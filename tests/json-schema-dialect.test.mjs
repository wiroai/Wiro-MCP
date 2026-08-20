import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
