import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';
import {
  buildChainedSelections,
  credentialsNeededFor,
  buildPickerAccounts,
  connectionState,
  estimateProratedUsd,
  idempotencyKeyMismatch,
  isAllowedRedirectUrl,
  newSkillChangeKey,
  normalizeBase64FileValue,
  normalizeCustomSkillKey,
  parseCredentialMeta,
  parseSkillChangeKey,
  parseSkillRegistry,
  planSkillChanges,
  resolveDeployCustomSkills,
  skillChangeDigest,
  skillPriceTag,
  templateTaskTextError,
  upsertCustomSkillKey,
} from '../dist/utils/agent-config.js';

const AGENT = 'ua-0001';
const NOW = Math.floor(Date.now() / 1000);
const TOKEN = '123456789:AAHsecretTelegramBotToken';

// ---------------------------------------------------------------------------
// Fixtures shaped like the production responses
// ---------------------------------------------------------------------------

const skillList = {
  result: true,
  errors: [],
  skills: [
    { name: 'int-instagram-post', title: 'Instagram', depends_on: ['util-chat-markdown-reporting', 'util-social-posting-common', 'util-anti-ai-human-copy'], conflicts_with: [], credential_key: 'instagram', requires_credentials: true, pricing: { billing_model: 'tokens', monthly_price_weight_usd: 1, monthly_credits_weight: 100 } },
    { name: 'int-googleads-manage', title: 'Google Ads', depends_on: ['util-chat-markdown-reporting'], conflicts_with: [], credential_key: 'google-ads', additional_credential_keys: ['google-merchant-center'], requires_credentials: true, pricing: { monthly_price_weight_usd: 4 } },
    { name: 'int-old-poster', title: 'Old', depends_on: [], deprecated: true, replacement: 'int-instagram-post', requires_credentials: false, pricing: {} },
    { name: 'util-chat-markdown-reporting', depends_on: [], requires_credentials: false, pricing: {} },
    { name: 'util-social-posting-common', depends_on: [], requires_credentials: false, pricing: {} },
    { name: 'util-anti-ai-human-copy', depends_on: [], requires_credentials: false, pricing: {} },
    { name: 'util-video-creator', depends_on: ['util-motion-effects'], requires_credentials: false, pricing: {} },
    { name: 'util-motion-effects', depends_on: ['util-video-creator'], requires_credentials: false, pricing: {} },
  ],
  channels: [{ id: 'telegram', title: 'Telegram', credential_key: 'telegram', required_fields: ['bottoken', 'allowedusers'] }],
  total: 8,
};

const credentials = {
  telegram: {
    key: 'telegram',
    title: 'Telegram',
    credential_mode: 'api_key',
    connection_modes: [],
    wiro_connect_pending: false,
    credential_schema: [
      { key: 'bottoken', type: 'password', label: 'Telegram Bot Token', required: true, encrypted: true, help: '<p>Create a bot with <code>@BotFather</code> and copy its token. Keep it private.</p>' },
      { key: 'allowedusers', type: 'string-array', label: 'Allowed Telegram DM User IDs', required: true, pattern: '^\\d{5,}$' },
      { key: 'groups', type: 'object-array', label: 'Allowed Telegram Groups', required: false, item_schema: [{ key: 'chatid', type: 'text', label: 'Group Chat ID', required: true, pattern: '^-\\d{5,}$' }, { key: 'allowedusers', type: 'string-array', label: 'Allowed users', required: false }] },
    ],
    channel: { id: 'telegram', plugin: 'telegram', required_fields: ['bottoken', 'allowedusers'] },
    oauth_provider: null,
  },
  'twilio-voice': {
    key: 'twilio-voice',
    title: 'Twilio Voice',
    connection_modes: [],
    credential_schema: [
      { key: 'accountsid', type: 'text', label: 'Account SID', required: true, encrypted: true },
      { key: 'holdstrategy', type: 'select', label: 'Hold experience', required: false, options: [{ value: 'none', text: 'None' }, { value: 'audio', text: 'Audio' }] },
      { key: 'holdaudio', type: 'fileinput', label: 'Hold greeting (audio file)', required: false, filetypes: ['audio/mpeg', 'audio/wav'], maxsize: 10240 },
    ],
    oauth_provider: null,
  },
  'google-play': {
    key: 'google-play',
    title: 'Google Play',
    connection_modes: [],
    credential_schema: [
      { key: 'serviceaccountjson', type: 'fileinput-base64', label: 'Service account JSON', required: true, encrypted: true },
    ],
    oauth_provider: null,
  },
  'sys-openai': {
    key: 'sys-openai',
    title: 'OpenAI',
    credential_mode: 'api_key',
    connection_modes: [],
    credential_schema: [{ key: 'apikey', type: 'password', label: 'API key', required: true, platform_managed: true }],
    oauth_provider: null,
  },
  hubspot: {
    key: 'hubspot',
    title: 'HubSpot',
    credential_mode: 'oauth',
    connection_modes: ['wiro', 'own'],
    wiro_connect_pending: false,
    credential_schema: [
      { key: 'clientid', type: 'text', label: 'Client ID', required: true, oauth_managed: true, only_in_modes: ['own'] },
      { key: 'clientsecret', type: 'password', label: 'Client Secret', required: true, encrypted: true, oauth_managed: true, only_in_modes: ['own'] },
      { key: 'portalname', type: 'text', label: 'Portal', auto_filled_by_oauth: true },
    ],
    oauth_provider: {
      auth_method_value: 'wiro',
      oauth_flow: { callback_path: '/UserAgentOAuth/HubSpotCallback', authorize_url: 'https://app.hubspot.com/oauth/authorize' },
      username_field: 'portalname',
      account_picker: null,
    },
  },
  'meta-ads': {
    key: 'meta-ads',
    title: 'Meta Ads',
    credential_mode: 'hybrid',
    connection_modes: ['api_key', 'own', 'wiro'],
    default_connection_mode: 'api_key',
    wiro_connect_pending: true,
    credential_schema: [
      { key: 'appid', type: 'text', label: 'App ID', required: true, oauth_managed: true, only_in_modes: ['own'] },
      { key: 'appsecret', type: 'password', label: 'App Secret', required: true, encrypted: true, oauth_managed: true, only_in_modes: ['own'] },
      { key: 'systemusertoken', type: 'password', label: 'System User Token', required: true, encrypted: true, only_in_modes: ['api_key'] },
      { key: 'adaccountid', type: 'text', label: 'Ad Account ID', required: true, auto_filled_by_oauth: true },
      { key: 'adaccountname', type: 'text', label: 'Ad Account Name', auto_filled_by_oauth: true },
      { key: 'pagemappings', type: 'array', item_type: 'object', label: 'Selected Facebook Pages', server_managed: true },
    ],
    oauth_provider: {
      auth_method_value: 'wiro',
      oauth_flow: { callback_path: '/UserAgentOAuth/MetaAdsCallback', client_id_field: 'appid', client_secret_field: 'appsecret' },
      direct_probe: { mode: 'api_key', mode_label: 'System User Token', token_field: 'systemusertoken', required_fields: ['systemusertoken'] },
      account_picker: {
        enabled: true,
        multi_select: true,
        item_value_field: 'adaccountid',
        item_label_field: 'adaccountname',
        item_fields_to_save: ['adaccountid', 'adaccountname'],
        url_item_fields: { adaccountid: 'id', adaccountname: 'name' },
        next: {
          enabled: true,
          key: 'pages',
          optional: true,
          modal_title: 'Select Facebook Pages',
          parent_value_field: 'adaccountid',
          parent_label_field: 'adaccountname',
          item_value_field: 'pageid',
          item_label_field: 'pagename',
          persist_field: 'pagemappings',
        },
      },
    },
  },
};

function detailRow(overrides = {}) {
  return {
    guid: AGENT,
    title: 'Growth agent',
    status: 4,
    tier: 'starter',
    monthlypriceusd: '42.00',
    monthlycredits: 4200,
    teamguid: null,
    timezone: 'Europe/Istanbul',
    agent: { guid: 'tpl-1', custom: false },
    subscription: {
      plan: 'agent',
      status: 'active',
      provider: 'prepaid',
      currentperiodend: NOW + 15 * 86400,
      daysremaining: 15,
    },
    skills: [{ name: 'util-chat-markdown-reporting', enabled: true, _edited: false }],
    credentials: {
      telegram: {
        bottoken: TOKEN,
        allowedusers: [],
        groups: [],
        optional: true,
        _connected: false,
        _filled: false,
        _required_missing: false,
        _schema: { title: 'Telegram' },
      },
      'meta-ads': {
        appid: '',
        appsecret: '',
        systemusertoken: '',
        _connected: false,
        _filled: false,
        _required_missing: true,
        optional: false,
        _schema: { title: 'Meta Ads' },
      },
    },
    communicationChannels: [{
      id: 'telegram',
      title: 'Telegram',
      credentialkey: 'telegram',
      enabled: false,
      configured: false,
      missingfields: ['allowedusers'],
      schema: { fields: [{ key: 'bottoken', label: 'Telegram Bot Token' }, { key: 'allowedusers', label: 'Allowed Telegram DM User IDs' }] },
    }],
    customskills: [
      { key: 'cs-approval-policy', description: 'Approval rules', value: 'Ask before spending.', interval: null, enabled: true, requires_credentials: [], _source: 'preset-strategy', _editable: true },
    ],
    scheduledskills: [
      { key: 'cs-cron-metaads-performance-reporter', description: 'Weekly Meta report', value: 'Report on Meta Ads.', interval: '0 9 * * 1', enabled: true, requires_credentials: ['meta-ads'], _source: 'skill-bundle', _editable: true },
      { key: 'cs-cron-my-task', description: 'My task', value: 'Do my task.', interval: '0 8 * * *', enabled: true, requires_credentials: [], _source: 'user-created', _editable: true, _user_created: true },
    ],
    ...overrides,
  };
}

function detail(overrides) {
  return { result: true, errors: [], useragents: [detailRow(overrides)] };
}

function credentialDetail(body) {
  const credential = credentials[body.key];
  return credential
    ? { result: true, errors: [], credential }
    : { result: false, errors: [{ code: 404, message: `Credential not found: ${body.key}` }], credential: null };
}

function fakeClient(routes) {
  const calls = [];
  const client = {
    calls,
    paths: () => calls.map(call => call.path),
    async post(path, body = {}) {
      calls.push({ path, body });
      const route = routes[path];
      if (route === undefined) throw new Error(`Unexpected call to ${path}`);
      return typeof route === 'function' ? route(body, calls) : structuredClone(route);
    },
    async postForm(path, form) {
      calls.push({ path, form });
      const route = routes[path];
      if (route === undefined) throw new Error(`Unexpected form call to ${path}`);
      return typeof route === 'function' ? route(form, calls) : structuredClone(route);
    },
  };
  return client;
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

const AGENT_TOOLS = [
  'apply_agent_skills',
  'set_agent_credentials',
  'connect_agent_oauth',
  'disconnect_agent_oauth',
  'manage_agent_custom_skill',
];

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

test('agent configuration tools advertise output schemas, annotations and plain copy', async () => {
  await withClient(fakeClient({}), async client => {
    const { tools } = await client.listTools();
    for (const name of AGENT_TOOLS) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.ok(tool.outputSchema, `${name} has an output schema`);
      assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
      assert.doesNotMatch(JSON.stringify(tool), /[\u2013\u2014]/, `${name} has no dashes used as punctuation`);
    }
    const disconnect = tools.find(tool => tool.name === 'disconnect_agent_oauth');
    assert.equal(disconnect.annotations.destructiveHint, true);
  });
});

// ---------------------------------------------------------------------------
// apply_agent_skills
// ---------------------------------------------------------------------------

function skillRoutes(extra = {}) {
  return {
    '/Skills/List': skillList,
    '/UserAgent/Detail': detail(),
    '/UserAgent/PricingPreview': { result: true, errors: [], tier: 'starter', totalPriceUsd: 43, totalMonthlyCredits: 4300, enabledSkills: ['int-instagram-post', 'util-anti-ai-human-copy', 'util-chat-markdown-reporting', 'util-social-posting-common'], tokenRates: { huge: true } },
    ...extra,
  };
}

const INSTAGRAM_SET = ['int-instagram-post', 'util-anti-ai-human-copy', 'util-chat-markdown-reporting', 'util-social-posting-common'];

/** Detail that shows the Instagram skills once SkillsApply was called, like the live agent would. */
function detailAfterApply(overrides = {}) {
  return (_body, calls) => (calls.some(call => call.path === '/UserAgent/SkillsApply')
    ? detail({ skills: INSTAGRAM_SET.map(name => ({ name, enabled: true })), monthlypriceusd: '43.00', ...overrides })
    : detail(overrides));
}

async function quoteInstagram(client) {
  const quote = await client.callTool({
    name: 'apply_agent_skills',
    arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true } },
  });
  assert.equal(quote.structuredContent.status, 'quote', text(quote));
  return quote;
}

test('apply_agent_skills quotes first, adds dependencies and returns a reusable key', async () => {
  const fake = fakeClient(skillRoutes());
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true } },
    });
    assert.notEqual(result.isError, true, text(result));
    const out = result.structuredContent;
    assert.equal(out.status, 'quote');
    assert.deepEqual(out.changes.enable.sort(), ['int-instagram-post', 'util-anti-ai-human-copy', 'util-social-posting-common']);
    assert.deepEqual(out.changes.addedDependencies.sort(), ['util-anti-ai-human-copy', 'util-social-posting-common']);
    assert.deepEqual(out.changes.alreadySet, []);
    assert.equal(out.pricing.currentMonthlyUsd, 42);
    assert.equal(out.pricing.newMonthlyUsd, 43);
    assert.equal(out.pricing.deltaMonthlyUsd, 1);
    assert.equal(out.billing.plan, 'prepaid');
    assert.equal(out.billing.wallet, 'personal');
    assert.equal(out.billing.estimatedChargeNowUsd, 0.5);
    assert.match(out.billing.note, /taken from your personal wallet now/);
    assert.match(out.restart, /restarts/);
    assert.deepEqual(out.credentialsNeeded, [{ skill: 'int-instagram-post', credentials: ['instagram'] }]);
    assert.match(out.idempotencyKey, /^mcp-[0-9a-f]{16}-[0-9a-f]{10}-[0-9a-f]{8}$/);
    assert.equal(parseSkillChangeKey(out.idempotencyKey).priceTag, skillPriceTag(42, 43));
    assert.deepEqual(out.nextAction.arguments, {
      agent_guid: AGENT,
      skills: { 'int-instagram-post': true },
      add_dependencies: true,
      confirm: true,
      idempotency_key: out.idempotencyKey,
    });
    assert.equal(out.nextAction.reason, 'Ask the user to approve this charge first.');
    assert.doesNotMatch(JSON.stringify(out), /tokenRates|huge/);

    const preview = fake.calls.find(call => call.path === '/UserAgent/PricingPreview');
    assert.deepEqual(preview.body, {
      useragentguid: AGENT,
      skillOverrides: { 'int-instagram-post': true, 'util-social-posting-common': true, 'util-anti-ai-human-copy': true },
    });
    for (const value of Object.values(preview.body.skillOverrides)) assert.equal(typeof value, 'boolean');
    assert.equal(fake.paths().includes('/UserAgent/SkillsApply'), false);
  });
});

test('apply_agent_skills applies with the quoted key and reports the wallet charge', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply(),
    '/UserAgent/SkillsApply': {
      result: true,
      errors: [],
      pricing: { previousPriceUsd: 42, newPriceUsd: 43, deltaUsd: 1, previousMonthlyCredits: 4200, newMonthlyCredits: 4300, deltaCredits: 100, enabledSkills: ['int-instagram-post'] },
      tier: 'starter',
      stripeProrationApplied: false,
      prepaidWalletDelta: 0.5,
      restartTriggered: true,
      restartedAt: NOW,
    },
  }));
  await withClient(fake, async client => {
    const quote = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true } },
    });
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.notEqual(result.isError, true, text(result));
    const apply = fake.calls.find(call => call.path === '/UserAgent/SkillsApply');
    assert.deepEqual(apply.body, {
      useragentguid: AGENT,
      skills: { 'int-instagram-post': true, 'util-social-posting-common': true, 'util-anti-ai-human-copy': true },
      idempotencyKey: quote.structuredContent.idempotencyKey,
    });
    const out = result.structuredContent;
    assert.equal(out.status, 'applied');
    assert.equal(out.billing.chargedNowUsd, 0.5);
    assert.match(out.billing.note, /\$0\.50 was taken from your personal wallet/);
    assert.equal(out.pricing.newMonthlyUsd, 43);
    assert.equal(out.idempotencyKey, quote.structuredContent.idempotencyKey);
    assert.deepEqual(out.nextAction, {
      tool: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, credential: 'instagram' },
      reason: 'See what instagram needs before asking the user for it.',
    });
    assert.doesNotMatch(JSON.stringify(out), /restartTriggered|restartedAt/);
  });
});

test('apply_agent_skills refuses a key that was issued for a different change', async () => {
  const fake = fakeClient(skillRoutes({ '/UserAgent/SkillsApply': { result: true } }));
  await withClient(fake, async client => {
    const quote = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true } },
    });
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-googleads-manage': true }, confirm: true, idempotency_key: quote.structuredContent.idempotencyKey },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /belongs to a different skill change/);
    assert.equal(fake.paths().includes('/UserAgent/SkillsApply'), false);
  });
});

test('apply_agent_skills explains refusals with the server details', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/SkillsApply': {
      result: false,
      errors: [{ code: 103, message: 'Insufficient wallet balance to apply skill changes.' }],
      requiredUsd: 3.2,
      availableUsd: 1.1,
    },
  }));
  await withClient(fake, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.match(text(result), /needs \$3\.20 and has \$1\.10/);
    assert.equal(result.structuredContent.status, 'refused');
    assert.equal(result.structuredContent.error.code, 103);
    assert.equal(result.structuredContent.restart, 'Nothing changed, so the agent does not restart.');
  });

  const busy = fakeClient(skillRoutes({
    '/UserAgent/SkillsApply': { result: false, errors: [{ code: 104, message: 'A skill update is already in progress for this agent.' }] },
  }));
  await withClient(busy, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.match(text(result), /same idempotency_key/);
    assert.match(text(result), /idempotency_key: `mcp-/);
  });
});

test('apply_agent_skills applies only at the quoted price', async () => {
  let newPrice = 43;
  const fake = fakeClient(skillRoutes({
    '/UserAgent/PricingPreview': () => ({ result: true, errors: [], totalPriceUsd: newPrice, totalMonthlyCredits: newPrice * 100 }),
    '/UserAgent/SkillsApply': { result: true },
  }));
  await withClient(fake, async client => {
    const unquoted = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true }, confirm: true },
    });
    assert.equal(unquoted.structuredContent.status, 'quote');
    assert.match(text(unquoted), /confirming needs the idempotency_key of a quote/);

    const foreign = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true }, confirm: true, idempotency_key: 'my-own-key-123' },
    });
    assert.equal(foreign.structuredContent.status, 'quote');

    const quote = await quoteInstagram(client);
    newPrice = 430;
    const changed = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(changed.structuredContent.status, 'quote');
    assert.equal(changed.structuredContent.priceChanged, true);
    assert.equal(changed.structuredContent.pricing.newMonthlyUsd, 430);
    assert.notEqual(changed.structuredContent.idempotencyKey, quote.structuredContent.idempotencyKey);
    assert.match(text(changed), /The price changed since the quote, so nothing was applied or charged/);
    assert.equal(fake.paths().includes('/UserAgent/SkillsApply'), false);
  });
});

test('apply_agent_skills checks the live agent when Wiro answers with an error or a saved result', async () => {
  // An error after the change was saved: the agent shows the new skills.
  const saved = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply(),
    '/UserAgent/SkillsApply': { result: false, errors: [{ code: 0, message: 'Connection reset while saving' }] },
  }));
  await withClient(saved, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.status, 'applied');
    assert.match(result.structuredContent.billing.note, /Connection reset while saving.*the change was saved.*Do not repeat the change/);
    assert.doesNotMatch(text(result), /Nothing changed/);
  });

  // An error before anything was written: the agent is unchanged.
  const unchanged = fakeClient(skillRoutes({
    '/UserAgent/SkillsApply': { result: false, errors: [{ code: 0, message: 'Connection reset while saving' }] },
  }));
  await withClient(unchanged, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'refused');
    assert.match(text(result), /skills are unchanged, so the change was not applied/);
  });

  // The agent cannot be read afterwards: nothing is claimed either way.
  const unreadable = fakeClient(skillRoutes({
    '/UserAgent/Detail': (_body, calls) => (calls.some(call => call.path === '/UserAgent/SkillsApply')
      ? { result: false, errors: [{ code: 0, message: 'User agent not found' }] }
      : detail()),
    '/UserAgent/SkillsApply': () => { throw new Error('socket hang up'); },
  }));
  await withClient(unreadable, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.match(text(result), /could not be read to check whether the change was saved/);
    assert.equal(result.structuredContent.restart, 'The agent restarts if the change was saved.');
  });

  // A reused key replays an earlier success although this change was not made.
  const replayed = fakeClient(skillRoutes({
    '/UserAgent/SkillsApply': { result: true, pricing: { previousPriceUsd: 42, newPriceUsd: 43, deltaUsd: 1 }, prepaidWalletDelta: 0.5 },
  }));
  await withClient(replayed, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'refused');
    assert.match(text(result), /saved result of an earlier call.*probably not applied by this call/);
    assert.deepEqual(result.structuredContent.nextAction.arguments, { agent_guid: AGENT, skills: { 'int-instagram-post': true }, add_dependencies: true });
  });

  // A retry after a timeout: the change is already on, and Wiro returns the earlier result.
  const retry = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({ skills: INSTAGRAM_SET.map(name => ({ name, enabled: true })), monthlypriceusd: '43.00' }),
    '/UserAgent/SkillsApply': { result: true, pricing: { previousPriceUsd: 42, newPriceUsd: 43, deltaUsd: 1 }, prepaidWalletDelta: 0.5 },
  }));
  await withClient(retry, async client => {
    const key = newSkillChangeKey(skillChangeDigest(AGENT, Object.fromEntries(['int-instagram-post', 'util-social-posting-common', 'util-anti-ai-human-copy', 'util-chat-markdown-reporting'].map(name => [name, true]))), skillPriceTag(42, 43));
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true }, confirm: true, idempotency_key: key },
    });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.status, 'applied');
    assert.match(result.structuredContent.billing.note, /already applied by an earlier call with this idempotency_key, and nothing new was charged now/);
    assert.equal(retry.paths().includes('/UserAgent/PricingPreview'), false);
    assert.deepEqual(retry.calls.find(call => call.path === '/UserAgent/SkillsApply').body.skills, {});
  });
});

test('apply_agent_skills tells a cancelled plan that nothing renews at the new price', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({ subscription: { plan: 'agent', status: 'active', provider: 'prepaid', currentperiodend: NOW + 15 * 86400, daysremaining: 15, pendingdowngrade: 'cancel' } }),
    '/UserAgent/PricingPreview': { result: true, errors: [], totalPriceUsd: 40, totalMonthlyCredits: 4000 },
  }));
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-chat-markdown-reporting': false } },
    });
    const note = result.structuredContent.billing.note;
    assert.match(note, /credited back to your personal wallet now for the 15 days left in this period/);
    assert.match(note, /The plan is cancelled and ends about a day after .*, so this covers only the days left/);
    assert.doesNotMatch(note, /renews at|expire/);
  });
});

test('apply_agent_skills checks names before anything is priced or written', async () => {
  const fake = fakeClient(skillRoutes());
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: {
        agent_guid: AGENT,
        skills: { 'cs-weekly': true, telegram: true, 'int-instagram-postt': true, 'int-old-poster': true },
      },
    });
    assert.equal(result.isError, true);
    const message = text(result);
    assert.match(message, /manage_agent_custom_skill/);
    assert.match(message, /channel, not a skill/);
    assert.match(message, /Unknown skill "int-instagram-postt"\. Did you mean int-instagram-post/);
    assert.match(message, /retired.*int-instagram-post instead/);
    assert.deepEqual(fake.paths(), ['/Skills/List']);
  });
});

test('apply_agent_skills reports a no-op, a dependency turned off and a tier downgrade', async () => {
  const fake = fakeClient(skillRoutes());
  await withClient(fake, async client => {
    const noop = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-chat-markdown-reporting': true, 'int-googleads-manage': false } },
    });
    assert.equal(noop.structuredContent.status, 'no_change');

    const conflict = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true, 'util-social-posting-common': false } },
    });
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /int-instagram-post needs util-social-posting-common/);
    assert.equal(fake.paths().includes('/UserAgent/PricingPreview'), false);
  });

  const pro = fakeClient(skillRoutes({ '/UserAgent/Detail': detail({ tier: 'pro' }) }));
  await withClient(pro, async client => {
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: {}, tier: 'starter' },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /cannot be moved back to Starter/);
  });
});

test('apply_agent_skills runs the server\'s dependency check against the whole skill set', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({
      skills: ['int-instagram-post', 'util-chat-markdown-reporting', 'util-social-posting-common', 'util-anti-ai-human-copy']
        .map(name => ({ name, enabled: true })),
    }),
  }));
  await withClient(fake, async client => {
    const removing = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-anti-ai-human-copy': false } },
    });
    assert.equal(removing.isError, true);
    assert.match(text(removing), /int-instagram-post needs util-anti-ai-human-copy\. Keep util-anti-ai-human-copy on, or also turn off int-instagram-post/);

    const withoutDependencies = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-video-creator': true }, add_dependencies: false },
    });
    assert.equal(withoutDependencies.isError, true);
    assert.match(text(withoutDependencies), /util-video-creator needs util-motion-effects, which is off/);
    assert.equal(fake.paths().includes('/UserAgent/PricingPreview'), false);
  });
});

test('apply_agent_skills tells a card plan that nothing is charged now', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({ teamguid: 'team-1', subscription: { status: 'active', provider: 'stripe', currentperiodend: NOW + 86400, daysremaining: 1 } }),
  }));
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true } },
    });
    assert.equal(result.structuredContent.billing.plan, 'card');
    assert.equal(result.structuredContent.billing.wallet, 'team');
    assert.equal(result.structuredContent.billing.estimatedChargeNowUsd, null);
    assert.match(result.structuredContent.billing.note, /Nothing is charged now.*next invoice/);
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /team-1/);
  });
});

// ---------------------------------------------------------------------------
// set_agent_credentials
// ---------------------------------------------------------------------------

test('set_agent_credentials describes a credential without writing or leaking values', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, credential: 'telegram' },
    });
    assert.notEqual(result.isError, true, text(result));
    const out = result.structuredContent;
    assert.equal(out.mode, 'describe');
    assert.equal(out.credential.kind, 'channel');
    const token = out.credential.fields.find(field => field.field === 'bottoken');
    assert.equal(token.secret, true);
    assert.equal(token.help, 'Create a bot with @BotFather and copy its token. Keep it private.');
    const groups = out.credential.fields.find(field => field.field === 'groups');
    assert.deepEqual(groups.itemFields.map(field => field.field), ['chatid', 'allowedusers']);
    assert.equal(out.credential.status.connected, false);
    assert.deepEqual(out.credential.status.missingFields, ['Allowed Telegram DM User IDs']);
    assert.match(text(result), /turns on by itself once these are set: Telegram Bot Token, Allowed Telegram DM User IDs/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
    assert.deepEqual(fake.paths(), ['/Credentials/Detail', '/UserAgent/Detail']);
  });
});

test('set_agent_credentials writes typed values, reports the channel and never echoes secrets', async () => {
  let written = false;
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': body => {
      written = true;
      return { result: true, errors: [], applied: body.fields.length };
    },
    '/UserAgent/Detail': () => (written
      ? detail({
        status: 1,
        credentials: { telegram: { bottoken: TOKEN, allowedusers: ['761381461'], optional: true, _connected: true, _filled: true, _schema: { title: 'Telegram' } } },
        communicationChannels: [{ id: 'telegram', title: 'Telegram', credentialkey: 'telegram', enabled: true, configured: true, missingfields: [] }],
      })
      : detail()),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: {
        agent_guid: AGENT,
        fields: [
          { credential: 'telegram', field: 'bottoken', value: TOKEN },
          { credential: 'telegram', field: 'allowedusers', value: [761381461, ' 761381462 '] },
        ],
      },
    });
    assert.notEqual(result.isError, true, text(result));
    const upsert = fake.calls.find(call => call.path === '/UserAgent/CredentialUpsert');
    assert.deepEqual(upsert.body, {
      useragentguid: AGENT,
      fields: [
        { credentialkey: 'telegram', fieldname: 'bottoken', fieldvalue: TOKEN },
        { credentialkey: 'telegram', fieldname: 'allowedusers', fieldvalue: ['761381461', '761381462'] },
      ],
    });
    const out = result.structuredContent;
    assert.equal(out.applied, 2);
    assert.equal(out.channels[0].enabled, true);
    assert.equal(out.credentials[0].connected, true);
    assert.equal(out.agentStatus, 'stopping');
    assert.match(out.notes.join(' '), /restarts to load the new values/);
    assert.match(out.notes.join(' '), /Telegram is on\./);
    assert.doesNotMatch(JSON.stringify(result), /AAHsecret/);
  });
});

test('set_agent_credentials refuses bad fields before writing anything', async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: {
        agent_guid: AGENT,
        fields: [
          { credential: 'telegram', field: 'botoken', value: TOKEN },
          { credential: 'telegram', field: 'allowedusers', value: ['12'] },
          { credential: 'meta-ads', field: 'adaccountid', value: '123' },
          { credential: 'meta-ads', field: 'accesstoken', value: 'abcdefghijkl' },
          { credential: 'meta-ads', field: 'authmethod', value: 'magic' },
          { credential: 'sys-openai', field: 'apikey', value: 'sk-123456789' },
          { credential: 'nope', field: 'x', value: 'y' },
        ],
      },
    });
    assert.equal(result.isError, true);
    const message = text(result);
    assert.match(message, /Telegram has no field "botoken"\. Fields you can set: bottoken, allowedusers, groups/);
    assert.match(message, /Allowed Telegram DM User IDs item 1 has an invalid format/);
    assert.match(message, /Ad Account ID is filled when the account is connected/);
    assert.match(message, /"accesstoken" is filled by the connection itself/);
    assert.match(message, /authmethod must be one of api_key, own, wiro/);
    assert.match(message, /OpenAI is managed by Wiro/);
    assert.match(message, /Unknown credential "nope"/);
    assert.doesNotMatch(message, /AAHsecret/);
    assert.equal(fake.paths().includes('/UserAgent/CredentialUpsert'), false);
  });
});

test('set_agent_credentials hides submitted values inside server errors', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: false, applied: 1, errors: [{ code: 0, message: `Telegram rejected ${TOKEN}` }] },
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: {
        agent_guid: AGENT,
        fields: [
          { credential: 'telegram', field: 'bottoken', value: TOKEN },
          { credential: 'telegram', field: 'allowedusers', value: ['761381461'] },
        ],
      },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /partly saved/);
    assert.match(text(result), /Telegram rejected \[hidden\]/);
    assert.doesNotMatch(JSON.stringify(result), /AAHsecret/);
    assert.equal(result.structuredContent.applied, 1);
  });
});

test('set_agent_credentials encodes base64 file fields from their text', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail(),
  });
  const json = '{"type":"service_account","client_email":"bot@example.iam.gserviceaccount.com"}';
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'google-play', field: 'serviceaccountjson', value: json }] },
    });
    assert.notEqual(result.isError, true, text(result));
    const upsert = fake.calls.find(call => call.path === '/UserAgent/CredentialUpsert');
    assert.equal(upsert.body.fields[0].fieldvalue, Buffer.from(json).toString('base64'));
    assert.doesNotMatch(JSON.stringify(result), /service_account/);
  });
});

test('set_agent_credentials refuses a link in a key file field without saving it', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'google-play', field: 'serviceaccountjson', value: 'https://example.com/key.json' }] },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /not a link/);
    assert.equal(fake.calls.some(call => call.path === '/UserAgent/CredentialUpsert'), false);
  });
});

test('set_agent_credentials refuses a private file URL without calling Wiro', { concurrency: false }, async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'twilio-voice', field: 'holdaudio', value: 'http://127.0.0.1:9/hold.mp3' }] },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /not a public address/);
    assert.deepEqual(fake.paths(), ['/Credentials/Detail']);
  });
});

test('set_agent_credentials uploads a file field from a public URL', { concurrency: false }, async () => {
  const originalGet = https.get;
  https.get = (_url, _options, callback) => {
    const response = Readable.from([Buffer.from('ID3 fake audio')]);
    response.statusCode = 200;
    response.headers = { 'content-type': 'audio/mpeg; charset=binary' };
    const request = new EventEmitter();
    process.nextTick(() => callback(response));
    return request;
  };
  let uploaded;
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/CredentialFileUpload': form => {
      uploaded = form;
      return { result: true, url: 'https://cdn.example/agent-credentials/hold.mp3', credentialkey: 'twilio-voice', fieldname: 'holdaudio' };
    },
    '/UserAgent/Detail': detail({ status: 0 }),
  });
  try {
    await withClient(fake, async client => {
      const result = await client.callTool({
        name: 'set_agent_credentials',
        arguments: {
          agent_guid: AGENT,
          fields: [
            { credential: 'twilio-voice', field: 'holdstrategy', value: 'audio' },
            { credential: 'twilio-voice', field: 'holdaudio', value: 'https://files.example.com/media/greeting' },
          ],
        },
      });
      assert.notEqual(result.isError, true, text(result));
      assert.deepEqual(fake.paths(), ['/Credentials/Detail', '/UserAgent/CredentialUpsert', '/UserAgent/CredentialFileUpload', '/UserAgent/Detail']);
      assert.equal(uploaded.get('useragentguid'), AGENT);
      assert.equal(uploaded.get('credentialkey'), 'twilio-voice');
      assert.equal(uploaded.get('fieldname'), 'holdaudio');
      const file = uploaded.get('file');
      assert.equal(file.type, 'audio/mpeg');
      assert.equal(file.name, 'greeting.mp3');
      assert.deepEqual(result.structuredContent.uploadedFiles, [{ credential: 'twilio-voice', field: 'holdaudio', url: 'https://cdn.example/agent-credentials/hold.mp3' }]);
      assert.equal(result.structuredContent.applied, 2);
      assert.match(result.structuredContent.notes[0], /stopped; the values are used when it starts/);
    });
  } finally {
    https.get = originalGet;
  }
});

// ---------------------------------------------------------------------------
// connect_agent_oauth and disconnect_agent_oauth
// ---------------------------------------------------------------------------

test('connect_agent_oauth returns a browser link with the dashboard as the return address', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
    '/UserAgentOAuth/OAuthStatus': { result: true, connected: false, accounts: [], connectedat: '', tokenexpiresat: '' },
    '/UserAgentOAuth/OAuthConnect': { result: true, authorizeUrl: 'https://app.hubspot.com/oauth/authorize?client_id=abc&state=xyz' },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'hubspot' },
    });
    assert.notEqual(result.isError, true, text(result));
    const connect = fake.calls.find(call => call.path === '/UserAgentOAuth/OAuthConnect');
    assert.deepEqual(connect.body, {
      useragentguid: AGENT,
      credentialkey: 'hubspot',
      authmethod: 'wiro',
      redirecturl: `https://wiro.ai/panel/agents/${AGENT}?id=${AGENT}`,
    });
    const out = result.structuredContent;
    assert.equal(out.state, 'authorize_in_browser');
    assert.equal(out.mode, 'wiro');
    assert.equal(out.expiresInSeconds, 900);
    assert.match(text(result), /must open this link in their own browser/);
    assert.match(text(result), /https:\/\/app\.hubspot\.com\/oauth\/authorize/);
    assert.deepEqual(out.nextAction.arguments, {
      action: 'status',
      agent_guid: AGENT,
      credential: 'hubspot',
      since_connected_at: '',
      wait_seconds: 45,
    });
  });
});

test('connect_agent_oauth refuses a return address outside the dashboard and the local machine', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
    '/UserAgentOAuth/OAuthStatus': { result: true, connected: false, accounts: [], connectedat: '', tokenexpiresat: '' },
    '/UserAgentOAuth/OAuthConnect': { result: true, authorizeUrl: 'https://app.hubspot.com/oauth/authorize?state=xyz' },
  });
  await withClient(fake, async client => {
    const refused = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'hubspot', redirect_url: 'https://attacker.example/cb' },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /only be the agent's page in the Wiro dashboard/);
    assert.equal(fake.paths().includes('/UserAgentOAuth/OAuthConnect'), false);

    const local = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'hubspot', redirect_url: 'http://localhost:3000/done' },
    });
    assert.notEqual(local.isError, true, text(local));
    assert.equal(fake.calls.find(call => call.path === '/UserAgentOAuth/OAuthConnect').body.redirecturl, 'http://localhost:3000/done');
    assert.match(local.structuredContent.message, /the browser goes to http:\/\/localhost:3000\/done/);
  });
});

test('connect_agent_oauth explains what to save when Wiro\'s own app is not available', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'meta-ads' },
    });
    assert.notEqual(result.isError, true, text(result));
    const out = result.structuredContent;
    assert.equal(out.state, 'setup_needed');
    const modes = Object.fromEntries(out.connectionModes.map(mode => [mode.mode, mode]));
    assert.equal(modes.wiro.available, false);
    assert.deepEqual(modes.api_key.fields, [{ field: 'systemusertoken', label: 'System User Token', isSet: false }]);
    assert.deepEqual(modes.own.fields.map(field => field.field), ['appid', 'appsecret']);
    assert.match(modes.own.note, /https:\/\/api\.wiro\.ai\/v1\/UserAgentOAuth\/MetaAdsCallback/);
    assert.equal(out.nextAction.tool, 'set_agent_credentials');
    assert.equal(fake.paths().includes('/UserAgentOAuth/OAuthConnect'), false);

    const wiro = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'meta-ads', mode: 'wiro' },
    });
    assert.equal(wiro.structuredContent.state, 'setup_needed');
    assert.match(wiro.structuredContent.message, /not available yet/);
  });
});

test('connect_agent_oauth checks a saved token without a browser and lists the accounts', async () => {
  const row = detailRow();
  row.credentials['meta-ads'] = { ...row.credentials['meta-ads'], systemusertoken: 'EAAB-system-user-token' };
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': { result: true, useragents: [row] },
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgentOAuth/OAuthConnect': { result: true, accounts: [{ id: '1234', name: 'Acme Ads' }, { id: '5678', name: 'Beta Ads' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'meta-ads' },
    });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CredentialUpsert').body.fields, [
      { credentialkey: 'meta-ads', fieldname: 'authmethod', fieldvalue: 'api_key' },
    ]);
    const connect = fake.calls.find(call => call.path === '/UserAgentOAuth/OAuthConnect');
    assert.deepEqual(connect.body, { useragentguid: AGENT, credentialkey: 'meta-ads', authmethod: 'api_key' });
    const out = result.structuredContent;
    assert.equal(out.state, 'pick_accounts');
    assert.deepEqual(out.candidates, [{ id: '1234', name: 'Acme Ads' }, { id: '5678', name: 'Beta Ads' }]);
    assert.equal(out.nextAction.arguments.action, 'select_accounts');
    assert.doesNotMatch(JSON.stringify(result), /EAAB-system-user-token/);
  });
});

test('connect_agent_oauth asks before replacing a working connection', async () => {
  const row = detailRow();
  row.credentials['meta-ads'] = { ...row.credentials['meta-ads'], systemusertoken: 'EAAB-token', authmethod: 'api_key', _connected: true };
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': { result: true, useragents: [row] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'meta-ads', mode: 'api_key' },
    });
    assert.equal(result.structuredContent.state, 'confirm_needed');
    assert.equal(result.structuredContent.nextAction.arguments.confirm, true);
    assert.equal(result.structuredContent.nextAction.reason, 'Ask the user to confirm this first.');
    assert.equal('redirect_url' in result.structuredContent.nextAction.arguments, false);
    assert.equal(fake.paths().includes('/UserAgentOAuth/OAuthConnect'), false);
  });

  // The confirmed call keeps the return address the user asked for.
  const hubspotRow = detailRow();
  hubspotRow.credentials.hubspot = { portalname: 'Acme', _connected: true, _filled: true, _required_missing: false, optional: true, _schema: { title: 'HubSpot' } };
  const browser = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': { result: true, useragents: [hubspotRow] },
    '/UserAgentOAuth/OAuthStatus': { result: true, connected: true, accounts: [], connectedat: '2026-10-01T10:00:00.000Z', tokenexpiresat: '2099-01-01T00:00:00.000Z' },
    '/UserAgentOAuth/OAuthConnect': { result: true, authorizeUrl: 'https://app.hubspot.com/oauth/authorize?state=xyz' },
  });
  await withClient(browser, async client => {
    const ask = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { agent_guid: AGENT, credential: 'hubspot', redirect_url: 'http://localhost:5173/done' },
    });
    assert.equal(ask.structuredContent.state, 'confirm_needed');
    assert.deepEqual(ask.structuredContent.nextAction.arguments, {
      action: 'connect',
      agent_guid: AGENT,
      credential: 'hubspot',
      mode: 'wiro',
      redirect_url: 'http://localhost:5173/done',
      confirm: true,
    });
    assert.equal(browser.paths().includes('/UserAgentOAuth/OAuthConnect'), false);

    const confirmed = await client.callTool({ name: 'connect_agent_oauth', arguments: ask.structuredContent.nextAction.arguments });
    assert.notEqual(confirmed.isError, true, text(confirmed));
    assert.equal(browser.calls.find(call => call.path === '/UserAgentOAuth/OAuthConnect').body.redirecturl, 'http://localhost:5173/done');
    assert.match(confirmed.structuredContent.message, /the browser goes to http:\/\/localhost:5173\/done/);
  });
});

test('connect_agent_oauth status tells a finished sign-in from one still waiting', async () => {
  const signedIn = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgentOAuth/OAuthStatus': { result: true, connected: false, accounts: [], connectedat: '2026-10-29T10:00:00.000Z', tokenexpiresat: '2099-01-01T00:00:00.000Z' },
  });
  await withClient(signedIn, async client => {
    const result = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { action: 'status', agent_guid: AGENT, credential: 'meta-ads', since_connected_at: '' },
    });
    assert.equal(result.structuredContent.state, 'pick_accounts');
    assert.match(result.structuredContent.message, /chosen on the agent's page in the Wiro dashboard/);
  });

  const waiting = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgentOAuth/OAuthStatus': { result: true, connected: false, accounts: [], connectedat: '', tokenexpiresat: '' },
  });
  await withClient(waiting, async client => {
    const result = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { action: 'status', agent_guid: AGENT, credential: 'hubspot', since_connected_at: '', wait_seconds: 1 },
    });
    assert.equal(result.structuredContent.state, 'waiting_for_user');
    assert.ok(waiting.paths().filter(path => path === '/UserAgentOAuth/OAuthStatus').length >= 2);
    assert.deepEqual(result.structuredContent.nextAction.arguments, {
      action: 'status',
      agent_guid: AGENT,
      credential: 'hubspot',
      since_connected_at: '',
      wait_seconds: 45,
    });
  });
});

test('connect_agent_oauth saves accounts and runs the chained page step', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgentOAuth/SetPickerAccounts': body => (body.pickerkey
      ? { result: true, pickerkey: 'pages', pagemappings: [{ adaccountid: '1234', adaccountname: 'Acme Ads', pageid: '555', pagename: 'Acme Page' }] }
      : { result: true, accounts: [{ id: '1234', name: 'Acme Ads' }, { id: '5678', name: 'Beta Ads' }] }),
    '/UserAgentOAuth/DiscoverPickerItems': {
      result: true,
      pickerkey: 'pages',
      groups: [
        { parent: { adaccountid: '1234', adaccountname: 'Acme Ads' }, items: [{ pageid: '555', pagename: 'Acme Page' }, { pageid: '556', pagename: 'Acme Two' }] },
        { parent: { adaccountid: '5678', adaccountname: 'Beta Ads' }, items: [{ pageid: '777', pagename: 'Beta Page' }] },
      ],
    },
  });
  await withClient(fake, async client => {
    const saved = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { action: 'select_accounts', agent_guid: AGENT, credential: 'meta-ads', accounts: [{ id: '1234', name: 'Acme Ads' }, { id: 5678, name: 'Beta Ads' }] },
    });
    assert.notEqual(saved.isError, true, text(saved));
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgentOAuth/SetPickerAccounts').body, {
      useragentguid: AGENT,
      credentialkey: 'meta-ads',
      accounts: [{ adaccountid: '1234', adaccountname: 'Acme Ads' }, { adaccountid: '5678', adaccountname: 'Beta Ads' }],
    });
    assert.equal(saved.structuredContent.state, 'connected');
    assert.deepEqual(saved.structuredContent.nextAction.arguments, { action: 'select_accounts', agent_guid: AGENT, credential: 'meta-ads', picker: 'pages' });

    const listed = await client.callTool({ name: 'connect_agent_oauth', arguments: saved.structuredContent.nextAction.arguments });
    assert.equal(listed.structuredContent.state, 'pick_child_items');
    assert.equal(listed.structuredContent.childStep.label, 'Facebook Pages');
    assert.deepEqual(listed.structuredContent.nextAction.arguments.selections, [
      { parent: '1234', items: ['555', '556'] },
      { parent: '5678', items: ['777'] },
    ]);

    const chained = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { action: 'select_accounts', agent_guid: AGENT, credential: 'meta-ads', picker: 'pages', selections: [{ parent: '1234', items: ['555'] }] },
    });
    assert.notEqual(chained.isError, true, text(chained));
    const save = fake.calls.filter(call => call.path === '/UserAgentOAuth/SetPickerAccounts').at(-1);
    assert.deepEqual(save.body, {
      useragentguid: AGENT,
      credentialkey: 'meta-ads',
      pickerkey: 'pages',
      selections: [
        { parentvalue: '1234', items: [{ pageid: '555', pagename: 'Acme Page' }] },
        { parentvalue: '5678', items: [] },
      ],
    });
    assert.match(chained.structuredContent.message, /Nothing was chosen for Beta Ads \(5678\)/);
    assert.deepEqual(chained.structuredContent.childStep.groups[0].items, [{ id: '555', name: 'Acme Page' }]);

    const unknown = await client.callTool({
      name: 'connect_agent_oauth',
      arguments: { action: 'select_accounts', agent_guid: AGENT, credential: 'meta-ads', picker: 'pages', selections: [{ parent: '1234', items: ['999'] }] },
    });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /"999" is not available under Acme Ads/);
  });
});

test('connect_agent_oauth sends plain credentials to set_agent_credentials', async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'connect_agent_oauth', arguments: { agent_guid: AGENT, credential: 'telegram' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /not a sign-in connection.*set_agent_credentials/);
  });
});

test('disconnect_agent_oauth asks first and disconnects only with confirm', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgentOAuth/OAuthStatus': { result: true, connected: true, accounts: [{ id: '1234', name: 'Acme Ads' }], connectedat: '2026-10-01T00:00:00Z', tokenexpiresat: '' },
    '/UserAgentOAuth/OAuthDisconnect': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const preview = await client.callTool({ name: 'disconnect_agent_oauth', arguments: { agent_guid: AGENT, credential: 'meta-ads' } });
    assert.equal(preview.structuredContent.disconnected, false);
    assert.equal(preview.structuredContent.connectedBefore, true);
    assert.match(preview.structuredContent.message, /connected for Acme Ads/);
    assert.match(preview.structuredContent.willClear, /own app keys are kept/);
    assert.equal(fake.paths().includes('/UserAgentOAuth/OAuthDisconnect'), false);

    const done = await client.callTool({ name: 'disconnect_agent_oauth', arguments: preview.structuredContent.nextAction.arguments });
    assert.equal(done.structuredContent.disconnected, true);
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgentOAuth/OAuthDisconnect').body, {
      useragentguid: AGENT,
      credentialkey: 'meta-ads',
    });
  });
});

// ---------------------------------------------------------------------------
// manage_agent_custom_skill
// ---------------------------------------------------------------------------

test('manage_agent_custom_skill creates a scheduled task under its canonical key', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'manage_agent_custom_skill',
      arguments: { action: 'upsert', agent_guid: AGENT, key: 'weekly-report', kind: 'scheduled_task', value: 'Summarize last week.', enabled: true },
    });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CustomSkillUpsert').body, {
      useragentguid: AGENT,
      skillkey: 'cs-cron-weekly-report',
      value: 'Summarize last week.',
      enabled: true,
    });
    const out = result.structuredContent;
    assert.equal(out.key, 'cs-cron-weekly-report');
    assert.equal(out.kind, 'scheduled_task');
    assert.equal(out.created, true);
    assert.equal(out.schedule.interval, '0 10 * * 1');
    assert.equal(out.schedule.timeZone, 'Europe/Istanbul');
    assert.match(out.schedule.note, /Mondays at 10:00/);
    assert.match(out.schedule.note, /spends the agent's credits/);
    assert.equal(out.entry.description, 'Weekly report');
    assert.match(out.restart, /restarts/);
  });
});

test('manage_agent_custom_skill upsert with a bare key edits the agent\'s existing entry', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'manage_agent_custom_skill',
      arguments: { action: 'upsert', agent_guid: AGENT, key: 'my-task', value: 'Do it at eight.' },
    });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(fake.calls.find(call => call.path === '/UserAgent/CustomSkillUpsert').body.skillkey, 'cs-cron-my-task');
    assert.equal(result.structuredContent.key, 'cs-cron-my-task');
    assert.equal(result.structuredContent.created, false);
    assert.deepEqual(result.structuredContent.warnings, ['Saved under the key cs-cron-my-task.']);

    const fresh = await client.callTool({
      name: 'manage_agent_custom_skill',
      arguments: { action: 'upsert', agent_guid: AGENT, key: 'brand-voice', value: 'Be warm.' },
    });
    assert.equal(fresh.structuredContent.key, 'cs-brand-voice');
    assert.equal(fresh.structuredContent.created, true);
  });

  const both = fakeClient({
    '/UserAgent/Detail': detail({
      customskills: [{ key: 'cs-report', description: 'Report rules', value: 'Be short.', enabled: true, _source: 'user-created' }],
      scheduledskills: [{ key: 'cs-cron-report', description: 'Report', value: 'Report.', interval: '0 9 * * 1', enabled: true, _source: 'user-created' }],
    }),
  });
  await withClient(both, async client => {
    const result = await client.callTool({
      name: 'manage_agent_custom_skill',
      arguments: { action: 'upsert', agent_guid: AGENT, key: 'report', value: 'New text.' },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /Both cs-report and cs-cron-report exist on this agent\. Pass the full key\./);
  });
});

test('manage_agent_custom_skill refuses invalid upserts without writing', async () => {
  const fake = fakeClient({ '/UserAgent/Detail': detail() });
  await withClient(fake, async client => {
    const cases = [
      [{ key: 'tone', kind: 'skill', interval: '0 9 * * *', value: 'x' }, /only applies to scheduled tasks/],
      [{ key: 'cs-cron-daily', interval: 'every day', value: 'x' }, /five fields/],
      [{ key: 'Lead Strategy', value: 'x' }, /Invalid key/],
      [{ key: 'brand-new' }, /needs value/],
      [{ key: 'cs-approval-policy', description: 'New text' }, /comes with the agent, so its description cannot be changed/],
      [{ key: 'cs-cron-metaads-performance-reporter', value: 'Different prompt' }, /comes from the agent's template/],
    ];
    for (const [args, pattern] of cases) {
      const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, ...args } });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text(result), pattern);
    }
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), false);
  });
});

test('manage_agent_custom_skill deletes only user entries, after confirm', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillDelete': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const preset = await client.callTool({
      name: 'manage_agent_custom_skill',
      arguments: { action: 'delete', agent_guid: AGENT, key: 'metaads-performance-reporter', kind: 'scheduled_task', confirm: true },
    });
    assert.equal(preset.isError, true);
    assert.deepEqual(preset.structuredContent.nextAction.arguments, {
      action: 'upsert',
      agent_guid: AGENT,
      key: 'cs-cron-metaads-performance-reporter',
      enabled: false,
    });

    const ask = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'delete', agent_guid: AGENT, key: 'my-task' } });
    assert.equal(ask.structuredContent.status, 'confirm_needed');
    assert.equal(ask.structuredContent.key, 'cs-cron-my-task');
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillDelete'), false);

    const missing = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'delete', agent_guid: AGENT, key: 'cs-cron-ghost', confirm: true } });
    assert.equal(missing.isError, true);

    const done = await client.callTool({ name: 'manage_agent_custom_skill', arguments: ask.structuredContent.nextAction.arguments });
    assert.equal(done.structuredContent.status, 'deleted');
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CustomSkillDelete').body, {
      useragentguid: AGENT,
      skillkey: 'cs-cron-my-task',
    });
  });
});

test('manage_agent_custom_skill history shows saved states without who changed them', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillHistory': {
      result: true,
      errors: [],
      entries: [{
        guid: 'v2',
        skillkey: 'cs-cron-my-task',
        value: 'Old prompt',
        intervalexpr: '0 7 * * *',
        enabled: true,
        operation: 'update',
        changedby: 'uuid-secret',
        changedat: 1767225600,
        after_value: 'Do my task.',
        after_interval: '0 8 * * *',
        after_enabled: true,
        changed_fields: ['value', 'interval'],
        changedby_user: { uuid: 'uuid-secret', email: 'owner@example.com', firstname: 'Ada' },
        prev_value: 'Older',
      }],
      preset_default: null,
    },
    '/UserAgent/CustomSkillAlternatives': { result: true, alternatives: [{ title: 'Daily digest', description: 'A short daily summary', value: 'Summarize today.', intervalexpr: '0 9 * * *' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'history', agent_guid: AGENT, key: 'my-task' } });
    assert.notEqual(result.isError, true, text(result));
    const out = result.structuredContent;
    assert.deepEqual(out.history, [{
      versionId: 'v2',
      operation: 'update',
      changedAt: '2026-01-01T00:00:00.000Z',
      changedFields: ['value', 'interval'],
      value: 'Do my task.',
      interval: '0 8 * * *',
      enabled: true,
    }]);
    assert.equal(out.presetDefault, null);
    assert.deepEqual(out.templates, [{ title: 'Daily digest', description: 'A short daily summary', value: 'Summarize today.', interval: '0 9 * * *' }]);
    assert.doesNotMatch(JSON.stringify(result), /owner@example\.com|uuid-secret|Ada|Older/);
  });
});

test('manage_agent_custom_skill warns that a reset without a template default deletes', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillHistory': { result: true, entries: [], preset_default: null },
    '/UserAgent/CustomSkillRevert': { result: true, action: 'deleted', current_value: null, current_interval: null, current_enabled: null },
  });
  await withClient(fake, async client => {
    const ask = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'revert', agent_guid: AGENT, key: 'cs-cron-my-task', source: 'preset' } });
    assert.equal(ask.structuredContent.status, 'confirm_needed');
    assert.match(ask.structuredContent.message, /no template default, so reverting to the template deletes it/);
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillRevert'), false);

    const done = await client.callTool({ name: 'manage_agent_custom_skill', arguments: ask.structuredContent.nextAction.arguments });
    assert.equal(done.structuredContent.status, 'deleted');
    assert.equal(done.structuredContent.revertResult, 'deleted');
    assert.equal(done.structuredContent.entry, null);
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CustomSkillRevert').body, {
      useragentguid: AGENT,
      skillkey: 'cs-cron-my-task',
      source: 'preset',
    });
  });
});

test('manage_agent_custom_skill renames a user entry and keeps its kind', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillRename': { result: true, newskillkey: 'cs-cron-morning-task' },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'rename', agent_guid: AGENT, key: 'my-task', new_key: 'morning-task' } });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CustomSkillRename').body, {
      useragentguid: AGENT,
      oldskillkey: 'cs-cron-my-task',
      newskillkey: 'cs-cron-morning-task',
    });
    assert.equal(result.structuredContent.renamedTo, 'cs-cron-morning-task');

    const preset = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'rename', agent_guid: AGENT, key: 'cs-approval-policy', new_key: 'rules' } });
    assert.equal(preset.isError, true);
    assert.match(text(preset), /cannot be renamed/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('custom skill keys follow the API normalisation rules', () => {
  assert.equal(normalizeCustomSkillKey('lead-strategy'), 'cs-lead-strategy');
  assert.equal(normalizeCustomSkillKey('cs-lead-strategy'), 'cs-lead-strategy');
  assert.equal(normalizeCustomSkillKey('cs-cron-daily-report'), 'cs-cron-daily-report');
  assert.equal(normalizeCustomSkillKey('daily-report', { scheduled: true }), 'cs-cron-daily-report');
  assert.equal(normalizeCustomSkillKey('daily', { hasInterval: '0 9 * * *' }), 'cs-cron-daily');
  assert.equal(normalizeCustomSkillKey('daily', { hasInterval: 'manual' }), 'cs-daily');
  assert.equal(normalizeCustomSkillKey('cron-daily'), 'cs-cron-daily');
  assert.equal(normalizeCustomSkillKey('Lead Strategy'), null);
  assert.equal(normalizeCustomSkillKey('lead--strategy'), null);
  assert.equal(normalizeCustomSkillKey('-lead'), null);
  assert.equal(normalizeCustomSkillKey(''), null);
  assert.equal(normalizeCustomSkillKey(`cs-${'a'.repeat(61)}`), null);
  assert.deepEqual(upsertCustomSkillKey('report', 'scheduled_task'), { key: 'cs-cron-report' });
  assert.match(upsertCustomSkillKey('cs-report', 'scheduled_task').error, /custom skill key/);
});

test('an OAuth credential is ready for new skills only once it is connected', () => {
  const registry = { skills: new Map([['int-shop', { requiresCredentials: true, credentialKeys: ['shopify', 'notes'] }]]) };
  const row = (shopify) => ({
    credentials: {
      shopify: { _schema: { oauth_provider: { oauth_flow: {} } }, ...shopify },
      notes: { _schema: { oauth_provider: null }, _filled: true, _connected: false },
    },
  });
  assert.deepEqual(credentialsNeededFor(['int-shop'], registry, row({ _filled: true, _connected: false })), [{ skill: 'int-shop', credentials: ['shopify'] }]);
  assert.deepEqual(credentialsNeededFor(['int-shop'], registry, row({ _filled: true, _connected: true })), []);
});

test('skill plans follow dependency cycles and keys are bound to their change', () => {
  const registry = parseSkillRegistry(skillList);
  const plan = planSkillChanges({ 'util-video-creator': true }, registry, true);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.requested, { 'util-video-creator': true, 'util-motion-effects': true });

  const digest = skillChangeDigest(AGENT, plan.requested, undefined);
  assert.equal(digest, skillChangeDigest(AGENT, { 'util-motion-effects': true, 'util-video-creator': true }));
  const key = newSkillChangeKey(digest, skillPriceTag(12, 15));
  assert.equal(idempotencyKeyMismatch(key, digest), false);
  assert.equal(idempotencyKeyMismatch(key, skillChangeDigest(AGENT, plan.requested, 'pro')), true);
  assert.equal(idempotencyKeyMismatch('my-own-key-123', digest), false);
  assert.deepEqual(parseSkillChangeKey(key), { digest, priceTag: skillPriceTag(12, 15) });
  assert.equal(parseSkillChangeKey('my-own-key-123'), null);
  assert.notEqual(skillPriceTag(12, 15), skillPriceTag(120, 150));
  assert.notEqual(skillPriceTag(12, 15), skillPriceTag(13, 15));
  assert.equal(skillPriceTag(12, 15), skillPriceTag(12.001, 15));
});

test('deploy custom skills resolve bare keys against the template and need text when new', () => {
  const template = [
    { key: 'cs-content-strategy', interval: null },
    { key: 'cs-cron-daily-digest', interval: '0 8 * * *' },
  ];
  const { skills, errors } = resolveDeployCustomSkills([
    { key: 'daily-digest', enabled: false },
    { key: 'content-strategy', value: 'Focus on reels' },
    { key: 'weekly-report', value: 'Sum up', interval: ' 0 9 * * 1 ' },
  ], template);
  assert.deepEqual(errors, []);
  assert.deepEqual(skills, [
    // Sent without a schedule, Wiro would save the template's task on its weekly default.
    { key: 'cs-cron-daily-digest', kind: 'scheduled_task', fromTemplate: true, interval: '0 8 * * *', enabled: false },
    { key: 'cs-content-strategy', kind: 'skill', fromTemplate: true, value: 'Focus on reels' },
    { key: 'cs-cron-weekly-report', kind: 'scheduled_task', fromTemplate: false, value: 'Sum up', interval: '0 9 * * 1' },
  ]);
  assert.deepEqual(resolveDeployCustomSkills([{ key: 'daily-digest', interval: '0 7 * * 1-5' }], template).skills, [
    { key: 'cs-cron-daily-digest', kind: 'scheduled_task', fromTemplate: true, interval: '0 7 * * 1-5' },
  ]);
  // The runtime always runs a template's scheduled task with the template's own prompt.
  const text = resolveDeployCustomSkills([{ key: 'daily-digest', value: 'Only customer mail', enabled: true }], template);
  assert.deepEqual(text.skills, []);
  assert.equal(text.errors[0], templateTaskTextError('cs-cron-daily-digest'));
  assert.match(text.errors[0], /only its schedule \(interval\) and on\/off state \(enabled\) can/);
  assert.match(resolveDeployCustomSkills([{ key: 'x', value: 'a' }, { key: 'cs-x', value: 'b' }], []).errors[0], /listed twice/);
  assert.match(resolveDeployCustomSkills([{ key: 'tone', value: ' ' }], []).errors[0], /value cannot be empty/);
  assert.match(resolveDeployCustomSkills([{ key: 'cs-cron-x', value: 'a', interval: '* * *' }], null).errors[0], /five fields/);
  assert.deepEqual(resolveDeployCustomSkills([{ key: 'brand-voice' }], null).errors, []);
  assert.deepEqual(resolveDeployCustomSkills([{ key: 'cs-cron-daily-digest', value: 'Mine' }], null).errors, []);
  assert.match(resolveDeployCustomSkills([{ key: 'both' }], [{ key: 'cs-both' }, { key: 'cs-cron-both' }]).errors[0], /Pass the full key/);
});

test('sign-in return addresses are limited to the agent page and the local machine', () => {
  assert.equal(isAllowedRedirectUrl(`https://wiro.ai/panel/agents/${AGENT}?id=${AGENT}`, AGENT), true);
  assert.equal(isAllowedRedirectUrl(`https://wiro.ai/panel/agents/${AGENT}`, AGENT), true);
  assert.equal(isAllowedRedirectUrl('http://localhost:5173/callback', AGENT), true);
  assert.equal(isAllowedRedirectUrl('http://127.0.0.1:8080/done', AGENT), true);
  assert.equal(isAllowedRedirectUrl('https://attacker.example/cb', AGENT), false);
  assert.equal(isAllowedRedirectUrl('https://wiro.ai/panel/agents/other-agent', AGENT), false);
  assert.equal(isAllowedRedirectUrl(`https://wiro.ai/panel/agents/${AGENT}?next=https://attacker.example`, AGENT), false);
  assert.equal(isAllowedRedirectUrl(`https://wiro.ai.attacker.example/panel/agents/${AGENT}`, AGENT), false);
  assert.equal(isAllowedRedirectUrl('http://localhost.attacker.example/cb', AGENT), false);
  assert.equal(isAllowedRedirectUrl('http://wiro.ai/panel/agents/x', AGENT), false);
  assert.equal(isAllowedRedirectUrl('https://user@wiro.ai/panel/agents/ua-0001', AGENT), false);
  assert.equal(isAllowedRedirectUrl('javascript:alert(1)', AGENT), false);
});

test('prorated charges, base64 values and picker payloads match the API', () => {
  const now = Date.UTC(2026, 9, 1);
  assert.equal(estimateProratedUsd(30, now / 1000 + 10 * 86400, now), 10);
  assert.equal(estimateProratedUsd(-6, now / 1000 + 15 * 86400, now), -3);
  assert.equal(estimateProratedUsd(5, null, now), null);

  assert.equal(normalizeBase64FileValue('eyJhIjoxfQ=='), 'eyJhIjoxfQ==');
  assert.equal(normalizeBase64FileValue('data:application/json;base64,eyJhIjoxfQ=='), 'eyJhIjoxfQ==');
  assert.equal(normalizeBase64FileValue('{"a":1}'), Buffer.from('{"a":1}').toString('base64'));
  assert.equal(normalizeBase64FileValue('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), Buffer.from('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').toString('base64'));

  const youtube = parseCredentialMeta({
    key: 'youtube',
    title: 'YouTube',
    connection_modes: ['wiro', 'own'],
    oauth_provider: {
      oauth_flow: {},
      account_picker: { multi_select: true, item_value_field: 'channelid', item_label_field: 'channeltitle', item_fields_to_save: ['channelid', 'channeltitle'], url_item_fields: { channelid: 'id', channeltitle: 'title' } },
    },
  });
  assert.deepEqual(buildPickerAccounts(youtube.oauth.picker, [{ id: 'UC1', title: 'My channel' }]), {
    accounts: [{ channelid: 'UC1', channeltitle: 'My channel' }],
  });
  assert.match(buildPickerAccounts(youtube.oauth.picker, [{ id: 'UC1' }, { id: 'UC1' }]).error, /listed twice/);

  const next = parseCredentialMeta(credentials['meta-ads']).oauth.picker.next;
  const groups = [{ parent: { id: '1234', name: 'Acme' }, items: [{ id: '555', name: 'Page' }] }, { parent: { id: '9', name: 'Broken' }, items: [], errorCode: 'provider_error' }];
  assert.deepEqual(buildChainedSelections(next, groups, [{ parent: 'act_1234', items: ['555'] }]).selections, [
    { parentvalue: '1234', items: [{ pageid: '555', pagename: 'Page' }] },
  ]);
  assert.match(buildChainedSelections(next, groups, [{ parent: '9', items: [] }]).error, /could not be read/);
});

test('connection states follow the picker and expiry rules', () => {
  const base = { connected: false, accounts: [], connectedAt: '', tokenExpiresAt: '', childStep: null };
  assert.equal(connectionState(base, { hasPicker: true, since: '' }), 'waiting_for_user');
  assert.equal(connectionState({ ...base, connectedAt: 't1' }, { hasPicker: true, since: '' }), 'pick_accounts');
  assert.equal(connectionState({ ...base, connected: true, connectedAt: 't1' }, { hasPicker: false, since: 't0' }), 'connected');
  assert.equal(connectionState({ ...base, connected: true, connectedAt: 't0' }, { hasPicker: false, since: 't0' }), 'waiting_for_user');
  assert.equal(connectionState({ ...base, connectedAt: 't1', accounts: [{ id: '1', name: 'a' }], tokenExpiresAt: '2000-01-01T00:00:00Z' }, { hasPicker: true }), 'token_expired');
  assert.equal(connectionState({
    ...base,
    connected: true,
    connectedAt: 't1',
    childStep: { picker: 'locations', optional: false, configured: false, groups: [] },
  }, { hasPicker: true }), 'pick_child_items');
  assert.equal(connectionState(base, { hasPicker: false }), 'not_connected');
});
