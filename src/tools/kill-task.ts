import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { taskActionOutputSchema } from './schemas.js';

const STOP_REQUESTED = 'Stop requested; the task now shows as cancelled. A task that was still queued is not '
  + 'charged; one that was already running can still be charged for its run.';

export function registerKillTask(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'kill_task',
    {
      title: 'Stop a Wiro task',
      description: 'Stop a model task that has not finished. A queued task is cancelled and '
        + 'never charged. A task that was already running can still be charged for its run, '
        + 'and get_task_price shows any charge once the run ends. If the task finished first, '
        + 'the call is refused with "Process ended": read it with get_task and show the result. '
        + 'Not for the steps of a workflow run or the runs Studio starts.',
      inputSchema: {
        tasktoken: z.string().optional().describe('The task token returned from run_model.'),
        taskid: z.string().optional().describe('The task ID (alternative to tasktoken).'),
      },
      outputSchema: taskActionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ tasktoken, taskid }, extra) => {
      try {
        if (!tasktoken && !taskid) {
          return {
            content: [{ type: 'text' as const, text: '## Error\n\nEither `tasktoken` or `taskid` is required.' }],
            isError: true,
          };
        }

        const result = await client.killTask(
          { tasktoken, taskid },
          extra.signal,
        );
        if (result.result === false) {
          const msg = (result.errors as Array<{ message: string }>)?.map(e => e.message).join(', ') || 'Kill failed';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${msg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: STOP_REQUESTED }],
          structuredContent: {
            action: 'kill',
            success: true,
            task: {
              ...(taskid ? { id: taskid } : {}),
              ...(tasktoken ? { token: tasktoken } : {}),
            },
            message: STOP_REQUESTED,
          },
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `## Error\n\n${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
