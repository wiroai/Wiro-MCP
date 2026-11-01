import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  truncate,
  unixToIso,
  type ApiEnvelope,
} from '../utils/api.js';
import { oneLine, quotedSpan } from '../utils/quoted-text.js';
import { primaryWallet, walletBalance, workspaceOfWallet } from '../utils/workspace.js';
import { strictInput } from './schemas.js';

interface WalletListResponse extends ApiEnvelope {
  wallet?: Array<Record<string, unknown>>;
}

const MAX_TRANSACTIONS = 50;
const DEFAULT_TRANSACTIONS = 20;
const TEXT_FIELD_MAX = 200;

// A row for an agent gives the agent's guid first.
const LEADING_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A credit for an agent's skill change names the agent's guid first too. Other rows can start with a guid, so the ending matters.
const AGENT_CREDIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=-[a-z-]+-credit-)/i;

const walletTransactionSchema = z.object({
  time: z.string().optional(),
  type: z.string().describe('The row\'s type as the wallet page names it, such as PAYMENT, PAYMENT (COUPON), DEPOSIT or TRANSFER IN.'),
  direction: z.enum(['in', 'out']).describe('Whether the row adds to the wallet or takes from it.'),
  amountUsd: z.number().describe('The amount in USD, always positive; direction gives the sign.'),
  description: z.string().optional(),
  model: z.string().optional(),
  project: z.string().optional(),
  store: z.string().optional(),
  taskId: z.string().optional(),
  agentGuid: z.string().optional(),
  discountUsd: z.number().optional(),
  expiresAt: z.string().optional().describe('For credit that can be spent only for a while: when it ends.'),
});

type WalletTransaction = z.infer<typeof walletTransactionSchema>;

const transactionsSchema = z.object({
  total: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  nextStart: z.number().int().nonnegative().nullable(),
  rows: z.array(walletTransactionSchema),
});

function textField(value: unknown): string | undefined {
  const text = asString(value);
  return text?.trim() ? truncate(oneLine(text), TEXT_FIELD_MAX) : undefined;
}

/** The type column gives a row's sign, as the wallet page reads it: a deduction takes from a deposit. */
function isIncoming(type: string): boolean {
  if (type.includes('DEDUCTION')) return false;
  return type.includes('DEPOSIT') || type.includes('REFUND') || type === 'TRANSFER IN';
}

/** A wallet row, rebuilt from an allowlist: what it was and how much. */
function toWalletTransaction(row: Record<string, unknown>): WalletTransaction {
  const type = asString(row.type) ?? 'UNKNOWN';
  const time = unixToIso(row.time);
  const description = textField(row.description);
  const model = textField(row.modelname);
  const project = textField(row.projectname);
  const store = textField(row.storename);
  const taskId = textField(row.taskid);
  const agentGuid = LEADING_GUID.exec(asString(row.agentguid) ?? '')?.[0] ?? AGENT_CREDIT_ID.exec(asString(row.paymentid) ?? '')?.[0];
  const discountUsd = Math.abs(toNumber(row.discountapplied) ?? 0);
  const expiresAt = unixToIso(row.expirytime);
  return {
    ...(time ? { time } : {}),
    type,
    direction: isIncoming(type) ? 'in' : 'out',
    amountUsd: Math.round(Math.abs(toNumber(row.amount) ?? 0) * 1e6) / 1e6,
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(project ? { project } : {}),
    ...(store ? { store } : {}),
    ...(taskId ? { taskId } : {}),
    ...(agentGuid ? { agentGuid } : {}),
    ...(discountUsd > 0 ? { discountUsd: Math.round(discountUsd * 1e6) / 1e6 } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

async function readTransactions(
  client: WiroClient,
  limit: number,
  start: number,
  signal: AbortSignal,
): Promise<z.infer<typeof transactionsSchema>> {
  // "me" reads the wallet of the connected project's workspace, as the wallet page does.
  const body = requireApiSuccess(
    await client.post<ApiEnvelope & { wallettransaction?: unknown; total?: unknown }>('/Wallet/TransactionList', {
      uuid: 'me',
      type: 'all',
      start,
      limit,
    }, signal),
    'The wallet transactions could not be read.',
  );
  const rows = (Array.isArray(body.wallettransaction) ? body.wallettransaction : []).filter(isPlainObject).map(toWalletTransaction);
  const total = toNumber(body.total) ?? start + rows.length;
  return { total, start, limit, nextStart: start + rows.length < total && rows.length > 0 ? start + rows.length : null, rows };
}

/** Up to six decimals, as a model run can cost a fraction of a cent, and at least two. */
function transactionUsd(value: number): string {
  return `$${value.toFixed(6).replace(/0{1,4}$/, '')}`;
}

// Names and descriptions can be written by other people, such as a public workflow's title, so they stay in code spans.
function transactionLine(row: WalletTransaction): string {
  const details = [
    row.description ? quotedSpan(row.description) : null,
    row.model ? `model ${quotedSpan(row.model)}` : null,
    row.project ? `project ${quotedSpan(row.project)}` : null,
    row.store ? `store item ${quotedSpan(row.store)}` : null,
    row.taskId ? `task ${quotedSpan(row.taskId)}` : null,
    row.agentGuid ? `agent \`${row.agentGuid}\`` : null,
    row.discountUsd ? `after a ${transactionUsd(row.discountUsd)} discount` : null,
    row.expiresAt ? `can be spent until ${row.expiresAt}` : null,
  ].filter(Boolean).join(', ');
  return `- ${row.time ?? 'unknown time'} ${row.direction === 'in' ? '+' : '-'}${transactionUsd(row.amountUsd)} ${row.type}${details ? `: ${details}` : ''}`;
}

function transactionLines(transactions: z.infer<typeof transactionsSchema>): string[] {
  const { rows, total, start, nextStart } = transactions;
  const lines = ['', `### Recent transactions (${rows.length} of ${total}, newest first)`, ''];
  if (rows.length === 0) lines.push(start === 0 ? 'This wallet has no transactions yet.' : 'No more transactions.');
  lines.push(...rows.map(transactionLine));
  if (nextStart !== null) lines.push('', `More transactions: call get_account with recent_transactions and transactions_start ${nextStart}.`);
  return lines;
}

export function registerGetAccount(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_account',
    {
      title: 'Get Wiro account balance and workspace',
      description: 'Show which workspace the connected project belongs to (personal, or a team) and that '
        + 'workspace\'s wallet balance. Everything run or bought through this connection is charged to this '
        + 'wallet. In a team it also gives the team role calls act with, admin or member. Use it before paid '
        + 'work and when a call is refused for insufficient balance. With recent_transactions it also lists the '
        + 'wallet\'s latest transactions, the rows the Transactions page of the Wiro dashboard shows, which is how to '
        + 'check that a charge or a credit landed. In a team the wallet is shared, so the list holds the activity of '
        + 'the whole team.',
      inputSchema: strictInput({
        recent_transactions: z.number().int().min(1).max(MAX_TRANSACTIONS).optional()
          .describe(`Also list this many of the wallet's latest transactions, newest first (1 to ${MAX_TRANSACTIONS}). Leave it out to read only the balance.`),
        transactions_start: z.number().int().min(0).optional()
          .describe(`How many of the latest rows to skip, from nextStart in the last answer. Without recent_transactions it lists ${DEFAULT_TRANSACTIONS} rows.`),
      }),
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
        transactions: transactionsSchema.optional(),
        transactionsError: z.string().optional()
          .describe('Why the transactions could not be read, when the balance could.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ recent_transactions, transactions_start }, extra) => {
      try {
        const walletResult = await client.post<WalletListResponse>('/Wallet/List', {}, extra.signal);
        const wallets = walletResult.wallet ?? [];
        if (walletResult.result !== true && wallets.length === 0) {
          requireApiSuccess(walletResult, 'Could not read the wallet.');
        }
        const wallet = primaryWallet(wallets);
        const balance = wallet ? walletBalance(wallet) : null;

        // The balance is still useful without the workspace name.
        const workspace = await workspaceOfWallet(client, wallet, extra.signal);

        const lines = ['## Wiro account', ''];
        lines.push(`**Workspace:** ${workspace.kind === 'team'
          ? `team${workspace.teamName?.trim() ? ` ${quotedSpan(workspace.teamName)}` : ''}${workspace.organizationName?.trim() ? ` (${quotedSpan(workspace.organizationName)})` : ''}`
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

        // The balance above stands even when the rows cannot be read.
        let transactions: z.infer<typeof transactionsSchema> | undefined;
        let transactionsError: string | undefined;
        if (recent_transactions !== undefined || transactions_start !== undefined) {
          try {
            transactions = await readTransactions(client, recent_transactions ?? DEFAULT_TRANSACTIONS, transactions_start ?? 0, extra.signal);
            lines.push(...transactionLines(transactions));
          } catch (error) {
            if (extra.signal.aborted) throw error;
            transactionsError = errorText(error);
            lines.push('', `The transactions could not be read: ${transactionsError}`);
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            workspace,
            balance,
            authMode: client.authType,
            ...(transactions ? { transactions } : {}),
            ...(transactionsError ? { transactionsError } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
