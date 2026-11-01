import type { WiroClient } from '../client.js';
import { asString, hasErrorCode, isPlainObject, requireApiSuccess, type ApiEnvelope } from './api.js';
import { quotedSpan } from './quoted-text.js';

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

interface TeamListResponse extends ApiEnvelope {
  team?: unknown;
}

interface WalletListResponse extends ApiEnvelope {
  wallet?: Array<Record<string, unknown>>;
}

async function readOrganizations(client: WiroClient, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const body = requireApiSuccess(
    await client.post<OrganizationListResponse>('/Organization/List', {}, signal),
    'The teams could not be read.',
  );
  return Array.isArray(body.organizations) ? body.organizations.filter(isPlainObject) : [];
}

/** Every team of the connected project's creator, in Wiro's order. Throws when the list cannot be read. */
export async function readTeamMemberships(client: WiroClient, signal?: AbortSignal): Promise<TeamMembership[]> {
  return membershipsIn(await readOrganizations(client, signal));
}

function membershipsIn(organizations: Array<Record<string, unknown>>): TeamMembership[] {
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

export interface ConnectedWorkspace {
  kind: 'personal' | 'team' | 'unknown';
  teamName?: string;
  organizationName?: string;
  role?: TeamRole;
}

/**
 * The team a wallet belongs to when its person is not a member of that team. An
 * organization's owner can use a key of a team project with no member row, so
 * the memberships leave that team out. A wallet keyed by an owner's id is that
 * person's own and needs no read. Throws when a team list cannot be read.
 */
async function ownedTeamOfWallet(
  client: WiroClient,
  organizations: Array<Record<string, unknown>>,
  owner: string,
  signal?: AbortSignal,
): Promise<ConnectedWorkspace | undefined> {
  if (organizations.some(organization => organization.owneruuid === owner)) return undefined;
  for (const organization of organizations) {
    const organizationguid = asString(organization.guid);
    if (!organizationguid) continue;
    const body = requireApiSuccess(
      await client.post<TeamListResponse>('/Team/List', { organizationguid }, signal),
      'The teams could not be read.',
    );
    const teams = Array.isArray(body.team) ? body.team.filter(isPlainObject) : [];
    const team = teams.find(row => row.guid === owner);
    if (team) {
      const teamName = asString(team.name);
      const organizationName = asString(organization.name);
      return { kind: 'team', ...(teamName ? { teamName } : {}), ...(organizationName ? { organizationName } : {}) };
    }
  }
  return undefined;
}

/**
 * The workspace a wallet belongs to: a team wallet is keyed by the team id.
 * Unknown when the teams cannot be read.
 */
export async function workspaceOfWallet(
  client: WiroClient,
  wallet: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<ConnectedWorkspace> {
  const owner = wallet ? asString(wallet.uuid) : undefined;
  try {
    const organizations = await readOrganizations(client, signal);
    const team = owner ? membershipsIn(organizations).find(candidate => candidate.guid === owner) : undefined;
    if (team) {
      return {
        kind: 'team',
        ...(team.teamName ? { teamName: team.teamName } : {}),
        ...(team.organizationName ? { organizationName: team.organizationName } : {}),
        ...(team.role ? { role: team.role } : {}),
      };
    }
    return (owner ? await ownedTeamOfWallet(client, organizations, owner, signal) : undefined) ?? { kind: 'personal' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: 'unknown' };
  }
}

function money(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

export interface WalletBalance {
  currency: 'USD';
  totalUsd: number;
  depositUsd: number;
  couponCreditUsd: number;
  storeRevenueUsd: number;
}

export function walletBalance(wallet: Record<string, unknown>): WalletBalance {
  const depositUsd = money(wallet.amount);
  const couponCreditUsd = money(wallet.giftedamount);
  const storeRevenueUsd = money(wallet.storeamount);
  return {
    currency: 'USD',
    totalUsd: Math.round((depositUsd + couponCreditUsd + storeRevenueUsd) * 100) / 100,
    depositUsd,
    couponCreditUsd,
    storeRevenueUsd,
  };
}

export interface PayingWallet {
  workspace: ConnectedWorkspace;
  balanceUsd: number | null;
  /** The part of the balance that is store revenue, when the wallet could be read. */
  storeRevenueUsd?: number;
}

/**
 * The wallet this connection pays from and its workspace, as far as they can be
 * read. Without a wallet row the workspace cannot be told apart.
 */
export async function readPayingWallet(client: WiroClient, signal?: AbortSignal): Promise<PayingWallet> {
  try {
    const wallets = (await client.post<WalletListResponse>('/Wallet/List', {}, signal)).wallet;
    const wallet = primaryWallet(Array.isArray(wallets) ? wallets : []);
    if (!wallet) return { workspace: { kind: 'unknown' }, balanceUsd: null };
    const balance = walletBalance(wallet);
    return {
      workspace: await workspaceOfWallet(client, wallet, signal),
      balanceUsd: balance.totalUsd,
      storeRevenueUsd: balance.storeRevenueUsd,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { workspace: { kind: 'unknown' }, balanceUsd: null };
  }
}

/** The wallet a workspace pays from, named when it can be read; otherwise the wording given. */
export function payingWalletText(workspace: ConnectedWorkspace, whenUnknown: string): string {
  if (workspace.kind === 'personal') return 'The personal wallet.';
  if (workspace.kind !== 'team') return whenUnknown;
  const team = workspace.teamName?.trim() ? `the team ${quotedSpan(workspace.teamName)}` : 'the connected project\'s team';
  return `The wallet of ${team}${workspace.organizationName?.trim() ? ` (${quotedSpan(workspace.organizationName)})` : ''}.`;
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
