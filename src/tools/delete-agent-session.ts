import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  isPlainObject,
  requireApiSuccess,
  toNumber,
} from '../utils/api.js';
import {
  AGENT_INPUT_DESCRIPTION,
  agentRequestBody,
  agentSessionProblem,
  callAgent,
  resolveAgentTarget,
  type AgentTarget,
} from '../utils/agent-targets.js';
import { nextActionSchema } from './schemas.js';

/** The session's row in the key's session list, or null when the list cannot be read. */
async function findSession(
  client: WiroClient,
  target: AgentTarget,
  session: string,
  signal: AbortSignal,
): Promise<{ listed: boolean; messageCount: number | null } | null> {
  try {
    const response = requireApiSuccess(
      await callAgent(client, target, 'sessions', agentRequestBody(target, undefined), signal),
      '',
    );
    const data = isPlainObject(response.data) ? response.data : {};
    const rows = Array.isArray(data.sessions) ? data.sessions.filter(isPlainObject) : [];
    const row = rows.find(candidate => asString(candidate.sessionkey) === session);
    return row ? { listed: true, messageCount: toNumber(row.messagecount) } : { listed: false, messageCount: null };
  } catch {
    return null;
  }
}

/** Pause before the second look at a session list that did not show the session. */
export const SESSION_RECHECK_MS = 2_000;

function notFoundSummary(target: AgentTarget, session: string): string {
  const owner = target.kind === 'deployed' ? 'this agent' : target.kind === 'studio' ? 'Studio' : 'the Workflow Agent';
  return `Session "${session}" is not in this API key's session list for ${owner}, so nothing was deleted. `
    + 'If it was started in the last few seconds, try again shortly.'
    + (target.kind === 'workflow-agent'
      ? ' An API key reaches only the Workflow Agent sessions of its own project, not chats on wiro.ai or another project\'s.'
      : '');
}

function deletionSummary(target: AgentTarget, session: string): string {
  const scope = target.kind === 'studio' && session === 'default'
    ? 'the main Studio chat on wiro.ai'
    : target.kind === 'deployed' && session === 'default'
      ? 'your agent\'s main chat, including its voice call records'
      : `session "${session}"`;
  return `This permanently deletes every message you sent and received in ${scope}, including a turn that is `
    + 'still running, and resets the agent\'s memory of it. It cannot be undone.';
}

export function registerDeleteAgentSession(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'delete_agent_session',
    {
      title: 'Delete an agent conversation',
      description: 'Permanently delete one conversation (session) with Studio, the Workflow Agent or one of your '
        + 'deployed agents, and reset the agent\'s memory of it so the next message in that session starts fresh. '
        + 'Without confirm: true it only describes what would be deleted; ask the user before confirming. Cancel a '
        + 'running turn first with cancel_agent_message. Studio keeps a display name the session was given on '
        + 'wiro.ai. The Workflow Agent\'s "default" session cannot be deleted. Model outputs and saved workflows '
        + 'are not affected.',
      inputSchema: {
        agent: z.string().min(1).describe(AGENT_INPUT_DESCRIPTION),
        session: z.string().min(1).describe('The session to delete (from get_agent_conversation).'),
        confirm: z.boolean().default(false)
          .describe('Set to true only after the user agreed to the permanent deletion.'),
      },
      outputSchema: {
        agent: z.string(),
        agentKind: z.enum(['studio', 'workflow-agent', 'deployed']),
        session: z.string(),
        deleted: z.boolean(),
        memoryReset: z.boolean(),
        messageCount: z.number().nullable().optional(),
        summary: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent, session, confirm }, extra) => {
      try {
        const target = resolveAgentTarget(agent);
        const problem = agentSessionProblem(target, session);
        if (problem) throw new Error(problem);
        if (target.kind === 'workflow-agent' && session === 'default') {
          throw new Error('The Workflow Agent\'s main session ("default") cannot be deleted.');
        }
        const base = { agent: target.agent, agentKind: target.kind, session };

        // The delete call answers success for a session that never existed, so check
        // the list first. Studio's and a deployed agent's main chat always exist. The
        // list can lag behind a session started moments ago, so a missing session is
        // looked up once more after a pause.
        let found = await findSession(client, target, session, extra.signal);
        if (found && !found.listed && session !== 'default') {
          await new Promise(resolve => setTimeout(resolve, SESSION_RECHECK_MS));
          found = (await findSession(client, target, session, extra.signal)) ?? found;
        }
        if (found && !found.listed && session !== 'default') {
          const summary = notFoundSummary(target, session);
          return {
            content: [{ type: 'text' as const, text: `## Nothing to delete\n\n${summary}` }],
            structuredContent: { ...base, deleted: false, memoryReset: false, messageCount: 0, summary },
          };
        }

        if (!confirm) {
          const messageCount = found ? found.messageCount : null;
          const summary = deletionSummary(target, session)
            + (messageCount !== null ? ` The session holds ${messageCount} message(s).` : '');
          return {
            content: [{ type: 'text' as const, text: `## Confirm deletion\n\n${summary}\n\nAsk the user to confirm, then call delete_agent_session again with confirm: true.` }],
            structuredContent: {
              ...base,
              deleted: false,
              memoryReset: false,
              messageCount,
              summary,
              nextAction: {
                tool: 'delete_agent_session',
                arguments: { agent: target.agent, session, confirm: true },
                reason: 'Ask the user to confirm this permanent deletion first.',
              },
            },
          };
        }

        // Studio: ClearSession is the call that both deletes and resets memory
        // for any session. The other two always reset when asked to.
        const body = target.kind === 'deployed'
          ? agentRequestBody(target, session, { rotate: true })
          : agentRequestBody(target, session);
        requireApiSuccess(
          await callAgent(client, target, 'deleteSession', body, extra.signal),
          'The session could not be deleted.',
        );

        const summary = `Deleted session "${session}". The next message in this session starts without memory `
          + 'of the old conversation.'
          + (target.kind === 'studio' ? ' A display name set on wiro.ai stays on the now empty session.' : '');
        return {
          content: [{ type: 'text' as const, text: `## Session deleted\n\n${summary}` }],
          structuredContent: { ...base, deleted: true, memoryReset: true, summary },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
