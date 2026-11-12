import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TaskWaitTimeoutError, WiroClient } from '../dist/client.js';
import { createMcpServer } from '../dist/server.js';
import { registerRunModel } from '../dist/tools/run-model.js';

// run_model with the real WiroClient against a stand-in for the Wiro API, on
// a short clock: a call waits at most 600 ms, an identical call 250 ms after a
// still waiting one counts as its retry, and a call that ended unanswered can
// be continued for 5 seconds.
const TIMING = { maxWaitMs: 600, retryAfterMs: 250, unansweredWindowMs: 5_000 };
const SLACK_MS = 400;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function abortError() {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * The Wiro API as fetch sees it. A run request answers after `runDelayMs` and
 * honours its abort signal as fetch does; the task it creates runs for
 * `taskMs`, then ends with exit code `exitCode`.
 */
function fakeApi({ runDelayMs = 0, taskMs = 60_000, exitCode = '0' } = {}) {
  const tasks = new Map();
  const api = { runs: [], runSignals: [] };
  api.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(init.body ?? '{}');
    if (path.startsWith('/v1/Run/')) {
      const n = api.runs.length + 1;
      api.runs.push({ path, body });
      api.runSignals.push(init.signal);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, runDelayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortError());
        }, { once: true });
      });
      const task = { id: String(1000 + n), token: `token-${n}`, createdAt: Date.now() };
      tasks.set(task.token, task);
      return json({ result: true, errors: [], taskid: task.id, socketaccesstoken: task.token });
    }
    if (path === '/v1/Task/Detail') {
      const task = tasks.get(body.tasktoken);
      if (!task) return json({ result: false, errors: [{ message: 'task-not-founded' }] });
      const done = Date.now() - task.createdAt >= taskMs;
      return json({
        result: true,
        errors: [],
        total: '1',
        tasklist: [{
          id: task.id,
          socketaccesstoken: task.token,
          parameters: {},
          status: done ? 'task_postprocess_end' : 'task_start',
          pexit: done ? exitCode : '',
          debugoutput: '',
          starttime: '',
          endtime: '',
          elapsedseconds: '1',
          totalcost: '0.006',
          modelslugowner: 'owner',
          modelslugproject: 'model',
          outputs: done && exitCode === '0'
            ? [{ name: 'image.png', contenttype: 'image/png', size: '2048', url: 'https://cdn.example/image.png' }]
            : [],
        }],
      });
    }
    throw new Error(`unexpected request to ${path}`);
  };
  return api;
}

let keys = 0;
/** A client with an API key no other test uses, so runs never cross tests. */
function wiroClient() {
  keys += 1;
  return new WiroClient(`retry-test-key-${keys}`, undefined, 'https://api.example/v1');
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

/** One MCP client connected to a server that has only run_model, on TIMING. */
async function connect(wiro, timing = TIMING) {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  registerRunModel(server, wiro, timing);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const ARGS = { model: 'owner/model', params: { prompt: 'A mountain lake at sunset', steps: 9 } };

function runModel(client, args = ARGS, options) {
  return client.callTool({ name: 'run_model', arguments: args }, undefined, options);
}

/** A call the client gives up on after `ms` without telling the server, as Zed does at 60 seconds. */
function callAndDrop(client, ms, args = ARGS) {
  const call = runModel(client, args);
  call.catch(() => {});
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

test('run_model answers within its wait budget, the run request included', async () => {
  const api = fakeApi({ runDelayMs: 400 });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient());
    try {
      const started = Date.now();
      const result = await runModel(client, { ...ARGS, timeout_seconds: 600 });
      const elapsed = Date.now() - started;

      // The 400 ms run request comes out of the same 600 ms budget as the polling.
      assert.ok(elapsed >= TIMING.maxWaitMs - 50, `answered after ${elapsed} ms`);
      assert.ok(elapsed < TIMING.maxWaitMs + SLACK_MS, `answered after ${elapsed} ms`);
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.state, 'running');
      assert.equal(result.structuredContent.task.token, 'token-1');
      assert.equal(result.structuredContent.nextAction.tool, 'wait_for_task');
      assert.equal(api.runs.length, 1);
    } finally {
      await close();
    }
  });
});

test('a run request slower than the budget is not waited for, and an identical call continues it', async () => {
  const api = fakeApi({ runDelayMs: 1_200, taskMs: 0 });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient());
    try {
      const started = Date.now();
      const first = await runModel(client);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < TIMING.maxWaitMs + SLACK_MS, `answered after ${elapsed} ms`);
      assert.equal(first.isError, true);
      assert.match(first.content[0].text, /Wiro had not confirmed the run request \d+ seconds after it was sent/);
      assert.match(first.content[0].text, /Do not run the model again now: in a minute, call list_tasks with model "model"/);

      // The run request was not cancelled with the call: Wiro's answer still
      // arrives, and the identical call picks that task up.
      assert.equal(api.runSignals[0], undefined);
      await delay(800);
      const second = await runModel(client);
      assert.equal(api.runs.length, 1);
      assert.notEqual(second.isError, true);
      assert.equal(second.structuredContent.state, 'completed');
      assert.equal(second.structuredContent.task.token, 'token-1');
      assert.equal(second.structuredContent.reused, true);
      assert.match(second.content[0].text, /^This call continued the task of an identical run_model call made \d+ seconds? ago, whose answer did not reach you, instead of starting and billing a new task\./);
    } finally {
      await close();
    }
  });
});

test('timeout_seconds sets the whole wait, up to an hour', async () => {
  const waits = [];
  const fake = {
    identity: 'wait-test',
    runModel: async () => {
      await delay(50);
      return { result: true, errors: [], taskid: '7', socketaccesstoken: 'wait-token' };
    },
    waitForTask: async (_token, timeoutMs) => {
      waits.push(timeoutMs);
      throw new TaskWaitTimeoutError(timeoutMs);
    },
  };
  const server = createMcpServer(fake);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['run_model', 'wait_for_task']) {
      const timeout = tools.find(entry => entry.name === name).inputSchema.properties.timeout_seconds;
      assert.equal(timeout.maximum, 3600, name);
      assert.equal(timeout.default, 45, name);
    }
    for (const name of ['run_workflow', 'resume_workflow_run', 'send_agent_message', 'get_agent_message', 'control_agent', 'get_my_agent']) {
      assert.equal(tools.find(entry => entry.name === name).inputSchema.properties.wait_seconds.maximum, 3600, name);
    }
    assert.match(
      tools.find(entry => entry.name === 'run_model').inputSchema.properties.timeout_seconds.description,
      /counted from the start of the call\. The 45-second default is safe for clients with a 60-second tool timeout; wait longer, such as 300 seconds for a video, when the client allows longer tool calls\./,
    );

    // The 50 ms run request comes out of the wait the call asked for; the rest is polling.
    for (const timeout_seconds of [3600, 300, undefined]) {
      const result = await client.callTool({
        name: 'run_model',
        arguments: { model: 'owner/model', params: { prompt: `wait ${timeout_seconds}` }, ...(timeout_seconds ? { timeout_seconds } : {}) },
      });
      assert.equal(result.structuredContent.state, 'submitted');
    }
    assert.equal(waits.length, 3);
    for (const [index, seconds] of [3600, 300, 45].entries()) {
      assert.ok(waits[index] <= seconds * 1000 - 40 && waits[index] > seconds * 1000 - 2000, `asked ${seconds} s, polled ${waits[index]} ms`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('a retry after notifications/cancelled continues the cancelled call\'s task', async () => {
  const api = fakeApi({ taskMs: 150 });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient());
    try {
      await callAndCancel(client, 100);
      await delay(100);
      const retry = await runModel(client);

      assert.equal(api.runs.length, 1);
      assert.notEqual(retry.isError, true);
      assert.equal(retry.structuredContent.state, 'completed');
      assert.equal(retry.structuredContent.task.token, 'token-1');
      assert.equal(retry.structuredContent.reused, true);
      assert.match(retry.content[0].text, /^This call continued the task of an identical run_model call/);
      assert.match(retry.content[0].text, /https:\/\/cdn\.example\/image\.png/);

      // Its answer reached the client, so the same call once more is a new run.
      const again = await runModel(client);
      assert.equal(api.runs.length, 2);
      assert.equal(again.structuredContent.reused, undefined);
      assert.doesNotMatch(again.content[0].text, /continued the task/);
    } finally {
      await close();
    }
  });
});

test('a cancel during the run request does not lose the task', async () => {
  const api = fakeApi({ runDelayMs: 300, taskMs: 0 });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient());
    try {
      await callAndCancel(client, 100);
      // The run request is still on its way; the retry waits for the same one.
      const retry = await runModel(client);
      assert.equal(api.runs.length, 1);
      assert.equal(retry.structuredContent.state, 'completed');
      assert.equal(retry.structuredContent.task.token, 'token-1');
      assert.equal(retry.structuredContent.reused, true);
    } finally {
      await close();
    }
  });
});

test('a retry after a client timeout that sent no cancel continues the waiting call', async () => {
  const api = fakeApi({ taskMs: 60_000 });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient());
    try {
      // The first call is still waiting on the server when the client gives up.
      await callAndDrop(client, TIMING.retryAfterMs + 50);
      const retry = await runModel(client);
      assert.equal(api.runs.length, 1);
      assert.notEqual(retry.isError, true);
      assert.equal(retry.structuredContent.state, 'running');
      assert.equal(retry.structuredContent.task.token, 'token-1');
      assert.equal(retry.structuredContent.reused, true);
      assert.equal(retry.structuredContent.nextAction.tool, 'wait_for_task');
    } finally {
      await close();
    }
  });
});

test('identical calls sent side by side each start their own task', async () => {
  const api = fakeApi({ taskMs: 0 });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient());
    try {
      const results = await Promise.all([runModel(client), runModel(client), runModel(client)]);
      assert.equal(api.runs.length, 3);
      assert.deepEqual(results.map(result => result.structuredContent.task.token).sort(), ['token-1', 'token-2', 'token-3']);
      for (const result of results) assert.equal(result.structuredContent.reused, undefined);
    } finally {
      await close();
    }
  });
});

test('an identical call after one that answered starts a new task', async () => {
  for (const taskMs of [0, 60_000]) {
    const api = fakeApi({ taskMs });
    await withApi(api, async () => {
      const { client, close } = await connect(wiroClient());
      try {
        // A finished task, and one still running when the call answered: in
        // both the client got the task, so the same call again is a new run.
        const first = await runModel(client);
        const second = await runModel(client);
        assert.equal(api.runs.length, 2, `task of ${taskMs} ms`);
        assert.equal(first.structuredContent.task.token, 'token-1');
        assert.equal(second.structuredContent.task.token, 'token-2');
        assert.equal(second.structuredContent.reused, undefined);
      } finally {
        await close();
      }
    });
  }
});

test('a continued run whose task failed is replaced by a new run', async () => {
  const api = fakeApi({ taskMs: 50, exitCode: '1' });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient());
    try {
      await callAndCancel(client, 20);
      await delay(100);
      const retry = await runModel(client);
      assert.equal(api.runs.length, 2);
      assert.equal(retry.structuredContent.task.token, 'token-2');
      assert.equal(retry.structuredContent.reused, undefined);
      assert.doesNotMatch(retry.content[0].text, /continued the task/);
    } finally {
      await close();
    }
  });
});

test('only the same API key, model and parameters continue a run, in any key order', async () => {
  const api = fakeApi({ taskMs: 100 });
  await withApi(api, async () => {
    const wiro = wiroClient();
    const { client, close } = await connect(wiro);
    const other = await connect(wiroClient());
    try {
      await callAndCancel(client, 30);
      await delay(50);

      // Another project's key, another model and other parameters each start their own run.
      await Promise.all([
        runModel(other.client),
        runModel(client, { ...ARGS, model: 'owner/other-model' }),
        runModel(client, { ...ARGS, params: { ...ARGS.params, steps: 10 } }),
      ]);
      assert.equal(api.runs.length, 4);

      // The same parameters in another order are the same call.
      const retry = await runModel(client, { ...ARGS, model: 'Owner/Model', params: { steps: 9, prompt: ARGS.params.prompt } });
      assert.equal(api.runs.length, 4);
      assert.equal(retry.structuredContent.task.token, 'token-1');
      assert.equal(retry.structuredContent.reused, true);
    } finally {
      await close();
      await other.close();
    }
  });
});

test('an unanswered run is continued only inside its window', async () => {
  const api = fakeApi({ taskMs: 100 });
  await withApi(api, async () => {
    const { client, close } = await connect(wiroClient(), { ...TIMING, unansweredWindowMs: 200 });
    try {
      await callAndCancel(client, 30);
      await delay(400);
      const late = await runModel(client);
      assert.equal(api.runs.length, 2);
      assert.equal(late.structuredContent.task.token, 'token-2');
      assert.equal(late.structuredContent.reused, undefined);
    } finally {
      await close();
    }
  });
});
