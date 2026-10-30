import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, requireApiSuccess, toInteger, type ApiEnvelope } from '../utils/api.js';
import { toWorkflowSummary, workflowSummarySchema, type WorkflowSummary } from '../utils/workflow.js';
import { nextActionSchema } from './schemas.js';

interface WorkflowListResponse extends ApiEnvelope {
  workflow?: Array<Record<string, unknown>>;
  total?: number | string;
}

export function registerListWorkflows(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_workflows',
    {
      title: 'List Wiro workflows',
      description: 'List workflows. scope "mine" lists the workflows in the API key\'s '
        + 'workspace (personal, or the team the key\'s project belongs to). scope "public" '
        + 'searches the public gallery of ready-made workflows, for example every workflow '
        + 'that uses a given model. Use the returned `fullSlug` with get_workflow, '
        + 'run_workflow, clone_workflow or update_workflow.',
      inputSchema: {
        scope: z.enum(['mine', 'public']).default('mine')
          .describe('"mine" for your workspace, "public" for the public gallery.'),
        search: z.string().max(200).optional()
          .describe('Text to look for in the title, description or tags.'),
        tags: z.array(z.string()).max(20).optional()
          .describe('Public gallery only: workflows with any of these tags.'),
        model: z.string().optional()
          .describe('Public gallery only: workflows that use this model, as "owner/model".'),
        visibility: z.enum(['private', 'public']).optional()
          .describe('scope "mine" only: only private or only published workflows.'),
        only_favorites: z.boolean().optional()
          .describe('Public gallery only: workflows you liked.'),
        sort: z.enum(['updatetime', 'createtime', 'title', 'runcount', 'likecount', 'clonecount', 'ratingscore'])
          .optional()
          .describe('scope "mine": updatetime (default), createtime or title. '
            + 'scope "public": createtime (default), runcount, likecount, clonecount or ratingscore.'),
        order: z.enum(['desc', 'asc']).default('desc').describe('Sort direction (default desc).'),
        start: z.number().int().min(0).max(10_000).default(0).describe('Pagination offset (default 0).'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum results (default 20, max 100).'),
      },
      outputSchema: {
        scope: z.enum(['mine', 'public']),
        workflows: z.array(workflowSummarySchema),
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
    async (args, extra) => {
      try {
        const body: Record<string, unknown> = {
          scope: args.scope === 'mine' ? 'my' : 'public',
          order: args.order.toUpperCase(),
          start: String(args.start),
          limit: String(args.limit),
        };
        if (args.search) body.search = args.search;
        if (args.scope === 'mine') {
          body.sort = args.sort && ['updatetime', 'createtime', 'title'].includes(args.sort)
            ? args.sort
            : 'updatetime';
          // The filter only reads the strings '0' and '1'.
          if (args.visibility) body.ispublic = args.visibility === 'public' ? '1' : '0';
        } else {
          if (args.sort && args.sort !== 'updatetime' && args.sort !== 'title') body.sort = args.sort;
          if (args.tags && args.tags.length > 0) body.tags = args.tags;
          if (args.model) body.model = args.model;
          if (args.only_favorites) body.onlyfavorites = '1';
          body.toolpreview = '1';
        }

        const result = requireApiSuccess(
          await client.post<WorkflowListResponse>('/Workflow/List', body, extra.signal),
          'Could not list workflows.',
        );
        const rows = result.workflow ?? [];
        const workflows: WorkflowSummary[] = rows.map(row => {
          const summary = toWorkflowSummary(row, { includeState: args.scope === 'mine' });
          if (args.scope === 'public' && Array.isArray(row.toolitems)) {
            const models = row.toolitems
              .map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>).slug : undefined))
              .filter((slug): slug is string => typeof slug === 'string');
            if (models.length > 0) summary.models = models;
          }
          return summary;
        });
        const total = toInteger(result.total, workflows.length);
        const nextStart = args.start + workflows.length < total ? args.start + workflows.length : null;

        const lines = [
          `## ${args.scope === 'mine' ? 'Your workflows' : 'Public workflows'} (${total} total)`,
          '',
        ];
        if (workflows.length === 0) lines.push('No workflows found.');
        for (const workflow of workflows) {
          const details = [
            workflow.state,
            workflow.stepCount !== undefined ? `${workflow.stepCount} steps` : undefined,
            // Your own protected originals stay readable to you; clones of a
            // protected workflow keep the graph hidden even from their owner.
            workflow.isProtected
              ? (args.scope === 'mine' && workflow.isClone === false ? 'graph hidden from others' : 'graph hidden')
              : undefined,
            workflow.runCount !== undefined ? `${workflow.runCount} gallery runs` : undefined,
          ].filter(Boolean).join(', ');
          lines.push(`- **${workflow.title}** \`${workflow.fullSlug}\`${details ? ` (${details})` : ''}`);
          if (workflow.description) lines.push(`  ${workflow.description}`);
        }
        if (nextStart !== null) lines.push('', `More results: call again with start=${nextStart}.`);

        const first = workflows[0];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            scope: args.scope,
            workflows,
            total,
            start: args.start,
            nextStart,
            ...(first
              ? {
                nextAction: {
                  tool: 'get_workflow',
                  arguments: { slug: first.fullSlug },
                  reason: 'Read a workflow\'s inputs and steps before running, cloning or editing it.',
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
