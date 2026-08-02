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

test('all 13 tools advertise output schemas and annotations', async () => {
  await withClient({}, async client => {
    const result = await client.listTools();

    assert.equal(result.tools.length, 13);
    for (const tool of result.tools) {
      assert.ok(tool.inputSchema, `${tool.name} is missing inputSchema`);
      assert.ok(tool.outputSchema, `${tool.name} is missing outputSchema`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean');
      assert.equal(typeof tool.annotations?.idempotentHint, 'boolean');
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean');
    }
  });
});

test('list_tasks returns structured history and chains into get_task', async () => {
  const fakeWiroClient = {
    listTasks: async params => {
      assert.deepEqual(params, {
        start: 0,
        limit: 20,
        model: undefined,
      });
      return completedDetail();
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
  });
});
