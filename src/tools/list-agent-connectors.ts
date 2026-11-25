import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, truncate } from '../utils/api.js';
import { loadCredentialMeta } from '../utils/agent-config.js';
import {
  CONNECTION_STATUSES,
  CONNECT_WAYS,
  accountsText,
  connectionOf,
  connectionSchema,
  connectionStateText,
  connectorLabel,
  connectorSchema,
  fieldsForMode,
  listCatalog,
  listConnections,
  readConnector,
  signsIn,
  waysText,
  withCatalogWay,
  type AgentConnection,
  type CatalogConnector,
  type ConnectorField,
} from '../utils/agent-connectors.js';
import { quotedSpan } from '../utils/quoted-text.js';
import type { NextAction } from '../utils/user-agent.js';
import { nextActionSchema, strictInput } from './schemas.js';

const connectorSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  ways: z.array(z.enum(CONNECT_WAYS)),
  accountPickers: z.number().int().nonnegative().describe('How many account choices it has once connected.'),
  tools: z.number().int().nonnegative().describe('How many tools the agent gets from it, as far as the catalog has listed them.'),
  status: z.enum([...CONNECTION_STATUSES, 'not_connected']).optional()
    .describe('With agent_guid: its state on that agent.'),
});

type ConnectorSummary = z.infer<typeof connectorSummarySchema>;

const outputSchema = {
  connectors: z.array(connectorSummarySchema),
  total: z.number().int().nonnegative(),
  connector: connectorSchema.optional().describe('With name: the connector in full.'),
  connections: z.array(connectionSchema).optional()
    .describe('With agent_guid: the agent\'s connections, every state.'),
  credential: z.object({
    key: z.string(),
    title: z.string(),
    kind: z.enum(['channel', 'credential']),
  }).optional().describe('Set when name is a chat channel or another credential rather than a connector: set_agent_credentials sets it.'),
  nextAction: nextActionSchema.optional(),
};

const DESCRIPTION_IN_LIST = 160;

function summaryOf(connector: CatalogConnector, connections: AgentConnection[] | null): ConnectorSummary {
  const connection = connections ? connectionOf(connections, connector.slug) : undefined;
  return {
    slug: connector.slug,
    title: connector.title,
    ...(connector.description ? { description: truncate(connector.description, DESCRIPTION_IN_LIST) } : {}),
    ...(connector.category ? { category: connector.category } : {}),
    ways: connector.ways,
    accountPickers: connector.accountPickers.length,
    tools: connector.tools.length,
    ...(connections ? { status: connection?.status ?? 'not_connected' as const } : {}),
  };
}

function wayShort(connector: Pick<CatalogConnector, 'ways'>): string {
  const words: Record<string, string> = { key: 'key', sign_in: 'sign-in', project: 'Wiro project', none: 'nothing to enter' };
  return connector.ways.map(way => words[way]).join(' or ');
}

function summaryLine(connector: CatalogConnector, connections: AgentConnection[] | null): string {
  // Account choices are made once it is connected, for a sign-in served by the vendor too (TikTok Ads advertisers).
  const accountChoices = connector.accountPickers.length > 0
    ? `account choices: ${connector.accountPickers.map(picker => picker.label).join(', ')}`
    : '';
  const details = [connector.category, wayShort(connector), accountChoices].filter(Boolean).join(', ');
  const state = connections ? ` [${connectionStateText(connectionOf(connections, connector.slug))}]` : '';
  const description = connector.description ? `: ${truncate(connector.description, DESCRIPTION_IN_LIST)}` : '';
  return `- **${connector.title}** (\`${connector.slug}\`, ${details})${state}${description}`;
}

function connectionLine(connection: AgentConnection): string {
  const accounts = accountsText(connection);
  const since = connection.status === 'connected' && connection.connectedAt ? ` since ${connection.connectedAt}` : '';
  return `- ${connectorLabel(connection)}: ${connectionStateText(connection)}${since}${accounts ? `; ${accounts}` : ''}`;
}

function fieldFlags(field: ConnectorField, hybrid: boolean): string {
  return [
    field.required ? 'required' : 'optional',
    field.secret ? 'secret' : null,
    field.format !== 'text' && field.format !== 'password' ? field.format : null,
    field.options ? `one of: ${field.options.map(option => option.value).join(', ')}` : null,
    field.appKey ? 'a key of the user\'s own app, used only to sign in' : null,
    hybrid && field.mode ? `only with mode ${field.mode}` : null,
    field.project ? 'filled from a Wiro project: pass project_id' : null,
  ].filter(Boolean).join(', ');
}

function fieldLines(field: ConnectorField, hybrid: boolean): string[] {
  const lines = [`- **${field.label}** (\`${field.name}\`, ${fieldFlags(field, hybrid)})`];
  if (field.description) lines.push(...field.description.split(/\r?\n/).map(line => `  ${line}`));
  return lines;
}

/** The required values a connect in this mode still needs, by label, leaving out what the connection holds. */
function stillNeeded(connector: CatalogConnector, connection: AgentConnection | undefined, mode?: 'sign_in' | 'key'): string[] {
  return fieldsForMode(connector, mode)
    .filter(field => field.required && !field.project && !connection?.savedFields.includes(field.name))
    .map(field => field.label);
}

function detailNextAction(connector: CatalogConnector, agentGuid: string | undefined, connection: AgentConnection | undefined): NextAction | undefined {
  if (!agentGuid) return undefined;
  const args = { action: 'connect', agent_guid: agentGuid, connector: connector.slug };
  if (connection?.status === 'pending') {
    return {
      tool: 'connect_agent_connector',
      arguments: { action: 'status', agent_guid: agentGuid, connector: connector.slug },
      reason: 'A sign-in was started and has not finished. This checks whether the user has approved it.',
    };
  }
  if (connection?.status === 'connected') {
    const unpicked = connector.accountPickers.filter(picker => !connection.accounts[picker.key]?.length);
    return unpicked.length > 0
      ? {
        tool: 'set_agent_connector_accounts',
        arguments: { agent_guid: agentGuid, connector: connector.slug },
        reason: `List the ${unpicked.map(picker => picker.label).join(' and ')} to choose from; none ${unpicked.length > 1 ? 'are' : 'is'} chosen yet.`,
      }
      : undefined;
  }
  const needed = stillNeeded(connector, connection);
  if (needed.length > 0) {
    return {
      tool: 'connect_agent_connector',
      arguments: args,
      reason: `Ask the user for ${needed.join(', ')}, then call it with them in values. Never ask for them in a message to an agent.`,
    };
  }
  if (connector.ways.includes('project')) {
    return {
      tool: 'connect_agent_connector',
      arguments: args,
      reason: 'This shows which Wiro project the connector would use and which wallet pays for its model runs, and changes nothing without confirm: true.',
    };
  }
  return {
    tool: 'connect_agent_connector',
    arguments: args,
    reason: signsIn(connector)
      ? 'This returns the sign-in link for the user to open in their own browser.'
      : 'This connects it; get the user\'s yes first.',
  };
}

function formatDetail(connector: CatalogConnector, connection: AgentConnection | undefined, agentGuid: string | undefined): string {
  const hybrid = connector.ways.includes('sign_in') && connector.ways.includes('key');
  const lines = [`## ${connector.title} (\`${connector.slug}\`)`, ''];
  if (connector.description) lines.push(connector.description, '');
  if (connector.category) lines.push(`**Category:** ${connector.category}`);
  lines.push(`**Connects with:** ${waysText(connector.ways)}${hybrid ? ' (mode sign_in or key)' : ''}`);
  if (connector.websiteUrl) lines.push(`**Website:** ${connector.websiteUrl}`);
  if (agentGuid) {
    const accounts = connection ? accountsText(connection, connector.accountPickers) : '';
    lines.push(`**On this agent:** ${connectionStateText(connection)}${connection?.connectedAt && connection.status === 'connected' ? ` since ${connection.connectedAt}` : ''}${accounts ? `; ${accounts}` : ''}${connection?.savedFields.length ? `; saved: ${connection.savedFields.join(', ')}` : ''}`);
  }
  const typed = connector.fields.filter(field => !field.project);
  if (typed.length > 0) {
    lines.push('', '### What the user provides', '');
    if (signsIn(connector)) {
      lines.push(connector.fields.some(field => field.appKey)
        ? 'The sign-in uses the user\'s own app at the service: its keys go in values with the connect call, and its consent page shows that app.'
        : 'The sign-in takes these values with the connect call.');
      if (connector.wiroApp) {
        lines.push('It also signs in with Wiro\'s own app, with nothing to type, but only on the agent\'s Connectors tab in the Wiro web app: a sign-in through this server always uses the user\'s own app.');
      }
      lines.push('');
    }
    for (const field of typed) lines.push(...fieldLines(field, hybrid));
  } else if (connector.ways.includes('sign_in')) {
    lines.push('', 'Nothing to type: connect returns a sign-in link, and the user approves access in their own browser.');
  }
  if (connector.ways.includes('project')) {
    lines.push('', 'It runs with the agent\'s own Wiro project, the one its video and voice skills use: connecting it '
      + 'with connect_agent_connector (project_id from list_projects, or the project of this connection) binds that '
      + 'project to the agent, as bind_agent_project does. Its calls count as the agent\'s own: the agent\'s spend '
      + 'limits and Model Access rules apply, model runs are billed to the wallet of the workspace that owns the '
      + 'project, and account, agent and billing calls are refused.');
    if (agentGuid && connection?.status === 'connected') {
      lines.push(connection.projectId
        ? `On this agent it runs with the project with id ${quotedSpan(connection.projectId)}.`
        : 'The agent has no Wiro project now, so the connector gives it nothing until one is bound with connect_agent_connector or bind_agent_project.');
    }
  }
  if (connector.accountPickers.length > 0) {
    lines.push('', '### Account choices', '', 'Once it is connected, set_agent_connector_accounts lists these and saves the ones the agent may use; it acts only on those.', '');
    for (const picker of connector.accountPickers) {
      lines.push(`- **${picker.label}** (\`${picker.key}\`, ${picker.multiple ? 'one or more' : 'one'})${picker.description ? `: ${picker.description}` : ''}`);
    }
  }
  if (connector.tools.length > 0) {
    lines.push('', `### Tools the agent gets (named ${connector.slug}__<tool>)`, '');
    for (const tool of connector.tools) {
      const kind = tool.readOnly ? 'reads' : tool.destructive ? 'changes or deletes' : 'writes';
      lines.push(`- \`${tool.name}\` (${kind})${tool.description ? `: ${quotedSpan(tool.description)}` : ''}`);
    }
    lines.push('', 'A custom skill (manage_agent_custom_skill) can tell the agent when and how to use them.');
  }
  if (connector.docs) {
    const { overview, setup, revoke, limits } = connector.docs;
    if (overview || setup.length > 0) lines.push('', '### Setup', '');
    if (overview) lines.push(overview);
    setup.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    if (revoke) lines.push('', `**Revoke access:** ${revoke}`);
    if (limits) lines.push('', `**Limits:** ${limits}`);
  }
  return lines.join('\n');
}

export function registerListAgentConnectors(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_agent_connectors',
    {
      title: 'List agent connectors',
      description: 'List the Connectors a Wiro agent can connect: outside services such as ad accounts, stores, '
        + 'social accounts, mailboxes and data sources. A connected connector gives the agent its tools '
        + '(<connector>__<tool>); every plan includes every connector. Without name it lists the catalog with how '
        + 'each one connects: key (values typed on its Connect card, such as an API key), sign_in (a link the user '
        + 'approves in their own browser) or project (a Wiro project). search and category narrow the list. Pass name '
        + 'with a connector\'s slug for that connector in full: each value to ask the user for with where it comes '
        + 'from, the account choices to make once connected, the tools the agent gets and the setup and revoke steps. '
        + 'With agent_guid, each connector also shows its state on that agent and the agent\'s connections are listed. '
        + 'connect_agent_connector connects one. Chat channels such as Telegram are not connectors: set_agent_credentials '
        + 'sets them.',
      inputSchema: strictInput({
        name: z.string().min(1).max(100).optional()
          .describe('A connector\'s slug, such as "google-ads" or "serper": returns that connector in full.'),
        search: z.string().max(100).optional()
          .describe('Words to look for in the catalog, such as "ads" or "email".'),
        category: z.string().max(40).optional()
          .describe('Only connectors of this category, such as "marketing" or "crm".'),
        agent_guid: z.string().min(1).max(100).optional()
          .describe('A deployed agent\'s guid, from list_my_agents: adds each connector\'s state on that agent and lists its connections.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name, search, category, agent_guid }, extra) => {
      try {
        const agentGuid = agent_guid?.trim() || undefined;
        const connections = agentGuid ? await listConnections(client, agentGuid, extra.signal) : null;

        if (name) {
          const slug = name.trim().toLowerCase();
          const connector = await readConnector(client, slug, extra.signal);
          if (!connector) {
            const credential = await loadCredentialMeta(client, slug, extra.signal).catch(() => null);
            if (credential && !slug.startsWith('sys-')) {
              const kind = credential.channel ? 'channel' as const : 'credential' as const;
              const what = kind === 'channel' ? 'a chat channel' : 'a credential of the agent';
              return {
                content: [{ type: 'text' as const, text: `## ${credential.title} (\`${slug}\`)\n\n${credential.title} is ${what}, not a connector. set_agent_credentials with credential "${slug}" shows its fields and saves them.` }],
                structuredContent: {
                  connectors: [],
                  total: 0,
                  ...(connections ? { connections } : {}),
                  credential: { key: slug, title: credential.title, kind },
                  nextAction: agentGuid
                    ? {
                      tool: 'set_agent_credentials',
                      arguments: { agent_guid: agentGuid, credential: slug },
                      reason: `See the ${credential.title} fields before asking the user for them.`,
                    }
                    : {
                      tool: 'list_agent_skills',
                      arguments: { name: slug },
                      reason: `See the ${credential.title} fields.`,
                    },
                },
              };
            }
            return errorResult(new Error(`No connector is named "${slug}". list_agent_connectors without name lists them, and search narrows the list.`));
          }
          const listed = connections ? connectionOf(connections, connector.slug) : undefined;
          const connection = listed ? withCatalogWay(listed, connector) : undefined;
          const nextAction = detailNextAction(connector, agentGuid, connection);
          return {
            content: [{ type: 'text' as const, text: formatDetail(connector, connection, agentGuid) }],
            structuredContent: {
              connectors: [summaryOf(connector, connections)],
              total: 1,
              connector,
              ...(connections ? { connections: connection ? [connection] : [] } : {}),
              ...(nextAction ? { nextAction } : {}),
            },
          };
        }

        const catalog = await listCatalog(client, { search: search?.trim(), category: category?.trim().toLowerCase() }, extra.signal);
        const listed = new Set(catalog.map(connector => connector.slug));
        const lines = [`## Agent connectors (${catalog.length})`, ''];
        if (catalog.length === 0) lines.push(search || category ? 'No connector matched.' : 'The catalog lists no connectors right now.');
        for (const connector of catalog) lines.push(summaryLine(connector, connections));
        const elsewhere = (connections ?? []).filter(connection => !listed.has(connection.connector));
        if (connections && (search || category) && elsewhere.length > 0) {
          lines.push('', '### Other connections of this agent', '', ...elsewhere.map(connectionLine));
        } else if (connections && !search && !category && elsewhere.length > 0) {
          lines.push('', '### Connections the catalog no longer offers', '', ...elsewhere.map(connectionLine));
        }
        if (connections && connections.length === 0) lines.push('', 'This agent has no connections yet.');
        lines.push('', 'list_agent_connectors with name shows what a connector needs and the tools the agent gets; connect_agent_connector connects it.');
        const only = catalog.length === 1 ? catalog[0] : undefined;
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            connectors: catalog.map(connector => summaryOf(connector, connections)),
            total: catalog.length,
            ...(connections
              ? { connections: connections.map(item => withCatalogWay(item, catalog.find(connector => connector.slug === item.connector))) }
              : {}),
            ...(only
              ? {
                nextAction: {
                  tool: 'list_agent_connectors',
                  arguments: { name: only.slug, ...(agentGuid ? { agent_guid: agentGuid } : {}) },
                  reason: `See what ${only.title} needs before asking the user for it.`,
                },
              }
              : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
