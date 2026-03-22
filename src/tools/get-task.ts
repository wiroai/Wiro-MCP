import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatTaskResult } from '../utils/format.js';

export function registerGetTask(server: McpServer, client: WiroClient): void {
  server.tool(
    'get_task',
    'Get the current status and output of a task. Returns status, outputs, cost, and elapsed time. Check pexit for success ("0") or failure.',
    {
      tasktoken: z.string().optional().describe('The task token returned from run_model'),
      taskid: z.string().optional().describe('The task ID (alternative to tasktoken)'),
    },
    async ({ tasktoken, taskid }) => {
      try {
        if (!tasktoken && !taskid) {
          return {
            content: [{ type: 'text' as const, text: '## Error\n\nEither `tasktoken` or `taskid` is required.' }],
            isError: true,
          };
        }

        const detail = await client.getTask({ tasktoken, taskid });
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
        return {
          content: [{ type: 'text' as const, text: `## Error\n\n${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
