import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { awaitingCharge, cancelledWhileQueued, formatTaskCost } from '../utils/format.js';
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
      description: 'Get one task’s cost: the amount charged once Wiro has billed it, with the '
        + 'model\'s list price beside it when a discount made them differ. Successful tasks are '
        + 'billed; failed tasks and tasks cancelled while queued are not, and a task stopped '
        + 'while running can still be charged once its work ends. A finished task\'s result already '
        + 'shows its cost, so use this for a task whose result you do not have, or whose result '
        + 'shows only the list price. If the task is active, follow the returned `wait_for_task` '
        + 'next action.',
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

        const state = getTaskState(task);
        // Wiro sets chargedcost once it has billed a finished task; a failed or
        // cancelled task shows a charge only when Wiro reports one.
        const chargedUsd = task.chargedcost === null || task.chargedcost === undefined || task.chargedcost === ''
          ? null
          : Number(task.chargedcost);
        const charged = chargedUsd !== null && Number.isFinite(chargedUsd) && chargedUsd > 0
          ? formatTaskCost(task)
          : null;
        // A successful task reads as finished a moment before its charge is recorded.
        const awaiting = awaitingCharge(task);
        // No worker took a task cancelled while queued, so it never ran.
        const neverRan = state === 'cancelled' && charged === null && cancelledWhileQueued(task);
        if (state === 'completed') {
          lines.push(`**Result:** Success`);
          lines.push(`**Cost:** ${awaiting
            ? `$${Number(task.totalcost)} list price; check again in a moment for the charged amount`
            : formatTaskCost(task) ?? '$0 (no charge)'}`);
        } else if (state === 'failed') {
          lines.push(`**Result:** Failed${task.pexit ? ` (exit code: ${task.pexit})` : ''}`);
          lines.push(`**Cost:** ${charged ?? '$0 (failed tasks are not charged)'}`);
        } else if (state === 'cancelled') {
          lines.push(`**Result:** Cancelled`);
          lines.push(`**Cost:** ${charged ?? (neverRan
            ? '$0 (cancelled while queued, not charged)'
            : '$0 so far (a task stopped while running can still be charged when its work ends)')}`);
        } else {
          lines.push(`**Result:** In progress`);
          lines.push(`**Cost:** Not yet determined (task still running)`);
        }

        if (task.elapsedseconds) {
          lines.push(`**Duration:** ${task.elapsedseconds}s`);
        }

        const structuredTask = toStructuredTaskResult(task, {
          taskid,
          tasktoken,
        });
        const successful = state === 'completed';
        const terminal = successful || state === 'failed' || state === 'cancelled';
        // Work a cancelled task had already started can still be charged when it
        // ends, so with no charge yet it is not known whether it will be billed.
        const pendingCancel = state === 'cancelled' && charged === null && !neverRan;

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            state,
            task: structuredTask.task,
            billed: terminal && !pendingCancel ? successful || charged !== null : null,
            costUsd: terminal && !awaiting
              ? (chargedUsd !== null && Number.isFinite(chargedUsd)
                ? chargedUsd
                : (successful ? Number(task.totalcost || 0) : 0))
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
