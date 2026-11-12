import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RUN_KEY_HEADER, WiroClient } from '../dist/client.js';
import { registerRunModel } from '../dist/tools/run-model.js';
import { RunLedger, runKey } from '../dist/utils/run-ledger.js';

// run_model on two hosts behind one load balancer: each host is its own
// process with its own ledger, as the two servers of a hosted deployment are
// (or one stdio server before and after a restart). Both reach one Wiro API,
// which keeps the record of each keyed run request where every host reads it.
// The stand-in API below follows Wiro's rules for x-wiro-run-key on the same
// short clock as tests/run-model-retry.test.mjs.
const TIMING = { maxWaitMs: 600, retryAfterMs: 250, unansweredWindowMs: 5_000 };

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * The Wiro API with run keys. A keyed run request whose record is at least
 * `retryAfterMs` old, or whose last call ended unanswered, gets the record's
 * task back unless that task failed; otherwise it starts a task and the record
 * names it. Run/Release ends the record (answered, failed) or marks it
 * unanswered. The nth task runs for `taskMs` (or `taskMs[n]`) and ends with
 * `exitCodes[n]`. A call polls once right away, then every 2 seconds, so
 * within these sub-second waits a task reads as done only if it is at its
 * first poll.
 */
function keyedApi({ taskMs = 60_000, exitCodes = [], runDelayMs = 0, busy = false, readsStatus = true } = {}) {
  const tasks = new Map();
  const records = new Map();
  const api = { runs: [], created: [], releases: [], records };
  const taskDone = task => Date.now() - task.createdAt >= task.runsMs;
  const taskFailed = task => taskDone(task) && task.exitCode !== '0';
  api.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(init.body ?? '{}');
    if (path === '/v1/Run/Release') {
      api.releases.push(body);
      const record = records.get(body.runkey);
      if (!record || record.taskid !== body.taskid) return json({ result: true, errors: [], released: false });
      if (body.outcome === 'unanswered') record.unanswered = true;
      else records.delete(body.runkey);
      return json({ result: true, errors: [], released: true });
    }
    if (path.startsWith('/v1/Run/')) {
      const key = init.headers?.[RUN_KEY_HEADER];
      api.runs.push({ path, body, key });
      await delay(runDelayMs);
      if (busy) {
        return json({ result: false, errors: [{ message: 'The same run request is still creating its task.' }], runkeybusy: true });
      }
      const record = key ? records.get(key) : undefined;
      if (record) {
        const ageMs = Date.now() - record.at;
        const task = tasks.get(record.token);
        // readsStatus false: the task fails right after Wiro handed it out.
        if ((record.unanswered || ageMs >= TIMING.retryAfterMs) && !(readsStatus && taskFailed(task))) {
          record.unanswered = false;
          return json({
            result: true,
            errors: [],
            taskid: record.taskid,
            socketaccesstoken: record.token,
            runkeyreused: true,
            runkeyage: Math.round(ageMs / 1000),
          });
        }
      }
      const n = api.created.length + 1;
      const task = {
        id: String(2000 + n),
        token: `token-${n}`,
        createdAt: Date.now(),
        runsMs: Array.isArray(taskMs) ? taskMs[n - 1] ?? 0 : taskMs,
        exitCode: exitCodes[n - 1] ?? '0',
      };
      tasks.set(task.token, task);
      api.created.push(task.id);
      if (key) records.set(key, { taskid: task.id, token: task.token, at: Date.now(), unanswered: false });
      return json({ result: true, errors: [], taskid: task.id, socketaccesstoken: task.token });
    }
    if (path === '/v1/Task/Detail') {
      const task = tasks.get(body.tasktoken);
      if (!task) return json({ result: false, errors: [{ message: 'task-not-founded' }] });
      const done = taskDone(task);
      return json({
        result: true,
        errors: [],
        total: '1',
        tasklist: [{
          id: task.id,
          socketaccesstoken: task.token,
          parameters: {},
          status: done ? 'task_postprocess_end' : 'task_start',
          pexit: done ? task.exitCode : '',
          debugoutput: '',
          starttime: '',
          endtime: '',
          elapsedseconds: '1',
          totalcost: '0.006',
          modelslugowner: 'owner',
          modelslugproject: 'model',
          outputs: done && task.exitCode === '0'
            ? [{ name: 'image.png', contenttype: 'image/png', size: '2048', url: `https://cdn.example/${task.id}.png` }]
            : [],
        }],
      });
    }
    throw new Error(`unexpected request to ${path}`);
  };
  return api;
}

async function withApi(api, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = api.fetch;
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

let keys = 0;
/** An API key no other test uses. */
function apiKey() {
  keys += 1;
  return `cross-host-key-${keys}`;
}

/**
 * One host: its own process ledger, and, as on the hosted server, a new
 * WiroClient for every request; returns an MCP client connected to it.
 */
async function host(key) {
  const ledger = new RunLedger();
  const server = new McpServer({ name: 'test-host', version: '1.0.0' });
  registerRunModel(server, new WiroClient(key, undefined, 'https://api.example/v1'), TIMING, ledger);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    ledger,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const ARGS = { model: 'owner/model', params: { prompt: 'A lighthouse at dawn', steps: 9 } };

function runModel(client, args = ARGS, options) {
  return client.callTool({ name: 'run_model', arguments: args }, undefined, options);
}

/** A call the client gives up on after `ms` without telling the server. */
function callAndDrop(client, ms, args = ARGS) {
  runModel(client, args).catch(() => {});
  return delay(ms);
}

/** A call the client cancels after `ms`, which sends notifications/cancelled. */
async function callAndCancel(client, ms, args = ARGS) {
  const controller = new AbortController();
  const call = runModel(client, args, { signal: controller.signal });
  await delay(ms);
  controller.abort('the user stopped it');
  await assert.rejects(call);
}

async function until(check, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail('timed out waiting');
    await delay(5);
  }
}

test('every run request carries its run key: the ledger key of the caller, model and parameters', async () => {
  const api = keyedApi({ taskMs: 0 });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    try {
      await runModel(a.client);
    } finally {
      await a.close();
    }
  });
  const identity = new WiroClient(key).identity;
  assert.equal(api.runs.length, 1);
  assert.equal(api.runs[0].key, runKey(identity, ARGS.model, ARGS.params));
  assert.match(api.runs[0].key, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(api.runs[0].body), JSON.stringify(ARGS.params), 'the key travels as a header, never in the model parameters');
});

test('a retry that lands on the other host continues the same task, after a client timeout that sent no cancel', async () => {
  const api = keyedApi({ taskMs: 900 });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    const b = await host(key);
    try {
      // Host A's call is still waiting when the client gives up and retries,
      // and the load balancer sends the retry to host B.
      await callAndDrop(a.client, 400);
      const retry = await runModel(b.client);
      assert.equal(retry.isError, undefined);
      assert.equal(retry.structuredContent.reused, true);
      assert.equal(retry.structuredContent.task.id, '2001');
      assert.match(retry.content[0].text, /^This call continued the task of an identical run_model call made \d+ seconds? ago/);
    } finally {
      await a.close();
      await b.close();
    }
  });
  assert.deepEqual(api.created, ['2001'], 'one task for the call and its retries');
});

test('a retry on the other host right after a cancel continues the cancelled call\'s task', async () => {
  const api = keyedApi({ taskMs: 120 });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    const b = await host(key);
    try {
      // Cancelled well inside retryAfterMs: only the unanswered release lets
      // host B know this is a retry, not a call sent side by side.
      await callAndCancel(a.client, 60);
      await until(() => api.releases.some(release => release.outcome === 'unanswered'));
      await delay(100);
      const retry = await runModel(b.client);
      assert.equal(retry.structuredContent.reused, true);
      assert.equal(retry.structuredContent.state, 'completed');
      assert.equal(retry.structuredContent.task.id, '2001');
    } finally {
      await a.close();
      await b.close();
    }
  });
  assert.deepEqual(api.created, ['2001']);
  assert.deepEqual(api.releases.map(release => [release.taskid, release.outcome]), [['2001', 'unanswered'], ['2001', 'answered']]);
});

test('retries that move from host to host keep the one task', async () => {
  // Over HTTP a client that gives up closes its connection and the server
  // sees the close, so the call ends unanswered, as a cancel does here.
  const api = keyedApi({ taskMs: 60_000 });
  const key = apiKey();
  await withApi(api, async () => {
    const hosts = [await host(key), await host(key)];
    try {
      for (const index of [0, 1, 0, 1]) await callAndCancel(hosts[index].client, 80);
      const last = await runModel(hosts[0].client);
      assert.equal(last.structuredContent.reused, true);
      assert.equal(last.structuredContent.task.id, '2001');
    } finally {
      for (const entry of hosts) await entry.close();
    }
  });
  assert.deepEqual(api.created, ['2001']);
});

test('an identical call on the other host after the first answer arrived starts a new task', async () => {
  const api = keyedApi({ taskMs: 0 });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    const b = await host(key);
    try {
      const first = await runModel(a.client);
      assert.equal(first.structuredContent.state, 'completed');
      await until(() => api.releases.length === 1);
      await delay(TIMING.retryAfterMs);
      const second = await runModel(b.client);
      assert.equal(second.structuredContent.reused, undefined);
      assert.notEqual(second.structuredContent.task.id, first.structuredContent.task.id);
    } finally {
      await a.close();
      await b.close();
    }
  });
  assert.deepEqual(api.created, ['2001', '2002']);
  assert.deepEqual(api.releases[0], { runkey: api.runs[0].key, taskid: '2001', outcome: 'answered' });
});

test('identical calls sent side by side to both hosts each start their own task', async () => {
  const api = keyedApi({ taskMs: 0 });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    const b = await host(key);
    try {
      const results = await Promise.all([runModel(a.client), runModel(b.client)]);
      assert.deepEqual(results.map(result => result.structuredContent.reused), [undefined, undefined]);
    } finally {
      await a.close();
      await b.close();
    }
  });
  assert.equal(api.created.length, 2);
});

test('a retry whose task already failed gets a new task from Wiro', async () => {
  const api = keyedApi({ taskMs: [200, 0], exitCodes: ['1', '0'] });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    const b = await host(key);
    try {
      await callAndDrop(a.client, 300);
      const retry = await runModel(b.client);
      assert.equal(retry.structuredContent.state, 'completed');
      assert.equal(retry.structuredContent.task.id, '2002');
      assert.equal(retry.structuredContent.reused, undefined);
    } finally {
      await a.close();
      await b.close();
    }
  });
  assert.deepEqual(api.created, ['2001', '2002']);
});

test('a task that fails right after Wiro handed it to a retry is replaced once, by a new task', async () => {
  // The first task fails, and so does its replacement: the call answers the
  // replacement's failure instead of starting a third task.
  const api = keyedApi({ taskMs: [200, 0], exitCodes: ['1', '1'], readsStatus: false });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    const b = await host(key);
    try {
      await callAndDrop(a.client, 300);
      const retry = await runModel(b.client);
      assert.equal(retry.structuredContent.state, 'failed');
      assert.equal(retry.structuredContent.task.id, '2002');
      assert.equal(retry.structuredContent.reused, undefined, 'the answer is the new task, not the continued one');
    } finally {
      await a.close();
      await b.close();
    }
  });
  assert.deepEqual(api.created, ['2001', '2002']);
  assert.ok(api.releases.some(release => release.taskid === '2001' && release.outcome === 'failed'), 'the failed run\'s record ended before the new request');
});

test('a run request Wiro answers busy starts nothing and says how to find the task', async () => {
  const api = keyedApi({ busy: true });
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    try {
      const result = await runModel(a.client);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /An identical run_model call is still starting its task on Wiro, so this call started nothing and nothing was charged for it\. Do not run the model again now: in a minute, call list_tasks with model "model"/);
    } finally {
      await a.close();
    }
  });
  assert.deepEqual(api.created, []);
});

test('a lost or refused release never fails a call', async () => {
  const api = keyedApi({ taskMs: 0 });
  const fetchRun = api.fetch;
  api.fetch = async (url, init) => {
    if (new URL(String(url)).pathname === '/v1/Run/Release') throw new TypeError('fetch failed');
    return fetchRun(url, init);
  };
  const key = apiKey();
  await withApi(api, async () => {
    const a = await host(key);
    try {
      const result = await runModel(a.client);
      assert.equal(result.structuredContent.state, 'completed');
      assert.equal(result.isError, undefined);
    } finally {
      await a.close();
    }
  });
});

test('WiroClient refuses a malformed run key and lets no requestHeaders hook set one', async () => {
  const client = new WiroClient('api-key', undefined, 'https://api.example/v1');
  await assert.rejects(client.runModel('owner/model', {}, undefined, { runKey: 'not-a-key' }), /runKey must be 64 lowercase hex characters/);
  const hooked = new WiroClient('api-key', undefined, 'https://api.example/v1', {
    requestHeaders: () => ({ [RUN_KEY_HEADER]: 'f'.repeat(64) }),
  });
  await assert.rejects(hooked.post('/Tool/List', {}), new RegExp(`requestHeaders cannot set ${RUN_KEY_HEADER}`));
});
