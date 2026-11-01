import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  isTaskId,
  isTaskIdTooLarge,
  isTaskNotFound,
  TaskPollingError,
  TaskWaitTimeoutError,
  type WiroClient,
} from '../client.js';
import {
  formatTaskPending,
  formatTaskResult,
  TASK_ID_NOT_NUMERIC,
  TASK_NOT_FOUND,
} from '../utils/format.js';
import {
  createTaskContent,
  toPendingTaskResult,
  toStructuredTaskResult,
} from '../utils/structured.js';
import { strictInput, taskResultOutputSchema } from './schemas.js';

export function registerGetTask(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_task',
    {
      title: 'Get a Wiro task',
      description: 'Get the current status and output of one task. It does not '
        + 'return the prompt or settings the task ran with. By default '
        + 'this is an immediate check. For an active task, follow the returned '
        + '`nextAction` instead of submitting another run. Completed tool-call '
        + 'turns expose ordered typed segments and a `run_model` continuation '
        + 'template whose ordinary `params` contain `previousTaskToken`, `toolOutputs` '
        + 'and the turn\'s `session_id` when it had one. When the task is complete, present every returned '
        + 'media resource in the user-facing response instead of reporting only '
        + 'task metadata.',
      inputSchema: strictInput({
        tasktoken: z.string().optional().describe('The task token returned from run_model.'),
        taskid: z.string().optional().describe('The task ID (alternative to tasktoken).'),
        wait_seconds: z.number().int().min(0).max(45).default(0)
          .describe('Optional bounded wait before returning (0-45 seconds, default 0).'),
      }),
      outputSchema: taskResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ tasktoken, taskid, wait_seconds }, extra) => {
      try {
        if (!tasktoken && !taskid) {
          return {
            content: [{ type: 'text' as const, text: '## Error\n\nEither `tasktoken` or `taskid` is required.' }],
            isError: true,
          };
        }
        if (taskid && !isTaskId(taskid)) {
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${TASK_ID_NOT_NUMERIC}` }],
            isError: true,
          };
        }
        if (taskid && isTaskIdTooLarge(taskid)) {
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${TASK_NOT_FOUND}` }],
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
          const errors = isTaskNotFound(detail)
            ? TASK_NOT_FOUND
            : detail.errors?.map(error => error.message).join(', ') || 'Task status request failed.';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${errors}` }],
            isError: true,
          };
        }
        const task = detail.tasklist?.[0];

        if (!task) {
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${TASK_NOT_FOUND}` }],
            isError: true,
          };
        }

        return {
          content: createTaskContent(formatTaskResult(task), task),
          structuredContent: toStructuredTaskResult(task, {
            taskid,
            tasktoken,
          }),
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
            structuredContent: lastTask
              ? toStructuredTaskResult(lastTask, { taskid, tasktoken })
              : toPendingTaskResult({ taskid, tasktoken }),
          };
        }

        const message = error instanceof TaskPollingError && isTaskNotFound(error.lastDetail)
          ? TASK_NOT_FOUND
          : (error instanceof Error ? error.message : String(error));
        return {
          content: [{ type: 'text' as const, text: `## Error\n\n${message}` }],
          isError: true,
        };
      }
    },
  );
}
