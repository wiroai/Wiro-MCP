import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  TaskWaitTimeoutError,
  WiroClient,
} from '../dist/client.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function task(status, overrides = {}) {
  return {
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status,
    pexit: '',
    debugoutput: '',
    starttime: '',
    endtime: '',
    elapsedseconds: '0',
    totalcost: '0',
    outputs: [],
    ...overrides,
  };
}

function detail(status, overrides = {}) {
  return {
    result: true,
    errors: [],
    total: '1',
    tasklist: [task(status, overrides)],
  };
}

test('runModel preserves first-turn and continuation tool-call payloads', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });
    return jsonResponse({
      result: true,
      errors: [],
      taskid: '123',
      socketaccesstoken: 'task-token',
    });
  };

  const firstTurnParams = {
    messages: [{ role: 'user', content: 'Check the weather.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    session_id: 'weather-session',
  };
  const continuationParams = {
    previousTaskToken: 'previous-task-token',
    toolOutputs: [{
      call_id: 'call_01',
      output: { temperature_c: 12 },
    }],
    session_id: 'weather-session',
  };

  try {
    const client = new WiroClient('api-key');
    await client.runModel('claude/fable-5', firstTurnParams);
    await client.runModel('claude/fable-5', continuationParams);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.endsWith('/Run/claude/fable-5'), true);
    assert.equal(requests[1].url.endsWith('/Run/claude/fable-5'), true);
    assert.deepEqual(requests[0].body, firstTurnParams);
    assert.deepEqual(requests[1].body, continuationParams);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForTask continues after DB task_error', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(
      calls === 1
        ? detail('task_error', { debugerror: 'Output folder creation failed' })
        : detail('task_postprocess_end', { pexit: '1' }),
    );
  };

  try {
    const client = new WiroClient('api-key');
    const result = await client.waitForTask('task-token', 100, {
      pollIntervalMs: 1,
    });

    assert.equal(calls, 2);
    assert.equal(result.tasklist[0].status, 'task_postprocess_end');
    assert.equal(result.tasklist[0].pexit, '1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForTask timeout preserves the last task detail', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(detail('task_start'));

  try {
    const client = new WiroClient('api-key');
    await assert.rejects(
      client.waitForTask('task-token', 20, { pollIntervalMs: 1 }),
      error => {
        assert.ok(error instanceof TaskWaitTimeoutError);
        assert.equal(error.lastDetail?.tasklist[0].status, 'task_start');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForTask retries a transient fetch failure', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('temporary network failure');
    return jsonResponse(detail('task_postprocess_end', { pexit: '0' }));
  };

  try {
    const client = new WiroClient('api-key');
    const result = await client.waitForTask('task-token', 100, {
      pollIntervalMs: 1,
    });

    assert.equal(calls, 2);
    assert.equal(result.tasklist[0].status, 'task_postprocess_end');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForTask honors a caller abort signal', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse(detail('task_start'));
  };

  try {
    const client = new WiroClient('api-key');
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      client.waitForTask('task-token', 100, {
        signal: controller.signal,
        pollIntervalMs: 1,
      }),
      error => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancelTask resolves a token and sends the required taskid', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });
    if (requests.length === 1) return jsonResponse(detail('task_queue'));
    return jsonResponse({ result: true, errors: [], tasklist: [] });
  };

  try {
    const client = new WiroClient('api-key');
    await client.cancelTask('task-token');

    assert.equal(requests[0].url.endsWith('/Task/Detail'), true);
    assert.deepEqual(requests[0].body, { tasktoken: 'task-token' });
    assert.equal(requests[1].url.endsWith('/Task/Cancel'), true);
    assert.deepEqual(requests[1].body, { taskid: '123' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('killTask maps a task token to socketaccesstoken', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return jsonResponse({ result: true, errors: [], tasklist: [] });
  };

  try {
    const client = new WiroClient('api-key');
    await client.killTask('task-token');

    assert.deepEqual(requestBody, { socketaccesstoken: 'task-token' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listTasks scopes by auth without sending uuid', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
    };
    return jsonResponse({
      result: true,
      errors: [],
      total: '0',
      tasklist: [],
    });
  };

  try {
    const client = new WiroClient('api-key');
    await client.listTasks({
      start: 20,
      limit: 5,
      model: 'flux',
    });

    assert.equal(request.url.endsWith('/Task/List'), true);
    assert.deepEqual(request.body, {
      type: 'model',
      sort: 'id',
      order: 'DESC',
      start: '20',
      limit: '5',
      modelName: 'flux',
    });
    assert.equal(Object.hasOwn(request.body, 'uuid'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('trusted proxy context signs the caller IP and API path', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const sharedSecret = 's'.repeat(32);
  let headers;
  Date.now = () => 1_800_000_000_000;
  globalThis.fetch = async (_url, init) => {
    headers = init?.headers;
    return jsonResponse(detail('task_postprocess_end', { pexit: '0' }));
  };

  try {
    const client = new WiroClient(
      'api-key',
      undefined,
      'http://localhost:1453/v1',
      {
        trustedProxy: {
          clientIp: '203.0.113.8',
          sharedSecret,
        },
      },
    );
    await client.getTask({ taskid: '123' });

    const payload = [
      '1800000000000',
      '203.0.113.8',
      'api-key',
      '/v1/Task/Detail',
    ].join('\n');
    const expected = crypto
      .createHmac('sha256', sharedSecret)
      .update(payload)
      .digest('hex');

    assert.equal(headers['x-wiro-proxy-client-ip'], '203.0.113.8');
    assert.equal(headers['x-wiro-proxy-timestamp'], '1800000000000');
    assert.equal(headers['x-wiro-proxy-signature'], expected);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
