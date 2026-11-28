import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../dist/server.js';

// An MCP SDK client keeps each tool's output schema from its tool listing and refuses a result whose structured
// content does not match it. mcp.wiro.ai is stateless, so a session that listed tools before a deploy calls the new
// version with the old listing. get_model_schema's objects are loose from 2.2.0: a listing of 2.2.0 or later takes a
// key a later version adds, at the top, on the model and on a parameter item. 2.1.0's strict objects refused 2.2.0's
// maxFiles until the client listed the tools again.

const model = {
  cleanslugowner: 'klingai',
  cleanslugproject: 'kling-image-v4-long',
  title: 'Kling Image v4 Long',
  categories: ['tool'],
  approximatelycost: 0,
  cps: 0,
  dynamicprice: '[{"inputs":{},"price":0.04,"priceMethod":"per-run"}]',
  parameters: [{ title: '', items: [{ id: 'productImages', type: 'combinefileinput', label: 'Product Images', maxinputlength: 3 }] }],
};

async function connected() {
  const server = createMcpServer({ getModelSchema: async () => ({ result: true, errors: [], tool: [model] }) });
  const client = new Client({ name: 'listed-before', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  return { server, client, tools };
}

// The listing as a client that listed an earlier version holds it: these keys were added later.
function earlierListing(tools, { strict = false } = {}) {
  const listing = structuredClone(tools);
  const schema = listing.find(tool => tool.name === 'get_model_schema').outputSchema;
  const modelSchema = schema.properties.model;
  const itemSchema = modelSchema.properties.parameters.items.properties.items.items;
  const drop = (object, key) => {
    delete object.properties[key];
    if (Array.isArray(object.required)) object.required = object.required.filter(name => name !== key);
  };
  drop(schema, 'nextAction');
  drop(modelSchema, 'estimatedCostUsd');
  drop(itemSchema, 'maxFiles');
  if (strict) for (const object of [schema, modelSchema, itemSchema]) object.additionalProperties = false;
  return listing;
}

test('a client that listed this version takes a result with keys its listing lacks', async () => {
  const { server, client, tools } = await connected();
  try {
    // cacheToolMetadata is what listTools stores; it is how the probe in the review gave the client an older listing.
    client.cacheToolMetadata(earlierListing(tools));
    const result = await client.callTool({ name: 'get_model_schema', arguments: { model: 'klingai/kling-image-v4-long' } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.model.parameters[0].items[0].maxFiles, 3);
    assert.ok('nextAction' in result.structuredContent);
  } finally {
    await client.close();
    await server.close();
  }
});

test('the same keys against strict objects, as 2.1.0 listed them, make the client refuse the result', async () => {
  const { server, client, tools } = await connected();
  try {
    client.cacheToolMetadata(earlierListing(tools, { strict: true }));
    await assert.rejects(
      client.callTool({ name: 'get_model_schema', arguments: { model: 'klingai/kling-image-v4-long' } }),
      /Structured content does not match the tool's output schema/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('get_model_schema lists loose objects: the top, the model, a parameter group and item, an option', async () => {
  const { server, client, tools } = await connected();
  try {
    const schema = tools.find(tool => tool.name === 'get_model_schema').outputSchema;
    const modelSchema = schema.properties.model;
    const group = modelSchema.properties.parameters.items;
    const item = group.properties.items.items;
    for (const [name, object] of Object.entries({ top: schema, model: modelSchema, group, item, option: item.properties.options.items, raise: item.properties.maxFilesByOption.items })) {
      assert.notEqual(object.additionalProperties, false, `${name} takes added keys`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
