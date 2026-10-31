import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
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

test('uploadFile refuses a .zip archive without calling the Wiro API', { concurrency: false }, async () => {
  const originalGet = https.get;
  const originalFetch = globalThis.fetch;
  // The download answers with the type in the path, so each case needs no server.
  https.get = (url, _options, callback) => {
    const type = decodeURIComponent(new URL(url).pathname.split('/')[1]);
    const response = Readable.from([Buffer.from('PK\u0003\u0004 test bytes')]);
    response.statusCode = 200;
    response.headers = { 'content-type': type };
    const request = new EventEmitter();
    process.nextTick(() => callback(response));
    return request;
  };
  const apiCalls = [];
  globalThis.fetch = async url => {
    apiCalls.push(String(url));
    return new Response(JSON.stringify({ result: true, errors: [], list: [{ id: 'enc-id', name: 'a.png', contenttype: 'image/png', size: '20', url: 'https://cdn.example/k/a.png' }] }));
  };
  try {
    const client = new WiroClient('test-key', undefined, 'https://api.example/v1');
    for (const type of ['application/zip', 'application/zip; charset=binary', 'Application/X-Zip-Compressed', 'application/x-zip']) {
      await assert.rejects(
        client.uploadFile(`https://files.example.com/${encodeURIComponent(type)}/archive.zip`),
        /A \.zip archive cannot be uploaded as one file\. Pass the archive's public URL to the model directly, or upload its files one at a time\./,
        type,
      );
    }
    assert.deepEqual(apiCalls, []);

    // Other types are uploaded as before; Wiro answers for them.
    for (const type of ['image/png', 'application/octet-stream']) {
      const upload = await client.uploadFile(`https://files.example.com/${encodeURIComponent(type)}/a.png`);
      assert.equal(upload.result, true, type);
    }
    assert.deepEqual(apiCalls, ['https://api.example/v1/File/Upload', 'https://api.example/v1/File/Upload']);
  } finally {
    https.get = originalGet;
    globalThis.fetch = originalFetch;
  }
});
