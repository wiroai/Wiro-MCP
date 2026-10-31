import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, errorResult, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import { primaryWallet, readTeamMemberships, type TeamRole } from '../utils/workspace.js';

interface WalletListResponse extends ApiEnvelope {
  wallet?: Array<Record<string, unknown>>;
}

function money(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

export function registerGetAccount(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_account',
    {
      title: 'Get Wiro account balance and workspace',
      description: 'Show which workspace the connected project belongs to (personal, or a team) and that '
        + 'workspace\'s wallet balance. Everything run or bought through this connection is charged to this '
        + 'wallet. In a team it also gives the team role calls act with, admin or member. Use it before paid '
        + 'work and when a call is refused for insufficient balance.',
      inputSchema: {},
      outputSchema: {
        workspace: z.object({
          kind: z.enum(['personal', 'team', 'unknown']),
          teamName: z.string().optional(),
          organizationName: z.string().optional(),
          role: z.enum(['admin', 'member']).optional(),
        }),
        balance: z.object({
          currency: z.literal('USD'),
          totalUsd: z.number(),
          depositUsd: z.number(),
          couponCreditUsd: z.number(),
          storeRevenueUsd: z.number(),
        }).nullable(),
        authMode: z.enum(['signature', 'apikey-only']),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_args, extra) => {
      try {
        const walletResult = await client.post<WalletListResponse>('/Wallet/List', {}, extra.signal);
        const wallets = walletResult.wallet ?? [];
        if (walletResult.result !== true && wallets.length === 0) {
          requireApiSuccess(walletResult, 'Could not read the wallet.');
        }
        const wallet = primaryWallet(wallets);
        const balance = wallet
          ? (() => {
            const depositUsd = money(wallet.amount);
            const couponCreditUsd = money(wallet.giftedamount);
            const storeRevenueUsd = money(wallet.storeamount);
            return {
              currency: 'USD' as const,
              totalUsd: Math.round((depositUsd + couponCreditUsd + storeRevenueUsd) * 100) / 100,
              depositUsd,
              couponCreditUsd,
              storeRevenueUsd,
            };
          })()
          : null;

        // The wallet's owner is the team for a team project.
        let workspace: {
          kind: 'personal' | 'team' | 'unknown';
          teamName?: string;
          organizationName?: string;
          role?: TeamRole;
        } = { kind: 'unknown' };
        const walletOwner = wallet ? asString(wallet.uuid) : undefined;
        try {
          const teams = await readTeamMemberships(client, extra.signal);
          const team = walletOwner ? teams.find(candidate => candidate.guid === walletOwner) : undefined;
          workspace = team
            ? {
              kind: 'team',
              ...(team.teamName ? { teamName: team.teamName } : {}),
              ...(team.organizationName ? { organizationName: team.organizationName } : {}),
              ...(team.role ? { role: team.role } : {}),
            }
            : { kind: 'personal' };
        } catch {
          // The balance is still useful without the workspace name.
        }

        const lines = ['## Wiro account', ''];
        lines.push(`**Workspace:** ${workspace.kind === 'team'
          ? `team ${workspace.teamName ?? ''}${workspace.organizationName ? ` (${workspace.organizationName})` : ''}`.trim()
          : workspace.kind}`);
        if (workspace.role) lines.push(`**Role in this team:** ${workspace.role}`);
        if (balance) {
          lines.push(`**Balance:** $${balance.totalUsd}`);
          lines.push(`- Deposits: $${balance.depositUsd}`);
          if (balance.couponCreditUsd) lines.push(`- Coupon credit: $${balance.couponCreditUsd} (may be limited to certain models)`);
          if (balance.storeRevenueUsd) lines.push(`- Store revenue: $${balance.storeRevenueUsd}`);
        } else {
          lines.push('**Balance:** no wallet yet. Add funds at https://wiro.ai/panel/wallet/deposit/credit-card to start; for a team project, select that team in the Wiro dashboard first.');
        }
        if (workspace.kind === 'team') {
          lines.push('', 'Team spend limits and the team\'s model rules can still refuse a run when the wallet has money.');
        }
        if (workspace.role === 'member') {
          lines.push('Only a team admin can deploy an agent in this team. Starting, changing or paying for a team agent '
            + 'needs a team admin or the person who deployed it (for payments also the organization\'s owner).');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: { workspace, balance, authMode: client.authType },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
