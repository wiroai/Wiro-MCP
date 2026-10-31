import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, errorText, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import {
  loadCredentialMeta,
  readOAuthStatus,
  type OAuthStatusSnapshot,
} from '../utils/agent-config.js';
import { nextActionSchema } from './schemas.js';

const accountSchema = z.object({ id: z.string(), name: z.string() });

const outputSchema = {
  agentGuid: z.string(),
  credential: z.string(),
  title: z.string(),
  disconnected: z.boolean(),
  connectedBefore: z.boolean().nullable(),
  accounts: z.array(accountSchema),
  willClear: z.string(),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

function describeClear(title: string, ownAppKept: boolean): string {
  return `The saved ${title} sign-in, its selected accounts and the connection's settings are removed`
    + `${ownAppKept ? '; your own app keys are kept for reconnecting' : ''}. Scheduled tasks that need ${title} stop running, `
    + `and a running agent restarts. Reconnecting needs connect_agent_oauth again, usually with a new ${title} sign-in.`;
}

export function registerDisconnectAgentOauth(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'disconnect_agent_oauth',
    {
      title: 'Disconnect an agent integration',
      description: 'Disconnect a sign-in based integration (for example Google Ads, Meta Ads or '
        + 'HubSpot) from a deployed agent. Call it without confirm first: it shows what is '
        + 'connected and what will be removed, and changes nothing. After the user agrees, call '
        + 'again with confirm: true. The saved sign-in, the selected accounts and the connection\'s '
        + 'settings are cleared (your own app keys are kept), the provider is asked to revoke the '
        + 'access where it supports that, scheduled tasks that need the integration stop running, '
        + 'and a running agent restarts. It cannot be undone; reconnect with connect_agent_oauth. '
        + 'For plain credentials such as Telegram, clear fields with set_agent_credentials instead.',
      inputSchema: {
        agent_guid: z.string().min(1).describe('The deployed agent\'s guid, from list_my_agents.'),
        credential: z.string().min(1).describe('The integration\'s credential key, for example "google-ads" or "meta-ads".'),
        confirm: z.boolean().default(false)
          .describe('false (default) only shows what would be removed. true disconnects.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, credential: rawCredential, confirm }, extra) => {
      try {
        const credential = rawCredential.trim();
        const meta = await loadCredentialMeta(client, credential, extra.signal);
        if (!meta) return errorResult(new Error(`Unknown credential "${credential}".`));
        if (!meta.oauth) {
          return errorResult(new Error(`${meta.title} is not a sign-in connection. Clear its fields with set_agent_credentials instead.`));
        }
        const ownAppKept = meta.fields.some(field => field.oauthManaged && field.onlyInModes?.includes('own'));
        const willClear = describeClear(meta.title, ownAppKept);

        let before: OAuthStatusSnapshot | null = null;
        try {
          before = await readOAuthStatus(client, agent_guid, credential, meta.oauth.picker, extra.signal);
        } catch (error) {
          if (!confirm) throw error;
        }
        const accounts = before?.accounts ?? [];
        const connectedBefore = before ? before.connected || before.connectedAt !== '' : null;

        if (!confirm) {
          const message = connectedBefore
            ? `${meta.title} is connected${accounts.length > 0 ? ` for ${accounts.map(account => account.name || account.id).join(', ')}` : ''}. ${willClear}`
            : `${meta.title} does not look connected on this agent. Disconnecting still clears any saved ${meta.title} settings.`;
          return {
            content: [{ type: 'text' as const, text: `## Disconnect ${meta.title}?\n\n${message}\n\nNothing has changed yet. After the user agrees, call disconnect_agent_oauth again with confirm: true.` }],
            structuredContent: {
              agentGuid: agent_guid,
              credential,
              title: meta.title,
              disconnected: false,
              connectedBefore,
              accounts,
              willClear,
              message,
              nextAction: {
                tool: 'disconnect_agent_oauth',
                arguments: { agent_guid, credential, confirm: true },
                reason: 'Ask the user to confirm this first.',
              },
            },
          };
        }

        requireApiSuccess(
          await client.post<ApiEnvelope>('/UserAgentOAuth/OAuthDisconnect', {
            useragentguid: agent_guid,
            credentialkey: credential,
          }, extra.signal),
          `Could not disconnect ${meta.title}.`,
        );
        const message = `${meta.title} is disconnected. ${willClear}`;
        return {
          content: [{ type: 'text' as const, text: `## ${meta.title} disconnected\n\n${message}` }],
          structuredContent: {
            agentGuid: agent_guid,
            credential,
            title: meta.title,
            disconnected: true,
            connectedBefore,
            accounts,
            willClear,
            message,
          },
        };
      } catch (error) {
        const message = errorText(error);
        // The hint follows Wiro's message as a paragraph of its own, as in connect_agent_oauth.
        return errorResult(new Error(/not found or unauthorized/i.test(message)
          ? `${message}\n\nIntegrations can only be changed with a project created by the person who deployed the agent: connect this server with such a project, by its API key or a browser sign-in.`
          : message));
      }
    },
  );
}
