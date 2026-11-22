import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  errorResult,
  errorText,
  isPlainObject,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  amountPerPeriod,
  alertText,
  capitalized,
  cents,
  changeFailure,
  checkTargetArguments,
  confirmLead,
  confirmState,
  CONTROL_SCOPES,
  cannotChangeText,
  controlsPageUrl,
  isThisConnection,
  isUsedUp,
  leftOf,
  limitView,
  limitViewSchema,
  NOTHING_CHANGED,
  PERIODS,
  periodWord,
  previewFailure,
  previewMissingText,
  readFailure,
  readLimitList,
  resetText,
  resolveTarget,
  soFarLabel,
  spendingText,
  summaryId,
  summaryIdSchema,
  SURFACES,
  targetArgument,
  targetText,
  toLimitRow,
  usd,
  utcText,
  versionOf,
  type ControlScope,
  type ControlsWorkspace,
  type LimitList,
  type LimitRow,
  type Period,
  type ResolvedTarget,
  type Surface,
} from '../utils/controls.js';
import { jsonSpan, quotedSpan } from '../utils/quoted-text.js';
import { nextActionSchema, strictInput } from './schemas.js';

const MAX_AMOUNT_USD = 10_000_000;
const DEFAULT_ALERT = 80;

const SET_UNKNOWN = 'The outcome is not known: the limit may or may not have changed. get_controls shows the limit as it '
  + 'is now, and repeating this same call is safe, since it sets the same values.';
const REMOVE_UNKNOWN = 'The outcome is not known: the limit may or may not be removed. get_controls shows whether it is '
  + 'still there, and repeating this same call is safe.';
const ASK_REASON = 'Ask the user to confirm this change first.';
const APPLIES_NOTE =
  'It applies to new work from now on. Work already running finishes and is charged, except a realtime session or a voice call, which ends after the turn that uses the limit up.';
// An agent's own limit also stops the turn it is in: it is checked again at each of the agent's steps.
const AGENT_APPLIES_NOTE = 'It applies from now on. Once it is used up, the agent pauses at its next step, even in the '
  + 'middle of a reply, a voice call it is on ends after the current turn, and its scheduled tasks pause, until the limit '
  + 'resets or is raised.';

interface Args {
  action: 'set' | 'remove';
  scope?: ControlScope;
  member?: string;
  project?: string;
  surface?: Surface;
  agent?: string;
  period?: Period;
  amount_usd?: number;
  alert_percent?: 50 | 80 | 90 | null;
  limit_guid?: string;
  confirm: boolean;
  updated_at?: number;
  summary_id?: string;
}

type Outcome = 'preview' | 'saved' | 'removed' | 'unchanged' | 'refused';

interface Located {
  target: ResolvedTarget;
  period: Period;
  existing: LimitRow | null;
  /** The target's limit of the other period, which stays as it is. */
  other: LimitRow | null;
}

const outputSchema = {
  action: z.enum(['set', 'remove']),
  outcome: z.enum(['preview', 'saved', 'removed', 'unchanged', 'refused'])
    .describe('preview: a change summary, nothing changed yet. saved or removed: done. unchanged: it was already so. refused: this connection cannot change spend limits.'),
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
  period: z.enum(PERIODS).optional(),
  before: limitViewSchema.nullable().describe('The limit before the change; null when there was none.'),
  after: limitViewSchema.nullable().describe('The limit after the change; null for a removal.'),
  usedUpAtOnce: z.boolean().optional().describe('True when this period\'s spending already reaches the new amount, so new work it covers is refused at once.'),
  changedSinceSummary: z.boolean().optional().describe('True when the limit changed after the summary the user saw: this is a new summary, and nothing was saved.'),
  alertRecipients: z.string().optional().describe('Who gets the alert email and the email when the limit is used up.'),
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
  message: z.string(),
  dashboardUrl: z.string(),
  nextAction: nextActionSchema.optional(),
};

function inputError(text: string): Error {
  return new Error(`${text} ${NOTHING_CHANGED}`);
}

function sameLimit(row: LimitRow, amountUsd: number, alertPercent: number | null): boolean {
  return Math.abs(row.amountUsd - amountUsd) < 0.005 && row.alertPercent === alertPercent;
}

function sameTarget(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function limitPhrase(row: Pick<LimitRow, 'period' | 'amountUsd'>, target: string): string {
  return `the ${periodWord(row.period)} limit of ${usd(row.amountUsd)} for ${target}`;
}

/** Who hears about a limit: the account, or a team's managers and the person it is for. */
function alertRecipients(kind: ControlsWorkspace['kind'], target: ResolvedTarget): string {
  if (kind !== 'team') return 'the account\'s e-mail';
  const managers = 'the team\'s admins and the organization\'s owner';
  if (target.scope === 'member') return `${managers}, and ${target.targetName ? quotedSpan(target.targetName) : 'the member'}`;
  if (target.scope === 'project') return `${managers}, and the person who created the key`;
  if (target.scope === 'agent') return `${managers}, and the person who deployed the agent`;
  return managers;
}

function emailLine(alertPercent: number | null, recipients: string): string {
  return alertPercent === null
    ? `**Emails:** no alert before the limit is used up; an email when it is used up goes to ${recipients}`
    : `**Emails:** an alert at ${alertPercent}% and an email when the limit is used up go to ${recipients}`;
}

function nextLine(nextAction: { tool: string; arguments: Record<string, unknown>; reason: string } | undefined): string[] {
  return nextAction ? ['', `**Next:** \`${nextAction.tool}\` with ${jsonSpan(nextAction.arguments)}. ${nextAction.reason}`] : [];
}

function bullets(warnings: string[], notes: string[]): string[] {
  const all = [...warnings.map(warning => `Warning: ${warning}`), ...notes];
  return all.length > 0 ? ['', ...all.map(line => `- ${line}`)] : [];
}

function targetView(target: ResolvedTarget) {
  return {
    scope: target.scope,
    ...(target.scope !== 'account' ? { target: target.target } : {}),
    ...(target.targetName ? { targetName: target.targetName } : {}),
    ...(target.thisConnection ? { thisConnection: true } : {}),
  };
}

/** Where a limit's runs meet this connection: its own key, the surface it counts as, or the whole wallet. */
function connectionNote(target: ResolvedTarget): string | null {
  if (target.scope === 'project' && target.thisConnection) {
    return 'This is the key this connection uses: once the limit is used up, this connection\'s runs stop too until it resets.';
  }
  if (target.scope === 'surface' && target.thisConnection) {
    return 'This connection counts as this surface: once the limit is used up, this connection\'s runs stop too until it resets.';
  }
  if (target.scope === 'account') return 'It covers this connection\'s runs too.';
  return null;
}

function result(structured: Record<string, unknown>, lines: string[]) {
  return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: structured };
}

function refusedResult(action: Args['action'], workspace: ControlsWorkspace) {
  const message = cannotChangeText(workspace, 'spend limits', 'spend-limits');
  return result({
    action,
    outcome: 'refused' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: false },
    before: null,
    after: null,
    warnings: [],
    notes: [],
    message,
    dashboardUrl: controlsPageUrl('spend-limits', workspace),
  }, ['## Not changed', '', message]);
}

/** The limit a call names, and its period: from limit_guid, or from the scope and its target. */
async function locate(client: WiroClient, args: Args, list: LimitList, signal: AbortSignal): Promise<Located | string> {
  if (args.limit_guid) {
    const row = list.limits.find(candidate => candidate.guid === args.limit_guid);
    if (!row) return `No limit with limit_guid ${quotedSpan(args.limit_guid)} is in this workspace.`;
    const fields = (['member', 'project', 'surface', 'agent'] as const).filter(field => args[field] !== undefined);
    const conflict = (args.scope !== undefined && args.scope !== row.scope)
      || (args.period !== undefined && args.period !== row.period)
      || fields.some(field => field !== row.scope
        || (!sameTarget(String(args[field]).trim(), row.target) && !sameTarget(String(args[field]).trim(), row.targetName ?? '')));
    if (conflict) {
      throw inputError(`limit_guid already names ${limitPhrase(row, targetText(row, list.workspace.kind))}: leave out scope, `
        + 'its target and period, or name the same ones. To add a limit of the other period, name scope and target with that period instead.');
    }
    const target: ResolvedTarget = {
      scope: row.scope,
      target: row.target,
      ...(row.targetName ? { targetName: row.targetName } : {}),
      thisConnection: isThisConnection(row.scope, row.target, list.caller),
    };
    const other = list.limits.find(candidate => candidate !== row && candidate.scope === row.scope && sameTarget(candidate.target, row.target)) ?? null;
    return { target, period: row.period, existing: row, other };
  }

  const scope = args.scope as ControlScope;
  let target: ResolvedTarget;
  try {
    target = await resolveTarget(client, { ...args, scope }, list, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw inputError(errorText(error));
  }
  const onTarget = list.limits.filter(row => row.scope === target.scope && sameTarget(row.target, target.target));
  const named = onTarget.find(row => row.targetName)?.targetName;
  if (!target.targetName && named) target.targetName = named;
  let period = args.period;
  if (!period) {
    const periods = [...new Set(onTarget.map(row => row.period))];
    if (periods.length > 1) {
      throw inputError(`${capitalized(targetText(target, list.workspace.kind))} has a monthly and a daily limit: say which one with period.`);
    }
    period = periods[0] ?? 'month';
  }
  const existing = onTarget.find(row => row.period === period) ?? null;
  const other = onTarget.find(row => row.period !== period) ?? null;
  return { target, period, existing, other };
}

interface PreviewAnswer {
  limit: LimitRow;
  /** The limit Set would replace; null for none, undefined when the answer left it out. */
  existing: LimitRow | null | undefined;
}

async function previewLimit(client: WiroClient, body: Record<string, unknown>, workspace: ControlsWorkspace, signal: AbortSignal): Promise<PreviewAnswer> {
  let answer: ApiEnvelope & { preview?: unknown; limit?: unknown; existing?: unknown };
  try {
    answer = requireApiSuccess(
      await client.post<ApiEnvelope & { preview?: unknown; limit?: unknown; existing?: unknown }>('/SpendLimit/Preview', body, signal),
      'The change summary could not be made.',
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw previewFailure(error, 'spend-limits', workspace);
  }
  const limit = isPlainObject(answer.limit) ? toLimitRow(answer.limit) : null;
  // Only an answer that says it is a preview proves nothing was written.
  if (answer.preview !== true || !limit) throw new Error(previewMissingText('spend-limits', workspace));
  const existing = isPlainObject(answer.existing) ? toLimitRow(answer.existing) : answer.existing === null ? null : undefined;
  return { limit, existing };
}

async function setLimit(client: WiroClient, args: Args, list: LimitList, signal: AbortSignal) {
  const { workspace, caller } = list;
  const dashboardUrl = controlsPageUrl('spend-limits', workspace);
  const located = await locate(client, args, list, signal);
  if (typeof located === 'string') throw inputError(`${located} get_controls lists the limits with their guids.`);
  const { target, period, other } = located;
  const covers = () => targetText(target, workspace.kind);
  // Only the alert given: the limit keeps its amount.
  if (args.amount_usd === undefined && !located.existing) {
    throw inputError(`There is no ${periodWord(period)} limit for ${covers()} yet, so set needs amount_usd: the limit in USD.`);
  }
  const amount = args.amount_usd !== undefined ? cents(args.amount_usd) : (located.existing as LimitRow).amountUsd;
  const alert = args.alert_percent !== undefined ? args.alert_percent : located.existing ? located.existing.alertPercent : DEFAULT_ALERT;

  const unchanged = (row: LimitRow) => {
    const message = `${capitalized(limitPhrase(row, covers()))} is already set, with ${alertText(row.alertPercent)}. ${NOTHING_CHANGED}`;
    return result({
      action: 'set',
      outcome: 'unchanged' satisfies Outcome,
      workspace: { kind: workspace.kind, canManage: true },
      target: targetView(target),
      period,
      before: limitView(row, caller),
      after: limitView(row, caller),
      warnings: [],
      notes: [],
      message,
      dashboardUrl,
    }, ['## Nothing to change', '', message]);
  };
  if (located.existing && sameLimit(located.existing, amount, alert)) return unchanged(located.existing);

  const body = { scope: target.scope, target: target.target, period, amountusd: amount, alertpct: alert };
  const preview = await previewLimit(client, body, workspace, signal);
  // The preview reads the limit afresh, so its answer wins over the list read before it.
  const before = preview.existing !== undefined ? preview.existing : located.existing;
  if (!target.targetName && (preview.limit.targetName || before?.targetName)) target.targetName = preview.limit.targetName ?? before?.targetName;
  if (before && sameLimit(before, amount, alert)) return unchanged(before);
  const after = preview.limit;

  const version = versionOf(before);
  const id = summaryId(client, { tool: 'manage_spend_limit', action: 'set', ...body, version });
  const nextAction = {
    tool: 'manage_spend_limit',
    arguments: {
      action: 'set',
      scope: target.scope,
      ...targetArgument(target.scope, target.target),
      period,
      amount_usd: amount,
      alert_percent: alert,
      confirm: true,
      updated_at: version,
      summary_id: id,
    },
    reason: ASK_REASON,
  };
  const recipients = alertRecipients(workspace.kind, target);
  const usedUpAtOnce = isUsedUp(after);
  const warnings: string[] = [];
  if (usedUpAtOnce) {
    warnings.push(`It is used up at once: ${usd(after.spentUsd)} was already spent this ${period}, so new work it covers is refused until it ${resetText(after)}.`);
  } else if (leftOf(after) === 0) {
    warnings.push('Nothing is left at once: work that is still running holds the rest, so new work it covers is refused until that work ends or the limit resets.');
  }
  const notes: string[] = [];
  if (args.amount_usd !== undefined && Math.abs(args.amount_usd - amount) > 1e-9) notes.push(`The amount is rounded to cents: ${usd(amount)}.`);
  if (args.amount_usd === undefined) notes.push(`The amount stays ${usd(amount)}.`);
  if (!before && after.periodStart) {
    notes.push(`It counts all of this ${period}'s spending since ${utcText(after.periodStart)}, also what was spent before the limit was set.`);
  }
  const connection = connectionNote(target);
  if (connection) notes.push(connection);
  if (other) notes.push(`${capitalized(limitPhrase(other, 'the same target'))} stays as it is, and both apply.`);
  if (before && before.alertPercent !== null && alert === null) notes.push('No alert email goes out before the limit is used up.');

  const state = confirmState(args, version, id);
  if (state !== 'confirmed') {
    const changedSinceSummary = state === 'changed';
    const lead = confirmLead(state, 'limit');
    const message = lead ?? `Set ${amountPerPeriod(amount, period)} for ${covers()}? Nothing has changed yet.`;
    const lines = [
      changedSinceSummary ? '## The limit changed since the summary (nothing saved)' : '## Set a spend limit? (nothing changed yet)',
      '',
      ...(lead ? [lead, ''] : []),
      `**Covers:** ${covers()}`,
      `**Before:** ${before ? `${amountPerPeriod(before.amountUsd, before.period)}, ${alertText(before.alertPercent)}` : `no ${periodWord(period)} limit`}`,
      `**After:** ${amountPerPeriod(amount, period)}, ${alertText(alert)}`,
      `**${soFarLabel(period)}:** ${spendingText(after)}; ${resetText(after)}`,
      emailLine(alert, recipients),
      ...bullets(warnings, notes),
      '',
      'Nothing has changed yet. Show this to the user and wait for a clear yes.',
      ...nextLine(nextAction),
    ];
    return result({
      action: 'set',
      outcome: 'preview' satisfies Outcome,
      workspace: { kind: workspace.kind, canManage: true },
      target: targetView(target),
      period,
      before: before ? limitView(before, caller) : null,
      after: limitView(after, caller),
      usedUpAtOnce,
      ...(changedSinceSummary ? { changedSinceSummary: true } : {}),
      alertRecipients: recipients,
      warnings,
      notes,
      message,
      dashboardUrl,
      nextAction,
    }, lines);
  }

  let saved: ApiEnvelope & { limit?: unknown };
  try {
    saved = requireApiSuccess(
      await client.post<ApiEnvelope & { limit?: unknown }>('/SpendLimit/Set', body, signal),
      'The limit could not be saved.',
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw changeFailure(error, 'spend-limits', SET_UNKNOWN, workspace);
  }
  const row = (isPlainObject(saved.limit) ? toLimitRow(saved.limit) : null) ?? after;
  const message = `Saved: ${amountPerPeriod(row.amountUsd, row.period)} for ${covers()}, ${alertText(row.alertPercent)}.`;
  const savedNotes = [target.scope === 'agent' ? AGENT_APPLIES_NOTE : APPLIES_NOTE, ...(connection ? [connection] : [])];
  return result({
    action: 'set',
    outcome: 'saved' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: true },
    target: targetView(target),
    period,
    before: before ? limitView(before, caller) : null,
    after: limitView(row, caller),
    usedUpAtOnce: isUsedUp(row),
    alertRecipients: recipients,
    warnings: isUsedUp(row) ? [`It is used up already: new work it covers is refused until it ${resetText(row)}.`] : [],
    notes: savedNotes,
    message,
    dashboardUrl,
  }, [
    '## Spend limit saved',
    '',
    `**Covers:** ${covers()}`,
    `**Limit:** ${amountPerPeriod(row.amountUsd, row.period)}, ${alertText(row.alertPercent)}`,
    `**${soFarLabel(row.period)}:** ${spendingText(row)}; ${resetText(row)}`,
    ...bullets(isUsedUp(row) ? [`It is used up already: new work it covers is refused until it ${resetText(row)}.`] : [], savedNotes),
  ]);
}

/** The limits that still apply once one is removed: its target's other period and the whole wallet's. */
function stillApplyNote(row: LimitRow, list: LimitList): string | null {
  const kind = list.workspace.kind;
  const others = list.limits.filter(candidate => candidate !== row && candidate.guid !== row.guid
    && ((candidate.scope === row.scope && sameTarget(candidate.target, row.target)) || (candidate.scope === 'account' && row.scope !== 'account')));
  if (others.length === 0) return null;
  return `Still in place: ${others.map(candidate => limitPhrase(candidate, targetText(candidate, kind))).join('; ')}.`;
}

async function removeLimit(client: WiroClient, args: Args, list: LimitList, signal: AbortSignal) {
  const { workspace, caller } = list;
  const dashboardUrl = controlsPageUrl('spend-limits', workspace);
  const located = await locate(client, args, list, signal);
  const nothing = (text: string) => result({
    action: 'remove',
    outcome: 'unchanged' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: true },
    ...(typeof located === 'string' ? {} : { target: targetView(located.target), period: located.period }),
    before: null,
    after: null,
    warnings: [],
    notes: [],
    message: text,
    dashboardUrl,
  }, ['## Nothing to remove', '', text]);
  if (typeof located === 'string') return nothing(`${located} It may be removed already; get_controls lists the limits. ${NOTHING_CHANGED}`);
  const row = located.existing;
  const covers = targetText(located.target, workspace.kind);
  if (!row) return nothing(`There is no ${periodWord(located.period)} limit for ${covers}, so there is nothing to remove. ${NOTHING_CHANGED}`);
  if (!row.guid) throw inputError('Wiro did not give this limit\'s guid, so it cannot be removed here. It can be removed on the Spend Limits page of the Wiro dashboard.');

  const stillApply = stillApplyNote(row, list);
  const notes = [...(stillApply ? [stillApply] : [])];
  const version = versionOf(row);
  const id = summaryId(client, { tool: 'manage_spend_limit', action: 'remove', guid: row.guid, version });
  const state = confirmState(args, version, id);
  if (state !== 'confirmed') {
    const changedSinceSummary = state === 'changed';
    const lead = confirmLead(state, 'limit');
    const nextAction = {
      tool: 'manage_spend_limit',
      arguments: { action: 'remove', limit_guid: row.guid, confirm: true, updated_at: version, summary_id: id },
      reason: ASK_REASON,
    };
    notes.push('Once it is removed, work it refused can start again at once.');
    const message = lead ?? `Remove ${limitPhrase(row, covers)}? Nothing has changed yet.`;
    return result({
      action: 'remove',
      outcome: 'preview' satisfies Outcome,
      workspace: { kind: workspace.kind, canManage: true },
      target: targetView(located.target),
      period: row.period,
      before: limitView(row, caller),
      after: null,
      ...(changedSinceSummary ? { changedSinceSummary: true } : {}),
      warnings: [],
      notes,
      message,
      dashboardUrl,
      nextAction,
    }, [
      changedSinceSummary ? '## The limit changed since the summary (nothing removed)' : '## Remove a spend limit? (nothing changed yet)',
      '',
      ...(lead ? [lead, ''] : []),
      `**Limit:** ${limitPhrase(row, covers)}, ${alertText(row.alertPercent)}`,
      `**${soFarLabel(row.period)}:** ${spendingText(row)}; ${resetText(row)}`,
      ...bullets([], notes),
      '',
      'Nothing has changed yet. Show this to the user and wait for a clear yes.',
      ...nextLine(nextAction),
    ]);
  }

  try {
    requireApiSuccess(await client.post<ApiEnvelope>('/SpendLimit/Remove', { guid: row.guid }, signal), 'The limit could not be removed.');
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ApiResultError && /limit not found in this workspace/i.test(error.message)) {
      return nothing(`${capitalized(limitPhrase(row, covers))} is not there any more: it was removed already. ${NOTHING_CHANGED}`);
    }
    throw changeFailure(error, 'spend-limits', REMOVE_UNKNOWN, workspace);
  }
  const removedNotes = ['Work it refused can start again at once.', ...(stillApply ? [stillApply] : [])];
  const message = `Removed ${limitPhrase(row, covers)}.`;
  return result({
    action: 'remove',
    outcome: 'removed' satisfies Outcome,
    workspace: { kind: workspace.kind, canManage: true },
    target: targetView(located.target),
    period: row.period,
    before: limitView(row, caller),
    after: null,
    warnings: [],
    notes: removedNotes,
    message,
    dashboardUrl,
  }, ['## Spend limit removed', '', message, ...bullets([], removedNotes)]);
}

/** Refusals that need no call: arguments that do not fit together. */
function checkArguments(args: Args): void {
  if (args.action === 'set' && args.amount_usd === undefined && args.alert_percent === undefined) {
    throw inputError('set needs amount_usd (the limit in USD), or alert_percent alone to change only the alert of a limit that exists.');
  }
  if (args.action === 'set' && args.amount_usd !== undefined && cents(args.amount_usd) < 0.01) throw inputError('amount_usd must be at least $0.01.');
  if (args.action === 'remove' && (args.amount_usd !== undefined || args.alert_percent !== undefined)) {
    throw inputError('remove takes no amount_usd or alert_percent.');
  }
  if (!args.limit_guid && !args.scope) {
    throw inputError('Name the limit: scope with its target (member, project, surface or agent), or limit_guid from get_controls.');
  }
  try {
    if (!args.limit_guid) checkTargetArguments(args);
  } catch (error) {
    throw inputError(errorText(error));
  }
}

export function registerManageSpendLimit(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'manage_spend_limit',
    {
      title: 'Set or remove a Wiro spend limit',
      description: 'Set (add or change) or remove one spend limit of the connected project\'s workspace: a monthly or '
        + 'daily USD cap on the whole wallet (account), one team member, one API key (project), one way in (surface) or one '
        + 'agent. A limit counts the whole period in UTC, also what was spent before it was set, and once it is reached new '
        + 'work it covers is refused with error code 93. Each target can have one monthly and one daily limit. Only the '
        + 'account owner, a team admin or the organization\'s owner can change limits; for anyone else this changes nothing. '
        + 'Without `confirm: true` it returns a change summary: what the limit covers, its value before and after, what was '
        + 'spent this period and when it resets. Show it, wait for a clear yes, then repeat the call exactly as its '
        + 'nextAction shows. If the limit changed in between, or the call asks for anything else, nothing is saved and a '
        + 'new summary comes back. To change only the alert, give limit_guid and alert_percent.',
      inputSchema: strictInput({
        action: z.enum(['set', 'remove'])
          .describe('set adds a limit, or changes the one with the same scope, target and period; remove deletes one.'),
        scope: z.enum(CONTROL_SCOPES).optional()
          .describe('What the limit caps: account (the whole wallet), member (one team member), project (one API key), surface (one way in) or agent (one deployed agent). Needed unless limit_guid names the limit.'),
        member: z.string().trim().min(1).max(320).optional()
          .describe('Scope member, teams only: the member, by e-mail or user id.'),
        project: z.string().trim().min(1).max(200).optional()
          .describe('Scope project: the API key\'s project, by id or exact name. Left out, this connection\'s own key.'),
        surface: z.enum(SURFACES).optional()
          .describe('Scope surface: web (the dashboard), api (an API key, a local install of this server included), mcp (the hosted MCP server), llm-gateway, extension, agent (deployed agents\' own runs), studio (messages to Studio and the models it runs), workflow-agent (messages to the Workflow Agent) or workflow (workflow runs and their steps, unless an agent, Studio or the Workflow Agent started them).'),
        agent: z.string().trim().min(1).max(200).optional()
          .describe('Scope agent: the deployed agent, by name or guid.'),
        period: z.enum(PERIODS).optional()
          .describe('month (from the 1st, 00:00 UTC) or day (from 00:00 UTC). Left out, the period of the target\'s only limit, and month for a new one.'),
        amount_usd: z.number().positive().max(MAX_AMOUNT_USD).optional()
          .describe('set: the limit in USD, at least 0.01, rounded to cents. Left out with alert_percent, a limit keeps its amount.'),
        alert_percent: z.union([z.literal(50), z.literal(80), z.literal(90)]).nullable().optional()
          .describe('set: when the alert email goes out, at 50, 80 or 90 percent of the limit; null for no alert. Left out, a limit keeps its alert, and a new one gets 80.'),
        limit_guid: z.string().trim().min(1).max(64).optional()
          .describe('The limit\'s guid from get_controls, in place of scope, its target and period.'),
        confirm: z.boolean().default(false)
          .describe('Set true only by repeating the change summary\'s nextAction, after the user approved that summary.'),
        updated_at: z.number().int().min(0).optional()
          .describe('From the change summary\'s nextAction: the version of the limit the user saw. Never set it yourself.'),
        summary_id: summaryIdSchema,
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Repeating a change sets the same values again, which changes nothing.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        checkArguments(args);
        let list: LimitList;
        try {
          list = await readLimitList(client, extra.signal);
        } catch (error) {
          if (extra.signal.aborted) throw error;
          throw readFailure('The spend limits', error);
        }
        // Wiro says whether it would take a change from this connection: a member gets the refusal here.
        if (list.workspace.canManage === false) return refusedResult(args.action, list.workspace);
        // List's caller came in the same Wiro API release as Preview: without it there is no change summary, so no change.
        if (!list.caller) throw new Error(previewMissingText('spend-limits', list.workspace));
        return args.action === 'remove'
          ? await removeLimit(client, args, list, extra.signal)
          : await setLimit(client, args, list, extra.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

