import assert from 'node:assert/strict';
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

test('waitForTask treats DB task_error as terminal', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(detail('task_error', {
    debugerror: 'Output folder creation failed',
  }));

  try {
    const client = new WiroClient('api-key');
    const result = await client.waitForTask('task-token', 100, {
      pollIntervalMs: 1,
    });

    assert.equal(result.tasklist[0].status, 'task_error');
    assert.equal(result.tasklist[0].debugerror, 'Output folder creation failed');
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
