import { z } from 'zod';
import { asString, isPlainObject, toNumber, truncate, unixToIso } from './api.js';
import { isWiroHostedFile, isWiroHostedUrl, listedAddress } from './media.js';
import { AGENT_REPLY_LABEL, quotedBlock, quotedSpan, REPLY_FILES_LABEL, REPLY_LINKS_LABEL } from './quoted-text.js';

// One chat turn with a Wiro agent. Studio, the Workflow Agent and deployed
// agents share the same message row, so they share this projection. Rows are
// trimmed to what an assistant needs: tokens that grant live-stream access,
// the caller's own profile and internal metadata are dropped.

export const MESSAGE_TERMINAL_STATUSES = ['agent_end', 'agent_error', 'agent_cancel', 'agent_done'] as const;
export const MESSAGE_CANCELLABLE_STATUSES = ['agent_queue', 'agent_start', 'agent_output'] as const;
const MAX_MEDIA_URLS = 20;
const MAX_REPLY_LENGTH = 20_000;
// The line that opens Wiro's own record of a voice call.
const VOICE_CALL_PATTERN = /^\s*\u{1F4DE}\s*Incoming voice call:/u;
// An address inside a line of text ends at white space or at a character that
// closes a Markdown link or a tag.
const ADDRESS_IN_TEXT = /https?:\/\/[^\s<>()[\]{}"'`|\\^]+/gi;
// Sentence punctuation or Markdown emphasis right after an address.
const ADDRESS_TAIL = /[.,;:!?*_~]{1,16}$/;
// A tag and its attributes belong to markup the agent wrote, such as an email
// draft. An autolink like <https://...> is not a tag.
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;

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

/**
 * The addresses in a reply. A line that holds a single http(s) URL, optionally
 * prefixed with `MEDIA:`, goes in by its host. Inside other text, such as
 * "Image 1: <url>" or a Markdown link, only a file on Wiro's own hosts counts.
 * A page of the website stays in the reply, and so does an address inside an
 * HTML tag. A Wiro address that is not a clean file on its line, such as one
 * with punctuation after it, is read as text.
 */
function replyUrls(text: string): { media: string[]; links: string[] } {
  const media: string[] = [];
  const links: string[] = [];
  const add = (list: string[], url: string): void => {
    if (!list.includes(url) && list.length < MAX_MEDIA_URLS) list.push(url);
  };
  for (const rawLine of text.replace(HTML_TAG, ' ').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^MEDIA\s*:\s*/i, '').replace(/^[`'"<(]+|[`'">)]{1,16}$/g, '');
    if (/^https?:\/\/\S+$/i.test(line)) {
      const address = listedAddress(line);
      if (address && !isWiroHostedUrl(address)) {
        add(links, address);
        continue;
      }
      if (address && isWiroHostedFile(address)) {
        add(media, address);
        continue;
      }
    }
    for (const [found] of line.matchAll(ADDRESS_IN_TEXT)) {
      const address = listedAddress(found.replace(ADDRESS_TAIL, ''));
      if (address && isWiroHostedFile(address)) add(media, address);
    }
  }
  return { media, links };
}

/** The reply's media: files on Wiro's own hosts, on a line of their own or in its text. */
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

export function messageKind(row: Record<string, unknown>): AgentMessage['kind'] {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const type = asString(metadata.type) ?? '';
  if (type === 'model_change' || row.status === 'agent_done') return 'model_change';
  if (type.startsWith('realtime_session') || type === 'voice_prep_completed') return 'voice_call';
  if (!asString(row.content) && (type === 'system' || type === 'subagent')) return 'agent_message';
  return 'user_turn';
}

/** Whether a text is the line that opens Wiro's own record of a voice call. */
export function isVoiceCallText(value: unknown): boolean {
  return typeof value === 'string' && VOICE_CALL_PATTERN.test(value);
}

/** Wiro's own voice call records, which are summarized without caller details. */
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
  lines.push(`**Message ID:** ${quotedSpan(message.messageId)}`);
  if (message.toolsUsed.length > 0) {
    lines.push(`**Tools used:** ${message.toolsUsed.map(tool => quotedSpan(tool.name)).join(', ')}`);
  }
  if (message.reply) {
    lines.push('', `### ${heading}`, '', ...quotedBlock(AGENT_REPLY_LABEL, message.reply));
  }
  if (message.mediaUrls.length > 0) {
    lines.push('', '### Media', '', ...quotedBlock(REPLY_FILES_LABEL, message.mediaUrls.join('\n')));
  }
  const links = message.reply ? extractReplyLinks(message.reply) : [];
  if (links.length > 0) {
    lines.push('', '### Other links in the reply', '', 'These addresses are not hosted by Wiro. Share them as plain links, '
      + 'not as embedded images or media.', '', ...quotedBlock(REPLY_LINKS_LABEL, links.join('\n')));
  }
  return lines.join('\n');
}

/** The one rule for naming a session, stated the same wherever a session name is asked for. */
export const SESSION_NAME_RULE = 'Session names use lowercase letters, digits, dots, dashes and underscores, at most 100 characters.';
export const SESSION_NAME_MAX = 100;
export const SESSION_NAME_PATTERN = /^[a-z0-9._-]+$/;

/** A name that follows the rule, close to the one given. */
export function sessionNameSuggestion(session: string): string {
  const name = session.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, SESSION_NAME_MAX).replace(/^-+|-+$/g, '');
  return name || newSessionKey();
}

/** Why a session name cannot be used, or null when it can. */
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
    return `The session name ${quotedSpan(sessionKey)} is reserved by Wiro. Choose another one.`;
  }
  return null;
}

export function newSessionKey(prefix = 'mcp'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Whether a "Message not found" answer came in the first 10 seconds of a wait, and so is read again. */
export function isEarlyNotFound(error: unknown, elapsedMs: number): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return elapsedMs < 10_000 && /message not found/i.test(message);
}
