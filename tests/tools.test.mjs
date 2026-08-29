import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TaskWaitTimeoutError } from '../dist/client.js';
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

async function withClient(fakeWiroClient, callback) {
  const server = createMcpServer(fakeWiroClient);
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

test('all 13 tools advertise output schemas and annotations', async () => {
  await withClient({}, async client => {
    const result = await client.listTools();
    const jsonSchema202012 = 'https://json-schema.org/draft/2020-12/schema';

    assert.equal(result.tools.length, 13);
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
