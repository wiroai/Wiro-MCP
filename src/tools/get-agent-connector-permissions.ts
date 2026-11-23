import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { ApiResultError, errorResult, hasErrorCode } from '../utils/api.js';
import {
  approvalSchema,
  formatApproval,
  waitingApproval,
  waitingApprovalNote,
  type Approval,
} from '../utils/agent-approvals.js';
import { CONNECTOR_SLUG } from '../utils/agent-connectors.js';
import {
  CATEGORY_TITLES,
  COLUMN_TITLES,
  PERMISSION_COLUMNS,
  PERMISSION_DEFAULTS_TEXT,
  PERMISSIONS_EXPLAINED,
  permissionActionSchema,
  permissionCategorySchema,
  permissionValueSchema,
  publicAction,
  readConnectorPermissions,
  valueTitle,
  VALUE_TITLES,
  WIRO_SCOPE_NOTE,
  type ConnectorPermissions,
  type PermissionAction,
  type PermissionCategoryView,
} from '../utils/connector-permissions.js';
import { quotedSpan } from '../utils/quoted-text.js';
import { nextActionSchema, strictInput } from './schemas.js';

// How many actions of one group the text names one by one, and how many share the group's values on one line. The
// structured result lists every action.
const MAX_ACTION_LINES = 60;
const MAX_SAME_NAMES = 40;

/** The groups, the actions and what an action not listed yet does: what the permission tools return as a view. */
export const permissionsViewSchema = {
  categories: z.array(permissionCategorySchema)
    .describe('The three groups: read (Read-only), create (Create and send), change (Change and delete), with their values in Chat and Autopilot.'),
  actions: z.array(permissionActionSchema)
    .describe('Every action the connection has permissions for, with its values.'),
  unlisted: z.object({ chat: permissionValueSchema, autopilot: permissionValueSchema })
    .describe('What an action the connector has not listed yet does: it follows Change and delete unless it has a setting of its own.'),
  updatedAt: z.string().optional().describe('When the permissions were last changed.'),
};

const outputSchema = {
  agentGuid: z.string(),
  connector: z.string(),
  title: z.string(),
  actionsListed: z.boolean()
    .describe('false: the connector lists its actions after its first connection; until then only the groups can be set.'),
  catalogStatus: z.enum(['active', 'hidden', 'retired']).optional(),
  ...permissionsViewSchema,
  waiting: z.array(approvalSchema)
    .describe('Approval cards a scheduled task, a channel chat or the agent\'s own work asked for, still waiting for an answer, each with its request and its answer_agent_approval step. A card asked in a Telegram, Slack or Discord chat has no step: it is answered there (answeredIn).'),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

/** "Chat Allow, Autopilot Mixed". */
function categoryValues(category: PermissionCategoryView): string {
  return PERMISSION_COLUMNS.map(column => `${COLUMN_TITLES[column]} ${valueTitle(category[column].value)}`).join(', ');
}

/** "Chat Ask, Autopilot Allow (its own setting in Autopilot)". */
function actionValues(action: PermissionAction): string {
  const own = PERMISSION_COLUMNS.filter(column => action.own[column]).map(column => COLUMN_TITLES[column]);
  const notes = [
    ...(own.length > 0 ? [`its own setting in ${own.join(' and ')}`] : []),
    ...(action.hidden ? ['not shown to the agent'] : []),
    ...(action.listed ? [] : ['not listed yet']),
  ];
  return `${PERMISSION_COLUMNS.map(column => `${COLUMN_TITLES[column]} ${VALUE_TITLES[action[column]]}`).join(', ')}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}

/** Whether an action reads exactly as its group: no setting of its own, and the group's values in both columns. */
function asItsGroup(action: PermissionAction, category: PermissionCategoryView): boolean {
  return !action.own.chat && !action.own.autopilot && action.listed
    && PERMISSION_COLUMNS.every(column => category[column].value === action[column]);
}

/** The groups and their actions, in text. */
export function permissionLines(read: Pick<ConnectorPermissions, 'connector' | 'view'>): string[] {
  const lines: string[] = [];
  for (const category of read.view.categories) {
    const actions = read.view.actions.filter(action => action.category === category.key);
    lines.push('', `### ${CATEGORY_TITLES[category.key]} (${category.actions === 1 ? '1 action' : `${category.actions} actions`}): ${categoryValues(category)}`, '', category.description);
    const same = actions.filter(action => asItsGroup(action, category));
    const own = actions.filter(action => !asItsGroup(action, category));
    if (same.length > 0) {
      const named = same.slice(0, MAX_SAME_NAMES).map(action => `\`${action.name}\``).join(', ');
      lines.push(`- As the group: ${named}${same.length > MAX_SAME_NAMES ? `, and ${same.length - MAX_SAME_NAMES} more` : ''}`);
    }
    for (const action of own.slice(0, MAX_ACTION_LINES)) {
      lines.push(`- ${quotedSpan(action.title)} (\`${action.name}\`): ${actionValues(action)}`);
    }
    if (own.length > MAX_ACTION_LINES) lines.push(`- ${own.length - MAX_ACTION_LINES} more actions with values of their own: the structured result lists them.`);
  }
  const unlisted = PERMISSION_COLUMNS.map(column => `${COLUMN_TITLES[column]} ${VALUE_TITLES[read.view.unlisted[column]]}`).join(', ');
  lines.push('', `Actions the connector has not listed yet: ${unlisted}, as Change and delete, unless one has a setting of its own.`
    + (read.connector.actionsListed ? '' : ` ${read.connector.title} lists its actions after its first connection; until then only the groups can be set.`));
  if (read.view.updatedAt) lines.push(`Last changed: ${read.view.updatedAt}.`);
  return lines;
}

/** One sentence that sums up the groups: "Read-only Chat Allow, Autopilot Allow; ...". */
export function permissionSummary(read: Pick<ConnectorPermissions, 'view'>): string {
  const groups = read.view.categories.map(category => `${CATEGORY_TITLES[category.key]}: ${categoryValues(category)}`).join('; ');
  const own = read.view.actions.filter(action => action.own.chat || action.own.autopilot).length;
  const hidden = read.view.actions.filter(action => action.hidden).length;
  return `${groups}.${own > 0 ? ` ${own === 1 ? '1 action has' : `${own} actions have`} a setting of its own.` : ''}`
    + `${hidden > 0 ? ` ${hidden === 1 ? '1 action is' : `${hidden} actions are`} blocked in both columns, so the agent does not see ${hidden === 1 ? 'it' : 'them'}.` : ''}`;
}

/** The view as the permission tools return it. */
export function viewOutput(read: Pick<ConnectorPermissions, 'view'>) {
  return {
    categories: read.view.categories,
    actions: read.view.actions.map(publicAction),
    unlisted: read.view.unlisted,
    ...(read.view.updatedAt ? { updatedAt: read.view.updatedAt } : {}),
  };
}

/** Wiro's refusal of a permission read or change, with who can do it. */
export function permissionError(error: unknown): unknown {
  if (!(error instanceof ApiResultError)) return error;
  if (hasErrorCode(error, 97) || hasErrorCode(error, 96)) {
    return new Error(`${error.message} Only the person who deployed the agent or a team admin of its team can read or `
      + 'change its connector permissions.');
  }
  if (/not connected to the agent/i.test(error.message)) {
    return new Error(`${error.message} Permissions belong to a connection: connect_agent_connector connects it, and `
      + 'list_agent_connectors with agent_guid lists the agent\'s connections.');
  }
  return error;
}

export function registerGetAgentConnectorPermissions(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_agent_connector_permissions',
    {
      title: 'Read a connector\'s permissions',
      description: 'Show what a deployed agent may do with one of its Connectors without asking. Wiro sorts each '
        + 'action into a group: Read-only, Create and send, or Change and delete, and gives it a value in two columns. '
        + `${PERMISSIONS_EXPLAINED} ${PERMISSION_DEFAULTS_TEXT} Each group has a value, and an action can have a setting `
        + 'of its own. It lists the groups with their values (Mixed where their actions differ), every action with its '
        + 'values and defaults, what an action the connector has not listed yet does, and the approval cards that a '
        + 'scheduled task, a channel chat or the agent\'s own work asked for and that still wait, with their requests '
        + '(waiting); answer_agent_approval answers them, except one asked in a Telegram, Slack or Discord chat, which is '
        + 'answered there. set_agent_connector_permissions changes the values. Only '
        + 'the person who deployed the agent or a team admin of its team can read them. Read-only.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100).describe('The deployed agent\'s guid, from list_my_agents.'),
        connector: z.string().min(1).max(100).describe('The connector\'s slug, such as "wordpress". list_agent_connectors with agent_guid lists the agent\'s connections.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, connector }, extra) => {
      try {
        const agentGuid = agent_guid.trim();
        const slug = connector.trim().toLowerCase();
        if (!CONNECTOR_SLUG.test(slug)) throw new Error(`No connector is named "${connector}". list_agent_connectors lists them.`);
        let read: ConnectorPermissions;
        try {
          read = await readConnectorPermissions(client, agentGuid, slug, extra.signal);
        } catch (error) {
          throw permissionError(error);
        }
        const waiting = read.waiting
          .map(item => waitingApproval(item, read.connector, read.view, agentGuid))
          .filter((item): item is Approval => item !== undefined);
        const pending = waiting.filter(item => item.status === 'pending');
        const message = `${read.connector.title} on this agent: ${permissionSummary(read)}`
          + `${pending.length > 0 ? ` ${waitingApprovalNote(pending)}` : ''}`;
        // A card asked in a chat app has no step here: it is answered in that chat.
        const nextAction = pending.find(item => item.nextAction)?.nextAction;
        const lines = [
          `## ${read.connector.title} permissions (\`${read.connector.slug}\`)`,
          '',
          PERMISSIONS_EXPLAINED,
          ...(read.connector.slug === 'wiro' ? ['', WIRO_SCOPE_NOTE] : []),
          ...(read.connector.catalogStatus && read.connector.catalogStatus !== 'active'
            ? ['', `The catalog no longer offers ${read.connector.title} (${read.connector.catalogStatus}), so the connection gives the agent nothing now.`]
            : []),
          ...permissionLines(read),
        ];
        if (waiting.length > 0) {
          lines.push('', '### Waiting for approval', '', 'Scheduled tasks and the agent\'s own work asked for these actions, '
            + 'and an approved one runs in the chat where its card is. An action asked in a Telegram, Slack or Discord chat '
            + 'is answered in that chat.');
          if (pending.length > 0) lines.push(waitingApprovalNote(pending));
          waiting.forEach((approval, index) => lines.push('', ...formatApproval(approval, `Approval ${index + 1}`)));
        }
        if (nextAction) lines.push('', `**Next:** \`${nextAction.tool}\` with the first waiting card. ${nextAction.reason}`);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            agentGuid,
            connector: read.connector.slug,
            title: read.connector.title,
            actionsListed: read.connector.actionsListed,
            ...(read.connector.catalogStatus ? { catalogStatus: read.connector.catalogStatus } : {}),
            ...viewOutput(read),
            waiting,
            message,
            ...(nextAction ? { nextAction } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
