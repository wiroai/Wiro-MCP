import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  errorText,
  isPlainObject,
  MODEL_ACCESS_URL,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  blocksSomething,
  CATEGORY_KEYS,
  changeFailure,
  checkTargetArguments,
  confirmLead,
  confirmState,
  CONTROL_SCOPES,
  cannotChangeText,
  entryName,
  isCategory,
  isThisConnection,
  MAX_RULE_MODELS,
  NOTHING_CHANGED,
  previewFailure,
  previewMissingText,
  readFailure,
  readRuleList,
  resolveTarget,
  ruleSummary,
  ruleView,
  ruleViewSchema,
  summaryId,
  summaryIdSchema,
  SURFACES,
  targetArgument,
  targetText,
  toRuleDecisions,
  toRuleRow,
  versionOf,
  wholeWallet,
  type Access,
  type CategoryKey,
  type CategoryLabels,
  type ControlScope,
  type ControlsWorkspace,
  type ResolvedTarget,
  type RuleDecision,
  type RuleList,
  type RuleRow,
  type Surface,
} from '../utils/controls.js';
import { jsonSpan, quotedSpan } from '../utils/quoted-text.js';
import { nextActionSchema, strictInput } from './schemas.js';

const MAX_MODELS_PER_CALL = 50;

const SET_UNKNOWN = 'The outcome is not known: the rule may or may not have changed. get_controls shows the rule as it '
  + 'is now, and repeating this same call is safe, since it asks for the same rule.';
const REMOVE_UNKNOWN = 'The outcome is not known: the rule may or may not be removed. get_controls shows whether it is '
  + 'still there, and repeating this same call is safe.';
const ASK_REASON = 'Ask the user to confirm this change first.';
const APPLIES_NOTE = 'It applies to runs that start from now on; work already running is not stopped.';
const AGENT_NOTE = 'The agent follows a change to its own rule within about a minute.';

type EntryAccess = Access | 'unset';

interface Args {
  action: 'update' | 'replace' | 'remove';
  scope?: ControlScope;
  member?: string;
  project?: string;
  surface?: Surface;
  agent?: string;
  everything_else?: Access;
  categories?: Array<{ category: CategoryKey; access: EntryAccess }>;
  models?: Array<{ model: string; access: EntryAccess }>;
  rule_guid?: string;
  confirm: boolean;
  updated_at?: number;
  summary_id?: string;
}

type Outcome = 'preview' | 'saved' | 'removed' | 'unchanged' | 'refused';

/** The rule a change asks for: entries the rule holds keep their id, new ones go by the name given. */
interface Draft {
  access: Access;
  categories: Partial<Record<CategoryKey, Access>>;
  models: Array<{ ref: string; id?: string; access: Access }>;
}

interface Located {
  target: ResolvedTarget;
  existing: RuleRow | null;
}

const fromTo = z.enum(['allow', 'block', 'not named']);

const outputSchema = {
  action: z.enum(['update', 'replace', 'remove']),
  outcome: z.enum(['preview', 'saved', 'removed', 'unchanged', 'refused'])
    .describe('preview: a change summary, nothing changed yet. saved or removed: done. unchanged: it was already so. refused: nothing was changed, and message says why.'),
  workspace: z.object({
    kind: z.enum(['personal', 'team', 'unknown']),
    canManage: z.boolean(),
  }),
  target: z.object({
    scope: z.enum(CONTROL_SCOPES),
    target: z.string().optional(),
    targetName: z.string().optional(),
    thisConnection: z.boolean().optional(),
  }).optional(),
  before: ruleViewSchema.nullable().describe('The rule before the change; null when there was none.'),
  after: ruleViewSchema.nullable().describe('The rule after the change; null for a removal.'),
  changes: z.object({
    everythingElse: z.object({ from: fromTo, to: fromTo }).optional(),
    categories: z.array(z.object({ category: z.enum(CATEGORY_KEYS), label: z.string(), from: fromTo, to: fromTo })),
    models: z.array(z.object({ id: z.string(), model: z.string().nullable(), title: z.string().optional(), from: fromTo, to: fromTo })),
  }).optional(),
  changedSinceSummary: z.boolean().optional().describe('True when the rule changed after the summary the user saw: this is a new summary, and nothing was saved.'),
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
  message: z.string(),
  dashboardUrl: z.string(),
  nextAction: nextActionSchema.optional(),
};

function inputError(text: string): Error {
  return new Error(`${text} ${NOTHING_CHANGED}`);
}

function sameTarget(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function result(structured: Record<string, unknown>, lines: string[]) {
  return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: structured };
}

function targetView(target: ResolvedTarget) {
  return {
    scope: target.scope,
    ...(target.scope !== 'account' ? { target: target.target } : {}),
    ...(target.targetName ? { targetName: target.targetName } : {}),
    ...(target.thisConnection ? { thisConnection: true } : {}),
  };
}

function nextLine(nextAction: { tool: string; arguments: Record<string, unknown>; reason: string } | undefined): string[] {
  return nextAction ? ['', `**Next:** \`${nextAction.tool}\` with ${jsonSpan(nextAction.arguments)}. ${nextAction.reason}`] : [];
}

function bullets(warnings: string[], notes: string[]): string[] {
  const all = [...warnings.map(warning => `Warning: ${warning}`), ...notes];
  return all.length > 0 ? ['', ...all.map(line => `- ${line}`)] : [];
}

function word(access: Access | 'not named'): string {
  return access === 'allow' ? 'allowed' : access === 'block' ? 'blocked' : 'not named';
}

function refusedResult(action: Args['action'], workspace: ControlsWorkspace) {
  const message = cannotChangeText(workspace.kind, 'Model Access rules', 'model-access');
  return result({
    action,
    outcome: 'refused' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: false },
    before: null,
    after: null,
    warnings: [],
    notes: [],
    message,
    dashboardUrl: MODEL_ACCESS_URL,
  }, ['## Not changed', '', message]);
}

/** Refusals that need no call: arguments that do not fit together. */
function checkArguments(args: Args): void {
  const hasEntries = args.everything_else !== undefined || (args.categories?.length ?? 0) > 0 || (args.models?.length ?? 0) > 0;
  if (args.action === 'remove' && hasEntries) {
    throw inputError('remove deletes the whole rule and takes no everything_else, categories or models. To take out one entry, use update with access unset.');
  }
  if (args.action === 'update' && !hasEntries) {
    throw inputError('update needs something to change: everything_else, categories or models.');
  }
  if (args.action === 'replace') {
    const unset = [...(args.categories ?? []), ...(args.models ?? [])].some(entry => entry.access === 'unset');
    if (unset) throw inputError('Access unset takes an entry out of a rule, so it goes with update. replace writes the whole rule: leave the entry out instead.');
  }
  const categories = args.categories ?? [];
  const twice = categories.find((entry, index) => categories.findIndex(other => other.category === entry.category) !== index);
  if (twice) throw inputError(`The category ${twice.category} is named twice.`);
  const models = args.models ?? [];
  const twiceModel = models.find((entry, index) => models.findIndex(other => other.model.toLowerCase() === entry.model.toLowerCase()) !== index);
  if (twiceModel) throw inputError(`${quotedSpan(twiceModel.model)} is named twice.`);
  if (!args.rule_guid && !args.scope) {
    throw inputError('Name the rule: scope with its target (member, project, surface or agent), or rule_guid from get_controls.');
  }
  try {
    if (!args.rule_guid) checkTargetArguments(args);
  } catch (error) {
    throw inputError(errorText(error));
  }
}

/** The rule a call names: from rule_guid, or from the scope and its target. One rule per scope and target. */
async function locate(client: WiroClient, args: Args, list: RuleList, signal: AbortSignal): Promise<Located | string> {
  if (args.rule_guid) {
    const rule = list.rules.find(candidate => candidate.guid === args.rule_guid);
    if (!rule) return `No rule with rule_guid ${quotedSpan(args.rule_guid)} is in this workspace.`;
    const fields = (['member', 'project', 'surface', 'agent'] as const).filter(field => args[field] !== undefined);
    const conflict = (args.scope !== undefined && args.scope !== rule.scope)
      || fields.some(field => field !== rule.scope
        || (!sameTarget(String(args[field]).trim(), rule.target) && !sameTarget(String(args[field]).trim(), rule.targetName ?? '')));
    if (conflict) {
      throw inputError(`rule_guid already names the rule for ${targetText(rule, list.workspace.kind)}: leave out scope and its target, or name the same ones.`);
    }
    return {
      target: {
        scope: rule.scope,
        target: rule.target,
        ...(rule.targetName ? { targetName: rule.targetName } : {}),
        thisConnection: isThisConnection(rule.scope, rule.target, list.caller),
      },
      existing: rule,
    };
  }
  let target: ResolvedTarget;
  try {
    target = await resolveTarget(client, { ...args, scope: args.scope as ControlScope }, list, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw inputError(errorText(error));
  }
  const existing = list.rules.find(rule => rule.scope === target.scope && sameTarget(rule.target, target.target)) ?? null;
  if (!target.targetName && existing?.targetName) target.targetName = existing.targetName;
  return { target, existing };
}

/** The rule asked for, and the entries an unset found nothing to take out of. */
function draftOf(args: Args, existing: RuleRow | null): { draft: Draft; notInRule: string[] } {
  const notInRule: string[] = [];
  if (args.action === 'replace') {
    const categories: Partial<Record<CategoryKey, Access>> = {};
    for (const entry of args.categories ?? []) if (entry.access !== 'unset') categories[entry.category] = entry.access;
    return {
      draft: {
        access: args.everything_else ?? 'allow',
        categories,
        models: (args.models ?? []).flatMap(entry => (entry.access === 'unset' ? [] : [{ ref: entry.model.trim(), access: entry.access }])),
      },
      notInRule,
    };
  }
  const categories: Partial<Record<CategoryKey, Access>> = { ...(existing?.categories ?? {}) };
  for (const entry of args.categories ?? []) {
    if (entry.access === 'unset') {
      if (categories[entry.category] === undefined) notInRule.push(entry.category);
      delete categories[entry.category];
    } else {
      categories[entry.category] = entry.access;
    }
  }
  // Entries the rule holds go back by id: a name can have changed, and a model no longer on Wiro has none.
  const models: Draft['models'] = (existing?.models ?? []).map(entry => ({ ref: entry.id, id: entry.id, access: entry.access }));
  for (const entry of args.models ?? []) {
    const ref = entry.model.trim();
    const held = existing?.models.find(candidate => (/^\d+$/.test(ref)
      ? candidate.id === ref
      : candidate.model !== null && candidate.model.toLowerCase() === ref.toLowerCase()));
    const index = held ? models.findIndex(candidate => candidate.id === held.id) : -1;
    if (entry.access === 'unset') {
      if (index === -1) notInRule.push(ref);
      else models.splice(index, 1);
    } else if (index !== -1) {
      models[index] = { ...models[index], access: entry.access };
    } else {
      models.push({ ref, access: entry.access });
    }
  }
  return { draft: { access: args.everything_else ?? existing?.access ?? 'allow', categories, models }, notInRule };
}

function sameRule(a: Pick<RuleRow, 'access' | 'categories' | 'models'>, b: Pick<RuleRow, 'access' | 'categories' | 'models'>): boolean {
  if (a.access !== b.access) return false;
  if (CATEGORY_KEYS.some(key => a.categories[key] !== b.categories[key])) return false;
  if (a.models.length !== b.models.length) return false;
  const byId = new Map(a.models.map(entry => [entry.id, entry.access]));
  return b.models.every(entry => byId.get(entry.id) === entry.access);
}

/** A draft whose entries all have ids is the same as a rule when every value matches. */
function draftMatches(draft: Draft, rule: RuleRow | null): boolean {
  if (!rule || draft.models.some(entry => entry.id === undefined)) return false;
  return sameRule({ access: draft.access, categories: draft.categories, models: draft.models.map(entry => ({ id: entry.id as string, model: null, access: entry.access })) }, rule);
}

function ruleBody(target: ResolvedTarget, draft: Draft): Record<string, unknown> {
  return {
    scope: target.scope,
    target: target.target,
    access: draft.access,
    categories: CATEGORY_KEYS.flatMap(category => (draft.categories[category] ? [{ category, access: draft.categories[category] }] : [])),
    models: draft.models.map(entry => ({ model: entry.ref, access: entry.access })),
  };
}

interface Changes {
  everythingElse?: { from: Access | 'not named'; to: Access | 'not named' };
  categories: Array<{ category: CategoryKey; label: string; from: Access | 'not named'; to: Access | 'not named' }>;
  models: Array<{ id: string; model: string | null; title?: string; from: Access | 'not named'; to: Access | 'not named' }>;
}

function changesOf(before: RuleRow | null, after: RuleRow, labels: CategoryLabels): Changes {
  const changes: Changes = { categories: [], models: [] };
  const fromAccess = before?.access ?? 'allow';
  if (!before || fromAccess !== after.access) changes.everythingElse = { from: before ? fromAccess : 'not named', to: after.access };
  for (const category of CATEGORY_KEYS) {
    const from = before?.categories[category] ?? 'not named';
    const to = after.categories[category] ?? 'not named';
    if (from !== to) changes.categories.push({ category, label: labels[category], from, to });
  }
  const ids = [...new Set([...(before?.models ?? []).map(entry => entry.id), ...after.models.map(entry => entry.id)])];
  for (const id of ids) {
    const was = before?.models.find(entry => entry.id === id);
    const now = after.models.find(entry => entry.id === id);
    const from = was?.access ?? 'not named';
    const to = now?.access ?? 'not named';
    if (from === to) continue;
    const model = now?.model ?? was?.model ?? null;
    const title = now?.title ?? was?.title;
    changes.models.push({ id, model, ...(title ? { title } : {}), from, to });
  }
  return changes;
}

function changeLines(changes: Changes): string[] {
  const lines: string[] = [];
  if (changes.everythingElse) {
    lines.push(changes.everythingElse.from === 'not named'
      ? `- Every model it does not name: ${word(changes.everythingElse.to)}`
      : `- Every model it does not name: ${word(changes.everythingElse.from)} before, ${word(changes.everythingElse.to)} after`);
  }
  for (const entry of changes.categories) lines.push(`- ${entry.label}: ${word(entry.from)} before, ${word(entry.to)} after`);
  for (const entry of changes.models) lines.push(`- ${entryName(entry, true)}: ${word(entry.from)} before, ${word(entry.to)} after`);
  return lines;
}

/** Allowing a category here changes nothing while the whole wallet's rule blocks it. */
function categoryWarnings(
  target: ResolvedTarget,
  before: RuleRow['categories'],
  after: RuleRow['categories'],
  list: RuleList,
): string[] {
  if (target.scope === 'account') return [];
  const account = list.rules.find(rule => rule.scope === 'account');
  if (!account) return [];
  const whole = wholeWallet(list.workspace.kind);
  const warnings: string[] = [];
  for (const category of CATEGORY_KEYS) {
    if (after[category] !== 'allow' || before[category] === 'allow') continue;
    const label = list.labels[category];
    if (account.categories[category] === 'block') {
      warnings.push(`The rule for ${whole} blocks ${label}, so allowing it here changes nothing until that rule allows it too.`);
    } else if (account.access === 'block' && account.categories[category] !== 'allow') {
      warnings.push(`The rule for ${whole} lets only what it names run, and it does not allow ${label}, so allowing it here changes nothing until that rule allows it too.`);
    }
  }
  return warnings;
}

/** When the wider rules could not be checked: the whole wallet's rule blocks this model by name. */
function accountModelWarning(target: ResolvedTarget, id: string | undefined, name: string, list: RuleList): string[] {
  if (target.scope === 'account' || !id) return [];
  const account = list.rules.find(rule => rule.scope === 'account');
  if (!account?.models.some(held => held.id === id && held.access === 'block')) return [];
  return [`The rule for ${wholeWallet(list.workspace.kind)} blocks ${name}, so allowing it here changes nothing until that rule allows it too.`];
}

/** Besides a target's own rule, the rules that apply to every run of it: they must allow a model too. */
const ALWAYS_APPLY: Record<ControlScope, readonly ControlScope[]> = {
  account: [],
  member: ['account'],
  // A key acts as the person who created it, so in a team that member's rule covers every run with it.
  project: ['account', 'member'],
  surface: ['account'],
  // An agent's runs come in on the agent surface with its own key, as that key's creator.
  agent: ['account', 'member', 'project', 'surface'],
};

/** At most this many models of one change are checked against the wider rules. */
const MAX_WIDER_CHECKS = 10;

/** A ModelAccess/Check body for a run of the target. The agent surface needs an agent, so a plain run stands in for it. */
function targetRunBody(target: ResolvedTarget): Record<string, string> {
  switch (target.scope) {
    case 'member':
      return { member: target.target };
    case 'project':
      return { project: target.target };
    case 'surface':
      return target.target === 'agent' ? {} : { surface: target.target };
    case 'agent':
      return { agent: target.target };
    case 'account':
      return {};
  }
}

/**
 * For each model a change allows, the wider rules that still block it for the target, as ModelAccess/Check decides
 * them today. null when that model's check failed, so nothing is known; a model past the first ten is not checked.
 */
async function widerBlocks(
  client: WiroClient,
  target: ResolvedTarget,
  models: Array<{ key: string; ref: string }>,
  signal: AbortSignal,
): Promise<Map<string, RuleDecision[] | null>> {
  const found = new Map<string, RuleDecision[] | null>();
  if (target.scope === 'account') return found;
  const scopes = ALWAYS_APPLY[target.scope];
  await Promise.all(models.slice(0, MAX_WIDER_CHECKS).map(async ({ key, ref }) => {
    try {
      const body = requireApiSuccess(
        await client.post<ApiEnvelope & { check?: unknown }>('/ModelAccess/Check', { model: ref, ...targetRunBody(target) }, signal),
        'The model could not be checked.',
      );
      const check = isPlainObject(body.check) ? body.check : {};
      found.set(key, toRuleDecisions(check.rules).filter(decision => decision.decides === 'block'
        && scopes.includes(decision.rule.scope)
        && !(decision.rule.scope === target.scope && sameTarget(decision.rule.target, target.target))));
    } catch (error) {
      if (signal.aborted) throw error;
      found.set(key, null);
    }
  }));
  return found;
}

/** A wider rule that still blocks a model this change allows. */
function widerBlockText(decision: RuleDecision, model: string, kind: ControlsWorkspace['kind'], labels: CategoryLabels): string {
  const rule = `The rule for ${targetText(decision.rule, kind)}`;
  const tail = 'so allowing it here changes nothing until that rule allows it too.';
  if (decision.by === 'model') return `${rule} blocks ${model} by name, ${tail}`;
  if (decision.by === 'category') {
    const label = decision.category && isCategory(decision.category) ? labels[decision.category] : 'one of its categories';
    return `${rule} blocks ${label}, and ${model} is in it, ${tail}`;
  }
  return `${rule} lets only the models it names run, and ${model} is not one of them, ${tail}`;
}

/** What the wider rules say of the models a change allows: a warning for each one that still blocks one. */
async function modelWarnings(
  client: WiroClient,
  target: ResolvedTarget,
  allowed: Array<{ key: string; ref: string; id?: string; name: string }>,
  list: RuleList,
  signal: AbortSignal,
): Promise<string[]> {
  const checks = await widerBlocks(client, target, allowed, signal);
  return allowed.flatMap(entry => {
    const decisions = checks.get(entry.key);
    return decisions
      ? decisions.map(decision => widerBlockText(decision, entry.name, list.workspace.kind, list.labels))
      : accountModelWarning(target, entry.id, entry.name, list);
  });
}

interface PreviewAnswer {
  rule: RuleRow;
  /** The rule Set would replace; null for none, undefined when the answer left it out. */
  existing: RuleRow | null | undefined;
  chatModel?: { name: string; blocked: boolean };
}

/** Wiro's refusal of a model the rule holds that is no longer on Wiro, with how to take it out. */
function hiddenModelText(error: unknown, existing: RuleRow | null): string | null {
  if (!(error instanceof ApiResultError) || !existing) return null;
  const id = /^(\d+) is not a model on Wiro\.?$/i.exec(error.message.trim())?.[1];
  if (!id || !existing.models.some(entry => entry.id === id)) return null;
  return `Model ${id} in this rule is no longer on Wiro, so the rule cannot be saved with it. Add ${jsonSpan({ model: id, access: 'unset' })} `
    + `to models in this call to take it out. ${NOTHING_CHANGED}`;
}

async function previewRule(client: WiroClient, body: Record<string, unknown>, existing: RuleRow | null, signal: AbortSignal): Promise<PreviewAnswer> {
  let answer: ApiEnvelope & { preview?: unknown; rule?: unknown; existing?: unknown; agentchatmodel?: unknown };
  try {
    answer = requireApiSuccess(
      await client.post<ApiEnvelope & { preview?: unknown; rule?: unknown; existing?: unknown; agentchatmodel?: unknown }>('/ModelAccess/Preview', body, signal),
      'The change summary could not be made.',
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const hidden = hiddenModelText(error, existing);
    if (hidden) throw new Error(hidden);
    throw previewFailure(error, 'model-access');
  }
  const rule = isPlainObject(answer.rule) ? toRuleRow(answer.rule) : null;
  // Only an answer that says it is a preview proves nothing was written.
  if (answer.preview !== true || !rule) throw new Error(previewMissingText('model-access'));
  const previous = isPlainObject(answer.existing) ? toRuleRow(answer.existing) : answer.existing === null ? null : undefined;
  const chat = isPlainObject(answer.agentchatmodel) ? answer.agentchatmodel : null;
  const chatName = chat ? (asString(chat.model)?.trim() || asString(chat.ref)?.trim()) : undefined;
  return {
    rule,
    existing: previous,
    ...(chat && chatName ? { chatModel: { name: chatName, blocked: chat.blocked === true } } : {}),
  };
}

function nextArguments(args: Args, target: ResolvedTarget, version: number, id: string): Record<string, unknown> {
  return {
    action: args.action,
    scope: target.scope,
    ...targetArgument(target.scope, target.target),
    ...(args.everything_else !== undefined ? { everything_else: args.everything_else } : {}),
    ...(args.categories && args.categories.length > 0 ? { categories: args.categories } : {}),
    ...(args.models && args.models.length > 0 ? { models: args.models.map(entry => ({ model: entry.model.trim(), access: entry.access })) } : {}),
    confirm: true,
    updated_at: version,
    summary_id: id,
  };
}

/** The change a rule summary shows, for its id: the rule Set would get, in an order that does not depend on the reads. */
function ruleChange(action: Args['action'], body: Record<string, unknown>, version: number): Record<string, unknown> {
  const models = (body.models as Array<{ model: string; access: Access }>).map(entry => [entry.model, entry.access]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { tool: 'manage_model_access', action, ...body, models, version };
}

function removeNextAction(rule: RuleRow) {
  return {
    tool: 'manage_model_access',
    arguments: { action: 'remove', rule_guid: rule.guid },
    reason: 'Shows what removing the rule changes; nothing changes without the user\'s yes.',
  };
}

async function changeRule(client: WiroClient, args: Args, list: RuleList, signal: AbortSignal) {
  const { workspace, caller, labels } = list;
  const located = await locate(client, args, list, signal);
  if (typeof located === 'string') throw inputError(`${located} get_controls lists the rules with their guids.`);
  const { target, existing } = located;
  const covers = () => targetText(target, workspace.kind);
  const { draft, notInRule } = draftOf(args, existing);
  const unsetNote = notInRule.length > 0
    ? [`${notInRule.map(name => quotedSpan(name)).join(', ')} ${notInRule.length === 1 ? 'is' : 'are'} not in the rule, so unset changes nothing there.`]
    : [];

  const unchanged = (rule: RuleRow) => {
    const message = `The rule for ${covers()} already reads: ${ruleSummary(rule, labels, { quote: true, maxModels: 10 })}. ${NOTHING_CHANGED}`;
    return result({
      action: args.action,
      outcome: 'unchanged' satisfies Outcome,
      workspace: { kind: workspace.kind, canManage: true },
      target: targetView(target),
      before: ruleView(rule, labels, caller),
      after: ruleView(rule, labels, caller),
      warnings: [],
      notes: unsetNote,
      message,
      dashboardUrl: MODEL_ACCESS_URL,
    }, ['## Nothing to change', '', message, ...bullets([], unsetNote)]);
  };
  if (draftMatches(draft, existing)) return unchanged(existing as RuleRow);

  if (!blocksSomething(draft)) {
    // Often the wish behind it is to open a model a wider rule blocks: say which rule that is.
    const opened = draft.models.filter(entry => entry.access === 'allow'
      && !existing?.models.some(held => held.id !== undefined && held.id === entry.id && held.access === 'allow'));
    const warnings = [...new Set([
      ...categoryWarnings(target, existing?.categories ?? {}, draft.categories, list),
      ...await modelWarnings(client, target, opened.map(entry => {
        const held = entry.id ? existing?.models.find(candidate => candidate.id === entry.id) : undefined;
        return { key: entry.id ?? entry.ref, ref: entry.ref, ...(entry.id ? { id: entry.id } : {}), name: held ? entryName(held, true) : quotedSpan(entry.ref) };
      }), list, signal),
    ])];
    const hint = warnings.length > 0
      ? 'To open a model that a wider rule blocks, that rule has to change: check_model_access shows every rule that blocks it.'
      : 'To let only some models run, set everything_else to block.';
    const message = `After this change the rule for ${covers()} would block nothing: with everything_else allow, allow entries `
      + `change nothing, since a narrower rule cannot open what a wider one blocks. ${hint} `
      + `${existing ? 'To lift the rule, remove it: nextAction shows that summary. ' : ''}${NOTHING_CHANGED}`;
    const nextAction = existing?.guid ? removeNextAction(existing) : undefined;
    return result({
      action: args.action,
      outcome: 'refused' satisfies Outcome,
      workspace: { kind: workspace.kind, canManage: true },
      target: targetView(target),
      before: existing ? ruleView(existing, labels, caller) : null,
      after: null,
      warnings,
      notes: unsetNote,
      message,
      dashboardUrl: MODEL_ACCESS_URL,
      ...(nextAction ? { nextAction } : {}),
    }, ['## Not changed', '', message, ...bullets(warnings, unsetNote), ...nextLine(nextAction)]);
  }
  if (draft.models.length > MAX_RULE_MODELS) {
    throw inputError(`A rule can name at most ${MAX_RULE_MODELS} models, and this one would name ${draft.models.length}.`);
  }

  const body = ruleBody(target, draft);
  const preview = await previewRule(client, body, existing, signal);
  const before = preview.existing !== undefined ? preview.existing : existing;
  const after = preview.rule;
  if (!target.targetName && (after.targetName || before?.targetName)) target.targetName = after.targetName ?? before?.targetName;
  if (before && sameRule(before, after)) return unchanged(before);

  const changes = changesOf(before, after, labels);
  const warnings: string[] = [];
  if (target.scope === 'agent' && preview.chatModel?.blocked) {
    warnings.push(`This rule also blocks ${quotedSpan(preview.chatModel.name)}, the chat model the agent answers with, so the agent `
      + 'would stop answering. Allow that model too, or allow LLM & Chat.');
  }
  if (!after.models.some(entry => entry.access === 'allow') && !Object.values(after.categories).includes('allow') && after.access === 'block') {
    warnings.push(`This rule blocks every model for ${covers()}.`);
  }
  warnings.push(...categoryWarnings(target, before?.categories ?? {}, after.categories, list));
  const allowedModels = changes.models.filter(entry => entry.to === 'allow' && entry.from !== 'allow');
  warnings.push(...await modelWarnings(client, target, allowedModels.map(entry => ({
    key: entry.id,
    ref: entry.model ?? entry.id,
    id: entry.id,
    name: entryName(entry, true),
  })), list, signal));
  const notes = [APPLIES_NOTE];
  if (target.scope === 'agent') notes.push(AGENT_NOTE);
  if (target.scope === 'account' || target.thisConnection) notes.push('It covers runs through this connection too.');
  const gone = after.models.filter(entry => entry.model === null).length;
  if (gone > 0) notes.push(`${gone === 1 ? 'One model' : `${gone} models`} in this rule ${gone === 1 ? 'is' : 'are'} no longer on Wiro and stay in it until taken out.`);
  notes.push(...unsetNote);

  const version = versionOf(before);
  const id = summaryId(client, ruleChange(args.action, body, version));
  const nextAction = { tool: 'manage_model_access', arguments: nextArguments(args, target, version, id), reason: ASK_REASON };
  const state = confirmState(args, version, id);
  if (state !== 'confirmed') {
    const changedSinceSummary = state === 'changed';
    const lead = confirmLead(state, 'rule');
    const message = lead ?? `Change the rule for ${covers()} to: ${ruleSummary(after, labels)}? Nothing has changed yet.`;
    return result({
      action: args.action,
      outcome: 'preview' satisfies Outcome,
      workspace: { kind: workspace.kind, canManage: true },
      target: targetView(target),
      before: before ? ruleView(before, labels, caller) : null,
      after: ruleView(after, labels, caller),
      changes,
      ...(changedSinceSummary ? { changedSinceSummary: true } : {}),
      warnings,
      notes,
      message,
      dashboardUrl: MODEL_ACCESS_URL,
      nextAction,
    }, [
      changedSinceSummary ? '## The rule changed since the summary (nothing saved)' : '## Change a Model Access rule? (nothing changed yet)',
      '',
      ...(lead ? [lead, ''] : []),
      `**Rule for:** ${covers()}`,
      `**Before:** ${before ? ruleSummary(before, labels, { quote: true, maxModels: 10 }) : 'no rule, so this rule allowed every model'}`,
      `**After:** ${ruleSummary(after, labels, { quote: true, maxModels: 10 })}`,
      '**Changes:**',
      ...changeLines(changes),
      ...bullets(warnings, notes),
      '',
      'Nothing has changed yet. Show this to the user and wait for a clear yes.',
      ...nextLine(nextAction),
    ]);
  }

  let saved: ApiEnvelope & { rule?: unknown };
  try {
    saved = requireApiSuccess(await client.post<ApiEnvelope & { rule?: unknown }>('/ModelAccess/Set', body, signal), 'The rule could not be saved.');
  } catch (error) {
    if (signal.aborted) throw error;
    const hidden = hiddenModelText(error, before);
    if (hidden) throw new Error(hidden);
    throw changeFailure(error, 'model-access', SET_UNKNOWN);
  }
  const rule = (isPlainObject(saved.rule) ? toRuleRow(saved.rule) : null) ?? after;
  const savedNotes = notes.filter(note => !unsetNote.includes(note));
  const message = `Saved the rule for ${covers()}: ${ruleSummary(rule, labels)}.`;
  return result({
    action: args.action,
    outcome: 'saved' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: true },
    target: targetView(target),
    before: before ? ruleView(before, labels, caller) : null,
    after: ruleView(rule, labels, caller),
    changes: changesOf(before, rule, labels),
    warnings,
    notes: savedNotes,
    message,
    dashboardUrl: MODEL_ACCESS_URL,
  }, [
    '## Model Access rule saved',
    '',
    `**Rule for:** ${covers()}`,
    `**Now:** ${ruleSummary(rule, labels, { quote: true, maxModels: 10 })}`,
    ...bullets(warnings, savedNotes),
  ]);
}

/** The rule that still applies once one is removed: the whole wallet's. */
function stillApplyNote(rule: RuleRow, list: RuleList): string | null {
  if (rule.scope === 'account') return null;
  const account = list.rules.find(candidate => candidate.scope === 'account');
  return account
    ? `The rule for ${wholeWallet(list.workspace.kind)} still applies: ${ruleSummary(account, list.labels, { quote: true, maxModels: 10 })}.`
    : null;
}

async function removeRule(client: WiroClient, args: Args, list: RuleList, signal: AbortSignal) {
  const { workspace, caller, labels } = list;
  const located = await locate(client, args, list, signal);
  const nothing = (text: string) => result({
    action: 'remove',
    outcome: 'unchanged' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: true },
    ...(typeof located === 'string' ? {} : { target: targetView(located.target) }),
    before: null,
    after: null,
    warnings: [],
    notes: [],
    message: text,
    dashboardUrl: MODEL_ACCESS_URL,
  }, ['## Nothing to remove', '', text]);
  if (typeof located === 'string') return nothing(`${located} It may be removed already; get_controls lists the rules. ${NOTHING_CHANGED}`);
  const rule = located.existing;
  const covers = targetText(located.target, workspace.kind);
  if (!rule) return nothing(`There is no rule for ${covers}, so there is nothing to remove. ${NOTHING_CHANGED}`);
  if (!rule.guid) throw inputError('Wiro did not give this rule\'s guid, so it cannot be removed here. It can be removed on the Model Access page of the Wiro dashboard.');

  const stillApply = stillApplyNote(rule, list);
  const notes = [
    ...(stillApply ? [stillApply] : []),
    ...(rule.scope === 'agent' ? [AGENT_NOTE] : []),
  ];
  const version = versionOf(rule);
  const id = summaryId(client, { tool: 'manage_model_access', action: 'remove', guid: rule.guid, version });
  const state = confirmState(args, version, id);
  if (state !== 'confirmed') {
    const changedSinceSummary = state === 'changed';
    const lead = confirmLead(state, 'rule');
    const nextAction = {
      tool: 'manage_model_access',
      arguments: { action: 'remove', rule_guid: rule.guid, confirm: true, updated_at: version, summary_id: id },
      reason: ASK_REASON,
    };
    const previewNotes = ['Once it is removed, models it blocked can run again, unless another rule blocks them.', ...notes];
    const message = lead ?? `Remove the rule for ${covers}? Nothing has changed yet.`;
    return result({
      action: 'remove',
      outcome: 'preview' satisfies Outcome,
      workspace: { kind: workspace.kind, canManage: true },
      target: targetView(located.target),
      before: ruleView(rule, labels, caller),
      after: null,
      ...(changedSinceSummary ? { changedSinceSummary: true } : {}),
      warnings: [],
      notes: previewNotes,
      message,
      dashboardUrl: MODEL_ACCESS_URL,
      nextAction,
    }, [
      changedSinceSummary ? '## The rule changed since the summary (nothing removed)' : '## Remove a Model Access rule? (nothing changed yet)',
      '',
      ...(lead ? [lead, ''] : []),
      `**Rule for:** ${covers}`,
      `**It reads:** ${ruleSummary(rule, labels, { quote: true, maxModels: 10 })}`,
      ...bullets([], previewNotes),
      '',
      'Nothing has changed yet. Show this to the user and wait for a clear yes.',
      ...nextLine(nextAction),
    ]);
  }

  try {
    requireApiSuccess(await client.post<ApiEnvelope>('/ModelAccess/Remove', { guid: rule.guid }, signal), 'The rule could not be removed.');
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ApiResultError && /rule not found in this workspace/i.test(error.message)) {
      return nothing(`The rule for ${covers} is not there any more: it was removed already. ${NOTHING_CHANGED}`);
    }
    throw changeFailure(error, 'model-access', REMOVE_UNKNOWN);
  }
  const removedNotes = ['Models it blocked can run again from now on, unless another rule blocks them.', ...notes];
  const message = `Removed the rule for ${covers}.`;
  return result({
    action: 'remove',
    outcome: 'removed' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: true },
    target: targetView(located.target),
    before: ruleView(rule, labels, caller),
    after: null,
    warnings: [],
    notes: removedNotes,
    message,
    dashboardUrl: MODEL_ACCESS_URL,
  }, ['## Model Access rule removed', '', message, ...bullets([], removedNotes)]);
}

export function registerManageModelAccess(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'manage_model_access',
    {
      title: 'Change a Wiro Model Access rule',
      description: 'Change one Model Access rule of the connected project\'s workspace: which models the whole wallet '
        + '(account), one team member, one API key (project), one way in (surface) or one agent may run. A rule names '
        + 'categories, single models (by owner/slug) and what every other model gets (everything_else). update changes '
        + 'only the entries it names and keeps the rest (access unset takes an entry out), replace writes the whole rule, '
        + 'remove deletes it. Every rule that applies to a run must allow its model, so a narrower rule cannot open what '
        + 'a wider one blocks. Only the account owner, a team admin or the organization\'s owner can change rules; for '
        + 'anyone else this changes nothing. Without `confirm: true` it returns a change summary: the rule before and '
        + 'after, each entry that changes, and warnings, such as a wider rule that still blocks a model it allows. Show it, '
        + 'wait for a clear yes, then repeat the call exactly as its nextAction shows. If the rule changed in between, or '
        + 'the call asks for anything else, nothing is saved and a new summary comes back.',
      inputSchema: strictInput({
        action: z.enum(['update', 'replace', 'remove'])
          .describe('update merges the entries given into the rule, replace writes the whole rule from the entries given, remove deletes the rule.'),
        scope: z.enum(CONTROL_SCOPES).optional()
          .describe('Whose runs the rule covers: account (the whole wallet), member (one team member), project (one API key), surface (one way in) or agent (one deployed agent). Needed unless rule_guid names the rule.'),
        member: z.string().trim().min(1).max(320).optional()
          .describe('Scope member, teams only: the member, by e-mail or user id.'),
        project: z.string().trim().min(1).max(200).optional()
          .describe('Scope project: the API key\'s project, by id or exact name. Left out, this connection\'s own key.'),
        surface: z.enum(SURFACES).optional()
          .describe('Scope surface: web (the dashboard), api (an API key, a local install of this server included), mcp (the hosted MCP server), llm-gateway, extension or agent.'),
        agent: z.string().trim().min(1).max(200).optional()
          .describe('Scope agent: the deployed agent, by name or guid. Its rule also covers the chat model it answers with.'),
        everything_else: z.enum(['allow', 'block']).optional()
          .describe('What every model the rule names neither by category nor by name gets. allow: every model except what the rule blocks; block: only what the rule allows. update keeps it when left out; replace and a new rule default to allow.'),
        categories: z.array(z.object({
          category: z.enum(CATEGORY_KEYS),
          access: z.enum(['allow', 'block', 'unset']),
        })).max(CATEGORY_KEYS.length).optional()
          .describe('Categories: image, video, audio, music, 3d, llm, utilities. A category also covers models added to it later; within a rule a model\'s own entry wins, then a block among its categories. unset, with update only, takes the entry out.'),
        models: z.array(z.object({
          model: z.string().trim().min(1).max(200).describe('owner/slug as search_models shows it, or the model\'s id.'),
          access: z.enum(['allow', 'block', 'unset']),
        })).max(MAX_MODELS_PER_CALL).optional()
          .describe(`Single models, up to ${MAX_MODELS_PER_CALL} a call (a rule holds up to ${MAX_RULE_MODELS}). unset, with update only, takes the entry out.`),
        rule_guid: z.string().trim().min(1).max(64).optional()
          .describe('The rule\'s guid from get_controls, in place of scope and its target.'),
        confirm: z.boolean().default(false)
          .describe('Set true only by repeating the change summary\'s nextAction, after the user approved that summary.'),
        updated_at: z.number().int().min(0).optional()
          .describe('From the change summary\'s nextAction: the version of the rule the user saw. Never set it yourself.'),
        summary_id: summaryIdSchema,
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Repeating a change asks for the same rule again, which changes nothing.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        checkArguments(args);
        let list: RuleList;
        try {
          list = await readRuleList(client, extra.signal);
        } catch (error) {
          if (extra.signal.aborted) throw error;
          throw readFailure('The Model Access rules', error);
        }
        // Wiro says whether it would take a change from this connection: a member gets the refusal here.
        if (list.workspace.canManage === false) return refusedResult(args.action, list.workspace);
        // List's caller came in the same Wiro API release as Preview: without it there is no change summary, so no change.
        if (!list.caller) throw new Error(previewMissingText('model-access'));
        return args.action === 'remove'
          ? await removeRule(client, args, list, extra.signal)
          : await changeRule(client, args, list, extra.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

