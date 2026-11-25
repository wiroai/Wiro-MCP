import crypto from 'node:crypto';
import type { WiroClient } from '../client.js';
import {
  AGENT_NOT_FOUND_TEXT,
  ApiResultError,
  asString,
  hasErrorCode,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  truncate,
  unixToIso,
  type ApiEnvelope,
} from './api.js';
import {
  centsToUsd,
  credentialKeysSetupWaitsFor,
  nameList,
  skillLabel,
  STARTER_TASK_KEY,
  toSkillGroups,
  WIRO_PROJECT_CREDENTIAL,
  wordsFromKey,
} from './user-agent.js';
import { CONNECTOR_SLUG } from './agent-connectors.js';

// Helpers for configuring a deployed agent: its registry skills, its credentials
// (chat channels, Twilio Voice, settings and the Wiro project) and its custom
// skills. Outside services are connectors (agent-connectors.ts). The pure functions mirror the server
// rules closely so a bad request is caught before anything is written.

export const DEFAULT_CRON_INTERVAL = '0 10 * * 1';
const REGISTRY_TTL_MS = 5 * 60_000;

type Row = Record<string, unknown>;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => asString(item)).filter((item): item is string => !!item)
    : [];
}

export function formatUsd(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Agent row
// ---------------------------------------------------------------------------

export const AGENT_STATUS_LABELS: Record<number, string> = {
  0: 'stopped',
  1: 'stopping',
  2: 'queued',
  3: 'starting',
  4: 'running',
  5: 'error',
  6: 'setup required',
};

export function agentStatusLabel(status: number | null): string {
  return status !== null && AGENT_STATUS_LABELS[status] ? AGENT_STATUS_LABELS[status] : 'unknown';
}

/** Whether the agent is starting or running: a configuration write acts on it at once only then. */
export function isAgentRunning(status: number | null): boolean {
  return status === 3 || status === 4;
}

/**
 * A change Wiro applied to the running agent with no restart, as its answer says (live: true, or restart "live"). It
 * names no direction, so it also reads right for a change that takes something away.
 */
export const LIVE_CHANGE_NOTE = 'The running agent has the change from its next message, with no restart.';

/** A live change that gives the running agent something it uses: a connector connected, a custom skill turned on. */
export const LIVE_ADDED_NOTE = 'The running agent uses it from its next message, with no restart.';

/** A live change that takes something away: a connector disconnected, a custom skill turned off or deleted. */
export const LIVE_REMOVED_NOTE = 'The running agent stops using it from its next message, with no restart.';

/**
 * The live sentence for a change to one custom skill or scheduled task, from whether its switch is on before and after
 * the change (a new entry is off before it, a deleted one off after it). A scheduled task runs on its own time, not
 * at the agent's next message.
 */
export function liveEntryNote(kind: CustomSkillKind, onBefore: boolean, onAfter: boolean): string {
  if (kind === 'scheduled_task') {
    if (onAfter) return 'The running agent has the change with no restart; it applies from the task\'s next run.';
    return onBefore
      ? 'The running agent has the change with no restart; the task stops running.'
      : 'The running agent has the change with no restart.';
  }
  if (onAfter) return LIVE_ADDED_NOTE;
  return onBefore ? LIVE_REMOVED_NOTE : LIVE_CHANGE_NOTE;
}

/**
 * Before a change that can reach a running agent with no restart. Wiro decides when it applies it: most go live, the
 * few that need a restart (or a live change that cannot finish) restart the agent.
 */
export const LIVE_OR_RESTART_NOTE = 'A running agent gets most changes without a restart; a few restart it, which takes about a minute.';

/** Whether Wiro's answer says a running agent got the change with no restart. */
export function answeredLive(body: { live?: unknown; restart?: unknown }): boolean {
  return body.live === true || body.restart === 'live';
}

/**
 * What a change does to the agent, by its status before the change. A change Wiro's answer says the running agent
 * got with no restart takes a live sentence instead.
 */
export function restartNote(status: number | null, what = 'change'): string {
  switch (status) {
    case 3:
    case 4:
      return `The agent restarts to load the ${what}, which takes about a minute. Follow it with get_my_agent.`;
    case 1:
      return `The agent is already stopping or restarting; it loads the ${what} when it starts again.`;
    case 2:
      return `The agent is queued to start and loads the ${what} when it does.`;
    case 6:
      return `The agent still needs setup; the ${what} takes effect once it starts.`;
    case 0:
      return `The agent is stopped, so the ${what} takes effect the next time it starts.`;
    case 5:
      return `The agent stopped with an error, so the ${what} takes effect the next time it starts.`;
    default:
      return `The ${what} takes effect the next time the agent starts.`;
  }
}

export function keyList(keys: string[]): string {
  return keys.length > 1 ? `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}` : keys.join('');
}

function afterWriteNote(status: number | null): string {
  switch (status) {
    case 1:
      return 'The agent restarts to load the new values, which takes about a minute.';
    case 2:
    case 3:
      return 'The agent is starting and loads the new values.';
    case 4:
      // A save that changes a value sets a running agent stopping before Wiro answers.
      return 'The agent kept running: a save that matches what is stored does not restart it. If it should load new values now, control_agent with action restart does it.';
    case 6:
      return 'The agent still needs setup before it can start; get_my_agent shows what is missing.';
    case 5:
      return 'The agent stopped with an error; the values are used when it starts.';
    case null:
      return 'Check the agent with get_my_agent.';
    default:
      return `The agent is ${agentStatusLabel(status)}; the values are used when it starts.`;
  }
}

/** What the setup still waits for and the tool that gives each one: a Wiro project or saved fields. */
export function setupStillMissingNote(missing: Array<{ key: string; title: string }>): string | null {
  if (missing.length === 0) return null;
  const titles = (items: typeof missing) => items.map(item => item.title);
  const isProject = (item: typeof missing[number]) => item.key === WIRO_PROJECT_CREDENTIAL;
  const steps = [
    { verb: 'Set', names: titles(missing.filter(item => !isProject(item))), tool: 'set_agent_credentials' },
    { verb: 'Connect', names: titles(missing.filter(isProject)), tool: 'bind_agent_project' },
  ].filter(step => step.names.length > 0);
  const first = steps[0];
  const how = steps.length === 1 && first
    ? `${first.verb} ${first.names.length > 1 ? 'them' : 'it'} with ${first.tool}`
    : steps.map((step, index) => `${index === 0 ? step.verb : step.verb.toLowerCase()} ${keyList(step.names)} with ${step.tool}`).join(', ');
  return `Setup is not finished: still missing ${keyList(titles(missing))}. ${how}, then check with get_my_agent.`;
}

/** When the agent loads the values, and the credentials its setup still waits for, at any status. */
export function afterWriteNotes(
  status: number | null,
  missing: Array<{ key: string; title: string }>,
): string[] {
  const note = afterWriteNote(status);
  const setup = setupStillMissingNote(missing);
  if (!setup) return [note];
  // At status 6 the general note says the same without the names.
  return status === 6 ? [setup] : [note, setup];
}

export async function readUserAgent(
  client: WiroClient,
  agentGuid: string,
  signal?: AbortSignal,
): Promise<Row> {
  const body = requireApiSuccess(
    await client.post<ApiEnvelope & { useragents?: unknown[] }>('/UserAgent/Detail', { guid: agentGuid }, signal),
    'Could not read the agent.',
  );
  const row = Array.isArray(body.useragents) ? body.useragents[0] : undefined;
  if (!isPlainObject(row)) throw new Error(AGENT_NOT_FOUND_TEXT);
  return row;
}

export function agentStatusOf(row: Row): number | null {
  return toNumber(row.status);
}

/** Names of the registry skills that are on. Detail lists only enabled skills. */
export function enabledSkillNames(row: Row): string[] {
  if (!Array.isArray(row.skills)) return [];
  return row.skills
    .map(skill => (isPlainObject(skill)
      ? (skill.enabled === false ? undefined : asString(skill.name))
      : asString(skill)))
    .filter((name): name is string => !!name);
}

export function isCustomBuild(row: Row): boolean {
  return isPlainObject(row.agent) && row.agent.custom === true;
}

// ---------------------------------------------------------------------------
// Registry reads (anonymous, identical for every caller, so cached briefly)
// ---------------------------------------------------------------------------

const registryCache = new WeakMap<object, Map<string, { at: number; value: unknown }>>();

async function cachedRead<T>(owner: object, key: string, load: () => Promise<T>): Promise<T> {
  let entries = registryCache.get(owner);
  if (!entries) {
    entries = new Map();
    registryCache.set(owner, entries);
  }
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.value as T;
  const value = await load();
  entries.set(key, { at: Date.now(), value });
  return value;
}

export interface RegistrySkill {
  name: string;
  title: string;
  dependsOn: string[];
  conflictsWith: string[];
  deprecated: boolean;
  replacement?: string;
  requiresCredentials: boolean;
  credentialKeys: string[];
  /** The catalog connectors the skill works with (suggested_connectors). None connects by itself. */
  suggestedConnectors: string[];
}

export interface RegistryChannel {
  id: string;
  title: string;
  credentialKey: string;
}

export interface SkillRegistry {
  skills: Map<string, RegistrySkill>;
  channels: Map<string, RegistryChannel>;
}

export function parseSkillRegistry(body: Row): SkillRegistry {
  const skills = new Map<string, RegistrySkill>();
  for (const raw of Array.isArray(body.skills) ? body.skills : []) {
    if (!isPlainObject(raw)) continue;
    const name = asString(raw.name);
    if (!name) continue;
    const primary = asString(raw.credential_key);
    skills.set(name, {
      name,
      title: asString(raw.title) ?? name,
      dependsOn: stringList(raw.depends_on),
      conflictsWith: stringList(raw.conflicts_with),
      deprecated: raw.deprecated === true,
      ...(asString(raw.replacement) ? { replacement: asString(raw.replacement) } : {}),
      requiresCredentials: raw.requires_credentials === true,
      credentialKeys: [...(primary ? [primary] : []), ...stringList(raw.additional_credential_keys)],
      suggestedConnectors: [...new Set(stringList(raw.suggested_connectors).filter(slug => CONNECTOR_SLUG.test(slug)))],
    });
  }
  const channels = new Map<string, RegistryChannel>();
  for (const raw of Array.isArray(body.channels) ? body.channels : []) {
    if (!isPlainObject(raw)) continue;
    const id = asString(raw.id);
    if (!id) continue;
    channels.set(id, {
      id,
      title: asString(raw.title) ?? id,
      credentialKey: asString(raw.credential_key) ?? id,
    });
  }
  return { skills, channels };
}

/** The catalog title of every skill the registry lists that has one, for skillLabel. */
export function registryTitles(registry: SkillRegistry): Map<string, string> {
  return new Map([...registry.skills.values()].filter(skill => skill.title !== skill.name).map(skill => [skill.name, skill.title]));
}

export async function loadSkillRegistry(client: WiroClient, signal?: AbortSignal): Promise<SkillRegistry> {
  return cachedRead(client, 'skills', async () => parseSkillRegistry(requireApiSuccess(
    await client.post<ApiEnvelope & Row>('/Skills/List', {}, signal),
    'Could not read the skill list.',
  )));
}

/**
 * The catalog titles of these skills, so a text names them as people see them. The catalog is read only when
 * there is a name; the map is empty when there is none or the catalog cannot be read.
 */
export async function skillTitles(client: WiroClient, names: Iterable<string>, signal?: AbortSignal): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const wanted = new Set(names);
  if (wanted.size === 0) return titles;
  const registry = await loadSkillRegistry(client, signal).catch(() => null);
  for (const name of wanted) {
    const title = registry?.skills.get(name)?.title;
    if (title && title !== name) titles.set(name, title);
  }
  return titles;
}

/** The catalog titles of the skills these scheduled tasks are paused for (skillTitles). */
export async function pausedSkillTitles(
  client: WiroClient,
  tasks: ReadonlyArray<{ skillOff?: boolean; offSkills?: string[][] }>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  return skillTitles(client, tasks.filter(task => task.skillOff).flatMap(task => (task.offSkills ?? []).flat()), signal);
}

// ---------------------------------------------------------------------------
// Skill changes (apply_agent_skills)
// ---------------------------------------------------------------------------

export interface SkillPlan {
  /** Every skill the change sets, dependencies included. */
  requested: Record<string, boolean>;
  addedDependencies: string[];
  errors: string[];
}

function suggestSkills(name: string, registry: SkillRegistry): string[] {
  const tokens = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2));
  return [...registry.skills.keys()]
    .map(candidate => ({
      candidate,
      score: candidate.split('-').filter(token => tokens.has(token)).length,
    }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(entry => entry.candidate);
}

/**
 * Validates the requested names against the registry and, when asked, adds
 * the skills they depend on. The server refuses a change whose enabled set is
 * missing a dependency. Names are checked against the registry here, so only
 * known skills are sent.
 */
export function planSkillChanges(
  input: Record<string, boolean>,
  registry: SkillRegistry,
  addDependencies: boolean,
): SkillPlan {
  const errors = new Set<string>();
  const requested: Record<string, boolean> = {};
  const titles = registryTitles(registry);
  const label = (name: string) => skillLabel(name, titles);
  for (const [rawName, enabled] of Object.entries(input)) {
    const name = rawName.trim();
    if (!name) {
      errors.add('Skill names cannot be empty.');
      continue;
    }
    if (name.startsWith('cs-') || name.startsWith('cron-')) {
      errors.add(`"${name}" is a custom skill or scheduled task. Use manage_agent_custom_skill for it.`);
      continue;
    }
    const channel = registry.channels.get(name);
    if (channel) {
      errors.add(`"${name}" is a channel, not a skill. It turns on when its fields are filled with set_agent_credentials (credential "${channel.credentialKey}").`);
      continue;
    }
    const skill = registry.skills.get(name);
    if (!skill) {
      const suggestions = suggestSkills(name, registry);
      errors.add(`Unknown skill "${name}".${suggestions.length ? ` Did you mean ${suggestions.map(label).join(', ')}?` : ''} Use list_agent_skills for the full list. An outside service is a Connector, not a skill: list_agent_connectors lists them and connect_agent_connector connects one.`);
      continue;
    }
    if (enabled && skill.deprecated) {
      errors.add(`${label(name)} is retired and cannot be turned on${skill.replacement ? `. Use ${label(skill.replacement)} instead` : ''}.`);
      continue;
    }
    requested[name] = enabled;
  }

  const added: string[] = [];
  if (addDependencies) {
    const queue = Object.keys(requested).filter(name => requested[name]);
    while (queue.length > 0) {
      const name = queue.shift() as string;
      for (const dependency of registry.skills.get(name)?.dependsOn ?? []) {
        if (requested[dependency] === false) {
          errors.add(`${label(name)} needs ${label(dependency)}, which this change turns off. Keep ${label(dependency)} on, or leave ${label(name)} off.`);
          continue;
        }
        if (requested[dependency] === true || !registry.skills.has(dependency)) continue;
        requested[dependency] = true;
        added.push(dependency);
        queue.push(dependency);
      }
    }
  }
  return { requested, addedDependencies: added, errors: [...errors] };
}

export interface SkillDiff {
  changes: Record<string, boolean>;
  enable: string[];
  disable: string[];
  alreadySet: string[];
}

/** Only real changes are sent, since a skill change reaches a running agent, live or with a restart. */
export function diffSkills(requested: Record<string, boolean>, enabledNow: Iterable<string>): SkillDiff {
  const current = new Set(enabledNow);
  const diff: SkillDiff = { changes: {}, enable: [], disable: [], alreadySet: [] };
  for (const [name, enabled] of Object.entries(requested)) {
    if (enabled === current.has(name)) {
      diff.alreadySet.push(name);
      continue;
    }
    diff.changes[name] = enabled;
    (enabled ? diff.enable : diff.disable).push(name);
  }
  return diff;
}

/**
 * The same check the API runs before it writes: every skill that ends up on
 * needs its dependencies on, and no two conflicting skills may be on.
 */
export function checkSkillSet(
  enabledNow: Iterable<string>,
  changes: Record<string, boolean>,
  registry: SkillRegistry,
): { deps: Array<{ skill: string; requires: string }>; conflicts: Array<{ a: string; b: string }> } {
  const finalSet = new Set(enabledNow);
  for (const [name, enabled] of Object.entries(changes)) {
    if (enabled) finalSet.add(name);
    else finalSet.delete(name);
  }
  const deps: Array<{ skill: string; requires: string }> = [];
  const conflicts: Array<{ a: string; b: string }> = [];
  for (const name of finalSet) {
    const skill = registry.skills.get(name);
    if (!skill) continue;
    for (const dependency of skill.dependsOn) {
      if (!finalSet.has(dependency)) deps.push({ skill: name, requires: dependency });
    }
    for (const other of skill.conflictsWith) {
      if (finalSet.has(other) && !conflicts.some(pair => pair.a === other && pair.b === name)) {
        conflicts.push({ a: name, b: other });
      }
    }
  }
  return { deps, conflicts };
}

/** Credential keys the newly enabled skills read, skipping the ones the agent already has. */
export function credentialsNeededFor(
  skills: string[],
  registry: SkillRegistry,
  row?: Row,
): Array<{ skill: string; credentials: string[] }> {
  const ready = (key: string): boolean => (row ? credentialReady(row, key) : false);
  return skills
    .map(skill => ({
      skill,
      credentials: (registry.skills.get(skill)?.requiresCredentials
        ? registry.skills.get(skill)?.credentialKeys ?? []
        : []).filter(key => !ready(key)),
    }))
    .filter(entry => entry.credentials.length > 0);
}

/** The credential keys the given skills use, main and additional, by the same rule as credentialsNeededFor. */
export function credentialsUsedBySkills(skills: Iterable<string>, registry: SkillRegistry): Set<string> {
  const used = new Set<string>();
  for (const name of skills) {
    const skill = registry.skills.get(name);
    if (!skill?.requiresCredentials) continue;
    for (const key of skill.credentialKeys) used.add(key);
  }
  return used;
}

export interface UnusedCredential {
  /** The skills whose main credential this is, to turn on first, as people see them: Title (`key`). */
  skills: string[];
}

/**
 * Null when the agent uses this credential: one of its active skills reads it, or
 * one of its custom skills or scheduled tasks requires it (a skill's scheduled
 * task only when it can use that credential now). A template agent's setup also
 * waits for the credentials its template requires, whichever skills are on. Else
 * the skills that would use it, to turn on first.
 */
export function unusedCredential(row: Row, credential: string, registry: SkillRegistry): UnusedCredential | null {
  const used = credentialsUsedBySkills(enabledSkillNames(row), registry);
  // A skill's scheduled task counts only the credentials it can use now; a task of the user's own, the ones its row lists.
  for (const entry of customSkillEntries(row)) {
    for (const key of entry.usableCredentials ?? entry.requiresCredentials) used.add(key);
  }
  if (used.has(credential) || (!isCustomBuild(row) && credentialGroup(row, credential)?.optional === false)) return null;
  return {
    skills: [...registry.skills.values()]
      .filter(skill => !skill.deprecated && skill.requiresCredentials && skill.credentialKeys[0] === credential)
      .map(skill => skillLabel(skill.name, registryTitles(registry))),
  };
}

// A key minted by this package: mcp-<random>-<change digest>. Keys from earlier versions also carry a price fingerprint at the end.
const IDEMPOTENCY_KEY_RE = /^mcp-[0-9a-f]{16}-([0-9a-f]{10})(?:-[0-9a-f]{8})?$/;

/** Fingerprint of one logical skill change, independent of the agent's current state. */
export function skillChangeDigest(
  agentGuid: string,
  requested: Record<string, boolean>,
): string {
  const entries = Object.keys(requested).sort().map(name => `${name}=${requested[name] ? 1 : 0}`);
  return crypto.createHash('sha256')
    .update([agentGuid, '', ...entries].join('\n'))
    .digest('hex')
    .slice(0, 10);
}

/** A new key for one skill change. Repeating the change with it never applies it twice. */
export function newSkillChangeKey(digest: string): string {
  return `mcp-${crypto.randomBytes(8).toString('hex')}-${digest}`;
}

/** The change fingerprint of a key minted by this package, or null for any other key. */
export function parseSkillChangeKey(key: string): { digest: string } | null {
  const match = IDEMPOTENCY_KEY_RE.exec(key.trim());
  return match ? { digest: match[1] as string } : null;
}

/**
 * Keys minted by this package carry the fingerprint of their change. Wiro
 * answers a reused key with the saved result of the call that first used it,
 * so a key is only sent with the change it was issued for.
 */
export function idempotencyKeyMismatch(key: string, digest: string): boolean {
  const parsed = parseSkillChangeKey(key);
  return parsed !== null && parsed.digest !== digest;
}

const DAY_SECONDS = 86400;

/**
 * What a move to a larger plan does today, as Wiro works it out on the plan the
 * agent has now (PricingPreview with the agent's guid and the new plan answers
 * it as planChange). The money moves now only on a wallet plan.
 */
export interface PlanChange {
  /** Who pays the plan: the wallet, or a card. */
  wallet: boolean;
  /** When the current period ends, in unix seconds. */
  periodEnd: number | null;
  secondsLeft: number | null;
  /** The included AI usage this period gains, in USD; below 0 when it loses. */
  includedNowUsd: number | null;
  /** The AI usage this period includes in all after the change, in USD. */
  includedThisPeriodUsd: number | null;
  /** The AI usage each renewal includes after the change, in USD. */
  includedFromRenewalUsd: number | null;
  /** Taken from the wallet now, at list price. 0 on a card plan. */
  chargeNowUsd: number | null;
  /**
   * Wiro's refusal of the change, in its own words, when it would refuse it now: a move to a larger plan while the
   * plan's renewal is due. The answer then names no charge. null when Wiro would make the change.
   */
  refusal: string | null;
}

/** An amount Wiro answers in hundredths of a dollar, in USD; null stays null. */
function hundredthsToUsd(value: unknown): number | null {
  const cents = toNumber(value);
  return cents === null ? null : centsToUsd(cents);
}

/** The plan change of a pricing answer, or null when the agent has no active plan or Wiro sent none. */
export function readPlanChange(value: unknown): PlanChange | null {
  if (!isPlainObject(value)) return null;
  return {
    wallet: asString(value.provider) === 'prepaid',
    periodEnd: toNumber(value.periodEnd),
    secondsLeft: toNumber(value.secondsLeft),
    // Wiro answers the included usage in hundredths of a dollar.
    includedNowUsd: hundredthsToUsd(value.creditsNow),
    includedThisPeriodUsd: hundredthsToUsd(value.creditsThisPeriod),
    includedFromRenewalUsd: hundredthsToUsd(value.creditsFromRenewal),
    chargeNowUsd: toNumber(value.chargeNowUsd),
    refusal: asString(value.refusal)?.trim() || null,
  };
}

/** Whether a rise now pays the one-day minimum: under a day is left of the period. */
export function underOneDayLeft(secondsLeft: number | null): boolean {
  return secondsLeft !== null && secondsLeft < DAY_SECONDS;
}

/** The time left of a period in whole days, at least 1, for a sentence such as "(27 days)". */
export function daysLeftText(secondsLeft: number | null): string | null {
  if (secondsLeft === null || secondsLeft < 0) return null;
  const days = Math.max(1, Math.round(secondsLeft / DAY_SECONDS));
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export interface SkillsApplyFailure {
  code: number | null;
  message: string;
  guidance: string;
  retrySameKey: boolean;
  deps?: Array<{ skill: string; requires: string }>;
  conflicts?: Array<{ a: string; b: string }>;
}

/**
 * Turns a refused SkillsApply into an explanation and the step that fixes it. A skill change moves no money,
 * so none of these is about the wallet.
 */
export function describeSkillsApplyError(error: unknown, titles?: ReadonlyMap<string, string>): SkillsApplyFailure {
  const message = error instanceof Error ? error.message : String(error);
  const body = error instanceof ApiResultError ? error.body : {};
  const codes = error instanceof ApiResultError ? error.codes.map(code => toNumber(code)) : [];
  const code = codes.find(candidate => candidate !== null && candidate >= 95 && candidate <= 110) ?? null;
  const base = { code, message, retrySameKey: false };
  switch (code) {
    case 101: {
      const deps = (Array.isArray(body.deps) ? body.deps : [])
        .filter(isPlainObject)
        .map(dep => ({ skill: asString(dep.skill) ?? '', requires: asString(dep.requires) ?? '' }));
      return {
        ...base,
        deps,
        guidance: `Some skills need others that would be off: ${deps.map(dep => `${skillLabel(dep.skill, titles)} needs ${skillLabel(dep.requires, titles)}`).join('; ')}. Turn the needed skills on in the same change (add_dependencies does this for skills you turn on), or keep them on when you turn other skills off.`,
      };
    }
    case 102: {
      const conflicts = (Array.isArray(body.conflicts) ? body.conflicts : [])
        .filter(isPlainObject)
        .map(pair => ({ a: asString(pair.a) ?? '', b: asString(pair.b) ?? '' }));
      return {
        ...base,
        conflicts,
        guidance: `These skills cannot be on together: ${conflicts.map(pair => `${skillLabel(pair.a, titles)} and ${skillLabel(pair.b, titles)}`).join('; ')}. Keep only one of each pair.`,
      };
    }
    case 104:
      // Changes to an agent's skills or plan take turns, such as a plan change or a renewal.
      return {
        ...base,
        retrySameKey: true,
        guidance: 'Another change to this agent\'s skills or plan, such as a plan change or a renewal, is still going through, and one runs at a time. Nothing was changed by this call. Wait a few seconds, then repeat the call with the same idempotency_key. If it keeps saying so, it clears within 15 minutes.',
      };
    case 107:
      return {
        ...base,
        guidance: 'This idempotency_key cannot be used for this call, and nothing was changed by it. Repeat the call without idempotency_key: it then gets a new key.',
      };
    case 108:
      return {
        ...base,
        retrySameKey: true,
        guidance: 'Wiro could not read or save what this change needs just now. Nothing was changed. Try again: repeat the call with the same idempotency_key.',
      };
    case 110:
      return {
        ...base,
        guidance: 'Do not repeat this change. Check the agent\'s skills with get_my_agent before changing anything, and contact Wiro support if they are not what you expect.',
      };
    case 95:
    case 96:
    case 97:
      return {
        ...base,
        guidance: 'Only the agent\'s owner or an admin of the team that owns it can change its skills.',
      };
    default:
      break;
  }
  if (/pricing snapshot|not found in registry|not in the skill registry/i.test(message)) {
    return {
      ...base,
      guidance: 'Wiro could not read one of the skills, so nothing was changed. Check the skill names with list_agent_skills.',
    };
  }
  if (/^unknown skill: /i.test(message)) {
    return {
      ...base,
      guidance: 'Nothing was changed. Use names from list_agent_skills.',
    };
  }
  if (/change the plan with upgradetier/i.test(message)) {
    return {
      ...base,
      guidance: 'A skill change does not change the plan. manage_agent_billing with action change_plan does.',
    };
  }
  return { ...base, guidance: workspaceHint(message) ?? '' };
}

export const WORKSPACE_HINT = 'Connect with a project in the workspace (personal or team) that owns this agent, by its API key or a browser sign-in.';

/** The API names a dashboard concept ("team context"); here the workspace is the connected project's. */
export function workspaceHint(message: string): string | undefined {
  return /switch to the (team|personal)|different team|personal workspace/i.test(message) ? WORKSPACE_HINT : undefined;
}

// ---------------------------------------------------------------------------
// Credential registry entries
// ---------------------------------------------------------------------------

export interface CredentialField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  encrypted: boolean;
  platformManaged: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  options?: string[];
  fileTypes?: string[];
  maxSizeKb?: number;
  itemType?: string;
  itemSchema: CredentialField[];
  help?: string;
  placeholder?: string;
}

export interface CredentialMeta {
  key: string;
  title: string;
  fields: CredentialField[];
  channel: { id: string; requiredFields: string[] } | null;
  platformOnly: boolean;
}

// A field's setup help is shown whole: its last steps are part of the setup.
export const FIELD_HELP_MAX = 4_000;

// The Wiro project field. On the dashboard it is a project picker, and the help
// it comes with describes that picker, so this line is shown instead. The
// credential is the project the agent's video and voice skills run models
// with. The wiro connector, the agent's own model tools, always runs with the
// same project: connecting it binds its project to this credential.
export const WIRO_PROJECT_NOTE = 'Connect a Wiro project with bind_agent_project: it takes the project of this connection or '
  + 'one from list_projects, and no key passes through this chat. The user can also pick the project on the agent\'s page in '
  + 'the Wiro dashboard. Saving a project API key with set_agent_credentials stays possible when the user gives one for this, '
  + 'and Wiro adds the project\'s secret by itself. The agent\'s video and voice skills run models with this project, '
  + 'billed to the wallet of the workspace that owns it. The agent\'s own model tools (wiro__*) come from the wiro '
  + 'connector, which always runs with this same project: connecting it with connect_agent_connector (project_id, or '
  + 'the project of this connection) binds that project here too, and its model runs count as the agent\'s own.';

export function isWiroProjectField(raw: Row): boolean {
  return /^(custom:)?wiro-project-picker$/.test(asString(raw.type) ?? '');
}

export function htmlToText(value: unknown, maxLength = 400): string | undefined {
  const html = asString(value);
  if (!html) return undefined;
  const text = html
    .replace(/<\s*(br|\/p|\/li|\/div)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? truncate(text, maxLength) : undefined;
}

function itemSchemaOf(raw: Row): Row[] {
  if (Array.isArray(raw.item_schema)) return raw.item_schema.filter(isPlainObject);
  const config = isPlainObject(raw.custom_component_config) ? raw.custom_component_config : null;
  if (!config) return [];
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('per_') && key.endsWith('_schema') && Array.isArray(value)) {
      return value.filter(isPlainObject);
    }
  }
  return [];
}

function parseOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map(option => (isPlainObject(option) ? asString(option.value) ?? '' : asString(option)))
    .filter((option): option is string => option !== undefined);
  return options.length > 0 ? options : undefined;
}

export function parseCredentialField(raw: Row): CredentialField {
  const key = asString(raw.key) ?? '';
  return {
    key,
    label: asString(raw.label) ?? key,
    type: asString(raw.type) ?? 'text',
    required: raw.required === true,
    encrypted: raw.encrypted === true,
    platformManaged: raw.platform_managed === true,
    ...(asString(raw.pattern) ? { pattern: asString(raw.pattern) } : {}),
    ...(toNumber(raw.minlength) !== null ? { minLength: toNumber(raw.minlength) as number } : {}),
    ...(toNumber(raw.maxlength) !== null ? { maxLength: toNumber(raw.maxlength) as number } : {}),
    ...(parseOptions(raw.options) ? { options: parseOptions(raw.options) } : {}),
    ...(Array.isArray(raw.filetypes) ? { fileTypes: stringList(raw.filetypes) } : {}),
    ...(toNumber(raw.maxsize) !== null ? { maxSizeKb: toNumber(raw.maxsize) as number } : {}),
    ...(asString(raw.item_type) ? { itemType: asString(raw.item_type) } : {}),
    itemSchema: itemSchemaOf(raw).map(parseCredentialField).filter(field => field.key),
    ...(!isWiroProjectField(raw) && htmlToText(raw.help, FIELD_HELP_MAX) ? { help: htmlToText(raw.help, FIELD_HELP_MAX) } : {}),
    ...(asString(raw.placeholder) ? { placeholder: asString(raw.placeholder) } : {}),
  };
}

export function parseCredentialMeta(raw: Row): CredentialMeta {
  const key = asString(raw.key) ?? '';
  const fields = (Array.isArray(raw.credential_schema) ? raw.credential_schema : [])
    .filter(isPlainObject)
    .map(parseCredentialField)
    .filter(field => field.key);
  const channel = isPlainObject(raw.channel)
    ? { id: asString(raw.channel.id) ?? key, requiredFields: stringList(raw.channel.required_fields) }
    : null;
  return {
    key,
    title: asString(raw.title) ?? key,
    fields,
    channel,
    platformOnly: raw.credential_mode === 'rule_only'
      || (fields.length > 0 && fields.every(field => field.platformManaged)),
  };
}

/** Returns null when the registry has no credential with that key. */
export async function loadCredentialMeta(
  client: WiroClient,
  key: string,
  signal?: AbortSignal,
): Promise<CredentialMeta | null> {
  try {
    return await cachedRead(client, `credential:${key}`, async () => {
      const body = requireApiSuccess(
        await client.post<ApiEnvelope & { credential?: unknown }>('/Credentials/Detail', { key }, signal),
        `Could not read the credential "${key}".`,
      );
      if (!isPlainObject(body.credential)) {
        throw new ApiResultError(`Credential not found: ${key}`, [404], body as Row);
      }
      return parseCredentialMeta(body.credential);
    });
  } catch (error) {
    if (hasErrorCode(error, 404)) return null;
    throw error;
  }
}

export type FieldShape = 'object-array' | 'string-array' | 'file' | 'boolean' | 'number' | 'select' | 'text';

const OBJECT_LIST_TYPES = new Set([
  'custom:urls-list',
]);

/** Mirrors how the API stores a field: lists of rows, lists of strings, files or one value. */
export function credentialFieldShape(field: Pick<CredentialField, 'type' | 'itemType' | 'itemSchema'>): FieldShape {
  const type = field.type;
  if (type === 'object-array' || OBJECT_LIST_TYPES.has(type)) return 'object-array';
  if (type === 'string-array') return 'string-array';
  if (type === 'array') {
    if (field.itemType === 'object') return 'object-array';
    if (field.itemType === 'string') return 'string-array';
    return field.itemSchema.length > 0 ? 'object-array' : 'string-array';
  }
  if (type === 'fileinput') return 'file';
  if (type === 'boolean') return 'boolean';
  if (type === 'number') return 'number';
  if (type === 'select') return 'select';
  return 'text';
}

/** Fields Wiro fills; customers cannot write them. */
export function isWritableField(field: CredentialField): boolean {
  return !field.platformManaged && field.type !== 'computed';
}

export interface CredentialFieldInput {
  credential: string;
  field: string;
  value?: unknown;
  parent_field?: string;
  ordinal?: number;
}

export interface CredentialApiField {
  credentialkey: string;
  fieldname: string;
  fieldvalue: unknown;
  parentfield?: string;
  ordinal?: number;
}

export interface CredentialFileUpload {
  credential: string;
  field: string;
  label: string;
  url: string;
  fileTypes: string[];
  maxBytes: number;
}

export interface PreparedCredentialWrite {
  apiFields: CredentialApiField[];
  files: CredentialFileUpload[];
  errors: string[];
  /** Every string the caller sent, so errors can be scrubbed of them. */
  secrets: string[];
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// An agent's detail shows a saved secret, such as a key or a token, as exactly eight dots (U+2022), and an unsaved
// one as "": the dots read as set, and they are never the value. A value that is exactly those dots, spaces around
// it aside, was copied from there, so it is never sent back. Any other text is a value like any other.
const SECRET_MASK = '\u2022'.repeat(8);

/** Whether a value is that mask, or holds it as a list item or an entry's field. */
export function holdsSecretMask(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() === SECRET_MASK;
  if (Array.isArray(value)) return value.some(holdsSecretMask);
  if (isPlainObject(value)) return Object.values(value).some(holdsSecretMask);
  return false;
}

/** What a value that holds the mask holds, for the sentence that refuses it. */
export const SECRET_MASK_TEXT = 'the dots Wiro shows in place of a saved secret, not the secret itself';

/**
 * Every string of 8 or more characters in a value, at any depth of its lists and objects, for the redaction of
 * error texts. Short values (select options, flags) are not secrets and would garble messages.
 */
export function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    if (value.trim().length >= 8) into.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

function patternError(field: CredentialField, value: string, label: string): string | null {
  if (field.minLength !== undefined && value.length < field.minLength) {
    return `${label} must be at least ${field.minLength} characters.`;
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return `${label} must be at most ${field.maxLength} characters.`;
  }
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(value)) return `${label} has an invalid format (expected pattern ${field.pattern}).`;
    } catch {
      return null;
    }
  }
  return null;
}

function fieldList(fields: CredentialField[]): string {
  return fields.filter(isWritableField).map(field => field.key).join(', ');
}

function scalarValue(
  field: CredentialField,
  value: unknown,
  label: string,
): { value?: unknown; error?: string } {
  const shape = credentialFieldShape(field);
  if (shape === 'boolean') {
    return typeof value === 'boolean' ? { value } : { error: `${label} takes true or false.` };
  }
  if (shape === 'number') {
    const number = toNumber(value);
    return number === null ? { error: `${label} takes a number.` } : { value: number };
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { error: `${label} takes a single text value.` };
  }
  const text = String(value);
  if (shape === 'select' && field.options && !field.options.includes(text)) {
    return { error: `${label} must be one of: ${field.options.map(option => option || '(empty)').join(', ')}.` };
  }
  const problem = text.trim() ? patternError(field, text.trim(), label) : null;
  return problem ? { error: problem } : { value: text };
}

/**
 * A list field's value. Items and rows are named the way Wiro names them,
 * counting from 1: "Allowed Telegram DM User IDs #2" at the top level, and
 * itemLabel names the items of a text list inside an entry.
 */
function listValue(
  field: CredentialField,
  value: unknown,
  label: string,
  itemLabel: (index: number) => string = index => `${label} #${index + 1}`,
): { value?: unknown; error?: string } {
  const shape = credentialFieldShape(field);
  if (!Array.isArray(value)) return { error: `${label} takes a list (JSON array).` };
  if (shape === 'string-array') {
    const items: string[] = [];
    for (const [index, item] of value.entries()) {
      if (typeof item !== 'string' && typeof item !== 'number') {
        return { error: `${field.label} takes a list of text values; ${itemLabel(index)} is not one.` };
      }
      const text = String(item).trim();
      if (!text) continue;
      const problem = patternError(field, text, itemLabel(index));
      if (problem) return { error: problem };
      items.push(text);
    }
    return { value: items };
  }
  return rowsValue(field, value, index => `${label} #${index + 1}`);
}

function isListField(field: CredentialField): boolean {
  const shape = credentialFieldShape(field);
  return shape === 'object-array' || shape === 'string-array';
}

/**
 * The rows of a list of objects, checked the way Wiro checks them: only the
 * keys the item schema declares, each value by its own rules, and a list inside
 * a row (such as the channels of one Discord server) by its own shape. Errors
 * name the row the way Wiro does: "Server ID in Allowed Discord Servers #2".
 */
function rowsValue(
  field: CredentialField,
  value: unknown[],
  rowLabel: (index: number) => string,
): { value?: Row[]; error?: string } {
  const allowed = new Set(field.itemSchema.map(item => item.key));
  const rows: Row[] = [];
  for (const [index, item] of value.entries()) {
    const label = rowLabel(index);
    if (!isPlainObject(item)) return { error: `${field.label} takes a list of objects; ${label} is not one.` };
    if (allowed.size > 0) {
      const unknown = Object.keys(item).filter(key => !allowed.has(key));
      if (unknown.length > 0) {
        return { error: `${label} has unknown keys (${unknown.join(', ')}). Allowed: ${[...allowed].join(', ')}.` };
      }
    }
    const row: Row = { ...item };
    for (const entry of field.itemSchema) {
      const checked = isListField(entry)
        ? nestedListValue(entry, row[entry.key], label)
        : rowFieldValue(entry, row[entry.key], `${entry.label} in ${label}`);
      if (checked.error) return { error: checked.error };
      if (Object.prototype.hasOwnProperty.call(row, entry.key)) row[entry.key] = checked.value;
    }
    rows.push(row);
  }
  return { value: rows };
}

/** One value in a list row: required, options, length and pattern, as Wiro checks it. */
function rowFieldValue(field: CredentialField, value: unknown, label: string): { value?: unknown; error?: string } {
  if (!isFilledValue(value)) return field.required ? { error: `${label} is required.` } : { value };
  const shape = credentialFieldShape(field);
  if (typeof value === 'object') return { error: `${label} takes a single text value.` };
  const text = String(value);
  if (shape === 'select' && field.options && !field.options.includes(text)) {
    return { error: `${label} must be one of: ${field.options.map(option => option || '(empty)').join(', ')}.` };
  }
  const problem = patternError(field, text, label);
  return problem ? { error: problem } : { value };
}

/**
 * A list inside one entry of a list, such as the channels of one Discord server,
 * in a whole write of the outer list or on its own with parent_field: rows
 * checked against its item schema, or text items.
 */
function nestedListValue(field: CredentialField, value: unknown, entryLabel: string): { value?: unknown; error?: string } {
  const label = `${field.label} in ${entryLabel}`;
  if (!Array.isArray(value)) {
    if (isFilledValue(value)) return { error: `${label} takes a list (JSON array).` };
    return field.required ? { error: `${label} is required.` } : { value };
  }
  const checked = credentialFieldShape(field) === 'object-array'
    ? rowsValue(field, value, index => `${field.label} #${index + 1} in ${entryLabel}`)
    : listValue({ ...field, type: 'string-array' }, value, label, index => `${label}, item #${index + 1}`);
  if (checked.error) return checked;
  return field.required && Array.isArray(checked.value) && checked.value.length === 0
    ? { error: `${label} is required.` }
    : checked;
}

/** What an unknown credential key gets: the credentials there are, and where an outside service goes. */
export const UNKNOWN_CREDENTIAL_HINT = 'Credentials are chat channels (such as "telegram"), Twilio Voice, settings and the Wiro '
  + 'project; get_my_agent lists the agent\'s. An outside service is a Connector: list_agent_connectors lists them and '
  + 'connect_agent_connector connects one.';

/**
 * Checks every requested field against the credential registry and builds the
 * API payload. Nothing is written when any field is refused.
 */
export function prepareCredentialWrite(
  inputs: CredentialFieldInput[],
  metas: Map<string, CredentialMeta | null>,
  /** Unknown keys that name a connector, with its title: they get the connector tools' names. */
  connectors: ReadonlyMap<string, string> = new Map(),
): PreparedCredentialWrite {
  const prepared: PreparedCredentialWrite = { apiFields: [], files: [], errors: [], secrets: [] };
  const reportedUnknown = new Set<string>();
  for (const input of inputs) {
    collectStrings(input.value, prepared.secrets);
    const credential = input.credential.trim();
    const fieldName = input.field.trim();
    const meta = metas.get(credential) ?? null;
    if (!meta) {
      if (!reportedUnknown.has(credential)) {
        const connector = connectors.get(credential);
        prepared.errors.push(connector
          ? `${connector} is a Connector, not a credential: connect it with connect_agent_connector (list_agent_connectors with name "${credential}" shows what it needs).`
          : `Unknown credential "${credential}". ${UNKNOWN_CREDENTIAL_HINT}`);
        reportedUnknown.add(credential);
      }
      continue;
    }
    if (meta.platformOnly) {
      prepared.errors.push(`${meta.title} is managed by Wiro and cannot be set.`);
      continue;
    }
    if (!fieldName) {
      prepared.errors.push(`${meta.title}: the field key is empty.`);
      continue;
    }
    if (fieldName.startsWith('_')) {
      prepared.errors.push(`${meta.title}: "${fieldName}" is a reserved name.`);
      continue;
    }
    if (holdsSecretMask(input.value)) {
      prepared.errors.push(`${meta.title}: "${fieldName}" holds ${SECRET_MASK_TEXT}. Leave it out to keep the saved value, or send the new value.`);
      continue;
    }

    if (input.parent_field) {
      const root = input.parent_field.split(/[.[\]]/)[0]?.trim() ?? '';
      const parent = meta.fields.find(field => field.key === root);
      if (!parent || credentialFieldShape(parent) !== 'object-array') {
        prepared.errors.push(`${meta.title} has no list field "${root}" for parent_field. List fields: ${meta.fields.filter(field => credentialFieldShape(field) === 'object-array').map(field => field.key).join(', ') || 'none'}.`);
        continue;
      }
      // Wiro checks and stores an entry's field under the list's own key and
      // the entry's position, so parent_field takes that key alone and the
      // position goes in ordinal.
      if (input.parent_field.trim() !== parent.key) {
        prepared.errors.push(`${parent.label}: parent_field takes the list field's key alone ("${parent.key}"); pass the entry's position, from 0, as ordinal.`);
        continue;
      }
      if (!isWritableField(parent)) {
        prepared.errors.push(`${parent.label} is filled by Wiro and cannot be set.`);
        continue;
      }
      const item = parent.itemSchema.find(candidate => candidate.key === fieldName);
      if (parent.itemSchema.length > 0 && !item) {
        prepared.errors.push(`${parent.label} entries have no field "${fieldName}". Entry fields: ${parent.itemSchema.map(candidate => candidate.key).join(', ')}.`);
        continue;
      }
      if (input.ordinal === undefined) {
        prepared.errors.push(`${parent.label}: ordinal (the entry's position, from 0) is required with parent_field.`);
        continue;
      }
      // The entry is named the way Wiro names it, counting from 1.
      const entryLabel = `${parent.label} #${input.ordinal + 1}`;
      let value = input.value;
      // An entry's field is checked as it is in a whole write of the list,
      // empty values included, so a required one cannot be cleared.
      if (item) {
        const checked = isListField(item)
          ? nestedListValue(item, isEmptyValue(value) ? [] : value, entryLabel)
          : rowFieldValue(item, value, `${item.label} in ${entryLabel}`);
        if (checked.error) {
          prepared.errors.push(checked.error);
          continue;
        }
        value = checked.value;
      }
      prepared.apiFields.push({
        credentialkey: credential,
        fieldname: fieldName,
        fieldvalue: item && !isFilledValue(value) ? (isListField(item) ? [] : '') : (value ?? ''),
        parentfield: parent.key,
        ordinal: input.ordinal,
      });
      continue;
    }

    const field = meta.fields.find(candidate => candidate.key === fieldName);
    if (!field) {
      prepared.errors.push(`${meta.title} has no field "${fieldName}". Fields you can set: ${fieldList(meta.fields) || 'none'}.`);
      continue;
    }
    if (field.platformManaged) {
      prepared.errors.push(`${field.label} is managed by Wiro and cannot be set.`);
      continue;
    }
    if (!isWritableField(field)) {
      prepared.errors.push(`${field.label} is filled by Wiro and cannot be set directly.`);
      continue;
    }

    const shape = credentialFieldShape(field);
    // Channel groups are optional as a whole: clearing one activation field turns the channel off.
    const mayClear = !field.required || meta.channel !== null;
    if (isEmptyValue(input.value)) {
      if (!mayClear) {
        prepared.errors.push(`${field.label} is required and cannot be cleared. To replace the saved value, send the new one. `
          + 'To end the agent\'s access, revoke it with the service it belongs to.');
        continue;
      }
      const cleared = shape === 'string-array' || shape === 'object-array' ? [] : '';
      prepared.apiFields.push({ credentialkey: credential, fieldname: fieldName, fieldvalue: cleared });
      continue;
    }

    if (shape === 'file') {
      const url = typeof input.value === 'string' ? input.value.trim() : '';
      if (!/^https?:\/\//i.test(url)) {
        prepared.errors.push(`${field.label} takes the public http(s) URL of the file to upload.`);
        continue;
      }
      prepared.files.push({
        credential,
        field: fieldName,
        label: field.label,
        url,
        fileTypes: field.fileTypes ?? [],
        maxBytes: (field.maxSizeKb ?? 10240) * 1024,
      });
      continue;
    }
    const checked = shape === 'string-array' || shape === 'object-array'
      ? listValue(field, input.value, field.label)
      : scalarValue(field, input.value, field.label);
    if (checked.error) {
      prepared.errors.push(checked.error);
      continue;
    }
    if ((shape === 'string-array' || shape === 'object-array')
      && Array.isArray(checked.value) && checked.value.length === 0 && !mayClear) {
      prepared.errors.push(`${field.label} is required and cannot be empty.`);
      continue;
    }
    prepared.apiFields.push({ credentialkey: credential, fieldname: fieldName, fieldvalue: checked.value });
  }
  return prepared;
}

/** Removes every value the caller sent from a message before it is shown. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length >= 8) out = out.split(secret).join('[hidden]');
  }
  return out;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** The API derives the stored file's extension from its name, so one is always added. */
export function uploadFileName(url: string, field: string, contentType: string): string {
  let base = '';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    base = '';
  }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-100);
  if (/\.[A-Za-z0-9]{2,5}$/.test(base)) return base;
  const extension = EXTENSION_BY_TYPE[contentType] ?? 'bin';
  return `${base || field}.${extension}`;
}

// ---------------------------------------------------------------------------
// Agent credential status (from /UserAgent/Detail)
// ---------------------------------------------------------------------------

export function isFilledValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(isFilledValue);
  if (isPlainObject(value)) return Object.values(value).some(isFilledValue);
  return true;
}

/**
 * Whether a field of a saved credential holds what someone entered, counted the
 * way Wiro counts it for a card's filled state: a list of options counts only an
 * option that is selected, and a row of a list does not count for its selects
 * and switches, which come with a default.
 */
export function isCredentialFieldFilled(field: CredentialField, value: unknown): boolean {
  if (field.itemSchema.length === 0 || !Array.isArray(value)) return isCredentialValueFilled(value);
  return value.some(row => {
    if (!isPlainObject(row)) return isCredentialValueFilled(row);
    return Object.entries(row).some(([key, item]) => {
      const inner = field.itemSchema.find(entry => entry.key === key);
      if (!inner) return isCredentialValueFilled(item);
      if (inner.type === 'select' || inner.type === 'boolean') return false;
      return isCredentialFieldFilled(inner, item);
    });
  });
}

function isCredentialValueFilled(value: unknown): boolean {
  if (Array.isArray(value) && value.length > 0 && value.every(option => isPlainObject(option) && 'selected' in option)) {
    return value.some(option => isPlainObject(option) && option.selected === true);
  }
  if (Array.isArray(value)) return value.some(isCredentialValueFilled);
  if (isPlainObject(value)) return Object.values(value).some(isCredentialValueFilled);
  return isFilledValue(value);
}

export function credentialGroup(row: Row, key: string): Row | null {
  const groups = isPlainObject(row.credentials) ? row.credentials : null;
  const group = groups ? groups[key] : undefined;
  return isPlainObject(group) ? group : null;
}

/** Whether the agent can use a credential now: it is connected, or every required field holds a value. */
export function credentialReady(row: Row, key: string): boolean {
  const group = credentialGroup(row, key);
  if (!group) return false;
  return group._connected === true || group._filled === true;
}

export interface CredentialStatus {
  key: string;
  title: string;
  connected: boolean;
  filled: boolean;
  requiredMissing: boolean;
  optional: boolean;
  missingFields: string[];
}

export function credentialStatus(row: Row, key: string, meta?: CredentialMeta | null): CredentialStatus | null {
  const group = credentialGroup(row, key);
  if (!group) return null;
  const schema = isPlainObject(group._schema) ? group._schema : {};
  const connected = group._connected === true;
  // Filled says every required field holds a value, a template's own value that is not shown included.
  const missingFields = connected || !meta || group._filled === true
    ? []
    : meta.fields
      .filter(field => field.required && isWritableField(field) && !isCredentialFieldFilled(field, group[field.key]))
      .map(field => field.label);
  return {
    key,
    title: asString(schema.title) ?? meta?.title ?? key,
    connected,
    filled: group._filled === true,
    requiredMissing: credentialKeysSetupWaitsFor(row).has(key),
    optional: group.optional === true,
    missingFields,
  };
}

export interface ChannelStatus {
  id: string;
  title: string;
  credential: string;
  enabled: boolean;
  missingFields: string[];
}

export function channelStatuses(row: Row): ChannelStatus[] {
  const channels = Array.isArray(row.communicationChannels) ? row.communicationChannels : [];
  return channels.filter(isPlainObject).map(channel => {
    const schema = isPlainObject(channel.schema) ? channel.schema : {};
    const labels = new Map<string, string>();
    for (const field of Array.isArray(schema.fields) ? schema.fields : []) {
      if (isPlainObject(field) && asString(field.key)) {
        labels.set(asString(field.key) as string, asString(field.label) ?? (asString(field.key) as string));
      }
    }
    const id = asString(channel.id) ?? '';
    return {
      id,
      title: asString(channel.title) ?? id,
      credential: asString(channel.credentialkey) ?? id,
      enabled: channel.enabled === true,
      missingFields: stringList(channel.missingfields).map(field => labels.get(field) ?? field),
    };
  });
}

// ---------------------------------------------------------------------------
// Custom skills and scheduled tasks (manage_agent_custom_skill)
// ---------------------------------------------------------------------------

export type CustomSkillKind = 'skill' | 'scheduled_task';

/** The entry that holds what an agent posts, sends or changes by itself until the user says yes. */
export const APPROVAL_POLICY_KEY = 'cs-approval-policy';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Same rules as the API's key normalisation: cs-cron-x and cs-x stay, cron-x
 * becomes cs-cron-x, and a bare slug gets cs-cron- when scheduled (or given a
 * non-empty interval) and cs- otherwise. The slug is 1-60 characters of
 * lowercase letters, digits and single dashes. Returns null when invalid.
 */
export function normalizeCustomSkillKey(
  input: string,
  options: { scheduled?: boolean; hasInterval?: unknown } = {},
): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let prefix: string;
  let body: string;
  if (trimmed.startsWith('cs-cron-')) {
    prefix = 'cs-cron-';
    body = trimmed.slice('cs-cron-'.length);
  } else if (trimmed.startsWith('cs-')) {
    prefix = 'cs-';
    body = trimmed.slice('cs-'.length);
  } else if (trimmed.startsWith('cron-')) {
    prefix = 'cs-';
    body = trimmed;
  } else {
    let scheduled = options.scheduled === true;
    if (!scheduled && options.hasInterval !== undefined && options.hasInterval !== null && options.hasInterval !== false) {
      const interval = String(options.hasInterval).trim().toLowerCase();
      scheduled = interval !== '' && interval !== 'manual' && interval !== 'false';
    }
    prefix = scheduled ? 'cs-cron-' : 'cs-';
    body = trimmed;
  }
  if (body.length === 0 || body.length > 60 || !SLUG_RE.test(body)) return null;
  return prefix + body;
}

export function customSkillKindOf(key: string): CustomSkillKind {
  return key.startsWith('cs-cron-') ? 'scheduled_task' : 'skill';
}

const INVALID_KEY_MESSAGE = 'Use lowercase letters, digits and single dashes, for example lead-strategy (at most 60 characters after the cs- or cs-cron- prefix).';

function isBareCustomSkillKey(key: string): boolean {
  return !key.startsWith('cs-') && !key.startsWith('cron-');
}

/**
 * The key an upsert writes, computed with the API's own rules. With the
 * agent's entries, a bare key with no kind and no interval names the existing
 * entry of that name, as rename, delete, history and revert do; the API would
 * otherwise create a new cs- entry.
 */
export function upsertCustomSkillKey(
  input: string,
  kind?: CustomSkillKind,
  interval?: string,
  existingKeys?: Set<string>,
): { key?: string; error?: string } {
  const trimmed = input.trim();
  const scheduledPrefix = trimmed.startsWith('cs-cron-') || trimmed.startsWith('cron-');
  if (kind === 'skill' && scheduledPrefix) {
    return { error: `"${input}" is a scheduled task key. Use kind scheduled_task, or a key without cron-.` };
  }
  if (kind === 'scheduled_task' && trimmed.startsWith('cs-') && !scheduledPrefix) {
    return { error: `"${input}" is a custom skill key. Scheduled task keys start with cs-cron-.` };
  }
  if (existingKeys && !kind && interval === undefined && isBareCustomSkillKey(trimmed)) {
    const asSkill = normalizeCustomSkillKey(trimmed, { scheduled: false });
    const asTask = normalizeCustomSkillKey(trimmed, { scheduled: true });
    if (asSkill && asTask && existingKeys.has(asTask)) {
      return existingKeys.has(asSkill)
        ? { error: `Both ${asSkill} and ${asTask} exist on this agent. Pass the full key.` }
        : { key: asTask };
    }
  }
  const key = normalizeCustomSkillKey(trimmed, {
    scheduled: kind === 'scheduled_task',
    hasInterval: kind === 'skill' ? undefined : interval,
  });
  if (!key) return { error: `Invalid key "${input}". ${INVALID_KEY_MESSAGE}` };
  if (interval !== undefined && customSkillKindOf(key) === 'skill') {
    return { error: 'interval only applies to scheduled tasks (keys starting with cs-cron-). Use kind scheduled_task.' };
  }
  return { key };
}

/** The exact key of an existing entry; the API matches rename, delete, history and revert keys literally. */
export function resolveExistingCustomSkillKey(
  input: string,
  existingKeys: Set<string>,
  kind?: CustomSkillKind,
): { key?: string; error?: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith('cs-') || trimmed.startsWith('cron-')) {
    const key = normalizeCustomSkillKey(trimmed);
    return key ? { key } : { error: `Invalid key "${input}". ${INVALID_KEY_MESSAGE}` };
  }
  const asSkill = normalizeCustomSkillKey(trimmed, { scheduled: false });
  const asTask = normalizeCustomSkillKey(trimmed, { scheduled: true });
  if (!asSkill || !asTask) return { error: `Invalid key "${input}". ${INVALID_KEY_MESSAGE}` };
  if (kind) return { key: kind === 'scheduled_task' ? asTask : asSkill };
  const matches = [asSkill, asTask].filter(key => existingKeys.has(key));
  if (matches.length === 1) return { key: matches[0] };
  if (matches.length > 1) return { error: `Both ${asSkill} and ${asTask} exist. Pass the full key.` };
  return { error: `This agent has no custom skill or scheduled task named "${input}". Pass the full key (cs-... or cs-cron-...). get_my_agent without entry lists its keys.` };
}

/** A light shape check; the API validates the expression fully. */
export function looksLikeCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  return parts.every(part => /^[0-9A-Za-z*,/?#-]+$/.test(part));
}

export interface DeployCustomSkillInput {
  key: string;
  value?: string;
  description?: string;
  interval?: string;
  enabled?: boolean;
}

export interface DeployCustomSkill extends DeployCustomSkillInput {
  kind: CustomSkillKind;
  /** The template already has an entry with this key, and this one replaces its settings. */
  fromTemplate: boolean;
}

/** An entry the template comes with, as its detail lists it. */
export interface TemplateCustomSkill {
  key: string;
  interval?: string | null;
  /** The start of the entry's text in the template; a scheduled task with none is the agent's own to write. */
  instructions?: string;
}

/**
 * Wiro's answer to a change of the text of a scheduled task the agent's template owns: one the template wrote a text
 * for. The agent runs the template's text whatever its own copy says, so the text stays the template's; its switch and
 * its schedule are the agent's own.
 */
export const TEMPLATE_TASK_TEXT_REFUSAL = 'This scheduled task comes with the agent\'s template, so its instructions '
  + 'cannot be changed. You can still turn it on or off and change its schedule.';

const TEMPLATE_TASK_TEXT_PATTERN = /comes with the agent's template, so its instructions cannot be changed/i;

/** What to do instead of changing a template task's text. */
const TEMPLATE_TASK_TEXT_HELP = 'enabled turns it on or off and interval changes its schedule. To change what it does, '
  + 'edit the related custom skill (a cs- key without cron), or create a scheduled task of your own.';

/** The refusal of a text change to a scheduled task the template owns, with the task's key and what to do instead. */
export function templateTaskTextError(key: string): string {
  return `${key}: ${TEMPLATE_TASK_TEXT_REFUSAL} ${TEMPLATE_TASK_TEXT_HELP}`;
}

/** Whether a sent text is the one a task shows, line endings and surrounding blanks aside, as Wiro compares them. */
export function sameTaskText(sent: string, shown: string): boolean {
  const plain = (text: string) => text.replace(/\r\n/g, '\n').trim();
  return plain(sent) === plain(shown);
}

/**
 * Checks deploy_agent's custom_skills the way manage_agent_custom_skill
 * would, before the deploy is paid for. A bare key names the template's own
 * entry of that name when it has one. Without the template's entries only the
 * checks that need no template run.
 */
export function resolveDeployCustomSkills(
  entries: DeployCustomSkillInput[],
  template: TemplateCustomSkill[] | null,
): { skills: DeployCustomSkill[]; errors: string[] } {
  const skills: DeployCustomSkill[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const known = new Map((template ?? []).map(task => [task.key, task]));
  for (const entry of entries) {
    const raw = entry.key.trim();
    const interval = entry.interval?.trim();
    let key: string | null;
    if (isBareCustomSkillKey(raw) && entry.interval === undefined) {
      const asSkill = normalizeCustomSkillKey(raw, { scheduled: false });
      const asTask = normalizeCustomSkillKey(raw, { scheduled: true });
      if (asSkill && asTask && known.has(asSkill) && known.has(asTask)) {
        errors.push(`The template has both ${asSkill} and ${asTask}. Pass the full key instead of "${raw}".`);
        continue;
      }
      key = asTask && known.has(asTask) ? asTask : asSkill;
    } else {
      key = normalizeCustomSkillKey(raw, { hasInterval: entry.interval });
    }
    if (!key) {
      errors.push(`The custom skill key "${entry.key}" is not valid. ${INVALID_KEY_MESSAGE}`);
      continue;
    }
    if (template && seen.has(key)) {
      errors.push(`${key} is listed twice in custom_skills.`);
      continue;
    }
    seen.add(key);
    const kind = customSkillKindOf(key);
    if (entry.interval !== undefined && (!interval || !looksLikeCron(interval))) {
      errors.push(`${key}: interval must be a cron expression with five fields: minute hour day-of-month month day-of-week, for example "0 9 * * 1-5" for weekdays at 09:00.`);
      continue;
    }
    if (entry.interval !== undefined && kind !== 'scheduled_task') {
      errors.push(`${key}: interval only applies to scheduled tasks (keys starting with cs-cron-).`);
      continue;
    }
    const fromTemplate = known.has(key);
    const templateTask = fromTemplate && kind === 'scheduled_task';
    // A scheduled task the template wrote a text for runs that text: the agent's own copy never runs.
    const templateText = templateTask && Boolean(known.get(key)?.instructions?.trim());
    if (entry.value !== undefined && !entry.value.trim()) {
      errors.push(`${key}: value cannot be empty.${fromTemplate ? ' Leave it out to keep the template\'s text.' : ''}`);
      continue;
    }
    if (templateText && entry.value !== undefined) {
      errors.push(templateTaskTextError(key));
      continue;
    }
    if (template && !fromTemplate && entry.value === undefined) {
      errors.push(`${key} is a new ${kind === 'scheduled_task' ? 'scheduled task, so it needs value: the prompt the agent runs on schedule' : 'custom skill, so it needs value: the instructions the agent follows'}.`);
      continue;
    }
    // A scheduled task sent without a schedule is saved on the weekly
    // default, so a template's own task is sent with its own schedule.
    const schedule = interval ?? (templateTask ? known.get(key)?.interval || undefined : undefined);
    skills.push({
      key,
      kind,
      fromTemplate,
      ...(entry.value !== undefined ? { value: entry.value } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(schedule !== undefined ? { interval: schedule } : {}),
      ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    });
  }
  return { skills, errors };
}

export function humanizeCustomSkillKey(key: string): string {
  let body = key.trim();
  if (body.startsWith('cs-cron-')) body = body.slice('cs-cron-'.length);
  else if (body.startsWith('cs-')) body = body.slice('cs-'.length);
  body = body.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return body ? body.charAt(0).toUpperCase() + body.slice(1) : '';
}

export interface CustomSkillEntry {
  key: string;
  kind: CustomSkillKind;
  description: string;
  value: string;
  interval: string | null;
  enabled: boolean;
  source: string;
  userCreated: boolean;
  requiresCredentials: string[];
  /** The connectors a scheduled task needs: it runs while one of them is connected. */
  requiresConnectors: string[];
  /** The starter task whose text was never written: it does not run until its text is saved. */
  notWritten?: boolean;
  /**
   * A scheduled task the agent's template owns: Wiro shows the template's text, which the agent runs, and refuses a
   * change to it (it marks the task not editable). Its switch and schedule are the agent's own.
   */
  templateText?: boolean;
  /** The skills that bring a scheduled task. */
  ownerSkills?: string[];
  /** The skills the scheduled task needs are off, so it is paused until one skill from each list in offSkills is on. */
  skillOff?: boolean;
  /** While skillOff, the skills that end the pause, as lists: one skill from each list. */
  offSkills?: string[][];
  /** A skill's scheduled task: the credentials it can use now. It runs while one of them is connected. */
  usableCredentials?: string[];
  /**
   * A skill's scheduled task: for each credential it needs that is not connected, the skills it would still
   * wait for once that one is connected, as lists ([] when connecting it is enough).
   */
  ifConnected?: Record<string, string[][]>;
}

/** Wiro's _if_connected: each credential key with the lists of skills a task would still wait for. */
function skillGroupsByKey(value: Row): Record<string, string[][]> {
  return Object.fromEntries(Object.entries(value).filter(([, groups]) => Array.isArray(groups)).map(([key, groups]) => [key, toSkillGroups(groups)]));
}

/** A task's connector slugs, as a list or as the JSON text Wiro stores. */
function connectorList(value: unknown): string[] {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [...new Set(stringList(list).filter(slug => CONNECTOR_SLUG.test(slug)))];
}

export function customSkillEntries(row: Row): CustomSkillEntry[] {
  const rows = [
    ...(Array.isArray(row.customskills) ? row.customskills : []),
    ...(Array.isArray(row.scheduledskills) ? row.scheduledskills : []),
  ];
  return rows.filter(isPlainObject).map(entry => {
    const key = asString(entry.key) ?? '';
    const source = asString(entry._source) ?? '';
    return {
      key,
      kind: customSkillKindOf(key),
      description: asString(entry.description) ?? '',
      value: asString(entry.value) ?? '',
      interval: asString(entry.interval) ?? null,
      enabled: entry.enabled !== false,
      source,
      userCreated: source === 'user-created' || entry._user_created === true,
      requiresCredentials: stringList(entry.requires_credentials),
      requiresConnectors: connectorList(entry.requires_connectors),
      notWritten: key === STARTER_TASK_KEY && entry._edited === false,
      ...(customSkillKindOf(key) === 'scheduled_task' && entry._editable === false ? { templateText: true } : {}),
      ownerSkills: stringList(entry._owner_skills),
      skillOff: entry._skill_off === true,
      offSkills: toSkillGroups(entry._off_skills),
      ...(Array.isArray(entry._usable_credentials) ? { usableCredentials: stringList(entry._usable_credentials) } : {}),
      ...(isPlainObject(entry._if_connected) ? { ifConnected: skillGroupsByKey(entry._if_connected) } : {}),
    };
  }).filter(entry => entry.key);
}

/**
 * The connection a scheduled task needs, as a sentence: the credentials it can use (a skill's task) or the
 * ones its row lists (a task of the user's own), by title where the agent's credential cards have one, and
 * the connectors it needs.
 */
export function connectionNeededText(
  row: Row,
  entry: Pick<CustomSkillEntry, 'usableCredentials' | 'requiresCredentials' | 'requiresConnectors'>,
): string {
  const keys = entry.usableCredentials ?? entry.requiresCredentials;
  const credentials = keys.length > 0
    ? `It only runs while ${keys.length > 1 ? 'one of ' : ''}${nameList(keys.map(key => credentialLabel(row, key)), 'or')} is connected.`
    : '';
  const connectors = entry.requiresConnectors.length > 0
    ? `It needs ${entry.requiresConnectors.length > 1 ? 'one of the connectors ' : 'the connector '}${nameList(entry.requiresConnectors.map(slug => `\`${slug}\``), 'or')} connected to run.`
    : '';
  return [credentials, connectors].filter(Boolean).join(' ');
}

/**
 * A credential as people see it, with its key: Google Ads (`google-ads`). Its title comes from the agent's card
 * for it, or from titles (the credential catalog), or is made from the key.
 */
export function credentialLabel(row: Row, key: string, titles?: ReadonlyMap<string, string>): string {
  const schema = credentialGroup(row, key)?._schema;
  const title = isPlainObject(schema) ? asString(schema.title) : undefined;
  return `${title ?? titles?.get(key) ?? wordsFromKey(key)} (\`${key}\`)`;
}

/** The catalog titles of these credentials, read through the cached credential details; a key it cannot read is left out. */
export async function credentialTitles(client: WiroClient, keys: Iterable<string>, signal?: AbortSignal): Promise<Map<string, string>> {
  const unique = [...new Set(keys)];
  const metas = await Promise.all(unique.map(key => loadCredentialMeta(client, key, signal).catch(() => null)));
  return new Map(unique.flatMap((key, index) => {
    const title = metas[index]?.title;
    return title && title !== key ? [[key, title] as [string, string]] : [];
  }));
}

/** Readable text for the API's custom skill error codes. */
export function customSkillErrorMessage(message: string): string {
  if (/invalid-cron-expression|invalid cron/i.test(message)) {
    return 'The schedule is not a valid cron expression. Use five fields: minute hour day-of-month month day-of-week, for example "0 9 * * 1-5".';
  }
  if (TEMPLATE_TASK_TEXT_PATTERN.test(message)) return `${message} ${TEMPLATE_TASK_TEXT_HELP}`;
  if (/customskill-preset-description-not-editable/.test(message)) {
    return 'This entry comes with the agent, so its description cannot be changed. Its text and on/off state can.';
  }
  if (/customskill-(registry|preset)-not-deletable/.test(message)) {
    return 'This entry comes with the agent and cannot be deleted. Turn it off with action upsert and enabled: false instead.';
  }
  if (/useragent-customskill-version-not-found/.test(message)) {
    return 'That version was not found. List the versions with action history.';
  }
  if (/useragent-customskill-not-found|agent-customskill-not-found/.test(message)) {
    return 'This agent has no custom skill or scheduled task with that key.';
  }
  return message;
}

export function toIsoTime(value: unknown): string | undefined {
  const iso = unixToIso(value);
  if (iso) return iso;
  const text = asString(value);
  return text && !/^\d+$/.test(text) ? text : undefined;
}
