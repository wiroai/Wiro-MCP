import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult } from '../utils/api.js';
import { customSkillEntries, resolveExistingCustomSkillKey } from '../utils/agent-config.js';
import { textBlock } from '../utils/quoted-text.js';
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
import { isPlainTeamMember } from '../utils/workspace.js';
import { nextActionSchema } from './schemas.js';

const entrySchema = z.object({
  key: z.string(),
  kind: z.enum(['custom_instruction', 'scheduled_task']),
  description: z.string().optional(),
  enabled: z.boolean(),
  interval: z.string().nullable(),
  text: z.string(),
});

export function registerGetMyAgent(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_my_agent',
    {
      title: 'Get a deployed Wiro agent',
      description: 'Read the full state of one deployed agent: status (number and label), plan, its Starter and Pro '
        + 'prices, credit balance, time zone, skills, chat channels, model settings with the credit rates of the models it can switch to, '
        + 'scheduled tasks and custom instructions (a long text is shortened; entry adds one entry\'s whole text), and the '
        + 'state of each credential. Credential values are never returned, only whether each one is filled, '
        + 'connected or missing. With wait_seconds it keeps reading until the agent is no longer stopping, '
        + 'queued or starting; when the wait runs out, follow the returned nextAction instead of repeating '
        + 'the action that started it. Statuses: 0 stopped, 1 stopping, 2 queued, 3 starting, 4 running, '
        + '5 error, 6 setup required.',
      inputSchema: {
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        entry: z.string().min(1).max(80).optional()
          .describe('The key of one custom instruction or scheduled task, such as cs-brand-voice, or its bare name such as brand-voice. Adds that entry\'s whole text, which the list shortens when it is long. Read it before changing the entry with manage_agent_custom_skill.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0)
          .describe('Keep reading for up to this many seconds while the agent is stopping, queued or starting (0 to 600, default 0 for an immediate read). 45 or less is safe for clients with a 60 second tool timeout; follow nextAction to keep waiting.'),
      },
      outputSchema: {
        agent: agentDetailSchema,
        settled: z.boolean(),
        waitedSeconds: z.number().nonnegative().optional(),
        advice: z.string(),
        entry: entrySchema.optional(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, entry, wait_seconds }, extra) => {
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
        // The list shows the start of a long entry; the row holds its whole text.
        let full: z.infer<typeof entrySchema> | undefined;
        if (entry !== undefined) {
          const entries = customSkillEntries(row);
          const resolved = resolveExistingCustomSkillKey(entry, new Set(entries.map(item => item.key)));
          const found = resolved.key ? entries.find(item => item.key === resolved.key) : undefined;
          if (!found) {
            return errorResult(new Error(resolved.error
              ?? `This agent has no custom instruction or scheduled task named "${entry}". get_my_agent without entry lists its keys.`));
          }
          full = {
            key: found.key,
            kind: found.kind === 'scheduled_task' ? 'scheduled_task' : 'custom_instruction',
            ...(found.description ? { description: found.description } : {}),
            enabled: found.enabled,
            interval: found.interval,
            text: found.value,
          };
        }
        const plainMember = await isPlainTeamMember(client, row, extra.signal);
        const advice = settled
          ? settledStatusAdvice(agent.status, plainMember, agent)
          : `The agent is still ${describeAgentStatus(agent.status).toLowerCase()}. Call get_my_agent again with wait_seconds to keep waiting.`;
        const nextAction = !settled && wait_seconds > 0
          ? {
            tool: 'get_my_agent',
            arguments: { agent_guid: guid, wait_seconds: DEFAULT_WAIT_SECONDS },
            reason: 'The agent has not settled yet. Keep waiting; do not repeat the action that started it.',
          }
          : nextStepForAgent(agent, DEFAULT_WAIT_SECONDS, plainMember);

        return {
          content: [{
            type: 'text' as const,
            text: [
              formatAgentDetail(agent, plainMember),
              ...(full ? ['', `### \`${full.key}\` in full`, '', ...textBlock(full.text)] : []),
              '',
              advice,
            ].join('\n'),
          }],
          structuredContent: {
            agent,
            settled,
            ...(waitedSeconds !== undefined ? { waitedSeconds } : {}),
            advice,
            ...(full ? { entry: full } : {}),
            ...(nextAction ? { nextAction } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
