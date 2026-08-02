import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatTaskList } from '../utils/format.js';
import { toStructuredTaskResult } from '../utils/structured.js';
import { taskListOutputSchema } from './schemas.js';

export function registerListTasks(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List Wiro tasks',
      description: 'List the authenticated project’s recent model-generation tasks. '
        + 'Use this to find work from previous conversations, then call `get_task` '
        + 'with a returned task ID for the complete result. The caller identity is '
        + 'derived from authentication; no user UUID is accepted.',
      inputSchema: {
        start: z.number().int().min(0).default(0)
          .describe('Pagination offset (default 0).'),
        limit: z.number().int().min(1).max(100).default(20)
          .describe('Maximum tasks to return (default 20, max 100).'),
        model: z.string().optional()
          .describe('Optional model slug or partial model name filter.'),
      },
      outputSchema: taskListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ start, limit, model }, extra) => {
      try {
        const result = await client.listTasks(
          { start, limit, model },
          extra.signal,
        );
        if (!result.result) {
          const message = result.errors?.map(error => error.message).join(', ')
            || 'Task history request failed.';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${message}` }],
            isError: true,
          };
        }

        const tasks = result.tasklist ?? [];
        const total = Number.parseInt(String(result.total ?? '0'), 10) || 0;
        const nextStart = start + tasks.length < total
          ? start + tasks.length
          : null;
        const firstTask = tasks[0];
        const structuredTasks = tasks.map(task => {
          const structured = toStructuredTaskResult(task);
          return {
            state: structured.state,
            task: structured.task,
            outputs: structured.outputs.slice(0, 3).map(output => {
              const { text: _text, ...summary } = output;
              return summary;
            }),
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: formatTaskList(tasks, total, start),
          }],
          structuredContent: {
            tasks: structuredTasks,
            total,
            start,
            limit,
            nextStart,
            ...(firstTask
              ? {
                nextAction: {
                  tool: 'get_task',
                  arguments: { taskid: firstTask.id },
                  reason: 'Fetch the complete result for the newest matching task.',
                },
              }
              : {}),
          },
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `## Error\n\n${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
