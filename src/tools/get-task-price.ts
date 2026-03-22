import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';

export function registerGetTaskPrice(server: McpServer, client: WiroClient): void {
  server.tool(
    'get_task_price',
    'Get the cost of a completed task. Returns the total cost charged for the run. Only successful tasks (pexit "0") are billed — failed tasks are not charged.',
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

        const lines: string[] = [];
        lines.push('## Task Price');
        lines.push('');
        lines.push(`**Task ID:** ${task.id}`);
        lines.push(`**Status:** ${task.status}`);

        if (task.pexit === '0') {
          const cost = task.totalcost && task.totalcost !== '0'
            ? `$${task.totalcost}`
            : '$0 (no charge)';
          lines.push(`**Result:** Success`);
          lines.push(`**Cost:** ${cost}`);
        } else if (task.pexit) {
          lines.push(`**Result:** Failed (exit code: ${task.pexit})`);
          lines.push(`**Cost:** $0 (failed tasks are not charged)`);
        } else {
          lines.push(`**Result:** In progress`);
          lines.push(`**Cost:** Not yet determined (task still running)`);
        }

        if (task.elapsedseconds) {
          lines.push(`**Duration:** ${task.elapsedseconds}s`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
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
