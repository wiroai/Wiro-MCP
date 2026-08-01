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

export function registerGetTask(server: McpServer, client: WiroClient): void {
  server.tool(
    'get_task',
    'Get the current status and output of a task. By default this is an immediate one-time check; set `wait_seconds` for a short bounded wait, or use `wait_for_task` for resumable long generations. Returns status, outputs, cost, and elapsed time. Check pexit for success ("0") or failure.',
    {
      tasktoken: z.string().optional().describe('The task token returned from run_model'),
      taskid: z.string().optional().describe('The task ID (alternative to tasktoken)'),
      wait_seconds: z.number().int().min(0).max(45).default(0)
        .describe('Optional bounded wait before returning (0-45 seconds, default 0)'),
    },
    async ({ tasktoken, taskid, wait_seconds }, extra) => {
      try {
        if (!tasktoken && !taskid) {
          return {
            content: [{ type: 'text' as const, text: '## Error\n\nEither `tasktoken` or `taskid` is required.' }],
            isError: true,
          };
        }

        const reference = { tasktoken, taskid };
        const detail = wait_seconds > 0
          ? await client.waitForTask(
            reference,
            wait_seconds * 1000,
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
          )
          : await client.getTask(reference, extra.signal);
        if (!detail.result) {
          const errors = detail.errors?.map(error => error.message).join(', ')
            || 'Task status request failed.';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${errors}` }],
            isError: true,
          };
        }
        const task = detail.tasklist?.[0];

        if (!task) {
          return {
            content: [{ type: 'text' as const, text: '## Error\n\nTask not found.' }],
            isError: true,
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
                timeoutSeconds: wait_seconds,
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
