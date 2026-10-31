import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';
import { WiroApiError } from '../dist/client.js';
import { ApiResultError } from '../dist/utils/api.js';
import {
  agentStatusLabel,
  htmlToText,
  isPreChargeRefusal,
  nextStepForAgent,
  normalizeCustomSkillKey,
  outcomeUnknown,
  toAgentDetail,
} from '../dist/utils/user-agent.js';

const AGENT_TOOLS = [
  'list_agent_templates',
  'get_agent_template',
  'list_agent_skills',
  'deploy_agent',
  'list_my_agents',
  'get_my_agent',
  'control_agent',
  'update_agent',
  'manage_agent_billing',
  'get_agent_activity',
  'delete_agent',
];

// Values that must never leave the server, whichever tool returns the agent.
const SECRETS = [
  'owner-uuid-secret',
  'team-guid-secret',
  'secret-app-password',
  'SECRET-BOT-TOKEN',
  'gmail-owner@example.com',
  '761381461',
  'billing.stripe.com',
  'price_secret',
  'prod_secret',
  'member@example.com',
  'member-uuid',
  'avatar.png',
];

function assertNoSecrets(result) {
  const serialized = JSON.stringify(result);
  for (const secret of SECRETS) {
    assert.equal(serialized.includes(secret), false, `output leaked ${secret}`);
  }
}

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    called(path) {
      return calls.filter(call => call.path === path);
    },
    async post(path, body = {}) {
      calls.push({ path, body: structuredClone(body) });
      const handler = routes[path];
      if (handler === undefined) throw new Error(`Unexpected call to ${path}`);
      const value = typeof handler === 'function' ? await handler(body, calls) : handler;
      return structuredClone(value);
    },
  };
}

async function withClient(fakeWiroClient, callback) {
  const server = createMcpServer(fakeWiroClient);
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

function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

function textOf(result) {
  return result.content.map(item => item.text ?? '').join('\n');
}

const NOW = Math.floor(Date.now() / 1000);

function subscription(overrides = {}) {
  return {
    plan: 'agent',
    status: 'active',
    amount: 12,
    currency: 'usd',
    currentperiodend: NOW + 15 * 86_400,
    renewaldate: new Date((NOW + 15 * 86_400) * 1000).toISOString(),
    daysremaining: 15,
    pendingdowngrade: null,
    provider: 'prepaid',
    nextprovider: null,
    canconverttoprepaid: false,
    ...overrides,
  };
}

function agentRow(overrides = {}) {
  return {
    guid: 'ua-1',
    uuid: 'owner-uuid-secret',
    teamguid: null,
    title: 'My Bot',
    description: 'Posts every morning',
    cover: null,
    categories: '["social-media"]',
    tier: 'starter',
    tiermultiplier: 10,
    status: 4,
    pinned: true,
    timezone: null,
    teamsessionmode: 'private',
    monthlycredits: 1200,
    monthlypriceusd: 12,
    extracredits: 0,
    usedcredits: 200,
    remainingcredits: 1000,
    pendingextra: 0,
    creditperiod: '2026-10',
    creditsyncat: NOW - 86_400,
    stripepriceid: 'price_secret',
    stripeproductid: 'prod_secret',
    deletedat: null,
    deletedby: null,
    createdat: String(NOW - 10 * 86_400),
    updatedat: String(NOW - 86_400),
    queuedat: String(NOW - 600),
    startedat: String(NOW - 500),
    runningat: String(NOW - 400),
    setuprequired: true,
    subscription: subscription(),
    stripeportalurl: 'https://billing.stripe.com/p/session/secret-portal',
    stripeupdateurl: 'https://billing.stripe.com/p/session/secret-update',
    stripecancelurl: 'https://billing.stripe.com/p/session/secret-cancel',
    extracreditsexpiry: NOW + 100 * 86_400,
    agentguid: 'tpl-guid',
    agent: {
      guid: 'tpl-guid',
      title: 'Instagram Manager',
      slug: 'instagram-manager',
      description: '<p>Marketing copy</p>',
      cover: 'https://cdn.example/cover.webp',
      samples: ['https://cdn.example/sample.webp'],
      categories: ['social-media'],
      tiermultiplier: 10,
      tiers: { starter: { priceUsd: 12, credits: 1200 }, pro: { priceUsd: 120, credits: 12000 } },
      extracreditpacks: [
        { packkey: 'small', credits: 6000, priceusd: 60, enabled: true },
        { packkey: 'medium', credits: 12000, priceusd: 120, enabled: true },
      ],
    },
    skills: [
      { name: 'int-gmail-check', enabled: true, _edited: false, _user_created: false },
      { name: 'util-chat-markdown-reporting', enabled: true, _edited: false, _user_created: false },
    ],
    skillsmeta: { 'int-gmail-check': { title: 'Gmail Check' } },
    tokenRates: {
      default_model: 'openai/gpt-5.6-sol',
      fallback_rate: { input_per_1m: 0, output_per_1m: 0 },
      models: {
        'openai/gpt-5.6-sol': { selectable: true, label: 'GPT-5.6 Sol', input_per_1m: 625, output_per_1m: 3750 },
        'openai/gpt-5.6-luna': { selectable: true, label: 'GPT-5.6 Luna', input_per_1m: 25, output_per_1m: 150 },
        'openai/gpt-5.2': { selectable: false, label: 'GPT-5.2' },
      },
    },
    credentials: {
      gmail: {
        optional: false,
        extra: false,
        _connected: false,
        _filled: false,
        _required_missing: true,
        account: 'gmail-owner@example.com',
        apppassword: 'secret-app-password',
        _editable: { account: true, apppassword: true },
        _schema: {
          title: 'Gmail',
          credential_mode: 'imap_credentials',
          oauth_provider: null,
          fields: [
            { key: 'account', label: 'Gmail Account', type: 'email', required: true },
            { key: 'apppassword', label: 'App Password', type: 'password', required: true },
          ],
        },
      },
      telegram: {
        optional: true,
        extra: false,
        _connected: true,
        _filled: true,
        _required_missing: false,
        bottoken: '123456:SECRET-BOT-TOKEN',
        allowedusers: ['761381461'],
        _schema: { title: 'Telegram', oauth_provider: null, fields: [] },
      },
    },
    communicationChannels: [{
      id: 'telegram',
      plugin: 'telegram',
      credentialkey: 'telegram',
      title: 'Telegram',
      icon: 'https://cdn.example/telegram.svg',
      required_fields: ['bottoken', 'allowedusers'],
      capabilities: { direct: true },
      schema: { title: 'Telegram' },
      enabled: true,
      configured: true,
      missingfields: [],
    }],
    enabledChannels: ['telegram'],
    enabledCommands: null,
    agentModel: { chatModel: 'openai/gpt-5.6-sol', cronModel: null, voicePrepModel: null, voicePostcallModel: null },
    customskills: [{
      key: 'cs-content-strategy',
      description: 'Content strategy',
      value: 'Write posts. '.repeat(100),
      interval: null,
      enabled: true,
      requires_credentials: [],
      _source: 'preset-strategy',
      _editable: true,
      _edited: false,
    }],
    scheduledskills: [{
      key: 'cs-cron-daily-scan',
      description: 'Daily inbox scan',
      value: 'Scan the inbox.',
      interval: '0 9 * * *',
      enabled: true,
      requires_credentials: ['gmail'],
      _source: 'skill-bundle',
      _editable: true,
      _edited: false,
    }],
    ...overrides,
  };
}

function detailResponse(row) {
  return { result: true, errors: [], useragents: [row] };
}

function templateRow(overrides = {}) {
  return {
    guid: '0b3c2f1e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    slug: 'instagram-manager',
    title: 'Instagram Manager',
    headline: 'Plans and posts to Instagram.',
    description: '<p>Grows your <strong>Instagram</strong> with <a href="https://wiro.ai/agents">daily posts</a>.</p>',
    cover: 'https://cdn.example/cover.webp',
    samples: ['https://cdn.example/sample.webp'],
    categories: ['social-media'],
    status: 1,
    createdat: '1760000000',
    updatedat: '1760000000',
    tiermultiplier: 10,
    tiers: { starter: { priceUsd: 12, credits: 1200 }, pro: { priceUsd: 120, credits: 12000 } },
    skills: ['int-instagram-post', 'util-chat-markdown-reporting'],
    skillsmeta: {
      'int-instagram-post': {
        title: 'Instagram Post',
        description: 'Posts to Instagram',
        requires_credentials: true,
        credential_key: 'instagram',
        icon: 'https://cdn.example/icon.svg',
      },
    },
    tokenRates: {
      default_model: 'openai/gpt-5.6-sol',
      models: {
        'openai/gpt-5.6-sol': { selectable: true, label: 'GPT-5.6 Sol', tier: 'premium', input_per_1m: 625, output_per_1m: 3750, cached_input_per_1m: 62.5 },
        'openai/gpt-5.2': { selectable: false, label: 'GPT-5.2' },
      },
    },
    communicationChannels: [{
      id: 'telegram',
      plugin: 'telegram',
      credentialkey: 'telegram',
      title: 'Telegram',
      required_fields: ['bottoken', 'allowedusers'],
      schema: { fields: [] },
    }],
    extracreditpacks: [],
    credentials: {
      instagram: {
        optional: false,
        extra: false,
        authmethod: 'wiro',
        appid: 'preset-app-id-value',
        _editable: { appid: true, accesstoken: false },
        _schema: {
          title: 'Instagram',
          credential_mode: 'oauth',
          connection_modes: ['wiro', 'own'],
          oauth_provider: { auth_method_value: 'oauth', oauth_flow: { authorize_url: 'https://example.com/authorize' } },
          fields: [
            { key: 'appid', label: 'App ID', type: 'text', required: true, only_in_modes: ['own'] },
            { key: 'accesstoken', label: 'Access token', type: 'password', required: true, auto_filled_by_oauth: true },
          ],
        },
      },
      'var-website': {
        optional: true,
        extra: false,
        url: 'https://preset.example',
        _schema: { title: 'Website', fields: [{ key: 'url', label: 'Website URL', type: 'url', required: true }] },
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registration and helpers
// ---------------------------------------------------------------------------

test('agent tools are registered with output schemas, annotations and plain copy', async () => {
  await withClient(fakeClient({}), async client => {
    const { tools } = await client.listTools();
    for (const name of AGENT_TOOLS) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.ok(tool.outputSchema, `${name} has an output schema`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
      assert.equal(JSON.stringify(tool).includes('\u2014'), false, `${name} uses an em dash`);
    }
    const deploy = tools.find(tool => tool.name === 'deploy_agent');
    assert.equal(deploy.annotations.readOnlyHint, false);
    assert.ok(deploy.inputSchema.properties.confirm);
    const billing = tools.find(tool => tool.name === 'manage_agent_billing');
    assert.ok(billing.inputSchema.properties.request_id);
    assert.ok(billing.inputSchema.properties.confirm_charge_usd);
    assert.ok(deploy.inputSchema.properties.confirm_charge_usd);
    assert.equal('checkoutUrl' in billing.outputSchema.properties, false);
    assert.deepEqual(billing.outputSchema.properties.outcome.enum, ['quote', 'done', 'not_needed', 'refused']);
    for (const tool of tools.filter(candidate => AGENT_TOOLS.includes(candidate.name))) {
      assert.doesNotMatch(JSON.stringify(tool), /expiresAt|expiry|credits? expire/i, `${tool.name} mentions credit expiry`);
    }
  });
});

test('only known refusals count as nothing charged after a paid request', () => {
  const refused = message => new ApiResultError(message, [0], {});
  assert.equal(outcomeUnknown(refused('Insufficient wallet balance. Required: $12.00, Available: $1.00')), false);
  assert.equal(outcomeUnknown(refused('Already on pro tier')), false);
  assert.equal(outcomeUnknown(refused('Subscription already active for this useragent. Cancel or modify the existing subscription instead.')), false);
  assert.equal(outcomeUnknown(refused('This agent belongs to a team. Switch to the team context to access it.')), false);
  assert.equal(outcomeUnknown(new ApiResultError('Only a team admin can perform this action on a team-owned agent.', [97], {})), false);
  assert.equal(outcomeUnknown(new ApiResultError('A skill update is already in progress for this agent.', [104], {})), false);
  assert.equal(isPreChargeRefusal(refused('Extra credit pack not available for this agent.')), true);
  // Catch-all answers that can follow a charge leave the outcome open.
  assert.equal(outcomeUnknown(refused('Connection terminated unexpectedly')), true);
  assert.equal(outcomeUnknown(refused('Wallet was charged but the credit purchase is still pending. Retry with the same request id.')), true);
  assert.equal(outcomeUnknown(new WiroApiError(502, 'Bad gateway')), true);
  assert.equal(outcomeUnknown(new WiroApiError(401, 'Unauthorized')), false);
  assert.equal(outcomeUnknown(new Error('socket hang up')), true);
});

test('next steps carry every argument the next tool needs', () => {
  const agent = toAgentDetail(agentRow());
  assert.deepEqual(nextStepForAgent(agent, 45).arguments, { agent_guid: 'ua-1', credential: 'gmail' });
  const oauth = toAgentDetail(agentRow({
    credentials: {
      instagram: { optional: false, _connected: false, _filled: false, _required_missing: true, _schema: { title: 'Instagram', oauth_provider: { oauth_flow: {} } } },
    },
  }));
  assert.deepEqual(nextStepForAgent(oauth, 45), {
    tool: 'connect_agent_oauth',
    arguments: { action: 'connect', agent_guid: 'ua-1', credential: 'instagram' },
    reason: 'Provide the missing credentials (instagram). This starts with Instagram, which the user connects by signing in.',
  });
  // A running agent needs the user's own message, so no call is suggested.
  assert.equal(nextStepForAgent(toAgentDetail(agentRow({ credentials: {} })), 45), undefined);
});

test('a required OAuth credential that is saved but not connected still counts as missing', () => {
  const shop = { optional: false, _connected: false, _filled: true, _required_missing: false, _schema: { title: 'Shopify', oauth_provider: { oauth_flow: {} } } };
  const later = { optional: true, _connected: false, _filled: false, _required_missing: false, _schema: { title: 'Slack', oauth_provider: { oauth_flow: {} } } };
  const agent = toAgentDetail(agentRow({ status: 6, setuprequired: true, credentials: { shopify: shop, slack: later } }));
  assert.deepEqual(agent.missingCredentials, [{ key: 'shopify', title: 'Shopify', oauth: true }]);
  assert.equal(nextStepForAgent(agent, 45).tool, 'connect_agent_oauth');
  assert.deepEqual(nextStepForAgent(agent, 45).arguments, { action: 'connect', agent_guid: 'ua-1', credential: 'shopify' });
  const connected = toAgentDetail(agentRow({ credentials: { shopify: { ...shop, _connected: true } } }));
  assert.deepEqual(connected.missingCredentials, []);
});

test('status labels, html cleanup and custom skill keys follow the server rules', () => {
  assert.equal(agentStatusLabel(4), 'running');
  assert.equal(agentStatusLabel(6), 'setup_required');
  assert.equal(agentStatusLabel(9), 'unknown');
  assert.equal(agentStatusLabel(null), 'unknown');
  assert.equal(
    htmlToText('<ol><li>Open <a href="https://t.me/BotFather">@BotFather</a></li><li>Send &lt;code&gt;</li></ol>'),
    '- Open @BotFather (https://t.me/BotFather)\n- Send <code>',
  );
  assert.equal(normalizeCustomSkillKey('weekly-report'), 'cs-weekly-report');
  assert.equal(normalizeCustomSkillKey('weekly-report', '0 9 * * 1'), 'cs-cron-weekly-report');
  assert.equal(normalizeCustomSkillKey('cron-daily'), 'cs-cron-daily');
  assert.equal(normalizeCustomSkillKey('Weekly Report'), null);
});

test('the detail sanitizer keeps states and drops every value and id', () => {
  const agent = toAgentDetail(agentRow());
  assertNoSecrets(agent);
  assert.equal(agent.statusLabel, 'running');
  assert.equal(agent.workspace, 'personal');
  assert.deepEqual(agent.missingCredentials, [{ key: 'gmail', title: 'Gmail', oauth: false }]);
  assert.deepEqual(agent.credentials.map(item => item.key), ['gmail']);
  assert.equal(agent.channels[0].enabled, true);
  assert.equal(agent.customInstructions[0].instructionsTruncated, true);
  assert.ok(agent.customInstructions[0].instructions.length <= 303);
  assert.equal(agent.template.slug, 'instagram-manager');
  assert.deepEqual(agent.selectableModels.map(model => model.slug), ['openai/gpt-5.6-sol', 'openai/gpt-5.6-luna']);
  assert.equal(agent.dashboardUrl, 'https://wiro.ai/panel/agents/ua-1');
  assert.equal(toAgentDetail(agentRow({ teamguid: 'team-guid-secret' })).workspace, 'team');
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test('list_agent_templates maps the sort, trims rows and chains to get_agent_template', async () => {
  const fake = fakeClient({
    '/Agent/List': { result: true, errors: [], total: 3, agents: [templateRow(), templateRow({ guid: 'g2', slug: 'no-price', title: 'No Price', tiers: null, headline: '' })] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'list_agent_templates', { sort: 'popular', limit: 2 });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls[0].body, { sort: 'totalrun', order: 'DESC', start: 0, limit: 2 });
    const [first, second] = result.structuredContent.templates;
    assert.deepEqual(first.pricing, { starter: { priceUsd: 12, monthlyCredits: 1200 }, pro: { priceUsd: 120, monthlyCredits: 12000 } });
    assert.equal(first.summary, 'Plans and posts to Instagram.');
    assert.equal(second.pricing, null);
    assert.equal(second.summary, 'Grows your Instagram with daily posts (https://wiro.ai/agents).');
    assert.equal(result.structuredContent.nextStart, 2);
    assert.equal(result.structuredContent.nextAction.tool, 'get_agent_template');
    assert.equal(JSON.stringify(result.structuredContent).includes('samples'), false);
    assert.match(textOf(result), /pricing unavailable/);
  });
});

test('get_agent_template returns what to ask for without preset values', async () => {
  const fake = fakeClient({ '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] } });
  await withClient(fake, async client => {
    const result = await call(client, 'get_agent_template', { template: 'instagram-manager' });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls[0].body, { slug: 'instagram-manager' });
    const template = result.structuredContent.template;
    assert.deepEqual(template.requiredCredentials.map(item => item.key), ['instagram']);
    assert.equal(template.requiredCredentials[0].oauth, true);
    assert.deepEqual(template.requiredCredentials[0].fields.map(field => field.key), ['appid']);
    assert.deepEqual(template.optionalCredentials.map(item => item.key), ['var-website']);
    assert.equal(template.skills[0].credentialKey, 'instagram');
    assert.deepEqual(template.models.selectable.map(model => model.slug), ['openai/gpt-5.6-sol']);
    assert.equal(template.models.selectable[0].inputCreditsPer1M, 625);
    assert.deepEqual(template.channels, [{ id: 'telegram', title: 'Telegram', credentialKey: 'telegram', requiredFields: ['bottoken', 'allowedusers'] }]);
    const serialized = JSON.stringify(result);
    for (const leaked of ['preset-app-id-value', 'https://preset.example', 'authorize_url', 'icon.svg']) {
      assert.equal(serialized.includes(leaked), false, `leaked ${leaked}`);
    }
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'deploy_agent',
      arguments: { template: 'instagram-manager', tier: 'starter' },
      reason: 'Get the exact deployment quote. Nothing is charged until the user approves and the call is repeated with confirm: true.',
    });
  });
});

test('get_agent_template looks a guid up by guid and asks for tasks when told to', async () => {
  const fake = fakeClient({ '/Agent/Detail': { result: true, errors: [], agents: [templateRow({ scheduledskills: [{ key: 'cs-cron-x', value: 'Run', interval: '0 9 * * *', enabled: true }], customskills: [] })] } });
  await withClient(fake, async client => {
    const result = await call(client, 'get_agent_template', { template: '0b3c2f1e-1a2b-4c3d-8e4f-5a6b7c8d9e0f', include_tasks: true });
    assert.deepEqual(fake.calls[0].body, { guid: '0b3c2f1e-1a2b-4c3d-8e4f-5a6b7c8d9e0f', type: 'full' });
    assert.equal(result.structuredContent.template.scheduledTasks[0].interval, '0 9 * * *');
  });
});

test('get_agent_template reports an unknown template as an error', async () => {
  const fake = fakeClient({ '/Agent/Detail': { result: false, errors: [{ code: 0, message: 'Agent not found' }] } });
  await withClient(fake, async client => {
    const result = await call(client, 'get_agent_template', { template: 'missing' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Agent not found/);
  });
});

test('list_agent_skills hides deprecated skills and lists channels', async () => {
  const fake = fakeClient({
    '/Skills/List': {
      result: true,
      errors: [],
      total: 2,
      skills: [
        { name: 'int-gmail-check', title: 'Gmail Check', category: 'int', requires_credentials: true, credential_key: 'gmail', depends_on: ['util-chat-markdown-reporting'], conflicts_with: [], capabilities: [], deprecated: false, icon: 'x.svg', pricing: { billing_model: 'tokens', monthly_price_weight_usd: 1, monthly_credits_weight: 100 } },
        { name: 'int-old', title: 'Old', category: 'int', deprecated: true, replacement: 'int-new', pricing: {} },
      ],
      channels: [{ id: 'telegram', title: 'Telegram', credential_key: 'telegram', required_fields: ['bottoken', 'allowedusers'], credential: { credential_schema: [{ help: '<p>long</p>' }] } }],
    },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'list_agent_skills', { category: 'int' });
    assert.deepEqual(fake.calls[0].body, { category: 'int' });
    assert.deepEqual(result.structuredContent.skills.map(skill => skill.name), ['int-gmail-check']);
    assert.equal(result.structuredContent.skills[0].monthlyPriceUsd, 1);
    assert.deepEqual(result.structuredContent.channels[0].requiredFields, ['bottoken', 'allowedusers']);
    assert.equal(JSON.stringify(result.structuredContent).includes('credential_schema'), false);
    assert.deepEqual(result.structuredContent.nextAction.arguments, { name: 'int-gmail-check' });
  });
});

test('list_agent_skills with a name returns the setup fields of every credential the skill needs', async () => {
  const credentials = {
    'google-ads': {
      key: 'google-ads',
      title: 'Google Ads',
      credential_mode: 'oauth',
      connection_modes: ['wiro', 'own'],
      wiro_connect_pending: true,
      oauth_provider: { oauth_flow: { authorize_url: 'https://accounts.example/authorize', token_exchange: {} } },
      credential_schema: [
        { key: 'clientid', label: 'OAuth Client ID', type: 'text', required: true, only_in_modes: ['own'], help: '<ol><li>Open <a href="https://console.cloud.google.com/">Google Cloud Console</a></li></ol>' },
        { key: 'accesstoken', label: 'Access token', type: 'password', required: false, auto_filled_by_oauth: true },
      ],
      used_by_skills: ['int-googleads-manage'],
    },
    'google-merchant-center': {
      key: 'google-merchant-center',
      title: 'Merchant Center',
      credential_mode: 'oauth',
      connection_modes: ['own'],
      oauth_provider: {},
      credential_schema: [],
    },
  };
  const fake = fakeClient({
    '/Skills/Detail': {
      result: true,
      errors: [],
      skill: { name: 'int-googleads-manage', title: 'Google Ads', requires_credentials: true, credential_key: 'google-ads', additional_credential_keys: ['google-merchant-center', 'sys-openai'], depends_on: [], conflicts_with: [], pricing: { monthly_price_weight_usd: 3, monthly_credits_weight: 300 } },
    },
    '/Credentials/Detail': body => (credentials[body.key]
      ? { result: true, errors: [], credential: credentials[body.key] }
      : { result: false, errors: [{ code: 404, message: 'Credential not found' }] }),
  });
  await withClient(fake, async client => {
    const result = await call(client, 'list_agent_skills', { name: 'int-googleads-manage' });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.called('/Credentials/Detail').map(item => item.body.key), ['google-ads', 'google-merchant-center']);
    const [primary, additional] = result.structuredContent.setup.credentials;
    assert.equal(primary.role, 'primary');
    assert.equal(primary.oauth, true);
    assert.equal(primary.wiroConnectAvailable, false);
    assert.equal(primary.fields[0].help, '- Open Google Cloud Console (https://console.cloud.google.com/)');
    assert.equal(primary.fields[1].writable, false);
    assert.equal(additional.role, 'additional');
    assert.equal(JSON.stringify(result).includes('authorize'), false);
  });
});

test('list_agent_skills accepts a channel key and refuses unknown names', async () => {
  const telegram = {
    key: 'telegram',
    title: 'Telegram',
    credential_mode: 'api_key',
    connection_modes: [],
    channel: { id: 'telegram', plugin: 'telegram', required_fields: ['bottoken', 'allowedusers'] },
    credential_schema: [{ key: 'bottoken', label: 'Telegram Bot Token', type: 'password', required: true, encrypted: true }],
  };
  const fake = fakeClient({
    '/Skills/Detail': { result: false, errors: [{ code: 404, message: 'Skill not found' }] },
    '/Credentials/Detail': body => (body.key === 'telegram'
      ? { result: true, errors: [], credential: telegram }
      : { result: false, errors: [{ code: 404, message: 'Credential not found' }] }),
  });
  await withClient(fake, async client => {
    const ok = await call(client, 'list_agent_skills', { name: 'telegram' });
    const credential = ok.structuredContent.setup.credentials[0];
    assert.equal(credential.role, 'channel');
    assert.deepEqual(credential.channel, { id: 'telegram', requiredFields: ['bottoken', 'allowedusers'] });
    assert.equal(credential.fields[0].secret, true);

    const missing = await call(client, 'list_agent_skills', { name: 'nope' });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /No skill or credential is named "nope"/);
  });
});

// ---------------------------------------------------------------------------
// deploy_agent
// ---------------------------------------------------------------------------

test('deploy_agent quotes a template without deploying or echoing credentials', async () => {
  const fake = fakeClient({ '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] } });
  await withClient(fake, async client => {
    const result = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'pro',
      credentials: { telegram: { bottoken: '123456:SECRET-BOT-TOKEN', allowedusers: ['761381461'] } },
    });
    assert.notEqual(result.isError, true);
    assert.equal(fake.called('/UserAgent/Deploy').length, 0);
    const content = result.structuredContent;
    assert.equal(content.stage, 'quote');
    assert.equal(content.quote.priceUsd, 120);
    assert.equal(content.quote.monthlyCredits, 12000);
    assert.equal(content.quote.title, 'Instagram Manager');
    assert.deepEqual(content.quote.credentialsNeeded, [{ key: 'instagram', title: 'Instagram' }]);
    assert.equal(content.nextAction.tool, 'deploy_agent');
    assert.equal(content.nextAction.arguments.confirm, true);
    assert.equal(content.nextAction.arguments.credentials, undefined);
    assert.match(content.nextAction.reason, /^Ask the user to approve this charge first\./);
    assert.match(textOf(result), /\$120\.00 now, then \$120\.00 every 30 days/);
    assertNoSecrets(result);
  });
});

test('deploy_agent checks custom skills and prices them with a draft preview', async () => {
  const fake = fakeClient({
    '/Skills/List': body => ({
      result: true,
      errors: [],
      skills: body.name_in
        .filter(name => name !== 'int-typo')
        .map(name => ({ name, title: 'Gmail Check', requires_credentials: true, credential_key: 'gmail', deprecated: name === 'int-retired', replacement: 'int-gmail-check', pricing: { monthly_price_weight_usd: 1, monthly_credits_weight: 100 } })),
    }),
    '/UserAgent/PricingPreview': { result: true, errors: [], totalPriceUsd: 4, totalMonthlyCredits: 400, enabledSkills: ['int-gmail-check', 'util-chat-markdown-reporting'], tiers: {} },
  });
  await withClient(fake, async client => {
    const unknown = await call(client, 'deploy_agent', { custom: true, title: 'Inbox', tier: 'starter', skills: ['int-typo'] });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /Unknown skill: int-typo/);

    const retired = await call(client, 'deploy_agent', { custom: true, title: 'Inbox', tier: 'starter', skills: ['int-retired'] });
    assert.equal(retired.isError, true);
    assert.match(textOf(retired), /int-retired \(use int-gmail-check\)/);
    assert.equal(fake.called('/UserAgent/PricingPreview').length, 0);

    const quote = await call(client, 'deploy_agent', { custom: true, title: 'Inbox', tier: 'starter', skills: ['int-gmail-check'] });
    assert.notEqual(quote.isError, true);
    assert.deepEqual(fake.called('/UserAgent/PricingPreview')[0].body, { draft: true, skills: ['int-gmail-check'], tier: 'starter' });
    assert.equal(quote.structuredContent.quote.kind, 'custom');
    assert.equal(quote.structuredContent.quote.priceUsd, 4);
    assert.deepEqual(quote.structuredContent.quote.skills, ['int-gmail-check', 'util-chat-markdown-reporting']);
    assert.equal(fake.called('/UserAgent/Deploy').length, 0);
  });
});

test('deploy_agent refuses unclear requests before calling Wiro', async () => {
  const fake = fakeClient({});
  await withClient(fake, async client => {
    const both = await call(client, 'deploy_agent', { template: 'x', custom: true, title: 'A', tier: 'starter' });
    assert.match(textOf(both), /either template or custom/);
    const none = await call(client, 'deploy_agent', { tier: 'starter' });
    assert.match(textOf(none), /Pass template/);
    const noTitle = await call(client, 'deploy_agent', { custom: true, tier: 'starter' });
    assert.match(textOf(noTitle), /title is required/);
    const overlay = await call(client, 'deploy_agent', { template: 'x', tier: 'starter', skills: ['int-gmail-check'] });
    assert.match(textOf(overlay), /apply_agent_skills/);
    const badKey = await call(client, 'deploy_agent', { template: 'x', tier: 'starter', custom_skills: [{ key: 'Bad Key' }] });
    assert.match(textOf(badKey), /not valid/);
    const typo = await call(client, 'deploy_agent', { template: 'x', tier: 'premium' });
    assert.equal(typo.isError, true);
    assert.equal(fake.calls.length, 0);
  });
});

test('deploy_agent with confirm pays from the wallet and returns a sanitized agent', async () => {
  const deployed = agentRow({
    status: 2,
    guid: 'ua-new',
    scheduledskills: [
      ...agentRow().scheduledskills,
      { key: 'cs-cron-weekly-report', description: 'Weekly report', value: 'Summarize the week', interval: '0 9 * * 1', enabled: true, _source: 'user-created' },
    ],
  });
  const fake = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [templateRow({ customskills: [{ key: 'cs-content-strategy', value: 'x', enabled: true }], scheduledskills: [] })] },
    '/UserAgent/Deploy': { result: true, errors: [], useragents: [{ ...deployed, subscription: undefined }] },
    '/UserAgent/Detail': detailResponse(deployed),
  });
  await withClient(fake, async client => {
    const result = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'starter',
      title: 'Insta',
      credentials: { telegram: { bottoken: '123456:SECRET-BOT-TOKEN', allowedusers: ['761381461'] } },
      custom_skills: [
        { key: 'content-strategy', value: 'Focus on reels' },
        { key: 'weekly-report', value: 'Summarize the week', interval: '0 9 * * 1' },
      ],
      confirm_charge_usd: 12,
      confirm: true,
    });
    assert.notEqual(result.isError, true);
    const [deployCall] = fake.called('/UserAgent/Deploy');
    assert.equal(deployCall.body.useprepaid, true);
    assert.equal(deployCall.body.agentguid, templateRow().guid);
    assert.equal(deployCall.body.tier, 'starter');
    assert.equal(deployCall.body.title, 'Insta');
    assert.equal(deployCall.body.credentials.telegram.bottoken, '123456:SECRET-BOT-TOKEN');
    assert.deepEqual(deployCall.body.customskills, [
      { key: 'cs-content-strategy', value: 'Focus on reels', _user_created: false },
      { key: 'cs-cron-weekly-report', value: 'Summarize the week', interval: '0 9 * * 1', _user_created: true },
    ]);
    for (const forbidden of ['enabledchannels', 'teamsessionmode', 'directchatmode', 'agenttermsaccepted']) {
      assert.equal(forbidden in deployCall.body, false);
    }
    const content = result.structuredContent;
    assert.equal(content.stage, 'deployed');
    assert.equal(content.chargedUsd, 12);
    assert.equal(content.agent.guid, 'ua-new');
    assert.equal(content.agent.statusLabel, 'queued');
    assert.equal(content.nextAction.tool, 'set_agent_credentials');
    assert.deepEqual(content.nextAction.arguments, { agent_guid: 'ua-new', credential: 'gmail' });
    assert.deepEqual(content.customSkills, [
      { key: 'cs-content-strategy', kind: 'skill', interval: null, enabled: true, onAgent: true },
      { key: 'cs-cron-weekly-report', kind: 'scheduled_task', interval: '0 9 * * 1', enabled: true, onAgent: true },
    ]);
    assert.match(textOf(result), /Custom skills saved: `cs-content-strategy`.*`cs-cron-weekly-report` \(scheduled task, runs on "0 9 \* \* 1"\)/);
    assertNoSecrets(result);
  });
});

test('deploy_agent charges only the price the user approved', async () => {
  let price = 12;
  const fake = fakeClient({
    '/Agent/Detail': () => ({ result: true, errors: [], agents: [templateRow({ tiers: { starter: { priceUsd: price, credits: price * 100 }, pro: { priceUsd: price * 10, credits: price * 1000 } } })] }),
  });
  await withClient(fake, async client => {
    const quote = await call(client, 'deploy_agent', { template: 'instagram-manager', tier: 'starter' });
    assert.equal(quote.structuredContent.nextAction.arguments.confirm_charge_usd, 12);
    assert.match(textOf(quote), /confirm_charge_usd 12 and confirm: true/);

    const missing = await call(client, 'deploy_agent', { template: 'instagram-manager', tier: 'starter', confirm: true });
    assert.equal(missing.structuredContent.stage, 'quote');
    assert.match(textOf(missing), /confirm_charge_usd is missing/);

    price = 15;
    const changed = await call(client, 'deploy_agent', quote.structuredContent.nextAction.arguments);
    assert.equal(changed.structuredContent.stage, 'quote');
    assert.equal(changed.structuredContent.priceChanged, true);
    assert.equal(changed.structuredContent.quote.priceUsd, 15);
    assert.equal(changed.structuredContent.nextAction.arguments.confirm_charge_usd, 15);
    assert.match(textOf(changed), /now \$15\.00, and the user approved \$12\.00/);
    assert.equal(fake.called('/UserAgent/Deploy').length, 0);
  });
});

test('deploy_agent checks custom skills against the template before quoting', async () => {
  const template = templateRow({
    customskills: [{ key: 'cs-content-strategy', value: 'x', enabled: true }],
    scheduledskills: [{ key: 'cs-cron-daily-digest', value: 'Digest', interval: '0 9 * * *', enabled: true }],
  });
  const fake = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [template] },
    '/UserAgent/Deploy': { result: true, errors: [], useragents: [agentRow({ guid: 'ua-new', status: 2 })] },
    '/UserAgent/Detail': detailResponse(agentRow({ guid: 'ua-new', status: 2 })),
  });
  await withClient(fake, async client => {
    const badSchedule = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'starter',
      custom_skills: [{ key: 'digest', value: 'Send it', interval: 'every day at 9' }],
    });
    assert.equal(badSchedule.isError, true);
    assert.match(textOf(badSchedule), /cs-cron-digest: interval must be a cron expression with five fields/);
    const scheduledSkill = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'starter',
      custom_skills: [{ key: 'cs-content-strategy', interval: '0 9 * * *' }],
    });
    assert.match(textOf(scheduledSkill), /cs-content-strategy: interval only applies to scheduled tasks/);
    assert.equal(fake.calls.length, 0);

    const noText = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'starter',
      custom_skills: [{ key: 'brand-voice' }],
    });
    assert.equal(noText.isError, true);
    assert.match(textOf(noText), /cs-brand-voice is a new custom skill, so it needs value/);
    assert.equal(fake.called('/UserAgent/Deploy').length, 0);

    // The agent always runs the template's own prompt for its scheduled tasks.
    const newText = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'starter',
      custom_skills: [{ key: 'daily-digest', value: 'Only list unread mail from customers.', enabled: true }],
    });
    assert.equal(newText.isError, true);
    assert.match(textOf(newText), /Nothing was deployed/);
    assert.match(textOf(newText), /The text of cs-cron-daily-digest comes from the agent's template and cannot be changed; only its schedule \(interval\) and on\/off state \(enabled\) can/);
    assert.equal(fake.called('/UserAgent/Deploy').length, 0);

    const quote = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'starter',
      custom_skills: [{ key: 'daily-digest', enabled: false }],
    });
    assert.notEqual(quote.isError, true, textOf(quote));
    // Without its schedule Wiro would save the task on its weekly default instead of the template's.
    assert.deepEqual(quote.structuredContent.quote.customSkills, [
      { key: 'cs-cron-daily-digest', kind: 'scheduled_task', interval: '0 9 * * *', enabled: false, replacesTemplateEntry: true },
    ]);
    assert.match(textOf(quote), /`cs-cron-daily-digest` \(scheduled task, runs on "0 9 \* \* \*", turned off, replaces the template's entry\)/);

    await call(client, 'deploy_agent', quote.structuredContent.nextAction.arguments);
    assert.deepEqual(fake.called('/UserAgent/Deploy')[0].body.customskills, [
      { key: 'cs-cron-daily-digest', interval: '0 9 * * *', enabled: false, _user_created: false },
    ]);
  });
});

test('deploy_agent never retries a duplicate and reports the existing agent', async () => {
  const existing = agentRow({ guid: 'ua-old', status: 6, subscription: null });
  const fake = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] },
    '/UserAgent/Deploy': { result: false, errors: [{ code: 99, message: 'Duplicate deploy: an identical agent was already deployed 3s ago.' }], existingUserAgentGuid: 'ua-old' },
    '/UserAgent/Detail': detailResponse(existing),
  });
  await withClient(fake, async client => {
    const result = await call(client, 'deploy_agent', { template: 'instagram-manager', tier: 'starter', confirm_charge_usd: 12, confirm: true });
    assert.notEqual(result.isError, true);
    assert.equal(fake.called('/UserAgent/Deploy').length, 1);
    assert.equal(result.structuredContent.stage, 'duplicate');
    assert.equal(result.structuredContent.existingAgentGuid, 'ua-old');
    assert.equal(result.structuredContent.agent.statusLabel, 'setup_required');
    assert.match(result.structuredContent.message, /manage_agent_billing with action subscribe/);
    assert.deepEqual(result.structuredContent.nextAction.arguments, { agent_guid: 'ua-old' });
    assertNoSecrets(result);
  });
});

test('deploy_agent tells a second agent with its own title to wait out the 10-second guard', async () => {
  const fake = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] },
    '/UserAgent/Deploy': { result: false, errors: [{ code: 99, message: 'Duplicate deploy: an identical agent ("Brand A") was already deployed 3s ago. Open the existing one in your panel, or wait a few seconds and retry.' }], existingUserAgentGuid: 'ua-a' },
    '/UserAgent/Detail': detailResponse(agentRow({ guid: 'ua-a', title: 'Brand A' })),
  });
  await withClient(fake, async client => {
    const result = await call(client, 'deploy_agent', {
      template: 'instagram-manager',
      tier: 'starter',
      title: 'Brand B',
      credentials: { telegram: { bottoken: '123456:SECRET-BOT-TOKEN', allowedusers: ['761381461'] } },
      confirm_charge_usd: 12,
      confirm: true,
    });
    assert.notEqual(result.isError, true);
    const content = result.structuredContent;
    assert.equal(content.stage, 'retry_later');
    assert.equal(content.agent, undefined);
    assert.equal(content.existingAgentGuid, undefined);
    assert.match(content.message, /nothing was created or charged for "Brand B"/);
    assert.equal(content.nextAction.tool, 'deploy_agent');
    assert.equal(content.nextAction.arguments.title, 'Brand B');
    assert.equal(content.nextAction.arguments.confirm_charge_usd, 12);
    assert.equal(content.nextAction.arguments.credentials, undefined);
    assert.match(content.nextAction.reason, /Wait about 10 seconds first.*Pass the same credentials again/);
    assertNoSecrets(result);
  });
});

test('deploy_agent explains a short wallet and a lost response', async () => {
  const shortWallet = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] },
    '/UserAgent/Deploy': { result: false, errors: [{ code: 0, message: 'Insufficient wallet balance. Required: $12.00, Available: $3.00' }] },
  });
  await withClient(shortWallet, async client => {
    const result = await call(client, 'deploy_agent', { template: 'instagram-manager', tier: 'starter', confirm_charge_usd: 12, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Required: \$12\.00, Available: \$3\.00/);
    assert.match(textOf(result), /Nothing was created or charged/);
  });

  const timeout = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] },
    '/UserAgent/Deploy': () => { throw new Error('socket hang up'); },
  });
  await withClient(timeout, async client => {
    const result = await call(client, 'deploy_agent', { template: 'instagram-manager', tier: 'starter', confirm_charge_usd: 12, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /may have been created and charged\. Check list_my_agents/);
    assert.equal(timeout.called('/UserAgent/Deploy').length, 1);
  });

  // A catch-all answer can come after the wallet was charged.
  const afterCharge = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] },
    '/UserAgent/Deploy': { result: false, errors: [{ code: 0, message: 'Connection terminated unexpectedly' }] },
  });
  await withClient(afterCharge, async client => {
    const result = await call(client, 'deploy_agent', { template: 'instagram-manager', tier: 'starter', confirm_charge_usd: 12, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Connection terminated unexpectedly/);
    assert.match(textOf(result), /may have been created and charged\. Check list_my_agents/);
  });
});

// ---------------------------------------------------------------------------
// list_my_agents and get_my_agent
// ---------------------------------------------------------------------------

test('list_my_agents pages without a total and strips account data', async () => {
  const row = agentRow({ enabledSkills: ['int-gmail-check'], skills: undefined, credentials: undefined });
  const fake = fakeClient({ '/UserAgent/MyAgents': { result: true, errors: [], useragents: [row, { ...row, guid: 'ua-2' }] } });
  await withClient(fake, async client => {
    const result = await call(client, 'list_my_agents', { limit: 2, sort: 'recently_updated' });
    assert.deepEqual(fake.calls[0].body, { sort: 'updatedat', order: 'DESC', start: 0, limit: 2 });
    const [first] = result.structuredContent.agents;
    assert.equal(first.statusLabel, 'running');
    assert.deepEqual(first.skills, ['int-gmail-check']);
    assert.equal(first.subscription.billing, 'wallet');
    assert.equal(result.structuredContent.nextStart, 2);
    assertNoSecrets(result);
  });
});

test('get_my_agent returns the sanitized state and the next step', async () => {
  const fake = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow()) });
  await withClient(fake, async client => {
    const result = await call(client, 'get_my_agent', { agent_guid: 'ua-1' });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls[0].body, { guid: 'ua-1' });
    const { agent, settled, nextAction } = result.structuredContent;
    assert.equal(settled, true);
    assert.equal(agent.status, 4);
    assert.equal(agent.scheduledTasks[0].interval, '0 9 * * *');
    assert.equal(agent.extraCreditPacks[0].pack, 'small');
    assert.equal(nextAction.tool, 'set_agent_credentials');
    assert.match(textOf(result), /Gmail \(`gmail`\): missing \(required\)/);
    assert.match(textOf(result), /\*\*Time zone:\*\* UTC, the default\. Scheduled tasks run in it\./);
    assertNoSecrets(result);
  });
});

test('get_my_agent waits for a starting agent and hands back a continuation when time runs out', async () => {
  let reads = 0;
  const settling = fakeClient({
    '/UserAgent/Detail': () => {
      reads += 1;
      return detailResponse(agentRow({ status: reads === 1 ? 2 : 4, credentials: {} }));
    },
  });
  await withClient(settling, async client => {
    const result = await call(client, 'get_my_agent', { agent_guid: 'ua-1', wait_seconds: 30 });
    assert.equal(result.structuredContent.settled, true);
    assert.equal(result.structuredContent.agent.statusLabel, 'running');
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.match(result.structuredContent.advice, /send_agent_message with agent set to its guid/);
  });

  const stuck = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ status: 3 })) });
  await withClient(stuck, async client => {
    const result = await call(client, 'get_my_agent', { agent_guid: 'ua-1', wait_seconds: 1 });
    assert.equal(result.structuredContent.settled, false);
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'get_my_agent',
      arguments: { agent_guid: 'ua-1', wait_seconds: 45 },
      reason: 'The agent has not settled yet. Keep waiting; do not repeat the action that started it.',
    });
  });
});

test('get_my_agent passes a not-found answer through as an error', async () => {
  const fake = fakeClient({ '/UserAgent/Detail': { result: false, errors: [{ code: 0, message: 'User agent not found' }], useragents: [] } });
  await withClient(fake, async client => {
    const result = await call(client, 'get_my_agent', { agent_guid: 'missing' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /User agent not found/);
  });
});

// ---------------------------------------------------------------------------
// control_agent
// ---------------------------------------------------------------------------

test('control_agent starts a stopped agent and waits for it', async () => {
  let started = false;
  const fake = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ status: started ? 4 : 0, credentials: {} })),
    '/UserAgent/Start': () => {
      started = true;
      return { result: true, errors: [], useragents: [] };
    },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'start', wait_seconds: 20 });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.called('/UserAgent/Start')[0].body, { guid: 'ua-1' });
    const content = result.structuredContent;
    assert.equal(content.outcome, 'requested');
    assert.equal(content.previousStatusLabel, 'stopped');
    assert.equal(content.statusLabel, 'running');
    assert.equal(content.settled, true);
    assert.equal(content.nextAction, undefined);
    assert.match(content.message, /The agent is running\. send_agent_message/);
  });
});

test('control_agent turns start refusals into the billing step to take', async () => {
  const expired = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 0, subscription: subscription({ status: 'expired' }) })),
    '/UserAgent/Start': { result: false, errors: [{ code: 0, message: 'Subscription required: please subscribe to this agent before starting it.' }] },
  });
  await withClient(expired, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'start' });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.outcome, 'refused');
    assert.deepEqual(result.structuredContent.nextAction.arguments, { agent_guid: 'ua-1', action: 'renew' });
  });

  const noCredits = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 0, tier: 'pro' })),
    '/UserAgent/Start': { result: false, errors: [{ code: 0, message: 'No credits available. Please renew your subscription or purchase extra credits.' }] },
  });
  await withClient(noCredits, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'start' });
    assert.equal(result.structuredContent.outcome, 'refused');
    assert.deepEqual(result.structuredContent.nextAction.arguments, { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small' });
  });

  const unpaid = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ status: 6, subscription: null })) });
  await withClient(unpaid, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'start' });
    assert.equal(unpaid.called('/UserAgent/Start').length, 0);
    assert.equal(result.structuredContent.outcome, 'refused');
    assert.deepEqual(result.structuredContent.nextAction.arguments, { agent_guid: 'ua-1', action: 'subscribe' });
  });

  const setup = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ status: 6 })) });
  await withClient(setup, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'start' });
    assert.equal(result.structuredContent.outcome, 'refused');
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'set_agent_credentials',
      arguments: { agent_guid: 'ua-1', credential: 'gmail' },
      reason: 'Provide the missing credentials (gmail). This lists the Gmail fields to ask the user for.',
    });
  });
});

test('control_agent restarts through Update without returning its response', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 4 })),
    '/UserAgent/Update': { result: true, errors: [], useragents: [agentRow()] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'restart' });
    assert.deepEqual(fake.called('/UserAgent/Update')[0].body, { guid: 'ua-1' });
    assert.equal(result.structuredContent.outcome, 'requested');
    assertNoSecrets(result);
  });
});

test('control_agent stop says the plan keeps running and skips needless calls', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 4 })),
    '/UserAgent/Stop': { result: true, errors: [], useragents: [] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'stop' });
    assert.equal(result.structuredContent.outcome, 'requested');
    assert.match(result.structuredContent.message, /does not pause the plan/);
  });

  const stopped = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ status: 0 })) });
  await withClient(stopped, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'stop' });
    assert.equal(result.structuredContent.outcome, 'not_needed');
    assert.equal(stopped.called('/UserAgent/Stop').length, 0);
  });
});

// ---------------------------------------------------------------------------
// update_agent
// ---------------------------------------------------------------------------

test('update_agent sends only the given fields to the right endpoint', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 4 })),
    '/UserAgent/Update': { result: true, errors: [], useragents: [agentRow()] },
    '/UserAgent/UpdateSettings': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'update_agent', {
      agent_guid: 'ua-1',
      title: 'Renamed',
      timezone: 'Europe/Istanbul',
      chat_model: 'openai/gpt-5.6-luna',
      enabled_commands: ['agent_help', 'agent_help', 'new_session'],
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.called('/UserAgent/Update')[0].body, { guid: 'ua-1', title: 'Renamed' });
    assert.deepEqual(fake.called('/UserAgent/UpdateSettings')[0].body, {
      useragentguid: 'ua-1',
      timezone: 'Europe/Istanbul',
      enabledcommands: ['agent_help', 'new_session'],
      chatmodel: 'openai/gpt-5.6-luna',
    });
    assert.deepEqual(result.structuredContent.changed, ['title', 'timezone', 'enabled_commands', 'chat_model']);
    assert.equal(result.structuredContent.restarted, true);
    assert.equal(result.structuredContent.nextAction.tool, 'get_my_agent');
    assertNoSecrets(result);
  });
});

test('update_agent skips Update for settings, checks models and finishes setup', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 0 })),
    '/UserAgent/UpdateSettings': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    await call(client, 'update_agent', { agent_guid: 'ua-1', team_session_mode: 'collaborative' });
    assert.equal(fake.called('/UserAgent/Update').length, 0);
    assert.deepEqual(fake.called('/UserAgent/UpdateSettings')[0].body, { useragentguid: 'ua-1', teamsessionmode: 'collaborative' });

    const bad = await call(client, 'update_agent', { agent_guid: 'ua-1', cron_model: 'openai/gpt-5.2' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /not a selectable model/);

    const empty = await call(client, 'update_agent', { agent_guid: 'ua-1' });
    assert.equal(empty.isError, true);
    assert.match(textOf(empty), /Nothing to update/);
  });

  let status = 6;
  const setup = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ status, credentials: {} })),
    '/UserAgent/Update': () => {
      status = 0;
      return { result: true, errors: [], useragents: [] };
    },
  });
  await withClient(setup, async client => {
    const result = await call(client, 'update_agent', { agent_guid: 'ua-1' });
    assert.deepEqual(setup.called('/UserAgent/Update')[0].body, { guid: 'ua-1' });
    assert.match(result.structuredContent.message, /Setup is complete/);
    assert.equal(result.structuredContent.nextAction.tool, 'control_agent');
  });
});

// ---------------------------------------------------------------------------
// manage_agent_billing
// ---------------------------------------------------------------------------

test('manage_agent_billing quotes a subscription and pays it from the wallet on confirm', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 6, subscription: null, credentials: {} })),
    '/UserAgent/CreateSubscriptionCheckout': { result: true, errors: [], subscriptionId: 42, monthlypriceusd: 120, monthlycredits: 12000 },
  });
  await withClient(fake, async client => {
    const quote = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'subscribe', tier: 'pro' });
    assert.equal(fake.called('/UserAgent/CreateSubscriptionCheckout').length, 0);
    assert.equal(quote.structuredContent.outcome, 'quote');
    assert.deepEqual(quote.structuredContent.quote, {
      chargeNowUsd: 120,
      estimated: false,
      recurringUsd: 120,
      monthlyCredits: 12000,
      paidFrom: 'personal_wallet',
      tier: 'pro',
    });
    assert.deepEqual(quote.structuredContent.nextAction, {
      tool: 'manage_agent_billing',
      arguments: { agent_guid: 'ua-1', action: 'subscribe', tier: 'pro', confirm_charge_usd: 120, confirm: true },
      reason: 'Ask the user to approve this charge first.',
    });

    const done = await call(client, 'manage_agent_billing', quote.structuredContent.nextAction.arguments);
    assert.deepEqual(fake.called('/UserAgent/CreateSubscriptionCheckout')[0].body, { useragentguid: 'ua-1', useprepaid: true, tier: 'pro' });
    assert.equal(done.structuredContent.outcome, 'done');
    assert.equal(done.structuredContent.result.chargedUsd, 120);
    assert.equal(JSON.stringify(done).includes('subscriptionId'), false);
    assertNoSecrets(done);
  });
});

test('manage_agent_billing charges only the amount the user approved', async () => {
  let pro = 120;
  const fake = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({
      status: 6,
      subscription: null,
      credentials: {},
      agent: { ...agentRow().agent, tiers: { starter: { priceUsd: 12, credits: 1200 }, pro: { priceUsd: pro, credits: pro * 100 } } },
    })),
    '/UserAgent/CreateSubscriptionCheckout': { result: true, errors: [], monthlypriceusd: 150, monthlycredits: 15000 },
  });
  await withClient(fake, async client => {
    const missing = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'subscribe', tier: 'pro', confirm: true });
    assert.equal(missing.structuredContent.outcome, 'quote');
    assert.match(missing.structuredContent.message, /confirm_charge_usd is missing/);

    pro = 150;
    const changed = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'subscribe', tier: 'pro', confirm_charge_usd: 120, confirm: true });
    assert.equal(changed.structuredContent.outcome, 'quote');
    assert.equal(changed.structuredContent.priceChanged, true);
    assert.match(changed.structuredContent.message, /now \$150\.00, and the user approved \$120\.00/);
    assert.equal(changed.structuredContent.nextAction.arguments.confirm_charge_usd, 150);
    assert.equal(fake.called('/UserAgent/CreateSubscriptionCheckout').length, 0);

    const done = await call(client, 'manage_agent_billing', changed.structuredContent.nextAction.arguments);
    assert.equal(done.structuredContent.outcome, 'done');
    assert.equal(fake.called('/UserAgent/CreateSubscriptionCheckout').length, 1);
  });
});

test('manage_agent_billing buys credits with a request id that makes retries safe', async () => {
  let bought = false;
  const fake = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ tier: 'pro', extracredits: bought ? 6000 : 0 })),
    '/UserAgent/CreateExtraCreditCheckout': body => {
      bought = true;
      return { result: true, url: null, errors: [], provider: 'prepaid', requestid: body.requestid };
    },
    // The id's purchase completed in an earlier call, so its pack is older than the replay.
    '/UserAgent/TransactionList': {
      result: true,
      errors: [],
      summary: { extrapacks: [{ id: 3, credits: 6000, remainingcredits: 6000, status: 'active', purchasedat: NOW - 86_400, expiresat: NOW + 170 * 86_400 }] },
    },
  });
  await withClient(fake, async client => {
    const quote = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small' });
    const requestId = quote.structuredContent.requestId;
    assert.match(requestId, /^[A-Za-z0-9_-]{8,128}$/);
    assert.equal(quote.structuredContent.quote.chargeNowUsd, 60);
    assert.equal(quote.structuredContent.quote.creditsAdded, 6000);
    assert.equal(quote.structuredContent.nextAction.arguments.request_id, requestId);
    assert.equal(quote.structuredContent.nextAction.arguments.confirm_charge_usd, 60);
    assert.doesNotMatch(quote.structuredContent.message, /expir/i);
    assert.equal(fake.called('/UserAgent/CreateExtraCreditCheckout').length, 0);

    const done = await call(client, 'manage_agent_billing', quote.structuredContent.nextAction.arguments);
    assert.deepEqual(fake.called('/UserAgent/CreateExtraCreditCheckout')[0].body, { useragentguid: 'ua-1', pack: 'small', requestid: requestId });
    assert.equal(done.structuredContent.outcome, 'done');
    assert.equal(done.structuredContent.result.chargedUsd, 60);
    // A finished purchase id is not offered for reuse.
    assert.equal(done.structuredContent.requestId, undefined);
    assert.equal(JSON.stringify(done.structuredContent.nextAction ?? {}).includes(requestId), false);

    // Wiro answers a reused id with success again, but nothing new is bought.
    assert.equal(fake.called('/UserAgent/TransactionList').length, 0);
    const replay = await call(client, 'manage_agent_billing', quote.structuredContent.nextAction.arguments);
    assert.equal(replay.structuredContent.outcome, 'not_needed');
    assert.match(replay.structuredContent.message, /had already completed: the agent's extra credits did not grow and no new pack shows, so nothing new was bought or charged now/);
    assert.equal(replay.structuredContent.result, undefined);
    assert.equal(fake.called('/UserAgent/TransactionList').length, 1);
  });
});

test('manage_agent_billing does not call a purchase a replay when an expiring pack hid its credits', async () => {
  // A 4,000-credit remainder expires in the same settle that adds the new 6,000.
  let bought = false;
  const fake = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ tier: 'pro', extracredits: bought ? 6500 : 4500 })),
    '/UserAgent/CreateExtraCreditCheckout': body => {
      bought = true;
      return { result: true, url: null, errors: [], provider: 'prepaid', requestid: body.requestid };
    },
    '/UserAgent/TransactionList': {
      result: true,
      errors: [],
      summary: {
        extrapacks: [
          { id: 12, credits: 6000, remainingcredits: 6000, status: 'active', purchasedat: NOW, expiresat: NOW + 180 * 86_400 },
          { id: 4, credits: 6000, remainingcredits: 0, status: 'expired', purchasedat: NOW - 181 * 86_400, expiresat: NOW - 600 },
        ],
      },
    },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small', request_id: 'pack-key-456', confirm_charge_usd: 60, confirm: true });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'done');
    assert.equal(result.structuredContent.result.chargedUsd, 60);
    assert.equal(result.structuredContent.result.creditsAdded, 6000);
    assert.match(result.structuredContent.message, /^Bought the small pack/);
    assert.match(result.structuredContent.message, /grew by less than the pack, which happens when an older pack expires at the same moment/);
    assert.doesNotMatch(textOf(result), /nothing new was bought or charged/);
    assert.equal(fake.called('/UserAgent/CreateExtraCreditCheckout').length, 1);
  });

  // Without the packs the tool cannot tell, so it does not claim that nothing was charged.
  const unreadable = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ tier: 'pro', extracredits: 6000 })),
    '/UserAgent/CreateExtraCreditCheckout': body => ({ result: true, url: null, errors: [], provider: 'prepaid', requestid: body.requestid }),
    '/UserAgent/TransactionList': { result: false, errors: [{ code: 0, message: 'Lock timeout' }] },
  });
  await withClient(unreadable, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small', request_id: 'pack-key-789', confirm_charge_usd: 60, confirm: true });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'done');
    assert.deepEqual(result.structuredContent.result, { chargedUsd: null });
    assert.match(result.structuredContent.message, /it is not confirmed whether this bought a new pack or repeated a purchase that had already completed/);
    assert.match(result.structuredContent.message, /get_account before buying again/);
    assert.doesNotMatch(textOf(result), /nothing new was bought or charged/);
  });
});

test('manage_agent_billing tells how to retry a pending pack purchase', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ tier: 'pro' })),
    '/UserAgent/CreateExtraCreditCheckout': { result: false, url: null, errors: [{ code: 0, message: 'Wallet was charged but the credit purchase is still pending. Retry with the same request id.' }] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'medium', request_id: 'retry-key-123', confirm_charge_usd: 120, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /request_id "retry-key-123", confirm_charge_usd 120 and confirm: true/);
    assert.match(textOf(result), /This works only while the pack still costs \$120\.00; Wiro refuses the id at any other price, and then Wiro support has to finish the purchase/);
  });
});

test('manage_agent_billing explains that a pending purchase finishes only at its first price', async () => {
  let price = 60;
  let attempt = 0;
  const fake = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({
      tier: 'pro',
      agent: { ...agentRow().agent, extracreditpacks: [{ packkey: 'small', credits: 6000, priceusd: price, enabled: true }] },
    })),
    // Wiro binds the request id to the price of its first attempt.
    '/UserAgent/CreateExtraCreditCheckout': () => {
      attempt += 1;
      return attempt === 1
        ? { result: false, errors: [{ code: 0, message: 'Wallet was charged but the credit purchase is still pending. Retry with the same request id.' }] }
        : { result: false, errors: [{ code: 0, message: 'Purchase request id was already used for another pack' }] };
    },
  });
  await withClient(fake, async client => {
    const args = { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small', request_id: 'reqPENDING1', confirm_charge_usd: 60, confirm: true };
    const first = await call(client, 'manage_agent_billing', args);
    assert.equal(first.isError, true);

    price = 90;
    const retry = await call(client, 'manage_agent_billing', args);
    assert.equal(retry.structuredContent.outcome, 'quote');
    assert.equal(retry.structuredContent.priceChanged, true);
    const message = retry.structuredContent.message;
    assert.match(message, /it is now \$90\.00, and the user approved \$60\.00\. Nothing was charged by this call\./);
    assert.match(message, /If an earlier call with request_id "reqPENDING1" said the wallet was charged but the purchase is still pending, that purchase can only be finished at its original price/);
    assert.match(message, /Do not approve the new amount for it; ask Wiro support to finish it\./);
    // The same id stays in the nextAction, so Wiro refuses it instead of charging a second pack.
    assert.equal(retry.structuredContent.nextAction.arguments.request_id, 'reqPENDING1');
    assert.equal(attempt, 1);

    const approved = await call(client, 'manage_agent_billing', retry.structuredContent.nextAction.arguments);
    assert.equal(approved.isError, true);
    const text = textOf(approved);
    assert.match(text, /Purchase request id was already used for another pack/);
    assert.match(text, /Nothing was charged now\./);
    assert.match(text, /For a new purchase, get a new quote without request_id\./);
    assert.match(text, /can only be finished at its original price, so ask Wiro support to finish it/);
    assert.equal(attempt, 2);
  });
});

test('manage_agent_billing reports a failure after the request as a possible charge, not a refusal', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ tier: 'pro' })),
    '/UserAgent/CreateExtraCreditCheckout': { result: false, url: null, errors: [{ code: 0, message: 'Lock timeout' }] },
    '/UserAgent/TransactionList': {
      result: true,
      errors: [],
      total: 0,
      transactions: [],
      summary: { extrapacks: [{ id: 9, credits: 6000, remainingcredits: 6000, status: 'active', purchasedat: NOW - 30 * 86_400, expiresat: NOW + 150 * 86_400 }] },
    },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small', request_id: 'pack-key-123', confirm_charge_usd: 60, confirm: true });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /Lock timeout/);
    assert.match(text, /the wallet may have been charged/);
    assert.match(text, /No new pack shows on the agent yet/);
    assert.match(text, /request_id "pack-key-123"/);
    assert.match(text, /Do not get a new quote for this purchase/);
    assert.equal(fake.called('/UserAgent/CreateExtraCreditCheckout').length, 1);
  });

  let subscribed = false;
  const subscribe = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ status: 6, subscription: null })),
    '/UserAgent/CreateSubscriptionCheckout': () => {
      subscribed = true;
      return { result: false, errors: [{ code: 0, message: 'Cannot read properties of undefined' }] };
    },
  });
  await withClient(subscribe, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'subscribe', confirm_charge_usd: 12, confirm: true });
    assert.equal(subscribed, true);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /The agent shows no active plan yet/);
    assert.match(textOf(result), /Do not repeat the call until this is checked/);
  });

  // The charge landed but the tier write did not: the plan already carries the Pro price.
  let upgraded = false;
  const upgrade = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow(upgraded ? { monthlypriceusd: 120, subscription: subscription({ amount: 120 }) } : {})),
    '/UserAgent/UpgradeTier': () => {
      upgraded = true;
      throw new WiroApiError(502, 'Bad gateway');
    },
  });
  await withClient(upgrade, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'upgrade_to_pro', confirm_charge_usd: 108, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /the wallet may have been charged/);
    assert.match(textOf(result), /already shows the Pro price but not the Pro tier.*Do not upgrade again/);
    assert.equal(upgrade.called('/UserAgent/UpgradeTier').length, 1);
  });
});

test('manage_agent_billing reports an action that went through despite an error as done, without a retry', async () => {
  // The pack shows on the agent although its credits are not counted yet.
  const pack = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ tier: 'pro' })),
    '/UserAgent/CreateExtraCreditCheckout': { result: false, url: null, errors: [{ code: 0, message: 'Lock timeout' }] },
    '/UserAgent/TransactionList': {
      result: true,
      errors: [],
      summary: { extrapacks: [{ id: 9, credits: 6000, remainingcredits: 6000, status: 'active', purchasedat: NOW, expiresat: NOW + 180 * 86_400 }] },
    },
  });
  await withClient(pack, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small', request_id: 'pack-key-123', confirm_charge_usd: 60, confirm: true });
    assert.notEqual(result.isError, true, textOf(result));
    const out = result.structuredContent;
    assert.equal(out.outcome, 'done');
    assert.deepEqual(out.result, { chargedUsd: 60, creditsAdded: 6000 });
    assert.match(out.message, /^Wiro answered with an error \(Lock timeout\) after the request was sent, but reading the agent again shows that it went through\./);
    assert.match(out.message, /A new pack of that size shows on the agent, so the purchase went through and the wallet was charged\. Do not buy it again\./);
    assert.match(out.message, /repeating this purchase with the same request_id "pack-key-123" and confirm_charge_usd 60 finishes it without a second charge/);
    assert.doesNotMatch(textOf(result), /To retry|may have been charged/);
    assert.equal(out.nextAction.tool, 'get_my_agent');
    assert.equal(pack.called('/UserAgent/CreateExtraCreditCheckout').length, 1);
  });

  let credited = false;
  const rose = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ tier: 'pro', extracredits: credited ? 6000 : 0 })),
    '/UserAgent/CreateExtraCreditCheckout': () => {
      credited = true;
      return { result: false, errors: [{ code: 0, message: 'Connection is closed.' }] };
    },
  });
  await withClient(rose, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small', request_id: 'pack-key-321', confirm_charge_usd: 60, confirm: true });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'done');
    assert.match(result.structuredContent.message, /The agent's extra credits rose by 6,000, so the purchase went through\. Do not buy it again\./);
    assert.doesNotMatch(textOf(result), /To retry|request_id "pack-key-321"/);
    assert.equal(rose.called('/UserAgent/TransactionList').length, 0);
  });

  let subscribed = false;
  const subscribe = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ status: subscribed ? 2 : 6, subscription: subscribed ? subscription() : null })),
    '/UserAgent/CreateSubscriptionCheckout': () => {
      subscribed = true;
      return { result: false, errors: [{ code: 0, message: 'Cannot read properties of undefined' }] };
    },
  });
  await withClient(subscribe, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'subscribe', confirm_charge_usd: 12, confirm: true });
    assert.notEqual(result.isError, true, textOf(result));
    const out = result.structuredContent;
    assert.equal(out.outcome, 'done');
    assert.deepEqual(out.result, { chargedUsd: 12, tier: 'starter' });
    assert.match(out.message, /The agent now has an active plan, so the payment went through\. Do not subscribe again\./);
    assert.doesNotMatch(out.message, /Do not repeat the call until this is checked/);
    assert.equal(out.agent.statusLabel, 'queued');
    assert.deepEqual(out.nextAction, { tool: 'get_my_agent', arguments: { agent_guid: 'ua-1', wait_seconds: 45 }, reason: 'Wait until the agent is running.' });
    assertNoSecrets(result);
  });

  let upgraded = false;
  const upgrade = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow(upgraded ? { tier: 'pro', monthlypriceusd: 120, subscription: subscription({ amount: 120 }) } : {})),
    '/UserAgent/UpgradeTier': () => {
      upgraded = true;
      throw new WiroApiError(502, 'Bad gateway');
    },
  });
  await withClient(upgrade, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'upgrade_to_pro', confirm_charge_usd: 108, confirm: true });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'done');
    assert.deepEqual(result.structuredContent.result, { chargedUsd: null, tier: 'pro' });
    assert.match(result.structuredContent.message, /The agent is on Pro now, so the upgrade went through\. Do not upgrade again\. The prorated charge is not shown, and it is at most \$108\.00\./);
    assert.equal(upgrade.called('/UserAgent/UpgradeTier').length, 1);
  });
});

test('manage_agent_billing refuses packs below Pro and estimates a wallet upgrade', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow()),
    '/UserAgent/UpgradeTier': { result: true, errors: [], tier: 'pro', previousTier: 'starter', newPriceUsd: 120, newMonthlyCredits: 12000, proratedCharge: 54 },
  });
  await withClient(fake, async client => {
    const refused = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small' });
    assert.equal(refused.structuredContent.outcome, 'refused');
    assert.deepEqual(refused.structuredContent.nextAction.arguments, { agent_guid: 'ua-1', action: 'upgrade_to_pro' });

    const upgrade = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'upgrade_to_pro' });
    const { quote } = upgrade.structuredContent;
    assert.equal(quote.estimated, true);
    assert.equal(quote.maxChargeUsd, 108);
    assert.equal(quote.chargeNowUsd, 54);
    assert.equal(quote.recurringUsd, 120);
    // Wiro prorates over the real period length, so the user approves the maximum.
    assert.equal(upgrade.structuredContent.nextAction.arguments.confirm_charge_usd, 108);
    assert.match(upgrade.structuredContent.message, /about \$54\.00 now .* never more than \$108\.00, so that is the amount to approve/);
    assert.match(upgrade.structuredContent.message, /confirm_charge_usd 108, confirm: true/);
    assert.equal(fake.calls.filter(item => item.path !== '/UserAgent/Detail').length, 0);

    // The approved amount is a ceiling for a prorated upgrade, and the estimate alone is below it.
    for (const approved of [50, 60]) {
      const tooLow = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'upgrade_to_pro', confirm_charge_usd: approved, confirm: true });
      assert.equal(tooLow.structuredContent.outcome, 'quote');
      assert.equal(tooLow.structuredContent.priceChanged, true);
      assert.match(tooLow.structuredContent.message, new RegExp(`The most this upgrade can charge changed since the quote: it is now \\$108\\.00, and the user approved at most \\$${approved}\\.00\\. Nothing was charged\\.`));
      assert.equal(tooLow.structuredContent.nextAction.arguments.confirm_charge_usd, 108);
    }
    assert.equal(fake.called('/UserAgent/UpgradeTier').length, 0);

    const done = await call(client, 'manage_agent_billing', upgrade.structuredContent.nextAction.arguments);
    assert.equal(done.structuredContent.outcome, 'done');
    assert.equal(fake.called('/UserAgent/UpgradeTier').length, 1);
  });
});

test('manage_agent_billing approves an upgrade on a shorter billing period at its maximum', async () => {
  // A card plan switching to the wallet keeps its 28-day card period: Wiro
  // divides by 28 days, while the estimate divides by 30.
  const start = NOW;
  const end = NOW + 28 * 86_400;
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ subscription: subscription({ provider: 'stripe', nextprovider: 'prepaid', currentperiodend: end }) })),
    '/UserAgent/UpgradeTier': () => {
      const totalDays = Math.max(1, Math.round((end - start) / 86_400));
      const remainingDays = Math.max(0, Math.round((end - Math.floor(Date.now() / 1000)) / 86_400));
      const proratedCharge = Math.round(((120 - 12) / totalDays) * remainingDays * 100) / 100;
      return { result: true, errors: [], tier: 'pro', previousTier: 'starter', newPriceUsd: 120, newMonthlyCredits: 12000, proratedCharge };
    },
  });
  await withClient(fake, async client => {
    const quote = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'upgrade_to_pro' });
    assert.equal(quote.structuredContent.quote.chargeNowUsd, 100.8);
    const approved = quote.structuredContent.nextAction.arguments.confirm_charge_usd;
    assert.equal(approved, 108);
    const done = await call(client, 'manage_agent_billing', quote.structuredContent.nextAction.arguments);
    assert.equal(done.structuredContent.outcome, 'done');
    assert.equal(done.structuredContent.result.chargedUsd, 108);
    assert.ok(done.structuredContent.result.chargedUsd <= approved);
  });
});

test('manage_agent_billing does not promise renewals on a cancelled plan', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ subscription: subscription({ pendingdowngrade: 'cancel' }) })),
  });
  await withClient(fake, async client => {
    const upgrade = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'upgrade_to_pro' });
    const { quote, message } = upgrade.structuredContent;
    assert.equal(quote.recurringUsd, null);
    assert.match(message, /The plan is cancelled, so it ends about a day after .* and does not renew at the Pro price; this charge covers only the days left/);
    assert.match(message, /undo the cancellation first with action renew/);
    assert.doesNotMatch(message, /From the next renewal/);
  });
});

test('manage_agent_billing sends card plans to the dashboard without a payment link', async () => {
  const card = subscription({ provider: 'stripe' });
  const fake = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ subscription: card })) });
  await withClient(fake, async client => {
    const upgrade = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'upgrade_to_pro', confirm: true });
    assert.equal(upgrade.structuredContent.outcome, 'refused');
    assert.match(upgrade.structuredContent.message, /card payments are made in the Wiro dashboard\. Nothing was charged here\. To upgrade it to Pro, open https:\/\/wiro\.ai\/panel\/agents\/ua-1$/);
    assert.equal(upgrade.structuredContent.checkoutUrl, undefined);

    const cancel = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'cancel' });
    assert.equal(cancel.structuredContent.outcome, 'refused');
    assert.match(cancel.structuredContent.message, /https:\/\/wiro\.ai\/panel\/agents\/ua-1/);
    assert.deepEqual(fake.calls.map(item => item.path).filter(path => path !== '/UserAgent/Detail'), []);
  });

  const proCard = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ tier: 'pro', subscription: card })) });
  await withClient(proCard, async client => {
    const pack = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'buy_credits', pack: 'small', confirm: true });
    assert.equal(pack.structuredContent.outcome, 'refused');
    assert.match(pack.structuredContent.message, /To buy the pack, open https:\/\/wiro\.ai\/panel\/agents\/ua-1/);
    assert.doesNotMatch(JSON.stringify(pack), /checkout\.stripe\.com/);
    assert.deepEqual(proCard.calls.map(item => item.path).filter(path => path !== '/UserAgent/Detail'), []);
  });
});

test('manage_agent_billing does not say a card plan set to stop will renew', async () => {
  const card = subscription({ provider: 'stripe' });
  const fake = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ subscription: card, stripecancelatperiodend: true })) });
  await withClient(fake, async client => {
    const renew = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'renew' });
    assert.equal(renew.structuredContent.outcome, 'refused');
    assert.match(renew.structuredContent.message, /is set to stop renewing after .*where it can be kept: https:\/\/wiro\.ai\/panel\/agents\/ua-1$/);
    assert.doesNotMatch(renew.structuredContent.message, /renews by itself/);
  });
  const renewing = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ subscription: card })) });
  await withClient(renewing, async client => {
    const renew = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'renew' });
    assert.match(renew.structuredContent.message, /renews by itself/);
  });
});

test('manage_agent_billing cancels and undoes a wallet plan with confirmation', async () => {
  let pending = null;
  const fake = fakeClient({
    '/UserAgent/Detail': () => detailResponse(agentRow({ subscription: subscription({ pendingdowngrade: pending }) })),
    '/UserAgent/CancelSubscription': () => {
      pending = 'cancel';
      return { result: true, errors: [], cancelsAt: NOW + 15 * 86_400 };
    },
    '/UserAgent/RenewSubscription': () => {
      pending = null;
      return { result: true, errors: [], action: 'undo-cancel' };
    },
  });
  await withClient(fake, async client => {
    const quote = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'cancel' });
    assert.equal(quote.structuredContent.outcome, 'quote');
    assert.match(quote.structuredContent.message, /nothing is refunded/);
    assert.equal(quote.structuredContent.nextAction.reason, 'Ask the user to confirm the cancellation first.');

    const done = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'cancel', confirm: true });
    assert.equal(done.structuredContent.outcome, 'done');
    assert.ok(done.structuredContent.result.cancelsAt);
    assert.equal(done.structuredContent.agent.subscription.cancelAtPeriodEnd, true);

    const undo = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'renew', confirm: true });
    assert.equal(undo.structuredContent.result.renewal, 'undo_cancel');
    assert.deepEqual(fake.called('/UserAgent/RenewSubscription')[0].body, { guid: 'ua-1' });
  });
});

test('manage_agent_billing explains a workspace mismatch', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ teamguid: 'team-guid-secret', status: 0, subscription: subscription({ status: 'expired' }) })),
    '/UserAgent/RenewSubscription': { result: false, errors: [{ code: 0, message: 'This agent belongs to a team. Switch to the team context to access it.' }] },
  });
  await withClient(fake, async client => {
    const quote = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'renew' });
    assert.equal(quote.structuredContent.quote.paidFrom, 'team_wallet');
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'renew', confirm_charge_usd: 12, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /API key from the agent's own workspace/);
    assertNoSecrets(result);
  });
});

// ---------------------------------------------------------------------------
// get_agent_activity
// ---------------------------------------------------------------------------

test('get_agent_activity usage drops the people behind each row', async () => {
  const fake = fakeClient({
    '/UserAgent/TransactionList': {
      result: true,
      errors: [],
      total: 3,
      summary: {
        monthlycredits: 1200,
        extracredits: 100,
        usedcredits: 200,
        remainingcredits: 1100,
        creditperiod: '2026-10',
        creditsyncat: NOW - 86_400,
        extrapacks: [{ id: 7, credits: 6000, remainingcredits: 100, status: 'active', provider: 'prepaid', purchasedat: NOW - 1000, expiresat: NOW + 1000 }],
        byModel: [{ model: 'openai/gpt-5.6-sol', inputtokens: 1000, outputtokens: 200, cachereadtokens: 0, cachewritetokens: 0, totaltokens: 1200, tokencost: 14, turncount: 3 }],
      },
      transactions: [{
        guid: 'tx-1',
        type: 'deduct',
        action: 'tokens',
        amount: -5,
        balanceafter: 1100,
        description: 'Chat turn',
        sessionkey: 'session-secret',
        agentsessionkey: 'session-secret',
        messageguid: 'msg-1',
        provider: null,
        providerref: 'prepaid-1-abc',
        metadata: { requestid: 'abc' },
        createdat: NOW - 60,
        uuid: 'member-uuid',
        user: { uuid: 'member-uuid', firstname: 'Ada', lastname: 'Lovelace', email: 'member@example.com', avatar: 'avatar.png' },
        inputtokens: 300,
        outputtokens: 50,
        totaltokens: 350,
        tokencost: 5,
        processedms: 900,
        model: 'openai/gpt-5.6-sol',
      }],
    },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'get_agent_activity', { agent_guid: 'ua-1', kind: 'usage', limit: 1 });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls[0].body, { useragentguid: 'ua-1', limit: 1, start: 0 });
    const { usage } = result.structuredContent;
    assert.equal(usage.balance.remainingCredits, 1100);
    assert.equal(usage.byModel[0].turns, 3);
    assert.deepEqual(usage.transactions[0].tokens, { input: 300, output: 50, total: 350 });
    assert.deepEqual(usage.extraPacks, [{ credits: 6000, remainingCredits: 100, status: 'active', purchasedAt: new Date((NOW - 1000) * 1000).toISOString() }]);
    assert.equal(usage.nextStart, 1);
    const serialized = JSON.stringify(result);
    for (const leaked of ['Lovelace', 'session-secret', 'prepaid-1-abc', 'msg-1']) {
      assert.equal(serialized.includes(leaked), false, `leaked ${leaked}`);
    }
    assertNoSecrets(result);
  });
});

test('get_agent_activity logs strip people and explain an agent that is not running', async () => {
  const fake = fakeClient({
    '/UserAgent/Logs': {
      result: true,
      errors: [],
      date: '2026-10-29',
      totalLines: 2,
      events: [
        { ts: '2026-10-29T10:00:00Z', kind: 'tool', title: 'Posted', tool: 'instagram', ok: true, durationMs: 1200, cost: { credits: 3 }, userUuid: 'member-uuid', user: { email: 'member@example.com', avatar: 'avatar.png' } },
        { ts: 1761732000, kind: 'turn', title: 'Chat', ok: false, error: 'Agent unavailable', tokens: { input: 10, output: 'x' } },
      ],
    },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'get_agent_activity', { agent_guid: 'ua-1', kind: 'logs', date: '2026-10-29', lines: 50 });
    assert.deepEqual(fake.calls[0].body, { useragentguid: 'ua-1', lines: 50, date: '2026-10-29' });
    const { logs } = result.structuredContent;
    assert.equal(logs.available, true);
    assert.equal(logs.events[0].credits, 3);
    assert.equal(logs.events[1].time, new Date(1761732000 * 1000).toISOString());
    assert.deepEqual(logs.events[1].tokens, { input: 10 });
    assertNoSecrets(result);
  });

  const stopped = fakeClient({
    '/UserAgent/Logs': { result: false, events: [], errors: [{ code: 0, message: 'Agent is not assigned to a worker. It may not be running.' }] },
    '/UserAgent/LogsList': { result: false, dates: [], errors: [{ code: 0, message: 'Agent is not assigned to a worker. It may not be running.' }] },
  });
  await withClient(stopped, async client => {
    const logs = await call(client, 'get_agent_activity', { agent_guid: 'ua-1', kind: 'logs' });
    assert.notEqual(logs.isError, true);
    assert.equal(logs.structuredContent.logs.available, false);
    assert.equal(logs.structuredContent.nextAction.tool, 'control_agent');
    const dates = await call(client, 'get_agent_activity', { agent_guid: 'ua-1', kind: 'log_dates' });
    assert.equal(dates.structuredContent.logDates.available, false);
  });
});

// ---------------------------------------------------------------------------
// delete_agent
// ---------------------------------------------------------------------------

test('delete_agent lists what blocks the deletion in order', async () => {
  const fake = fakeClient({ '/UserAgent/Detail': detailResponse(agentRow({ status: 4 })) });
  await withClient(fake, async client => {
    const result = await call(client, 'delete_agent', { agent_guid: 'ua-1', confirm: true });
    assert.equal(fake.called('/UserAgent/Delete').length, 0);
    assert.equal(result.structuredContent.deleted, false);
    assert.equal(result.structuredContent.blockers.length, 2);
    assert.deepEqual(result.structuredContent.nextAction.arguments, { agent_guid: 'ua-1', action: 'cancel' });
  });
});

test('delete_agent asks first, then deletes a stopped agent with a cancelled plan', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 0, subscription: subscription({ pendingdowngrade: 'cancel' }) })),
    '/UserAgent/Delete': { result: true, errors: [], useragent: { guid: 'ua-1', deletedat: NOW } },
  });
  await withClient(fake, async client => {
    const ask = await call(client, 'delete_agent', { agent_guid: 'ua-1' });
    assert.equal(ask.structuredContent.deleted, false);
    assert.match(ask.structuredContent.message, /cannot be undone/);
    assert.match(ask.structuredContent.message, /not refunded/);
    assert.deepEqual(ask.structuredContent.nextAction.arguments, { agent_guid: 'ua-1', confirm: true });
    assert.equal(fake.called('/UserAgent/Delete').length, 0);

    const done = await call(client, 'delete_agent', { agent_guid: 'ua-1', confirm: true });
    assert.deepEqual(fake.called('/UserAgent/Delete')[0].body, { useragentguid: 'ua-1' });
    assert.equal(done.structuredContent.deleted, true);
    assert.equal(done.structuredContent.deletedAt, new Date(NOW * 1000).toISOString());
  });
});

test('delete_agent turns a running container refusal into a stop step', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 5, subscription: null })),
    '/UserAgent/Delete': { result: false, errors: [{ code: 0, message: 'Stop the agent before deleting it.' }] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'delete_agent', { agent_guid: 'ua-1', confirm: true });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.deleted, false);
    assert.equal(result.structuredContent.nextAction.tool, 'control_agent');
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test('deploy_agent sends a custom build as a skill map and keeps refusals plain', async () => {
  const deployed = agentRow({ guid: 'ua-custom', status: 2, agentguid: undefined, agent: { custom: true, cover: null, icon: null, slug: 'custom-77' }, credentials: {} });
  const fake = fakeClient({
    '/Skills/List': { result: true, errors: [], skills: [{ name: 'int-gmail-check', title: 'Gmail Check', pricing: {} }] },
    '/UserAgent/PricingPreview': { result: true, errors: [], totalPriceUsd: 4, totalMonthlyCredits: 400, enabledSkills: ['int-gmail-check'] },
    '/UserAgent/Deploy': { result: true, errors: [], useragents: [deployed] },
    '/UserAgent/Detail': detailResponse(deployed),
  });
  await withClient(fake, async client => {
    const result = await call(client, 'deploy_agent', { custom: true, title: 'Inbox', tier: 'starter', skills: ['int-gmail-check'], confirm_charge_usd: 4, confirm: true });
    const body = fake.called('/UserAgent/Deploy')[0].body;
    assert.equal(body.custom, true);
    assert.equal('agentguid' in body, false);
    assert.deepEqual(body.skills, { 'int-gmail-check': true });
    assert.equal(result.structuredContent.agent.template.custom, true);
    assert.equal(JSON.stringify(result).includes('custom-77'), false);
    assert.equal(result.structuredContent.nextAction.tool, 'get_my_agent');
  });

  const { WiroApiError } = await import('../dist/client.js');
  const unauthorized = fakeClient({
    '/Agent/Detail': { result: true, errors: [], agents: [templateRow()] },
    '/UserAgent/Deploy': () => { throw new WiroApiError(401, '{"result":false}', 'Project authorization is not valid.'); },
  });
  await withClient(unauthorized, async client => {
    const result = await call(client, 'deploy_agent', { template: 'instagram-manager', tier: 'starter', confirm_charge_usd: 12, confirm: true });
    assert.equal(result.isError, true);
    assert.equal(textOf(result).includes('may have been created'), false);
  });
});

test('control_agent keeps a successful start when the follow-up read fails', async () => {
  let reads = 0;
  const fake = fakeClient({
    '/UserAgent/Detail': () => {
      reads += 1;
      if (reads > 1) return { result: false, errors: [{ code: 0, message: 'User agent not found' }] };
      return detailResponse(agentRow({ status: 0, credentials: {} }));
    },
    '/UserAgent/Start': { result: true, errors: [], useragents: [] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'control_agent', { agent_guid: 'ua-1', action: 'start' });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.outcome, 'requested');
    assert.match(result.structuredContent.message, /could not be read; get_my_agent shows it/);
    assert.equal(result.structuredContent.nextAction.tool, 'get_my_agent');
  });
});

test('update_agent reports a partial save', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 0 })),
    '/UserAgent/Update': { result: true, errors: [], useragents: [] },
    '/UserAgent/UpdateSettings': { result: false, errors: [{ code: 0, message: 'Invalid timezone: must be a valid IANA identifier.' }] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'update_agent', { agent_guid: 'ua-1', title: 'New', timezone: 'Mars/Base' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Invalid timezone/);
    assert.match(textOf(result), /The title change was saved; the settings were not\./);
  });
});

test('manage_agent_billing says nothing was charged when the wallet is short', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detailResponse(agentRow({ status: 6, subscription: null })),
    '/UserAgent/CreateSubscriptionCheckout': { result: false, errors: [{ code: 0, message: 'Insufficient wallet balance. Required: $12.00, Available: $1.00' }] },
  });
  await withClient(fake, async client => {
    const result = await call(client, 'manage_agent_billing', { agent_guid: 'ua-1', action: 'subscribe', confirm_charge_usd: 12, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Nothing was charged/);
    assert.equal(fake.called('/UserAgent/CreateSubscriptionCheckout').length, 1);
  });
});
