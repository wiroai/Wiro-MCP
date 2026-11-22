import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, errorResult, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import { customSkillEntries, readUserAgent } from '../utils/agent-config.js';
import {
  accountsText,
  connectionOf,
  connectionSchema,
  connectionStateText,
  listConnections,
  readConnector,
  type AgentConnection,
} from '../utils/agent-connectors.js';
import { taskLabel, taskNamedByWiro } from '../utils/user-agent.js';
import { nextActionSchema, strictInput } from './schemas.js';

const outputSchema = {
  agentGuid: z.string(),
  connector: z.string(),
  title: z.string(),
  disconnected: z.boolean(),
  connection: connectionSchema.optional().describe('The connection as it was before this call.'),
  revoked: z.boolean().optional()
    .describe('After a disconnect: whether the service confirmed it revoked the access. False when it does not support that or did not answer.'),
  restart: z.enum(['scheduled', 'none', 'failed']).optional(),
  willClear: z.string(),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type DisconnectBody = ApiEnvelope & { removed?: unknown; revoked?: unknown; restart?: unknown };

function describeClear(title: string, connection: AgentConnection | undefined, tasks: string[]): string {
  const signedIn = connection?.way === 'sign_in';
  return `The ${title} connection is removed: its saved values${signedIn ? ', its sign-in' : ''} and its account choices. `
    + `${signedIn ? `The service is asked to revoke the access where it supports that. ` : ''}`
    + `The agent loses the ${title} tools${tasks.length > 0 ? `, and these scheduled tasks stop running until it is connected again: ${tasks.join(', ')}` : ''}. `
    + `A running agent restarts. Connecting it again needs connect_agent_connector${signedIn ? ' and a new sign-in' : ' and the values again'}.`;
}

/** The scheduled tasks that are on and need this connector, as people see them. Empty when the agent cannot be read. */
async function tasksNeeding(client: WiroClient, agentGuid: string, slug: string, signal: AbortSignal): Promise<string[]> {
  try {
    const row = await readUserAgent(client, agentGuid, signal);
    return customSkillEntries(row)
      .filter(entry => entry.kind === 'scheduled_task' && entry.enabled && entry.requiresConnectors.includes(slug))
      .map(entry => taskLabel(entry.key, taskNamedByWiro(entry)));
  } catch {
    return [];
  }
}

export function registerDisconnectAgentConnector(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'disconnect_agent_connector',
    {
      title: 'Disconnect an agent connector',
      description: 'Disconnect a Connector from a deployed agent. Call it without confirm first: it shows the '
        + 'connection and what goes with it, and changes nothing. After the user agrees, call again with confirm: '
        + 'true. Its saved values, sign-in and account choices are removed, the service is asked to revoke a '
        + 'sign-in\'s access where it supports that, the agent loses the connector\'s tools, scheduled tasks that need '
        + 'it stop running, and a running agent restarts. It cannot be undone: connecting again needs '
        + 'connect_agent_connector with a new sign-in or the values. Chat channels such as Telegram are turned off by '
        + 'clearing their fields with set_agent_credentials instead.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100).describe('The deployed agent\'s guid, from list_my_agents.'),
        connector: z.string().min(1).max(100).describe('The connector\'s slug, such as "google-ads".'),
        confirm: z.boolean().default(false)
          .describe('false (default) only shows what would be removed. true disconnects.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, connector: rawConnector, confirm }, extra) => {
      try {
        const agentGuid = agent_guid.trim();
        const slug = rawConnector.trim().toLowerCase();
        const connections = await listConnections(client, agentGuid, extra.signal);
        const connection = connectionOf(connections, slug);
        // A connector the catalog no longer offers can still be disconnected; its title then comes from the connection.
        const title = connection?.title ?? (await readConnector(client, slug, extra.signal).catch(() => null))?.title ?? slug;
        const base = { agentGuid, connector: slug, title };
        if (!connection) {
          const message = `${title} is not connected to this agent, so there is nothing to remove.`;
          return {
            content: [{ type: 'text' as const, text: `## ${title}: not connected\n\n${message}` }],
            structuredContent: { ...base, disconnected: false, willClear: '', message },
          };
        }
        const tasks = await tasksNeeding(client, agentGuid, slug, extra.signal);
        const willClear = describeClear(title, connection, tasks);

        if (!confirm) {
          const accounts = accountsText(connection);
          const message = `${title} is ${connectionStateText(connection)}${connection.status === 'connected' && connection.connectedAt ? ` (since ${connection.connectedAt})` : ''}${accounts ? `; ${accounts}` : ''}. ${willClear}`;
          return {
            content: [{ type: 'text' as const, text: `## Disconnect ${title}?\n\n${message}\n\nNothing has changed yet. After the user agrees, call disconnect_agent_connector again with confirm: true.` }],
            structuredContent: {
              ...base,
              disconnected: false,
              connection,
              willClear,
              message,
              nextAction: {
                tool: 'disconnect_agent_connector',
                arguments: { agent_guid: agentGuid, connector: slug, confirm: true },
                reason: 'Ask the user to confirm this first.',
              },
            },
          };
        }

        const body = requireApiSuccess(
          await client.post<DisconnectBody>('/UserAgent/ConnectorDisconnect', { useragentguid: agentGuid, slug }, extra.signal),
          `Could not disconnect ${title}.`,
        );
        const removed = body.removed !== false;
        const revoked = body.revoked === true;
        const restartValue = asString(body.restart);
        const restart = restartValue === 'scheduled' || restartValue === 'none' || restartValue === 'failed' ? restartValue : undefined;
        const message = removed
          ? `${title} is disconnected. ${willClear}${connection.way === 'sign_in' ? ` ${revoked ? 'The service confirmed it revoked the access.' : 'The service did not confirm a revoke: the user can remove the access in its own settings too.'}` : ''}`
          : `${title} was no longer connected, so nothing changed.`;
        return {
          content: [{ type: 'text' as const, text: `## ${title} ${removed ? 'disconnected' : 'not connected'}\n\n${message}` }],
          structuredContent: {
            ...base,
            disconnected: removed,
            connection,
            revoked,
            ...(restart ? { restart } : {}),
            willClear,
            message,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
