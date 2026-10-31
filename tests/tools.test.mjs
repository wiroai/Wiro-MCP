import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TaskWaitTimeoutError, WiroClient } from '../dist/client.js';
import { createMcpServer } from '../dist/server.js';

function runningDetail() {
  return {
    result: true,
    errors: [],
    total: '1',
    tasklist: [{
      id: '123',
      socketaccesstoken: 'task-token',
      parameters: {},
      status: 'task_start',
      pexit: '',
      debugoutput: '',
      starttime: '',
      endtime: '',
      elapsedseconds: '3',
      totalcost: '0',
      outputs: [],
    }],
  };
}

function completedDetail() {
  const result = runningDetail();
  result.tasklist[0] = {
    ...result.tasklist[0],
    status: 'task_postprocess_end',
    pexit: '0',
    elapsedseconds: '8',
    totalcost: '0.02',
    modelslugowner: 'owner',
    modelslugproject: 'model',
    outputs: [{
      name: 'result.png',
      contenttype: 'image/png',
      size: '2048',
      url: 'https://cdn.example/result.png',
    }],
  };
  return result;
}

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

test('run_model returns a recoverable token when its wait budget expires', async () => {
  const fakeWiroClient = {
    runModel: async () => ({
      result: true,
      errors: [],
      taskid: '123',
      socketaccesstoken: 'task-token',
    }),
    waitForTask: async () => {
      throw new TaskWaitTimeoutError(45000, runningDetail());
    },
  };

  await withClient(fakeWiroClient, async client => {
    const result = await client.callTool({
      name: 'run_model',
      arguments: {
        model: 'owner/model',
        params: { prompt: 'test' },
      },
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /task-token/);
    assert.match(result.content[0].text, /wait_for_task/);
    assert.match(result.content[0].text, /Do not call `run_model` again/);
    assert.equal(result.structuredContent.state, 'running');
    assert.equal(result.structuredContent.task.token, 'task-token');
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'wait_for_task',
      arguments: { tasktoken: 'task-token' },
      reason: 'Continue this exact task. Do not call run_model again.',
    });
  });
});

test('wait_for_task is registered and returns a resumable pending result', async () => {
  const fakeWiroClient = {
    waitForTask: async () => {
      throw new TaskWaitTimeoutError(45000, runningDetail());
    },
  };

  await withClient(fakeWiroClient, async client => {
    const tools = await client.listTools();
    assert.equal(tools.tools.some(tool => tool.name === 'wait_for_task'), true);

    const result = await client.callTool({
      name: 'wait_for_task',
      arguments: { tasktoken: 'task-token' },
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /Task Still Running/);
    assert.match(result.content[0].text, /task-token/);
    assert.equal(result.structuredContent.state, 'running');
    assert.equal(result.structuredContent.nextAction.tool, 'wait_for_task');
  });
});

test('get_task supports a short bounded wait without losing the identifier', async () => {
  const fakeWiroClient = {
    waitForTask: async () => {
      throw new TaskWaitTimeoutError(10000, runningDetail());
    },
  };

  await withClient(fakeWiroClient, async client => {
    const result = await client.callTool({
      name: 'get_task',
      arguments: {
        tasktoken: 'task-token',
        wait_seconds: 10,
      },
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /Task Still Running/);
    assert.match(result.content[0].text, /task-token/);
    assert.equal(result.structuredContent.state, 'running');
  });
});

test('get_task returns a function-call continuation in run_model params', async () => {
  const detail = completedDetail();
  detail.tasklist[0].parameters = { session_id: 'weather-session' };
  detail.tasklist[0].outputs = [{
    contenttype: 'raw',
    content: {
      segments: [{
        type: 'function_call',
        id: 'fc_01',
        call_id: 'call_01',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
        status: 'completed',
      }],
      finishreason: 'tool_calls',
    },
  }];
  detail.tasklist[0].debugoutput = 'raw debug transport';

  await withClient({ getTask: async () => detail }, async client => {
    const result = await client.callTool({
      name: 'get_task',
      arguments: { taskid: '123' },
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.response, undefined);
    assert.equal(
      result.structuredContent.outputs[0].segments[0].call_id,
      'call_01',
    );
    assert.deepEqual(result.structuredContent.nextAction.arguments, {
      model: 'owner/model',
      params: {
        previousTaskToken: 'task-token',
        toolOutputs: [{
          call_id: 'call_01',
          output: '<tool result>',
        }],
        session_id: 'weather-session',
      },
    });
  });
});

test('get_task_price reports the charged amount and a cancelled task as free', async () => {
  const charged = completedDetail();
  charged.tasklist[0].totalcost = '0.1';
  charged.tasklist[0].chargedcost = '0.08';
  await withClient({ getTask: async () => charged }, async client => {
    const result = await client.callTool({ name: 'get_task_price', arguments: { taskid: '123' } });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /\*\*Cost:\*\* \$0\.08 charged \(list price \$0\.1\)/);
    assert.equal(result.structuredContent.costUsd, 0.08);
    assert.equal(result.structuredContent.task.chargedUsd, 0.08);
  });

  const cancelled = completedDetail();
  cancelled.tasklist[0].status = 'task_cancel';
  cancelled.tasklist[0].pexit = '';
  cancelled.tasklist[0].totalcost = '0.1';
  await withClient({ getTask: async () => cancelled }, async client => {
    const result = await client.callTool({ name: 'get_task_price', arguments: { taskid: '123' } });
    assert.match(result.content[0].text, /\*\*Result:\*\* Cancelled/);
    assert.match(result.content[0].text, /\$0 \(cancelled tasks are not charged\)/);
    assert.equal(result.structuredContent.state, 'cancelled');
    assert.equal(result.structuredContent.costUsd, 0);
  });
});

test('get_task omits invalid typed transport without public parser state', async () => {
  const detail = completedDetail();
  detail.tasklist[0].outputs = [{
    contenttype: 'raw',
    content: {
      raw: 'signed raw transport must stay private',
      segments: { type: 'answer', text: 'not an array' },
      finishreason: 'stop',
    },
  }];
  detail.tasklist[0].debugoutput = 'debug transport must stay private';

  await withClient({ getTask: async () => detail }, async client => {
    const result = await client.callTool({
      name: 'get_task',
      arguments: { taskid: '123' },
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.response, undefined);
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.equal(
      Object.hasOwn(result.structuredContent.outputs[0], 'malformed'),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(result.structuredContent),
      /signed raw transport|debug transport/,
    );
    assert.doesNotMatch(
      result.content.map(block => block.text ?? '').join('\n'),
      /signed raw transport|debug transport/,
    );
  });
});

test('run_model returns custom tool calls without exposing debug transport', async () => {
  const detail = completedDetail();
  detail.tasklist[0].outputs = [{
    contenttype: 'raw',
    content: {
      segments: [{
        type: 'custom_tool_call',
        id: 'ct_01',
        call_id: 'call_custom_01',
        name: 'shell_grammar',
        input: 'status --short',
        status: 'completed',
      }],
      finishreason: 'tool_calls',
    },
  }];
  detail.tasklist[0].debugoutput = 'raw debug transport';
  const fakeWiroClient = {
    runModel: async () => ({
      result: true,
      errors: [],
      taskid: '123',
      socketaccesstoken: 'task-token',
    }),
    waitForTask: async () => detail,
  };

  await withClient(fakeWiroClient, async client => {
    const result = await client.callTool({
      name: 'run_model',
      arguments: {
        model: 'owner/model',
        params: { prompt: 'test' },
      },
    });

    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.response, undefined);
    assert.equal(
      result.structuredContent.outputs[0].segments[0].input,
      'status --short',
    );
    assert.deepEqual(
      result.structuredContent.nextAction.arguments.params.toolOutputs,
      [{ call_id: 'call_custom_01', output: '<tool result>' }],
    );
  });
});

// Every description in a JSON schema, with the path that leads to it.
function schemaDescriptions(schema, path = 'schema') {
  if (!schema || typeof schema !== 'object') return [];
  const found = typeof schema.description === 'string' ? [[path, schema.description]] : [];
  for (const [key, value] of Object.entries(schema)) {
    if (value && typeof value === 'object') found.push(...schemaDescriptions(value, `${path}.${key}`));
  }
  return found;
}

const EXPECTED_TOOLS = [
  // Always available
  'get_account', 'get_playbook', 'search_docs',
  // Models
  'search_models', 'get_model_schema', 'recommend_model', 'explore', 'run_model',
  'wait_for_task', 'get_task', 'list_tasks', 'get_task_price', 'cancel_task',
  'kill_task', 'upload_file',
  // Workflows
  'list_workflows', 'get_workflow', 'create_workflow', 'update_workflow',
  'clone_workflow', 'delete_workflow', 'run_workflow', 'wait_for_workflow_run',
  'resume_workflow_run', 'list_workflow_runs', 'save_workflow_from_agent',
  // Agents
  'send_agent_message', 'get_agent_message', 'get_agent_conversation',
  'cancel_agent_message', 'delete_agent_session', 'list_studio_results',
  'list_agent_templates', 'get_agent_template', 'list_agent_skills', 'deploy_agent',
  'list_my_agents', 'get_my_agent', 'control_agent', 'update_agent',
  'manage_agent_billing', 'get_agent_activity', 'delete_agent',
  'apply_agent_skills', 'set_agent_credentials', 'connect_agent_oauth',
  'disconnect_agent_oauth', 'manage_agent_custom_skill',
];

test('wrapTool sees every tool with its annotations and can answer in its place', async () => {
  const seen = new Map();
  const wrapTool = (tool, handler) => {
    seen.set(tool.name, tool.annotations);
    if (tool.annotations?.readOnlyHint === true) return handler;
    return async () => ({ content: [{ type: 'text', text: `${tool.name} is turned off here.` }], isError: true });
  };
  await withClient({}, async client => {
    const { tools } = await client.listTools();
    assert.deepEqual([...seen.keys()].sort(), tools.map(tool => tool.name).sort());
    assert.equal(seen.get('delete_workflow').destructiveHint, true);

    const blocked = await client.callTool({ name: 'delete_workflow', arguments: { slug: 'fox-maker-Ab3xZ' } });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.content[0].text, 'delete_workflow is turned off here.');

    const open = await client.callTool({ name: 'get_playbook', arguments: { topics: ['workflows'] } });
    assert.notEqual(open.isError, true);
  }, { wrapTool });
});

test('every tool advertises output schemas and annotations', async () => {
  await withClient({}, async client => {
    const result = await client.listTools();
    const jsonSchema202012 = 'https://json-schema.org/draft/2020-12/schema';

    assert.deepEqual(result.tools.map(tool => tool.name).sort(), [...EXPECTED_TOOLS].sort());
    for (const tool of result.tools) {
      const texts = [
        ['title', tool.title ?? ''],
        ['description', tool.description ?? ''],
        ...schemaDescriptions(tool.inputSchema, 'inputSchema'),
        ...schemaDescriptions(tool.outputSchema, 'outputSchema'),
      ];
      for (const [where, text] of texts) {
        assert.equal(text.includes('\u2014'), false, `${tool.name} ${where} has an em dash`);
        assert.equal(text.includes('\u2013'), false, `${tool.name} ${where} has an en dash`);
      }
    }
    for (const tool of result.tools) {
      assert.ok(tool.inputSchema, `${tool.name} is missing inputSchema`);
      assert.ok(tool.outputSchema, `${tool.name} is missing outputSchema`);
      assert.equal(tool.inputSchema.$schema, jsonSchema202012, `${tool.name} inputSchema dialect`);
      assert.equal(tool.outputSchema.$schema, jsonSchema202012, `${tool.name} outputSchema dialect`);
      assert.equal(JSON.stringify(tool).includes('draft-07'), false, `${tool.name} still mentions draft-07`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
      assert.equal(typeof tool.annotations?.idempotentHint, 'boolean');
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean');
    }

    for (const name of ['run_model', 'get_task', 'wait_for_task']) {
      const tool = result.tools.find(candidate => candidate.name === name);
      assert.match(tool?.description ?? '', /present every returned media resource/i);
    }

    const taskTool = result.tools.find(tool => tool.name === 'get_task');
    const outputProperties = taskTool?.outputSchema?.properties?.outputs?.items
      ?.properties;
    assert.ok(outputProperties?.segments);
    assert.ok(outputProperties?.finishreason);
    assert.ok(outputProperties?.usage);
    assert.equal(outputProperties?.malformed, undefined);

    const listTool = result.tools.find(tool => tool.name === 'list_tasks');
    const listOutputProperties = listTool?.outputSchema?.properties?.tasks?.items
      ?.properties?.outputs?.items?.properties;
    assert.ok(listOutputProperties?.usage);
    for (const omitted of ['text', 'segments', 'finishreason']) {
      assert.equal(listOutputProperties?.[omitted], undefined);
    }
  });
});

test('list_tasks returns structured history and chains into get_task', async () => {
  const historyDetail = completedDetail();
  historyDetail.tasklist[0].outputs.push({
    contenttype: 'raw',
    content: {
      segments: [{ type: 'answer', text: 'Detailed text is omitted here.' }],
      finishreason: 'stop',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        total_tokens: 7,
      },
    },
  });
  const fakeWiroClient = {
    listTasks: async params => {
      assert.deepEqual(params, {
        start: 0,
        limit: 20,
        model: undefined,
      });
      return historyDetail;
    },
    getTask: async ({ taskid }) => {
      assert.equal(taskid, '123');
      return completedDetail();
    },
  };

  await withClient(fakeWiroClient, async client => {
    const history = await client.callTool({
      name: 'list_tasks',
      arguments: {},
    });

    assert.notEqual(history.isError, true);
    assert.equal(history.structuredContent.tasks.length, 1);
    assert.equal(history.structuredContent.tasks[0].state, 'completed');
    assert.equal(history.structuredContent.tasks[0].task.model, 'owner/model');
    const historyRawOutput = history.structuredContent.tasks[0].outputs[1];
    assert.deepEqual(historyRawOutput.usage, {
      input_tokens: 3,
      output_tokens: 4,
      total_tokens: 7,
    });
    for (const omitted of ['text', 'segments', 'finishreason']) {
      assert.equal(Object.hasOwn(historyRawOutput, omitted), false);
    }
    assert.deepEqual(history.structuredContent.nextAction.arguments, {
      taskid: '123',
    });

    const detail = await client.callTool({
      name: history.structuredContent.nextAction.tool,
      arguments: history.structuredContent.nextAction.arguments,
    });

    assert.equal(detail.structuredContent.state, 'completed');
    assert.equal(detail.structuredContent.outputs[0].url, 'https://cdn.example/result.png');
    assert.equal(detail.content.some(block => block.type === 'resource_link'), true);
    assert.equal(detail.content.some(block => block.type === 'text'
      && block.annotations?.audience?.includes('assistant')
      && /Present every generated media output/.test(block.text)), true);
  });
});

test('tools tell a key-only caller of a signature-auth project what to enter', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: false,
    errors: [{
      code: 0,
      message: 'Project requires signature authentication. '
        + 'x-signature and x-nonce headers are required.',
    }],
  }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const wiroClient = new WiroClient('api-key', undefined, 'https://api.example/v1', {
    missingSecretHint: 'This project uses signature-based auth. '
      + 'Enter API_KEY:API_SECRET as the API key.',
  });
  const calls = [
    ['run_model', { model: 'owner/model', params: { prompt: 'test' } }],
    ['wait_for_task', { tasktoken: 'task-token' }],
    ['get_task', { tasktoken: 'task-token' }],
    ['get_task', { tasktoken: 'task-token', wait_seconds: 5 }],
    ['list_tasks', {}],
    ['get_task_price', { tasktoken: 'task-token' }],
    ['cancel_task', { taskid: '123' }],
    ['kill_task', { taskid: '123' }],
  ];

  try {
    await withClient(wiroClient, async client => {
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        const text = result.content[0].text;
        assert.equal(result.isError, true, name);
        assert.match(text, /Enter API_KEY:API_SECRET as the API key\./, name);
        assert.doesNotMatch(text, /x-nonce/, name);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The tool names in `tool: '<name>'` literals under src, which is how a
// nextAction names the tool to call next.
function nextActionToolsInSource(dir = new URL('../src/', import.meta.url)) {
  const names = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const name of nextActionToolsInSource(new URL(`${entry.name}/`, dir))) names.add(name);
    } else if (entry.name.endsWith('.ts')) {
      const source = readFileSync(new URL(entry.name, dir), 'utf8');
      for (const match of source.matchAll(/\btool: ['"`]([a-z][a-z0-9_]*)['"`]/g)) names.add(match[1]);
    }
  }
  return names;
}

test('every nextAction in the source names a tool the default server registers', async () => {
  const named = nextActionToolsInSource();
  for (const name of ['wait_for_task', 'get_playbook', 'save_workflow_from_agent']) {
    assert.ok(named.has(name), `the source scan missed ${name}`);
  }
  await withClient({}, async client => {
    const registered = new Set((await client.listTools()).tools.map(tool => tool.name));
    assert.deepEqual([...named].filter(name => !registered.has(name)).sort(), []);
  });
});

function imageModelSchema() {
  return {
    result: true,
    errors: [],
    tool: [{
      cleanslugowner: 'owner',
      cleanslugproject: 'image-model',
      title: 'Image model',
      categories: ['text-to-image'],
      parameters: [{ title: 'Inputs', items: [{ id: 'prompt', type: 'text', label: 'Prompt', required: true }] }],
    }],
  };
}

test('get_model_schema points at workflow steps when run_model is not loaded', async () => {
  const fakeWiroClient = { getModelSchema: async () => imageModelSchema() };
  const callSchema = client => client.callTool({ name: 'get_model_schema', arguments: { model: 'owner/image-model' } });

  await withClient(fakeWiroClient, async client => {
    const result = await callSchema(client);
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'run_model',
      arguments: { model: 'owner/image-model', params: {} },
      reason: 'When the user asked for a run, fill the required model parameters, then submit one generation. A price question needs no run.',
    });
    assert.match(result.content[0].text, /Use `run_model` with this model/);
  });

  await withClient(fakeWiroClient, async client => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(names.has('run_model'), false);
    assert.doesNotMatch(tools.find(tool => tool.name === 'get_model_schema').description, /run_model/);

    const result = await callSchema(client);
    assert.notEqual(result.isError, true);
    const { nextAction, model } = result.structuredContent;
    assert.equal(nextAction.tool, 'get_playbook');
    assert.ok(names.has(nextAction.tool));
    assert.deepEqual(nextAction.arguments, { topics: ['workflow-graph'] });
    assert.equal(model.slug, 'owner/image-model');
    assert.equal(model.parameters[0].items[0].id, 'prompt');

    const text = result.content[0].text;
    assert.doesNotMatch(text, /run_model/);
    assert.match(text, /`prompt`/);
    assert.match(text, /### Usage\n\nUse this model as a workflow step: `"type": "run"`, `"tool": "owner\/image-model"`/);
  }, { toolsets: ['workflows'] });
});

test('a Workflow Agent proposal read with the agents toolset alone points at a loaded tool', async () => {
  const contents = {
    version: '1',
    nodes: {
      'node-a1': { type: 'run', id: 'node-a1', tool: 'owner/image-model', depends: ['input'], input: { prompt: '$input.prompt' }, metadata: { position: { x: 400, y: 0 } } },
      output: { type: 'display', id: 'output', depends: ['node-a1'], input: {}, fields: { image: '$node-a1.outputs' }, metadata: { position: { x: 800, y: 0 } } },
    },
    output: { image: '$node-a1.outputs' },
    schema: {
      input: {
        prompt: { name: 'prompt', label: 'Prompt', type: 'string', description: 'A text field', required: false, defaultValue: 'a fox', examples: [], ui: { field: 'textarea' } },
      },
      output: {},
    },
    metadata: { input: { position: { x: 0, y: 0 } } },
  };
  const artifact = { artifactVersion: 1, title: 'Fox maker', description: 'Makes foxes', contents };
  const reply = `Here it is.\n\n\`\`\`wiro-workflow\n${JSON.stringify(artifact)}\n\`\`\`\n`;
  const fakeWiroClient = {
    post: async path => {
      assert.equal(path, '/StudioWorkflow/Message/Detail');
      return {
        result: true,
        errors: [],
        data: { guid: 'wf-1', sessionkey: 'mcp-flow', status: 'agent_end', response: reply, timeline: [], createdat: '1761700000', endedat: '1761700010', tokencost: '10' },
      };
    },
  };

  await withClient(fakeWiroClient, async client => {
    const names = new Set((await client.listTools()).tools.map(tool => tool.name));
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'workflow-agent', message_id: 'wf-1', session: 'mcp-flow', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.nextAction.tool, 'save_workflow_from_agent');
    assert.ok(names.has('save_workflow_from_agent'), 'save_workflow_from_agent is not loaded with the agents toolset');
  }, { toolsets: ['agents'] });
});

test('the workflow tools alone still bring the catalog and Studio tools their guidance names', async () => {
  await withClient({}, async client => {
    const names = new Set((await client.listTools()).tools.map(tool => tool.name));
    for (const name of ['search_models', 'recommend_model', 'get_model_schema', 'upload_file', 'send_agent_message', 'list_studio_results']) {
      assert.ok(names.has(name), `${name} is missing with the workflows toolset`);
    }
    for (const name of ['run_model', 'deploy_agent', 'list_my_agents']) {
      assert.equal(names.has(name), false, `${name} should need its own toolset`);
    }
  }, { toolsets: ['workflows'] });
});
