import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  hasErrorCode,
  isPlainObject,
  requireApiSuccess,
  toInteger,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  CONNECTOR_SLUG,
  connectionSchema,
  connectionOf,
  isNotConnectedError,
  listConnections,
  readConnector,
  toAgentConnections,
  type CatalogConnector,
} from '../utils/agent-connectors.js';
import { LIVE_OR_RESTART_NOTE } from '../utils/agent-config.js';
import { jsonSpan, quotedSpan } from '../utils/quoted-text.js';
import { nextActionSchema, strictInput } from './schemas.js';

const candidateSchema = z.object({ id: z.string(), name: z.string() });

const pickerSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  multiple: z.boolean(),
  candidates: z.array(candidateSchema)
    .describe('The accounts the connection can reach now, listed by the service. Names come from the service.'),
  selected: z.array(z.string()).describe('The ids chosen now.'),
});

type Picker = z.infer<typeof pickerSchema>;

const outputSchema = {
  agentGuid: z.string(),
  connector: z.string(),
  title: z.string(),
  mode: z.enum(['list', 'set']),
  pickers: z.array(pickerSchema).optional(),
  accounts: z.record(z.string(), z.array(z.string())).optional()
    .describe('set: the accounts saved for each account choice, by id.'),
  applied: z.number().int().nonnegative().optional()
    .describe('set: 1 when the choice changed, 0 when it was already this.'),
  restart: z.enum(['live', 'scheduled', 'none', 'failed']).optional()
    .describe('set: live (the running agent got the accounts with no restart), scheduled (it restarts to load them), none (nothing to load, or the agent is not running) or failed.'),
  connection: connectionSchema.optional(),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type PickersBody = ApiEnvelope & { pickers?: unknown };
type SetBody = ApiEnvelope & { accounts?: unknown; applied?: unknown; restart?: unknown; useragentconnectors?: unknown };

/** What Wiro's answer to a save says about the running agent, as a sentence that follows another, or empty. */
function savedRestartText(restart: 'live' | 'scheduled' | 'none' | 'failed' | undefined): string {
  switch (restart) {
    case 'live':
      return ' The running agent uses them from its next message, with no restart.';
    case 'scheduled':
      return ' The running agent restarts to load them, which takes about a minute.';
    case 'failed':
      return ' The running agent could not be restarted: control_agent with action restart loads them.';
    default:
      return '';
  }
}

// Wiro's answer when the service refused the connection's sign-in while listing its accounts, or the connection
// already needs a new sign-in: it expired or was revoked. Wiro words it for the agent's chat, which asks its operator;
// here the user connects it again. Wiro marks it with the code "reauth", and the connection then reads reauth. An
// answer without the code, from a Wiro API before it, is known by its words.
const REAUTH_CODE = 'reauth';
const SIGN_IN_GONE = /expired or was revoked, so it has to be connected again/i;

/** How Wiro told that refusal: by its code, so the connection reads reauth; by its words only; or not at all. */
function signInGone(error: unknown): 'code' | 'words' | undefined {
  if (!(error instanceof ApiResultError)) return undefined;
  if (hasErrorCode(error, REAUTH_CODE)) return 'code';
  return SIGN_IN_GONE.test(error.message) ? 'words' : undefined;
}

/**
 * The answer to that refusal, with the connect that starts a new sign-in as its next step. A connection that reads
 * reauth is not connected, so that connect returns the link at once (or first asks for the keys of the user's own app
 * it needs). Without the code, the connection may still read connected, so that connect may first show what it
 * replaces.
 */
function signInGoneResult(agentGuid: string, slug: string, title: string, mode: 'list' | 'set', told: 'code' | 'words') {
  const gone = `The ${title} sign-in expired or was revoked at the service, so its accounts cannot be listed or saved, `
    + 'and nothing was changed.';
  const message = told === 'code'
    ? `${gone} Wiro now reads the connection as needing a new sign-in, so connect_agent_connector with action connect `
      + 'needs no confirm: it returns a new sign-in link at once, or lists the keys of the user\'s own app it needs '
      + 'first. Once the user has signed in again, choose the accounts.'
    : `${gone} Connect it again with connect_agent_connector, then choose the accounts. Action connect returns a new `
      + 'sign-in link, or, while the connection still reads connected, first shows what it replaces; after the user\'s '
      + 'yes, the same call with confirm: true returns the link.';
  const nextAction = {
    tool: 'connect_agent_connector',
    arguments: { action: 'connect', agent_guid: agentGuid, connector: slug },
    reason: told === 'code'
      ? `Connect ${title} again. This returns the sign-in link for the user to open in their own browser, or lists the `
        + 'keys of the user\'s own app it needs first.'
      : `Connect ${title} again. While the connection still reads connected, this first shows what it replaces: `
        + 'repeat it with confirm: true after the user\'s yes for the new sign-in link.',
  };
  return {
    content: [{
      type: 'text' as const,
      text: `## Error\n\n${message}\n\nNext: call connect_agent_connector with ${jsonSpan(nextAction.arguments)}.`,
    }],
    structuredContent: { agentGuid, connector: slug, title, mode, message, nextAction },
    isError: true,
  };
}

function toPickers(value: unknown): Picker[] {
  return (Array.isArray(value) ? value : []).filter(isPlainObject).flatMap((picker) => {
    const key = asString(picker.key)?.trim();
    if (!key) return [];
    const description = asString(picker.description)?.trim();
    const candidates = (Array.isArray(picker.candidates) ? picker.candidates : []).filter(isPlainObject).flatMap((candidate) => {
      const id = asString(candidate.id)?.trim();
      return id ? [{ id, name: asString(candidate.name)?.trim() || id }] : [];
    });
    const selected = (Array.isArray(picker.selected) ? picker.selected : []).map(item => asString(item)?.trim()).filter((id): id is string => Boolean(id));
    return [{
      key,
      label: asString(picker.label)?.trim() || key,
      ...(description ? { description } : {}),
      multiple: picker.multiple === true,
      candidates,
      selected,
    }];
  });
}

function toAccounts(value: unknown): Record<string, string[]> {
  const accounts: Record<string, string[]> = {};
  if (!isPlainObject(value)) return accounts;
  for (const [key, ids] of Object.entries(value)) {
    if (Array.isArray(ids)) accounts[key] = ids.map(id => asString(id)?.trim()).filter((id): id is string => Boolean(id));
  }
  return accounts;
}

/** What to propose saving: the choice there is, else the only account, else every account of a multiple choice. */
function proposal(pickers: Picker[]): Record<string, string[]> {
  const accounts: Record<string, string[]> = {};
  for (const picker of pickers) {
    if (picker.selected.length > 0) accounts[picker.key] = picker.selected;
    else if (picker.candidates.length === 1 || (picker.multiple && picker.candidates.length > 0)) {
      accounts[picker.key] = picker.multiple ? picker.candidates.map(candidate => candidate.id) : [picker.candidates[0]?.id ?? ''];
    }
  }
  return accounts;
}

function pickerLines(picker: Picker): string[] {
  const chosen = new Set(picker.selected);
  return [
    `### ${picker.label} (\`${picker.key}\`, ${picker.multiple ? 'one or more' : 'one'})`,
    '',
    ...(picker.description ? [picker.description, ''] : []),
    ...(picker.candidates.length === 0
      ? ['The connection reaches none right now.']
      : picker.candidates.map(candidate => `- ${quotedSpan(candidate.name)} (id ${quotedSpan(candidate.id)})${chosen.has(candidate.id) ? ': chosen' : ''}`)),
  ];
}

async function connectorOrError(client: WiroClient, slug: string, signal: AbortSignal): Promise<CatalogConnector | Error> {
  if (!CONNECTOR_SLUG.test(slug)) return new Error(`No connector is named "${slug}". list_agent_connectors lists them.`);
  const connector = await readConnector(client, slug, signal);
  return connector ?? new Error(`No connector is named "${slug}". list_agent_connectors lists them.`);
}

export function registerSetAgentConnectorAccounts(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'set_agent_connector_accounts',
    {
      title: 'Choose a connector\'s accounts',
      description: 'Choose which accounts a connected Connector may act on, for a connector with account choices '
        + '(such as the ad accounts, pages, properties, channels or apps a sign-in reaches, or the advertisers of a '
        + 'TikTok Ads sign-in). Call it with only '
        + 'connector first: it lists each account choice with the accounts the connection reaches now, as the service '
        + 'names them, and the ones chosen, and changes nothing. Then call it with accounts, {choice key: [ids]}, to '
        + 'save the ones the user picked: only ids from that list are taken, a single choice takes one id, and a choice '
        + 'left out keeps what it had. The agent then acts only on the chosen accounts. Saving acts on the first call, '
        + `so get the user's yes first. ${LIVE_OR_RESTART_NOTE} list_agent_connectors shows `
        + 'which connectors have account choices. The person who deployed the agent or a team admin of its team can '
        + 'choose.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100).describe('The deployed agent\'s guid, from list_my_agents.'),
        connector: z.string().min(1).max(100).describe('The connected connector\'s slug, such as "facebook-pages".'),
        accounts: z.record(z.string().min(1).max(40), z.array(z.string().min(1).max(200)).max(500)).optional()
          .describe('The accounts to save, by account choice key, for example {"pages": ["123", "456"]}. Leave it out to list the choices.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, connector: rawConnector, accounts }, extra) => {
      const agentGuid = agent_guid.trim();
      const slug = rawConnector.trim().toLowerCase();
      let title = slug;
      try {
        const connector = await connectorOrError(client, slug, extra.signal);
        if (connector instanceof Error) return errorResult(connector);
        title = connector.title;
        if (connector.accountPickers.length === 0) {
          return errorResult(new Error(`${connector.title} has no account choices to list or save here, and nothing was changed. `
            + 'If its setup steps (list_agent_connectors with its slug) name accounts the agent may act on, connect_agent_connector takes them in accounts.'));
        }
        const base = { agentGuid, connector: connector.slug, title: connector.title };

        if (!accounts) {
          const body = requireApiSuccess(
            await client.post<PickersBody>('/UserAgent/ConnectorAccounts', { useragentguid: agentGuid, slug: connector.slug }, extra.signal),
            `The ${connector.title} accounts could not be listed.`,
          );
          const pickers = toPickers(body.pickers);
          const proposed = proposal(pickers);
          const message = `Ask the user which accounts ${connector.title} may act on, then save them with accounts. Nothing has changed yet.`;
          const nextAction = Object.keys(proposed).length > 0
            ? {
              tool: 'set_agent_connector_accounts',
              arguments: { agent_guid: agentGuid, connector: connector.slug, accounts: proposed },
              reason: 'Ask the user which accounts to use, then save only those. This proposes the current choice, or every account where none is chosen.',
            }
            : undefined;
          return {
            content: [{
              type: 'text' as const,
              text: [
                `## ${connector.title}: account choices`,
                '',
                message,
                ...pickers.flatMap(picker => ['', ...pickerLines(picker)]),
                ...(nextAction ? ['', `Next: call set_agent_connector_accounts with ${jsonSpan(nextAction.arguments)} once the user agrees.`] : []),
              ].join('\n'),
            }],
            structuredContent: { ...base, mode: 'list' as const, pickers, message, ...(nextAction ? { nextAction } : {}) },
          };
        }

        const unknown = Object.keys(accounts).filter(key => !connector.accountPickers.some(picker => picker.key === key));
        if (unknown.length > 0) {
          return errorResult(new Error(`${connector.title} has no account choice ${unknown.map(key => `"${key}"`).join(', ')}. Its choices: ${connector.accountPickers.map(picker => `"${picker.key}" (${picker.label})`).join(', ')}. Nothing was saved.`));
        }
        const body = requireApiSuccess(
          await client.post<SetBody>('/UserAgent/ConnectorSetAccounts', { useragentguid: agentGuid, slug: connector.slug, accounts }, extra.signal),
          `The ${connector.title} accounts could not be saved.`,
        );
        const saved = toAccounts(body.accounts);
        const applied = toInteger(body.applied, 1);
        const restartValue = asString(body.restart);
        const restart = restartValue === 'live' || restartValue === 'scheduled' || restartValue === 'none' || restartValue === 'failed' ? restartValue : undefined;
        const connection = toAgentConnections(body.useragentconnectors)[0];
        const chosen = connector.accountPickers
          .filter(picker => saved[picker.key])
          .map(picker => `${picker.label}: ${saved[picker.key]?.length ?? 0} chosen`)
          .join(', ');
        const message = applied === 0
          ? `The ${connector.title} accounts were already this (${chosen}), so nothing changed and the agent does not restart.`
          : `Saved the ${connector.title} accounts (${chosen}). The agent acts only on these.${savedRestartText(restart)}`;
        return {
          content: [{ type: 'text' as const, text: `## ${connector.title}: accounts ${applied === 0 ? 'unchanged' : 'saved'}\n\n${message}` }],
          structuredContent: {
            ...base,
            mode: 'set' as const,
            accounts: saved,
            applied,
            ...(restart ? { restart } : {}),
            ...(connection ? { connection } : {}),
            message,
          },
        };
      } catch (error) {
        if (isNotConnectedError(error)) {
          const connections = await listConnections(client, agentGuid, extra.signal).catch(() => null);
          const state = connections ? connectionOf(connections, slug)?.status : undefined;
          return errorResult(new Error(`${slug} is not connected to this agent${state && state !== 'connected' ? ` (${state})` : ''}, so its accounts cannot be listed. Connect it first with connect_agent_connector.`));
        }
        const told = signInGone(error);
        if (told) return signInGoneResult(agentGuid, slug, title, accounts ? 'set' : 'list', told);
        return errorResult(error);
      }
    },
  );
}
