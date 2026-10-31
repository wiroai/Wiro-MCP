import crypto from 'node:crypto';
import type { WiroClient } from '../client.js';
import {
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

// Helpers for configuring a deployed agent: its registry skills, credentials,
// sign-in connections and custom skills. The pure functions mirror the server
// rules closely so a bad request is caught before anything is written.

export const DEFAULT_CRON_INTERVAL = '0 10 * * 1';
export const OAUTH_LINK_TTL_SECONDS = 900;
const DASHBOARD_AGENT_URL = 'https://wiro.ai/panel/agents/';
const OAUTH_CALLBACK_BASE = 'https://api.wiro.ai/v1';
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

/** Configuration writes restart an agent only while it is starting or running. */
export function isAgentRunning(status: number | null): boolean {
  return status === 3 || status === 4;
}

/** The agent's page in the Wiro dashboard, in the form the dashboard itself uses as an OAuth return address. */
export function dashboardAgentUrl(agentGuid: string): string {
  const guid = encodeURIComponent(agentGuid);
  return `${DASHBOARD_AGENT_URL}${guid}?id=${guid}`;
}

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
    case 5:
      return `The agent is ${agentStatusLabel(status)}, so the ${what} takes effect the next time it starts.`;
    default:
      return `The ${what} takes effect the next time the agent starts.`;
  }
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
  if (!isPlainObject(row)) throw new Error(`Agent ${agentGuid} was not found.`);
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
  monthlyPriceUsd: number | null;
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
    const pricing = isPlainObject(raw.pricing) ? raw.pricing : {};
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
      monthlyPriceUsd: toNumber(pricing.monthly_price_weight_usd ?? raw.monthly_price_weight_usd),
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

export async function loadSkillRegistry(client: WiroClient, signal?: AbortSignal): Promise<SkillRegistry> {
  return cachedRead(client, 'skills', async () => parseSkillRegistry(requireApiSuccess(
    await client.post<ApiEnvelope & Row>('/Skills/List', {}, signal),
    'Could not read the skill list.',
  )));
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
 * missing a dependency, and it never checks names: an unknown name turned off
 * is stored as a stray row, so names are checked here.
 */
export function planSkillChanges(
  input: Record<string, boolean>,
  registry: SkillRegistry,
  addDependencies: boolean,
): SkillPlan {
  const errors = new Set<string>();
  const requested: Record<string, boolean> = {};
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
      errors.add(`Unknown skill "${name}".${suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ''} Use list_agent_skills for the full list.`);
      continue;
    }
    if (enabled && skill.deprecated) {
      errors.add(`${name} is retired and cannot be turned on${skill.replacement ? `. Use ${skill.replacement} instead` : ''}.`);
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
          errors.add(`${name} needs ${dependency}, which this change turns off. Keep ${dependency} on, or leave ${name} off.`);
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

/** Only real changes are sent: the server would otherwise restart the agent for a no-op. */
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
  const groups = row && isPlainObject(row.credentials) ? row.credentials : {};
  // An OAuth credential is ready only once connected: a saved shop domain or
  // own-app key alone does not let the agent sign in.
  const ready = (key: string): boolean => {
    const group = groups[key];
    if (!isPlainObject(group)) return false;
    const oauth = isPlainObject(group._schema) && isPlainObject(group._schema.oauth_provider);
    return group._connected === true || (!oauth && group._filled === true);
  };
  return skills
    .map(skill => ({
      skill,
      credentials: (registry.skills.get(skill)?.requiresCredentials
        ? registry.skills.get(skill)?.credentialKeys ?? []
        : []).filter(key => !ready(key)),
    }))
    .filter(entry => entry.credentials.length > 0);
}

const IDEMPOTENCY_KEY_RE = /^mcp-[0-9a-f]{16}-([0-9a-f]{10})-([0-9a-f]{8})$/;

/** Fingerprint of one logical skill change, independent of the agent's current state. */
export function skillChangeDigest(
  agentGuid: string,
  requested: Record<string, boolean>,
  tier?: string,
): string {
  const entries = Object.keys(requested).sort().map(name => `${name}=${requested[name] ? 1 : 0}`);
  return crypto.createHash('sha256')
    .update([agentGuid, tier ?? '', ...entries].join('\n'))
    .digest('hex')
    .slice(0, 10);
}

function cents(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'none' : String(Math.round(value * 100));
}

/** Fingerprint of the monthly price before and after a change, as it was quoted. */
export function skillPriceTag(currentUsd: number | null, newUsd: number | null): string {
  return crypto.createHash('sha256')
    .update(`${cents(currentUsd)}:${cents(newUsd)}`)
    .digest('hex')
    .slice(0, 8);
}

export function newSkillChangeKey(digest: string, priceTag: string): string {
  return `mcp-${crypto.randomBytes(8).toString('hex')}-${digest}-${priceTag}`;
}

/** The change and price fingerprints of a key minted by this package, or null for any other key. */
export function parseSkillChangeKey(key: string): { digest: string; priceTag: string } | null {
  const match = IDEMPOTENCY_KEY_RE.exec(key.trim());
  return match ? { digest: match[1] as string, priceTag: match[2] as string } : null;
}

/**
 * Keys minted by this package carry the fingerprint of their change. Wiro
 * replays a cached success for a reused key, so a key reused for a different
 * change would report success without applying it.
 */
export function idempotencyKeyMismatch(key: string, digest: string): boolean {
  const parsed = parseSkillChangeKey(key);
  return parsed !== null && parsed.digest !== digest;
}

export interface PlanBilling {
  plan: 'prepaid' | 'card' | 'none';
  status: string | null;
  periodEnd: number | null;
  daysRemaining: number | null;
  wallet: 'team' | 'personal';
  /** Cancelled: the plan ends with this period and is not renewed. */
  cancelAtPeriodEnd: boolean;
}

export function planBilling(row: Row): PlanBilling {
  const wallet = asString(row.teamguid) ? 'team' : 'personal';
  const subscription = isPlainObject(row.subscription) ? row.subscription : null;
  if (!subscription) {
    return { plan: 'none', status: null, periodEnd: null, daysRemaining: null, wallet, cancelAtPeriodEnd: false };
  }
  return {
    plan: asString(subscription.provider) === 'prepaid' ? 'prepaid' : 'card',
    status: asString(subscription.status) ?? null,
    periodEnd: toNumber(subscription.currentperiodend),
    daysRemaining: toNumber(subscription.daysremaining),
    wallet,
    cancelAtPeriodEnd: subscription.pendingdowngrade === 'cancel' || row.stripecancelatperiodend === true,
  };
}

/**
 * Wiro charges a prepaid plan the monthly difference for the days left in the
 * period. The period start is not exposed, so a 30-day period is assumed.
 */
export function estimateProratedUsd(
  deltaUsd: number,
  periodEndUnix: number | null,
  nowMs = Date.now(),
  periodDays = 30,
): number | null {
  if (periodEndUnix === null || !Number.isFinite(deltaUsd)) return null;
  const remainingDays = Math.max(0, Math.round((periodEndUnix - nowMs / 1000) / 86400));
  return Math.round((deltaUsd / periodDays) * remainingDays * 100) / 100;
}

export interface SkillsApplyFailure {
  code: number | null;
  message: string;
  guidance: string;
  retrySameKey: boolean;
  deps?: Array<{ skill: string; requires: string }>;
  conflicts?: Array<{ a: string; b: string }>;
  requiredUsd?: number | null;
  availableUsd?: number | null;
}

/** Turns a refused SkillsApply into an explanation and the step that fixes it. */
export function describeSkillsApplyError(error: unknown): SkillsApplyFailure {
  const message = error instanceof Error ? error.message : String(error);
  const body = error instanceof ApiResultError ? error.body : {};
  const codes = error instanceof ApiResultError ? error.codes.map(code => toNumber(code)) : [];
  const code = codes.find(candidate => candidate !== null && candidate >= 95 && candidate <= 109) ?? null;
  const base = { code, message, retrySameKey: false };
  switch (code) {
    case 101: {
      const deps = (Array.isArray(body.deps) ? body.deps : [])
        .filter(isPlainObject)
        .map(dep => ({ skill: asString(dep.skill) ?? '', requires: asString(dep.requires) ?? '' }));
      return {
        ...base,
        deps,
        guidance: `Some skills need others that would be off: ${deps.map(dep => `${dep.skill} needs ${dep.requires}`).join('; ')}. Turn the needed skills on in the same change (add_dependencies does this for skills you turn on), or keep them on when you turn other skills off.`,
      };
    }
    case 102: {
      const conflicts = (Array.isArray(body.conflicts) ? body.conflicts : [])
        .filter(isPlainObject)
        .map(pair => ({ a: asString(pair.a) ?? '', b: asString(pair.b) ?? '' }));
      return {
        ...base,
        conflicts,
        guidance: `These skills cannot be on together: ${conflicts.map(pair => `${pair.a} and ${pair.b}`).join('; ')}. Keep only one of each pair.`,
      };
    }
    case 103: {
      const requiredUsd = toNumber(body.requiredUsd);
      const availableUsd = toNumber(body.availableUsd);
      return {
        ...base,
        requiredUsd,
        availableUsd,
        guidance: `The wallet does not cover the charge for the rest of this period${requiredUsd !== null ? `: it needs ${formatUsd(requiredUsd)}` : ''}${availableUsd !== null ? ` and has ${formatUsd(availableUsd)}` : ''}. Nothing was changed. Add funds to the wallet, then confirm again.`,
      };
    }
    case 104:
      return {
        ...base,
        retrySameKey: true,
        guidance: 'Another skill change for this agent is still running. Wait a few seconds, then repeat the call with the same idempotency_key.',
      };
    case 105:
      return {
        ...base,
        guidance: 'A Pro plan cannot be moved back to Starter here. Cancel the plan with manage_agent_billing and subscribe again at Starter once it ends.',
      };
    case 106:
      return {
        ...base,
        guidance: 'The agent\'s subscription is not active, so its skills cannot change. Renew it with manage_agent_billing first.',
      };
    case 107:
      return {
        ...base,
        guidance: 'Repeat the call without idempotency_key to start a fresh change.',
      };
    case 108:
      return {
        ...base,
        retrySameKey: true,
        guidance: 'Nothing was changed. Repeat the call with the same idempotency_key.',
      };
    case 109:
      return {
        ...base,
        guidance: 'The card payment failed and the change was rolled back. Update the card in the Wiro dashboard, then try again.',
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
  if (/pricing snapshot|not found in registry/i.test(message)) {
    return {
      ...base,
      guidance: 'The new price could not be computed, so nothing was changed. Check the skill names with list_agent_skills.',
    };
  }
  return { ...base, guidance: workspaceHint(message) ?? '' };
}

/** The API names a dashboard concept ("team context"); for an API key the workspace is the key's project. */
export function workspaceHint(message: string): string | undefined {
  return /switch to the (team|personal)|different team|personal workspace/i.test(message)
    ? 'Use an API key from a project in the workspace (personal or team) that owns this agent.'
    : undefined;
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
  oauthManaged: boolean;
  autoFilled: boolean;
  serverManaged: boolean;
  platformManaged: boolean;
  onlyInModes: string[] | null;
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

export interface NextPickerMeta {
  key: string;
  label: string;
  optional: boolean;
  parentValueField: string;
  parentLabelField: string;
  itemValueField: string;
  itemLabelField: string;
  persistField: string;
}

export interface PickerMeta {
  multiSelect: boolean;
  valueField: string;
  labelField?: string;
  fieldsToSave: string[];
  urlItemFields: Record<string, string>;
  pendingCache: boolean;
  next: NextPickerMeta | null;
}

export interface OAuthMeta {
  callbackPath?: string;
  stateFields: string[];
  connectRequirements: string[];
  directProbe: { mode: string; label?: string; requiredFields: string[] } | null;
  picker: PickerMeta | null;
}

export interface CredentialMeta {
  key: string;
  title: string;
  connectionModes: string[];
  defaultConnectionMode?: string;
  wiroPending: boolean;
  fields: CredentialField[];
  channel: { id: string; requiredFields: string[] } | null;
  oauth: OAuthMeta | null;
  platformOnly: boolean;
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
    oauthManaged: raw.oauth_managed === true,
    autoFilled: raw.auto_filled_by_oauth === true,
    serverManaged: raw.server_managed === true,
    platformManaged: raw.platform_managed === true,
    onlyInModes: Array.isArray(raw.only_in_modes) ? stringList(raw.only_in_modes) : null,
    ...(asString(raw.pattern) ? { pattern: asString(raw.pattern) } : {}),
    ...(toNumber(raw.minlength) !== null ? { minLength: toNumber(raw.minlength) as number } : {}),
    ...(toNumber(raw.maxlength) !== null ? { maxLength: toNumber(raw.maxlength) as number } : {}),
    ...(parseOptions(raw.options) ? { options: parseOptions(raw.options) } : {}),
    ...(Array.isArray(raw.filetypes) ? { fileTypes: stringList(raw.filetypes) } : {}),
    ...(toNumber(raw.maxsize) !== null ? { maxSizeKb: toNumber(raw.maxsize) as number } : {}),
    ...(asString(raw.item_type) ? { itemType: asString(raw.item_type) } : {}),
    itemSchema: itemSchemaOf(raw).map(parseCredentialField).filter(field => field.key),
    ...(htmlToText(raw.help) ? { help: htmlToText(raw.help) } : {}),
    ...(asString(raw.placeholder) ? { placeholder: asString(raw.placeholder) } : {}),
  };
}

function parsePicker(raw: unknown): PickerMeta | null {
  if (!isPlainObject(raw) || raw.enabled === false) return null;
  const valueField = asString(raw.item_value_field);
  if (!valueField) return null;
  const urlItemFields: Record<string, string> = {};
  if (isPlainObject(raw.url_item_fields)) {
    for (const [saved, source] of Object.entries(raw.url_item_fields)) {
      if (asString(source)) urlItemFields[saved] = asString(source) as string;
    }
  }
  const nextRaw = isPlainObject(raw.next) && raw.next.enabled !== false ? raw.next : null;
  const next = nextRaw && asString(nextRaw.key) && asString(nextRaw.item_value_field)
    ? {
      key: asString(nextRaw.key) as string,
      label: asString(nextRaw.modal_title)?.replace(/^select\s+/i, '') ?? (asString(nextRaw.key) as string),
      optional: nextRaw.optional === true,
      parentValueField: asString(nextRaw.parent_value_field) ?? valueField,
      parentLabelField: asString(nextRaw.parent_label_field) ?? asString(raw.item_label_field) ?? valueField,
      itemValueField: asString(nextRaw.item_value_field) as string,
      itemLabelField: asString(nextRaw.item_label_field) ?? (asString(nextRaw.item_value_field) as string),
      persistField: asString(nextRaw.persist_field) ?? '',
    }
    : null;
  return {
    multiSelect: raw.multi_select === true,
    valueField,
    ...(asString(raw.item_label_field) ? { labelField: asString(raw.item_label_field) } : {}),
    fieldsToSave: stringList(raw.item_fields_to_save).length > 0 ? stringList(raw.item_fields_to_save) : [valueField],
    urlItemFields,
    pendingCache: isPlainObject(raw.pending_cache),
    next,
  };
}

export function parseCredentialMeta(raw: Row): CredentialMeta {
  const key = asString(raw.key) ?? '';
  const fields = (Array.isArray(raw.credential_schema) ? raw.credential_schema : [])
    .filter(isPlainObject)
    .map(parseCredentialField)
    .filter(field => field.key);
  const provider = isPlainObject(raw.oauth_provider) ? raw.oauth_provider : null;
  let oauth: OAuthMeta | null = null;
  if (provider) {
    const flow = isPlainObject(provider.oauth_flow) ? provider.oauth_flow : {};
    const probe = isPlainObject(provider.direct_probe) ? provider.direct_probe : null;
    const tokenField = probe ? asString(probe.token_field) : undefined;
    oauth = {
      ...(asString(flow.callback_path) ? { callbackPath: asString(flow.callback_path) } : {}),
      stateFields: stringList(flow.state_fields),
      connectRequirements: (Array.isArray(flow.connect_requirements) ? flow.connect_requirements : [])
        .filter(isPlainObject)
        .map(requirement => asString(requirement.message) ?? '')
        .filter(Boolean),
      directProbe: probe
        ? {
          mode: asString(probe.mode) ?? 'api_key',
          ...(asString(probe.mode_label) ? { label: asString(probe.mode_label) } : {}),
          requiredFields: stringList(probe.required_fields).length > 0
            ? stringList(probe.required_fields)
            : (tokenField ? [tokenField] : []),
        }
        : null,
      picker: parsePicker(provider.account_picker),
    };
  }
  const channel = isPlainObject(raw.channel)
    ? { id: asString(raw.channel.id) ?? key, requiredFields: stringList(raw.channel.required_fields) }
    : null;
  return {
    key,
    title: asString(raw.title) ?? key,
    connectionModes: stringList(raw.connection_modes),
    ...(asString(raw.default_connection_mode) ? { defaultConnectionMode: asString(raw.default_connection_mode) } : {}),
    wiroPending: raw.wiro_connect_pending === true,
    fields,
    channel,
    oauth,
    platformOnly: raw.credential_mode === 'rule_only'
      || (!provider && fields.length > 0 && fields.every(field => field.platformManaged)),
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

export type FieldShape = 'object-array' | 'string-array' | 'file' | 'base64-file' | 'boolean' | 'number' | 'select' | 'text';

const OBJECT_LIST_TYPES = new Set([
  'custom:apps-list-ios',
  'custom:apps-list-android',
  'custom:apps-list-adjust',
  'custom:urls-list',
  'custom:firebase-accounts-list',
  'custom:drive-folder-picker',
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
  if (type === 'fileinput-base64') return 'base64-file';
  if (type === 'boolean') return 'boolean';
  if (type === 'number') return 'number';
  if (type === 'select') return 'select';
  return 'text';
}

/** Fields the connection flow or Wiro fills; customers cannot write them. */
export function isWritableField(field: CredentialField): boolean {
  return !field.autoFilled && !field.serverManaged && !field.platformManaged && field.type !== 'computed';
}

// Token state the connection flow owns.
const CONNECTION_STATE_FIELDS = new Set([
  'accesstoken',
  'refreshtoken',
  'connectedat',
  'tokenexpiresat',
  'refreshtokenexpiresat',
]);

/**
 * Base64 file fields hold the file's bytes as base64. Callers often have the
 * file's text instead (a service account JSON, a .p8 key), so anything that is
 * not already base64 is encoded here.
 */
export function normalizeBase64FileValue(value: string): string {
  const dataUrl = /^data:[^,]*;base64,(.*)$/s.exec(value.trim());
  if (dataUrl) return (dataUrl[1] ?? '').replace(/\s+/g, '');
  const compact = value.replace(/\s+/g, '');
  if (compact && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return compact;
  return Buffer.from(value, 'utf8').toString('base64');
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

// Short values (select options, flags) are not secrets and would garble messages.
function collectStrings(value: unknown, into: string[]): void {
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

function listValue(
  field: CredentialField,
  value: unknown,
  label: string,
): { value?: unknown; error?: string } {
  const shape = credentialFieldShape(field);
  if (!Array.isArray(value)) return { error: `${label} takes a list (JSON array).` };
  if (shape === 'string-array') {
    const items: string[] = [];
    for (const [index, item] of value.entries()) {
      if (typeof item !== 'string' && typeof item !== 'number') {
        return { error: `${label} takes a list of text values; item ${index + 1} is not one.` };
      }
      const text = String(item).trim();
      if (!text) continue;
      const problem = patternError(field, text, `${label} item ${index + 1}`);
      if (problem) return { error: problem };
      items.push(text);
    }
    return { value: items };
  }
  const allowed = new Set(field.itemSchema.map(item => item.key));
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) return { error: `${label} takes a list of objects; item ${index + 1} is not one.` };
    if (allowed.size > 0) {
      const unknown = Object.keys(item).filter(key => !allowed.has(key));
      if (unknown.length > 0) {
        return { error: `${label} item ${index + 1} has unknown keys (${unknown.join(', ')}). Allowed: ${[...allowed].join(', ')}.` };
      }
    }
  }
  return { value };
}

/**
 * Checks every requested field against the credential registry and builds the
 * API payload. Nothing is written when any field is refused: the API validates
 * the whole request too, but it silently stores names it does not know.
 */
export function prepareCredentialWrite(
  inputs: CredentialFieldInput[],
  metas: Map<string, CredentialMeta | null>,
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
        prepared.errors.push(`Unknown credential "${credential}". The credential keys a skill uses are listed by list_agent_skills and get_my_agent.`);
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
    if (CONNECTION_STATE_FIELDS.has(fieldName)) {
      prepared.errors.push(`${meta.title}: "${fieldName}" is filled by the connection itself. Use connect_agent_oauth.`);
      continue;
    }

    if (fieldName === 'authmethod') {
      if (input.parent_field || meta.connectionModes.length === 0) {
        prepared.errors.push(`${meta.title} has no connection modes, so "authmethod" does not apply.`);
      } else if (typeof input.value !== 'string' || !meta.connectionModes.includes(input.value)) {
        prepared.errors.push(`${meta.title}: authmethod must be one of ${meta.connectionModes.join(', ')}.`);
      } else {
        prepared.apiFields.push({ credentialkey: credential, fieldname: 'authmethod', fieldvalue: input.value });
      }
      continue;
    }

    if (input.parent_field) {
      const root = input.parent_field.split(/[.[\]]/)[0] ?? '';
      const parent = meta.fields.find(field => field.key === root);
      if (!parent || credentialFieldShape(parent) !== 'object-array') {
        prepared.errors.push(`${meta.title} has no list field "${root}" for parent_field. List fields: ${meta.fields.filter(field => credentialFieldShape(field) === 'object-array').map(field => field.key).join(', ') || 'none'}.`);
        continue;
      }
      if (!isWritableField(parent)) {
        prepared.errors.push(`${parent.label} is filled by the connection or by Wiro and cannot be set.`);
        continue;
      }
      const item = parent.itemSchema.find(candidate => candidate.key === fieldName);
      if (parent.itemSchema.length > 0 && !item) {
        prepared.errors.push(`${parent.label} items have no field "${fieldName}". Item fields: ${parent.itemSchema.map(candidate => candidate.key).join(', ')}.`);
        continue;
      }
      if (input.ordinal === undefined) {
        prepared.errors.push(`${parent.label}: ordinal (the item's position, from 0) is required with parent_field.`);
        continue;
      }
      let value = input.value;
      if (item && !isEmptyValue(value)) {
        const checked = Array.isArray(value)
          ? listValue({ ...item, type: 'string-array' }, value, `${parent.label} ${item.label}`)
          : scalarValue(item, value, `${parent.label} ${item.label}`);
        if (checked.error) {
          prepared.errors.push(checked.error);
          continue;
        }
        value = checked.value;
      }
      prepared.apiFields.push({
        credentialkey: credential,
        fieldname: fieldName,
        fieldvalue: value ?? '',
        parentfield: input.parent_field,
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
      prepared.errors.push(`${field.label} is filled when the account is connected with connect_agent_oauth and cannot be set directly.`);
      continue;
    }

    const shape = credentialFieldShape(field);
    // Channel groups are optional as a whole: clearing one activation field turns the channel off.
    const mayClear = !field.required || meta.channel !== null;
    if (isEmptyValue(input.value)) {
      if (!mayClear) {
        prepared.errors.push(`${field.label} is required and cannot be cleared.`);
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
    if (shape === 'base64-file') {
      if (typeof input.value !== 'string') {
        prepared.errors.push(`${field.label} takes the file's content as text or base64.`);
        continue;
      }
      // A link would be saved as the key itself. Key files are never fetched from a URL.
      if (/^\s*https?:\/\//i.test(input.value)) {
        prepared.errors.push(`${field.label} takes the file's content as text or base64, not a link. The user can paste the file's text or upload the file on the agent's page in the Wiro dashboard.`);
        continue;
      }
      prepared.apiFields.push({
        credentialkey: credential,
        fieldname: fieldName,
        fieldvalue: normalizeBase64FileValue(input.value),
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
// Agent credential status (from /UserAgent/Detail, values never read out)
// ---------------------------------------------------------------------------

export function isFilledValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(isFilledValue);
  if (isPlainObject(value)) return Object.values(value).some(isFilledValue);
  return true;
}

export function credentialGroup(row: Row, key: string): Row | null {
  const groups = isPlainObject(row.credentials) ? row.credentials : null;
  const group = groups ? groups[key] : undefined;
  return isPlainObject(group) ? group : null;
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
  // A sign-in credential's required fields depend on its mode; connected is the signal there.
  const missingFields = connected || !meta || meta.oauth
    ? []
    : meta.fields
      .filter(field => field.required && isWritableField(field) && !isFilledValue(group[field.key]))
      .map(field => field.label);
  return {
    key,
    title: asString(schema.title) ?? meta?.title ?? key,
    connected,
    filled: group._filled === true,
    requiredMissing: group._required_missing === true,
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
// Sign-in connections (connect_agent_oauth)
// ---------------------------------------------------------------------------

/**
 * Wiro sends the browser to this address after sign-in with the connected
 * account names appended, so only the agent's own dashboard page or an
 * address on the user's own machine is accepted.
 */
export function isAllowedRedirectUrl(url: string, agentGuid: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'http:') return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const dashboard = new URL(dashboardAgentUrl(agentGuid));
  return parsed.protocol === 'https:'
    && parsed.host === dashboard.host
    && parsed.pathname.replace(/\/+$/, '') === dashboard.pathname
    && (parsed.search === '' || parsed.search === dashboard.search)
    && parsed.hash === '';
}

/** The redirect URI a customer registers in their own OAuth app. */
export function ownAppRedirectUri(meta: CredentialMeta): string | undefined {
  return meta.oauth?.callbackPath ? `${OAUTH_CALLBACK_BASE}${meta.oauth.callbackPath}` : undefined;
}

export interface ModeRequirement {
  mode: string;
  available: boolean;
  needsBrowser: boolean;
  fields: Array<{ field: string; label: string; isSet: boolean }>;
  note: string;
}

function fieldsForMode(meta: CredentialMeta, mode: string): CredentialField[] {
  if (mode === 'wiro') return [];
  const byKey = new Map(meta.fields.map(field => [field.key, field]));
  const keys: string[] = [];
  if (mode === meta.oauth?.directProbe?.mode) {
    keys.push(...meta.oauth.directProbe.requiredFields);
  } else {
    for (const field of meta.fields) {
      if (isWritableField(field) && field.onlyInModes?.includes(mode)) keys.push(field.key);
    }
    if (mode === 'own') keys.push(...(meta.oauth?.stateFields ?? []));
  }
  return [...new Set(keys)]
    .map(key => byKey.get(key) ?? { ...parseCredentialField({ key }), required: true })
    .filter(field => isWritableField(field));
}

/** What each connection mode needs, with which of those fields are already saved. */
export function connectionModeRequirements(meta: CredentialMeta, group: Row | null): ModeRequirement[] {
  const modes = meta.connectionModes.length > 0 ? meta.connectionModes : ['wiro'];
  return modes.map(mode => {
    const fields = fieldsForMode(meta, mode).map(field => ({
      field: field.key,
      label: field.label,
      isSet: group !== null && isFilledValue(group[field.key]),
    }));
    if (mode === 'wiro') {
      return {
        mode,
        available: !meta.wiroPending,
        needsBrowser: true,
        fields,
        note: meta.wiroPending
          ? `Wiro's own ${meta.title} app is not available yet. Use another mode.`
          : `Sign in through Wiro's own ${meta.title} app. Nothing to set up first.`,
      };
    }
    if (mode === meta.oauth?.directProbe?.mode) {
      return {
        mode,
        available: true,
        needsBrowser: false,
        fields,
        note: `Save ${meta.oauth.directProbe.label ? `the ${meta.oauth.directProbe.label}` : 'these fields'} with set_agent_credentials, then connect with mode ${mode}. Wiro checks it and lists the accounts it can use. No browser needed.`,
      };
    }
    if (mode === 'api_key') {
      return {
        mode,
        available: true,
        needsBrowser: false,
        fields,
        note: `Save these fields with set_agent_credentials together with authmethod ${mode}. There is no sign-in or connect step for this mode.`,
      };
    }
    if (mode === 'own') {
      const redirect = ownAppRedirectUri(meta);
      const requirements = meta.oauth?.connectRequirements ?? [];
      return {
        mode,
        available: true,
        needsBrowser: true,
        fields,
        note: `Use your own ${meta.title} app: save its keys with set_agent_credentials${redirect ? ` and allow ${redirect} as a redirect URI in the app` : ''}, then connect with mode own and sign in.${requirements.length > 0 ? ` ${requirements.join(' ')}` : ''}`,
      };
    }
    return { mode, available: true, needsBrowser: true, fields, note: `Connect with mode ${mode}.` };
  });
}

/**
 * The mode to use when the caller did not name one: Wiro's own app when it is
 * available, the only remaining mode, or the first mode whose fields are
 * already saved (the registry's default first).
 */
export function chooseConnectionMode(meta: CredentialMeta, requirements: ModeRequirement[]): string | null {
  const usable = requirements.filter(requirement => requirement.available);
  const wiro = usable.find(requirement => requirement.mode === 'wiro');
  if (wiro) return 'wiro';
  if (usable.length === 1) return usable[0]?.mode ?? null;
  const ordered = [...usable].sort((left, right) => {
    const preferred = meta.defaultConnectionMode;
    return Number(right.mode === preferred) - Number(left.mode === preferred);
  });
  return ordered.find(requirement => requirement.fields.every(field => field.isSet))?.mode ?? null;
}

export interface AccountRef {
  id: string;
  name: string;
}

/** Candidate or saved accounts in one shape, whatever the provider calls the fields. */
export function toAccountRefs(list: unknown, picker?: PickerMeta | null): AccountRef[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isPlainObject).map(item => {
    const id = asString(item.id) ?? (picker ? asString(item[picker.valueField]) : undefined) ?? '';
    const name = asString(item.name)
      ?? asString(item.title)
      ?? asString(item.displayName)
      ?? (picker?.labelField ? asString(item[picker.labelField]) : undefined)
      ?? '';
    return { id, name };
  }).filter(account => account.id);
}

/** Maps {id, name} selections onto the fields the picker saves. */
export function buildPickerAccounts(
  picker: PickerMeta,
  accounts: Array<Record<string, unknown>>,
): { accounts?: Array<Record<string, string>>; error?: string } {
  if (accounts.length === 0) return { error: 'Pass at least one account.' };
  if (!picker.multiSelect && accounts.length !== 1) return { error: 'This connection uses exactly one account.' };
  const seen = new Set<string>();
  const out: Array<Record<string, string>> = [];
  for (const account of accounts) {
    const id = asString(account.id) ?? asString(account[picker.valueField]) ?? '';
    const name = asString(account.name)
      ?? (picker.labelField ? asString(account[picker.labelField]) : undefined)
      ?? asString(account.title)
      ?? asString(account.displayName)
      ?? '';
    if (!id.trim()) return { error: 'Every account needs an id.' };
    if (seen.has(id.trim())) return { error: `Account ${id} is listed twice.` };
    seen.add(id.trim());
    const mapped: Record<string, string> = {};
    for (const field of picker.fieldsToSave) {
      if (field === picker.valueField) mapped[field] = id.trim();
      else if (field === picker.labelField) mapped[field] = name;
      else if (asString(account[field]) !== undefined) mapped[field] = asString(account[field]) as string;
      else mapped[field] = picker.urlItemFields[field] === 'id' ? id.trim() : name;
    }
    out.push(mapped);
  }
  return { accounts: out };
}

export interface DiscoveredGroup {
  parent: AccountRef;
  items: AccountRef[];
  errorCode?: string;
}

export function parseDiscoveredGroups(next: NextPickerMeta, groups: unknown): DiscoveredGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups.filter(isPlainObject).map(group => {
    const parent = isPlainObject(group.parent) ? group.parent : {};
    const items = Array.isArray(group.items) ? group.items.filter(isPlainObject) : [];
    return {
      parent: {
        id: asString(parent[next.parentValueField]) ?? '',
        name: asString(parent[next.parentLabelField]) ?? '',
      },
      items: items
        .map(item => ({
          id: asString(item[next.itemValueField]) ?? '',
          name: asString(item[next.itemLabelField]) ?? '',
        }))
        .filter(item => item.id),
      ...(asString(group.errorcode) ? { errorCode: asString(group.errorcode) } : {}),
    };
  });
}

function sameId(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  const digits = (value: string) => value.replace(/\D+/g, '');
  return digits(left) !== '' && digits(left) === digits(right);
}

/**
 * Builds the chained-step payload from a fresh discovery. The API wants every
 * readable parent exactly once and each item with its discovered label, so
 * parents the caller left out are sent with no items.
 */
export function buildChainedSelections(
  next: NextPickerMeta,
  groups: DiscoveredGroup[],
  selections: Array<{ parent: string; items: string[] }>,
): { selections?: Array<{ parentvalue: string; items: Array<Record<string, string>> }>; skippedParents: AccountRef[]; error?: string } {
  const chosen = new Map<string, string[]>();
  for (const selection of selections) {
    const group = groups.find(candidate => sameId(candidate.parent.id, selection.parent));
    if (!group) {
      return {
        skippedParents: [],
        error: `Account "${selection.parent}" is not among the connected accounts (${groups.map(candidate => candidate.parent.id).join(', ') || 'none'}).`,
      };
    }
    if (group.errorCode) {
      return {
        skippedParents: [],
        error: `${group.parent.name || group.parent.id} could not be read (${group.errorCode}), so nothing can be chosen for it. Leave it out.`,
      };
    }
    const ids = chosen.get(group.parent.id) ?? [];
    for (const itemId of selection.items) {
      const item = group.items.find(candidate => sameId(candidate.id, itemId));
      if (!item) {
        return {
          skippedParents: [],
          error: `"${itemId}" is not available under ${group.parent.name || group.parent.id}. Available: ${group.items.map(candidate => `${candidate.id} (${candidate.name})`).join(', ') || 'none'}.`,
        };
      }
      if (!ids.includes(item.id)) ids.push(item.id);
    }
    chosen.set(group.parent.id, ids);
  }
  const skippedParents: AccountRef[] = [];
  const payload = groups.filter(group => !group.errorCode).map(group => {
    const ids = chosen.get(group.parent.id);
    if (!ids) skippedParents.push(group.parent);
    return {
      parentvalue: group.parent.id,
      items: group.items
        .filter(item => ids?.includes(item.id))
        .map(item => ({ [next.itemValueField]: item.id, [next.itemLabelField]: item.name })),
    };
  });
  return { selections: payload, skippedParents };
}

export interface ChildStepStatus {
  picker: string;
  optional: boolean;
  configured: boolean;
  groups: Array<{ parent: AccountRef; items: AccountRef[] }>;
}

export interface OAuthStatusSnapshot {
  connected: boolean;
  accounts: AccountRef[];
  connectedAt: string;
  tokenExpiresAt: string;
  childStep: ChildStepStatus | null;
}

export function parseOAuthStatus(body: Row, picker: PickerMeta | null): OAuthStatusSnapshot {
  let childStep: ChildStepStatus | null = null;
  const next = picker?.next;
  const steps = isPlainObject(body.pickersteps) ? body.pickersteps : null;
  const step = next && steps && isPlainObject(steps[next.key]) ? steps[next.key] as Row : null;
  if (next && step) {
    childStep = {
      picker: next.key,
      optional: step.optional === true,
      configured: step.configured === true,
      groups: parseDiscoveredGroups(next, step.groups).map(group => ({ parent: group.parent, items: group.items })),
    };
  }
  return {
    connected: body.connected === true,
    accounts: toAccountRefs(body.accounts, picker),
    connectedAt: asString(body.connectedat) ?? '',
    tokenExpiresAt: asString(body.tokenexpiresat) ?? '',
    childStep,
  };
}

export async function readOAuthStatus(
  client: WiroClient,
  agentGuid: string,
  credential: string,
  picker: PickerMeta | null,
  signal?: AbortSignal,
): Promise<OAuthStatusSnapshot> {
  const body = requireApiSuccess(
    await client.post<ApiEnvelope & Row>('/UserAgentOAuth/OAuthStatus', {
      useragentguid: agentGuid,
      credentialkey: credential,
    }, signal),
    'Could not read the connection status.',
  );
  return parseOAuthStatus(body, picker);
}

export type ConnectionState =
  | 'connected'
  | 'pick_accounts'
  | 'pick_child_items'
  | 'waiting_for_user'
  | 'token_expired'
  | 'not_connected';

/**
 * Wiro reports a picker credential as not connected until an account is
 * saved, so a fresh connectedat with no accounts means "signed in, accounts
 * still to choose". since is the connectedat seen before the sign-in started.
 */
export function connectionState(
  status: OAuthStatusSnapshot,
  options: { hasPicker: boolean; since?: string; nowMs?: number },
): ConnectionState {
  if (options.since !== undefined && status.connectedAt === options.since) return 'waiting_for_user';
  if (status.connected) {
    return status.childStep && !status.childStep.optional && !status.childStep.configured
      ? 'pick_child_items'
      : 'connected';
  }
  const expiresAt = Date.parse(status.tokenExpiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= (options.nowMs ?? Date.now())
    && (status.accounts.length > 0 || status.connectedAt)) {
    return 'token_expired';
  }
  if (options.hasPicker && status.connectedAt && status.accounts.length === 0) return 'pick_accounts';
  return 'not_connected';
}

// ---------------------------------------------------------------------------
// Custom skills and scheduled tasks (manage_agent_custom_skill)
// ---------------------------------------------------------------------------

export type CustomSkillKind = 'skill' | 'scheduled_task';

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
 * The key an upsert writes. The API does not echo it, so it is computed with
 * the API's own rules. With the agent's entries, a bare key with no kind and
 * no interval names the existing entry of that name, as rename, delete,
 * history and revert do; the API would otherwise create a new cs- entry.
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
  return { error: `This agent has no custom skill or scheduled task named "${input}". Pass the full key (cs-... or cs-cron-...) or check get_my_agent.` };
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
}

/** The runtime always runs a template's scheduled task with the template's own prompt. */
export function templateTaskTextError(key: string): string {
  return `The text of ${key} comes from the agent's template and cannot be changed; only its schedule (interval) and on/off state (enabled) can. To change what it does, edit the related custom skill (a cs- key without cron), or create your own scheduled task.`;
}

/**
 * Checks deploy_agent's custom_skills the way manage_agent_custom_skill
 * would. Deploy stores entries without validating them, so a broken
 * schedule or an entry without text would be paid for and never run. A bare
 * key names the template's own entry of that name when it has one. Without
 * the template's entries only the checks that need no template run.
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
    if (entry.value !== undefined && !entry.value.trim()) {
      errors.push(`${key}: value cannot be empty.${fromTemplate ? ' Leave it out to keep the template\'s text.' : ''}`);
      continue;
    }
    if (templateTask && entry.value !== undefined) {
      errors.push(templateTaskTextError(key));
      continue;
    }
    if (template && !fromTemplate && entry.value === undefined) {
      errors.push(`${key} is a new ${kind === 'scheduled_task' ? 'scheduled task, so it needs value: the prompt the agent runs on schedule' : 'custom skill, so it needs value: the instructions the agent follows'}.`);
      continue;
    }
    // Wiro saves a scheduled task sent without a schedule on its weekly
    // default, which would replace the template's own schedule.
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
    };
  }).filter(entry => entry.key);
}

/** Readable text for the API's untranslated custom skill errors. */
export function customSkillErrorMessage(message: string): string {
  if (/invalid-cron-expression|invalid cron/i.test(message)) {
    return 'The schedule is not a valid cron expression. Use five fields: minute hour day-of-month month day-of-week, for example "0 9 * * 1-5".';
  }
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
