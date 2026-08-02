import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { taskActionOutputSchema } from './schemas.js';

export function registerCancelTask(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel a queued Wiro task',
      description: 'Cancel a task that is still queued, before worker '
        + 'assignment. This changes remote state. Use `kill_task` for a task '
        + 'that has already started.',
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

        const result = await client.cancelTask(
          { tasktoken, taskid },
          extra.signal,
        );
        if (result.result === false) {
          const msg = (result.errors as Array<{ message: string }>)?.map(e => e.message).join(', ') || 'Cancel failed';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${msg}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Task cancelled successfully.` }],
          structuredContent: {
            action: 'cancel',
            success: true,
            task: {
              ...(taskid ? { id: taskid } : {}),
              ...(tasktoken ? { token: tasktoken } : {}),
            },
            message: 'Task cancelled successfully.',
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
