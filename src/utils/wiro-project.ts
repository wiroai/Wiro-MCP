import type { WiroClient } from '../client.js';
import { asString, errorText, isPlainObject, requireApiSuccess, type ApiEnvelope } from './api.js';
import {
  credentialGroup,
  customSkillEntries,
  isFilledValue,
  keyList,
  WORKSPACE_HINT,
  type CustomSkillEntry,
} from './agent-config.js';
import {
  connectorLabel,
  isLiveConnection,
  listConnections,
  readConnector,
  type AgentConnection,
} from './agent-connectors.js';
import { quotedSpan } from './quoted-text.js';
import { AGENT_AI_USAGE, skillOffTasksNote, taskLabel, taskNamedByWiro, WIRO_PROJECT_CREDENTIAL } from './user-agent.js';

// The Wiro projects of the connected project's workspace. What tools show of a
// project is built field by field: no key and no address on its IP list is ever
// part of it, and a key is only compared here, in memory.

/** Project/List gives at most this many projects, the newest first. */
export const PROJECT_LIST_LIMIT = 100;

/** What a tool may show of a project. */
export interface ProjectView {
  id: string;
  name: string;
  authMethod?: string;
  /** This connection's own project. */
  connected: boolean;
  /** Whether this connection can connect the project to an agent. */
  canBind: boolean;
  /** Whether the project accepts requests only from the addresses on its IP list. */
  ipRestricted?: boolean;
}

export interface ListedProject {
  view: ProjectView;
  /** The workspace it belongs to: a team's guid, or '' for a personal project. Undefined when the row does not say. */
  workspace?: string;
  /** The user id of the person who created it, whom its key acts as. Never shown on its own. */
  creator?: string;
  /** Whether a value is this project's key. */
  hasKey(value: unknown): boolean;
}

function toListedProject(row: Record<string, unknown>, id: string, client: WiroClient): ListedProject {
  const key = typeof row.apikey === 'string' && row.apikey.trim() !== '' ? row.apikey : undefined;
  const authMethod = asString(row.authmethod);
  return {
    view: {
      id,
      name: asString(row.name) ?? '',
      ...(authMethod ? { authMethod } : {}),
      connected: client.isOwnApiKey(row.apikey),
      canBind: key !== undefined,
      // A list without "*" lets in only its own addresses, and an empty one none.
      ...(Array.isArray(row.ipwhitelist) ? { ipRestricted: !row.ipwhitelist.includes('*') } : {}),
    },
    ...('teamguid' in row ? { workspace: asString(row.teamguid) ?? '' } : {}),
    ...(asString(row.uuid)?.trim() ? { creator: (asString(row.uuid) as string).trim() } : {}),
    hasKey: value => key !== undefined && value === key,
  };
}

/** An error's text, or a fixed sentence when it may hold a raw answer. */
export function keySafeErrorText(error: unknown): string {
  const text = errorText(error);
  return /^Invalid JSON response|[{[]\s*"|api_?key|api_?secret|ipwhitelist/i.test(text) ? 'The answer could not be read.' : text;
}

/** The projects of the connected project's workspace, newest first. Throws when they cannot be read. */
export async function readProjects(client: WiroClient, signal?: AbortSignal): Promise<ListedProject[]> {
  const body = requireApiSuccess(
    await client.post<ApiEnvelope & { project?: unknown }>('/Project/List', {}, signal),
    'Wiro did not return them.',
  );
  const rows = Array.isArray(body.project) ? body.project.filter(isPlainObject) : [];
  return rows.flatMap(row => {
    const id = asString(row.id);
    return id ? [toListedProject(row, id, client)] : [];
  });
}

export interface AgentProjectState {
  /** The listed project the agent uses. */
  current: ListedProject | null;
  /** The agent holds a project key, and it is none of the listed projects'. */
  outsideList: boolean;
  /** The agent holds this connection's own key, listed or not. */
  holdsConnectionKey: boolean;
}

/** Which project an agent's saved value belongs to, as far as this connection can see. */
export function agentProjectState(row: Record<string, unknown>, projects: ListedProject[], client: WiroClient): AgentProjectState {
  const group = credentialGroup(row, WIRO_PROJECT_CREDENTIAL);
  const saved = group?.apikey;
  const current = projects.find(project => project.hasKey(saved)) ?? null;
  const holdsConnectionKey = client.isOwnApiKey(saved);
  return {
    current,
    outsideList: !current && !holdsConnectionKey && (group?._filled === true || isFilledValue(saved)),
    holdsConnectionKey,
  };
}

/** Whether the listed projects are in another workspace than the agent, so none of them can be connected to it. */
export function isOtherWorkspace(row: Record<string, unknown>, projects: ListedProject[]): boolean {
  const agentWorkspace = asString(row.teamguid) ?? '';
  return projects.some(project => project.workspace !== undefined && project.workspace !== agentWorkspace);
}

/** The answer for an agent in another workspace than this connection's projects (isOtherWorkspace). */
export const OTHER_WORKSPACE_TEXT = `This agent is in another workspace than this connection's project, and nothing was changed. ${WORKSPACE_HINT}`;

/** The answer for a listed project this connection cannot make an agent's project (canBind false). */
export const CANNOT_BIND_TEXT = 'You can bind a project you created, or any project of a team you are an admin of. Nothing '
  + 'was changed. list_projects shows which ones.';

/**
 * The custom skills and scheduled tasks a new Wiro project turns on. Saving the agent's project sets every one that
 * requires it to on: with a first project that is all of them, and with a new project the ones that are off now.
 */
export function entriesTurnedOnByProject(row: Record<string, unknown>, replacing: boolean): CustomSkillEntry[] {
  return customSkillEntries(row).filter(entry => entry.requiresCredentials.includes(WIRO_PROJECT_CREDENTIAL)
    && (!replacing || !entry.enabled));
}

/**
 * Those entries as a sentence, said before ("once") or after ("now that") the project is connected. A paused task is
 * named with the skills it still waits for, by their titles. Null when none turns on.
 */
export function projectTurnsOnNote(
  entries: readonly CustomSkillEntry[],
  when: 'once' | 'now that',
  titles?: ReadonlyMap<string, string>,
): string | null {
  if (entries.length === 0) return null;
  const sentence = `${keyList(entries.map(entry => taskLabel(entry.key, taskNamedByWiro(entry))))} ${entries.length > 1 ? 'turn' : 'turns'} on ${when} the project is connected.${skillOffTasksNote(entries, titles)}`;
  return entries.some(entry => entry.kind === 'scheduled_task')
    ? `${sentence} Every run of a scheduled task uses ${AGENT_AI_USAGE}; turn off any you do not want with manage_agent_custom_skill.`
    : sentence;
}

/**
 * The agent's live connections to a connector that runs with its Wiro project (the wiro connector), whose tools a new
 * project moves to it. ConnectorList names the agent's project on such a connection, but none while the agent has no
 * project, so a connection that shows neither a project nor a saved value is looked up in the catalog. Empty when the
 * connections cannot be read.
 */
export async function projectConnections(client: WiroClient, agentGuid: string, signal?: AbortSignal): Promise<AgentConnection[]> {
  let live: AgentConnection[];
  try {
    live = (await listConnections(client, agentGuid, signal)).filter(isLiveConnection);
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
  const found: AgentConnection[] = [];
  for (const connection of live) {
    if (connection.way === 'project') {
      found.push(connection);
      continue;
    }
    if (connection.way !== 'key' || connection.savedFields.length > 0) continue;
    let ways: readonly string[] = [];
    try {
      ways = (await readConnector(client, connection.connector, signal))?.ways ?? [];
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (ways.includes('project')) found.push({ ...connection, way: 'project' });
  }
  return found;
}

/** What a new project does to those connections: their tools run with it from then on. Null when there are none. */
export function projectConnectionsNote(connections: readonly AgentConnection[]): string | null {
  if (connections.length === 0) return null;
  const several = connections.length > 1;
  const names = keyList(connections.map(connection => connectorLabel(connection)));
  const tools = keyList(connections.map(connection => `\`${connection.connector}__*\``));
  return `${names} ${several ? 'are' : 'is'} connected and always ${several ? 'run' : 'runs'} with the agent's own Wiro `
    + `project, so ${several ? 'their' : 'its'} model tools (${tools}) run with this project too, billed to the wallet of `
    + 'the workspace that owns it.';
}

/** A project inside a line of this server's own text. Its name comes from a person, so it is quoted. */
export function projectLabel(project: { id?: string; name?: string }): string {
  const id = project.id ? `id ${quotedSpan(project.id)}` : '';
  if (!project.name?.trim()) return id || 'the project of this connection';
  return id ? `${quotedSpan(project.name)} (${id})` : quotedSpan(project.name);
}

export const OUTSIDE_LIST_TEXT = 'a project outside this list or a key saved earlier';
