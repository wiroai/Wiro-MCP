import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * MCP SDK 1.32 still advertises Zod tool schemas as JSON Schema draft-07.
 * Claude and other 2020-12-only clients reject those tools before dispatch.
 * Rewrite the tools/list payload at the transport boundary instead of
 * depending on an SDK target option that is not currently passed through.
 */
export const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const DEFINITIONS_REF_PREFIX = '#/definitions/';

const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'dependentSchemas',
]);

const DATA_KEYWORDS = new Set([
  'enum',
  'const',
  'default',
  'examples',
  'required',
  'dependentRequired',
]);

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertSchemaMap(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const out: JsonObject = {};
  for (const [name, subschema] of Object.entries(node)) {
    out[name] = convertNode(subschema);
  }
  return out;
}

function convertNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertNode);
  if (!isPlainObject(node)) return node;

  const hasTupleItems = Array.isArray(node.items);
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case '$schema':
        break;

      case 'definitions':
        out.$defs = convertSchemaMap(value);
        break;

      case '$ref':
        out.$ref = typeof value === 'string' && value.startsWith(DEFINITIONS_REF_PREFIX)
          ? `#/$defs/${value.slice(DEFINITIONS_REF_PREFIX.length)}`
          : value;
        break;

      case 'items':
        if (hasTupleItems) out.prefixItems = (value as unknown[]).map(convertNode);
        else out.items = convertNode(value);
        break;

      case 'additionalItems':
        if (hasTupleItems) out.items = convertNode(value);
        break;

      case 'dependencies': {
        const dependentRequired: JsonObject = {};
        const dependentSchemas: JsonObject = {};
        if (isPlainObject(value)) {
          for (const [property, dependency] of Object.entries(value)) {
            if (Array.isArray(dependency)) dependentRequired[property] = dependency;
            else dependentSchemas[property] = convertNode(dependency);
          }
        }
        if (Object.keys(dependentRequired).length > 0) {
          out.dependentRequired = dependentRequired;
        }
        if (Object.keys(dependentSchemas).length > 0) {
          out.dependentSchemas = dependentSchemas;
        }
        break;
      }

      case 'exclusiveMinimum':
      case 'exclusiveMaximum': {
        const bound = key === 'exclusiveMinimum' ? node.minimum : node.maximum;
        if (value === true && typeof bound === 'number') out[key] = bound;
        else if (value !== false) out[key] = convertNode(value);
        break;
      }

      case 'minimum':
        if (node.exclusiveMinimum === true) break;
        out.minimum = convertNode(value);
        break;

      case 'maximum':
        if (node.exclusiveMaximum === true) break;
        out.maximum = convertNode(value);
        break;

      default:
        if (DATA_KEYWORDS.has(key)) out[key] = value;
        else if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = convertSchemaMap(value);
        else out[key] = convertNode(value);
    }
  }

  return out;
}

export function toJsonSchema2020_12<T>(schema: T): T {
  if (!isPlainObject(schema)) return schema;
  return {
    $schema: JSON_SCHEMA_2020_12,
    ...(convertNode(schema) as JsonObject),
  } as T;
}

export function normalizeOutgoingMessage(message: unknown): unknown {
  if (!isPlainObject(message)) return message;

  const result = message.result;
  if (!isPlainObject(result) || !Array.isArray(result.tools)) return message;

  const tools = result.tools.map(tool => {
    if (!isPlainObject(tool)) return tool;
    const next: JsonObject = { ...tool };
    if (isPlainObject(tool.inputSchema)) {
      next.inputSchema = toJsonSchema2020_12(tool.inputSchema);
    }
    if (isPlainObject(tool.outputSchema)) {
      next.outputSchema = toJsonSchema2020_12(tool.outputSchema);
    }
    return next;
  });

  return { ...message, result: { ...result, tools } };
}

const LISTS_2020_12 = Symbol.for('@wiro-ai/wiro-mcp/json-schema-2020-12');

type Marked<T> = T & { [LISTS_2020_12]?: true };

/** Wraps a transport so the tools/list it sends uses JSON Schema 2020-12. Calling it again does nothing. */
export function withJsonSchema2020_12<T extends Transport>(transport: T): T {
  const marked = transport as Marked<T>;
  if (marked[LISTS_2020_12]) return transport;
  marked[LISTS_2020_12] = true;
  const originalSend = transport.send.bind(transport);
  transport.send = (message, options) =>
    originalSend(normalizeOutgoingMessage(message) as Parameters<Transport['send']>[0], options);
  return transport;
}

/**
 * Makes an McpServer list its tools with JSON Schema 2020-12, whether it is
 * connected already or connects later. Calling it again does nothing.
 */
export function advertiseJsonSchema2020_12(server: McpServer): McpServer {
  const marked = server as Marked<McpServer>;
  if (marked[LISTS_2020_12]) return server;
  marked[LISTS_2020_12] = true;
  const connected = server.server.transport;
  if (connected) withJsonSchema2020_12(connected);
  const originalConnect = server.connect.bind(server);
  server.connect = (transport: Transport) => originalConnect(withJsonSchema2020_12(transport));
  return server;
}
