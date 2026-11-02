import { z } from 'zod';
import { WiroApiError } from '../client.js';
import {
  AGENT_NOT_FOUND_TEXT,
  ApiResultError,
  asString,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  truncate,
  unixToIso,
  type ApiEnvelope,
} from './api.js';
import { pollUntil, reportProgress, type ToolCallContext } from './poll.js';
import { quotedSpan } from './quoted-text.js';

// Deployed agents and the agent catalog. Results are rebuilt from an
// allowlist: only states, labels, prices and settings are returned.

export const AGENT_DASHBOARD_URL = 'https://wiro.ai/panel/agents';

export function agentDashboardUrl(guid: string): string {
  return `${AGENT_DASHBOARD_URL}/${encodeURIComponent(guid)}`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_LABELS = [
  'stopped',
  'stopping',
  'queued',
  'starting',
  'running',
  'error',
  'setup_required',
  'unknown',
] as const;

export const agentStatusLabelSchema = z.enum(STATUS_LABELS);
export type AgentStatusLabel = z.infer<typeof agentStatusLabelSchema>;

const STATUS_TEXT: Record<AgentStatusLabel, string> = {
  stopped: 'Stopped',
  stopping: 'Stopping',
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  error: 'Error',
  setup_required: 'Setup required',
  unknown: 'Unknown',
};

const STATUS_HINT: Record<AgentStatusLabel, string> = {
  stopped: 'It is not running. control_agent with action start starts it.',
  stopping: 'It is shutting down. If a restart was requested it is queued again on its own.',
  queued: 'It is waiting to start. This can take a while.',
  starting: 'It is starting up. If it does not come up within about two minutes it moves to error.',
  running: 'It is live and accepts messages.',
  error: 'The start failed or the agent stopped unexpectedly. control_agent with action start retries, and get_agent_activity with kind logs may show why.',
  setup_required: 'It has no paid plan yet, or required credentials are missing. It does not leave this state on its own.',
  unknown: 'The status could not be read.',
};

export function readAgentStatus(row: Record<string, unknown>): number | null {
  const status = toNumber(row.status);
  return status === null ? null : Math.trunc(status);
}

export function agentStatusLabel(status: number | null | undefined): AgentStatusLabel {
  if (status === null || status === undefined || !Number.isInteger(status)) return 'unknown';
  return status >= 0 && status <= 6 ? STATUS_LABELS[status] : 'unknown';
}

/** "Running (4)" */
export function describeAgentStatus(status: number | null | undefined): string {
  const label = agentStatusLabel(status);
  return status === null || status === undefined
    ? STATUS_TEXT[label]
    : `${STATUS_TEXT[label]} (${status})`;
}

// On a team agent a team admin or the person who deployed it starts, changes
// and pays for it (the organization's owner can also pay for it). Other members
// can read it and message it, so their hints say who can act instead of naming
// a call they cannot make.
const TEAM_AGENT_MANAGERS = 'a team admin or the person who deployed it';
// Connected accounts are the exception: Wiro lets only the person who
// deployed the agent connect them (connect_agent_oauth).
export const MEMBER_SETUP_HELP = `On this team agent, ${TEAM_AGENT_MANAGERS} saves credentials and pays for the plan. `
  + 'Only the person who deployed it can connect accounts, such as Instagram or Google Ads.';

const MEMBER_STATUS_HINT: Partial<Record<AgentStatusLabel, string>> = {
  stopped: `It is not running. On this team agent, ${TEAM_AGENT_MANAGERS} can start it.`,
  error: `The start failed or the agent stopped unexpectedly. On this team agent, ${TEAM_AGENT_MANAGERS} can start it again and read its logs.`,
  setup_required: `${STATUS_HINT.setup_required} ${MEMBER_SETUP_HELP}`,
};

/** plainMember: the connection acts as a member of the agent's team without admin rights. */
export function agentStatusHint(status: number | null | undefined, plainMember = false): string {
  const label = agentStatusLabel(status);
  return (plainMember ? MEMBER_STATUS_HINT[label] : undefined) ?? STATUS_HINT[label];
}

/** Stopping, queued and starting move on by themselves; every other status stays until someone acts. */
export function isTransitionalStatus(status: number | null | undefined): boolean {
  return status === 1 || status === 2 || status === 3;
}

// ---------------------------------------------------------------------------
// Prices, plans and credits
// ---------------------------------------------------------------------------

export const AGENT_TIERS = ['starter', 'pro'] as const;
export type AgentTier = typeof AGENT_TIERS[number];

export const tierPriceSchema = z.object({
  priceUsd: z.number(),
  monthlyCredits: z.number(),
});

export const tierPricingSchema = z.object({
  starter: tierPriceSchema,
  pro: tierPriceSchema,
});

export type TierPricing = z.infer<typeof tierPricingSchema>;

function toTierPrice(value: unknown): z.infer<typeof tierPriceSchema> | null {
  if (!isPlainObject(value)) return null;
  const priceUsd = toNumber(value.priceUsd);
  const credits = toNumber(value.credits);
  if (priceUsd === null || credits === null) return null;
  return { priceUsd, monthlyCredits: credits };
}

/** Starter and Pro prices, or null when Wiro could not price the agent. */
export function toTierPricing(value: unknown): TierPricing | null {
  if (!isPlainObject(value)) return null;
  const starter = toTierPrice(value.starter);
  const pro = toTierPrice(value.pro);
  return starter && pro ? { starter, pro } : null;
}

export function asTier(value: unknown): AgentTier | undefined {
  return value === 'starter' || value === 'pro' ? value : undefined;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return `$${value.toFixed(2)}`;
}

export function formatCredits(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return Math.round(value).toLocaleString('en-US');
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

// A confirmed charge goes ahead only when a fresh quote still matches the
// amount the user approved; anything else is quoted again.
export const AMOUNT_TOLERANCE_USD = 0.005;

export function sameAmount(quoted: number, approved: number): boolean {
  return Math.abs(quoted - approved) <= AMOUNT_TOLERANCE_USD;
}

export const subscriptionSchema = z.object({
  status: z.string(),
  billing: z.enum(['wallet', 'card']),
  switchingToWallet: z.boolean(),
  amountUsd: z.number().nullable()
    .describe('What the plan costs every 30 days. For a plan that has ended, the agent\'s monthly price, which is what a renew charges.'),
  periodEndsAt: z.string().optional(),
  daysRemaining: z.number().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  atPeriodEnd: z.enum(['renews', 'ends', 'unknown']).optional()
    .describe('For an active plan, what happens at periodEndsAt: it renews, it ends, or unknown for a card plan whose renewal is managed in the Wiro dashboard.'),
});

export type AgentSubscription = z.infer<typeof subscriptionSchema>;

/**
 * Whether a plan ends with its current period: true when it ends, false when
 * it renews, null when that is not known. A wallet plan says so itself, and a
 * card plan moving to wallet billing renews from the wallet, even though its
 * card subscription is set to end with the period. Any other card plan is
 * known only when the row carries its card state (cardEnds).
 */
export function planEndsWithPeriod(subscription: Record<string, unknown>, cardEnds?: unknown): boolean | null {
  if (subscription.pendingdowngrade === 'cancel') return true;
  if (subscription.provider === 'prepaid' || subscription.nextprovider === 'prepaid') return false;
  if (cardEnds === true) return true;
  return cardEnds === false ? false : null;
}

export function toSubscription(value: unknown, cardEnds?: unknown): AgentSubscription | null {
  if (!isPlainObject(value)) return null;
  const provider = asString(value.provider) ?? 'stripe';
  const periodEndsAt = unixToIso(value.currentperiodend);
  const status = asString(value.status) ?? 'expired';
  const ends = planEndsWithPeriod(value, cardEnds);
  return {
    status,
    billing: provider === 'prepaid' ? 'wallet' : 'card',
    switchingToWallet: provider !== 'prepaid' && value.nextprovider === 'prepaid',
    amountUsd: toNumber(value.amount),
    ...(periodEndsAt ? { periodEndsAt } : {}),
    daysRemaining: toNumber(value.daysremaining),
    // True only when the plan is known to end; atPeriodEnd also tells a plan that renews from an unknown one.
    cancelAtPeriodEnd: ends === true,
    ...(status === 'active' ? { atPeriodEnd: ends === true ? 'ends' as const : ends === false ? 'renews' as const : 'unknown' as const } : {}),
  };
}

/** How a new charge for this plan is paid right now. */
export function chargeRoute(subscription: unknown): 'wallet' | 'card' | null {
  if (!isPlainObject(subscription)) return null;
  if (subscription.nextprovider === 'prepaid' || subscription.provider === 'prepaid') return 'wallet';
  return 'card';
}

export const creditsSchema = z.object({
  monthly: z.number()
    .describe('The monthly credits this period grants. A plan change inside a period moves it for the time left, so it can differ from renewal.'),
  renewal: z.number().optional()
    .describe('The monthly credits each renewal grants.'),
  extra: z.number(),
  used: z.number(),
  remaining: z.number(),
  period: z.string().optional(),
});

export type AgentCredits = z.infer<typeof creditsSchema>;

export function toCredits(row: Record<string, unknown>): AgentCredits {
  const period = asString(row.creditperiod);
  const renewal = toNumber(row.renewalcredits);
  return {
    monthly: toNumber(row.monthlycredits) ?? 0,
    ...(renewal !== null ? { renewal } : {}),
    extra: toNumber(row.extracredits) ?? 0,
    used: toNumber(row.usedcredits) ?? 0,
    remaining: toNumber(row.remainingcredits) ?? 0,
    ...(period ? { period } : {}),
  };
}

/** The monthly credits as said in a line: those of this period, and those of each renewal when they differ. */
export function monthlyCreditsText(credits: Pick<AgentCredits, 'monthly' | 'renewal'>): string {
  return credits.renewal !== undefined && credits.renewal !== credits.monthly
    ? `${formatCredits(credits.monthly)} credits this period, ${formatCredits(credits.renewal)} from each renewal`
    : `monthly ${formatCredits(credits.monthly)}`;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': '\'',
  '&amp;': '&',
};

/** Plain text from catalog HTML. Links keep their target so setup steps stay usable. */
export function htmlToText(value: unknown, maxLength?: number): string {
  const html = asString(value);
  if (!html) return '';
  const text = html
    .replace(/<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, inner: string) => {
      const label = inner.replace(/<[^>]*>/g, '').trim();
      if (!/^https?:\/\//i.test(href) || label.includes(href)) return label;
      return label ? `${label} (${href})` : href;
    })
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|li|div|ol|ul|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&lt;|&gt;|&quot;|&#39;|&amp;/g, entity => ENTITIES[entity] ?? entity)
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return maxLength ? truncate(text, maxLength) : text;
}

export function toStringArray(value: unknown): string[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return value.split(',').map(item => item.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((item: unknown) => (isPlainObject(item) ? asString(item.name) : asString(item)))
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
}

// ---------------------------------------------------------------------------
// Credentials, channels and tasks of a deployed agent
// ---------------------------------------------------------------------------

export const credentialStatusSchema = z.object({
  key: z.string(),
  title: z.string(),
  optional: z.boolean(),
  oauth: z.boolean(),
  connected: z.boolean(),
  filled: z.boolean(),
  requiredMissing: z.boolean(),
});

export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

/** The state of each credential: whether it is filled, connected or missing. */
export function summarizeCredentials(credentials: unknown, skipKeys: Set<string> = new Set()): CredentialStatus[] {
  if (!isPlainObject(credentials)) return [];
  const statuses: CredentialStatus[] = [];
  for (const [key, group] of Object.entries(credentials)) {
    if (key.startsWith('_') || skipKeys.has(key) || !isPlainObject(group)) continue;
    const schema = isPlainObject(group._schema) ? group._schema : {};
    statuses.push({
      key,
      title: asString(schema.title) ?? key,
      optional: group.optional === true,
      oauth: isPlainObject(schema.oauth_provider),
      connected: group._connected === true,
      filled: group._filled === true,
      requiredMissing: group._required_missing === true,
    });
  }
  return statuses;
}

export const channelStatusSchema = z.object({
  id: z.string(),
  title: z.string(),
  credentialKey: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
  missingFields: z.array(z.string()),
});

export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export function summarizeChannels(value: unknown): ChannelStatus[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map(channel => {
    const id = asString(channel.id) ?? '';
    return {
      id,
      title: asString(channel.title) ?? id,
      credentialKey: asString(channel.credentialkey) ?? id,
      enabled: channel.enabled === true,
      configured: channel.configured === true,
      missingFields: toStringArray(channel.missingfields),
    };
  });
}

/** The scheduled task a custom build starts with. It runs only once its text has been written. */
export const STARTER_TASK_KEY = 'cs-cron-my-scheduled-task';

export const agentTaskSchema = z.object({
  key: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  notWritten: z.boolean().optional()
    .describe('The starter task whose text was never written. It does not run, even when it shows on, until its text is saved with manage_agent_custom_skill.'),
  ownerSkills: z.array(z.string()).optional()
    .describe('The skills that bring this task. It runs only while one of them is on.'),
  skillOff: z.boolean().optional()
    .describe('Every skill that brings this task is off, so it does not run, even when it shows on, until one of them is turned on with apply_agent_skills. Its own on/off state, text and schedule stay as they are.'),
  interval: z.string().nullable().optional(),
  source: z.enum(['template', 'skill', 'user']).optional(),
  instructions: z.string().optional(),
  instructionsTruncated: z.boolean().optional(),
});

export type AgentTask = z.infer<typeof agentTaskSchema>;

const TASK_SOURCES: Record<string, AgentTask['source']> = {
  'preset-strategy': 'template',
  'skill-bundle': 'skill',
  'user-created': 'user',
};

/** Custom instructions and scheduled tasks, with the instruction text cut short. */
export function summarizeTasks(value: unknown, maxInstructionLength = 300): AgentTask[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map(task => {
    const description = asString(task.description);
    const interval = asString(task.interval) ?? asString(task.intervalexpr);
    const instructions = asString(task.value) ?? '';
    const shortened = truncate(instructions, maxInstructionLength);
    const source = TASK_SOURCES[asString(task._source) ?? ''];
    const ownerSkills = toStringArray(task._owner_skills);
    return {
      key: asString(task.key) ?? '',
      ...(description ? { description } : {}),
      enabled: task.enabled !== false,
      ...(asString(task.key) === STARTER_TASK_KEY && task._edited === false ? { notWritten: true } : {}),
      ...(ownerSkills.length > 0 ? { ownerSkills } : {}),
      ...(task._skill_off === true ? { skillOff: true } : {}),
      ...(interval !== undefined ? { interval: interval || null } : {}),
      ...(source ? { source } : {}),
      ...(shortened ? { instructions: shortened } : {}),
      ...(instructions.length > maxInstructionLength ? { instructionsTruncated: true } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Deployed agent views
// ---------------------------------------------------------------------------

const agentTemplateRefSchema = z.object({
  custom: z.boolean(),
  guid: z.string().optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
});

const modelSettingsSchema = z.object({
  chat: z.string().nullable(),
  cron: z.string().nullable(),
  voicePrep: z.string().nullable(),
  voicePostcall: z.string().nullable(),
});

const selectableModelSchema = z.object({
  slug: z.string(),
  label: z.string().optional(),
  inputCreditsPer1M: z.number().optional(),
  outputCreditsPer1M: z.number().optional(),
});

type SelectableModel = z.infer<typeof selectableModelSchema>;

export const extraCreditPackSchema = z.object({
  pack: z.string(),
  credits: z.number(),
  priceUsd: z.number(),
});

export const agentSummarySchema = z.object({
  guid: z.string(),
  title: z.string(),
  status: z.number().int().nullable(),
  statusLabel: agentStatusLabelSchema,
  setupRequired: z.boolean()
    .describe('Whether the agent waits for setup. list_my_agents goes by the status (6). get_my_agent also checks each required credential and names what is missing.'),
  workspace: z.enum(['personal', 'team']),
  template: agentTemplateRefSchema,
  tier: z.string().optional(),
  monthlyPriceUsd: z.number().nullable(),
  credits: creditsSchema,
  subscription: subscriptionSchema.nullable(),
  timezone: z.string().nullable().optional(),
  teamSessionMode: z.string().optional(),
  skills: z.array(z.string()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastActivityAt: z.string().optional()
    .describe('When the agent\'s newest message was written, on any channel, scheduled runs included. Left out when it has none.'),
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentDetailSchema = agentSummarySchema.extend({
  description: z.string().optional(),
  cover: z.string().optional(),
  categories: z.array(z.string()),
  pricing: tierPricingSchema.nullable(),
  extraCreditPacks: z.array(extraCreditPackSchema)
    .describe('The extra credit packs this plan can buy. Only an active Pro plan can buy them, so any other plan lists none.'),
  models: modelSettingsSchema.optional(),
  selectableModels: z.array(selectableModelSchema).optional(),
  enabledCommands: z.array(z.string()).nullable(),
  credentials: z.array(credentialStatusSchema),
  missingCredentials: z.array(z.object({ key: z.string(), title: z.string(), oauth: z.boolean() })),
  channels: z.array(channelStatusSchema),
  scheduledTasks: z.array(agentTaskSchema),
  customInstructions: z.array(agentTaskSchema),
  queuedAt: z.string().optional(),
  startedAt: z.string().optional(),
  runningAt: z.string().optional(),
  stoppedAt: z.string().optional(),
  erroredAt: z.string().optional(),
  dashboardUrl: z.string(),
});

export type AgentDetail = z.infer<typeof agentDetailSchema>;

/** The part of a new agent that matters right after deploying it. */
export const deployedAgentSchema = agentSummarySchema.extend({
  missingCredentials: agentDetailSchema.shape.missingCredentials,
  channels: agentDetailSchema.shape.channels,
  dashboardUrl: z.string(),
});

export type DeployedAgent = z.infer<typeof deployedAgentSchema>;

export function toDeployedAgent(agent: AgentDetail): DeployedAgent {
  // Object schemas drop the keys they do not declare.
  return deployedAgentSchema.parse(agent);
}

function templateRef(row: Record<string, unknown>): AgentSummary['template'] {
  const agent = isPlainObject(row.agent) ? row.agent : {};
  const guid = asString(agent.guid) ?? asString(row.agentguid);
  if (agent.custom === true || !guid) return { custom: true };
  const slug = asString(agent.slug);
  const title = asString(agent.title);
  return {
    custom: false,
    guid,
    ...(slug ? { slug } : {}),
    ...(title ? { title } : {}),
  };
}

function timestamps<K extends string>(row: Record<string, unknown>, map: Record<K, string>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [key, column] of Object.entries(map) as Array<[K, string]>) {
    const iso = unixToIso(row[column]);
    if (iso) out[key] = iso;
  }
  return out;
}

/**
 * The plan as it is shown. A plan that has ended renews at the agent's monthly
 * price, not at the amount of its last period, so that is its one price.
 */
function planOf(row: Record<string, unknown>): AgentSubscription | null {
  const plan = toSubscription(row.subscription, row.stripecancelatperiodend);
  const price = toNumber(row.monthlypriceusd);
  return plan && plan.status !== 'active' && price !== null && price > 0 ? { ...plan, amountUsd: price } : plan;
}

/** The compact row used by list_my_agents. */
export function toAgentSummary(row: Record<string, unknown>): AgentSummary {
  const status = readAgentStatus(row);
  const tier = asString(row.tier);
  const timezone = row.timezone === null ? null : asString(row.timezone);
  const sessionMode = asString(row.teamsessionmode);
  return {
    guid: asString(row.guid) ?? '',
    title: asString(row.title) ?? '',
    status,
    statusLabel: agentStatusLabel(status),
    setupRequired: row.setuprequired === true || status === 6,
    workspace: row.teamguid ? 'team' : 'personal',
    template: templateRef(row),
    ...(tier ? { tier } : {}),
    monthlyPriceUsd: toNumber(row.monthlypriceusd),
    credits: toCredits(row),
    subscription: planOf(row),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(sessionMode ? { teamSessionMode: sessionMode } : {}),
    skills: toStringArray(row.skills ?? row.enabledSkills),
    ...timestamps(row, { createdAt: 'createdat', updatedAt: 'updatedat', lastActivityAt: 'lastactivityat' }),
  };
}

/** The models an agent can switch to, with their credits per 1M input and output tokens when Wiro lists them. */
function selectableModels(tokenRates: unknown): SelectableModel[] {
  if (!isPlainObject(tokenRates) || !isPlainObject(tokenRates.models)) return [];
  return Object.entries(tokenRates.models)
    .filter(([, meta]) => isPlainObject(meta) && meta.selectable === true)
    .map(([slug, meta]) => {
      const rates = meta as Record<string, unknown>;
      const label = asString(rates.label);
      const input = toNumber(rates.input_per_1m);
      const output = toNumber(rates.output_per_1m);
      return {
        slug,
        ...(label ? { label } : {}),
        ...(input !== null ? { inputCreditsPer1M: input } : {}),
        ...(output !== null ? { outputCreditsPer1M: output } : {}),
      };
    });
}

/** Slugs a deployed agent may switch its chat, cron or voice model to. */
export function selectableModelSlugs(row: Record<string, unknown>): Set<string> {
  return new Set(selectableModels(row.tokenRates).map(model => model.slug));
}

/**
 * The keys of the credentials an agent's setup waits for: a credential with a
 * required field empty, a required credential that holds no value yet, or a
 * required sign-in that is not connected. A custom build's setup waits only for
 * the main credential of each active skill, which skillsmeta lists. Its chat
 * channels are never among them.
 */
export function credentialKeysSetupWaitsFor(row: Record<string, unknown>): Set<string> {
  const channelKeys = new Set(summarizeChannels(row.communicationChannels).map(channel => channel.credentialKey));
  const activeKeys = templateRef(row).custom && isPlainObject(row.skillsmeta)
    ? new Set(Object.values(row.skillsmeta).filter(isPlainObject)
      .filter(meta => meta.requires_credentials === true)
      .map(meta => asString(meta.credential_key))
      .filter((key): key is string => Boolean(key)))
    : null;
  return new Set(summarizeCredentials(row.credentials, channelKeys)
    // A required credential whose fields are all optional has no empty required
    // field to show, and the setup still waits until it holds a value.
    .filter(credential => credential.requiredMissing
      || (!credential.optional && !credential.connected && (credential.oauth || (row.setuprequired === true && !credential.filled))))
    .filter(credential => !activeKeys || activeKeys.has(credential.key))
    // A group with no optional flag has no template row and no skill behind it, only saved values left over.
    .filter((credential) => {
      const group = isPlainObject(row.credentials) ? row.credentials[credential.key] : undefined;
      return isPlainObject(group) && typeof group.optional === 'boolean';
    })
    .map(credential => credential.key));
}

/**
 * The full view of one deployed agent (Detail, Deploy and Update rows): its
 * status, plan, prices, credits and settings, and the state of each
 * credential and channel.
 */
export function toAgentDetail(row: Record<string, unknown>): AgentDetail {
  const summary = toAgentSummary(row);
  const agent = isPlainObject(row.agent) ? row.agent : {};
  const channels = summarizeChannels(row.communicationChannels);
  const channelKeys = new Set(channels.map(channel => channel.credentialKey));
  // A credential is required and missing exactly when the setup waits for it, so its row and the setup line agree.
  const setupWaitsFor = credentialKeysSetupWaitsFor(row);
  const credentials = summarizeCredentials(row.credentials, channelKeys)
    .map(credential => ({ ...credential, requiredMissing: setupWaitsFor.has(credential.key) }));
  const description = asString(row.description);
  const cover = asString(row.cover) || asString(agent.cover);
  const agentModel = isPlainObject(row.agentModel) ? row.agentModel : undefined;
  const models = selectableModels(row.tokenRates);
  // Packs are bought only on an active Pro plan, so only that plan lists them.
  const canBuyPacks = summary.tier === 'pro' && summary.subscription?.status === 'active';
  const packs = canBuyPacks && Array.isArray(agent.extracreditpacks)
    ? agent.extracreditpacks.filter(isPlainObject).filter(pack => pack.enabled !== false)
    : [];

  return {
    ...summary,
    ...(description ? { description: truncate(description, 2_000) } : {}),
    ...(cover ? { cover } : {}),
    categories: toStringArray(row.categories),
    pricing: toTierPricing(agent.tiers),
    extraCreditPacks: packs.flatMap(pack => {
      const name = asString(pack.packkey);
      const credits = toNumber(pack.credits);
      const priceUsd = toNumber(pack.priceusd);
      return name && credits !== null && priceUsd !== null ? [{ pack: name, credits, priceUsd }] : [];
    }),
    ...(agentModel
      ? {
        models: {
          chat: asString(agentModel.chatModel) ?? null,
          cron: asString(agentModel.cronModel) ?? null,
          voicePrep: asString(agentModel.voicePrepModel) ?? null,
          voicePostcall: asString(agentModel.voicePostcallModel) ?? null,
        },
      }
      : {}),
    ...(models.length > 0 ? { selectableModels: models } : {}),
    enabledCommands: Array.isArray(row.enabledCommands) ? toStringArray(row.enabledCommands) : null,
    credentials,
    missingCredentials: credentials
      .filter(credential => credential.requiredMissing)
      .map(({ key, title, oauth }) => ({ key, title, oauth })),
    channels,
    scheduledTasks: summarizeTasks(row.scheduledskills),
    customInstructions: summarizeTasks(row.customskills),
    ...timestamps(row, {
      queuedAt: 'queuedat',
      startedAt: 'startedat',
      runningAt: 'runningat',
      stoppedAt: 'stopdat',
      erroredAt: 'errordat',
    }),
    dashboardUrl: agentDashboardUrl(summary.guid),
  };
}

export function formatSubscriptionLine(subscription: AgentSubscription | null, plainMember = false): string {
  if (!subscription) {
    return plainMember
      ? 'No plan. On this team agent, a team admin, the organization\'s owner or the person who deployed it can start one.'
      : 'No plan. manage_agent_billing with action subscribe starts one.';
  }
  const parts = [`${subscription.status}, billed ${subscription.billing === 'wallet' ? 'from the wallet' : 'by card'}`];
  if (subscription.amountUsd !== null) {
    parts.push(subscription.status === 'expired' && subscription.billing === 'wallet'
      ? `a renew charges ${formatUsd(subscription.amountUsd)} per 30 days`
      : `${formatUsd(subscription.amountUsd)} per 30 days`);
  }
  if (subscription.periodEndsAt) {
    const atPeriodEnd = subscription.atPeriodEnd ?? (subscription.cancelAtPeriodEnd ? 'ends' : 'renews');
    if (subscription.status !== 'active') {
      parts.push(`period ended ${subscription.periodEndsAt}`);
    } else if (atPeriodEnd === 'ends') {
      parts.push(`cancelled, ends after ${subscription.periodEndsAt}`);
    } else if (atPeriodEnd === 'renews') {
      parts.push(`renews after ${subscription.periodEndsAt}`);
    } else {
      // Whether this card plan renews is not known here.
      parts.push(`paid through ${subscription.periodEndsAt}`);
    }
  }
  if (subscription.switchingToWallet) parts.push('switching to wallet billing at period end');
  return parts.join(', ');
}

/** Without an active plan, an agent starts only on the extra credits it has left. */
export function startNeedsPlan(agent: Pick<AgentSummary, 'subscription' | 'credits'>): boolean {
  return agent.subscription?.status !== 'active' && agent.credits.extra <= 0;
}

/** renew brings back an expired wallet plan; any other agent without an active plan takes a new one. */
function planActionForStart(agent: Pick<AgentSummary, 'subscription'>): 'renew' | 'subscribe' {
  return agent.subscription?.status === 'expired' && agent.subscription.billing === 'wallet' ? 'renew' : 'subscribe';
}

function noPlanStartHint(agent: Pick<AgentSummary, 'subscription'>): string {
  return 'It has no active plan and no extra credits left, so it cannot start. '
    + (planActionForStart(agent) === 'renew'
      ? 'Its wallet plan has expired; manage_agent_billing with action renew restarts it.'
      : 'manage_agent_billing with action subscribe pays for a plan and starts the agent.');
}

/** An agent's title inside a line of this server's own text: on one line, in a code span it cannot close. */
export function agentTitleSpan(title: string): string {
  return title.trim() ? quotedSpan(title) : 'Untitled agent';
}

export function formatAgentSummaryLines(agent: AgentSummary, plainMember = false): string[] {
  const template = agent.template.custom
    ? 'custom build'
    : `template ${agent.template.title ?? agent.template.slug ?? agent.template.guid}`;
  const hint = !plainMember && (agent.status === 0 || agent.status === 5) && startNeedsPlan(agent)
    ? `${agent.status === 5 ? 'The start failed or the agent stopped unexpectedly.' : 'It is not running.'} ${noPlanStartHint(agent)}`
    : agentStatusHint(agent.status, plainMember);
  return [
    `**Agent:** ${agentTitleSpan(agent.title)} (\`${agent.guid}\`), ${template}, ${agent.workspace} workspace`,
    `**Status:** ${describeAgentStatus(agent.status)}. ${hint}`,
    `**Plan:** ${agent.tier ?? 'no tier'}; ${formatSubscriptionLine(agent.subscription, plainMember)}`,
    `**Credits:** ${formatCredits(agent.credits.remaining)} left (${monthlyCreditsText(agent.credits)}, extra ${formatCredits(agent.credits.extra)}, used ${formatCredits(agent.credits.used)})`,
  ];
}

/** Where an entry the list shortens is read in full. */
function shortenedNote(key: string): string {
  return ` (its text is long; get_my_agent with entry "${key}" shows it in full)`;
}

/** Names inside a sentence: a, b and c. */
function nameList(names: readonly string[], word: 'and' | 'or'): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}` : names.join('');
}

/**
 * Why a task whose skills are all off does not run, as a clause that names the skills to turn on. Its own
 * on/off state stays as it is: a task that is on runs again once one of them is on, and one that is off
 * also needs turning on.
 */
export function skillOffText(task: Pick<AgentTask, 'enabled' | 'ownerSkills'>): string {
  const names = task.ownerSkills ?? [];
  if (!task.enabled) {
    if (names.length === 1) return `it also needs its skill ${names[0]} turned on to run`;
    return `it also needs one of ${names.length > 1 ? `its skills ${nameList(names, 'or')}` : 'the skills that bring it'} turned on to run`;
  }
  if (names.length === 1) return `its skill ${names[0]} is off, so it does not run until ${names[0]} is turned on`;
  return `${names.length > 1 ? `its skills ${nameList(names, 'and')}` : 'the skills that bring it'} are off, so it does not run until one of them is turned on`;
}

/**
 * The tasks among these whose skills are all off, each as a sentence that names the skills to turn on, with a
 * space before it. A saved credential turns such a task on, but it does not run until one of them is on.
 */
export function skillOffTasksNote(tasks: ReadonlyArray<{ key: string; ownerSkills?: string[]; skillOff?: boolean }>): string {
  return tasks.filter(task => task.skillOff).map(task => {
    const names = task.ownerSkills ?? [];
    const skills = names.length === 1
      ? `its skill ${names[0]}`
      : `one of ${names.length > 1 ? `its skills ${nameList(names, 'or')}` : 'the skills that bring it'}`;
    return ` ${quotedSpan(task.key)} does not run until ${skills} is turned on.`;
  }).join('');
}

/** A scheduled task as a list line: key, on or off, schedule and description, then shortenedNote if its text was cut. */
export function formatScheduledTaskLine(task: AgentTask, shortenedNote = ''): string {
  return `- \`${task.key}\` ${task.enabled ? 'on' : 'off'}${task.notWritten ? ' (its text is not written yet, so it does not run)' : ''}${task.skillOff ? ` (${skillOffText(task)})` : ''}${task.interval ? `, ${task.interval}` : ''}${task.description ? `: ${quotedSpan(task.description)}` : ''}${task.instructionsTruncated ? shortenedNote : ''}`;
}

/** A custom instruction as a list line: key, on or off and description, then shortenedNote if its text was cut. */
export function formatCustomInstructionLine(task: AgentTask, shortenedNote = ''): string {
  return `- \`${task.key}\` ${task.enabled ? 'on' : 'off'}${task.description ? `: ${quotedSpan(task.description)}` : ''}${task.instructionsTruncated ? shortenedNote : ''}`;
}

function formatRate(credits: number): string {
  return credits.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

/** Each model with its credits per 1M input and output tokens, separated by semicolons. */
export function formatModelRates(models: readonly SelectableModel[]): string {
  return models.map(model => {
    const name = model.label ? `${model.label} (${model.slug})` : model.slug;
    return model.inputCreditsPer1M !== undefined && model.outputCreditsPer1M !== undefined
      ? `${name} ${formatRate(model.inputCreditsPer1M)} and ${formatRate(model.outputCreditsPer1M)}`
      : `${name} rate unknown`;
  }).join('; ');
}

/** The chat and scheduled-task models, then every model the agent can switch to with its rates. */
function formatModelsLine(agent: AgentDetail): string | null {
  const choices = agent.selectableModels ?? [];
  const nameOf = (slug: string | null) => (slug ? choices.find(model => model.slug === slug)?.label ?? slug : 'the default model');
  const parts: string[] = [];
  if (agent.models) parts.push(`chat ${nameOf(agent.models.chat)}, scheduled tasks ${nameOf(agent.models.cron)}.`);
  if (choices.length > 0) {
    parts.push(`Models you can switch to, in credits per 1M input and output tokens: ${formatModelRates(choices)}.`);
  }
  return parts.length > 0 ? `**Models:** ${parts.join(' ')}` : null;
}

export function formatAgentDetail(agent: AgentDetail, plainMember = false): string {
  const lines = formatAgentSummaryLines(agent, plainMember);
  if (agent.lastActivityAt) lines.push(`**Last activity:** ${agent.lastActivityAt}`);
  if (agent.pricing) {
    // Today's Starter and Pro prices for this agent's own skills, which can
    // differ from its template's and from the price its plan pays.
    const { starter, pro } = agent.pricing;
    lines.push(`**Prices now:** Starter ${formatUsd(starter.priceUsd)} per 30 days with ${formatCredits(starter.monthlyCredits)} credits per month; Pro ${formatUsd(pro.priceUsd)} per 30 days with ${formatCredits(pro.monthlyCredits)} credits per month. A new plan or an upgrade uses these, and a skill change moves the plan to today's prices for all its skills.`);
  }
  const models = formatModelsLine(agent);
  if (models) lines.push(models);
  if (agent.timezone !== undefined) {
    lines.push(`**Time zone:** ${agent.timezone?.trim() ? agent.timezone : 'UTC, the default'}. Scheduled tasks run in it.`);
  }
  if (agent.setupRequired) {
    lines.push(agent.missingCredentials.length > 0
      ? `**Setup required:** missing ${agent.missingCredentials.map(item => item.title).join(', ')}`
      : '**Setup required:** yes');
  }
  if (agent.skills.length > 0) lines.push(`**Skills:** ${agent.skills.join(', ')}`);
  if (agent.channels.length > 0) {
    lines.push(`**Channels:** ${agent.channels.map(channel => `${channel.title} ${channel.enabled ? 'on' : channel.configured ? 'configured' : 'off'}`).join(', ')}`);
  }
  if (agent.credentials.length > 0) {
    lines.push('', '### Credentials', '');
    for (const credential of agent.credentials) {
      const state = credential.connected
        ? 'connected'
        : credential.requiredMissing
          ? (credential.oauth ? 'not connected (required)' : 'missing (required)')
          : credential.filled
            ? 'filled'
            : 'not set';
      lines.push(`- ${credential.title} (\`${credential.key}\`): ${state}${credential.optional ? ', optional' : ''}`);
    }
  }
  if (agent.scheduledTasks.length > 0) {
    lines.push('', '### Scheduled tasks', '');
    for (const task of agent.scheduledTasks) lines.push(formatScheduledTaskLine(task, shortenedNote(task.key)));
  }
  if (agent.customInstructions.length > 0) {
    lines.push('', '### Custom instructions', '');
    for (const task of agent.customInstructions) lines.push(formatCustomInstructionLine(task, shortenedNote(task.key)));
  }
  lines.push('', `Dashboard: ${agent.dashboardUrl}`);
  return lines.join('\n');
}

// Custom skill keys get the same canonical shape the server gives them, so a
// key can be compared with the template's own entries before deploying.
export function normalizeCustomSkillKey(input: string, interval?: string | null): string | null {
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
    const scheduled = typeof interval === 'string'
      && !['', 'manual', 'false'].includes(interval.trim().toLowerCase());
    prefix = scheduled ? 'cs-cron-' : 'cs-';
    body = trimmed;
  }
  if (body.length === 0 || body.length > 60) return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body) ? prefix + body : null;
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string): boolean {
  return GUID_PATTERN.test(value.trim());
}

// ---------------------------------------------------------------------------
// Reading and waiting
// ---------------------------------------------------------------------------

export interface AgentApiClient {
  post<T = Record<string, unknown>>(
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
}

type UserAgentEnvelope = ApiEnvelope & { useragents?: unknown };

/** Reads one agent's Detail row; tool results are built from it with toAgentDetail or toAgentSummary. */
export async function readAgentDetail(
  client: AgentApiClient,
  guid: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = requireApiSuccess(
    await client.post<UserAgentEnvelope>('/UserAgent/Detail', { guid }, signal),
    'The agent could not be read.',
  );
  const rows = Array.isArray(body.useragents) ? body.useragents.filter(isPlainObject) : [];
  if (!rows[0]) throw new Error(AGENT_NOT_FOUND_TEXT);
  return rows[0];
}

// Every Detail read prices the agent, so polling stays slower than for tasks.
export function agentPollInterval(elapsedMs: number): number {
  return elapsedMs < 60_000 ? 5_000 : 10_000;
}

export interface AgentWaitResult {
  row: Record<string, unknown>;
  /** False when no read succeeded, so row is the fallback row passed in. */
  fresh: boolean;
  settled: boolean;
  elapsedMs: number;
}

/** Reads the agent until its status is no longer stopping, queued or starting. */
export async function waitForAgentToSettle(
  client: AgentApiClient,
  guid: string,
  waitSeconds: number,
  extra: ToolCallContext | undefined,
  fallbackRow: Record<string, unknown>,
): Promise<AgentWaitResult> {
  const result = await pollUntil({
    read: signal => readAgentDetail(client, guid, signal),
    isDone: row => !isTransitionalStatus(readAgentStatus(row)),
    timeoutMs: waitSeconds * 1000,
    signal: extra?.signal,
    interval: agentPollInterval,
    onPoll: (row, elapsedMs) => reportProgress(
      extra,
      elapsedMs,
      `Agent status: ${describeAgentStatus(readAgentStatus(row))}`,
    ),
  });
  return {
    row: result.value ?? fallbackRow,
    fresh: result.value !== undefined,
    settled: result.done,
    elapsedMs: result.elapsedMs,
  };
}

export interface NextAction {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

/** The credential that holds the Wiro project an agent runs models with. */
export const WIRO_PROJECT_CREDENTIAL = 'wiro';

/** The call that connects a Wiro project to an agent. It shows the project first; lead says why it comes now. */
export function bindProjectStep(agentGuid: string, lead: string): NextAction {
  return {
    tool: 'bind_agent_project',
    arguments: { agent_guid: agentGuid },
    reason: `${lead} This shows the project first and changes nothing without confirm: true, and no key is needed.`,
  };
}

/** The call that starts on the first missing credential, with every argument it needs. */
export function missingCredentialStep(agent: Pick<AgentDetail, 'guid' | 'missingCredentials'>): NextAction | undefined {
  const missing = agent.missingCredentials[0];
  if (!missing) return undefined;
  const keys = agent.missingCredentials.map(item => item.key).join(', ');
  if (missing.key === WIRO_PROJECT_CREDENTIAL) {
    return bindProjectStep(agent.guid, `Provide the missing credentials (${keys}), starting with ${missing.title}.`);
  }
  return missing.oauth
    ? {
      tool: 'connect_agent_oauth',
      arguments: { action: 'connect', agent_guid: agent.guid, credential: missing.key },
      reason: `Provide the missing credentials (${keys}). This starts with ${missing.title}, which the user connects by signing in.`,
    }
    : {
      tool: 'set_agent_credentials',
      arguments: { agent_guid: agent.guid, credential: missing.key },
      reason: `Provide the missing credentials (${keys}). This lists the ${missing.title} fields to ask the user for.`,
    };
}

/**
 * The most useful next call for an agent in this state, if any. For a team
 * member without admin rights it is only the wait for a status that moves on
 * by itself.
 */
export function nextStepForAgent(agent: AgentDetail, waitSeconds: number, plainMember = false): NextAction | undefined {
  const wait = isTransitionalStatus(agent.status)
    ? {
      tool: 'get_my_agent',
      arguments: { agent_guid: agent.guid, wait_seconds: waitSeconds },
      reason: 'Wait until the agent has settled. Do not repeat the action that started it.',
    }
    : undefined;
  if (plainMember) return wait;
  if (agent.status === 6 && agent.subscription?.status !== 'active') {
    return {
      tool: 'manage_agent_billing',
      arguments: { agent_guid: agent.guid, action: 'subscribe' },
      reason: 'The agent has no paid plan. This returns the price; nothing is charged without confirm: true.',
    };
  }
  const missing = agent.missingCredentials[0];
  if (missing) return missingCredentialStep(agent);
  if (wait) return wait;
  if ((agent.status === 0 || agent.status === 5) && startNeedsPlan(agent)) {
    return {
      tool: 'manage_agent_billing',
      arguments: { agent_guid: agent.guid, action: planActionForStart(agent) },
      reason: 'The agent has no active plan and no extra credits left, so it cannot start. This returns the price; nothing is charged without confirm: true.',
    };
  }
  if (agent.status === 0 || agent.status === 5) {
    return {
      tool: 'control_agent',
      arguments: { agent_guid: agent.guid, action: 'start' },
      reason: agent.status === 5 ? 'Retry the failed start.' : 'Start the agent.',
    };
  }
  return undefined;
}

// Refusals known to leave the wallet untouched.
const PRE_CHARGE_CODES = new Set([95, 96, 97, 99, 101, 102, 103, 104, 105, 106, 107, 108, 109]);

const WALLET_NOT_READ = /could not retrieve wallet balance/i;

/** Whether a refusal says the wallet could not be read, which says nothing about what it holds. */
export function isWalletNotRead(error: unknown): boolean {
  return error instanceof ApiResultError && WALLET_NOT_READ.test(error.message);
}

/** The words after such a refusal. No funds are asked for: the wallet may hold plenty. */
export const WALLET_NOT_READ_NOTE = 'Wiro could not read the balance just now. That is not a low balance, and nothing was charged. Try again in a moment; if it keeps saying so, get_account shows the wallet.';

const PRE_CHARGE_REFUSALS: RegExp[] = [
  /insufficient wallet balance/i,
  WALLET_NOT_READ,
  /wallet deduction failed/i,
  /subscription (is )?already active/i,
  /already on (the )?(pro|starter) tier/i,
  /no active subscription|active subscription required|no expired subscription found/i,
  /stripe subscriptions must be/i,
  /extra credit pack|pack key required|purchase request id/i,
  /could not (initialize|resume) prepaid credit purchase|prepaid credit purchase cannot be resumed/i,
  /downgrading to starter is not supported|targettier must be|tier must be 'starter' or 'pro'/i,
  /failed to compute (target-tier )?pricing|must be greater than \$0|failed to apply pricing snapshot/i,
  /failed to create subscription record|subscription record returned invalid id/i,
  /payment for this agent is already being processed|checkout for this agent is already being opened/i,
  /confirm this agent's previous checkout|card checkouts for a team agent|payment system not configured/i,
  /agent not found|team admin|don't have access|access denied|must own this/i,
  /switch to (the )?(team|personal) context|belongs to a different team/i,
  /^request parameter \[/i,
  /mutually exclusive|agent terms acceptance|customskills must be|skill key may only contain/i,
  /^unknown skill: /i,
  /^the tier change could not be saved\./i,
  /^we couldn't (schedule|undo) the cancellation\./i,
  /enabledchannels is not accepted|credentials must be an object|credential field|is missing required fields/i,
  /chat mode is not accepted|is managed by (wiro|the connection flow)|^agent-[a-z-]+$/i,
  /^failed to deploy agent|failed to save communication channel settings|failed to save custom skill/i,
];

/** Whether a result:false answer is one of the refusals known to leave the wallet untouched. */
export function isPreChargeRefusal(error: unknown): boolean {
  if (!(error instanceof ApiResultError)) return false;
  if (error.codes.some(code => PRE_CHARGE_CODES.has(Number(code)))) return true;
  return PRE_CHARGE_REFUSALS.some(pattern => pattern.test(error.message.trim()));
}

const CHARGED_START = 'The wallet was charged ';
const CHARGED_END = /, but the (tier change|renewal) did not finish\. Please contact support and do not try again\.$/;

/**
 * Whether a result:false answer says what the wallet paid. Its sentence is the
 * whole outcome: it is shown as it is, and the call is not repeated.
 */
export function isKnownPaidOutcome(error: unknown): boolean {
  if (!(error instanceof ApiResultError)) return false;
  const message = error.message.trim();
  return message.startsWith(CHARGED_START) && CHARGED_END.test(message);
}

/**
 * Whether a result:false answer carries code 110. Its answer is the whole outcome:
 * the change is reported as failed, what the agent and the wallet show is read by
 * hand, and the call is not repeated.
 */
export function isKnownFailedChange(error: unknown): boolean {
  return error instanceof ApiResultError && error.codes.some(code => Number(code) === 110);
}

/**
 * After a paid request was sent, whether it may still have gone through.
 * Only the known refusals, an answer that says what the wallet paid or carries
 * code 110, and client errors (other than a timeout or rate limit) settle it; any
 * other answer, a network failure or a server error leaves it open.
 */
export function outcomeUnknown(error: unknown): boolean {
  if (error instanceof ApiResultError) return !isPreChargeRefusal(error) && !isKnownPaidOutcome(error) && !isKnownFailedChange(error);
  if (error instanceof WiroApiError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

/** Advice for a status reached after a start, renew or deploy. With the agent, a failed agent without a plan or extra credits is sent to billing. */
export function settledStatusAdvice(status: number | null, plainMember = false, agent?: Pick<AgentSummary, 'subscription' | 'credits'>): string {
  if (!plainMember && agent && status === 5 && startNeedsPlan(agent)) {
    return `The agent failed to start. ${noPlanStartHint(agent)}`;
  }
  if (plainMember && status === 5) {
    return `The agent failed to start. On this team agent, ${TEAM_AGENT_MANAGERS} can start it again and read its logs.`;
  }
  if (plainMember && status === 6) {
    return `The agent needs setup: it has no paid plan, or required credentials are missing. ${MEMBER_SETUP_HELP}`;
  }
  switch (status) {
    case 4:
      return 'The agent is running. send_agent_message with agent set to its guid talks to it.';
    case 5:
      return 'The agent failed to start. get_agent_activity with kind logs may show why, and control_agent with action start retries.';
    case 0:
      return 'The agent is stopped. Right after a start this means it has no active plan and no credits left, or someone stopped it.';
    case 6:
      return 'The agent needs setup: it has no paid plan, or required credentials are missing.';
    default:
      return agentStatusHint(status, plainMember);
  }
}

/** Advice for a read, which cannot tell whether a start came first: a stopped agent gets what holds now. */
export function readStatusAdvice(agent: Pick<AgentSummary, 'status' | 'subscription' | 'credits'>, plainMember = false): string {
  if (agent.status !== 0) return settledStatusAdvice(agent.status, plainMember, agent);
  if (plainMember) return `The agent is stopped. On this team agent, ${TEAM_AGENT_MANAGERS} can start it.`;
  return startNeedsPlan(agent)
    ? `The agent is stopped. ${noPlanStartHint(agent)}`
    : 'The agent is stopped. control_agent with action start starts it.';
}
