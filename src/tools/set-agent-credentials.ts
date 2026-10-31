import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isPlainObject,
  toInteger,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  agentStatusLabel,
  agentStatusOf,
  channelStatuses,
  chooseConnectionMode,
  connectionModeRequirements,
  credentialFieldShape,
  credentialGroup,
  credentialStatus,
  customSkillEntries,
  isWritableField,
  loadCredentialMeta,
  ownAppRedirectUri,
  prepareCredentialWrite,
  readUserAgent,
  redactSecrets,
  uploadFileName,
  type CredentialField,
  type CredentialMeta,
} from '../utils/agent-config.js';
import { fetchPublicFile, type RemoteFile } from '../utils/remote-file.js';
import { nextActionSchema } from './schemas.js';

const credentialValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.record(z.string(), z.unknown())])),
]);

const credentialStatusSchema = z.object({
  key: z.string(),
  title: z.string(),
  connected: z.boolean(),
  filled: z.boolean(),
  requiredMissing: z.boolean(),
  optional: z.boolean(),
  missingFields: z.array(z.string()),
});

const channelStatusSchema = z.object({
  id: z.string(),
  title: z.string(),
  credential: z.string(),
  enabled: z.boolean(),
  missingFields: z.array(z.string()),
});

const fieldDescriptionSchema = z.object({
  field: z.string(),
  label: z.string(),
  type: z.string(),
  valueFormat: z.string(),
  required: z.boolean(),
  writable: z.boolean(),
  secret: z.boolean(),
  modes: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  options: z.array(z.string()).optional(),
  itemFields: z.array(z.object({
    field: z.string(),
    label: z.string(),
    type: z.string(),
    required: z.boolean(),
    pattern: z.string().optional(),
  })).optional(),
  fileTypes: z.array(z.string()).optional(),
  maxSizeKb: z.number().optional(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
});

const connectionModeSchema = z.object({
  mode: z.string(),
  available: z.boolean(),
  needsBrowser: z.boolean(),
  fields: z.array(z.object({ field: z.string(), label: z.string(), isSet: z.boolean() })),
  note: z.string(),
});

const outputSchema = {
  agentGuid: z.string(),
  mode: z.enum(['describe', 'write']),
  credential: z.object({
    key: z.string(),
    title: z.string(),
    kind: z.enum(['fields', 'sign_in', 'channel']),
    fields: z.array(fieldDescriptionSchema),
    connectionModes: z.array(connectionModeSchema).optional(),
    ownAppRedirectUri: z.string().optional(),
    channel: z.object({ id: z.string(), requiredFields: z.array(z.string()) }).optional(),
    status: credentialStatusSchema.nullable(),
  }).optional(),
  applied: z.number().int().nonnegative().optional(),
  uploadedFiles: z.array(z.object({
    credential: z.string(),
    field: z.string(),
    url: z.string(),
  })).optional(),
  errors: z.array(z.string()).optional(),
  credentials: z.array(credentialStatusSchema).optional(),
  channels: z.array(channelStatusSchema).optional(),
  agentStatus: z.string().optional(),
  notes: z.array(z.string()),
  nextAction: nextActionSchema.optional(),
};

type CredentialUpsertBody = ApiEnvelope & {
  applied?: unknown;
  twilioWebhooksUpdated?: unknown;
  twilioWebhooksFailed?: unknown;
  twilioWebhookSkipped?: unknown;
  twilioWebhookError?: unknown;
};

type FileUploadBody = ApiEnvelope & { url?: unknown };

function valueFormat(field: CredentialField): string {
  switch (credentialFieldShape(field)) {
    case 'string-array':
      return 'list of text values';
    case 'object-array':
      return field.itemSchema.length > 0
        ? `list of objects with keys ${field.itemSchema.map(item => item.key).join(', ')}`
        : 'list of objects';
    case 'file':
      return 'public http(s) URL of the file; it is uploaded';
    case 'base64-file':
      return 'the file content, as text or base64';
    case 'boolean':
      return 'true or false';
    case 'number':
      return 'number';
    case 'select':
      return field.options ? `one of: ${field.options.map(option => option || '(empty)').join(', ')}` : 'one option';
    default:
      if (field.encrypted || field.type === 'password') return 'secret text';
      if (field.type === 'email') return 'email address';
      if (field.type === 'url') return 'URL';
      return 'text';
  }
}

function describeField(field: CredentialField) {
  return {
    field: field.key,
    label: field.label,
    type: field.type,
    valueFormat: valueFormat(field),
    required: field.required,
    writable: isWritableField(field),
    secret: field.encrypted || field.type === 'password' || field.type === 'fileinput-base64',
    ...(field.onlyInModes ? { modes: field.onlyInModes } : {}),
    ...(field.pattern ? { pattern: field.pattern } : {}),
    ...(field.options ? { options: field.options } : {}),
    ...(field.itemSchema.length > 0
      ? {
        itemFields: field.itemSchema.map(item => ({
          field: item.key,
          label: item.label,
          type: item.type,
          required: item.required,
          ...(item.pattern ? { pattern: item.pattern } : {}),
        })),
      }
      : {}),
    ...(field.fileTypes ? { fileTypes: field.fileTypes } : {}),
    ...(field.maxSizeKb !== undefined ? { maxSizeKb: field.maxSizeKb } : {}),
    ...(field.help ? { help: field.help } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
  };
}

function credentialKind(meta: CredentialMeta): 'fields' | 'sign_in' | 'channel' {
  if (meta.channel) return 'channel';
  return meta.oauth ? 'sign_in' : 'fields';
}

function firstSentence(text: string): string {
  const sentence = /^(.{20,200}?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > 200 ? `${sentence.slice(0, 200)}...` : sentence;
}

function afterWriteNote(status: number | null): string {
  switch (status) {
    case 1:
      return 'The agent restarts to load the new values, which takes about a minute.';
    case 2:
    case 3:
      return 'The agent is starting and loads the new values.';
    case 4:
      return 'The agent restarts shortly to load the new values.';
    case 6:
      return 'The agent still needs setup before it can start; get_my_agent shows what is missing.';
    case null:
      return 'Check the agent with get_my_agent.';
    default:
      return `The agent is ${agentStatusLabel(status)}; the values are used when it starts.`;
  }
}

function errorMessages(body: ApiEnvelope): string[] {
  return (body.errors ?? [])
    .map(error => (typeof error?.message === 'string' ? error.message.trim() : ''))
    .filter(Boolean);
}

function connectModeFor(meta: CredentialMeta, written: Set<string>, authMethod?: string): string | undefined {
  if (authMethod) return authMethod;
  const probe = meta.oauth?.directProbe;
  if (probe && probe.requiredFields.some(field => written.has(field))) return probe.mode;
  if (meta.fields.some(field => written.has(field.key) && field.onlyInModes?.includes('own'))) return 'own';
  return undefined;
}

export function registerSetAgentCredentials(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'set_agent_credentials',
    {
      title: 'Set agent credentials',
      description: 'Save credential fields on a deployed agent: API keys, bot tokens, account IDs, '
        + 'allow lists, your own OAuth app keys, or the token for a browser-free connection. '
        + 'Call with only credential (no fields) to see that credential\'s field keys, formats, '
        + 'which are required, how it connects, and what is already set on this agent; nothing is '
        + 'written then. Skip that call when list_agent_skills with name already showed the fields. '
        + 'Then call with fields. Every field is checked before anything '
        + 'is written; unknown or Wiro-managed fields are refused. A key file, such as a Google '
        + 'service account JSON or an App Store .p8 key, takes the file\'s text, never a link: never '
        + 'ask for a public link to a key (the user can also upload it on the agent\'s page in the '
        + 'Wiro dashboard). Other file fields take a public URL and the file is uploaded. '
        + 'Values are never echoed back. A running agent restarts to load '
        + 'the values. Channels such as Telegram, Slack and Discord turn on by themselves once all '
        + 'their required fields are set, and turn off when one is cleared. Saving a credential can '
        + 'switch scheduled tasks that need it back on. Sign-in integrations (such as Google Ads, YouTube, '
        + 'Meta and HubSpot) are then connected with connect_agent_oauth; Gmail, Google Calendar and Google '
        + 'Drive are not sign-ins and are set here. Only save a Wiro project API '
        + 'key (credential "wiro") that the user gave you: model runs are billed to its wallet. '
        + 'The agents playbook (get_playbook) has the full setup walkthrough.',
      inputSchema: {
        agent_guid: z.string().min(1).describe('The deployed agent\'s guid, from list_my_agents.'),
        credential: z.string().optional()
          .describe('Describe mode: a credential key such as "telegram" or "google-ads". Used when fields is empty.'),
        fields: z.array(z.object({
          credential: z.string().min(1).describe('Credential key, for example "telegram", "gmail" or "meta-ads".'),
          field: z.string().min(1).describe('Field key inside that credential, for example "bottoken". Use "authmethod" to pick a connection mode (for example "api_key").'),
          value: credentialValueSchema.describe('The value. Lists are JSON arrays; a list of objects replaces the whole list. A key file takes the file\'s text; other files take a public http(s) URL. An empty value clears an optional field.'),
          parent_field: z.string().optional().describe('Only to change one entry of a list field: that list field\'s key, for example "groups".'),
          ordinal: z.number().int().min(0).optional().describe('With parent_field: the entry\'s position in the list, from 0.'),
        })).max(100).optional()
          .describe('Fields to save. Send the fields of one credential together.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, credential, fields }, extra) => {
      const secrets: string[] = [];
      try {
        if (!fields || fields.length === 0) {
          if (!credential?.trim()) {
            return errorResult(new Error('Pass fields to save, or credential to see what that credential needs.'));
          }
          return await describeCredential(client, agent_guid, credential.trim(), extra.signal);
        }

        const keys = [...new Set(fields.map(field => field.credential.trim()))];
        const metas = new Map<string, CredentialMeta | null>();
        for (const key of keys) metas.set(key, await loadCredentialMeta(client, key, extra.signal));
        const prepared = prepareCredentialWrite(fields, metas);
        secrets.push(...prepared.secrets);
        if (prepared.errors.length > 0) {
          return errorResult(new Error(redactSecrets(`Nothing was saved:\n\n- ${prepared.errors.join('\n- ')}`, secrets)));
        }

        // Files are fetched before anything is written, so a bad URL leaves the agent untouched.
        const downloads: Array<{ file: typeof prepared.files[number]; remote: RemoteFile; contentType: string }> = [];
        for (const file of prepared.files) {
          const remote = await fetchPublicFile(file.url, { maxBytes: file.maxBytes });
          const contentType = (remote.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
          if (file.fileTypes.length > 0 && !file.fileTypes.includes(contentType)) {
            return errorResult(new Error(`Nothing was saved: ${file.label} must be one of ${file.fileTypes.join(', ')}, but the file at ${file.url} is ${contentType || 'of an unknown type'}.`));
          }
          downloads.push({ file, remote, contentType });
        }

        const errors: string[] = [];
        const notes: string[] = [];
        let applied = 0;
        if (prepared.apiFields.length > 0) {
          const body = await client.post<CredentialUpsertBody>('/UserAgent/CredentialUpsert', {
            useragentguid: agent_guid,
            fields: prepared.apiFields,
          }, extra.signal);
          applied = toInteger(body.applied);
          if (body.result !== true) {
            const messages = errorMessages(body);
            errors.push(...(messages.length > 0 ? messages : ['The credentials were not saved.']));
            if (applied === 0) {
              return errorResult(new Error(redactSecrets(`Nothing was saved:\n\n- ${errors.join('\n- ')}`, secrets)));
            }
          }
          const updated = Array.isArray(body.twilioWebhooksUpdated) ? body.twilioWebhooksUpdated.length : 0;
          const failed = Array.isArray(body.twilioWebhooksFailed) ? body.twilioWebhooksFailed.filter(isPlainObject) : [];
          if (updated > 0) notes.push(`Calls to ${updated} Twilio number${updated === 1 ? '' : 's'} now reach the agent.`);
          if (failed.length > 0) {
            notes.push(`Twilio could not be updated for ${failed.length} number${failed.length === 1 ? '' : 's'}: ${asString(failed[0]?.error) ?? 'unknown error'}. Save the Twilio fields again to retry.`);
          }
          if (asString(body.twilioWebhookSkipped)) notes.push(`Twilio call routing was not updated: ${asString(body.twilioWebhookSkipped)}.`);
          if (asString(body.twilioWebhookError)) notes.push(`Twilio call routing failed: ${asString(body.twilioWebhookError)}.`);
        }

        const uploadedFiles: Array<{ credential: string; field: string; url: string }> = [];
        if (errors.length === 0) {
          for (const { file, remote, contentType } of downloads) {
            const form = new FormData();
            form.append('useragentguid', agent_guid);
            form.append('credentialkey', file.credential);
            form.append('fieldname', file.field);
            form.append(
              'file',
              new Blob([remote.data], contentType ? { type: contentType } : {}),
              uploadFileName(file.url, file.field, contentType),
            );
            const body = await client.postForm<FileUploadBody>('/UserAgent/CredentialFileUpload', form, extra.signal);
            if (body.result === true && asString(body.url)) {
              uploadedFiles.push({ credential: file.credential, field: file.field, url: asString(body.url) as string });
              applied += 1;
            } else {
              errors.push(`${file.label}: ${errorMessages(body).join(', ') || 'the upload failed'}.`);
            }
          }
        } else if (downloads.length > 0) {
          notes.push('Files were not uploaded because the other fields failed.');
        }

        let row: Record<string, unknown> | null = null;
        try {
          row = await readUserAgent(client, agent_guid, extra.signal);
        } catch {
          notes.push('The agent could not be read afterwards; check it with get_my_agent.');
        }
        const status = row ? agentStatusOf(row) : null;
        const statuses = row
          ? keys.map(key => credentialStatus(row as Record<string, unknown>, key, metas.get(key))).filter(entry => entry !== null)
          : [];
        const channels = row ? channelStatuses(row) : [];
        for (const channel of channels.filter(entry => keys.includes(entry.credential))) {
          notes.push(channel.enabled
            ? `${channel.title} is on.`
            : `${channel.title} turns on once these are set: ${channel.missingFields.join(', ') || 'its required fields'}.`);
        }
        if (row && customSkillEntries(row).some(entry => entry.kind === 'scheduled_task'
          && entry.requiresCredentials.some(key => keys.includes(key)))) {
          notes.push('Scheduled tasks that need these credentials are switched on or off to match, including ones that were turned off by hand.');
        }
        if (keys.includes('wiro')) {
          notes.push('Model runs started by this agent are billed to the wallet of the workspace that owns that project key.');
        }
        notes.unshift(afterWriteNote(status));

        let nextAction;
        for (const key of keys) {
          const meta = metas.get(key);
          const state = statuses.find(entry => entry.key === key);
          if (!meta?.oauth || state?.connected) continue;
          const written = new Set(prepared.apiFields.filter(field => field.credentialkey === key).map(field => field.fieldname));
          const authMethod = prepared.apiFields.find(field => field.credentialkey === key && field.fieldname === 'authmethod')?.fieldvalue;
          const mode = connectModeFor(meta, written, typeof authMethod === 'string' ? authMethod : undefined);
          if (mode === 'api_key' && !meta.oauth.directProbe) continue;
          nextAction = {
            tool: 'connect_agent_oauth',
            arguments: { action: 'connect', agent_guid, credential: key, ...(mode ? { mode } : {}) },
            reason: `Connect ${meta.title} now that its fields are saved.`,
          };
          break;
        }

        const lines = [
          errors.length > 0 ? '## Credentials partly saved' : '## Credentials saved',
          '',
          `**Agent:** \`${agent_guid}\`${status !== null ? ` (${agentStatusLabel(status)})` : ''}`,
          `**Fields saved:** ${applied}`,
          ...uploadedFiles.map(file => `**Uploaded:** ${file.credential}.${file.field}: ${file.url}`),
          ...statuses.map(entry => `**${entry.title}:** ${entry.connected ? 'connected' : entry.filled ? 'set' : 'not complete'}${entry.missingFields.length > 0 ? `; missing ${entry.missingFields.join(', ')}` : ''}`),
          ...(errors.length > 0 ? ['', '### Problems', '', ...errors.map(error => `- ${error}`)] : []),
          '',
          ...notes.map(note => `- ${note}`),
        ];
        return {
          content: [{ type: 'text' as const, text: redactSecrets(lines.join('\n'), secrets) }],
          structuredContent: {
            agentGuid: agent_guid,
            mode: 'write' as const,
            applied,
            uploadedFiles,
            errors: errors.map(error => redactSecrets(error, secrets)),
            credentials: statuses,
            channels,
            ...(status !== null ? { agentStatus: agentStatusLabel(status) } : {}),
            notes: notes.map(note => redactSecrets(note, secrets)),
            ...(nextAction ? { nextAction } : {}),
          },
          ...(errors.length > 0 ? { isError: true } : {}),
        };
      } catch (error) {
        return errorResult(new Error(redactSecrets(errorText(error), secrets)));
      }
    },
  );
}

async function describeCredential(
  client: WiroClient,
  agentGuid: string,
  key: string,
  signal: AbortSignal,
) {
  const meta = await loadCredentialMeta(client, key, signal);
  if (!meta) {
    return errorResult(new Error(`Unknown credential "${key}". The credential keys a skill uses are listed by list_agent_skills and get_my_agent.`));
  }
  const notes: string[] = [];
  let row: Record<string, unknown> | null = null;
  try {
    row = await readUserAgent(client, agentGuid, signal);
  } catch (error) {
    notes.push(`The agent could not be read: ${errorText(error)}`);
  }
  const group = row ? credentialGroup(row, key) : null;
  const status = row ? credentialStatus(row, key, meta) : null;
  const kind = credentialKind(meta);
  const modes = meta.oauth ? connectionModeRequirements(meta, group) : undefined;
  const redirectUri = meta.oauth && meta.connectionModes.includes('own') ? ownAppRedirectUri(meta) : undefined;
  const fields = meta.fields.map(describeField);

  if (meta.platformOnly) notes.push(`${meta.title} is managed by Wiro; there is nothing to set.`);
  if (meta.channel) {
    notes.push(`${meta.title} turns on by itself once these are set: ${meta.channel.requiredFields.map(field => meta.fields.find(candidate => candidate.key === field)?.label ?? field).join(', ')}. Clearing one turns it off.`);
  }
  if (meta.connectionModes.length > 0) {
    notes.push(`To choose how it connects, set field authmethod to one of: ${meta.connectionModes.join(', ')}.`);
  }
  if (key === 'wiro') {
    notes.push('The value is a Wiro project API key. Model runs started by the agent are billed to the wallet of the workspace that owns that project. Only use a key the user gave you.');
  }

  let nextAction;
  if (meta.oauth && modes && !status?.connected) {
    const mode = chooseConnectionMode(meta, modes);
    if (mode && !(mode === 'api_key' && !meta.oauth.directProbe)) {
      nextAction = {
        tool: 'connect_agent_oauth',
        arguments: { action: 'connect', agent_guid: agentGuid, credential: key, mode },
        reason: mode === 'wiro'
          ? `Start the ${meta.title} sign-in; the user approves it in a browser.`
          : `Everything mode ${mode} needs is saved; connect ${meta.title}.`,
      };
    }
  }

  const lines = [
    `## ${meta.title} (${key})`,
    '',
    status
      ? `**On this agent:** ${status.connected ? 'connected' : kind === 'sign_in' ? 'not connected' : status.filled ? 'set' : 'not complete'}${status.missingFields.length > 0 ? `; missing ${status.missingFields.join(', ')}` : ''}`
      : '**On this agent:** not set yet',
    '',
    '### Fields',
    '',
    ...meta.fields.map(field => {
      const flags = [
        valueFormat(field),
        field.required ? 'required' : 'optional',
        !isWritableField(field) ? (field.platformManaged ? 'managed by Wiro' : 'filled by the connection') : null,
        field.onlyInModes ? `mode ${field.onlyInModes.join('/')}` : null,
        field.pattern ? `pattern ${field.pattern}` : null,
      ].filter(Boolean).join(', ');
      return `- \`${field.key}\` ${field.label} (${flags})${field.help ? `: ${firstSentence(field.help)}` : ''}`;
    }),
    ...(modes
      ? ['', '### How it connects', '', ...modes.filter(mode => mode.available).map(mode => `- **${mode.mode}**: ${mode.note}${mode.fields.length > 0 ? ` Fields: ${mode.fields.map(field => `${field.field}${field.isSet ? ' (set)' : ''}`).join(', ')}.` : ''}`)]
      : []),
    ...(notes.length > 0 ? ['', ...notes.map(note => `- ${note}`)] : []),
  ];

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      agentGuid,
      mode: 'describe' as const,
      credential: {
        key,
        title: meta.title,
        kind,
        fields,
        ...(modes ? { connectionModes: modes } : {}),
        ...(redirectUri ? { ownAppRedirectUri: redirectUri } : {}),
        ...(meta.channel ? { channel: meta.channel } : {}),
        status,
      },
      ...(row ? { agentStatus: agentStatusLabel(agentStatusOf(row)) } : {}),
      notes,
      ...(nextAction ? { nextAction } : {}),
    },
  };
}
