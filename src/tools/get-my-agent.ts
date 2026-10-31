import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult } from '../utils/api.js';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from '../utils/poll.js';
import {
  agentDetailSchema,
  describeAgentStatus,
  formatAgentDetail,
  isTransitionalStatus,
  nextStepForAgent,
  readAgentDetail,
  readAgentStatus,
  settledStatusAdvice,
  toAgentDetail,
  waitForAgentToSettle,
} from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

export function registerGetMyAgent(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_my_agent',
    {
      title: 'Get a deployed Wiro agent',
      description: 'Read the full state of one deployed agent: status (number and label), plan and credit '
        + 'balance, time zone, skills, chat channels, model settings, scheduled tasks, custom instructions and the state '
        + 'of each credential. Credential values are never returned, only whether each one is filled, '
        + 'connected or missing. With wait_seconds it keeps reading until the agent is no longer stopping, '
        + 'queued or starting; when the wait runs out, follow the returned nextAction instead of repeating '
        + 'the action that started it. Statuses: 0 stopped, 1 stopping, 2 queued, 3 starting, 4 running, '
        + '5 error, 6 setup required.',
      inputSchema: {
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0)
          .describe('Keep reading for up to this many seconds while the agent is stopping, queued or starting (0 to 600, default 0 for an immediate read). 45 or less is safe for clients with a 60 second tool timeout; follow nextAction to keep waiting.'),
      },
      outputSchema: {
        agent: agentDetailSchema,
        settled: z.boolean(),
        waitedSeconds: z.number().nonnegative().optional(),
        advice: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, wait_seconds }, extra) => {
      try {
        const guid = agent_guid.trim();
        let row = await readAgentDetail(client, guid, extra.signal);
        let waitedSeconds: number | undefined;
        let settled = !isTransitionalStatus(readAgentStatus(row));
        if (!settled && wait_seconds > 0) {
          const waited = await waitForAgentToSettle(client, guid, wait_seconds, extra, row);
          row = waited.row;
          settled = waited.settled;
          waitedSeconds = Math.round(waited.elapsedMs / 1000);
        }
        const agent = toAgentDetail(row);
        const advice = settled
          ? settledStatusAdvice(agent.status)
          : `The agent is still ${describeAgentStatus(agent.status).toLowerCase()}. Call get_my_agent again with wait_seconds to keep waiting.`;
        const nextAction = !settled && wait_seconds > 0
          ? {
            tool: 'get_my_agent',
            arguments: { agent_guid: guid, wait_seconds: DEFAULT_WAIT_SECONDS },
            reason: 'The agent has not settled yet. Keep waiting; do not repeat the action that started it.',
          }
          : nextStepForAgent(agent, DEFAULT_WAIT_SECONDS);

        return {
          content: [{
            type: 'text' as const,
            text: `${formatAgentDetail(agent)}\n\n${advice}`,
          }],
          structuredContent: {
            agent,
            settled,
            ...(waitedSeconds !== undefined ? { waitedSeconds } : {}),
            advice,
            ...(nextAction ? { nextAction } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
