import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  getTaskState,
  toStructuredTaskResult,
} from '../utils/structured.js';
import { taskPriceOutputSchema } from './schemas.js';

export function registerGetTaskPrice(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_task_price',
    {
      title: 'Get a Wiro task price',
      description: 'Get one task’s final charged cost. Successful tasks are '
        + 'billed; failed tasks are not. If the task is active, follow the '
        + 'returned `wait_for_task` next action.',
      inputSchema: {
        tasktoken: z.string().optional().describe('The task token returned from run_model.'),
        taskid: z.string().optional().describe('The task ID (alternative to tasktoken).'),
      },
      outputSchema: taskPriceOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
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

        const detail = await client.getTask({ tasktoken, taskid }, extra.signal);
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
        if (task.modelslugowner && task.modelslugproject) {
          lines.push(`**Model:** \`${task.modelslugowner}/${task.modelslugproject}\``);
        }
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

        const state = getTaskState(task);
        const structuredTask = toStructuredTaskResult(task, {
          taskid,
          tasktoken,
        });
        const successful = state === 'completed';
        const terminal = successful || state === 'failed' || state === 'cancelled';

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            state,
            task: structuredTask.task,
            billed: terminal ? successful : null,
            costUsd: terminal
              ? (successful ? Number(task.totalcost || 0) : 0)
              : null,
            ...(structuredTask.nextAction
              ? { nextAction: structuredTask.nextAction }
              : {}),
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
