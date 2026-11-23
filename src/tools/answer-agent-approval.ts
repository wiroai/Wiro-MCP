import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  hasErrorCode,
  isPlainObject,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  APPROVAL_ANSWERS,
  APPROVAL_ANSWERS_EXPLAINED,
  APPROVAL_RIGHTS,
  approvalHeadline,
  approvalSchema,
  formatApproval,
  toApproval,
  waitingApproval,
  type Approval,
  type ApprovalAnswer,
} from '../utils/agent-approvals.js';
import { listConnections } from '../utils/agent-connectors.js';
import { toAgentMessage } from '../utils/agent-message.js';
import { readAgentMessage, resolveAgentTarget, type AgentTarget } from '../utils/agent-targets.js';
import {
  COLUMN_TITLES,
  PERMISSION_COLUMNS,
  permissionValueSchema,
  readConnectorPermissions,
  VALUE_TITLES,
  type PermissionValue,
} from '../utils/connector-permissions.js';
import { jsonSpan, quotedSpan } from '../utils/quoted-text.js';
import type { NextAction } from '../utils/structured.js';
import { nextActionSchema, strictInput } from './schemas.js';

// The connections whose waiting cards are read, at most, when the card's own message cannot be read here.
const MAX_WAITING_LOOKUPS = 12;
const MESSAGE_NOT_FOUND = /message not found/i;

const resumeSchema = z.object({
  status: z.enum(['queued', 'not_running', 'refused'])
    .describe('queued: Wiro started a new turn in the chat the card is in, and the agent goes on with the action there. not_running: the agent is not running, so nothing ran. refused: the turn could not start, for the reason in message.'),
  messageId: z.string().optional()
    .describe('The new turn\'s message, for get_agent_message. Left out when this connection does not read that chat.'),
  session: z.string().optional().describe('The session the new turn runs in.'),
  message: z.string().optional(),
});

type Resume = z.infer<typeof resumeSchema>;

const outputSchema = {
  agent: z.string(),
  messageguid: z.string(),
  cardid: z.string(),
  answer: z.enum(APPROVAL_ANSWERS),
  outcome: z.enum(['preview', 'answered', 'not_waiting', 'refused'])
    .describe('preview: the card is shown and nothing changed. answered: Wiro took the answer. not_waiting: the card was already answered or expired. refused: Wiro did not take the answer, for the reason in message.'),
  approval: approvalSchema.optional().describe('The card, as it is now.'),
  summary: z.string().optional().describe('Wiro\'s summary of the answer, such as "Allowed once."'),
  resume: resumeSchema.optional(),
  permissions: z.object({
    connector: z.string(),
    tool: z.string(),
    chat: permissionValueSchema,
    autopilot: permissionValueSchema,
  }).optional().describe('After always: the action\'s permissions in Chat and Autopilot now.'),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type ActBody = ApiEnvelope & { approval?: unknown; summary?: unknown; resume?: unknown; permissions?: unknown };

interface Call {
  target: AgentTarget;
  agentGuid: string;
  messageguid: string;
  cardid: string;
  answer: ApprovalAnswer;
}

/** What an answer does, in words, for the card it would answer. */
function answerText(approval: Approval, answer: ApprovalAnswer): string {
  switch (answer) {
    case 'allow':
      return 'Allow runs this one call once: the agent goes on with it in a new turn of the chat the card is in, and '
        + 'the approval holds for an hour.';
    case 'always':
      return `Always allow runs this call once now. ${approval.alwaysChanges} A column set to Block stays blocked. `
        + 'Only an agent admin can choose it: the person who deployed the agent, or a team admin of its team.';
    default:
      return 'Decline turns down this one call. The agent gets no new turn, and if it asks for the same action again '
        + 'later, a new card asks again.';
  }
}

/**
 * The card, read from its message. When that message cannot be read with this connection, such as the owner's own
 * chat of a team agent with private chats, the card is looked for among the cards waiting for the agent's connectors,
 * which an agent admin can read.
 */
async function findCard(client: WiroClient, call: Call, signal: AbortSignal): Promise<Approval | 'no-card' | 'no-message'> {
  try {
    const row = await readAgentMessage(client, call.target, call.messageguid, undefined, signal);
    const message = toAgentMessage(row, { agent: call.target.agent });
    return message.approvals?.find(item => item.cardid === call.cardid) ?? 'no-card';
  } catch (error) {
    if (signal.aborted) throw error;
    if (!(error instanceof ApiResultError) || !MESSAGE_NOT_FOUND.test(error.message)) throw error;
  }
  return (await findWaitingCard(client, call, signal)) ?? 'no-message';
}

async function findWaitingCard(client: WiroClient, call: Call, signal: AbortSignal): Promise<Approval | undefined> {
  let connections;
  try {
    connections = await listConnections(client, call.agentGuid, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
  for (const connection of connections.filter(item => item.status === 'connected').slice(0, MAX_WAITING_LOOKUPS)) {
    try {
      const read = await readConnectorPermissions(client, call.agentGuid, connection.connector, signal);
      const item = read.waiting.find(entry => entry.cardid === call.cardid && entry.messageguid === call.messageguid);
      if (item) return waitingApproval(item, read.connector, read.view, call.target.agent);
    } catch (error) {
      if (signal.aborted) throw error;
      // Only an agent admin reads them: a refusal is the same for every connector.
      if (hasErrorCode(error, 96) || hasErrorCode(error, 97)) return undefined;
    }
  }
  return undefined;
}

function base(call: Call) {
  return { agent: call.target.agent, messageguid: call.messageguid, cardid: call.cardid, answer: call.answer };
}

function confirmStep(call: Call): NextAction {
  return {
    tool: 'answer_agent_approval',
    arguments: { ...base(call), confirm: true },
    reason: 'Only after the user answered: repeat this with their answer (allow, always or decline) and confirm: true. '
      + 'Never answer on your own.',
  };
}

function preview(call: Call, approval: Approval) {
  if (approval.status !== 'pending') {
    const state = approval.status === 'expired'
      ? `It expired${approval.error ? `: ${approval.error}` : ''}${/[.!?]$/.test(approval.error ?? '') ? '' : '.'}`
      : `It was already answered: ${approval.status === 'declined' ? 'declined' : approval.status === 'always' ? 'always allowed' : 'allowed once'}${approval.answeredAt ? ` at ${approval.answeredAt}` : ''}.`;
    const message = `${state} There is nothing to answer. If the user still wants the action, ask the agent again: a new call makes a new card.`;
    return {
      content: [{ type: 'text' as const, text: [`## Approval: ${approvalHeadline(approval)}`, '', message, '', ...formatApproval(approval, 'The card')].join('\n') }],
      structuredContent: { ...base(call), outcome: 'not_waiting' as const, approval, message },
    };
  }
  const nextAction = confirmStep(call);
  const message = `${quotedSpan(approval.action)} in ${approval.connectorTitle} waits for an answer`
    + `${approval.expiresAt ? ` until ${approval.expiresAt}` : ''}, and nothing has changed yet. ${answerText(approval, call.answer)} `
    + 'Show the user the request and ask whether to allow it once, always allow it or decline it; then answer with '
    + 'their answer and confirm: true.';
  return {
    content: [{
      type: 'text' as const,
      text: [
        `## Approval: ${approvalHeadline(approval)}`,
        '',
        message,
        '',
        ...formatApproval(approval, 'The card'),
        '',
        `What each answer does: ${APPROVAL_ANSWERS_EXPLAINED} ${APPROVAL_RIGHTS}`,
        '',
        `**Next:** after the user's answer, \`answer_agent_approval\` with ${jsonSpan(nextAction.arguments)}, with answer set to their answer.`,
      ].join('\n'),
    }],
    structuredContent: { ...base(call), outcome: 'preview' as const, approval, message, nextAction },
  };
}

function toResume(value: unknown): Resume | undefined {
  if (!isPlainObject(value)) return undefined;
  const status = asString(value.status);
  if (status !== 'queued' && status !== 'not_running' && status !== 'refused') return undefined;
  const messageId = asString(value.messageguid);
  const session = asString(value.sessionkey);
  const message = asString(value.message)?.replace(/\s+/g, ' ').trim();
  // The turn's live token is never passed on.
  return {
    status,
    ...(messageId ? { messageId } : {}),
    ...(session ? { session } : {}),
    ...(message ? { message } : {}),
  };
}

function resumeText(resume: Resume | undefined, answer: ApprovalAnswer): string {
  if (answer === 'decline' || !resume) {
    return answer === 'decline' ? 'The agent gets no new turn, and a later call of the same action asks again.' : '';
  }
  switch (resume.status) {
    case 'queued':
      return resume.messageId
        ? `The agent goes on with it in a new turn (message \`${resume.messageId}\`${resume.session ? `, session "${resume.session}"` : ''}): get_agent_message reads its answer.`
        : 'The agent goes on with it in a new turn of the chat the card is in, which this connection does not read.';
    case 'not_running':
      return `${resume.message ? `${resume.message} ` : ''}Start it with control_agent, then ask it again in the same chat within the hour.`;
    default:
      return `No new turn started${resume.message ? `: ${resume.message}` : '.'} The approval holds for an hour: once that is sorted out, ask the agent again in the same chat.`;
  }
}

function toPermissions(value: unknown) {
  if (!isPlainObject(value)) return undefined;
  const connector = asString(value.connector);
  const tool = asString(value.tool);
  const chat = permissionValueSchema.safeParse(value.chat);
  const autopilot = permissionValueSchema.safeParse(value.autopilot);
  if (!connector || !tool || !chat.success || !autopilot.success) return undefined;
  return { connector, tool, chat: chat.data, autopilot: autopilot.data };
}

function permissionsText(action: string, values: Record<'chat' | 'autopilot', PermissionValue>): string {
  return `${action} now reads ${PERMISSION_COLUMNS.map(column => `${COLUMN_TITLES[column]} ${VALUE_TITLES[values[column]]}`).join(', ')}.`;
}

// Why Wiro did not take an answer, and what to do: by its code.
const REFUSAL_NOTES: Record<string, string> = {
  approval_expired: 'Nothing ran. If the user still wants the action, ask the agent again: a new call makes a new card.',
  approval_done: 'Nothing changed: the card was already answered. get_agent_message with this message id shows what became of it.',
  approval_blocked: 'Nothing ran: the action is blocked now. get_agent_connector_permissions shows the connector\'s '
    + 'permissions, and set_agent_connector_permissions changes them.',
  97: `${APPROVAL_RIGHTS} Allow, this call once, still works for this connection.`,
  96: 'Only the agent\'s owner and its team can answer its approvals.',
};

function refused(call: Call, error: ApiResultError) {
  const approval = toApproval(error.body.approval, { messageguid: call.messageguid, agent: call.target.agent });
  const code = error.codes.map(String).find(item => item in REFUSAL_NOTES);
  const message = `${error.message}${code ? ` ${REFUSAL_NOTES[code]}` : ''}`;
  const nextAction: NextAction | undefined = code === '97' && approval?.status === 'pending'
    ? {
      tool: 'answer_agent_approval',
      arguments: { ...base(call), answer: 'allow' },
      reason: 'Allow it once instead, if the user agrees: this shows what that does and changes nothing.',
    }
    : undefined;
  return {
    content: [{
      type: 'text' as const,
      text: [`## Error`, '', message, ...(approval ? ['', ...formatApproval(approval, 'The card')] : [])].join('\n'),
    }],
    structuredContent: {
      ...base(call),
      outcome: 'refused' as const,
      ...(approval ? { approval } : {}),
      message,
      ...(nextAction ? { nextAction } : {}),
    },
    isError: true,
  };
}

async function answerCard(client: WiroClient, call: Call, signal: AbortSignal) {
  let body: ActBody;
  try {
    body = requireApiSuccess(
      await client.post<ActBody>('/UserAgent/Message/ApprovalCardAct', {
        useragentguid: call.agentGuid,
        messageguid: call.messageguid,
        cardid: call.cardid,
        action: call.answer,
      }, signal),
      'The approval could not be saved. Try again.',
    );
  } catch (error) {
    if (error instanceof ApiResultError) return refused(call, error);
    throw error;
  }
  const approval = toApproval(body.approval, { messageguid: call.messageguid, agent: call.target.agent });
  const summary = asString(body.summary)?.replace(/\s+/g, ' ').trim();
  const resume = toResume(body.resume);
  const permissions = toPermissions(body.permissions);
  const action = approval ? quotedSpan(approval.action) : 'The action';
  const message = [
    summary ?? (call.answer === 'decline' ? 'Declined.' : call.answer === 'always' ? 'Always allowed.' : 'Allowed once.'),
    permissions ? permissionsText(action, permissions) : '',
    resumeText(resume, call.answer),
  ].filter(Boolean).join(' ');
  const nextAction: NextAction | undefined = resume?.status === 'queued' && resume.messageId
    ? {
      tool: 'get_agent_message',
      arguments: { agent: call.target.agent, message_id: resume.messageId },
      reason: 'The agent goes on with the approved action in this new turn. This waits for its answer and sends nothing.',
    }
    : undefined;
  return {
    content: [{
      type: 'text' as const,
      text: [
        `## Approval answered${approval ? `: ${approvalHeadline(approval)}` : ''}`,
        '',
        message,
        ...(approval ? ['', ...formatApproval(approval, 'The card')] : []),
        ...(nextAction ? ['', `**Next:** \`${nextAction.tool}\` with ${jsonSpan(nextAction.arguments)}. ${nextAction.reason}`] : []),
      ].join('\n'),
    }],
    structuredContent: {
      ...base(call),
      outcome: 'answered' as const,
      ...(approval ? { approval } : {}),
      ...(summary ? { summary } : {}),
      ...(resume ? { resume } : {}),
      ...(permissions ? { permissions } : {}),
      message,
      ...(nextAction ? { nextAction } : {}),
    },
  };
}

export function registerAnswerAgentApproval(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'answer_agent_approval',
    {
      title: 'Answer an agent\'s approval card',
      description: 'Answer a deployed agent\'s approval card. When the agent calls a Connector action whose permission '
        + 'is Ask (by default every Create and send action, and Change and delete ones in chat), the action does not '
        + 'run: Wiro shows a card with the exact request, and the agent waits for a person\'s answer. send_agent_message, '
        + 'get_agent_message and get_agent_conversation list these cards under approvals, with messageguid and cardid, '
        + 'and get_agent_connector_permissions lists the ones a scheduled task or the agent\'s own work asked for. '
        + 'answer allow runs this one call once; always runs it and also lets the action run without asking from now '
        + 'on, in the columns that ask for it now (a column set to Block stays blocked), and needs an agent admin: the '
        + 'person who deployed the agent or a team admin of its team; decline turns down this one call, and the next '
        + 'call asks again. Without confirm it shows the card, its request and what the answer does, and changes '
        + 'nothing: show it to the user and ask. With confirm: true, only after the user answered, it answers. After '
        + 'an approval the agent goes on in a new turn of the chat the card is in, and get_agent_message with the '
        + 'returned message id reads its answer. A card waits 24 hours, and an approval is used within an hour. Studio '
        + 'and the Workflow Agent never ask.',
      inputSchema: strictInput({
        agent: z.string().min(1).max(100).describe('The deployed agent\'s guid, from list_my_agents.'),
        messageguid: z.string().min(1).max(100)
          .describe('The message the card is on: messageguid of the approval, from send_agent_message, get_agent_message, get_agent_conversation or get_agent_connector_permissions.'),
        cardid: z.string().regex(/^[a-z0-9]{12}$/, 'cardid is the card\'s 12-character id, lowercase letters and digits, from the approval.')
          .describe('The card\'s id: cardid of the approval.'),
        answer: z.enum(APPROVAL_ANSWERS)
          .describe('allow (this call once), always (this call, and the action runs without asking from now on; agent admins only) or decline (turn down this call).'),
        confirm: z.boolean().default(false)
          .describe('false (default) shows the card and what the answer does, and changes nothing. true answers it: set it only after the user answered.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // An answered card is not answered again: a repeat changes nothing.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent, messageguid, cardid, answer, confirm }, extra) => {
      try {
        const target = resolveAgentTarget(agent);
        if (target.kind !== 'deployed' || !target.agentGuid) {
          throw new Error('Studio and the Workflow Agent never ask for approval: only a deployed agent\'s Connector actions do. Pass the agent\'s guid from list_my_agents.');
        }
        const call: Call = { target, agentGuid: target.agentGuid, messageguid: messageguid.trim(), cardid, answer };
        if (confirm) return await answerCard(client, call, extra.signal);
        const found = await findCard(client, call, extra.signal);
        if (found === 'no-card') {
          throw new Error(`Message ${call.messageguid} has no approval card ${cardid}. get_agent_message with this message id lists its cards.`);
        }
        if (found === 'no-message') {
          throw new Error(`The message ${call.messageguid} cannot be read with this connection, and no card ${cardid} waits for `
            + 'the agent\'s connectors that it can read. Check the ids with get_agent_conversation, or with '
            + 'get_agent_connector_permissions, which an agent admin reads. Nothing was answered.');
        }
        return preview(call, found);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
