import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';
import { toAgentConnection, toCatalogConnector } from '../dist/utils/agent-connectors.js';

const AGENT = 'ua-connectors';
const NOW = Math.floor(Date.now() / 1000);
const KEY = 'serper-secret-key-0123456789';
const CLIENT_SECRET = 'own-app-client-secret-0123456789';

// ---------------------------------------------------------------------------
// Catalog rows, as /AgentConnector/List and Detail show them
// ---------------------------------------------------------------------------

const SERPER = {
  slug: 'serper',
  title: 'Serper',
  description: 'Google search results through Serper.',
  category: 'data',
  iconurl: 'https://cdn.example/serper.png',
  websiteurl: 'https://serper.dev',
  authtype: 'fields',
  transport: 'local',
  credentialfields: [
    { name: 'apikey', label: 'API key', description: '1. Sign in at **serper.dev**.\n2. Copy the key from the dashboard.', required: true, secret: true, format: 'password' },
    { name: 'country', label: 'Country', description: 'Two letters, such as `us`.', required: false, secret: false, format: 'text', placeholder: 'us' },
  ],
  accountpickers: [],
  scopes: [],
  modes: [],
  tools: [
    { name: 'search', title: 'Search', description: 'Search the web.', readonly: true, destructive: false },
    { name: 'api_request', title: 'API request', description: 'Any other call.', readonly: false, destructive: true },
  ],
  docs: { overview: 'Search the web from the agent.', setup: ['Create a Serper account.', 'Copy the API key.'], revoke: 'Delete the key on serper.dev.', limits: '2,500 free searches.' },
  sortorder: 1,
  updatedat: NOW - 86400,
};

const FACEBOOK = {
  slug: 'facebook-pages',
  title: 'Facebook Pages',
  description: 'Post to Facebook Pages.',
  category: 'social',
  authtype: 'provider-oauth',
  transport: 'local',
  credentialfields: [
    { name: 'appid', label: 'App ID', description: 'From your Meta app. Allow {callbackurl} as a redirect URI.', required: true, secret: false, format: 'text', serveronly: true, mode: 'oauth' },
    { name: 'appsecret', label: 'App Secret', description: 'From your Meta app.', required: true, secret: true, format: 'password', serveronly: true, mode: 'oauth' },
    { name: 'systemusertoken', label: 'System User Token', description: 'A token of a system user of your business.', required: true, secret: true, format: 'password', mode: 'key' },
  ],
  accountpickers: [{ key: 'pages', label: 'Facebook Pages', description: 'The Pages the agent may post to.', multiple: true }],
  scopes: ['pages_manage_posts'],
  modes: ['oauth', 'key'],
  tools: [{ name: 'list_pages', title: 'List pages', description: 'The Pages this sign-in reaches.', readonly: true, destructive: false }],
  docs: null,
};

// A remote row (the vendor's own MCP server, signed in with OAuth) with an account choice: Wiro lists the advertisers
// a sign-in reaches by calling the vendor's read tool, and the bridge holds the agent to the ones chosen.
const TIKTOK_ADS = {
  slug: 'tiktok-ads',
  title: 'TikTok Ads',
  description: 'Manage TikTok ad campaigns.',
  category: 'marketing',
  authtype: 'oauth',
  transport: 'streamable-http',
  credentialfields: [],
  accountpickers: [{ key: 'advertisers', label: 'Advertisers', description: 'The advertiser accounts the agent may work with.', multiple: true }],
  scopes: ['mcp:tt4b'],
  modes: [],
  tools: [{ name: 'auth_advertiser_get', title: 'Advertisers', description: 'The advertisers this sign-in reaches.', readonly: true, destructive: false }],
  docs: null,
};

const WIRO = {
  slug: 'wiro',
  title: 'Wiro',
  description: 'Run AI models.',
  category: 'ai',
  authtype: 'headers',
  transport: 'streamable-http',
  credentialfields: [{ name: 'wiro_credentials', label: 'Wiro credentials', description: '', required: true, secret: true, format: 'password', source: 'wiro_project' }],
  accountpickers: [],
  scopes: [],
  modes: [],
  tools: [],
  docs: null,
};

const CATALOG = [SERPER, FACEBOOK, TIKTOK_ADS, WIRO];

function connection(row, overrides = {}) {
  return {
    slug: row.slug,
    title: row.title,
    iconurl: null,
    category: row.category,
    authtype: row.authtype,
    transport: row.transport,
    authmode: null,
    catalogstatus: 'active',
    status: 'connected',
    connectedat: NOW - 3600,
    updatedat: NOW - 3600,
    tokenexpiresat: null,
    refreshtokenexpiresat: null,
    scope: null,
    accounts: {},
    wiroprojectid: null,
    savedvariables: [],
    lasterror: null,
    ...overrides,
  };
}

function detailRow(overrides = {}) {
  return {
    guid: AGENT,
    title: 'Connector agent',
    status: 4,
    teamguid: null,
    agent: { guid: 'tpl-1', custom: false },
    skills: [],
    credentials: {},
    communicationChannels: [],
    customskills: [],
    scheduledskills: [
      { key: 'cs-cron-weekly-search', description: 'Weekly search', value: 'Search the news.', interval: '0 9 * * 1', enabled: true, requires_credentials: [], requires_connectors: ['serper'], _source: 'user-created', _editable: true, _user_created: true },
      { key: 'cs-cron-off-search', description: 'Off', value: 'Search.', interval: '0 9 * * 2', enabled: false, requires_credentials: [], requires_connectors: ['serper'], _source: 'user-created', _editable: true, _user_created: true },
    ],
    ...overrides,
  };
}

function catalogDetail(body) {
  const row = CATALOG.find(item => item.slug === body.slug);
  return row
    ? { result: true, errors: [], agentconnectors: [structuredClone(row)] }
    : { result: false, errors: [{ code: 0, message: 'Connector not found.' }] };
}

const TELEGRAM_CREDENTIAL = {
  key: 'telegram',
  title: 'Telegram',
  credential_schema: [{ key: 'bottoken', type: 'password', label: 'Bot Token', required: true }],
  channel: { id: 'telegram', required_fields: ['bottoken'] },
};

function credentialDetail(body) {
  return body.key === 'telegram'
    ? { result: true, errors: [], credential: TELEGRAM_CREDENTIAL }
    : { result: false, errors: [{ code: 404, message: `Credential not found: ${body.key}` }] };
}

function routes(extra = {}) {
  return {
    '/AgentConnector/List': { result: true, errors: [], agentconnectors: structuredClone(CATALOG) },
    '/AgentConnector/Detail': catalogDetail,
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [] },
    '/UserAgent/Detail': { result: true, errors: [], useragents: [detailRow()] },
    '/Credentials/Detail': credentialDetail,
    ...extra,
  };
}

function fakeClient(table) {
  const calls = [];
  return {
    calls,
    paths: () => calls.map(call => call.path),
    called: path => calls.filter(call => call.path === path),
    isOwnApiKey: value => value === 'own-project-key',
    async post(path, body = {}) {
      calls.push({ path, body });
      const route = table[path];
      if (route === undefined) throw new Error(`Unexpected call to ${path}`);
      return typeof route === 'function' ? route(body, calls) : structuredClone(route);
    },
  };
}

async function withClient(fake, callback) {
  const server = createMcpServer(fake);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function text(result) {
  return result.content.map(block => block.text ?? '').join('\n');
}

const call = (client, name, args) => client.callTool({ name, arguments: args });

// ---------------------------------------------------------------------------
// The parsers
// ---------------------------------------------------------------------------

test('a catalog row reads as how it connects, its fields, account choices, tools and docs, and never a value', () => {
  const serper = toCatalogConnector(SERPER);
  assert.deepEqual(serper.ways, ['key']);
  assert.deepEqual(serper.fields.map(field => [field.name, field.required, field.secret, field.format]), [['apikey', true, true, 'password'], ['country', false, false, 'text']]);
  assert.deepEqual(serper.tools[1], { name: 'api_request', title: 'API request', description: 'Any other call.', readOnly: false, destructive: true });
  assert.deepEqual(serper.docs, { overview: 'Search the web from the agent.', setup: ['Create a Serper account.', 'Copy the API key.'], revoke: 'Delete the key on serper.dev.', limits: '2,500 free searches.' });
  assert.equal(serper.updatedAt, new Date((NOW - 86400) * 1000).toISOString());

  const facebook = toCatalogConnector(FACEBOOK);
  assert.deepEqual(facebook.ways, ['sign_in', 'key']);
  assert.deepEqual(facebook.fields.map(field => [field.name, field.appKey ?? false, field.mode]), [['appid', true, 'sign_in'], ['appsecret', true, 'sign_in'], ['systemusertoken', false, 'key']]);
  assert.deepEqual(facebook.accountPickers, [{ key: 'pages', label: 'Facebook Pages', description: 'The Pages the agent may post to.', multiple: true }]);
  assert.deepEqual(toCatalogConnector(TIKTOK_ADS).ways, ['sign_in']);
  assert.deepEqual(toCatalogConnector(WIRO).ways, ['project']);
  assert.equal(toCatalogConnector(WIRO).fields[0].project, true);
  assert.deepEqual(toCatalogConnector({ slug: 'deepwiki', title: 'DeepWiki', authtype: 'none' }).ways, ['none']);

  const view = toAgentConnection(connection(FACEBOOK, { authmode: 'own', accounts: { pages: ['1', 2, ''] }, savedvariables: ['appid'], lasterror: 'x'.repeat(300) }));
  assert.equal(view.way, 'sign_in');
  assert.equal(view.ownApp, true);
  assert.deepEqual(view.accounts, { pages: ['1', '2'] });
  assert.equal(view.lastError.length, 203);
  assert.equal(toAgentConnection(connection(WIRO, { wiroprojectid: '12345' })).way, 'project');
  assert.equal(toAgentConnection(connection(SERPER, { status: 'gone' })), null);
});

// ---------------------------------------------------------------------------
// list_agent_connectors
// ---------------------------------------------------------------------------

test('list_agent_connectors lists the catalog with how each one connects, and the agent\'s state with agent_guid', async () => {
  const retired = connection({ slug: 'old-crm', title: 'Old CRM', category: 'crm', authtype: 'fields', transport: 'local' }, { catalogstatus: 'retired' });
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(SERPER, { savedvariables: ['apikey'] }), connection(FACEBOOK, { status: 'pending', authmode: null, connectedat: null }), retired] },
  }));
  await withClient(fake, async client => {
    const result = await call(client, 'list_agent_connectors', { agent_guid: AGENT });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(fake.called('/AgentConnector/List')[0].body, {});
    const { connectors, connections, total } = result.structuredContent;
    assert.equal(total, 4);
    assert.deepEqual(connectors.map(item => [item.slug, item.ways, item.status]), [
      ['serper', ['key'], 'connected'],
      ['facebook-pages', ['sign_in', 'key'], 'pending'],
      ['tiktok-ads', ['sign_in'], 'not_connected'],
      ['wiro', ['project'], 'not_connected'],
    ]);
    assert.equal(connections.length, 3);
    const lines = text(result).split('\n');
    assert.ok(lines.includes('- **Serper** (`serper`, data, key) [connected]: Google search results through Serper.'), text(result));
    assert.ok(lines.includes('- **Facebook Pages** (`facebook-pages`, social, sign-in or key, account choices: Facebook Pages) [sign-in started, not finished]: Post to Facebook Pages.'), text(result));
    // A remote row's account choices show the same way.
    assert.ok(lines.includes('- **TikTok Ads** (`tiktok-ads`, marketing, sign-in, account choices: Advertisers) [not connected]: Manage TikTok ad campaigns.'), text(result));
    assert.deepEqual(connectors.map(item => [item.slug, item.accountPickers]), [['serper', 0], ['facebook-pages', 1], ['tiktok-ads', 1], ['wiro', 0]]);
    assert.ok(lines.includes('- **Wiro** (`wiro`, ai, Wiro project) [not connected]: Run AI models.'), text(result));
    // A connection whose connector the catalog no longer offers is listed apart.
    assert.match(text(result), /### Connections the catalog no longer offers\n\n- Old CRM \(`old-crm`\): connected, but the catalog no longer offers it \(retired\) since /);
    assert.equal(JSON.stringify(result).includes('credentialfields'), false);
  });

  // Search and category go to Wiro as they are; one match leads to its detail.
  const one = fakeClient(routes({ '/AgentConnector/List': { result: true, errors: [], agentconnectors: [structuredClone(SERPER)] } }));
  await withClient(one, async client => {
    const result = await call(client, 'list_agent_connectors', { search: ' web search ', category: 'Data' });
    assert.deepEqual(one.called('/AgentConnector/List')[0].body, { search: 'web search', category: 'data' });
    assert.deepEqual(result.structuredContent.nextAction, { tool: 'list_agent_connectors', arguments: { name: 'serper' }, reason: 'See what Serper needs before asking the user for it.' });
    assert.equal(one.paths().includes('/UserAgent/ConnectorList'), false);
  });
});

test('list_agent_connectors with name shows the Connect card, where each value comes from, account choices, tools and setup', async () => {
  const fake = fakeClient(routes());
  await withClient(fake, async client => {
    const result = await call(client, 'list_agent_connectors', { name: 'Serper', agent_guid: AGENT });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(fake.called('/AgentConnector/Detail')[0].body, { slug: 'serper' });
    const out = text(result);
    assert.ok(out.includes([
      '### What the user provides',
      '',
      '- **API key** (`apikey`, required, secret)',
      '  1. Sign in at **serper.dev**.',
      '  2. Copy the key from the dashboard.',
      '- **Country** (`country`, optional)',
      '  Two letters, such as `us`.',
    ].join('\n')), out);
    assert.ok(out.includes('### Tools the agent gets (named serper__<tool>)\n\n- `search` (reads): `Search the web.`\n- `api_request` (changes or deletes): `Any other call.`'), out);
    assert.ok(out.includes('### Setup\n\nSearch the web from the agent.\n1. Create a Serper account.\n2. Copy the API key.\n\n**Revoke access:** Delete the key on serper.dev.\n\n**Limits:** 2,500 free searches.'), out);
    assert.match(out, /\*\*On this agent:\*\* not connected/);
    assert.equal(result.structuredContent.connector.slug, 'serper');
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'connect_agent_connector',
      arguments: { action: 'connect', agent_guid: AGENT, connector: 'serper' },
      reason: 'Ask the user for API key, then call it with them in values. Never ask for them in a message to an agent.',
    });
  });

  // A sign-in with the service's own OAuth says the user's own app signs in, and lists account choices.
  const connected = fakeClient(routes({ '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(FACEBOOK, { authmode: 'own' })] } }));
  await withClient(connected, async client => {
    const result = await call(client, 'list_agent_connectors', { name: 'facebook-pages', agent_guid: AGENT });
    const out = text(result);
    assert.match(out, /\*\*Connects with:\*\* a sign-in the user approves in their own browser, or values typed on its Connect card \(mode sign_in or key\)/);
    assert.match(out, /The sign-in uses the user's own app at the service: its keys go in values with the connect call, and its consent page shows that app\./);
    assert.match(out, /- \*\*App ID\*\* \(`appid`, required, a key of the user's own app, used only to sign in, only with mode sign_in\)/);
    assert.match(out, /- \*\*System User Token\*\* \(`systemusertoken`, required, secret, only with mode key\)/);
    assert.match(out, /### Account choices\n\nOnce it is connected, set_agent_connector_accounts lists these and saves the ones the agent may use; it acts only on those\.\n\n- \*\*Facebook Pages\*\* \(`pages`, one or more\): The Pages the agent may post to\./);
    // Connected with nothing chosen yet: the next step lists the choices.
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'set_agent_connector_accounts',
      arguments: { agent_guid: AGENT, connector: 'facebook-pages' },
      reason: 'List the Facebook Pages to choose from; none is chosen yet.',
    });
  });
});

test('list_agent_connectors points a chat channel to set_agent_credentials, and names no connector it does not know', async () => {
  const fake = fakeClient(routes());
  await withClient(fake, async client => {
    const channel = await call(client, 'list_agent_connectors', { name: 'telegram', agent_guid: AGENT });
    assert.notEqual(channel.isError, true, text(channel));
    assert.deepEqual(channel.structuredContent.credential, { key: 'telegram', title: 'Telegram', kind: 'channel' });
    assert.match(text(channel), /Telegram is a chat channel, not a connector\. set_agent_credentials with credential "telegram" shows its fields and saves them\./);
    assert.deepEqual(channel.structuredContent.nextAction.arguments, { agent_guid: AGENT, credential: 'telegram' });

    const unknown = await call(client, 'list_agent_connectors', { name: 'no-such-thing' });
    assert.equal(unknown.isError, true);
    assert.equal(text(unknown), '## Error\n\nNo connector is named "no-such-thing". list_agent_connectors without name lists them, and search narrows the list.');
  });
});

// ---------------------------------------------------------------------------
// connect_agent_connector: values
// ---------------------------------------------------------------------------

test('connect_agent_connector lists what is missing and sends nothing, then connects with the values and never shows them', async () => {
  let connected = false;
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorConnect': () => {
      connected = true;
      return { result: true, errors: [], status: 'connected', applied: 1, restart: 'scheduled', useragentconnectors: [connection(SERPER, { savedvariables: ['apikey'] })] };
    },
  }));
  await withClient(fake, async client => {
    const missing = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper' });
    assert.notEqual(missing.isError, true, text(missing));
    assert.equal(missing.structuredContent.state, 'setup_needed');
    assert.deepEqual(missing.structuredContent.missing, ['apikey']);
    assert.deepEqual(missing.structuredContent.fields.map(field => field.name), ['apikey', 'country']);
    assert.match(text(missing), /Serper needs API key first\. Ask the user for them, then call connect_agent_connector again with them in values\. Never put them in a message to an agent\. Nothing was sent\./);
    assert.match(text(missing), /- \*\*API key\*\* \(`apikey`, secret\)\n  1\. Sign in at \*\*serper\.dev\*\*\./);
    assert.equal(fake.paths().includes('/UserAgent/ConnectorConnect'), false);

    const result = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', values: { apikey: KEY, country: 'us' } });
    assert.notEqual(result.isError, true, text(result));
    assert.ok(connected);
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[0].body, { useragentguid: AGENT, slug: 'serper', values: { apikey: KEY, country: 'us' } });
    const out = result.structuredContent;
    assert.equal(out.state, 'connected');
    assert.equal(out.applied, 1);
    assert.equal(out.restart, 'scheduled');
    assert.deepEqual(out.connection.savedFields, ['apikey']);
    assert.match(out.message, /^Serper is connected\. A running agent restarts to load it, which takes about a minute\. Scheduled tasks that need it run once it is loaded: Weekly Search \(`cs-cron-weekly-search`\)\. Every run uses the agent's credits\.$/);
    assert.equal(out.nextAction, undefined);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  });
});

test('connect_agent_connector refuses unknown values, a masked secret, a mode or a project the connector does not take', async () => {
  const fake = fakeClient(routes());
  await withClient(fake, async client => {
    const unknown = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', values: { api_key: KEY } });
    assert.equal(unknown.isError, true);
    assert.equal(text(unknown), '## Error\n\nUnknown value "api_key". Serper takes "apikey", "country". Nothing was sent.');

    const masked = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', values: { apikey: '••••••••' } });
    assert.equal(text(masked), '## Error\n\napikey holds the dots Wiro shows in place of a saved secret, not the secret itself. Send the value itself. Nothing was sent.');

    const mode = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', mode: 'key', values: { apikey: KEY } });
    assert.equal(text(mode), '## Error\n\nSerper connects only with values typed on its Connect card, so it takes no mode. Leave mode out.');

    const project = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', project_id: '12345', values: { apikey: KEY } });
    assert.equal(text(project), '## Error\n\nSerper takes no Wiro project. Leave project_id out.');

    const wrongMode = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'facebook-pages', mode: 'key', values: { appid: '123' } });
    assert.equal(text(wrongMode), '## Error\n\nApp ID (appid) belongs to mode sign_in, not mode key. Nothing was sent.');

    const channel = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'telegram' });
    assert.equal(text(channel), '## Error\n\nTelegram is a chat channel, not a connector. Save its fields with set_agent_credentials (call it with credential "telegram" to see them).');

    const redirect = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads', redirect_url: 'http://example.com/back' });
    assert.match(text(redirect), /redirect_url must be an https address, or http:\/\/localhost or http:\/\/127\.0\.0\.1 on the user's own machine\./);
    assert.equal(fake.paths().includes('/UserAgent/ConnectorConnect'), false);
  });
});

test('connect_agent_connector counts saved values, and asks before it replaces a working connection, without repeating values', async () => {
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(SERPER, { savedvariables: ['apikey'] })] },
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'connected', applied: 0, restart: 'none', useragentconnectors: [connection(SERPER, { savedvariables: ['apikey', 'country'] })] },
  }));
  await withClient(fake, async client => {
    const asked = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', values: { country: 'de', apikey: KEY } });
    assert.notEqual(asked.isError, true, text(asked));
    assert.equal(asked.structuredContent.state, 'confirm_needed');
    assert.match(asked.structuredContent.message, /^Serper is already connected \(since .+\)\. Connecting again replaces that connection and its saved values\. Nothing has changed yet\. Ask the user to confirm\. Repeat the call with confirm: true and the same values\.$/);
    assert.deepEqual(asked.structuredContent.nextAction.arguments, { action: 'connect', agent_guid: AGENT, connector: 'serper', confirm: true });
    assert.equal(JSON.stringify(asked).includes(KEY), false);
    assert.equal(fake.paths().includes('/UserAgent/ConnectorConnect'), false);

    // The saved key stands for the required value, so a change of the country alone needs no key.
    const confirmed = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', values: { country: 'de' }, confirm: true });
    assert.notEqual(confirmed.isError, true, text(confirmed));
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[0].body.values, { country: 'de' });
    assert.match(confirmed.structuredContent.message, /^Serper is connected\. It already held this, so the agent does not restart\./);
  });
});

// ---------------------------------------------------------------------------
// connect_agent_connector: sign-ins
// ---------------------------------------------------------------------------

test('connect_agent_connector starts a sign-in that the user opens, and status waits until it finished', async () => {
  let reads = 0;
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'pending', authorizeUrl: 'https://ads.example/authorize?state=abc' },
    '/UserAgent/ConnectorList': () => {
      reads += 1;
      const rows = reads === 1 ? [] : reads === 2 ? [connection(TIKTOK_ADS, { status: 'pending', connectedat: null })] : [connection(TIKTOK_ADS, { connectedat: NOW })];
      return { result: true, errors: [], useragentconnectors: rows };
    },
  }));
  await withClient(fake, async client => {
    const started = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads', redirect_url: 'http://localhost:5173/done' });
    assert.notEqual(started.isError, true, text(started));
    const out = started.structuredContent;
    assert.equal(out.state, 'authorize_in_browser');
    assert.equal(out.authorizeUrl, 'https://ads.example/authorize?state=abc');
    assert.equal(out.expiresInSeconds, 600);
    assert.match(out.message, /The user must open this link in their own browser and approve access within 10 minutes\. Never open it for them\. Its consent page names the agent's owner: its organization, team or account\. After approving, the browser goes to http:\/\/localhost:5173\/done\./);
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[0].body, { useragentguid: AGENT, slug: 'tiktok-ads', redirecturl: 'http://localhost:5173/done' });
    assert.deepEqual(out.nextAction.arguments, { action: 'status', agent_guid: AGENT, connector: 'tiktok-ads', since_connected_at: '', wait_seconds: 45 });
    assert.ok(text(started).includes('\n\nhttps://ads.example/authorize?state=abc'), text(started));

    const waiting = await call(client, 'connect_agent_connector', { action: 'status', agent_guid: AGENT, connector: 'tiktok-ads' });
    assert.equal(waiting.structuredContent.state, 'waiting_for_user');
    assert.equal(waiting.structuredContent.nextAction.arguments.action, 'status');

    const done = await call(client, 'connect_agent_connector', { action: 'status', agent_guid: AGENT, connector: 'tiktok-ads', since_connected_at: '' });
    assert.equal(done.structuredContent.state, 'connected');
    assert.match(done.structuredContent.message, /^TikTok Ads is connected \(since .+\)\. The running agent restarts to load it, which takes about a minute\. Choose the Advertisers it may act on with set_agent_connector_accounts\.$/);
  });
});

test('connect_agent_connector status tells an older connection, a failed sign-in and an expired one apart', async () => {
  const since = new Date((NOW - 3600) * 1000).toISOString();
  const answer = row => fakeClient(routes({ '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: row ? [row] : [] } }));
  const status = async (fake, args = {}) => {
    let result;
    await withClient(fake, async client => {
      result = await call(client, 'connect_agent_connector', { action: 'status', agent_guid: AGENT, connector: 'tiktok-ads', ...args });
    });
    return result;
  };
  const older = await status(answer(connection(TIKTOK_ADS, { connectedat: NOW - 3600 })), { since_connected_at: since });
  assert.equal(older.structuredContent.state, 'waiting_for_user');
  const failed = await status(answer(connection(TIKTOK_ADS, { status: 'error', lasterror: 'authorization_denied' })));
  assert.equal(failed.structuredContent.state, 'failed');
  assert.match(failed.structuredContent.message, /did not finish: the user did not approve access at the service\. Connect again with action connect\./);
  const expired = await status(answer(connection(TIKTOK_ADS, { status: 'reauth' })));
  assert.equal(expired.structuredContent.state, 'reauth_needed');
  assert.equal(expired.structuredContent.nextAction.arguments.action, 'connect');
  const none = await status(answer(null));
  assert.equal(none.structuredContent.state, 'not_connected');
});

test('connect_agent_connector signs in with the user\'s own app keys, or connects a hybrid with its key in mode key', async () => {
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorConnect': body => (body.mode === 'key'
      ? { result: true, errors: [], status: 'connected', applied: 1, restart: 'scheduled', useragentconnectors: [connection(FACEBOOK, { authmode: 'key' })] }
      : { result: true, errors: [], status: 'pending', authorizeUrl: 'https://www.facebook.com/dialog/oauth?state=abc' }),
  }));
  await withClient(fake, async client => {
    const keys = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'facebook-pages' });
    assert.equal(keys.structuredContent.state, 'setup_needed');
    assert.equal(keys.structuredContent.mode, 'sign_in');
    assert.deepEqual(keys.structuredContent.missing, ['appid', 'appsecret']);
    assert.match(keys.structuredContent.message, /The sign-in uses the user's own app at the service, so its keys come with the connect call\./);
    // The redirect URI the app allows is in the field's own help.
    assert.deepEqual(keys.structuredContent.fields.map(field => field.name), ['appid', 'appsecret']);

    const signIn = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'facebook-pages', values: { appid: '1234', appsecret: CLIENT_SECRET } });
    assert.equal(signIn.structuredContent.state, 'authorize_in_browser');
    assert.match(signIn.structuredContent.message, /Its consent page shows the user's own app\./);
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[0].body, { useragentguid: AGENT, slug: 'facebook-pages', values: { appid: '1234', appsecret: CLIENT_SECRET } });
    assert.equal(JSON.stringify(signIn).includes(CLIENT_SECRET), false);

    const token = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'facebook-pages', mode: 'key', values: { systemusertoken: 'EAAG-system-user-token' } });
    assert.equal(token.structuredContent.state, 'connected');
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[1].body, { useragentguid: AGENT, slug: 'facebook-pages', values: { systemusertoken: 'EAAG-system-user-token' }, mode: 'key' });
    assert.match(token.structuredContent.message, /Choose the Facebook Pages it may act on with set_agent_connector_accounts\./);
    assert.deepEqual(token.structuredContent.nextAction, {
      tool: 'set_agent_connector_accounts',
      arguments: { agent_guid: AGENT, connector: 'facebook-pages' },
      reason: 'List the Facebook Pages to choose from.',
    });
    assert.equal(JSON.stringify(token).includes('EAAG-system-user-token'), false);
  });
});

// The wiro connector always runs with the agent's own Wiro project, so Wiro binds the project a connect names to the
// agent, as bind_agent_project does: the preview says so, with the project it replaces, and its calls are the agent's.
test('connect_agent_connector shows the Wiro project it binds to the agent, what it replaces and the wallet, and binds only with confirm', async () => {
  const projects = { result: true, errors: [], project: [
    { id: '111', name: 'Main', apikey: 'own-project-key', teamguid: null },
    { id: '222', name: 'Side', apikey: 'other-key', teamguid: null },
  ] };
  const fake = fakeClient(routes({
    '/Project/List': projects,
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'connected', applied: 1, restart: 'scheduled', useragentconnectors: [connection(WIRO, { wiroprojectid: '222' })] },
  }));
  await withClient(fake, async client => {
    const own = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro' });
    assert.equal(own.structuredContent.state, 'confirm_needed');
    assert.deepEqual(own.structuredContent.project, { id: '111', name: 'Main' });
    assert.equal(own.structuredContent.replacesProject, undefined, 'the agent has no project yet');
    assert.equal(own.structuredContent.message, 'Wiro runs with the agent\'s own Wiro project: connecting it makes `Main` (id `111`) that project, as '
      + 'bind_agent_project does, so the agent\'s video and voice skills use it too. Model runs through it are billed to the wallet of '
      + 'the workspace that owns that project, and the agent\'s spend limits and Model Access rules apply to them. Nothing has '
      + 'changed yet. Ask the user to confirm.');
    assert.equal(fake.paths().includes('/UserAgent/ConnectorConnect'), false);

    const unknown = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', project_id: '999' });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /No project with the id 999 is in this connection's workspace/);

    const detailReads = fake.called('/UserAgent/Detail').length;
    const bound = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', project_id: '222', confirm: true });
    assert.notEqual(bound.isError, true, text(bound));
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[0].body, { useragentguid: AGENT, slug: 'wiro', wiroprojectguid: '222' });
    assert.equal(bound.structuredContent.connection.projectId, '222');
    assert.match(bound.structuredContent.message, /The agent's own Wiro project is now `Side` \(id `222`\): its model tools and its video and voice skills run models with it, billed to the wallet of the workspace that owns it\.$/);
    // The confirm reads the agent once, before the connect: for bind_agent_project's checks, what the project turns
    // on and the scheduled tasks the connection starts.
    assert.equal(fake.called('/UserAgent/Detail').length, detailReads + 1);
    assert.ok(fake.paths().lastIndexOf('/UserAgent/Detail') < fake.paths().lastIndexOf('/UserAgent/ConnectorConnect'));
    assert.equal(JSON.stringify(bound).includes('other-key'), false);
  });

  // The agent's project now: replaced by another one, kept when it is the same, and named without its key when it is
  // outside this connection's list.
  const agentWith = key => fakeClient(routes({
    '/Project/List': projects,
    '/UserAgent/Detail': { result: true, errors: [], useragents: [detailRow({ credentials: { wiro: { apikey: key, optional: false, _filled: true } } })] },
  }));
  const preview = async (key, args = {}) => {
    let out;
    await withClient(agentWith(key), async client => {
      out = (await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', ...args })).structuredContent;
    });
    return out;
  };
  const replaced = await preview('other-key');
  assert.deepEqual(replaced.replacesProject, { id: '222', name: 'Side' });
  assert.match(replaced.message, /connecting it makes `Main` \(id `111`\) that project, as bind_agent_project does, so the agent's video and voice skills use it too\. It replaces `Side` \(id `222`\), the agent's project now\. Model runs/);
  const same = await preview('other-key', { project_id: '222' });
  assert.equal(same.replacesProject, undefined);
  assert.match(same.message, /^Wiro runs with the agent's own Wiro project, `Side` \(id `222`\), which stays as it is\. Model runs through it/);
  const outside = await preview('a-key-no-listed-project-has');
  assert.deepEqual(outside.replacesProject, { outsideList: true });
  assert.match(outside.message, /It replaces a project outside this list or a key saved earlier, the agent's project now\./);
  for (const out of [replaced, same, outside]) {
    assert.equal(out.state, 'confirm_needed');
    assert.equal(JSON.stringify(out).includes('other-key') || JSON.stringify(out).includes('a-key-no-listed-project-has'), false);
  }
});

// Binding a project writes the agent's Wiro key, and Wiro then turns on every scheduled task and custom skill that
// needs the project: on a first project all of them, on a new one those that are off now, even ones the user turned
// off. The preview names them before the yes, and the connected result after it, as bind_agent_project does.
test('connect_agent_connector names what a Wiro project turns on, before the yes and after it', async () => {
  const projects = { result: true, errors: [], project: [
    { id: '101', name: 'Second Project', apikey: 'second-key', teamguid: null },
    { id: '102', name: 'Main Project', apikey: 'own-project-key', teamguid: null },
  ] };
  const video = enabled => ({ key: 'cs-cron-weekly-video', description: 'Weekly video', value: 'Make the weekly video.', interval: '0 9 * * 1', enabled, requires_credentials: ['wiro'], requires_connectors: [], _source: 'user-created', _editable: true, _user_created: true });
  const rules = { key: 'cs-video-rules', description: 'Video rules', value: 'Keep videos short.', interval: null, enabled: false, requires_credentials: ['wiro'], _source: 'user-created', _editable: true, _user_created: true };
  const agent = (key, tasks) => ({ result: true, errors: [], useragents: [detailRow({
    credentials: key ? { wiro: { apikey: key, optional: false, _filled: true } } : {},
    scheduledskills: tasks,
    customskills: [rules],
  })] });
  const credits = 'Every run of a scheduled task uses credits; turn off any you do not want with manage_agent_custom_skill.';

  // A new project: what is off now turns on, the task the user turned off included; what is on stays out of it.
  const fake = fakeClient(routes({
    '/Project/List': projects,
    '/UserAgent/Detail': agent('second-key', [video(false), { ...video(true), key: 'cs-cron-daily-video' }]),
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'connected', applied: 1, restart: 'scheduled', useragentconnectors: [connection(WIRO, { wiroprojectid: '102' })] },
  }));
  await withClient(fake, async client => {
    const preview = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', project_id: '102' });
    assert.equal(preview.structuredContent.state, 'confirm_needed');
    assert.deepEqual(preview.structuredContent.replacesProject, { id: '101', name: 'Second Project' });
    const before = `Video Rules (\`cs-video-rules\`) and Weekly Video (\`cs-cron-weekly-video\`) turn on once the project is connected. ${credits}`;
    assert.ok(preview.structuredContent.message.includes(`apply to them. ${before} Nothing has changed yet.`), preview.structuredContent.message);
    assert.doesNotMatch(preview.structuredContent.message, /cs-cron-daily-video/);
    assert.equal(fake.paths().includes('/UserAgent/ConnectorConnect'), false);

    const done = await call(client, 'connect_agent_connector', preview.structuredContent.nextAction.arguments);
    assert.equal(done.structuredContent.state, 'connected');
    assert.ok(done.structuredContent.message.endsWith(`billed to the wallet of the workspace that owns it. ${before.replace('once', 'now that')}`), done.structuredContent.message);
  });

  // A first project turns on every one of them; the agent's own project again turns on nothing.
  const first = fakeClient(routes({ '/Project/List': projects, '/UserAgent/Detail': agent(null, [video(true)]) }));
  await withClient(first, async client => {
    const preview = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro' });
    assert.match(preview.structuredContent.message, /Video Rules \(`cs-video-rules`\) and Weekly Video \(`cs-cron-weekly-video`\) turn on once the project is connected\. Every run/);
  });
  const same = fakeClient(routes({
    '/Project/List': projects,
    '/UserAgent/Detail': agent('own-project-key', [video(false)]),
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'connected', applied: 1, restart: 'scheduled', useragentconnectors: [connection(WIRO, { wiroprojectid: '102' })] },
  }));
  await withClient(same, async client => {
    const preview = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro' });
    assert.match(preview.structuredContent.message, /which stays as it is\./);
    assert.doesNotMatch(preview.structuredContent.message, /turns? on/);
    const done = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', confirm: true });
    assert.doesNotMatch(done.structuredContent.message, /turns? on/);
  });
});

// Wiro refuses a connect that binds a project bind_agent_project would refuse, so the preview refuses it first, with
// bind_agent_project's own sentences, and nothing is sent.
test('connect_agent_connector refuses a Wiro project bind_agent_project would refuse, before any summary', async () => {
  const otherWorkspace = 'This agent is in another workspace than this connection\'s project, and nothing was changed. Connect with a project in the workspace (personal or team) that owns this agent, by its API key or a browser sign-in.';
  const cannotBind = 'You can bind a project you created, or any project of a team you are an admin of. Nothing was changed. list_projects shows which ones.';
  const cases = [
    ['a team key on a personal agent', [{ id: '102', name: 'Main', apikey: 'own-project-key', teamguid: 'team-1' }], {}, otherWorkspace],
    ['a personal key on a team agent', [{ id: '102', name: 'Main', apikey: 'own-project-key', teamguid: null }], { teamguid: 'team-1' }, otherWorkspace],
    // A project the list shows without its key: this connection cannot bind it.
    ['a project without its key', [{ id: '102', name: 'Main', apikey: 'own-project-key', teamguid: null }, { id: '103', name: 'Member', apikeymasked: 'mem***', teamguid: null }], {}, cannotBind, '103'],
  ];
  for (const [label, project, agent, refusal, projectId] of cases) {
    const fake = fakeClient(routes({
      '/Project/List': { result: true, errors: [], project },
      '/UserAgent/Detail': { result: true, errors: [], useragents: [detailRow(agent)] },
    }));
    await withClient(fake, async client => {
      for (const confirm of [false, true]) {
        const result = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', confirm, ...(projectId ? { project_id: projectId } : {}) });
        assert.equal(result.isError, true, label);
        assert.equal(text(result), `## Error\n\n${refusal}`, label);
      }
      assert.equal(fake.paths().includes('/UserAgent/ConnectorConnect'), false, label);
    });
  }
});

// The wiro connector's detail says the same: the agent's own project, its calls the agent's, and which project it runs
// with on this agent, or that it gives the agent nothing while the agent has no project.
test('list_agent_connectors says the wiro connector runs with the agent\'s own project, and what it does on this agent', async () => {
  const detail = async row => {
    let result;
    const fake = fakeClient(routes({ '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: row ? [row] : [] } }));
    await withClient(fake, async client => {
      result = await call(client, 'list_agent_connectors', { name: 'wiro', agent_guid: AGENT });
    });
    assert.notEqual(result.isError, true, text(result));
    return text(result);
  };
  const none = await detail(null);
  assert.match(none, /It runs with the agent's own Wiro project, the one its video and voice skills use: connecting it with connect_agent_connector \(project_id from list_projects, or the project of this connection\) binds that project to the agent, as bind_agent_project does\. Its calls count as the agent's own: the agent's spend limits and Model Access rules apply, model runs are billed to the wallet of the workspace that owns the project, and account, agent and billing calls are refused\./);
  assert.doesNotMatch(none, /On this agent it runs with|gives it nothing/);
  assert.match(await detail(connection(WIRO, { wiroprojectid: '111' })), /On this agent it runs with the project with id `111`\./);
  assert.match(await detail(connection(WIRO, { wiroprojectid: null })), /The agent has no Wiro project now, so the connector gives it nothing until one is bound with connect_agent_connector or bind_agent_project\./);

  // ConnectorList names no project on that connection, so the catalog row says how it connects.
  const fake = fakeClient(routes({ '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(WIRO), connection(SERPER, { savedvariables: ['apikey'] })] } }));
  await withClient(fake, async client => {
    const full = await call(client, 'list_agent_connectors', { name: 'wiro', agent_guid: AGENT });
    assert.equal(full.structuredContent.connections[0].way, 'project');
    const listed = await call(client, 'list_agent_connectors', { agent_guid: AGENT });
    assert.deepEqual(listed.structuredContent.connections.map(item => [item.connector, item.way]), [['wiro', 'project'], ['serper', 'key']]);
  });
  assert.equal(toAgentConnection(connection(WIRO)).way, 'key', 'the connection alone cannot tell');
});

// Accounts the user already knows, such as the advertisers a TikTok Ads call may name, go in with the connect, and a
// sign-in saves them once it finishes. A connector with account choices takes only their keys.
test('connect_agent_connector sends the accounts given with the connect, and checks them against account choices', async () => {
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorConnect': body => (body.slug === 'tiktok-ads'
      ? { result: true, errors: [], status: 'pending', authorizeUrl: 'https://ads.example/authorize?state=abc' }
      : { result: true, errors: [], status: 'connected', applied: 1, restart: 'scheduled', useragentconnectors: [connection(FACEBOOK, { authmode: 'key', accounts: body.accounts ?? {} })] }),
  }));
  await withClient(fake, async client => {
    const started = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads', accounts: { advertisers: ['7001', '7002'] } });
    assert.notEqual(started.isError, true, text(started));
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[0].body, { useragentguid: AGENT, slug: 'tiktok-ads', accounts: { advertisers: ['7001', '7002'] } });
    assert.match(started.structuredContent.message, /The accounts given are saved with the connection once the sign-in finishes\./);

    // An empty list of choices sends none, as if it were left out.
    await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads', accounts: {} });
    assert.equal('accounts' in fake.called('/UserAgent/ConnectorConnect')[1].body, false);

    // A connector with account choices takes only their keys.
    const unknown = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'facebook-pages', mode: 'key', values: { systemusertoken: 'EAAG-system-user-token' }, accounts: { groups: ['1'] } });
    assert.equal(text(unknown), '## Error\n\nFacebook Pages has no account choice "groups". Its choices: "pages" (Facebook Pages). Nothing was sent.');
    assert.equal(fake.called('/UserAgent/ConnectorConnect').length, 2);

    const keyed = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'facebook-pages', mode: 'key', values: { systemusertoken: 'EAAG-system-user-token' }, accounts: { pages: ['123'] } });
    assert.notEqual(keyed.isError, true, text(keyed));
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[2].body.accounts, { pages: ['123'] });
    assert.match(keyed.structuredContent.message, /^Facebook Pages is connected with the accounts given\./);
    // Chosen already, so nothing is left to choose.
    assert.equal(keyed.structuredContent.nextAction, undefined);
  });

  // A single choice takes one id, and accounts come back in the step that repeats the call: they are no secret.
  const single = { ...structuredClone(FACEBOOK), slug: 'ga-property', title: 'GA Property', accountpickers: [{ key: 'property', label: 'Property', multiple: false }] };
  const asked = fakeClient(routes({
    '/AgentConnector/Detail': body => (body.slug === 'ga-property' ? { result: true, errors: [], agentconnectors: [structuredClone(single)] } : catalogDetail(body)),
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(SERPER, { savedvariables: ['apikey'] })] },
  }));
  await withClient(asked, async client => {
    const two = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'ga-property', mode: 'key', values: { systemusertoken: 'EAAG-system-user-token' }, accounts: { property: ['1', '2'] } });
    assert.equal(text(two), '## Error\n\nProperty takes one account. Nothing was sent.');

    const replace = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', values: { apikey: KEY }, accounts: { sites: ['a'] } });
    assert.equal(replace.structuredContent.state, 'confirm_needed');
    assert.deepEqual(replace.structuredContent.nextAction.arguments, { action: 'connect', agent_guid: AGENT, connector: 'serper', accounts: { sites: ['a'] }, confirm: true });
    assert.equal(asked.paths().includes('/UserAgent/ConnectorConnect'), false);
  });
});

// A service account file goes in as a JSON value or as its text. A refusal that quotes one of its keys back shows
// none of them.
test('connect_agent_connector hides every value it was sent, at any depth, from an error text', async () => {
  const GA4 = {
    slug: 'ga4',
    title: 'Google Analytics 4',
    authtype: 'fields',
    transport: 'local',
    credentialfields: [{ name: 'serviceaccountjson', label: 'Service account JSON', description: 'The key file of a service account.', required: true, secret: true, format: 'json' }],
    accountpickers: [],
    tools: [],
  };
  const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
  const EMAIL = 'agent-reader@example-project.iam.gserviceaccount.com';
  const quoted = body => {
    const file = typeof body.values.serviceaccountjson === 'string' ? JSON.parse(body.values.serviceaccountjson) : body.values.serviceaccountjson;
    return { result: false, errors: [{ code: 0, message: `The vendor refused ${file.client_email}: private_key ${file.private_key} and ${JSON.stringify(file.private_key)} are not valid.` }] };
  };
  const fake = fakeClient(routes({
    '/AgentConnector/Detail': body => (body.slug === 'ga4' ? { result: true, errors: [], agentconnectors: [structuredClone(GA4)] } : catalogDetail(body)),
    '/UserAgent/ConnectorConnect': quoted,
  }));
  await withClient(fake, async client => {
    const file = { type: 'service_account', client_email: EMAIL, private_key: PRIVATE_KEY };
    for (const value of [file, JSON.stringify(file)]) {
      const result = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'ga4', values: { serviceaccountjson: value } });
      assert.equal(result.isError, true);
      // Values are hidden as they were sent, trimmed: only the key file's last line break can stay.
      assert.match(text(result), /The vendor refused \[hidden\]: private_key \[hidden\]\s* and "\[hidden\](\\n)?" are not valid\. Nothing was saved\./);
      const everything = JSON.stringify(result);
      for (const secret of [PRIVATE_KEY.trim(), 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', EMAIL]) assert.equal(everything.includes(secret), false, secret);
    }
  });
});

// ---------------------------------------------------------------------------
// set_agent_connector_accounts
// ---------------------------------------------------------------------------

test('set_agent_connector_accounts lists the accounts a connection reaches, then saves the ones the user picked', async () => {
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorAccounts': { result: true, errors: [], pickers: [{ key: 'pages', label: 'Facebook Pages', description: 'The Pages the agent may post to.', multiple: true, candidates: [{ id: '123', name: 'Acme' }, { id: '456', name: 'Beta' }], selected: [] }] },
    '/UserAgent/ConnectorSetAccounts': body => ({ result: true, errors: [], accounts: body.accounts, applied: 1, restart: 'scheduled', useragentconnectors: [connection(FACEBOOK, { accounts: body.accounts })] }),
  }));
  await withClient(fake, async client => {
    const listed = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'facebook-pages' });
    assert.notEqual(listed.isError, true, text(listed));
    assert.equal(listed.structuredContent.mode, 'list');
    assert.deepEqual(listed.structuredContent.pickers[0].candidates, [{ id: '123', name: 'Acme' }, { id: '456', name: 'Beta' }]);
    assert.match(text(listed), /### Facebook Pages \(`pages`, one or more\)\n\nThe Pages the agent may post to\.\n\n- `Acme` \(id `123`\)\n- `Beta` \(id `456`\)/);
    assert.deepEqual(listed.structuredContent.nextAction.arguments, { agent_guid: AGENT, connector: 'facebook-pages', accounts: { pages: ['123', '456'] } });
    assert.equal(fake.paths().includes('/UserAgent/ConnectorSetAccounts'), false);

    const saved = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'facebook-pages', accounts: { pages: ['123'] } });
    assert.notEqual(saved.isError, true, text(saved));
    assert.deepEqual(fake.called('/UserAgent/ConnectorSetAccounts')[0].body, { useragentguid: AGENT, slug: 'facebook-pages', accounts: { pages: ['123'] } });
    assert.equal(saved.structuredContent.message, 'Saved the Facebook Pages accounts (Facebook Pages: 1 chosen). The agent acts only on these. The running agent restarts to load them, which takes about a minute.');

    const unknown = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'facebook-pages', accounts: { groups: ['1'] } });
    assert.equal(text(unknown), '## Error\n\nFacebook Pages has no account choice "groups". Its choices: "pages" (Facebook Pages). Nothing was saved.');

    // A connector without account choices promises nothing about what its connection may act on.
    const none = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'serper' });
    assert.equal(text(none), '## Error\n\nSerper has no account choices to list or save here, and nothing was changed. If its setup steps (list_agent_connectors with its slug) name accounts the agent may act on, connect_agent_connector takes them in accounts.');
    assert.doesNotMatch(text(none), /acts on what its connection reaches/);
  });

  const notConnected = fakeClient(routes({ '/UserAgent/ConnectorAccounts': { result: false, errors: [{ code: 0, message: 'This connector is not connected to the agent.' }] } }));
  await withClient(notConnected, async client => {
    const result = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'facebook-pages' });
    assert.equal(text(result), '## Error\n\nfacebook-pages is not connected to this agent, so its accounts cannot be listed. Connect it first with connect_agent_connector.');
  });
});

// A remote connector (the vendor's own MCP server) can have account choices too: Wiro lists the advertisers a TikTok
// Ads sign-in reaches by calling the vendor's read tool, and saves only ones from that list. The tools treat it as any
// connector with account choices, and the sign-in says to choose them once it finishes.
test('a remote connector shows its account choices, asks for them once its sign-in finishes, and lists and saves them', async () => {
  const remote = toCatalogConnector(TIKTOK_ADS);
  assert.deepEqual(remote.ways, ['sign_in']);
  assert.deepEqual(remote.accountPickers, [{ key: 'advertisers', label: 'Advertisers', description: 'The advertiser accounts the agent may work with.', multiple: true }]);

  const PICKERS = [{ key: 'advertisers', label: 'Advertisers', description: 'The advertiser accounts the agent may work with.', multiple: true, candidates: [{ id: '7001', name: 'Shop A' }, { id: '7002', name: 'Shop B' }], selected: [] }];
  let signedIn = false;
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorList': () => ({ result: true, errors: [], useragentconnectors: signedIn ? [connection(TIKTOK_ADS, { connectedat: NOW })] : [] }),
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'pending', authorizeUrl: 'https://ads.example/authorize?state=abc' },
    '/UserAgent/ConnectorAccounts': { result: true, errors: [], pickers: PICKERS },
    '/UserAgent/ConnectorSetAccounts': body => ({ result: true, errors: [], accounts: body.accounts, applied: 1, restart: 'scheduled', useragentconnectors: [connection(TIKTOK_ADS, { accounts: body.accounts })] }),
  }));
  await withClient(fake, async client => {
    // The detail lists the account choice, as for a connector that runs here.
    const detail = await call(client, 'list_agent_connectors', { name: 'tiktok-ads', agent_guid: AGENT });
    assert.match(text(detail), /### Account choices\n\nOnce it is connected, set_agent_connector_accounts lists these and saves the ones the agent may use; it acts only on those\.\n\n- \*\*Advertisers\*\* \(`advertisers`, one or more\): The advertiser accounts the agent may work with\./);
    assert.deepEqual(detail.structuredContent.connector.accountPickers, remote.accountPickers);

    // The sign-in says to choose the advertisers once it finishes, unless they came with it.
    const started = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads' });
    assert.equal(started.structuredContent.state, 'authorize_in_browser');
    assert.match(started.structuredContent.message, /Once it finishes, choose the Advertisers it may act on: set_agent_connector_accounts lists the ones the sign-in reaches\. Give the link to the user/);
    const given = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads', accounts: { advertisers: ['7001'] } });
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[1].body, { useragentguid: AGENT, slug: 'tiktok-ads', accounts: { advertisers: ['7001'] } });
    assert.match(given.structuredContent.message, /The accounts given are saved with the connection once the sign-in finishes\./);
    assert.doesNotMatch(given.structuredContent.message, /Once it finishes, choose/);
    const wrongKey = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads', accounts: { adaccounts: ['1'] } });
    assert.equal(text(wrongKey), '## Error\n\nTikTok Ads has no account choice "adaccounts". Its choices: "advertisers" (Advertisers). Nothing was sent.');

    // Once the sign-in finished with none chosen, the result says to choose them, and the next step lists them.
    signedIn = true;
    const done = await call(client, 'connect_agent_connector', { action: 'status', agent_guid: AGENT, connector: 'tiktok-ads', since_connected_at: '' });
    assert.equal(done.structuredContent.state, 'connected');
    assert.match(done.structuredContent.message, /Choose the Advertisers it may act on with set_agent_connector_accounts\.$/);
    assert.deepEqual(done.structuredContent.nextAction, {
      tool: 'set_agent_connector_accounts',
      arguments: { agent_guid: AGENT, connector: 'tiktok-ads' },
      reason: 'List the Advertisers to choose from.',
    });

    // The list is the vendor's, read by Wiro; saving takes only ids from it.
    const listed = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'tiktok-ads' });
    assert.notEqual(listed.isError, true, text(listed));
    assert.deepEqual(fake.called('/UserAgent/ConnectorAccounts')[0].body, { useragentguid: AGENT, slug: 'tiktok-ads' });
    assert.match(text(listed), /### Advertisers \(`advertisers`, one or more\)\n\nThe advertiser accounts the agent may work with\.\n\n- `Shop A` \(id `7001`\)\n- `Shop B` \(id `7002`\)/);
    assert.deepEqual(listed.structuredContent.nextAction.arguments, { agent_guid: AGENT, connector: 'tiktok-ads', accounts: { advertisers: ['7001', '7002'] } });
    const saved = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'tiktok-ads', accounts: { advertisers: ['7002'] } });
    assert.deepEqual(fake.called('/UserAgent/ConnectorSetAccounts')[0].body, { useragentguid: AGENT, slug: 'tiktok-ads', accounts: { advertisers: ['7002'] } });
    assert.equal(saved.structuredContent.message, 'Saved the TikTok Ads accounts (Advertisers: 1 chosen). The agent acts only on these. The running agent restarts to load them, which takes about a minute.');
  });

  // The vendor refused the connection's sign-in while Wiro listed its accounts: connect it again, never "ask the
  // operator". An answer without the code reauth, from a Wiro API before it, is known by its words. Such an API leaves
  // that connection reading connected, so the connect first shows what it replaces, and the link comes with confirm:
  // true after the user's yes; nothing says the current one keeps working.
  const refused = { result: false, errors: [{ code: 0, message: 'The sign-in for this connector expired or was revoked, so it has to be connected again. Ask the agent\'s operator to reconnect it.' }] };
  const gone = fakeClient(routes({
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(TIKTOK_ADS)] },
    '/UserAgent/ConnectorAccounts': refused,
    '/UserAgent/ConnectorSetAccounts': refused,
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'pending', authorizeUrl: 'https://ads.example/authorize?state=new' },
  }));
  await withClient(gone, async client => {
    const message = 'The TikTok Ads sign-in expired or was revoked at the service, so its accounts cannot be listed or saved, and nothing was changed. '
      + 'Connect it again with connect_agent_connector, then choose the accounts. Action connect returns a new sign-in link, or, while the connection '
      + 'still reads connected, first shows what it replaces; after the user\'s yes, the same call with confirm: true returns the link.';
    const reconnect = { action: 'connect', agent_guid: AGENT, connector: 'tiktok-ads' };
    for (const [args, mode] of [[{}, 'list'], [{ accounts: { advertisers: ['7001'] } }, 'set']]) {
      const result = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'tiktok-ads', ...args });
      assert.equal(result.isError, true);
      assert.equal(text(result), `## Error\n\n${message}\n\nNext: call connect_agent_connector with \`${JSON.stringify(reconnect)}\`.`);
      assert.deepEqual(result.structuredContent, {
        agentGuid: AGENT,
        connector: 'tiktok-ads',
        title: 'TikTok Ads',
        mode,
        message,
        nextAction: {
          tool: 'connect_agent_connector',
          arguments: reconnect,
          reason: 'Connect TikTok Ads again. While the connection still reads connected, this first shows what it replaces: repeat it with confirm: true after the user\'s yes for the new sign-in link.',
        },
      });
    }

    // That connect: a preview first, then the link with confirm: true.
    const preview = await call(client, 'connect_agent_connector', reconnect);
    assert.equal(preview.structuredContent.state, 'confirm_needed');
    assert.match(preview.structuredContent.message, /^TikTok Ads is already connected \(since .+\)\. Connecting again replaces that connection once the new sign-in is approved; until then the current one stays as it is\. Nothing has changed yet\. Ask the user to confirm\.$/);
    assert.doesNotMatch(preview.structuredContent.message, /keeps working/);
    assert.deepEqual(preview.structuredContent.nextAction.arguments, { ...reconnect, confirm: true });
    assert.equal(gone.paths().includes('/UserAgent/ConnectorConnect'), false);
    const link = await call(client, 'connect_agent_connector', preview.structuredContent.nextAction.arguments);
    assert.equal(link.structuredContent.state, 'authorize_in_browser');
    assert.equal(link.structuredContent.authorizeUrl, 'https://ads.example/authorize?state=new');
  });
});

// Wiro marks that refusal with the code reauth, whatever its words, and the connection reads reauth from then on (as
// does one that already needed a new sign-in). It is not connected, so the connect needs no confirm: it returns the new
// sign-in link at once, or first lists the keys of the user's own app the sign-in needs.
test('a reconnect refusal Wiro marks with the code reauth leads to a connect that returns the new sign-in at once', async () => {
  const reauth = message => ({ result: false, errors: [{ code: 'reauth', message, time: NOW }] });
  const RECONNECT_WORDS = 'The sign-in for this connector expired or was revoked, so it has to be connected again. Ask the agent\'s operator to reconnect it.';
  for (const words of [RECONNECT_WORDS, 'Reconnect this connector.']) {
    const fake = fakeClient(routes({
      '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(TIKTOK_ADS, { status: 'reauth', lasterror: 'unauthorized', accounts: { advertisers: ['7001'] } })] },
      '/UserAgent/ConnectorAccounts': reauth(words),
      '/UserAgent/ConnectorSetAccounts': reauth(words),
      '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'pending', authorizeUrl: 'https://ads.example/authorize?state=again' },
    }));
    await withClient(fake, async client => {
      const message = 'The TikTok Ads sign-in expired or was revoked at the service, so its accounts cannot be listed or saved, and nothing was changed. '
        + 'Wiro now reads the connection as needing a new sign-in, so connect_agent_connector with action connect needs no confirm: it returns a new '
        + 'sign-in link at once, or lists the keys of the user\'s own app it needs first. Once the user has signed in again, choose the accounts.';
      const reconnect = { action: 'connect', agent_guid: AGENT, connector: 'tiktok-ads' };
      for (const [args, mode] of [[{}, 'list'], [{ accounts: { advertisers: ['7001'] } }, 'set']]) {
        const result = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'tiktok-ads', ...args });
        assert.equal(result.isError, true);
        assert.equal(text(result), `## Error\n\n${message}\n\nNext: call connect_agent_connector with \`${JSON.stringify(reconnect)}\`.`, words);
        assert.deepEqual(result.structuredContent, {
          agentGuid: AGENT,
          connector: 'tiktok-ads',
          title: 'TikTok Ads',
          mode,
          message,
          nextAction: {
            tool: 'connect_agent_connector',
            arguments: reconnect,
            reason: 'Connect TikTok Ads again. This returns the sign-in link for the user to open in their own browser, or lists the keys of the user\'s own app it needs first.',
          },
        });
      }

      // That connect: the link at once, with no preview first.
      const link = await call(client, 'connect_agent_connector', reconnect);
      assert.equal(link.structuredContent.state, 'authorize_in_browser', text(link));
      assert.equal(link.structuredContent.authorizeUrl, 'https://ads.example/authorize?state=again');
      assert.deepEqual(fake.called('/UserAgent/ConnectorConnect').map(sent => sent.body), [{ useragentguid: AGENT, slug: 'tiktok-ads' }]);
      assert.equal(link.structuredContent.nextAction.arguments.since_connected_at, '');
    });
  }

  // A sign-in with the user's own app: its keys saved with the connection take the connect to the link at once; a
  // connection that holds none lists them first, still with nothing to confirm.
  for (const [saved, state] of [[['appid', 'appsecret'], 'authorize_in_browser'], [[], 'setup_needed']]) {
    const fake = fakeClient(routes({
      '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(FACEBOOK, { status: 'reauth', lasterror: 'invalid_grant', authmode: saved.length > 0 ? 'own' : 'wiro', savedvariables: saved, accounts: { pages: ['123'] } })] },
      '/UserAgent/ConnectorAccounts': reauth(RECONNECT_WORDS),
      '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'pending', authorizeUrl: 'https://www.facebook.com/dialog/oauth?state=again' },
    }));
    await withClient(fake, async client => {
      const refused = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'facebook-pages' });
      assert.equal(refused.isError, true);
      assert.match(refused.structuredContent.message, /^The Facebook Pages sign-in expired or was revoked at the service, .* needs no confirm: it returns a new sign-in link at once/);
      const next = await call(client, 'connect_agent_connector', refused.structuredContent.nextAction.arguments);
      assert.equal(next.structuredContent.state, state, text(next));
      assert.equal(fake.called('/UserAgent/ConnectorConnect').length, state === 'authorize_in_browser' ? 1 : 0);
      if (state === 'setup_needed') assert.deepEqual(next.structuredContent.missing, ['appid', 'appsecret']);
    });
  }
});

// Wiro keeps the accounts a connection holds through a new sign-in that sends none: after the sign-in expired or was
// revoked, after a link that expired unused (the connection then reads pending), and when a connected one is replaced.
// The link says those stay, and asks only for a choice the connection lacks.
test('a new sign-in says the account choices a connection holds stay, and asks only for the ones it lacks', async () => {
  const BUSINESS = {
    slug: 'google-business',
    title: 'Google Business Profile',
    description: 'Manage business locations.',
    category: 'marketing',
    authtype: 'oauth',
    transport: 'streamable-http',
    credentialfields: [],
    accountpickers: [
      { key: 'accounts', label: 'Business Profile accounts', description: '', multiple: true },
      { key: 'locations', label: 'Business locations', description: '', multiple: true },
    ],
    scopes: [],
    modes: [],
    tools: [],
    docs: null,
  };
  const keptAdvertisers = ' The Advertisers chosen before stay through the new sign-in, and set_agent_connector_accounts changes them once it finishes. Give the link to the user';
  const cases = [
    [connection(TIKTOK_ADS, { status: 'reauth', lasterror: 'unauthorized', accounts: { advertisers: ['7001'] } }), {}, keptAdvertisers],
    [connection(TIKTOK_ADS, { status: 'pending', connectedat: null, accounts: { advertisers: ['7001'] } }), {}, keptAdvertisers],
    [connection(TIKTOK_ADS, { accounts: { advertisers: ['7001', '7002'] } }), { confirm: true }, keptAdvertisers],
    [connection(TIKTOK_ADS, { status: 'reauth', lasterror: 'unauthorized' }), {}, ' Once it finishes, choose the Advertisers it may act on: set_agent_connector_accounts lists the ones the sign-in reaches. Give the link to the user'],
    [connection(BUSINESS, { status: 'reauth', accounts: { accounts: ['acc-1'] } }), {}, ' The Business Profile accounts chosen before stay through the new sign-in, and set_agent_connector_accounts changes them once it finishes. '
      + 'Once it finishes, choose the Business locations it may act on: set_agent_connector_accounts lists the ones the sign-in reaches. Give the link to the user'],
  ];
  for (const [held, args, sentence] of cases) {
    const fake = fakeClient(routes({
      '/AgentConnector/Detail': body => (body.slug === BUSINESS.slug ? { result: true, errors: [], agentconnectors: [structuredClone(BUSINESS)] } : catalogDetail(body)),
      '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [held] },
      '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'pending', authorizeUrl: 'https://vendor.example/authorize?state=again' },
    }));
    await withClient(fake, async client => {
      const link = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: held.slug, ...args });
      assert.equal(link.structuredContent.state, 'authorize_in_browser', text(link));
      assert.ok(link.structuredContent.message.includes(sentence), `${held.status}: ${link.structuredContent.message}`);
      assert.deepEqual(fake.called('/UserAgent/ConnectorConnect').map(sent => sent.body), [{ useragentguid: AGENT, slug: held.slug }]);
    });
  }
});

// ---------------------------------------------------------------------------
// disconnect_agent_connector
// ---------------------------------------------------------------------------

test('disconnect_agent_connector says what goes and what stops, and disconnects only with confirm', async () => {
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(SERPER, { savedvariables: ['apikey'] })] },
    '/UserAgent/ConnectorDisconnect': { result: true, errors: [], removed: true, revoked: false, restart: 'scheduled' },
  }));
  await withClient(fake, async client => {
    const preview = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'serper' });
    assert.notEqual(preview.isError, true, text(preview));
    assert.equal(preview.structuredContent.disconnected, false);
    assert.equal(preview.structuredContent.willClear, 'The Serper connection is removed: its saved values and its account choices. The agent loses the Serper tools, and these scheduled tasks stop running until it is connected again: Weekly Search (`cs-cron-weekly-search`). A running agent restarts. Connecting it again needs connect_agent_connector and the values again.');
    assert.deepEqual(preview.structuredContent.nextAction.arguments, { agent_guid: AGENT, connector: 'serper', confirm: true });
    assert.equal(fake.paths().includes('/UserAgent/ConnectorDisconnect'), false);

    const done = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'serper', confirm: true });
    assert.equal(done.structuredContent.disconnected, true);
    assert.deepEqual(fake.called('/UserAgent/ConnectorDisconnect')[0].body, { useragentguid: AGENT, slug: 'serper' });
    assert.equal(done.structuredContent.restart, 'scheduled');
  });

  // A sign-in asks the service to revoke the access, and says whether it did.
  const signedIn = fakeClient(routes({
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(TIKTOK_ADS)] },
    '/UserAgent/ConnectorDisconnect': { result: true, errors: [], removed: true, revoked: true, restart: 'scheduled' },
  }));
  await withClient(signedIn, async client => {
    const done = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'tiktok-ads', confirm: true });
    assert.match(done.structuredContent.message, /The service is asked to revoke the access where it supports that\..*The service confirmed it revoked the access\.$/);
  });

  // Nothing to remove: no call goes out.
  const nothing = fakeClient(routes());
  await withClient(nothing, async client => {
    const result = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'serper', confirm: true });
    assert.equal(result.structuredContent.disconnected, false);
    assert.equal(result.structuredContent.message, 'Serper is not connected to this agent, so there is nothing to remove.');
    assert.equal(nothing.paths().includes('/UserAgent/ConnectorDisconnect'), false);
  });
});

test('disconnect_agent_connector words the restart as Wiro answers it, and promises none for a connection that is not connected', async () => {
  const disconnect = async (row, restart) => {
    const fake = fakeClient(routes({
      '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [row] },
      '/UserAgent/ConnectorDisconnect': { result: true, errors: [], removed: true, revoked: false, restart },
    }));
    let preview;
    let done;
    await withClient(fake, async client => {
      preview = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: row.slug });
      done = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: row.slug, confirm: true });
    });
    return { preview: preview.structuredContent, done: done.structuredContent };
  };

  const scheduled = await disconnect(connection(SERPER), 'scheduled');
  assert.match(scheduled.done.message, /^Serper is disconnected\. .*The running agent restarts without it, which takes about a minute\. Connecting it again/);
  assert.doesNotMatch(scheduled.done.message, /A running agent restarts\./);
  assert.equal(scheduled.done.willClear, scheduled.done.message.replace(/^Serper is disconnected\. /, ''));

  const stopped = await disconnect(connection(SERPER), 'none');
  assert.match(stopped.done.message, /The agent is not running, so nothing restarts; it starts without the connector\./);
  assert.equal(stopped.done.restart, 'none');

  const failed = await disconnect(connection(SERPER), 'failed');
  assert.match(failed.done.message, /The running agent could not be restarted, so it keeps the connector until it restarts: control_agent with action restart does that\./);

  // A connection that needs a new sign-in gave the agent nothing: no tools to lose, no task stops, no restart.
  const expired = await disconnect(connection(TIKTOK_ADS, { status: 'reauth' }), 'none');
  assert.equal(expired.preview.willClear, 'The TikTok Ads connection is removed: its saved values, its sign-in and its account choices. The service is asked to revoke the access where it supports that. Connecting it again needs connect_agent_connector and a new sign-in.');
  assert.match(expired.done.message, /It was not connected, so the agent does not restart\./);
  for (const out of [expired.preview, expired.done]) assert.doesNotMatch(out.message, /A running agent restarts|restarts without it|loses the TikTok Ads tools/);
});

// The wiro connector saves no values of its own: it runs with the agent's Wiro project, which a disconnect leaves bound.
test('disconnect_agent_connector says the agent keeps its Wiro project when the wiro connector goes', async () => {
  const fake = fakeClient(routes({ '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(WIRO, { wiroprojectid: '111' })] } }));
  await withClient(fake, async client => {
    const preview = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'wiro' });
    assert.equal(preview.structuredContent.willClear, 'The Wiro connection is removed. The agent keeps its Wiro project, which its video and voice skills use. The agent loses the Wiro tools. A running agent restarts. Connecting it again needs connect_agent_connector with a Wiro project.');
    assert.doesNotMatch(preview.structuredContent.willClear, /saved values|the values again/);
  });
});

// While the agent has no Wiro project, ConnectorList names none on the wiro connection, and Wiro leaves the connector
// out of the agent's settings: the catalog row says it is a project connector, and the agent has no tools to lose.
test('disconnect_agent_connector words a wiro connection on an agent with no project by its catalog row', async () => {
  const either = { key: 'cs-cron-weekly-images', description: 'Weekly images', value: 'Make images.', interval: '0 9 * * 1', enabled: true, requires_credentials: [], requires_connectors: ['wiro'], _source: 'user-created', _editable: true, _user_created: true };
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(WIRO, { wiroprojectid: null })] },
    '/UserAgent/ConnectorDisconnect': { result: true, errors: [], removed: true, revoked: false, restart: 'scheduled' },
  }));
  await withClient(fake, async client => {
    const preview = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'wiro' });
    assert.notEqual(preview.isError, true, text(preview));
    assert.equal(preview.structuredContent.willClear, 'The Wiro connection is removed. The agent has no Wiro project now, so the connector gives it nothing. A running agent restarts. Connecting it again needs connect_agent_connector with a Wiro project.');
    assert.doesNotMatch(preview.structuredContent.willClear, /saved values|the values again|loses the Wiro tools/);
    assert.equal(preview.structuredContent.connection.way, 'project');
    assert.deepEqual(fake.called('/AgentConnector/Detail').map(item => item.body), [{ slug: 'wiro' }]);

    const done = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'wiro', confirm: true });
    assert.equal(done.structuredContent.disconnected, true);
    assert.match(done.structuredContent.message, /^Wiro is disconnected\. The Wiro connection is removed\. The agent has no Wiro project now, so the connector gives it nothing\. The running agent restarts without it/);
  });

  // A scheduled task that needs the connector still stops with it.
  const tasks = fakeClient(routes({
    '/UserAgent/Detail': { result: true, errors: [], useragents: [detailRow({ scheduledskills: [either] })] },
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(WIRO, { wiroprojectid: null })] },
  }));
  await withClient(tasks, async client => {
    const preview = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'wiro' });
    assert.match(preview.structuredContent.willClear, /so the connector gives it nothing\. These scheduled tasks stop running until it is connected again: Weekly Images \(`cs-cron-weekly-images`\)\. A running agent restarts\./);
  });

  // A key connector with saved values needs no catalog read.
  const serper = fakeClient(routes({ '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(SERPER, { savedvariables: ['apikey'] })] } }));
  await withClient(serper, async client => {
    await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'serper' });
    assert.equal(serper.paths().includes('/AgentConnector/Detail'), false);
  });
});

// The wiro connector has no saved values, so connecting it again replaces the connection and nothing else.
test('connect_agent_connector words a replace of the wiro connection without saved values', async () => {
  const fake = fakeClient(routes({
    '/Project/List': { result: true, errors: [], project: [{ id: '111', name: 'Main', apikey: 'own-project-key', teamguid: null }] },
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(WIRO, { wiroprojectid: null })] },
  }));
  await withClient(fake, async client => {
    const preview = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro' });
    assert.match(preview.structuredContent.message, /^Wiro is already connected \(since .+\)\. Connecting again replaces that connection\. Wiro runs with the agent's own Wiro project/);
    assert.doesNotMatch(preview.structuredContent.message, /saved values/);
    assert.equal(preview.structuredContent.connection.way, 'project');
  });
});

// A scheduled task runs while any one of the connectors it names is connected, so it stops with a disconnect, or
// starts with a connect, only when none of its other connectors is connected.
test('the connector tools name only the scheduled tasks that stop or start with this connector', async () => {
  const either = { key: 'cs-cron-weekly-outreach', description: 'Weekly outreach', value: 'Find leads.', interval: '0 9 * * 1', enabled: true, requires_credentials: [], requires_connectors: ['serper', 'devto'], _source: 'user-created', _editable: true, _user_created: true };
  const paused = { ...either, key: 'cs-cron-paused-search', requires_connectors: ['serper'], _source: 'skill-bundle', _skill_off: true, _off_skills: [['util-weather']], _owner_skills: ['util-weather'] };
  const agent = { result: true, errors: [], useragents: [detailRow({ scheduledskills: [...detailRow().scheduledskills, either, paused] })] };
  const DEVTO = { slug: 'devto', title: 'DEV', category: 'content', authtype: 'fields', transport: 'local' };
  const tasksOf = out => out.willClear.match(/these scheduled tasks stop running until it is connected again: (.*?)\. /)?.[1] ?? '';

  for (const [devto, expected] of [
    [connection(DEVTO), 'Weekly Search (`cs-cron-weekly-search`)'],
    // A connection to the other connector that gives the agent nothing does not keep a task running.
    [connection(DEVTO, { status: 'reauth' }), 'Weekly Search (`cs-cron-weekly-search`), Weekly Outreach (`cs-cron-weekly-outreach`)'],
    [connection(DEVTO, { catalogstatus: 'retired' }), 'Weekly Search (`cs-cron-weekly-search`), Weekly Outreach (`cs-cron-weekly-outreach`)'],
  ]) {
    const fake = fakeClient(routes({
      '/UserAgent/Detail': agent,
      '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(SERPER), devto] },
    }));
    await withClient(fake, async client => {
      const preview = await call(client, 'disconnect_agent_connector', { agent_guid: AGENT, connector: 'serper' });
      assert.equal(tasksOf(preview.structuredContent), expected, devto.status);
      // A task whose skill is off does not run either way.
      assert.doesNotMatch(preview.structuredContent.willClear, /cs-cron-paused-search/);
    });
  }

  // Connecting: a task that another connected connector already runs does not start with this one.
  const connect = fakeClient(routes({
    '/UserAgent/Detail': agent,
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(DEVTO)] },
    '/UserAgent/ConnectorConnect': { result: true, errors: [], status: 'connected', applied: 1, restart: 'scheduled', useragentconnectors: [connection(SERPER, { savedvariables: ['apikey'] })] },
  }));
  await withClient(connect, async client => {
    const result = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'serper', values: { apikey: KEY } });
    assert.notEqual(result.isError, true, text(result));
    assert.match(result.structuredContent.message, /Scheduled tasks that need it run once it is loaded: Weekly Search \(`cs-cron-weekly-search`\)\. Every run/);
    assert.doesNotMatch(result.structuredContent.message, /cs-cron-weekly-outreach|cs-cron-paused-search/);
  });
});

// ---------------------------------------------------------------------------
// get_my_agent
// ---------------------------------------------------------------------------

test('get_my_agent lists the agent\'s connectors with their state and the accounts chosen', async () => {
  const fake = fakeClient(routes({
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [connection(SERPER), connection(FACEBOOK, { authmode: 'own', accounts: { pages: ['123', '456'] } }), connection(TIKTOK_ADS, { status: 'reauth' })] },
  }));
  await withClient(fake, async client => {
    const result = await call(client, 'get_my_agent', { agent_guid: AGENT });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(result.structuredContent.connectors.map(item => [item.connector, item.status]), [['serper', 'connected'], ['facebook-pages', 'connected'], ['tiktok-ads', 'reauth']]);
    const out = text(result);
    assert.match(out, /### Connectors\n\n- Serper \(`serper`\): connected since .+\n- Facebook Pages \(`facebook-pages`\): connected since .+; pages: 2 chosen\n- TikTok Ads \(`tiktok-ads`\): needs a new sign-in\n\nDashboard: /);
  });

  // An answer without the connectors still says everything else.
  const failing = fakeClient(routes({ '/UserAgent/ConnectorList': () => { throw new Error('socket hang up'); } }));
  await withClient(failing, async client => {
    const result = await call(client, 'get_my_agent', { agent_guid: AGENT });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.connectors, undefined);
    assert.match(text(result), /The connectors could not be read; list_agent_connectors with agent_guid lists them\./);
  });
});
