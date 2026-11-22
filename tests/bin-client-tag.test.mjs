import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The wiro-mcp-server command names itself to Wiro with x-wiro-client: wiro-mcp/<version>, so the runs of an
// install people run themselves count on the mcp surface. A WiroClient built by other code sends no such tag
// (client.test.mjs: without requestHeaders a client sends exactly what 1.4.1 sent).

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('the wiro-mcp-server command names itself to Wiro on every request', async () => {
  const seen = [];
  const api = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ path: request.url, headers: request.headers, body });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ result: true, errors: [], tasklist: [], total: '0' }));
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const { port } = api.address();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { WIRO_API_KEY: 'test-key', WIRO_API_BASE_URL: `http://127.0.0.1:${port}/v1` },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'list_tasks', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
  } finally {
    await client.close();
    await new Promise(resolve => api.close(resolve));
  }

  assert.ok(seen.length > 0, 'the command sent no request');
  assert.ok(seen.some(request => request.path === '/v1/Task/List'), JSON.stringify(seen.map(request => request.path)));
  for (const request of seen) {
    assert.equal(request.headers['x-wiro-client'], `wiro-mcp/${version}`, request.path);
    assert.equal(request.headers['x-api-key'], 'test-key', request.path);
  }
});
