import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';

export function registerCancelTask(server: McpServer, client: WiroClient): void {
  server.tool(
    'cancel_task',
    'Cancel a task that is still in the queue (before worker assignment). Tasks already running cannot be cancelled — use kill_task instead.',
    {
      tasktoken: z.string().describe('The task token to cancel'),
    },
    async ({ tasktoken }) => {
      try {
        await client.cancelTask(tasktoken);
        return {
          content: [{ type: 'text' as const, text: `Task cancelled successfully.` }],
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
