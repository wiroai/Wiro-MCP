import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, errorResult, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import { customSkillEntries, LIVE_OR_RESTART_NOTE, readUserAgent } from '../utils/agent-config.js';
import {
  accountsText,
  connectionOf,
  connectionSchema,
  connectionStateText,
  hangsOnConnector,
  isLiveConnection,
  listConnections,
  readConnector,
  withCatalogWay,
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
  restart: z.enum(['live', 'scheduled', 'none', 'failed']).optional()
    .describe('After a disconnect: live (the running agent dropped the connector with no restart), scheduled (it restarts without it), none (nothing to load, or the agent is not running) or failed.'),
  willClear: z.string(),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type DisconnectBody = ApiEnvelope & { removed?: unknown; revoked?: unknown; restart?: unknown };

type Restart = 'live' | 'scheduled' | 'none' | 'failed';

/**
 * What a disconnect removes and what goes with it. The agent loses tools and scheduled tasks only from a connection
 * that gives it the connector now, and `restart` is the sentence about the restart, or empty. The connection's way
 * comes from the catalog row (withCatalogWay), since a connection to the wiro connector names no project while the
 * agent has none.
 */
function describeClear(title: string, connection: AgentConnection, tasks: string[], restart: string): string {
  const signedIn = connection.way === 'sign_in';
  // The wiro connector saves nothing of its own: it runs with the agent's Wiro project, which stays bound. While the
  // agent has no project it gives the agent no tools, so there are none to lose.
  const project = connection.way === 'project';
  const noProject = project && !connection.projectId;
  const stop = tasks.length > 0 ? `these scheduled tasks stop running until it is connected again: ${tasks.join(', ')}` : '';
  const loses = !isLiveConnection(connection)
    ? ''
    : noProject
      ? (stop ? `${stop.charAt(0).toUpperCase()}${stop.slice(1)}. ` : '')
      : `The agent loses the ${title} tools${stop ? `, and ${stop}` : ''}. `;
  const removed = noProject
    ? `The ${title} connection is removed. The agent has no Wiro project now, so the connector gives it nothing. `
    : project
      ? `The ${title} connection is removed. The agent keeps its Wiro project, which its video and voice skills use. `
      : `The ${title} connection is removed: its saved values${signedIn ? ', its sign-in' : ''} and its account choices. `;
  const again = signedIn ? ' and a new sign-in' : project ? ' with a Wiro project' : ' and the values again';
  return removed
    + `${signedIn ? 'The service is asked to revoke the access where it supports that. ' : ''}`
    + loses
    + `${restart ? `${restart} ` : ''}`
    + `Connecting it again needs connect_agent_connector${again}.`;
}

/** Before the disconnect: a connection that is connected now reaches a running agent; any other loads nothing. */
function restartBefore(connection: AgentConnection): string {
  return connection.status === 'connected' ? LIVE_OR_RESTART_NOTE : '';
}

/** After the disconnect, as Wiro answered it. */
function restartAfter(connection: AgentConnection, restart: Restart | undefined): string {
  switch (restart) {
    case 'live':
      return 'The running agent no longer uses it from its next message, with no restart.';
    case 'scheduled':
      return 'The running agent restarts without it, which takes about a minute.';
    case 'failed':
      return 'The running agent could not be restarted, so it keeps the connector until it restarts: control_agent with action restart does that.';
    case 'none':
      return connection.status === 'connected'
        ? 'The agent is not running, so nothing restarts; it starts without the connector.'
        : 'It was not connected, so the agent does not restart.';
    default:
      return '';
  }
}

/**
 * The scheduled tasks that are on and stop with this connection, as people see them. A task runs while any one of
 * its connectors is connected, so one that can use another connected connector keeps running, and a connection that
 * does not give the agent its connector now stops nothing. Empty when the agent cannot be read.
 */
async function tasksStopping(
  client: WiroClient,
  agentGuid: string,
  slug: string,
  connections: readonly AgentConnection[],
  signal: AbortSignal,
): Promise<string[]> {
  if (!isLiveConnection(connectionOf(connections, slug))) return [];
  try {
    const row = await readUserAgent(client, agentGuid, signal);
    return customSkillEntries(row)
      .filter(entry => entry.kind === 'scheduled_task' && entry.enabled && !entry.notWritten && !entry.skillOff
        && hangsOnConnector(entry.requiresConnectors, slug, connections))
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
        + 'sign-in\'s access where it supports that, the agent loses the connector\'s tools, and scheduled tasks that '
        + `can use no other connected connector stop running. ${LIVE_OR_RESTART_NOTE} It cannot be undone: connecting `
        + 'again needs connect_agent_connector with a new sign-in or the values. The wiro connector saves no values: disconnecting it '
        + 'leaves the agent its Wiro project, and connecting it again takes a Wiro project. Chat channels such as Telegram '
        + 'are turned off by clearing their fields with set_agent_credentials instead.',
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
        const listed = connectionOf(connections, slug);
        // The catalog row says how the connector connects where the connection does not: a connection to the wiro
        // connector shows no project and no saved value while the agent has no project. A connector the catalog no
        // longer offers can still be disconnected; its title then comes from the connection.
        const unsure = !listed || listed.way === undefined || (listed.way === 'key' && listed.savedFields.length === 0);
        const connector = unsure ? await readConnector(client, slug, extra.signal).catch(() => null) : null;
        const connection = listed ? withCatalogWay(listed, connector) : undefined;
        const title = connection?.title ?? connector?.title ?? slug;
        const base = { agentGuid, connector: slug, title };
        if (!connection) {
          const message = `${title} is not connected to this agent, so there is nothing to remove.`;
          return {
            content: [{ type: 'text' as const, text: `## ${title}: not connected\n\n${message}` }],
            structuredContent: { ...base, disconnected: false, willClear: '', message },
          };
        }
        const tasks = await tasksStopping(client, agentGuid, slug, connections, extra.signal);
        const willClear = describeClear(title, connection, tasks, restartBefore(connection));

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
        const restart = restartValue === 'live' || restartValue === 'scheduled' || restartValue === 'none' || restartValue === 'failed' ? restartValue : undefined;
        const cleared = describeClear(title, connection, tasks, restartAfter(connection, restart));
        const message = removed
          ? `${title} is disconnected. ${cleared}${connection.way === 'sign_in' ? ` ${revoked ? 'The service confirmed it revoked the access.' : 'The service did not confirm a revoke: the user can remove the access in its own settings too.'}` : ''}`
          : `${title} was no longer connected, so nothing changed.`;
        return {
          content: [{ type: 'text' as const, text: `## ${title} ${removed ? 'disconnected' : 'not connected'}\n\n${message}` }],
          structuredContent: {
            ...base,
            disconnected: removed,
            connection,
            revoked,
            ...(restart ? { restart } : {}),
            willClear: removed ? cleared : willClear,
            message,
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
