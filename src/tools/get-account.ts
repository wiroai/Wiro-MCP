import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isPlainObject,
  MODEL_ACCESS_URL,
  requireApiSuccess,
  SPEND_LIMITS_URL,
  toNumber,
  truncate,
  unixToIso,
  type ApiEnvelope,
} from '../utils/api.js';
import { isSurface, SURFACES } from '../utils/controls.js';
import { oneLine, quotedSpan } from '../utils/quoted-text.js';
import { primaryWallet, walletBalance, workspaceOfWallet } from '../utils/workspace.js';
import { strictInput } from './schemas.js';

interface WalletListResponse extends ApiEnvelope {
  wallet?: Array<Record<string, unknown>>;
}

interface SpendLimitListResponse extends ApiEnvelope {
  limits?: Array<Record<string, unknown>>;
  workspace?: unknown;
}

export interface GetAccountOptions {
  /** Whether the controls tools (get_controls, manage_spend_limit, manage_model_access) are loaded too. */
  controls?: boolean;
}

const SPEND_LIMIT_SCOPES = ['account', 'member', 'project', 'surface', 'agent'] as const;

const spendLimitSchema = z.object({
  scope: z.enum(SPEND_LIMIT_SCOPES).describe('What the limit caps: the whole wallet (account), one team member, one API key (project), one way in (surface: web, api, mcp, llm-gateway, extension, agent, studio, workflow-agent, workflow) or one agent.'),
  target: z.string().optional().describe('The member\'s uuid, the project id, the surface or the agent guid; absent for the whole wallet.'),
  targetName: z.string().optional(),
  period: z.enum(['month', 'day']).describe('Monthly limits reset on the 1st, daily ones at 00:00 UTC.'),
  amountUsd: z.number(),
  spentUsd: z.number().describe('Spent in the current period.'),
  heldUsd: z.number().optional().describe('Held by work that is still running, until it is charged or ends.'),
  usedUp: z.boolean().describe('True when new work this limit covers is refused (error code 93).'),
  resetsAt: z.string().optional(),
});

type SpendLimit = z.infer<typeof spendLimitSchema>;

const MAX_TRANSACTIONS = 50;
const DEFAULT_TRANSACTIONS = 20;
const TEXT_FIELD_MAX = 200;

// A row for an agent names it in useragentguid; an older row gives the agent's guid first in agentguid.
const LEADING_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A credit for an agent's skill change names the agent's guid first too. Other rows can start with a guid, so the ending matters.
const AGENT_CREDIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=-[a-z-]+-credit-)/i;
// An agent's AI usage its plan covered: listed for the record, it moves no money (the wallet page shows it "(in plan)").
const AGENT_PLAN_USAGE = 'USAGE (AGENT PLAN)';

const walletTransactionSchema = z.object({
  time: z.string().optional(),
  type: z.string().describe('The row\'s type as the wallet page names it, such as PAYMENT, PAYMENT (COUPON), DEPOSIT, TRANSFER IN or USAGE (AGENT PLAN).'),
  direction: z.enum(['in', 'out']).optional().describe('Whether the row adds to the wallet or takes from it. Absent when inPlan is true.'),
  inPlan: z.boolean().optional().describe('True on a USAGE (AGENT PLAN) row: AI usage an agent\'s plan covered, listed for the record. No money moved, so leave it out of any total.'),
  amountUsd: z.number().describe('The amount in USD, always positive; direction gives the sign.'),
  description: z.string().optional(),
  model: z.string().optional(),
  project: z.string().optional(),
  store: z.string().optional(),
  taskId: z.string().optional(),
  agentGuid: z.string().optional(),
  surface: z.enum(SURFACES).optional().describe('The way in that made the charge, as Spend Limits count it. Older rows have none.'),
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

/** A limit row of SpendLimit/List, rebuilt from an allowlist. */
function toSpendLimit(row: Record<string, unknown>): SpendLimit | null {
  const scope = asString(row.scope) as SpendLimit['scope'] | undefined;
  const period = asString(row.period);
  const amountUsd = toNumber(row.amountusd);
  if (!scope || !SPEND_LIMIT_SCOPES.includes(scope) || (period !== 'month' && period !== 'day') || amountUsd === null) return null;
  const spentUsd = toNumber(row.spentusd) ?? 0;
  const heldUsd = toNumber(row.heldusd);
  const target = textField(row.target);
  const targetName = textField(row.targetlabel);
  const resetsAt = unixToIso(row.resetsat);
  return {
    scope,
    ...(target ? { target } : {}),
    ...(targetName ? { targetName } : {}),
    period,
    amountUsd,
    spentUsd,
    ...(heldUsd !== null && heldUsd > 0 ? { heldUsd: Math.round(heldUsd * 100) / 100 } : {}),
    usedUp: spentUsd >= amountUsd,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function spendLimitLine(limit: SpendLimit): string {
  const name = limit.targetName ? quotedSpan(limit.targetName) : limit.target ? quotedSpan(limit.target) : '';
  const what = limit.scope === 'account'
    ? 'the whole wallet'
    : limit.scope === 'member'
      ? `team member ${name}`
      : limit.scope === 'project'
        ? `the API key of project ${name}`
        : limit.scope === 'surface'
          ? `calls through ${name}`
          : `agent ${name}`;
  const period = limit.period === 'day' ? 'Daily' : 'Monthly';
  const held = limit.heldUsd ? `, $${limit.heldUsd} held by work still running` : '';
  const state = limit.usedUp ? ', used up: new work it covers is refused until it resets' : '';
  const reset = limit.resetsAt ? ` (resets ${limit.resetsAt})` : '';
  return `- ${period} limit for ${what}: $${limit.spentUsd} of $${limit.amountUsd}${held}${state}${reset}`;
}

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
  const agentGuid = LEADING_GUID.exec(asString(row.useragentguid) ?? '')?.[0]
    ?? LEADING_GUID.exec(asString(row.agentguid) ?? '')?.[0]
    ?? AGENT_CREDIT_ID.exec(asString(row.paymentid) ?? '')?.[0];
  const surface = isSurface(row.surface) ? row.surface : undefined;
  const inPlan = type.trim().toUpperCase() === AGENT_PLAN_USAGE;
  const discountUsd = Math.abs(toNumber(row.discountapplied) ?? 0);
  const expiresAt = unixToIso(row.expirytime);
  return {
    ...(time ? { time } : {}),
    type,
    ...(inPlan ? { inPlan: true } : { direction: isIncoming(type) ? 'in' as const : 'out' as const }),
    amountUsd: Math.round(Math.abs(toNumber(row.amount) ?? 0) * 1e6) / 1e6,
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(project ? { project } : {}),
    ...(store ? { store } : {}),
    ...(taskId ? { taskId } : {}),
    ...(agentGuid ? { agentGuid } : {}),
    ...(surface ? { surface } : {}),
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
    row.surface ? `surface \`${row.surface}\`` : null,
    row.discountUsd ? `after a ${transactionUsd(row.discountUsd)} discount` : null,
    row.expiresAt ? `can be spent until ${row.expiresAt}` : null,
  ].filter(Boolean).join(', ');
  // A plan row moved no money, so it carries no sign.
  const amount = row.inPlan
    ? `${transactionUsd(row.amountUsd)} ${row.type} (covered by the agent's plan, no money moved)`
    : `${row.direction === 'in' ? '+' : '-'}${transactionUsd(row.amountUsd)} ${row.type}`;
  return `- ${row.time ?? 'unknown time'} ${amount}${details ? `: ${details}` : ''}`;
}

function transactionLines(transactions: z.infer<typeof transactionsSchema>): string[] {
  const { rows, total, start, nextStart } = transactions;
  const lines = ['', `### Recent transactions (${rows.length} of ${total}, newest first)`, ''];
  if (rows.length === 0) lines.push(start === 0 ? 'This wallet has no transactions yet.' : 'No more transactions.');
  lines.push(...rows.map(transactionLine));
  if (nextStart !== null) lines.push('', `More transactions: call get_account with recent_transactions and transactions_start ${nextStart}.`);
  return lines;
}

/** Who changes the workspace's controls, as get_account says it; the controls tools are named only when they are loaded. */
function controlsLine(canManage: boolean | undefined, kind: string, controlsLoaded: boolean): string {
  if (canManage === false) {
    const who = kind === 'team' ? 'a team admin or the organization\'s owner' : 'the account owner';
    return controlsLoaded
      ? `This connection can only read the spend limits and Model Access rules: ${who} changes them. get_controls shows them all.`
      : `This connection can only read the spend limits and Model Access rules: ${who} changes them at ${SPEND_LIMITS_URL}.`;
  }
  if (canManage === true) {
    return controlsLoaded
      ? 'This connection can change them with manage_spend_limit and manage_model_access, after a change summary; get_controls shows the rules and what each limit used.'
      : `They are managed at ${SPEND_LIMITS_URL} and ${MODEL_ACCESS_URL}.`;
  }
  return controlsLoaded ? 'get_controls shows the rules and what each limit used.' : `They are managed at ${SPEND_LIMITS_URL} and ${MODEL_ACCESS_URL}.`;
}

export function registerGetAccount(server: McpServer, client: WiroClient, options: GetAccountOptions = {}): void {
  const controlsLoaded = options.controls === true;
  server.registerTool(
    'get_account',
    {
      title: 'Get Wiro account balance and workspace',
      description: 'Show which workspace the connected project belongs to (personal, or a team) and that '
        + 'workspace\'s wallet balance. Everything run or bought through this connection is charged to this '
        + 'wallet. In a team it also gives the team role calls act with, admin or member. Use it before paid '
        + 'work and when a call is refused for insufficient balance. With recent_transactions it also lists the '
        + 'wallet\'s latest transactions, the rows the Transactions page of the Wiro dashboard shows, which is how to '
        + 'check that a charge or a credit landed. A USAGE (AGENT PLAN) row is AI usage an agent\'s plan covered: it moved '
        + 'no money, so it is no charge. In a team the wallet is shared, so the list holds the activity of '
        + 'the whole team. It also lists the workspace\'s spend limits and says whether this connection can change '
        + `Spend Limits and Model Access rules${controlsLoaded ? ' (get_controls shows the rules)' : ''}.`,
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
        spendLimits: z.array(spendLimitSchema).optional()
          .describe('The workspace\'s spend limits with what each has used this period. A used-up limit refuses new work with error code 93 even when the wallet has money.'),
        spendLimitsError: z.string().optional()
          .describe('Why the spend limits could not be read, when the balance could.'),
        controls: z.object({
          canManage: z.boolean().describe('Whether this connection can change the Spend Limits and Model Access rules.'),
        }).optional(),
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
        // The spend limits (the whole wallet, a member, an API key, a surface or an agent). The balance stands without them.
        let spendLimits: SpendLimit[] | undefined;
        let spendLimitsError: string | undefined;
        let canManage: boolean | undefined;
        // Who changes the controls follows the workspace Wiro names for them, else the wallet's.
        let controlsKind: string = workspace.kind;
        try {
          const listed = await client.post<SpendLimitListResponse>('/SpendLimit/List', {}, extra.signal);
          requireApiSuccess(listed, 'Could not read the spend limits.');
          if (isPlainObject(listed.workspace)) {
            if (typeof listed.workspace.canmanage === 'boolean') canManage = listed.workspace.canmanage;
            if (listed.workspace.type === 'team' || listed.workspace.type === 'personal') controlsKind = listed.workspace.type;
          }
          spendLimits = (listed.limits ?? []).filter(isPlainObject).map(toSpendLimit).filter((l): l is SpendLimit => l !== null);
          lines.push('', spendLimits.length ? '**Spend limits:**' : '**Spend limits:** none');
          lines.push(...spendLimits.map(spendLimitLine));
        } catch (error) {
          if (extra.signal.aborted) throw error;
          spendLimitsError = errorText(error);
          lines.push('', `The spend limits could not be read: ${spendLimitsError}`);
        }
        lines.push('', 'A used-up spend limit refuses new work (error code 93) even when the wallet has money, '
          + 'and a Model Access rule can block a model (error code 92).');
        lines.push(controlsLine(canManage, controlsKind, controlsLoaded));
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
            ...(spendLimits ? { spendLimits } : {}),
            ...(spendLimitsError ? { spendLimitsError } : {}),
            ...(canManage !== undefined ? { controls: { canManage } } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
