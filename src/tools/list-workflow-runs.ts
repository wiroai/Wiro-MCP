import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  requireApiSuccess,
  toInteger,
  toNumber,
  type ApiEnvelope,
} from '../utils/api.js';
import { nextActionSchema } from './schemas.js';

interface RunHistoryResponse extends ApiEnvelope {
  workflowruns?: Array<Record<string, unknown>>;
  total?: number | string;
}

const runRowSchema = z.object({
  workflowtoken: z.string(),
  workflowSlug: z.string().optional(),
  workflowTitle: z.string().nullable().optional(),
  status: z.string(),
  canResume: z.boolean(),
  listPriceUsd: z.number().nullable().optional(),
  chargedUsd: z.number().nullable().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  elapsedSeconds: z.number().optional(),
  failedSteps: z.number().optional(),
  team: z.string().optional(),
});

function msToIso(value: unknown): string | undefined {
  const ms = toNumber(value);
  return ms !== null && ms > 0 ? new Date(ms).toISOString() : undefined;
}

export function registerListWorkflowRuns(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_workflow_runs',
    {
      title: 'List Wiro workflow runs',
      description: 'List past and current workflow runs in the API key\'s workspace, newest '
        + 'first, including runs started on wiro.ai. Use a returned run token with '
        + 'wait_for_workflow_run (wait_seconds 0) to read its outputs, or with '
        + 'resume_workflow_run when `canResume` is true.',
      inputSchema: {
        status: z.enum(['running', 'completed', 'failed', 'cancelled', 'stopped']).optional()
          .describe('Only runs with this status.'),
        search: z.string().max(200).optional().describe('Text to look for in the workflow title, or in its slug without the 5 character id: "product-ad" finds the runs of "product-ad-a1B2c".'),
        start: z.number().int().min(0).default(0).describe('Pagination offset (default 0).'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum runs (default 20, max 100).'),
      },
      outputSchema: {
        runs: z.array(runRowSchema),
        total: z.number().int().nonnegative(),
        start: z.number().int().nonnegative(),
        nextStart: z.number().int().nonnegative().nullable(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ status, search, start, limit }, extra) => {
      try {
        const body: Record<string, unknown> = { start, limit, sort: 'id', order: 'DESC' };
        if (status) body.status = status;
        if (search) body.search = search;
        const result = requireApiSuccess(
          await client.post<RunHistoryResponse>('/Workflow/RunHistory', body, extra.signal),
          'Could not list workflow runs.',
        );

        const runs = (result.workflowruns ?? []).map(row => ({
          workflowtoken: asString(row.workflowtoken) ?? '',
          ...(asString(row.workflowslug) ? { workflowSlug: asString(row.workflowslug) } : {}),
          workflowTitle: asString(row.workflowtitle) ?? null,
          status: asString(row.status) ?? 'running',
          canResume: row.canresume === true,
          ...(row.totalcost !== undefined ? { listPriceUsd: toNumber(row.totalcost) } : {}),
          ...(row.chargedcost !== undefined ? { chargedUsd: toNumber(row.chargedcost) } : {}),
          ...(msToIso(row.startedAt) ? { startedAt: msToIso(row.startedAt) } : {}),
          ...(msToIso(row.endedAt) ? { endedAt: msToIso(row.endedAt) } : {}),
          ...(toNumber(row.elapsedseconds) !== null ? { elapsedSeconds: toNumber(row.elapsedseconds)! } : {}),
          ...(toNumber(row.failedNodeCount) !== null ? { failedSteps: toNumber(row.failedNodeCount)! } : {}),
          ...(asString(row.teamname) ? { team: asString(row.teamname) } : {}),
        }));
        const total = toInteger(result.total, runs.length);
        const nextStart = start + runs.length < total ? start + runs.length : null;

        const lines = [`## Workflow runs (${total} total)`, ''];
        if (runs.length === 0) lines.push('No runs found.');
        for (const run of runs) {
          const cost = run.chargedUsd ?? run.listPriceUsd;
          lines.push(`- **${run.workflowTitle ?? run.workflowSlug ?? 'Workflow'}**: ${run.status}`
            + `${cost !== undefined && cost !== null ? `, $${cost}` : ''}`
            + `${run.startedAt ? `, started ${run.startedAt}` : ''} (token \`${run.workflowtoken}\`)`
            + `${run.canResume ? ', can be resumed' : ''}`);
        }
        if (nextStart !== null) lines.push('', `More results: call again with start=${nextStart}.`);

        const first = runs[0];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            runs,
            total,
            start,
            nextStart,
            ...(first
              ? {
                nextAction: {
                  tool: 'wait_for_workflow_run',
                  arguments: { workflowtoken: first.workflowtoken, wait_seconds: 0 },
                  reason: 'Read the newest run\'s status and outputs.',
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
