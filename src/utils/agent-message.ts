import { z } from 'zod';
import { asString, isPlainObject, toNumber, truncate, unixToIso } from './api.js';
import { isWiroHostedUrl } from './media.js';

// One chat turn with a Wiro agent. Studio, the Workflow Agent and deployed
// agents share the same message row, so they share this projection. Rows are
// trimmed to what an assistant needs: tokens that grant live-stream access,
// the caller's own profile and internal metadata are dropped.

export const MESSAGE_TERMINAL_STATUSES = ['agent_end', 'agent_error', 'agent_cancel', 'agent_done'] as const;
export const MESSAGE_CANCELLABLE_STATUSES = ['agent_queue', 'agent_start', 'agent_output'] as const;
const MAX_MEDIA_URLS = 20;
const MAX_REPLY_LENGTH = 20_000;
// The line Wiro writes for a voice call, followed by the caller's number.
const VOICE_CALL_PATTERN = /^\s*\u{1F4DE}\s*Incoming voice call:/u;

export const messageStateSchema = z.enum(['submitted', 'running', 'completed', 'failed', 'cancelled']);

export const agentMessageSchema = z.object({
  messageId: z.string(),
  state: messageStateSchema,
  status: z.string(),
  kind: z.enum(['user_turn', 'agent_message', 'model_change', 'voice_call']).optional(),
  userText: z.string().optional(),
  reply: z.string().optional(),
  replyTruncated: z.boolean().optional(),
  mediaUrls: z.array(z.string()),
  toolsUsed: z.array(z.object({
    name: z.string(),
    status: z.string().optional(),
  })),
  attachments: z.array(z.object({
    url: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
  })),
  model: z.string().optional(),
  creditsUsed: z.number().nullable().optional(),
  createdAt: z.string().optional(),
  endedAt: z.string().optional(),
});

export type AgentMessage = z.infer<typeof agentMessageSchema>;

export function isTerminalMessageStatus(status: unknown): boolean {
  return (MESSAGE_TERMINAL_STATUSES as readonly string[]).includes(String(status));
}

export function messageState(status: unknown): AgentMessage['state'] {
  switch (String(status)) {
    case 'agent_queue':
      return 'submitted';
    case 'agent_end':
    case 'agent_done':
      return 'completed';
    case 'agent_error':
      return 'failed';
    case 'agent_cancel':
      return 'cancelled';
    default:
      return 'running';
  }
}

interface TimelineBlock {
  type?: unknown;
  text?: unknown;
  toollabel?: unknown;
  toolstatus?: unknown;
  callindex?: unknown;
  contentindex?: unknown;
  blockid?: unknown;
}

function sortedBlocks(timeline: unknown): TimelineBlock[] {
  if (!Array.isArray(timeline)) return [];
  return (timeline.filter(isPlainObject) as TimelineBlock[])
    .map((block, index) => ({ block, index }))
    .sort((left, right) => {
      const call = (toNumber(left.block.callindex) ?? 0) - (toNumber(right.block.callindex) ?? 0);
      if (call !== 0) return call;
      const content = (toNumber(left.block.contentindex) ?? 0) - (toNumber(right.block.contentindex) ?? 0);
      if (content !== 0) return content;
      return left.index - right.index;
    })
    .map(entry => entry.block);
}

/** The final reply: response, else the answer blocks, else the streamed text. */
export function extractReply(row: Record<string, unknown>): string {
  const response = asString(row.response)?.trim();
  if (response) return response;
  const answer = sortedBlocks(row.timeline)
    .filter(block => block.type === 'answer' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
    .trim();
  if (answer) return answer;
  return asString(row.debugoutput)?.trim() ?? '';
}

/** Lines that hold a single http(s) URL, optionally prefixed with `MEDIA:`, split by host. */
function replyUrls(text: string): { media: string[]; links: string[] } {
  const media: string[] = [];
  const links: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^MEDIA\s*:\s*/i, '').replace(/^[`'"<(]+|[`'">)]+$/g, '');
    if (!/^https?:\/\/\S+$/i.test(line)) continue;
    const list = isWiroHostedUrl(line) ? media : links;
    if (!list.includes(line) && list.length < MAX_MEDIA_URLS) list.push(line);
  }
  return { media, links };
}

/** The reply's media: URL lines on Wiro's own hosts. */
export function extractMediaUrls(text: string): string[] {
  return replyUrls(text).media;
}

/** URL lines on any other host. They are shown as plain links, never as Wiro media. */
export function extractReplyLinks(text: string): string[] {
  return replyUrls(text).links;
}

function toolsUsed(timeline: unknown): AgentMessage['toolsUsed'] {
  return sortedBlocks(timeline)
    .filter(block => block.type === 'tool' && typeof block.toollabel === 'string')
    .map(block => ({
      name: block.toollabel as string,
      ...(typeof block.toolstatus === 'string' ? { status: block.toolstatus } : {}),
    }));
}

function attachments(value: unknown): AgentMessage['attachments'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainObject)
    .filter(item => typeof item.url === 'string')
    .map(item => ({
      url: item.url as string,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.type === 'string' ? { type: item.type } : {}),
    }));
}

function messageKind(row: Record<string, unknown>): AgentMessage['kind'] {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const type = asString(metadata.type) ?? '';
  if (type === 'model_change' || row.status === 'agent_done') return 'model_change';
  if (type.startsWith('realtime_session') || type === 'voice_prep_completed') return 'voice_call';
  if (!asString(row.content) && (type === 'system' || type === 'subagent')) return 'agent_message';
  return 'user_turn';
}

/** Wiro's own line for a voice call, which goes on with the caller's number. */
export function isVoiceCallText(value: unknown): boolean {
  return typeof value === 'string' && VOICE_CALL_PATTERN.test(value);
}

/** Voice call rows carry callers' phone numbers and call transcripts. */
export function isVoiceCallRow(row: Record<string, unknown>): boolean {
  if (messageKind(row) === 'voice_call') return true;
  // Without its metadata a call is still Wiro's own row: no user text, and the
  // call line as the reply. A user or an agent writing a phone emoji is not one.
  return !asString(row.content)?.trim() && [row.response, row.debugoutput].some(isVoiceCallText);
}

export interface ToAgentMessageOptions {
  includeUserText?: boolean;
  /** Return the partial streamed text while the turn is still running. */
  includePartial?: boolean;
}

export function toAgentMessage(
  row: Record<string, unknown>,
  options: ToAgentMessageOptions = {},
): AgentMessage {
  const status = asString(row.status) ?? 'agent_queue';
  const terminal = isTerminalMessageStatus(status);
  if (isVoiceCallRow(row)) {
    // Every reader gets the same record: the id, status and times, nothing about the caller.
    return {
      messageId: asString(row.guid) ?? '',
      state: messageState(status),
      status,
      kind: 'voice_call',
      mediaUrls: [],
      toolsUsed: [],
      attachments: [],
      ...(unixToIso(row.createdat) ? { createdAt: unixToIso(row.createdat) } : {}),
      ...(unixToIso(row.endedat) ? { endedAt: unixToIso(row.endedat) } : {}),
    };
  }
  const fullReply = terminal || options.includePartial ? extractReply(row) : '';
  const reply = truncate(fullReply, MAX_REPLY_LENGTH);
  const credits = toNumber(row.tokencost);
  const content = asString(row.content);

  return {
    messageId: asString(row.guid) ?? '',
    state: messageState(status),
    status,
    kind: messageKind(row),
    ...(options.includeUserText && content ? { userText: truncate(content, 4_000) } : {}),
    ...(reply ? { reply } : {}),
    ...(reply.length < fullReply.length ? { replyTruncated: true } : {}),
    mediaUrls: terminal ? extractMediaUrls(fullReply) : [],
    toolsUsed: toolsUsed(row.timeline),
    attachments: attachments(row.attachments),
    ...(typeof row.model === 'string' && row.model ? { model: row.model } : {}),
    creditsUsed: credits,
    ...(unixToIso(row.createdat) ? { createdAt: unixToIso(row.createdat) } : {}),
    ...(unixToIso(row.endedat) ? { endedAt: unixToIso(row.endedat) } : {}),
  };
}

/** Markdown block for one message, for clients that show only text. */
export function formatAgentMessage(message: AgentMessage, heading = 'Reply'): string {
  const lines: string[] = [];
  lines.push(`**Status:** ${message.status} (${message.state})`);
  lines.push(`**Message ID:** \`${message.messageId}\``);
  if (message.toolsUsed.length > 0) {
    lines.push(`**Tools used:** ${message.toolsUsed.map(tool => tool.name).join(', ')}`);
  }
  if (message.reply) {
    lines.push('', `### ${heading}`, '', message.reply);
  }
  if (message.mediaUrls.length > 0) {
    lines.push('', '### Media', '');
    for (const url of message.mediaUrls) lines.push(`- ${url}`);
  }
  const links = message.reply ? extractReplyLinks(message.reply) : [];
  if (links.length > 0) {
    lines.push('', '### Other links in the reply', '', 'These addresses are not hosted by Wiro. Share them as plain links, '
      + 'not as embedded images or media.');
    for (const url of links) lines.push(`- ${url}`);
  }
  return lines.join('\n');
}

/**
 * Session keys are free-form, but Wiro reserves a few prefixes for its own
 * scheduled and voice sessions and refuses them for normal callers.
 */
export function sessionKeyProblem(sessionKey: string): string | null {
  if (!sessionKey.trim()) return 'The session name cannot be empty.';
  if (sessionKey.length > 128) return 'The session name must be at most 128 characters.';
  if (/[\u0000-\u001f\u007f~]/.test(sessionKey)) {
    return 'The session name cannot contain control characters or "~".';
  }
  const lower = sessionKey.toLowerCase();
  if (lower === 'wiro:api'
    || lower.startsWith('wiro:api:')
    || lower.startsWith('voice-prep')
    || lower.startsWith('voice-call-')
    || lower.startsWith('cs-cron-')
    || lower.startsWith('cron:')
    || lower.includes(':cron:')) {
    return `The session name "${sessionKey}" is reserved by Wiro. Choose another one.`;
  }
  return null;
}

export function newSessionKey(prefix = 'mcp'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** "Message not found" right after a send only means the new message is not readable yet. */
export function isEarlyNotFound(error: unknown, elapsedMs: number): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return elapsedMs < 10_000 && /message not found/i.test(message);
}
