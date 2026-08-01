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

export function registerRunModel(server: McpServer, client: WiroClient): void {
  server.tool(
    'run_model',
    'Run any AI model on Wiro. Supports image generation, video generation, LLMs, audio, 3D, and more.\n\n' +
    'Use `get_model_schema` first to discover available parameters.\n\n' +
    'With wait=true (default), polls until completion and returns the result.\n' +
    'With wait=false, returns the task token immediately for `wait_for_task` or a one-time `get_task` check.\n' +
    'If the wait budget expires, the task is still running: continue with `wait_for_task`. Never submit the same run again.',
    {
      model: z.string().describe('Model slug in "owner/model" format, e.g. "openai/sora-2", "google/nano-banana-pro"'),
      params: z.record(z.string(), z.unknown()).describe('Model-specific parameters as key-value pairs. Use get_model_schema to discover available parameters. For file parameters (fileinput, multifileinput, combinefileinput), pass URLs directly — no upload needed. For combinefileinput, pass an array of URLs.'),
      wait: z.boolean().default(true).describe('If true, poll until completion and return result. If false, return task token immediately.'),
      timeout_seconds: z.number().int().min(10).max(600).default(45).describe('Max seconds to wait for completion (only when wait=true). The 45s default is safe for clients with a 60s tool timeout.'),
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

        if (!wait) {
          return {
            content: [{
              type: 'text' as const,
              text: formatTaskSubmitted(
                runResult.taskid,
                runResult.socketaccesstoken,
              ),
            }],
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
          return {
            content: [{
              type: 'text' as const,
              text: formatTaskPending({
                taskid: runResult.taskid,
                tasktoken: runResult.socketaccesstoken,
                timeoutSeconds: timeout_seconds,
                reason: 'The status endpoint returned no task data.',
              }),
            }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: formatTaskResult(task) }],
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
