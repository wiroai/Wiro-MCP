import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isPlainObject,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  OAUTH_LINK_TTL_SECONDS,
  buildChainedSelections,
  buildPickerAccounts,
  chooseConnectionMode,
  connectionModeRequirements,
  connectionState,
  credentialGroup,
  dashboardAgentUrl,
  isAllowedRedirectUrl,
  loadCredentialMeta,
  ownAppRedirectUri,
  parseDiscoveredGroups,
  readOAuthStatus,
  readUserAgent,
  toAccountRefs,
  type AccountRef,
  type ConnectionState,
  type CredentialMeta,
  type DiscoveredGroup,
  type ModeRequirement,
  type OAuthStatusSnapshot,
  type PickerMeta,
} from '../utils/agent-config.js';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  pollUntil,
  reportProgress,
} from '../utils/poll.js';
import { nextActionSchema } from './schemas.js';

const accountSchema = z.object({ id: z.string(), name: z.string() });

const outputSchema = {
  action: z.enum(['connect', 'status', 'select_accounts']),
  agentGuid: z.string(),
  credential: z.string(),
  title: z.string(),
  state: z.enum([
    'authorize_in_browser',
    'connected',
    'pick_accounts',
    'pick_child_items',
    'waiting_for_user',
    'token_expired',
    'not_connected',
    'setup_needed',
    'confirm_needed',
  ]),
  mode: z.string().optional(),
  authorizeUrl: z.string().optional(),
  expiresInSeconds: z.number().optional(),
  redirectUrl: z.string().optional(),
  connectedAt: z.string().optional(),
  tokenExpiresAt: z.string().optional(),
  accounts: z.array(accountSchema).optional(),
  candidates: z.array(accountSchema).optional(),
  childStep: z.object({
    picker: z.string(),
    label: z.string(),
    optional: z.boolean(),
    configured: z.boolean().optional(),
    groups: z.array(z.object({
      parent: accountSchema,
      items: z.array(accountSchema),
      error: z.string().optional(),
    })),
  }).optional(),
  connectionModes: z.array(z.object({
    mode: z.string(),
    available: z.boolean(),
    needsBrowser: z.boolean(),
    fields: z.array(z.object({ field: z.string(), label: z.string(), isSet: z.boolean() })),
    note: z.string(),
  })).optional(),
  ownAppRedirectUri: z.string().optional(),
  message: z.string(),
  nextAction: nextActionSchema.optional(),
};

type Action = 'connect' | 'status' | 'select_accounts';
type ConnectBody = ApiEnvelope & { authorizeUrl?: unknown; accounts?: unknown; errorcode?: unknown };
type PickerBody = ApiEnvelope & Record<string, unknown>;

interface Context {
  client: WiroClient;
  agentGuid: string;
  credential: string;
  meta: CredentialMeta;
  signal: AbortSignal;
}

const DONE_STATES = new Set<ConnectionState>(['connected', 'pick_accounts', 'pick_child_items']);

function oauthHint(message: string, meta: CredentialMeta): string | undefined {
  if (/not found or unauthorized/i.test(message)) {
    return 'Integrations can only be connected with a project created by the person who deployed the agent: connect this server with such a project, by its API key or a browser sign-in.';
  }
  if (/credentials not configured/i.test(message)) {
    return `Save your own ${meta.title} app keys with set_agent_credentials first (call it with credential "${meta.key}" to see the fields).`;
  }
  if (/wiro-managed oauth is not enabled/i.test(message)) {
    return 'Connect this service with mode own (your own app) or api_key where offered.';
  }
  if (/no pending .* connection/i.test(message)) {
    return 'The account list from the last connect expired after 15 minutes. Connect again.';
  }
  if (/account not connected/i.test(message)) return 'Connect the account first with action connect.';
  if (/candidates expired/i.test(message)) return 'Call select_accounts again; it lists the items afresh before saving.';
  return undefined;
}

/** Wiro's message, then the hint as a paragraph of its own, so the two read as separate sentences. */
function withHint(error: unknown, meta?: CredentialMeta): Error {
  const message = errorText(error);
  const hint = meta ? oauthHint(message, meta) : undefined;
  return new Error(hint ? `${message}\n\n${hint}` : message);
}

function childStepOf(picker: PickerMeta | null, groups: DiscoveredGroup[], configured?: boolean) {
  const next = picker?.next;
  if (!next) return undefined;
  return {
    picker: next.key,
    label: next.label,
    optional: next.optional,
    ...(configured !== undefined ? { configured } : {}),
    groups: groups.map(group => ({
      parent: group.parent,
      items: group.items,
      ...(group.errorCode ? { error: group.errorCode } : {}),
    })),
  };
}

function accountsLine(accounts: AccountRef[]): string {
  return accounts.map(account => (account.name ? `${account.name} (${account.id})` : account.id)).join(', ');
}

function result(
  action: Action,
  context: Context,
  state: z.infer<typeof outputSchema.state>,
  message: string,
  extra: Record<string, unknown> = {},
  textExtra: string[] = [],
) {
  const lines = [
    `## ${context.meta.title}: ${state.replace(/_/g, ' ')}`,
    '',
    message,
    ...textExtra,
  ];
  if (isPlainObject(extra.nextAction)) {
    lines.push('', `Next: call ${String(extra.nextAction.tool)} with ${JSON.stringify(extra.nextAction.arguments)}.`);
  }
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      action,
      agentGuid: context.agentGuid,
      credential: context.credential,
      title: context.meta.title,
      state,
      message,
      ...extra,
    },
  };
}

function modeLines(modes: ModeRequirement[]): string[] {
  return [
    '',
    ...modes.filter(mode => mode.available).map(mode => `- **${mode.mode}**: ${mode.note}${mode.fields.length > 0 ? ` Fields: ${mode.fields.map(field => `${field.field}${field.isSet ? ' (set)' : ' (missing)'}`).join(', ')}.` : ''}`),
  ];
}

async function connect(
  context: Context,
  input: { mode?: string; redirectUrl?: string; confirm: boolean },
) {
  const { client, agentGuid, credential, meta, signal } = context;
  const oauth = meta.oauth as NonNullable<CredentialMeta['oauth']>;
  const row = await readUserAgent(client, agentGuid, signal);
  const group = credentialGroup(row, credential);
  const modes = connectionModeRequirements(meta, group);
  const redirectUri = meta.connectionModes.includes('own') ? ownAppRedirectUri(meta) : undefined;
  const setupExtra = { connectionModes: modes, ...(redirectUri ? { ownAppRedirectUri: redirectUri } : {}) };
  const describeAction = {
    tool: 'set_agent_credentials',
    arguments: { agent_guid: agentGuid, credential },
    reason: 'See the fields and their formats before asking the user for them.',
  };

  if (input.mode && !modes.some(mode => mode.mode === input.mode)) {
    return errorResult(new Error(`${meta.title} cannot connect with mode ${input.mode}. Modes: ${modes.filter(mode => mode.available).map(mode => mode.mode).join(', ')}.`));
  }
  const mode = input.mode ?? chooseConnectionMode(meta, modes);
  const requirement = modes.find(candidate => candidate.mode === mode);
  if (!mode || !requirement) {
    return result('connect', context, 'setup_needed',
      `Choose how to connect ${meta.title}: it needs your own app keys or a token saved first.`,
      { ...setupExtra, nextAction: describeAction }, modeLines(modes));
  }
  if (!requirement.available) {
    return result('connect', context, 'setup_needed', `${requirement.note}`, { ...setupExtra, mode, nextAction: describeAction }, modeLines(modes));
  }
  if (mode === 'api_key' && !oauth.directProbe) {
    return result('connect', context, 'setup_needed', requirement.note, { ...setupExtra, mode, nextAction: describeAction }, modeLines(modes));
  }
  const missing = requirement.fields.filter(field => !field.isSet);
  if (missing.length > 0) {
    return result('connect', context, 'setup_needed',
      `Mode ${mode} needs these saved first with set_agent_credentials: ${missing.map(field => `${field.label} (${field.field})`).join(', ')}. ${requirement.note}`,
      { ...setupExtra, mode, nextAction: describeAction });
  }
  const connectedBefore = group?._connected === true;
  if (connectedBefore && !input.confirm) {
    return result('connect', context, 'confirm_needed',
      `${meta.title} is already connected. Connecting again replaces that connection and its selected accounts; if the new sign-in or check fails, the agent is left without it.`,
      {
        mode,
        nextAction: {
          tool: 'connect_agent_oauth',
          arguments: {
            action: 'connect',
            agent_guid: agentGuid,
            credential,
            mode,
            ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
            confirm: true,
          },
          reason: 'Ask the user to confirm this first.',
        },
      });
  }

  if (oauth.directProbe && mode === oauth.directProbe.mode) {
    // The check reads the mode from the saved credential, so it is saved first.
    if (asString(group?.authmethod) !== mode) {
      requireApiSuccess(
        await client.post<ApiEnvelope>('/UserAgent/CredentialUpsert', {
          useragentguid: agentGuid,
          fields: [{ credentialkey: credential, fieldname: 'authmethod', fieldvalue: mode }],
        }, signal),
        'Could not switch the connection mode.',
      );
    }
    const body = await client.post<ConnectBody>('/UserAgentOAuth/OAuthConnect', {
      useragentguid: agentGuid,
      credentialkey: credential,
      authmethod: mode,
    }, signal);
    if (body.result !== true) {
      const code = asString(body.errorcode);
      const message = (body.errors ?? []).map(error => error?.message?.trim()).filter(Boolean).join(' ')
        || `${meta.title} could not be checked.`;
      const parts = [code ? `${message} (${code})` : message];
      if (code === 'direct_token_missing') {
        parts.push(`Save ${requirement.fields.map(field => field.field).join(', ')} with set_agent_credentials first.`);
      } else if (connectedBefore) {
        parts.push('The previous connection was cleared by this check.');
      }
      return errorResult(new Error(parts.join(' ')));
    }
    const candidates = toAccountRefs(body.accounts, oauth.picker);
    if (oauth.picker && candidates.length > 0) {
      const pending = oauth.picker.pendingCache ? ' Save the choice within 15 minutes; after that, connect again.' : '';
      return result('connect', context, 'pick_accounts',
        `${meta.title} accepted the ${oauth.directProbe.label ?? 'credentials'}. Choose which of these accounts the agent should use.${pending}`,
        {
          mode,
          candidates,
          nextAction: {
            tool: 'connect_agent_oauth',
            arguments: { action: 'select_accounts', agent_guid: agentGuid, credential, accounts: candidates },
            reason: candidates.length === 1
              ? 'Save the only available account.'
              : 'Ask the user which accounts to use, then save only those.',
          },
        },
        ['', ...candidates.map(account => `- ${account.name || account.id} (${account.id})`)]);
    }
    return result('connect', context, 'connected',
      `${meta.title} is connected. A running agent restarts to use it.`,
      { mode });
  }

  const redirectUrl = input.redirectUrl?.trim() || dashboardAgentUrl(agentGuid);
  if (!isAllowedRedirectUrl(redirectUrl, agentGuid)) {
    return errorResult(new Error(`redirect_url can only be the agent's page in the Wiro dashboard (${dashboardAgentUrl(agentGuid)}) or a local address on the user's own machine (http://localhost or http://127.0.0.1, any port). Leave it out to use the dashboard page.`));
  }
  let since = '';
  try {
    since = (await readOAuthStatus(client, agentGuid, credential, oauth.picker, signal)).connectedAt;
  } catch {
    since = '';
  }
  const body = requireApiSuccess(
    await client.post<ConnectBody>('/UserAgentOAuth/OAuthConnect', {
      useragentguid: agentGuid,
      credentialkey: credential,
      authmethod: mode,
      redirecturl: redirectUrl,
    }, signal),
    `Could not start the ${meta.title} sign-in.`,
  );
  const authorizeUrl = asString(body.authorizeUrl);
  if (!authorizeUrl) throw new Error(`Wiro did not return a sign-in link for ${meta.title}.`);
  const usesDashboard = !/^http:/i.test(redirectUrl);
  const after = usesDashboard
    ? `After approving, the browser returns to the agent's page in the Wiro dashboard${oauth.picker ? ', which asks which accounts the agent should use' : ''}. Use a browser where the user is signed in to wiro.ai as the agent's owner.`
    : `After approving, the browser goes to ${redirectUrl}.`;
  return result('connect', context, 'authorize_in_browser',
    `The user must open this link in their own browser and approve access. It works for ${OAUTH_LINK_TTL_SECONDS / 60} minutes. ${after} Give the link to the user and check the status once they say they are done.`,
    {
      mode,
      authorizeUrl,
      expiresInSeconds: OAUTH_LINK_TTL_SECONDS,
      redirectUrl,
      nextAction: {
        tool: 'connect_agent_oauth',
        arguments: {
          action: 'status',
          agent_guid: agentGuid,
          credential,
          since_connected_at: since,
          wait_seconds: DEFAULT_WAIT_SECONDS,
        },
        reason: 'After the user has approved access, check that the connection finished.',
      },
    },
    ['', authorizeUrl]);
}

function statusMessage(state: ConnectionState, meta: CredentialMeta, snapshot: OAuthStatusSnapshot): string {
  const next = meta.oauth?.picker?.next;
  switch (state) {
    case 'connected': {
      const optionalStep = next && snapshot.childStep && !snapshot.childStep.configured
        ? ` Optionally, choose ${next.label} with action select_accounts and picker "${next.key}".`
        : '';
      return `${meta.title} is connected${snapshot.accounts.length > 0 ? ` for ${accountsLine(snapshot.accounts)}` : ''}.${optionalStep}`;
    }
    case 'pick_accounts':
      return 'The user approved access. The accounts to use are chosen on the agent\'s page in the Wiro dashboard that opened after the sign-in. If that page was closed, connect again, or save account IDs the user gives you with action select_accounts.';
    case 'pick_child_items':
      return `Access is approved, but ${next?.label ?? 'the second step'} still has to be chosen for each account. Call select_accounts with picker "${next?.key ?? ''}" to list them.`;
    case 'waiting_for_user':
      return `The ${meta.title} sign-in has not finished yet. The link from connect works for ${OAUTH_LINK_TTL_SECONDS / 60} minutes; after that, connect again.`;
    case 'token_expired':
      return `The saved ${meta.title} access has expired, usually because the agent was stopped and could not refresh it. Start the agent with control_agent, or connect again.`;
    default:
      return `${meta.title} is not connected. Start with action connect.`;
  }
}

async function status(
  context: Context,
  input: { since?: string; waitSeconds: number },
  extra: Parameters<typeof reportProgress>[0],
) {
  const { client, agentGuid, credential, meta, signal } = context;
  const picker = meta.oauth?.picker ?? null;
  const stateOf = (snapshot: OAuthStatusSnapshot) => connectionState(snapshot, { hasPicker: picker !== null, since: input.since });
  const polled = await pollUntil({
    read: readSignal => readOAuthStatus(client, agentGuid, credential, picker, readSignal),
    isDone: snapshot => DONE_STATES.has(stateOf(snapshot)),
    timeoutMs: input.waitSeconds * 1000,
    signal,
    interval: () => 5_000,
    onPoll: (snapshot, elapsedMs) => reportProgress(extra, elapsedMs, `${meta.title}: ${stateOf(snapshot)}`),
  });
  const snapshot = polled.value;
  if (!snapshot) throw new Error(`Could not read the ${meta.title} connection status.`);
  const state = stateOf(snapshot);
  let nextAction;
  if (state === 'waiting_for_user') {
    nextAction = {
      tool: 'connect_agent_oauth',
      arguments: {
        action: 'status',
        agent_guid: agentGuid,
        credential,
        ...(input.since !== undefined ? { since_connected_at: input.since } : {}),
        wait_seconds: DEFAULT_WAIT_SECONDS,
      },
      reason: 'Keep waiting for the user to finish signing in.',
    };
  } else if (state === 'pick_child_items' && picker?.next) {
    nextAction = {
      tool: 'connect_agent_oauth',
      arguments: { action: 'select_accounts', agent_guid: agentGuid, credential, picker: picker.next.key },
      reason: `List the ${picker.next.label} to choose from.`,
    };
  } else if (state === 'not_connected' || state === 'token_expired') {
    nextAction = {
      tool: 'connect_agent_oauth',
      arguments: { action: 'connect', agent_guid: agentGuid, credential },
      reason: `Connect ${meta.title}.`,
    };
  }
  const childStep = snapshot.childStep
    ? { ...snapshot.childStep, label: picker?.next?.label ?? snapshot.childStep.picker }
    : undefined;
  return result('status', context, state, statusMessage(state, meta, snapshot), {
    ...(snapshot.connectedAt ? { connectedAt: snapshot.connectedAt } : {}),
    ...(snapshot.tokenExpiresAt ? { tokenExpiresAt: snapshot.tokenExpiresAt } : {}),
    accounts: snapshot.accounts,
    ...(childStep ? { childStep } : {}),
    ...(nextAction ? { nextAction } : {}),
  });
}

async function selectAccounts(
  context: Context,
  input: {
    accounts?: Array<Record<string, string | number>>;
    picker?: string;
    selections?: Array<{ parent: string; items: string[] }>;
  },
) {
  const { client, agentGuid, credential, meta, signal } = context;
  const picker = meta.oauth?.picker ?? null;
  if (!picker) {
    return errorResult(new Error(`${meta.title} has no account choice to make; its connection is complete once connected.`));
  }

  if (input.picker) {
    const next = picker.next;
    if (!next || next.key !== input.picker) {
      return errorResult(new Error(`${meta.title} has no step "${input.picker}".${next ? ` Its extra step is "${next.key}".` : ''}`));
    }
    // Discovery runs before every save: the API only accepts items, with their exact labels, from a fresh list.
    const discovered = requireApiSuccess(
      await client.post<PickerBody>('/UserAgentOAuth/DiscoverPickerItems', {
        useragentguid: agentGuid,
        credentialkey: credential,
        pickerkey: next.key,
      }, signal),
      `Could not list the ${next.label}.`,
    );
    const groups = parseDiscoveredGroups(next, discovered.groups);
    if (!input.selections) {
      const readable = groups.filter(group => !group.errorCode);
      return result('select_accounts', context, 'pick_child_items',
        `Choose the ${next.label} to use under each account.${next.optional ? ' This step is optional.' : ''} Then call select_accounts again with picker "${next.key}" and selections.`,
        {
          childStep: childStepOf(picker, groups),
          nextAction: {
            tool: 'connect_agent_oauth',
            arguments: {
              action: 'select_accounts',
              agent_guid: agentGuid,
              credential,
              picker: next.key,
              selections: readable.map(group => ({ parent: group.parent.id, items: group.items.map(item => item.id) })),
            },
            reason: 'Ask the user which ones to keep; this preselects all of them.',
          },
        },
        ['', ...groups.flatMap(group => [
          `- ${group.parent.name || group.parent.id} (${group.parent.id})${group.errorCode ? `: could not be read (${group.errorCode})` : ''}`,
          ...group.items.map(item => `  - ${item.name || item.id} (${item.id})`),
        ])]);
    }
    const built = buildChainedSelections(next, groups, input.selections);
    if (built.error || !built.selections) return errorResult(new Error(built.error ?? 'Nothing to save.'));
    const saved = requireApiSuccess(
      await client.post<PickerBody>('/UserAgentOAuth/SetPickerAccounts', {
        useragentguid: agentGuid,
        credentialkey: credential,
        pickerkey: next.key,
        selections: built.selections,
      }, signal),
      `Could not save the ${next.label}.`,
    );
    const mappings = Array.isArray(saved[next.persistField]) ? (saved[next.persistField] as unknown[]).filter(isPlainObject) : [];
    const savedGroups = groups.filter(group => !group.errorCode).map(group => ({
      ...group,
      items: mappings
        .filter(mapping => asString(mapping[next.parentValueField]) === group.parent.id)
        .map(mapping => ({
          id: asString(mapping[next.itemValueField]) ?? '',
          name: asString(mapping[next.itemLabelField]) ?? '',
        })),
    }));
    const skipped = built.skippedParents.length > 0
      ? ` Nothing was chosen for ${accountsLine(built.skippedParents)}.`
      : '';
    return result('select_accounts', context, 'connected',
      `Saved ${mappings.length} ${next.label}.${skipped} A running agent restarts to use them.`,
      { childStep: { ...childStepOf(picker, savedGroups, mappings.length > 0) } });
  }

  if (!input.accounts || input.accounts.length === 0) {
    return errorResult(new Error('Pass accounts (each {id, name}) to save, or picker to run the extra step.'));
  }
  const built = buildPickerAccounts(picker, input.accounts);
  if (built.error || !built.accounts) return errorResult(new Error(built.error ?? 'Nothing to save.'));
  const saved = requireApiSuccess(
    await client.post<PickerBody>('/UserAgentOAuth/SetPickerAccounts', {
      useragentguid: agentGuid,
      credentialkey: credential,
      accounts: built.accounts,
    }, signal),
    'Could not save the accounts.',
  );
  const accounts = toAccountRefs(saved.accounts, picker);
  const next = picker.next;
  if (next) {
    return result('select_accounts', context, next.optional ? 'connected' : 'pick_child_items',
      `Saved ${accounts.length} account${accounts.length === 1 ? '' : 's'}: ${accountsLine(accounts)}. ${next.optional ? `Optionally, also choose ${next.label}.` : `Next, choose the ${next.label} for each account.`} A running agent restarts to use the accounts.`,
      {
        accounts,
        nextAction: {
          tool: 'connect_agent_oauth',
          arguments: { action: 'select_accounts', agent_guid: agentGuid, credential, picker: next.key },
          reason: next.optional
            ? `Optional: list the ${next.label} if the user wants to choose them.`
            : `List the ${next.label} to choose from.`,
        },
      });
  }
  return result('select_accounts', context, 'connected',
    `Saved ${accounts.length} account${accounts.length === 1 ? '' : 's'}: ${accountsLine(accounts)}. A running agent restarts to use them.`,
    { accounts });
}

export function registerConnectAgentOauth(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'connect_agent_oauth',
    {
      title: 'Connect an agent integration',
      description: 'Connect a sign-in based integration (Google Ads, GA4, YouTube, Google Business, '
        + 'Merchant Center, Meta Ads, Instagram, Facebook Pages, TikTok, LinkedIn, X, HubSpot, '
        + 'Mailchimp, Reddit, Shopify) to a deployed agent. action connect: with Wiro\'s own app '
        + '(mode wiro) or the user\'s own app (mode own) it returns a sign-in link that the user '
        + 'must open in their own browser and approve within 15 minutes; never open it for them. '
        + 'With mode api_key it checks a token saved earlier with set_agent_credentials and returns '
        + 'the accounts it can use, with no browser. Without mode the tool picks the one that '
        + 'works; when a provider needs the user\'s own app keys or a token first, it says which to '
        + 'save. action status: whether the sign-in finished (wait_seconds waits for '
        + 'the user). action select_accounts: saves which accounts the agent uses ({id, name} from '
        + 'connect), and with picker runs the extra step some providers have (Meta Ads pages, '
        + 'Google Business locations). Connecting again replaces an existing connection and needs '
        + 'confirm: true. A running agent restarts when a connection or selection is saved. '
        + 'Remove a connection with disconnect_agent_oauth. Connect only a credential that the agent\'s '
        + 'skills use (get_my_agent lists them). Only the person who deployed the agent can connect, so the '
        + 'connected project must be one that person created. The agents playbook (get_playbook) has the '
        + 'full setup walkthrough.',
      inputSchema: {
        action: z.enum(['connect', 'status', 'select_accounts']).default('connect')
          .describe('connect (default) starts a connection, status checks it, select_accounts saves the accounts to use.'),
        agent_guid: z.string().min(1).describe('The deployed agent\'s guid, from list_my_agents.'),
        credential: z.string().min(1)
          .describe('The integration\'s credential key, for example "google-ads", "meta-ads", "instagram", "hubspot" or "shopify".'),
        mode: z.enum(['wiro', 'own', 'api_key']).optional()
          .describe('connect: wiro (Wiro\'s app), own (the user\'s own app, keys saved first) or api_key (a saved token, no browser). Omit to let the tool choose.'),
        redirect_url: z.string().max(2_048).optional()
          .describe('connect: where the browser goes after sign-in. Defaults to the agent\'s page in the Wiro dashboard, which also handles the account choice. The only other accepted address is a local one on the user\'s own machine (http://localhost or http://127.0.0.1, any port). Keep the default unless the user asks.'),
        since_connected_at: z.string().optional()
          .describe('status: the since_connected_at value from connect\'s nextAction, so an older connection is not mistaken for the new one.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0)
          .describe(`status: how long to wait for the sign-in to finish, 0 to ${MAX_WAIT_SECONDS} seconds (default 0, a single check).`),
        accounts: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).optional()
          .describe('select_accounts: the accounts to use, each {id, name}, as returned by connect.'),
        picker: z.string().optional()
          .describe('select_accounts: the extra step\'s key ("pages" for Meta Ads, "locations" for Google Business). Without selections it lists the choices.'),
        selections: z.array(z.object({
          parent: z.string().describe('An account id from the earlier step.'),
          items: z.array(z.string()).describe('The ids of the items to use under that account.'),
        })).optional()
          .describe('select_accounts with picker: what to use under each account. Accounts left out get nothing.'),
        confirm: z.boolean().default(false)
          .describe('connect: true to replace an existing connection after the user agreed.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      let meta: CredentialMeta | null = null;
      try {
        const credential = args.credential.trim();
        meta = await loadCredentialMeta(client, credential, extra.signal);
        if (!meta) return errorResult(new Error(`Unknown credential "${credential}".`));
        if (!meta.oauth) {
          return errorResult(new Error(`${meta.title} is not a sign-in connection. Save its fields with set_agent_credentials (call it with credential "${credential}" to see them).`));
        }
        const context: Context = { client, agentGuid: args.agent_guid, credential, meta, signal: extra.signal };
        if (args.action === 'status') {
          return await status(context, { since: args.since_connected_at, waitSeconds: args.wait_seconds }, extra);
        }
        if (args.action === 'select_accounts') {
          return await selectAccounts(context, {
            accounts: args.accounts,
            picker: args.picker?.trim() || undefined,
            selections: args.selections,
          });
        }
        return await connect(context, { mode: args.mode, redirectUrl: args.redirect_url, confirm: args.confirm });
      } catch (error) {
        return errorResult(withHint(error, meta ?? undefined));
      }
    },
  );
}
