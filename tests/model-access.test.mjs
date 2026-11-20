import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WiroClient } from '../dist/client.js';
import { PLAYBOOKS } from '../dist/playbooks.js';
import { createMcpServer } from '../dist/server.js';
import { registerRunModel } from '../dist/tools/run-model.js';
import { MODEL_ACCESS_ADVICE, MODEL_ACCESS_CODE, MODEL_ACCESS_NOTE, SPEND_LIMIT_NOTE } from '../dist/utils/api.js';

// Wiro's Model Access: a rule of the workspace (the whole wallet, a team member,
// an API key, a surface or an agent) that blocks a model refuses work with it
// with code 92 before anything runs, and the refusal names the rule. The tools
// say so, and that the rule is not to be tried again or worked around.

const RULE_TEXT = 'This API key can only use selected models, and openai/gpt-6-2-astra is not one of them. '
  + 'Model Access rules decide which models can run.';
const CATEGORY_TEXT = "MCP can't use Video Generation models, and ByteDance/seedance-v2-5-flash is one of them. "
  + 'Model Access rules decide which models can run.';
const AGENT_TEXT = "This agent can't use openai/gpt-6-2-astra. Model Access rules decide which models can run.";

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

const refusal = (message, code = MODEL_ACCESS_CODE) => ({ result: false, errors: [{ code, message }] });

test('the Model Access code is 92 and its note says nothing ran, not to work around the rule, and where it changes', () => {
  assert.equal(MODEL_ACCESS_CODE, 92);
  assert.match(MODEL_ACCESS_NOTE, /^A Model Access rule of this workspace blocks this model, so nothing ran and nothing was charged\. /);
  assert.ok(MODEL_ACCESS_NOTE.endsWith(MODEL_ACCESS_ADVICE));
  assert.match(MODEL_ACCESS_ADVICE, /Do not try again, and do not work around the rule on your own/);
  assert.match(MODEL_ACCESS_ADVICE, /Tell the user which rule blocked the model/);
  assert.match(MODEL_ACCESS_ADVICE, /The account owner or a team admin/);
  assert.match(MODEL_ACCESS_ADVICE, /https:\/\/wiro\.ai\/panel\/controls\/model-access/);
  assert.match(MODEL_ACCESS_ADVICE, /or the user can pick another model\.$/);
  assert.doesNotMatch(MODEL_ACCESS_NOTE, /—|–/);
});

test('run_model passes a Model Access refusal on with its note, and not the spend-limit note', async () => {
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
      registerRunModel(server, new WiroClient(`model-access-key-${Math.random()}`, undefined, 'https://api.example/v1'), { maxWaitMs: 600, retryAfterMs: 250, unansweredWindowMs: 5_000 });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        return await client.callTool({ name: 'run_model', arguments: { model: 'openai/gpt-6-2-astra', params: { prompt: 'hello' }, wait: false } });
      } finally {
        await client.close();
        await server.close();
      }
    };
    for (const code of [92, '92']) {
      const blocked = await run(refusal(RULE_TEXT, code));
      assert.equal(blocked.isError, true);
      assert.equal(textOf(blocked), `## Error\n\nFailed to run model: ${RULE_TEXT} ${MODEL_ACCESS_NOTE}`);
      assert.equal(textOf(blocked).includes(SPEND_LIMIT_NOTE), false);
    }
    const other = await run(refusal('Insufficient wallet balance.', 97));
    assert.equal(textOf(other), '## Error\n\nFailed to run model: Insufficient wallet balance.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('run_workflow and resume_workflow_run add the note to a Model Access refusal', async () => {
  const fake = fakeClient({
    '/Workflow/Run': refusal(CATEGORY_TEXT),
    '/Workflow/RunResume': refusal(CATEGORY_TEXT),
  });
  await withClient(fake, async client => {
    const started = await client.callTool({ name: 'run_workflow', arguments: { slug: 'fox-maker-Ab3xZ', wait_seconds: 0 } });
    assert.equal(started.isError, true);
    assert.ok(textOf(started).includes(`${CATEGORY_TEXT} ${MODEL_ACCESS_NOTE}`), textOf(started));
    assert.equal(textOf(started).includes(SPEND_LIMIT_NOTE), false);
    const resumed = await client.callTool({ name: 'resume_workflow_run', arguments: { workflowtoken: 'wf-token', wait_seconds: 0 } });
    assert.equal(resumed.isError, true);
    assert.ok(textOf(resumed).includes(`${CATEGORY_TEXT} ${MODEL_ACCESS_NOTE}`), textOf(resumed));
    assert.deepEqual(fake.calls.map(call => call.path), ['/Workflow/Run', '/Workflow/RunResume']);
  });
});

test('send_agent_message adds the note when Studio or the Workflow Agent refuses with code 92', async () => {
  for (const [agent, route] of [['studio', '/Studio/Message/Send'], ['workflow-agent', '/StudioWorkflow/Message/Send']]) {
    const fake = fakeClient({ [route]: refusal(CATEGORY_TEXT) });
    await withClient(fake, async client => {
      const result = await client.callTool({ name: 'send_agent_message', arguments: { agent, message: 'make a clip' } });
      assert.equal(result.isError, true);
      assert.equal(textOf(result), `## Error\n\n${CATEGORY_TEXT}\n\n${MODEL_ACCESS_NOTE}`);
      assert.equal(fake.calls.length, 1, 'nothing is sent again');
    });
  }
});

const AGENT_GUID = 'ua-1';
const AGENT_DETAIL = {
  result: true,
  errors: [],
  useragents: [{
    guid: AGENT_GUID,
    title: 'My Bot',
    tier: 'starter',
    status: 0,
    setuprequired: false,
    agent: { custom: true },
    skills: [],
    skillsmeta: {},
    credentials: {},
    communicationChannels: [],
    enabledChannels: [],
    customskills: [],
    scheduledskills: [],
  }],
};

test('update_agent says a Model Access rule kept the model setting from being saved', async () => {
  const alone = fakeClient({ '/UserAgent/Detail': AGENT_DETAIL, '/UserAgent/UpdateSettings': refusal(AGENT_TEXT) });
  await withClient(alone, async client => {
    const result = await client.callTool({ name: 'update_agent', arguments: { agent_guid: AGENT_GUID, chat_model: 'openai/gpt-6-2-astra' } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), `## Error\n\n${AGENT_TEXT} ${MODEL_ACCESS_ADVICE}\n\nThe settings were not saved.`);
  });

  const withTitle = fakeClient({
    '/UserAgent/Detail': AGENT_DETAIL,
    '/UserAgent/Update': { result: true, errors: [], restarting: false, useragents: [] },
    '/UserAgent/UpdateSettings': refusal(AGENT_TEXT),
  });
  await withClient(withTitle, async client => {
    const result = await client.callTool({ name: 'update_agent', arguments: { agent_guid: AGENT_GUID, title: 'New name', chat_model: 'openai/gpt-6-2-astra' } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), `## Error\n\n${AGENT_TEXT} ${MODEL_ACCESS_ADVICE}\n\nThe title change was saved; the settings were not.`);
  });

  // Another settings refusal is passed on as before.
  const other = fakeClient({ '/UserAgent/Detail': AGENT_DETAIL, '/UserAgent/UpdateSettings': refusal('Invalid timezone: must be a valid IANA identifier.', 0) });
  await withClient(other, async client => {
    const result = await client.callTool({ name: 'update_agent', arguments: { agent_guid: AGENT_GUID, timezone: 'Mars/Base' } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nInvalid timezone: must be a valid IANA identifier.');
  });
});

test('get_account says a Model Access rule can block a model', async () => {
  const wallet = { result: true, errors: [], wallet: [{ symbol: 'USD', uuid: 'user-1', amount: '40', giftedamount: '0', storeamount: '0' }] };
  const fake = fakeClient({
    '/Wallet/List': wallet,
    '/Organization/List': { result: true, errors: [], organizations: [] },
    '/SpendLimit/List': { result: true, errors: [], limits: [] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    const lines = textOf(result).split('\n');
    assert.ok(lines.includes('A used-up spend limit refuses new work (error code 93) even when the wallet has money, '
      + 'and a Model Access rule can block a model (error code 92).'), textOf(result));
    assert.doesNotMatch(textOf(result), /team's model rules/);
  });
});

test('the playbooks name code 92 and the Model Access page instead of the old team refusal', () => {
  for (const topic of ['models', 'billing']) {
    assert.match(PLAYBOOKS[topic], /refused with error code 92/, topic);
    assert.match(PLAYBOOKS[topic], /wiro\.ai\/panel\/controls\/model-access/, topic);
    assert.match(PLAYBOOKS[topic], /Do not try again or switch to another model on your own: tell the user which rule blocked it\./, topic);
  }
  const all = Object.values(PLAYBOOKS).join('\n');
  assert.doesNotMatch(all, /This model is not available for your team|Team spend limit has been reached/);
  assert.match(PLAYBOOKS.billing, /refuses the work it covers with error code 93/);
});
