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

const TIKTOK_ADS = {
  slug: 'tiktok-ads',
  title: 'TikTok Ads',
  description: 'Manage TikTok ad campaigns.',
  category: 'marketing',
  authtype: 'oauth',
  transport: 'streamable-http',
  credentialfields: [],
  accountpickers: [],
  scopes: [],
  modes: [],
  tools: [],
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
    assert.ok(lines.includes('- **Facebook Pages** (`facebook-pages`, social, sign-in or key) [sign-in started, not finished]: Post to Facebook Pages.'), text(result));
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
    assert.match(done.structuredContent.message, /^TikTok Ads is connected \(since .+\)\. The running agent restarts to load it, which takes about a minute\.$/);
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

test('connect_agent_connector shows the Wiro project and the wallet first, and binds the project only with confirm', async () => {
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
    assert.match(own.structuredContent.message, /^Wiro would run Wiro models with `Main` \(id `111`\): model runs through it are billed to the wallet of the workspace that owns that project\. Nothing has changed yet\./);
    assert.equal(fake.paths().includes('/UserAgent/ConnectorConnect'), false);

    const unknown = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', project_id: '999' });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /No project with the id 999 is in this connection's workspace/);

    const bound = await call(client, 'connect_agent_connector', { agent_guid: AGENT, connector: 'wiro', project_id: '222', confirm: true });
    assert.notEqual(bound.isError, true, text(bound));
    assert.deepEqual(fake.called('/UserAgent/ConnectorConnect')[0].body, { useragentguid: AGENT, slug: 'wiro', wiroprojectguid: '222' });
    assert.equal(bound.structuredContent.connection.projectId, '222');
    assert.match(bound.structuredContent.message, /Model runs through it are billed to the wallet of the workspace that owns `Side` \(id `222`\)\./);
    assert.equal(JSON.stringify(bound).includes('other-key'), false);
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

    const none = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'serper' });
    assert.equal(text(none), '## Error\n\nSerper has no account choices: once connected, it acts on what its connection reaches.');
  });

  const notConnected = fakeClient(routes({ '/UserAgent/ConnectorAccounts': { result: false, errors: [{ code: 0, message: 'This connector is not connected to the agent.' }] } }));
  await withClient(notConnected, async client => {
    const result = await call(client, 'set_agent_connector_accounts', { agent_guid: AGENT, connector: 'facebook-pages' });
    assert.equal(text(result), '## Error\n\nfacebook-pages is not connected to this agent, so its accounts cannot be listed. Connect it first with connect_agent_connector.');
  });
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
