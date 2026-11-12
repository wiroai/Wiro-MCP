import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TaskPollingError,
  TaskWaitTimeoutError,
  type WiroClient,
} from '../client.js';
import type { Task } from '../types.js';
import { errorText, isOutcomeUnknown } from '../utils/api.js';
import {
  formatTaskPending,
  formatTaskResult,
  formatTaskSubmitted,
} from '../utils/format.js';
import { MAX_WAIT_SECONDS, type ToolCallContext } from '../utils/poll.js';
import {
  runKey,
  runLedger,
  submittedTask,
  type RunRecord,
  type RunReuseTiming,
  type RunSubmission,
} from '../utils/run-ledger.js';
import {
  createTaskContent,
  getTaskState,
  toPendingTaskResult,
  toStructuredTaskResult,
  type StructuredTaskResult,
  type TaskContentBlock,
} from '../utils/structured.js';
import { strictInput, taskResultOutputSchema } from './schemas.js';

/** How long run_model waits, and when an identical call continues an earlier run. */
export interface RunModelTiming extends RunReuseTiming {
  /** The longest one call may wait, counted from its start, the run request included. */
  maxWaitMs: number;
}

/**
 * A call waits as long as `timeout_seconds` asks, up to an hour, counted from
 * its start with the run request included. Some clients drop a tool call
 * sooner, Zed at 60 seconds without telling the server, and the agent then
 * repeats the call. So an identical call (same API key, model and parameters)
 * continues the earlier call's task instead of starting a new one when it comes
 * within 10 minutes of that call ending without its answer reaching the client
 * (cancelled, connection lost, or no task confirmed yet), or while that call is
 * still waiting and at least 10 seconds after it started.
 */
export const RUN_MODEL_TIMING: Readonly<RunModelTiming> = Object.freeze({
  maxWaitMs: MAX_WAIT_SECONDS * 1000,
  retryAfterMs: 10_000,
  unansweredWindowMs: 10 * 60_000,
});

interface ToolResult {
  [key: string]: unknown;
  content: TaskContentBlock[];
  structuredContent?: StructuredTaskResult;
  isError?: boolean;
}

const TIMED_OUT = Symbol('timed out');

function abortError(): Error {
  const error = new Error('Task wait aborted by client');
  error.name = 'AbortError';
  return error;
}

/** The run request's answer, or TIMED_OUT once the deadline passes first. */
function settleBy(
  submission: Promise<RunSubmission>,
  deadline: number,
  signal: AbortSignal,
): Promise<RunSubmission | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      finish();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      finish();
      resolve(TIMED_OUT);
    }, Math.max(0, deadline - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    void submission.then(settled => {
      finish();
      resolve(settled);
    });
  });
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text: `## Error\n\n${text}` }], isError: true };
}

/** What a call answers when Wiro created no task it can follow. */
function runFailure(settled: RunSubmission, model: string, project: string): ToolResult {
  if (!settled.ok) {
    const { error } = settled;
    // The request was sent, and no clear answer says whether Wiro created a task.
    if (isOutcomeUnknown(error)) {
      return errorResult(`The run request was sent but no clear answer came back (${errorText(error)}). `
        + 'The task may have started and may be charged. Before running it again, call list_tasks with model '
        + `"${project}" and look for a task of ${model} that is queued or running, or that started in the last few minutes.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  const runResult = settled.result;
  if (!runResult.result) {
    const errors = runResult.errors?.map(e => e.message).join(', ') || 'Unknown error';
    return errorResult(`Failed to run model: ${errors}`);
  }
  // Wiro created the task, so it runs and can be charged; only this call
  // cannot follow it.
  const taskid = runResult.taskid ? String(runResult.taskid) : '';
  return errorResult(taskid
    ? `The task was created (task ID ${taskid}), but its task token did not come back, so this call cannot wait for it. `
      + `Do not run the model again: read the task with get_task and taskid "${taskid}", or find it with list_tasks.`
    : 'The task was created, but its task ID and token did not come back, so this call cannot wait for it. '
      + `Do not run the model again: find the task with list_tasks with model "${project}", then read it with get_task.`);
}

/** What a call answers when Wiro has not confirmed the run before the deadline. */
function notConfirmed(model: string, project: string, sentSecondsAgo: number): ToolResult {
  return errorResult(`Wiro had not confirmed the run request ${sentSecondsAgo} seconds after it was sent, when this call's `
    + 'wait ended. The task may still start and may be charged. '
    + `Do not run the model again now: in a minute, call list_tasks with model "${project}" and look for a task of `
    + `${model} that started in the last few minutes, then follow it with wait_for_task.`);
}

function ageText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Marks a result as the task of an earlier identical call. */
function withReuseNote(result: ToolResult, ageMs: number): ToolResult {
  const note = `This call continued the task of an identical run_model call made ${ageText(ageMs)} ago, whose answer `
    + 'did not reach you, instead of starting and billing a new task. If the user wants a separate second run, '
    + 'change a parameter such as the seed.';
  const [first, ...rest] = result.content;
  const content: TaskContentBlock[] = first?.type === 'text'
    ? [{ ...first, text: `${note}\n\n${first.text}` }, ...rest]
    : [{ type: 'text', text: note }, ...result.content];
  return {
    ...result,
    content,
    ...(result.structuredContent ? { structuredContent: { ...result.structuredContent, reused: true } } : {}),
  };
}

type Followed =
  | { kind: 'done'; task: Task }
  | { kind: 'missing' }
  | { kind: 'waiting'; lastTask?: Task; reason?: string; timedOut: boolean };

/** Polls the task until it ends or the deadline passes. */
async function followTask(
  client: WiroClient,
  tasktoken: string,
  deadline: number,
  startedAt: number,
  extra: ToolCallContext,
): Promise<Followed> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return { kind: 'waiting', timedOut: true };
  try {
    const detail = await client.waitForTask(tasktoken, remainingMs, {
      signal: extra.signal,
      onPoll: async task => {
        const progressToken = extra._meta?.progressToken;
        if (progressToken === undefined) return;
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: (Date.now() - startedAt) / 1000,
              message: `Task status: ${task.status}`,
            },
          });
        } catch {
          // Progress is best-effort and must never interrupt task polling.
        }
      },
    });
    const task = detail.tasklist?.[0];
    return task ? { kind: 'done', task } : { kind: 'missing' };
  } catch (error) {
    const lastDetail = error instanceof TaskWaitTimeoutError || error instanceof TaskPollingError
      ? error.lastDetail
      : undefined;
    const timedOut = error instanceof TaskWaitTimeoutError;
    return {
      kind: 'waiting',
      lastTask: lastDetail?.tasklist?.[0],
      reason: timedOut ? undefined : 'Task submission succeeded, but status monitoring was interrupted.',
      timedOut,
    };
  }
}

function followedResult(
  followed: Followed,
  task: { taskid?: string; tasktoken: string },
  model: string,
  waitedSeconds: number,
): ToolResult {
  const reference = { taskid: task.taskid, tasktoken: task.tasktoken, model };
  if (followed.kind === 'done') {
    return {
      content: createTaskContent(formatTaskResult(followed.task), followed.task),
      structuredContent: toStructuredTaskResult(followed.task, reference),
    };
  }
  if (followed.kind === 'missing') {
    const reason = 'The status endpoint returned no task data.';
    return {
      content: [{
        type: 'text',
        text: formatTaskPending({ ...reference, timeoutSeconds: waitedSeconds, reason }),
      }],
      structuredContent: toPendingTaskResult({ ...reference, reason }),
    };
  }
  const { lastTask, reason } = followed;
  const structured = lastTask
    ? toStructuredTaskResult(lastTask, reference)
    : toPendingTaskResult({ ...reference, reason });
  if (reason) structured.error = reason;
  return {
    content: [{
      type: 'text',
      text: formatTaskPending({
        ...reference,
        status: lastTask?.status,
        timeoutSeconds: followed.timedOut ? waitedSeconds : undefined,
        reason,
      }),
    }],
    structuredContent: structured,
  };
}

export function registerRunModel(
  server: McpServer,
  client: WiroClient,
  timing: RunModelTiming = RUN_MODEL_TIMING,
): void {
  server.registerTool(
    'run_model',
    {
      title: 'Run a Wiro model',
      description: 'Run any AI model on Wiro. Supports image, video, text, audio, '
        + '3D, and more. Call `get_model_schema` first. With `wait=true` this '
        + 'performs a bounded wait; when the response contains '
        + '`nextAction.tool = "wait_for_task"`, call that tool with the exact '
        + 'arguments returned. Do not resubmit the original request. A completed '
        + 'tool-call turn instead returns a `run_model` continuation template; '
        + 'execute its calls, fill its `toolOutputs`, and invoke it once. '
        + 'When the task completes, present every returned media resource in the '
        + 'user-facing response instead of reporting only task metadata.',
      inputSchema: strictInput({
        model: z.string().describe('Model slug in "owner/model" format, e.g. "google/veo3-1", "google/nano-banana-pro"'),
        params: z.record(z.string(), z.unknown()).describe('Model-specific parameters as key-value pairs. Use get_model_schema to discover available parameters. Pass json and json-array parameters as structured JSON values in this same object. File parameters take public URLs, no upload needed: one URL for fileinput, an array of URLs for combinefileinput, and for multifileinput the URLs comma-separated in its matching ...UrlMultiple field. A parameter you leave out gets the default get_model_schema shows for it. A run fills nothing for the ones it marks as samples (file fields, ids that contain "input", the prompt and the LLM chat fields), picks a random seed, and refuses a required parameter that is missing. To continue a chat, send the same session_id with the next prompt, without previousTaskToken. A turn that ended with tool calls is continued with previousTaskToken, toolOutputs rows (call_id and output) and the same session_id, as its nextAction shows.'),
        wait: z.boolean().default(true).describe('If true, poll until completion and return the result. If false, return the task identifiers immediately.'),
        timeout_seconds: z.number().int().min(10).max(MAX_WAIT_SECONDS).default(45).describe(`Maximum seconds to wait when wait=true (up to ${MAX_WAIT_SECONDS}), counted from the start of the call. The 45-second default is safe for clients with a 60-second tool timeout; wait longer, such as 300 seconds for a video, when the client allows longer tool calls. A task that is still running then continues with wait_for_task.`),
      }, 'Model parameters go inside `params`.'),
      outputSchema: taskResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params, wait, timeout_seconds }, extra) => {
      const startedAt = Date.now();
      // The slug is checked before anything is sent, so any error the run call
      // throws afterwards came once the request had gone out.
      const [owner, ...rest] = model.split('/');
      const project = rest.join('/');
      if (!owner || !project) {
        return {
          content: [{ type: 'text' as const, text: '## Error\n\nModel must be in "owner/model" format, e.g. "google/veo3-1"' }],
          isError: true,
        };
      }

      // A call the client cancelled before it began sends nothing.
      if (extra.signal.aborted) return errorResult('The call was cancelled before the run request was sent.');

      // Every wait below ends by this deadline, the run request included.
      const deadline = startedAt + Math.min(timeout_seconds * 1000, timing.maxWaitMs);
      const waitedSeconds = (): number => Math.round((Date.now() - startedAt) / 1000);
      // A client without an identity, such as a stand-in in a test, gets a key
      // no other call shares.
      const identity = typeof client.identity === 'string' ? client.identity : undefined;
      const key = identity ? runKey(identity, model, params) : `call:${crypto.randomUUID()}`;

      let match = identity ? runLedger.find(key, timing, startedAt) : undefined;
      let record: RunRecord | undefined;
      let outcome: 'answered' | 'unanswered' | 'failed' = 'failed';
      // A cancel or a closed connection means this call's answer will never
      // arrive, so an identical call right after it continues its task.
      const onAbort = (): void => {
        if (record) runLedger.markUnanswered(record);
      };
      extra.signal.addEventListener('abort', onAbort);

      try {
        // Twice at most: a continued run whose request or task failed is
        // replaced by a new run, as if no earlier call had been made.
        for (;;) {
          const reused = match;
          match = undefined;
          record = reused ?? runLedger.start(key, () => client.runModel(model, params));
          runLedger.attach(record);
          const finish = (result: ToolResult): ToolResult => (reused
            ? withReuseNote(result, startedAt - reused.startedAt)
            : result);

          // The run request is not tied to this call's signal: once it is sent,
          // Wiro may create the task whether or not this call is still waiting,
          // and the ledger needs its answer for an identical call that follows.
          const settled = record.settled ?? await settleBy(record.submission, deadline, extra.signal);
          if (settled === TIMED_OUT) {
            outcome = 'unanswered';
            return notConfirmed(model, project, Math.round((Date.now() - record.startedAt) / 1000));
          }

          const task = submittedTask(settled);
          if (!task) {
            if (reused) {
              runLedger.release(record, 'failed');
              record = undefined;
              continue;
            }
            outcome = 'failed';
            return runFailure(settled, model, project);
          }

          if (!wait) {
            outcome = 'answered';
            return finish({
              content: [{ type: 'text', text: formatTaskSubmitted(task.taskid ?? '', task.tasktoken) }],
              structuredContent: toPendingTaskResult({ ...task, model }),
            });
          }

          const followed = await followTask(client, task.tasktoken, deadline, startedAt, extra);
          if (reused && followed.kind === 'done' && ['failed', 'cancelled'].includes(getTaskState(followed.task))) {
            runLedger.release(record, 'failed');
            record = undefined;
            continue;
          }
          outcome = 'answered';
          return finish(followedResult(followed, task, model, waitedSeconds()));
        }
      } catch (error) {
        // Only an abort ends up here; the SDK sends no answer for a cancelled call.
        return errorResult(error instanceof Error ? error.message : String(error));
      } finally {
        extra.signal.removeEventListener('abort', onAbort);
        if (record) runLedger.release(record, extra.signal.aborted ? 'unanswered' : outcome);
      }
    },
  );
}
