import { WiroApiError, type WiroClient } from '../client.js';
import {
  ApiResultError,
  apiErrorMessage,
  asString,
  hasErrorCode,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  type ApiEnvelope,
} from './api.js';
import { newSessionKey, sessionKeyProblem } from './agent-message.js';
import { fetchPublicFile } from './remote-file.js';

// Studio, the Workflow Agent and the user's own deployed agents speak the same
// message protocol behind three route families. Everything that differs
// between them (paths, how a session is addressed, which errors mean what)
// lives here so the tools stay identical for all three.

export type AgentKind = 'studio' | 'workflow-agent' | 'deployed';

export interface AgentTarget {
  kind: AgentKind;
  /** The value to pass back as `agent` in later calls. */
  agent: string;
  agentGuid?: string;
  /** Sentence start: "Studio", "The Workflow Agent", "Your agent". */
  name: string;
  /** Mid-sentence: "Studio", "the Workflow Agent", "your agent". */
  label: string;
}

export type AgentOperation =
  | 'send'
  | 'sendForm'
  | 'detail'
  | 'history'
  | 'sessions'
  | 'cancel'
  | 'deleteSession'
  | 'status';

const ENDPOINTS: Record<AgentKind, Partial<Record<AgentOperation, string>>> = {
  studio: {
    send: '/Studio/Message/Send',
    sendForm: '/Studio/Message/SendForm',
    detail: '/Studio/Message/Detail',
    history: '/Studio/Message/History',
    sessions: '/Studio/Message/Sessions',
    cancel: '/Studio/Message/Cancel',
    // ClearSession deletes the history and always moves the agent to a fresh
    // memory; DeleteSession does that only for "default".
    deleteSession: '/Studio/Message/ClearSession',
    status: '/Studio/Status',
  },
  'workflow-agent': {
    send: '/StudioWorkflow/Message/Send',
    sendForm: '/StudioWorkflow/Message/SendForm',
    detail: '/StudioWorkflow/Message/Detail',
    history: '/StudioWorkflow/Message/History',
    sessions: '/StudioWorkflow/Message/Sessions',
    cancel: '/StudioWorkflow/Message/Cancel',
    deleteSession: '/StudioWorkflow/Message/DeleteSession',
    status: '/StudioWorkflow/Status',
  },
  deployed: {
    send: '/UserAgent/Message/Send',
    sendForm: '/UserAgent/Message/Send',
    detail: '/UserAgent/Message/Detail',
    history: '/UserAgent/Message/History',
    sessions: '/UserAgent/Message/Sessions',
    cancel: '/UserAgent/Message/Cancel',
    deleteSession: '/UserAgent/Message/DeleteSession',
  },
};

export const AGENT_INPUT_DESCRIPTION = 'Which agent: "studio" (Wiro Studio, the media agent that runs '
  + 'models for you), "workflow-agent" (the Workflow Agent, which designs Wiro workflows) or the '
  + 'guid of one of your deployed agents (from list_my_agents).';

export const WORKFLOW_AGENT_MAX_MESSAGE_BYTES = 16 * 1024;
const WORKFLOW_SESSION_PATTERN = /^[A-Za-z0-9._:-]+$/;
// Wiro prefixes the session names an API key uses with the Workflow Agent and
// keeps the whole name within 128 characters, so names sent from here stay
// within 100. Names that already exist can be longer and are read as they are.
const WORKFLOW_SEND_SESSION_MAX = 100;
const AGENT_GUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const PRODUCT_UNAVAILABLE_PATTERN = /^agent (is|has no remaining|not found)|not configured/i;
export const BARE_UNAVAILABLE_PATTERN = /temporarily unavailable/i;
export const BACKGROUND_REPLY_PATTERN = /working on it in the background/i;
// A turn that spawns sub-agents or yields to them ends before their work does.
// Its reply is then often the agent's own waiting line, which no pattern finds.
const BACKGROUND_TOOLS = new Set(['sessions_spawn', 'sessions_yield']);

/** Whether a finished turn handed (part of) its work to sub-agents that deliver later. */
export function isBackgroundHandOff(
  reply: string | undefined,
  tools: Array<{ name: string; status?: string }>,
): boolean {
  // A spawn or yield that failed handed nothing over.
  return BACKGROUND_REPLY_PATTERN.test(reply ?? '')
    || tools.some(tool => BACKGROUND_TOOLS.has(tool.name) && tool.status !== 'error');
}

export function resolveAgentTarget(input: string): AgentTarget {
  const value = input.trim();
  const lower = value.toLowerCase();
  if (lower === 'studio') {
    return { kind: 'studio', agent: 'studio', name: 'Studio', label: 'Studio' };
  }
  if (lower === 'workflow-agent' || lower === 'workflow_agent' || lower === 'workflowagent') {
    return { kind: 'workflow-agent', agent: 'workflow-agent', name: 'The Workflow Agent', label: 'the Workflow Agent' };
  }
  if (!AGENT_GUID_PATTERN.test(value)) {
    throw new Error('agent must be "studio", "workflow-agent" or the guid of one of your deployed agents. '
      + 'list_my_agents shows the guids.');
  }
  return { kind: 'deployed', agent: value, agentGuid: value, name: 'Your agent', label: 'your agent' };
}

export function agentEndpoint(target: AgentTarget, operation: AgentOperation): string {
  const path = ENDPOINTS[target.kind][operation];
  if (!path) throw new Error(`${target.name} does not support this action.`);
  return path;
}

/**
 * Why a session name cannot be used with this agent, or null. Sending checks
 * the shorter Workflow Agent limit; reading, cancelling and deleting address a
 * session that already exists, so Wiro decides about its length.
 */
export function agentSessionProblem(
  target: AgentTarget,
  session: string,
  use: 'send' | 'read' = 'read',
): string | null {
  const problem = sessionKeyProblem(session);
  if (problem) return problem;
  if (target.kind !== 'workflow-agent') return null;
  if (!WORKFLOW_SESSION_PATTERN.test(session)) {
    return 'A Workflow Agent session name may contain only letters, digits, ".", "_", ":" and "-".';
  }
  if (use === 'send' && session.length > WORKFLOW_SEND_SESSION_MAX) {
    return 'A Workflow Agent session name may contain only letters, digits, ".", "_", ":" and "-", '
      + `and at most ${WORKFLOW_SEND_SESSION_MAX} characters (Wiro adds a prefix of its own to sessions started `
      + 'with an API key).';
  }
  return null;
}

/**
 * Studio shares the user's wiro.ai chat history, so a message without a
 * session opens a new one instead of landing in their main Studio chat. The
 * Workflow Agent keeps an API key's sessions apart from the user's own chats
 * on wiro.ai; a new session keeps unrelated requests apart there too. A
 * deployed agent's "default" session is its owner's own chat.
 */
export function resolveSendSession(
  target: AgentTarget,
  session: string | undefined,
): { session: string; created: boolean } {
  if (session === undefined || session.trim() === '') {
    if (target.kind === 'deployed') return { session: 'default', created: false };
    return { session: newSessionKey('mcp'), created: true };
  }
  const problem = agentSessionProblem(target, session, 'send');
  if (problem) throw new Error(problem);
  return { session, created: false };
}

/** The session to address a stored message with. */
export function resolveReadSession(target: AgentTarget, session: string | undefined): string | undefined {
  if (session === undefined || session.trim() === '') {
    // Studio and the Workflow Agent read a missing session as "default" (for the
    // Workflow Agent, the API key's own main session); a deployed agent can
    // find the message by its id alone.
    return target.kind === 'deployed' ? undefined : 'default';
  }
  const problem = agentSessionProblem(target, session);
  if (problem) throw new Error(problem);
  return session;
}

export function agentRequestBody(
  target: AgentTarget,
  session: string | undefined,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...fields };
  if (target.kind === 'deployed') body.useragentguid = target.agentGuid;
  if (session !== undefined) body.sessionkey = session;
  return body;
}

export const WORKFLOW_AGENT_KEY_REFUSED = 'The Workflow Agent did not accept this API key (HTTP 403: '
  + 'Bearer authentication is required). It is available on wiro.ai. From here you can still build '
  + 'and change workflows directly with create_workflow and update_workflow.';

/** Turns HTTP refusals that only mean "not available to this caller" into readable answers. */
export function mapAgentHttpError(target: AgentTarget, error: unknown): unknown {
  if (!(error instanceof WiroApiError) || error.status !== 403 || target.kind !== 'workflow-agent') {
    return error;
  }
  if (/bearer authentication is required/i.test(error.responseBody)) {
    return new ApiResultError(WORKFLOW_AGENT_KEY_REFUSED, [403], {});
  }
  if (/workspace is not available/i.test(error.responseBody)) {
    return new ApiResultError(
      'The Workflow Agent refused the workspace of this API key (HTTP 403). The key\'s project '
        + 'decides the workspace; use a key from the workspace you want to work in.',
      [403],
      {},
    );
  }
  return error;
}

export async function callAgent<T extends ApiEnvelope = ApiEnvelope & Record<string, unknown>>(
  client: WiroClient,
  target: AgentTarget,
  operation: AgentOperation,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const path = agentEndpoint(target, operation);
  try {
    return await client.post<T>(path, body, signal);
  } catch (error) {
    throw mapAgentHttpError(target, error);
  }
}

export async function callAgentForm<T extends ApiEnvelope = ApiEnvelope & Record<string, unknown>>(
  client: WiroClient,
  target: AgentTarget,
  form: FormData,
  signal?: AbortSignal,
): Promise<T> {
  const path = agentEndpoint(target, 'sendForm');
  try {
    return await client.postForm<T>(path, form, signal);
  } catch (error) {
    throw mapAgentHttpError(target, error);
  }
}

/** One stored message row, or ApiResultError("Message not found"). */
export async function readAgentMessage(
  client: WiroClient,
  target: AgentTarget,
  messageId: string,
  session: string | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = agentRequestBody(target, session, { messageguid: messageId });
  const response = await callAgent(client, target, 'detail', body, signal);
  requireApiSuccess(response, 'Message not found');
  const data = (response as Record<string, unknown>).data;
  if (!isPlainObject(data)) {
    throw new ApiResultError('Message not found', [], response as Record<string, unknown>);
  }
  return data;
}

// ─── Send refusals ──────────────────────────────────────────────────

const DEPLOYED_STATUS_HELP: Record<number, string> = {
  0: 'Your agent is stopped. Start it with control_agent (action "start"), wait until get_my_agent '
    + 'shows it running, then send the message again.',
  1: 'Your agent is stopping. Wait a moment, check get_my_agent, and start it again with control_agent '
    + 'if you still need it.',
  2: 'Your agent is starting. Wait 30 to 60 seconds and send the message again; get_my_agent shows when it is running.',
  3: 'Your agent is starting. Wait 30 to 60 seconds and send the message again; get_my_agent shows when it is running.',
  5: 'Your agent is in an error state. Restart it with control_agent (action "restart"); '
    + 'get_agent_activity (logs) can show what went wrong.',
  6: 'Your agent\'s setup is incomplete. get_my_agent lists the missing credentials or connections; '
    + 'complete them with set_agent_credentials or connect_agent_oauth, then start the agent. If get_my_agent '
    + 'shows no active plan, pay for one with manage_agent_billing (action subscribe), which returns the price first.',
};

export interface SelectableModels {
  models: string[];
  defaultModel?: string;
}

/** Chat models a caller may pick for Studio or the Workflow Agent. */
export async function readSelectableModels(
  client: WiroClient,
  target: AgentTarget,
  signal?: AbortSignal,
): Promise<SelectableModels | null> {
  if (target.kind === 'deployed') return null;
  try {
    const status = requireApiSuccess(await callAgent(client, target, 'status', {}, signal), '');
    const rates = (status as Record<string, unknown>).tokenRates;
    if (!isPlainObject(rates) || !isPlainObject(rates.models)) return null;
    const models = Object.entries(rates.models)
      .filter(([, meta]) => isPlainObject(meta) && meta.selectable === true)
      .map(([key]) => key);
    const agentModel = (status as Record<string, unknown>).agentModel;
    const defaultModel = asString(rates.default_model)
      ?? (isPlainObject(agentModel) ? asString(agentModel.chatModel) : undefined);
    return { models, ...(defaultModel ? { defaultModel } : {}) };
  } catch {
    return null;
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Where to look before sending a message again whose fate is unknown. */
function checkBeforeResending(target: AgentTarget, session: string): string {
  return `Check get_agent_conversation with agent "${target.agent}" and session "${session}" before sending it again.`;
}

/** A readable explanation for a Send that Wiro refused. */
export async function explainSendRefusal(
  client: WiroClient,
  target: AgentTarget,
  response: Record<string, unknown>,
  session: string,
  signal?: AbortSignal,
): Promise<string> {
  const error = new ApiResultError(
    apiErrorMessage(response as ApiEnvelope, 'The message was not accepted.'),
    ((response.errors as Array<{ code?: number | string }> | undefined) ?? [])
      .map(item => item?.code)
      .filter((code): code is number | string => code !== undefined && code !== null),
    response,
  );
  const message = error.message;

  // The bare "temporarily unavailable" answer also covers a Send that timed out
  // inside Wiro after the turn was already queued.
  if (BARE_UNAVAILABLE_PATTERN.test(message)
    && response.agentstatus === undefined && response.agentbalance === undefined) {
    return `${target.name} is temporarily unavailable. The message may still have been queued. `
      + checkBeforeResending(target, session);
  }

  if (target.kind !== 'deployed' && hasErrorCode(error, 97)) {
    const walletUsd = toNumber(response.walletUsd);
    const minimum = toNumber(response.minTopup) ?? 10;
    return `${target.name} needs at least ${formatUsd(minimum)} in the Wiro wallet of this API key's `
      + `workspace to start a turn${walletUsd === null ? '' : `; the wallet has ${formatUsd(walletUsd)}`}. `
      + `Add funds on wiro.ai, then send the message again. The ${formatUsd(minimum)} is a minimum to start, `
      + 'not a spending cap. get_account shows the current balance.';
  }

  if (target.kind !== 'deployed'
    && (response.agentstatus !== undefined || response.agentbalance !== undefined
      || PRODUCT_UNAVAILABLE_PATTERN.test(message))) {
    // Status and credit numbers here are not the caller's own, so they are not repeated.
    return `${target.name} is temporarily unavailable. Please try again shortly.`;
  }

  if (/invalid model|selectable model allowlist/i.test(message)) {
    const lines = [message];
    const selectable = await readSelectableModels(client, target, signal);
    if (selectable && selectable.models.length > 0) {
      lines.push(`Models you can choose: ${selectable.models.join(', ')}`
        + (selectable.defaultModel ? ` (default: ${selectable.defaultModel}).` : '.'));
    }
    lines.push('Send again with one of these, or leave model out to use the default.');
    return lines.join('\n');
  }

  if (target.kind === 'deployed') {
    const balance = response.agentbalance;
    if (isPlainObject(balance)) {
      const monthly = toNumber(balance.monthlycredits);
      const extra = toNumber(balance.extracredits);
      const used = toNumber(balance.usedcredits);
      return 'Your agent has no credits left'
        + (monthly !== null || extra !== null || used !== null
          ? ` (monthly ${monthly ?? 0}, extra ${extra ?? 0}, used ${used ?? 0})`
          : '')
        + '. Renew the subscription or buy a credit pack with manage_agent_billing, then send the message again.';
    }
    const status = toNumber(response.agentstatus);
    if (status !== null) {
      return DEPLOYED_STATUS_HELP[status] ?? `${message} Check the agent with get_my_agent.`;
    }
    if (/agent not found or access denied/i.test(message)) {
      return `${message}. Check the guid with list_my_agents. An API key reaches only the agents of its own `
        + 'workspace (personal or team).';
    }
    if (/belongs to a team|personal workspace|different team/i.test(message)) {
      return `${message} The API key's project decides the workspace; use a key from the agent's workspace.`;
    }
  }

  if (/reserved sessionkey/i.test(message)) {
    return 'That session name is reserved by Wiro. Choose another session name.';
  }
  if (/too many files/i.test(message)) {
    return `${message}. Send at most 8 attachments per message.`;
  }
  if (/file format invalid/i.test(message)) {
    return `${message}. Attach a supported image, video, audio or document file.`;
  }
  return message;
}

/** Wording for a Send that failed before Wiro answered. Never retried. */
export function sendTransportError(target: AgentTarget, error: unknown, session: string): Error {
  if (error instanceof ApiResultError) return error;
  if (error instanceof WiroApiError && error.status === 413) {
    return new Error('An attachment is too large for Wiro (HTTP 413). Each file must be at most '
      + `${target.kind === 'workflow-agent' ? '50' : '100'} MB.`);
  }
  if (error instanceof WiroApiError && error.status >= 400 && error.status < 500) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`The send request did not complete (${reason}). The message may still have been queued. `
    + checkBeforeResending(target, session));
}

/** Wording for a Send that Wiro accepted without saying which message it queued. */
export function sendWithoutIdError(target: AgentTarget, session: string): Error {
  return new Error('Wiro accepted the message but returned no message id. ' + checkBeforeResending(target, session));
}

// ─── Attachments ────────────────────────────────────────────────────

export const MAX_ATTACHMENTS = 8;
const ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024;

export interface AttachmentFile {
  name: string;
  contentType: string;
  data: Uint8Array;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
};

const TYPE_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_BY_TYPE).map(([type, extension]) => [extension, type]),
);

/** A file name with the right extension, which Wiro uses to accept or refuse the upload. */
export function attachmentFileName(url: string, contentType: string | undefined, index: number): string {
  let base = '';
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    base = decodeURIComponent(segment);
  } catch {
    base = '';
  }
  base = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.\s]+/, '').slice(0, 120);
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const hasExtension = /\.[A-Za-z0-9]{2,5}$/.test(base);
  if (base && hasExtension) return base;
  const extension = EXTENSION_BY_TYPE[type];
  const stem = base || `attachment-${index + 1}`;
  return extension ? `${stem}.${extension}` : stem;
}

function attachmentContentType(name: string, header: string | undefined): string {
  const type = (header ?? '').split(';')[0]?.trim().toLowerCase();
  if (type && type !== 'application/octet-stream') return type;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Downloads every URL before anything is sent, so a bad URL never leaves half a turn behind. */
export async function downloadAttachments(
  target: AgentTarget,
  urls: string[],
): Promise<AttachmentFile[]> {
  if (urls.length > MAX_ATTACHMENTS) {
    throw new Error(`Send at most ${MAX_ATTACHMENTS} attachments per message.`);
  }
  const maxBytes = (target.kind === 'workflow-agent' ? 50 : 100) * 1024 * 1024;
  const files: AttachmentFile[] = [];
  let total = 0;
  for (const [index, url] of urls.entries()) {
    const remote = await fetchPublicFile(url, { maxBytes });
    total += remote.data.length;
    if (total > ATTACHMENT_TOTAL_BYTES) {
      throw new Error('The attachments add up to more than 200 MB. Send fewer or smaller files.');
    }
    const name = attachmentFileName(url, remote.contentType, index);
    files.push({ name, contentType: attachmentContentType(name, remote.contentType), data: remote.data });
  }
  return files;
}

export function buildMessageForm(fields: Record<string, string>, files: AttachmentFile[]): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) {
    form.append('attachments', new Blob([file.data], { type: file.contentType }), file.name);
  }
  return form;
}
