import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WiroApiError } from '../dist/client.js';
import { PLAYBOOKS, PLAYBOOK_TOPICS } from '../dist/playbooks.js';
import { createMcpServer, parseToolsets, SERVER_INSTRUCTIONS, TOOLSETS } from '../dist/server.js';

// Controls: the workspace's Spend Limits and Model Access rules. get_controls and
// check_model_access only read. manage_spend_limit and manage_model_access show a
// change summary from Wiro's Preview route first, and change something only when
// the call repeats that summary's nextAction with confirm: true and the version
// the user saw. Members of a team, and an older Wiro API, change nothing.

const textOf = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const linesOf = result => textOf(result).split('\n');

const TEAM = '0d9aade4-d31b-4b97-88f3-a90482f080ea';
const JANE = '4b7d6c1e-2f3a-4c5d-9e8f-0a1b2c3d4e01';
const BOB = '7c7d6c1e-2f3a-4c5d-9e8f-0a1b2c3d4e02';
const AGENT = '35c1ed58-0a1b-4c2d-8e3f-405162738495';
const MONTH_START = 1793491200; // 2026-11-01T00:00:00Z
const MONTH_END = 1796083200; // 2026-12-01T00:00:00Z
const DAY_START = 1795132800; // 2026-11-20T00:00:00Z
const DAY_END = 1795219200; // 2026-11-21T00:00:00Z
const OWN_KEY = 'own-key-never-shown';
const OTHER_KEY = 'other-key-never-shown';

const ADMIN = { type: 'team', teamguid: TEAM, canmanage: true };
const MEMBER = { type: 'team', teamguid: TEAM, canmanage: false };
const PERSONAL = { type: 'personal', teamguid: null, canmanage: true };
const CALLER = { surface: 'mcp', projectid: '48211' };

const CATEGORIES = [
  ['image', 'Image Generation'], ['video', 'Video Generation'], ['audio', 'Audio & Speech'], ['music', 'Music Generation'],
  ['3d', '3D Generation'], ['llm', 'LLM & Chat'], ['utilities', 'Utilities'],
].map(([category, label]) => ({ category, label, values: [`${category}-value`] }));

const limitRow = fields => ({
  guid: 'l-1', scope: 'account', target: '', period: 'month', amountusd: 500, alertpct: 80,
  periodstart: MONTH_START, resetsat: MONTH_END, createdat: 100, updatedat: 100, targetlabel: null, spentusd: 248.7,
  ...fields,
});

const ruleRow = fields => ({
  guid: 'r-1', scope: 'account', target: '', access: 'allow', categories: [], models: [],
  createdat: 100, updatedat: 100, targetlabel: null,
  ...fields,
});

const category = (key, access) => ({ category: key, label: CATEGORIES.find(entry => entry.category === key).label, access });

const limitList = (limits, workspace = ADMIN, caller = CALLER) => ({ result: true, errors: [], limits, workspace, ...(caller ? { caller } : {}) });
const ruleList = (rules, workspace = ADMIN, caller = CALLER) => ({ result: true, errors: [], rules, categories: CATEGORIES, workspace, ...(caller ? { caller } : {}) });

const ORGS = { result: true, errors: [], organizations: [{ guid: 'org-1', name: 'Acme Inc', teams: [{ guid: TEAM, name: 'Acme', role: 'admin' }] }] };
const PROJECTS = {
  result: true,
  errors: [],
  project: [
    { id: '7', name: 'Staging', apikey: OTHER_KEY, teamguid: TEAM },
    { id: '48211', name: 'Production', apikey: OWN_KEY, teamguid: TEAM },
    { id: '9', name: 'Twin', apikey: 'k-9', teamguid: TEAM },
    { id: '10', name: 'Twin', apikey: 'k-10', teamguid: TEAM },
  ],
};
const MEMBERS = {
  result: true,
  errors: [],
  member: [
    { useruuid: JANE, role: 'member', status: 'active', user: { firstname: 'Jane', lastname: 'Doe', email: 'jane@acme.test' } },
    { useruuid: null, role: 'member', status: 'pending', inviteemail: 'new@acme.test' },
    { useruuid: '9b2f6c1e-2f3a-4c5d-9e8f-0a1b2c3d4e09', role: 'member', status: 'removed', user: { email: 'gone@acme.test' } },
  ],
};
const AGENTS = { result: true, errors: [], useragents: [{ guid: AGENT, title: 'Sales Bot' }, { guid: 'aa2f6c1e-2f3a-4c5d-9e8f-0a1b2c3d4e00', title: 'Other' }] };

const NOT_FOUND_ROUTE = () => {
  throw new WiroApiError(404, JSON.stringify({ result: false, errors: [{ code: 0, message: 'Parsing url error.' }] }));
};

function fakeClient(routes) {
  const calls = [];
  const handle = async (path, body) => {
    calls.push({ path, body });
    const route = routes[path];
    if (route === undefined) throw new Error(`Unexpected call to ${path}`);
    return typeof route === 'function' ? route(body, calls) : structuredClone(route);
  };
  return {
    calls,
    paths: () => calls.map(call => call.path),
    post: async (path, body) => handle(path, body),
    postForm: async (path, form) => handle(path, form),
    isOwnApiKey: value => value === OWN_KEY,
  };
}

async function withClient(fake, callback, options) {
  const server = createMcpServer({ authType: 'apikey-only', ...fake }, options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // listTools first, so the client checks every structuredContent against the tool's output schema.
  await client.listTools();
  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** What SpendLimit/Preview answers: the row as Set would save it, and the one it replaces. */
function limitPreview(existing, spent, extra = {}) {
  return body => ({
    result: true,
    errors: [],
    preview: true,
    workspace: ADMIN,
    limit: limitRow({
      guid: existing?.guid ?? null,
      scope: body.scope,
      target: body.target,
      period: body.period,
      amountusd: body.amountusd,
      alertpct: body.alertpct,
      spentusd: spent,
      targetlabel: existing?.targetlabel ?? extra.targetlabel ?? null,
      periodstart: body.period === 'day' ? DAY_START : MONTH_START,
      resetsat: body.period === 'day' ? DAY_END : MONTH_END,
      createdat: existing?.createdat ?? null,
      updatedat: existing?.updatedat ?? null,
      ...(extra.heldusd ? { heldusd: extra.heldusd } : {}),
    }),
    existing: existing ?? null,
  });
}

/** What ModelAccess/Preview answers: the rule as Set would save it, with the models named by id. */
function rulePreview(existing, ids, extra = {}) {
  return body => ({
    result: true,
    errors: [],
    preview: true,
    workspace: ADMIN,
    rule: ruleRow({
      guid: existing?.guid ?? null,
      scope: body.scope,
      target: body.target,
      access: body.access,
      categories: body.categories.map(entry => category(entry.category, entry.access)),
      models: body.models.map(entry => ({ id: ids[entry.model]?.id ?? entry.model, model: ids[entry.model]?.model ?? null, access: entry.access })),
      targetlabel: existing?.targetlabel ?? null,
      createdat: existing?.createdat ?? null,
      updatedat: existing?.updatedat ?? null,
    }),
    existing: existing ?? null,
    ...extra,
  });
}

// ------------------------------------------------------------------ get_controls

test('get_controls shows each limit with what is left, each rule in plain words, and who can change them', async () => {
  const fake = fakeClient({
    '/SpendLimit/List': limitList([
      limitRow({ guid: 'l-acc', heldusd: 20, alertpct: 90 }),
      limitRow({
        guid: 'l-key', scope: 'project', target: '48211', targetlabel: 'Production', period: 'day', amountusd: 5, spentusd: 5.2,
        periodstart: DAY_START, resetsat: DAY_END, alertpct: null,
      }),
    ]),
    '/ModelAccess/List': ruleList([
      ruleRow({ guid: 'r-acc', categories: [category('video', 'block')], models: [{ id: '301', model: 'bytedance/seedance-v2-5-flash', title: 'Seedance', access: 'allow' }] }),
      ruleRow({
        guid: 'r-key', scope: 'project', target: '48211', targetlabel: 'Production', access: 'block',
        categories: [category('image', 'allow')],
        models: [{ id: '201', model: 'openai/gpt-6-2-astra', access: 'allow' }, { id: '202', model: null, access: 'block' }],
      }),
    ]),
    '/Organization/List': ORGS,
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = linesOf(result);
    for (const line of [
      '## Controls of this workspace',
      '**Workspace:** team `Acme` (`Acme Inc`); this connection acts as a team admin',
      '**Changes:** this connection can change these Spend Limits and Model Access rules, with manage_spend_limit and manage_model_access. Every change shows a summary first and waits for the user\'s yes.',
      '**This connection\'s runs count as:** surface `mcp` (the hosted MCP server at mcp.wiro.ai), with the API key of project id `48211`',
      '### Spend limits (2)',
      '- Monthly limit for the whole team: $248.70 of $500.00 used, $20.00 held by work still running, $231.30 left, alert email at 90%, resets December 1, 2026 at 00:00 UTC (limit_guid `l-acc`)',
      '- Daily limit for the API key of project `Production` (id `48211`), the key this connection uses: $5.20 of $5.00 used: used up, so new work it covers is refused until it resets, no alert email, resets November 21, 2026 at 00:00 UTC (limit_guid `l-key`)',
      '### Model Access rules (2)',
      '- Rule for the whole team: Every model except Video Generation; `bytedance/seedance-v2-5-flash` allowed by name (rule_guid `r-acc`)',
      '- Rule for the API key of project `Production` (id `48211`), the key this connection uses: Only Image Generation and `openai/gpt-6-2-astra`, except model 202, no longer on Wiro (rule_guid `r-key`)',
      'Dashboard: https://wiro.ai/panel/controls/spend-limits and https://wiro.ai/panel/controls/model-access',
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(result)}`);

    const data = result.structuredContent;
    assert.deepEqual(data.workspace, { kind: 'team', teamGuid: TEAM, teamName: 'Acme', organizationName: 'Acme Inc', role: 'admin', canManage: true });
    assert.deepEqual(data.caller, { surface: 'mcp', projectId: '48211' });
    assert.deepEqual(data.spendLimits[0], {
      guid: 'l-acc', scope: 'account', period: 'month', amountUsd: 500, spentUsd: 248.7, heldUsd: 20, leftUsd: 231.3, usedUp: false,
      alertPercent: 90, periodStart: '2026-11-01T00:00:00Z', resetsAt: '2026-12-01T00:00:00Z', updatedAt: 100,
    });
    assert.equal(data.spendLimits[1].thisConnection, true);
    assert.equal(data.spendLimits[1].usedUp, true);
    assert.equal(data.spendLimits[1].leftUsd, 0);
    assert.equal(data.modelAccessRules[0].summary, 'Every model except Video Generation; bytedance/seedance-v2-5-flash allowed by name');
    assert.equal(data.modelAccessRules[1].summary, 'Only Image Generation and openai/gpt-6-2-astra, except model 202, no longer on Wiro');
    assert.deepEqual(data.modelAccessRules[1].models[1], { id: '202', model: null, access: 'block' });
    assert.equal(data.categories.length, 7);
    assert.deepEqual(data.surfaces.map(entry => entry.surface), ['web', 'api', 'mcp', 'llm-gateway', 'extension', 'agent']);
    assert.match(data.surfaces.find(entry => entry.surface === 'api').description, /a local install of this server included/);
    assert.deepEqual(data.dashboard, { spendLimits: 'https://wiro.ai/panel/controls/spend-limits', modelAccess: 'https://wiro.ai/panel/controls/model-access' });
    assert.deepEqual(fake.paths().sort(), ['/ModelAccess/List', '/Organization/List', '/SpendLimit/List']);

    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'get_controls');
    assert.equal(tool.annotations.readOnlyHint, true);
  });
});

test('get_controls lists the spending by way in, member, key and agent, and the team\'s members', async () => {
  const fake = fakeClient({
    '/SpendLimit/List': limitList([]),
    '/ModelAccess/List': ruleList([]),
    '/Organization/List': ORGS,
    '/SpendLimit/Usage': body => ({
      result: true,
      errors: [],
      usage: {
        period: body.period,
        periodstart: MONTH_START,
        resetsat: MONTH_END,
        totalusd: 412.3,
        surfaces: [
          { surface: 'web', label: 'the dashboard', spentusd: 300.1 },
          { surface: 'api', label: 'the API', spentusd: 100 },
          { surface: 'mcp', label: 'MCP', spentusd: 12.2 },
          { surface: 'llm-gateway', label: 'the LLM gateway', spentusd: 0 },
          { surface: 'nonsense', label: 'x', spentusd: 9 },
        ],
        members: [{ useruuid: JANE, label: 'Jane Doe', spentusd: 200 }],
        projects: [{ projectid: '48211', label: 'Production', spentusd: 100 }],
        agents: [{ useragentguid: AGENT, label: 'Sales Bot', spentusd: 10.004 }],
      },
    }),
    '/Team/Member/List': MEMBERS,
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: { usage: 'month', members: true } });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = linesOf(result);
    for (const line of [
      'No spend limits: nothing caps this workspace\'s spending beyond its balance.',
      'No Model Access rules: every model can run.',
      '### Spending this month (since November 1, 2026 at 00:00 UTC)',
      '**Total:** $412.30',
      '- By way in: the dashboard (`web`) $300.10, the API (`api`) $100.00, MCP (`mcp`) $12.20',
      '- By team member: `Jane Doe` $200.00',
      '- By API key: `Production` (id `48211`), this connection\'s key $100.00',
      '- By agent: `Sales Bot` $10.00',
      '### Team members (1)',
      `- \`Jane Doe\` (member): user id \`${JANE}\``,
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(result)}`);
    const { usage, members } = result.structuredContent;
    assert.equal(usage.totalUsd, 412.3);
    assert.deepEqual(usage.surfaces.map(row => row.surface), ['web', 'api', 'mcp', 'llm-gateway']);
    assert.deepEqual(usage.projects, [{ projectId: '48211', name: 'Production', thisConnection: true, spentUsd: 100 }]);
    assert.deepEqual(members, [{ useruuid: JANE, name: 'Jane Doe', role: 'member' }]);
    // The members' e-mail addresses stay out of the answer.
    assert.doesNotMatch(JSON.stringify(result), /jane@acme\.test|new@acme\.test/);
    assert.deepEqual(fake.calls.find(call => call.path === '/SpendLimit/Usage').body, { period: 'month' });
  });
});

test('get_controls shows what running work holds per way in, member, key and agent, also where nothing was charged yet', async () => {
  const fake = fakeClient({
    '/SpendLimit/List': limitList([]),
    '/ModelAccess/List': ruleList([]),
    '/Organization/List': ORGS,
    '/SpendLimit/Usage': {
      result: true,
      errors: [],
      usage: {
        period: 'month',
        periodstart: MONTH_START,
        resetsat: MONTH_END,
        totalusd: 12.5,
        heldusd: 42.5,
        surfaces: [
          { surface: 'web', label: 'the dashboard', spentusd: 0 },
          { surface: 'mcp', label: 'MCP', spentusd: 12.5, heldusd: 12.5 },
          { surface: 'api', label: 'the API', spentusd: 0, heldusd: 30 },
        ],
        members: [
          { useruuid: BOB, label: 'Bob Roe', spentusd: 12.5, heldusd: 12.5 },
          // Jane's renders are still running: nothing charged yet, but they hold $30.
          { useruuid: JANE, label: 'Jane Doe', spentusd: 0, heldusd: 30 },
        ],
        projects: [{ projectid: '7', label: 'Staging', spentusd: 0, heldusd: 30 }],
        agents: [],
      },
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: { usage: 'month' } });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = linesOf(result);
    for (const line of [
      '**Total:** $12.50',
      '**Held by work still running:** $42.50',
      '- By way in: MCP (`mcp`) $12.50 ($12.50 held by work still running), the API (`api`) $0.00 ($30.00 held by work still running)',
      '- By team member: `Bob Roe` $12.50 ($12.50 held by work still running), `Jane Doe` $0.00 ($30.00 held by work still running)',
      '- By API key: `Staging` (id `7`) $0.00 ($30.00 held by work still running)',
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(result)}`);
    const { usage } = result.structuredContent;
    assert.deepEqual(usage.members.find(row => row.useruuid === JANE), { useruuid: JANE, name: 'Jane Doe', spentUsd: 0, heldUsd: 30 });
    assert.deepEqual(usage.surfaces.find(row => row.surface === 'web'), { surface: 'web', label: 'the dashboard', spentUsd: 0 });
    assert.equal(usage.heldUsd, 42.5);
  });
});

test('get_controls marks the member limit and rule this connection acts under, from its key\'s creator', async () => {
  const fake = fakeClient({
    '/SpendLimit/List': limitList([
      limitRow({ guid: 'l-bob', scope: 'member', target: BOB, targetlabel: 'Bob Roe', amountusd: 100, spentusd: 100 }),
      limitRow({ guid: 'l-jane', scope: 'member', target: JANE, targetlabel: 'Jane Doe', amountusd: 100, spentusd: 100 }),
    ]),
    '/ModelAccess/List': ruleList([
      ruleRow({ guid: 'r-bob', scope: 'member', target: BOB, targetlabel: 'Bob Roe', categories: [category('video', 'block')] }),
    ]),
    '/Organization/List': ORGS,
    // Project/List rows name each project's creator; this connection's key is project 48211, which Bob created.
    '/Project/List': { ...PROJECTS, project: PROJECTS.project.map(row => ({ ...row, uuid: row.id === '48211' ? BOB : JANE })) },
    '/Team/Member/List': { ...MEMBERS, member: [...MEMBERS.member, { useruuid: BOB, role: 'admin', status: 'active', user: { firstname: 'Bob', lastname: 'Roe', email: 'bob@acme.test' } }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: { members: true } });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = linesOf(result);
    for (const line of [
      `**This connection's runs count as:** surface \`mcp\` (the hosted MCP server at mcp.wiro.ai), with the API key of project id \`48211\`, as team member \`Bob Roe\` (user id \`${BOB}\`)`,
      `- Monthly limit for team member \`Bob Roe\` (user id \`${BOB}\`), the person this connection acts as: $100.00 of $100.00 used: used up, so new work it covers is refused until it resets, alert email at 80%, resets December 1, 2026 at 00:00 UTC (limit_guid \`l-bob\`)`,
      `- Monthly limit for team member \`Jane Doe\` (user id \`${JANE}\`): $100.00 of $100.00 used: used up, so new work it covers is refused until it resets, alert email at 80%, resets December 1, 2026 at 00:00 UTC (limit_guid \`l-jane\`)`,
      `- Rule for team member \`Bob Roe\` (user id \`${BOB}\`), the person this connection acts as: Every model except Video Generation (rule_guid \`r-bob\`)`,
      `- \`Bob Roe\` (admin): user id \`${BOB}\`, the person this connection acts as`,
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(result)}`);
    const data = result.structuredContent;
    assert.deepEqual(data.caller, { surface: 'mcp', projectId: '48211', memberUuid: BOB });
    assert.equal(data.spendLimits.find(row => row.guid === 'l-bob').thisConnection, true);
    assert.equal(data.spendLimits.find(row => row.guid === 'l-jane').thisConnection, undefined);
    assert.equal(data.modelAccessRules[0].thisConnection, true);
    assert.equal(data.members.find(member => member.useruuid === BOB).thisConnection, true);
    // Project/List rows carry each key; no output does.
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${OWN_KEY}|${OTHER_KEY}|k-9|k-10`));
  });

  // Without a member limit or rule there is nothing to mark, so the projects are not read.
  const plain = fakeClient({ '/SpendLimit/List': limitList([limitRow({ guid: 'l-acc' })]), '/ModelAccess/List': ruleList([]), '/Organization/List': ORGS });
  await withClient(plain, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(plain.paths().includes('/Project/List'), false);
  });

  // Projects that cannot be read mark nothing, and the rest stands.
  const unread = fakeClient({
    '/SpendLimit/List': limitList([limitRow({ guid: 'l-bob', scope: 'member', target: BOB, targetlabel: 'Bob Roe' })]),
    '/ModelAccess/List': ruleList([]),
    '/Organization/List': ORGS,
    '/Project/List': () => { throw new WiroApiError(502, 'Bad gateway'); },
  });
  await withClient(unread, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.spendLimits[0].thisConnection, undefined);
    assert.deepEqual(result.structuredContent.caller, { surface: 'mcp', projectId: '48211' });
  });
});

test('get_controls tells a member they can only read, and each part stands alone', async () => {
  const fake = fakeClient({
    '/SpendLimit/List': limitList([limitRow({ guid: 'l-acc' })], MEMBER),
    '/ModelAccess/List': { result: false, errors: [{ code: 0, message: 'Model Access rules could not be read. Try again in a moment.' }] },
    '/Organization/List': { result: true, errors: [], organizations: [{ guid: 'org-1', name: 'Acme Inc', teams: [{ guid: TEAM, name: 'Acme', role: 'member' }] }] },
    '/SpendLimit/Usage': { result: false, errors: [{ code: 0, message: 'Spending could not be read. Try again in a moment.' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: { usage: 'day' } });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = linesOf(result);
    assert.ok(lines.includes('**Workspace:** team `Acme` (`Acme Inc`); this connection acts as a team member'), textOf(result));
    assert.ok(lines.includes('**Changes:** this connection can only read them: a team admin or the organization\'s owner changes them, with their own connection or in the Wiro dashboard.'), textOf(result));
    assert.ok(lines.includes('The Model Access rules could not be read: Model Access rules could not be read. Try again in a moment.'), textOf(result));
    assert.ok(lines.includes('The spending could not be read: Spending could not be read. Try again in a moment.'), textOf(result));
    assert.equal(result.structuredContent.workspace.canManage, false);
    assert.equal(result.structuredContent.spendLimits.length, 1);
    assert.equal(result.structuredContent.modelAccessRules, undefined);
    assert.match(result.structuredContent.modelAccessError, /could not be read/);
    assert.match(result.structuredContent.usageError, /could not be read/);
  });

  const broken = fakeClient({
    '/SpendLimit/List': () => { throw new WiroApiError(502, 'Bad gateway'); },
    '/ModelAccess/List': () => { throw new WiroApiError(502, 'Bad gateway'); },
    '/Organization/List': ORGS,
  });
  await withClient(broken, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /The controls could not be read: Wiro API error 502/);
  });
});

// ------------------------------------------------------------- check_model_access

const BLOCKED_BY_KEY = 'This API key can only use selected models, and openai/gpt-6-2-astra is not one of them. Model Access rules decide which models can run.';

function checkAnswer(decisions, allowed = false, message = BLOCKED_BY_KEY) {
  return { result: true, errors: [], check: { model: 'openai/gpt-6-2-astra', categories: ['llm'], allowed, message: allowed ? null : message, rules: decisions } };
}

const ACCOUNT_RULE = ruleRow({ guid: 'r-acc', categories: [category('video', 'block')] });
const KEY_RULE = ruleRow({ guid: 'r-key', scope: 'project', target: '48211', targetlabel: 'Production', access: 'block', categories: [category('image', 'allow')] });

test('check_model_access checks a run through this connection and offers the change that would allow the model', async () => {
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([ACCOUNT_RULE, KEY_RULE]),
    '/ModelAccess/Check': checkAnswer([
      { rule: ACCOUNT_RULE, access: 'allow', by: 'default', category: null },
      { rule: KEY_RULE, access: 'block', by: 'default', category: null },
    ]),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra' } });
    assert.notEqual(result.isError, true, textOf(result));
    // A run through this connection: its own surface and key, as Wiro counts them.
    assert.deepEqual(fake.calls.find(call => call.path === '/ModelAccess/Check').body, { model: 'openai/gpt-6-2-astra', surface: 'mcp', project: '48211' });
    const lines = linesOf(result);
    for (const line of [
      '## Model Access check: `openai/gpt-6-2-astra`',
      '**Run checked:** a run through this connection: surface `mcp` (the hosted MCP server at mcp.wiro.ai), with this connection\'s API key (project id `48211`)',
      '**Categories of this model:** LLM & Chat',
      `**Blocked.** Wiro refuses such a run with error code 92 before it starts: ${BLOCKED_BY_KEY}`,
      '**Rules that apply (2), widest first:**',
      '- Rule for the whole team: allows it, as it does not name this model, and allows every model it does not name. The rule: Every model except Video Generation.',
      '- Rule for the API key of project `Production` (id `48211`): blocks it, as it lets only the models it names run, and this model is not one of them. The rule: Only Image Generation.',
      'This connection can change the rules, after the user confirms a change summary. A model the rules allow is the other way out.',
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(result)}`);
    const data = result.structuredContent;
    assert.equal(data.allowed, false);
    assert.equal(data.message, BLOCKED_BY_KEY);
    assert.deepEqual(data.context, { surface: 'mcp', project: { id: '48211', thisConnection: true }, thisConnection: true });
    assert.deepEqual(data.rules.map(rule => [rule.scope, rule.decides, rule.by]), [['account', 'allow', 'default'], ['project', 'block', 'default']]);
    assert.deepEqual(data.nextAction, {
      tool: 'manage_model_access',
      arguments: { action: 'update', scope: 'project', project: '48211', models: [{ model: 'openai/gpt-6-2-astra', access: 'allow' }] },
      reason: 'Shows what allowing this model in that rule changes; nothing changes without the user\'s yes.',
    });
    // The fix is a change summary: it never carries confirm.
    assert.equal('confirm' in data.nextAction.arguments, false);
    assert.deepEqual(data.fixes, [data.nextAction]);
  });
});

test('check_model_access says every blocking rule must change, and gives no fix to a connection that only reads', async () => {
  const blockingAccount = ruleRow({ guid: 'r-acc', categories: [category('llm', 'block')] });
  const decisions = [
    { rule: blockingAccount, access: 'block', by: 'category', category: 'llm' },
    { rule: KEY_RULE, access: 'block', by: 'default', category: null },
  ];
  const admin = fakeClient({ '/ModelAccess/List': ruleList([blockingAccount, KEY_RULE]), '/ModelAccess/Check': checkAnswer(decisions) });
  await withClient(admin, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra' } });
    assert.ok(linesOf(result).includes('2 rules block it, and every rule that applies must allow a model, so each of them must change: a narrower rule cannot open what a wider one blocks.'), textOf(result));
    assert.ok(linesOf(result).includes('- Rule for the whole team: blocks it, as it blocks LLM & Chat, and this model is in it. The rule: Every model except LLM & Chat.'), textOf(result));
    assert.deepEqual(result.structuredContent.fixes.map(fix => fix.arguments.scope), ['account', 'project']);
    assert.deepEqual(result.structuredContent.nextAction.arguments, { action: 'update', scope: 'account', models: [{ model: 'openai/gpt-6-2-astra', access: 'allow' }] });
  });

  const member = fakeClient({ '/ModelAccess/List': ruleList([blockingAccount, KEY_RULE], MEMBER), '/ModelAccess/Check': checkAnswer(decisions) });
  await withClient(member, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra' } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.canManage, false);
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.equal(result.structuredContent.fixes, undefined);
    assert.ok(linesOf(result).includes('This connection can only read the rules: a team admin or the organization\'s owner can change them, with their own connection or at https://wiro.ai/panel/controls/model-access. Or the user can pick another model.'), textOf(result));
    assert.doesNotMatch(textOf(result), /\*\*Next:\*\*/);
  });

  const allowed = fakeClient({ '/ModelAccess/List': ruleList([]), '/ModelAccess/Check': checkAnswer([], true) });
  await withClient(allowed, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra' } });
    assert.equal(result.structuredContent.allowed, true);
    assert.equal(result.structuredContent.message, null);
    assert.ok(linesOf(result).includes('**Allowed.** No Model Access rule applies to this run, so every model can run.'), textOf(result));
    assert.equal(result.structuredContent.nextAction, undefined);
  });
});

test('check_model_access finds a member by e-mail and an agent by name, and checks the run they name', async () => {
  const member = fakeClient({ '/ModelAccess/List': ruleList([]), '/Team/Member/List': MEMBERS, '/ModelAccess/Check': checkAnswer([], true) });
  await withClient(member, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra', member: 'Jane@Acme.test' } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(member.calls.find(call => call.path === '/Team/Member/List').body, { teamguid: TEAM });
    // A member's own run: the dashboard, with no key, unless a project or surface is named.
    assert.deepEqual(member.calls.find(call => call.path === '/ModelAccess/Check').body, { model: 'openai/gpt-6-2-astra', surface: 'web', member: JANE });
    assert.ok(linesOf(result).includes('**Run checked:** a run by team member `Jane Doe` through surface `web` (the Wiro dashboard, with Studio and the Workflow Agent used there)'), textOf(result));
  });

  const agent = fakeClient({ '/ModelAccess/List': ruleList([]), '/UserAgent/MyAgents': AGENTS, '/ModelAccess/Check': checkAnswer([], true) });
  await withClient(agent, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra', agent: 'sales bot' } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(agent.calls.find(call => call.path === '/ModelAccess/Check').body, { model: 'openai/gpt-6-2-astra', surface: 'agent', agent: AGENT });
    assert.deepEqual(result.structuredContent.context, { surface: 'agent', agent: { guid: AGENT, name: 'Sales Bot' }, thisConnection: false });
  });

  // An unknown name is refused before any check, with the tool that lists the agents.
  const unknown = fakeClient({ '/ModelAccess/List': ruleList([]), '/UserAgent/MyAgents': AGENTS });
  await withClient(unknown, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra', agent: 'Nobody' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No agent named `Nobody` is in this workspace\. list_my_agents lists the agents with their guids\./);
    assert.equal(unknown.paths().includes('/ModelAccess/Check'), false);
  });
});

test('check_model_access checks a way in that comes with a key with this connection\'s key, and says when a member\'s key is left out', async () => {
  // This connection's key only lets Image Generation run; the gateway on its own blocks nothing.
  const keyOnly = ruleRow({ guid: 'r-key', scope: 'project', target: '48211', targetlabel: 'Production', access: 'block', categories: [category('image', 'allow')] });
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([keyOnly]),
    '/Team/Member/List': MEMBERS,
    '/ModelAccess/Check': body => (body.project === '48211'
      ? checkAnswer([{ rule: keyOnly, access: 'block', by: 'default', category: null }])
      : checkAnswer([], true)),
  });
  await withClient(fake, async client => {
    const gateway = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra', surface: 'llm-gateway' } });
    assert.notEqual(gateway.isError, true, textOf(gateway));
    assert.deepEqual(fake.calls.at(-1).body, { model: 'openai/gpt-6-2-astra', surface: 'llm-gateway', project: '48211' });
    assert.equal(gateway.structuredContent.allowed, false);
    assert.ok(linesOf(gateway).includes('**Run checked:** a run through surface `llm-gateway` (the OpenAI and Anthropic compatible LLM gateway), with this connection\'s API key (project id `48211`)'), textOf(gateway));
    assert.deepEqual(gateway.structuredContent.context, { surface: 'llm-gateway', project: { id: '48211', thisConnection: true }, thisConnection: false });

    // A member's key is not known: the check leaves its rule out and says so.
    const member = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra', member: 'jane@acme.test', surface: 'api' } });
    assert.notEqual(member.isError, true, textOf(member));
    assert.deepEqual(fake.calls.at(-1).body, { model: 'openai/gpt-6-2-astra', surface: 'api', member: JANE });
    assert.ok(linesOf(member).includes('A run through the API comes with an API key, and that key\'s own rule is not part of this check. A key counts as the person who created it: to include its rule, name a key this member created with project.'), textOf(member));
    assert.equal(member.structuredContent.context.keyLeftOut, true);

    // The dashboard comes with no key, so none is added.
    await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra', surface: 'web' } });
    assert.deepEqual(fake.calls.at(-1).body, { model: 'openai/gpt-6-2-astra', surface: 'web' });
  });
});

test('check_model_access describes the run Wiro says it checked: a key counts as the person who created it', async () => {
  const janeVideo = ruleRow({ guid: 'r-jane', scope: 'member', target: JANE, targetlabel: 'Jane Doe', categories: [category('video', 'block')] });
  const checked = context => body => ({
    result: true,
    errors: [],
    check: { model: 'bytedance/seedance-v2-5-flash', categories: ['video'], allowed: true, message: null, rules: [], context: context(body) },
  });
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([janeVideo]),
    '/Team/Member/List': MEMBERS,
    '/UserAgent/MyAgents': AGENTS,
    // Staging (project 7) was created by Bob, and so is the key the agent runs with.
    '/ModelAccess/Check': checked(body => ({
      surface: body.agent ? 'agent' : body.surface,
      member: { useruuid: BOB, label: 'Bob Roe' },
      project: body.project || body.agent ? { projectid: body.agent ? '7' : body.project, label: body.project === '48211' ? 'Production' : 'Staging' } : null,
      agent: body.agent ? { useragentguid: AGENT, label: 'Sales Bot' } : null,
    })),
  });
  await withClient(fake, async client => {
    const staging = await client.callTool({ name: 'check_model_access', arguments: { model: 'bytedance/seedance-v2-5-flash', member: 'jane@acme.test', project: '7' } });
    assert.notEqual(staging.isError, true, textOf(staging));
    const lines = linesOf(staging);
    for (const line of [
      '**Run checked:** a run by team member `Bob Roe` through surface `api` (calls with an API key, a local install of this server included), with the API key of project `Staging` (id `7`)',
      'A run with an API key counts as the person who created the key, so this checked a run by team member `Bob Roe`, not by team member `Jane Doe`. For that member\'s own runs, name a key they created with project, or leave out project and agent.',
      '**Allowed.** No Model Access rule applies to this run, so every model can run.',
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(staging)}`);
    assert.doesNotMatch(textOf(staging), /a run by team member `Jane Doe`/);
    assert.deepEqual(staging.structuredContent.context, { surface: 'api', project: { id: '7', name: 'Staging' }, member: { uuid: BOB, name: 'Bob Roe' }, thisConnection: false });

    const agent = await client.callTool({ name: 'check_model_access', arguments: { model: 'bytedance/seedance-v2-5-flash', agent: 'Sales Bot' } });
    assert.ok(linesOf(agent).includes(`**Run checked:** a run that agent \`Sales Bot\` (guid \`${AGENT}\`) starts, with the API key of project \`Staging\` (id \`7\`), as team member \`Bob Roe\``), textOf(agent));

    // A run through this connection names the member it counts as too.
    const own = await client.callTool({ name: 'check_model_access', arguments: { model: 'bytedance/seedance-v2-5-flash' } });
    assert.ok(linesOf(own).includes('**Run checked:** a run through this connection: surface `mcp` (the hosted MCP server at mcp.wiro.ai), with this connection\'s API key (project id `48211`), as team member `Bob Roe`'), textOf(own));
    assert.deepEqual(own.structuredContent.context, { surface: 'mcp', project: { id: '48211', name: 'Production', thisConnection: true }, member: { uuid: BOB, name: 'Bob Roe' }, thisConnection: true });
  });
});

test('check_model_access without Wiro\'s caller field finds this connection\'s key and says which surface it assumed', async () => {
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([], ADMIN, null),
    '/Project/List': PROJECTS,
    '/ModelAccess/Check': checkAnswer([], true),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra' } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(fake.calls.find(call => call.path === '/ModelAccess/Check').body, { model: 'openai/gpt-6-2-astra', surface: 'api', project: '48211' });
    assert.match(textOf(result), /Wiro did not say which surface this connection counts as, so this checked api\./);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${OWN_KEY}|${OTHER_KEY}`));
  });
});

test('check_model_access refuses a run that cannot happen, and points an unknown model to search_models', async () => {
  const fake = fakeClient({});
  await withClient(fake, async client => {
    const agentOnWeb = await client.callTool({ name: 'check_model_access', arguments: { model: 'a/b', agent: AGENT, surface: 'web' } });
    assert.equal(agentOnWeb.isError, true);
    assert.match(textOf(agentOnWeb), /A run an agent starts counts as surface agent/);
    const keyOnWeb = await client.callTool({ name: 'check_model_access', arguments: { model: 'a/b', project: '48211', surface: 'web' } });
    assert.equal(keyOnWeb.isError, true);
    assert.match(textOf(keyOnWeb), /A dashboard run \(surface web\) uses no API key/);
    assert.deepEqual(fake.calls, []);
  });
  const unknown = fakeClient({ '/ModelAccess/List': ruleList([]), '/ModelAccess/Check': { result: false, errors: [{ code: 0, message: 'acme/nothing is not a model on Wiro.' }] } });
  await withClient(unknown, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'acme/nothing' } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nacme/nothing is not a model on Wiro. search_models finds a model\'s owner/slug.');
  });
});

// ------------------------------------------------------------- manage_spend_limit

test('manage_spend_limit shows a change summary from Preview, then saves on the confirmed repeat', async () => {
  let existing = null;
  const fake = fakeClient({
    '/SpendLimit/List': () => limitList(existing ? [existing] : []),
    '/SpendLimit/Preview': body => limitPreview(existing, 312.4)(body),
    '/SpendLimit/Set': body => {
      existing = limitRow({ guid: 'l-new', amountusd: body.amountusd, alertpct: body.alertpct, spentusd: 312.4, createdat: 500, updatedat: 500 });
      return { result: true, errors: [], limit: existing };
    },
  });
  await withClient(fake, async client => {
    const preview = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 500 } });
    assert.notEqual(preview.isError, true, textOf(preview));
    assert.deepEqual(fake.paths(), ['/SpendLimit/List', '/SpendLimit/Preview']);
    assert.deepEqual(fake.calls[1].body, { scope: 'account', target: '', period: 'month', amountusd: 500, alertpct: 80 });
    const data = preview.structuredContent;
    assert.equal(data.outcome, 'preview');
    assert.equal(data.before, null);
    assert.equal(data.after.amountUsd, 500);
    assert.equal(data.after.spentUsd, 312.4);
    assert.equal(data.after.leftUsd, 187.6);
    assert.equal(data.usedUpAtOnce, false);
    assert.equal(data.alertRecipients, 'the team\'s admins and the organization\'s owner');
    assert.match(data.nextAction.arguments.summary_id, /^[0-9a-f]{32}$/);
    assert.deepEqual(data.nextAction, {
      tool: 'manage_spend_limit',
      arguments: { action: 'set', scope: 'account', period: 'month', amount_usd: 500, alert_percent: 80, confirm: true, updated_at: 0, summary_id: data.nextAction.arguments.summary_id },
      reason: 'Ask the user to confirm this change first.',
    });
    const lines = linesOf(preview);
    for (const line of [
      '## Set a spend limit? (nothing changed yet)',
      '**Covers:** the whole team',
      '**Before:** no monthly limit',
      '**After:** $500.00 a month, alert email at 80%',
      '**This month so far:** $312.40 of $500.00 used, $187.60 left; resets December 1, 2026 at 00:00 UTC',
      '**Emails:** an alert at 80% and an email when the limit is used up go to the team\'s admins and the organization\'s owner',
      '- It counts all of this month\'s spending since November 1, 2026 at 00:00 UTC, also what was spent before the limit was set.',
      '- It covers this connection\'s runs too.',
      'Nothing has changed yet. Show this to the user and wait for a clear yes.',
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(preview)}`);

    const saved = await client.callTool({ name: 'manage_spend_limit', arguments: data.nextAction.arguments });
    assert.notEqual(saved.isError, true, textOf(saved));
    assert.equal(saved.structuredContent.outcome, 'saved');
    assert.deepEqual(fake.paths().slice(2), ['/SpendLimit/List', '/SpendLimit/Preview', '/SpendLimit/Set']);
    assert.deepEqual(fake.calls[4].body, { scope: 'account', target: '', period: 'month', amountusd: 500, alertpct: 80 });
    assert.ok(linesOf(saved).includes('**Limit:** $500.00 a month, alert email at 80%'), textOf(saved));
    assert.ok(linesOf(saved).includes('- It applies to new work from now on. Work already running finishes and is charged, except a realtime session or a voice call, which ends after the turn that uses the limit up.'), textOf(saved));

    // Asking again for what is set now changes nothing and makes no Preview or Set call.
    const again = await client.callTool({ name: 'manage_spend_limit', arguments: data.nextAction.arguments });
    assert.equal(again.structuredContent.outcome, 'unchanged');
    assert.deepEqual(fake.paths().slice(5), ['/SpendLimit/List']);
    assert.match(textOf(again), /The monthly limit of \$500\.00 for the whole team is already set, with alert email at 80%\. Nothing was changed\./);
  });
});

test('manage_spend_limit refuses a team member at the summary, with no Preview or Set call', async () => {
  const fake = fakeClient({ '/SpendLimit/List': limitList([limitRow({ guid: 'l-acc' })], MEMBER) });
  await withClient(fake, async client => {
    for (const args of [
      { action: 'set', scope: 'account', amount_usd: 900 },
      { action: 'set', scope: 'member', member: JANE, amount_usd: 10 },
      { action: 'remove', limit_guid: 'l-acc' },
      { action: 'set', scope: 'account', amount_usd: 900, confirm: true, updated_at: 100 },
    ]) {
      const result = await client.callTool({ name: 'manage_spend_limit', arguments: args });
      assert.notEqual(result.isError, true, textOf(result));
      assert.equal(result.structuredContent.outcome, 'refused');
      assert.equal(result.structuredContent.nextAction, undefined);
      assert.equal(result.structuredContent.workspace.canManage, false);
      assert.equal(textOf(result), '## Not changed\n\nOnly a team admin or the organization\'s owner can change this team\'s spend limits, and this connection acts as a team member without those rights. Nothing was changed. Ask a team admin to do it, with their own connection or at https://wiro.ai/panel/controls/spend-limits.');
    }
    assert.deepEqual([...new Set(fake.paths())], ['/SpendLimit/List']);
  });
});

test('manage_spend_limit keeps the alert when it is left out, and sends null to turn it off', async () => {
  const key = limitRow({ guid: 'l-key', scope: 'project', target: '48211', targetlabel: 'Production', period: 'day', amountusd: 5, alertpct: 90, spentusd: 1, periodstart: DAY_START, resetsat: DAY_END });
  const fake = fakeClient({ '/SpendLimit/List': limitList([key]), '/SpendLimit/Preview': body => limitPreview(key, 1)(body) });
  await withClient(fake, async client => {
    // The key's only limit is daily, so that is the period; the key is this connection's own.
    const raised = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'project', amount_usd: 10.004 } });
    assert.notEqual(raised.isError, true, textOf(raised));
    assert.deepEqual(fake.calls[1].body, { scope: 'project', target: '48211', period: 'day', amountusd: 10, alertpct: 90 });
    assert.deepEqual(raised.structuredContent.target, { scope: 'project', target: '48211', targetName: 'Production', thisConnection: true });
    assert.equal(raised.structuredContent.nextAction.arguments.updated_at, 100);
    assert.equal(raised.structuredContent.nextAction.arguments.project, '48211');
    const notes = raised.structuredContent.notes;
    assert.ok(notes.includes('The amount is rounded to cents: $10.00.'), notes.join('\n'));
    assert.ok(notes.includes('This is the key this connection uses: once the limit is used up, this connection\'s runs stop too until it resets.'), notes.join('\n'));
    assert.ok(linesOf(raised).includes('**Before:** $5.00 a day, alert email at 90%'), textOf(raised));
    assert.ok(linesOf(raised).includes('**Today so far:** $1.00 of $10.00 used, $9.00 left; resets November 21, 2026 at 00:00 UTC'), textOf(raised));
    assert.ok(linesOf(raised).includes('**Emails:** an alert at 90% and an email when the limit is used up go to the team\'s admins and the organization\'s owner, and the person who created the key'), textOf(raised));

    const quiet = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', limit_guid: 'l-key', amount_usd: 5, alert_percent: null } });
    assert.notEqual(quiet.isError, true, textOf(quiet));
    assert.deepEqual(fake.calls[3].body, { scope: 'project', target: '48211', period: 'day', amountusd: 5, alertpct: null });
    assert.equal(quiet.structuredContent.nextAction.arguments.alert_percent, null);
    assert.ok(quiet.structuredContent.notes.includes('No alert email goes out before the limit is used up.'));
    assert.ok(linesOf(quiet).includes('**Emails:** no alert before the limit is used up; an email when it is used up goes to the team\'s admins and the organization\'s owner, and the person who created the key'), textOf(quiet));
  });
});

test('manage_spend_limit asks for the period when a target has both, and warns when a new limit is used up at once', async () => {
  const both = [
    limitRow({ guid: 'l-m', scope: 'surface', target: 'llm-gateway', targetlabel: 'the LLM gateway', amountusd: 100 }),
    limitRow({ guid: 'l-d', scope: 'surface', target: 'llm-gateway', targetlabel: 'the LLM gateway', period: 'day', amountusd: 10, periodstart: DAY_START, resetsat: DAY_END }),
  ];
  const fake = fakeClient({ '/SpendLimit/List': limitList(both), '/SpendLimit/Preview': body => limitPreview(both.find(row => row.period === body.period), 60)(body) });
  await withClient(fake, async client => {
    const ambiguous = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'surface', surface: 'llm-gateway', amount_usd: 50 } });
    assert.equal(ambiguous.isError, true);
    assert.equal(textOf(ambiguous), '## Error\n\nThe LLM gateway (surface `llm-gateway`) has a monthly and a daily limit: say which one with period. Nothing was changed.');
    const lowered = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'surface', surface: 'llm-gateway', period: 'month', amount_usd: 50 } });
    assert.notEqual(lowered.isError, true, textOf(lowered));
    assert.equal(lowered.structuredContent.usedUpAtOnce, true);
    assert.deepEqual(lowered.structuredContent.warnings, ['It is used up at once: $60.00 was already spent this month, so new work it covers is refused until it resets December 1, 2026 at 00:00 UTC.']);
    assert.ok(lowered.structuredContent.notes.includes('The daily limit of $10.00 for the same target stays as it is, and both apply.'));
  });
  // A list that cannot be read stops the change before any summary.
  const unread = fakeClient({ '/SpendLimit/List': () => { throw new WiroApiError(502, 'Bad gateway'); } });
  await withClient(unread, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 50 } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nThe spend limits could not be read (Wiro API error 502: Bad gateway), so nothing was changed. Try again in a moment.');
    assert.deepEqual(unread.paths(), ['/SpendLimit/List']);
  });
});

test('manage_spend_limit refuses an amount under a cent and arguments that do not fit, before any call', async () => {
  const fake = fakeClient({ '/SpendLimit/List': limitList([]) });
  await withClient(fake, async client => {
    const cases = [
      [{ action: 'set', scope: 'account', amount_usd: 0.004 }, 'amount_usd must be at least $0.01. Nothing was changed.'],
      [{ action: 'set', scope: 'account' }, 'set needs amount_usd (the limit in USD), or alert_percent alone to change only the alert of a limit that exists. Nothing was changed.'],
      [{ action: 'remove', scope: 'account', amount_usd: 5 }, 'remove takes no amount_usd or alert_percent. Nothing was changed.'],
      [{ action: 'set', amount_usd: 5 }, 'Name the limit: scope with its target (member, project, surface or agent), or limit_guid from get_controls. Nothing was changed.'],
      [{ action: 'set', scope: 'account', member: JANE, amount_usd: 5 }, 'Scope account covers the whole wallet and takes no `member`. For one member, use scope member. Nothing was changed.'],
      [{ action: 'set', scope: 'surface', amount_usd: 5 }, 'Scope surface needs `surface`: one of web, api, mcp, llm-gateway, extension, agent. Nothing was changed.'],
      [{ action: 'set', scope: 'project', agent: AGENT, amount_usd: 5 }, '`agent` goes with scope agent, and this call has scope project: name its target with `project`. Nothing was changed.'],
    ];
    for (const [args, message] of cases) {
      const result = await client.callTool({ name: 'manage_spend_limit', arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal(textOf(result), `## Error\n\n${message}`, JSON.stringify(args));
    }
    assert.deepEqual(fake.calls, []);
  });
});

test('manage_spend_limit shows a new summary when the limit changed after the one the user saw', async () => {
  let now = limitRow({ guid: 'l-acc', amountusd: 500, updatedat: 100 });
  const fake = fakeClient({ '/SpendLimit/List': () => limitList([now]), '/SpendLimit/Preview': body => limitPreview(now, 248.7)(body) });
  await withClient(fake, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 700 } });
    assert.equal(summary.structuredContent.nextAction.arguments.updated_at, 100);
    // A colleague lowers it to $300 before the user says yes.
    now = limitRow({ guid: 'l-acc', amountusd: 300, updatedat: 200 });
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: summary.structuredContent.nextAction.arguments });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'preview');
    assert.equal(result.structuredContent.changedSinceSummary, true);
    assert.equal(result.structuredContent.nextAction.arguments.updated_at, 200);
    assert.match(textOf(result), /^## The limit changed since the summary \(nothing saved\)\n\nThe limit changed after the summary you showed, so nothing was saved\. Show this summary and ask the user again\./);
    assert.ok(linesOf(result).includes('**Before:** $300.00 a month, alert email at 80%'), textOf(result));
    assert.equal(fake.paths().includes('/SpendLimit/Set'), false);

    // A confirm with no version from a summary is shown as a summary, and nothing is saved.
    const blind = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 700, confirm: true } });
    assert.equal(blind.structuredContent.outcome, 'preview');
    assert.match(textOf(blind), /This call did not repeat a change summary's nextAction, so nothing was saved\./);
    assert.equal(fake.paths().includes('/SpendLimit/Set'), false);
  });
});

test('manage_spend_limit changes nothing on an older Wiro API without Preview, and maps its key refusal', async () => {
  const fake = fakeClient({ '/SpendLimit/List': limitList([]), '/SpendLimit/Preview': NOT_FOUND_ROUTE });
  await withClient(fake, async client => {
    for (const args of [
      { action: 'set', scope: 'account', amount_usd: 500 },
      { action: 'set', scope: 'account', amount_usd: 500, period: 'month', alert_percent: 80, confirm: true, updated_at: 0 },
    ]) {
      const result = await client.callTool({ name: 'manage_spend_limit', arguments: args });
      assert.equal(result.isError, true);
      assert.equal(textOf(result), '## Error\n\nThis change cannot be previewed right now, so it was not made and nothing was changed. It can be made on the Spend Limits page of the Wiro dashboard: https://wiro.ai/panel/controls/spend-limits.');
    }
    assert.equal(fake.paths().includes('/SpendLimit/Set'), false);
  });

  // An answer that does not say it is a preview proves nothing, so it counts as no Preview.
  const unmarked = fakeClient({ '/SpendLimit/List': limitList([]), '/SpendLimit/Preview': { result: true, errors: [], limit: limitRow({}) } });
  await withClient(unmarked, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 500 } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /This change cannot be previewed right now/);
  });

  const row = limitRow({ guid: 'l-acc' });
  const older = fakeClient({
    '/SpendLimit/List': limitList([row]),
    '/SpendLimit/Remove': () => { throw new WiroApiError(401, JSON.stringify({ result: false, errors: [{ code: 0, message: 'API keys can\'t manage teams or organizations. Sign in and try again.' }] })); },
  });
  await withClient(older, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'remove', limit_guid: 'l-acc' } });
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nThis change cannot be made through this connection right now, so nothing was changed. It can be made on the Spend Limits page of the Wiro dashboard: https://wiro.ai/panel/controls/spend-limits.');
  });
});

test('manage_spend_limit passes Wiro\'s refusals on, says when the outcome is unknown, and names a target by e-mail, name or guid', async () => {
  const refusals = fakeClient({
    '/SpendLimit/List': limitList([]),
    '/Team/Member/List': MEMBERS,
    '/SpendLimit/Preview': body => (body.target === JANE
      ? { result: false, errors: [{ code: 0, message: 'That person is not an active member of this team.' }] }
      : limitPreview(null, 0)(body)),
  });
  await withClient(refusals, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'member', member: 'jane@acme.test', amount_usd: 20 } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nThat person is not an active member of this team. Nothing was changed.');
    const unknownMember = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'member', member: 'who@acme.test', amount_usd: 20 } });
    assert.match(textOf(unknownMember), /No active member of this team has the e-mail `who@acme\.test`\. get_controls with members true lists the team's members\. Nothing was changed\./);
  });

  const projects = fakeClient({ '/SpendLimit/List': limitList([]), '/Project/List': PROJECTS, '/SpendLimit/Preview': body => limitPreview(null, 0, { targetlabel: 'Staging' })(body) });
  await withClient(projects, async client => {
    const twins = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'project', project: 'Twin', amount_usd: 20 } });
    assert.equal(twins.isError, true);
    assert.match(textOf(twins), /2 projects are named `Twin`: ids `9`, `10`\. Name the one you mean by its id\. Nothing was changed\./);
    const staging = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'project', project: 'staging', period: 'day', amount_usd: 5 } });
    assert.notEqual(staging.isError, true, textOf(staging));
    assert.deepEqual(projects.calls.at(-1).body, { scope: 'project', target: '7', period: 'day', amountusd: 5, alertpct: 80 });
    assert.deepEqual(staging.structuredContent.target, { scope: 'project', target: '7', targetName: 'Staging' });
    // Project/List rows carry each key; no output ever does.
    assert.doesNotMatch(JSON.stringify([twins, staging]), new RegExp(`${OWN_KEY}|${OTHER_KEY}|k-9|k-10`));
  });

  const agents = fakeClient({ '/SpendLimit/List': limitList([]), '/UserAgent/MyAgents': AGENTS, '/SpendLimit/Preview': body => limitPreview(null, 0, { targetlabel: 'Sales Bot' })(body) });
  await withClient(agents, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'agent', agent: 'Sales Bot', amount_usd: 25 } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(agents.calls.at(-1).body.target, AGENT);
    assert.equal(result.structuredContent.nextAction.arguments.agent, AGENT);
    assert.ok(linesOf(result).includes(`**Covers:** agent \`Sales Bot\` (guid \`${AGENT}\`)`), textOf(result));
    assert.match(result.structuredContent.alertRecipients, /and the person who deployed the agent$/);
    const house = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'agent', agent: 'Studio', amount_usd: 25 } });
    assert.equal(house.isError, true);
    assert.match(textOf(house), /Studio and the Workflow Agent are not agents of this workspace, so no limit or rule names them\./);
  });
  // A workspace agent may be called Studio itself: then the name is that agent's.
  const named = fakeClient({
    '/SpendLimit/List': limitList([]),
    '/UserAgent/MyAgents': { result: true, errors: [], useragents: [{ guid: AGENT, title: 'Studio' }] },
    '/SpendLimit/Preview': body => limitPreview(null, 0, { targetlabel: 'Studio' })(body),
  });
  await withClient(named, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'agent', agent: 'Studio', amount_usd: 25 } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.nextAction.arguments.agent, AGENT);
  });

  const failing = fakeClient({
    '/SpendLimit/List': limitList([]),
    '/SpendLimit/Preview': body => limitPreview(null, 0)(body),
    '/SpendLimit/Set': () => { throw new WiroApiError(502, 'Bad gateway'); },
  });
  await withClient(failing, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 500 } });
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /The outcome is not known: the limit may or may not have changed\. get_controls shows the limit as it is now, and repeating this same call is safe, since it sets the same values\./);
  });

  const limited = fakeClient({
    '/SpendLimit/List': limitList([]),
    '/SpendLimit/Preview': body => limitPreview(null, 0)(body),
    '/SpendLimit/Set': { result: false, errors: [{ code: 0, message: 'Too many changes to Spend Limits and Model Access in the last hour. Try again later.' }] },
  });
  await withClient(limited, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 500 } });
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(textOf(result), '## Error\n\nToo many changes to Spend Limits and Model Access in the last hour. Try again later. Nothing was changed.');
  });
});

test('manage_spend_limit removes by guid after a summary, and an already removed limit is unchanged', async () => {
  let rows = [
    limitRow({ guid: 'l-acc' }),
    limitRow({ guid: 'l-mem', scope: 'member', target: JANE, targetlabel: 'Jane Doe', amountusd: 50, spentusd: 12 }),
  ];
  const fake = fakeClient({
    '/SpendLimit/List': () => limitList(rows),
    '/SpendLimit/Remove': body => {
      const found = rows.some(row => row.guid === body.guid);
      rows = rows.filter(row => row.guid !== body.guid);
      return found ? { result: true, errors: [] } : { result: false, errors: [{ code: 0, message: 'Limit not found in this workspace.' }] };
    },
  });
  await withClient(fake, async client => {
    const preview = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'remove', scope: 'member', member: JANE } });
    assert.notEqual(preview.isError, true, textOf(preview));
    assert.equal(preview.structuredContent.outcome, 'preview');
    assert.deepEqual(preview.structuredContent.nextAction.arguments, {
      action: 'remove', limit_guid: 'l-mem', confirm: true, updated_at: 100, summary_id: preview.structuredContent.nextAction.arguments.summary_id,
    });
    assert.match(preview.structuredContent.nextAction.arguments.summary_id, /^[0-9a-f]{32}$/);
    const lines = linesOf(preview);
    assert.ok(lines.includes(`**Limit:** the monthly limit of $50.00 for team member \`Jane Doe\` (user id \`${JANE}\`), alert email at 80%`), textOf(preview));
    assert.ok(lines.includes('- Still in place: the monthly limit of $500.00 for the whole team.'), textOf(preview));
    assert.equal(fake.paths().includes('/SpendLimit/Remove'), false);

    const removed = await client.callTool({ name: 'manage_spend_limit', arguments: preview.structuredContent.nextAction.arguments });
    assert.equal(removed.structuredContent.outcome, 'removed');
    assert.deepEqual(fake.calls.find(call => call.path === '/SpendLimit/Remove').body, { guid: 'l-mem' });
    assert.ok(removed.structuredContent.notes.includes('Work it refused can start again at once.'));

    const twice = await client.callTool({ name: 'manage_spend_limit', arguments: preview.structuredContent.nextAction.arguments });
    assert.equal(twice.structuredContent.outcome, 'unchanged');
    assert.match(textOf(twice), /No limit with limit_guid `l-mem` is in this workspace\. It may be removed already/);
  });

  // Removed by someone else between the list and the call: Wiro's answer settles it.
  const racing = fakeClient({ '/SpendLimit/List': limitList([limitRow({ guid: 'l-acc' })]), '/SpendLimit/Remove': { result: false, errors: [{ code: 0, message: 'Limit not found in this workspace.' }] } });
  await withClient(racing, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'remove', limit_guid: 'l-acc' } });
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(result.structuredContent.outcome, 'unchanged');
    assert.match(textOf(result), /is not there any more: it was removed already\. Nothing was changed\./);
  });
});

test('manage_spend_limit writes only what the summary showed: an edited, blind or hand-made confirm gets a summary', async () => {
  let rows = [limitRow({ guid: 'l-acc' })];
  const fake = fakeClient({
    '/SpendLimit/List': () => limitList(rows),
    '/SpendLimit/Preview': body => limitPreview(rows.find(row => row.period === body.period && row.scope === body.scope) ?? null, 248.7)(body),
    '/SpendLimit/Set': body => {
      rows = [limitRow({ guid: 'l-acc', amountusd: body.amountusd, alertpct: body.alertpct, updatedat: 300 })];
      return { result: true, errors: [], limit: rows[0] };
    },
    '/SpendLimit/Remove': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 600 } });
    const shown = summary.structuredContent.nextAction.arguments;
    assert.equal(shown.amount_usd, 600);

    // "Yes, but make it $5,000": the user never saw that summary, so this is a new one and nothing is saved.
    const edited = await client.callTool({ name: 'manage_spend_limit', arguments: { ...shown, amount_usd: 5000 } });
    assert.notEqual(edited.isError, true, textOf(edited));
    assert.equal(edited.structuredContent.outcome, 'preview');
    assert.equal(edited.structuredContent.changedSinceSummary, undefined);
    assert.match(textOf(edited), /^## Set a spend limit\? \(nothing changed yet\)\n\nThis call asks for something other than the summary it repeats, so nothing was saved\. Show this summary and ask the user\./);
    assert.ok(linesOf(edited).includes('**After:** $5000.00 a month, alert email at 80%'), textOf(edited));
    assert.notEqual(edited.structuredContent.nextAction.arguments.summary_id, shown.summary_id);

    // A first call that sets confirm on its own, and one built from get_controls' updatedAt, are summaries too.
    const blind = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 50, confirm: true, updated_at: 0 } });
    assert.equal(blind.structuredContent.outcome, 'preview');
    assert.match(textOf(blind), /This call did not repeat a change summary's nextAction, so nothing was saved\./);
    const handMade = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', limit_guid: 'l-acc', amount_usd: 100000, confirm: true, updated_at: 100 } });
    assert.equal(handMade.structuredContent.outcome, 'preview');
    const removeHandMade = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'remove', limit_guid: 'l-acc', confirm: true, updated_at: 100 } });
    assert.equal(removeHandMade.structuredContent.outcome, 'preview');
    // The id of one summary does not confirm another change.
    const otherId = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'remove', limit_guid: 'l-acc', confirm: true, updated_at: 100, summary_id: shown.summary_id } });
    assert.equal(otherId.structuredContent.outcome, 'preview');
    assert.equal(fake.paths().some(path => path === '/SpendLimit/Set' || path === '/SpendLimit/Remove'), false);

    // The exact repeat saves.
    const saved = await client.callTool({ name: 'manage_spend_limit', arguments: shown });
    assert.equal(saved.structuredContent.outcome, 'saved');
    assert.deepEqual(fake.calls.find(call => call.path === '/SpendLimit/Set').body, { scope: 'account', target: '', period: 'month', amountusd: 600, alertpct: 80 });
  });
});

test('manage_spend_limit changes only the alert of a limit, keeping its amount', async () => {
  const key = limitRow({ guid: 'l-key', scope: 'project', target: '48211', targetlabel: 'Production', period: 'day', amountusd: 5, alertpct: 90, spentusd: 1, periodstart: DAY_START, resetsat: DAY_END });
  const fake = fakeClient({ '/SpendLimit/List': limitList([key]), '/SpendLimit/Preview': body => limitPreview(key, 1)(body) });
  await withClient(fake, async client => {
    const quiet = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', limit_guid: 'l-key', alert_percent: null } });
    assert.notEqual(quiet.isError, true, textOf(quiet));
    assert.equal(quiet.structuredContent.outcome, 'preview');
    assert.deepEqual(fake.calls.at(-1).body, { scope: 'project', target: '48211', period: 'day', amountusd: 5, alertpct: null });
    assert.equal(quiet.structuredContent.nextAction.arguments.amount_usd, 5);
    assert.equal(quiet.structuredContent.nextAction.arguments.alert_percent, null);
    assert.ok(quiet.structuredContent.notes.includes('The amount stays $5.00.'), quiet.structuredContent.notes.join('\n'));
    assert.ok(linesOf(quiet).includes('**After:** $5.00 a day, no alert email'), textOf(quiet));

    // The same alert again is already so.
    const same = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', limit_guid: 'l-key', alert_percent: 90 } });
    assert.equal(same.structuredContent.outcome, 'unchanged');
  });
  const none = fakeClient({ '/SpendLimit/List': limitList([]) });
  await withClient(none, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'project', project: '7', alert_percent: 50 } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nThere is no monthly limit for the API key of project id `7` yet, so set needs amount_usd: the limit in USD. Nothing was changed.');
    assert.deepEqual(none.paths(), ['/SpendLimit/List']);
  });
});

test('manage_spend_limit remove shows a new summary when the limit changed after the one the user saw', async () => {
  let row = limitRow({ guid: 'l-acc', amountusd: 500 });
  const fake = fakeClient({ '/SpendLimit/List': () => limitList([row]), '/SpendLimit/Remove': { result: true, errors: [] } });
  await withClient(fake, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'remove', limit_guid: 'l-acc' } });
    // A colleague raises it in the meantime.
    row = limitRow({ guid: 'l-acc', amountusd: 900, updatedat: 200 });
    const stale = await client.callTool({ name: 'manage_spend_limit', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(stale.structuredContent.outcome, 'preview');
    assert.equal(stale.structuredContent.changedSinceSummary, true);
    assert.equal(stale.structuredContent.nextAction.arguments.updated_at, 200);
    assert.notEqual(stale.structuredContent.nextAction.arguments.summary_id, summary.structuredContent.nextAction.arguments.summary_id);
    assert.match(textOf(stale), /^## The limit changed since the summary \(nothing removed\)\n\nThe limit changed after the summary you showed, so nothing was saved\./);
    assert.ok(linesOf(stale).includes('**Limit:** the monthly limit of $900.00 for the whole team, alert email at 80%'), textOf(stale));
    assert.equal(fake.paths().includes('/SpendLimit/Remove'), false);
    const removed = await client.callTool({ name: 'manage_spend_limit', arguments: stale.structuredContent.nextAction.arguments });
    assert.equal(removed.structuredContent.outcome, 'removed');
  });
});

test('the manage tools change nothing on an older Wiro API whose List has no caller, a removal included', async () => {
  const limits = fakeClient({ '/SpendLimit/List': limitList([limitRow({ guid: 'l-acc' })], ADMIN, null) });
  await withClient(limits, async client => {
    for (const args of [{ action: 'remove', limit_guid: 'l-acc' }, { action: 'set', scope: 'account', amount_usd: 50 }]) {
      const result = await client.callTool({ name: 'manage_spend_limit', arguments: args });
      assert.equal(result.isError, true);
      assert.equal(textOf(result), '## Error\n\nThis change cannot be previewed right now, so it was not made and nothing was changed. It can be made on the Spend Limits page of the Wiro dashboard: https://wiro.ai/panel/controls/spend-limits.');
    }
    assert.deepEqual([...new Set(limits.paths())], ['/SpendLimit/List']);
  });
  const rules = fakeClient({ '/ModelAccess/List': ruleList([ruleRow({ guid: 'r-acc', categories: [category('video', 'block')] })], ADMIN, null) });
  await withClient(rules, async client => {
    for (const args of [{ action: 'remove', rule_guid: 'r-acc' }, { action: 'update', scope: 'account', categories: [{ category: 'audio', access: 'block' }] }]) {
      const result = await client.callTool({ name: 'manage_model_access', arguments: args });
      assert.equal(result.isError, true);
      assert.equal(textOf(result), '## Error\n\nThis change cannot be previewed right now, so it was not made and nothing was changed. It can be made on the Model Access page of the Wiro dashboard: https://wiro.ai/panel/controls/model-access.');
    }
    assert.deepEqual([...new Set(rules.paths())], ['/ModelAccess/List']);
  });
  // A member still gets the member's refusal first.
  const member = fakeClient({ '/SpendLimit/List': limitList([], MEMBER, null) });
  await withClient(member, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'account', amount_usd: 50 } });
    assert.equal(result.structuredContent.outcome, 'refused');
  });
});

// ------------------------------------------------------------ manage_model_access

const HELD_RULE = ruleRow({
  guid: 'r-mem', scope: 'member', target: JANE, targetlabel: 'Jane Doe',
  categories: [category('audio', 'block')],
  models: [{ id: '201', model: 'acme/old-video', access: 'block' }],
});
const IDS = {
  '201': { id: '201', model: 'acme/old-video' },
  'openai/gpt-6-2-astra': { id: '501', model: 'openai/gpt-6-2-astra' },
  'google/nano-banana-2': { id: '502', model: 'google/nano-banana-2' },
  'kling/kling-v3': { id: '601', model: 'kling/kling-v3' },
};

test('manage_model_access update keeps the rule\'s entries, sends them by id, and saves on the confirmed repeat', async () => {
  let rule = HELD_RULE;
  const fake = fakeClient({
    '/ModelAccess/List': () => ruleList([rule]),
    '/Team/Member/List': MEMBERS,
    '/ModelAccess/Preview': body => rulePreview(rule, IDS)(body),
    '/ModelAccess/Set': body => {
      rule = rulePreview(rule, IDS)(body).rule;
      rule.guid = 'r-mem';
      rule.updatedat = 300;
      return { result: true, errors: [], rule };
    },
  });
  await withClient(fake, async client => {
    const args = { action: 'update', scope: 'member', member: 'jane@acme.test', categories: [{ category: 'video', access: 'block' }] };
    const preview = await client.callTool({ name: 'manage_model_access', arguments: args });
    assert.notEqual(preview.isError, true, textOf(preview));
    const sent = fake.calls.find(call => call.path === '/ModelAccess/Preview').body;
    assert.deepEqual(sent, {
      scope: 'member',
      target: JANE,
      access: 'allow',
      categories: [{ category: 'video', access: 'block' }, { category: 'audio', access: 'block' }],
      models: [{ model: '201', access: 'block' }],
    });
    const data = preview.structuredContent;
    assert.equal(data.outcome, 'preview');
    assert.deepEqual(data.changes, { categories: [{ category: 'video', label: 'Video Generation', from: 'not named', to: 'block' }], models: [] });
    assert.deepEqual(data.nextAction.arguments, {
      action: 'update', scope: 'member', member: JANE, categories: [{ category: 'video', access: 'block' }], confirm: true, updated_at: 100,
      summary_id: data.nextAction.arguments.summary_id,
    });
    assert.match(data.nextAction.arguments.summary_id, /^[0-9a-f]{32}$/);
    const lines = linesOf(preview);
    for (const line of [
      '## Change a Model Access rule? (nothing changed yet)',
      `**Rule for:** team member \`Jane Doe\` (user id \`${JANE}\`)`,
      '**Before:** Every model except Audio & Speech and `acme/old-video`',
      '**After:** Every model except Video Generation, Audio & Speech and `acme/old-video`',
      '- Video Generation: not named before, blocked after',
      '- It applies to runs that start from now on; work already running is not stopped.',
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(preview)}`);
    assert.equal(fake.paths().includes('/ModelAccess/Set'), false);

    const saved = await client.callTool({ name: 'manage_model_access', arguments: data.nextAction.arguments });
    assert.notEqual(saved.isError, true, textOf(saved));
    assert.equal(saved.structuredContent.outcome, 'saved');
    assert.deepEqual(fake.calls.find(call => call.path === '/ModelAccess/Set').body, sent);
    assert.ok(linesOf(saved).includes('**Now:** Every model except Video Generation, Audio & Speech and `acme/old-video`'), textOf(saved));

    // The same change again finds nothing to do, with no Preview or Set call.
    const before = fake.calls.length;
    const again = await client.callTool({ name: 'manage_model_access', arguments: data.nextAction.arguments });
    assert.equal(again.structuredContent.outcome, 'unchanged');
    assert.deepEqual(fake.calls.slice(before).map(call => call.path), ['/ModelAccess/List']);
  });
});

test('manage_model_access replace writes only what is given, and unset takes an entry out in an update', async () => {
  const keyRule = ruleRow({ guid: 'r-key', scope: 'project', target: '48211', targetlabel: 'Production', access: 'block', categories: [category('image', 'allow')], models: [{ id: '501', model: 'openai/gpt-6-2-astra', access: 'allow' }] });
  const fake = fakeClient({ '/ModelAccess/List': ruleList([keyRule]), '/ModelAccess/Preview': body => rulePreview(keyRule, IDS)(body) });
  await withClient(fake, async client => {
    const replaced = await client.callTool({
      name: 'manage_model_access',
      arguments: { action: 'replace', scope: 'project', everything_else: 'block', models: [{ model: 'google/nano-banana-2', access: 'allow' }] },
    });
    assert.notEqual(replaced.isError, true, textOf(replaced));
    assert.deepEqual(fake.calls.filter(call => call.path === '/ModelAccess/Preview').at(-1).body, { scope: 'project', target: '48211', access: 'block', categories: [], models: [{ model: 'google/nano-banana-2', access: 'allow' }] });
    assert.equal(replaced.structuredContent.after.summary, 'Only google/nano-banana-2');
    assert.ok(replaced.structuredContent.notes.includes('It covers runs through this connection too.'));

    const unset = await client.callTool({
      name: 'manage_model_access',
      arguments: { action: 'update', scope: 'project', models: [{ model: 'OpenAI/GPT-6-2-Astra', access: 'unset' }, { model: 'acme/missing', access: 'unset' }] },
    });
    assert.notEqual(unset.isError, true, textOf(unset));
    assert.deepEqual(fake.calls.filter(call => call.path === '/ModelAccess/Preview').at(-1).body, { scope: 'project', target: '48211', access: 'block', categories: [{ category: 'image', access: 'allow' }], models: [] });
    assert.ok(unset.structuredContent.notes.includes('`acme/missing` is not in the rule, so unset changes nothing there.'));

    const wrong = await client.callTool({ name: 'manage_model_access', arguments: { action: 'replace', scope: 'project', models: [{ model: 'a/b', access: 'unset' }] } });
    assert.equal(wrong.isError, true);
    assert.match(textOf(wrong), /Access unset takes an entry out of a rule, so it goes with update\./);
  });
});

test('manage_model_access shows a new summary when the rule changed after the one the user saw, keeping a colleague\'s entry', async () => {
  let rule = HELD_RULE;
  const fake = fakeClient({
    '/ModelAccess/List': () => ruleList([rule]),
    '/ModelAccess/Preview': body => rulePreview(rule, IDS)(body),
    '/ModelAccess/Set': () => ({ result: true, errors: [], rule }),
  });
  await withClient(fake, async client => {
    const summary = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', scope: 'member', member: JANE, categories: [{ category: 'video', access: 'block' }] } });
    assert.equal(summary.structuredContent.outcome, 'preview');
    // A colleague blocks Image Generation for Jane in the meantime.
    rule = { ...HELD_RULE, categories: [...HELD_RULE.categories, category('image', 'block')], updatedat: 200 };
    const stale = await client.callTool({ name: 'manage_model_access', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(stale.structuredContent.outcome, 'preview');
    assert.equal(stale.structuredContent.changedSinceSummary, true);
    assert.equal(stale.structuredContent.nextAction.arguments.updated_at, 200);
    assert.match(textOf(stale), /^## The rule changed since the summary \(nothing saved\)\n\nThe rule changed after the summary you showed, so nothing was saved\./);
    // The new summary is built on the colleague's rule: their entry stays.
    assert.deepEqual(fake.calls.filter(call => call.path === '/ModelAccess/Preview').at(-1).body.categories, [
      { category: 'image', access: 'block' }, { category: 'video', access: 'block' }, { category: 'audio', access: 'block' },
    ]);
    assert.equal(fake.paths().includes('/ModelAccess/Set'), false);
    const saved = await client.callTool({ name: 'manage_model_access', arguments: stale.structuredContent.nextAction.arguments });
    assert.equal(saved.structuredContent.outcome, 'saved');
    assert.deepEqual(fake.calls.find(call => call.path === '/ModelAccess/Set').body.categories.map(entry => entry.category), ['image', 'video', 'audio']);
  });

  // replace writes the whole rule, so a colleague's change in between needs a new yes too.
  let keyRule = ruleRow({ guid: 'r-key', scope: 'project', target: '48211', targetlabel: 'Production', access: 'block', categories: [category('image', 'allow')] });
  const replace = fakeClient({
    '/ModelAccess/List': () => ruleList([keyRule]),
    '/ModelAccess/Preview': body => rulePreview(keyRule, IDS)(body),
    '/ModelAccess/Check': { result: true, errors: [], check: { model: 'x', categories: [], allowed: true, message: null, rules: [] } },
    '/ModelAccess/Set': () => ({ result: true, errors: [], rule: keyRule }),
  });
  await withClient(replace, async client => {
    const summary = await client.callTool({ name: 'manage_model_access', arguments: { action: 'replace', scope: 'project', everything_else: 'block', models: [{ model: 'google/nano-banana-2', access: 'allow' }] } });
    keyRule = { ...keyRule, categories: [category('image', 'allow'), category('llm', 'allow')], updatedat: 250 };
    const stale = await client.callTool({ name: 'manage_model_access', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(stale.structuredContent.changedSinceSummary, true);
    assert.ok(linesOf(stale).includes('**Before:** Only Image Generation and LLM & Chat'), textOf(stale));
    assert.equal(replace.paths().includes('/ModelAccess/Set'), false);

    // An edited confirm of the new summary is not a yes to it either.
    const edited = await client.callTool({ name: 'manage_model_access', arguments: { ...stale.structuredContent.nextAction.arguments, models: [{ model: 'openai/gpt-6-2-astra', access: 'allow' }] } });
    assert.equal(edited.structuredContent.outcome, 'preview');
    assert.match(textOf(edited), /This call asks for something other than the summary it repeats, so nothing was saved\./);
    const blind = await client.callTool({ name: 'manage_model_access', arguments: { action: 'remove', rule_guid: 'r-key', confirm: true, updated_at: 250 } });
    assert.equal(blind.structuredContent.outcome, 'preview');
    assert.equal(replace.paths().some(path => path === '/ModelAccess/Set' || path === '/ModelAccess/Remove'), false);
  });
});

test('manage_model_access warns when a wider rule still blocks a model the change allows, as Check finds it', async () => {
  const teamVideo = ruleRow({ guid: 'r-acc', categories: [category('video', 'block')] });
  const bob = ruleRow({ guid: 'r-bob', scope: 'member', target: BOB, targetlabel: 'Bob Roe', categories: [category('llm', 'block')] });
  const webRule = ruleRow({ guid: 'r-web', scope: 'surface', target: 'api', targetlabel: 'the API', access: 'block' });
  const decisions = {
    'kling/kling-v3': [{ rule: teamVideo, access: 'block', by: 'category', category: 'video' }],
    'openai/gpt-6-2-astra': [
      { rule: teamVideo, access: 'allow', by: 'default', category: null },
      { rule: bob, access: 'block', by: 'category', category: 'llm' },
      // The API's surface rule covers only some runs of a key, so it is no reason to warn about the key's rule.
      { rule: webRule, access: 'block', by: 'default', category: null },
    ],
  };
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([teamVideo, HELD_RULE, bob, webRule]),
    '/ModelAccess/Preview': body => rulePreview(body.scope === 'member' ? HELD_RULE : null, IDS)(body),
    '/ModelAccess/Check': body => ({ result: true, errors: [], check: { model: body.model, categories: [], allowed: false, message: 'x', rules: decisions[body.model] ?? [] } }),
  });
  await withClient(fake, async client => {
    // "Let Jane use Kling" while the team's rule blocks Video Generation.
    const jane = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', scope: 'member', member: JANE, models: [{ model: 'kling/kling-v3', access: 'allow' }] } });
    assert.notEqual(jane.isError, true, textOf(jane));
    assert.deepEqual(fake.calls.find(call => call.path === '/ModelAccess/Check').body, { model: 'kling/kling-v3', member: JANE });
    assert.deepEqual(jane.structuredContent.warnings, ['The rule for the whole team blocks Video Generation, and `kling/kling-v3` is in it, so allowing it here changes nothing until that rule allows it too.']);
    assert.ok(linesOf(jane).includes('- Warning: The rule for the whole team blocks Video Generation, and `kling/kling-v3` is in it, so allowing it here changes nothing until that rule allows it too.'), textOf(jane));

    // A key's runs count as its creator, so Bob's member rule decides them too; the API surface's does not always.
    const key = await client.callTool({ name: 'manage_model_access', arguments: { action: 'replace', scope: 'project', project: '48211', everything_else: 'block', models: [{ model: 'openai/gpt-6-2-astra', access: 'allow' }] } });
    assert.notEqual(key.isError, true, textOf(key));
    assert.deepEqual(fake.calls.filter(call => call.path === '/ModelAccess/Check').at(-1).body, { model: 'openai/gpt-6-2-astra', project: '48211' });
    assert.deepEqual(key.structuredContent.warnings, [`The rule for team member \`Bob Roe\` (user id \`${BOB}\`) blocks LLM & Chat, and \`openai/gpt-6-2-astra\` is in it, so allowing it here changes nothing until that rule allows it too.`]);
  });

  // "Allow GPT on this key" with no key rule would block nothing; the refusal names the rule that really blocks it.
  const onlyImage = ruleRow({ guid: 'r-acc', access: 'block', categories: [category('image', 'allow')] });
  const nothing = fakeClient({
    '/ModelAccess/List': ruleList([onlyImage]),
    '/ModelAccess/Check': { result: true, errors: [], check: { model: 'openai/gpt-6-2-astra', categories: ['llm'], allowed: false, message: 'x', rules: [{ rule: onlyImage, access: 'block', by: 'default', category: null }] } },
  });
  await withClient(nothing, async client => {
    const result = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', scope: 'project', models: [{ model: 'openai/gpt-6-2-astra', access: 'allow' }] } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'refused');
    assert.deepEqual(result.structuredContent.warnings, ['The rule for the whole team lets only the models it names run, and `openai/gpt-6-2-astra` is not one of them, so allowing it here changes nothing until that rule allows it too.']);
    assert.match(result.structuredContent.message, /would block nothing: .* To open a model that a wider rule blocks, that rule has to change: check_model_access shows every rule that blocks it\. Nothing was changed\.$/);
    assert.doesNotMatch(result.structuredContent.message, /set everything_else to block/);
    assert.deepEqual(nothing.paths(), ['/ModelAccess/List', '/ModelAccess/Check']);
  });

  // A check that fails adds nothing, and the change summary stands.
  const failing = fakeClient({
    '/ModelAccess/List': ruleList([teamVideo, HELD_RULE]),
    '/ModelAccess/Preview': body => rulePreview(HELD_RULE, IDS)(body),
    '/ModelAccess/Check': () => { throw new WiroApiError(502, 'Bad gateway'); },
  });
  await withClient(failing, async client => {
    const result = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', scope: 'member', member: JANE, models: [{ model: 'kling/kling-v3', access: 'allow' }] } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'preview');
    assert.deepEqual(result.structuredContent.warnings, []);
  });

  // Each target is checked as one of its own runs.
  const runs = fakeClient({
    '/ModelAccess/List': ruleList([]),
    '/UserAgent/MyAgents': AGENTS,
    '/ModelAccess/Preview': body => rulePreview(null, IDS)(body),
    '/ModelAccess/Check': { result: true, errors: [], check: { model: 'x', categories: [], allowed: true, message: null, rules: [] } },
  });
  await withClient(runs, async client => {
    for (const [target, body] of [
      [{ scope: 'agent', agent: 'Sales Bot' }, { model: 'kling/kling-v3', agent: AGENT }],
      [{ scope: 'surface', surface: 'llm-gateway' }, { model: 'kling/kling-v3', surface: 'llm-gateway' }],
      [{ scope: 'surface', surface: 'agent' }, { model: 'kling/kling-v3' }],
    ]) {
      await client.callTool({ name: 'manage_model_access', arguments: { action: 'replace', ...target, everything_else: 'block', models: [{ model: 'kling/kling-v3', access: 'allow' }] } });
      assert.deepEqual(runs.calls.filter(call => call.path === '/ModelAccess/Check').at(-1).body, body);
    }
    // The whole wallet's rule has nothing wider to check.
    const before = runs.calls.length;
    await client.callTool({ name: 'manage_model_access', arguments: { action: 'replace', scope: 'account', everything_else: 'block', models: [{ model: 'kling/kling-v3', access: 'allow' }] } });
    assert.equal(runs.calls.slice(before).some(call => call.path === '/ModelAccess/Check'), false);
  });
});

test('manage_model_access refuses a rule that blocks nothing and offers to remove it instead', async () => {
  const videoBlock = ruleRow({ guid: 'r-mem', scope: 'member', target: JANE, targetlabel: 'Jane Doe', categories: [category('video', 'block')] });
  const fake = fakeClient({ '/ModelAccess/List': ruleList([videoBlock]) });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', scope: 'member', member: JANE, categories: [{ category: 'video', access: 'unset' }] } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.outcome, 'refused');
    assert.match(result.structuredContent.message, /would block nothing: with everything_else allow, allow entries change nothing/);
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'manage_model_access',
      arguments: { action: 'remove', rule_guid: 'r-mem' },
      reason: 'Shows what removing the rule changes; nothing changes without the user\'s yes.',
    });
    assert.deepEqual(fake.paths(), ['/ModelAccess/List']);
  });
});

test('manage_model_access warns about the agent\'s chat model and about the whole account\'s rule', async () => {
  const account = ruleRow({ guid: 'r-acc', categories: [category('llm', 'block')] });
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([account]),
    '/UserAgent/MyAgents': AGENTS,
    '/ModelAccess/Preview': body => rulePreview(null, IDS, body.scope === 'agent'
      ? { agentchatmodel: { ref: 'openai/gpt-5.6-terra', model: 'openai/gpt-5-6-terra', blocked: true } }
      : {})(body),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'manage_model_access',
      arguments: { action: 'replace', scope: 'agent', agent: 'Sales Bot', everything_else: 'block', models: [{ model: 'google/nano-banana-2', access: 'allow' }] },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const { warnings, notes } = result.structuredContent;
    assert.ok(warnings.includes('This rule also blocks `openai/gpt-5-6-terra`, the chat model the agent answers with, so the agent would stop answering. Allow that model too, or allow LLM & Chat.'), warnings.join('\n'));
    assert.ok(notes.includes('The agent follows a change to its own rule within about a minute.'));
    assert.match(textOf(result), /- Warning: This rule also blocks `openai\/gpt-5-6-terra`/);

    const opened = await client.callTool({
      name: 'manage_model_access',
      arguments: { action: 'replace', scope: 'surface', surface: 'api', everything_else: 'block', categories: [{ category: 'llm', access: 'allow' }] },
    });
    assert.ok(opened.structuredContent.warnings.includes('The rule for the whole team blocks LLM & Chat, so allowing it here changes nothing until that rule allows it too.'), opened.structuredContent.warnings.join('\n'));
  });
});

test('manage_model_access removes a rule after a summary, says when it changed since, and when it is gone already', async () => {
  let rules = [ruleRow({ guid: 'r-acc' , categories: [category('video', 'block')] }), ruleRow({ guid: 'r-gw', scope: 'surface', target: 'llm-gateway', targetlabel: 'the LLM gateway', access: 'block', updatedat: 400 })];
  const fake = fakeClient({
    '/ModelAccess/List': () => ruleList(rules),
    '/ModelAccess/Remove': body => {
      const found = rules.some(rule => rule.guid === body.guid);
      rules = rules.filter(rule => rule.guid !== body.guid);
      return found ? { result: true, errors: [] } : { result: false, errors: [{ code: 0, message: 'Rule not found in this workspace.' }] };
    },
  });
  await withClient(fake, async client => {
    // A confirm that does not come from a summary is only a summary.
    const blind = await client.callTool({ name: 'manage_model_access', arguments: { action: 'remove', rule_guid: 'r-gw', confirm: true, updated_at: 100 } });
    assert.equal(blind.structuredContent.outcome, 'preview');
    assert.equal(blind.structuredContent.changedSinceSummary, undefined);
    assert.equal(blind.structuredContent.nextAction.arguments.updated_at, 400);
    // A summary of the rule as it was, confirmed after a colleague changed it, is not a yes to the new rule.
    const stale = await client.callTool({ name: 'manage_model_access', arguments: { ...blind.structuredContent.nextAction.arguments, updated_at: 100 } });
    assert.equal(stale.structuredContent.outcome, 'preview');
    assert.equal(stale.structuredContent.changedSinceSummary, true);
    assert.equal(stale.structuredContent.nextAction.arguments.updated_at, 400);

    const preview = await client.callTool({ name: 'manage_model_access', arguments: { action: 'remove', scope: 'surface', surface: 'llm-gateway' } });
    assert.ok(linesOf(preview).includes('**It reads:** No model: this rule blocks every model'), textOf(preview));
    assert.ok(preview.structuredContent.notes.includes('The rule for the whole team still applies: Every model except Video Generation.'));
    assert.equal(fake.paths().includes('/ModelAccess/Remove'), false);

    const removed = await client.callTool({ name: 'manage_model_access', arguments: preview.structuredContent.nextAction.arguments });
    assert.equal(removed.structuredContent.outcome, 'removed');
    assert.deepEqual(fake.calls.find(call => call.path === '/ModelAccess/Remove').body, { guid: 'r-gw' });

    const none = await client.callTool({ name: 'manage_model_access', arguments: { action: 'remove', scope: 'surface', surface: 'llm-gateway' } });
    assert.equal(none.structuredContent.outcome, 'unchanged');
    assert.match(textOf(none), /There is no rule for the LLM gateway \(surface `llm-gateway`\), so there is nothing to remove\./);
  });
});

test('manage_model_access refuses a member at the summary and changes nothing on an older Wiro API', async () => {
  const member = fakeClient({ '/ModelAccess/List': ruleList([], MEMBER) });
  await withClient(member, async client => {
    const result = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', scope: 'account', categories: [{ category: 'video', access: 'block' }] } });
    assert.equal(result.structuredContent.outcome, 'refused');
    assert.equal(textOf(result), '## Not changed\n\nOnly a team admin or the organization\'s owner can change this team\'s Model Access rules, and this connection acts as a team member without those rights. Nothing was changed. Ask a team admin to do it, with their own connection or at https://wiro.ai/panel/controls/model-access.');
    assert.deepEqual(member.paths(), ['/ModelAccess/List']);
  });

  const older = fakeClient({ '/ModelAccess/List': ruleList([]), '/ModelAccess/Preview': NOT_FOUND_ROUTE });
  await withClient(older, async client => {
    const result = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', scope: 'account', categories: [{ category: 'video', access: 'block' }], confirm: true, updated_at: 0 } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nThis change cannot be previewed right now, so it was not made and nothing was changed. It can be made on the Model Access page of the Wiro dashboard: https://wiro.ai/panel/controls/model-access.');
    assert.equal(older.paths().includes('/ModelAccess/Set'), false);
  });
});

test('manage_model_access explains a model that is not on Wiro, and one the rule holds that left Wiro', async () => {
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([HELD_RULE]),
    '/ModelAccess/Preview': body => (body.models.some(entry => entry.model === 'acme/nothing')
      ? { result: false, errors: [{ code: 0, message: 'acme/nothing is not a model on Wiro.' }] }
      : { result: false, errors: [{ code: 0, message: '201 is not a model on Wiro.' }] }),
  });
  await withClient(fake, async client => {
    const unknown = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', rule_guid: 'r-mem', models: [{ model: 'acme/nothing', access: 'block' }] } });
    assert.equal(textOf(unknown), '## Error\n\nacme/nothing is not a model on Wiro. search_models finds a model\'s owner/slug. Nothing was changed.');
    const hidden = await client.callTool({ name: 'manage_model_access', arguments: { action: 'update', rule_guid: 'r-mem', categories: [{ category: 'video', access: 'block' }] } });
    assert.equal(textOf(hidden), '## Error\n\nModel 201 in this rule is no longer on Wiro, so the rule cannot be saved with it. Add `{"model":"201","access":"unset"}` to models in this call to take it out. Nothing was changed.');
  });
});

// ------------------------------------------------------------- the guidance around them

test('the controls group is on by default, loads on its own, and the admin-style server lists can leave it out', async () => {
  assert.deepEqual(TOOLSETS, ['models', 'workflows', 'agents', 'controls']);
  assert.deepEqual(parseToolsets('controls'), ['controls']);
  assert.deepEqual(parseToolsets('models, Controls'), ['models', 'controls']);
  const controlsOnly = fakeClient({});
  await withClient(controlsOnly, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['check_model_access', 'get_account', 'get_controls', 'get_playbook', 'manage_model_access', 'manage_spend_limit', 'search_docs']);
  }, { toolsets: ['controls'] });
  await withClient(fakeClient({}), async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['get_controls', 'check_model_access', 'manage_spend_limit', 'manage_model_access']) assert.equal(names.includes(name), false, name);
  }, { toolsets: ['models', 'workflows', 'agents'] });
});

test('the instructions stay under 4,000 characters and name the controls tools and topic', () => {
  assert.ok(SERVER_INSTRUCTIONS.length < 4000, `the instructions are ${SERVER_INSTRUCTIONS.length} characters`);
  assert.ok(SERVER_INSTRUCTIONS.split('\n').length <= 25);
  const summaries = SERVER_INSTRUCTIONS.split('\n').find(line => line.startsWith('- Change summaries come first'));
  assert.match(summaries, /bind_agent_project, manage_spend_limit, manage_model_access, manage_agent_custom_skill/);
  assert.match(SERVER_INSTRUCTIONS, /Playbook topics: [^\n]*, billing, controls\./);
  assert.ok(PLAYBOOK_TOPICS.includes('controls'));
});

test('the controls playbook teaches the rules, the roles, the surfaces and the recipes', () => {
  const text = PLAYBOOKS.controls;
  for (const pattern of [
    /error code 93/, /error code 92/,
    /A team: a team admin or the organization's owner\. The person who made the team is one of its admins\./,
    /cannot change any of them: not the whole team's, not their own member limit, and not the limits and rules of the keys and agents they created or deployed/,
    /A deployed agent can never change controls, not even its own\./,
    /`mcp`: the hosted MCP server at mcp\.wiro\.ai/,
    /A local install of this server counts as `api`\./,
    /The period is `month` or `day`, in UTC\./,
    /Every limit and every rule that applies to a run must allow it/,
    /A narrower rule cannot open what a wider one blocks\./,
    /Nothing changes without `confirm: true`\. The first call returns a change summary/,
    /never lift a limit or open a rule just to finish a task/,
  ]) assert.match(text, pattern);
  for (const recipe of [
    'Cap the whole account at $500 a month:',
    'Cap one API key at $5 a day:',
    'Give each team member a monthly cap:',
    'Stop a team member from using video models:',
    'Let one agent use only one model:',
    'Block the LLM gateway:',
    'Block one model everywhere:',
    'Find why work was refused, and fix it:',
    'Raise or remove a limit:',
    'Change or turn off the alert:',
    'See what was spent this month, and by whom:',
  ]) assert.ok(text.split('\n').includes(recipe), recipe);
  // Every recipe that changes a limit or a rule shows the summary, waits for a yes, confirms, and says what to tell the user.
  const recipes = text.slice(text.indexOf('## Recipes'), text.indexOf('## What to tell the user')).split('\n\n').slice(1);
  const changing = recipes.filter(recipe => /`manage_(spend_limit|model_access)`/.test(recipe));
  assert.ok(changing.length >= 9, `${changing.length} recipes change something`);
  for (const recipe of changing) {
    const title = recipe.split('\n')[0];
    assert.match(recipe, /wait for a yes, then confirm|get one yes for that list, then confirm each one/i, title);
    assert.match(recipe, /Tell the user/, title);
  }
  // The member list names members; the limits are listed with the other limits.
  assert.doesNotMatch(text, /members with their user ids and limits/);
  assert.match(text, /A confirm saves only the change its summary showed\./);
  assert.match(text, /runs in progress hold part of the limit/);
  assert.doesNotMatch(text, /agent's owner can|also the agent's owner|panel\/wallet\/limits|dryrun/);
  for (const topic of ['models', 'billing', 'getting-started']) assert.match(PLAYBOOKS[topic], /`controls`/, topic);
});

test('the controls tools name the right argument for a wrong one, and reach nothing', async () => {
  const fake = fakeClient({});
  await withClient(fake, async client => {
    const cases = [
      ['manage_spend_limit', { action: 'set', scope: 'account', amount: 5 }, /`amount` \(use `amount_usd`\)/],
      ['manage_spend_limit', { action: 'set', scope: 'account', amount_usd: 5, alertPct: 50 }, /`alertPct` \(use `alert_percent`\)/],
      ['manage_spend_limit', { action: 'set', scope: 'member', email: 'jane@acme.test', amount_usd: 5 }, /`email` \(use `member`\)/],
      ['manage_spend_limit', { action: 'set', scope: 'project', project_id: '48211', amount_usd: 5 }, /`project_id` \(use `project`\)/],
      ['manage_spend_limit', { action: 'remove', limitGuid: 'l-1' }, /`limitGuid` \(use `limit_guid`\)/],
      ['manage_spend_limit', { action: 'remove', guid: 'l-1' }, /`guid` \(use `limit_guid`\)/],
      ['manage_spend_limit', { action: 'remove', limit_guid: 'l-1', confirm: true, updated_at: 1, digest: 'x' }, /`digest` \(use `summary_id`\)/],
      ['manage_model_access', { action: 'update', scope: 'account', access: 'block' }, /`access` \(use `everything_else`\)/],
      ['manage_model_access', { action: 'remove', ruleId: 'r-1' }, /`ruleId` \(use `rule_guid`\)/],
      ['manage_model_access', { action: 'update', scope: 'agent', agent_guid: AGENT, models: [] }, /`agent_guid` \(use `agent`\)/],
      ['check_model_access', { model: 'a/b', channel: 'mcp' }, /`channel` \(use `surface`\)/],
      ['get_controls', { spending: 'month' }, /`spending` \(use `usage`\)/],
    ];
    for (const [name, args, expected] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(result.content[0].text, expected, `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(fake.calls, []);
  });
});

test('get_controls words a personal account as such', async () => {
  const fake = fakeClient({
    '/SpendLimit/List': limitList([limitRow({ guid: 'l-acc', amountusd: 100, spentusd: 20 })], PERSONAL),
    '/ModelAccess/List': ruleList([], PERSONAL),
    '/Organization/List': { result: true, errors: [], organizations: [] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: { members: true } });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = linesOf(result);
    assert.ok(lines.includes('**Workspace:** personal account'), textOf(result));
    assert.ok(lines.includes('- Monthly limit for the whole account: $20.00 of $100.00 used, $80.00 left, alert email at 80%, resets December 1, 2026 at 00:00 UTC (limit_guid `l-acc`)'), textOf(result));
    assert.ok(lines.includes('The connected project is not in a team, so this workspace has no team members.'), textOf(result));
    assert.equal(result.structuredContent.workspace.kind, 'personal');
    assert.equal(result.structuredContent.members, undefined);
    assert.equal(fake.paths().includes('/Team/Member/List'), false);
  });
});

// ---------------------------------------------------------------- who changed it

const CHANGED_AT = 1795096920; // 2026-11-19T14:02:00Z
const GONE = '9b2f6c1e-2f3a-4c5d-9e8f-0a1b2c3d4e09';
const OWNER = 'ab2f6c1e-2f3a-4c5d-9e8f-0a1b2c3d4e0a';

test('get_controls says who changed each limit and rule last, and when', async () => {
  const fake = fakeClient({
    '/SpendLimit/List': limitList([
      limitRow({ guid: 'l-acc', updatedat: CHANGED_AT, updatedby: { useruuid: JANE, label: 'Jane Doe' } }),
      limitRow({
        guid: 'l-key', scope: 'project', target: '7', targetlabel: 'Staging', period: 'day', amountusd: 5, spentusd: 1,
        periodstart: DAY_START, resetsat: DAY_END, updatedat: CHANGED_AT, updatedby: { useruuid: OWNER, label: 'the organization owner' },
      }),
      // A change Wiro made itself names no one.
      limitRow({ guid: 'l-web', scope: 'surface', target: 'web', amountusd: 50, spentusd: 0, updatedby: null }),
      limitRow({ guid: 'l-bob', scope: 'member', target: BOB, targetlabel: 'Bob Roe', amountusd: 100, spentusd: 10, updatedat: CHANGED_AT, updatedby: { useruuid: BOB, label: 'Bob Roe' } }),
    ]),
    '/ModelAccess/List': ruleList([
      ruleRow({ guid: 'r-acc', categories: [category('video', 'block')], updatedat: CHANGED_AT, updatedby: { useruuid: GONE, label: null } }),
      ruleRow({ guid: 'r-api', scope: 'surface', target: 'api', access: 'block', categories: [category('image', 'allow')] }),
    ]),
    '/Organization/List': ORGS,
    '/Project/List': { ...PROJECTS, project: PROJECTS.project.map(row => ({ ...row, uuid: row.id === '48211' ? BOB : JANE })) },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = linesOf(result);
    for (const line of [
      '- Monthly limit for the whole team: $248.70 of $500.00 used, $251.30 left, alert email at 80%, resets December 1, 2026 at 00:00 UTC (limit_guid `l-acc`; last changed by `Jane Doe` on November 19, 2026 at 14:02 UTC)',
      '- Daily limit for the API key of project `Staging` (id `7`): $1.00 of $5.00 used, $4.00 left, alert email at 80%, resets November 21, 2026 at 00:00 UTC (limit_guid `l-key`; last changed by the organization\'s owner on November 19, 2026 at 14:02 UTC)',
      '- Monthly limit for the dashboard (surface `web`): $0.00 of $50.00 used, $50.00 left, alert email at 80%, resets December 1, 2026 at 00:00 UTC (limit_guid `l-web`)',
      `- Monthly limit for team member \`Bob Roe\` (user id \`${BOB}\`), the person this connection acts as: $10.00 of $100.00 used, $90.00 left, alert email at 80%, resets December 1, 2026 at 00:00 UTC (limit_guid \`l-bob\`; last changed by \`Bob Roe\`, the person this connection acts as, on November 19, 2026 at 14:02 UTC)`,
      `- Rule for the whole team: Every model except Video Generation (rule_guid \`r-acc\`; last changed by a former team member (user id \`${GONE}\`) on November 19, 2026 at 14:02 UTC)`,
      '- Rule for the API (surface `api`): Only Image Generation (rule_guid `r-api`)',
    ]) assert.ok(lines.includes(line), `missing line: ${line}\n\n${textOf(result)}`);
    const data = result.structuredContent;
    assert.deepEqual(data.spendLimits.find(row => row.guid === 'l-acc').updatedBy, { useruuid: JANE, name: 'Jane Doe' });
    assert.deepEqual(data.spendLimits.find(row => row.guid === 'l-key').updatedBy, { useruuid: OWNER, name: 'the organization owner' });
    assert.equal(data.spendLimits.find(row => row.guid === 'l-web').updatedBy, undefined);
    assert.deepEqual(data.modelAccessRules[0].updatedBy, { useruuid: GONE });
    assert.equal(data.modelAccessRules[1].updatedBy, undefined);
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'get_controls');
    assert.match(tool.description, /Each limit and rule says who changed it last, and when, where Wiro gives it\./);
  });

  // A name people wrote stays in a code span, and a malformed updatedby names no one.
  const personal = fakeClient({
    '/SpendLimit/List': limitList([
      limitRow({ guid: 'l-acc', updatedat: CHANGED_AT, updatedby: { useruuid: JANE, label: 'me `x` @acme.test' } }),
      limitRow({ guid: 'l-day', period: 'day', amountusd: 10, spentusd: 0, periodstart: DAY_START, resetsat: DAY_END, updatedby: { useruuid: 'not-a-uuid', label: 'Someone' } }),
    ], PERSONAL),
    '/ModelAccess/List': ruleList([], PERSONAL),
    '/Organization/List': { result: true, errors: [], organizations: [] },
  });
  await withClient(personal, async client => {
    const result = await client.callTool({ name: 'get_controls', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /\(limit_guid `l-acc`; last changed by ``me `x` @acme\.test`` on November 19, 2026 at 14:02 UTC\)/);
    assert.match(textOf(result), /\(limit_guid `l-day`\)$/m);
    assert.equal(result.structuredContent.spendLimits[1].updatedBy, undefined);
  });
});

test('check_model_access and the change summaries carry who changed a rule or limit last', async () => {
  const blockingAccount = ruleRow({ guid: 'r-acc', categories: [category('llm', 'block')], updatedat: CHANGED_AT, updatedby: { useruuid: JANE, label: 'Jane Doe' } });
  const fake = fakeClient({
    '/ModelAccess/List': ruleList([blockingAccount]),
    '/ModelAccess/Check': checkAnswer([{ rule: blockingAccount, access: 'block', by: 'category', category: 'llm' }]),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'check_model_access', arguments: { model: 'openai/gpt-6-2-astra' } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.ok(linesOf(result).includes('- Rule for the whole team: blocks it, as it blocks LLM & Chat, and this model is in it. The rule: Every model except LLM & Chat. Last changed by `Jane Doe` on November 19, 2026 at 14:02 UTC.'), textOf(result));
    assert.deepEqual(result.structuredContent.rules[0].updatedBy, { useruuid: JANE, name: 'Jane Doe' });
  });

  const held = limitRow({ guid: 'l-acc', updatedat: CHANGED_AT, updatedby: { useruuid: JANE, label: 'Jane Doe' } });
  const limits = fakeClient({
    '/SpendLimit/List': limitList([held]),
    '/SpendLimit/Preview': body => limitPreview(held, 248.7)(body),
  });
  await withClient(limits, async client => {
    const result = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', limit_guid: 'l-acc', amount_usd: 600 } });
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(result.structuredContent.before.updatedBy, { useruuid: JANE, name: 'Jane Doe' });
    // Preview's draft names no one.
    assert.equal(result.structuredContent.after.updatedBy, undefined);
  });
});

// ------------------------------------------------------------- an agent's voice

test('manage_model_access warns when an agent\'s rule newly blocks its built-in voice', async () => {
  const ids = { ...IDS, 'google/gemini-3-flash': { id: '701', model: 'google/gemini-3-flash' } };
  const general = 'This rule also blocks Audio & Speech, which covers the agent\'s built-in voice: voice notes are not transcribed and voice replies go out as text. Allow Audio & Speech to keep them.';
  const repliesOnly = 'This rule also blocks Audio & Speech, which covers the agent\'s voice replies, so they go out as text. Allow Audio & Speech to keep them.';
  const run = async (args, { existing = null, chat = null } = {}) => {
    const fake = fakeClient({
      '/ModelAccess/List': ruleList(existing ? [existing] : []),
      '/UserAgent/MyAgents': AGENTS,
      '/ModelAccess/Preview': body => rulePreview(existing, ids, chat ? { agentchatmodel: chat } : {})(body),
    });
    let warnings;
    await withClient(fake, async client => {
      const result = await client.callTool({ name: 'manage_model_access', arguments: args });
      assert.notEqual(result.isError, true, textOf(result));
      assert.equal(result.structuredContent.outcome, 'preview', textOf(result));
      warnings = result.structuredContent.warnings;
    });
    return warnings;
  };
  const onlyOne = { action: 'replace', scope: 'agent', agent: 'Sales Bot', everything_else: 'block', models: [{ model: 'google/nano-banana-2', access: 'allow' }] };

  // Only one model: everything else, Audio & Speech included, is blocked.
  assert.ok((await run(onlyOne)).includes(general));
  // Audio & Speech blocked by name of the category, on a rule that allows every other model.
  assert.ok((await run({ action: 'update', scope: 'agent', agent: 'Sales Bot', categories: [{ category: 'audio', access: 'block' }] })).includes(general));
  // Audio & Speech allowed keeps the voice, and LLM & Chat allowed does not.
  assert.equal((await run({ ...onlyOne, categories: [{ category: 'audio', access: 'allow' }] })).some(text => /Audio & Speech/.test(text)), false);
  assert.ok((await run({ ...onlyOne, categories: [{ category: 'llm', access: 'allow' }] })).includes(general));
  // A Gemini agent's voice notes go through the model the rule allows by name; its voice replies do not.
  const gemini = { ref: 'google/gemini-3-flash-preview', model: 'google/gemini-3-flash', blocked: false };
  const geminiOnly = { ...onlyOne, models: [{ model: 'google/gemini-3-flash', access: 'allow' }] };
  assert.ok((await run(geminiOnly, { chat: gemini })).includes(repliesOnly));
  // The same rule for an agent that chats on another provider stops its voice notes too.
  assert.ok((await run(geminiOnly, { chat: { ref: 'openai/gpt-5.6-terra', model: 'openai/gpt-5-6-terra', blocked: true } })).includes(general));
  // A rule that already blocked the voice says nothing new about it.
  const blocking = ruleRow({ guid: 'r-agent', scope: 'agent', target: AGENT, targetlabel: 'Sales Bot', access: 'block', categories: [category('image', 'allow')] });
  assert.equal((await run({ action: 'update', scope: 'agent', agent: 'Sales Bot', categories: [{ category: 'video', access: 'allow' }] }, { existing: blocking })).some(text => /Audio & Speech/.test(text)), false);
  // Other scopes have no built-in voice.
  assert.equal((await run({ action: 'replace', scope: 'surface', surface: 'mcp', everything_else: 'block', categories: [{ category: 'image', access: 'allow' }] })).some(text => /Audio & Speech/.test(text)), false);

  await withClient(fakeClient({}), async client => {
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'manage_model_access');
    assert.match(tool.inputSchema.properties.agent.description, /its built-in voice \(voice notes and voice replies, which count as Audio & Speech\)/);
  });
});

test('manage_spend_limit says an agent pauses at its next step once its own limit is used up', async () => {
  const preview = body => limitPreview(null, 0, { targetlabel: 'Sales Bot' })(body);
  const fake = fakeClient({ '/SpendLimit/List': limitList([]), '/UserAgent/MyAgents': AGENTS, '/SpendLimit/Preview': preview, '/SpendLimit/Set': body => ({ ...preview(body), preview: undefined }) });
  await withClient(fake, async client => {
    const summary = await client.callTool({ name: 'manage_spend_limit', arguments: { action: 'set', scope: 'agent', agent: 'Sales Bot', amount_usd: 25 } });
    assert.notEqual(summary.isError, true, textOf(summary));
    const saved = await client.callTool({ name: 'manage_spend_limit', arguments: summary.structuredContent.nextAction.arguments });
    assert.equal(saved.structuredContent.outcome, 'saved', textOf(saved));
    assert.deepEqual(saved.structuredContent.notes, ['It applies from now on. Once it is used up, the agent pauses at its next step, even in the middle of a reply, a voice call it is on ends after the current turn, and its scheduled tasks pause, until the limit resets or is raised.']);
  });
});
