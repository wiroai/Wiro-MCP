import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TaskPollingError,
  TaskWaitTimeoutError,
  type WiroClient,
} from '../client.js';
import type { RunModelResult } from '../types.js';
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
        params: z.record(z.string(), z.unknown()).describe('Model-specific parameters as key-value pairs. Use get_model_schema to discover available parameters. Pass json and json-array parameters as structured JSON values in this same object. Continue a completed turn with previousTaskToken: add toolOutputs rows with call_id and output for tool results, or provide exactly one new prompt or non-empty messages value for a stateful next turn. For file parameters (fileinput, multifileinput, combinefileinput), pass URLs directly — no upload needed. For combinefileinput, pass an array of URLs.'),
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
        if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(runResult.socketaccesstoken)) {
          throw new Error('Wiro task submission omitted socketaccesstoken');
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

        return {
          content: [{ type: 'text' as const, text: `## Error\n\n${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
