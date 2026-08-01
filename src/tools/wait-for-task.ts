import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TaskWaitTimeoutError,
  type WiroClient,
} from '../client.js';
import {
  formatTaskPending,
  formatTaskResult,
} from '../utils/format.js';

export function registerWaitForTask(server: McpServer, client: WiroClient): void {
  server.tool(
    'wait_for_task',
    'Wait for an existing Wiro task without submitting a new model run. '
      + 'Returns the final output if the task completes within the wait budget. '
      + 'If it is still running, call this tool again with the same identifier. '
      + 'Never call `run_model` again for the same task.',
    {
      tasktoken: z.string().optional().describe('The task token returned from run_model'),
      taskid: z.string().optional().describe('The task ID (alternative to tasktoken)'),
      timeout_seconds: z.number().int().min(10).max(600).default(45)
        .describe('Max seconds to wait. The 45s default is safe for clients with a 60s tool timeout.'),
    },
    async ({ tasktoken, taskid, timeout_seconds }, extra) => {
      if (!tasktoken && !taskid) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Error\n\nEither `tasktoken` or `taskid` is required.',
          }],
          isError: true,
        };
      }

      try {
        const detail = await client.waitForTask(
          { tasktoken, taskid },
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
                taskid,
                tasktoken,
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
        if (error instanceof TaskWaitTimeoutError) {
          const lastTask = error.lastDetail?.tasklist?.[0];
          return {
            content: [{
              type: 'text' as const,
              text: formatTaskPending({
                taskid: taskid || lastTask?.id,
                tasktoken: tasktoken || lastTask?.socketaccesstoken,
                status: lastTask?.status,
                timeoutSeconds: timeout_seconds,
              }),
            }],
          };
        }

        const identifier = tasktoken
          ? `**Task Token:** ${tasktoken}`
          : `**Task ID:** ${taskid}`;
        return {
          content: [{
            type: 'text' as const,
            text: `## Task Status Error\n\n${identifier}\n\n`
              + `${error instanceof Error ? error.message : String(error)}\n\n`
              + 'The task was not submitted again. Retry `wait_for_task` with the same identifier.',
          }],
          isError: true,
        };
      }
    },
  );
}
