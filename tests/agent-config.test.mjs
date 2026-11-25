import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';
import { SERVER_INSTRUCTIONS } from '../dist/instructions.js';
import { PLAYBOOKS } from '../dist/playbooks.js';
import { AGENT_NOT_FOUND_TEXT, ApiResultError } from '../dist/utils/api.js';
import { isPreChargeRefusal, isKnownFailedChange, outcomeUnknown } from '../dist/utils/user-agent.js';
import {
  credentialsNeededFor,
  describeSkillsApplyError,
  credentialsUsedBySkills,
  idempotencyKeyMismatch,
  newSkillChangeKey,
  normalizeCustomSkillKey,
  parseSkillChangeKey,
  parseSkillRegistry,
  planSkillChanges,
  resolveDeployCustomSkills,
  skillChangeDigest,
  templateTaskTextError,
  upsertCustomSkillKey,
} from '../dist/utils/agent-config.js';

const AGENT = 'ua-0001';
const NOW = Math.floor(Date.now() / 1000);
const TOKEN = '000000:TEST-BOT-TOKEN';
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const skillList = {
  result: true,
  errors: [],
  skills: [
    { name: 'util-voice-receptionist', title: 'Voice Receptionist', depends_on: ['util-chat-markdown-reporting', 'util-social-posting-common', 'util-anti-ai-human-copy'], conflicts_with: [], credential_key: 'twilio-voice', requires_credentials: true, pricing: { billing_model: 'tokens', monthly_price_weight_usd: 1, monthly_credits_weight: 100 } },
    { name: 'util-voice-call-prep', title: 'Voice Call Prep', depends_on: ['util-chat-markdown-reporting'], conflicts_with: [], credential_key: 'wiro', additional_credential_keys: ['var-website'], requires_credentials: true, pricing: { monthly_price_weight_usd: 4 } },
    { name: 'util-old-receptionist', title: 'Old', depends_on: [], deprecated: true, replacement: 'util-voice-receptionist', requires_credentials: false, pricing: {} },
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
  discord: {
    key: 'discord',
    title: 'Discord',
    credential_mode: 'api_key',
    connection_modes: [],
    credential_schema: [
      { key: 'bottoken', type: 'password', label: 'Discord Bot Token', required: true, encrypted: true },
      { key: 'allowedusers', type: 'string-array', label: 'Allowed Discord DM User IDs', required: true, pattern: '^\\d{15,22}$' },
      {
        key: 'guilds',
        type: 'object-array',
        label: 'Allowed Discord Servers',
        required: false,
        help: '<p>Each row defines one Discord server the agent answers in.</p>',
        item_schema: [
          { key: 'guildid', type: 'text', label: 'Server ID', required: true, pattern: '^\\d{15,22}$', help: '<p>The numeric ID of one Discord server.</p>' },
          { key: 'channelids', type: 'string-array', label: 'Allowed Channel IDs', required: true, pattern: '^\\d{15,22}$' },
          { key: 'allowedusers', type: 'string-array', label: 'Allowed User IDs', required: false, pattern: '^\\d{15,22}$' },
          { key: 'mode', type: 'select', label: 'Reply Mode', required: false, options: [{ value: 'mention', text: 'Mention' }, { value: 'all', text: 'All messages' }] },
        ],
      },
    ],
    channel: { id: 'discord', plugin: 'discord', required_fields: ['bottoken', 'allowedusers'] },
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
  wiro: {
    key: 'wiro',
    title: 'Wiro AI Models',
    credential_mode: 'api_key',
    connection_modes: [],
    credential_schema: [
      { key: 'apikey', type: 'custom:wiro-project-picker', label: 'Wiro Project', required: true, encrypted: true, help: '<p>Pick the Wiro project the agent runs models with.</p>' },
    ],
    oauth_provider: null,
  },
  'var-support-email': {
    key: 'var-support-email',
    title: 'Support Email',
    credential_mode: 'static',
    connection_modes: [],
    credential_schema: [{ key: 'value', type: 'email', label: 'Support Email', required: false }],
    oauth_provider: null,
  },
  'sys-example': {
    key: 'sys-example',
    title: 'Example Service',
    credential_mode: 'api_key',
    connection_modes: [],
    credential_schema: [{ key: 'apikey', type: 'password', label: 'API key', required: true, platform_managed: true }],
    oauth_provider: null,
  },
};

// Skills beyond the ones every test agent knows: one that a paused task waits for, and ones that read credentials.
const extraSkillList = {
  ...skillList,
  skills: [
    ...skillList.skills,
    { name: 'util-ads-manager-common', title: 'Ads Manager Common', depends_on: [], conflicts_with: [], requires_credentials: false, pricing: {} },
    { name: 'util-store-review-response', title: 'Store Review Response', depends_on: [], conflicts_with: [], credential_key: 'var-support-email', additional_credential_keys: ['wiro'], requires_credentials: true, pricing: {} },
    { name: 'util-web-channel', title: 'Web Channel', depends_on: [], conflicts_with: [], credential_key: 'twilio-voice', requires_credentials: true, pricing: {} },
  ],
};

function skillsOn(...names) {
  return names.map(name => ({ name, enabled: true, _edited: false }));
}

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
      wiro: {
        apikey: '',
        _connected: false,
        _filled: false,
        _required_missing: true,
        optional: false,
        _schema: { title: 'Wiro AI Models' },
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
      // The template wrote this task's text, so Wiro shows the template's text and marks it not editable.
      { key: 'cs-cron-metaads-performance-reporter', description: 'Weekly Meta report', value: 'Report on Meta Ads.', interval: '0 9 * * 1', enabled: true, requires_credentials: [], requires_connectors: ['meta-ads'], _source: 'skill-bundle', _editable: false },
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
    called: path => calls.filter(call => call.path === path),
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
  'list_agent_connectors',
  'connect_agent_connector',
  'set_agent_connector_accounts',
  'disconnect_agent_connector',
  'manage_agent_custom_skill',
  'list_projects',
  'bind_agent_project',
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
    const disconnect = tools.find(tool => tool.name === 'disconnect_agent_connector');
    assert.equal(disconnect.annotations.destructiveHint, true);
    assert.equal(tools.find(tool => tool.name === 'list_agent_connectors').annotations.readOnlyHint, true);
  });
});

// ---------------------------------------------------------------------------
// apply_agent_skills
// ---------------------------------------------------------------------------

function skillRoutes(extra = {}) {
  return {
    '/Skills/List': skillList,
    '/UserAgent/Detail': detail(),
    ...extra,
  };
}

const RECEPTIONIST_SET = ['util-voice-receptionist', 'util-anti-ai-human-copy', 'util-chat-markdown-reporting', 'util-social-posting-common'];
// What the Voice Receptionist change sends: the skill and the two it needs that are off.
const RECEPTIONIST_CHANGE = { 'util-voice-receptionist': true, 'util-social-posting-common': true, 'util-anti-ai-human-copy': true };

/** Detail that shows the Voice Receptionist skills once SkillsApply was called, like the live agent would. */
function detailAfterApply(overrides = {}) {
  return (_body, calls) => (calls.some(call => call.path === '/UserAgent/SkillsApply')
    ? detail({ skills: RECEPTIONIST_SET.map(name => ({ name, enabled: true })), ...overrides })
    : detail(overrides));
}

/** SkillsApply's answer for a change: no money moves, and Wiro says whether a running agent restarts. */
function appliedAnswer(overrides = {}) {
  return { result: true, errors: [], pricing: { enabledSkills: RECEPTIONIST_SET }, tier: 'starter', restartTriggered: true, ...overrides };
}

function applyReceptionist(client, extra = {}) {
  return client.callTool({ name: 'apply_agent_skills', arguments: { agent_guid: AGENT, skills: { 'util-voice-receptionist': true }, ...extra } });
}

const FREE_NOTE = 'A skill change costs nothing: the plan keeps its price and the AI usage it includes.';

test('apply_agent_skills applies on the first call, adds dependencies, costs nothing and returns a key', async () => {
  const fake = fakeClient(skillRoutes({ '/UserAgent/Detail': detailAfterApply(), '/UserAgent/SkillsApply': appliedAnswer() }));
  await withClient(fake, async client => {
    const result = await applyReceptionist(client);
    assert.notEqual(result.isError, true, text(result));
    const out = result.structuredContent;
    assert.equal(out.status, 'applied');
    assert.deepEqual([...out.changes.enable].sort(), ['util-anti-ai-human-copy', 'util-social-posting-common', 'util-voice-receptionist']);
    assert.deepEqual([...out.changes.addedDependencies].sort(), ['util-anti-ai-human-copy', 'util-social-posting-common']);
    assert.deepEqual(out.changes.alreadySet, []);
    assert.equal(out.note, FREE_NOTE);
    assert.deepEqual(out.enabledSkills, RECEPTIONIST_SET);
    assert.match(out.restart, /^The agent restarts to load the skill change/);
    assert.deepEqual(out.credentialsNeeded, [{ skill: 'util-voice-receptionist', credentials: ['twilio-voice'] }]);
    assert.match(out.idempotencyKey, /^mcp-[0-9a-f]{16}-[0-9a-f]{10}$/);
    assert.equal(parseSkillChangeKey(out.idempotencyKey).digest, skillChangeDigest(AGENT, { ...RECEPTIONIST_CHANGE, 'util-chat-markdown-reporting': true }));
    assert.deepEqual(out.nextAction, {
      tool: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, credential: 'twilio-voice' },
      reason: 'See what twilio-voice needs before asking the user for it.',
    });
    // No price, plan or billing comes with a skill change, and nothing is quoted first.
    for (const field of ['pricing', 'billing', 'tier']) assert.equal(field in out, false, field);
    assert.ok(text(result).split('\n').includes(`**Cost:** ${FREE_NOTE} The skills' work uses the agent's AI usage (its plan first, then the workspace balance), and model runs they start are billed to the wallet of the workspace that owns the Wiro project connected to the agent.`), text(result));
    assert.doesNotMatch(text(result), /\$\d|charged|prorat|confirm/i);
    assert.deepEqual(fake.paths().filter(path => path !== '/Credentials/Detail'), ['/Skills/List', '/UserAgent/Detail', '/UserAgent/SkillsApply', '/UserAgent/Detail']);
    const [apply] = fake.called('/UserAgent/SkillsApply');
    assert.deepEqual(apply.body, { useragentguid: AGENT, skills: RECEPTIONIST_CHANGE, idempotencyKey: out.idempotencyKey });
    for (const value of Object.values(apply.body.skills)) assert.equal(typeof value, 'boolean');
  });
});

test('apply_agent_skills says when the running agent got the change with no restart, and waits for nothing', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply(),
    '/UserAgent/SkillsApply': appliedAnswer({ restartTriggered: false, restart: 'live', live: true }),
  }));
  await withClient(fake, async client => {
    const result = await applyReceptionist(client);
    assert.notEqual(result.isError, true, text(result));
    const out = result.structuredContent;
    assert.equal(out.status, 'applied');
    assert.equal(out.live, true);
    assert.equal(out.restart, 'The running agent uses it from its next message, with no restart.');
    assert.ok(text(result).split('\n').includes(`**Restart:** ${out.restart}`), text(result));
    assert.notEqual(out.nextAction?.tool, 'get_my_agent', 'nothing restarts, so there is nothing to wait for');
  });
  // A restart answer is not called live.
  const restarted = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply(),
    '/UserAgent/SkillsApply': appliedAnswer({ restartTriggered: true, restart: 'scheduled', live: false }),
  }));
  await withClient(restarted, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.structuredContent.live, undefined);
    assert.match(result.structuredContent.restart, /^The agent restarts to load the skill change/);
  });
});

test('apply_agent_skills takes no confirm and no tier, and points a plan change to manage_agent_billing', async () => {
  const fake = fakeClient(skillRoutes());
  await withClient(fake, async client => {
    for (const extra of [{ confirm: true }, { tier: 'pro' }]) {
      const result = await applyReceptionist(client, extra);
      assert.equal(result.isError, true, JSON.stringify(extra));
      assert.match(text(result), /Unknown argument/);
      assert.match(text(result), /A skill change applies on the first call and takes no confirm; manage_agent_billing with action change_plan changes the plan\./);
    }
    assert.equal(fake.calls.length, 0);
    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'apply_agent_skills');
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['add_dependencies', 'agent_guid', 'idempotency_key', 'skills']);
    assert.match(tool.description, /Every plan includes every skill, so a skill change costs nothing: the plan keeps its price and the AI usage it includes, and no active plan is needed\./);
    assert.match(tool.description, /The change is applied on the first call, so tell the user what turns on or off and get their yes first\./);
    assert.match(tool.description, /A running agent gets most changes without a restart; a few restart it, which takes about a minute\./);
    assert.match(tool.description, /To change the plan, use manage_agent_billing \(change_plan\)\./);
    assert.doesNotMatch(tool.description, /quote|prorat|wallet at once|Starter to Pro/i);
  });
});

test('apply_agent_skills names each skill by its title, with the name it takes', async () => {
  const fake = fakeClient(skillRoutes({ '/UserAgent/Detail': detailAfterApply(), '/UserAgent/SkillsApply': appliedAnswer() }));
  await withClient(fake, async client => {
    const applied = await applyReceptionist(client);
    const lines = text(applied).split('\n');
    // A skill the catalog gives no title reads as words made from its name.
    assert.ok(lines.includes('**Turned on:** Voice Receptionist (`util-voice-receptionist`), Social Posting Common (`util-social-posting-common`), Anti AI Human Copy (`util-anti-ai-human-copy`)'), text(applied));
    assert.ok(lines.includes('**Added because other skills need them:** Social Posting Common (`util-social-posting-common`), Anti AI Human Copy (`util-anti-ai-human-copy`)'), text(applied));
    assert.ok(lines.includes('**Still needed:** credentials for Voice Receptionist (`util-voice-receptionist`): Twilio Voice (`twilio-voice`). Set them with set_agent_credentials.'), text(applied));
    // The structured lists keep the names the tools take.
    assert.deepEqual(applied.structuredContent.changes.enable, ['util-voice-receptionist', 'util-social-posting-common', 'util-anti-ai-human-copy']);
  });
});

test('apply_agent_skills names a credential by the title of its card, or of the catalog when the agent has no card', async () => {
  const reviews = { name: 'util-store-review-response', title: 'Store Review Response', depends_on: [], conflicts_with: [], credential_key: 'var-support-email', requires_credentials: true, pricing: { monthly_price_weight_usd: 0, monthly_credits_weight: 0 } };
  const card = { optional: false, _connected: false, _filled: false, _required_missing: true, _schema: { title: 'Support Email' } };
  for (const [source, credentials, catalog] of [
    ['catalog', detailRow().credentials, credentialDetail],
    ['card', { ...detailRow().credentials, 'var-support-email': card }, { result: false, errors: [{ code: 0, message: 'Busy' }], credential: null }],
  ]) {
    const fake = fakeClient(skillRoutes({
      '/Skills/List': { ...skillList, skills: [...skillList.skills, reviews] },
      '/Credentials/Detail': catalog,
      '/UserAgent/Detail': (_body, calls) => detail(calls.some(call => call.path === '/UserAgent/SkillsApply')
        ? { credentials, skills: [...detailRow().skills, { name: 'util-store-review-response', enabled: true }] }
        : { credentials }),
      '/UserAgent/SkillsApply': appliedAnswer(),
    }));
    await withClient(fake, async client => {
      const applied = await client.callTool({ name: 'apply_agent_skills', arguments: { agent_guid: AGENT, skills: { 'util-store-review-response': true } } });
      assert.equal(applied.structuredContent.status, 'applied', `${source}: ${text(applied)}`);
      // The title, not the words made from the key (Var Support Email).
      assert.ok(text(applied).split('\n').includes('**Still needed:** credentials for Store Review Response (`util-store-review-response`): Support Email (`var-support-email`). Set them with set_agent_credentials.'), `${source}: ${text(applied)}`);
    });
  }
});

test('apply_agent_skills names the Connectors the skills it turned on work with that the agent has not connected', async () => {
  const ads = { name: 'util-ads-manager-common', title: 'Ads Manager Common Rules', depends_on: [], conflicts_with: [], requires_credentials: false, pricing: {}, suggested_connectors: ['google-ads', 'meta-ads', 'tiktok-ads'] };
  const fake = fakeClient(skillRoutes({
    '/Skills/List': { ...skillList, skills: [...skillList.skills, ads] },
    '/UserAgent/Detail': (_body, calls) => detail(calls.some(call => call.path === '/UserAgent/SkillsApply')
      ? { skills: [...detailRow().skills, { name: 'util-ads-manager-common', enabled: true }] }
      : {}),
    '/UserAgent/SkillsApply': appliedAnswer({ pricing: { enabledSkills: ['util-ads-manager-common'] } }),
    // Meta Ads is connected already, and TikTok Ads is not in the active catalog.
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [{ slug: 'meta-ads', title: 'Meta Ads', status: 'connected', authtype: 'oauth' }] },
    '/AgentConnector/List': { result: true, errors: [], agentconnectors: [{ slug: 'google-ads', title: 'Google Ads' }, { slug: 'meta-ads', title: 'Meta Ads' }] },
  }));
  await withClient(fake, async client => {
    const applied = await client.callTool({ name: 'apply_agent_skills', arguments: { agent_guid: AGENT, skills: { 'util-ads-manager-common': true } } });
    assert.equal(applied.structuredContent.status, 'applied', text(applied));
    assert.deepEqual(applied.structuredContent.connectorsToConnect, [{ connector: 'google-ads', title: 'Google Ads' }]);
    assert.ok(text(applied).split('\n').includes('**Connectors to connect:** Google Ads (`google-ads`). The skills turned on work with them, and none connects by itself: connect_agent_connector connects each one.'), text(applied));
    assert.deepEqual(applied.structuredContent.nextAction, {
      tool: 'list_agent_connectors',
      arguments: { name: 'google-ads', agent_guid: AGENT },
      reason: 'See how this connector connects before asking the user for anything; connect_agent_connector connects it.',
    });
    assert.deepEqual(fake.called('/UserAgent/ConnectorList').map(call => call.body), [{ useragentguid: AGENT }]);
  });
});

test('apply_agent_skills says when the skill change takes effect on an agent that is not running', async () => {
  for (const [status, restart] of [
    [6, 'The agent still needs setup; the skill change takes effect once it starts.'],
    [0, 'The agent is stopped, so the skill change takes effect the next time it starts.'],
    [5, 'The agent stopped with an error, so the skill change takes effect the next time it starts.'],
  ]) {
    const fake = fakeClient(skillRoutes({
      '/UserAgent/Detail': detailAfterApply({ status }),
      // Wiro restarts no agent that is not running.
      '/UserAgent/SkillsApply': appliedAnswer({ restartTriggered: false }),
    }));
    await withClient(fake, async client => {
      const result = await applyReceptionist(client);
      assert.notEqual(result.isError, true, text(result));
      assert.equal(result.structuredContent.restart, restart, `status ${status}`);
      assert.ok(text(result).includes(`**Restart:** ${restart}`), `status ${status}`);
    });
  }

  // A running agent that Wiro did not restart says so instead of a restart that did not happen.
  const kept = fakeClient(skillRoutes({ '/UserAgent/Detail': detailAfterApply(), '/UserAgent/SkillsApply': appliedAnswer({ restartTriggered: false }) }));
  await withClient(kept, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.structuredContent.restart, 'The agent keeps running: Wiro did not restart it for this change. control_agent with action restart loads it now.');
    assert.equal(result.structuredContent.nextAction.tool, 'set_agent_credentials');
  });
});

test('apply_agent_skills works without an active plan: a skill change needs none', async () => {
  for (const subscription of [
    null,
    { plan: 'agent', status: 'expired', provider: 'prepaid', currentperiodend: NOW - 86400, daysremaining: 0 },
    { plan: 'agent', status: 'expired', provider: 'stripe', currentperiodend: NOW - 86400, daysremaining: 0 },
  ]) {
    const fake = fakeClient(skillRoutes({ '/UserAgent/Detail': detailAfterApply({ subscription, status: 0 }), '/UserAgent/SkillsApply': appliedAnswer({ restartTriggered: false }) }));
    await withClient(fake, async client => {
      const result = await applyReceptionist(client);
      assert.equal(result.structuredContent.status, 'applied', text(result));
      assert.doesNotMatch(text(result), /manage_agent_billing|subscribe|renew/);
      assert.equal(fake.called('/UserAgent/SkillsApply').length, 1);
    });
  }
});

test('apply_agent_skills refuses a key that was issued for a different change', async () => {
  const fake = fakeClient(skillRoutes({ '/UserAgent/SkillsApply': appliedAnswer() }));
  await withClient(fake, async client => {
    const key = newSkillChangeKey(skillChangeDigest(AGENT, { ...RECEPTIONIST_CHANGE, 'util-chat-markdown-reporting': true }));
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-voice-call-prep': true }, idempotency_key: key },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /belongs to a different skill change/);
    assert.equal(fake.paths().includes('/UserAgent/SkillsApply'), false);
    // A key from an earlier version, with a price fingerprint at its end, is bound to its change the same way.
    const older = `${key}-0a1b2c3d`;
    const refused = await client.callTool({ name: 'apply_agent_skills', arguments: { agent_guid: AGENT, skills: { 'util-voice-call-prep': true }, idempotency_key: older } });
    assert.match(text(refused), /belongs to a different skill change/);
  });
});

test('apply_agent_skills explains a refusal with the server details and keeps the key for a retry', async () => {
  const busy = fakeClient(skillRoutes({
    '/UserAgent/SkillsApply': { result: false, errors: [{ code: 104, message: 'A skill update is already in progress for this agent, please retry shortly.' }] },
  }));
  await withClient(busy, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true);
    const out = result.structuredContent;
    assert.equal(out.status, 'refused');
    assert.equal(out.error.code, 104);
    assert.match(out.note, /^Another change to this agent's skills or plan, such as a plan change or a renewal, is still going through, and one runs at a time\. Nothing was changed by this call\./);
    assert.match(text(result), /^## Skill change not applied/);
    assert.match(text(result), /If it keeps saying so, it clears within 15 minutes\./);
    assert.match(text(result), new RegExp(`idempotency_key: \`${out.idempotencyKey}\``));
    assert.doesNotMatch(text(result), /charged|funds|wallet|may have been/i);
    assert.equal(out.nextAction, undefined);
    // The answer settles it: the agent is not read again to guess.
    assert.equal(busy.called('/UserAgent/Detail').length, 1);

    // The retry with that key sends the same change under the same key.
    await applyReceptionist(client, { idempotency_key: out.idempotencyKey });
    const [first, second] = busy.called('/UserAgent/SkillsApply');
    assert.equal(second.body.idempotencyKey, first.body.idempotencyKey);
    assert.deepEqual(second.body.skills, first.body.skills);
  });

  const retry = fakeClient(skillRoutes({ '/UserAgent/SkillsApply': { result: false, errors: [{ code: 108, message: 'Failed to apply skill changes, please retry.' }] } }));
  await withClient(retry, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 108);
    assert.equal(result.structuredContent.note, 'Wiro could not read or save what this change needs just now. Nothing was changed. Try again: repeat the call with the same idempotency_key.');
    assert.match(text(result), /idempotency_key: `mcp-/);
    assert.doesNotMatch(text(result), /funds|deposit|top up|balance/i);
  });
});

test('apply_agent_skills leads a spent or reused key to the same change with a new key', async () => {
  for (const message of [
    'This idempotencyKey was already used for a different skill change. Nothing was changed; send a new idempotencyKey.',
    'Cached response corrupt, please retry with a new idempotency key.',
  ]) {
    // The first key is refused and changes nothing; the second call, with a new key, makes the change.
    const applies = calls => calls.filter(call => call.path === '/UserAgent/SkillsApply').length;
    const fake = fakeClient(skillRoutes({
      '/UserAgent/Detail': (_body, calls) => (applies(calls) >= 2
        ? detail({ skills: RECEPTIONIST_SET.map(name => ({ name, enabled: true })) })
        : detail()),
      '/UserAgent/SkillsApply': (_body, calls) => (applies(calls) === 1
        ? { result: false, errors: [{ code: 107, message }] }
        : appliedAnswer()),
    }));
    await withClient(fake, async client => {
      const result = await applyReceptionist(client);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 107);
      assert.ok(text(result).includes(message), text(result));
      assert.equal(result.structuredContent.note, 'This idempotency_key cannot be used for this call, and nothing was changed by it. Repeat the call without idempotency_key: it then gets a new key.');
      assert.doesNotMatch(text(result), /^idempotency_key:/m, 'the spent key is not offered again');
      const { tool, arguments: args } = result.structuredContent.nextAction;
      assert.equal(tool, 'apply_agent_skills');
      assert.deepEqual(args, { agent_guid: AGENT, skills: { 'util-voice-receptionist': true }, add_dependencies: true });
      const again = await client.callTool({ name: tool, arguments: args });
      assert.equal(again.structuredContent.status, 'applied', text(again));
      const [first, second] = fake.called('/UserAgent/SkillsApply');
      assert.notEqual(second.body.idempotencyKey, first.body.idempotencyKey);
    });
  }
});

test('apply_agent_skills names a skill Wiro cannot read and gives the next step', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/SkillsApply': { result: false, errors: [{ code: 0, message: "pricing-step: skill 'util-retired' is enabled but not found in registry" }] },
  }));
  await withClient(fake, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'refused');
    assert.match(text(result), /^## Skill change not applied\n\nWiro could not work this out because the skill util-retired is not in the skill registry\. list_agent_skills shows the current names\. If the request did not name this skill, the agent already has it on, and Wiro support can take it off\./);
    assert.equal(result.structuredContent.note, 'Wiro could not read one of the skills, so nothing was changed. Check the skill names with list_agent_skills.');
    // A refusal like this settles the outcome, so the agent is not read again.
    assert.equal(fake.called('/UserAgent/Detail').length, 1);
  });
});

test('apply_agent_skills checks the live agent when Wiro answers with an error or a saved result', async () => {
  // An error answer while the agent shows the new skills.
  const saved = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply(),
    '/UserAgent/SkillsApply': { result: false, errors: [{ code: 0, message: 'Connection reset while saving' }] },
  }));
  await withClient(saved, async client => {
    const result = await applyReceptionist(client);
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.status, 'applied');
    assert.equal(result.structuredContent.note, `The agent's skills now match the request, so the change is in place. Do not repeat it. ${FREE_NOTE}`);
    assert.match(text(result), /^## Skills updated$/m);
    assert.doesNotMatch(text(result), /Nothing changed|wallet|charged/);

    // The repeat with its key goes out with no skills, and its answer is lost too: the change is in place.
    const repeat = await applyReceptionist(client, { idempotency_key: result.structuredContent.idempotencyKey });
    assert.deepEqual(saved.called('/UserAgent/SkillsApply').at(-1).body.skills, {});
    assert.equal(repeat.structuredContent.status, 'no_change');
    assert.equal(repeat.structuredContent.note, `The agent's skills already match the request, so the change is in place. Do not repeat it. ${FREE_NOTE}`);
  });

  // An error before anything was written: the agent is unchanged.
  const unchanged = fakeClient(skillRoutes({
    '/UserAgent/SkillsApply': { result: false, errors: [{ code: 0, message: 'Connection reset while saving' }] },
  }));
  await withClient(unchanged, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'refused');
    assert.match(text(result), /^The agent's skills are unchanged, so the change was not applied \(Connection reset while saving\)\. Repeating this call with the same idempotency_key is safe\./m);
    assert.match(text(result), /^idempotency_key: `mcp-/m);
  });

  // The agent cannot be read afterwards: nothing is claimed either way.
  const unreadable = fakeClient(skillRoutes({
    '/UserAgent/Detail': (_body, calls) => (calls.some(call => call.path === '/UserAgent/SkillsApply')
      ? { result: false, errors: [{ code: 0, message: 'User agent not found' }] }
      : detail()),
    '/UserAgent/SkillsApply': () => { throw new Error('socket hang up'); },
  }));
  await withClient(unreadable, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true);
    assert.match(text(result), /^The change could not be confirmed \(socket hang up\)\. Check get_my_agent to see whether the skills match the request before trying again;/m);
    assert.equal(result.structuredContent.restart, 'A running agent gets most changes without a restart; a few restart it, which takes about a minute.');
  });

  // A success answer while the agent does not show the change.
  const missing = fakeClient(skillRoutes({ '/UserAgent/SkillsApply': appliedAnswer() }));
  await withClient(missing, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'refused');
    assert.match(text(result), /The agent's skills do not match this change, so it is not in place\. Check get_my_agent/);
    assert.deepEqual(result.structuredContent.nextAction.arguments, { agent_guid: AGENT, skills: { 'util-voice-receptionist': true }, add_dependencies: true });
  });

  // A repeat with the same key: the change is already on, and the answer is the earlier result.
  const retry = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({ skills: RECEPTIONIST_SET.map(name => ({ name, enabled: true })) }),
    '/UserAgent/SkillsApply': appliedAnswer(),
  }));
  await withClient(retry, async client => {
    const key = newSkillChangeKey(skillChangeDigest(AGENT, { ...RECEPTIONIST_CHANGE, 'util-chat-markdown-reporting': true }));
    const result = await applyReceptionist(client, { idempotency_key: key });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.status, 'applied');
    assert.equal(result.structuredContent.note, `This change was already applied by an earlier call with this idempotency_key. ${FREE_NOTE}`);
    assert.match(text(result), /^## Already applied$/m);
    assert.equal(result.structuredContent.restart, 'Nothing changed, so the agent does not restart.');
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.deepEqual(retry.called('/UserAgent/SkillsApply')[0].body, { useragentguid: AGENT, skills: {}, idempotencyKey: key });
  });
});

test('apply_agent_skills reports a code 110 as failed, and never as applied', async () => {
  const message = "This skill change failed, and it could not be undone. Check the agent's skills.";
  const refused = { result: false, errors: [{ code: 110, message }] };
  // The agent reads as if the change were in place.
  const fake = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply(),
    '/UserAgent/SkillsApply': refused,
  }));
  await withClient(fake, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true, text(result));
    assert.equal(result.structuredContent.status, 'refused');
    assert.equal(result.structuredContent.error.code, 110);
    assert.ok(text(result).includes(message), text(result));
    assert.match(text(result), /^## Skill change failed/);
    assert.equal(result.structuredContent.note, 'Do not repeat this change. Check the agent\'s skills with get_my_agent before changing anything, and contact Wiro support if they are not what you expect.');
    assert.doesNotMatch(text(result), /Skills updated|the change is in place|Nothing changed/);
    // A way to look at what happened, and no way to send it again.
    assert.doesNotMatch(text(result), /^idempotency_key:/m);
    assert.deepEqual(result.structuredContent.nextAction, { tool: 'get_my_agent', arguments: { agent_guid: AGENT }, reason: 'Check the agent\'s skills. Do not repeat the change.' });

    // The agent now shows the change, so a repeat with the key goes out with no skills, and the key answers the same.
    const repeat = await applyReceptionist(client, { idempotency_key: result.structuredContent.idempotencyKey });
    assert.deepEqual(fake.called('/UserAgent/SkillsApply').at(-1).body.skills, {});
    assert.equal(fake.called('/UserAgent/SkillsApply').length, 2);
    assert.equal(repeat.structuredContent.status, 'refused');
    assert.equal(repeat.structuredContent.error.code, 110);
    assert.doesNotMatch(text(repeat), /No change needed|Already applied|already match/);
  });
  const failure = describeSkillsApplyError(new ApiResultError(message, [110], refused));
  assert.equal(failure.code, 110);
  assert.equal(failure.retrySameKey, false);
});

test('a code 110 never counts as an open outcome, whatever the live agent shows', () => {
  const failed = new ApiResultError("This skill change failed, and it could not be undone. Check the agent's skills.", [110], {});
  assert.equal(outcomeUnknown(failed), false);
  assert.equal(isKnownFailedChange(failed), true);
  // It says nothing about the wallet, so it is no refusal known to leave the wallet untouched.
  assert.equal(isPreChargeRefusal(failed), false);
  assert.equal(isKnownFailedChange(new ApiResultError('Failed to apply skill changes', [108], {})), false);
  assert.equal(isKnownFailedChange(new Error('This skill change failed')), false);
});

test('apply_agent_skills checks names before anything is written', async () => {
  const fake = fakeClient(skillRoutes());
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'apply_agent_skills',
      arguments: {
        agent_guid: AGENT,
        skills: { 'cs-weekly': true, telegram: true, 'util-voice-receptionistt': true, 'util-old-receptionist': true },
      },
    });
    assert.equal(result.isError, true);
    const message = text(result);
    assert.match(message, /manage_agent_custom_skill/);
    assert.match(message, /channel, not a skill/);
    assert.match(message, /Unknown skill "util-voice-receptionistt"\. Did you mean Voice Receptionist \(`util-voice-receptionist`\)/);
    assert.match(message, /Old \(`util-old-receptionist`\) is retired and cannot be turned on\. Use Voice Receptionist \(`util-voice-receptionist`\) instead\./);
    assert.deepEqual(fake.paths(), ['/Skills/List']);
  });
});

test('apply_agent_skills names the scheduled tasks a change paused', async () => {
  // Detail before and after turning Ads Manager Common off. The holiday planner was paused already.
  const task = (key, paused) => ({
    key, description: key, value: 'Report on Meta Ads.', interval: '0 9 * * 1', enabled: true, requires_credentials: [], requires_connectors: ['meta-ads'], _source: 'skill-bundle', _editable: true,
    _owner_skills: ['util-ads-manager-common'], _skill_off: paused, ...(paused ? { _off_skills: [['util-ads-manager-common']] } : {}), _usable_credentials: [], _if_connected: {},
  });
  const before = detail({ skills: skillsOn('util-chat-markdown-reporting', 'util-ads-manager-common'), scheduledskills: [task('cs-cron-metaads-performance-reporter', false), task('cs-cron-metaads-holiday-planner', true)] });
  const after = detail({ skills: skillsOn('util-chat-markdown-reporting'), scheduledskills: [task('cs-cron-metaads-performance-reporter', true), task('cs-cron-metaads-holiday-planner', true)] });
  const fake = fakeClient(skillRoutes({
    '/Skills/List': extraSkillList,
    '/UserAgent/Detail': (_body, calls) => structuredClone(calls.some(call => call.path === '/UserAgent/SkillsApply') ? after : before),
    '/UserAgent/SkillsApply': appliedAnswer(),
  }));
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'apply_agent_skills', arguments: { agent_guid: AGENT, skills: { 'util-ads-manager-common': false } } });
    assert.equal(result.structuredContent.status, 'applied', text(result));
    assert.deepEqual(result.structuredContent.pausedTasks, ['cs-cron-metaads-performance-reporter']);
    assert.match(text(result), /\*\*Paused by this change:\*\* Meta Ads Performance Reporter \(`cs-cron-metaads-performance-reporter`\) is paused until Ads Manager Common \(`util-ads-manager-common`\) is on\./);
    assert.doesNotMatch(text(result), /holiday-planner/);
    // Turning a skill off adds no work, so the cost line says only that it is free.
    assert.ok(text(result).split('\n').includes(`**Cost:** ${FREE_NOTE}`), text(result));
    assert.equal(fake.paths().includes('/UserAgent/PricingPreview'), false);
  });
});

test('a skill change Wiro refuses for a dependency or a conflict names the skills by title', () => {
  const titles = new Map([['util-voice-receptionist', 'Voice Receptionist'], ['util-social-posting-common', 'Social Posting Common Rules']]);
  const deps = describeSkillsApplyError(new ApiResultError('Missing dependencies', [101], { deps: [{ skill: 'util-voice-receptionist', requires: 'util-social-posting-common' }] }), titles);
  assert.match(deps.guidance, /Some skills need others that would be off: Voice Receptionist \(`util-voice-receptionist`\) needs Social Posting Common Rules \(`util-social-posting-common`\)\./);
  assert.deepEqual(deps.deps, [{ skill: 'util-voice-receptionist', requires: 'util-social-posting-common' }]);
  const conflicts = describeSkillsApplyError(new ApiResultError('Conflicting skills', [102], { conflicts: [{ a: 'util-voice-receptionist', b: 'util-old-receptionist' }] }), titles);
  assert.match(conflicts.guidance, /These skills cannot be on together: Voice Receptionist \(`util-voice-receptionist`\) and Old Receptionist \(`util-old-receptionist`\)\./);
  // A plan change sent here is refused by Wiro with a sentence that points to the plan tool.
  const plan = describeSkillsApplyError(new ApiResultError('Change the plan with UpgradeTier.', [0], {}));
  assert.equal(plan.guidance, 'A skill change does not change the plan. manage_agent_billing with action change_plan does.');
  assert.equal(isPreChargeRefusal(new ApiResultError('Change the plan with UpgradeTier.', [0], {})), true);
});

test('apply_agent_skills reports a no-op and a dependency turned off without writing', async () => {
  const fake = fakeClient(skillRoutes());
  await withClient(fake, async client => {
    const noop = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-chat-markdown-reporting': true, 'util-voice-call-prep': false } },
    });
    assert.equal(noop.structuredContent.status, 'no_change');
    assert.equal(noop.structuredContent.restart, 'Nothing changed, so the agent does not restart.');
    assert.match(text(noop), /^## No change needed\n\nThe skills are already as requested on agent `ua-0001`\. Nothing changed\.$/);

    const conflict = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-voice-receptionist': true, 'util-social-posting-common': false } },
    });
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /Voice Receptionist \(`util-voice-receptionist`\) needs Social Posting Common \(`util-social-posting-common`\), which this change turns off/);
    assert.equal(fake.paths().includes('/UserAgent/SkillsApply'), false);
  });
});

test('apply_agent_skills runs the server\'s dependency check against the whole skill set', async () => {
  const fake = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({
      skills: ['util-voice-receptionist', 'util-chat-markdown-reporting', 'util-social-posting-common', 'util-anti-ai-human-copy']
        .map(name => ({ name, enabled: true })),
    }),
  }));
  await withClient(fake, async client => {
    const removing = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-anti-ai-human-copy': false } },
    });
    assert.equal(removing.isError, true);
    assert.match(text(removing), /Voice Receptionist \(`util-voice-receptionist`\) needs Anti AI Human Copy \(`util-anti-ai-human-copy`\)\. Keep Anti AI Human Copy \(`util-anti-ai-human-copy`\) on, or also turn off Voice Receptionist \(`util-voice-receptionist`\)/);

    const withoutDependencies = await client.callTool({
      name: 'apply_agent_skills',
      arguments: { agent_guid: AGENT, skills: { 'util-video-creator': true }, add_dependencies: false },
    });
    assert.equal(withoutDependencies.isError, true);
    assert.match(text(withoutDependencies), /Video Creator \(`util-video-creator`\) needs Motion Effects \(`util-motion-effects`\), which is off\. Turn Motion Effects \(`util-motion-effects`\) on in the same change\./);
    assert.equal(fake.paths().includes('/UserAgent/SkillsApply'), false);
  });
});

// The connected project's creator in the team that owns the agent.
function teamRole(role) {
  return {
    result: true,
    errors: [],
    organizations: [{ guid: 'org-1', name: 'Acme', status: 1, teams: [{ guid: 'team-1', name: 'Growth', status: 1, role }] }],
  };
}

const TEAM_ADMIN_REQUIRED = { result: false, errors: [{ code: 97, message: 'Only a team admin can perform this action on a team-owned agent.' }] };

test('apply_agent_skills stops a team member who cannot change the skills before anything changes', async () => {
  const member = fakeClient(skillRoutes({
    '/UserAgent/Detail': detail({ teamguid: 'team-1' }),
    '/Organization/List': teamRole('member'),
    '/UserAgent/TransactionList': TEAM_ADMIN_REQUIRED,
  }));
  await withClient(member, async client => {
    const result = await applyReceptionist(client);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'refused');
    assert.equal(result.structuredContent.error.code, 97);
    assert.equal(result.structuredContent.idempotencyKey, undefined);
    assert.equal(result.structuredContent.restart, 'Nothing changed, so the agent does not restart.');
    assert.match(text(result), /^## Skill change not possible\n\nOnly a team admin or the person who deployed this agent can change its skills, and this connection acts as a team member without those rights\. Nothing was changed\./);
    assert.equal(member.paths().includes('/UserAgent/SkillsApply'), false);
    assert.doesNotMatch(JSON.stringify(result), /team-1/);
  });

  // The member who deployed the agent, and a team admin, make the change.
  const deployer = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply({ teamguid: 'team-1' }),
    '/Organization/List': teamRole('member'),
    '/UserAgent/TransactionList': { result: true, errors: [], transactions: [], summary: null, total: 0 },
    '/UserAgent/SkillsApply': appliedAnswer(),
  }));
  await withClient(deployer, async client => {
    assert.equal((await applyReceptionist(client)).structuredContent.status, 'applied');
  });
  const admin = fakeClient(skillRoutes({ '/UserAgent/Detail': detailAfterApply({ teamguid: 'team-1' }), '/Organization/List': teamRole('admin'), '/UserAgent/SkillsApply': appliedAnswer() }));
  await withClient(admin, async client => {
    assert.equal((await applyReceptionist(client)).structuredContent.status, 'applied');
    assert.equal(admin.paths().includes('/UserAgent/TransactionList'), false);
  });

  // A personal agent needs no team lookup.
  const personal = fakeClient(skillRoutes({ '/UserAgent/Detail': detailAfterApply(), '/UserAgent/SkillsApply': appliedAnswer() }));
  await withClient(personal, async client => {
    await applyReceptionist(client);
    assert.equal(personal.paths().includes('/Organization/List'), false);
  });
});

test('apply_agent_skills makes the change for a team member when the rights check fails for another reason', async () => {
  const member = fakeClient(skillRoutes({
    '/UserAgent/Detail': detailAfterApply({ teamguid: 'team-1' }),
    '/Organization/List': teamRole('member'),
    '/UserAgent/TransactionList': { result: false, errors: [{ code: 0, message: 'Unexpected error' }] },
    '/UserAgent/SkillsApply': appliedAnswer(),
  }));
  await withClient(member, async client => {
    assert.equal((await applyReceptionist(client)).structuredContent.status, 'applied');
    assert.equal(member.paths().filter(path => path === '/UserAgent/TransactionList').length, 1);
  });
});

test('set_agent_credentials asks whether a team member may save credentials before asking for values', async () => {
  const member = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail({ teamguid: 'team-1' }),
    '/Organization/List': teamRole('member'),
  });
  await withClient(member, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'telegram' } });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(result.structuredContent.notes[0], 'This connection acts as a member of this agent\'s team without admin rights, so it can save credentials here only if the person who created the connected project deployed the agent. Before asking for any value, ask the user whether they created this project and deployed the agent. If not, a team admin or the person who deployed it saves them in the Wiro dashboard.');
    assert.doesNotMatch(JSON.stringify(result), /team-1/);
  });

  const admin = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail({ teamguid: 'team-1' }),
    '/Organization/List': teamRole('admin'),
  });
  await withClient(admin, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'telegram' } });
    assert.doesNotMatch(text(result), /without admin rights/);
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
    // A credential has no ways to connect: those belong to connectors.
    for (const key of ['connectionModes', 'ownAppRedirectUri']) assert.equal(key in out.credential, false, key);
    assert.deepEqual(fake.paths(), ['/Credentials/Detail', '/UserAgent/Detail']);
  });
});

test('set_agent_credentials describe lists the keys of a list\'s entries and of a list inside an entry', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'discord' } });
    assert.notEqual(result.isError, true, text(result));
    const fields = text(result).split('### Fields\n\n')[1];
    assert.ok(fields.includes([
      '- `guilds` Allowed Discord Servers (list of objects, optional): Each row defines one Discord server the agent answers in. Each entry:',
      '  - `guildid` Server ID (text, required, pattern ^\\d{15,22}$): The numeric ID of one Discord server.',
      '  - `channelids` Allowed Channel IDs (list of text values, required, pattern ^\\d{15,22}$)',
      '  - `allowedusers` Allowed User IDs (list of text values, optional, pattern ^\\d{15,22}$)',
      '  - `mode` Reply Mode (one of: mention, all, optional)',
    ].join('\n')), fields);
    const guilds = result.structuredContent.credential.fields.find(field => field.field === 'guilds');
    assert.deepEqual(guilds.itemFields.map(item => item.field), ['guildid', 'channelids', 'allowedusers', 'mode']);
    assert.equal(guilds.help, 'Each row defines one Discord server the agent answers in.');
    assert.deepEqual(guilds.itemFields.find(item => item.field === 'mode'), { field: 'mode', label: 'Reply Mode', type: 'select', required: false, options: ['mention', 'all'] });
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
        credentials: { telegram: { bottoken: TOKEN, allowedusers: ['123456789'], optional: true, _connected: true, _filled: true, _schema: { title: 'Telegram' } } },
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
          { credential: 'telegram', field: 'allowedusers', value: [123456789, ' 987654321 '] },
        ],
      },
    });
    assert.notEqual(result.isError, true, text(result));
    const upsert = fake.calls.find(call => call.path === '/UserAgent/CredentialUpsert');
    assert.deepEqual(upsert.body, {
      useragentguid: AGENT,
      fields: [
        { credentialkey: 'telegram', fieldname: 'bottoken', fieldvalue: TOKEN },
        { credentialkey: 'telegram', fieldname: 'allowedusers', fieldvalue: ['123456789', '987654321'] },
      ],
    });
    const out = result.structuredContent;
    assert.equal(out.applied, 2);
    assert.equal(out.channels[0].enabled, true);
    assert.equal(out.credentials[0].connected, true);
    assert.equal(out.agentStatus, 'stopping');
    assert.match(out.notes.join(' '), /restarts to load the new values/);
    assert.match(out.notes.join(' '), /Telegram is on\./);
    assert.equal(out.nextAction, undefined);
    assert.doesNotMatch(JSON.stringify(result), /TEST-BOT-TOKEN/);
  });
});

test('set_agent_credentials names the credentials the setup still waits for after a write, at any status', async () => {
  const write = { agent_guid: AGENT, fields: [{ credential: 'twilio-voice', field: 'accountsid', value: 'AC0123456789abcdef' }] };
  const twilio = { accountsid: 'AC0123456789abcdef', optional: false, _connected: false, _filled: true, _required_missing: false, _schema: { title: 'Twilio Voice' } };
  const wiro = filled => ({ apikey: filled ? 'wiro-project-key-value' : '', optional: false, _connected: false, _filled: filled, _required_missing: !filled, _schema: { title: 'Wiro AI Models' } });
  const afterWrite = overrides => fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': { result: true, errors: [], applied: 1 },
    '/UserAgent/Detail': detail({ credentials: { 'twilio-voice': twilio, wiro: wiro(false) }, communicationChannels: [], scheduledskills: [], ...overrides }),
  });
  // A save that changes a value sets a running agent stopping, to start again, before Wiro answers.
  const restartNote = 'The agent restarts to load the new values, which takes about a minute.';
  const keptNote = 'The agent kept running: a save that matches what is stored does not restart it. If it should load new values now, control_agent with action restart does it.';
  const missingNote = 'Setup is not finished: still missing Wiro AI Models. Connect it with bind_agent_project, then check with get_my_agent.';

  // A running agent whose setup still waits for another credential.
  await withClient(afterWrite({ status: 1, setuprequired: true }), async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(result.structuredContent.notes, [restartNote, missingNote]);
    assert.match(text(result), /\*\*Twilio Voice:\*\* set\n/);
    assert.match(text(result), /- Setup is not finished: still missing Wiro AI Models\. Connect it with bind_agent_project, then check with get_my_agent\./);
    assert.doesNotMatch(JSON.stringify(result), /AC0123456789abcdef|wiro-project-key-value/);
  });

  // At status 6 the named note takes the place of the general one.
  await withClient(afterWrite({ status: 6, setuprequired: true }), async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.deepEqual(result.structuredContent.notes, [missingNote]);
    assert.doesNotMatch(text(result), /still needs setup before it can start/);
  });

  // Once nothing is missing, the result says nothing about setup.
  await withClient(afterWrite({ status: 1, setuprequired: false, credentials: { 'twilio-voice': twilio, wiro: wiro(true) } }), async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(result.structuredContent.notes, [restartNote]);
    assert.doesNotMatch(text(result), /Setup is not finished/);
  });

  // An agent read back still running was not restarted: the save matched what was stored.
  await withClient(afterWrite({ status: 4, setuprequired: false, credentials: { 'twilio-voice': twilio, wiro: wiro(true) } }), async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.notEqual(result.isError, true, text(result));
    assert.deepEqual(result.structuredContent.notes, [keptNote]);
    assert.doesNotMatch(text(result), /restarts (shortly|to load)/);
  });

  // A stopped agent, and one that stopped with an error, use the values when they start.
  for (const [status, note] of [
    [0, 'The agent is stopped; the values are used when it starts.'],
    [5, 'The agent stopped with an error; the values are used when it starts.'],
  ]) {
    await withClient(afterWrite({ status, setuprequired: false, credentials: { 'twilio-voice': twilio, wiro: wiro(true) } }), async client => {
      const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
      assert.notEqual(result.isError, true, text(result));
      assert.deepEqual(result.structuredContent.notes, [note], `status ${status}`);
    });
  }

  // At status 6 with no credential named, the general note stays.
  await withClient(afterWrite({ status: 6, setuprequired: true, credentials: { 'twilio-voice': twilio, wiro: wiro(true) } }), async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: write });
    assert.deepEqual(result.structuredContent.notes, ['The agent still needs setup before it can start; get_my_agent shows what is missing.']);
  });
});

test('set_agent_credentials clears an optional field or a chat channel\'s field, never another required one', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': body => ({ result: true, errors: [], applied: body.fields.length }),
    '/UserAgent/Detail': detail(),
  });
  await withClient(fake, async client => {
    const { tools } = await client.listTools();
    const value = tools.find(tool => tool.name === 'set_agent_credentials').inputSchema.properties.fields.items.properties.value;
    assert.match(value.description, /An empty value clears an optional field\. A required field cannot be cleared, except on a chat channel, which then turns off\.$/);

    const required = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'twilio-voice', field: 'accountsid', value: '' }] },
    });
    assert.equal(required.isError, true);
    assert.match(text(required), /Account SID is required and cannot be cleared\./);
    assert.equal(fake.calls.some(call => call.path === '/UserAgent/CredentialUpsert'), false);

    const channel = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: AGENT, fields: [{ credential: 'telegram', field: 'bottoken', value: '' }] },
    });
    assert.notEqual(channel.isError, true, text(channel));
    const upsert = fake.calls.find(call => call.path === '/UserAgent/CredentialUpsert');
    assert.deepEqual(upsert.body.fields, [{ credentialkey: 'telegram', fieldname: 'bottoken', fieldvalue: '' }]);
  });
});

test('set_agent_credentials refuses bad fields before writing anything', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/AgentConnector/Detail': body => (body.slug === 'meta-ads'
      ? { result: true, errors: [], agentconnectors: [{ slug: 'meta-ads', title: 'Meta Ads', authtype: 'provider-oauth', transport: 'local' }] }
      : { result: false, errors: [{ code: 0, message: 'Connector not found.' }] }),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: {
        agent_guid: AGENT,
        fields: [
          { credential: 'telegram', field: 'botoken', value: TOKEN },
          { credential: 'telegram', field: 'allowedusers', value: ['12'] },
          { credential: 'twilio-voice', field: 'holdstrategy', value: 'magic' },
          { credential: 'meta-ads', field: 'systemusertoken', value: 'abcdefghijkl' },
          { credential: 'sys-example', field: 'apikey', value: 'test-api-key' },
          { credential: 'nope', field: 'x', value: 'y' },
        ],
      },
    });
    assert.equal(result.isError, true);
    const message = text(result);
    assert.match(message, /Telegram has no field "botoken"\. Fields you can set: bottoken, allowedusers, groups/);
    assert.match(message, /Allowed Telegram DM User IDs #1 has an invalid format/);
    assert.match(message, /Hold experience must be one of: none, audio\./);
    // A connector's key is not a credential: it goes to the connector tools.
    assert.match(message, /Meta Ads is a Connector, not a credential: connect it with connect_agent_connector \(list_agent_connectors with name "meta-ads" shows what it needs\)\./);
    assert.match(message, /Example Service is managed by Wiro/);
    assert.match(message, /Unknown credential "nope"\. Credentials are chat channels \(such as "telegram"\), Twilio Voice, settings and the Wiro project; get_my_agent lists the agent's\. An outside service is a Connector: list_agent_connectors lists them and connect_agent_connector connects one\./);
    assert.doesNotMatch(message, /TEST-BOT-TOKEN|abcdefghijkl/);
    assert.equal(fake.paths().includes('/UserAgent/CredentialUpsert'), false);
  });
});

test('set_agent_credentials points a connector\'s key to the connector tools when describing it', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/AgentConnector/Detail': { result: true, errors: [], agentconnectors: [{ slug: 'serper', title: 'Serper', authtype: 'fields', transport: 'local' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'serper' } });
    assert.equal(result.isError, true);
    assert.equal(text(result), '## Error\n\nSerper is a Connector, not a credential: connect it with connect_agent_connector (list_agent_connectors with name "serper" shows what it needs). Nothing was saved.');
    assert.equal(fake.paths().includes('/UserAgent/Detail'), false);
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
          { credential: 'telegram', field: 'allowedusers', value: ['123456789'] },
        ],
      },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /partly saved/);
    assert.match(text(result), /Telegram rejected \[hidden\]/);
    assert.doesNotMatch(JSON.stringify(result), /TEST-BOT-TOKEN/);
    assert.equal(result.structuredContent.applied, 1);
  });
});

const SERVER = '123456789012345678';
const CHANNEL = '234567890123456789';

test('set_agent_credentials checks the rows of a list and the lists inside them, and names them the way Wiro does', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/CredentialUpsert': body => ({ result: true, errors: [], applied: body.fields.length }),
    '/UserAgent/Detail': detail(),
  });
  const writeGuilds = (client, guilds) => client.callTool({
    name: 'set_agent_credentials',
    arguments: { agent_guid: AGENT, fields: [{ credential: 'discord', field: 'guilds', value: guilds }] },
  });
  await withClient(fake, async client => {
    const missingId = await writeGuilds(client, [{ guildid: SERVER, channelids: [CHANNEL] }, { channelids: [CHANNEL] }]);
    assert.equal(missingId.isError, true);
    assert.match(text(missingId), /Nothing was saved:\n\n- Server ID in Allowed Discord Servers #2 is required\./);

    const unknownKey = await writeGuilds(client, [{ guildid: SERVER, channelids: [CHANNEL], roleids: ['1'] }]);
    assert.match(text(unknownKey), /Allowed Discord Servers #1 has unknown keys \(roleids\)\. Allowed: guildid, channelids, allowedusers, mode\./);

    const badMode = await writeGuilds(client, [{ guildid: SERVER, channelids: [CHANNEL], mode: 'loud' }]);
    assert.match(text(badMode), /Reply Mode in Allowed Discord Servers #1 must be one of: mention, all\./);

    const notAList = await writeGuilds(client, [{ guildid: SERVER, channelids: CHANNEL }]);
    assert.match(text(notAList), /Allowed Channel IDs in Allowed Discord Servers #1 takes a list \(JSON array\)\./);

    const noChannels = await writeGuilds(client, [{ guildid: SERVER, channelids: [] }]);
    assert.match(text(noChannels), /Allowed Channel IDs in Allowed Discord Servers #1 is required\./);
    assert.equal(fake.calls.some(call => call.path === '/UserAgent/CredentialUpsert'), false);

    const valid = await writeGuilds(client, [{ guildid: SERVER, channelids: [CHANNEL, Number('345678901234567')] }]);
    assert.notEqual(valid.isError, true, text(valid));
    const upsert = fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1);
    assert.deepEqual(upsert.body.fields, [{
      credentialkey: 'discord',
      fieldname: 'guilds',
      fieldvalue: [{ guildid: SERVER, channelids: [CHANNEL, '345678901234567'] }],
    }]);
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
    // A text list goes out under the list's own key and the entry's position.
    const channels = await write(client, { credential: 'discord', field: 'channelids', parent_field: 'guilds', ordinal: 1, value: [CHANNEL] });
    assert.notEqual(channels.isError, true, text(channels));
    assert.deepEqual(fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1).body.fields, [{
      credentialkey: 'discord',
      fieldname: 'channelids',
      fieldvalue: [CHANNEL],
      parentfield: 'guilds',
      ordinal: 1,
    }]);

    const users = await write(client, { credential: 'telegram', field: 'allowedusers', parent_field: 'groups', ordinal: 0, value: ['123456789', 987654321] });
    assert.notEqual(users.isError, true, text(users));
    assert.deepEqual(fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').at(-1).body.fields, [{
      credentialkey: 'telegram',
      fieldname: 'allowedusers',
      fieldvalue: ['123456789', '987654321'],
      parentfield: 'groups',
      ordinal: 0,
    }]);
    const upserts = fake.calls.filter(call => call.path === '/UserAgent/CredentialUpsert').length;

    const badItem = await write(client, { credential: 'discord', field: 'channelids', parent_field: 'guilds', ordinal: 1, value: ['general'] });
    assert.equal(badItem.isError, true);
    assert.match(text(badItem), /Allowed Channel IDs in Allowed Discord Servers #2, item #1 has an invalid format/);

    const path = await write(client, { credential: 'discord', field: 'channelids', parent_field: 'guilds.0', ordinal: 0, value: [CHANNEL] });
    assert.match(text(path), /Allowed Discord Servers: parent_field takes the list field's key alone \("guilds"\); pass the entry's position, from 0, as ordinal\./);
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
    const whole = await write(client, { credential: 'telegram', field: 'groups', value: [{ chatid: spaced, allowedusers: ['123456789'] }] });
    for (const result of [entry, whole]) {
      assert.equal(result.isError, true);
      assert.match(text(result), /Group Chat ID in Allowed Telegram Groups #1 has an invalid format \(expected pattern \^-\\d\{5,\}\$\)\./);
    }
    assert.equal(upserts().length, 0);

    // An optional list inside an entry is cleared as an empty list.
    for (const value of [null, '', '  ']) {
      const users = await write(client, { credential: 'discord', field: 'allowedusers', parent_field: 'guilds', ordinal: 0, value });
      assert.notEqual(users.isError, true, text(users));
      assert.deepEqual(upserts().at(-1).body.fields, [{ credentialkey: 'discord', fieldname: 'allowedusers', fieldvalue: [], parentfield: 'guilds', ordinal: 0 }]);
    }
  });
});

test('set_agent_credentials names list items and entries the way Wiro does', async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail });
  const write = (client, field) => client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields: [field] } });
  await withClient(fake, async client => {
    const top = await write(client, { credential: 'telegram', field: 'allowedusers', value: ['123456789', '12'] });
    assert.equal(top.isError, true);
    assert.match(text(top), /Allowed Telegram DM User IDs #2 has an invalid format \(expected pattern \^\\d\{5,\}\$\)\./);

    // A text list inside an entry names its items after the entry, in a whole write and with parent_field.
    const nested = 'Allowed User IDs in Allowed Telegram Groups #1, item #2 has an invalid format (expected pattern ^\\d{5,}$).';
    const whole = await write(client, { credential: 'telegram', field: 'groups', value: [{ chatid: '-1001234567890', allowedusers: ['123456789', '12'] }] });
    const entry = await write(client, { credential: 'telegram', field: 'allowedusers', parent_field: 'groups', ordinal: 0, value: ['123456789', '12'] });
    for (const result of [whole, entry]) {
      assert.equal(result.isError, true);
      assert.ok(text(result).includes(nested), text(result));
      assert.doesNotMatch(text(result), / item \d+ /);
    }
    const notText = await write(client, { credential: 'telegram', field: 'allowedusers', parent_field: 'groups', ordinal: 0, value: [{ id: '123456789' }] });
    assert.ok(text(notText).includes('Allowed User IDs takes a list of text values; Allowed User IDs in Allowed Telegram Groups #1, item #1 is not one.'), text(notText));

    const unknownField = await write(client, { credential: 'discord', field: 'roleids', parent_field: 'guilds', ordinal: 0, value: ['1'] });
    assert.match(text(unknownField), /Allowed Discord Servers entries have no field "roleids"\. Entry fields: guildid, channelids, allowedusers, mode\./);
    const noOrdinal = await write(client, { credential: 'discord', field: 'guildid', parent_field: 'guilds', value: SERVER });
    assert.match(text(noOrdinal), /Allowed Discord Servers: ordinal \(the entry's position, from 0\) is required with parent_field\./);
    assert.equal(fake.paths().includes('/UserAgent/CredentialUpsert'), false);
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

// An agent's detail shows a saved secret as dots. It reads as set, the dots are never shown as a value, and they
// are never sent back as one.
test('a saved secret Wiro shows as dots reads as set, is never shown, and is never sent back', async () => {
  const MASK = '••••••••';
  const row = detailRow();
  row.credentials.telegram = { ...row.credentials.telegram, bottoken: MASK };
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': { result: true, errors: [], useragents: [row] },
    '/UserAgent/CredentialUpsert': { result: true, applied: 1 },
  });
  await withClient(fake, async client => {
    const telegram = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'telegram' } });
    assert.deepEqual(telegram.structuredContent.credential.status.missingFields, ['Allowed Telegram DM User IDs']);
    assert.equal(JSON.stringify(telegram).includes('•'), false);

    // Sent back alone, padded, inside a list or next to a real value, nothing is saved.
    const refusal = (title, field) => `## Error\n\nNothing was saved:\n\n- ${title}: "${field}" holds the dots Wiro shows in place of a saved secret, not the secret itself. Leave it out to keep the saved value, or send the new value.`;
    for (const [fields, expected] of [
      [[{ credential: 'telegram', field: 'bottoken', value: MASK }], refusal('Telegram', 'bottoken')],
      [[{ credential: 'telegram', field: 'bottoken', value: ` ${MASK} ` }], refusal('Telegram', 'bottoken')],
      [[{ credential: 'telegram', field: 'groups', value: [{ chatid: '-1001234567', allowedusers: [MASK] }] }], refusal('Telegram', 'groups')],
      [[{ credential: 'telegram', field: 'allowedusers', value: ['123456789'] }, { credential: 'telegram', field: 'bottoken', value: MASK }], refusal('Telegram', 'bottoken')],
    ]) {
      const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields } });
      assert.equal(result.isError, true, text(result));
      assert.equal(text(result), expected);
    }
    assert.equal(fake.paths().includes('/UserAgent/CredentialUpsert'), false);

    // A deploy refuses them before anything is read or quoted.
    const calls = fake.calls.length;
    const deploy = await client.callTool({
      name: 'deploy_agent',
      arguments: { template: 'growth-agent', tier: 'starter', credentials: { telegram: { bottoken: MASK, allowedusers: ['123456789'] } } },
    });
    assert.equal(deploy.isError, true);
    assert.equal(text(deploy), '## Error\n\nNothing was deployed: credentials telegram.bottoken holds the dots Wiro shows in place of a saved secret, not the secret itself. Send the value itself, or leave it out and save it after the deploy with set_agent_credentials.');
    assert.equal(fake.calls.length, calls);

    // Only Wiro's mask, exactly eight of those dots, stands for a saved secret. Other dots are a value like any
    // other, which Wiro checks.
    for (const value of [MASK.slice(1), `${MASK}•`]) {
      const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields: [{ credential: 'telegram', field: 'bottoken', value }] } });
      assert.notEqual(result.isError, true, text(result));
    }
    assert.deepEqual(fake.called('/UserAgent/CredentialUpsert').map(call => call.body.fields), [
      [{ credentialkey: 'telegram', fieldname: 'bottoken', fieldvalue: '•'.repeat(7) }],
      [{ credentialkey: 'telegram', fieldname: 'bottoken', fieldvalue: '•'.repeat(9) }],
    ]);
  });
});

test('set_agent_credentials names the skills a task the save turns on still waits for', async () => {
  const task = (key, requires, owners, offSkills) => ({
    key, description: 'Store check', value: 'Check the store.', interval: '0 9 * * *', enabled: true, requires_credentials: requires, _source: 'skill-bundle', _editable: true,
    _owner_skills: owners, _skill_off: offSkills !== null, ...(offSkills ? { _off_skills: offSkills } : {}),
  });
  const replies = task('cs-cron-review-replies', ['var-support-email'], ['util-store-review-response', 'util-web-channel'], [['util-store-review-response', 'util-web-channel']]);
  const digest = task('cs-cron-support-digest', ['var-support-email', 'wiro'], ['util-chat-markdown-reporting'], null);
  // Waiting too, but it needs another credential, so this save says nothing about it.
  const calls = task('cs-cron-call-summary', ['twilio-voice'], ['util-web-channel'], [['util-web-channel']]);
  const save = async scheduledskills => {
    let result;
    await withClient(fakeClient({
      '/Credentials/Detail': credentialDetail,
      '/Skills/List': extraSkillList,
      '/UserAgent/CredentialUpsert': { result: true, errors: [], applied: 1 },
      '/UserAgent/Detail': detail({
        status: 6,
        skills: skillsOn('util-chat-markdown-reporting'),
        credentials: { 'var-support-email': { value: 'help@example.com', optional: false, _connected: false, _filled: true, _required_missing: false, _schema: { title: 'Support Email' } } },
        communicationChannels: [],
        scheduledskills,
      }),
    }), async client => {
      result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, fields: [{ credential: 'var-support-email', field: 'value', value: 'help@example.com' }] } });
      assert.notEqual(result.isError, true, text(result));
    });
    return result;
  };
  const base = 'Saving these credentials turns on the scheduled tasks that need them; turn off any you do not want.';

  const waiting = await save([replies, digest, calls]);
  assert.ok(waiting.structuredContent.notes.includes(`${base} Review Replies (\`cs-cron-review-replies\`) stays paused until Store Review Response (\`util-store-review-response\`) or Web Channel (\`util-web-channel\`) is on.`), JSON.stringify(waiting.structuredContent.notes));
  assert.doesNotMatch(text(waiting), /`cs-cron-(support-digest|call-summary)`\) stays paused/);

  const running = await save([digest]);
  assert.ok(running.structuredContent.notes.includes(base), JSON.stringify(running.structuredContent.notes));
});

test('get_my_agent does not ask for a credential whose saved values have no template row or skill behind them', async () => {
  // The fields were saved on an agent that does not use them: the setup does not wait for them.
  const row = detailRow({ skills: skillsOn('util-chat-markdown-reporting') });
  row.credentials = { 'twilio-voice': { accountsid: 'AC1', _connected: false, _filled: true, _required_missing: false, _schema: { title: 'Twilio Voice' } } };
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/Skills/List': extraSkillList,
    '/UserAgent/Detail': { result: true, useragents: [row] },
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_my_agent', arguments: { agent_guid: AGENT } });
    assert.deepEqual(result.structuredContent.agent.missingCredentials, []);
    assert.notEqual(result.structuredContent.nextAction?.tool, 'set_agent_credentials');
  });
});

test('credentialsUsedBySkills counts main and additional credentials of the skills named', () => {
  const registry = parseSkillRegistry(extraSkillList);
  assert.deepEqual([...credentialsUsedBySkills(['util-store-review-response', 'util-web-channel', 'util-anti-ai-human-copy', 'not-in-the-list'], registry)], ['var-support-email', 'wiro', 'twilio-voice']);
  assert.deepEqual([...credentialsUsedBySkills([], registry)], []);
  // A skill that needs no credentials uses none, whatever keys it lists.
  const noCredentials = parseSkillRegistry({ skills: [{ name: 'util-x', credential_key: 'wiro', requires_credentials: false }] });
  assert.deepEqual([...credentialsUsedBySkills(['util-x'], noCredentials)], []);
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
    assert.match(out.schedule.note, /uses the agent's AI usage \(its plan first, then the workspace balance\)/);
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
      [{ key: 'cs-cron-metaads-performance-reporter', value: 'Different prompt' }, /^## Error\n\ncs-cron-metaads-performance-reporter: This scheduled task comes with the agent's template, so its instructions cannot be changed\. You can still turn it on or off and change its schedule\. enabled turns it on or off and interval changes its schedule\./],
    ];
    for (const [args, pattern] of cases) {
      const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, ...args } });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text(result), pattern);
    }
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), false);
  });
});

test('a scheduled task that comes with the template keeps its text: its own text sent back changes nothing, its switch and schedule still change', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [], restarting: true },
  });
  await withClient(fake, async client => {
    const upsert = args => client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key: 'cs-cron-metaads-performance-reporter', ...args } });
    // The template's own text, line endings and surrounding blanks aside, is no change.
    const same = await upsert({ value: '  Report on Meta Ads.\r\n' });
    assert.notEqual(same.isError, true, text(same));
    assert.equal(same.structuredContent.status, 'no_change');
    assert.equal(same.structuredContent.entry.editable, false);
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), false);

    // With the switch, only the switch is sent.
    const off = await upsert({ value: 'Report on Meta Ads.', enabled: false });
    assert.equal(off.structuredContent.status, 'saved');
    assert.deepEqual(fake.called('/UserAgent/CustomSkillUpsert')[0].body, { useragentguid: AGENT, skillkey: 'cs-cron-metaads-performance-reporter', enabled: false });
    const schedule = await upsert({ interval: '0 8 * * 1' });
    assert.equal(schedule.structuredContent.status, 'saved');
    assert.deepEqual(fake.called('/UserAgent/CustomSkillUpsert')[1].body, { useragentguid: AGENT, skillkey: 'cs-cron-metaads-performance-reporter', interval: '0 8 * * 1' });
  });
});

test('a scheduled task Wiro shows as editable takes a new text, and Wiro\'s refusal of a template\'s text says what still changes', async () => {
  // A task the template wrote no text for, or one of a custom build, is the agent's own.
  const own = { key: 'cs-cron-own-words', description: 'Own words', value: 'Post a photo.', interval: '0 9 * * 1', enabled: true, requires_credentials: [], _source: 'skill-bundle', _editable: true };
  const fake = fakeClient({
    '/UserAgent/Detail': detail({ scheduledskills: [own] }),
    '/UserAgent/CustomSkillUpsert': body => (body.skillkey === 'cs-cron-own-words' && body.value === 'Refused text.'
      ? { result: false, errors: [{ code: 0, message: 'This scheduled task comes with the agent\'s template, so its instructions cannot be changed. You can still turn it on or off and change its schedule.' }] }
      : { result: true, errors: [] }),
  });
  await withClient(fake, async client => {
    const saved = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key: 'own-words', value: 'Post the week\'s best photo.' } });
    assert.notEqual(saved.isError, true, text(saved));
    assert.equal(saved.structuredContent.entry.editable, undefined);
    assert.equal(fake.called('/UserAgent/CustomSkillUpsert')[0].body.value, 'Post the week\'s best photo.');
    // Wiro is the judge: its refusal comes back with what can still change.
    const refused = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key: 'own-words', value: 'Refused text.' } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /so its instructions cannot be changed\. You can still turn it on or off and change its schedule\. enabled turns it on or off and interval changes its schedule\. To change what it does, edit the related custom skill/);
  });
});

test('get_my_agent and history say which scheduled task runs the template\'s text', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillHistory': { result: true, errors: [], entries: [], preset_default: null },
    '/UserAgent/CustomSkillAlternatives': { result: true, errors: [], alternatives: [] },
    '/UserAgent/ConnectorList': { result: true, errors: [], useragentconnectors: [] },
  });
  await withClient(fake, async client => {
    const agent = await client.callTool({ name: 'get_my_agent', arguments: { agent_guid: AGENT, entry: 'metaads-performance-reporter' } });
    assert.notEqual(agent.isError, true, text(agent));
    const tasks = agent.structuredContent.agent.scheduledTasks;
    assert.equal(tasks.find(task => task.key === 'cs-cron-metaads-performance-reporter').editable, false);
    assert.equal(tasks.find(task => task.key === 'cs-cron-my-task').editable, undefined);
    assert.equal(agent.structuredContent.entry.editable, false);
    assert.match(text(agent), /cs-cron-metaads-performance-reporter`?\)? on \(the template's text, which cannot be changed\)/);
    assert.match(text(agent), /It comes with the agent's template: the agent runs this text, the template's, which cannot be changed\. Its schedule and on\/off state can\./);
    const history = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'history', agent_guid: AGENT, key: 'cs-cron-metaads-performance-reporter' } });
    assert.match(history.structuredContent.message, /It comes with the agent's template, so the agent runs the template's text, which cannot be changed; its schedule and on\/off state can\./);
  });
});

test('manage_agent_custom_skill describes turning off the approval policy and needs confirm', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    let ask;
    for (const key of ['cs-approval-policy', 'approval-policy', ' cs-approval-policy ']) {
      ask = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key, enabled: false } });
      assert.notEqual(ask.isError, true, text(ask));
      const out = ask.structuredContent;
      assert.equal(out.status, 'confirm_needed', key);
      assert.equal(out.key, 'cs-approval-policy');
      assert.match(out.message, /^Turning off cs-approval-policy removes the agent's approval gate: it can then post, send or change things on outside services by itself, such as from a scheduled task, without waiting for the user's yes\./);
      assert.match(out.message, /Nothing has changed yet\.$/);
      assert.equal(out.entry.enabled, true);
      assert.deepEqual(out.nextAction, {
        tool: 'manage_agent_custom_skill',
        arguments: { action: 'upsert', agent_guid: AGENT, key: 'cs-approval-policy', enabled: false, confirm: true },
        reason: 'Ask the user to confirm this first.',
      });
      assert.ok(text(ask).includes(out.message));
      assert.match(text(ask), /Ask the user to confirm, then call manage_agent_custom_skill again with confirm: true\./);
    }
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), false);

    const done = await client.callTool({ name: 'manage_agent_custom_skill', arguments: ask.structuredContent.nextAction.arguments });
    assert.notEqual(done.isError, true, text(done));
    assert.equal(done.structuredContent.status, 'saved');
    assert.equal(done.structuredContent.entry.enabled, false);
    assert.match(done.structuredContent.restart, /restarts to load the change/);
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CustomSkillUpsert').body, {
      useragentguid: AGENT,
      skillkey: 'cs-approval-policy',
      enabled: false,
    });
  });
});

test('manage_agent_custom_skill keeps the whole change when it asks before turning off the approval policy', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const ask = await client.callTool({
      name: 'manage_agent_custom_skill',
      arguments: { action: 'upsert', agent_guid: AGENT, key: 'approval-policy', kind: 'skill', value: 'New rules.', description: 'Approval rules', enabled: false },
    });
    assert.equal(ask.structuredContent.status, 'confirm_needed');
    assert.deepEqual(ask.structuredContent.nextAction.arguments, {
      action: 'upsert',
      agent_guid: AGENT,
      key: 'cs-approval-policy',
      enabled: false,
      value: 'New rules.',
      description: 'Approval rules',
      confirm: true,
    });
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), false);
    const done = await client.callTool({ name: 'manage_agent_custom_skill', arguments: ask.structuredContent.nextAction.arguments });
    assert.equal(done.structuredContent.status, 'saved');
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CustomSkillUpsert').body, {
      useragentguid: AGENT,
      skillkey: 'cs-approval-policy',
      value: 'New rules.',
      enabled: false,
      description: 'Approval rules',
    });
  });
});

test('manage_agent_custom_skill describes a new text for the approval policy and needs confirm', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const value = '# Approval Policy\n\n## Mode\n\nmode: auto\n\n```\n**Next:** a line of the text\n```';
    for (const key of ['cs-approval-policy', 'approval-policy']) {
      for (const extra of [{}, { enabled: true }]) {
        const ask = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key, value, ...extra } });
        assert.notEqual(ask.isError, true, text(ask));
        const out = ask.structuredContent;
        assert.equal(out.status, 'confirm_needed');
        assert.match(out.message, /^The new text below replaces the rules of cs-approval-policy\. Its mode line and per-action rules decide what the agent may post, send or change on outside services by itself/);
        assert.match(out.message, /Nothing has changed yet\.$/);
        assert.equal(out.entry.enabled, true);
        assert.deepEqual(out.nextAction.arguments, { action: 'upsert', agent_guid: AGENT, key: 'cs-approval-policy', ...extra, value, confirm: true });
        assert.ok(text(ask).includes(`\`\`\`\`text\n${value}\n\`\`\`\``));
      }
    }
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), false);
    const done = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key: 'cs-approval-policy', value, confirm: true } });
    assert.equal(done.structuredContent.status, 'saved');
    assert.deepEqual(fake.calls.find(call => call.path === '/UserAgent/CustomSkillUpsert').body, { useragentguid: AGENT, skillkey: 'cs-approval-policy', value });
  });
});

test('manage_agent_custom_skill says what a revert of the approval policy brings back', async () => {
  const offVersion = { guid: 'v1', operation: 'update', changedat: 1767225600, after_value: 'mode: auto', after_enabled: false, after_interval: null, changed_fields: ['value', 'enabled'] };
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillHistory': { result: true, errors: [], entries: [offVersion], preset_default: { value: 'mode: manual-single', enabled: true, description: 'd' } },
  });
  await withClient(fake, async client => {
    const fromHistory = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'revert', agent_guid: AGENT, key: 'cs-approval-policy', source: 'history', version_id: 'v1' } });
    assert.equal(fromHistory.structuredContent.status, 'confirm_needed');
    assert.match(fromHistory.structuredContent.message, /The restored policy is off, which removes the agent's approval gate\./);
    assert.ok(text(fromHistory).includes('```text\nmode: auto\n```'));
    const fromPreset = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'revert', agent_guid: AGENT, key: 'cs-approval-policy', source: 'preset' } });
    assert.match(fromPreset.structuredContent.message, /The restored policy is on\./);
    assert.ok(text(fromPreset).includes('```text\nmode: manual-single\n```'));
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillRevert'), false);
  });
});

test('manage_agent_custom_skill does not ask again for the rest of the upserts', async () => {
  const upserts = (agent = detail()) => fakeClient({
    '/UserAgent/Detail': agent,
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  const cases = [
    // Turning the policy on, and saving the text it already has, act at once.
    [detail(), { key: 'cs-approval-policy', enabled: true }],
    [detail(), { key: 'cs-approval-policy', value: 'Ask before spending.' }],
    // A policy that is off does not gate anything yet.
    [detail({ customskills: [{ key: 'cs-approval-policy', description: 'Approval rules', value: 'Ask.', interval: null, enabled: false, requires_credentials: [], _source: 'preset-strategy', _editable: true }] }), { key: 'cs-approval-policy', value: 'mode: auto' }],
    // Other entries turn off at once.
    [detail(), { key: 'cs-cron-my-task', enabled: false }],
    // A policy that is already off stays off.
    [detail({ customskills: [{ key: 'cs-approval-policy', description: 'Approval rules', value: 'Ask.', interval: null, enabled: false, requires_credentials: [], _source: 'preset-strategy', _editable: true }] }), { key: 'cs-approval-policy', enabled: false }],
    // An agent that comes without one has no gate to turn off.
    [detail({ customskills: [] }), { key: 'cs-approval-policy', value: 'Ask first.', enabled: false }],
  ];
  for (const [agent, args] of cases) {
    const fake = upserts(agent);
    await withClient(fake, async client => {
      const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, ...args } });
      assert.notEqual(result.isError, true, text(result));
      assert.equal(result.structuredContent.status, 'saved', JSON.stringify(args));
      assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), true, JSON.stringify(args));
    });
  }
});

test('the refusal to delete the approval policy leads to the same confirmation', async () => {
  const fake = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const refused = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'delete', agent_guid: AGENT, key: 'cs-approval-policy', confirm: true } });
    assert.equal(refused.isError, true);
    const ask = await client.callTool({ name: 'manage_agent_custom_skill', arguments: refused.structuredContent.nextAction.arguments });
    assert.equal(ask.structuredContent.status, 'confirm_needed');
    assert.equal(fake.paths().includes('/UserAgent/CustomSkillUpsert'), false);
  });
});

test('the tool text, the playbooks and the instructions say turning off the approval policy needs confirm', async () => {
  await withClient(fakeClient({}), async client => {
    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'manage_agent_custom_skill');
    assert.match(tool.description, /Turning off cs-approval-policy or changing its text also needs confirm: true/);
    assert.match(tool.inputSchema.properties.confirm.description, /an upsert that turns off cs-approval-policy or changes its text/);
  });
  assert.match(PLAYBOOKS.agents, /and so does an upsert that turns off `cs-approval-policy` or changes its text/);
  assert.match(PLAYBOOKS['getting-started'], /`manage_agent_custom_skill` \(delete, revert, and an upsert that turns off `cs-approval-policy` or changes its text\)/);
  assert.match(SERVER_INSTRUCTIONS, /manage_agent_custom_skill \(delete, revert, turning off or editing cs-approval-policy\)/);
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
        changedby: '00000000-0000-0000-0000-000000000001',
        changedat: 1767225600,
        after_value: 'Do my task.',
        after_interval: '0 8 * * *',
        after_enabled: true,
        changed_fields: ['value', 'interval'],
        changedby_user: { uuid: '00000000-0000-0000-0000-000000000001', email: 'owner@example.com', firstname: 'Ada' },
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
    assert.doesNotMatch(JSON.stringify(result), /owner@example\.com|00000000-0000-0000-0000-000000000001|Ada|Older/);
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

test('skill plans follow dependency cycles and keys are bound to their change', () => {
  const registry = parseSkillRegistry(skillList);
  const plan = planSkillChanges({ 'util-video-creator': true }, registry, true);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.requested, { 'util-video-creator': true, 'util-motion-effects': true });

  const digest = skillChangeDigest(AGENT, plan.requested);
  assert.equal(digest, skillChangeDigest(AGENT, { 'util-motion-effects': true, 'util-video-creator': true }));
  assert.notEqual(digest, skillChangeDigest(AGENT, { 'util-motion-effects': true, 'util-video-creator': false }));
  assert.notEqual(digest, skillChangeDigest('ua-other', plan.requested));
  const key = newSkillChangeKey(digest);
  assert.match(key, /^mcp-[0-9a-f]{16}-[0-9a-f]{10}$/);
  assert.notEqual(newSkillChangeKey(digest), key, 'every key is new');
  assert.equal(idempotencyKeyMismatch(key, digest), false);
  assert.equal(idempotencyKeyMismatch(key, skillChangeDigest(AGENT, { 'util-video-creator': true })), true);
  assert.equal(idempotencyKeyMismatch('my-own-key-123', digest), false);
  assert.deepEqual(parseSkillChangeKey(key), { digest });
  // A key an earlier version minted, with a price fingerprint at its end, still names its change.
  assert.deepEqual(parseSkillChangeKey(`${key}-0a1b2c3d`), { digest });
  assert.equal(parseSkillChangeKey('my-own-key-123'), null);
});

test('deploy custom skills resolve bare keys against the template and need text when new', () => {
  const template = [
    { key: 'cs-content-strategy', interval: null },
    { key: 'cs-cron-daily-digest', interval: '0 8 * * *', instructions: 'Digest the inbox.' },
    // A task the template wrote no text for is the agent's own to write.
    { key: 'cs-cron-own-words', interval: '0 7 * * *' },
  ];
  const { skills, errors } = resolveDeployCustomSkills([
    { key: 'daily-digest', enabled: false },
    { key: 'content-strategy', value: 'Focus on reels' },
    { key: 'weekly-report', value: 'Sum up', interval: ' 0 9 * * 1 ' },
  ], template);
  assert.deepEqual(errors, []);
  assert.deepEqual(skills, [
    // The template's own task is sent with the template's schedule.
    { key: 'cs-cron-daily-digest', kind: 'scheduled_task', fromTemplate: true, interval: '0 8 * * *', enabled: false },
    { key: 'cs-content-strategy', kind: 'skill', fromTemplate: true, value: 'Focus on reels' },
    { key: 'cs-cron-weekly-report', kind: 'scheduled_task', fromTemplate: false, value: 'Sum up', interval: '0 9 * * 1' },
  ]);
  assert.deepEqual(resolveDeployCustomSkills([{ key: 'daily-digest', interval: '0 7 * * 1-5' }], template).skills, [
    { key: 'cs-cron-daily-digest', kind: 'scheduled_task', fromTemplate: true, interval: '0 7 * * 1-5' },
  ]);
  // The agent always runs the text the template wrote for its scheduled task.
  const text = resolveDeployCustomSkills([{ key: 'daily-digest', value: 'Only customer mail', enabled: true }], template);
  assert.deepEqual(text.skills, []);
  assert.equal(text.errors[0], templateTaskTextError('cs-cron-daily-digest'));
  assert.match(text.errors[0], /^cs-cron-daily-digest: This scheduled task comes with the agent's template, so its instructions cannot be changed\. You can still turn it on or off and change its schedule\./);
  assert.deepEqual(resolveDeployCustomSkills([{ key: 'own-words', value: 'Post the week\'s best photo.' }], template), {
    skills: [{ key: 'cs-cron-own-words', kind: 'scheduled_task', fromTemplate: true, value: 'Post the week\'s best photo.', interval: '0 7 * * *' }],
    errors: [],
  });
  assert.match(resolveDeployCustomSkills([{ key: 'x', value: 'a' }, { key: 'cs-x', value: 'b' }], []).errors[0], /listed twice/);
  assert.match(resolveDeployCustomSkills([{ key: 'tone', value: ' ' }], []).errors[0], /value cannot be empty/);
  assert.match(resolveDeployCustomSkills([{ key: 'cs-cron-x', value: 'a', interval: '* * *' }], null).errors[0], /five fields/);
  assert.deepEqual(resolveDeployCustomSkills([{ key: 'brand-voice' }], null).errors, []);
  assert.deepEqual(resolveDeployCustomSkills([{ key: 'cs-cron-daily-digest', value: 'Mine' }], null).errors, []);
  assert.match(resolveDeployCustomSkills([{ key: 'both' }], [{ key: 'cs-both' }, { key: 'cs-cron-both' }]).errors[0], /Pass the full key/);
});

// ---------------------------------------------------------------------------
// An agent that cannot be reached, and a required field that cannot be emptied
// ---------------------------------------------------------------------------

const NOT_FOUND = { result: false, errors: [{ code: 0, message: 'User agent not found' }] };
const RANDOM_GUID = '7b0c1f4e-2d3a-4c5b-9e8f-0123456789ab';

test('set_agent_credentials refuses to describe a credential on an agent that cannot be reached', async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail, '/UserAgent/Detail': NOT_FOUND });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: RANDOM_GUID, credential: 'telegram' } });
    assert.equal(result.isError, true);
    assert.equal(text(result), `## Error\n\n${AGENT_NOT_FOUND_TEXT}`);
    assert.doesNotMatch(text(result), /On this agent|not set yet|User agent/);
    assert.equal(result.structuredContent, undefined);

    // An unknown credential is still named first.
    const unknown = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: RANDOM_GUID, credential: 'no-such-thing' } });
    assert.match(text(unknown), /Unknown credential "no-such-thing"/);
  });
});

test('set_agent_credentials still describes a credential when the agent read fails for another reason', async () => {
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': () => { throw new Error('socket hang up'); },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'telegram' } });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /\*\*On this agent:\*\* could not be read/);
    assert.doesNotMatch(text(result), /not set yet/);
    assert.ok(result.structuredContent.notes.includes('The agent could not be read: socket hang up'));
    assert.equal(result.structuredContent.credential.key, 'telegram');
  });

  // An agent without this credential is not set yet.
  const unset = fakeClient({ '/Credentials/Detail': credentialDetail, '/UserAgent/Detail': detail({ credentials: {} }) });
  await withClient(unset, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'telegram' } });
    assert.match(text(result), /\*\*On this agent:\*\* not set yet/);
  });
});

test('set_agent_credentials gives the next step when a write reaches no agent', async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail, '/UserAgent/CredentialUpsert': NOT_FOUND });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'set_agent_credentials',
      arguments: { agent_guid: RANDOM_GUID, fields: [{ credential: 'telegram', field: 'bottoken', value: TOKEN }] },
    });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes(`Nothing was saved:\n\n- ${AGENT_NOT_FOUND_TEXT}`), text(result));
  });
});

test('clearing a required field says how to replace the value or end the access, and nothing is sent', async () => {
  const fake = fakeClient({ '/Credentials/Detail': credentialDetail });
  await withClient(fake, async client => {
    for (const value of ['', null, '   ']) {
      const result = await client.callTool({
        name: 'set_agent_credentials',
        arguments: { agent_guid: AGENT, fields: [{ credential: 'twilio-voice', field: 'accountsid', value }] },
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /Nothing was saved/);
      assert.match(text(result), /Account SID is required and cannot be cleared\. To replace the saved value, send the new one\. To end the agent's access, revoke it with the service it belongs to\./);
    }
    assert.equal(fake.paths().includes('/UserAgent/CredentialUpsert'), false);
  });
});

test('set_agent_credentials counts a field the template fills as set', async () => {
  // Twilio's account id comes from the template and is not shown, and the card reads filled.
  const fake = fakeClient({
    '/Credentials/Detail': credentialDetail,
    '/UserAgent/Detail': detail({ status: 0, credentials: { 'twilio-voice': { accountsid: '', holdstrategy: 'none', optional: false, _connected: false, _filled: true, _required_missing: false, _schema: { title: 'Twilio Voice' } } } }),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'twilio-voice' } });
    assert.notEqual(result.isError, true, text(result));
    const state = result.structuredContent.credential.status;
    assert.equal(state.filled, true);
    assert.deepEqual(state.missingFields, []);
    assert.match(text(result), /^\*\*On this agent:\*\* set$/m);
    assert.doesNotMatch(text(result), /missing Account SID/);
  });
});

test('manage_agent_custom_skill says from Wiro\'s answer whether a save restarts the agent', async () => {
  const restarts = /^The agent restarts to load the change, which takes about a minute\./;
  const saved = 'The new text is saved, and the agent was not restarted. A running agent usually takes a text or description edit without a restart; if its replies still follow the old text, control_agent with action restart loads the new one.';
  const notRestarted = 'The change is saved, but the agent was not restarted, so a running agent keeps its old settings until it restarts. control_agent with action restart loads them, and get_my_agent shows its status.';
  const descriptionSaved = 'The new description is saved, and the agent was not restarted. A running agent usually takes a description edit without a restart; control_agent with action restart loads it for certain.';
  const cases = [
    // A text edit Wiro sent to the running agent: no restart, and no promise that it landed.
    ['a text edit, not restarted', { key: 'cs-cron-my-task', value: 'Do it at nine.' }, false, 4, saved],
    ['a text and description edit, not restarted', { key: 'cs-cron-my-task', value: 'Do it at nine.', description: 'My nine o\'clock task' }, false, 4, saved],
    // Only the description moved: no new text to speak of.
    ['a description edit, not restarted', { key: 'cs-cron-my-task', description: 'My nine o\'clock task' }, false, 4, descriptionSaved],
    ['a description edit with the same text sent back', { key: 'cs-cron-my-task', value: 'Do my task.', description: 'My nine o\'clock task' }, false, 4, descriptionSaved],
    // A text edit Wiro could not send there restarts the agent.
    ['a text edit, restarted', { key: 'cs-cron-my-task', value: 'Do it at nine.' }, true, 4, restarts],
    ['a schedule change', { key: 'cs-cron-my-task', interval: '0 9 * * *' }, true, 4, restarts],
    ['a schedule change that did not restart', { key: 'cs-cron-my-task', interval: '0 9 * * *' }, false, 4, notRestarted],
    ['a new entry', { key: 'weekly-report', kind: 'scheduled_task', value: 'Summarize last week.' }, true, 4, restarts],
    ['a text edit of a stopped agent', { key: 'cs-cron-my-task', value: 'Do it at nine.' }, false, 0, /^The agent is stopped, so the change takes effect the next time it starts\.$/],
  ];
  for (const [name, args, restarting, status, note] of cases) {
    const fake = fakeClient({
      '/UserAgent/Detail': detail({ status }),
      '/UserAgent/CustomSkillUpsert': { result: true, errors: [], restarting },
    });
    await withClient(fake, async client => {
      const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, ...args } });
      assert.notEqual(result.isError, true, `${name}: ${text(result)}`);
      const out = result.structuredContent;
      assert.equal(out.restarting, restarting, name);
      if (typeof note === 'string') assert.equal(out.restart, note, name);
      else assert.match(out.restart, note, name);
      assert.ok(text(result).includes(`**Restart:** ${out.restart}`), name);
      if (!restarting) assert.doesNotMatch(out.restart, /restarts to load/, name);
    });
  }

  // The approval policy's text turns its gate on or off when the agent starts, so its edit restarts the agent.
  const policy = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [], restarting: true },
  });
  await withClient(policy, async client => {
    const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key: 'cs-approval-policy', value: 'Ask before any post.', confirm: true } });
    assert.notEqual(result.isError, true, text(result));
    assert.match(result.structuredContent.restart, restarts);
    assert.equal(result.structuredContent.restarting, true);
  });

  // An answer without the field goes by what the save changed.
  const older = fakeClient({
    '/UserAgent/Detail': detail(),
    '/UserAgent/CustomSkillUpsert': { result: true, errors: [] },
  });
  await withClient(older, async client => {
    const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, key: 'cs-cron-my-task', value: 'Do it at nine.' } });
    assert.match(result.structuredContent.restart, restarts);
    assert.equal(result.structuredContent.restarting, undefined);
  });

  // A Wiro that applies changes live says so, for every kind of change, the approval policy's included.
  const live = 'The running agent uses it from its next message, with no restart.';
  for (const [name, args] of [
    ['a new entry', { key: 'weekly-report', kind: 'scheduled_task', value: 'Summarize last week.' }],
    ['a schedule change', { key: 'cs-cron-my-task', interval: '0 9 * * *' }],
    ['a text edit', { key: 'cs-cron-my-task', value: 'Do it at nine.' }],
    ['the approval policy', { key: 'cs-approval-policy', value: 'Ask before any post.', confirm: true }],
  ]) {
    const fake = fakeClient({
      '/UserAgent/Detail': detail(),
      '/UserAgent/CustomSkillUpsert': { result: true, errors: [], restarting: false, live: true },
    });
    await withClient(fake, async client => {
      const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: { action: 'upsert', agent_guid: AGENT, ...args } });
      assert.notEqual(result.isError, true, `${name}: ${text(result)}`);
      assert.equal(result.structuredContent.restart, live, name);
      assert.equal(result.structuredContent.live, true, name);
      assert.equal(result.structuredContent.restarting, false, name);
    });
  }

  await withClient(fakeClient({}), async client => {
    const { tools } = await client.listTools();
    const description = tools.find(tool => tool.name === 'manage_agent_custom_skill').description;
    assert.match(description, /A running agent gets most changes without a restart; a few restart it, which takes about a minute\. The result says which happened\./);
    assert.doesNotMatch(description, /A running agent restarts for a new entry/);
  });
  const line = PLAYBOOKS.agents.split('\n').find(item => item.startsWith('- Most changes reach a running agent live'));
  assert.match(line, /every `manage_agent_custom_skill` change \(a new entry, its text, description, schedule or on\/off state, a rename, a delete or a revert, `cs-approval-policy` included\)/);
});

test('manage_agent_custom_skill rename, delete and revert say from Wiro\'s answer whether the running agent got the change live', async () => {
  const live = 'The running agent uses it from its next message, with no restart.';
  const restarts = /^The agent restarts to load the /;
  for (const [answer, expected, liveField] of [
    [{ restarting: false, live: true, restart: 'live' }, live, true],
    [{ restarting: true, live: false, restart: 'scheduled' }, restarts, undefined],
    // A Wiro that does not answer live goes by the agent's status, as before.
    [{}, restarts, undefined],
  ]) {
    const fake = fakeClient({
      '/UserAgent/Detail': detail(),
      '/UserAgent/CustomSkillRename': { result: true, errors: [], newskillkey: 'cs-cron-renamed-task', ...answer },
      '/UserAgent/CustomSkillDelete': { result: true, errors: [], ...answer },
      '/UserAgent/CustomSkillRevert': { result: true, errors: [], action: 'reverted', current_value: 'Do my task.', ...answer },
    });
    await withClient(fake, async client => {
      const calls = [
        { action: 'rename', agent_guid: AGENT, key: 'cs-cron-my-task', new_key: 'renamed-task' },
        { action: 'delete', agent_guid: AGENT, key: 'cs-cron-my-task', confirm: true },
        { action: 'revert', agent_guid: AGENT, key: 'cs-cron-my-task', source: 'preset', confirm: true },
      ];
      for (const args of calls) {
        const result = await client.callTool({ name: 'manage_agent_custom_skill', arguments: args });
        assert.notEqual(result.isError, true, `${args.action}: ${text(result)}`);
        const out = result.structuredContent;
        if (typeof expected === 'string') assert.equal(out.restart, expected, args.action);
        else assert.match(out.restart, expected, args.action);
        assert.equal(out.live, liveField, args.action);
        assert.equal(out.restarting, answer.restarting, args.action);
      }
    });
  }
});

test('set_agent_credentials does not count a list row that holds only a select as filled', async () => {
  // A template's blank Discord server row with only the reply mode picked: Wiro reads the card as not filled.
  const blankRows = { bottoken: '', allowedusers: [], guilds: [{ guildid: '', channelids: [], mode: 'mention' }], optional: false, _connected: false, _filled: false, _required_missing: true, _schema: { title: 'Discord' } };
  const entered = { ...blankRows, bottoken: 'bot-token', allowedusers: ['123456789012345678'], guilds: [{ guildid: SERVER, channelids: [], mode: 'mention' }], _filled: true, _required_missing: false };
  for (const [group, line, filled] of [
    [blankRows, /^\*\*On this agent:\*\* not complete; missing Discord Bot Token, Allowed Discord DM User IDs$/m, false],
    // A row with a server id is an entry, so Wiro reads the card as filled.
    [entered, /^\*\*On this agent:\*\* set$/m, true],
  ]) {
    const fake = fakeClient({
      '/Credentials/Detail': credentialDetail,
      '/UserAgent/Detail': detail({ status: 0, credentials: { discord: group } }),
    });
    await withClient(fake, async client => {
      const result = await client.callTool({ name: 'set_agent_credentials', arguments: { agent_guid: AGENT, credential: 'discord' } });
      assert.notEqual(result.isError, true, text(result));
      assert.match(text(result), line);
      assert.equal(result.structuredContent.credential.status.filled, filled);
      assert.doesNotMatch(JSON.stringify(result), /bot-token/);
    });
  }
});
