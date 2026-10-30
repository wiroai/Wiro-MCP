import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  truncate,
  unixToIso,
} from '../utils/api.js';
import {
  agentMessageSchema,
  extractMediaUrls,
  extractReply,
  isTerminalMessageStatus,
  isVoiceCallText,
  sessionKeyProblem,
  toAgentMessage,
  type AgentMessage,
} from '../utils/agent-message.js';
import {
  AGENT_INPUT_DESCRIPTION,
  agentRequestBody,
  agentSessionProblem,
  callAgent,
  resolveAgentTarget,
  type AgentTarget,
} from '../utils/agent-targets.js';
import {
  summarizeWorkflowReply,
  workflowArtifactSummarySchema,
  workflowReplyProse,
  type WorkflowArtifactSummary,
} from '../utils/workflow-agent.js';
import { nextActionSchema } from './schemas.js';

const MAX_HISTORY_REPLY = 4_000;
const MAX_LAST_MESSAGE = 200;

const sessionSummarySchema = z.object({
  session: z.string(),
  name: z.string().optional(),
  messageCount: z.number().nullable(),
  updatedAt: z.string().optional(),
  lastMessage: z.string().optional(),
});

const historyMessageSchema = agentMessageSchema.extend({
  workflows: z.array(workflowArtifactSummarySchema).optional(),
});

type HistoryMessage = AgentMessage & { workflows?: WorkflowArtifactSummary[] };

function sessionPreview(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  if (!text) return undefined;
  // A voice call row starts with the caller's number; it is not ours to pass on.
  if (isVoiceCallText(text)) return 'Voice call';
  return truncate(text.replace(/\s+/g, ' '), MAX_LAST_MESSAGE);
}

function historyMessage(target: AgentTarget, row: Record<string, unknown>): HistoryMessage {
  const message = toAgentMessage(row, { includeUserText: true, includePartial: true });
  // Voice rows come back with only their id, status and times, as in get_agent_message.
  if (message.kind === 'voice_call') return message;

  let reply = message.reply ?? '';
  let replyCut = message.replyTruncated === true;
  let workflows: WorkflowArtifactSummary[] | undefined;
  let mediaUrls = message.mediaUrls;
  if (target.kind === 'workflow-agent' && row.status === 'agent_end') {
    // Keep the prose; the fenced JSON is summarized instead of repeated.
    const summary = summarizeWorkflowReply(extractReply(row));
    reply = summary.prose;
    replyCut = false;
    if (summary.workflows.length > 0) workflows = summary.workflows;
    mediaUrls = extractMediaUrls(summary.prose);
  } else if (target.kind === 'workflow-agent' && !isTerminalMessageStatus(row.status)) {
    reply = workflowReplyProse(extractReply(row));
    replyCut = false;
  }

  const { reply: _reply, replyTruncated: _truncated, ...rest } = message;
  const shortened = truncate(reply, MAX_HISTORY_REPLY);
  return {
    ...rest,
    ...(shortened ? { reply: shortened } : {}),
    ...(shortened.length < reply.length || replyCut ? { replyTruncated: true } : {}),
    mediaUrls,
    ...(workflows ? { workflows } : {}),
  };
}

function formatSessions(target: AgentTarget, sessions: Array<z.infer<typeof sessionSummarySchema>>): string {
  const lines = [`## Sessions with ${target.label}`, ''];
  if (sessions.length === 0) {
    lines.push('No sessions yet.');
    return lines.join('\n');
  }
  for (const session of sessions) {
    const parts = [`\`${session.session}\`${session.name ? ` (${session.name})` : ''}`];
    if (session.messageCount !== null) parts.push(`${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`);
    if (session.updatedAt) parts.push(`updated ${session.updatedAt}`);
    lines.push(`- ${parts.join(' · ')}`);
    if (session.lastMessage) lines.push(`  - ${session.lastMessage}`);
  }
  return lines.join('\n');
}

function formatHistory(session: string, messages: HistoryMessage[], hasMore: boolean): string {
  const lines = [`## Conversation \`${session}\` (newest first)`, ''];
  if (messages.length === 0) lines.push('No messages.');
  for (const message of messages) {
    lines.push(`### ${message.createdAt ?? 'unknown time'} · ${message.state} · \`${message.messageId}\``);
    if (message.kind === 'voice_call') {
      lines.push('Voice call (details are not shown here).', '');
      continue;
    }
    if (message.userText) lines.push(`**User:** ${truncate(message.userText, 500)}`);
    if (message.reply) lines.push(`**Agent:** ${truncate(message.reply, 1_500)}`);
    for (const url of message.mediaUrls) lines.push(`- ${url}`);
    for (const workflow of message.workflows ?? []) {
      lines.push(`- Workflow ${workflow.title ? `"${workflow.title}"` : workflow.index + 1}: `
        + `${workflow.valid ? 'valid' : workflow.status}`
        + (workflow.artifactHash ? `, artifact_hash \`${workflow.artifactHash}\`` : ''));
    }
    lines.push('');
  }
  if (hasMore) lines.push('Older messages exist; follow nextAction to read them.');
  return lines.join('\n');
}

export function registerGetAgentConversation(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_agent_conversation',
    {
      title: 'Get agent conversations',
      description: 'Without session: list your conversations (sessions) with Studio, the Workflow Agent or one '
        + 'of your deployed agents, most recent first. With session: read that conversation, newest message '
        + 'first, with hasMore and nextBefore for older pages. Use it to find a session to continue, to pick up '
        + 'a result an agent delivered later in the background, or to check whether a message was queued before '
        + 'sending it again. Studio sessions are the same ones the user sees in Studio on wiro.ai. Workflow Agent '
        + 'sessions listed here are the ones this API key\'s project used; the user\'s own Workflow Agent chats on '
        + 'wiro.ai are separate and are not listed. Studio\'s late results do not show here for a team project\'s '
        + 'key; list_studio_results has their model runs. Workflow Agent replies list their workflows with '
        + 'artifact_hash for save_workflow_from_agent. Voice call details are not returned. Media from Wiro is in '
        + 'mediaUrls; share other links from a reply as plain links. Read-only.',
      inputSchema: {
        agent: z.string().min(1).describe(AGENT_INPUT_DESCRIPTION),
        session: z.string().optional().describe('The conversation to read. Leave it out to list the sessions.'),
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Messages per page when reading a session (1-200, default 20).'),
        before: z.string().optional()
          .describe('Message id to page back from: pass nextBefore from the previous page.'),
      },
      outputSchema: {
        agent: z.string(),
        agentKind: z.enum(['studio', 'workflow-agent', 'deployed']),
        session: z.string().optional(),
        sessions: z.array(sessionSummarySchema).optional(),
        messages: z.array(historyMessageSchema).optional(),
        hasMore: z.boolean().optional(),
        nextBefore: z.string().optional(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent, session, limit, before }, extra) => {
      try {
        const target = resolveAgentTarget(agent);

        if (session === undefined || session.trim() === '') {
          const response = requireApiSuccess(
            await callAgent(client, target, 'sessions', agentRequestBody(target, undefined), extra.signal),
            'Could not list the sessions.',
          );
          const data = isPlainObject(response.data) ? response.data : {};
          const rows = Array.isArray(data.sessions) ? data.sessions.filter(isPlainObject) : [];
          const sessions = rows
            .map(row => ({ row, key: asString(row.sessionkey) ?? '' }))
            // Reserved sessions belong to Wiro's own scheduling and voice plumbing and cannot be read.
            .filter(({ key }) => key !== '' && sessionKeyProblem(key) === null)
            .map(({ row, key }) => {
              const updatedAt = unixToIso(row.updatedat);
              const lastMessage = sessionPreview(row.lastmessage);
              const name = asString(row.name);
              return {
                session: key,
                ...(name ? { name } : {}),
                messageCount: toNumber(row.messagecount),
                ...(updatedAt ? { updatedAt } : {}),
                ...(lastMessage ? { lastMessage } : {}),
              };
            });
          const newest = sessions[0];
          return {
            content: [{ type: 'text' as const, text: formatSessions(target, sessions) }],
            structuredContent: {
              agent: target.agent,
              agentKind: target.kind,
              sessions,
              ...(newest
                ? {
                  nextAction: {
                    tool: 'get_agent_conversation',
                    arguments: { agent: target.agent, session: newest.session },
                    reason: 'Read the most recent conversation.',
                  },
                }
                : {}),
            },
          };
        }

        const problem = agentSessionProblem(target, session);
        if (problem) throw new Error(problem);
        const response = requireApiSuccess(
          await callAgent(client, target, 'history', agentRequestBody(target, session, {
            limit,
            ...(before ? { before } : {}),
          }), extra.signal),
          'Could not read the conversation.',
        );
        const data = isPlainObject(response.data) ? response.data : {};
        const rows = Array.isArray(data.messages) ? data.messages.filter(isPlainObject) : [];
        const messages = rows.map(row => historyMessage(target, row));
        const hasMore = data.hasmore === true && messages.length > 0;
        const nextBefore = hasMore ? messages[messages.length - 1]!.messageId : undefined;

        return {
          content: [{ type: 'text' as const, text: formatHistory(session, messages, hasMore) }],
          structuredContent: {
            agent: target.agent,
            agentKind: target.kind,
            session,
            messages,
            hasMore,
            ...(nextBefore ? { nextBefore } : {}),
            ...(nextBefore
              ? {
                nextAction: {
                  tool: 'get_agent_conversation',
                  arguments: { agent: target.agent, session, limit, before: nextBefore },
                  reason: 'Read the next page of older messages.',
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
