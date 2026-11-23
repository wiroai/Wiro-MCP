import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, isPlainObject, requireApiSuccess, truncate, unixToIso, type ApiEnvelope } from './api.js';

// Connector permissions: what a connected Connector's actions may do without asking. Wiro sorts each action into a
// group by what it does (Read-only, Create and send, Change and delete) and gives each one a value in two columns:
// Chat, when someone is talking to the agent (the Wiro web chat, a message sent with an API key or from this server,
// an authorized Telegram, Slack or Discord chat), and Autopilot, its scheduled tasks and the work before and after a
// voice call. Any other work the agent does on its own (sub-agents, work in the background) takes the stricter of
// the two for each action, so an action runs there without asking only where both columns allow it.
// Allow runs the action, Ask waits for a person to approve it in the chat (an approval card), and Block never runs
// it; an action blocked in both columns is not shown to the agent at all. A group's value holds for each of its
// actions, and an action can have a setting of its own. By default Read-only runs, Create and send asks, and Change
// and delete asks in Chat and never runs in Autopilot. These are the words the Wiro dashboard uses; the keys the API
// takes are read, create and change, chat and autopilot, allow, ask and block.

export const PERMISSION_CATEGORIES = ['read', 'create', 'change'] as const;
export type PermissionCategory = typeof PERMISSION_CATEGORIES[number];

export const PERMISSION_COLUMNS = ['chat', 'autopilot'] as const;
export type PermissionColumn = typeof PERMISSION_COLUMNS[number];

export const PERMISSION_VALUES = ['allow', 'ask', 'block'] as const;
export type PermissionValue = typeof PERMISSION_VALUES[number];

export type PermissionCells = Partial<Record<PermissionColumn, PermissionValue>>;

/** The defaults of each group, the same on every connector unless Wiro sets an action's own default. */
export const CATEGORY_DEFAULTS: Record<PermissionCategory, Record<PermissionColumn, PermissionValue>> = {
  read: { chat: 'allow', autopilot: 'allow' },
  create: { chat: 'ask', autopilot: 'ask' },
  change: { chat: 'ask', autopilot: 'block' },
};

export const CATEGORY_TITLES: Record<PermissionCategory, string> = {
  read: 'Read-only',
  create: 'Create and send',
  change: 'Change and delete',
};

export const CATEGORY_TEXTS: Record<PermissionCategory, string> = {
  read: 'Looks things up and changes nothing.',
  create: 'Creates or sends something new, such as a post, a message or an email.',
  change: 'Changes or deletes what is already there.',
};

export const COLUMN_TITLES: Record<PermissionColumn, string> = { chat: 'Chat', autopilot: 'Autopilot' };

export const VALUE_TITLES: Record<PermissionValue, string> = { allow: 'Allow', ask: 'Ask', block: 'Block' };

/** The two columns and the three values, said the same way by every tool that shows or sets them. */
export const PERMISSIONS_EXPLAINED = 'Chat is when someone is talking to the agent: the Wiro web chat, a message sent '
  + 'with an API key or from this server, or an authorized Telegram, Slack or Discord chat. Autopilot is its scheduled '
  + 'tasks and the work before and after a voice call; any other work it does on its own, such as sub-agents and work '
  + 'in the background, takes the stricter of Chat and Autopilot for each action. Allow runs an action, Ask waits for a '
  + 'person to approve it in the chat, and Block never runs it; an action blocked in both is not shown to the agent at '
  + 'all.';

/** The defaults, in words. */
export const PERMISSION_DEFAULTS_TEXT = 'By default, read-only actions run, Create and send asks first, and Change and '
  + 'delete asks first in Chat and never runs in Autopilot.';

/** What the permissions of the Wiro AI Models connector cover, and what they do not. */
export const WIRO_SCOPE_NOTE = 'These permissions cover the actions of the Wiro AI Models connector. Skills that run '
  + 'models with the agent\'s own Wiro project, such as video creation, follow its Spend Limits and Model Access instead.';

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_DESCRIPTION = 200;
const MAX_TITLE = 120;

export const permissionValueSchema = z.enum(PERMISSION_VALUES);

const columnValueSchema = z.object({
  value: permissionValueSchema.nullable()
    .describe('The value every action of the group has in this column; null when they differ (mixed).'),
  mixed: z.boolean(),
});

export const permissionCategorySchema = z.object({
  key: z.enum(PERMISSION_CATEGORIES),
  title: z.string(),
  description: z.string(),
  actions: z.number().int().nonnegative(),
  chat: columnValueSchema,
  autopilot: columnValueSchema,
  chosen: z.object({ chat: permissionValueSchema.optional(), autopilot: permissionValueSchema.optional() })
    .describe('The group\'s own setting in each column, where one was chosen; a column left out follows the default.'),
});

export const permissionActionSchema = z.object({
  name: z.string().describe('The action\'s tool name at the connector, the key tools takes.'),
  title: z.string(),
  description: z.string().optional(),
  category: z.enum(PERMISSION_CATEGORIES),
  chat: permissionValueSchema,
  autopilot: permissionValueSchema,
  own: z.object({ chat: z.boolean(), autopilot: z.boolean() })
    .describe('Whether the action has a setting of its own in each column, instead of its group\'s. null in tools removes it.'),
  defaults: z.object({ chat: permissionValueSchema, autopilot: permissionValueSchema })
    .describe('What each column falls back to without a setting of its group or its own: Wiro\'s default for this action, else its group\'s.'),
  hidden: z.boolean().describe('Blocked in Chat and Autopilot, so the agent does not see it.'),
  listed: z.boolean()
    .describe('false: the connector has not listed this action yet; it shows because it has a setting of its own or a Wiro default.'),
});

export type PermissionCategoryView = z.infer<typeof permissionCategorySchema>;
export type PermissionAction = z.infer<typeof permissionActionSchema>;

/** Where a cell's value came from, as Wiro says it; used only to work out what a change does. */
type CellSource = 'tool' | 'category' | 'catalog' | 'default' | 'unknown';

interface ParsedAction extends PermissionAction {
  source: Record<PermissionColumn, CellSource>;
}

export interface PermissionView {
  categories: PermissionCategoryView[];
  actions: ParsedAction[];
  /** What an action the connector has not listed yet does in each column. */
  unlisted: Record<PermissionColumn, PermissionValue>;
  updatedAt?: string;
}

export interface ConnectorPermissions {
  connector: { slug: string; title: string; actionsListed: boolean; catalogStatus?: 'active' | 'hidden' | 'retired' };
  view: PermissionView;
  /** The approval cards waiting for this connector on Wiro's own approval messages, as Wiro lists them. */
  waiting: Record<string, unknown>[];
}

function value(raw: unknown): PermissionValue | undefined {
  const text = asString(raw);
  return (PERMISSION_VALUES as readonly string[]).includes(text ?? '') ? text as PermissionValue : undefined;
}

function category(raw: unknown): PermissionCategory | undefined {
  const text = asString(raw);
  return (PERMISSION_CATEGORIES as readonly string[]).includes(text ?? '') ? text as PermissionCategory : undefined;
}

function cellSource(raw: unknown): CellSource {
  const text = asString(raw);
  return text === 'tool' || text === 'category' || text === 'catalog' || text === 'default' || text === 'unknown' ? text : 'default';
}

function line(raw: unknown, max: number): string | undefined {
  const text = asString(raw)?.replace(/\s+/g, ' ').trim();
  return text ? truncate(text, max) : undefined;
}

function toAction(raw: Record<string, unknown>): ParsedAction | undefined {
  const name = asString(raw.name)?.trim();
  const group = category(raw.category);
  const chat = value(raw.chat);
  const autopilot = value(raw.autopilot);
  if (!name || !TOOL_NAME.test(name) || !group || !chat || !autopilot) return undefined;
  const sources = isPlainObject(raw.source) ? raw.source : {};
  const defaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const source = { chat: cellSource(sources.chat), autopilot: cellSource(sources.autopilot) };
  const description = line(raw.description, MAX_DESCRIPTION);
  return {
    name,
    title: line(raw.title, MAX_TITLE) ?? name,
    ...(description ? { description } : {}),
    category: group,
    chat,
    autopilot,
    own: { chat: source.chat === 'tool', autopilot: source.autopilot === 'tool' },
    defaults: {
      chat: value(defaults.chat) ?? CATEGORY_DEFAULTS[group].chat,
      autopilot: value(defaults.autopilot) ?? CATEGORY_DEFAULTS[group].autopilot,
    },
    hidden: chat === 'block' && autopilot === 'block',
    listed: raw.cached !== false,
    source,
  };
}

function toColumnValue(raw: unknown, fallback: PermissionValue): { value: PermissionValue | null; mixed: boolean } {
  if (!isPlainObject(raw)) return { value: fallback, mixed: false };
  if (raw.mixed === true) return { value: null, mixed: true };
  return { value: value(raw.value) ?? fallback, mixed: false };
}

/** ConnectorPermissions' view of one connection: its groups, its actions and what an action not listed yet does. */
export function toPermissionView(raw: unknown): PermissionView {
  const body = isPlainObject(raw) ? raw : {};
  const actions = (Array.isArray(body.tools) ? body.tools : []).filter(isPlainObject).map(toAction)
    .filter((action): action is ParsedAction => action !== undefined);
  const rows = (Array.isArray(body.categories) ? body.categories : []).filter(isPlainObject);
  const categories = PERMISSION_CATEGORIES.map((key) => {
    const row = rows.find(item => item.key === key) ?? {};
    const chosenRow = isPlainObject(row.chosen) ? row.chosen : {};
    const chosen: PermissionCells = {};
    for (const column of PERMISSION_COLUMNS) {
      const picked = value(chosenRow[column]);
      if (picked) chosen[column] = picked;
    }
    const count = typeof row.tools === 'number' && Number.isFinite(row.tools)
      ? Math.max(0, Math.trunc(row.tools))
      : actions.filter(action => action.category === key).length;
    return {
      key,
      title: CATEGORY_TITLES[key],
      description: CATEGORY_TEXTS[key],
      actions: count,
      chat: toColumnValue(row.chat, chosen.chat ?? CATEGORY_DEFAULTS[key].chat),
      autopilot: toColumnValue(row.autopilot, chosen.autopilot ?? CATEGORY_DEFAULTS[key].autopilot),
      chosen,
    };
  });
  const unknown = isPlainObject(body.unknown) ? body.unknown : {};
  const updatedAt = unixToIso(body.updatedat);
  return {
    categories,
    actions,
    unlisted: {
      chat: value(unknown.chat) ?? CATEGORY_DEFAULTS.change.chat,
      autopilot: value(unknown.autopilot) ?? CATEGORY_DEFAULTS.change.autopilot,
    },
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** An action as the tools return it: without where each value came from. */
export function publicAction(action: ParsedAction): PermissionAction {
  const { source: _source, ...rest } = action;
  return rest;
}

type PermissionsBody = ApiEnvelope & { connector?: unknown; permissions?: unknown; pending?: unknown };

/** One connection's permissions and the approval cards waiting for it. Only an agent admin can read them. */
export async function readConnectorPermissions(
  client: WiroClient,
  agentGuid: string,
  slug: string,
  signal?: AbortSignal,
): Promise<ConnectorPermissions> {
  const body = requireApiSuccess(
    await client.post<PermissionsBody>('/UserAgent/ConnectorPermissions', { useragentguid: agentGuid, slug }, signal),
    'The connector\'s permissions could not be read.',
  );
  const connector = isPlainObject(body.connector) ? body.connector : {};
  const status = asString(connector.catalogstatus);
  return {
    connector: {
      slug: asString(connector.slug) ?? slug,
      title: line(connector.title, MAX_TITLE) ?? slug,
      actionsListed: connector.toolscached === true,
      ...(status === 'active' || status === 'hidden' || status === 'retired' ? { catalogStatus: status } : {}),
    },
    view: toPermissionView(body.permissions),
    waiting: (Array.isArray(body.pending) ? body.pending : []).filter(isPlainObject),
  };
}

// ─── Setting them ──────────────────────────────────────────────────

/** A change as set_agent_connector_permissions takes it: null removes a column's setting. */
export type CellChange = Partial<Record<PermissionColumn, PermissionValue | null>>;

export interface PermissionChanges {
  reset?: boolean;
  categories?: Partial<Record<PermissionCategory, CellChange>>;
  tools?: Record<string, CellChange>;
}

interface StoredState {
  categories: Partial<Record<PermissionCategory, PermissionCells>>;
  tools: Record<string, PermissionCells>;
}

/** What the connection holds now, as far as the view shows it: each group's own setting and each action's own one. */
function storedState(view: PermissionView): StoredState {
  const categories: StoredState['categories'] = {};
  for (const row of view.categories) {
    if (Object.keys(row.chosen).length > 0) categories[row.key] = { ...row.chosen };
  }
  const tools: StoredState['tools'] = {};
  for (const action of view.actions) {
    const cells: PermissionCells = {};
    for (const column of PERMISSION_COLUMNS) if (action.own[column]) cells[column] = action[column];
    if (Object.keys(cells).length > 0) tools[action.name] = cells;
  }
  return { categories, tools };
}

/**
 * The state after a change, applied the way Wiro applies it: reset first (no group or action setting is left), then
 * the groups (setting a group's column also clears that column from the own settings of its actions), then the
 * actions (null removes an own setting).
 */
function applyChanges(view: PermissionView, before: StoredState, changes: PermissionChanges): StoredState {
  const categories: StoredState['categories'] = changes.reset ? {} : structuredClone(before.categories);
  const tools: StoredState['tools'] = changes.reset ? {} : structuredClone(before.tools);
  // An action the connector has not listed counts as Change and delete.
  const groupOf = new Map(view.actions.filter(action => action.listed).map(action => [action.name, action.category]));
  for (const key of PERMISSION_CATEGORIES) {
    const cells = changes.categories?.[key];
    if (!cells) continue;
    const entry: PermissionCells = { ...(categories[key] ?? {}) };
    for (const column of PERMISSION_COLUMNS) {
      if (!(column in cells)) continue;
      const next = cells[column];
      if (next === null || next === undefined) delete entry[column];
      else entry[column] = next;
      for (const name of Object.keys(tools)) {
        if ((groupOf.get(name) ?? 'change') !== key) continue;
        delete tools[name]![column];
        if (Object.keys(tools[name]!).length === 0) delete tools[name];
      }
    }
    if (Object.keys(entry).length > 0) categories[key] = entry;
    else delete categories[key];
  }
  for (const [name, cells] of Object.entries(changes.tools ?? {})) {
    const entry: PermissionCells = { ...(tools[name] ?? {}) };
    for (const column of PERMISSION_COLUMNS) {
      if (!(column in cells)) continue;
      const next = cells[column];
      if (next === null || next === undefined) delete entry[column];
      else entry[column] = next;
    }
    if (Object.keys(entry).length > 0) tools[name] = entry;
    else delete tools[name];
  }
  return { categories, tools };
}

/**
 * Wiro's own default of an action the connector has not listed, in one column, as far as the view tells it: a value
 * that came from it, else a default that differs from Change and delete's.
 */
function catalogDefault(action: ParsedAction, column: PermissionColumn): PermissionValue | undefined {
  if (action.source[column] === 'catalog') return action[column];
  if (action.source[column] === 'unknown') return undefined;
  return action.defaults[column] !== CATEGORY_DEFAULTS.change[column] ? action.defaults[column] : undefined;
}

function unlistedValue(state: StoredState, column: PermissionColumn): PermissionValue {
  return state.categories.change?.[column] ?? CATEGORY_DEFAULTS.change[column];
}

/** An action's value in a column under a state: its own setting, else its group's, else its default. */
function effectiveValue(action: ParsedAction, state: StoredState, column: PermissionColumn): PermissionValue {
  const own = state.tools[action.name]?.[column];
  if (own) return own;
  if (action.listed) return state.categories[action.category]?.[column] ?? action.defaults[column];
  return catalogDefault(action, column) ?? unlistedValue(state, column);
}

export interface CellMove {
  /** The action's title, or null for an action the connector has not listed yet. */
  action: string | null;
  name?: string;
  column: PermissionColumn;
  from: PermissionValue;
  to: PermissionValue;
}

export interface PermissionPlan {
  /** Every value the agent sees that changes, by action and column. */
  moves: CellMove[];
  /** Whether what is saved changes at all. */
  stored: boolean;
  /** Whether saving restarts a running agent: anything but Ask turned into Allow does. */
  restarts: boolean;
  /** Actions that become blocked in both columns, so the agent stops seeing them, and ones it sees again. */
  hides: string[];
  shows: string[];
}

/** What a change does, worked out from the view the way Wiro decides it. */
export function planChanges(view: PermissionView, changes: PermissionChanges): PermissionPlan {
  const before = storedState(view);
  const after = applyChanges(view, before, changes);
  const moves: CellMove[] = [];
  const hides: string[] = [];
  const shows: string[] = [];
  for (const action of view.actions) {
    const values = PERMISSION_COLUMNS.map(column => [action[column], effectiveValue(action, after, column)] as const);
    values.forEach(([from, to], index) => {
      if (from !== to) moves.push({ action: action.title, name: action.name, column: PERMISSION_COLUMNS[index]!, from, to });
    });
    const hiddenAfter = values.every(([, to]) => to === 'block');
    if (hiddenAfter && !action.hidden) hides.push(action.title);
    if (!hiddenAfter && action.hidden) shows.push(action.title);
  }
  for (const column of PERMISSION_COLUMNS) {
    const to = unlistedValue(after, column);
    if (view.unlisted[column] !== to) moves.push({ action: null, column, from: view.unlisted[column], to });
  }
  return {
    moves,
    stored: stableJson(before) !== stableJson(after),
    restarts: moves.some(move => !(move.from === 'ask' && move.to === 'allow')),
    hides,
    shows,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What the view holds, for a change summary's id: a confirm goes ahead only while it is the same. */
export function permissionStateDigest(view: PermissionView): string {
  return stableJson({ state: storedState(view), updatedAt: view.updatedAt ?? null });
}

/** A change request with only what it sets, in a stable order, as the summary id binds it. */
export function normalizedChanges(changes: PermissionChanges): PermissionChanges {
  const out: PermissionChanges = {};
  if (changes.reset === true) out.reset = true;
  const categories: NonNullable<PermissionChanges['categories']> = {};
  for (const key of PERMISSION_CATEGORIES) {
    const cells = changes.categories?.[key];
    if (cells && Object.keys(cells).length > 0) categories[key] = cells;
  }
  if (Object.keys(categories).length > 0) out.categories = categories;
  const names = Object.keys(changes.tools ?? {}).filter(name => Object.keys(changes.tools?.[name] ?? {}).length > 0).sort();
  if (names.length > 0) out.tools = Object.fromEntries(names.map(name => [name, changes.tools![name]!]));
  return out;
}

/** A value in words: "Allow". */
export function valueTitle(valueKey: PermissionValue | null | undefined): string {
  return valueKey ? VALUE_TITLES[valueKey] : 'Mixed';
}

/** One requested cell in words: "Chat Allow", or "Chat back to the group's setting". */
function requestedCell(column: PermissionColumn, next: PermissionValue | null | undefined, ofAction: boolean): string {
  if (next === null || next === undefined) {
    return `${COLUMN_TITLES[column]} back to ${ofAction ? 'its group\'s setting' : 'its default'}`;
  }
  return `${COLUMN_TITLES[column]} ${VALUE_TITLES[next]}`;
}

/** The request in words, one line each, as a change summary lists it. titles names actions by their titles. */
export function requestLines(changes: PermissionChanges, titles: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];
  if (changes.reset) lines.push('- Reset: every group and action goes back to its default first.');
  for (const key of PERMISSION_CATEGORIES) {
    const cells = changes.categories?.[key];
    if (!cells) continue;
    const parts = PERMISSION_COLUMNS.filter(column => column in cells).map(column => requestedCell(column, cells[column], false));
    if (parts.length > 0) {
      lines.push(`- ${CATEGORY_TITLES[key]} (group): ${parts.join(', ')}. Its actions' own settings in ${parts.length === 1 ? 'this column are' : 'these columns are'} cleared.`);
    }
  }
  for (const [name, cells] of Object.entries(changes.tools ?? {})) {
    const parts = PERMISSION_COLUMNS.filter(column => column in cells).map(column => requestedCell(column, cells[column], true));
    if (parts.length > 0) lines.push(`- ${titles.get(name) ?? name} (\`${name}\`): ${parts.join(', ')}.`);
  }
  return lines;
}

/** What changes for the agent, grouped by column and by the move, one line each. */
export function moveLines(moves: readonly CellMove[], limit = 12): string[] {
  const groups = new Map<string, CellMove[]>();
  for (const move of moves) {
    const key = `${move.column}:${move.from}:${move.to}`;
    groups.set(key, [...(groups.get(key) ?? []), move]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const named = group.filter(move => move.action !== null).map(move => move.action as string);
    const unlisted = group.some(move => move.action === null);
    const shown = named.slice(0, limit);
    const more = named.length - shown.length;
    const who = [
      ...(shown.length > 0 ? [`${named.length === 1 ? '1 action' : `${named.length} actions`} (${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''})`] : []),
      ...(unlisted ? ['actions not listed yet'] : []),
    ].join(' and ');
    return `- ${COLUMN_TITLES[first.column]}: ${VALUE_TITLES[first.from]} to ${VALUE_TITLES[first.to]} for ${who}.`;
  });
}
