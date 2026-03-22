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
        const result = await client.killTask(tasktoken);
        if (result.result === false) {
          const msg = (result.errors as Array<{ message: string }>)?.map(e => e.message).join(', ') || 'Kill failed';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${msg}` }],
            isError: true,
          };
        }
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
