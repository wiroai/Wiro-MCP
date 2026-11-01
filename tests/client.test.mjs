import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isTaskNotFound,
  TaskPollingError,
  TaskWaitTimeoutError,
  WiroApiError,
  WiroClient,
} from '../dist/client.js';
import { errorText } from '../dist/utils/api.js';

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

test('isOwnApiKey says whether a value is this client\'s key, and hands out nothing', () => {
  const client = new WiroClient('own-api-key', 'own-api-secret');
  assert.equal(client.isOwnApiKey('own-api-key'), true);
  for (const value of ['other-key', 'own-api-key ', 'OWN-API-KEY', 'own-api-secret', '', null, undefined, 1, {}, ['own-api-key']]) {
    assert.equal(client.isOwnApiKey(value), false, JSON.stringify(value));
  }
});

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

test('waitForTask stops at once for a task that is not in the workspace', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  // Wiro's answer for an unknown task and for another workspace's task.
  const notFound = {
    total: '0',
    errors: [{ time: 1793463112, code: 0, message: 'task-not-founded' }],
    tasklist: [],
    result: false,
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(notFound);
  };

  try {
    const client = new WiroClient('api-key');
    await assert.rejects(
      client.waitForTask({ taskid: '1' }, 100, { pollIntervalMs: 1 }),
      error => {
        assert.ok(error instanceof TaskPollingError);
        assert.equal(error.message, 'Task not found in this workspace');
        assert.deepEqual(error.lastDetail, notFound);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(isTaskNotFound(notFound), true);
    assert.equal(isTaskNotFound(detail('task_start')), false);

    // Any other refusal may pass, so it is asked again.
    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(calls === 1
        ? { ...notFound, errors: [{ code: 0, message: 'task-not-checked' }] }
        : detail('task_postprocess_end', { pexit: '0' }));
    };
    const result = await client.waitForTask('task-token', 100, { pollIntervalMs: 1 });
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

// Requests that WiroClient 1.4.1 sent, JSON and multipart, with and without an
// API secret, on the default base URL and another one.
const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/client-requests-1.4.1.json', import.meta.url), 'utf8'));

function recordedClient({ apiKey, apiSecret, baseUrl }, options) {
  const args = [apiKey, apiSecret ?? undefined, baseUrl ?? undefined];
  if (options !== undefined) args.push(options);
  return new WiroClient(...args);
}

function describeBody(body) {
  if (typeof body === 'string') return { type: 'string', value: body };
  assert.ok(body instanceof FormData, 'the body is a string or FormData');
  return {
    type: 'FormData',
    fields: [...body.entries()].map(([name, value]) => (typeof value === 'string'
      ? { name, value }
      : { name, filename: value.name, type: value.type, size: value.size })),
  };
}

// Makes one recorded call with Date.now fixed at `now` and returns what fetch got.
async function sendRecorded(client, call, now) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return jsonResponse({ result: true, errors: [] });
  };
  Date.now = () => now;
  try {
    if (call.method === 'post') {
      await client.post(call.path, call.body);
    } else {
      const form = new FormData();
      for (const field of call.form) {
        form.append(field.name, new Blob([field.text], { type: field.type }), field.filename);
      }
      await client.postForm(call.path, form);
    }
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
  assert.equal(seen.length, 1, 'one fetch per call');
  const [{ url, init }] = seen;
  return { url, method: init.method, headers: init.headers, body: describeBody(init.body) };
}

function isError(type, message) {
  return error => {
    assert.equal(error.constructor, type);
    assert.equal(error.message, message);
    return true;
  };
}

test('without requestHeaders a client sends exactly the requests 1.4.1 sent', { concurrency: false }, async () => {
  assert.equal(RECORDED.cases.length, 8);
  // No options, options without the hook, and a hook that adds nothing.
  for (const options of [undefined, {}, { requestHeaders: undefined }, { requestHeaders: () => ({}) }]) {
    for (const recorded of RECORDED.cases) {
      const client = recordedClient(recorded.client, options);
      for (const { now, call, expected } of recorded.requests) {
        const sent = await sendRecorded(client, call, now);
        assert.deepEqual(sent, expected, recorded.id);
        assert.deepEqual(Object.keys(sent.headers), Object.keys(expected.headers), `${recorded.id}: header order`);
      }
    }
  }
});

test('requestHeaders gets the path and API key of every request and adds its headers last', { concurrency: false }, async () => {
  for (const recorded of RECORDED.cases) {
    const seen = [];
    const client = recordedClient(recorded.client, {
      requestHeaders: request => {
        seen.push(request);
        return { 'x-example-path': request.pathname, 'X-Example-Key': `key ${request.apiKey}` };
      },
    });
    for (const { now, call, expected, derived } of recorded.requests) {
      seen.length = 0;
      const sent = await sendRecorded(client, call, now);
      assert.match(derived.pathname, /^\/v1\/(Tool\/List|File\/Upload)$/);
      assert.deepEqual(seen, [{ pathname: derived.pathname, apiKey: recorded.client.apiKey }], recorded.id);
      const added = { 'x-example-path': derived.pathname, 'X-Example-Key': `key ${recorded.client.apiKey}` };
      // The client's own headers, the URL, the method and the body stay as they were.
      assert.deepEqual(sent, { ...expected, headers: { ...expected.headers, ...added } }, recorded.id);
      assert.deepEqual(
        Object.keys(sent.headers),
        [...Object.keys(expected.headers), ...Object.keys(added)],
        `${recorded.id}: header order`,
      );
    }
  }
});

test('requestHeaders runs again for each request', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push([String(url), init.headers['x-example-count'], init.headers['x-example-path']]);
    return jsonResponse(detail('task_postprocess_end', { pexit: '0' }));
  };
  let count = 0;

  try {
    const client = new WiroClient('api-key', 'api-secret', undefined, {
      requestHeaders: ({ pathname }) => ({ 'x-example-count': String(++count), 'x-example-path': pathname }),
    });
    await client.searchModels({ search: 'flux' });
    await client.cancelTask('task-token');
    await client.killTask({ taskid: '123' });

    assert.deepEqual(sent, [
      ['https://api.wiro.ai/v1/Tool/List', '1', '/v1/Tool/List'],
      ['https://api.wiro.ai/v1/Task/Detail', '2', '/v1/Task/Detail'],
      ['https://api.wiro.ai/v1/Task/Cancel', '3', '/v1/Task/Cancel'],
      ['https://api.wiro.ai/v1/Task/Kill', '4', '/v1/Task/Kill'],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestHeaders cannot set the client\'s own auth or content headers', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return jsonResponse({ result: true, errors: [] });
  };

  try {
    const names = ['x-api-key', 'X-API-Key', 'x-signature', 'X-Signature', 'x-nonce', 'X-NONCE', 'content-type', 'Content-Type'];
    for (const name of names) {
      const requestHeaders = () => ({ 'x-example': 'allowed', [name]: 'replaced' });
      const refusal = isError(Error, `requestHeaders cannot set ${name}; WiroClient sets it`);
      for (const client of [
        new WiroClient('api-key', 'api-secret', undefined, { requestHeaders }),
        new WiroClient('api-key', undefined, undefined, { requestHeaders }),
      ]) {
        await assert.rejects(client.post('/Tool/List', {}), refusal);
        await assert.rejects(client.postForm('/File/Upload', new FormData()), refusal);
      }
    }
    assert.equal(fetched, 0, 'no request is sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestHeaders must return a plain object of string values', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let lastHeaders;
  let fetched = 0;
  globalThis.fetch = async (_url, init) => {
    fetched += 1;
    lastHeaders = init.headers;
    return jsonResponse({ result: true, errors: [] });
  };
  const notPlain = 'requestHeaders must return a plain object of header names and string values';
  const cases = [
    [() => ({ 'x-example': 1 }), TypeError, 'requestHeaders returned a non-string value for x-example'],
    [() => ({ 'x-first': 'a', 'x-example': undefined }), TypeError, 'requestHeaders returned a non-string value for x-example'],
    [() => ({ 'x-example': null }), TypeError, 'requestHeaders returned a non-string value for x-example'],
    [() => ({ 'x-example': ['a'] }), TypeError, 'requestHeaders returned a non-string value for x-example'],
    [() => undefined, TypeError, notPlain],
    [() => null, TypeError, notPlain],
    [() => 'x-example: a', TypeError, notPlain],
    [() => [['x-example', 'a']], TypeError, notPlain],
    [() => new Headers({ 'x-example': 'a' }), TypeError, notPlain],
    [() => new Map([['x-example', 'a']]), TypeError, notPlain],
    [async () => ({ 'x-example': 'a' }), TypeError, notPlain],
    [() => { throw new RangeError('no headers for this request'); }, RangeError, 'no headers for this request'],
  ];

  try {
    for (const [requestHeaders, type, message] of cases) {
      const client = new WiroClient('api-key', undefined, undefined, { requestHeaders });
      await assert.rejects(client.post('/Tool/List', {}), isError(type, message));
      await assert.rejects(client.postForm('/File/Upload', new FormData()), isError(type, message));
    }
    assert.equal(fetched, 0, 'no request is sent');

    // An object without a prototype is a plain object too.
    const client = new WiroClient('api-key', undefined, undefined, {
      requestHeaders: () => Object.assign(Object.create(null), { 'x-example': 'a' }),
    });
    await client.post('/Tool/List', {});
    assert.deepEqual(lastHeaders, { 'x-api-key': 'api-key', 'Content-Type': 'application/json', 'x-example': 'a' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a requestHeaders option that is not a function is refused', () => {
  for (const requestHeaders of [null, 'x-example: a', { 'x-example': 'a' }]) {
    assert.throws(
      () => new WiroClient('api-key', undefined, undefined, { requestHeaders }),
      isError(TypeError, 'requestHeaders must be a function'),
    );
  }
});

test('the removed trustedProxy option throws instead of being ignored', () => {
  const removed = isError(Error, 'The trustedProxy option was removed in 1.5.0; pass requestHeaders instead.');
  for (const options of [
    { trustedProxy: {} },
    { trustedProxy: undefined },
    { trustedProxy: null },
    { trustedProxy: {}, requestHeaders: () => ({}) },
  ]) {
    assert.throws(() => new WiroClient('api-key', undefined, undefined, options), removed);
    assert.throws(() => new WiroClient('api-key', 'api-secret', 'https://api.example.test/v1', options), removed);
  }
});

// What the Wiro API answers for a project with signature auth when the request
// has only x-api-key.
const SIGNATURE_REQUIRED = {
  result: false,
  errors: [{
    code: 0,
    message: 'Project requires signature authentication. '
      + 'x-signature and x-nonce headers are required.',
  }],
};

test('a signature client signs every request, a key-only client does not', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const headers = [];
  globalThis.fetch = async (_url, init) => {
    headers.push(init?.headers);
    return jsonResponse({ result: true, errors: [], total: '0', tasklist: [] });
  };

  try {
    await new WiroClient('api-key', 'api-secret').listTasks();
    await new WiroClient('api-key').listTasks();

    const [signed, keyOnly] = headers;
    assert.equal(signed['x-api-key'], 'api-key');
    assert.equal(
      signed['x-signature'],
      crypto.createHmac('sha256', 'api-key')
        .update(`api-secret${signed['x-nonce']}`)
        .digest('hex'),
    );
    assert.equal(keyOnly['x-api-key'], 'api-key');
    assert.equal(Object.hasOwn(keyOnly, 'x-signature'), false);
    assert.equal(Object.hasOwn(keyOnly, 'x-nonce'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a key-only client on a signature-auth project says where the secret goes', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(SIGNATURE_REQUIRED, 401);

  try {
    const client = new WiroClient('api-key', undefined, undefined, {
      missingSecretHint: 'Enter API_KEY:API_SECRET as the API key.',
    });
    await assert.rejects(client.listTasks(), error => {
      assert.ok(error instanceof WiroApiError);
      assert.equal(error.status, 401);
      assert.equal(
        error.message,
        'Wiro API error 401: Enter API_KEY:API_SECRET as the API key.',
      );
      assert.equal(error.responseBody, JSON.stringify(SIGNATURE_REQUIRED));
      return true;
    });

    await assert.rejects(
      new WiroClient('api-key').runModel('owner/model', {}),
      {
        message: 'Wiro API error 401: This project uses signature-based auth. '
          + 'Pass its API secret to WiroClient along with the API key.',
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('other 401s keep the API message', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async () => jsonResponse(body, 401);

  try {
    body = {
      result: false,
      errors: [{ code: 0, message: 'Project authorization is not founded.' }],
    };
    await assert.rejects(new WiroClient('api-key').listTasks(), error => {
      assert.equal(error.hint, undefined);
      assert.equal(error.message, `Wiro API error 401: ${JSON.stringify(body)}`);
      return true;
    });

    body = {
      result: false,
      errors: [{ code: 0, message: 'Project authorization is not valid.' }],
    };
    await assert.rejects(new WiroClient('api-key', 'wrong-secret').listTasks(), error => {
      assert.equal(error.hint, undefined);
      assert.equal(error.message, `Wiro API error 401: ${JSON.stringify(body)}`);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a web page answer is one short line in the error message and stays whole in responseBody', { concurrency: false }, async () => {
  const page = '<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n'
    + '<center><h1>504 Gateway Time-out</h1></center>\r\n<hr><center>proxy</center>\r\n</body>\r\n</html>\r\n';
  const error = new WiroApiError(504, page);
  assert.equal(error.message, 'Wiro API error 504: Gateway Time-out');
  assert.equal(errorText(error), 'Wiro API error 504: Gateway Time-out');
  assert.equal(error.responseBody, page);

  // Without a title the page's text is used, without markup, scripts or styles, and cut to 200 characters.
  assert.equal(new WiroApiError(502, '<html>502 Bad Gateway</html>').message, 'Wiro API error 502: Bad Gateway');
  const long = `<!DOCTYPE html><html><head><style>body{color:red}</style><script>var x = 1;</script></head><body><p>${'word '.repeat(200)}</p></body></html>`;
  const message = new WiroApiError(520, long).message;
  assert.doesNotMatch(message, /[<>]|color:red|var x/);
  assert.ok(message.length <= 'Wiro API error 520: '.length + 203, String(message.length));
  assert.equal(new WiroApiError(503, '<html><title>503</title></html>').message, 'Wiro API error 503: 503');
  assert.equal(new WiroApiError(500, '<html><body></body></html>').message, 'Wiro API error 500: the answer was a web page with no text');

  // JSON, plain text and hints are shown as before.
  const json = JSON.stringify({ result: false, errors: [{ code: 0, message: 'Some refusal.' }] });
  assert.equal(new WiroApiError(401, json).message, `Wiro API error 401: ${json}`);
  assert.equal(errorText(new WiroApiError(401, json)), 'Wiro API error 401: Some refusal.');
  assert.equal(new WiroApiError(502, 'Bad gateway').message, 'Wiro API error 502: Bad gateway');
  assert.equal(new WiroApiError(500, 'a < b and c > d').message, 'Wiro API error 500: a < b and c > d');
  assert.equal(new WiroApiError(401, '{"result":false}', 'A hint.').message, 'Wiro API error 401: A hint.');

  // The same holds for the client's own requests, and for a 2xx page that is not JSON.
  const originalFetch = globalThis.fetch;
  let answer;
  globalThis.fetch = async () => answer();
  try {
    answer = () => new Response(page, { status: 504, headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(new WiroClient('api-key').listTasks(), thrown => {
      assert.ok(thrown instanceof WiroApiError);
      assert.equal(thrown.message, 'Wiro API error 504: Gateway Time-out');
      assert.equal(thrown.responseBody, page);
      return true;
    });
    answer = () => new Response('<html><body><h1>Maintenance</h1></body></html>', { status: 200 });
    await assert.rejects(new WiroClient('api-key').listTasks(), { message: 'Invalid JSON response: Maintenance' });

    // Text that starts like JSON but does not parse stays out of the message.
    const part = '{"result":true,"rows":[{"value":"stays-out';
    assert.equal(new WiroApiError(500, part).message, 'Wiro API error 500: the answer could not be read');
    assert.equal(new WiroApiError(500, part).responseBody, part);
    answer = () => new Response(part, { status: 200 });
    await assert.rejects(new WiroClient('api-key').listTasks(), { message: 'Invalid JSON response: the answer could not be read' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForTask stops on a missing secret and keeps the hint', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(SIGNATURE_REQUIRED, 401);
  };

  try {
    const client = new WiroClient('api-key', undefined, undefined, {
      missingSecretHint: 'Enter API_KEY:API_SECRET as the API key.',
    });
    await assert.rejects(
      client.waitForTask('task-token', 100, { pollIntervalMs: 1 }),
      error => {
        assert.ok(error instanceof TaskPollingError);
        assert.equal(
          error.message,
          'Task status request failed with HTTP 401. '
            + 'Enter API_KEY:API_SECRET as the API key.',
        );
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
