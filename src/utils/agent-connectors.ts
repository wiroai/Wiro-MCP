import { z } from 'zod';
import type { WiroClient } from '../client.js';
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

// Agent connectors: the outside services an agent works with, such as an ad
// account, a store or a mailbox. Wiro keeps one catalog of them, and each agent
// connects the ones it needs: with values typed on the connector's Connect card
// (an API key, a token, an ID), with a sign-in the user approves in their own
// browser, or with a Wiro project (the wiro connector, which always runs with
// the agent's own project, so connecting it binds that project to the agent). A
// connected connector gives the agent its tools, named <connector>__<tool>, and
// a connector with account choices acts only on the accounts chosen, whether it
// runs here or on its vendor's server. Everything here is built field by field
// from what the catalog and the connection views show; a saved value never
// comes back.

/** A connector's catalog key: a lowercase letter, then 1 to 29 lowercase letters, digits or dashes. */
export const CONNECTOR_SLUG = /^[a-z][a-z0-9-]{1,29}$/;

/** How a connector connects, as the tools say it. */
export const CONNECT_WAYS = ['key', 'sign_in', 'project', 'none'] as const;
export type ConnectWay = typeof CONNECT_WAYS[number];

/** The ways a connector that offers two of them takes, as connect_agent_connector's mode. */
export const CONNECT_MODES = ['sign_in', 'key'] as const;
export type ConnectMode = typeof CONNECT_MODES[number];

export const CONNECTION_STATUSES = ['connected', 'pending', 'reauth', 'error'] as const;
export type ConnectionStatus = typeof CONNECTION_STATUSES[number];

/** How long a sign-in link works: Wiro keeps the sign-in's state this long. */
export const SIGN_IN_LINK_TTL_SECONDS = 600;

/** The longest help text a field shows. */
const FIELD_HELP_MAX = 4_000;
const TOOL_DESCRIPTION_MAX = 200;

export const connectorFieldSchema = z.object({
  name: z.string().describe('The key to send in connect_agent_connector values.'),
  label: z.string(),
  description: z.string().optional()
    .describe('Where the value comes from and how to get it, as the connector\'s Connect card says it (Markdown).'),
  required: z.boolean(),
  secret: z.boolean(),
  format: z.string().describe('text, password, url, email, textarea, json or select.'),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })).optional(),
  placeholder: z.string().optional(),
  pattern: z.string().optional(),
  maxLength: z.number().int().optional(),
  appKey: z.boolean().optional()
    .describe('A key of the user\'s own app at the service, such as its client id or secret: used only to sign in, never handed to the agent.'),
  mode: z.enum(CONNECT_MODES).optional()
    .describe('For a connector that connects either way: the way this field belongs to. Without it the field belongs to both.'),
  project: z.boolean().optional()
    .describe('Filled from a Wiro project: pass project_id instead of a value.'),
});

export type ConnectorField = z.infer<typeof connectorFieldSchema>;

export const connectorPickerSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  multiple: z.boolean(),
});

export type ConnectorPicker = z.infer<typeof connectorPickerSchema>;

export const connectorToolSchema = z.object({
  name: z.string().describe('The tool\'s name at the connector. The agent calls it as <connector>__<name>.'),
  title: z.string().optional(),
  description: z.string().optional(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
});

export type ConnectorTool = z.infer<typeof connectorToolSchema>;

export const connectorDocsSchema = z.object({
  overview: z.string().optional(),
  setup: z.array(z.string()),
  revoke: z.string().optional(),
  limits: z.string().optional(),
});

export const connectorSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  iconUrl: z.string().optional(),
  websiteUrl: z.string().optional(),
  ways: z.array(z.enum(CONNECT_WAYS))
    .describe('How it connects: key (values typed on its Connect card), sign_in (a link the user opens in their own browser), project (a Wiro project) or none.'),
  fields: z.array(connectorFieldSchema),
  accountPickers: z.array(connectorPickerSchema)
    .describe('The account choices to make once it is connected, with set_agent_connector_accounts.'),
  scopes: z.array(z.string()),
  tools: z.array(connectorToolSchema),
  docs: connectorDocsSchema.optional(),
  updatedAt: z.string().optional(),
});

export type CatalogConnector = z.infer<typeof connectorSchema>;

export const connectionSchema = z.object({
  connector: z.string(),
  title: z.string(),
  category: z.string().optional(),
  status: z.enum(CONNECTION_STATUSES)
    .describe('connected; pending (a sign-in was started and has not finished); reauth (the sign-in expired or was revoked: connect again); error (the last sign-in failed).'),
  way: z.enum(CONNECT_WAYS).optional(),
  ownApp: z.boolean().optional()
    .describe('Signed in with the user\'s own app at the service. Left out for a connection that did not sign in that way.'),
  catalogStatus: z.enum(['active', 'hidden', 'retired']).optional()
    .describe('Whether the catalog still offers the connector. A connection to a connector that is no longer active gives the agent nothing.'),
  connectedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  scope: z.string().optional(),
  accounts: z.record(z.string(), z.array(z.string()))
    .describe('The accounts chosen for each account picker, by id.'),
  projectId: z.string().optional()
    .describe('A connector that runs with a Wiro project (wiro): the agent\'s own Wiro project, which it always runs '
      + 'with. Left out when the agent has none; the connector then gives the agent nothing.'),
  savedFields: z.array(z.string()).describe('The fields that hold a saved value. Values are never shown.'),
  lastError: z.string().optional(),
});

export type AgentConnection = z.infer<typeof connectionSchema>;

type Row = Record<string, unknown>;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => asString(item)?.trim()).filter((item): item is string => Boolean(item))
    : [];
}

function text(value: unknown, max?: number): string | undefined {
  const value_ = asString(value)?.trim();
  if (!value_) return undefined;
  return max ? truncate(value_, max) : value_;
}

function toField(raw: Row, authType: string): ConnectorField | null {
  const name = text(raw.name);
  if (!name) return null;
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option) => {
      if (!isPlainObject(option)) {
        const value = asString(option);
        return value !== undefined ? [{ value }] : [];
      }
      const value = asString(option.value);
      const label = text(option.label);
      return value !== undefined ? [{ value, ...(label ? { label } : {}) }] : [];
    })
    : [];
  const description = text(raw.description, FIELD_HELP_MAX);
  const placeholder = text(raw.placeholder);
  const pattern = text(raw.pattern);
  const maxLength = toNumber(raw.maxlength);
  const mode = asString(raw.mode);
  const format = text(raw.format) ?? (raw.secret === true ? 'password' : 'text');
  return {
    name,
    label: text(raw.label) ?? name,
    ...(description ? { description } : {}),
    required: raw.required === true,
    secret: raw.secret === true || format === 'password',
    format,
    ...(options.length > 0 ? { options } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(pattern ? { pattern } : {}),
    ...(maxLength !== null && maxLength > 0 ? { maxLength: Math.trunc(maxLength) } : {}),
    ...(raw.serveronly === true ? { appKey: true } : {}),
    ...(authType === 'provider-oauth' && (mode === 'oauth' || mode === 'key') ? { mode: mode === 'oauth' ? 'sign_in' as const : 'key' as const } : {}),
    ...(raw.source === 'wiro_project' ? { project: true } : {}),
  };
}

/** How a catalog row connects, from its auth type, its fields and its ways in. */
function waysOf(authType: string, fields: ConnectorField[], modes: string[]): ConnectWay[] {
  switch (authType) {
    case 'oauth':
      return ['sign_in'];
    case 'provider-oauth':
      return modes.includes('key') ? ['sign_in', 'key'] : ['sign_in'];
    case 'headers':
    case 'fields': {
      const ways: ConnectWay[] = [];
      if (fields.some(field => !field.project)) ways.push('key');
      if (fields.some(field => field.project)) ways.push('project');
      return ways.length > 0 ? ways : ['none'];
    }
    default:
      return ['none'];
  }
}

/** One catalog row as /AgentConnector/List and Detail show it. */
export function toCatalogConnector(row: Row): CatalogConnector {
  const authType = asString(row.authtype) ?? 'none';
  const fields = (Array.isArray(row.credentialfields) ? row.credentialfields : [])
    .filter(isPlainObject)
    .map(field => toField(field, authType))
    .filter((field): field is ConnectorField => field !== null);
  const pickers = (Array.isArray(row.accountpickers) ? row.accountpickers : []).filter(isPlainObject).flatMap((picker) => {
    const key = text(picker.key);
    if (!key) return [];
    const description = text(picker.description);
    return [{ key, label: text(picker.label) ?? key, ...(description ? { description } : {}), multiple: picker.multiple === true }];
  });
  const tools = (Array.isArray(row.tools) ? row.tools : []).filter(isPlainObject).flatMap((tool) => {
    const name = text(tool.name);
    if (!name) return [];
    const title = text(tool.title);
    const description = text(tool.description, TOOL_DESCRIPTION_MAX);
    return [{
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      readOnly: tool.readonly === true,
      destructive: tool.destructive === true,
    }];
  });
  const docsRow = isPlainObject(row.docs) ? row.docs : null;
  const overview = text(docsRow?.overview);
  const revoke = text(docsRow?.revoke);
  const limits = text(docsRow?.limits);
  const setup = stringList(docsRow?.setup);
  const docs = docsRow && (overview || revoke || limits || setup.length > 0)
    ? { ...(overview ? { overview } : {}), setup, ...(revoke ? { revoke } : {}), ...(limits ? { limits } : {}) }
    : undefined;
  const slug = text(row.slug) ?? '';
  const description = text(row.description);
  const category = text(row.category);
  const iconUrl = text(row.iconurl);
  const websiteUrl = text(row.websiteurl);
  const updatedAt = unixToIso(row.updatedat);
  return {
    slug,
    title: text(row.title) ?? slug,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    ways: waysOf(authType, fields, stringList(row.modes)),
    fields,
    accountPickers: pickers,
    scopes: stringList(row.scopes),
    tools,
    ...(docs ? { docs } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** Whether a catalog row starts a sign-in on connect (with mode sign_in where it also takes a key). */
export function signsIn(connector: Pick<CatalogConnector, 'ways'>, mode?: ConnectMode): boolean {
  if (!connector.ways.includes('sign_in')) return false;
  return mode !== 'key' || !connector.ways.includes('key');
}

/** The fields a connect in this mode reads: a field of the other way is left out. */
export function fieldsForMode(connector: CatalogConnector, mode?: ConnectMode): ConnectorField[] {
  if (!connector.ways.includes('sign_in') || !connector.ways.includes('key')) return connector.fields;
  const way = mode ?? 'sign_in';
  return connector.fields.filter(field => !field.mode || field.mode === way);
}

/** One of the agent's connections as /UserAgent/ConnectorList shows it. */
export function toAgentConnection(row: Row): AgentConnection | null {
  const connector = text(row.slug);
  const status = asString(row.status);
  if (!connector || !(CONNECTION_STATUSES as readonly string[]).includes(status ?? '')) return null;
  const authType = asString(row.authtype) ?? '';
  const authMode = asString(row.authmode);
  const way: ConnectWay | undefined = authMode === 'key'
    ? 'key'
    : authMode === 'own' || authMode === 'wiro' || authType === 'oauth'
      ? 'sign_in'
      : row.wiroprojectid !== null && row.wiroprojectid !== undefined && row.wiroprojectid !== ''
        ? 'project'
        : authType === 'fields' || authType === 'headers'
          ? 'key'
          : authType === 'none' ? 'none' : undefined;
  const accounts: Record<string, string[]> = {};
  if (isPlainObject(row.accounts)) {
    for (const [key, ids] of Object.entries(row.accounts)) {
      const list = stringList(ids);
      if (list.length > 0) accounts[key] = list;
    }
  }
  const catalogStatus = asString(row.catalogstatus);
  const category = text(row.category);
  const connectedAt = unixToIso(row.connectedat);
  const updatedAt = unixToIso(row.updatedat);
  const scope = text(row.scope);
  const projectId = asString(row.wiroprojectid)?.trim();
  const lastError = text(row.lasterror, 200);
  return {
    connector,
    title: text(row.title) ?? connector,
    ...(category ? { category } : {}),
    status: status as ConnectionStatus,
    ...(way ? { way } : {}),
    ...(authMode === 'own' ? { ownApp: true } : authMode === 'wiro' ? { ownApp: false } : {}),
    ...(catalogStatus === 'active' || catalogStatus === 'hidden' || catalogStatus === 'retired' ? { catalogStatus } : {}),
    ...(connectedAt ? { connectedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(scope ? { scope } : {}),
    accounts,
    ...(projectId ? { projectId } : {}),
    savedFields: stringList(row.savedvariables),
    ...(lastError ? { lastError } : {}),
  };
}

export function toAgentConnections(list: unknown): AgentConnection[] {
  return (Array.isArray(list) ? list : [])
    .filter(isPlainObject)
    .map(toAgentConnection)
    .filter((connection): connection is AgentConnection => connection !== null);
}

type CatalogBody = ApiEnvelope & { agentconnectors?: unknown };
type ConnectionsBody = ApiEnvelope & { useragentconnectors?: unknown };

/** The active catalog, as search and category narrow it. */
export async function listCatalog(
  client: WiroClient,
  filter: { search?: string; category?: string },
  signal?: AbortSignal,
): Promise<CatalogConnector[]> {
  const body = requireApiSuccess(
    await client.post<CatalogBody>('/AgentConnector/List', {
      ...(filter.search ? { search: filter.search } : {}),
      ...(filter.category ? { category: filter.category } : {}),
    }, signal),
    'The connector catalog could not be read.',
  );
  return (Array.isArray(body.agentconnectors) ? body.agentconnectors : [])
    .filter(isPlainObject)
    .map(toCatalogConnector)
    .filter(connector => connector.slug !== '');
}

// Wiro's answer for a slug that names no active connector.
const NOT_IN_CATALOG = /^connector not found\.?$/i;

/** One active connector by its slug, or null when the catalog has none by that name. */
export async function readConnector(client: WiroClient, slug: string, signal?: AbortSignal): Promise<CatalogConnector | null> {
  if (!CONNECTOR_SLUG.test(slug)) return null;
  const response = await client.post<CatalogBody>('/AgentConnector/Detail', { slug }, signal);
  if (response?.result !== true && (response?.errors ?? []).some(item => NOT_IN_CATALOG.test(item?.message?.trim() ?? ''))) {
    return null;
  }
  const body = requireApiSuccess(response, 'The connector could not be read.');
  const row = Array.isArray(body.agentconnectors) ? body.agentconnectors.find(isPlainObject) : undefined;
  return row ? toCatalogConnector(row) : null;
}

/** The agent's connections, every status. */
export async function listConnections(client: WiroClient, agentGuid: string, signal?: AbortSignal): Promise<AgentConnection[]> {
  const body = requireApiSuccess(
    await client.post<ConnectionsBody>('/UserAgent/ConnectorList', { useragentguid: agentGuid }, signal),
    'The agent\'s connectors could not be read.',
  );
  return toAgentConnections(body.useragentconnectors);
}

export function connectionOf(connections: readonly AgentConnection[], slug: string): AgentConnection | undefined {
  return connections.find(connection => connection.connector === slug);
}

/** Whether a connection gives the agent its connector now: connected, and still offered by the catalog. */
export function isLiveConnection(connection: AgentConnection | undefined): boolean {
  return connection?.status === 'connected' && (connection.catalogStatus === undefined || connection.catalogStatus === 'active');
}

/**
 * Whether a scheduled task that names these connectors starts or stops with this one: it names it, and none of the
 * other connectors it names is connected. A task runs while any one of its connectors is connected.
 */
export function hangsOnConnector(requiresConnectors: readonly string[], slug: string, connections: readonly AgentConnection[]): boolean {
  return requiresConnectors.includes(slug)
    && !requiresConnectors.some(other => other !== slug && isLiveConnection(connectionOf(connections, other)));
}

/** A connector as a line of text: its title and its slug. Titles come from the catalog, so they are not quoted. */
export function connectorLabel(connector: { title?: string; slug?: string; connector?: string }): string {
  const slug = connector.slug ?? connector.connector ?? '';
  return connector.title && connector.title !== slug ? `${connector.title} (\`${slug}\`)` : `\`${slug}\``;
}

const WAY_WORDS: Record<ConnectWay, string> = {
  key: 'values typed on its Connect card',
  sign_in: 'a sign-in the user approves in their own browser',
  project: 'a Wiro project',
  none: 'nothing to enter',
};

/** How a connector connects, in words: "a sign-in the user approves in their own browser, or values typed on its Connect card". */
export function waysText(ways: readonly ConnectWay[]): string {
  return ways.map(way => WAY_WORDS[way]).join(', or ');
}

/** A connection's state in a few words. */
export function connectionStateText(connection: AgentConnection | undefined): string {
  if (!connection) return 'not connected';
  switch (connection.status) {
    case 'connected':
      return connection.catalogStatus && connection.catalogStatus !== 'active'
        ? `connected, but the catalog no longer offers it (${connection.catalogStatus})`
        : 'connected';
    case 'pending':
      return 'sign-in started, not finished';
    case 'reauth':
      return 'needs a new sign-in';
    default:
      return `the last sign-in failed${connection.lastError ? ` (${connection.lastError})` : ''}`;
  }
}

/** The accounts chosen on a connection, by picker: "Facebook Pages: 2 chosen". */
export function accountsText(connection: AgentConnection, pickers: readonly ConnectorPicker[] = []): string {
  const parts = Object.entries(connection.accounts).map(([key, ids]) => {
    const label = pickers.find(picker => picker.key === key)?.label ?? key;
    return `${label}: ${ids.length} chosen`;
  });
  return parts.join(', ');
}

/** A redirect address the sign-in may return the browser to: https, or http on the user's own machine. */
export function isAllowedRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Whether an error is Wiro's answer that the connector is not connected to the agent. */
export function isNotConnectedError(error: unknown): boolean {
  return error instanceof ApiResultError && /not connected to the agent/i.test(error.message);
}
