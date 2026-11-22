import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isPlainObject,
  requireApiSuccess,
  toInteger,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  agentStatusOf,
  collectStrings,
  customSkillEntries,
  holdsSecretMask,
  isAgentRunning,
  loadCredentialMeta,
  pausedSkillTitles,
  readUserAgent,
  redactSecrets,
  SECRET_MASK_TEXT,
  type CustomSkillEntry,
} from '../utils/agent-config.js';
import {
  CONNECT_MODES,
  SIGN_IN_LINK_TTL_SECONDS,
  connectionOf,
  connectionSchema,
  connectorFieldSchema,
  fieldsForMode,
  hangsOnConnector,
  isAllowedRedirectUrl,
  listConnections,
  readConnector,
  signsIn,
  toAgentConnections,
  waysText,
  withCatalogWay,
  type AgentConnection,
  type CatalogConnector,
  type ConnectMode,
  type ConnectorField,
} from '../utils/agent-connectors.js';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, pollUntil, reportProgress } from '../utils/poll.js';
import { jsonSpan } from '../utils/quoted-text.js';
import { taskLabel, taskNamedByWiro } from '../utils/user-agent.js';
import {
  agentProjectState,
  CANNOT_BIND_TEXT,
  entriesTurnedOnByProject,
  isOtherWorkspace,
  OTHER_WORKSPACE_TEXT,
  OUTSIDE_LIST_TEXT,
  projectLabel,
  projectTurnsOnNote,
  readProjects,
  type ListedProject,
} from '../utils/wiro-project.js';
import { nextActionSchema, strictInput } from './schemas.js';

// What the route takes as a project's id.
const PROJECT_ID_PATTERN = /^[1-9][0-9]{0,17}$/;

const STATES = [
  'connected',
  'authorize_in_browser',
  'waiting_for_user',
  'setup_needed',
  'confirm_needed',
  'not_connected',
  'failed',
  'reauth_needed',
] as const;

type State = typeof STATES[number];

const outputSchema = {
  action: z.enum(['connect', 'status']),
  agentGuid: z.string(),
  connector: z.string(),
  title: z.string(),
  state: z.enum(STATES),
  mode: z.enum(CONNECT_MODES).optional(),
  authorizeUrl: z.string().optional()
    .describe('The sign-in link for the user to open in their own browser. Never open it for them.'),
  expiresInSeconds: z.number().optional(),
  fields: z.array(connectorFieldSchema).optional()
    .describe('setup_needed: the values to ask the user for, with where each one comes from.'),
  missing: z.array(z.string()).optional()
    .describe('setup_needed: the names of the required values that are missing.'),
  project: z.object({ id: z.string().optional(), name: z.string().optional() }).optional()
    .describe('A connector that runs with a Wiro project (the wiro connector): the project connecting it binds to the '
      + 'agent as its own Wiro project, which the agent\'s video and voice skills use too.'),
  replacesProject: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    outsideList: z.boolean().optional().describe('The agent holds a project outside this connection\'s list or a key saved earlier.'),
  }).optional()
    .describe('The agent\'s Wiro project now, which the connect replaces. Left out when it has none, or when it is the same project.'),
  connection: connectionSchema.optional(),
  applied: z.number().int().nonnegative().optional()
    .describe('1 when the saved connection changed, 0 when it already held this.'),
  restart: z.enum(['scheduled', 'none', 'failed']).optional()
    .describe('scheduled: a running agent restarts to load the connector. none: nothing to load, or the agent is not running. failed: it is saved, but a running agent needs control_agent restart.'),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type ConnectBody = ApiEnvelope & {
  status?: unknown;
  authorizeUrl?: unknown;
  applied?: unknown;
  restart?: unknown;
  useragentconnectors?: unknown;
};

type Values = Record<string, unknown>;

type Accounts = Record<string, string[]>;

interface Context {
  client: WiroClient;
  agentGuid: string;
  connector: CatalogConnector;
  signal: AbortSignal;
}

function result(
  action: 'connect' | 'status',
  context: Context,
  state: State,
  message: string,
  extra: Record<string, unknown> = {},
  textExtra: string[] = [],
) {
  const lines = [`## ${context.connector.title}: ${state.replace(/_/g, ' ')}`, '', message, ...textExtra];
  if (isPlainObject(extra.nextAction)) {
    lines.push('', `Next: call ${String(extra.nextAction.tool)} with ${jsonSpan(extra.nextAction.arguments)}.`);
  }
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      action,
      agentGuid: context.agentGuid,
      connector: context.connector.slug,
      title: context.connector.title,
      state,
      message,
      ...extra,
    },
  };
}

/** Whether a value fills a field: an empty text or null clears it instead. */
function fills(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/** A JSON object or list sent as its text, such as a service account file, or undefined for any other text. */
function jsonInText(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Every value sent, to hide from an error text that quotes one back: each string of 8 or more characters at any
 * depth (short values such as select options and flags are not secrets and would garble messages), as it is and
 * as JSON writes it, and the whole JSON text of a JSON value. A JSON field sent as its text counts at every depth
 * too, so a service's refusal that quotes one key of a service account file shows none of it.
 */
function secretsIn(values: Values): string[] {
  const strings: string[] = [];
  const secrets: string[] = [];
  for (const value of Object.values(values)) {
    collectStrings(value, strings);
    if (isPlainObject(value) || Array.isArray(value)) secrets.push(JSON.stringify(value));
    else if (typeof value === 'string') collectStrings(jsonInText(value), strings);
  }
  for (const text of strings) secrets.push(text, JSON.stringify(text).slice(1, -1));
  return [...new Set(secrets.map(secret => secret.trim()).filter(secret => secret.length >= 8))];
}

/**
 * Why accounts sent with a connect are refused, or null. A connector with account choices takes only their keys, and
 * a single choice one id. Another connector's account keys are its setup steps' to name, so Wiro checks them.
 */
function accountsRefusal(connector: CatalogConnector, accounts: Accounts): string | null {
  if (connector.accountPickers.length === 0) return null;
  const unknown = Object.keys(accounts).filter(key => !connector.accountPickers.some(picker => picker.key === key));
  if (unknown.length > 0) {
    return `${connector.title} has no account choice ${unknown.map(key => `"${key}"`).join(', ')}. Its choices: `
      + `${connector.accountPickers.map(picker => `"${picker.key}" (${picker.label})`).join(', ')}. Nothing was sent.`;
  }
  const single = connector.accountPickers.find(picker => !picker.multiple && (accounts[picker.key]?.length ?? 0) > 1);
  return single ? `${single.label} takes one account. Nothing was sent.` : null;
}

/** A connector's account choices by label: "Advertisers", "Facebook Pages and Instagram accounts". */
function pickerLabels(connector: CatalogConnector): string {
  return connector.accountPickers.map(picker => picker.label).join(' and ');
}

function fieldNeedLines(fields: ConnectorField[]): string[] {
  return fields.flatMap((field) => {
    const lines = [`- **${field.label}** (\`${field.name}\`${field.secret ? ', secret' : ''}${field.appKey ? ', a key of the user\'s own app' : ''})`];
    if (field.description) lines.push(...field.description.split(/\r?\n/).map(line => `  ${line}`));
    return lines;
  });
}

/**
 * What the agent says about a new connection: the scheduled tasks that are on and start running with this
 * connector, as people see them, and whether it runs. A task runs while any one of its connectors is connected, so
 * one that can use another connector of `connections` that is connected already runs and is left out. `read` is the
 * agent as read just before the connect, when it was; otherwise it is read now. Nothing when the agent cannot be read.
 */
async function agentAfterConnect(
  context: Context,
  connections: readonly AgentConnection[],
  read?: Record<string, unknown>,
): Promise<{ tasks: string[]; running: boolean }> {
  try {
    const row = read ?? await readUserAgent(context.client, context.agentGuid, context.signal);
    return {
      tasks: customSkillEntries(row)
        .filter(entry => entry.kind === 'scheduled_task' && entry.enabled && !entry.notWritten && !entry.skillOff
          && hangsOnConnector(entry.requiresConnectors, context.connector.slug, connections))
        .map(entry => taskLabel(entry.key, taskNamedByWiro(entry))),
      running: isAgentRunning(agentStatusOf(row)),
    };
  } catch {
    return { tasks: [], running: false };
  }
}

function restartOf(value: unknown): 'scheduled' | 'none' | 'failed' | undefined {
  const restart = asString(value);
  return restart === 'scheduled' || restart === 'none' || restart === 'failed' ? restart : undefined;
}

function restartText(restart: 'scheduled' | 'none' | 'failed' | undefined, applied: number): string {
  if (applied === 0) return 'It already held this, so the agent does not restart.';
  switch (restart) {
    case 'scheduled':
      return 'A running agent restarts to load it, which takes about a minute.';
    case 'failed':
      return 'It is saved, but the running agent could not be restarted: control_agent with action restart loads it.';
    default:
      return 'The agent loads it the next time it starts.';
  }
}

type ProjectView = { id?: string; name?: string };

/**
 * What connecting a connector that runs with a Wiro project does to the agent's project. The connector always uses
 * the agent's own Wiro project, so Wiro binds the project the connect names (or this connection's own) to the agent,
 * as bind_agent_project does, with what that turns on.
 */
interface ProjectPlan {
  /** The project it binds: the one asked for, or this connection's own. */
  project: ProjectView;
  /** The agent's project now, which it replaces; undefined when it has none or it is the same, or it could not be read. */
  replaces?: ProjectView & { outsideList?: boolean };
  /** The agent holds this project already. */
  already: boolean;
  /** The agent as read for this plan, before the connect; undefined when it could not be read. */
  row?: Record<string, unknown>;
  /** The custom skills and scheduled tasks the new project turns on (entriesTurnedOnByProject). */
  turnsOn: CustomSkillEntry[];
  /** The titles of the skills a paused one of them still waits for. */
  titles: Map<string, string>;
}

function viewOf(project: ListedProject): ProjectView {
  return { id: project.view.id, name: project.view.name };
}

/**
 * The project a connect would bind, the one it replaces and what the bind turns on, read afresh for the preview and
 * for the confirm. A project Wiro would refuse to bind is refused here first, with bind_agent_project's sentences: an
 * agent in another workspace, or a listed project this connection cannot bind. Reads that fail only leave out what
 * they would show; Wiro still checks the connect.
 */
async function projectPlan(context: Context, projectId: string | undefined): Promise<ProjectPlan> {
  let projects: ListedProject[];
  try {
    projects = await readProjects(context.client, context.signal);
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { project: projectId !== undefined ? { id: projectId } : {}, already: false, turnsOn: [], titles: new Map() };
  }
  let row: Record<string, unknown> | undefined;
  try {
    row = await readUserAgent(context.client, context.agentGuid, context.signal);
  } catch (error) {
    if (context.signal.aborted) throw error;
  }
  if (row && isOtherWorkspace(row, projects)) throw new Error(OTHER_WORKSPACE_TEXT);
  const target = projectId !== undefined
    ? projects.find(item => item.view.id === projectId)
    : projects.find(item => item.view.connected);
  if (projectId !== undefined && !target) {
    throw new Error(`No project with the id ${projectId} is in this connection's workspace, and nothing was changed. list_projects shows the projects you can choose.`);
  }
  if (target && !target.view.canBind) throw new Error(CANNOT_BIND_TEXT);
  const project = target ? viewOf(target) : {};
  if (!row) return { project, already: false, turnsOn: [], titles: new Map() };
  const { current, outsideList, holdsConnectionKey } = agentProjectState(row, projects, context.client);
  const already = target ? target === current : holdsConnectionKey;
  if (already) return { project, already: true, row, turnsOn: [], titles: new Map() };
  // Binding the project writes the agent's Wiro key, which turns on what requires the project, as a bind does.
  const turnsOn = entriesTurnedOnByProject(row, current !== null || outsideList || holdsConnectionKey);
  const titles = await pausedSkillTitles(context.client, turnsOn, context.signal);
  const replaces = current ? viewOf(current) : outsideList ? { outsideList: true } : undefined;
  return { project, ...(replaces ? { replaces } : {}), already: false, row, turnsOn, titles };
}

/** What a connect with a Wiro project does, said before the user's yes. */
function projectPreviewText(title: string, plan: ProjectPlan): string {
  const label = projectLabel(plan.project);
  const binds = plan.already
    ? `${title} runs with the agent's own Wiro project, ${label}, which stays as it is.`
    : `${title} runs with the agent's own Wiro project: connecting it makes ${label} that project, as bind_agent_project `
      + 'does, so the agent\'s video and voice skills use it too.';
  const replaces = plan.replaces
    ? ` It replaces ${plan.replaces.outsideList ? OUTSIDE_LIST_TEXT : projectLabel(plan.replaces)}, the agent's project now.`
    : '';
  const turnsOn = projectTurnsOnNote(plan.turnsOn, 'once', plan.titles);
  return `${binds}${replaces} Model runs through it are billed to the wallet of the workspace that owns that project, `
    + `and the agent's spend limits and Model Access rules apply to them.${turnsOn ? ` ${turnsOn}` : ''}`;
}

async function connect(
  context: Context,
  input: { values?: Values; mode?: ConnectMode; projectId?: string; redirectUrl?: string; accounts?: Accounts; confirm: boolean },
) {
  const { client, agentGuid, connector, signal } = context;
  const hybrid = connector.ways.includes('sign_in') && connector.ways.includes('key');
  if (input.mode && !hybrid) {
    return errorResult(new Error(`${connector.title} connects only with ${waysText(connector.ways)}, so it takes no mode. Leave mode out.`));
  }
  const takesProject = connector.fields.some(field => field.project);
  if (input.projectId !== undefined && !takesProject) {
    return errorResult(new Error(`${connector.title} takes no Wiro project. Leave project_id out.`));
  }
  if (input.redirectUrl !== undefined && !isAllowedRedirectUrl(input.redirectUrl.trim())) {
    return errorResult(new Error('redirect_url must be an https address, or http://localhost or http://127.0.0.1 on the user\'s own machine. Leave it out to use Wiro\'s own page. Nothing was sent.'));
  }
  const fields = fieldsForMode(connector, input.mode);
  const values: Values = {};
  const unknown: string[] = [];
  for (const [rawName, value] of Object.entries(input.values ?? {})) {
    const name = rawName.trim();
    const field = connector.fields.find(candidate => candidate.name === name);
    if (!field || field.project) {
      unknown.push(name);
      continue;
    }
    if (!fields.includes(field)) {
      return errorResult(new Error(`${field.label} (${name}) belongs to mode ${field.mode}, not mode ${input.mode ?? 'sign_in'}. Nothing was sent.`));
    }
    values[name] = value;
  }
  if (unknown.length > 0) {
    const names = fields.filter(field => !field.project).map(field => field.name);
    return errorResult(new Error(`Unknown value${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}. `
      + `${connector.title} takes ${names.length > 0 ? names.map(name => `"${name}"`).join(', ') : 'no values'}`
      + `${takesProject ? ', and project_id for its Wiro project' : ''}. Nothing was sent.`));
  }
  const secrets = secretsIn(values);
  const masked = Object.entries(values).filter(([, value]) => holdsSecretMask(value)).map(([name]) => name);
  if (masked.length > 0) {
    return errorResult(new Error(`${masked.join(', ')} ${masked.length > 1 ? 'hold' : 'holds'} ${SECRET_MASK_TEXT}. Send the value itself. Nothing was sent.`));
  }
  const accounts = input.accounts && Object.keys(input.accounts).length > 0 ? input.accounts : undefined;
  const accountRefusal = accounts ? accountsRefusal(connector, accounts) : null;
  if (accountRefusal) return errorResult(new Error(accountRefusal));

  const connections = await listConnections(client, agentGuid, signal);
  const listed = connectionOf(connections, connector.slug);
  const existing = listed ? withCatalogWay(listed, connector) : undefined;
  const saved = new Set(existing?.savedFields ?? []);
  const missing = fields.filter(field => field.required && !field.project
    && (Object.hasOwn(values, field.name) ? !fills(values[field.name]) : !saved.has(field.name)));
  const mode = hybrid ? input.mode ?? 'sign_in' : undefined;
  const signIn = signsIn(connector, input.mode);
  if (missing.length > 0) {
    const appKeys = missing.some(field => field.appKey);
    return result('connect', context, 'setup_needed',
      `${connector.title} needs ${missing.map(field => field.label).join(', ')} first.`
        + `${appKeys ? ' The sign-in uses the user\'s own app at the service, so its keys come with the connect call.' : ''}`
        + ' Ask the user for them, then call connect_agent_connector again with them in values. Never put them in a message to an agent. Nothing was sent.',
      {
        ...(mode ? { mode } : {}),
        fields: fields.filter(field => !field.project),
        missing: missing.map(field => field.name),
        ...(existing ? { connection: existing } : {}),
        nextAction: {
          tool: 'connect_agent_connector',
          arguments: {
            action: 'connect',
            agent_guid: agentGuid,
            connector: connector.slug,
            ...(input.mode ? { mode: input.mode } : {}),
            ...(accounts ? { accounts } : {}),
          },
          reason: `Call it again with values for ${missing.map(field => field.name).join(', ')} once the user gives them.`,
        },
      },
      ['', ...fieldNeedLines(missing)]);
  }

  const connectedNow = existing?.status === 'connected';
  const previewing = !input.confirm && (takesProject || connectedNow);
  const plan = takesProject ? await projectPlan(context, input.projectId) : undefined;
  const project = plan?.project;
  if (previewing) {
    const typedValues = connector.fields.some(field => !field.project);
    const replace = connectedNow
      ? `${connector.title} is already connected${existing?.connectedAt ? ` (since ${existing.connectedAt})` : ''}. Connecting again replaces that connection${signIn ? ' once the new sign-in is approved; until then the current one keeps working' : typedValues ? ' and its saved values' : ''}.`
      : '';
    const pays = plan ? projectPreviewText(connector.title, plan) : '';
    const sendAgain = Object.keys(values).length > 0 ? ' Repeat the call with confirm: true and the same values.' : '';
    return result('connect', context, 'confirm_needed',
      `${[replace, pays].filter(Boolean).join(' ')} Nothing has changed yet. Ask the user to confirm.${sendAgain}`,
      {
        ...(mode ? { mode } : {}),
        ...(project ? { project } : {}),
        ...(plan?.replaces ? { replacesProject: plan.replaces } : {}),
        ...(existing ? { connection: existing } : {}),
        nextAction: {
          tool: 'connect_agent_connector',
          arguments: {
            action: 'connect',
            agent_guid: agentGuid,
            connector: connector.slug,
            ...(input.mode ? { mode: input.mode } : {}),
            ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
            ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
            ...(accounts ? { accounts } : {}),
            confirm: true,
          },
          reason: `Ask the user to confirm this first.${sendAgain ? ' Add the same values again: they are never repeated here.' : ''}`,
        },
      });
  }

  let body: ConnectBody;
  try {
    body = requireApiSuccess(
      await client.post<ConnectBody>('/UserAgent/ConnectorConnect', {
        useragentguid: agentGuid,
        slug: connector.slug,
        ...(Object.keys(values).length > 0 ? { values } : {}),
        ...(hybrid && input.mode ? { mode: input.mode === 'key' ? 'key' : 'oauth' } : {}),
        ...(input.projectId !== undefined ? { wiroprojectguid: input.projectId } : {}),
        ...(input.redirectUrl ? { redirecturl: input.redirectUrl.trim() } : {}),
        ...(accounts ? { accounts } : {}),
      }, signal),
      `${connector.title} could not be connected.`,
    );
  } catch (error) {
    return errorResult(new Error(redactSecrets(`${errorText(error)} Nothing was saved.`, secrets)));
  }

  const authorizeUrl = asString(body.authorizeUrl);
  if (authorizeUrl) {
    const ownApp = connector.fields.some(field => field.appKey);
    const consent = ownApp
      ? 'Its consent page shows the user\'s own app.'
      : 'Its consent page names the agent\'s owner: its organization, team or account.';
    const after = input.redirectUrl
      ? `After approving, the browser goes to ${input.redirectUrl.trim()}.`
      : 'After approving, the browser lands on a page that says how it went.';
    // A sign-in with account choices acts only on the accounts chosen, and they are listed once it finishes.
    const accountsLater = accounts
      ? ' The accounts given are saved with the connection once the sign-in finishes.'
      : connector.accountPickers.length > 0
        ? ` Once it finishes, choose the ${pickerLabels(connector)} it may act on: set_agent_connector_accounts lists the ones the sign-in reaches.`
        : '';
    return result('connect', context, 'authorize_in_browser',
      `The user must open this link in their own browser and approve access within ${SIGN_IN_LINK_TTL_SECONDS / 60} minutes. Never open it for them. ${consent} `
        + `${after}${accountsLater} Give the link to the user and check the status once they say they are done.`,
      {
        ...(mode ? { mode } : {}),
        authorizeUrl,
        expiresInSeconds: SIGN_IN_LINK_TTL_SECONDS,
        ...(existing ? { connection: existing } : {}),
        nextAction: {
          tool: 'connect_agent_connector',
          arguments: {
            action: 'status',
            agent_guid: agentGuid,
            connector: connector.slug,
            since_connected_at: connectedNow ? existing?.connectedAt ?? '' : '',
            wait_seconds: DEFAULT_WAIT_SECONDS,
          },
          reason: 'After the user has approved access, check that the connection finished.',
        },
      },
      ['', authorizeUrl]);
  }

  const answered = toAgentConnections(body.useragentconnectors)[0];
  const connection = answered ? withCatalogWay(answered, connector) : undefined;
  const applied = toInteger(body.applied, 1);
  const restart = restartOf(body.restart);
  const { tasks } = await agentAfterConnect(context, connections, plan?.row);
  const unpicked = connector.accountPickers.filter(picker => !connection?.accounts[picker.key]?.length);
  const message = [
    `${connector.title} is connected${accounts ? ' with the accounts given' : ''}.`,
    restartText(restart, applied),
    tasks.length > 0 ? `Scheduled tasks that need it run once it is loaded: ${tasks.join(', ')}. Every run uses the agent's credits.` : '',
    unpicked.length > 0 ? `Choose the ${unpicked.map(picker => picker.label).join(' and ')} it may act on with set_agent_connector_accounts.` : '',
    project
      ? `The agent's own Wiro project is now ${projectLabel(project)}: its model tools and its video and voice skills run `
        + 'models with it, billed to the wallet of the workspace that owns it.'
      : '',
    // What the project's key turned on, as the preview named it; a connect that changed nothing turned nothing on.
    plan && applied !== 0 ? projectTurnsOnNote(plan.turnsOn, 'now that', plan.titles) ?? '' : '',
  ].filter(Boolean).join(' ');
  return result('connect', context, 'connected', message, {
    ...(mode ? { mode } : {}),
    ...(project ? { project } : {}),
    ...(connection ? { connection } : {}),
    applied,
    ...(restart ? { restart } : {}),
    ...(unpicked.length > 0
      ? {
        nextAction: {
          tool: 'set_agent_connector_accounts',
          arguments: { agent_guid: agentGuid, connector: connector.slug },
          reason: `List the ${unpicked.map(picker => picker.label).join(' and ')} to choose from.`,
        },
      }
      : {}),
  });
}

/** Wiro's code for a sign-in that failed, in words. */
function failureText(code: string | undefined): string {
  switch (code) {
    case 'authorization_denied':
      return 'the user did not approve access at the service';
    case 'token_exchange_failed':
      return 'the service did not hand over access after the approval';
    case 'oauth_app_missing':
    case 'oauth_app_changed':
      return 'the app keys the sign-in started with are missing or changed';
    case 'connector_unavailable':
      return 'the catalog no longer offers the connector';
    default:
      return code ? `the sign-in failed (${code})` : 'the sign-in failed';
  }
}

function isNewer(connection: AgentConnection, since: string | undefined): boolean {
  if (!since) return true;
  const at = connection.connectedAt ? Date.parse(connection.connectedAt) : NaN;
  const before = Date.parse(since);
  return Number.isNaN(before) || (!Number.isNaN(at) && at > before);
}

function stateOf(connection: AgentConnection | undefined, since: string | undefined): State {
  if (!connection) return 'not_connected';
  switch (connection.status) {
    case 'connected':
      return isNewer(connection, since) ? 'connected' : 'waiting_for_user';
    case 'pending':
      return 'waiting_for_user';
    case 'reauth':
      return 'reauth_needed';
    default:
      return 'failed';
  }
}

async function status(
  context: Context,
  input: { since?: string; waitSeconds: number },
  extra: Parameters<typeof reportProgress>[0],
) {
  const { client, agentGuid, connector, signal } = context;
  const polled = await pollUntil({
    read: readSignal => listConnections(client, agentGuid, readSignal),
    isDone: list => stateOf(connectionOf(list, connector.slug), input.since) !== 'waiting_for_user',
    timeoutMs: input.waitSeconds * 1000,
    signal,
    interval: () => 5_000,
    onPoll: (list, elapsedMs) => reportProgress(extra, elapsedMs, `${connector.title}: ${stateOf(connectionOf(list, connector.slug), input.since)}`),
  });
  if (!polled.value) throw new Error(`Could not read the ${connector.title} connection.`);
  const found = connectionOf(polled.value, connector.slug);
  const connection = found ? withCatalogWay(found, connector) : undefined;
  const state = stateOf(connection, input.since);
  const connectAgain = {
    tool: 'connect_agent_connector',
    arguments: { action: 'connect', agent_guid: agentGuid, connector: connector.slug },
    reason: `Connect ${connector.title} again.`,
  };
  const extraFields = connection ? { connection } : {};
  switch (state) {
    case 'connected': {
      const unpicked = connector.accountPickers.filter(picker => !connection?.accounts[picker.key]?.length);
      const { tasks, running } = await agentAfterConnect(context, polled.value);
      return result('status', context, state, [
        `${connector.title} is connected${connection?.connectedAt ? ` (since ${connection.connectedAt})` : ''}.`,
        running ? 'The running agent restarts to load it, which takes about a minute.' : '',
        tasks.length > 0 ? `Scheduled tasks that need it run once it is loaded: ${tasks.join(', ')}.` : '',
        unpicked.length > 0 ? `Choose the ${unpicked.map(picker => picker.label).join(' and ')} it may act on with set_agent_connector_accounts.` : '',
      ].filter(Boolean).join(' '), {
        ...extraFields,
        ...(unpicked.length > 0
          ? {
            nextAction: {
              tool: 'set_agent_connector_accounts',
              arguments: { agent_guid: agentGuid, connector: connector.slug },
              reason: `List the ${unpicked.map(picker => picker.label).join(' and ')} to choose from.`,
            },
          }
          : {}),
      });
    }
    case 'waiting_for_user':
      return result('status', context, state,
        `The ${connector.title} sign-in has not finished yet. The link from connect works for ${SIGN_IN_LINK_TTL_SECONDS / 60} minutes; after that, connect again. If the user saw an error page, connect again.`,
        {
          ...extraFields,
          nextAction: {
            tool: 'connect_agent_connector',
            arguments: {
              action: 'status',
              agent_guid: agentGuid,
              connector: connector.slug,
              ...(input.since !== undefined ? { since_connected_at: input.since } : {}),
              wait_seconds: DEFAULT_WAIT_SECONDS,
            },
            reason: 'Keep waiting for the user to finish signing in.',
          },
        });
    case 'failed':
      return result('status', context, state,
        `The latest ${connector.title} sign-in did not finish: ${failureText(connection?.lastError)}. Connect again with action connect.`,
        { ...extraFields, nextAction: connectAgain });
    case 'reauth_needed':
      return result('status', context, state,
        `The ${connector.title} sign-in expired or was revoked, so the agent cannot use it. Connect again with action connect.`,
        { ...extraFields, nextAction: connectAgain });
    default:
      return result('status', context, state, `${connector.title} is not connected to this agent. Start with action connect.`,
        { nextAction: connectAgain });
  }
}

export function registerConnectAgentConnector(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'connect_agent_connector',
    {
      title: 'Connect an agent connector',
      description: 'Connect a Connector (an outside service from list_agent_connectors) to a deployed agent, which '
        + 'then gets its tools. action connect: a connector that takes a key saves the values in values and connects '
        + 'at once; the result never shows them again. A sign-in connector returns a link that the user must open in '
        + 'their own browser and approve within 10 minutes; never open it for them. A sign-in with the service\'s own '
        + 'OAuth uses the user\'s own app there: its keys (such as a client id and secret) go in values with the same '
        + 'call. A connector that offers both takes mode sign_in or key. The wiro connector runs with a Wiro project and '
        + 'gives the agent only Wiro\'s model, task and file upload tools, plus read-only docs search and playbooks: '
        + 'connecting it takes project_id from list_projects (or the project of this connection) and makes that project '
        + 'the agent\'s own Wiro project, as bind_agent_project does, so its calls count as the agent\'s own (its spend '
        + 'limits and Model Access rules apply, and account, agent and billing calls are refused). It first shows the '
        + 'project, what it replaces, which wallet pays and the scheduled tasks and custom skills the project turns on. '
        + 'A call with required values missing sends nothing and lists what to ask for, with where each value comes '
        + 'from. action status: whether the sign-in finished (wait_seconds waits for the user). Connecting a connector '
        + 'that is connected now replaces that connection, and a connector that runs with a Wiro project always shows '
        + 'its project first: both take confirm: true after the user agreed. A running agent restarts to load a new '
        + 'connection. Where a connector has account choices, such as the advertisers a TikTok Ads sign-in reaches, '
        + 'set_agent_connector_accounts lists and saves the accounts it may act on once it is connected; accounts '
        + 'saves ids the user already knows with this call. disconnect_agent_connector removes a connection. The person '
        + 'who deployed the agent or a team admin of its team can connect. Keys go only in values, never in a message '
        + 'to an agent.',
      inputSchema: strictInput({
        action: z.enum(['connect', 'status']).default('connect')
          .describe('connect (default) connects or starts the sign-in, status checks a sign-in.'),
        agent_guid: z.string().min(1).max(100).describe('The deployed agent\'s guid, from list_my_agents.'),
        connector: z.string().min(1).max(100).describe('The connector\'s slug, from list_agent_connectors, such as "serper" or "google-ads".'),
        values: z.record(z.string(), z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          z.array(z.unknown()),
          z.record(z.string(), z.unknown()),
        ])).optional()
          .describe('connect: the Connect card\'s values by field name, as list_agent_connectors shows them, for example {"apikey": "..."}. A json field takes the JSON value or its text. Values saved before are kept unless sent again; null or "" clears an optional one. Never echoed back.'),
        mode: z.enum(CONNECT_MODES).optional()
          .describe('connect, for a connector that connects either way: sign_in (the default) or key.'),
        project_id: z.string()
          .regex(PROJECT_ID_PATTERN, 'project_id must be the id of a project from list_projects, such as "12345". Nothing was sent.')
          .optional()
          .describe('connect, for a connector that runs with a Wiro project (wiro): the project\'s id from list_projects, which becomes the agent\'s own Wiro project. Leave it out for the project of this connection.'),
        accounts: z.record(z.string().min(1).max(40), z.array(z.string().min(1).max(200)).max(500)).optional()
          .describe('connect: the accounts the connection may act on, {account key: [ids]}, saved with it as given; a '
            + 'sign-in saves them once it finishes. Use it for ids the user already knows, such as TikTok Ads advertiser '
            + 'ids under "advertisers", or where the connector\'s setup steps name an account key. Otherwise choose them '
            + 'once connected with set_agent_connector_accounts, which lists the accounts the connection reaches and takes '
            + 'only those. A connector with account choices takes only their keys. Leave it out to keep the accounts '
            + 'saved before.'),
        redirect_url: z.string().max(2_048).optional()
          .describe('connect, for a sign-in: where the browser goes after approving, an https address or a local one on the user\'s own machine (http://localhost or http://127.0.0.1). Leave it out for Wiro\'s own page, which says how it went.'),
        since_connected_at: z.string().max(64).optional()
          .describe('status: the since_connected_at value from connect\'s nextAction, so the connection from before is not taken for the new one.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0)
          .describe(`status: how long to wait for the sign-in to finish, 0 to ${MAX_WAIT_SECONDS} seconds (default 0, a single check).`),
        confirm: z.boolean().default(false)
          .describe('connect: true to replace a working connection, or to connect a connector that runs with a Wiro project (it binds the project to the agent), after the user agreed.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        const slug = args.connector.trim().toLowerCase();
        const agentGuid = args.agent_guid.trim();
        const connector = await readConnector(client, slug, extra.signal);
        if (!connector) {
          const credential = await loadCredentialMeta(client, slug, extra.signal).catch(() => null);
          return errorResult(new Error(credential && !slug.startsWith('sys-')
            ? `${credential.title} is ${credential.channel ? 'a chat channel' : 'a credential of the agent'}, not a connector. Save its fields with set_agent_credentials (call it with credential "${slug}" to see them).`
            : `No connector is named "${slug}". list_agent_connectors lists them.`));
        }
        const context: Context = { client, agentGuid, connector, signal: extra.signal };
        if (args.action === 'status') {
          return await status(context, { since: args.since_connected_at, waitSeconds: args.wait_seconds }, extra);
        }
        return await connect(context, {
          values: args.values,
          mode: args.mode,
          projectId: args.project_id,
          redirectUrl: args.redirect_url,
          accounts: args.accounts,
          confirm: args.confirm,
        });
      } catch (error) {
        return errorResult(new Error(redactSecrets(errorText(error), secretsIn(args.values ?? {}))));
      }
    },
  );
}
