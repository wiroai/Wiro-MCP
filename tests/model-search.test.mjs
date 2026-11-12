import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WiroClient } from '../dist/client.js';
import { PLAYBOOKS } from '../dist/playbooks.js';
import { createMcpServer } from '../dist/server.js';

async function withClient(fakeWiroClient, callback) {
  const server = createMcpServer(fakeWiroClient);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // Listed first, so the client checks every result against the output schema.
    await client.listTools();
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const row = {
  cleanslugowner: 'wiro',
  cleanslugproject: 'text-to-image-flux-fast',
  title: 'Flux Fast Text to Image',
  categories: ['text-to-image'],
  approximatelycost: 0.003,
  cps: 0,
  parameters: null,
};

// What Tool/List with `searchfallback` answers when no model has every word.
const partial = {
  result: true,
  errors: [],
  total: 137,
  tool: [row],
  searchused: 'text to image',
  searchignored: ['flat', 'illustration'],
};

const NOTE = 'No model matched every word of "text to image flat illustration", so these results are for '
  + '"text to image" (left out: "flat", "illustration"). Style and subject words belong in the prompt, not the search.';
const HINT = 'Search by the task or the model name, such as "text to image" or "upscale image"; '
  + 'style and subject words belong in the prompt.';

test('searchModels asks Tool/List for the search fallback only with a search', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse({ result: true, errors: [], total: 0, tool: [] });
  };

  try {
    const client = new WiroClient('api-key');
    await client.searchModels({ search: 'text to image flat illustration' });
    await client.searchModels({ search: '  ' });
    await client.searchModels({ categories: ['text-to-image'] });

    assert.equal(bodies[0].search, 'text to image flat illustration');
    assert.equal(bodies[0].searchfallback, true);
    assert.equal('searchfallback' in bodies[1], false);
    assert.equal('searchfallback' in bodies[2], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recommend_model says which words its results leave out', async () => {
  let sent;
  const fakeWiroClient = {
    searchModels: async params => {
      sent = params;
      return partial;
    },
  };

  await withClient(fakeWiroClient, async client => {
    const result = await client.callTool({ name: 'recommend_model', arguments: { task: 'text to image flat illustration' } });
    assert.notEqual(result.isError, true);
    assert.equal(sent.search, 'text to image flat illustration');
    const text = result.content[0].text;
    assert.ok(text.startsWith(`${NOTE}\n\n## Recommended Models for "text to image" (1 results)`), text);
    assert.equal(result.structuredContent.searchUsed, 'text to image');
    assert.deepEqual(result.structuredContent.ignoredWords, ['flat', 'illustration']);
    assert.equal(result.structuredContent.total, 137);
    assert.equal(result.structuredContent.nextAction.arguments.model, 'wiro/text-to-image-flux-fast');
  });
});

test('search_models says which words its results leave out', async () => {
  const fakeWiroClient = { searchModels: async () => partial };

  await withClient(fakeWiroClient, async client => {
    const result = await client.callTool({
      name: 'search_models',
      arguments: { search: 'text to image flat illustration', categories: ['text-to-image'] },
    });
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    assert.ok(text.startsWith(`${NOTE}\n\n## Models (1 results)`), text);
    assert.equal(result.structuredContent.searchUsed, 'text to image');
    assert.deepEqual(result.structuredContent.ignoredWords, ['flat', 'illustration']);
  });
});

test('a search every word matched, or an API without the fallback, reads as before', async () => {
  const answers = [
    { result: true, errors: [], total: 1, tool: [row] },
    // Not a list of words: read as no fallback.
    { result: true, errors: [], total: 1, tool: [row], searchused: 'text', searchignored: 'image' },
    { result: true, errors: [], total: 1, tool: [row], searchignored: ['', '  '] },
  ];
  for (const answer of answers) {
    const fakeWiroClient = { searchModels: async () => answer };
    await withClient(fakeWiroClient, async client => {
      const recommended = await client.callTool({ name: 'recommend_model', arguments: { task: 'text to image' } });
      assert.ok(recommended.content[0].text.startsWith('## Recommended Models for "text to image" (1 results)'));
      assert.equal('searchUsed' in recommended.structuredContent, false);
      assert.equal('ignoredWords' in recommended.structuredContent, false);

      const searched = await client.callTool({ name: 'search_models', arguments: { search: 'text to image' } });
      assert.ok(searched.content[0].text.startsWith('## Models (1 results)'));
      assert.equal('searchUsed' in searched.structuredContent, false);
      assert.equal('ignoredWords' in searched.structuredContent, false);
    });
  }
});

test('an empty result names the words no model has and points style words to the prompt', async () => {
  const none = { result: true, errors: [], total: 0, tool: [], searchused: '', searchignored: ['flat', 'illustration'] };
  await withClient({ searchModels: async () => none }, async client => {
    const searched = await client.callTool({
      name: 'search_models',
      arguments: { search: 'flat illustration', categories: ['text-to-image'] },
    });
    assert.equal(searched.content[0].text, `No models found matching your criteria. No model has "flat", "illustration". ${HINT}`);
    assert.deepEqual(searched.structuredContent.ignoredWords, ['flat', 'illustration']);
    assert.equal('searchUsed' in searched.structuredContent, false);

    const recommended = await client.callTool({ name: 'recommend_model', arguments: { task: 'flat illustration' } });
    assert.equal(
      recommended.content[0].text,
      `No models found for "flat illustration". No model has "flat", "illustration". ${HINT} For a kind of task, \`search_models\` with categories also works.`,
    );
  });

  const empty = { result: true, errors: [], total: 0, tool: [] };
  await withClient({ searchModels: async () => empty }, async client => {
    const recommended = await client.callTool({ name: 'recommend_model', arguments: { task: 'flat illustration' } });
    assert.equal(
      recommended.content[0].text,
      `No models found for "flat illustration". ${HINT} For a kind of task, \`search_models\` with categories also works.`,
    );
    const listed = await client.callTool({ name: 'search_models', arguments: { categories: ['text-to-image'] } });
    assert.equal(listed.content[0].text, 'No models found matching your criteria.');
  });
});

test('the search texts send style and subject words to the prompt', async () => {
  await withClient({}, async client => {
    const { tools } = await client.listTools();
    const recommend = tools.find(tool => tool.name === 'recommend_model');
    const search = tools.find(tool => tool.name === 'search_models');
    const texts = [
      ['recommend_model description', recommend.description],
      ['search_models search', search.inputSchema.properties.search.description],
      ['models playbook', PLAYBOOKS.models],
    ];
    for (const [label, text] of texts) {
      assert.doesNotMatch(text, /each extra word narrows/, label);
      assert.match(text, /Style and subject words, such as "flat illustration"/, label);
      assert.match(text, /A result for only part of the words names the words it left out\./, label);
    }
    assert.match(recommend.description, /A model matches when one of its fields has every word\./);
    assert.match(search.inputSchema.properties.search.description, /a model matches when one of these has every word\./);
  });
});
