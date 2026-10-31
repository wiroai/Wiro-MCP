import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isPlainObject,
  requireApiSuccess,
  truncate,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  DEFAULT_CRON_INTERVAL,
  agentStatusOf,
  customSkillEntries,
  customSkillErrorMessage,
  customSkillKindOf,
  humanizeCustomSkillKey,
  isCustomBuild,
  looksLikeCron,
  normalizeCustomSkillKey,
  readUserAgent,
  resolveExistingCustomSkillKey,
  restartNote,
  templateTaskTextError,
  toIsoTime,
  upsertCustomSkillKey,
  workspaceHint,
  type CustomSkillEntry,
  type CustomSkillKind,
} from '../utils/agent-config.js';
import { nextActionSchema } from './schemas.js';

const MAX_VALUE_ECHO = 1_500;

const kindSchema = z.enum(['skill', 'scheduled_task']);

const entrySchema = z.object({
  key: z.string(),
  kind: kindSchema,
  description: z.string(),
  value: z.string(),
  valueTruncated: z.boolean().optional(),
  interval: z.string().nullable(),
  enabled: z.boolean(),
  origin: z.enum(['agent', 'user']),
});

const outputSchema = {
  action: z.enum(['upsert', 'rename', 'delete', 'history', 'revert']),
  agentGuid: z.string(),
  key: z.string(),
  kind: kindSchema,
  status: z.enum(['saved', 'renamed', 'deleted', 'reverted', 'listed', 'confirm_needed', 'no_change']),
  created: z.boolean().optional(),
  renamedTo: z.string().optional(),
  revertResult: z.string().optional(),
  entry: entrySchema.nullable().optional(),
  schedule: z.object({
    interval: z.string(),
    timeZone: z.string(),
    note: z.string(),
  }).optional(),
  history: z.array(z.object({
    versionId: z.string(),
    operation: z.string(),
    changedAt: z.string().optional(),
    changedFields: z.array(z.string()),
    value: z.string().nullable(),
    valueTruncated: z.boolean().optional(),
    interval: z.string().nullable(),
    enabled: z.boolean().nullable(),
  })).optional(),
  presetDefault: z.object({
    value: z.string(),
    valueTruncated: z.boolean().optional(),
    interval: z.string().nullable(),
    enabled: z.boolean().nullable(),
    description: z.string(),
  }).nullable().optional(),
  templates: z.array(z.object({
    title: z.string(),
    description: z.string(),
    value: z.string(),
    interval: z.string().optional(),
  })).optional(),
  restart: z.string().optional(),
  warnings: z.array(z.string()),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type Action = 'upsert' | 'rename' | 'delete' | 'history' | 'revert';
type Row = Record<string, unknown>;

interface Input {
  action: Action;
  agent_guid: string;
  key: string;
  kind?: CustomSkillKind;
  value?: string;
  interval?: string;
  enabled?: boolean;
  description?: string;
  new_key?: string;
  source?: 'preset' | 'history';
  version_id?: string;
  limit: number;
  confirm: boolean;
}

function echo(value: string | null | undefined): { value: string; valueTruncated?: boolean } {
  const text = value ?? '';
  return text.length > MAX_VALUE_ECHO
    ? { value: truncate(text, MAX_VALUE_ECHO), valueTruncated: true }
    : { value: text };
}

/** An entry as returned; full keeps its whole text, which an edit starts from. */
function toEntry(entry: CustomSkillEntry, full = false) {
  return {
    key: entry.key,
    kind: entry.kind,
    description: entry.description,
    ...(full ? { value: entry.value } : echo(entry.value)),
    interval: entry.interval,
    enabled: entry.enabled,
    origin: entry.userCreated ? 'user' as const : 'agent' as const,
  };
}

/** Text in a fence longer than any run of backticks inside it, so it shows as is. */
function textBlock(value: string): string[] {
  let fence = '```';
  while (value.includes(fence)) fence += '`';
  return [`${fence}text`, value, fence];
}

function kindLabel(kind: CustomSkillKind): string {
  return kind === 'scheduled_task' ? 'scheduled task' : 'custom skill';
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function reply(
  input: Input,
  key: string,
  status: z.infer<typeof outputSchema.status>,
  message: string,
  extra: Record<string, unknown> = {},
  textExtra: string[] = [],
) {
  const warnings = Array.isArray(extra.warnings) ? extra.warnings as string[] : [];
  const label = kindLabel(customSkillKindOf(key));
  const lines = [
    `## ${label.charAt(0).toUpperCase()}${label.slice(1)} \`${key}\``,
    '',
    message,
    ...textExtra,
    ...(typeof extra.restart === 'string' ? ['', `**Restart:** ${extra.restart}`] : []),
    ...(warnings.length > 0 ? ['', ...warnings.map(warning => `- ${warning}`)] : []),
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      action: input.action,
      agentGuid: input.agent_guid,
      key,
      kind: customSkillKindOf(key),
      status,
      warnings,
      message,
      ...extra,
    },
  };
}

function scheduleInfo(row: Row, interval: string, isDefault: boolean, entry: { enabled: boolean; requiresCredentials: string[] }) {
  const timeZone = asString(row.timezone)?.trim() || 'UTC';
  const parts = [
    `Runs on the cron schedule "${interval}"${isDefault ? ' (the default: Mondays at 10:00)' : ''} in the agent's time zone, ${timeZone}. The time zone can be changed with update_agent.`,
    'Every run spends the agent\'s credits.',
    entry.enabled ? '' : 'It is turned off, so it does not run.',
    entry.requiresCredentials.length > 0 ? `It only runs while ${entry.requiresCredentials.join(', ')} is connected.` : '',
  ].filter(Boolean);
  return { interval, timeZone, note: parts.join(' ') };
}

async function upsert(client: WiroClient, input: Input, signal: AbortSignal) {
  const checked = upsertCustomSkillKey(input.key, input.kind, input.interval);
  if (checked.error || !checked.key) return errorResult(new Error(checked.error ?? 'Invalid key.'));
  const interval = input.interval?.trim();
  if (input.interval !== undefined && (!interval || !looksLikeCron(interval))) {
    return errorResult(new Error('interval must be a cron expression with five fields: minute hour day-of-month month day-of-week, for example "0 9 * * 1-5" for weekdays at 09:00.'));
  }
  if (input.value !== undefined && !input.value.trim()) {
    return errorResult(new Error('value cannot be empty: an entry without text never reaches the agent. To stop it, set enabled: false.'));
  }

  const row = await readUserAgent(client, input.agent_guid, signal);
  const entries = customSkillEntries(row);
  // A bare key edits the agent's own entry of that name, whichever kind it is.
  const computed = upsertCustomSkillKey(input.key, input.kind, input.interval, new Set(entries.map(entry => entry.key)));
  if (computed.error || !computed.key) return errorResult(new Error(computed.error ?? 'Invalid key.'));
  const key = computed.key;
  const kind = customSkillKindOf(key);
  const existing = entries.find(entry => entry.key === key) ?? null;
  const fromAgent = existing !== null && !existing.userCreated;
  if (!existing && input.value === undefined) {
    return errorResult(new Error(`${key} does not exist yet. A new ${kindLabel(kind)} needs value: ${kind === 'scheduled_task' ? 'the prompt the agent runs on schedule' : 'the instructions the agent follows'}.`));
  }
  if (existing && input.value === undefined && input.interval === undefined
    && input.enabled === undefined && input.description === undefined) {
    return errorResult(new Error('Nothing to change: pass value, interval, enabled or description.'));
  }
  if (fromAgent && input.description !== undefined && input.description.trim() !== existing.description.trim()) {
    return errorResult(new Error(`${key} comes with the agent, so its description cannot be changed. Its text${kind === 'scheduled_task' ? ', schedule' : ''} and on/off state can.`));
  }
  if (fromAgent && kind === 'scheduled_task' && existing.source === 'skill-bundle' && !isCustomBuild(row)
    && input.value !== undefined && input.value !== existing.value) {
    return errorResult(new Error(templateTaskTextError(key)));
  }

  const body: Record<string, unknown> = { useragentguid: input.agent_guid, skillkey: key };
  if (input.value !== undefined) body.value = input.value;
  if (interval !== undefined) body.interval = interval;
  if (input.enabled !== undefined) body.enabled = input.enabled;
  if (input.description !== undefined) body.description = input.description;
  requireApiSuccess(
    await client.post<ApiEnvelope>('/UserAgent/CustomSkillUpsert', body, signal),
    `Could not save ${key}.`,
  );

  const functional = !existing
    || (input.value !== undefined && input.value !== existing.value)
    || (interval !== undefined && interval !== (existing.interval ?? ''))
    || (input.enabled !== undefined && input.enabled !== existing.enabled);
  const after = {
    key,
    kind,
    description: input.description ?? existing?.description ?? humanizeCustomSkillKey(key),
    value: input.value ?? existing?.value ?? '',
    interval: kind === 'scheduled_task' ? interval ?? existing?.interval ?? DEFAULT_CRON_INTERVAL : null,
    enabled: input.enabled ?? existing?.enabled ?? true,
    source: existing?.source ?? 'user-created',
    userCreated: existing ? existing.userCreated : true,
    requiresCredentials: existing?.requiresCredentials ?? [],
  };
  const warnings: string[] = [];
  if (input.key.trim() !== key) warnings.push(`Saved under the key ${key}.`);
  const schedule = kind === 'scheduled_task' && after.interval
    ? scheduleInfo(row, after.interval, !existing && interval === undefined, after)
    : undefined;
  const restart = functional
    ? restartNote(agentStatusOf(row), 'change')
    : 'Its text, schedule and on/off state are unchanged, so the agent does not restart.';
  return reply(input, key, 'saved',
    existing ? `Updated the ${kindLabel(kind)} ${key}.` : `Created the ${kindLabel(kind)} ${key}.`,
    {
      created: !existing,
      entry: toEntry(after),
      ...(schedule ? { schedule } : {}),
      restart,
      warnings,
    },
    schedule ? ['', `**Schedule:** ${schedule.note}`] : []);
}

function resolveKey(input: Input, entries: CustomSkillEntry[]) {
  return resolveExistingCustomSkillKey(input.key, new Set(entries.map(entry => entry.key)), input.kind);
}

async function rename(client: WiroClient, input: Input, signal: AbortSignal) {
  const row = await readUserAgent(client, input.agent_guid, signal);
  const entries = customSkillEntries(row);
  const resolved = resolveKey(input, entries);
  if (resolved.error || !resolved.key) return errorResult(new Error(resolved.error ?? 'Invalid key.'));
  const oldKey = resolved.key;
  const existing = entries.find(entry => entry.key === oldKey);
  if (!existing) return errorResult(new Error(`This agent has no ${kindLabel(customSkillKindOf(oldKey))} ${oldKey}.`));
  if (!existing.userCreated) {
    return errorResult(new Error(`${oldKey} comes with the agent and cannot be renamed. Turn it off with action upsert and enabled: false, and create a new one instead.`));
  }
  if (!input.new_key?.trim()) return errorResult(new Error('new_key is required for rename.'));
  const target = input.new_key.trim();
  const targetIsTask = target.startsWith('cs-cron-') || target.startsWith('cron-');
  const targetIsSkill = target.startsWith('cs-') && !target.startsWith('cs-cron-');
  if ((existing.kind === 'skill' && targetIsTask) || (existing.kind === 'scheduled_task' && targetIsSkill)) {
    return errorResult(new Error('A custom skill and a scheduled task cannot be renamed into each other. Delete it and create a new one of the other kind.'));
  }
  const newKey = normalizeCustomSkillKey(target, { scheduled: existing.kind === 'scheduled_task' });
  if (!newKey) {
    return errorResult(new Error(`Invalid new_key "${input.new_key}". Use lowercase letters, digits and single dashes, for example weekly-report.`));
  }
  if (newKey === oldKey) return errorResult(new Error(`${oldKey} already has that key.`));
  if (entries.some(entry => entry.key === newKey)) return errorResult(new Error(`${newKey} already exists on this agent.`));

  const response = requireApiSuccess(
    await client.post<ApiEnvelope & { newskillkey?: unknown }>('/UserAgent/CustomSkillRename', {
      useragentguid: input.agent_guid,
      oldskillkey: oldKey,
      newskillkey: newKey,
      ...(input.description !== undefined ? { description: input.description } : {}),
    }, signal),
    `Could not rename ${oldKey}.`,
  );
  const renamedTo = asString(response.newskillkey) ?? newKey;
  return reply(input, oldKey, 'renamed', `Renamed ${oldKey} to ${renamedTo}.`, {
    renamedTo,
    entry: toEntry({ ...existing, key: renamedTo, description: input.description ?? existing.description }),
    restart: restartNote(agentStatusOf(row), 'new name'),
  });
}

async function remove(client: WiroClient, input: Input, signal: AbortSignal) {
  const row = await readUserAgent(client, input.agent_guid, signal);
  const entries = customSkillEntries(row);
  const resolved = resolveKey(input, entries);
  if (resolved.error || !resolved.key) return errorResult(new Error(resolved.error ?? 'Invalid key.'));
  const key = resolved.key;
  const existing = entries.find(entry => entry.key === key);
  // The key is checked against the agent's entries first, so a key that matches none is reported, not sent.
  if (!existing) return errorResult(new Error(`This agent has no ${kindLabel(customSkillKindOf(key))} ${key}.`));
  if (!existing.userCreated) {
    const response = reply(input, key, 'no_change',
      `${key} comes with the agent and cannot be deleted. Turn it off instead.`,
      {
        entry: toEntry(existing),
        nextAction: {
          tool: 'manage_agent_custom_skill',
          arguments: { action: 'upsert', agent_guid: input.agent_guid, key, enabled: false },
          reason: 'Turn it off instead of deleting it.',
        },
      });
    return { ...response, isError: true };
  }
  if (!input.confirm) {
    return reply(input, key, 'confirm_needed',
      `Deleting ${key} removes it together with its whole version history. It cannot be restored. Nothing has changed yet.`,
      {
        entry: toEntry(existing),
        nextAction: {
          tool: 'manage_agent_custom_skill',
          arguments: { action: 'delete', agent_guid: input.agent_guid, key, confirm: true },
          reason: 'Ask the user to confirm this first.',
        },
      });
  }
  requireApiSuccess(
    await client.post<ApiEnvelope>('/UserAgent/CustomSkillDelete', {
      useragentguid: input.agent_guid,
      skillkey: key,
    }, signal),
    `Could not delete ${key}.`,
  );
  return reply(input, key, 'deleted', `Deleted ${key} and its history.`, {
    entry: null,
    restart: restartNote(agentStatusOf(row), 'change'),
  });
}

interface HistoryData {
  entries: Row[];
  presetDefault: Row | null;
}

async function readHistory(client: WiroClient, input: Input, key: string, signal: AbortSignal): Promise<HistoryData> {
  const body = requireApiSuccess(
    await client.post<ApiEnvelope & { entries?: unknown; preset_default?: unknown }>('/UserAgent/CustomSkillHistory', {
      useragentguid: input.agent_guid,
      skillkey: key,
    }, signal),
    `Could not read the history of ${key}.`,
  );
  return {
    entries: Array.isArray(body.entries) ? body.entries.filter(isPlainObject) : [],
    presetDefault: isPlainObject(body.preset_default) ? body.preset_default : null,
  };
}

// History rows store the state before each save; after_* is what that save produced.
function historyEntry(row: Row) {
  const value = row.after_value === null || row.after_value === undefined ? null : String(row.after_value);
  const changedAt = toIsoTime(row.changedat);
  return {
    versionId: asString(row.guid) ?? '',
    operation: asString(row.operation) ?? '',
    ...(changedAt ? { changedAt } : {}),
    changedFields: Array.isArray(row.changed_fields) ? row.changed_fields.map(String) : [],
    ...(value === null ? { value: null } : echo(value)),
    interval: asString(row.after_interval) ?? null,
    enabled: boolOrNull(row.after_enabled),
  };
}

function presetDefaultOf(preset: Row | null) {
  if (!preset) return null;
  return {
    ...echo(asString(preset.value)),
    interval: asString(preset.intervalexpr) ?? null,
    enabled: boolOrNull(preset.enabled),
    description: asString(preset.description) ?? '',
  };
}

async function history(client: WiroClient, input: Input, signal: AbortSignal) {
  const row = await readUserAgent(client, input.agent_guid, signal);
  const entries = customSkillEntries(row);
  const resolved = resolveKey(input, entries);
  if (resolved.error || !resolved.key) return errorResult(new Error(resolved.error ?? 'Invalid key.'));
  const key = resolved.key;
  const warnings: string[] = [];
  const [data, alternatives] = await Promise.all([
    readHistory(client, input, key, signal),
    client.post<ApiEnvelope & { alternatives?: unknown }>('/UserAgent/CustomSkillAlternatives', {
      useragentguid: input.agent_guid,
      skillkey: key,
    }, signal).catch((error: unknown) => {
      warnings.push(`Templates could not be read: ${errorText(error)}`);
      return null;
    }),
  ]);
  const templates = alternatives?.result === true && Array.isArray(alternatives.alternatives)
    ? alternatives.alternatives.filter(isPlainObject).map(template => ({
      title: asString(template.title) ?? '',
      description: asString(template.description) ?? '',
      value: truncate(asString(template.value) ?? '', 4_000),
      ...(asString(template.intervalexpr) ? { interval: asString(template.intervalexpr) } : {}),
    }))
    : [];
  const versions = data.entries.slice(0, input.limit).map(historyEntry);
  const current = entries.find(entry => entry.key === key) ?? null;
  const presetDefault = presetDefaultOf(data.presetDefault);
  const message = [
    current ? `Current: ${current.enabled ? 'on' : 'off'}${current.interval ? `, schedule "${current.interval}"` : ''}.` : 'This key has no live entry on the agent.',
    `${data.entries.length} saved version${data.entries.length === 1 ? '' : 's'}${versions.length < data.entries.length ? `, showing the newest ${versions.length}` : ''}.`,
    presetDefault ? 'It has a template default (revert with source preset).' : 'It has no template default.',
    templates.length > 0 ? `${templates.length} ready-made template${templates.length === 1 ? '' : 's'} can be used as its text.` : '',
  ].filter(Boolean).join(' ');
  return reply(input, key, 'listed', message, {
    entry: current ? toEntry(current, true) : null,
    history: versions,
    presetDefault,
    templates,
    warnings,
  }, [
    ...(current?.value ? ['', '**Current text:**', '', ...textBlock(current.value)] : []),
    '',
    ...versions.map(version => `- \`${version.versionId}\` ${version.changedAt ?? ''} ${version.operation}${version.changedFields.length > 0 ? ` (${version.changedFields.join(', ')})` : ''}`),
    ...(templates.length > 0 ? ['', '**Templates:**', ...templates.map(template => `- ${template.title}${template.interval ? ` (schedule "${template.interval}")` : ''}: ${template.description}`)] : []),
  ]);
}

async function revert(client: WiroClient, input: Input, signal: AbortSignal) {
  if (!input.source) return errorResult(new Error('source is required for revert: preset (the template default) or history (an earlier version).'));
  if (input.source === 'history' && !input.version_id) {
    return errorResult(new Error('version_id is required with source history. List the versions with action history.'));
  }
  const row = await readUserAgent(client, input.agent_guid, signal);
  const entries = customSkillEntries(row);
  const resolved = resolveKey(input, entries);
  if (resolved.error || !resolved.key) return errorResult(new Error(resolved.error ?? 'Invalid key.'));
  const key = resolved.key;
  const current = entries.find(entry => entry.key === key) ?? null;

  if (!input.confirm) {
    const data = await readHistory(client, input, key, signal);
    const warnings: string[] = [];
    let message: string;
    if (input.source === 'preset') {
      message = data.presetDefault
        ? `Reverting resets ${key} to the template default: its text, schedule, on/off state and description. Your edits are replaced.`
        : `${key} has no template default, so reverting to the template deletes it from the agent.`;
      if (!data.presetDefault) warnings.push('This removes the entry. Its history is kept, so a version can be restored later with source history.');
    } else {
      const version = data.entries.find(entry => asString(entry.guid) === input.version_id);
      if (!version) return errorResult(new Error(`Version ${input.version_id} was not found for ${key}. List the versions with action history.`));
      const restored = historyEntry(version);
      message = `Reverting restores the version of ${key} saved${restored.changedAt ? ` at ${restored.changedAt}` : ''}: its text${restored.interval ? `, schedule "${restored.interval}"` : ''} and on/off state. The current text is replaced.`;
    }
    return reply(input, key, 'confirm_needed', `${message} Nothing has changed yet.`, {
      entry: current ? toEntry(current) : null,
      presetDefault: presetDefaultOf(data.presetDefault),
      warnings,
      nextAction: {
        tool: 'manage_agent_custom_skill',
        arguments: {
          action: 'revert',
          agent_guid: input.agent_guid,
          key,
          source: input.source,
          ...(input.version_id ? { version_id: input.version_id } : {}),
          confirm: true,
        },
        reason: 'Ask the user to confirm this first.',
      },
    });
  }

  const response = requireApiSuccess(
    await client.post<ApiEnvelope & Row>('/UserAgent/CustomSkillRevert', {
      useragentguid: input.agent_guid,
      skillkey: key,
      source: input.source,
      ...(input.source === 'history' ? { versionguid: input.version_id } : {}),
    }, signal),
    `Could not revert ${key}.`,
  );
  const outcome = asString(response.action) ?? '';
  const kind = customSkillKindOf(key);
  const currentValue = response.current_value === null || response.current_value === undefined
    ? null
    : String(response.current_value);
  const entry = currentValue === null
    ? null
    : toEntry({
      key,
      kind,
      description: current?.description ?? '',
      value: currentValue,
      interval: asString(response.current_interval) ?? null,
      enabled: response.current_enabled !== false,
      source: current?.source ?? '',
      userCreated: current?.userCreated ?? false,
      requiresCredentials: current?.requiresCredentials ?? [],
    });
  const messages: Record<string, string> = {
    'no-op': `${key} already matches that version; nothing changed.`,
    reset: `${key} is back to the template default.`,
    deleted: `${key} had no template default, so it was removed from the agent.`,
    reverted: `${key} is restored to the chosen version.`,
    're-inserted': `${key} is restored to the chosen version and is back on the agent.`,
  };
  return reply(input, key,
    outcome === 'no-op' ? 'no_change' : outcome === 'deleted' ? 'deleted' : 'reverted',
    messages[outcome] ?? `${key} was reverted.`,
    {
      revertResult: outcome,
      entry,
      restart: outcome === 'no-op'
        ? 'Nothing changed, so the agent does not restart.'
        : restartNote(agentStatusOf(row), 'change'),
    });
}

export function registerManageAgentCustomSkill(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'manage_agent_custom_skill',
    {
      title: 'Manage custom skills and scheduled tasks',
      description: 'Create and manage a deployed agent\'s own skills. A custom skill (key cs-...) is '
        + 'standing instructions the agent follows, for example a tone or an approval policy. A '
        + 'scheduled task (key cs-cron-...) is a prompt the agent runs by itself on a cron schedule, '
        + 'for example a weekly report. Actions: upsert creates or updates one (a bare key such as '
        + '"weekly-report" updates the agent\'s own entry of that name when there is one, and otherwise '
        + 'gets its prefix from kind or interval; the result gives the final key); rename '
        + 'changes the key of one you created; delete removes one you created together with its '
        + 'history (needs confirm: true); history shows the current text in full and lists earlier '
        + 'versions, the template default and ready-made templates (key "cs-my-custom-strategy" or '
        + '"cs-cron-my-scheduled-task" gives starter templates); revert restores the template default '
        + 'or an earlier version (needs confirm: true). Schedules use the agent\'s time zone, which is '
        + 'UTC unless it was set with update_agent; a new task without interval runs Mondays at 10:00. '
        + 'Every scheduled run spends the agent\'s credits, so confirm the schedule with the user. '
        + 'Entries from the agent\'s template, cs-approval-policy and the scheduled tasks its skills '
        + 'brought cannot be deleted or renamed: set enabled false instead. The agent '
        + 'restarts when the text, schedule or on/off state changes. get_my_agent lists the '
        + 'current entries. Registry skills are switched with apply_agent_skills instead. The agents '
        + 'playbook (get_playbook) covers custom skills and schedules.',
      inputSchema: {
        action: z.enum(['upsert', 'rename', 'delete', 'history', 'revert'])
          .describe('What to do.'),
        agent_guid: z.string().min(1).describe('The deployed agent\'s guid, from list_my_agents.'),
        key: z.string().min(1).max(80)
          .describe('The entry\'s key: a full key (cs-... or cs-cron-...) or a bare slug such as "weekly-report" (lowercase letters, digits, single dashes). A bare slug names the agent\'s existing entry of that name, whichever kind it is.'),
        kind: kindSchema.optional()
          .describe('skill (instructions, cs-) or scheduled_task (runs on a schedule, cs-cron-). Decides the prefix of a bare key; without it a new bare key becomes a custom skill unless interval is given.'),
        value: z.string().max(100_000).optional()
          .describe('upsert: the instructions (custom skill) or the prompt to run (scheduled task). Required when creating.'),
        interval: z.string().max(120).optional()
          .describe('upsert, scheduled tasks only: a 5-field cron expression such as "0 9 * * 1-5" (weekdays 09:00). Omit to keep the current schedule, or Mondays 10:00 for a new task.'),
        enabled: z.boolean().optional()
          .describe('upsert: true to turn it on, false to turn it off. New entries start on.'),
        description: z.string().max(1_000).optional()
          .describe('upsert or rename: a short summary the agent uses to pick the skill. Fixed for entries that come with the agent.'),
        new_key: z.string().max(80).optional()
          .describe('rename: the new key, of the same kind.'),
        source: z.enum(['preset', 'history']).optional()
          .describe('revert: preset (the template default) or history (an earlier version).'),
        version_id: z.string().optional()
          .describe('revert with source history: a versionId from action history.'),
        limit: z.number().int().min(1).max(500).default(20)
          .describe('history: how many versions to return, newest first (default 20).'),
        confirm: z.boolean().default(false)
          .describe('delete and revert: true to do it after the user agreed. Without it they only describe what would happen.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const input = args as Input;
      try {
        switch (input.action) {
          case 'upsert':
            return await upsert(client, input, extra.signal);
          case 'rename':
            return await rename(client, input, extra.signal);
          case 'delete':
            return await remove(client, input, extra.signal);
          case 'history':
            return await history(client, input, extra.signal);
          default:
            return await revert(client, input, extra.signal);
        }
      } catch (error) {
        const message = customSkillErrorMessage(errorText(error));
        const hint = workspaceHint(message);
        return errorResult(new Error(hint ? `${message} ${hint}` : message));
      }
    },
  );
}
