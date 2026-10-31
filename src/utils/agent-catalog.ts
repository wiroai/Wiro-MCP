import { z } from 'zod';
import { asString, isPlainObject, toNumber, truncate } from './api.js';
import { usableConnectionModes } from './agent-config.js';
import {
  agentTaskSchema,
  htmlToText,
  summarizeTasks,
  tierPricingSchema,
  toStringArray,
  toTierPricing,
} from './user-agent.js';

// The agent catalog: templates, skills and the credentials they need. These
// come from public catalog endpoints; preset credential values and OAuth
// internals are still left out.

export const templateSummarySchema = z.object({
  guid: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  categories: z.array(z.string()),
  cover: z.string().optional(),
  pricing: tierPricingSchema.nullable(),
  tierMultiplier: z.number().optional(),
});

export type TemplateSummary = z.infer<typeof templateSummarySchema>;

export function toTemplateSummary(row: Record<string, unknown>): TemplateSummary {
  const summary = asString(row.headline)?.trim() || htmlToText(row.description, 300);
  const cover = asString(row.cover);
  const tierMultiplier = toNumber(row.tiermultiplier);
  return {
    guid: asString(row.guid) ?? '',
    slug: asString(row.slug) ?? '',
    title: asString(row.title) ?? '',
    ...(summary ? { summary } : {}),
    categories: toStringArray(row.categories),
    ...(cover ? { cover } : {}),
    pricing: toTierPricing(row.tiers),
    ...(tierMultiplier !== null ? { tierMultiplier } : {}),
  };
}

export const credentialFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string().optional(),
  required: z.boolean(),
  onlyInModes: z.array(z.string()).optional(),
});

export const credentialRequirementSchema = z.object({
  key: z.string(),
  title: z.string(),
  mode: z.string().optional(),
  oauth: z.boolean(),
  connectionModes: z.array(z.string()),
  fields: z.array(credentialFieldSchema),
});

export type CredentialRequirement = z.infer<typeof credentialRequirementSchema>;

const modelOptionSchema = z.object({
  slug: z.string(),
  label: z.string().optional(),
  tier: z.string().optional(),
  inputCreditsPer1M: z.number().optional(),
  outputCreditsPer1M: z.number().optional(),
  cachedInputCreditsPer1M: z.number().optional(),
});

export const templateDetailSchema = templateSummarySchema.extend({
  description: z.string().optional(),
  skills: z.array(z.object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    credentialKey: z.string().optional(),
    additionalCredentialKeys: z.array(z.string()).optional(),
  })),
  requiredCredentials: z.array(credentialRequirementSchema),
  optionalCredentials: z.array(credentialRequirementSchema),
  channels: z.array(z.object({
    id: z.string(),
    title: z.string(),
    credentialKey: z.string(),
    requiredFields: z.array(z.string()),
  })),
  models: z.object({
    default: z.string().optional(),
    selectable: z.array(modelOptionSchema),
  }),
  scheduledTasks: z.array(agentTaskSchema).optional(),
  customInstructions: z.array(agentTaskSchema).optional(),
});

export type TemplateDetail = z.infer<typeof templateDetailSchema>;

function writableSchemaField(field: Record<string, unknown>): boolean {
  return field.platform_managed !== true
    && field.auto_filled_by_oauth !== true
    && field.server_managed !== true
    && field.type !== 'computed';
}

/** What a user fills in for one credential group, from its inline schema. Values are never read. */
function toCredentialRequirement(key: string, group: Record<string, unknown>): CredentialRequirement {
  const schema = isPlainObject(group._schema) ? group._schema : {};
  const editable = isPlainObject(group._editable) ? group._editable : null;
  const fields = Array.isArray(schema.fields) ? schema.fields.filter(isPlainObject) : [];
  const mode = asString(schema.credential_mode);
  return {
    key,
    title: asString(schema.title) ?? key,
    ...(mode ? { mode } : {}),
    oauth: isPlainObject(schema.oauth_provider),
    connectionModes: usableConnectionModes({
      connectionModes: toStringArray(schema.connection_modes),
      wiroPending: schema.wiro_connect_pending === true,
    }),
    fields: fields
      .filter(field => {
        const fieldKey = asString(field.key);
        if (!fieldKey || !writableSchemaField(field)) return false;
        return editable ? editable[fieldKey] !== false : true;
      })
      .map(field => {
        const onlyInModes = toStringArray(field.only_in_modes);
        const type = asString(field.type);
        return {
          key: asString(field.key) ?? '',
          label: asString(field.label) ?? asString(field.key) ?? '',
          ...(type ? { type } : {}),
          required: field.required === true,
          ...(onlyInModes.length > 0 ? { onlyInModes } : {}),
        };
      }),
  };
}

function toModelOptions(tokenRates: unknown): TemplateDetail['models'] {
  if (!isPlainObject(tokenRates)) return { selectable: [] };
  const defaultModel = asString(tokenRates.default_model);
  const models = isPlainObject(tokenRates.models) ? tokenRates.models : {};
  const selectable = Object.entries(models)
    .filter(([, meta]) => isPlainObject(meta) && meta.selectable === true)
    .map(([slug, meta]) => {
      const rates = meta as Record<string, unknown>;
      const label = asString(rates.label);
      const tier = asString(rates.tier);
      const input = toNumber(rates.input_per_1m);
      const output = toNumber(rates.output_per_1m);
      const cached = toNumber(rates.cached_input_per_1m);
      return {
        slug,
        ...(label ? { label } : {}),
        ...(tier ? { tier } : {}),
        ...(input !== null ? { inputCreditsPer1M: input } : {}),
        ...(output !== null ? { outputCreditsPer1M: output } : {}),
        ...(cached !== null ? { cachedInputCreditsPer1M: cached } : {}),
      };
    });
  return { ...(defaultModel ? { default: defaultModel } : {}), selectable };
}

export function toTemplateDetail(row: Record<string, unknown>): TemplateDetail {
  const summary = toTemplateSummary(row);
  const skillsMeta = isPlainObject(row.skillsmeta) ? row.skillsmeta : {};
  const skills = toStringArray(row.skills).map(name => {
    const meta = isPlainObject(skillsMeta[name]) ? skillsMeta[name] as Record<string, unknown> : {};
    const title = asString(meta.title);
    const description = asString(meta.description);
    const needsCredentials = meta.requires_credentials === true;
    const credentialKey = needsCredentials ? asString(meta.credential_key) : undefined;
    const additional = needsCredentials ? toStringArray(meta.additional_credential_keys) : [];
    return {
      name,
      ...(title ? { title } : {}),
      ...(description ? { description: truncate(description, 200) } : {}),
      ...(credentialKey ? { credentialKey } : {}),
      ...(additional.length > 0 ? { additionalCredentialKeys: additional } : {}),
    };
  });

  const channels = (Array.isArray(row.communicationChannels) ? row.communicationChannels : [])
    .filter(isPlainObject)
    .map(channel => {
      const id = asString(channel.id) ?? '';
      return {
        id,
        title: asString(channel.title) ?? id,
        credentialKey: asString(channel.credentialkey) ?? id,
        requiredFields: toStringArray(channel.required_fields),
      };
    });
  const channelKeys = new Set(channels.map(channel => channel.credentialKey));

  const requiredCredentials: CredentialRequirement[] = [];
  const optionalCredentials: CredentialRequirement[] = [];
  if (isPlainObject(row.credentials)) {
    for (const [key, group] of Object.entries(row.credentials)) {
      if (key.startsWith('_') || !isPlainObject(group)) continue;
      // Only groups the template marks as not optional hold back the setup.
      if (group.optional === false) {
        requiredCredentials.push(toCredentialRequirement(key, group));
      } else if (!channelKeys.has(key)) {
        optionalCredentials.push(toCredentialRequirement(key, group));
      }
    }
  }

  const description = htmlToText(row.description, 1_500);
  const scheduled = Array.isArray(row.scheduledskills) ? summarizeTasks(row.scheduledskills) : undefined;
  const custom = Array.isArray(row.customskills) ? summarizeTasks(row.customskills) : undefined;

  return {
    ...summary,
    ...(description ? { description } : {}),
    skills,
    requiredCredentials,
    optionalCredentials,
    channels,
    models: toModelOptions(row.tokenRates),
    ...(scheduled ? { scheduledTasks: scheduled } : {}),
    ...(custom ? { customInstructions: custom } : {}),
  };
}

export const skillSummarySchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  capabilities: z.array(z.string()),
  requiresCredentials: z.boolean(),
  credentialKey: z.string().optional(),
  additionalCredentialKeys: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()),
  conflictsWith: z.array(z.string()),
  userInvocable: z.boolean().optional(),
  deprecated: z.boolean(),
  replacement: z.string().optional(),
  monthlyPriceUsd: z.number(),
  monthlyCredits: z.number(),
});

export type SkillSummary = z.infer<typeof skillSummarySchema>;

export function toSkillSummary(skill: Record<string, unknown>): SkillSummary {
  const pricing = isPlainObject(skill.pricing) ? skill.pricing : {};
  const description = asString(skill.description);
  const category = asString(skill.category);
  const credentialKey = asString(skill.credential_key);
  const additional = toStringArray(skill.additional_credential_keys);
  const replacement = asString(skill.replacement);
  return {
    name: asString(skill.name) ?? '',
    title: asString(skill.title) ?? asString(skill.name) ?? '',
    ...(description ? { description: truncate(description, 300) } : {}),
    ...(category ? { category } : {}),
    capabilities: toStringArray(skill.capabilities),
    requiresCredentials: skill.requires_credentials === true,
    ...(credentialKey ? { credentialKey } : {}),
    ...(additional.length > 0 ? { additionalCredentialKeys: additional } : {}),
    dependsOn: toStringArray(skill.depends_on),
    conflictsWith: toStringArray(skill.conflicts_with),
    ...(typeof skill.user_invocable === 'boolean' ? { userInvocable: skill.user_invocable } : {}),
    deprecated: skill.deprecated === true,
    ...(replacement ? { replacement } : {}),
    monthlyPriceUsd: toNumber(pricing.monthly_price_weight_usd) ?? 0,
    monthlyCredits: toNumber(pricing.monthly_credits_weight) ?? 0,
  };
}

const setupOptionSchema = z.object({ value: z.string(), label: z.string().optional() });

const setupItemFieldSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
  required: z.boolean().optional(),
  pattern: z.string().optional(),
  options: z.array(setupOptionSchema).optional(),
  help: z.string().optional(),
});

export const credentialSetupFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string().optional(),
  required: z.boolean(),
  writable: z.boolean(),
  secret: z.boolean(),
  onlyInModes: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  options: z.array(setupOptionSchema).optional(),
  help: z.string().optional(),
  // The keys of a list's entries, and of a list inside an entry.
  itemFields: z.array(setupItemFieldSchema.extend({ itemFields: z.array(setupItemFieldSchema).optional() })).optional(),
});

export type CredentialSetupItem = z.infer<typeof setupItemFieldSchema> & { itemFields?: Array<z.infer<typeof setupItemFieldSchema>> };

export const credentialSetupSchema = z.object({
  key: z.string(),
  title: z.string(),
  role: z.enum(['primary', 'additional', 'channel', 'credential']),
  mode: z.string().optional(),
  connectionModes: z.array(z.string()),
  oauth: z.boolean(),
  wiroConnectAvailable: z.boolean(),
  channel: z.object({ id: z.string(), requiredFields: z.array(z.string()) }).optional(),
  usedBySkills: z.array(z.string()).optional(),
  note: z.string().optional(),
  fields: z.array(credentialSetupFieldSchema),
});

export type CredentialSetup = z.infer<typeof credentialSetupSchema>;

function itemSchemaOf(field: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(field.item_schema)) return field.item_schema;
  const config = isPlainObject(field.custom_component_config) ? field.custom_component_config : null;
  if (!config) return undefined;
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('per_') && key.endsWith('_schema') && Array.isArray(value)) return value;
  }
  return undefined;
}

function setupOptions(field: Record<string, unknown>): Array<z.infer<typeof setupOptionSchema>> {
  if (!Array.isArray(field.options)) return [];
  return field.options.flatMap(option => {
    if (isPlainObject(option)) {
      const value = asString(option.value);
      const label = asString(option.text) ?? asString(option.label);
      return value !== undefined ? [{ value, ...(label ? { label } : {}) }] : [];
    }
    const value = asString(option);
    return value !== undefined ? [{ value }] : [];
  });
}

/** The keys of a list's entries, with a list inside an entry described one level further. */
function setupItems(field: Record<string, unknown>, nested: boolean): CredentialSetupItem[] {
  return (itemSchemaOf(field) ?? []).filter(isPlainObject).flatMap(item => {
    const itemKey = asString(item.key);
    if (!itemKey) return [];
    const itemLabel = asString(item.label);
    const itemType = asString(item.type);
    const itemPattern = asString(item.pattern);
    const options = setupOptions(item);
    const help = htmlToText(item.help, 300);
    const children = nested ? setupItems(item, false) : [];
    return [{
      key: itemKey,
      ...(itemLabel ? { label: itemLabel } : {}),
      ...(itemType ? { type: itemType } : {}),
      ...(typeof item.required === 'boolean' ? { required: item.required } : {}),
      ...(itemPattern ? { pattern: itemPattern } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(help ? { help } : {}),
      ...(children.length > 0 ? { itemFields: children } : {}),
    }];
  });
}

/** A credential registry entry reduced to what a user is asked for. OAuth internals stay out. */
export function toCredentialSetup(
  credential: Record<string, unknown>,
  role: CredentialSetup['role'],
): CredentialSetup {
  const key = asString(credential.key) ?? '';
  const listedModes = toStringArray(credential.connection_modes);
  const wiroPending = credential.wiro_connect_pending === true;
  const channel = isPlainObject(credential.channel) ? credential.channel : null;
  const mode = asString(credential.credential_mode);
  const usedBy = toStringArray(credential.used_by_skills);
  const schema = Array.isArray(credential.credential_schema)
    ? credential.credential_schema.filter(isPlainObject)
    : [];
  return {
    key,
    title: asString(credential.title) ?? key,
    role: channel && role === 'credential' ? 'channel' : role,
    ...(mode ? { mode } : {}),
    connectionModes: usableConnectionModes({ connectionModes: listedModes, wiroPending }),
    oauth: isPlainObject(credential.oauth_provider),
    wiroConnectAvailable: listedModes.includes('wiro') && !wiroPending,
    ...(channel
      ? { channel: { id: asString(channel.id) ?? key, requiredFields: toStringArray(channel.required_fields) } }
      : {}),
    ...(usedBy.length > 0 ? { usedBySkills: usedBy } : {}),
    ...(key === 'wiro'
      ? { note: 'This is a Wiro project API key. Models the agent runs are billed to that project\'s wallet, so use only a key the user gives for this purpose.' }
      : {}),
    fields: schema.filter(field => asString(field.key)).map(field => {
      const onlyInModes = toStringArray(field.only_in_modes);
      const type = asString(field.type);
      const pattern = asString(field.pattern);
      const help = htmlToText(field.help, 600);
      const options = setupOptions(field);
      const items = setupItems(field, true);
      return {
        key: asString(field.key) ?? '',
        label: asString(field.label) ?? asString(field.key) ?? '',
        ...(type ? { type } : {}),
        required: field.required === true,
        writable: writableSchemaField(field),
        secret: field.encrypted === true || type === 'password',
        ...(onlyInModes.length > 0 ? { onlyInModes } : {}),
        ...(pattern ? { pattern } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(help ? { help } : {}),
        ...(items.length > 0 ? { itemFields: items } : {}),
      };
    }),
  };
}

// Wiro keeps a few credentials for itself (model routing, command lists); a
// user never fills them in.
export function isPlatformCredentialKey(key: string): boolean {
  return key.startsWith('sys-');
}
