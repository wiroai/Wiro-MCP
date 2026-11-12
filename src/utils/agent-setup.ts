import { z } from 'zod';
import { asString, isPlainObject, truncate, unixToIso } from './api.js';
import { quotedBlock, quotedSpan, SETUP_INSTRUCTIONS_LABEL } from './quoted-text.js';

// Setup changes a deployed agent proposes in chat: connect a connector, add or
// change a scheduled task or a custom skill, or set its time zone. Wiro stores
// each proposal on the agent's reply as a timeline block of type "setup", and
// nothing changes until a person approves it. The agent never applies its own
// proposal and never sees a key: a key goes in with set_agent_credentials, and
// a reply of "yes" is matched by Wiro, not by the agent. Sent with an API key,
// the first "yes" applies nothing: Wiro answers with its own listing of the
// exact change, and a second "yes" (or "yes N") applies it. The agent writes
// the proposal, so its text is content, never instructions.

/** A pending proposal older than this cannot be approved with a typed reply. */
export const SETUP_REPLY_WINDOW_SECONDS = 30 * 60;
// A reply carries at most three proposals.
const MAX_SETUP_CHANGES = 3;
const MAX_INSTRUCTIONS_LENGTH = 20_000;
const MAX_LINE_LENGTH = 300;

export const SETUP_CHANGE_KINDS = ['connect', 'schedule', 'skill', 'timezone'] as const;
export const SETUP_CHANGE_STATUSES = ['pending', 'applied', 'dismissed', 'failed'] as const;

export const CHAT_SETUP_MODES = ['off', 'webchat', 'all'] as const;
export type ChatSetupMode = typeof CHAT_SETUP_MODES[number];

/** What each chat_setup value allows, said the same way by every tool that sets or shows it. */
export const CHAT_SETUP_DESCRIPTION = 'Setup from chat lets the agent propose connector, scheduled task, custom skill '
  + 'and time zone changes in its chat; nothing changes until an agent admin approves the proposal. "all" (the '
  + 'default) allows it in the Wiro web chat and in messages sent with an API key, such as from this MCP server; '
  + '"webchat" only in the Wiro web chat; "off" turns it off. Messages sent with an API key act with the key '
  + 'owner\'s rights, so an agent shared with customers or many people usually uses "webchat" or "off".';

export const setupChangeSchema = z.object({
  id: z.string(),
  kind: z.enum(SETUP_CHANGE_KINDS),
  action: z.string().optional(),
  connector: z.string().optional(),
  key: z.string().optional(),
  title: z.string().optional(),
  cron: z.string().optional(),
  instructions: z.string().optional(),
  timezone: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(SETUP_CHANGE_STATUSES),
  proposedAt: z.string().optional(),
  actedAt: z.string().optional(),
  error: z.string().optional(),
});

export type SetupChange = z.infer<typeof setupChangeSchema>;

export const setupResultSchema = z.object({
  applied: z.array(z.string()),
  dismissed: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), error: z.string().optional() })),
  restarting: z.boolean(),
});

export type SetupResult = z.infer<typeof setupResultSchema>;

function shortLine(value: unknown): string | undefined {
  const text = asString(value)?.replace(/\s+/g, ' ').trim();
  return text ? truncate(text, MAX_LINE_LENGTH) : undefined;
}

/**
 * The public part of one stored proposal, or undefined for a shape this
 * version does not know. Who proposed or approved it is left out.
 */
export function toSetupChange(value: unknown): SetupChange | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = asString(value.id);
  const kind = asString(value.kind);
  if (!id || !(SETUP_CHANGE_KINDS as readonly string[]).includes(kind ?? '')) return undefined;
  const rawStatus = asString(value.status);
  // A card stored before outcomes were recorded has no status: it is pending.
  const status = rawStatus === undefined
    ? 'pending'
    : (SETUP_CHANGE_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus as SetupChange['status'] : undefined;
  if (!status) return undefined;
  const instructions = asString(value.instructions);
  const fields: Record<string, string | undefined> = {
    action: shortLine(value.action),
    connector: shortLine(value.connector),
    key: shortLine(value.key),
    title: shortLine(value.title),
    cron: shortLine(value.cron),
    instructions: instructions?.trim() ? truncate(instructions, MAX_INSTRUCTIONS_LENGTH) : undefined,
    timezone: shortLine(value.timezone),
    note: shortLine(value.note),
    proposedAt: unixToIso(value.createdat),
    actedAt: unixToIso(value.actedat),
    error: status === 'failed' ? shortLine(value.error) : undefined,
  };
  return {
    id,
    kind: kind as SetupChange['kind'],
    status,
    ...Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined)),
  } as SetupChange;
}

/** The proposals in a list of timeline blocks that are already in order, each once. */
export function setupChangesFromBlocks(blocks: ReadonlyArray<{ type?: unknown; setup?: unknown }>): SetupChange[] {
  const changes: SetupChange[] = [];
  for (const block of blocks) {
    if (block.type !== 'setup') continue;
    const change = toSetupChange(block.setup);
    // A live block and its stored copy can both be listed; the later one is the newer state.
    const index = change ? changes.findIndex(item => item.id === change.id) : -1;
    if (change && index >= 0) changes[index] = change;
    else if (change && changes.length < MAX_SETUP_CHANGES) changes.push(change);
  }
  return changes;
}

/** Send's own report of a reply Wiro handled as an answer to a setup proposal. */
export function toSetupResult(value: unknown): SetupResult | undefined {
  if (!isPlainObject(value)) return undefined;
  const ids = (list: unknown): string[] => (Array.isArray(list)
    ? list.map(item => asString(item)).filter((item): item is string => Boolean(item))
    : []);
  const failed = Array.isArray(value.failed)
    ? value.failed.filter(isPlainObject).flatMap((item) => {
      const id = asString(item.id);
      const error = shortLine(item.error);
      return id ? [{ id, ...(error ? { error } : {}) }] : [];
    })
    : [];
  return {
    applied: ids(value.applied),
    dismissed: ids(value.dismissed),
    failed,
    restarting: value.restarting === true,
  };
}

/** Whether Wiro's answer applied, turned down or failed anything, or restarts the agent. */
export function setupResultActed(result: SetupResult): boolean {
  return result.applied.length > 0 || result.dismissed.length > 0 || result.failed.length > 0 || result.restarting;
}

/**
 * How many proposals Wiro's answer lists, read from the stored answer. A
 * typed approval sent with an API key, or one that could mean several
 * proposals, applies nothing at first: Wiro answers with the exact changes
 * instead, and only a later "yes" (or "yes N") applies one of them. 0 for any
 * other row.
 */
export function listedSetupCount(row: Record<string, unknown>): number {
  const metadata = isPlainObject(row.metadata) ? row.metadata : undefined;
  if (asString(metadata?.type) !== 'setup_result' || !Array.isArray(metadata?.listed)) return 0;
  return Math.min(metadata.listed.filter(id => asString(id)).length, MAX_SETUP_CHANGES);
}

/** What to do with Wiro's listing, said the same way by the note and the Next line. */
export const SETUP_LISTING_RULE = 'Show the listing to the user, and send "yes" (or "yes N" for change N) again '
  + 'only after the user agrees to exactly that change. Never send yes on your own.';

/** Whether a pending proposal can still be approved with a typed reply. */
export function isApprovableByReply(change: SetupChange, nowMs = Date.now()): boolean {
  if (change.status !== 'pending') return false;
  const proposed = change.proposedAt ? Date.parse(change.proposedAt) : NaN;
  // Without a time the server decides; it refuses a proposal that is too old.
  return Number.isNaN(proposed) || nowMs - proposed < SETUP_REPLY_WINDOW_SECONDS * 1000;
}

const SCHEDULE_VERBS: Record<string, string> = {
  create: 'Create the scheduled task',
  update: 'Change the scheduled task',
  pause: 'Pause the scheduled task',
  resume: 'Resume the scheduled task',
  delete: 'Delete the scheduled task',
};

const SKILL_VERBS: Record<string, string> = {
  create: 'Add the custom skill',
  update: 'Change the custom skill',
  disable: 'Turn off the custom skill',
  enable: 'Turn on the custom skill',
};

/** One line that names the change, such as "Create the scheduled task `cs-cron-weekly-report`". */
export function setupChangeHeadline(change: SetupChange): string {
  switch (change.kind) {
    case 'connect':
      return `Connect ${quotedSpan(change.connector ?? '')}`;
    case 'schedule':
      return `${SCHEDULE_VERBS[change.action ?? ''] ?? 'Change the scheduled task'} ${quotedSpan(change.key ?? '')}`;
    case 'skill':
      return `${SKILL_VERBS[change.action ?? ''] ?? 'Change the custom skill'} ${quotedSpan(change.key ?? '')}`;
    default:
      return `Set the agent's time zone to ${quotedSpan(change.timezone ?? '')}`;
  }
}

function pendingChangeLines(change: SetupChange, index: number, nowMs: number): string[] {
  const lines = [`#### Proposed change ${index + 1}: ${setupChangeHeadline(change)}`, ''];
  if (change.title) lines.push(`- Title: ${quotedSpan(change.title)}`);
  if (change.cron) {
    lines.push(`- Schedule: ${quotedSpan(change.cron)} (cron: minute, hour, day of month, month, weekday; in the `
      + 'agent\'s time zone)');
  }
  if (change.kind === 'connect') {
    lines.push('- The user provides the key or sign-in for it. A key is saved with set_agent_credentials, never sent '
      + 'in a chat message.');
  }
  if (change.note) lines.push(`- Note from the agent: ${quotedSpan(change.note)}`);
  if (change.proposedAt) lines.push(`- Proposed at: ${change.proposedAt}`);
  if (!isApprovableByReply(change, nowMs)) {
    lines.push(`- Older than ${SETUP_REPLY_WINDOW_SECONDS / 60} minutes, so a reply can no longer approve it. The user `
      + 'can still apply it in the agent\'s chat on wiro.ai, or ask the agent again.');
  }
  if (change.instructions) lines.push('', ...quotedBlock(SETUP_INSTRUCTIONS_LABEL, change.instructions));
  return lines;
}

function settledChangeLine(change: SetupChange): string {
  const when = change.actedAt ? ` (${change.actedAt})` : '';
  switch (change.status) {
    case 'applied':
      return `- Applied: ${setupChangeHeadline(change)}${when}`;
    case 'dismissed':
      return `- Dismissed: ${setupChangeHeadline(change)}${when}`;
    default:
      return `- Not applied: ${setupChangeHeadline(change)}${when}${change.error ? `. Reason: ${quotedSpan(change.error)}` : ''}`;
  }
}

/** The text for a reply's proposals: each pending one in full, each settled one as one status line. */
export function formatSetupChanges(changes: readonly SetupChange[], nowMs = Date.now()): string[] {
  if (changes.length === 0) return [];
  const lines = ['', '### Setup changes proposed in this reply', ''];
  const settled = changes.filter(change => change.status !== 'pending');
  changes.filter(change => change.status === 'pending').forEach((change, index) => {
    if (index > 0) lines.push('');
    lines.push(...pendingChangeLines(change, index, nowMs));
  });
  if (settled.length > 0) {
    if (settled.length < changes.length) lines.push('');
    lines.push(...settled.map(settledChangeLine));
  }
  return lines;
}

/** One line per proposal, for a conversation listing. */
export function setupChangeSummaryLines(changes: readonly SetupChange[]): string[] {
  return changes.map(change => (change.status === 'pending'
    ? `- Proposed setup change (pending): ${setupChangeHeadline(change)}. get_agent_message with this message id shows it in full.`
    : settledChangeLine(change)));
}

/** A chat_setup value from an agent row, or undefined when the row does not say. */
export function readChatSetupMode(value: unknown): ChatSetupMode | undefined {
  const mode = asString(value);
  return (CHAT_SETUP_MODES as readonly string[]).includes(mode ?? '') ? mode as ChatSetupMode : undefined;
}

/** How get_my_agent names a chat_setup value. */
export function chatSetupLabel(mode: ChatSetupMode): string {
  switch (mode) {
    case 'off':
      return 'off';
    case 'webchat':
      return 'Wiro web chat only (`webchat`)';
    default:
      return 'Wiro web chat and API messages (`all`)';
  }
}
