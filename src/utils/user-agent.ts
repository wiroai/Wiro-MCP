import { z } from 'zod';
import { WiroApiError } from '../client.js';
import {
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

// Deployed agents and the agent catalog. Agent rows come back with the
// owner's stored credential values, billing links and account ids, none of
// which an assistant should pass on, so every row is rebuilt here from an
// allowlist instead of being passed through.

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

export function agentStatusHint(status: number | null | undefined): string {
  return STATUS_HINT[agentStatusLabel(status)];
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
  amountUsd: z.number().nullable(),
  periodEndsAt: z.string().optional(),
  daysRemaining: z.number().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

export type AgentSubscription = z.infer<typeof subscriptionSchema>;

export function toSubscription(value: unknown, cancelAtPeriodEnd?: unknown): AgentSubscription | null {
  if (!isPlainObject(value)) return null;
  const provider = asString(value.provider) ?? 'stripe';
  const periodEndsAt = unixToIso(value.currentperiodend);
  return {
    status: asString(value.status) ?? 'expired',
    billing: provider === 'prepaid' ? 'wallet' : 'card',
    switchingToWallet: provider !== 'prepaid' && value.nextprovider === 'prepaid',
    amountUsd: toNumber(value.amount),
    ...(periodEndsAt ? { periodEndsAt } : {}),
    daysRemaining: toNumber(value.daysremaining),
    cancelAtPeriodEnd: value.pendingdowngrade === 'cancel' || cancelAtPeriodEnd === true,
  };
}

/** How a new charge for this plan is paid right now. */
export function chargeRoute(subscription: unknown): 'wallet' | 'card' | null {
  if (!isPlainObject(subscription)) return null;
  if (subscription.nextprovider === 'prepaid' || subscription.provider === 'prepaid') return 'wallet';
  return 'card';
}

export const creditsSchema = z.object({
  monthly: z.number(),
  extra: z.number(),
  used: z.number(),
  remaining: z.number(),
  period: z.string().optional(),
});

export type AgentCredits = z.infer<typeof creditsSchema>;

export function toCredits(row: Record<string, unknown>): AgentCredits {
  const period = asString(row.creditperiod);
  return {
    monthly: toNumber(row.monthlycredits) ?? 0,
    extra: toNumber(row.extracredits) ?? 0,
    used: toNumber(row.usedcredits) ?? 0,
    remaining: toNumber(row.remainingcredits) ?? 0,
    ...(period ? { period } : {}),
  };
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

/** Per-credential state only. Field values never leave this function. */
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

export const agentTaskSchema = z.object({
  key: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
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
    return {
      key: asString(task.key) ?? '',
      ...(description ? { description } : {}),
      enabled: task.enabled !== false,
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
  setupRequired: z.boolean(),
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
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentDetailSchema = agentSummarySchema.extend({
  description: z.string().optional(),
  cover: z.string().optional(),
  categories: z.array(z.string()),
  pricing: tierPricingSchema.nullable(),
  extraCreditPacks: z.array(extraCreditPackSchema),
  models: modelSettingsSchema.optional(),
  selectableModels: z.array(z.object({ slug: z.string(), label: z.string().optional() })).optional(),
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
    subscription: toSubscription(row.subscription, row.stripecancelatperiodend),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(sessionMode ? { teamSessionMode: sessionMode } : {}),
    skills: toStringArray(row.skills ?? row.enabledSkills),
    ...timestamps(row, { createdAt: 'createdat', updatedAt: 'updatedat' }),
  };
}

function selectableModels(tokenRates: unknown): Array<{ slug: string; label?: string }> {
  if (!isPlainObject(tokenRates) || !isPlainObject(tokenRates.models)) return [];
  return Object.entries(tokenRates.models)
    .filter(([, meta]) => isPlainObject(meta) && meta.selectable === true)
    .map(([slug, meta]) => {
      const label = isPlainObject(meta) ? asString(meta.label) : undefined;
      return { slug, ...(label ? { label } : {}) };
    });
}

/** Slugs a deployed agent may switch its chat, cron or voice model to. */
export function selectableModelSlugs(row: Record<string, unknown>): Set<string> {
  return new Set(selectableModels(row.tokenRates).map(model => model.slug));
}

/**
 * The full sanitized view of one deployed agent (Detail, Deploy and Update
 * rows). Credential values, billing session links, account ids and the
 * team id are dropped; only states, labels and settings remain.
 */
export function toAgentDetail(row: Record<string, unknown>): AgentDetail {
  const summary = toAgentSummary(row);
  const agent = isPlainObject(row.agent) ? row.agent : {};
  const channels = summarizeChannels(row.communicationChannels);
  const channelKeys = new Set(channels.map(channel => channel.credentialKey));
  const credentials = summarizeCredentials(row.credentials, channelKeys);
  const description = asString(row.description);
  const cover = asString(row.cover) || asString(agent.cover);
  const agentModel = isPlainObject(row.agentModel) ? row.agentModel : undefined;
  const models = selectableModels(row.tokenRates);
  const packs = Array.isArray(agent.extracreditpacks)
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
    // A required sign-in that is not connected also holds back the setup, so it
    // is listed as missing too.
    missingCredentials: credentials
      .filter(credential => credential.requiredMissing || (credential.oauth && !credential.optional && !credential.connected))
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

export function formatSubscriptionLine(subscription: AgentSubscription | null): string {
  if (!subscription) return 'No plan. manage_agent_billing with action subscribe starts one.';
  const parts = [`${subscription.status}, billed ${subscription.billing === 'wallet' ? 'from the wallet' : 'by card'}`];
  if (subscription.amountUsd !== null) parts.push(`${formatUsd(subscription.amountUsd)} per 30 days`);
  if (subscription.periodEndsAt) {
    if (subscription.status !== 'active') {
      parts.push(`period ended ${subscription.periodEndsAt}`);
    } else {
      parts.push(subscription.cancelAtPeriodEnd
        ? `cancelled, ends after ${subscription.periodEndsAt}`
        : `renews after ${subscription.periodEndsAt}`);
    }
  }
  if (subscription.switchingToWallet) parts.push('switching to wallet billing at period end');
  return parts.join(', ');
}

export function formatAgentSummaryLines(agent: AgentSummary): string[] {
  const template = agent.template.custom
    ? 'custom build'
    : `template ${agent.template.title ?? agent.template.slug ?? agent.template.guid}`;
  return [
    `**Agent:** ${agent.title} (\`${agent.guid}\`), ${template}, ${agent.workspace} workspace`,
    `**Status:** ${describeAgentStatus(agent.status)}. ${agentStatusHint(agent.status)}`,
    `**Plan:** ${agent.tier ?? 'no tier'}; ${formatSubscriptionLine(agent.subscription)}`,
    `**Credits:** ${formatCredits(agent.credits.remaining)} left (monthly ${formatCredits(agent.credits.monthly)}, extra ${formatCredits(agent.credits.extra)}, used ${formatCredits(agent.credits.used)})`,
  ];
}

const SHORTENED_NOTE = ' (its text is long; manage_agent_custom_skill history shows it in full)';

export function formatAgentDetail(agent: AgentDetail): string {
  const lines = formatAgentSummaryLines(agent);
  if (agent.pricing) {
    // This agent's own Starter and Pro prices, which can differ from its template's.
    const { starter, pro } = agent.pricing;
    lines.push(`**Prices now:** Starter ${formatUsd(starter.priceUsd)} per 30 days with ${formatCredits(starter.monthlyCredits)} credits per month; Pro ${formatUsd(pro.priceUsd)} per 30 days with ${formatCredits(pro.monthlyCredits)} credits per month. A new plan or an upgrade uses these.`);
  }
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
        : credential.filled
          ? 'filled'
          : credential.requiredMissing
            ? 'missing (required)'
            : 'not set';
      lines.push(`- ${credential.title} (\`${credential.key}\`): ${state}${credential.optional ? ', optional' : ''}`);
    }
  }
  if (agent.scheduledTasks.length > 0) {
    lines.push('', '### Scheduled tasks', '');
    for (const task of agent.scheduledTasks) {
      lines.push(`- \`${task.key}\` ${task.enabled ? 'on' : 'off'}${task.interval ? `, ${task.interval}` : ''}${task.description ? `: ${task.description}` : ''}${task.instructionsTruncated ? SHORTENED_NOTE : ''}`);
    }
  }
  if (agent.customInstructions.length > 0) {
    lines.push('', '### Custom instructions', '');
    for (const task of agent.customInstructions) {
      lines.push(`- \`${task.key}\`${task.description ? `: ${task.description}` : ''}${task.instructionsTruncated ? SHORTENED_NOTE : ''}`);
    }
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

/** The raw Detail row. Callers must pass it through toAgentDetail before returning anything. */
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
  if (!rows[0]) throw new Error(`No agent was found for agent_guid "${guid}".`);
  return rows[0];
}

// Every Detail read prices the agent, so polling stays slower than for tasks.
export function agentPollInterval(elapsedMs: number): number {
  return elapsedMs < 60_000 ? 5_000 : 10_000;
}

export interface AgentWaitResult {
  row: Record<string, unknown>;
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
    settled: result.done,
    elapsedMs: result.elapsedMs,
  };
}

export interface NextAction {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

/** The call that starts on the first missing credential, with every argument it needs. */
export function missingCredentialStep(agent: Pick<AgentDetail, 'guid' | 'missingCredentials'>): NextAction | undefined {
  const missing = agent.missingCredentials[0];
  if (!missing) return undefined;
  const keys = agent.missingCredentials.map(item => item.key).join(', ');
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

/** The most useful next call for an agent in this state, if any. */
export function nextStepForAgent(agent: AgentDetail, waitSeconds: number): NextAction | undefined {
  if (agent.status === 6 && agent.subscription?.status !== 'active') {
    return {
      tool: 'manage_agent_billing',
      arguments: { agent_guid: agent.guid, action: 'subscribe' },
      reason: 'The agent has no paid plan. This returns the price; nothing is charged without confirm: true.',
    };
  }
  const missing = agent.missingCredentials[0];
  if (missing) return missingCredentialStep(agent);
  if (isTransitionalStatus(agent.status)) {
    return {
      tool: 'get_my_agent',
      arguments: { agent_guid: agent.guid, wait_seconds: waitSeconds },
      reason: 'Wait until the agent has settled. Do not repeat the action that started it.',
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

// Refusals Wiro sends before it touches the wallet, or after rolling back
// everything it wrote. Only these are known to come before any charge, so any
// other result:false answer to a paid call leaves the outcome open.
const PRE_CHARGE_CODES = new Set([95, 96, 97, 99, 101, 102, 103, 104, 105, 106, 107, 108, 109]);

const PRE_CHARGE_REFUSALS: RegExp[] = [
  /insufficient wallet balance/i,
  /could not retrieve wallet balance/i,
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
  /enabledchannels is not accepted|credentials must be an object|credential field|is missing required fields/i,
  /chat mode is not accepted|is managed by (wiro|the connection flow)|^agent-[a-z-]+$/i,
  /^failed to deploy agent|failed to save communication channel settings|failed to save custom skill/i,
];

/** Whether a result:false answer is one that Wiro sends before any charge. */
export function isPreChargeRefusal(error: unknown): boolean {
  if (!(error instanceof ApiResultError)) return false;
  if (error.codes.some(code => PRE_CHARGE_CODES.has(Number(code)))) return true;
  return PRE_CHARGE_REFUSALS.some(pattern => pattern.test(error.message.trim()));
}

/**
 * After a paid request was sent, whether it may still have gone through.
 * Only the known refusals and client errors (other than a timeout or rate
 * limit) settle it; any other answer, a network failure or a server error
 * leaves it open.
 */
export function outcomeUnknown(error: unknown): boolean {
  if (error instanceof ApiResultError) return !isPreChargeRefusal(error);
  if (error instanceof WiroApiError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

/** Advice for a status reached after a start, renew or deploy. */
export function settledStatusAdvice(status: number | null): string {
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
      return agentStatusHint(status);
  }
}
