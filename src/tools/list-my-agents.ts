import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, isPlainObject, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import {
  agentSummarySchema,
  describeAgentStatus,
  formatCredits,
  formatSubscriptionLine,
  toAgentSummary,
} from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

const SORTS = {
  newest: { sort: 'id', order: 'DESC' },
  oldest: { sort: 'id', order: 'ASC' },
  title: { sort: 'title', order: 'ASC' },
  status: { sort: 'status', order: 'ASC' },
  recently_updated: { sort: 'updatedat', order: 'DESC' },
} as const;

export function registerListMyAgents(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_my_agents',
    {
      title: 'List my deployed Wiro agents',
      description: 'List the agents deployed in the workspace this API key belongs to (a team project\'s key '
        + 'lists the team\'s agents, any other key lists the personal ones). Each row shows the status, '
        + 'whether setup is still required, the plan and the credit balance. Call get_my_agent with an '
        + 'agent_guid for the full state, including which credentials are missing.',
      inputSchema: {
        sort: z.enum(['newest', 'oldest', 'title', 'status', 'recently_updated']).default('newest')
          .describe('Order of the list (default newest first).'),
        start: z.number().int().min(0).default(0)
          .describe('Pagination offset (default 0).'),
        limit: z.number().int().min(1).max(50).default(20)
          .describe('Maximum agents to return (default 20, max 50).'),
      },
      outputSchema: {
        agents: z.array(agentSummarySchema),
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
    async ({ sort, start, limit }, extra) => {
      try {
        const order = SORTS[sort];
        const body = requireApiSuccess(
          await client.post<ApiEnvelope & { useragents?: unknown }>('/UserAgent/MyAgents', {
            sort: order.sort,
            order: order.order,
            start,
            limit,
          }, extra.signal),
          'Your agents could not be listed.',
        );
        const rows = Array.isArray(body.useragents) ? body.useragents.filter(isPlainObject) : [];
        const agents = rows.map(toAgentSummary).filter(agent => agent.guid);
        // The endpoint has no total, so a full page means there may be more.
        const nextStart = rows.length >= limit ? start + rows.length : null;
        const first = agents[0];

        const lines = [`## My agents (${agents.length})`, ''];
        if (agents.length === 0) {
          lines.push(start === 0
            ? 'No agents are deployed in this workspace. list_agent_templates shows what can be deployed.'
            : 'No more agents.');
        }
        for (const agent of agents) {
          lines.push(
            `- **${agent.title}** (\`${agent.guid}\`): ${describeAgentStatus(agent.status)}${agent.setupRequired ? ', setup required' : ''}; `
            + `${agent.tier ?? 'no tier'}; ${formatCredits(agent.credits.remaining)} credits left; ${formatSubscriptionLine(agent.subscription)}`,
          );
        }
        if (nextStart !== null) lines.push('', `More agents may exist: call list_my_agents with start ${nextStart}.`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            agents,
            start,
            limit,
            nextStart,
            ...(first
              ? {
                nextAction: {
                  tool: 'get_my_agent',
                  arguments: { agent_guid: first.guid },
                  reason: 'Read the full state of an agent, including missing credentials.',
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
