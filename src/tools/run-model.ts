import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TaskPollingError,
  TaskWaitTimeoutError,
  type WiroClient,
} from '../client.js';
import type { RunModelResult } from '../types.js';
import { errorText, isOutcomeUnknown } from '../utils/api.js';
import {
  formatTaskPending,
  formatTaskResult,
  formatTaskSubmitted,
} from '../utils/format.js';
import {
  createTaskContent,
  toPendingTaskResult,
  toStructuredTaskResult,
} from '../utils/structured.js';
import { taskResultOutputSchema } from './schemas.js';

export function registerRunModel(server: McpServer, client: WiroClient): void {
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
      inputSchema: {
        model: z.string().describe('Model slug in "owner/model" format, e.g. "openai/sora-2", "google/nano-banana-pro"'),
        params: z.record(z.string(), z.unknown()).describe('Model-specific parameters as key-value pairs. Use get_model_schema to discover available parameters. Pass json and json-array parameters as structured JSON values in this same object. File parameters take public URLs, no upload needed: one URL for fileinput, an array of URLs for combinefileinput, and for multifileinput the URLs comma-separated in its matching ...UrlMultiple field. A parameter you leave out gets the default get_model_schema shows for it. A run fills nothing for the ones it marks as samples (file fields, ids that contain "input", the prompt and the LLM chat fields), picks a random seed, and refuses a required parameter that is missing. Continue a completed turn with previousTaskToken and the same session_id as that turn: add toolOutputs rows with call_id and output for tool results, or send exactly one new prompt or non-empty messages value for a stateful next turn.'),
        wait: z.boolean().default(true).describe('If true, poll until completion and return the result. If false, return the task identifiers immediately.'),
        timeout_seconds: z.number().int().min(10).max(600).default(45).describe('Maximum seconds to wait when wait=true. The 45-second default is safe for clients with a 60-second tool timeout.'),
      },
      outputSchema: taskResultOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ model, params, wait, timeout_seconds }, extra) => {
      // The slug is checked before anything is sent, so any error the run call
      // throws afterwards came once the request had gone out.
      const [owner, ...rest] = model.split('/');
      const project = rest.join('/');
      if (!owner || !project) {
        return {
          content: [{ type: 'text' as const, text: '## Error\n\nModel must be in "owner/model" format, e.g. "openai/sora-2"' }],
          isError: true,
        };
      }
      let runResult: RunModelResult | undefined;

      try {
        runResult = await client.runModel(model, params, extra.signal);

        if (!runResult.result) {
          const errors = runResult.errors?.map(e => e.message).join(', ') || 'Unknown error';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\nFailed to run model: ${errors}` }],
            isError: true,
          };
        }
        if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(runResult.socketaccesstoken ?? '')) {
          // Wiro created the task, so it runs and can be charged; only this
          // call cannot follow it.
          const taskid = runResult.taskid ? String(runResult.taskid) : '';
          return {
            content: [{
              type: 'text' as const,
              text: taskid
                ? `## Error\n\nThe task was created (task ID ${taskid}), but its task token did not come back, so this call cannot wait for it. `
                  + `Do not run the model again: read the task with get_task and taskid "${taskid}", or find it with list_tasks.`
                : '## Error\n\nThe task was created, but its task ID and token did not come back, so this call cannot wait for it. '
                  + `Do not run the model again: find the task with list_tasks with model "${project}", then read it with get_task.`,
            }],
            isError: true,
          };
        }

        if (!wait) {
          return {
            content: [{
              type: 'text' as const,
              text: formatTaskSubmitted(
                runResult.taskid,
                runResult.socketaccesstoken,
              ),
            }],
            structuredContent: toPendingTaskResult({
              taskid: runResult.taskid,
              tasktoken: runResult.socketaccesstoken,
              model,
            }),
          };
        }

        const detail = await client.waitForTask(
          runResult.socketaccesstoken,
          timeout_seconds * 1000,
          {
            signal: extra.signal,
            onPoll: async (task, context) => {
              const progressToken = extra._meta?.progressToken;
              if (progressToken === undefined) return;
              try {
                await extra.sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: context.elapsedMs / 1000,
                    message: `Task status: ${task.status}`,
                  },
                });
              } catch {
                // Progress is best-effort and must never interrupt task polling.
              }
            },
          },
        );

        const task = detail.tasklist?.[0];
        if (!task) {
          const reason = 'The status endpoint returned no task data.';
          return {
            content: [{
              type: 'text' as const,
              text: formatTaskPending({
                taskid: runResult.taskid,
                tasktoken: runResult.socketaccesstoken,
                timeoutSeconds: timeout_seconds,
                reason,
              }),
            }],
            structuredContent: toPendingTaskResult({
              taskid: runResult.taskid,
              tasktoken: runResult.socketaccesstoken,
              model,
              reason,
            }),
          };
        }

        return {
          content: createTaskContent(formatTaskResult(task), task),
          structuredContent: toStructuredTaskResult(task, {
            taskid: runResult.taskid,
            tasktoken: runResult.socketaccesstoken,
            model,
          }),
        };
      } catch (error) {
        if (runResult?.result && runResult.socketaccesstoken) {
          const lastDetail = error instanceof TaskWaitTimeoutError
            || error instanceof TaskPollingError
            ? error.lastDetail
            : undefined;
          const lastTask = lastDetail?.tasklist?.[0];
          const reason = error instanceof TaskWaitTimeoutError
            ? undefined
            : 'Task submission succeeded, but status monitoring was interrupted.';
          const structured = lastTask
            ? toStructuredTaskResult(lastTask, {
              taskid: runResult.taskid,
              tasktoken: runResult.socketaccesstoken,
              model,
            })
            : toPendingTaskResult({
              taskid: runResult.taskid,
              tasktoken: runResult.socketaccesstoken,
              model,
              reason,
            });
          if (reason) structured.error = reason;

          return {
            content: [{
              type: 'text' as const,
              text: formatTaskPending({
                taskid: runResult.taskid,
                tasktoken: runResult.socketaccesstoken,
                status: lastTask?.status,
                timeoutSeconds: error instanceof TaskWaitTimeoutError
                  ? timeout_seconds
                  : undefined,
                reason,
              }),
            }],
            structuredContent: structured,
          };
        }

        // The request was sent, and no clear answer says whether Wiro created a task.
        if (!runResult && isOutcomeUnknown(error)) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Error\n\nThe run request was sent but no clear answer came back (${errorText(error)}). `
                + 'The task may have started and may be charged. Before running it again, call list_tasks with model '
                + `"${project}" and look for a task of ${model} that is queued or running, or that started in the last few minutes.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `## Error\n\n${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
