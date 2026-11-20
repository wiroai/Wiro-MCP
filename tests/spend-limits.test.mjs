import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WiroClient } from '../dist/client.js';
import { createMcpServer } from '../dist/server.js';
import { registerRunModel } from '../dist/tools/run-model.js';
import { SPEND_LIMIT_CODE, spendLimitNote, spendRefusalShape } from '../dist/utils/api.js';

// Wiro's spend limits: a workspace's limit (the whole wallet, a team member, an
// API key, a surface or an agent) that is used up refuses new work with code 93
// before anything runs, and so does one with less left than a run's known price.
// The tools say which, and that trying the same work again changes nothing;
// get_controls shows the limits and manage_spend_limit changes them.

const LIMIT_TEXT = "This API key's monthly spend limit is reached ($50.00 of $50.00). It resets on December 1, 2026 at 00:00 UTC.";
const LEFT_TEXT = "This team's monthly spend limit has $3.10 left of $500.00, and this run costs $4.00. It resets on December 1, 2026 at 00:00 UTC.";
// Wiro's refusals when work it let in earlier holds part of the limit, word for word as the run gate writes them.
const HELD_TEXT = "This API key's daily spend limit is reached ($11.00 of $10.00). Runs in progress hold $3.00 of it. It resets at 00:00 UTC.";
const LEFT_HELD_TEXT = "This API key's daily spend limit has $0.80 left of $20.00, and this run costs $1.20. Runs in progress hold $19.20 of it. It resets at 00:00 UTC.";

// The notes as a server with the controls tools gives them, and as one without them (the default of a tool registered on its own).
const WITH_CONTROLS = { controls: true };
const SPEND_LIMIT_NOTE = spendLimitNote(LIMIT_TEXT, WITH_CONTROLS);
const SPEND_LIMIT_LEFT_NOTE = spendLimitNote(LEFT_TEXT, WITH_CONTROLS);

const textOf = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

async function withClient(fakeWiroClient, callback) {
  const server = createMcpServer({ authType: 'apikey-only', ...fakeWiroClient });
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
    post: async (path, body) => handle(path, body),
    postForm: async (path, form) => handle(path, form),
  };
}

test('the spend-limit code is 93 and its note says nothing ran and not to retry', () => {
  assert.equal(SPEND_LIMIT_CODE, 93);
  for (const text of [LIMIT_TEXT, LEFT_TEXT, HELD_TEXT, LEFT_HELD_TEXT]) {
    const loaded = spendLimitNote(text, WITH_CONTROLS);
    const alone = spendLimitNote(text);
    for (const note of [loaded, alone]) {
      assert.match(note, /nothing ran and nothing was charged/);
      assert.match(note, /the account owner, a team admin or the organization's owner/);
      assert.match(note, /https:\/\/wiro\.ai\/panel\/controls\/spend-limits/);
      // The agent-owner path is gone, and no old link is left.
      assert.doesNotMatch(note, /agent's owner|panel\/wallet\/limits/);
      assert.doesNotMatch(note, /—|–/);
    }
    // The controls tools are named only where they are loaded; without them, get_account and the dashboard.
    assert.match(loaded, /get_controls shows the limit and when it resets, and manage_spend_limit changes it after the user confirms a change summary/);
    assert.doesNotMatch(alone, /get_controls|manage_spend_limit|check_model_access|manage_model_access/);
    assert.match(alone, /on the Spend Limits page of the Wiro dashboard: https:\/\/wiro\.ai\/panel\/controls\/spend-limits\. get_account lists the limits\.$/);
  }
  assert.match(SPEND_LIMIT_NOTE, /^A spend limit of this workspace is used up, so nothing ran and nothing was charged\. Do not try again until the limit resets/);
  assert.match(SPEND_LIMIT_NOTE, /https:\/\/wiro\.ai\/panel\/controls\/spend-limits\.$/);
});

test('the spend-limit note follows the refusal: used up, less left than this costs, or room held by running work', () => {
  assert.equal(spendRefusalShape(LIMIT_TEXT), 'used-up');
  assert.equal(spendRefusalShape("Your daily spend limit is reached ($10.00 of $10.00). It resets at 00:00 UTC."), 'used-up');
  assert.equal(spendRefusalShape(LEFT_TEXT), 'left');
  // An agent purchase and a workflow are refused the same way.
  assert.equal(spendRefusalShape("This team's monthly spend limit has $12.00 left of $40.00, and this purchase costs $30.00. It resets on December 1, 2026 at 00:00 UTC."), 'left');
  assert.equal(spendRefusalShape("This team's monthly spend limit has $10.00 left of $50.00, and this workflow costs $12.00. It resets on December 1, 2026 at 00:00 UTC."), 'left');
  assert.match(SPEND_LIMIT_LEFT_NOTE, /^A spend limit of this workspace has less left than this costs, so nothing ran and nothing was charged\. The limit is not used up: cheaper work/);
  assert.match(SPEND_LIMIT_LEFT_NOTE, /start it only with the user's yes/);
  assert.match(SPEND_LIMIT_LEFT_NOTE, /This same work stays refused until the limit resets/);
  assert.doesNotMatch(SPEND_LIMIT_LEFT_NOTE, /is used up, so|Do not try again until/);

  // A limit that is full because running work holds the rest is not used up: the held part frees up when that work ends.
  assert.equal(spendRefusalShape(HELD_TEXT), 'held');
  assert.equal(spendRefusalShape("This team's monthly spend limit is reached ($10.00 of $10.00). Runs in progress hold $4.00 of it. It resets on December 1, 2026 at 00:00 UTC."), 'held');
  const held = spendLimitNote(HELD_TEXT, WITH_CONTROLS);
  assert.match(held, /^A spend limit of this workspace has no room left for new work, because work that is still running holds the rest of it, so nothing ran and nothing was charged\. The limit is not used up: the held part frees up when that work ends, and only what the work is charged counts\. Do not try again while that work is running\./);
  assert.match(held, /Once it has ended, this work may fit, but start it only with the user's yes\./);
  assert.doesNotMatch(held, /is used up, so|Do not try again until the limit resets/);

  // Less left than this costs, with part of it held: cheaper work may fit now, and this work once the running work ends.
  assert.equal(spendRefusalShape(LEFT_HELD_TEXT), 'left-held');
  assert.equal(spendRefusalShape("Your monthly spend limit has $2.00 left of $6.00, and this run costs $2.50. Runs in progress hold $4.00 of it. It resets on December 1, 2026 at 00:00 UTC."), 'left-held');
  const leftHeld = spendLimitNote(LEFT_HELD_TEXT, WITH_CONTROLS);
  assert.match(leftHeld, /^A spend limit of this workspace has less left than this costs, so nothing ran and nothing was charged\. The limit is not used up: cheaper work/);
  assert.match(leftHeld, /Work that is still running holds part of the limit\. That part frees up when the work ends, and only what the work is charged counts, so this same work may fit then: try it again only after that work has ended, and only with the user's yes\./);
  assert.doesNotMatch(leftHeld, /This same work stays refused until/);
});

test('run_model passes a spend-limit refusal on with the note, and a balance refusal without it', async () => {
  const originalFetch = globalThis.fetch;
  const answer = { current: null };
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/Run/Release') return new Response(JSON.stringify({ result: true, errors: [], released: false }), { status: 200 });
    if (path.startsWith('/v1/Run/')) return new Response(JSON.stringify(answer.current), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`unexpected request to ${path}`);
  };
  try {
    const run = async (body, notes) => {
      answer.current = body;
      const server = new McpServer({ name: 'test-server', version: '1.0.0' });
      registerRunModel(server, new WiroClient(`spend-limit-key-${Math.random()}`, undefined, 'https://api.example/v1'), { maxWaitMs: 600, retryAfterMs: 250, unansweredWindowMs: 5_000 }, undefined, notes);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        return await client.callTool({ name: 'run_model', arguments: { model: 'owner/model', params: { prompt: 'a fox' }, wait: false } });
      } finally {
        await client.close();
        await server.close();
      }
    };
    const limited = await run({ result: false, errors: [{ code: 93, message: LIMIT_TEXT }] }, WITH_CONTROLS);
    assert.equal(limited.isError, true);
    assert.equal(textOf(limited), `## Error\n\nFailed to run model: ${LIMIT_TEXT} ${SPEND_LIMIT_NOTE}`);
    // A run that costs more than is left: the limit is not used up, and a cheaper run may fit.
    const left = await run({ result: false, errors: [{ code: 93, message: LEFT_TEXT }] }, WITH_CONTROLS);
    assert.equal(left.isError, true);
    assert.equal(textOf(left), `## Error\n\nFailed to run model: ${LEFT_TEXT} ${SPEND_LIMIT_LEFT_NOTE}`);
    assert.doesNotMatch(textOf(left), /is used up/);
    // Running work holds the rest: not used up, and this run may fit once that work ends.
    const held = await run({ result: false, errors: [{ code: 93, message: HELD_TEXT }] }, WITH_CONTROLS);
    assert.equal(textOf(held), `## Error\n\nFailed to run model: ${HELD_TEXT} ${spendLimitNote(HELD_TEXT, WITH_CONTROLS)}`);
    assert.doesNotMatch(textOf(held), /is used up, so/);
    // Registered on its own, run_model knows nothing of the controls tools and names get_account and the dashboard.
    const alone = await run({ result: false, errors: [{ code: 93, message: LIMIT_TEXT }] });
    assert.equal(textOf(alone), `## Error\n\nFailed to run model: ${LIMIT_TEXT} ${spendLimitNote(LIMIT_TEXT)}`);
    assert.doesNotMatch(textOf(alone), /get_controls|manage_spend_limit/);
    const balance = await run({ result: false, errors: [{ code: 97, message: 'Insufficient wallet balance.' }] });
    assert.equal(textOf(balance), '## Error\n\nFailed to run model: Insufficient wallet balance.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('run_workflow and resume_workflow_run add the note to a spend-limit refusal', async () => {
  const fake = fakeClient({
    '/Workflow/Run': { result: false, errors: [{ code: 93, message: LIMIT_TEXT }] },
    '/Workflow/RunResume': { result: false, errors: [{ code: 93, message: LIMIT_TEXT }] },
  });
  await withClient(fake, async client => {
    const started = await client.callTool({ name: 'run_workflow', arguments: { slug: 'fox-maker-Ab3xZ', wait_seconds: 0 } });
    assert.equal(started.isError, true);
    assert.ok(textOf(started).includes(`${LIMIT_TEXT} ${SPEND_LIMIT_NOTE}`), textOf(started));
    const resumed = await client.callTool({ name: 'resume_workflow_run', arguments: { workflowtoken: 'wf-token', wait_seconds: 0 } });
    assert.equal(resumed.isError, true);
    assert.ok(textOf(resumed).includes(`${LIMIT_TEXT} ${SPEND_LIMIT_NOTE}`), textOf(resumed));
    assert.deepEqual(fake.calls.map(call => call.path), ['/Workflow/Run', '/Workflow/RunResume']);
  });
  const left = fakeClient({ '/Workflow/Run': { result: false, errors: [{ code: 93, message: LEFT_TEXT }] } });
  await withClient(left, async client => {
    const started = await client.callTool({ name: 'run_workflow', arguments: { slug: 'fox-maker-Ab3xZ', wait_seconds: 0 } });
    assert.equal(started.isError, true);
    assert.ok(textOf(started).includes(`${LEFT_TEXT} ${SPEND_LIMIT_LEFT_NOTE}`), textOf(started));
  });
});

test('send_agent_message picks the note by the refusal, for Studio and the Workflow Agent', async () => {
  for (const [message, note] of [
    [LIMIT_TEXT, SPEND_LIMIT_NOTE],
    [LEFT_TEXT, SPEND_LIMIT_LEFT_NOTE],
    [LEFT_HELD_TEXT, spendLimitNote(LEFT_HELD_TEXT, WITH_CONTROLS)],
  ]) {
    const fake = fakeClient({ '/Studio/Message/Send': { result: false, errors: [{ code: 93, message }] } });
    await withClient(fake, async client => {
      const result = await client.callTool({ name: 'send_agent_message', arguments: { agent: 'studio', message: 'make a clip' } });
      assert.equal(result.isError, true);
      assert.equal(textOf(result), `## Error\n\n${message}\n\n${note}`);
      assert.equal(fake.calls.length, 1, 'nothing is sent again');
    });
  }
});

test('without the controls group, the 93 note points to get_account and the dashboard, not to tools that are not there', async () => {
  const fake = fakeClient({
    '/Workflow/Run': { result: false, errors: [{ code: 93, message: HELD_TEXT }] },
    '/Studio/Message/Send': { result: false, errors: [{ code: 93, message: LEFT_TEXT }] },
  });
  const server = createMcpServer({ authType: 'apikey-only', ...fake }, { toolsets: ['models', 'workflows', 'agents'] });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.some(tool => tool.name === 'get_controls'), false);
    const started = await client.callTool({ name: 'run_workflow', arguments: { slug: 'fox-maker-Ab3xZ', wait_seconds: 0 } });
    assert.ok(textOf(started).includes(`${HELD_TEXT} ${spendLimitNote(HELD_TEXT)}`), textOf(started));
    const sent = await client.callTool({ name: 'send_agent_message', arguments: { agent: 'studio', message: 'make a clip' } });
    assert.equal(textOf(sent), `## Error\n\n${LEFT_TEXT}\n\n${spendLimitNote(LEFT_TEXT)}`);
    for (const result of [started, sent]) {
      assert.doesNotMatch(textOf(result), /get_controls|manage_spend_limit|check_model_access|manage_model_access/);
      assert.match(textOf(result), /get_account lists the limits\./);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

const WALLET = { result: true, errors: [], wallet: [{ symbol: 'USD', uuid: 'user-1', amount: '40', giftedamount: '0', storeamount: '0' }] };
const ORGS = { result: true, errors: [], organizations: [] };

test('get_account lists the spend limits with what each has used, and which are used up', async () => {
  const fake = fakeClient({
    '/Wallet/List': WALLET,
    '/Organization/List': ORGS,
    '/SpendLimit/List': {
      result: true,
      errors: [],
      limits: [
        { guid: 'l-1', scope: 'account', target: '', period: 'month', amountusd: 300, spentusd: 248.7, resetsat: 1796083200, alertpct: 80 },
        { guid: 'l-2', scope: 'project', target: '48211', targetlabel: 'Production', period: 'day', amountusd: 25, spentusd: 25.2, resetsat: 1795219200 },
        { guid: 'l-3', scope: 'surface', target: 'llm-gateway', targetlabel: 'the LLM gateway', period: 'month', amountusd: 50, spentusd: 3 },
        { scope: 'nonsense', period: 'month', amountusd: 1 },
      ],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = textOf(result).split('\n');
    assert.ok(lines.includes('**Spend limits:**'), textOf(result));
    assert.ok(lines.includes('- Monthly limit for the whole wallet: $248.7 of $300 (resets 2026-12-01T00:00:00.000Z)'), textOf(result));
    assert.ok(lines.includes('- Daily limit for the API key of project `Production`: $25.2 of $25, used up: new work it covers is refused until it resets (resets 2026-11-21T00:00:00.000Z)'), textOf(result));
    assert.ok(lines.includes('- Monthly limit for calls through `the LLM gateway`: $3 of $50'), textOf(result));
    assert.ok(lines.includes('A used-up spend limit refuses new work (error code 93) even when the wallet has money, '
      + 'and a Model Access rule can block a model (error code 92).'), textOf(result));
    assert.deepEqual(result.structuredContent.spendLimits.map(l => [l.scope, l.usedUp]), [['account', false], ['project', true], ['surface', false]]);
    assert.equal(result.structuredContent.balance.totalUsd, 40);
  });
});

test('get_account keeps the balance when the spend limits cannot be read', async () => {
  const fake = fakeClient({ '/Wallet/List': WALLET, '/Organization/List': ORGS, '/SpendLimit/List': { result: false, errors: [{ code: 0, message: 'Parsing url error.' }] } });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.balance.totalUsd, 40);
    assert.equal(result.structuredContent.spendLimits, undefined);
    assert.match(result.structuredContent.spendLimitsError, /Parsing url error/);
    assert.match(textOf(result), /The spend limits could not be read: /);
  });
});

test('get_account with no limits says none', async () => {
  const fake = fakeClient({ '/Wallet/List': WALLET, '/Organization/List': ORGS, '/SpendLimit/List': { result: true, errors: [], limits: [] } });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.ok(textOf(result).split('\n').includes('**Spend limits:** none'));
    assert.deepEqual(result.structuredContent.spendLimits, []);
  });
});

test('get_account says whether this connection can change the controls, and names the tools only when they are loaded', async () => {
  const listed = canmanage => ({
    result: true,
    errors: [],
    workspace: { type: 'team', teamguid: 'team-1', canmanage },
    limits: [{ guid: 'l-1', scope: 'account', target: '', period: 'month', amountusd: 300, spentusd: 248.7, heldusd: 12.5, resetsat: 1796083200, alertpct: 80 }],
  });
  const routes = canmanage => ({ '/Wallet/List': WALLET, '/Organization/List': ORGS, '/SpendLimit/List': listed(canmanage) });

  const admin = fakeClient(routes(true));
  await withClient(admin, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(result.structuredContent.controls, { canManage: true });
    assert.equal(result.structuredContent.spendLimits[0].heldUsd, 12.5);
    const lines = textOf(result).split('\n');
    assert.ok(lines.includes('- Monthly limit for the whole wallet: $248.7 of $300, $12.5 held by work still running (resets 2026-12-01T00:00:00.000Z)'), textOf(result));
    assert.ok(lines.includes('This connection can change them with manage_spend_limit and manage_model_access, after a change summary; get_controls shows the rules and what each limit used.'), textOf(result));
    const { tools } = await client.listTools();
    assert.match(tools.find(tool => tool.name === 'get_account').description, /says whether this connection can change Spend Limits and Model Access rules \(get_controls shows the rules\)\.$/);
  });

  const member = fakeClient(routes(false));
  await withClient(member, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.deepEqual(result.structuredContent.controls, { canManage: false });
    assert.ok(textOf(result).split('\n').includes('This connection can only read the spend limits and Model Access rules: a team admin or the organization\'s owner changes them. get_controls shows them all.'), textOf(result));
  });

  // Without the controls group, get_account names the dashboard instead of tools that are not loaded.
  const server = createMcpServer({ authType: 'apikey-only', ...fakeClient(routes(false)) }, { toolsets: ['models'] });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.some(tool => tool.name === 'get_controls'), false);
    assert.doesNotMatch(tools.find(tool => tool.name === 'get_account').description, /get_controls/);
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.ok(textOf(result).split('\n').includes('This connection can only read the spend limits and Model Access rules: a team admin or the organization\'s owner changes them at https://wiro.ai/panel/controls/spend-limits.'), textOf(result));
    assert.doesNotMatch(textOf(result), /get_controls|manage_spend_limit/);
  } finally {
    await client.close();
    await server.close();
  }

  // An answer without the workspace keeps the old fields only.
  const older = fakeClient({ '/Wallet/List': WALLET, '/Organization/List': ORGS, '/SpendLimit/List': { result: true, errors: [], limits: [] } });
  await withClient(older, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.equal(result.structuredContent.controls, undefined);
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ['authMode', 'balance', 'spendLimits', 'workspace']);
  });
});
