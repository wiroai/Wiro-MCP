import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { WiroApiError, type WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorText,
  isOutcomeUnknown,
  isPlainObject,
  MODEL_ACCESS_URL,
  requireApiSuccess,
  SPEND_LIMITS_URL,
  toNumber,
  truncate,
  type ApiEnvelope,
} from './api.js';
import { oneLine, quotedSpan } from './quoted-text.js';
import { keySafeErrorText, readProjects } from './wiro-project.js';
import { canonicalStringify } from './workflow-artifacts.js';

// Controls: a workspace's Spend Limits (caps on what it spends in a month or a
// day) and Model Access rules (which models it may run). The four controls
// tools share what is here: reading Wiro's lists, naming a limit's or a rule's
// target, putting a rule in plain words, and turning a refused or failed change
// into a sentence that says what happened. Every field shown is rebuilt from an
// allowlist, and names people wrote stay in code spans.

export const CONTROL_SCOPES = ['account', 'member', 'project', 'surface', 'agent'] as const;
export type ControlScope = typeof CONTROL_SCOPES[number];

export const SURFACES = ['web', 'api', 'mcp', 'llm-gateway', 'extension', 'agent'] as const;
export type Surface = typeof SURFACES[number];

export const PERIODS = ['month', 'day'] as const;
export type Period = typeof PERIODS[number];

export const CATEGORY_KEYS = ['image', 'video', 'audio', 'music', '3d', 'llm', 'utilities'] as const;
export type CategoryKey = typeof CATEGORY_KEYS[number];

export type Access = 'allow' | 'block';

export type CategoryLabels = Record<CategoryKey, string>;

const DEFAULT_CATEGORY_LABELS: CategoryLabels = {
  image: 'Image Generation',
  video: 'Video Generation',
  audio: 'Audio & Speech',
  music: 'Music Generation',
  '3d': '3D Generation',
  llm: 'LLM & Chat',
  utilities: 'Utilities',
};

/** How Wiro names each way in, as its refusals do. */
export const SURFACE_LABELS: Record<Surface, string> = {
  web: 'the dashboard',
  api: 'the API',
  mcp: 'MCP',
  'llm-gateway': 'the LLM gateway',
  extension: 'the browser extensions',
  agent: 'agents',
};

/** What each way in covers. A local install of this server sends its calls with an API key, so it counts as api. */
export const SURFACE_DESCRIPTIONS: Record<Surface, string> = {
  web: 'the Wiro dashboard, with Studio and the Workflow Agent used there',
  api: 'calls with an API key, a local install of this server included',
  mcp: 'the hosted MCP server at mcp.wiro.ai',
  'llm-gateway': 'the OpenAI and Anthropic compatible LLM gateway',
  extension: 'the Wiro browser extensions',
  agent: 'deployed agents\' own runs',
};

/** Wiro's limit on one rule: it can name at most this many models. */
export const MAX_RULE_MODELS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[1-9][0-9]{0,17}$/;
const TEXT_MAX = 200;

export const NOTHING_CHANGED = 'Nothing was changed.';

export function isScope(value: unknown): value is ControlScope {
  return typeof value === 'string' && (CONTROL_SCOPES as readonly string[]).includes(value);
}

export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && (SURFACES as readonly string[]).includes(value);
}

function isPeriod(value: unknown): value is Period {
  return value === 'month' || value === 'day';
}

export function isCategory(value: unknown): value is CategoryKey {
  return typeof value === 'string' && (CATEGORY_KEYS as readonly string[]).includes(value);
}

function isAccess(value: unknown): value is Access {
  return value === 'allow' || value === 'block';
}

function textValue(value: unknown, max = TEXT_MAX): string | undefined {
  const text = asString(value);
  return text?.trim() ? truncate(oneLine(text), max) : undefined;
}

function unixValue(value: unknown): number | undefined {
  const seconds = toNumber(value);
  return seconds !== null && seconds > 0 ? Math.trunc(seconds) : undefined;
}

export function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** An amount in USD with cents, such as $248.70. */
export function usd(value: number): string {
  return `$${cents(value).toFixed(2)}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A time in plain words, in UTC, as Wiro's refusals give it: "December 1, 2026 at 00:00 UTC". */
export function utcText(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} at `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function isoTime(unixSeconds: number | undefined): string | undefined {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z') : undefined;
}

// ---------------------------------------------------------------- workspace

export interface ControlsWorkspace {
  kind: 'personal' | 'team' | 'unknown';
  teamGuid?: string;
  /** Whether Wiro would take a change from this connection; undefined when its answer did not say. */
  canManage?: boolean;
}

/** How Wiro counts calls through this connection: the surface, the API key's project and, in a team, the member. */
export interface Caller {
  surface?: Surface;
  projectId?: string;
  /** In a team, the user id of the person this connection acts as: the creator of its key's project. */
  memberUuid?: string;
}

function toWorkspace(value: unknown): ControlsWorkspace {
  if (!isPlainObject(value)) return { kind: 'unknown' };
  const kind = value.type === 'team' ? 'team' : value.type === 'personal' ? 'personal' : 'unknown';
  const teamGuid = textValue(value.teamguid, 64);
  return {
    kind,
    ...(kind === 'team' && teamGuid ? { teamGuid } : {}),
    ...(typeof value.canmanage === 'boolean' ? { canManage: value.canmanage } : {}),
  };
}

function toCaller(value: unknown): Caller | undefined {
  if (!isPlainObject(value)) return undefined;
  const projectId = asString(value.projectid)?.trim();
  return {
    ...(isSurface(value.surface) ? { surface: value.surface } : {}),
    ...(projectId && PROJECT_ID.test(projectId) ? { projectId } : {}),
  };
}

// ------------------------------------------------------------- changed by

/** Who changed a limit or a rule last, as Wiro names them. */
export interface ChangedBy {
  useruuid: string;
  /** Their name or e-mail, or "the organization owner"; absent for someone who is no longer in the team. */
  name?: string;
}

/** Wiro's label for an organization's owner who is not a member of the team. */
const ORGANIZATION_OWNER = /^the organization owner$/i;

export const changedBySchema = z.object({
  useruuid: z.string(),
  name: z.string().optional().describe('Their name or e-mail, or "the organization owner"; absent for someone who is no longer in the team.'),
}).describe('Who changed it last. Absent when Wiro did not say, or when a change Wiro made itself was the last.');

/** A row's updatedby: { useruuid, label } of a person, or null for a change Wiro made itself. */
function toChangedBy(value: unknown): ChangedBy | undefined {
  if (!isPlainObject(value)) return undefined;
  const useruuid = textValue(value.useruuid, 64);
  if (!useruuid || !UUID.test(useruuid)) return undefined;
  const name = textValue(value.label);
  return { useruuid, ...(name ? { name } : {}) };
}

/**
 * "last changed by `Jane Doe` on November 18, 2026 at 14:02 UTC", or undefined when Wiro did not say who. A name
 * people wrote stays in a code span; Wiro's own label for the organization's owner reads as words.
 */
export function changedByText(
  row: { updatedBy?: ChangedBy; updatedAt?: number; createdAt?: number },
  kind: ControlsWorkspace['kind'],
  caller: Caller | undefined,
): string | undefined {
  const by = row.updatedBy;
  if (!by) return undefined;
  const name = by.name
    ? ORGANIZATION_OWNER.test(by.name) ? 'the organization\'s owner' : quotedSpan(by.name)
    : kind === 'team' ? `a former team member (user id ${quotedSpan(by.useruuid)})` : `user id ${quotedSpan(by.useruuid)}`;
  const at = row.updatedAt ?? row.createdAt;
  const self = isThisConnection('member', by.useruuid, caller) ? `, the person this connection acts as${at ? ',' : ''}` : '';
  return `last changed by ${name}${self}${at ? ` on ${utcText(at)}` : ''}`;
}

/** The parenthesis a list line ends with: a guid and who changed the row last, each when known. */
function lineTrailer(...parts: Array<string | undefined>): string {
  const known = parts.filter((part): part is string => Boolean(part));
  return known.length > 0 ? ` (${known.join('; ')})` : '';
}

/** Who may change controls, for a sentence after a refusal or in a read. */
export function whoCanChange(kind: ControlsWorkspace['kind']): string {
  return kind === 'personal' ? 'the account owner' : 'a team admin or the organization\'s owner';
}

/** The whole wallet's name, by the kind of workspace. */
export function wholeWallet(kind: ControlsWorkspace['kind']): string {
  return kind === 'team' ? 'the whole team' : kind === 'personal' ? 'the whole account' : 'the whole wallet';
}

// ------------------------------------------------------------------- limits

export interface LimitRow {
  guid?: string;
  scope: ControlScope;
  /** '' for the whole wallet. */
  target: string;
  targetName?: string;
  period: Period;
  amountUsd: number;
  spentUsd: number;
  /** What work that is still running holds against the limit. */
  heldUsd?: number;
  alertPercent: number | null;
  periodStart?: number;
  resetsAt?: number;
  createdAt?: number;
  updatedAt?: number;
  updatedBy?: ChangedBy;
}

/** A limit row of SpendLimit/List, /Preview or /Set, rebuilt from an allowlist. */
export function toLimitRow(row: Record<string, unknown>): LimitRow | null {
  const scope = row.scope;
  const period = row.period;
  const amountUsd = toNumber(row.amountusd);
  if (!isScope(scope) || !isPeriod(period) || amountUsd === null) return null;
  const guid = textValue(row.guid, 64);
  const target = scope === 'account' ? '' : textValue(row.target) ?? '';
  const targetName = textValue(row.targetlabel);
  const held = toNumber(row.heldusd);
  const alert = toNumber(row.alertpct);
  const periodStart = unixValue(row.periodstart);
  const resetsAt = unixValue(row.resetsat);
  const createdAt = unixValue(row.createdat);
  const updatedAt = unixValue(row.updatedat);
  const updatedBy = toChangedBy(row.updatedby);
  return {
    ...(guid ? { guid } : {}),
    scope,
    target,
    ...(targetName ? { targetName } : {}),
    period,
    amountUsd: cents(amountUsd),
    spentUsd: cents(Math.max(0, toNumber(row.spentusd) ?? 0)),
    ...(held !== null && held > 0 ? { heldUsd: cents(held) } : {}),
    alertPercent: alert === null || alert <= 0 ? null : Math.trunc(alert),
    ...(periodStart ? { periodStart } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

/** What is left for new work: the amount less what was spent and what running work holds. */
export function leftOf(row: LimitRow): number {
  return Math.max(0, cents(row.amountUsd - row.spentUsd - (row.heldUsd ?? 0)));
}

export function isUsedUp(row: Pick<LimitRow, 'amountUsd' | 'spentUsd'>): boolean {
  return row.spentUsd >= row.amountUsd;
}

/**
 * A row's version, as a change summary records it: its last change, 0 when there is no row. A
 * confirmed change goes ahead only while the row still has the version the user saw.
 */
export function versionOf(row: { updatedAt?: number; createdAt?: number } | null | undefined): number {
  return row ? row.updatedAt ?? row.createdAt ?? 1 : 0;
}

// ------------------------------------------------------------- confirming

/** What a confirm repeats from a change summary's nextAction. */
export interface ConfirmArgs {
  confirm: boolean;
  updated_at?: number;
  summary_id?: string;
}

/**
 * Where a call stands: a summary to show, or a confirm. A confirm writes only when it repeats the summary of this
 * very change, made from the row's current version.
 *   summary     no confirm: show the change summary.
 *   changed     the row changed after the summary the user saw.
 *   no-summary  confirm without the summary's updated_at and summary_id.
 *   differs     confirm of another change than the summary it repeats.
 *   confirmed   write.
 */
export type ConfirmState = 'summary' | 'changed' | 'no-summary' | 'differs' | 'confirmed';

export function confirmState(args: ConfirmArgs, version: number, id: string): ConfirmState {
  if (!args.confirm) return 'summary';
  if (args.updated_at === undefined || args.summary_id === undefined) return 'no-summary';
  if (args.updated_at !== version) return 'changed';
  return args.summary_id === id ? 'confirmed' : 'differs';
}

/**
 * The id of a change summary: a digest of the exact change it shows and the version of the row it was made from,
 * keyed by this connection's API key. It cannot be made up without the key, and every server of one deployment
 * gives the same id for the same change.
 */
export function summaryId(client: WiroClient, change: Record<string, unknown>): string {
  const identity = (client as { identity?: unknown }).identity;
  return createHmac('sha256', `wiro-mcp-controls:${typeof identity === 'string' ? identity : ''}`)
    .update(canonicalStringify(change))
    .digest('hex')
    .slice(0, 32);
}

/** The sentence a summary opens with when a confirm did not write, by why it did not. */
export function confirmLead(state: ConfirmState, what: 'limit' | 'rule'): string | null {
  switch (state) {
    case 'changed':
      return `The ${what} changed after the summary you showed, so nothing was saved. Show this summary and ask the user again.`;
    case 'no-summary':
      return 'This call did not repeat a change summary\'s nextAction, so nothing was saved. Show this summary and ask the user.';
    case 'differs':
      return 'This call asks for something other than the summary it repeats, so nothing was saved. Show this summary and ask the user.';
    default:
      return null;
  }
}

export const summaryIdSchema = z.string().trim().min(1).max(64).optional()
  .describe('From the change summary\'s nextAction: the id of the change the user saw. Never set it yourself.');

export function periodWord(period: Period): string {
  return period === 'day' ? 'daily' : 'monthly';
}

/** The label of a period's spending so far: "Today so far" or "This month so far". */
export function soFarLabel(period: Period): string {
  return period === 'day' ? 'Today so far' : 'This month so far';
}

/** A phrase of this server's text at the start of a sentence. */
export function capitalized(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/** "$500.00 a month". */
export function amountPerPeriod(amountUsd: number, period: Period): string {
  return `${usd(amountUsd)} a ${period}`;
}

export function alertText(alertPercent: number | null): string {
  return alertPercent === null ? 'no alert email' : `alert email at ${alertPercent}%`;
}

/** When a period ends, or the time a row gives. */
export function resetText(row: Pick<LimitRow, 'period' | 'resetsAt'>): string {
  if (row.resetsAt) return `resets ${utcText(row.resetsAt)}`;
  return row.period === 'day' ? 'resets every day at 00:00 UTC' : 'resets on the 1st at 00:00 UTC';
}

export interface TargetView {
  scope: ControlScope;
  target?: string;
  targetName?: string;
  /** This connection's own API key, the surface this connection counts as, or in a team the member it acts as. */
  thisConnection?: boolean;
}

export function isThisConnection(scope: ControlScope, target: string, caller: Caller | undefined): boolean {
  if (!caller) return false;
  if (scope === 'project') return caller.projectId !== undefined && caller.projectId === target;
  if (scope === 'surface') return caller.surface !== undefined && caller.surface === target;
  if (scope === 'member') return caller.memberUuid !== undefined && caller.memberUuid.toLowerCase() === target.toLowerCase();
  return false;
}

/** What a limit or a rule covers, as one phrase of this server's own text. */
export function targetText(view: TargetView, kind: ControlsWorkspace['kind']): string {
  const id = view.target ?? '';
  const name = view.targetName;
  let text: string;
  switch (view.scope) {
    case 'account':
      text = wholeWallet(kind);
      break;
    case 'member':
      text = name ? `team member ${quotedSpan(name)} (user id ${quotedSpan(id)})` : `the team member with user id ${quotedSpan(id)}`;
      break;
    case 'project':
      text = name ? `the API key of project ${quotedSpan(name)} (id ${quotedSpan(id)})` : `the API key of project id ${quotedSpan(id)}`;
      break;
    case 'surface':
      text = isSurface(id) ? `${SURFACE_LABELS[id]} (surface \`${id}\`)` : `surface ${quotedSpan(id)}`;
      break;
    case 'agent':
      text = name ? `agent ${quotedSpan(name)} (guid ${quotedSpan(id)})` : `the agent with guid ${quotedSpan(id)}`;
      break;
  }
  if (!view.thisConnection) return text;
  if (view.scope === 'project') return `${text}, the key this connection uses`;
  if (view.scope === 'member') return `${text}, the person this connection acts as`;
  return `${text}, the way in this connection counts as`;
}

/** The argument that names a scope's target in the manage tools, or none for the whole wallet. */
export function targetArgument(scope: ControlScope, target: string): Record<string, string> {
  return scope === 'account' ? {} : { [scope]: target };
}

export const limitViewSchema = z.object({
  guid: z.string().optional(),
  scope: z.enum(CONTROL_SCOPES).describe('What the limit caps: the whole wallet (account), one team member, one API key (project), one way in (surface) or one agent.'),
  target: z.string().optional().describe('The member\'s user id, the project id, the surface or the agent guid; absent for the whole wallet.'),
  targetName: z.string().optional(),
  thisConnection: z.boolean().optional().describe('True for the API key this connection uses, the surface it counts as, or in a team the member it acts as.'),
  period: z.enum(PERIODS).describe('A monthly limit runs from the 1st at 00:00 UTC, a daily one from 00:00 UTC.'),
  amountUsd: z.number(),
  spentUsd: z.number().describe('Spent in the current period, including what was spent before the limit was set.'),
  heldUsd: z.number().optional().describe('Held by work that is still running, until it is charged or ends.'),
  leftUsd: z.number().describe('What new work can still use: the amount less what was spent and what is held.'),
  usedUp: z.boolean().describe('True when what was spent reached the amount: new work it covers is refused with error code 93.'),
  alertPercent: z.number().int().nullable().describe('The alert email goes out at this percent of the amount; null for none.'),
  periodStart: z.string().optional(),
  resetsAt: z.string().optional(),
  updatedAt: z.number().int().optional().describe('When the limit last changed, in Unix seconds.'),
  updatedBy: changedBySchema.optional(),
});

export type LimitView = z.infer<typeof limitViewSchema>;

export function limitView(row: LimitRow, caller: Caller | undefined): LimitView {
  const periodStart = isoTime(row.periodStart);
  const resetsAt = isoTime(row.resetsAt);
  const version = row.updatedAt ?? row.createdAt;
  return {
    ...(row.guid ? { guid: row.guid } : {}),
    scope: row.scope,
    ...(row.scope !== 'account' ? { target: row.target } : {}),
    ...(row.targetName ? { targetName: row.targetName } : {}),
    ...(isThisConnection(row.scope, row.target, caller) ? { thisConnection: true } : {}),
    period: row.period,
    amountUsd: row.amountUsd,
    spentUsd: row.spentUsd,
    ...(row.heldUsd ? { heldUsd: row.heldUsd } : {}),
    leftUsd: leftOf(row),
    usedUp: isUsedUp(row),
    alertPercent: row.alertPercent,
    ...(periodStart ? { periodStart } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(version ? { updatedAt: version } : {}),
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
  };
}

/** "$248.70 of $500.00 used, $20.00 held by work still running, $231.30 left". */
export function spendingText(row: LimitRow): string {
  const held = row.heldUsd ? `, ${usd(row.heldUsd)} held by work still running` : '';
  if (isUsedUp(row)) return `${usd(row.spentUsd)} of ${usd(row.amountUsd)} used${held}: used up, so new work it covers is refused until it resets`;
  const left = leftOf(row);
  const state = left === 0 ? `, nothing left until running work ends` : `, ${usd(left)} left`;
  return `${usd(row.spentUsd)} of ${usd(row.amountUsd)} used${held}${state}`;
}

/** One line of a limit list. */
export function limitLine(row: LimitRow, kind: ControlsWorkspace['kind'], caller: Caller | undefined): string {
  const view = { scope: row.scope, target: row.target, targetName: row.targetName, thisConnection: isThisConnection(row.scope, row.target, caller) };
  const period = row.period === 'day' ? 'Daily' : 'Monthly';
  const trailer = lineTrailer(row.guid ? `limit_guid ${quotedSpan(row.guid)}` : undefined, changedByText(row, kind, caller));
  return `- ${period} limit for ${targetText(view, kind)}: ${spendingText(row)}, ${alertText(row.alertPercent)}, ${resetText(row)}${trailer}`;
}

// -------------------------------------------------------------------- rules

export interface RuleModelEntry {
  id: string;
  /** The model's owner/slug; null when it is no longer on Wiro. */
  model: string | null;
  title?: string;
  access: Access;
}

export interface RuleRow {
  guid?: string;
  scope: ControlScope;
  target: string;
  targetName?: string;
  /** What every model the rule names neither by category nor by name gets ("everything else"). */
  access: Access;
  categories: Partial<Record<CategoryKey, Access>>;
  models: RuleModelEntry[];
  createdAt?: number;
  updatedAt?: number;
  updatedBy?: ChangedBy;
}

/** A rule row of ModelAccess/List, /Preview, /Set or /Check, rebuilt from an allowlist. */
export function toRuleRow(row: Record<string, unknown>): RuleRow | null {
  const scope = row.scope;
  if (!isScope(scope)) return null;
  const guid = textValue(row.guid, 64);
  const target = scope === 'account' ? '' : textValue(row.target) ?? '';
  const targetName = textValue(row.targetlabel);
  const categories: Partial<Record<CategoryKey, Access>> = {};
  const entries = Array.isArray(row.categories)
    ? row.categories.filter(isPlainObject).map(entry => [entry.category, entry.access] as const)
    : isPlainObject(row.categories) ? Object.entries(row.categories) : [];
  for (const [category, access] of entries) {
    if (isCategory(category) && isAccess(access)) categories[category] = access;
  }
  const models = (Array.isArray(row.models) ? row.models : []).filter(isPlainObject).flatMap(entry => {
    const id = asString(entry.id)?.trim();
    if (!id || !/^\d{1,19}$/.test(id) || !isAccess(entry.access)) return [];
    const model = textValue(entry.model);
    const title = textValue(entry.title);
    return [{ id, model: model ?? null, ...(title ? { title } : {}), access: entry.access }];
  });
  const createdAt = unixValue(row.createdat);
  const updatedAt = unixValue(row.updatedat);
  const updatedBy = toChangedBy(row.updatedby);
  return {
    ...(guid ? { guid } : {}),
    scope,
    target,
    ...(targetName ? { targetName } : {}),
    access: row.access === 'block' ? 'block' : 'allow',
    categories,
    models,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

/** The category labels a ModelAccess/List answer gives, over the built-in ones. */
export function toCategoryLabels(value: unknown): CategoryLabels {
  const labels = { ...DEFAULT_CATEGORY_LABELS };
  if (!Array.isArray(value)) return labels;
  for (const entry of value.filter(isPlainObject)) {
    const label = textValue(entry.label, 80);
    if (isCategory(entry.category) && label) labels[entry.category] = label;
  }
  return labels;
}

export function categoryList(labels: CategoryLabels): Array<{ category: CategoryKey; label: string }> {
  return CATEGORY_KEYS.map(category => ({ category, label: labels[category] }));
}

/** A model of a rule by its owner/slug, or by its id when it is no longer on Wiro. */
export function entryName(entry: Pick<RuleModelEntry, 'id' | 'model'>, quote: boolean): string {
  if (entry.model === null) return `model ${entry.id}, no longer on Wiro`;
  return quote ? quotedSpan(entry.model) : entry.model;
}

function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function namesText(categoryNames: string[], models: RuleModelEntry[], quote: boolean, maxModels: number): string {
  const shown = models.slice(0, maxModels).map(entry => entryName(entry, quote));
  const more = models.length - shown.length;
  return listText([...categoryNames, ...shown, ...(more > 0 ? [`${more} more ${more === 1 ? 'model' : 'models'}`] : [])]);
}

/**
 * A rule in plain words: "Every model except Video Generation; bytedance/seedance-v2-5-flash allowed by name" or
 * "Only Image Generation and openai/gpt-6-2-astra". In a rule that allows every other model an allowed category
 * decides nothing (a block among a model's categories wins), so it is left out.
 */
export function ruleSummary(rule: RuleRow, labels: CategoryLabels, options: { quote?: boolean; maxModels?: number } = {}): string {
  const quote = options.quote ?? false;
  const maxModels = options.maxModels ?? Infinity;
  const categories = (access: Access) => CATEGORY_KEYS.filter(key => rule.categories[key] === access).map(key => labels[key]);
  const models = (access: Access) => rule.models.filter(entry => entry.access === access);
  if (rule.access === 'allow') {
    const blockedCategories = categories('block');
    const blockedModels = models('block');
    if (blockedCategories.length === 0 && blockedModels.length === 0) return 'Every model: this rule blocks nothing';
    const allowedModels = models('allow');
    const byName = allowedModels.length > 0 ? `; ${namesText([], allowedModels, quote, maxModels)} allowed by name` : '';
    return `Every model except ${namesText(blockedCategories, blockedModels, quote, maxModels)}${byName}`;
  }
  const allowedCategories = categories('allow');
  const allowedModels = models('allow');
  if (allowedCategories.length === 0 && allowedModels.length === 0) return 'No model: this rule blocks every model';
  const blockedCategories = categories('block');
  const blockedModels = models('block');
  const except = blockedCategories.length > 0 || blockedModels.length > 0
    ? `, except ${namesText(blockedCategories, blockedModels, quote, maxModels)}`
    : '';
  return `Only ${namesText(allowedCategories, allowedModels, quote, maxModels)}${except}`;
}

/** Whether a rule blocks anything at all. One that does not changes no decision. */
export function blocksSomething(rule: { access: Access; categories: RuleRow['categories']; models: Array<{ access: Access }> }): boolean {
  return rule.access === 'block'
    || Object.values(rule.categories).includes('block')
    || rule.models.some(entry => entry.access === 'block');
}

export const ruleViewSchema = z.object({
  guid: z.string().optional(),
  scope: z.enum(CONTROL_SCOPES).describe('Whose runs the rule covers: the whole wallet (account), one team member, one API key (project), one way in (surface) or one agent.'),
  target: z.string().optional().describe('The member\'s user id, the project id, the surface or the agent guid; absent for the whole wallet.'),
  targetName: z.string().optional(),
  thisConnection: z.boolean().optional().describe('True for the API key this connection uses, the surface it counts as, or in a team the member it acts as.'),
  everythingElse: z.enum(['allow', 'block']).describe('What a model the rule names neither by category nor by name gets.'),
  categories: z.array(z.object({
    category: z.enum(CATEGORY_KEYS),
    label: z.string(),
    access: z.enum(['allow', 'block']),
  })),
  models: z.array(z.object({
    id: z.string(),
    model: z.string().nullable().describe('The owner/slug; null for a model that is no longer on Wiro.'),
    title: z.string().optional(),
    access: z.enum(['allow', 'block']),
  })),
  summary: z.string().describe('The rule in plain words.'),
  updatedAt: z.number().int().optional().describe('When the rule last changed, in Unix seconds.'),
  updatedBy: changedBySchema.optional(),
});

export type RuleView = z.infer<typeof ruleViewSchema>;

export function ruleView(rule: RuleRow, labels: CategoryLabels, caller: Caller | undefined): RuleView {
  const version = rule.updatedAt ?? rule.createdAt;
  return {
    ...(rule.guid ? { guid: rule.guid } : {}),
    scope: rule.scope,
    ...(rule.scope !== 'account' ? { target: rule.target } : {}),
    ...(rule.targetName ? { targetName: rule.targetName } : {}),
    ...(isThisConnection(rule.scope, rule.target, caller) ? { thisConnection: true } : {}),
    everythingElse: rule.access,
    categories: CATEGORY_KEYS.flatMap(category => {
      const access = rule.categories[category];
      return access ? [{ category, label: labels[category], access }] : [];
    }),
    models: rule.models.map(entry => ({ id: entry.id, model: entry.model, ...(entry.title ? { title: entry.title } : {}), access: entry.access })),
    summary: ruleSummary(rule, labels),
    ...(version ? { updatedAt: version } : {}),
    ...(rule.updatedBy ? { updatedBy: rule.updatedBy } : {}),
  };
}

/** One line of a rule list: at most ten models are named in the text. */
export function ruleLine(rule: RuleRow, labels: CategoryLabels, kind: ControlsWorkspace['kind'], caller: Caller | undefined): string {
  const view = { scope: rule.scope, target: rule.target, targetName: rule.targetName, thisConnection: isThisConnection(rule.scope, rule.target, caller) };
  const trailer = lineTrailer(rule.guid ? `rule_guid ${quotedSpan(rule.guid)}` : undefined, changedByText(rule, kind, caller));
  return `- Rule for ${targetText(view, kind)}: ${ruleSummary(rule, labels, { quote: true, maxModels: 10 })}${trailer}`;
}

// ------------------------------------------------------------------ checks

export type Decision = 'allow' | 'block';
export type DecidedBy = 'model' | 'category' | 'default';

/** How one rule decides a model for a run, as ModelAccess/Check explains it. */
export interface RuleDecision {
  rule: RuleRow;
  decides: Decision;
  by: DecidedBy;
  category: string | null;
}

/** The rules of a ModelAccess/Check answer that apply to the run, widest first, each with its decision. */
export function toRuleDecisions(value: unknown): RuleDecision[] {
  return (Array.isArray(value) ? value.filter(isPlainObject) : []).flatMap(entry => {
    const rule = isPlainObject(entry.rule) ? toRuleRow(entry.rule) : null;
    if (!rule) return [];
    const decides: Decision = entry.access === 'block' ? 'block' : 'allow';
    const by: DecidedBy = entry.by === 'model' || entry.by === 'category' ? entry.by : 'default';
    const category = asString(entry.category) ?? null;
    return [{ rule, decides, by, category }];
  });
}

/** The run a ModelAccess/Check answer says it checked. A key acts as its creator, so in a team that is the member. */
export interface CheckedRun {
  surface: Surface;
  member?: { uuid: string; name?: string };
  project?: { id: string; name?: string };
  agent?: { guid: string; name?: string };
}

/** check.context of a ModelAccess/Check answer; undefined when the answer has none (an older Wiro API). */
export function toCheckedRun(value: unknown): CheckedRun | undefined {
  if (!isPlainObject(value) || !isSurface(value.surface)) return undefined;
  const member = isPlainObject(value.member) ? value.member : null;
  const project = isPlainObject(value.project) ? value.project : null;
  const agent = isPlainObject(value.agent) ? value.agent : null;
  const memberUuid = member ? textValue(member.useruuid, 64) : undefined;
  const projectId = project ? asString(project.projectid)?.trim() : undefined;
  const agentGuid = agent ? textValue(agent.useragentguid, 64) : undefined;
  const label = (entry: Record<string, unknown> | null) => (entry ? textValue(entry.label) : undefined);
  return {
    surface: value.surface,
    ...(memberUuid && UUID.test(memberUuid) ? { member: { uuid: memberUuid, ...(label(member) ? { name: label(member) } : {}) } } : {}),
    ...(projectId && PROJECT_ID.test(projectId) ? { project: { id: projectId, ...(label(project) ? { name: label(project) } : {}) } } : {}),
    ...(agentGuid && UUID.test(agentGuid) ? { agent: { guid: agentGuid, ...(label(agent) ? { name: label(agent) } : {}) } } : {}),
  };
}

/** Why one rule decides the model as it does, as the end of a sentence about that rule. */
export function decisionReason(decision: Pick<RuleDecision, 'decides' | 'by' | 'category'>, labels: CategoryLabels): string {
  const label = decision.category && isCategory(decision.category) ? labels[decision.category] : decision.category;
  if (decision.by === 'model') return decision.decides === 'block' ? 'blocks this model by name' : 'allows this model by name';
  if (decision.by === 'category') {
    return decision.decides === 'block'
      ? `blocks ${label}, and this model is in it`
      : `allows ${label}, and this model is in it`;
  }
  return decision.decides === 'block'
    ? 'lets only the models it names run, and this model is not one of them'
    : 'does not name this model, and allows every model it does not name';
}

// -------------------------------------------------------------------- lists

export interface LimitList {
  workspace: ControlsWorkspace;
  caller?: Caller;
  limits: LimitRow[];
}

export interface RuleList {
  workspace: ControlsWorkspace;
  caller?: Caller;
  rules: RuleRow[];
  labels: CategoryLabels;
}

type ListBody = ApiEnvelope & { workspace?: unknown; caller?: unknown };

function rowsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/** The workspace's spend limits with this period's spending. Throws when they cannot be read. */
export async function readLimitList(client: WiroClient, signal?: AbortSignal): Promise<LimitList> {
  const body = requireApiSuccess(
    await client.post<ListBody & { limits?: unknown }>('/SpendLimit/List', {}, signal),
    'The spend limits could not be read.',
  );
  const caller = toCaller(body.caller);
  return {
    workspace: toWorkspace(body.workspace),
    ...(caller ? { caller } : {}),
    limits: rowsOf(body.limits).map(toLimitRow).filter((row): row is LimitRow => row !== null),
  };
}

/** The workspace's Model Access rules and the categories a rule can name. Throws when they cannot be read. */
export async function readRuleList(client: WiroClient, signal?: AbortSignal): Promise<RuleList> {
  const body = requireApiSuccess(
    await client.post<ListBody & { rules?: unknown; categories?: unknown }>('/ModelAccess/List', {}, signal),
    'The Model Access rules could not be read.',
  );
  const caller = toCaller(body.caller);
  return {
    workspace: toWorkspace(body.workspace),
    ...(caller ? { caller } : {}),
    rules: rowsOf(body.rules).map(toRuleRow).filter((row): row is RuleRow => row !== null),
    labels: toCategoryLabels(body.categories),
  };
}

// ------------------------------------------------------------------ targets

export interface TargetArgs {
  scope?: ControlScope;
  member?: string;
  project?: string;
  surface?: Surface;
  agent?: string;
}

export interface ResolvedTarget {
  scope: ControlScope;
  /** '' for the whole wallet. */
  target: string;
  targetName?: string;
  thisConnection: boolean;
}

const TARGET_FIELDS = ['member', 'project', 'surface', 'agent'] as const;

/** Checks before any call that the target arguments fit the scope. Throws a sentence. */
export function checkTargetArguments(args: TargetArgs): void {
  if (!args.scope) {
    const given = TARGET_FIELDS.filter(field => args[field] !== undefined);
    if (given.length > 0) throw new Error(`\`${given[0]}\` names a target, so \`scope\` must say what it is: ${given[0]}.`);
    return;
  }
  for (const field of TARGET_FIELDS) {
    if (args[field] === undefined || field === args.scope) continue;
    if (args.scope === 'account') {
      throw new Error(`Scope account covers the whole wallet and takes no \`${field}\`. For one ${field}, use scope ${field}.`);
    }
    throw new Error(`\`${field}\` goes with scope ${field}, and this call has scope ${args.scope}: name its target with \`${args.scope}\`.`);
  }
  if (args.scope === 'member' && !args.member?.trim()) {
    throw new Error('Scope member needs `member`: the team member\'s e-mail or user id.');
  }
  if (args.scope === 'surface' && !args.surface) {
    throw new Error(`Scope surface needs \`surface\`: one of ${SURFACES.join(', ')}.`);
  }
  if (args.scope === 'agent' && !args.agent?.trim()) {
    throw new Error('Scope agent needs `agent`: the agent\'s name or guid, as list_my_agents shows them.');
  }
}

// Studio and the Workflow Agent are shared by every Wiro user, so no workspace has them as an agent of its own.
const HOUSE_AGENTS = /^(wiro[ -]?)?(studio|workflow[ -]?agent)$/i;

const HOUSE_AGENT_TEXT = 'Studio and the Workflow Agent are not agents of this workspace, so no limit or rule names them. '
  + 'The models they run for a person are checked like that person\'s own runs, against the controls of the whole '
  + 'wallet, the member, the API key the message came with and the surface it came in on. Use one of those scopes instead.';

interface ProjectChoice {
  id: string;
  name?: string;
  connected: boolean;
}

/** This connection's own project: the one Wiro says the calls come with, or the listed project with its key. */
async function connectionProject(client: WiroClient, caller: Caller | undefined, signal?: AbortSignal): Promise<ProjectChoice> {
  if (caller?.projectId) return { id: caller.projectId, connected: true };
  let projects;
  try {
    projects = await readProjects(client, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`The projects could not be read: ${keySafeErrorText(error)} Name the key's project with \`project\`.`);
  }
  const own = projects.find(project => project.view.connected);
  if (!own) throw new Error('This connection\'s project is not among the projects Wiro lists. Name the key\'s project with `project`.');
  return { id: own.view.id, ...(own.view.name ? { name: own.view.name } : {}), connected: true };
}

async function projectByName(client: WiroClient, name: string, caller: Caller | undefined, signal?: AbortSignal): Promise<ProjectChoice> {
  let projects;
  try {
    projects = await readProjects(client, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`The projects could not be read: ${keySafeErrorText(error)} Name the project by its id instead.`);
  }
  const wanted = oneLine(name);
  const exact = projects.filter(project => oneLine(project.view.name) === wanted);
  const found = exact.length > 0 ? exact : projects.filter(project => oneLine(project.view.name).toLowerCase() === wanted.toLowerCase());
  if (found.length === 0) {
    throw new Error(`No project named ${quotedSpan(wanted)} is among this workspace's newest 100 projects. Name it by its id, `
      + 'as the Projects page of the Wiro dashboard shows it.');
  }
  if (found.length > 1) {
    throw new Error(`${found.length} projects are named ${quotedSpan(wanted)}: ids ${found.map(project => quotedSpan(project.view.id)).join(', ')}. `
      + 'Name the one you mean by its id.');
  }
  const project = found[0];
  return {
    id: project.view.id,
    ...(project.view.name ? { name: project.view.name } : {}),
    connected: project.view.connected || caller?.projectId === project.view.id,
  };
}

/** A project named by its id or its exact name; left out, this connection's own. */
export async function resolveProject(client: WiroClient, value: string | undefined, caller: Caller | undefined, signal?: AbortSignal): Promise<ProjectChoice> {
  const text = value?.trim();
  if (!text) return connectionProject(client, caller, signal);
  if (PROJECT_ID.test(text)) return { id: text, connected: caller?.projectId === text };
  return projectByName(client, text, caller, signal);
}

interface MemberChoice {
  uuid: string;
  name?: string;
}

interface MemberListBody extends ApiEnvelope {
  member?: unknown;
}

export interface TeamMember {
  uuid: string;
  name?: string;
  email?: string;
  role?: 'admin' | 'member';
}

/** The active members of a team, in Wiro's order. Throws when they cannot be read. */
export async function readTeamMembers(client: WiroClient, teamGuid: string, signal?: AbortSignal): Promise<TeamMember[]> {
  const body = requireApiSuccess(
    await client.post<MemberListBody>('/Team/Member/List', { teamguid: teamGuid }, signal),
    'The team\'s members could not be read.',
  );
  return rowsOf(body.member).flatMap(row => {
    const uuid = asString(row.useruuid)?.trim();
    if (!uuid || row.status !== 'active') return [];
    const user = isPlainObject(row.user) ? row.user : {};
    const fullName = [asString(user.firstname), asString(user.lastname)].filter(part => part?.trim()).join(' ');
    const name = textValue(fullName);
    const email = textValue(user.email);
    const role = row.role === 'admin' || row.role === 'member' ? row.role : undefined;
    return [{ uuid, ...(name ? { name } : {}), ...(email ? { email } : {}), ...(role ? { role } : {}) }];
  });
}

/** A team member named by e-mail or user id. Only an e-mail needs the team's member list. */
export async function resolveMember(client: WiroClient, value: string, workspace: ControlsWorkspace, signal?: AbortSignal): Promise<MemberChoice> {
  if (workspace.kind === 'personal') {
    throw new Error('Member limits and rules exist only in a team workspace, and the connected project is personal.');
  }
  const text = value.trim();
  if (UUID.test(text)) return { uuid: text };
  if (!text.includes('@')) throw new Error('`member` takes the team member\'s e-mail or user id.');
  if (!workspace.teamGuid) throw new Error('The team of this connection is not known, so a member cannot be found by e-mail. Name the member by user id.');
  let members: TeamMember[];
  try {
    members = await readTeamMembers(client, workspace.teamGuid, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`The team's members could not be read: ${keySafeErrorText(error)} Name the member by user id instead.`);
  }
  const found = members.filter(member => member.email?.toLowerCase() === text.toLowerCase());
  if (found.length === 0) {
    throw new Error(`No active member of this team has the e-mail ${quotedSpan(text)}. get_controls with members true lists the team's members.`);
  }
  return { uuid: found[0].uuid, ...(found[0].name ? { name: found[0].name } : { name: text }) };
}

interface AgentChoice {
  guid: string;
  name?: string;
}

const AGENT_PAGE = 50;
const AGENT_PAGES = 4;

/** An agent of this workspace named by its guid or its exact name. */
export async function resolveAgent(client: WiroClient, value: string, signal?: AbortSignal): Promise<AgentChoice> {
  const text = oneLine(value);
  if (UUID.test(text)) return { guid: text };
  const rows: Array<Record<string, unknown>> = [];
  try {
    for (let page = 0; page < AGENT_PAGES; page += 1) {
      const body = requireApiSuccess(
        await client.post<ApiEnvelope & { useragents?: unknown }>('/UserAgent/MyAgents', {
          sort: 'id',
          order: 'DESC',
          start: page * AGENT_PAGE,
          limit: AGENT_PAGE,
        }, signal),
        'The agents could not be listed.',
      );
      const pageRows = rowsOf(body.useragents);
      rows.push(...pageRows);
      if (pageRows.length < AGENT_PAGE) break;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`The agents could not be listed: ${keySafeErrorText(error)} Name the agent by its guid instead.`);
  }
  const agents = rows.flatMap(row => {
    const guid = asString(row.guid);
    return guid ? [{ guid, title: oneLine(asString(row.title) ?? '') }] : [];
  });
  const exact = agents.filter(agent => agent.title === text);
  const found = exact.length > 0 ? exact : agents.filter(agent => agent.title.toLowerCase() === text.toLowerCase());
  if (found.length === 0) {
    // An agent of the workspace may be called Studio; only without one is the name Wiro's own agent.
    if (HOUSE_AGENTS.test(text)) throw new Error(HOUSE_AGENT_TEXT);
    throw new Error(`No agent named ${quotedSpan(text)} is in this workspace. list_my_agents lists the agents with their guids.`);
  }
  if (found.length > 1) {
    throw new Error(`${found.length} agents are named ${quotedSpan(text)}: guids ${found.map(agent => quotedSpan(agent.guid)).join(', ')}. `
      + 'Name the one you mean by its guid.');
  }
  return { guid: found[0].guid, ...(found[0].title ? { name: found[0].title } : {}) };
}

/** A limit's or a rule's target from the manage tools' arguments: an e-mail, a name or this connection's key become ids. */
export async function resolveTarget(
  client: WiroClient,
  args: TargetArgs & { scope: ControlScope },
  context: { workspace: ControlsWorkspace; caller?: Caller },
  signal?: AbortSignal,
): Promise<ResolvedTarget> {
  switch (args.scope) {
    case 'account':
      return { scope: 'account', target: '', thisConnection: false };
    case 'member': {
      const member = await resolveMember(client, args.member ?? '', context.workspace, signal);
      return { scope: 'member', target: member.uuid, ...(member.name ? { targetName: member.name } : {}), thisConnection: false };
    }
    case 'project': {
      const project = await resolveProject(client, args.project, context.caller, signal);
      return { scope: 'project', target: project.id, ...(project.name ? { targetName: project.name } : {}), thisConnection: project.connected };
    }
    case 'surface': {
      const surface = args.surface as Surface;
      return { scope: 'surface', target: surface, thisConnection: context.caller?.surface === surface };
    }
    case 'agent': {
      const agent = await resolveAgent(client, args.agent ?? '', signal);
      return { scope: 'agent', target: agent.guid, ...(agent.name ? { targetName: agent.name } : {}), thisConnection: false };
    }
  }
}

// ------------------------------------------------------------------- errors

export type ControlsPage = 'spend-limits' | 'model-access';

function pageText(page: ControlsPage): string {
  return page === 'spend-limits' ? `the Spend Limits page of the Wiro dashboard: ${SPEND_LIMITS_URL}` : `the Model Access page of the Wiro dashboard: ${MODEL_ACCESS_URL}`;
}

/** An older Wiro API has no change summary for controls, so no change goes through this server. */
export function previewMissingText(page: ControlsPage): string {
  return `This change cannot be previewed right now, so it was not made and nothing was changed. It can be made on ${pageText(page)}.`;
}

/** An older Wiro API takes changes to controls only from a signed-in person. */
function keyRefusedText(page: ControlsPage): string {
  return `This change cannot be made through this connection right now, so nothing was changed. It can be made on ${pageText(page)}.`;
}

/** The refusal an older Wiro API gives a change made with an API key. */
const KEY_CANNOT_CHANGE = /API keys can't manage teams or organizations/i;
/** Wiro's limit on how many changes API keys may make in an hour. */
const TOO_MANY_CHANGES = /Too many changes to Spend Limits and Model Access/i;
/** What Wiro answers for a route it does not have. */
const UNKNOWN_ROUTE = /^Parsing url error\.?$/i;

function withPeriod(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Wiro's refusal of a change, with what fixes it where that is known. */
export function refusalText(message: string): string {
  const text = withPeriod(message);
  if (/ is not a model on Wiro\.$| is not a model's owner\/slug or id\.$/i.test(text)) {
    return `${text} search_models finds a model's owner/slug. ${NOTHING_CHANGED}`;
  }
  if (/ is named twice\.$/i.test(text)) {
    return `${text} Name each model once: a model the rule already holds is named as get_controls shows it, or by its id. ${NOTHING_CHANGED}`;
  }
  return `${text} ${NOTHING_CHANGED}`;
}

/** Why a read for a change failed, as one sentence that says nothing changed. */
export function readFailure(what: string, error: unknown): Error {
  if (error instanceof ApiResultError) return new Error(`${withPeriod(error.message)} ${NOTHING_CHANGED}`);
  return new Error(`${what} could not be read (${keySafeErrorText(error)}), so ${NOTHING_CHANGED.toLowerCase()} Try again in a moment.`);
}

/** Why a change summary could not be made. A route the API does not have means the change cannot be previewed. */
export function previewFailure(error: unknown, page: ControlsPage): Error {
  if (error instanceof ApiResultError) {
    return new Error(UNKNOWN_ROUTE.test(error.message.trim()) ? previewMissingText(page) : refusalText(error.message));
  }
  if (error instanceof WiroApiError && error.status === 404) return new Error(previewMissingText(page));
  const text = errorText(error);
  if (TOO_MANY_CHANGES.test(text)) return new Error(`${withPeriod(text)} ${NOTHING_CHANGED}`);
  if (error instanceof WiroApiError && error.status === 401 && KEY_CANNOT_CHANGE.test(text)) return new Error(keyRefusedText(page));
  if (!isOutcomeUnknown(error)) return new Error(`${withPeriod(text)} ${NOTHING_CHANGED}`);
  return new Error(`The change summary could not be made (${keySafeErrorText(error)}), so ${NOTHING_CHANGED.toLowerCase()} Try again in a moment.`);
}

/**
 * Why a change failed. A clean refusal changed nothing. Without a clear answer the change may have
 * gone through, so `unknownText` says how to find out.
 */
export function changeFailure(error: unknown, page: ControlsPage, unknownText: string): Error {
  if (error instanceof ApiResultError) return new Error(refusalText(error.message));
  const text = errorText(error);
  if (TOO_MANY_CHANGES.test(text)) return new Error(`${withPeriod(text)} ${NOTHING_CHANGED}`);
  if (error instanceof WiroApiError && error.status === 401 && KEY_CANNOT_CHANGE.test(text)) return new Error(keyRefusedText(page));
  if (error instanceof WiroApiError && error.status === 404) return new Error(previewMissingText(page));
  if (!isOutcomeUnknown(error)) return new Error(`${withPeriod(text)} ${NOTHING_CHANGED}`);
  return new Error(`${keySafeErrorText(error)}\n\n${unknownText}`);
}

/** The sentence for a connection that may read controls but not change them. */
export function cannotChangeText(kind: ControlsWorkspace['kind'], what: 'spend limits' | 'Model Access rules', page: ControlsPage): string {
  const url = page === 'spend-limits' ? SPEND_LIMITS_URL : MODEL_ACCESS_URL;
  if (kind === 'team') {
    return `Only a team admin or the organization's owner can change this team's ${what}, and this connection acts as a team `
      + `member without those rights. ${NOTHING_CHANGED} Ask a team admin to do it, with their own connection or at ${url}.`;
  }
  return `This connection cannot change the ${what} of this workspace. ${NOTHING_CHANGED} The account owner can change them at ${url}.`;
}

export const dashboardSchema = z.object({
  spendLimits: z.string(),
  modelAccess: z.string(),
});

export const DASHBOARD = { spendLimits: SPEND_LIMITS_URL, modelAccess: MODEL_ACCESS_URL };
