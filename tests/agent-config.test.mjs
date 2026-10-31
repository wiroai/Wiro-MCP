import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';
import { PLAYBOOKS } from '../dist/playbooks.js';
import { ApiResultError } from '../dist/utils/api.js';
import {
  buildChainedSelections,
  credentialsNeededFor,
  describeSkillsApplyError,
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
      { key: 'groups', type: 'object-array', label: 'Allowed Telegram Groups', required: false, item_schema: [{ key: 'chatid', type: 'text', label: 'Group Chat ID', required: true, pattern: '^-\\d{5,}$' }, { key: 'allowedusers', type: 'string-array', label: 'Allowed User IDs', required: true, pattern: '^\\d{5,}$' }] },
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
      { key: 'serviceaccountjson', type: 'fileinput-base64', label: 'Service account JSON', required: true, encrypted: true, filetypes: ['application/json'] },
    ],
    oauth_provider: null,
  },
  'apple-appstore': {
    key: 'apple-appstore',
    title: 'App Store Connect',
    connection_modes: [],
    credential_schema: [
      { key: 'privatekey', type: 'fileinput-base64', label: 'Private Key (.p8)', required: true, encrypted: true, filetypes: ['application/x-pem-file', '.p8', 'application/octet-stream', 'text/plain'] },
    ],
    oauth_provider: null,
  },
  firebase: {
    key: 'firebase',
    title: 'Firebase',
    credential_mode: 'sa',
    connection_modes: [],
    credential_schema: [{
      key: 'accounts',
      type: 'custom:firebase-accounts-list',
      label: 'Firebase Accounts',
      required: true,
      custom_component_config: {
        max_accounts: 10,
        per_account_schema: [
          { key: 'appname', type: 'text', label: 'App Name', required: true, help: '<p>A friendly label that identifies this Firebase project.</p>' },
          { key: 'serviceaccountjson', type: 'fileinput-base64', label: 'Service Account JSON', required: true, encrypted: true, filetypes: ['application/json'] },
          {
            key: 'apps',
            type: 'array',
            label: 'Apps',
            required: false,
            item_type: 'object',
            item_schema: [
              { key: 'platform', type: 'select', label: 'Platform', required: true, options: [{ value: 'ios', text: 'iOS' }, { value: 'android', text: 'Android' }] },
              { key: 'id', type: 'text', label: 'App ID', required: true, help: '<p>The Android package name or the numeric Apple ID of the app.</p>' },
            ],
            help: '<p>The mobile apps registered under this Firebase project.</p>',
          },
        ],
      },
    }],
    oauth_provider: null,
  },
  'google-ads': {
    key: 'google-ads',
    title: 'Google Ads',
    credential_mode: 'oauth',
    connection_modes: ['wiro', 'own'],
    wiro_connect_pending: true,
    credential_schema: [
      { key: 'clientid', type: 'text', label: 'OAuth Client ID', required: true, oauth_managed: true, only_in_modes: ['own'] },
      { key: 'clientsecret', type: 'password', label: 'OAuth Client Secret', required: true, encrypted: true, oauth_managed: true, only_in_modes: ['own'] },
      { key: 'developertoken', type: 'password', label: 'Developer Token', required: true, encrypted: true, oauth_managed: true, only_in_modes: ['own'] },
      { key: 'customerid', type: 'text', label: 'Customer ID', required: true, auto_filled_by_oauth: true },
    ],
    oauth_provider: {
      auth_method_value: 'wiro',
      oauth_flow: { callback_path: '/UserAgentOAuth/GAdsCallback' },
    },
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
    assert.match(text(result), /Nothing was changed\. Funds are added at https:\/\/wiro\.ai\/panel\/wallet\/deposit\/credit-card \(for a team project, select that team in the dashboard first\); once the user has added them and says yes, confirm again\./);
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

test('apply_agent_skills names only the fix for the agent\'s own plan when the payment fails', async () => {
  const refused = {
    result: false,
    errors: [{ code: 109, message: 'Payment processing failed for this skill change. Your skills, tier, and pricing snapshot have been reverted to the previous state. Please update your card or top up your wallet, then retry.' }],
  };
  const failed = 'The payment for this change did not go through, so the change was undone and nothing was charged.';
  // A short wallet is refused before any payment (code 103), so a wallet plan is not told to add funds.
  const wallet = `${failed} The balance is not the cause, so no funds need to be added. Ask for a new quote and confirm it once the user approves.`;
  const card = `${failed} Update the card in the Wiro dashboard, then ask for a new quote.`;

  const prepaid = fakeClient(skillRoutes({ '/UserAgent/SkillsApply': refused }));
  await withClient(prepaid, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'refused');
    assert.equal(result.structuredContent.error.code, 109);
    assert.equal(result.structuredContent.billing.note, wallet);
    assert.doesNotMatch(result.structuredContent.billing.note, /deposit|add funds/i);
    assert.ok(text(result).includes(wallet), text(result));
    assert.doesNotMatch(text(result), /update the card/i);
  });

  const stripe = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({ subscription: { status: 'active', provider: 'stripe', currentperiodend: NOW + 86400, daysremaining: 1 } }),
    '/UserAgent/SkillsApply': refused,
  }));
  await withClient(stripe, async client => {
    const quote = await quoteInstagram(client);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.structuredContent.billing.note, card);
    assert.doesNotMatch(text(result), /add funds/i);
  });

  // Without the plan, only the card fix is named: a wallet plan needs nothing added.
  const failure = describeSkillsApplyError(new ApiResultError(refused.errors[0].message, [109], refused));
  assert.equal(failure.guidance, `${failed} For a plan paid by card, update the card in the Wiro dashboard first. Then ask for a new quote.`);
  assert.doesNotMatch(failure.guidance, /deposit|add funds/i);
  assert.equal(failure.retrySameKey, false);
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
    assert.match(result.structuredContent.billing.note, /probably taken from, or credited to, your personal wallet, and a credit can be spent until this period ends;/);
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
    assert.match(note, /credited back to your personal wallet now for the 15 days left in this period\. It can be spent until this period ends\./);
    assert.match(note, /The plan is cancelled and ends about a day after .*, so this covers only the days left/);
    assert.doesNotMatch(note, /renews at|expire/);
  });
});

test('apply_agent_skills says once that a credit for skills turned off can be spent until the period ends', async () => {
  // Turning the reporting skill off lowers the price from $42 to $40.
  const removal = { agent_guid: AGENT, skills: { 'util-chat-markdown-reporting': false } };
  const applied = (overrides = {}) => ({
    result: true,
    errors: [],
    pricing: { previousPriceUsd: 42, newPriceUsd: 40, deltaUsd: -2, previousMonthlyCredits: 4200, newMonthlyCredits: 4000, deltaCredits: -200 },
    tier: 'starter',
    stripeProrationApplied: false,
    ...overrides,
  });
  const routes = (detailOverrides, skillsApply) => skillRoutes({
    '/UserAgent/Detail': (_body, calls) => detail({
      ...detailOverrides,
      ...(calls.some(call => call.path === '/UserAgent/SkillsApply') ? { skills: [], monthlypriceusd: '40.00' } : {}),
    }),
    '/UserAgent/PricingPreview': { result: true, errors: [], totalPriceUsd: 40, totalMonthlyCredits: 4000 },
    '/UserAgent/SkillsApply': skillsApply,
  });
  const spendBy = /It can be spent until this period ends\./g;

  const personal = fakeClient(routes({}, applied({ prepaidWalletDelta: -1 })));
  await withClient(personal, async client => {
    const quote = await client.callTool({ name: 'apply_agent_skills', arguments: removal });
    assert.equal(quote.structuredContent.status, 'quote', text(quote));
    assert.match(quote.structuredContent.billing.note, /^About \$1\.00 is credited back to your personal wallet now for the 15 days left in this period\. It can be spent until this period ends\.( |$)/);
    assert.equal(text(quote).match(spendBy)?.length, 1, text(quote));

    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.status, 'applied');
    assert.equal(result.structuredContent.billing.chargedNowUsd, -1);
    assert.equal(result.structuredContent.billing.note, '$1.00 was credited to your personal wallet. It can be spent until this period ends.');
    assert.equal(text(result).match(spendBy)?.length, 1, text(result));
  });

  // The agent's team wallet is credited for a team agent.
  const team = fakeClient(routes({ teamguid: 'team-1' }, applied({ prepaidWalletDelta: -1 })));
  await withClient(team, async client => {
    const quote = await client.callTool({ name: 'apply_agent_skills', arguments: removal });
    assert.match(quote.structuredContent.billing.note, /credited back to the team wallet now/);
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.equal(result.structuredContent.billing.note, '$1.00 was credited to the team wallet. It can be spent until this period ends.');
    assert.doesNotMatch(JSON.stringify(result), /team-1/);
  });

  // A credit is reported only when Wiro reports one, and Wiro's own note on the billing is passed on.
  const warning = 'The skill change is saved and the lower monthly price applies from the next renewal.';
  const withNote = fakeClient(routes({}, applied({ prepaidWalletDelta: null, warnings: [warning] })));
  await withClient(withNote, async client => {
    const quote = await client.callTool({ name: 'apply_agent_skills', arguments: removal });
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: quote.structuredContent.nextAction.arguments });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.billing.chargedNowUsd, null);
    assert.equal(result.structuredContent.billing.note, `Nothing was charged now. ${warning}`);
    assert.doesNotMatch(text(result), /was credited to/);
  });

  // With the current price unknown, the quote cannot tell a charge from a credit and says both once.
  const unpriced = fakeClient(skillRoutes({ '/UserAgent/Detail': detail({ monthlypriceusd: null }) }));
  await withClient(unpriced, async client => {
    const quote = await client.callTool({ name: 'apply_agent_skills', arguments: { agent_guid: AGENT, skills: { 'int-instagram-post': true } } });
    assert.equal(quote.structuredContent.status, 'quote', text(quote));
    assert.equal(quote.structuredContent.pricing.deltaMonthlyUsd, null);
    assert.equal(quote.structuredContent.billing.note, 'The difference for the rest of this period is taken from, or credited to, your personal wallet when the change is applied. A credit can be spent until this period ends. The plan then renews at $43.00 a month.');
    assert.equal(text(quote).match(/can be spent until this period ends/g)?.length, 1, text(quote));
  });

  await withClient(fakeClient({}), async client => {
    const { tools } = await client.listTools();
    const description = tools.find(tool => tool.name === 'apply_agent_skills').description;
    assert.match(description, /taken from the wallet at once, or credited to it when the price drops, and that credit can be spent until the period ends; on a card plan it is added to the next invoice\./);
  });
  assert.match(PLAYBOOKS.agents, /on a wallet plan, the difference for the rest of the period is charged at once, or credited to the wallet for use until the period ends\./);
  assert.match(PLAYBOOKS.billing, /\| Agent skill change \| The price difference for the rest of the period, charged, or credited for use until the period ends \| When applied \|/);
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

test('set_agent_credentials describe offers connect only once the chosen mode has every field saved', async () => {
  const empty = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
  });
  await withClient(empty, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'google-ads' } });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.ok(result.structuredContent.notes.includes('Mode own needs clientid, clientsecret and developertoken saved first.'));
    assert.match(text(result), /- Mode own needs clientid, clientsecret and developertoken saved first\./);
    assert.doesNotMatch(text(result), /Everything mode own needs is saved/);
    assert.deepEqual(empty.paths(), ['/Credentials/Detail', '/UserAgent/Detail']);
  });

  const saved = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail({
      credentials: {
        'google-ads': { clientid: '123-abc.apps.googleusercontent.com', clientsecret: 'own-secret-value', developertoken: 'own-dev-token', _connected: false, _filled: true, optional: false, _schema: { title: 'Google Ads' } },
      },
    }),
  });
  await withClient(saved, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'google-ads' } });
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'connect_agent_oauth',
      arguments: { action: 'connect', agent_guid: AGENT, credential: 'google-ads', mode: 'own' },
      reason: 'Everything mode own needs is saved; connect Google Ads.',
    });
    assert.doesNotMatch(JSON.stringify(result), /own-secret-value|own-dev-token/);
  });

  // Wiro's own app needs nothing saved first.
  const hubspot = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
  });
  await withClient(hubspot, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'hubspot' } });
    assert.equal(result.structuredContent.nextAction.arguments.mode, 'wiro');
    assert.match(text(result), /- \*\*wiro\*\*: Sign in through Wiro's own HubSpot app/);
  });
});

test('set_agent_credentials offers connect after a write only once the mode has every field saved', async () => {
  const googleAds = fields => ({ ...fields, _connected: false, _filled: false, optional: false, _schema: { title: 'Google Ads' } });
  const write = { agent_guid: AGENT, fields: [{ credential: 'google-ads', field: 'clientid', value: '123-abc.apps.googleusercontent.com' }] };

  // Only the client ID is saved: connecting now would be refused, so no connect step is offered.
  const partial = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail({ credentials: { 'google-ads': googleAds({ clientid: '123-abc.apps.googleusercontent.com', clientsecret: '', developertoken: '' }) } }),
  });
  await withClient(partial, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.ok(result.structuredContent.notes.includes('Mode own needs clientsecret and developertoken saved first.'), text(result));
    assert.match(text(result), /- Mode own needs clientsecret and developertoken saved first\./);
    assert.doesNotMatch(text(result), /now that its fields are saved/);
  });

  // Every field of mode own is saved: connect with that mode.
  const complete = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail({ credentials: { 'google-ads': googleAds({ clientid: '123-abc.apps.googleusercontent.com', clientsecret: 'own-secret-value', developertoken: 'own-dev-token' }) } }),
  });
  await withClient(complete, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'connect_agent_oauth',
      arguments: { action: 'connect', agent_guid: AGENT, credential: 'google-ads', mode: 'own' },
      reason: 'Connect Google Ads now that its fields are saved.',
    });
    assert.doesNotMatch(JSON.stringify(result), /own-secret-value|own-dev-token/);
  });

  // The agent cannot be read back: nothing is claimed about the mode.
  const unread = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': { result: false, errors: [{ code: 0, message: 'User agent not found' }] },
  });
  await withClient(unread, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.ok(result.structuredContent.notes.includes('The agent could not be read afterwards; check it with get_my_agent.'));
    assert.doesNotMatch(text(result), /saved first/);
  });
});

test('set_agent_credentials offers only the modes that can be used', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const metaAds = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'meta-ads' } });
    assert.notEqual(metaAds.isError, true, text(metaAds));
    const howItConnects = text(metaAds).split('### How it connects')[1];
    assert.ok(howItConnects, 'the describe text has a How it connects section');
    assert.match(howItConnects, /^- \*\*api_key\*\*: /m);
    assert.match(howItConnects, /^- \*\*own\*\*: /m);
    assert.doesNotMatch(howItConnects, /- \*\*wiro\*\*/);
    assert.ok(metaAds.structuredContent.notes.includes('To choose how it connects, set field authmethod to one of: api_key, own.'));

    const googleAds = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'google-ads' } });
    assert.ok(googleAds.structuredContent.notes.includes('To choose how it connects, set field authmethod to one of: own.'));
    assert.doesNotMatch(text(googleAds), /- \*\*wiro\*\*/);

    const wiro = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'google-ads', field: 'authmethod', value: 'wiro' }] },
    });
    assert.equal(wiro.isError, true);
    assert.match(text(wiro), /Google Ads: authmethod must be one of own\./);

    const unknownMode = await client.callTool({ name: 'connect_agent_oauth', arguments: { agent_guid: AGENT, credential: 'google-ads', mode: 'api_key' } });
    assert.equal(unknownMode.isError, true);
    assert.match(text(unknownMode), /Google Ads cannot connect with mode api_key\. Modes: own\./);
    assert.equal(fake.paths().includes('/UserAgent/CredentialUpsert'), false);
    assert.equal(fake.paths().includes('/UserAgentOAuth/OAuthConnect'), false);
  });
});

test('set_agent_credentials describe lists the keys of a list\'s entries and of a list inside an entry', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'firebase' } });
    assert.notEqual(result.isError, true, text(result));
    const fields = text(result).split('### Fields\n\n')[1];
    assert.ok(fields.startsWith([
      '- `accounts` Firebase Accounts (list of objects, required). Each entry:',
      '  - `appname` App Name (text, required): A friendly label that identifies this Firebase project.',
      '  - `serviceaccountjson` Service Account JSON (the file content, as text or base64, required)',
      '  - `apps` Apps (list of objects, optional): The mobile apps registered under this Firebase project. Each entry:',
      '    - `platform` Platform (one of: ios, android, required)',
      '    - `id` App ID (text, required): The Android package name or the numeric Apple ID of the app.',
    ].join('\n')), fields);
    const accounts = result.structuredContent.credential.fields.find(field => field.field === 'accounts');
    assert.deepEqual(accounts.itemFields.map(item => item.field), ['appname', 'serviceaccountjson', 'apps']);
    const apps = accounts.itemFields.find(item => item.field === 'apps');
    assert.equal(apps.required, false);
    assert.equal(apps.help, 'The mobile apps registered under this Firebase project.');
    assert.deepEqual(apps.itemFields, [
      { field: 'platform', label: 'Platform', type: 'select', required: true, options: ['ios', 'android'] },
      { field: 'id', label: 'App ID', type: 'text', required: true, help: 'The Android package name or the numeric Apple ID of the app.' },
    ]);
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
    assert.match(message, /Allowed Telegram DM User IDs #1 has an invalid format/);
    assert.match(message, /Ad Account ID is filled when the account is connected/);
    assert.match(message, /"accesstoken" is filled by the connection itself/);
    // wiro_connect_pending leaves wiro out of the choices.
    assert.match(message, /Meta Ads: authmethod must be one of api_key, own\./);
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

test('set_agent_credentials encodes key files inside a list, as a whole list or one entry', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail(),
  });
  const json = '{"type":"service_account","project_id":"my-app","token_uri":"https://oauth2.googleapis.com/token"}';
  const encoded = Buffer.from('{"type":"service_account","project_id":"staging"}').toString('base64');
  await withClient(fake, async client => {
    const accounts = [
      { appname: 'My App', serviceaccountjson: json },
      { appname: 'Staging', serviceaccountjson: encoded },
    ];
    const list = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'firebase', field: 'accounts', value: accounts }] },
    });
    assert.notEqual(list.isError, true, text(list));
    const listUpsert = fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1);
    assert.deepEqual(listUpsert.body.fields[0].fieldvalue, [
      { appname: 'My App', serviceaccountjson: Buffer.from(json).toString('base64') },
      { appname: 'Staging', serviceaccountjson: encoded },
    ]);

    const entry = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'firebase', field: 'serviceaccountjson', parent_field: 'accounts', ordinal: 0, value: json }] },
    });
    assert.notEqual(entry.isError, true, text(entry));
    const entryUpsert = fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1);
    assert.equal(entryUpsert.body.fields[0].fieldvalue, Buffer.from(json).toString('base64'));
    assert.equal(entryUpsert.body.fields[0].parentfield, 'accounts');
    assert.equal(entryUpsert.body.fields[0].ordinal, 0);
    assert.doesNotMatch(JSON.stringify([list, entry]), /service_account/);
  });
});

test('set_agent_credentials refuses a link in a key file inside a list without saving it', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const list = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'firebase', field: 'accounts', value: [{ appname: 'My App', serviceaccountjson: 'https://drive.example.com/key.json' }] }] },
    });
    assert.equal(list.isError, true);
    assert.match(text(list), /Service Account JSON in Firebase Accounts #1 takes the file's content as text or base64, not a link/);

    const entry = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'firebase', field: 'serviceaccountjson', parent_field: 'accounts', ordinal: 0, value: ' HTTPS://drive.example.com/key.json' }] },
    });
    assert.equal(entry.isError, true);
    assert.match(text(entry), /not a link/);
    assert.equal(fake.calls.some(call => call.path === '/UserAgent/CredentialUpsert'), false);
  });
});

test('set_agent_credentials refuses a JSON key file that is not JSON, wherever it is', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail(),
  });
  // A local path, and an id that looks like base64 but is not a key file.
  const values = ['~/Downloads/firebase-adminsdk.json', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'];
  await withClient(fake, async client => {
    for (const value of values) {
      const calls = [
        { credential: 'firebase', field: 'accounts', value: [{ appname: 'My App', serviceaccountjson: value }] },
        { credential: 'firebase', field: 'serviceaccountjson', parent_field: 'accounts', ordinal: 0, value },
        { credential: 'google-play', field: 'serviceaccountjson', value },
      ];
      for (const field of calls) {
        const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields: [field] } });
        assert.equal(result.isError, true, `${value} in ${field.credential}.${field.field}`);
        assert.match(text(result), /takes the text of the JSON key file\. This value is not JSON\. The user can paste the file's text or upload the file on the agent's page in the Wiro dashboard\./);
        assert.equal(JSON.stringify(result).includes(value), false, 'the value is never repeated');
      }
    }
    const row = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'firebase', field: 'accounts', value: [{ appname: 'My App', serviceaccountjson: { type: 'service_account' } }] }] },
    });
    assert.equal(row.isError, true);
    assert.match(text(row), /Service Account JSON in Firebase Accounts #1 takes the file's content as text or base64\./);
    assert.equal(fake.calls.some(call => call.path === '/UserAgent/CredentialUpsert'), false);
  });
});

test('set_agent_credentials checks the rows of a list inside a list entry and names them the way Wiro does', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': body => ({ result: true, errors: [], applied: body.fields.length }),
    '/UserAgent/Detail': detail(),
  });
  const json = '{"type":"service_account","project_id":"my-app"}';
  const account = apps => ({ appname: 'My App', serviceaccountjson: json, apps });
  const writeAccounts = (client, accounts) => client.callTool({
    name: 'set_agent_credentials',
    arguments: { agent_guid: AGENT, fields: [{ credential: 'firebase', field: 'accounts', value: accounts }] },
  });
  await withClient(fake, async client => {
    const missingId = await writeAccounts(client, [account([{ platform: 'android', id: 'com.acme.app' }, { platform: 'ios' }])]);
    assert.equal(missingId.isError, true);
    assert.match(text(missingId), /Nothing was saved:\n\n- App ID in Apps #2 in Firebase Accounts #1 is required\./);

    const unknownKey = await writeAccounts(client, [account([{ platform: 'ios', id: '1234567890', bundleid: 'com.acme.app' }])]);
    assert.equal(unknownKey.isError, true);
    assert.match(text(unknownKey), /Apps #1 in Firebase Accounts #1 has unknown keys \(bundleid\)\. Allowed: platform, id\./);

    const badPlatform = await writeAccounts(client, [account([{ platform: 'windows', id: 'com.acme.app' }])]);
    assert.match(text(badPlatform), /Platform in Apps #1 in Firebase Accounts #1 must be one of: ios, android\./);

    const notAList = await writeAccounts(client, [account({ platform: 'android', id: 'com.acme.app' })]);
    assert.match(text(notAList), /Apps in Firebase Accounts #1 takes a list \(JSON array\)\./);

    // The entry's own keys are checked the same way.
    const noName = await writeAccounts(client, [{ serviceaccountjson: json, apps: [] }]);
    assert.match(text(noName), /App Name in Firebase Accounts #1 is required\./);
    assert.equal(fake.calls.some(call => call.path === '/UserAgent/CredentialUpsert'), false);

    const valid = await writeAccounts(client, [account([{ platform: 'android', id: 'com.acme.app' }, { platform: 'ios', id: '1234567890' }])]);
    assert.notEqual(valid.isError, true, text(valid));
    const upsert = fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1);
    assert.deepEqual(upsert.body.fields, [{
      credentialkey: 'firebase',
      fieldname: 'accounts',
      fieldvalue: [{
        appname: 'My App',
        serviceaccountjson: Buffer.from(json).toString('base64'),
        apps: [{ platform: 'android', id: 'com.acme.app' }, { platform: 'ios', id: '1234567890' }],
      }],
    }]);
    assert.doesNotMatch(JSON.stringify(valid), /service_account/);
  });
});

test('set_agent_credentials writes a list inside one entry with parent_field and ordinal', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': body => ({ result: true, errors: [], applied: body.fields.length }),
    '/UserAgent/Detail': detail(),
  });
  const write = (client, field) => client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields: [field] } });
  await withClient(fake, async client => {
    // Rows go out as a list of objects under the list's own key and the entry's position.
    const apps = await write(client, { credential: 'firebase', field: 'apps', parent_field: 'accounts', ordinal: 1, value: [{ platform: 'android', id: 'com.acme.app' }] });
    assert.notEqual(apps.isError, true, text(apps));
    assert.deepEqual(fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1).body.fields, [{
      credentialkey: 'firebase',
      fieldname: 'apps',
      fieldvalue: [{ platform: 'android', id: 'com.acme.app' }],
      parentfield: 'accounts',
      ordinal: 1,
    }]);

    // A text list keeps its text items.
    const users = await write(client, { credential: 'telegram', field: 'allowedusers', parent_field: 'groups', ordinal: 0, value: ['761381461', 761381462] });
    assert.notEqual(users.isError, true, text(users));
    assert.deepEqual(fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1).body.fields, [{
      credentialkey: 'telegram',
      fieldname: 'allowedusers',
      fieldvalue: ['761381461', '761381462'],
      parentfield: 'groups',
      ordinal: 0,
    }]);
    const upserts = fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').length;

    const badRow = await write(client, { credential: 'firebase', field: 'apps', parent_field: 'accounts', ordinal: 1, value: [{ platform: 'android' }] });
    assert.equal(badRow.isError, true);
    assert.match(text(badRow), /App ID in Apps #1 in Firebase Accounts #2 is required\./);

    const textRow = await write(client, { credential: 'firebase', field: 'apps', parent_field: 'accounts', ordinal: 0, value: ['com.acme.app'] });
    assert.match(text(textRow), /Apps takes a list of objects; Apps #1 in Firebase Accounts #1 is not one\./);

    const path = await write(client, { credential: 'firebase', field: 'apps', parent_field: 'accounts.0', ordinal: 0, value: [{ platform: 'ios', id: '1234567890' }] });
    assert.match(text(path), /Firebase Accounts: parent_field takes the list field's key alone \("accounts"\); pass the entry's position, from 0, as ordinal\./);
    assert.equal(fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').length, upserts);
  });
});

test('set_agent_credentials checks one entry\'s field with parent_field as strictly as a whole write', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': body => ({ result: true, errors: [], applied: body.fields.length }),
    '/UserAgent/Detail': detail(),
  });
  const write = (client, field) => client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields: [field] } });
  const upserts = () => fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert');
  await withClient(fake, async client => {
    // A required field of an entry cannot be cleared on its own either.
    for (const value of [null, '', []]) {
      const cleared = await write(client, { credential: 'telegram', field: 'allowedusers', parent_field: 'groups', ordinal: 0, value });
      assert.equal(cleared.isError, true, JSON.stringify(value));
      assert.match(text(cleared), /Allowed User IDs in Allowed Telegram Groups #1 is required\./);
    }
    const noChat = await write(client, { credential: 'telegram', field: 'chatid', parent_field: 'groups', ordinal: 0, value: null });
    assert.equal(noChat.isError, true);
    assert.match(text(noChat), /Group Chat ID in Allowed Telegram Groups #1 is required\./);

    // A value is checked as it is sent, the same way in both kinds of write.
    const spaced = '-1001234567890 ';
    const entry = await write(client, { credential: 'telegram', field: 'chatid', parent_field: 'groups', ordinal: 0, value: spaced });
    const whole = await write(client, { credential: 'telegram', field: 'groups', value: [{ chatid: spaced, allowedusers: ['761381461'] }] });
    for (const result of [entry, whole]) {
      assert.equal(result.isError, true);
      assert.match(text(result), /Group Chat ID in Allowed Telegram Groups #1 has an invalid format \(expected pattern \^-\\d\{5,\}\$\)\./);
    }
    assert.equal(upserts().length, 0);

    // An optional list inside an entry is cleared as an empty list.
    for (const value of [null, '', '  ']) {
      const apps = await write(client, { credential: 'firebase', field: 'apps', parent_field: 'accounts', ordinal: 0, value });
      assert.notEqual(apps.isError, true, text(apps));
      assert.deepEqual(upserts().at(-1).body.fields, [{ credentialkey: 'firebase', fieldname: 'apps', fieldvalue: [], parentfield: 'accounts', ordinal: 0 }]);
    }
  });
});

test('set_agent_credentials names list items and entries the way Wiro does', async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail });
  const write = (client, field) => client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields: [field] } });
  await withClient(fake, async client => {
    const top = await write(client, { credential: 'telegram', field: 'allowedusers', value: ['761381461', '12'] });
    assert.equal(top.isError, true);
    assert.match(text(top), /Allowed Telegram DM User IDs #2 has an invalid format \(expected pattern \^\\d\{5,\}\$\)\./);

    // A text list inside an entry names its items after the entry, in a whole write and with parent_field.
    const nested = 'Allowed User IDs in Allowed Telegram Groups #1, item #2 has an invalid format (expected pattern ^\\d{5,}$).';
    const whole = await write(client, { credential: 'telegram', field: 'groups', value: [{ chatid: '-1001234567890', allowedusers: ['761381461', '12'] }] });
    const entry = await write(client, { credential: 'telegram', field: 'allowedusers', parent_field: 'groups', ordinal: 0, value: ['761381461', '12'] });
    for (const result of [whole, entry]) {
      assert.equal(result.isError, true);
      assert.ok(text(result).includes(nested), text(result));
      assert.doesNotMatch(text(result), / item \d+ /);
    }
    const notText = await write(client, { credential: 'telegram', field: 'allowedusers', parent_field: 'groups', ordinal: 0, value: [{ id: '761381461' }] });
    assert.ok(text(notText).includes('Allowed User IDs takes a list of text values; Allowed User IDs in Allowed Telegram Groups #1, item #1 is not one.'), text(notText));

    const unknownField = await write(client, { credential: 'firebase', field: 'bundleid', parent_field: 'accounts', ordinal: 0, value: 'com.acme.app' });
    assert.match(text(unknownField), /Firebase Accounts entries have no field "bundleid"\. Entry fields: appname, serviceaccountjson, apps\./);
    const noOrdinal = await write(client, { credential: 'firebase', field: 'appname', parent_field: 'accounts', value: 'My App' });
    assert.match(text(noOrdinal), /Firebase Accounts: ordinal \(the entry's position, from 0\) is required with parent_field\./);
    assert.equal(fake.paths().includes('/UserAgent/CredentialUpsert'), false);
  });
});

test('set_agent_credentials accepts JSON text, base64 JSON, a data URL and a key that is not JSON', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
    '/UserAgent/Detail': detail(),
  });
  const json = '{"type":"service_account","project_id":"my-app"}';
  const encoded = Buffer.from(json).toString('base64');
  const p8 = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----';
  await withClient(fake, async client => {
    for (const value of [json, encoded, `data:application/json;base64,${encoded}`]) {
      const result = await client.callTool({
        name: 'set_agent_credentials',
        arguments: { agent_guid: AGENT, fields: [{ credential: 'google-play', field: 'serviceaccountjson', value }] },
      });
      assert.notEqual(result.isError, true, text(result));
      assert.equal(fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1).body.fields[0].fieldvalue, encoded);
    }
    const key = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'apple-appstore', field: 'privatekey', value: p8 }] },
    });
    assert.notEqual(key.isError, true, text(key));
    assert.equal(fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1).body.fields[0].fieldvalue, Buffer.from(p8).toString('base64'));
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

test('connect_agent_oauth explains what to save before a provider can connect', async () => {
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
    assert.equal(wiro.structuredContent.message, 'Use another mode for Meta Ads.');
    assert.doesNotMatch(text(wiro), /not available|- \*\*wiro\*\*/);
    assert.match(text(wiro), /- \*\*own\*\*: /);
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

test('connect_agent_oauth and disconnect_agent_oauth say whose project can change a connection', async () => {
  const refusal = { result: false, errors: [{ code: 0, message: 'User agent not found or unauthorized' }] };
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
    '/UserAgentOAuth/OAuthStatus': { result: true, connected: true, accounts: [], connectedat: '2026-10-01T00:00:00Z', tokenexpiresat: '' },
    '/UserAgentOAuth/OAuthConnect': refusal,
    '/UserAgentOAuth/OAuthDisconnect': refusal,
  });
  await withClient(fake, async client => {
    // The hint says to connect this server with the deployer's project, and starts after Wiro's own sentence.
    const connect = await client.callTool({ name: 'connect_agent_oauth', arguments: { agent_guid: AGENT, credential: 'hubspot', confirm: true } });
    assert.equal(connect.isError, true);
    assert.ok(text(connect).includes('User agent not found or unauthorized\n\nIntegrations can only be connected with a project created by the person who deployed the agent: connect this server with such a project, by its API key or a browser sign-in.'), text(connect));

    const disconnect = await client.callTool({ name: 'disconnect_agent_oauth', arguments: { agent_guid: AGENT, credential: 'hubspot', confirm: true } });
    assert.equal(disconnect.isError, true);
    assert.ok(text(disconnect).includes('User agent not found or unauthorized\n\nIntegrations can only be changed with a project created by the person who deployed the agent: connect this server with such a project, by its API key or a browser sign-in.'), text(disconnect));
    for (const result of [connect, disconnect]) assert.doesNotMatch(text(result), /unauthorized Integrations/);

    const { tools } = await client.listTools();
    const description = tools.find(tool => tool.name === 'connect_agent_oauth').description;
    assert.match(description, /Only the person who deployed the agent can connect, so the connected project must be one that person created\./);
  });
  assert.match(PLAYBOOKS.agents, /Only the person who deployed the agent can connect, so the connected project must be one that person created\./);
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

test('manage_agent_custom_skill history returns the whole current text of a long entry', async () => {
  const policy = `${'Ask the owner before you reply to a refund request or post anything in public. '.repeat(30)}End of policy.`;
  const fake = fakeClient({
    '/UserAgent/Detail': detail({
      customskills: [{ key: 'cs-approval-policy', description: 'Approval rules', value: policy, enabled: true, requires_credentials: [], _source: 'preset-strategy', _editable: true }],
    }),
    '/UserAgent/CustomSkillHistory': {
      result: true,
      entries: [{ guid: 'v1', operation: 'update', changedat: 1767225600, after_value: policy, after_enabled: true, changed_fields: ['value'] }],
      preset_default: null,
    },
    '/UserAgent/CustomSkillAlternatives': { result: true, alternatives: [] },
  });
  assert.ok(policy.length > 2_000);
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'history', agent_guid: AGENT, key: 'cs-approval-policy' } });
    assert.notEqual(result.isError, true, text(result));
    const out = result.structuredContent;
    assert.equal(out.entry.value, policy);
    assert.equal(out.entry.valueTruncated, undefined);
    assert.ok(text(result).includes(`**Current text:**\n\n\`\`\`text\n${policy}\n\`\`\``));
    // Earlier versions stay shortened.
    assert.equal(out.history[0].valueTruncated, true);
    assert.ok(out.history[0].value.length < policy.length);

    const { tools } = await client.listTools();
    const description = tools.find(tool => tool.name === 'manage_agent_custom_skill').description;
    assert.match(description, /history shows the current text in full/);
    assert.match(description, /Entries from the agent's template, cs-approval-policy and the scheduled tasks its skills brought cannot be deleted or renamed: set enabled false instead\./);
  });
});

test('agent configuration tools say which connection reaches an agent of another workspace', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': { result: false, errors: [{ code: 0, message: 'This agent belongs to a team. Switch to the team context to access it.' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'history', agent_guid: AGENT, key: 'cs-approval-policy' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Switch to the team context to access it\. Connect with a project in the workspace \(personal or team\) that owns this agent, by its API key or a browser sign-in\./);
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
