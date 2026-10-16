import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { WiroClient } from '../dist/client.js';
import {
  assertPublicHttpUrl,
  fetchPublicFile,
  isDisallowedIp,
} from '../dist/utils/remote-file.js';

test('non-public addresses are refused, public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:7f00:1']) {
    assert.equal(isDisallowedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(isDisallowedIp(ip), false, ip);
  }
});

test('only http(s) URLs pass, and IP-literal hosts must be public', () => {
  assert.doesNotThrow(() => assertPublicHttpUrl(new URL('https://example.com/a.png')));
  assert.doesNotThrow(() => assertPublicHttpUrl(new URL('http://8.8.8.8/a.png')));
  for (const url of ['file:///etc/hosts', 'ftp://example.com/a', 'data:text/plain,hi', 'http://127.0.0.1/', 'http://[::1]/', 'http://2130706433/']) {
    assert.throws(() => assertPublicHttpUrl(new URL(url)), undefined, url);
  }
});

test('a download from a loopback server is refused before any request', { concurrency: false }, async (t) => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end('local file');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  await assert.rejects(fetchPublicFile(`http://127.0.0.1:${port}/a.txt`), /not a public address/);
  await assert.rejects(fetchPublicFile(`http://localhost:${port}/a.txt`), /not a public address/);
  assert.equal(hits, 0);
});

test('uploadFile refuses a non-public URL without calling the Wiro API', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async () => {
    apiCalls++;
    return new Response('{}');
  };
  try {
    const client = new WiroClient('test-key');
    await assert.rejects(client.uploadFile('http://127.0.0.1:9/a.png'), /not a public address/);
    await assert.rejects(client.uploadFile('file:///etc/hosts'), /Only http\(s\) URLs/);
    assert.equal(apiCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
