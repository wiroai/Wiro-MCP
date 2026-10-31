import type { WiroClient } from '../client.js';
import { asString, hasErrorCode, isPlainObject, requireApiSuccess, type ApiEnvelope } from './api.js';

// The teams of the person who created the connected project, with that
// person's role in each. Calls act as that person, so team rights follow
// these roles: only a team admin deploys in a team, a team agent is started,
// changed and paid for by a team admin or the person who deployed it (the
// organization's owner can also pay for it), and every other member can read
// it and message it.

export type TeamRole = 'admin' | 'member';

export interface TeamMembership {
  guid: string;
  teamName?: string;
  organizationName?: string;
  role?: TeamRole;
}

interface OrganizationListResponse extends ApiEnvelope {
  organizations?: unknown;
}

interface WalletListResponse extends ApiEnvelope {
  wallet?: Array<Record<string, unknown>>;
}

/** Every team of the connected project's creator, in Wiro's order. Throws when the list cannot be read. */
export async function readTeamMemberships(client: WiroClient, signal?: AbortSignal): Promise<TeamMembership[]> {
  const body = requireApiSuccess(
    await client.post<OrganizationListResponse>('/Organization/List', {}, signal),
    'The teams could not be read.',
  );
  const organizations = Array.isArray(body.organizations) ? body.organizations.filter(isPlainObject) : [];
  return organizations.flatMap(organization => {
    const organizationName = asString(organization.name);
    const teams = Array.isArray(organization.teams) ? organization.teams.filter(isPlainObject) : [];
    return teams.flatMap(team => {
      const guid = asString(team.guid);
      if (!guid) return [];
      const teamName = asString(team.name);
      const role = team.role === 'admin' || team.role === 'member' ? team.role : undefined;
      return [{
        guid,
        ...(teamName ? { teamName } : {}),
        ...(organizationName ? { organizationName } : {}),
        ...(role ? { role } : {}),
      }];
    });
  });
}

/**
 * The wallet a workspace pays from. Team wallets are keyed by the team id and
 * personal wallets by the user id, so its owner tells the workspace apart.
 */
export function primaryWallet(wallets: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return wallets.find(row => row.symbol === 'USD') ?? wallets[0];
}

/**
 * Whether the connected project belongs to a team in which its creator is a
 * member without admin rights, where only a team admin can deploy. False for
 * a personal project, and when this cannot be read.
 */
export async function connectedAsPlainMember(client: WiroClient, signal?: AbortSignal): Promise<boolean> {
  try {
    const memberOf = (await readTeamMemberships(client, signal)).filter(team => team.role === 'member');
    if (memberOf.length === 0) return false;
    const wallets = (await client.post<WalletListResponse>('/Wallet/List', {}, signal)).wallet;
    const owner = asString(primaryWallet(Array.isArray(wallets) ? wallets : [])?.uuid);
    return owner !== undefined && memberOf.some(team => team.guid === owner);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

/**
 * Whether the connected project's creator is a member without admin rights of
 * the team that owns this agent row. A personal agent needs no lookup, and a
 * team list that cannot be read counts as false.
 */
export async function isPlainTeamMember(
  client: WiroClient,
  row: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const teamGuid = asString(row.teamguid);
  if (!teamGuid) return false;
  try {
    const team = (await readTeamMemberships(client, signal)).find(candidate => candidate.guid === teamGuid);
    return team?.role === 'member';
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

/**
 * Whether Wiro refuses this connection the credit history of a team agent.
 * That read takes the same rights as paying for the agent: the person who
 * deployed it, a team admin or the organization's owner. Changing its skills
 * takes the person who deployed it or a team admin, so for skills a refusal
 * here is final but a pass is not: the organization's owner passes here and
 * gets Wiro's own answer when the skill change is confirmed. Only that
 * refusal counts; any other answer is false.
 */
export async function teamAgentBillingRefused(client: WiroClient, agentGuid: string, signal?: AbortSignal): Promise<boolean> {
  try {
    requireApiSuccess(
      await client.post<ApiEnvelope>('/UserAgent/TransactionList', { useragentguid: agentGuid, limit: 1 }, signal),
      'The agent could not be read.',
    );
    return false;
  } catch (error) {
    if (signal?.aborted) throw error;
    return hasErrorCode(error, 97);
  }
}
