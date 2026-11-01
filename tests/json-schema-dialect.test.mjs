import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../dist/server.js';
import {
  advertiseJsonSchema2020_12,
  JSON_SCHEMA_2020_12,
  normalizeOutgoingMessage,
  toJsonSchema2020_12,
} from '../dist/utils/json-schema-dialect.js';

test('stamps 2020-12 at the document root and strips nested $schema', () => {
  const converted = toJsonSchema2020_12({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      nested: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'string',
      },
    },
  });

  assert.equal(converted.$schema, JSON_SCHEMA_2020_12);
  assert.equal(converted.properties.nested.$schema, undefined);
  assert.equal(converted.properties.nested.type, 'string');
});

test('rewrites draft-07 keywords into 2020-12 equivalents', () => {
  const converted = toJsonSchema2020_12({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    definitions: {
      point: { type: 'number' },
    },
    properties: {
      pair: {
        type: 'array',
        items: [{ $ref: '#/definitions/point' }, { $ref: '#/definitions/point' }],
        additionalItems: false,
      },
      name: {
        type: 'string',
        minLength: 1,
      },
    },
    dependencies: {
      name: ['pair'],
      pair: { type: 'object', properties: { extra: { type: 'boolean' } } },
    },
    exclusiveMinimum: true,
    minimum: 0,
  });

  assert.equal(converted.$schema, JSON_SCHEMA_2020_12);
  assert.equal(converted.definitions, undefined);
  assert.deepEqual(converted.$defs, { point: { type: 'number' } });
  assert.deepEqual(converted.properties.pair.prefixItems, [
    { $ref: '#/$defs/point' },
    { $ref: '#/$defs/point' },
  ]);
  assert.equal(converted.properties.pair.items, false);
  assert.equal(converted.properties.pair.additionalItems, undefined);
  assert.deepEqual(converted.dependentRequired, { name: ['pair'] });
  assert.equal(converted.dependentSchemas.pair.properties.extra.type, 'boolean');
  assert.equal(converted.exclusiveMinimum, 0);
  assert.equal(converted.minimum, undefined);
});

test('does not rewrite caller-chosen property names or instance data', () => {
  const converted = toJsonSchema2020_12({
    type: 'object',
    properties: {
      definitions: { type: 'string' },
      $schema: { type: 'string' },
    },
    required: ['definitions', '$schema'],
    default: {
      definitions: 1,
      $schema: 'x',
    },
  });

  assert.equal(converted.properties.definitions.type, 'string');
  assert.equal(converted.properties.$schema.type, 'string');
  assert.deepEqual(converted.required, ['definitions', '$schema']);
  assert.deepEqual(converted.default, { definitions: 1, $schema: 'x' });
});

test('rewrites tools/list schemas and leaves other messages untouched', () => {
  const listed = normalizeOutgoingMessage({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        {
          name: 'search_models',
          inputSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
          },
          outputSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
          },
        },
      ],
    },
  });

  assert.equal(listed.result.tools[0].inputSchema.$schema, JSON_SCHEMA_2020_12);
  assert.equal(listed.result.tools[0].outputSchema.$schema, JSON_SCHEMA_2020_12);

  const ping = { jsonrpc: '2.0', id: 2, result: { ok: true } };
  assert.equal(normalizeOutgoingMessage(ping), ping);
});

const noClient = { post: async () => ({ result: true }) };

function standIn(members = {}) {
  const names = [];
  return { names, registerTool: name => { names.push(name); }, ...members };
}

test('registerTools works on a stand-in server without server or connect', () => {
  for (const members of [{}, { connect: async () => {} }, { server: {} }]) {
    const server = standIn(members);
    registerTools(server, noClient);
    assert.ok(server.names.includes('get_account'));
    assert.ok(server.names.includes('deploy_agent'));
    assert.deepEqual(Object.keys(server).sort(), ['names', 'registerTool', ...Object.keys(members)].sort(), 'the stand-in is left as it was');
    assert.equal(Object.getOwnPropertySymbols(server).length, 0, 'the stand-in is not marked');
  }
  const direct = standIn();
  assert.equal(advertiseJsonSchema2020_12(direct), direct);
});

test('registerTools passes a stand-in server through wrapTool and toolsets', () => {
  const server = standIn();
  const wrapped = [];
  registerTools(server, noClient, {
    toolsets: ['models'],
    wrapTool: (tool, handler) => {
      wrapped.push(tool.name);
      return handler;
    },
  });
  assert.ok(server.names.includes('run_model'));
  assert.equal(server.names.includes('deploy_agent'), false);
  assert.deepEqual(wrapped, server.names);
});

test('registerTools still makes a real server list 2020-12, connected before or after', async () => {
  const listSchemas = async server => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools.map(tool => tool.inputSchema.$schema);
  };

  const before = new McpServer({ name: 'test', version: '1.0.0' });
  const originalConnect = before.connect;
  registerTools(before, noClient, { toolsets: ['models'] });
  assert.notEqual(before.connect, originalConnect, 'connect is wrapped');
  assert.deepEqual([...new Set(await listSchemas(before))], [JSON_SCHEMA_2020_12]);

  // Calling it twice wraps once.
  const twice = new McpServer({ name: 'test', version: '1.0.0' });
  advertiseJsonSchema2020_12(twice);
  const wrappedConnect = twice.connect;
  registerTools(twice, noClient, { toolsets: ['models'] });
  assert.equal(twice.connect, wrappedConnect);

  // A server already connected gets its transport rewritten at once.
  const connected = new McpServer({ name: 'test', version: '1.0.0' });
  connected.registerTool('ping', { description: 'Ping', inputSchema: {} }, async () => ({ content: [] }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await connected.connect(serverTransport);
  await client.connect(clientTransport);
  advertiseJsonSchema2020_12(connected);
  const { tools } = await client.listTools();
  assert.equal(tools[0].inputSchema.$schema, JSON_SCHEMA_2020_12);
  await client.close();
  await connected.close();
});
