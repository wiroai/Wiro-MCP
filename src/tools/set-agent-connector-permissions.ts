import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, errorResult, isPlainObject, requireApiSuccess, toInteger, type ApiEnvelope } from '../utils/api.js';
import { CONNECTOR_SLUG } from '../utils/agent-connectors.js';
import {
  PERMISSION_COLUMNS,
  PERMISSION_DEFAULTS_TEXT,
  PERMISSIONS_EXPLAINED,
  moveLines,
  normalizedChanges,
  permissionStateDigest,
  permissionValueSchema,
  planChanges,
  readConnectorPermissions,
  requestLines,
  toPermissionView,
  WIRO_SCOPE_NOTE,
  type ConnectorPermissions,
  type PermissionChanges,
  type PermissionPlan,
} from '../utils/connector-permissions.js';
import { summaryId, summaryIdSchema } from '../utils/controls.js';
import { jsonSpan } from '../utils/quoted-text.js';
import type { NextAction } from '../utils/structured.js';
import { permissionError, permissionLines, permissionSummary, permissionsViewSchema, viewOutput } from './get-agent-connector-permissions.js';
import { nextActionSchema, strictInput } from './schemas.js';

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_TOOL_SETTINGS = 500;

const cellsSchema = z.strictObject({
  chat: permissionValueSchema.nullable().optional()
    .describe('allow, ask or block when someone is talking to the agent; null removes the setting.'),
  autopilot: permissionValueSchema.nullable().optional()
    .describe('allow, ask or block in scheduled tasks and the work before and after a voice call (other work the agent does on its own takes the stricter of chat and autopilot); null removes the setting.'),
});

const outputSchema = {
  agentGuid: z.string(),
  connector: z.string(),
  title: z.string(),
  outcome: z.enum(['summary', 'saved', 'no_change'])
    .describe('summary: what the change does, and nothing is saved yet. saved: Wiro saved it. no_change: the permissions are already this.'),
  changes: z.array(z.object({
    action: z.string().nullable().describe('The action\'s title; null for the actions the connector has not listed yet.'),
    name: z.string().optional(),
    column: z.enum(PERMISSION_COLUMNS),
    from: permissionValueSchema,
    to: permissionValueSchema,
  })).describe('Every value the agent works with that the change moves, by action and column.'),
  restarts: z.boolean().optional()
    .describe('summary: whether saving restarts a running agent. Any change other than Ask to Allow does.'),
  hides: z.array(z.string()).optional().describe('Actions the change blocks in both columns, so the agent stops seeing them.'),
  shows: z.array(z.string()).optional().describe('Actions blocked in both columns now that the agent sees again after the change.'),
  applied: z.number().int().nonnegative().optional().describe('saved: 1 when Wiro changed the permissions, 0 when they were already this.'),
  restart: z.enum(['scheduled', 'none', 'failed']).optional()
    .describe('saved: scheduled (the running agent restarts to use them), none, or failed (they apply at its next start).'),
  permissions: z.object(permissionsViewSchema).optional().describe('saved: the permissions as they are now.'),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type SetBody = ApiEnvelope & { applied?: unknown; restart?: unknown; permissions?: unknown };

interface Input {
  agent_guid: string;
  connector: string;
  reset?: boolean;
  categories?: PermissionChanges['categories'];
  tools?: PermissionChanges['tools'];
  confirm: boolean;
  summary_id?: string;
}

/** Why a requested action cannot be set, as Wiro says it: a name the connection does not list. */
function unknownActionError(read: ConnectorPermissions, names: string[]): Error | undefined {
  const listed = new Set(read.view.actions.map(action => action.name));
  const missing = names.filter(name => !listed.has(name));
  if (missing.length === 0) return undefined;
  if (!read.connector.actionsListed) {
    return new Error(`${read.connector.title}'s actions are listed after its first connection, so only its groups `
      + '(categories) can be set now. Nothing was saved.');
  }
  return new Error(`${missing.map(name => `"${name}"`).join(', ')} ${missing.length === 1 ? 'is not one of' : 'are not among'} `
    + `${read.connector.title}'s actions. get_agent_connector_permissions lists them by name. Nothing was saved.`);
}

/** The restart line of a summary. */
function restartText(plan: PermissionPlan): string {
  if (plan.moves.length === 0) return 'Nothing the agent may do changes, so it does not restart.';
  return plan.restarts
    ? 'Saving restarts a running agent, which takes about a minute: any change other than Ask to Allow reaches it only with a restart.'
    : 'Saving needs no restart: every change turns Ask into Allow, which the agent picks up the next time it asks.';
}

/** A warning when the change lets actions run with no one approving them. */
function allowWarning(plan: PermissionPlan): string | undefined {
  const toAllow = plan.moves.filter(move => move.to === 'allow' && move.from !== 'allow');
  if (toAllow.length === 0) return undefined;
  const autopilot = toAllow.some(move => move.column === 'autopilot');
  return `Allow lets ${toAllow.length === 1 ? 'that action run without anyone approving it' : 'those actions run without anyone approving them'}`
    + `${autopilot ? ', in Autopilot also from scheduled tasks and the work before and after a voice call, with no one watching' : ''}. Make sure the user wants that.`;
}

function summaryResult(input: Input, read: ConnectorPermissions, changes: PermissionChanges, plan: PermissionPlan, id: string, lead?: string) {
  const titles = new Map(read.view.actions.map(action => [action.name, action.title]));
  const nextAction: NextAction = {
    tool: 'set_agent_connector_permissions',
    arguments: {
      agent_guid: input.agent_guid.trim(),
      connector: read.connector.slug,
      ...changes,
      confirm: true,
      summary_id: id,
    },
    reason: 'Ask the user to confirm this first. Repeat it exactly: a confirm saves only the change this summary shows.',
  };
  const warning = allowWarning(plan);
  const message = [
    lead ?? '',
    `This changes the ${read.connector.title} permissions of the agent, and nothing is saved yet.`,
    plan.moves.length > 0
      ? `${plan.moves.length === 1 ? '1 value changes' : `${plan.moves.length} values change`} for the agent.`
      : 'What the agent may do stays the same; only the saved settings change.',
    restartText(plan),
    warning ?? '',
    'After the user agrees, repeat the call as the nextAction shows.',
  ].filter(Boolean).join(' ');
  const lines = [
    `## ${read.connector.title} permissions: change summary (nothing saved yet)`,
    '',
    ...(lead ? [lead, ''] : []),
    'Requested:',
    ...requestLines(changes, titles),
    '',
    'What changes for the agent:',
    ...(plan.moves.length > 0 ? moveLines(plan.moves) : ['- Nothing it may do changes: only the saved settings do.']),
    ...(plan.hides.length > 0 ? [`- Blocked in Chat and Autopilot, so the agent stops seeing them: ${plan.hides.join(', ')}.`] : []),
    ...(plan.shows.length > 0 ? [`- No longer blocked in both columns, so the agent sees them again: ${plan.shows.join(', ')}.`] : []),
    '',
    `**Restart:** ${restartText(plan)}`,
    ...(warning ? ['', `**Note:** ${warning}`] : []),
    ...(read.connector.slug === 'wiro' ? ['', WIRO_SCOPE_NOTE] : []),
    '',
    `**Next:** after the user's yes, \`set_agent_connector_permissions\` with ${jsonSpan(nextAction.arguments)}.`,
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      agentGuid: input.agent_guid.trim(),
      connector: read.connector.slug,
      title: read.connector.title,
      outcome: 'summary' as const,
      changes: plan.moves.map(move => ({ ...move })),
      restarts: plan.restarts,
      ...(plan.hides.length > 0 ? { hides: plan.hides } : {}),
      ...(plan.shows.length > 0 ? { shows: plan.shows } : {}),
      message,
      nextAction,
    },
  };
}

/** What Wiro's answer to a save says about the restart, in words. */
function savedRestartText(restart: 'scheduled' | 'none' | 'failed' | undefined, plan: PermissionPlan): string {
  switch (restart) {
    case 'scheduled':
      return 'The running agent restarts to use them, which takes about a minute.';
    case 'failed':
      return 'The agent could not restart, so the change applies at its next start: control_agent with action restart loads it now.';
    default:
      return plan.restarts
        ? 'Nothing restarted: the agent loads them the next time it starts, or when the connector connects.'
        : 'No restart was needed: every change turns Ask into Allow, which the agent picks up the next time it asks.';
  }
}

async function save(client: WiroClient, input: Input, read: ConnectorPermissions, changes: PermissionChanges, plan: PermissionPlan, signal: AbortSignal) {
  const body = requireApiSuccess(
    await client.post<SetBody>('/UserAgent/ConnectorSetPermissions', {
      useragentguid: input.agent_guid.trim(),
      slug: read.connector.slug,
      ...changes,
    }, signal),
    `The ${read.connector.title} permissions could not be saved.`,
  );
  const applied = toInteger(body.applied, 1);
  const restartValue = asString(body.restart);
  const restart = restartValue === 'scheduled' || restartValue === 'none' || restartValue === 'failed' ? restartValue : undefined;
  const after = isPlainObject(body.permissions) ? { connector: read.connector, view: toPermissionView(body.permissions) } : undefined;
  const message = applied === 0
    ? `The ${read.connector.title} permissions were already this, so nothing changed and the agent does not restart.`
    : `Saved the ${read.connector.title} permissions. ${savedRestartText(restart, plan)}`;
  const lines = [
    `## ${read.connector.title} permissions ${applied === 0 ? 'unchanged' : 'saved'}`,
    '',
    message,
    ...(after ? ['', permissionSummary(after), ...permissionLines(after)] : []),
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      agentGuid: input.agent_guid.trim(),
      connector: read.connector.slug,
      title: read.connector.title,
      outcome: applied === 0 ? 'no_change' as const : 'saved' as const,
      changes: applied === 0 ? [] : plan.moves.map(move => ({ ...move })),
      applied,
      ...(restart ? { restart } : {}),
      ...(after ? { permissions: viewOutput(after) } : {}),
      message,
    },
  };
}

export function registerSetAgentConnectorPermissions(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'set_agent_connector_permissions',
    {
      title: 'Change a connector\'s permissions',
      description: 'Change what a deployed agent may do with one of its Connectors without asking. Set a group '
        + '(categories: read is Read-only, create is Create and send, change is Change and delete) or one action (tools, '
        + 'by its name from get_agent_connector_permissions), each in two columns: chat and autopilot, each allow, ask '
        + `or block. ${PERMISSIONS_EXPLAINED} null removes a setting: a group's column goes back to its default, an `
        + 'action\'s to its group\'s. Setting a group\'s column also clears that column from its actions\' own settings. '
        + `reset: true first puts every group and action back to the defaults. ${PERMISSION_DEFAULTS_TEXT} Call it `
        + 'without confirm first: it shows what changes for the agent and whether a running agent restarts (any change '
        + 'other than Ask to Allow does), and saves nothing. After the user agrees, repeat the call as its nextAction '
        + 'shows, with confirm: true and summary_id; a confirm saves only the change its summary showed. Only the '
        + 'person who deployed the agent or a team admin of its team can change them. Always allow on an approval card '
        + '(answer_agent_approval) also sets an action to Allow.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100).describe('The deployed agent\'s guid, from list_my_agents.'),
        connector: z.string().min(1).max(100).describe('The connected connector\'s slug, such as "wordpress".'),
        reset: z.boolean().optional()
          .describe('true: every group and action goes back to its default first, then categories and tools apply.'),
        categories: z.strictObject({
          read: cellsSchema.optional().describe('Read-only: looks things up and changes nothing.'),
          create: cellsSchema.optional().describe('Create and send: creates or sends something new, such as a post, a message or an email.'),
          change: cellsSchema.optional().describe('Change and delete: changes or deletes what is already there.'),
        }).optional().describe('Group values, such as {"create": {"chat": "allow"}}.'),
        tools: z.record(z.string().regex(TOOL_NAME), cellsSchema)
          .refine(value => Object.keys(value).length <= MAX_TOOL_SETTINGS, `At most ${MAX_TOOL_SETTINGS} actions in one call.`)
          .optional()
          .describe('Action values by the action\'s name, such as {"delete_post": {"chat": "block"}}.'),
        confirm: z.boolean().default(false)
          .describe('Set true only by repeating the change summary\'s nextAction, after the user approved that summary.'),
        summary_id: summaryIdSchema,
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Setting the same values again changes nothing.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const input = args as Input;
      try {
        const slug = input.connector.trim().toLowerCase();
        if (!CONNECTOR_SLUG.test(slug)) throw new Error(`No connector is named "${input.connector}". list_agent_connectors lists them.`);
        const changes = normalizedChanges({ reset: input.reset, categories: input.categories, tools: input.tools });
        if (!changes.reset && !changes.categories && !changes.tools) {
          throw new Error('Pass reset, categories or tools: there is nothing to change. get_agent_connector_permissions shows the permissions now.');
        }
        let read: ConnectorPermissions;
        try {
          read = await readConnectorPermissions(client, input.agent_guid.trim(), slug, extra.signal);
        } catch (error) {
          throw permissionError(error);
        }
        if (read.connector.catalogStatus === 'retired') throw new Error(`${read.connector.title} is no longer offered. Nothing was saved.`);
        const unknown = unknownActionError(read, Object.keys(changes.tools ?? {}));
        if (unknown) throw unknown;
        const plan = planChanges(read.view, changes);
        if (!plan.stored) {
          const message = `The ${read.connector.title} permissions are already this, so nothing changes and nothing was saved.`;
          return {
            content: [{ type: 'text' as const, text: `## ${read.connector.title} permissions unchanged\n\n${message}` }],
            structuredContent: {
              agentGuid: input.agent_guid.trim(),
              connector: read.connector.slug,
              title: read.connector.title,
              outcome: 'no_change' as const,
              changes: [],
              message,
            },
          };
        }
        const id = summaryId(client, {
          tool: 'set_agent_connector_permissions',
          agent: input.agent_guid.trim(),
          connector: read.connector.slug,
          state: permissionStateDigest(read.view),
          changes,
        });
        if (!input.confirm) return summaryResult(input, read, changes, plan, id);
        if (input.summary_id === undefined) {
          return summaryResult(input, read, changes, plan, id,
            'This call did not repeat a change summary\'s nextAction, so nothing was saved. Show this summary and ask the user.');
        }
        if (input.summary_id !== id) {
          return summaryResult(input, read, changes, plan, id,
            'The permissions changed after the summary you showed, or this call asks for another change, so nothing was saved. Show this summary and ask the user again.');
        }
        try {
          return await save(client, input, read, changes, plan, extra.signal);
        } catch (error) {
          throw permissionError(error);
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
