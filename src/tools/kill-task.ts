import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';

export function registerKillTask(server: McpServer, client: WiroClient): void {
  server.tool(
    'kill_task',
    'Kill a task that is currently running (after worker assignment). For queued tasks, use cancel_task instead.',
    {
      tasktoken: z.string().describe('The task token to kill'),
    },
    async ({ tasktoken }) => {
      try {
        await client.killTask(tasktoken);
        return {
          content: [{ type: 'text' as const, text: `Task killed successfully.` }],
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
