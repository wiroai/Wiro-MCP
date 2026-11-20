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
  type ApiEnvelope,
} from '../utils/api.js';
import {
  categoryList,
  CATEGORY_KEYS,
  DASHBOARD,
  dashboardSchema,
  isSurface,
  isThisConnection,
  isoTime,
  limitLine,
  limitView,
  limitViewSchema,
  readLimitList,
  readRuleList,
  readTeamMembers,
  ruleLine,
  ruleView,
  ruleViewSchema,
  SURFACE_DESCRIPTIONS,
  SURFACE_LABELS,
  SURFACES,
  toCategoryLabels,
  usd,
  utcText,
  whoCanChange,
  type Caller,
  type ControlsWorkspace,
  type LimitList,
  type RuleList,
  type TeamMember,
} from '../utils/controls.js';
import { oneLine, quotedSpan } from '../utils/quoted-text.js';
import { readTeamMemberships, type TeamMembership } from '../utils/workspace.js';
import { keySafeErrorText, readProjects } from '../utils/wiro-project.js';
import { strictInput } from './schemas.js';

/** At most this many rows of each usage breakdown and of the member list are written out; all are in structuredContent. */
const TEXT_ROWS = 20;

const usageRowSchema = z.object({
  spentUsd: z.number(),
  heldUsd: z.number().optional().describe('Held by its work that is still running, until that work is charged or ends.'),
});

const usageSchema = z.object({
  period: z.enum(['month', 'day']),
  periodStart: z.string().optional(),
  resetsAt: z.string().optional(),
  totalUsd: z.number(),
  heldUsd: z.number().optional().describe('Held by work that is still running, until it is charged or ends.'),
  surfaces: z.array(usageRowSchema.extend({ surface: z.enum(SURFACES), label: z.string() })),
  members: z.array(usageRowSchema.extend({ useruuid: z.string(), name: z.string().optional(), thisConnection: z.boolean().optional() })),
  projects: z.array(usageRowSchema.extend({ projectId: z.string(), name: z.string().optional(), thisConnection: z.boolean().optional() })),
  agents: z.array(usageRowSchema.extend({ agentGuid: z.string(), name: z.string().optional() })),
});

type Usage = z.infer<typeof usageSchema>;

const memberSchema = z.object({
  useruuid: z.string().describe('What member takes in manage_spend_limit, manage_model_access and check_model_access.'),
  name: z.string().optional(),
  role: z.enum(['admin', 'member']).optional(),
  thisConnection: z.boolean().optional().describe('True for the person this connection acts as.'),
});

function money(value: unknown): number {
  const amount = toNumber(value);
  return amount === null ? 0 : Math.max(0, Math.round(amount * 1e6) / 1e6);
}

function name(value: unknown): string | undefined {
  const text = asString(value);
  return text?.trim() ? oneLine(text).slice(0, 200) : undefined;
}

/** What a usage row spent, and what its work that is still running holds when it holds anything. */
function amounts(row: Record<string, unknown>): { spentUsd: number; heldUsd?: number } {
  const heldUsd = money(row.heldusd);
  return { spentUsd: money(row.spentusd), ...(heldUsd > 0 ? { heldUsd } : {}) };
}

function toUsage(value: unknown, period: 'month' | 'day', caller: Caller | undefined): Usage {
  const usage = isPlainObject(value) ? value : {};
  const rows = (list: unknown) => (Array.isArray(list) ? list.filter(isPlainObject) : []);
  const periodStart = isoTime(toNumber(usage.periodstart) ?? undefined);
  const resetsAt = isoTime(toNumber(usage.resetsat) ?? undefined);
  const heldUsd = money(usage.heldusd);
  return {
    period: usage.period === 'day' ? 'day' : usage.period === 'month' ? 'month' : period,
    ...(periodStart ? { periodStart } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    totalUsd: money(usage.totalusd),
    ...(heldUsd > 0 ? { heldUsd } : {}),
    surfaces: rows(usage.surfaces).flatMap(row => (isSurface(row.surface)
      ? [{ surface: row.surface, label: SURFACE_LABELS[row.surface], ...amounts(row) }]
      : [])),
    members: rows(usage.members).flatMap(row => {
      const useruuid = asString(row.useruuid);
      const label = name(row.label);
      return useruuid
        ? [{ useruuid, ...(label ? { name: label } : {}), ...(isThisConnection('member', useruuid, caller) ? { thisConnection: true } : {}), ...amounts(row) }]
        : [];
    }),
    projects: rows(usage.projects).flatMap(row => {
      const projectId = asString(row.projectid);
      const label = name(row.label);
      return projectId
        ? [{ projectId, ...(label ? { name: label } : {}), ...(caller?.projectId === projectId ? { thisConnection: true } : {}), ...amounts(row) }]
        : [];
    }),
    agents: rows(usage.agents).flatMap(row => {
      const agentGuid = asString(row.useragentguid);
      const label = name(row.label);
      return agentGuid ? [{ agentGuid, ...(label ? { name: label } : {}), ...amounts(row) }] : [];
    }),
  };
}

/** A usage amount: cents, and "under $0.01" for a fraction of a cent. */
function usageUsd(value: number): string {
  return value > 0 && value < 0.005 ? 'under $0.01' : usd(value);
}

interface BreakdownItem {
  text: string;
  spentUsd: number;
  heldUsd?: number;
}

/** One breakdown of the spending, biggest first: a row that only holds money for running work is listed too. */
function breakdownLine(title: string, items: BreakdownItem[]): string[] {
  const active = items
    .filter(item => item.spentUsd > 0 || (item.heldUsd ?? 0) > 0)
    .sort((a, b) => b.spentUsd - a.spentUsd || (b.heldUsd ?? 0) - (a.heldUsd ?? 0));
  if (active.length === 0) return [];
  const shown = active.slice(0, TEXT_ROWS).map(item => `${item.text} ${usageUsd(item.spentUsd)}`
    + `${item.heldUsd ? ` (${usageUsd(item.heldUsd)} held by work still running)` : ''}`);
  const more = active.length - shown.length;
  return [`- ${title}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`];
}

function usageLines(usage: Usage, kind: ControlsWorkspace['kind']): string[] {
  const since = usage.periodStart ? ` (since ${utcText(Date.parse(usage.periodStart) / 1000)})` : '';
  const lines = ['', `### Spending ${usage.period === 'day' ? 'today' : 'this month'}${since}`, '', `**Total:** ${usageUsd(usage.totalUsd)}`];
  if (usage.heldUsd) lines.push(`**Held by work still running:** ${usageUsd(usage.heldUsd)}`);
  const held = (row: { spentUsd: number; heldUsd?: number }) => ({ spentUsd: row.spentUsd, ...(row.heldUsd ? { heldUsd: row.heldUsd } : {}) });
  lines.push(
    ...breakdownLine('By way in', usage.surfaces.map(row => ({ text: `${row.label} (\`${row.surface}\`)`, ...held(row) }))),
    ...(kind === 'team'
      ? breakdownLine('By team member', usage.members.map(row => ({
        text: `${row.name ? quotedSpan(row.name) : `user id ${quotedSpan(row.useruuid)}`}${row.thisConnection ? ', the person this connection acts as' : ''}`,
        ...held(row),
      })))
      : []),
    ...breakdownLine('By API key', usage.projects.map(row => ({
      text: `${row.name ? `${quotedSpan(row.name)} (id ${quotedSpan(row.projectId)})` : `project id ${quotedSpan(row.projectId)}`}${row.thisConnection ? ', this connection\'s key' : ''}`,
      ...held(row),
    }))),
    ...breakdownLine('By agent', usage.agents.map(row => ({ text: row.name ? quotedSpan(row.name) : `guid ${quotedSpan(row.agentGuid)}`, ...held(row) }))),
  );
  if (usage.totalUsd === 0) lines.push(usage.heldUsd ? 'Nothing was charged in this period yet.' : 'Nothing was spent in this period yet.');
  return lines;
}

function memberLines(members: TeamMember[], caller: Caller | undefined): string[] {
  const lines = ['', `### Team members (${members.length})`, ''];
  const shown = members.slice(0, TEXT_ROWS * 5);
  lines.push(...shown.map(member => `- ${member.name ? quotedSpan(member.name) : quotedSpan(member.email ?? member.uuid)}`
    + `${member.role ? ` (${member.role})` : ''}: user id ${quotedSpan(member.uuid)}`
    + `${isThisConnection('member', member.uuid, caller) ? ', the person this connection acts as' : ''}`));
  if (members.length > shown.length) lines.push(`- and ${members.length - shown.length} more, in structuredContent`);
  return lines;
}

function workspaceLine(workspace: ControlsWorkspace, team: TeamMembership | undefined): string {
  if (workspace.kind !== 'team') return `**Workspace:** ${workspace.kind === 'personal' ? 'personal account' : 'unknown'}`;
  const teamName = team?.teamName?.trim() ? ` ${quotedSpan(team.teamName)}` : '';
  const organization = team?.organizationName?.trim() ? ` (${quotedSpan(team.organizationName)})` : '';
  const role = team?.role === 'admin' ? '; this connection acts as a team admin' : team?.role === 'member' ? '; this connection acts as a team member' : '';
  return `**Workspace:** team${teamName}${organization}${role}`;
}

function callerLine(caller: Caller | undefined, memberName: string | undefined): string[] {
  if (!caller?.surface && !caller?.projectId) return [];
  const surface = caller.surface ? `surface \`${caller.surface}\` (${SURFACE_DESCRIPTIONS[caller.surface]})` : 'an unknown surface';
  const key = caller.projectId ? `, with the API key of project id ${quotedSpan(caller.projectId)}` : '';
  const member = caller.memberUuid
    ? `, as team member ${memberName ? `${quotedSpan(memberName)} (user id ${quotedSpan(caller.memberUuid)})` : `with user id ${quotedSpan(caller.memberUuid)}`}`
    : '';
  return [`**This connection's runs count as:** ${surface}${key}${member}`];
}

/**
 * In a team, the person this connection acts as: its key's project's creator. Read only when a member limit or
 * rule could be theirs. Undefined when it cannot be told.
 */
async function connectionMember(client: WiroClient, caller: Caller | undefined, signal: AbortSignal): Promise<string | undefined> {
  try {
    const projects = await readProjects(client, signal);
    const own = projects.find(project => (caller?.projectId ? project.view.id === caller.projectId : project.view.connected));
    return own?.creator && UUID_TEXT.test(own.creator) ? own.creator : undefined;
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerGetControls(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_controls',
    {
      title: 'Get Wiro Spend Limits and Model Access rules',
      description: 'Show the Controls of the connected project\'s workspace (personal, or a team). Spend Limits '
        + 'cap what it spends in a month or a day, in USD: on the whole wallet, one team member, one API key, one way in '
        + '(surface) or one agent. Each limit comes with what it used this period, what is held by work still running, '
        + 'what is left and when it resets (UTC). Model Access rules allow or block models, by category or one by one, '
        + 'and each comes in plain words. The answer also says whether this connection can change them (the account '
        + 'owner, a team admin or the organization\'s owner can; other team members only read) and which surface, '
        + 'API key and, in a team, member this connection\'s own runs count as. With usage it lists this month\'s or today\'s spending by '
        + 'surface, team member, API key and agent; with members, the team\'s members and their user ids. Free and '
        + 'read-only. Read the controls playbook before changing a limit or a rule.',
      inputSchema: strictInput({
        usage: z.enum(['month', 'day']).optional()
          .describe('Also list this month\'s or today\'s spending (UTC) by surface, team member, API key and agent.'),
        members: z.boolean().optional()
          .describe('In a team, also list the team\'s members with their user ids, to set a limit or a rule per member.'),
      }),
      outputSchema: {
        workspace: z.object({
          kind: z.enum(['personal', 'team', 'unknown']),
          teamGuid: z.string().optional(),
          teamName: z.string().optional(),
          organizationName: z.string().optional(),
          role: z.enum(['admin', 'member']).optional(),
          canManage: z.boolean().describe('Whether this connection can change the Spend Limits and Model Access rules.'),
        }),
        caller: z.object({
          surface: z.enum(SURFACES).optional(),
          projectId: z.string().optional(),
          memberUuid: z.string().optional().describe('In a team, the user id of the person this connection acts as: the creator of its API key\'s project.'),
        }).optional().describe('How this connection\'s own runs count: their surface, the project of the API key and, in a team, the member.'),
        spendLimits: z.array(limitViewSchema).optional(),
        modelAccessRules: z.array(ruleViewSchema).optional(),
        categories: z.array(z.object({ category: z.enum(CATEGORY_KEYS), label: z.string() }))
          .describe('The model categories a rule can name.'),
        surfaces: z.array(z.object({ surface: z.enum(SURFACES), label: z.string(), description: z.string() }))
          .describe('The ways in a limit or a rule can name.'),
        usage: usageSchema.optional(),
        members: z.array(memberSchema).optional(),
        spendLimitsError: z.string().optional(),
        modelAccessError: z.string().optional(),
        usageError: z.string().optional(),
        membersError: z.string().optional(),
        dashboard: dashboardSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ usage, members }, extra) => {
      try {
        const signal = extra.signal;
        const [limitsRead, rulesRead, teamsRead] = await Promise.allSettled([
          readLimitList(client, signal),
          readRuleList(client, signal),
          readTeamMemberships(client, signal),
        ]);
        if (signal.aborted) throw signal.reason ?? new Error('The call was cancelled.');
        const limits: LimitList | undefined = limitsRead.status === 'fulfilled' ? limitsRead.value : undefined;
        const rules: RuleList | undefined = rulesRead.status === 'fulfilled' ? rulesRead.value : undefined;
        if (!limits && !rules) {
          throw new Error(`The controls could not be read: ${errorText((limitsRead as PromiseRejectedResult).reason)}`);
        }

        const workspace: ControlsWorkspace = limits && limits.workspace.kind !== 'unknown'
          ? limits.workspace
          : rules?.workspace ?? limits?.workspace ?? { kind: 'unknown' };
        const canManage = (limits?.workspace.canManage ?? rules?.workspace.canManage) === true;
        const listedCaller = limits?.caller ?? rules?.caller;
        const team = workspace.teamGuid && teamsRead.status === 'fulfilled'
          ? teamsRead.value.find(candidate => candidate.guid === workspace.teamGuid)
          : undefined;
        const labels = rules?.labels ?? toCategoryLabels(undefined);
        const isTeam = workspace.kind === 'team' && Boolean(workspace.teamGuid);
        // A key acts as its project's creator, so in a team one member limit or rule may be this connection's own.
        const memberRows = [...(limits?.limits ?? []), ...(rules?.rules ?? [])].filter(row => row.scope === 'member');

        const [usageRead, membersRead, memberUuid] = await Promise.all([
          usage
            ? client.post<ApiEnvelope & { usage?: unknown }>('/SpendLimit/Usage', { period: usage }, signal)
              .then(body => ({ ok: true as const, body: requireApiSuccess(body, 'The spending could not be read.') }))
              .catch((error: unknown) => ({ ok: false as const, error }))
            : undefined,
          members && isTeam
            ? readTeamMembers(client, workspace.teamGuid as string, signal)
              .then(list => ({ ok: true as const, list }))
              .catch((error: unknown) => ({ ok: false as const, error }))
            : undefined,
          isTeam && memberRows.length > 0 ? connectionMember(client, listedCaller, signal) : undefined,
        ]);
        if (signal.aborted) throw signal.reason ?? new Error('The call was cancelled.');
        const caller: Caller | undefined = memberUuid ? { ...(listedCaller ?? {}), memberUuid } : listedCaller;

        let usageView: Usage | undefined;
        let usageError: string | undefined;
        if (usageRead?.ok) usageView = toUsage(usageRead.body.usage, usage as 'month' | 'day', caller);
        else if (usageRead) usageError = errorText(usageRead.error);

        let memberList: TeamMember[] | undefined;
        let membersError: string | undefined;
        let membersLine: string | undefined;
        if (members && !isTeam) {
          membersError = 'The connected project is not in a team, so this workspace has no team members.';
          membersLine = membersError;
        } else if (membersRead?.ok) {
          memberList = membersRead.list;
        } else if (membersRead) {
          membersError = `${keySafeErrorText(membersRead.error)} Name members by user id; a limit or a rule names its member's user id.`;
          membersLine = `The team's members could not be listed: ${membersError}`;
        }
        const memberName = memberUuid
          ? memberList?.find(member => member.uuid.toLowerCase() === memberUuid.toLowerCase())?.name
            ?? memberRows.find(row => row.target.toLowerCase() === memberUuid.toLowerCase() && row.targetName)?.targetName
          : undefined;

        const lines = ['## Controls of this workspace', '', workspaceLine(workspace, team)];
        lines.push(canManage
          ? '**Changes:** this connection can change these Spend Limits and Model Access rules, with manage_spend_limit and '
            + 'manage_model_access. Every change shows a summary first and waits for the user\'s yes.'
          : `**Changes:** this connection can only read them: ${whoCanChange(workspace.kind)} changes them, with their own `
            + 'connection or in the Wiro dashboard.');
        lines.push(...callerLine(caller, memberName));

        const spendLimits = limits?.limits.map(row => limitView(row, caller));
        lines.push('', `### Spend limits${limits ? ` (${limits.limits.length})` : ''}`, '');
        if (!limits) {
          lines.push(`The spend limits could not be read: ${errorText((limitsRead as PromiseRejectedResult).reason)}`);
        } else if (limits.limits.length === 0) {
          lines.push('No spend limits: nothing caps this workspace\'s spending beyond its balance.');
        } else {
          lines.push(...limits.limits.map(row => limitLine(row, workspace.kind, caller)));
        }

        const modelAccessRules = rules?.rules.map(rule => ruleView(rule, labels, caller));
        lines.push('', `### Model Access rules${rules ? ` (${rules.rules.length})` : ''}`, '');
        if (!rules) {
          lines.push(`The Model Access rules could not be read: ${errorText((rulesRead as PromiseRejectedResult).reason)}`);
        } else if (rules.rules.length === 0) {
          lines.push('No Model Access rules: every model can run.');
        } else {
          lines.push(...rules.rules.map(rule => ruleLine(rule, labels, workspace.kind, caller)));
        }
        lines.push('', 'Every limit and every rule that applies to a run must allow it, so a narrower one cannot open what a '
          + 'wider one blocks. Periods are in UTC.');
        lines.push(`Categories a rule can name: ${CATEGORY_KEYS.map(key => `\`${key}\` (${labels[key]})`).join(', ')}.`);

        if (usageView) lines.push(...usageLines(usageView, workspace.kind));
        if (usageError) lines.push('', `The spending could not be read: ${usageError}`);
        if (memberList) lines.push(...memberLines(memberList, caller));
        if (membersLine) lines.push('', membersLine);
        lines.push('', `Dashboard: ${DASHBOARD.spendLimits} and ${DASHBOARD.modelAccess}`);

        const spendLimitsError = limits ? undefined : errorText((limitsRead as PromiseRejectedResult).reason);
        const modelAccessError = rules ? undefined : errorText((rulesRead as PromiseRejectedResult).reason);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            workspace: {
              kind: workspace.kind,
              ...(workspace.teamGuid ? { teamGuid: workspace.teamGuid } : {}),
              ...(team?.teamName ? { teamName: team.teamName } : {}),
              ...(team?.organizationName ? { organizationName: team.organizationName } : {}),
              ...(team?.role ? { role: team.role } : {}),
              canManage,
            },
            ...(caller && (caller.surface || caller.projectId || caller.memberUuid) ? { caller } : {}),
            ...(spendLimits ? { spendLimits } : {}),
            ...(modelAccessRules ? { modelAccessRules } : {}),
            categories: categoryList(labels),
            surfaces: SURFACES.map(surface => ({ surface, label: SURFACE_LABELS[surface], description: SURFACE_DESCRIPTIONS[surface] })),
            ...(usageView ? { usage: usageView } : {}),
            ...(memberList
              ? {
                members: memberList.map(member => ({
                  useruuid: member.uuid,
                  ...(member.name ?? member.email ? { name: member.name ?? member.email } : {}),
                  ...(member.role ? { role: member.role } : {}),
                  ...(isThisConnection('member', member.uuid, caller) ? { thisConnection: true } : {}),
                })),
              }
              : {}),
            ...(spendLimitsError ? { spendLimitsError } : {}),
            ...(modelAccessError ? { modelAccessError } : {}),
            ...(usageError ? { usageError } : {}),
            ...(membersError ? { membersError } : {}),
            dashboard: DASHBOARD,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

