import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, isPlainObject, requireApiSuccess, toNumber, type ApiEnvelope } from '../utils/api.js';
import { templateSummarySchema, toTemplateSummary, type TemplateSummary } from '../utils/agent-catalog.js';
import { formatCredits, formatUsd } from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

const SORTS = {
  newest: { sort: 'id', order: 'DESC' },
  popular: { sort: 'totalrun', order: 'DESC' },
  title: { sort: 'title', order: 'ASC' },
} as const;

function priceLine(template: TemplateSummary): string {
  if (!template.pricing) return 'pricing unavailable';
  const { starter, pro } = template.pricing;
  return `Starter ${formatUsd(starter.priceUsd)} (${formatCredits(starter.monthlyCredits)} credits), `
    + `Pro ${formatUsd(pro.priceUsd)} (${formatCredits(pro.monthlyCredits)} credits) per 30 days`;
}

export function registerListAgentTemplates(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_agent_templates',
    {
      title: 'List Wiro agent templates',
      description: 'Browse the catalog of ready-made Wiro agents (templates) that deploy_agent can deploy. '
        + 'Each template shows its Starter and Pro price in USD per 30 days and the monthly credit pool '
        + 'that pays for the agent\'s model usage (100 credits = 1 USD). A template whose pricing is null '
        + 'cannot be priced right now: do not quote or deploy it. Call get_agent_template next for the '
        + 'skills, the credentials the user must provide and the exact prices. To build an agent from '
        + 'individual skills instead, use list_agent_skills. get_playbook describes the whole flow from '
        + 'choosing a template to a running agent.',
      inputSchema: {
        search: z.string().max(200).optional()
          .describe('Words to look for in the title, description, slug and categories, for example "instagram". Results are sorted by relevance when set.'),
        category: z.string().max(200).optional()
          .describe('Category filter, for example "social-media". Separate several categories with commas.'),
        sort: z.enum(['newest', 'popular', 'title']).default('newest')
          .describe('Order when no search is given: newest first, most deployed first, or by title.'),
        start: z.number().int().min(0).default(0)
          .describe('Pagination offset (default 0).'),
        limit: z.number().int().min(1).max(100).default(20)
          .describe('Maximum templates to return (default 20, max 100).'),
      },
      outputSchema: {
        templates: z.array(templateSummarySchema),
        total: z.number().int().nonnegative(),
        start: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
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
    async ({ search, category, sort, start, limit }, extra) => {
      try {
        const order = SORTS[sort];
        const body = requireApiSuccess(
          await client.post<ApiEnvelope & { agents?: unknown; total?: unknown }>('/Agent/List', {
            ...(search?.trim() ? { search: search.trim() } : {}),
            ...(category?.trim() ? { category: category.trim() } : {}),
            sort: order.sort,
            order: order.order,
            start,
            limit,
          }, extra.signal),
          'The agent catalog could not be read.',
        );
        const rows = Array.isArray(body.agents) ? body.agents.filter(isPlainObject) : [];
        const templates = rows.map(toTemplateSummary).filter(template => template.guid && template.slug);
        const total = Math.max(0, Math.trunc(toNumber(body.total) ?? templates.length));
        const nextStart = start + rows.length < total ? start + rows.length : null;
        const first = templates[0];

        const range = rows.length > 0 ? `${start + 1}-${start + rows.length} of ${total}` : `none of ${total}`;
        const lines = [`## Agent templates (${range})`, ''];
        if (templates.length === 0) lines.push('No templates matched.');
        for (const template of templates) {
          lines.push(`- **${template.title}** (\`${template.slug}\`): ${priceLine(template)}`);
          if (template.summary) lines.push(`  ${template.summary}`);
        }
        if (nextStart !== null) lines.push('', `More templates: call list_agent_templates with start ${nextStart}.`);
        if (first) lines.push('', `Next: get_agent_template with template "${first.slug}" shows its skills, required credentials and exact prices.`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            templates,
            total,
            start,
            limit,
            nextStart,
            ...(first
              ? {
                nextAction: {
                  tool: 'get_agent_template',
                  arguments: { template: first.slug },
                  reason: 'Read the skills, required credentials and exact prices before deploying.',
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
