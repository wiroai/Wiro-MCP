import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, errorResult, isPlainObject, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';

interface WalletListResponse extends ApiEnvelope {
  wallet?: Array<Record<string, unknown>>;
}

interface OrganizationListResponse extends ApiEnvelope {
  organizations?: Array<Record<string, unknown>>;
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
      description: 'Show which workspace the API key works in (personal, or a team) and that '
        + 'workspace\'s wallet balance. Everything the key runs or buys is charged to this '
        + 'wallet. Use it before paid work and when a call is refused for insufficient balance.',
      inputSchema: {},
      outputSchema: {
        workspace: z.object({
          kind: z.enum(['personal', 'team', 'unknown']),
          teamName: z.string().optional(),
          organizationName: z.string().optional(),
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
        const wallet = wallets.find(row => row.symbol === 'USD') ?? wallets[0];
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

        // Team wallets are keyed by the team id, personal wallets by the user id,
        // so the wallet's owner tells which workspace the key belongs to.
        let workspace: { kind: 'personal' | 'team' | 'unknown'; teamName?: string; organizationName?: string } = { kind: 'unknown' };
        const walletOwner = wallet ? asString(wallet.uuid) : undefined;
        try {
          const organizations = await client.post<OrganizationListResponse>('/Organization/List', {}, extra.signal);
          if (organizations.result === true) {
            workspace = { kind: 'personal' };
            for (const organization of organizations.organizations ?? []) {
              const teams = Array.isArray(organization.teams) ? organization.teams.filter(isPlainObject) : [];
              const team = teams.find(candidate => walletOwner && candidate.guid === walletOwner);
              if (team) {
                workspace = {
                  kind: 'team',
                  ...(asString(team.name) ? { teamName: asString(team.name) } : {}),
                  ...(asString(organization.name) ? { organizationName: asString(organization.name) } : {}),
                };
                break;
              }
            }
          }
        } catch {
          // The balance is still useful without the workspace name.
        }

        const lines = ['## Wiro account', ''];
        lines.push(`**Workspace:** ${workspace.kind === 'team'
          ? `team ${workspace.teamName ?? ''}${workspace.organizationName ? ` (${workspace.organizationName})` : ''}`.trim()
          : workspace.kind}`);
        if (balance) {
          lines.push(`**Balance:** $${balance.totalUsd}`);
          lines.push(`- Deposits: $${balance.depositUsd}`);
          if (balance.couponCreditUsd) lines.push(`- Coupon credit: $${balance.couponCreditUsd} (may be limited to certain models)`);
          if (balance.storeRevenueUsd) lines.push(`- Store revenue: $${balance.storeRevenueUsd}`);
        } else {
          lines.push('**Balance:** no wallet yet. Add funds on wiro.ai to start.');
        }
        if (workspace.kind === 'team') {
          lines.push('', 'Team spend limits and the team\'s model rules can still refuse a run when the wallet has money.');
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
