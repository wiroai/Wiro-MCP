import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  truncate,
  unixToIso,
  type ApiEnvelope,
} from '../utils/api.js';
import { formatCredits } from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

const MAX_LOG_EVENTS = 300;

const tokenCountsSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  total: z.number().optional(),
});

const usageSchema = z.object({
  total: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  nextStart: z.number().int().nonnegative().nullable(),
  balance: z.object({
    monthlyCredits: z.number(),
    extraCredits: z.number(),
    usedCredits: z.number(),
    remainingCredits: z.number(),
    period: z.string().optional(),
  }),
  extraPacks: z.array(z.object({
    credits: z.number(),
    remainingCredits: z.number(),
    status: z.string().optional(),
    purchasedAt: z.string().optional(),
  })),
  byModel: z.array(z.object({
    model: z.string(),
    tokens: tokenCountsSchema,
    credits: z.number(),
    turns: z.number(),
  })),
  transactions: z.array(z.object({
    type: z.string(),
    action: z.string().optional(),
    credits: z.number(),
    balanceAfter: z.number().nullable(),
    description: z.string().optional(),
    createdAt: z.string().optional(),
    paidBy: z.string().optional(),
    model: z.string().optional(),
    tokens: tokenCountsSchema.optional(),
    processedMs: z.number().optional(),
  })),
});

const logEventSchema = z.object({
  time: z.string().optional(),
  kind: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  tool: z.string().optional(),
  ok: z.boolean().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  processedMs: z.number().optional(),
  model: z.string().optional(),
  tokens: z.record(z.string(), z.number()).optional(),
  credits: z.number().optional(),
  trigger: z.string().optional(),
  remainingCredits: z.number().optional(),
});

const logsSchema = z.object({
  available: z.boolean(),
  date: z.string().optional(),
  totalLines: z.number().int().nonnegative().optional(),
  events: z.array(logEventSchema),
  note: z.string().optional(),
});

const logDatesSchema = z.object({
  available: z.boolean(),
  dates: z.array(z.object({ date: z.string(), sizeBytes: z.number().optional() })),
  note: z.string().optional(),
});

type Envelope = ApiEnvelope & Record<string, unknown>;

const NOT_RUNNING_NOTE = 'The activity log is read from the agent host, and this agent is not on one right now '
  + '(it is stopped, has never started, or was released). Start it with control_agent to read its log.';

function tokenCounts(row: Record<string, unknown>): z.infer<typeof tokenCountsSchema> {
  const fields: Array<[keyof z.infer<typeof tokenCountsSchema>, unknown]> = [
    ['input', row.inputtokens],
    ['output', row.outputtokens],
    ['cacheRead', row.cachereadtokens],
    ['cacheWrite', row.cachewritetokens],
    ['total', row.totaltokens],
  ];
  const out: z.infer<typeof tokenCountsSchema> = {};
  for (const [key, value] of fields) {
    const count = toNumber(value);
    if (count !== null) out[key] = count;
  }
  return out;
}

function eventTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim())) return value;
  const numeric = toNumber(value);
  if (numeric === null || numeric <= 0) return undefined;
  return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
}

function numericRecord(value: unknown): Record<string, number> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const count = toNumber(entry);
    if (count !== null) out[key] = count;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Events carry the acting person's profile; only the activity itself is kept.
function toLogEvent(event: Record<string, unknown>): z.infer<typeof logEventSchema> {
  const out: z.infer<typeof logEventSchema> = {};
  const time = eventTime(event.ts);
  if (time) out.time = time;
  for (const key of ['kind', 'title', 'tool', 'trigger', 'model'] as const) {
    const value = asString(event[key]);
    if (value) out[key] = truncate(value, 200);
  }
  const summary = asString(event.summary);
  if (summary) out.summary = truncate(summary, 500);
  if (typeof event.ok === 'boolean') out.ok = event.ok;
  const error = asString(event.error);
  if (error) out.error = truncate(error, 300);
  const duration = toNumber(event.durationMs);
  if (duration !== null) out.durationMs = duration;
  const processed = toNumber(event.processedMs);
  if (processed !== null) out.processedMs = processed;
  const tokens = numericRecord(event.tokens);
  if (tokens) out.tokens = tokens;
  const credits = isPlainObject(event.cost) ? toNumber(event.cost.credits) : toNumber(event.tokencost);
  if (credits !== null) out.credits = credits;
  const remaining = toNumber(event.remainingcredits);
  if (remaining !== null) out.remainingCredits = remaining;
  return out;
}

function isNotRunning(error: unknown): boolean {
  return error instanceof ApiResultError && /not assigned to a worker|may not be running/i.test(error.message);
}

export function registerGetAgentActivity(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_agent_activity',
    {
      title: 'Get a Wiro agent\'s usage or activity log',
      description: 'Read what a deployed agent has done and spent. kind usage returns the credit balance, '
        + 'usage per model for the current period and the credit ledger (charges, renewals, packs and token '
        + 'usage per turn; 100 credits = 1 USD). kind logs returns the activity log for one day, newest first '
        + '(tool calls, turns, scheduled runs, errors). kind log_dates lists the days that have a log. Logs '
        + 'are read from the agent\'s host: a running agent and an agent in error have one, a stopped agent '
        + 'has none (the call says so; start it only if the user agrees). Names and emails of the people who '
        + 'acted are never returned.',
      inputSchema: {
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        kind: z.enum(['usage', 'logs', 'log_dates']).default('usage')
          .describe('usage for credits and spending, logs for one day of activity, log_dates for the days that have a log.'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('logs only: the UTC day as YYYY-MM-DD (default today).'),
        lines: z.number().int().min(1).max(MAX_LOG_EVENTS).default(100)
          .describe(`logs only: how many of the newest events to return (default 100, max ${MAX_LOG_EVENTS}).`),
        start: z.number().int().min(0).default(0)
          .describe('usage only: offset into the ledger, newest first (default 0).'),
        limit: z.number().int().min(1).max(200).default(50)
          .describe('usage only: ledger rows to return (default 50, max 200).'),
      },
      outputSchema: {
        kind: z.enum(['usage', 'logs', 'log_dates']),
        agentGuid: z.string(),
        usage: usageSchema.optional(),
        logs: logsSchema.optional(),
        logDates: logDatesSchema.optional(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, kind, date, lines, start, limit }, extra) => {
      const guid = agent_guid.trim();
      const startAgent = {
        tool: 'control_agent',
        arguments: { agent_guid: guid, action: 'start' },
        reason: 'Logs can only be read while the agent is on an agent host.',
      };
      try {
        if (kind === 'usage') {
          const body = requireApiSuccess(
            await client.post<Envelope>('/UserAgent/TransactionList', { useragentguid: guid, limit, start }, extra.signal),
            'The usage of this agent could not be read.',
          );
          const summary = isPlainObject(body.summary) ? body.summary : {};
          const rows = Array.isArray(body.transactions) ? body.transactions.filter(isPlainObject) : [];
          const total = Math.max(0, Math.trunc(toNumber(body.total) ?? rows.length));
          const period = asString(summary.creditperiod);
          const usage: z.infer<typeof usageSchema> = {
            total,
            start,
            limit,
            nextStart: start + rows.length < total ? start + rows.length : null,
            balance: {
              monthlyCredits: toNumber(summary.monthlycredits) ?? 0,
              extraCredits: toNumber(summary.extracredits) ?? 0,
              usedCredits: toNumber(summary.usedcredits) ?? 0,
              remainingCredits: toNumber(summary.remainingcredits) ?? 0,
              ...(period ? { period } : {}),
            },
            // Pack expiry dates are left out on purpose: the tools never surface credit expiry.
            extraPacks: (Array.isArray(summary.extrapacks) ? summary.extrapacks : []).filter(isPlainObject).map(pack => {
              const status = asString(pack.status);
              const purchasedAt = unixToIso(pack.purchasedat);
              return {
                credits: toNumber(pack.credits) ?? 0,
                remainingCredits: toNumber(pack.remainingcredits) ?? 0,
                ...(status ? { status } : {}),
                ...(purchasedAt ? { purchasedAt } : {}),
              };
            }),
            byModel: (Array.isArray(summary.byModel) ? summary.byModel : []).filter(isPlainObject).map(entry => ({
              model: asString(entry.model) ?? 'unknown',
              tokens: tokenCounts(entry),
              credits: toNumber(entry.tokencost) ?? 0,
              turns: toNumber(entry.turncount) ?? 0,
            })),
            transactions: rows.map(row => {
              const action = asString(row.action);
              const description = asString(row.description);
              const createdAt = unixToIso(row.createdat);
              const provider = asString(row.provider);
              const model = asString(row.model);
              const tokens = tokenCounts(row);
              const processedMs = toNumber(row.processedms);
              return {
                type: asString(row.type) ?? 'unknown',
                ...(action ? { action } : {}),
                credits: toNumber(row.amount) ?? 0,
                balanceAfter: toNumber(row.balanceafter),
                ...(description ? { description: truncate(description, 200) } : {}),
                ...(createdAt ? { createdAt } : {}),
                ...(provider ? { paidBy: provider === 'prepaid' ? 'wallet' : provider === 'stripe' ? 'card' : provider } : {}),
                ...(model ? { model } : {}),
                ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
                ...(processedMs !== null ? { processedMs } : {}),
              };
            }),
          };

          const text = [
            `## Usage of agent \`${guid}\``,
            '',
            `**Balance:** ${formatCredits(usage.balance.remainingCredits)} credits left (monthly ${formatCredits(usage.balance.monthlyCredits)}, extra ${formatCredits(usage.balance.extraCredits)}, used ${formatCredits(usage.balance.usedCredits)}${period ? `, period ${period}` : ''})`,
          ];
          if (usage.byModel.length > 0) {
            text.push('', '### This period by model', '');
            for (const entry of usage.byModel) {
              text.push(`- ${entry.model}: ${formatCredits(entry.credits)} credits over ${formatCredits(entry.turns)} turns, ${formatCredits(entry.tokens.total ?? 0)} tokens`);
            }
          }
          text.push('', `### Ledger (${rows.length} of ${total}, newest first)`, '');
          if (usage.transactions.length === 0) text.push('No entries.');
          for (const entry of usage.transactions) {
            text.push(`- ${entry.createdAt ?? ''} ${entry.type}${entry.action ? `/${entry.action}` : ''}: ${entry.credits} credits${entry.description ? `, ${entry.description}` : ''}`);
          }
          if (usage.nextStart !== null) text.push('', `More entries: call get_agent_activity with kind usage and start ${usage.nextStart}.`);

          return {
            content: [{ type: 'text' as const, text: text.join('\n') }],
            structuredContent: {
              kind,
              agentGuid: guid,
              usage,
              ...(usage.nextStart !== null
                ? {
                  nextAction: {
                    tool: 'get_agent_activity',
                    arguments: { agent_guid: guid, kind: 'usage', start: usage.nextStart, limit },
                    reason: 'Read the next page of the ledger.',
                  },
                }
                : {}),
            },
          };
        }

        if (kind === 'log_dates') {
          let dates: Array<{ date: string; sizeBytes?: number }> = [];
          try {
            const body = requireApiSuccess(
              await client.post<Envelope>('/UserAgent/LogsList', { useragentguid: guid }, extra.signal),
              'The log days could not be read.',
            );
            dates = (Array.isArray(body.dates) ? body.dates : []).flatMap(entry => {
              const day = isPlainObject(entry) ? asString(entry.date) : asString(entry);
              if (!day) return [];
              const size = isPlainObject(entry) ? toNumber(entry.sizeBytes) : null;
              return [{ date: day, ...(size !== null ? { sizeBytes: size } : {}) }];
            }).sort((left, right) => right.date.localeCompare(left.date));
          } catch (error) {
            if (!isNotRunning(error)) throw error;
            return {
              content: [{ type: 'text' as const, text: `## Log days\n\n${NOT_RUNNING_NOTE}` }],
              structuredContent: {
                kind,
                agentGuid: guid,
                logDates: { available: false, dates: [], note: NOT_RUNNING_NOTE },
                nextAction: startAgent,
              },
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: `## Log days\n\n${dates.length > 0 ? dates.map(entry => `- ${entry.date}`).join('\n') : 'No log days yet.'}`,
            }],
            structuredContent: {
              kind,
              agentGuid: guid,
              logDates: { available: true, dates },
            },
          };
        }

        let body: Envelope;
        try {
          body = requireApiSuccess(
            await client.post<Envelope>('/UserAgent/Logs', {
              useragentguid: guid,
              lines,
              ...(date ? { date } : {}),
            }, extra.signal),
            'The activity log could not be read.',
          );
        } catch (error) {
          if (!isNotRunning(error)) throw error;
          return {
            content: [{ type: 'text' as const, text: `## Activity log\n\n${NOT_RUNNING_NOTE}` }],
            structuredContent: {
              kind,
              agentGuid: guid,
              logs: { available: false, events: [], note: NOT_RUNNING_NOTE },
              nextAction: startAgent,
            },
          };
        }
        const events = (Array.isArray(body.events) ? body.events : [])
          .filter(isPlainObject)
          .slice(0, lines)
          .map(toLogEvent);
        const logDate = asString(body.date);
        const totalLines = toNumber(body.totalLines);
        const text = [`## Activity log${logDate ? ` for ${logDate}` : ''} (${events.length} events, newest first)`, ''];
        if (events.length === 0) text.push('No activity for this day.');
        for (const event of events) {
          const status = event.ok === false ? ' (failed)' : '';
          text.push(`- ${event.time ?? ''} ${event.kind ?? 'event'}: ${event.title ?? ''}${status}${event.summary ? `. ${event.summary.replace(/\s+/g, ' ')}` : ''}`);
        }

        return {
          content: [{ type: 'text' as const, text: text.join('\n') }],
          structuredContent: {
            kind,
            agentGuid: guid,
            logs: {
              available: true,
              ...(logDate ? { date: logDate } : {}),
              ...(totalLines !== null ? { totalLines: Math.max(0, Math.trunc(totalLines)) } : {}),
              events,
            },
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
