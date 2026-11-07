import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server.js';

async function withClient(fakeWiroClient, callback, options) {
  const server = createMcpServer(fakeWiroClient, options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// 10000 tags plus the tags member make 10001 elements, one more than the default limit.
// list_workflows takes at most 20 tags.
const manyTags = Array.from({ length: 10_000 }, (_, index) => `tag-${index}`);

test('a tool that needs no input runs when the call leaves out arguments', async () => {
  const fakeWiroClient = {
    authType: 'apikey-only',
    post: async path => (path === '/Wallet/List'
      ? { result: true, errors: [], wallet: [{ symbol: 'USD', uuid: 'user-guid-1', amount: '12.5', giftedamount: '0', storeamount: '0' }] }
      : { result: true, errors: [], organizations: [] }),
  };

  await withClient(fakeWiroClient, async client => {
    const result = await client.callTool({ name: 'get_account' });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.balance.totalUsd, 12.5);
  });
});

test('a tool call with more than 10000 elements gets one short error', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'list_workflows', arguments: { tags: manyTags } });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      'MCP error -32602: Invalid arguments for tool list_workflows: arguments contain more than the maximum of 10000 elements',
    );
  });
});

test('maxToolInputElements: Infinity turns the check off', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'list_workflows', arguments: { tags: manyTags } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Too big: expected array to have <=20 items at tags/);
  }, { maxToolInputElements: Infinity });
});
