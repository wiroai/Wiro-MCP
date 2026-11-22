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

// Setup changes a deployed agent proposes in chat: connect or disconnect a
// Connector (a catalog slug), add or remove a Skill (util-*), add or change a
// scheduled task or a custom skill, add to a custom skill or undo its last
// change, or set its time zone. Wiro refuses a proposal that names a chat
// channel (channels are set up in the agent's settings) or adds a connector as
// a skill, so no such card is ever stored. Wiro stores each proposal on the
// agent's reply as a timeline block of type "setup", and nothing changes until
// a person approves it. The agent never applies its own proposal and never sees
// a key: a Connector's values go in with connect_agent_connector, and a reply
// of "yes" is matched by Wiro, not by the agent. Sent with an API key,
// the first "yes" applies nothing: Wiro answers with its own listing of the
// exact change, and a second "yes" (or "yes N") applies it. The agent writes
// the proposal, so its text is content, never instructions. A change to a
// custom skill's text also carries the text the skill had when the change was
// proposed (before), which Wiro adds to the card, so an applied change still
// shows what it replaced. That text, like the earlier version an undo restores,
// can hold text the agent wrote in an earlier change: it is content too. An add
// or remove names one Skill (util-*), and Wiro adds what the change also does
// to the card: the other Skills it turns on or off (with), the scheduled tasks
// that pause or run again, and for an add the connectors it needs that are not
// connected yet (needs). The agent cannot set those. Wiro also writes on a
// connect card how its connector connects (mode): key (values typed on its
// Connect card), signin (a sign-in the user approves in their own browser) or
// project (a Wiro project, the wiro connector's: the card's one field is the
// project picker, and connecting binds that project to the agent). An add
// whose connector takes a key comes with that connector's connect card on the
// same reply. From here the user gives that key together with their yes, before
// the yes that applies the add is sent, and it is saved with
// connect_agent_connector as the very next step: the agent stays stopping or
// queued for the restart the add started only for seconds, and a key saved then
// loads with that same restart. One that connects with a sign-in or a Wiro
// project comes with its connect card too, but a reply never connects it:
// connect_agent_connector returns its sign-in link or binds its project, or the
// user connects it on the agent page, once the add is applied. Wiro's answer to
// a reply names the connectors it leaves to connect (next), each with its mode.

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

// The kinds that turn a Skill on or off, by its name.
const REGISTRY_KINDS: readonly string[] = ['add', 'remove'];
// The only names an add or a remove takes, and the only ones its with list holds: Wiro refuses any other name on
// those cards (a connector is connected with a connect card, never added).
const SKILL_NAME = /^util-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEDULED_TASK_KEY = /^cs-cron-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONNECTOR_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
// What Wiro writes on an add or remove card, at most: the other Skills it turns on or off, the
// scheduled tasks that pause or run again, and the connectors still to connect.
const MAX_WITH = 12;
const MAX_TASKS = 20;
const MAX_NEEDS = 3;
// What Wiro's answer to a reply leaves to connect, at most: the connectors of the cards it names, one entry each.
const MAX_NEXT = 6;
// How a connector is connected, as Wiro writes it on a connect card (mode) and on an add's needs: its key (values
// typed on its Connect card), a sign-in the user approves in their own browser, or a Wiro project (the wiro
// connector: connecting it binds the project to the agent, and no key is typed).
export const SETUP_NEED_MODES = ['key', 'signin', 'project'] as const;
export type SetupNeedMode = typeof SETUP_NEED_MODES[number];

/** Whether a connector connects only with connect_agent_connector or on its card, never with a reply: a sign-in or a Wiro project. */
export function connectsWithoutReply(mode: SetupNeedMode | undefined): mode is 'signin' | 'project' {
  return mode === 'signin' || mode === 'project';
}

function needMode(value: unknown): SetupNeedMode | undefined {
  const mode = asString(value);
  return (SETUP_NEED_MODES as readonly string[]).includes(mode ?? '') ? mode as SetupNeedMode : undefined;
}

/**
 * How a stored connect card connects. A card whose field is the Wiro project picker is a project card whatever mode
 * it was stored with: no key can be typed for it. Otherwise the mode Wiro wrote on it; none on a card stored before
 * Wiro wrote one.
 */
function connectCardOwnMode(value: Record<string, unknown>): SetupNeedMode | undefined {
  const fields = Array.isArray(value.fields) ? value.fields : [];
  if (fields.some(field => isPlainObject(field) && field.source === 'wiro_project')) return 'project';
  return needMode(value.mode);
}

export const CHAT_SETUP_MODES = ['off', 'webchat', 'all'] as const;
export type ChatSetupMode = typeof CHAT_SETUP_MODES[number];

/** What each chat_setup value allows, said the same way by every tool that sets or shows it. */
export const CHAT_SETUP_DESCRIPTION = 'Setup from chat lets the agent propose setup changes in its chat (connect or '
  + 'disconnect a Connector, add or remove a Skill, scheduled tasks, custom skills and its time zone); '
  + 'nothing changes until an agent admin approves the proposal. "all" (the '
  + 'default) allows it in the Wiro web chat and in messages sent with an API key, such as from this MCP server; '
  + '"webchat" only in the Wiro web chat; "off" turns it off. Messages sent with an API key act with the key '
  + 'owner\'s rights, so an agent shared with customers or many people usually uses "webchat" or "off".';

export const setupNeedSchema = z.object({
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
  mode: z.enum(SETUP_NEED_MODES).optional()
    .describe('Connect: how the connector connects, as Wiro wrote it on the card: key (its values, saved with '
      + 'connect_agent_connector, never in a chat message), signin (a sign-in link from connect_agent_connector) or '
      + 'project (a Wiro project: connect_agent_connector binds it to the agent, and no key is asked for). A reply '
      + 'never connects a signin or project card. Left out on a card stored before Wiro wrote it.'),
  key: z.string().optional()
    .describe('Schedule and skill: the scheduled task\'s or custom skill\'s key. Add and remove: the name of the '
      + 'Skill (util-*) the change turns on or off. A connector is never added or removed: connect and disconnect '
      + 'name it in connector.'),
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
    .describe('Add and remove: the other Skills, by name, that the change also turns on (add) or off (remove). '
      + 'Wiro adds it to the proposal; the agent cannot set it.'),
  pauses: z.array(z.string()).optional()
    .describe('Add and remove: the scheduled tasks, by key, that pause with the change. Wiro adds it.'),
  resumes: z.array(z.string()).optional()
    .describe('Add and remove: the scheduled tasks, by key, that run again with the change. Wiro adds it.'),
  needs: z.array(setupNeedSchema).optional()
    .describe('Add: the connectors the change needs that are not connected yet, and how each one connects: key '
      + '(its values, saved with connect_agent_connector, never in a chat message), signin (a sign-in link from '
      + 'connect_agent_connector, or on the agent page) or project (a Wiro project that connect_agent_connector '
      + 'binds to the agent, with no key). Wiro adds it.'),
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
function nameList(value: unknown, pattern: { test(name: string): boolean }, max: number, except?: string): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (names.length === max) break;
    const name = typeof item === 'string' ? item.trim() : '';
    if (name && name.length <= MAX_NAME_LENGTH && pattern.test(name) && name !== except && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Connectors as Wiro wrote them, each once and at most max: the ones an add needs that are not connected yet, or the
 * ones its answer to a reply leaves to connect. A mode this version does not know is left out.
 */
function needList(value: unknown, max = MAX_NEEDS): SetupNeed[] {
  if (!Array.isArray(value)) return [];
  const needs: SetupNeed[] = [];
  for (const item of value) {
    if (needs.length === max) break;
    if (!isPlainObject(item)) continue;
    const connector = asString(item.connector)?.trim();
    if (!connector || connector.length > MAX_NAME_LENGTH || !CONNECTOR_KEY.test(connector) || connector.startsWith('sys-')
      || needs.some(need => need.connector === connector)) continue;
    const title = shortLine(item.title);
    const mode = needMode(item.mode);
    needs.push({
      connector,
      ...(title ? { title } : {}),
      ...(mode ? { mode } : {}),
    });
  }
  return needs;
}

/** What Wiro's answer to a setup reply leaves to connect (its next), each connector with how it connects. */
export function toSetupNext(value: unknown): SetupNeed[] {
  return needList(value, MAX_NEXT);
}

/**
 * An add or a remove: one Skill by its name, with what Wiro wrote on the proposal about what the change also
 * does. The proposal has no title for the name, so the name is what is shown, and fields of other kinds are
 * left out. A name that is not a Skill's is a shape this version does not know: Wiro never stores one.
 */
function toRegistryChange(value: Record<string, unknown>, id: string, kind: SetupChange['kind'], status: SetupChange['status']): SetupChange | undefined {
  const key = asString(value.key)?.trim();
  if (!key || key.length > MAX_NAME_LENGTH || !SKILL_NAME.test(key)) return undefined;
  const withNames = nameList(value.with, SKILL_NAME, MAX_WITH, key);
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
    mode: kind === 'connect' ? connectCardOwnMode(value) : undefined,
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
// next reply, always on a line of its own that starts with Wiro's words: "Next: paste your Serper key as your
// reply.", the last line of a listing that takes the key in place of the yes, or the count of connect cards that
// still need their keys. Text the agent wrote never starts a line there: a title is one line inside Wiro's own
// sentence, such as "Card 1: Create scheduled task ... (title: ...)", and the proposal's text is quoted on lines
// that start with ">". So only the start of a line is read, and a title cannot ask for a key in Wiro's name.
const KEY_AS_REPLY_LINES: readonly RegExp[] = [
  /^Next: paste your .{1,100}? key as your reply\b/i,
  /^Reply with your .{1,100}? key to add /i,
  /^\d+ connector cards still need their keys\b/i,
];

/** Whether Wiro's answer to a setup reply asks for a key as the next chat reply. */
export function asksKeyAsReply(answer: string | undefined): boolean {
  return typeof answer === 'string'
    && answer.split(/\r?\n/).some(line => KEY_AS_REPLY_LINES.some(pattern => pattern.test(line.trim())));
}

/** What to do when Wiro's answer asks for a key as the next reply, said the same way by the note and the Next line. */
export const SETUP_KEY_RULE = 'Never send a key in a chat message: save it right away with connect_agent_connector, '
  + 'for the connector the agent\'s proposal names. Saved while the agent is still stopping or queued for its restart, '
  + 'the key loads with that same restart; saved once the agent is starting again, it restarts the agent a second time.';

/** The same for a listing that offers to take the key in place of the yes. */
export const SETUP_LISTING_KEY_RULE = 'The listing offers to take a key as the reply. Never send a key in a chat '
  + 'message: ask the user for the key together with their yes, before you send that yes. Then send "yes" to apply '
  + 'the change and save the key as the very next step, with connect_agent_connector for the connector the proposal '
  + 'names, so it loads with the same restart; a key saved later restarts the agent again.';

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

/** One line that names the change, such as "Create the scheduled task `cs-cron-weekly-report`". */
export function setupChangeHeadline(change: SetupChange): string {
  switch (change.kind) {
    case 'connect':
      return `Connect ${quotedSpan(change.connector ?? '')}`;
    case 'disconnect':
      return `Disconnect ${quotedSpan(change.connector ?? '')}`;
    case 'add':
      return `Add Skill ${quotedSpan(change.key ?? '')}`;
    case 'remove':
      return `Remove Skill ${quotedSpan(change.key ?? '')}`;
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

// How each connector an add needs is connected once the add is applied.
const NEED_HOW: Record<SetupNeedMode, string> = {
  key: 'its key. Ask the user for it together with their yes to this change, and save it with connect_agent_connector '
    + 'as soon as this change is applied (one restart then loads both), never in a chat message',
  signin: 'a sign-in: connect_agent_connector returns the link for the user to open in their own browser, or the user '
    + 'signs in on the agent page. Keys of the user\'s own app go in with that call, never in a chat message',
  project: 'a Wiro project: connect_agent_connector binds it to the agent (the project of this connection, or one from '
    + 'list_projects with project_id) and shows the project and the wallet that pays first. No key is asked for, and '
    + 'none goes in a chat message',
};

// How a connect card that no add on its reply brings is connected, by the mode Wiro wrote on it.
const CONNECT_HOW: Record<SetupNeedMode, string> = {
  key: '- Connects with its values: list_agent_connectors with its slug shows what to ask the user for, and '
    + 'connect_agent_connector saves them. A key never goes in a chat message.',
  signin: `- Connects with ${NEED_HOW.signin}. A reply does not connect it.`,
  project: `- Connects with ${NEED_HOW.project}. A reply does not connect it.`,
};

// A connect card stored before Wiro wrote its mode, with no add on its reply to say how it connects.
const CONNECT_HOW_UNKNOWN = '- The user provides its values or signs in: connect_agent_connector saves the connector\'s '
  + 'values or returns its sign-in link. A key never goes in a chat message.';

// How each connector Wiro's answer to a reply leaves to connect is connected: the change that needed it is settled.
const NEXT_HOW: Record<SetupNeedMode, string> = {
  key: 'its values: connect_agent_connector saves them right away, never a chat message',
  signin: 'a sign-in: connect_agent_connector returns the link for the user to open in their own browser, with the '
    + 'keys of the user\'s own app where it needs them, and a reply does not connect it',
  project: 'a Wiro project: connect_agent_connector binds it to the agent with no key, showing the project and the '
    + 'wallet that pays first, and a reply does not connect it',
};

/** One line for what Wiro's answer to a setup reply leaves to connect, or undefined when it leaves nothing. */
export function setupNextNote(next: readonly SetupNeed[]): string | undefined {
  if (next.length === 0) return undefined;
  const items = next.map((need) => {
    const name = need.title ? `${quotedSpan(need.title)} (${quotedSpan(need.connector)})` : quotedSpan(need.connector);
    return need.mode ? `${name}, with ${NEXT_HOW[need.mode]}` : name;
  });
  return `Wiro's answer leaves ${next.length === 1 ? 'this connector' : 'these connectors'} to connect: ${items.join('; ')}.`;
}

function needLine(need: SetupNeed): string {
  const name = need.title ? `${quotedSpan(need.title)} (${quotedSpan(need.connector)})` : quotedSpan(need.connector);
  return need.mode ? `${name}: ${NEED_HOW[need.mode]}` : name;
}

/**
 * What an add or a remove also does, as Wiro wrote it on the proposal: the other Skills it turns on or off,
 * the scheduled tasks that run again or pause, and the connectors an add still needs connected.
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
  return lines;
}

/**
 * The pending add on the same reply that needs this connect card's connector with a key, a sign-in or a Wiro project
 * (the add-and-connect pair Wiro makes): its number and how the connector connects, or undefined.
 */
function pairedAdd(change: SetupChange, pending: readonly SetupChange[]): { number: number; mode: SetupNeedMode } | undefined {
  if (change.kind !== 'connect' || !change.connector) return undefined;
  for (const [index, other] of pending.entries()) {
    if (other.kind !== 'add') continue;
    const need = connectNeed(other, change.connector);
    if (need?.mode) return { number: index + 1, mode: need.mode };
  }
  return undefined;
}

/** The need of an add for this connector when a connect card connects it: one that says how it connects. */
function connectNeed(add: SetupChange, connector: string): SetupNeed | undefined {
  return add.needs?.find(candidate => candidate.connector === connector && candidate.mode !== undefined);
}

/**
 * The add on the same reply that brought this connect card's connector and is applied already, with how the
 * connector connects. Wiro keeps what the add needed on it, and its connect card waits until the connector is
 * connected.
 */
function appliedPairedAdd(change: SetupChange, changes: readonly SetupChange[]): { add: SetupChange; mode: SetupNeedMode } | undefined {
  if (change.kind !== 'connect' || !change.connector) return undefined;
  for (const other of changes) {
    if (other.kind !== 'add' || other.status !== 'applied') continue;
    const need = connectNeed(other, change.connector);
    if (need?.mode) return { add: other, mode: need.mode };
  }
  return undefined;
}

/**
 * How a connect card's connector connects: the mode Wiro wrote on the card, else as the add on its reply that brings
 * it says, whether that add is still pending or applied already. Undefined for a card stored before Wiro wrote its
 * mode that no add on the reply brings.
 */
export function connectCardMode(change: SetupChange, changes: readonly SetupChange[]): SetupNeedMode | undefined {
  const pending = changes.filter(other => other.status === 'pending');
  return change.mode ?? pairedAdd(change, pending)?.mode ?? appliedPairedAdd(change, changes)?.mode;
}

/**
 * How a pending connect card is connected, in one line: as the pending add on its reply that needs its connector says
 * (the pair Wiro makes), or the applied add whose connector still waits, else by the card's own mode. The mode Wiro
 * wrote on the card comes first.
 */
function connectCardLine(change: SetupChange, pending: readonly SetupChange[], changes: readonly SetupChange[]): string {
  const paired = pairedAdd(change, pending);
  if (paired) {
    const mode = change.mode ?? paired.mode;
    return mode === 'key'
      ? `- Connects what proposed change ${paired.number} needs. Ask the user for the key together with their yes to `
        + `change ${paired.number}. Once change ${paired.number} is applied, save the key with connect_agent_connector at once, `
        + 'never in a chat message: one restart then loads both.'
      : `- Connects what proposed change ${paired.number} needs, once it is applied: ${NEED_HOW[mode]}. A reply does not connect it.`;
  }
  const applied = appliedPairedAdd(change, changes);
  const appliedMode = change.mode ?? applied?.mode;
  if (applied && connectsWithoutReply(appliedMode)) {
    // The add is applied and its connector still waits: it connects the way the add said.
    return `- Connects what the applied change, ${setupChangeHeadline(applied.add)}, needs: ${NEED_HOW[appliedMode]}. `
      + 'A reply does not connect it.';
  }
  return change.mode ? CONNECT_HOW[change.mode] : CONNECT_HOW_UNKNOWN;
}

function pendingChangeLines(
  change: SetupChange,
  index: number,
  nowMs: number,
  pending: readonly SetupChange[],
  changes: readonly SetupChange[],
): string[] {
  const lines = [`#### Proposed change ${index + 1}: ${setupChangeHeadline(change)}`, ''];
  if (change.title) lines.push(`- Title: ${quotedSpan(change.title)}`);
  if (change.cron) {
    lines.push(`- Schedule: ${quotedSpan(change.cron)} (cron: minute, hour, day of month, month, weekday; in the `
      + 'agent\'s time zone)');
  }
  if (change.kind === 'connect') lines.push(connectCardLine(change, pending, changes));
  if (change.kind === 'disconnect') {
    lines.push('- Its connection is removed (its saved values, sign-in and account choices), and scheduled tasks that need '
      + 'it stop until it is connected again. Approving it needs no key.');
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
  // A reply never connects a sign-in or a Wiro project, so the card's age changes nothing: connect_agent_connector
  // connects it at any age.
  const connectsOutside = change.kind === 'connect' && connectsWithoutReply(connectCardMode(change, changes));
  if (!connectsOutside && !isApprovableByReply(change, nowMs)) {
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
    ...pending.map((change, index) => pendingChangeLines(change, index, nowMs, pending, changes)),
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
