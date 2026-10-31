import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult } from '../utils/api.js';
import { formatStudioRun, readStudioRunPage, STUDIO_RUNS_MAX, studioRunSchema } from '../utils/studio-runs.js';
import { nextActionSchema } from './schemas.js';

function parseSince(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const text = value.trim();
  let seconds = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Date.parse(text) / 1000;
  // A 13-digit number is a JavaScript timestamp in milliseconds.
  if (seconds > 100_000_000_000) seconds /= 1000;
  if (!Number.isFinite(seconds)) {
    throw new Error('since must be an ISO 8601 time such as 2026-01-31T09:00:00Z, or Unix seconds.');
  }
  return Math.floor(seconds);
}

export function registerListStudioResults(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_studio_results',
    {
      title: 'List Studio model runs',
      description: 'List the model runs Studio started for this key\'s account (images, videos, audio, text), newest '
        + 'first, with their status, output URLs, text answers and cost. It covers all of your Studio conversations in '
        + 'this key\'s workspace; teammates\' runs are not included. Use it to collect outputs that finished after a turn '
        + 'ended, or to check what is still running. Each run shows when it was created and, for a model that takes a '
        + 'prompt, its prompt, so it can be matched to a request. These runs belong to Studio, so get_task, list_tasks, '
        + 'cancel_task and kill_task cannot read or stop them; poll this tool instead. It reads at most Studio\'s 100 most '
        + 'recent runs: to collect a period, pass since with limit 100, and the result says when older runs in that '
        + 'period may be missing. Only successful runs are charged. Read-only.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20)
          .describe('How many recent runs to read (1-100, default 20). Filters apply after reading, so fewer can come back.'),
        state: z.enum(['all', 'running', 'completed', 'failed', 'cancelled']).default('all')
          .describe('Only runs in this state (default all).'),
        since: z.string().optional()
          .describe('Only runs created at or after this time: ISO 8601 (2026-01-31T09:00:00Z) or Unix seconds.'),
      },
      outputSchema: {
        runs: z.array(studioRunSchema),
        count: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        mayMissOlder: z.boolean().optional(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, state, since }, extra) => {
      try {
        const from = parseSince(since);
        // Studio returns only its most recent runs, so a full page whose oldest
        // run is newer than since can leave out older runs of that period.
        const page = await readStudioRunPage(client, limit, from === undefined ? {} : { from }, extra.signal);
        const runs = page.runs.filter(run => state === 'all' || run.state === state);
        const running = runs.filter(run => run.state === 'running').length;

        const lines = ['## Studio model runs', ''];
        if (runs.length === 0) lines.push('No runs matched.');
        for (const run of runs) lines.push(formatStudioRun(run));
        if (running > 0) lines.push('', `${running} run(s) still running. Check again in a little while.`);
        if (page.mayMissOlder) {
          lines.push('', limit < STUDIO_RUNS_MAX
            ? `Call again with limit ${STUDIO_RUNS_MAX} to see more of that period.`
            : `Studio returns its ${STUDIO_RUNS_MAX} most recent model runs, and the oldest of them is newer than since, `
              + 'so earlier runs from that period are not in this list.');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            runs,
            count: runs.length,
            running,
            ...(page.mayMissOlder ? { mayMissOlder: true } : {}),
            ...(running > 0
              ? {
                nextAction: {
                  tool: 'list_studio_results',
                  arguments: { limit, ...(since ? { since } : {}) },
                  reason: 'Some runs are still running; call again in a little while to see their outputs.',
                },
              }
              : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
