import type { WiroClient } from '../client.js';
import { asString, errorText, isPlainObject, requireApiSuccess, type ApiEnvelope } from './api.js';
import { credentialGroup, isFilledValue } from './agent-config.js';
import { quotedSpan } from './quoted-text.js';
import { WIRO_PROJECT_CREDENTIAL } from './user-agent.js';

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

/** A project inside a line of this server's own text. Its name comes from a person, so it is quoted. */
export function projectLabel(project: { id?: string; name?: string }): string {
  const id = project.id ? `id ${quotedSpan(project.id)}` : '';
  if (!project.name?.trim()) return id || 'the project of this connection';
  return id ? `${quotedSpan(project.name)} (${id})` : quotedSpan(project.name);
}

export const OUTSIDE_LIST_TEXT = 'a project outside this list or a key saved earlier';
