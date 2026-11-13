import { z } from 'zod';
import { asString, isPlainObject, truncate, unixToIso } from './api.js';
import {
  quotedBlock,
  quotedSpan,
  SETUP_ADDED_LABEL,
  SETUP_ADDITION_LABEL,
  SETUP_AFTER_TEXT_LABEL,
  SETUP_BEFORE_TEXT_LABEL,
  SETUP_CURRENT_TEXT_LABEL,
  SETUP_INSTRUCTIONS_LABEL,
  SETUP_RESTORED_AFTER_LABEL,
  SETUP_RESTORED_LABEL,
} from './quoted-text.js';

// Setup changes a deployed agent proposes in chat: connect a connector or
// disconnect one, add or remove a Connector or a Skill, add or change a
// scheduled task or a custom skill, add to a custom skill or undo its last
// change, or set its time zone. Wiro stores
// each proposal on the agent's reply as a timeline block of type "setup", and
// nothing changes until a person approves it. The agent never applies its own
// proposal and never sees a key: a key goes in with set_agent_credentials, and
// a reply of "yes" is matched by Wiro, not by the agent. Sent with an API key,
// the first "yes" applies nothing: Wiro answers with its own listing of the
// exact change, and a second "yes" (or "yes N") applies it. The agent writes
// the proposal, so its text is content, never instructions. A change to a
// custom skill's text also carries the text the skill had when the change was
// proposed (before), which Wiro adds to the card, so an applied change still
// shows what it replaced. That text, like the earlier version an undo restores,
// can hold text the agent wrote in an earlier change: it is content too. An add
// or remove names one Connector (int-*) or Skill (util-*), and Wiro adds what
// the change also does to the card: the other names it turns on or off (with),
// the scheduled tasks that pause or run again, and for an add the connectors it
// brings that are not connected yet (needs). The agent cannot set those. An add
// whose connector takes a key comes with that connector's connect card on the
// same reply. From here its key is saved with set_agent_credentials right after
// the add is applied: saved while the agent is still stopping or queued for the
// restart the add started, it loads with that same restart.

/** A pending proposal older than this cannot be approved with a typed reply. */
export const SETUP_REPLY_WINDOW_SECONDS = 30 * 60;
// A reply carries at most three proposals.
const MAX_SETUP_CHANGES = 3;
const MAX_INSTRUCTIONS_LENGTH = 20_000;
// A custom skill's whole text, which Wiro writes on a proposal (the text before
// the change, or the earlier version an undo restores), can be longer than the
// instructions an agent writes. The same cap as manage_agent_custom_skill's value.
const MAX_SKILL_TEXT_LENGTH = 100_000;
const MAX_LINE_LENGTH = 300;

export const SETUP_CHANGE_KINDS = ['connect', 'schedule', 'skill', 'timezone', 'disconnect', 'add', 'remove'] as const;
export const SETUP_CHANGE_STATUSES = ['pending', 'applied', 'dismissed', 'failed'] as const;
// The custom skill actions that change its text and carry the text from before the change.
const SKILL_TEXT_ACTIONS: readonly string[] = ['update', 'append', 'revert'];

// The kinds that turn a Connector (int-*) or a Skill (util-*) on or off, by its name.
const REGISTRY_KINDS: readonly string[] = ['add', 'remove'];
const REGISTRY_NAME = /^(?:int|util)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEDULED_TASK_KEY = /^cs-cron-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONNECTOR_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
// What Wiro writes on an add or remove card, at most: the other names it turns on or off, the
// scheduled tasks that pause or run again, and the connectors still to connect.
const MAX_WITH = 12;
const MAX_TASKS = 20;
const MAX_NEEDS = 3;
// How a connector an add brings is connected: its key, a sign-in, or a setup on the agent page
// (files, service accounts, a Wiro project).
export const SETUP_NEED_MODES = ['key', 'signin', 'page'] as const;
type SetupNeedMode = typeof SETUP_NEED_MODES[number];

export const CHAT_SETUP_MODES = ['off', 'webchat', 'all'] as const;
export type ChatSetupMode = typeof CHAT_SETUP_MODES[number];

/** What each chat_setup value allows, said the same way by every tool that sets or shows it. */
export const CHAT_SETUP_DESCRIPTION = 'Setup from chat lets the agent propose setup changes in its chat (connect or '
  + 'disconnect a service, add or remove a Connector or Skill, scheduled tasks, custom skills and its time zone); '
  + 'nothing changes until an agent admin approves the proposal. "all" (the '
  + 'default) allows it in the Wiro web chat and in messages sent with an API key, such as from this MCP server; '
  + '"webchat" only in the Wiro web chat; "off" turns it off. Messages sent with an API key act with the key '
  + 'owner\'s rights, so an agent shared with customers or many people usually uses "webchat" or "off".';

const setupNeedSchema = z.object({
  connector: z.string(),
  title: z.string().optional(),
  mode: z.enum(SETUP_NEED_MODES).optional(),
});

export type SetupNeed = z.infer<typeof setupNeedSchema>;

export const setupChangeSchema = z.object({
  id: z.string(),
  kind: z.enum(SETUP_CHANGE_KINDS),
  action: z.string().optional(),
  connector: z.string().optional(),
  key: z.string().optional()
    .describe('Schedule and skill: the scheduled task\'s or custom skill\'s key. Add and remove: the name of the '
      + 'Connector (int-*) or Skill (util-*) the change turns on or off.'),
  title: z.string().optional(),
  cron: z.string().optional(),
  instructions: z.string().optional()
    .describe('The scheduled task\'s or custom skill\'s text: the whole new text (create, update), only the text to '
      + 'add at the end of the skill (append), or the earlier version an undo restores (revert), which Wiro takes '
      + 'from the skill\'s history.'),
  before: z.string().optional()
    .describe('Custom skill update, append and revert: the skill\'s text when the change was proposed. Wiro adds it '
      + 'to the proposal; the agent cannot set it. It stays as it is once the change is applied, so it shows what '
      + 'the change replaced.'),
  timezone: z.string().optional(),
  with: z.array(z.string()).optional()
    .describe('Add and remove: the other Connectors and Skills, by name, that the change also turns on (add) or '
      + 'off (remove). Wiro adds it to the proposal; the agent cannot set it.'),
  pauses: z.array(z.string()).optional()
    .describe('Add and remove: the scheduled tasks, by key, that pause with the change. Wiro adds it.'),
  resumes: z.array(z.string()).optional()
    .describe('Add and remove: the scheduled tasks, by key, that run again with the change. Wiro adds it.'),
  needs: z.array(setupNeedSchema).optional()
    .describe('Add: the connectors the change brings that are not connected yet, and how each one connects: key '
      + '(its key, saved with set_agent_credentials, never in a chat message), signin (a sign-in on the agent page) '
      + 'or page (set up on the agent page). Wiro adds it.'),
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

/** The distinct names of a list Wiro writes on an add or remove, at most max; anything else in it is left out. */
function nameList(value: unknown, pattern: RegExp, max: number, except?: string): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (names.length === max) break;
    const name = typeof item === 'string' ? item.trim() : '';
    if (name && name.length <= MAX_NAME_LENGTH && pattern.test(name) && name !== except && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The connectors an add brings that are not connected yet, as Wiro wrote them. A mode this version does not know is left out. */
function needList(value: unknown): SetupNeed[] {
  if (!Array.isArray(value)) return [];
  const needs: SetupNeed[] = [];
  for (const item of value) {
    if (needs.length === MAX_NEEDS) break;
    if (!isPlainObject(item)) continue;
    const connector = asString(item.connector)?.trim();
    if (!connector || connector.length > MAX_NAME_LENGTH || !CONNECTOR_KEY.test(connector) || connector.startsWith('sys-')
      || needs.some(need => need.connector === connector)) continue;
    const title = shortLine(item.title);
    const mode = asString(item.mode);
    needs.push({
      connector,
      ...(title ? { title } : {}),
      ...((SETUP_NEED_MODES as readonly string[]).includes(mode ?? '') ? { mode: mode as SetupNeedMode } : {}),
    });
  }
  return needs;
}

/**
 * An add or a remove: one Connector or Skill by its name, with what Wiro wrote on the proposal about what
 * the change also does. The proposal has no title for the name, so the name is what is shown, and fields of
 * other kinds are left out. A name that is not a Connector's or a Skill's is a shape this version does not know.
 */
function toRegistryChange(value: Record<string, unknown>, id: string, kind: SetupChange['kind'], status: SetupChange['status']): SetupChange | undefined {
  const key = asString(value.key)?.trim();
  if (!key || key.length > MAX_NAME_LENGTH || !REGISTRY_NAME.test(key)) return undefined;
  const withNames = nameList(value.with, REGISTRY_NAME, MAX_WITH, key);
  const pauses = nameList(value.pauses, SCHEDULED_TASK_KEY, MAX_TASKS);
  const resumes = nameList(value.resumes, SCHEDULED_TASK_KEY, MAX_TASKS);
  // Only an add brings connectors.
  const needs = kind === 'add' ? needList(value.needs) : [];
  const note = shortLine(value.note);
  const proposedAt = unixToIso(value.createdat);
  const actedAt = unixToIso(value.actedat);
  const error = status === 'failed' ? shortLine(value.error) : undefined;
  return {
    id,
    kind,
    status,
    key,
    ...(withNames.length > 0 ? { with: withNames } : {}),
    ...(pauses.length > 0 ? { pauses } : {}),
    ...(resumes.length > 0 ? { resumes } : {}),
    ...(needs.length > 0 ? { needs } : {}),
    ...(note ? { note } : {}),
    ...(proposedAt ? { proposedAt } : {}),
    ...(actedAt ? { actedAt } : {}),
    ...(error ? { error } : {}),
  };
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
  if (REGISTRY_KINDS.includes(kind ?? '')) return toRegistryChange(value, id, kind as SetupChange['kind'], status);
  const action = shortLine(value.action);
  const skillText = kind === 'skill' && SKILL_TEXT_ACTIONS.includes(action ?? '');
  const instructions = asString(value.instructions);
  const before = skillText ? asString(value.before) : undefined;
  // An undo's text is the skill's earlier version, which Wiro puts on the card, so it can be longer than an agent's
  // instructions.
  const instructionsCap = skillText && action === 'revert' ? MAX_SKILL_TEXT_LENGTH : MAX_INSTRUCTIONS_LENGTH;
  const fields: Record<string, string | undefined> = {
    action,
    connector: shortLine(value.connector),
    key: shortLine(value.key),
    title: shortLine(value.title),
    cron: shortLine(value.cron),
    instructions: instructions?.trim() ? truncate(instructions, instructionsCap) : undefined,
    before: before?.trim() ? truncate(before, MAX_SKILL_TEXT_LENGTH) : undefined,
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

// Wiro's own answer to a setup reply is written for a person typing in the chat, so it can ask for a key as the
// next reply: "Next: paste your Serper key as your reply.", a listing that takes the key in place of the yes, or
// connect cards that still need their keys. Lines quoting a proposal's text start with ">" and are left out.
const KEY_AS_REPLY = /\b(?:paste|reply with) your .{1,100}? key\b|\bstill need their keys\b/i;

/** Whether Wiro's answer to a setup reply asks for a key as the next chat reply. */
export function asksKeyAsReply(answer: string | undefined): boolean {
  return typeof answer === 'string'
    && answer.split(/\r?\n/).some(line => !line.trimStart().startsWith('>') && KEY_AS_REPLY.test(line));
}

/** What to do when Wiro's answer asks for a key as the next reply, said the same way by the note and the Next line. */
export const SETUP_KEY_RULE = 'Never send a key in a chat message: save it right away with set_agent_credentials, under '
  + 'the connector the agent\'s proposal names. Saved while the agent is still stopping or queued for its restart, the '
  + 'key loads with that same restart; saved once the agent is starting again, it restarts the agent a second time.';

/** The same for a listing that offers to take the key in place of the yes. */
export const SETUP_LISTING_KEY_RULE = 'The listing offers to take a key as the reply. Never send a key in a chat '
  + 'message: once the user agrees, send "yes" to apply the change, then save the key with set_agent_credentials '
  + 'right away, so it loads with the same restart.';

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
  append: 'Add to the custom skill',
  revert: 'Undo the last change to the custom skill',
};

/** What an add or a remove turns on or off: a Connector for an int-* name, else a Skill. */
function registryWord(key: string | undefined): string {
  return key?.startsWith('int-') ? 'Connector' : 'Skill';
}

/** One line that names the change, such as "Create the scheduled task `cs-cron-weekly-report`". */
export function setupChangeHeadline(change: SetupChange): string {
  switch (change.kind) {
    case 'connect':
      return `Connect ${quotedSpan(change.connector ?? '')}`;
    case 'disconnect':
      return `Disconnect ${quotedSpan(change.connector ?? '')}`;
    case 'add':
      return `Add ${registryWord(change.key)} ${quotedSpan(change.key ?? '')}`;
    case 'remove':
      return `Remove ${registryWord(change.key)} ${quotedSpan(change.key ?? '')}`;
    case 'schedule':
      return `${SCHEDULE_VERBS[change.action ?? ''] ?? 'Change the scheduled task'} ${quotedSpan(change.key ?? '')}`;
    case 'skill':
      return `${SKILL_VERBS[change.action ?? ''] ?? 'Change the custom skill'} ${quotedSpan(change.key ?? '')}`;
    default:
      return `Set the agent's time zone to ${quotedSpan(change.timezone ?? '')}`;
  }
}

function isSkillAction(change: SetupChange, action: string): boolean {
  return change.kind === 'skill' && change.action === action;
}

/** The label of a proposal's own text, before it is applied or after. */
function changeTextLabel(change: SetupChange, applied: boolean): string {
  if (isSkillAction(change, 'append')) return applied ? SETUP_ADDED_LABEL : SETUP_ADDITION_LABEL;
  if (isSkillAction(change, 'revert')) return applied ? SETUP_RESTORED_AFTER_LABEL : SETUP_RESTORED_LABEL;
  return applied ? SETUP_AFTER_TEXT_LABEL : SETUP_INSTRUCTIONS_LABEL;
}

/**
 * Whether a settled change is shown with the skill's text before and after it:
 * an applied change to a custom skill's text that carries both.
 */
function showsBeforeAndAfter(change: SetupChange): boolean {
  return change.status === 'applied' && change.before !== undefined && change.instructions !== undefined;
}

// How each connector an add brings is connected once the add is applied.
const NEED_HOW: Record<SetupNeedMode, string> = {
  key: 'its key, saved with set_agent_credentials right after this change is applied (one restart then loads both), '
    + 'never sent in a chat message',
  signin: 'sign in on the agent page, or with connect_agent_oauth',
  page: 'set up on the agent page',
};

function needLine(need: SetupNeed): string {
  const name = need.title ? `${quotedSpan(need.title)} (${quotedSpan(need.connector)})` : quotedSpan(need.connector);
  return need.mode ? `${name}: ${NEED_HOW[need.mode]}` : name;
}

/**
 * What an add or a remove also does, as Wiro wrote it on the proposal: the other names it turns on or off,
 * the scheduled tasks that run again or pause, the connectors an add still needs connected, and for a
 * Connector's remove that its saved key stays.
 */
function registryChangeLines(change: SetupChange): string[] {
  if (change.kind !== 'add' && change.kind !== 'remove') return [];
  const add = change.kind === 'add';
  const names = (list: readonly string[]) => list.map(name => quotedSpan(name)).join(', ');
  const lines: string[] = [];
  if (change.with) lines.push(`- Also turns ${add ? 'on' : 'off'}: ${names(change.with)}`);
  const resumes = change.resumes ? [`- Scheduled tasks that run again: ${names(change.resumes)}`] : [];
  const pauses = change.pauses ? [`- Scheduled tasks that pause: ${names(change.pauses)}`] : [];
  lines.push(...(add ? [...resumes, ...pauses] : [...pauses, ...resumes]));
  if (change.needs) lines.push('- Still to connect once it is on:', ...change.needs.map(need => `  - ${needLine(need)}`));
  if (!add && change.key?.startsWith('int-')) {
    lines.push('- Its saved key stays saved, if it has one: adding it back needs no new key. Only a disconnect '
      + 'removes a key.');
  }
  return lines;
}

/**
 * The number of the pending add on the same reply that brings this connect card's connector with a key (the
 * add-and-connect pair Wiro makes), or undefined.
 */
function pairedAddNumber(change: SetupChange, pending: readonly SetupChange[]): number | undefined {
  if (change.kind !== 'connect' || !change.connector) return undefined;
  const index = pending.findIndex(other => other.kind === 'add'
    && other.needs?.some(need => need.connector === change.connector && need.mode === 'key'));
  return index >= 0 ? index + 1 : undefined;
}

function pendingChangeLines(change: SetupChange, index: number, nowMs: number, pending: readonly SetupChange[]): string[] {
  const lines = [`#### Proposed change ${index + 1}: ${setupChangeHeadline(change)}`, ''];
  if (change.title) lines.push(`- Title: ${quotedSpan(change.title)}`);
  if (change.cron) {
    lines.push(`- Schedule: ${quotedSpan(change.cron)} (cron: minute, hour, day of month, month, weekday; in the `
      + 'agent\'s time zone)');
  }
  const pairedAdd = pairedAddNumber(change, pending);
  if (pairedAdd !== undefined) {
    lines.push(`- Connects what proposed change ${pairedAdd} adds. Once change ${pairedAdd} is applied, save the key `
      + 'with set_agent_credentials right away, never in a chat message: one restart then loads both.');
  } else if (change.kind === 'connect') {
    lines.push('- The user provides the key or sign-in for it. A key is saved with set_agent_credentials, never sent '
      + 'in a chat message.');
  }
  if (change.kind === 'disconnect') {
    lines.push('- Its saved key is removed, and skills that use it stop until it is connected again. Approving it '
      + 'needs no key.');
  }
  lines.push(...registryChangeLines(change));
  if (isSkillAction(change, 'append')) {
    lines.push('- Adds the proposal\'s text at the end of the skill, after a blank line. The rest of the skill stays as '
      + 'it is.');
  }
  if (isSkillAction(change, 'revert')) {
    lines.push('- Restores the skill\'s text from before its last change. Wiro took that text from the skill\'s '
      + 'history, not from the agent\'s proposal.');
  }
  if (change.note) lines.push(`- Note from the agent: ${quotedSpan(change.note)}`);
  if (change.proposedAt) lines.push(`- Proposed at: ${change.proposedAt}`);
  if (!isApprovableByReply(change, nowMs)) {
    lines.push(`- Older than ${SETUP_REPLY_WINDOW_SECONDS / 60} minutes, so a reply can no longer approve it. The user `
      + 'can still apply it in the agent\'s chat on wiro.ai, or ask the agent again.');
  }
  if (change.before) lines.push('', ...quotedBlock(SETUP_CURRENT_TEXT_LABEL, change.before));
  if (change.instructions) lines.push('', ...quotedBlock(changeTextLabel(change, false), change.instructions));
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

/** An applied change to a custom skill's text: the skill's text before it, then the text it wrote. */
function appliedChangeLines(change: SetupChange): string[] {
  const when = change.actedAt ? ` (${change.actedAt})` : '';
  return [
    `#### Applied: ${setupChangeHeadline(change)}${when}`,
    '',
    ...quotedBlock(SETUP_BEFORE_TEXT_LABEL, change.before ?? ''),
    '',
    ...quotedBlock(changeTextLabel(change, true), change.instructions ?? ''),
  ];
}

/**
 * The text for a reply's proposals: each pending one in full, an applied change
 * to a custom skill's text with the text before and after it, and each other
 * settled one as one status line.
 */
export function formatSetupChanges(changes: readonly SetupChange[], nowMs = Date.now()): string[] {
  if (changes.length === 0) return [];
  const lines = ['', '### Setup changes proposed in this reply', ''];
  const pending = changes.filter(change => change.status === 'pending');
  const sections = [
    ...pending.map((change, index) => pendingChangeLines(change, index, nowMs, pending)),
    ...changes.filter(showsBeforeAndAfter).map(appliedChangeLines),
  ];
  sections.forEach((section, index) => {
    if (index > 0) lines.push('');
    lines.push(...section);
  });
  const settled = changes.filter(change => change.status !== 'pending' && !showsBeforeAndAfter(change));
  if (settled.length > 0) {
    if (sections.length > 0) lines.push('');
    lines.push(...settled.map(settledChangeLine));
  }
  return lines;
}

/** One line per proposal, for a conversation listing. */
export function setupChangeSummaryLines(changes: readonly SetupChange[]): string[] {
  return changes.map((change) => {
    if (change.status === 'pending') {
      return `- Proposed setup change (pending): ${setupChangeHeadline(change)}. get_agent_message with this message id shows it in full.`;
    }
    return showsBeforeAndAfter(change)
      ? `${settledChangeLine(change)}. get_agent_message with this message id shows the skill's text before and after it.`
      : settledChangeLine(change);
  });
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
