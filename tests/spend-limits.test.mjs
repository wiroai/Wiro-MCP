import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WiroClient } from '../dist/client.js';
import { createMcpServer } from '../dist/server.js';
import { registerRunModel } from '../dist/tools/run-model.js';
import { SPEND_LIMIT_CODE, SPEND_LIMIT_NOTE } from '../dist/utils/api.js';

// Wiro's spend limits: a workspace's limit (the whole wallet, a team member, an
// API key, a surface or an agent) that is used up refuses new work with code 93
// before anything runs. The tools say so and that trying again changes nothing;
// get_account lists the limits.

const LIMIT_TEXT = "This API key's monthly spend limit is reached ($50.00 of $50.00). It resets on December 1, 2026 at 00:00 UTC.";

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
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      const route = routes[path];
      if (route === undefined) throw new Error(`Unexpected call to ${path}`);
      return typeof route === 'function' ? route(body, calls) : structuredClone(route);
    },
  };
}

test('the spend-limit code is 93 and its note says nothing ran and not to retry', () => {
  assert.equal(SPEND_LIMIT_CODE, 93);
  assert.match(SPEND_LIMIT_NOTE, /nothing ran and nothing was charged/);
  assert.match(SPEND_LIMIT_NOTE, /Do not try again until the limit resets/);
  assert.match(SPEND_LIMIT_NOTE, /https:\/\/wiro\.ai\/panel\/wallet\/limits/);
  assert.doesNotMatch(SPEND_LIMIT_NOTE, /—|–/);
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
    const run = async body => {
      answer.current = body;
      const server = new McpServer({ name: 'test-server', version: '1.0.0' });
      registerRunModel(server, new WiroClient(`spend-limit-key-${Math.random()}`, undefined, 'https://api.example/v1'), { maxWaitMs: 600, retryAfterMs: 250, unansweredWindowMs: 5_000 });
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
    const limited = await run({ result: false, errors: [{ code: 93, message: LIMIT_TEXT }] });
    assert.equal(limited.isError, true);
    assert.equal(textOf(limited), `## Error\n\nFailed to run model: ${LIMIT_TEXT} ${SPEND_LIMIT_NOTE}`);
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
    assert.ok(lines.includes('A used-up spend limit refuses new work (error code 93) even when the wallet has money.'), textOf(result));
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
