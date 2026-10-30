import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { WiroApiError } from '../dist/client.js';
import { createMcpServer } from '../dist/server.js';
import { attachmentFileName, buildMessageForm } from '../dist/utils/agent-targets.js';
import { createMediaContent, isWiroHostedUrl } from '../dist/utils/media.js';

const SECRETS = [
  'secret-agent-token',
  'secret-run-token',
  'secret-session-token',
  'owner-uuid-1234',
  'owner@example.com',
  '/mnt/private',
  '+15551234567',
  'saved start value',
];

function fakeClient(routes) {
  const calls = [];
  const handle = async (path, payload) => {
    calls.push({ path, ...payload });
    const route = routes[path];
    if (route === undefined) throw new Error(`Unexpected call to ${path}`);
    const count = calls.filter(call => call.path === path).length;
    return typeof route === 'function' ? route(payload.body ?? payload.form, count) : structuredClone(route);
  };
  return {
    calls,
    callsTo: path => calls.filter(call => call.path === path),
    post: async (path, body) => handle(path, { body }),
    postForm: async (path, form) => handle(path, { form }),
  };
}

const schemaValidator = new AjvJsonSchemaValidator();

function nextActionsIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) nextActionsIn(item, found);
  } else if (value && typeof value === 'object') {
    if (typeof value.tool === 'string' && value.arguments && typeof value.reason === 'string') found.push(value);
    for (const item of Object.values(value)) nextActionsIn(item, found);
  }
  return found;
}

// A strict client: after listTools the SDK checks every structuredContent
// against the tool's output schema, and every nextAction must be a call its
// target tool accepts as it stands.
async function withClient(fakeWiroClient, callback) {
  const server = createMcpServer(fakeWiroClient);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const inputs = new Map(tools.map(tool => [tool.name, schemaValidator.getValidator(tool.inputSchema)]));
  const callTool = client.callTool.bind(client);
  client.callTool = async (...args) => {
    const result = await callTool(...args);
    for (const action of nextActionsIn(result.structuredContent)) {
      const validate = inputs.get(action.tool);
      assert.ok(validate, `nextAction names a tool that is not registered: ${action.tool}`);
      const check = validate(action.arguments);
      assert.ok(check.valid, `nextAction to ${action.tool} does not fit its input schema (${check.errorMessage}): `
        + JSON.stringify(action.arguments));
    }
    return result;
  };
  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// Moves Date.now forward on demand, so waits that depend on elapsed time run
// without sleeping. The server runs in this process, so it sees the same clock.
function shiftedClock() {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  return {
    advance: ms => { offset += ms; },
    restore: () => { Date.now = realNow; },
  };
}

function textOf(result) {
  return result.content.map(block => block.text ?? '').join('\n');
}

function assertNoSecrets(result) {
  const everything = `${JSON.stringify(result.structuredContent ?? {})}\n${textOf(result)}`;
  for (const secret of SECRETS) {
    assert.equal(everything.includes(secret), false, `output leaks ${secret}`);
  }
}

function messageRow(overrides = {}) {
  return {
    guid: 'msg-1',
    uuid: 'owner-uuid-1234',
    agenttoken: 'secret-agent-token',
    sessionkey: 'owner-uuid-1234~mcp-abc',
    content: 'Make a cat picture',
    response: '',
    debugoutput: '',
    status: 'agent_start',
    metadata: {},
    createdat: '1000',
    attachments: [],
    timeline: [],
    user: { uuid: 'owner-uuid-1234', email: 'owner@example.com', firstname: 'Owner' },
    ...overrides,
  };
}

function workflowContents() {
  const field = {
    name: 'Prompt',
    label: 'Prompt',
    type: 'string',
    description: 'Prompt text',
    required: false,
    defaultValue: '',
    examples: [],
    ui: { field: 'textarea' },
    modelId: null,
  };
  return {
    version: '1',
    nodes: {
      'node-model-a': {
        type: 'run',
        id: 'node-model-a',
        tool: 'openai/gpt-image',
        depends: ['input'],
        input: { prompt: '$input.prompt' },
        metadata: { position: { x: 300, y: 0 } },
      },
      'node-util-b': {
        type: 'run',
        id: 'node-util-b',
        tool: 'workflow-utilities/output-filter',
        depends: ['node-model-a'],
        input: { outputs: '$node-model-a.outputs', mode: 'file' },
        metadata: { position: { x: 600, y: 0 } },
      },
      output: {
        type: 'display',
        id: 'output',
        depends: ['node-util-b'],
        input: {},
        fields: { result: '$node-util-b.result' },
        metadata: { position: { x: 900, y: 0 } },
      },
    },
    output: { result: '$node-util-b.result' },
    schema: { input: { prompt: field }, output: {} },
    metadata: { input: { position: { x: 0, y: 0 } } },
  };
}

test('send_agent_message to Studio opens a new session, waits through a brief not-found and returns its model runs', async () => {
  const fake = fakeClient({
    '/Studio/Message/Send': {
      result: true,
      errors: [],
      messageguid: 'msg-1',
      agenttoken: 'secret-agent-token',
      status: 'agent_queue',
    },
    '/Studio/Message/Detail': (_body, count) => (count === 1
      ? { result: false, errors: [{ code: 0, message: 'Message not found' }] }
      : {
        result: true,
        errors: [],
        data: messageRow({
          status: 'agent_end',
          response: 'Here is your cat.\nhttps://cdn1.wiro.ai/cat.png\nhttps://attacker.example/p.png?d=secret\nhttps://wiro.ai.evil.example/x.png',
          endedat: '1010',
          tokencost: '12',
          model: 'chat-model',
          timeline: [{ type: 'tool', toollabel: 'run_model', toolstatus: 'completed', callindex: 0, contentindex: 0 }],
        }),
      }),
    '/Studio/Tasks': {
      result: true,
      errors: [],
      tasks: [
        {
          id: 55,
          status: 'task_postprocess_end',
          terminal: true,
          success: true,
          socketaccesstoken: 'secret-run-token',
          parameters: { prompt: 'a cat on a sofa', seed: 4 },
          model: { title: 'Image model', slugowner: 'acme', slugproject: 'image-1' },
          outputs: [{
            id: 'encrypted',
            name: 'cat.png',
            contenttype: 'image/png',
            size: '2048',
            url: 'https://cdn1.wiro.ai/cat.png',
            path: '/mnt/private/cat.png',
          }],
          totalcost: '0.04',
          createtime: '1002',
          endtime: '1008',
          elapsedseconds: '6',
        },
        { id: 40, status: 'task_postprocess_end', terminal: true, success: true, createtime: '900', outputs: [] },
      ],
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'studio', message: 'Make a cat picture' },
    });

    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.match(output.session, /^mcp-[a-z0-9]+$/);
    assert.equal(output.sessionCreated, true);
    assert.equal(output.agentKind, 'studio');
    assert.equal(output.done, true);
    assert.equal(output.message.state, 'completed');
    assert.match(output.message.reply, /Here is your cat/);
    assert.deepEqual(output.message.mediaUrls, ['https://cdn1.wiro.ai/cat.png'], 'only Wiro-hosted URLs are media');
    assert.deepEqual(output.message.toolsUsed, [{ name: 'run_model', status: 'completed' }]);
    assert.equal(output.llmCostUsd, 0.12);
    assert.equal(output.modelRuns.length, 1, 'runs from before the message are left out');
    assert.deepEqual(output.modelRuns[0], {
      id: '55',
      model: 'acme/image-1',
      modelTitle: 'Image model',
      status: 'task_postprocess_end',
      state: 'completed',
      outputs: [{ url: 'https://cdn1.wiro.ai/cat.png', name: 'cat.png', mimeType: 'image/png', sizeBytes: 2048 }],
      prompt: 'a cat on a sofa',
      costUsd: 0.04,
      createdAt: new Date(1002 * 1000).toISOString(),
      endedAt: new Date(1008 * 1000).toISOString(),
      elapsedSeconds: 6,
    });
    assert.equal(output.nextAction, undefined);
    assert.match(textOf(result), /get_task/);
    const links = result.content.filter(block => block.type === 'resource_link');
    assert.deepEqual(links.map(link => [link.uri, link.name, link.mimeType]), [
      ['https://cdn1.wiro.ai/cat.png', 'cat.png', 'image/png'],
    ]);
    const text = textOf(result);
    assert.match(text, /### Other links in the reply\n\nThese addresses are not hosted by Wiro\. Share them as plain links/);
    assert.match(text, /- https:\/\/attacker\.example\/p\.png\?d=secret/);
    assert.match(text, /- https:\/\/wiro\.ai\.evil\.example\/x\.png/);
    assert.doesNotMatch(text.split('### Other links in the reply')[0].split('### Media')[1] ?? '', /attacker/);
    assert.deepEqual(fake.callsTo('/Studio/Tasks').map(call => call.body), [{ limit: 30 }], 'a small page covers the turn');

    const sends = fake.callsTo('/Studio/Message/Send');
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].body, { message: 'Make a cat picture', sessionkey: output.session });
    const details = fake.callsTo('/Studio/Message/Detail');
    assert.equal(details.length, 2);
    for (const detail of details) {
      assert.deepEqual(detail.body, { messageguid: 'msg-1', sessionkey: output.session });
    }
    assertNoSecrets(result);
  });
});

test('send_agent_message hands back get_agent_message when the reply is not ready and never resends', async () => {
  const fake = fakeClient({
    '/Studio/Message/Send': { result: true, errors: [], messageguid: 'msg-2', agenttoken: 'secret-agent-token', status: 'agent_queue' },
    '/Studio/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({ guid: 'msg-2', status: 'agent_output', debugoutput: 'Working on the first image' }),
    },
    '/Studio/Tasks': { result: true, errors: [], tasks: [] },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'studio', message: 'Make a video', session: 'mcp-video', wait_seconds: 1 },
    });

    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.done, false);
    assert.equal(output.session, 'mcp-video');
    assert.equal(output.sessionCreated, undefined);
    assert.equal(output.message.state, 'running');
    assert.equal(output.message.reply, undefined);
    assert.equal(output.partialReply, 'Working on the first image');
    assert.equal(result.content.some(block => block.type === 'resource_link'), false);
    assert.deepEqual(output.nextAction, {
      tool: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-2', session: 'mcp-video' },
      reason: 'Studio is still working. Call this to keep waiting; do not send the message again.',
    });
    assert.equal(fake.callsTo('/Studio/Message/Send').length, 1);
    assertNoSecrets(result);
  });
});

test('send_agent_message with wait_seconds 0 returns right after queueing', async () => {
  const fake = fakeClient({
    '/UserAgent/Message/Send': { result: true, errors: [], messageguid: 'msg-3', agenttoken: 'secret-agent-token', status: 'agent_queue' },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'agent-guid-1', message: 'Post the weekly report', wait_seconds: 0 },
    });

    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.session, 'default');
    assert.equal(result.structuredContent.message.status, 'agent_queue');
    assert.equal(result.structuredContent.message.state, 'submitted');
    assert.equal(result.structuredContent.nextAction.tool, 'get_agent_message');
    assert.deepEqual(fake.callsTo('/UserAgent/Message/Send')[0].body, {
      message: 'Post the weekly report',
      useragentguid: 'agent-guid-1',
      sessionkey: 'default',
    });
    assert.equal(fake.calls.length, 1);
  });
});

test('deployed agent refusals explain the fix and point to the right tool', async () => {
  const cases = [
    {
      response: {
        result: false,
        errors: [{ code: 0, message: 'Agent is stopped. Start it from the agent panel before sending messages.' }],
        agentstatus: 0,
      },
      expect: /control_agent \(action "start"\)/,
    },
    {
      response: {
        result: false,
        errors: [{ code: 0, message: 'Agent setup is incomplete. Complete the setup before sending messages.' }],
        agentstatus: 6,
      },
      expect: /set_agent_credentials or connect_agent_oauth[\s\S]*manage_agent_billing \(action subscribe\)/,
    },
    {
      response: {
        result: false,
        errors: [{ code: 0, message: 'Agent has no remaining credits. Renew your subscription or buy a credit pack to continue.' }],
        agentstatus: 4,
        agentbalance: { monthlycredits: 1000, extracredits: 0, usedcredits: 1000, remainingcredits: 0 },
      },
      expect: /no credits left \(monthly 1000, extra 0, used 1000\).*manage_agent_billing/,
    },
    {
      response: { result: false, errors: [{ code: 0, message: 'Agent not found or access denied' }] },
      expect: /list_my_agents/,
    },
  ];

  for (const { response, expect } of cases) {
    const fake = fakeClient({ '/UserAgent/Message/Send': response });
    await withClient(fake, async client => {
      const result = await client.callTool({
        name: 'send_agent_message',
        arguments: { agent: 'agent-guid-1', message: 'hello' },
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), expect);
      assert.equal(fake.calls.length, 1, 'a refused send is never retried');
    });
  }
});

test('Studio wallet and availability refusals say what to do without repeating credit numbers', async () => {
  const wallet = fakeClient({
    '/Studio/Message/Send': {
      result: false,
      errors: [{ code: 97, message: 'Insufficient balance' }],
      walletUsd: 3.5,
      minTopup: 10,
    },
  });
  await withClient(wallet, async client => {
    const result = await client.callTool({ name: 'send_agent_message', arguments: { agent: 'studio', message: 'hi' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /at least \$10\.00/);
    assert.match(textOf(result), /has \$3\.50/);
    assert.match(textOf(result), /get_account/);
  });

  const unavailable = fakeClient({
    '/Studio/Message/Send': {
      result: false,
      errors: [{ code: 0, message: 'Agent has no remaining credits. Renew your subscription or buy a credit pack to continue.' }],
      agentstatus: 4,
      agentbalance: { monthlycredits: 987654, extracredits: 0, usedcredits: 987654, remainingcredits: 0 },
    },
  });
  await withClient(unavailable, async client => {
    const result = await client.callTool({ name: 'send_agent_message', arguments: { agent: 'studio', message: 'hi' } });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '## Error\n\nStudio is temporarily unavailable. Please try again shortly.');
  });
});

test('an invalid model is answered with the models that can be chosen', async () => {
  const fake = fakeClient({
    '/StudioWorkflow/Message/Send': {
      result: false,
      errors: [{ code: 0, message: 'Invalid model: bad/model is not in the selectable model allowlist.' }],
    },
    '/StudioWorkflow/Status': {
      result: true,
      errors: [],
      walletUsd: 50,
      tokenRates: {
        default_model: 'acme/one',
        models: {
          'acme/one': { selectable: true, input: 1, output: 2 },
          'acme/hidden': { selectable: false },
          'acme/three': { selectable: true },
        },
      },
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'workflow-agent', message: 'Build a flow', model: 'bad/model' },
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /Models you can choose: acme\/one, acme\/three \(default: acme\/one\)/);
    assert.doesNotMatch(text, /acme\/hidden/);
    assert.equal(fake.callsTo('/StudioWorkflow/Message/Send').length, 1);
  });
});

test('inputs that do not apply to an agent are refused before anything is sent', async () => {
  const fake = fakeClient({});
  await withClient(fake, async client => {
    const model = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'agent-guid-1', message: 'hi', model: 'acme/one' },
    });
    assert.equal(model.isError, true);
    assert.match(textOf(model), /update_agent/);

    const workflow = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'studio', message: 'hi', workflow: 'campaign-Ab12C' },
    });
    assert.equal(workflow.isError, true);

    const reserved = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'studio', message: 'hi', session: 'cron:daily' },
    });
    assert.equal(reserved.isError, true);
    assert.match(textOf(reserved), /reserved/);

    const badSession = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'workflow-agent', message: 'hi', session: 'has spaces' },
    });
    assert.equal(badSession.isError, true);

    const badAgent = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'not a guid', message: 'hi' },
    });
    assert.equal(badAgent.isError, true);
    assert.match(textOf(badAgent), /list_my_agents/);

    const local = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'studio', message: 'edit this', attachment_urls: ['http://127.0.0.1/a.png'] },
    });
    assert.equal(local.isError, true);
    assert.match(textOf(local), /not a public address/);
  });
  assert.equal(fake.calls.length, 0);
});

test('attachments are sent as multipart files with a usable name and type', async () => {
  assert.equal(attachmentFileName('https://cdn.example/files/photo.png?x=1', 'image/png', 0), 'photo.png');
  assert.equal(attachmentFileName('https://cdn.example/render', 'video/mp4; codecs=avc1', 1), 'render.mp4');
  assert.equal(attachmentFileName('https://cdn.example/', 'application/pdf', 2), 'attachment-3.pdf');

  const form = buildMessageForm(
    { message: 'Use this', sessionkey: 'mcp-1' },
    [{ name: 'photo.png', contentType: 'image/png', data: Buffer.from('png-bytes') }],
  );
  assert.equal(form.get('message'), 'Use this');
  assert.equal(form.get('sessionkey'), 'mcp-1');
  const file = form.get('attachments');
  assert.equal(file.name, 'photo.png');
  assert.equal(file.type, 'image/png');
  assert.equal(await file.text(), 'png-bytes');
});

test('the Workflow Agent gets the workflow to edit and its reply comes back as workflows plus the requested list', async () => {
  const contents = workflowContents();
  contents.metadata.input.values = { prompt: 'saved start value' };
  const artifact = {
    artifactVersion: 1,
    title: 'Faster campaign',
    description: 'Same flow with a faster model',
    contents: workflowContents(),
  };
  const request = { protocolVersion: 1, requestId: 'req-1', operation: 'workflow.list', args: { search: 'campaign' } };
  const reply = [
    'Here is the faster version.',
    '```wiro-workflow-request',
    JSON.stringify(request),
    '```',
    '```wiro-workflow',
    JSON.stringify(artifact, null, 2),
    '```',
    'Save it when you are ready.',
  ].join('\n');

  const fake = fakeClient({
    '/Workflow/Detail': {
      result: true,
      errors: [],
      workflow: [{
        id: 7,
        useruuid: 'owner-uuid-1234',
        teamguid: null,
        slug: 'campaign',
        slugid: 'Ab12C',
        title: 'Campaign',
        description: 'Makes campaign images',
        updatetime: '1700000000',
        contents,
      }],
    },
    '/StudioWorkflow/Message/Send': { result: true, errors: [], messageguid: 'wf-1', agenttoken: 'secret-agent-token', status: 'agent_queue' },
    '/StudioWorkflow/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({ guid: 'wf-1', sessionkey: 'mcp-flow', status: 'agent_end', response: reply, debugoutput: reply, tokencost: '30' }),
    },
    '/Workflow/List': {
      result: true,
      errors: [],
      total: '3',
      workflow: [
        { slug: 'campaign', slugid: 'Ab12C', title: 'Campaign', updatetime: '1700000000', clonedfromid: null, isprotected: 0, useruuid: 'owner-uuid-1234' },
        { slug: 'bought', slugid: 'Zz99Z', title: 'Bought copy', updatetime: '1700000001', clonedfromid: 5, isprotected: 1 },
        { slug: 'campaign-2', slugid: 'Qq11Q', title: 'Campaign 2', updatetime: '1690000000', clonedfromid: null, isprotected: 0 },
      ],
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'send_agent_message',
      arguments: {
        agent: 'workflow-agent',
        message: 'Make it faster',
        session: 'mcp-flow',
        workflow: 'https://wiro.ai/workflows/campaign-Ab12C',
      },
    });

    assert.notEqual(result.isError, true, textOf(result));
    const sent = fake.callsTo('/StudioWorkflow/Message/Send')[0].body;
    assert.equal(sent.sessionkey, 'mcp-flow');
    assert.equal(sent.message, 'Make it faster');
    assert.deepEqual(sent.workflowContext.source, {
      slug: 'campaign',
      slugid: 'Ab12C',
      fullSlug: 'campaign-Ab12C',
      title: 'Campaign',
      description: 'Makes campaign images',
      updatetime: '1700000000',
      workspace: 'personal',
    });
    assert.equal(sent.workflowContext.protocolVersion, 1);
    assert.equal(sent.workflowContext.contents.metadata.input.values, undefined);
    assert.equal(Object.hasOwn(sent, 'uuid'), false);
    assert.deepEqual(fake.callsTo('/Workflow/Detail')[0].body, { slug: 'campaign-Ab12C' });

    const output = result.structuredContent;
    assert.equal(output.message.reply, 'Here is the faster version.\nSave it when you are ready.');
    assert.deepEqual(output.message.mediaUrls, []);
    assert.equal(output.llmCostUsd, 0.3);
    assert.deepEqual(output.attachedWorkflow, {
      fullSlug: 'campaign-Ab12C',
      title: 'Campaign',
      updatetime: '1700000000',
      url: 'https://wiro.ai/workflows/campaign-Ab12C',
    });
    assert.equal(output.workflows.length, 1);
    assert.equal(output.workflows[0].valid, true);
    assert.equal(output.workflows[0].index, 0);
    assert.equal(output.workflows[0].title, 'Faster campaign');
    assert.equal(output.workflows[0].nodeCount, 2);
    assert.match(output.workflows[0].artifactHash, /^[0-9a-f]{64}$/);

    const lists = fake.callsTo('/Workflow/List');
    assert.equal(lists.length, 1);
    assert.deepEqual(lists[0].body, {
      scope: 'my',
      start: '0',
      limit: '50',
      summary: true,
      sort: 'updatetime',
      order: 'DESC',
      search: 'campaign',
    });
    assert.deepEqual(output.workflowList.rows.map(row => row.fullSlug), ['campaign-Ab12C', 'campaign-2-Qq11Q']);
    assert.equal(output.workflowList.total, 2);
    assert.match(output.workflowList.instruction, /workflow set to its fullSlug/);

    assert.deepEqual(output.nextAction, {
      tool: 'save_workflow_from_agent',
      arguments: {
        session: 'mcp-flow',
        message_id: 'wf-1',
        artifact_hash: output.workflows[0].artifactHash,
        workflow: 'campaign-Ab12C',
        loaded_updatetime: '1700000000',
      },
      reason: output.nextAction.reason,
    });
    assert.doesNotMatch(textOf(result), /"contents"/);
    assertNoSecrets(result);
  });
});

test('get_agent_message never runs the list request when the reply has only invalid workflows', async () => {
  const broken = { artifactVersion: 1, title: 'Broken', contents: { ...workflowContents(), output: { other: '$node-util-b.result' } } };
  const reply = `Draft below.\n\`\`\`wiro-workflow\n${JSON.stringify(broken)}\n\`\`\``;
  const fake = fakeClient({
    '/StudioWorkflow/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({ guid: 'wf-2', status: 'agent_end', response: reply }),
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'workflow-agent', message_id: 'wf-2', session: 'mcp-flow', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const workflow = result.structuredContent.workflows[0];
    assert.equal(workflow.valid, false);
    assert.equal(workflow.status, 'invalid');
    assert.match(workflow.issues[0], /must exactly match nodes\.output\.fields/);
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.equal(result.structuredContent.workflowList, undefined);
    assert.equal(result.structuredContent.message.userText, 'Make a cat picture');
    assert.ok(result.structuredContent.notes.some(note => /fix them/.test(note)));
  });
});

test('Workflow Agent refusals: protected copies and API keys it does not accept', async () => {
  const protectedCopy = fakeClient({
    '/Workflow/Detail': {
      result: true,
      errors: [],
      workflow: [{ slug: 'bought', slugid: 'Zz99Z', title: 'Bought', updatetime: '1', contents: workflowContents(), estimatedcost: { type: 'estimated', value: 0.2 } }],
    },
  });
  await withClient(protectedCopy, async client => {
    const result = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'workflow-agent', message: 'edit', workflow: 'bought-Zz99Z' },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /protected copy/);
    assert.equal(protectedCopy.callsTo('/StudioWorkflow/Message/Send').length, 0);
  });

  const refused = fakeClient({
    '/StudioWorkflow/Message/Send': () => {
      throw new WiroApiError(403, '{"result":false,"errors":[{"code":0,"message":"Bearer authentication is required."}]}');
    },
    '/StudioWorkflow/Message/Sessions': () => {
      throw new WiroApiError(403, '{"result":false,"errors":[{"code":0,"message":"Bearer authentication is required."}]}');
    },
  });
  await withClient(refused, async client => {
    for (const call of [
      { name: 'send_agent_message', arguments: { agent: 'workflow-agent', message: 'hi' } },
      { name: 'get_agent_conversation', arguments: { agent: 'workflow-agent' } },
    ]) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /did not accept this API key/);
      assert.doesNotMatch(textOf(result), /Wiro API error/);
    }
  });
});

test('a team key whose creator left the team gets a readable refusal from Studio and the Workflow Agent', async () => {
  const body = '{"result":false,"errors":[{"code":0,"message":"You must be a member of this team to perform this action"}]}';
  const fake = fakeClient({
    '/Studio/Message/Send': () => { throw new WiroApiError(403, body); },
    '/StudioWorkflow/Message/Send': () => { throw new WiroApiError(403, body); },
  });
  await withClient(fake, async client => {
    for (const agent of ['studio', 'workflow-agent']) {
      const result = await client.callTool({ name: 'send_agent_message', arguments: { agent, message: 'hi' } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /the person who created it is no longer a member of that team/);
      assert.doesNotMatch(textOf(result), /\{"result"/);
    }
  });
});

test('get_agent_message reads a deployed agent message without secrets and explains a missing one', async () => {
  const fake = fakeClient({
    '/UserAgent/Message/Detail': (body) => (body.messageguid === 'msg-9'
      ? {
        result: true,
        errors: [],
        data: messageRow({
          guid: 'msg-9',
          sessionkey: 'support',
          status: 'agent_end',
          content: 'Render the intro',
          response: 'Done.\nMEDIA:https://cdn1.wiro.ai/intro.mp4',
          tokencost: '7',
        }),
      }
      : { result: false, errors: [{ code: 0, message: 'Message not found' }] }),
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'agent-guid-1', message_id: 'msg-9', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.session, 'support');
    assert.equal(output.agentKind, 'deployed');
    assert.equal(output.message.userText, 'Render the intro');
    assert.deepEqual(output.message.mediaUrls, ['https://cdn1.wiro.ai/intro.mp4']);
    assert.equal(output.message.creditsUsed, 7);
    assert.equal(output.llmCostUsd, undefined);
    assert.deepEqual(
      result.content.filter(block => block.type === 'resource_link').map(link => [link.uri, link.mimeType]),
      [['https://cdn1.wiro.ai/intro.mp4', 'video/mp4']],
    );
    assert.deepEqual(fake.callsTo('/UserAgent/Message/Detail')[0].body, { messageguid: 'msg-9', useragentguid: 'agent-guid-1' });
    assertNoSecrets(result);

    // Within the first seconds "not found" can be a new message that is not visible yet.
    const early = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'agent-guid-1', message_id: 'nope', wait_seconds: 0 },
    });
    assert.notEqual(early.isError, true, textOf(early));
    assert.equal(early.structuredContent.done, false);
    assert.equal(early.structuredContent.message.messageId, 'nope');
    // Nothing was read, so no status of Wiro's is claimed for it.
    assert.equal(early.structuredContent.message.status, 'not_visible');
    assert.match(textOf(early), /^## Message not visible yet\n/);
    assert.doesNotMatch(textOf(early), /agent_queue|is still working/);
    assert.ok(early.structuredContent.notes.some(note => /does not show this message yet/.test(note)));
    assert.doesNotMatch(textOf(early), /Pass the same session/);
    assert.deepEqual(early.structuredContent.nextAction.arguments, {
      agent: 'agent-guid-1',
      message_id: 'nope',
      wait_seconds: 15,
    });
  });

  // Past the first 10 seconds it is reported as missing.
  const clock = shiftedClock();
  try {
    const late = fakeClient({
      '/UserAgent/Message/Detail': () => {
        clock.advance(11_000);
        return { result: false, errors: [{ code: 0, message: 'Message not found' }] };
      },
      '/Studio/Message/Detail': () => {
        clock.advance(11_000);
        return { result: false, errors: [{ code: 0, message: 'Message not found' }] };
      },
    });
    await withClient(late, async client => {
      const missing = await client.callTool({
        name: 'get_agent_message',
        arguments: { agent: 'agent-guid-1', message_id: 'nope', wait_seconds: 30 },
      });
      assert.equal(missing.isError, true);
      assert.match(textOf(missing), /Message not found\. Check message_id and agent/);

      const studioMissing = await client.callTool({
        name: 'get_agent_message',
        arguments: { agent: 'studio', message_id: 'nope', wait_seconds: 30 },
      });
      assert.equal(studioMissing.isError, true);
      assert.match(textOf(studioMissing), /Pass the same session the message was sent in/);
    });
  } finally {
    clock.restore();
  }
});

test('get_agent_conversation lists sessions and pages history without voice data or stream tokens', async () => {
  const fake = fakeClient({
    '/UserAgent/Message/Sessions': {
      result: true,
      errors: [],
      data: {
        sessions: [
          { sessionkey: 'default', messagecount: '4', updatedat: '1700000100', lastmessage: '\u{1F4DE} Incoming voice call: +15551234567' },
          { sessionkey: 'cron:daily', messagecount: '2', updatedat: '1700000050', lastmessage: 'report' },
          { sessionkey: 'support', messagecount: 0, updatedat: '1690000000', lastmessage: 'Hello there', name: 'Support', uuid: 'owner-uuid-1234', user: { email: 'owner@example.com' } },
        ],
      },
    },
    '/UserAgent/Message/History': {
      result: true,
      errors: [],
      data: {
        count: 2,
        hasmore: true,
        sessiontoken: 'secret-session-token',
        messages: [
          {
            guid: 'voice-1',
            uuid: 'owner-uuid-1234',
            content: '\u{1F4DE} Incoming voice call: +15551234567',
            response: 'Caller +15551234567 asked about prices',
            status: 'agent_end',
            metadata: { type: 'realtime_session', callerInfo: { number: '+15551234567' }, transcript: [{ role: 'user', text: 'hi' }] },
            createdat: '1700000090',
          },
          {
            guid: 'msg-1',
            uuid: 'owner-uuid-1234',
            agenttoken: 'secret-agent-token',
            content: 'What did we sell?',
            response: 'Twelve units.',
            status: 'agent_end',
            metadata: { type: 'progressGenerate' },
            createdat: '1700000000',
            tokencost: '3',
            user: { email: 'owner@example.com' },
          },
        ],
      },
    },
  });

  await withClient(fake, async client => {
    const listed = await client.callTool({ name: 'get_agent_conversation', arguments: { agent: 'agent-guid-1' } });
    assert.notEqual(listed.isError, true, textOf(listed));
    assert.deepEqual(listed.structuredContent.sessions, [
      { session: 'default', messageCount: 4, updatedAt: new Date(1700000100 * 1000).toISOString(), lastMessage: 'Voice call' },
      { session: 'support', name: 'Support', messageCount: 0, updatedAt: new Date(1690000000 * 1000).toISOString(), lastMessage: 'Hello there' },
    ]);
    assert.deepEqual(listed.structuredContent.nextAction.arguments, { agent: 'agent-guid-1', session: 'default' });
    assert.deepEqual(fake.callsTo('/UserAgent/Message/Sessions')[0].body, { useragentguid: 'agent-guid-1' });
    assertNoSecrets(listed);

    const history = await client.callTool({
      name: 'get_agent_conversation',
      arguments: { agent: 'agent-guid-1', session: 'default', limit: 2 },
    });
    assert.notEqual(history.isError, true, textOf(history));
    const output = history.structuredContent;
    assert.equal(output.messages.length, 2);
    assert.deepEqual(output.messages[0], {
      messageId: 'voice-1',
      state: 'completed',
      status: 'agent_end',
      kind: 'voice_call',
      mediaUrls: [],
      toolsUsed: [],
      attachments: [],
      createdAt: new Date(1700000090 * 1000).toISOString(),
    });
    assert.equal(output.messages[1].userText, 'What did we sell?');
    assert.equal(output.messages[1].reply, 'Twelve units.');
    assert.equal(output.hasMore, true);
    assert.equal(output.nextBefore, 'msg-1');
    assert.deepEqual(output.nextAction.arguments, { agent: 'agent-guid-1', session: 'default', limit: 2, before: 'msg-1' });
    assert.deepEqual(fake.callsTo('/UserAgent/Message/History')[0].body, { limit: 2, useragentguid: 'agent-guid-1', sessionkey: 'default' });
    assertNoSecrets(history);

    const reserved = await client.callTool({
      name: 'get_agent_conversation',
      arguments: { agent: 'agent-guid-1', session: 'voice-call-123' },
    });
    assert.equal(reserved.isError, true);
  });
});

test('cancel_agent_message reads the final status back, including a turn that finished anyway', async () => {
  const fake = fakeClient({
    '/Studio/Message/Cancel': { result: true, errors: [] },
    '/Studio/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({ guid: 'msg-5', status: 'agent_end', response: 'Finished before the stop arrived.' }),
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'cancel_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-5', session: 'mcp-1' },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.cancelAccepted, true);
    assert.equal(output.finalStatus, 'agent_end');
    assert.equal(output.finalState, 'completed');
    assert.ok(output.notes.some(note => /finished anyway/.test(note)));
    assert.ok(output.notes.some(note => /list_studio_results/.test(note)));
    assert.deepEqual(fake.callsTo('/Studio/Message/Cancel')[0].body, { messageguid: 'msg-5', sessionkey: 'mcp-1' });
    assertNoSecrets(result);
  });

  const ended = fakeClient({
    '/UserAgent/Message/Cancel': { result: false, errors: [{ code: 0, message: 'Message cannot be cancelled (status: agent_end)' }] },
  });
  await withClient(ended, async client => {
    const result = await client.callTool({
      name: 'cancel_agent_message',
      arguments: { agent: 'agent-guid-1', message_id: 'msg-6' },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.cancelAccepted, false);
    assert.equal(result.structuredContent.finalStatus, 'agent_end');
    assert.deepEqual(ended.callsTo('/UserAgent/Message/Cancel')[0].body, { messageguid: 'msg-6', useragentguid: 'agent-guid-1' });
  });
});

test('delete_agent_session asks for confirmation, then deletes and resets memory for each agent', async () => {
  const fake = fakeClient({
    '/Studio/Message/Sessions': { result: true, errors: [], data: { sessions: [{ sessionkey: 'mcp-1', messagecount: '6', updatedat: '1700000000', lastmessage: 'hi' }] } },
    '/Studio/Message/ClearSession': { result: true, errors: [] },
    '/UserAgent/Message/DeleteSession': { result: true, errors: [] },
    '/StudioWorkflow/Message/DeleteSession': { result: true, errors: [] },
  });

  await withClient(fake, async client => {
    const preview = await client.callTool({
      name: 'delete_agent_session',
      arguments: { agent: 'studio', session: 'mcp-1' },
    });
    assert.notEqual(preview.isError, true, textOf(preview));
    assert.equal(preview.structuredContent.deleted, false);
    assert.equal(preview.structuredContent.messageCount, 6);
    assert.deepEqual(preview.structuredContent.nextAction, {
      tool: 'delete_agent_session',
      arguments: { agent: 'studio', session: 'mcp-1', confirm: true },
      reason: 'Ask the user to confirm this permanent deletion first.',
    });
    assert.equal(fake.callsTo('/Studio/Message/ClearSession').length, 0);

    const studio = await client.callTool({
      name: 'delete_agent_session',
      arguments: { agent: 'studio', session: 'mcp-1', confirm: true },
    });
    assert.equal(studio.structuredContent.deleted, true);
    assert.equal(studio.structuredContent.memoryReset, true);
    assert.deepEqual(fake.callsTo('/Studio/Message/ClearSession')[0].body, { sessionkey: 'mcp-1' });

    const deployed = await client.callTool({
      name: 'delete_agent_session',
      arguments: { agent: 'agent-guid-1', session: 'support', confirm: true },
    });
    assert.equal(deployed.structuredContent.deleted, true);
    assert.deepEqual(fake.callsTo('/UserAgent/Message/DeleteSession')[0].body, {
      rotate: true,
      useragentguid: 'agent-guid-1',
      sessionkey: 'support',
    });

    const workflowDefault = await client.callTool({
      name: 'delete_agent_session',
      arguments: { agent: 'workflow-agent', session: 'default', confirm: true },
    });
    assert.equal(workflowDefault.isError, true);
    assert.equal(fake.callsTo('/StudioWorkflow/Message/DeleteSession').length, 0);

    const workflowNamed = await client.callTool({
      name: 'delete_agent_session',
      arguments: { agent: 'workflow-agent', session: 'mcp-flow', confirm: true },
    });
    assert.equal(workflowNamed.structuredContent.deleted, true);
    assert.deepEqual(fake.callsTo('/StudioWorkflow/Message/DeleteSession')[0].body, { sessionkey: 'mcp-flow' });
  });
});

test('delete_agent_session does not report deleting a session the key cannot see', async () => {
  const fake = fakeClient({
    '/StudioWorkflow/Message/Sessions': { result: true, errors: [], data: { sessions: [{ sessionkey: 'default', messagecount: 0, updatedat: null, lastmessage: '' }] } },
    '/StudioWorkflow/Message/DeleteSession': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    for (const confirm of [false, true]) {
      const result = await client.callTool({
        name: 'delete_agent_session',
        arguments: { agent: 'workflow-agent', session: 'other-project-chat', confirm },
      });
      assert.notEqual(result.isError, true, textOf(result));
      assert.equal(result.structuredContent.deleted, false);
      assert.equal(result.structuredContent.nextAction, undefined);
      assert.match(textOf(result), /^## Nothing to delete\n/);
      assert.match(textOf(result), /only the Workflow Agent sessions of its own project/);
    }
    assert.equal(fake.callsTo('/StudioWorkflow/Message/DeleteSession').length, 0);
  });
});

test('delete_agent_session looks again before calling a fresh session missing', async () => {
  const fake = fakeClient({
    '/StudioWorkflow/Message/Sessions': (_body, count) => ({
      result: true,
      errors: [],
      data: {
        sessions: count === 1
          ? [{ sessionkey: 'default', messagecount: 0, updatedat: null, lastmessage: '' }]
          : [{ sessionkey: 'default', messagecount: 0, updatedat: null, lastmessage: '' }, { sessionkey: 'mcp-new', messagecount: '2', updatedat: '1700000000' }],
      },
    }),
    '/StudioWorkflow/Message/DeleteSession': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'delete_agent_session',
      arguments: { agent: 'workflow-agent', session: 'mcp-new', confirm: true },
    });
    assert.equal(result.structuredContent.deleted, true, textOf(result));
    assert.equal(fake.callsTo('/StudioWorkflow/Message/Sessions').length, 2);
    assert.deepEqual(fake.callsTo('/StudioWorkflow/Message/DeleteSession')[0].body, { sessionkey: 'mcp-new' });
  });
});

test('an unseen Workflow Agent message names the other-project cause from the first check', async () => {
  const fake = fakeClient({
    '/StudioWorkflow/Message/Detail': { result: false, errors: [{ code: 0, message: 'Message not found' }] },
  });
  await withClient(fake, async client => {
    const early = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'workflow-agent', message_id: 'nope', session: 'mcp-flow', wait_seconds: 0 },
    });
    assert.notEqual(early.isError, true, textOf(early));
    assert.ok(early.structuredContent.notes.some(note => /sent with another project's API key or on wiro\.ai/.test(note)));
    assert.match(early.structuredContent.nextAction.reason, /another project's API key or on wiro\.ai cannot be read with this key/);
  });
});

test('a Workflow Agent message another project sent reads as not found, with the reason', async () => {
  const clock = shiftedClock();
  try {
    const fake = fakeClient({
      '/StudioWorkflow/Message/Detail': () => {
        clock.advance(11_000);
        return { result: false, errors: [{ code: 0, message: 'Message not found' }] };
      },
    });
    await withClient(fake, async client => {
      const missing = await client.callTool({
        name: 'get_agent_message',
        arguments: { agent: 'workflow-agent', message_id: 'nope', session: 'mcp-flow', wait_seconds: 30 },
      });
      assert.equal(missing.isError, true);
      assert.match(textOf(missing), /Pass the same session the message was sent in/);
      assert.match(textOf(missing), /visible only to API keys of the project that sent it/);
    });
  } finally {
    clock.restore();
  }
});

test('list_studio_results filters by state and time and keeps run tokens private', async () => {
  const fake = fakeClient({
    '/Studio/Tasks': {
      result: true,
      errors: [],
      tasks: [
        { id: 3, status: 'task_start', terminal: false, success: null, socketaccesstoken: 'secret-run-token', parameters: '{"prompt":"a dog","apikey":"x"}', model: { slugowner: 'acme', slugproject: 'video' }, outputs: [], totalcost: '0', createtime: '1700000300' },
        {
          id: 2,
          status: 'task_postprocess_end',
          terminal: true,
          success: true,
          model: { slugowner: 'acme', slugproject: 'llm' },
          outputs: [{ contenttype: 'raw', content: { prompt: 'p', answer: ['Twelve ', 'words.'], raw: 'private raw' } }],
          totalcost: '0.001',
          createtime: '1700000200',
        },
        { id: 1, status: 'task_postprocess_end', terminal: true, success: false, outputs: [], totalcost: '0', createtime: '1600000000' },
      ],
    },
  });

  await withClient(fake, async client => {
    const all = await client.callTool({ name: 'list_studio_results', arguments: {} });
    assert.notEqual(all.isError, true, textOf(all));
    assert.equal(all.structuredContent.count, 3);
    assert.equal(all.structuredContent.running, 1);
    assert.equal(all.structuredContent.runs[0].prompt, 'a dog');
    assert.equal(all.structuredContent.runs[1].text, 'Twelve words.');
    assert.equal(all.structuredContent.runs[2].state, 'failed');
    assert.equal(all.structuredContent.nextAction.tool, 'list_studio_results');
    assert.deepEqual(fake.callsTo('/Studio/Tasks')[0].body, { limit: 20 });
    assert.doesNotMatch(JSON.stringify(all.structuredContent), /private raw|apikey/);
    assertNoSecrets(all);

    const completed = await client.callTool({
      name: 'list_studio_results',
      arguments: { state: 'completed', since: new Date(1700000000 * 1000).toISOString(), limit: 5 },
    });
    assert.deepEqual(completed.structuredContent.runs.map(run => run.id), ['2']);
    assert.equal(completed.structuredContent.nextAction, undefined);

    const badSince = await client.callTool({ name: 'list_studio_results', arguments: { since: 'yesterday-ish' } });
    assert.equal(badSince.isError, true);
  });
});

test('Studio keeps waiting for model runs that are still running and hands back get_agent_message', async () => {
  const fake = fakeClient({
    '/Studio/Message/Send': { result: true, errors: [], messageguid: 'msg-7', agenttoken: 'secret-agent-token', status: 'agent_queue' },
    '/Studio/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({ guid: 'msg-7', status: 'agent_end', response: 'Your video is rendering.', endedat: '1005', tokencost: '4' }),
    },
    '/Studio/Tasks': {
      result: true,
      errors: [],
      tasks: [{ id: 70, status: 'task_start', terminal: false, success: null, socketaccesstoken: 'secret-run-token', model: { slugowner: 'acme', slugproject: 'video' }, outputs: [], totalcost: '0', createtime: '1003' }],
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'studio', message: 'Make a video', session: 'mcp-vid', wait_seconds: 1 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.done, true);
    assert.equal(output.modelRunsPending, true);
    assert.equal(output.modelRuns[0].state, 'running');
    assert.ok(fake.callsTo('/Studio/Tasks').length >= 2, 'the runs are polled while time remains');
    assert.deepEqual(output.nextAction.arguments, { agent: 'studio', message_id: 'msg-7', session: 'mcp-vid' });
    assert.equal(output.nextAction.tool, 'get_agent_message');
    assert.equal(fake.callsTo('/Studio/Message/Send').length, 1);
    assertNoSecrets(result);
  });
});

test('a background hand-off points to the conversation instead of a resend', async () => {
  const fake = fakeClient({
    '/UserAgent/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({
        guid: 'msg-8',
        sessionkey: 'default',
        status: 'agent_end',
        response: 'Working on it in the background. The result will appear in this chat when it is ready.',
      }),
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'agent-guid-1', message_id: 'msg-8', session: 'default' },
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.background, true);
    assert.deepEqual(result.structuredContent.nextAction, {
      tool: 'get_agent_conversation',
      arguments: { agent: 'agent-guid-1', session: 'default', limit: 5 },
      reason: 'The result arrives as a later message in this session.',
    });
    assert.deepEqual(fake.callsTo('/UserAgent/Message/Detail')[0].body, {
      messageguid: 'msg-8',
      useragentguid: 'agent-guid-1',
      sessionkey: 'default',
    });
  });
});

test('Workflow Agent history summarizes workflows but never runs list requests', async () => {
  const artifact = { artifactVersion: 1, title: 'Old draft', contents: workflowContents() };
  const reply = [
    'An older answer.',
    '```wiro-workflow-request',
    JSON.stringify({ protocolVersion: 1, requestId: 'r', operation: 'workflow.list', args: {} }),
    '```',
    '```wiro-workflow',
    JSON.stringify(artifact),
    '```',
  ].join('\n');
  const fake = fakeClient({
    '/StudioWorkflow/Message/History': {
      result: true,
      errors: [],
      data: {
        hasmore: false,
        sessiontoken: 'secret-session-token',
        messages: [messageRow({ guid: 'wf-old', status: 'agent_end', content: 'Build it', response: reply })],
      },
    },
  });

  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'get_agent_conversation',
      arguments: { agent: 'workflow-agent', session: 'mcp-flow' },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const message = result.structuredContent.messages[0];
    assert.equal(message.reply, 'An older answer.');
    assert.equal(message.workflows[0].valid, true);
    assert.match(message.workflows[0].artifactHash, /^[0-9a-f]{64}$/);
    assert.equal(result.structuredContent.hasMore, false);
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.equal(fake.callsTo('/Workflow/List').length, 0);
    assert.deepEqual(fake.callsTo('/StudioWorkflow/Message/History')[0].body, { limit: 20, sessionkey: 'mcp-flow' });
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /"contents"/);
    assertNoSecrets(result);
  });
});

test('the messaging tools advertise output schemas, annotations and plain public copy', async () => {
  const names = [
    'send_agent_message',
    'get_agent_message',
    'get_agent_conversation',
    'cancel_agent_message',
    'delete_agent_session',
    'list_studio_results',
  ];
  await withClient(fakeClient({}), async client => {
    const { tools } = await client.listTools();
    for (const name of names) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.ok(tool.outputSchema, `${name} has an output schema`);
      assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(tool.outputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations?.[hint], 'boolean', `${name} ${hint}`);
      }
      assert.doesNotMatch(JSON.stringify(tool), /\u2014/, `${name} uses an em dash`);
    }
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    assert.equal(byName.send_agent_message.annotations.readOnlyHint, false);
    assert.equal(byName.get_agent_message.annotations.readOnlyHint, true);
    assert.equal(byName.delete_agent_session.annotations.destructiveHint, true);
    assert.equal(byName.cancel_agent_message.annotations.destructiveHint, true);
  });
});

test('after Send queued the turn, a failed read returns the message id and session instead of an error', async () => {
  const cases = [
    {
      name: 'Detail answers result:false',
      detail: () => ({ result: false, errors: [{ code: 0, message: 'Agent is temporarily unavailable. Please try again shortly.' }] }),
      reason: /could not be read just now \(Wiro answered that it is temporarily unavailable\)/,
    },
    {
      name: 'Detail answers result:false with retry advice',
      detail: () => ({ result: false, errors: [{ code: 0, message: 'Message lookup failed. Please try again in a minute.' }] }),
      reason: /could not be read just now \(Message lookup failed\.\)/,
    },
    {
      name: 'Detail answers HTTP 400',
      detail: () => { throw new WiroApiError(400, '{"result":false}'); },
      reason: /could not be read just now \(HTTP 400\)/,
    },
    {
      name: 'Detail answers HTTP 502 until the wait ends',
      detail: (_body, _count, clock) => {
        clock.advance(31_000);
        throw new WiroApiError(502, '<html>Bad Gateway</html>');
      },
      reason: /could not be read just now \(HTTP 502\)/,
    },
    {
      name: 'Detail keeps saying not found past 10 seconds',
      detail: (_body, _count, clock) => {
        clock.advance(31_000);
        return { result: false, errors: [{ code: 0, message: 'Message not found' }] };
      },
      reason: /does not show it yet/,
    },
  ];

  for (const { name, detail, reason } of cases) {
    const clock = shiftedClock();
    try {
      const fake = fakeClient({
        '/Studio/Message/Send': { result: true, errors: [], messageguid: 'msg-q', agenttoken: 'secret-agent-token', status: 'agent_queue' },
        '/Studio/Message/Detail': (body, count) => detail(body, count, clock),
      });
      await withClient(fake, async client => {
        const result = await client.callTool({
          name: 'send_agent_message',
          arguments: { agent: 'studio', message: 'Make a cat picture', wait_seconds: 30 },
        });
        assert.notEqual(result.isError, true, `${name}: ${textOf(result)}`);
        const output = result.structuredContent;
        const sentSession = fake.callsTo('/Studio/Message/Send')[0].body.sessionkey;
        assert.equal(output.done, false, name);
        assert.equal(output.session, sentSession, name);
        assert.equal(output.sessionCreated, true, name);
        assert.equal(output.message.messageId, 'msg-q', name);
        assert.equal(output.message.status, 'agent_queue', name);
        assert.ok(output.notes.some(note => reason.test(note) && /Do not send it again/.test(note)), name);
        // "Do not send it again" must not sit next to the server's own retry advice.
        assert.doesNotMatch(textOf(result), /try again/i, name);
        assert.deepEqual(output.nextAction.arguments, { agent: 'studio', message_id: 'msg-q', session: sentSession }, name);
        assert.equal(output.nextAction.tool, 'get_agent_message', name);
        assert.equal(fake.callsTo('/Studio/Message/Send').length, 1, `${name}: never resent`);
        assert.doesNotMatch(textOf(result), /Bad Gateway/, name);
        assertNoSecrets(result);
      });
    } finally {
      clock.restore();
    }
  }
});

test('send errors with an unknown outcome name the session to check before resending', async () => {
  const transport = fakeClient({
    '/Studio/Message/Send': () => { throw new TypeError('fetch failed'); },
  });
  await withClient(transport, async client => {
    const result = await client.callTool({ name: 'send_agent_message', arguments: { agent: 'studio', message: 'Make a cat' } });
    assert.equal(result.isError, true);
    const session = transport.callsTo('/Studio/Message/Send')[0].body.sessionkey;
    assert.match(session, /^mcp-[a-z0-9]+$/);
    assert.match(textOf(result), new RegExp(`may still have been queued\\. Check get_agent_conversation with agent "studio" and session "${session}"`));
    assert.equal(transport.calls.length, 1);
  });

  const noId = fakeClient({ '/StudioWorkflow/Message/Send': { result: true, errors: [], status: 'agent_queue' } });
  await withClient(noId, async client => {
    const result = await client.callTool({ name: 'send_agent_message', arguments: { agent: 'workflow-agent', message: 'Build', session: 'mcp-flow' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /no message id\. Check get_agent_conversation with agent "workflow-agent" and session "mcp-flow"/);
  });

  // A bare "temporarily unavailable" can follow a Send that timed out inside Wiro after queueing.
  for (const [agent, path] of [['studio', '/Studio/Message/Send'], ['agent-guid-1', '/UserAgent/Message/Send']]) {
    const unavailable = fakeClient({
      [path]: { result: false, errors: [{ code: 0, message: 'Agent is temporarily unavailable. Please try again shortly.' }] },
    });
    await withClient(unavailable, async client => {
      const result = await client.callTool({ name: 'send_agent_message', arguments: { agent, message: 'hi', session: 'support' } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), new RegExp(`temporarily unavailable\\. The message may still have been queued\\. Check get_agent_conversation with agent "${agent}" and session "support"`));
      assert.doesNotMatch(textOf(result), /try again shortly/);
      assert.equal(unavailable.calls.length, 1);
    });
  }
});

test('get_agent_message returns voice call rows without the caller or the call', async () => {
  const rows = [
    {
      guid: 'voice-1',
      uuid: 'owner-uuid-1234',
      content: '',
      response: '\u{1F4DE} Incoming voice call: +15551234567',
      debugoutput: '\u{1F4DE} Incoming voice call: +15551234567',
      status: 'agent_end',
      metadata: { type: 'realtime_session', callerInfo: { number: '+15551234567' } },
      createdat: '1700000000',
      endedat: '1700000300',
      timeline: [],
      attachments: [],
    },
    {
      guid: 'voice-2',
      content: '',
      response: '\u{1F4DE} Incoming voice call: +15551234567',
      status: 'agent_output',
      metadata: {},
      createdat: '1700000400',
    },
  ];
  const fake = fakeClient({
    '/UserAgent/Message/Detail': body => ({ result: true, errors: [], data: rows.find(row => row.guid === body.messageguid) }),
  });

  await withClient(fake, async client => {
    for (const row of rows) {
      const result = await client.callTool({
        name: 'get_agent_message',
        arguments: { agent: 'agent-guid-1', message_id: row.guid, wait_seconds: 0 },
      });
      assert.notEqual(result.isError, true, textOf(result));
      const message = result.structuredContent.message;
      assert.equal(message.kind, 'voice_call');
      assert.equal(message.messageId, row.guid);
      for (const field of ['reply', 'userText', 'replyTruncated']) assert.equal(message[field], undefined, field);
      assert.equal(result.structuredContent.partialReply, undefined);
      assert.deepEqual(message.mediaUrls, []);
      assert.ok(result.structuredContent.notes.some(note => /voice call record/.test(note)));
      assertNoSecrets(result);
    }
  });
});

test('a workflow attached on send travels through get_agent_message into the save step', async () => {
  const artifact = { artifactVersion: 1, title: 'Faster campaign', contents: workflowContents() };
  const reply = `Here it is.\n\`\`\`wiro-workflow\n${JSON.stringify(artifact)}\n\`\`\``;
  let finished = false;
  const fake = fakeClient({
    '/Workflow/Detail': {
      result: true,
      errors: [],
      workflow: [{ slug: 'campaign', slugid: 'Ab12C', title: 'Campaign', updatetime: '1700000000', teamguid: null, contents: workflowContents() }],
    },
    '/StudioWorkflow/Message/Send': { result: true, errors: [], messageguid: 'wf-9', agenttoken: 'secret-agent-token', status: 'agent_queue' },
    '/StudioWorkflow/Message/Detail': () => ({
      result: true,
      errors: [],
      data: finished
        ? messageRow({ guid: 'wf-9', status: 'agent_end', response: reply })
        : messageRow({ guid: 'wf-9', status: 'agent_start' }),
    }),
  });

  await withClient(fake, async client => {
    const sent = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'workflow-agent', message: 'Make it faster', session: 'mcp-flow', workflow: 'campaign-Ab12C', wait_seconds: 1 },
    });
    assert.notEqual(sent.isError, true, textOf(sent));
    assert.deepEqual(sent.structuredContent.nextAction.arguments, {
      agent: 'workflow-agent',
      message_id: 'wf-9',
      session: 'mcp-flow',
      workflow: 'campaign-Ab12C',
      loaded_updatetime: '1700000000',
    });

    finished = true;
    const got = await client.callTool({
      name: 'get_agent_message',
      arguments: { ...sent.structuredContent.nextAction.arguments, wait_seconds: 0 },
    });
    assert.notEqual(got.isError, true, textOf(got));
    const output = got.structuredContent;
    assert.deepEqual(output.attachedWorkflow, {
      fullSlug: 'campaign-Ab12C',
      updatetime: '1700000000',
      url: 'https://wiro.ai/workflows/campaign-Ab12C',
    });
    assert.deepEqual(output.nextAction.arguments, {
      session: 'mcp-flow',
      message_id: 'wf-9',
      artifact_hash: output.workflows[0].artifactHash,
      workflow: 'campaign-Ab12C',
      loaded_updatetime: '1700000000',
    });
    assert.equal(output.nextAction.tool, 'save_workflow_from_agent');
    assert.equal(Object.hasOwn(output.nextAction.arguments, 'confirm'), false);
    assert.match(output.nextAction.reason, /campaign-Ab12C.*summary of the change.*confirm: true/);
    assert.match(textOf(got), /\*\*Attached workflow:\*\* `campaign-Ab12C`/);

    // Without the attachment the save step says how to apply it instead of claiming a new copy is the only way.
    const bare = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'workflow-agent', message_id: 'wf-9', session: 'mcp-flow', wait_seconds: 0 },
    });
    assert.equal(bare.structuredContent.nextAction.arguments.workflow, undefined);
    assert.match(bare.structuredContent.nextAction.reason, /pass workflow and loaded_updatetime from that send's attachedWorkflow/);

    for (const args of [
      { workflow: 'campaign-Ab12C' },
      { loaded_updatetime: '1700000000' },
      { workflow: 'not a slug', loaded_updatetime: '1700000000' },
    ]) {
      const refused = await client.callTool({
        name: 'get_agent_message',
        arguments: { agent: 'workflow-agent', message_id: 'wf-9', session: 'mcp-flow', wait_seconds: 0, ...args },
      });
      assert.equal(refused.isError, true, JSON.stringify(args));
    }
    const studio = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'wf-9', workflow: 'campaign-Ab12C', loaded_updatetime: '1700000000' },
    });
    assert.equal(studio.isError, true);
    assert.match(textOf(studio), /only to agent "workflow-agent"/);
  });
});

test('a Workflow Agent list request asks for the user\'s choice in a note, not as a send without a message', async () => {
  const request = { protocolVersion: 1, requestId: 'req-2', operation: 'workflow.list', args: { search: 'campaign' } };
  const reply = ['Which one do you mean?', '```wiro-workflow-request', JSON.stringify(request), '```'].join('\n');
  for (const listed of [
    [{ slug: 'campaign', slugid: 'Ab12C', title: 'Campaign', updatetime: '1700000000' }],
    [
      { slug: 'campaign', slugid: 'Ab12C', title: 'Campaign', updatetime: '1700000000' },
      { slug: 'campaign-2', slugid: 'Qq11Q', title: 'Campaign 2', updatetime: '1690000000' },
    ],
  ]) {
    const fake = fakeClient({
      '/StudioWorkflow/Message/Detail': { result: true, errors: [], data: messageRow({ guid: 'wf-l', status: 'agent_end', response: reply }) },
      '/Workflow/List': { result: true, errors: [], total: String(listed.length), workflow: listed },
    });
    await withClient(fake, async client => {
      const result = await client.callTool({
        name: 'get_agent_message',
        arguments: { agent: 'workflow-agent', message_id: 'wf-l', session: 'mcp-flow', wait_seconds: 0 },
      });
      assert.notEqual(result.isError, true, textOf(result));
      const output = result.structuredContent;
      // The send needs the user's own edit request, so no call is offered.
      assert.equal(output.nextAction, undefined);
      assert.doesNotMatch(textOf(result), /\*\*Next:\*\*/);
      assert.equal(output.workflowList.rows.length, listed.length);
      const note = output.notes.find(item => /needs the workflow attached/.test(item));
      assert.ok(note, JSON.stringify(output.notes));
      assert.match(note, /send_agent_message with agent "workflow-agent", session "mcp-flow"/);
      assert.match(note, listed.length === 1
        ? /they mean "Campaign".*workflow "campaign-Ab12C" and their edit request as message/
        : /which of the listed workflows they mean.*workflow set to that workflow's fullSlug/);
      assert.match(note, /new, billed turn/);
      assert.doesNotMatch(note, /<[a-z ]+>/);
      assert.match(textOf(result), /### Notes[\s\S]*needs the workflow attached/);
    });
  }
});

test('a Studio turn that yielded to sub-agents keeps collecting the runs they start after it ended', async () => {
  const now = Math.floor(Date.now() / 1000);
  const yielded = messageRow({
    guid: 'msg-y',
    status: 'agent_end',
    response: 'I am rendering your video now and will post it here when it is ready.',
    createdat: String(now - 200),
    endedat: String(now - 190),
    timeline: [
      { type: 'tool', toollabel: 'sessions_spawn', toolstatus: 'completed', callindex: 0, contentindex: 0 },
      { type: 'tool', toollabel: 'sessions_yield', toolstatus: 'completed', callindex: 1, contentindex: 0 },
    ],
  });
  const lateRun = {
    id: 77,
    status: 'task_postprocess_end',
    terminal: true,
    success: true,
    model: { slugowner: 'acme', slugproject: 'video-1' },
    outputs: [{ name: 'cat.mp4', contenttype: 'video/mp4', size: '1', url: 'https://cdn1.wiro.ai/cat.mp4' }],
    totalcost: '0.5',
    createtime: String(now - 100),
  };

  const history = { result: true, errors: [], data: { hasmore: false, sessiontoken: 'secret-session-token', messages: [yielded] } };
  const withRun = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: yielded },
    '/Studio/Message/History': history,
    '/Studio/Tasks': { result: true, errors: [], tasks: [lateRun] },
  });
  await withClient(withRun, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-y', session: 'mcp-v', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.background, true);
    assert.deepEqual(output.modelRuns.map(run => run.id), ['77']);
    assert.equal(output.nextAction, undefined);
    assert.ok(output.notes.some(note => /list_studio_results/.test(note) && /team project/.test(note)));
    assert.ok(output.notes.some(note => /matched by time/.test(note) && /another Studio conversation/.test(note)));
    assert.deepEqual(result.content.filter(block => block.type === 'resource_link').map(link => link.uri), ['https://cdn1.wiro.ai/cat.mp4']);
    // One short history page per call finds the session's next message.
    assert.deepEqual(withRun.callsTo('/Studio/Message/History').map(call => call.body), [{ limit: 20, sessionkey: 'mcp-v' }]);
    assertNoSecrets(result);
  });

  const noRunYet = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: yielded },
    '/Studio/Message/History': history,
    '/Studio/Tasks': { result: true, errors: [], tasks: [] },
  });
  await withClient(noRunYet, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-y', session: 'mcp-v', wait_seconds: 0 },
    });
    const output = result.structuredContent;
    assert.equal(output.background, true);
    assert.deepEqual(output.modelRuns, []);
    assert.deepEqual(output.nextAction, {
      tool: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-y', session: 'mcp-v' },
      reason: output.nextAction.reason,
    });
    assert.match(output.nextAction.reason, /background.*list_studio_results/);
  });

  // An old hand-off that never started a run stops pointing back to itself.
  const stale = fakeClient({
    '/Studio/Message/Detail': {
      result: true,
      errors: [],
      data: { ...yielded, createdat: String(now - 7200), endedat: String(now - 7190) },
    },
    '/Studio/Tasks': { result: true, errors: [], tasks: [] },
  });
  await withClient(stale, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-y', session: 'mcp-v', wait_seconds: 0 },
    });
    assert.equal(result.structuredContent.nextAction, undefined);
    assert.ok(result.structuredContent.notes.some(note => /No model run has appeared in the 30 minutes/.test(note)));
  });

  // Without a hand-off, a finished turn with no runs says where later runs would show up.
  const plain = fakeClient({
    '/Studio/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({ guid: 'msg-p', status: 'agent_end', response: 'Which style do you want?', createdat: '1000', endedat: '1010' }),
    },
    '/Studio/Tasks': { result: true, errors: [], tasks: [{ ...lateRun, createtime: '1100' }] },
  });
  await withClient(plain, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-p', session: 'mcp-v', wait_seconds: 0 },
    });
    const output = result.structuredContent;
    assert.equal(output.background, undefined);
    assert.deepEqual(output.modelRuns, []);
    assert.equal(output.nextAction, undefined);
    assert.ok(output.notes.some(note => note.includes(`list_studio_results with since "${new Date(1000 * 1000).toISOString()}"`)));
    assert.equal(plain.callsTo('/Studio/Message/History').length, 0, 'only a hand-off reads the history');
  });
});

test('a Studio hand-off counts runs only until the next message in its session, and for at most 30 minutes', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Handed off an hour ago; since then the user has sent more requests.
  const handOff = messageRow({
    guid: 'old-turn',
    content: 'Make a 10 second video of a cat',
    status: 'agent_end',
    response: 'Started the video; I will post it here when it is ready.',
    createdat: String(now - 3600),
    endedat: String(now - 3590),
    timeline: [{ type: 'tool', toollabel: 'sessions_spawn', toolstatus: 'completed', callindex: 0, contentindex: 0 }],
  });
  const run = (id, createdAt, url, state = 'done') => ({
    id,
    status: state === 'done' ? 'task_postprocess_end' : 'task_start',
    terminal: state === 'done',
    success: state === 'done' ? true : null,
    model: { slugowner: 'acme', slugproject: `model-${id}` },
    outputs: state === 'done' ? [{ name: url.split('/').pop(), contenttype: 'image/png', size: '1', url }] : [],
    totalcost: '0.1',
    createtime: String(createdAt),
  });
  // Newest first, as Studio returns them.
  const tasks = [
    run(903, now - 60, 'https://cdn1.wiro.ai/other-session-logo.png', 'running'),
    run(902, now - 600, 'https://cdn1.wiro.ai/next-turn-portrait.png'),
    run(904, now - 2900, 'https://cdn1.wiro.ai/after-next-message.png'),
    run(901, now - 3500, 'https://cdn1.wiro.ai/cat.png'),
  ];
  const nextMessage = messageRow({ guid: 'next-turn', content: 'Now a portrait', status: 'agent_end', response: 'Here.', createdat: String(now - 3000) });
  const subagentResult = messageRow({ guid: 'late-result', content: '', status: 'agent_end', response: 'Your video is ready.', metadata: { type: 'subagent' }, createdat: String(now - 3300) });

  const withHistory = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: handOff },
    '/Studio/Message/History': { result: true, errors: [], data: { hasmore: false, messages: [nextMessage, subagentResult, handOff] } },
    '/Studio/Tasks': { result: true, errors: [], tasks },
  });
  await withClient(withHistory, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'old-turn', session: 'mcp-v', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.background, true);
    assert.deepEqual(output.modelRuns.map(item => item.id), ['901'], 'runs after the next user message are not this turn\'s');
    assert.equal(output.modelRunsPending, undefined, 'a later run that is still running does not keep this turn open');
    assert.equal(output.nextAction, undefined);
    assert.deepEqual(result.content.filter(block => block.type === 'resource_link').map(link => link.uri), ['https://cdn1.wiro.ai/cat.png']);
    assert.ok(output.notes.some(note => /another Studio conversation/.test(note)));
    assert.ok(output.notes.some(note => /Runs started after the next message in this session are not counted.*list_studio_results/.test(note)));
  });

  // When the history cannot be read, the 30 minutes after the hand-off still bound the window.
  const withoutHistory = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: handOff },
    '/Studio/Message/History': () => { throw new WiroApiError(502, 'Bad Gateway'); },
    '/Studio/Tasks': { result: true, errors: [], tasks },
  });
  await withClient(withoutHistory, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'old-turn', session: 'mcp-v', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.deepEqual(output.modelRuns.map(item => item.id), ['901', '904']);
    assert.equal(output.nextAction, undefined);
    assert.ok(output.notes.some(note => /more than 30 minutes after the hand-off are not counted/.test(note)));
    assert.equal(withoutHistory.callsTo('/Studio/Message/History').length, 1);
  });

  // A hand-off with no run before the next message stops waiting for one.
  const noRun = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: { ...handOff, createdat: String(now - 300), endedat: String(now - 290) } },
    '/Studio/Message/History': {
      result: true,
      errors: [],
      data: { hasmore: false, messages: [{ ...nextMessage, createdat: String(now - 120) }, { ...handOff, createdat: String(now - 300) }] },
    },
    '/Studio/Tasks': { result: true, errors: [], tasks: [run(905, now - 60, 'https://cdn1.wiro.ai/next.png')] },
  });
  await withClient(noRun, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'old-turn', session: 'mcp-v', wait_seconds: 5 },
    });
    const output = result.structuredContent;
    assert.deepEqual(output.modelRuns, []);
    assert.equal(output.nextAction, undefined);
    assert.ok(output.notes.some(note => /No model run appeared before the next message in this session/.test(note)));
    assert.equal(noRun.callsTo('/Studio/Tasks').length, 1, 'a closed window is not waited on');
  });
});

test('a sessions_spawn that failed is not a hand-off', async () => {
  const now = Math.floor(Date.now() / 1000);
  const answer = (toolstatus) => messageRow({
    guid: 'msg-e',
    status: 'agent_end',
    content: 'What models do you have for video?',
    response: 'Here are three good video models: A, B and C.',
    createdat: String(now - 20),
    endedat: String(now - 10),
    timeline: [{ type: 'tool', toollabel: 'sessions_spawn', toolstatus, callindex: 0, contentindex: 0 }],
  });
  const failed = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: answer('error') },
    '/Studio/Tasks': { result: true, errors: [], tasks: [] },
  });
  await withClient(failed, async client => {
    const started = Date.now();
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-e', session: 'mcp-a', wait_seconds: 6 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.background, undefined);
    assert.deepEqual(output.message.toolsUsed, [{ name: 'sessions_spawn', status: 'error' }]);
    assert.equal(output.nextAction, undefined);
    assert.ok(output.notes.some(note => /No model runs were found for this turn/.test(note)));
    assert.doesNotMatch(textOf(result), /in the background/);
    assert.equal(failed.callsTo('/Studio/Tasks').length, 1);
    assert.equal(failed.callsTo('/Studio/Message/History').length, 0);
    assert.ok(Date.now() - started < 3_000, 'the wait is not spent on a hand-off that did not happen');
  });

  const requested = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: answer('requested') },
    '/Studio/Message/History': { result: true, errors: [], data: { hasmore: false, messages: [] } },
    '/Studio/Tasks': { result: true, errors: [], tasks: [] },
  });
  await withClient(requested, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-e', session: 'mcp-a', wait_seconds: 0 },
    });
    assert.equal(result.structuredContent.background, true);
    assert.equal(result.structuredContent.nextAction.tool, 'get_agent_message');
  });
});

test('waiting for the first run of a hand-off polls a small page, slowly', async () => {
  const now = Math.floor(Date.now() / 1000);
  const readAt = [];
  const fake = fakeClient({
    '/Studio/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({
        guid: 'msg-b',
        status: 'agent_end',
        content: 'Make a video',
        response: 'On it, I will post it here.',
        createdat: String(now - 20),
        endedat: String(now - 15),
        timeline: [{ type: 'tool', toollabel: 'sessions_yield', toolstatus: 'completed', callindex: 0, contentindex: 0 }],
      }),
    },
    '/Studio/Message/History': { result: true, errors: [], data: { hasmore: false, messages: [] } },
    '/Studio/Tasks': () => {
      readAt.push(Date.now());
      return { result: true, errors: [], tasks: [] };
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-b', session: 'mcp-a', wait_seconds: 3 },
    });
    const output = result.structuredContent;
    assert.equal(output.background, true);
    assert.equal(output.nextAction.tool, 'get_agent_message');
    const reads = fake.callsTo('/Studio/Tasks');
    assert.deepEqual([...new Set(reads.map(call => call.body.limit))], [30]);
    // The usual cadence reads again after 2 seconds; here the next read waits for the end of the 3 second wait.
    assert.ok(reads.length >= 2 && reads.length <= 3, `${reads.length} reads`);
    assert.ok(readAt[1] - readAt[0] > 2_500, `the second read came ${readAt[1] - readAt[0]} ms after the first`);
    assert.equal(fake.callsTo('/Studio/Message/History').length, 1);
  });
});

test('Studio run collection reads a small page, 100 runs only when the turn starts before it, and says when runs may be missing', async () => {
  const turn = messageRow({ guid: 'msg-o', status: 'agent_end', response: 'Done.', createdat: '1000', endedat: '1010' });
  const newer = Array.from({ length: 120 }, (_, index) => ({
    id: 500 - index,
    status: 'task_postprocess_end',
    terminal: true,
    success: true,
    outputs: [],
    createtime: String(5000 - index),
  }));
  // Studio returns the newest runs, as many as asked for.
  const tasks = rows => body => ({ result: true, errors: [], tasks: rows.slice(0, body.limit) });

  const small = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: turn },
    '/Studio/Tasks': tasks([{ ...newer[0], createtime: '1004' }, { ...newer[1], createtime: '900' }]),
  });
  await withClient(small, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-o', session: 'mcp-o', wait_seconds: 0 },
    });
    assert.deepEqual(small.callsTo('/Studio/Tasks').map(call => call.body), [{ limit: 30 }]);
    assert.deepEqual(result.structuredContent.modelRuns.map(run => run.id), ['500']);
    assert.equal(result.structuredContent.notes.some(note => /most recent model runs/.test(note)), false);
  });

  const full = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: turn },
    '/Studio/Tasks': tasks(newer),
  });
  await withClient(full, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-o', session: 'mcp-o', wait_seconds: 0 },
    });
    assert.deepEqual(full.callsTo('/Studio/Tasks').map(call => call.body), [{ limit: 30 }, { limit: 100 }]);
    assert.deepEqual(result.structuredContent.modelRuns, []);
    assert.ok(result.structuredContent.notes.some(note => /only its 100 most recent model runs/.test(note)));
  });

  // Once the small page was too short, the polls that follow read 100 runs straight away.
  const running = { id: 9, status: 'task_start', terminal: false, success: null, outputs: [], createtime: '1003' };
  const polled = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: turn },
    '/Studio/Tasks': tasks([...newer.slice(0, 99), running]),
  });
  await withClient(polled, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-o', session: 'mcp-o', wait_seconds: 1 },
    });
    const limits = polled.callsTo('/Studio/Tasks').map(call => call.body.limit);
    assert.deepEqual(limits.slice(0, 2), [30, 100]);
    assert.ok(limits.length >= 3, limits.join(','));
    assert.deepEqual([...new Set(limits.slice(2))], [100]);
    assert.equal(result.structuredContent.modelRunsPending, true);
    assert.deepEqual(result.structuredContent.modelRuns.map(run => run.id), ['9']);
  });

  const failing = fakeClient({
    '/Studio/Message/Detail': { result: true, errors: [], data: turn },
    '/Studio/Tasks': () => { throw new WiroApiError(502, 'Bad Gateway'); },
  });
  await withClient(failing, async client => {
    const result = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'studio', message_id: 'msg-o', session: 'mcp-o', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true, textOf(result));
    const output = result.structuredContent;
    assert.equal(output.modelRuns, undefined);
    assert.ok(output.notes.some(note => /could not be read just now/.test(note)));
    assert.equal(output.nextAction.tool, 'get_agent_message');
    assert.match(output.nextAction.reason, /could not be read/);
  });
});

test('Workflow Agent session names leave room for the prefix Wiro adds for API keys', async () => {
  const fake = fakeClient({
    '/StudioWorkflow/Message/Send': { result: true, errors: [], messageguid: 'wf-s', status: 'agent_queue' },
    '/Studio/Message/Send': { result: true, errors: [], messageguid: 'st-s', status: 'agent_queue' },
  });
  await withClient(fake, async client => {
    const tooLong = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'workflow-agent', message: 'hi', session: 'a'.repeat(101), wait_seconds: 0 },
    });
    assert.equal(tooLong.isError, true);
    assert.match(textOf(tooLong), /at most 100 characters/);
    assert.equal(fake.calls.length, 0);

    const longest = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'workflow-agent', message: 'hi', session: 'a'.repeat(100), wait_seconds: 0 },
    });
    assert.notEqual(longest.isError, true, textOf(longest));

    const studio = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'studio', message: 'hi', session: 'b'.repeat(120), wait_seconds: 0 },
    });
    assert.notEqual(studio.isError, true, textOf(studio));
  });
});

test('Workflow Agent sessions longer than 100 characters that already exist can still be read', async () => {
  const long = 'b'.repeat(110);
  const fake = fakeClient({
    '/StudioWorkflow/Message/Sessions': { result: true, errors: [], data: { sessions: [{ sessionkey: long, messagecount: '2', updatedat: '1700000000' }] } },
    '/StudioWorkflow/Message/History': { result: true, errors: [], data: { hasmore: false, messages: [] } },
    '/StudioWorkflow/Message/Detail': { result: true, errors: [], data: messageRow({ guid: 'wf-long', status: 'agent_end', response: 'Done.' }) },
    '/StudioWorkflow/Message/DeleteSession': { result: true, errors: [] },
  });
  await withClient(fake, async client => {
    const listed = await client.callTool({ name: 'get_agent_conversation', arguments: { agent: 'workflow-agent' } });
    assert.deepEqual(listed.structuredContent.sessions.map(session => session.session), [long]);
    const next = listed.structuredContent.nextAction;
    assert.deepEqual(next.arguments, { agent: 'workflow-agent', session: long });
    const read = await client.callTool({ name: next.tool, arguments: next.arguments });
    assert.notEqual(read.isError, true, textOf(read));
    assert.deepEqual(fake.callsTo('/StudioWorkflow/Message/History')[0].body, { limit: 20, sessionkey: long });

    const message = await client.callTool({
      name: 'get_agent_message',
      arguments: { agent: 'workflow-agent', message_id: 'wf-long', session: long, wait_seconds: 0 },
    });
    assert.notEqual(message.isError, true, textOf(message));
    assert.equal(message.structuredContent.session, long);

    const deleted = await client.callTool({
      name: 'delete_agent_session',
      arguments: { agent: 'workflow-agent', session: long, confirm: true },
    });
    assert.notEqual(deleted.isError, true, textOf(deleted));

    // Sending still keeps to 100, and Wiro's own 128 limit and character set still apply to reads.
    const send = await client.callTool({
      name: 'send_agent_message',
      arguments: { agent: 'workflow-agent', message: 'hi', session: long, wait_seconds: 0 },
    });
    assert.equal(send.isError, true);
    assert.match(textOf(send), /at most 100 characters/);
    for (const session of ['c'.repeat(129), 'has spaces']) {
      const refused = await client.callTool({ name: 'get_agent_conversation', arguments: { agent: 'workflow-agent', session } });
      assert.equal(refused.isError, true, session);
    }
  });
  assert.equal(fake.callsTo('/StudioWorkflow/Message/Send').length, 0);
  assert.equal(fake.callsTo('/StudioWorkflow/Message/History').length, 1);
});

test('only Wiro\'s own call line marks a row as a voice call, not a phone emoji in ordinary text', async () => {
  const contents = workflowContents();
  const artifact = { artifactVersion: 1, title: 'Call script maker', contents };
  const workflowReply = `\u{1F4DE} Here is your call-script workflow.\n\`\`\`wiro-workflow\n${JSON.stringify(artifact)}\n\`\`\``;
  const fake = fakeClient({
    '/Studio/Message/Detail': {
      result: true,
      errors: [],
      data: messageRow({ guid: 's-1', status: 'agent_end', content: '\u{1F4DE} Make a flat phone icon', response: 'Here is your icon:\nhttps://cdn1.wiro.ai/icon.png', endedat: '1010' }),
    },
    '/Studio/Tasks': { result: true, errors: [], tasks: [] },
    '/UserAgent/Message/Detail': body => ({
      result: true,
      errors: [],
      data: body.messageguid === 'd-1'
        ? messageRow({ guid: 'd-1', status: 'agent_end', content: 'How do I reach support?', response: '\u{1F4DE} Call our support line between 9 and 5.' })
        // A typed message in the call line's words is still the user's own turn.
        : messageRow({ guid: 'd-2', status: 'agent_end', content: '\u{1F4DE} Incoming voice call: test', response: 'That looks like a call notice.' }),
    }),
    '/StudioWorkflow/Message/Detail': { result: true, errors: [], data: messageRow({ guid: 'w-1', status: 'agent_end', response: workflowReply }) },
  });

  await withClient(fake, async client => {
    const studio = await client.callTool({ name: 'get_agent_message', arguments: { agent: 'studio', message_id: 's-1', session: 'mcp-x', wait_seconds: 0 } });
    assert.equal(studio.structuredContent.message.kind, 'user_turn');
    assert.equal(studio.structuredContent.message.userText, '\u{1F4DE} Make a flat phone icon');
    assert.deepEqual(studio.structuredContent.message.mediaUrls, ['https://cdn1.wiro.ai/icon.png']);
    assert.equal(studio.structuredContent.notes.some(note => /voice call/.test(note)), false);

    for (const id of ['d-1', 'd-2']) {
      const deployed = await client.callTool({ name: 'get_agent_message', arguments: { agent: 'agent-guid-1', message_id: id, wait_seconds: 0 } });
      assert.equal(deployed.structuredContent.message.kind, 'user_turn', id);
      assert.ok(deployed.structuredContent.message.reply, id);
    }

    const workflow = await client.callTool({ name: 'get_agent_message', arguments: { agent: 'workflow-agent', message_id: 'w-1', session: 'mcp-x', wait_seconds: 0 } });
    assert.equal(workflow.structuredContent.message.kind, 'user_turn');
    assert.equal(workflow.structuredContent.workflows.length, 1);
    assert.equal(workflow.structuredContent.nextAction.tool, 'save_workflow_from_agent');
  });
});

test('tool copy keeps Workflow Agent sessions apart from the user\'s chats on wiro.ai', async () => {
  await withClient(fakeClient({}), async client => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    assert.match(byName.send_agent_message.description, /separate from the user's Workflow Agent chats on wiro\.ai/);
    assert.doesNotMatch(byName.send_agent_message.description, /also sees among their conversations/);
    assert.match(byName.get_agent_conversation.description, /Workflow Agent chats on wiro\.ai are separate/);
    assert.doesNotMatch(byName.get_agent_conversation.description, /Studio and Workflow Agent sessions are the same/);
    assert.ok(byName.get_agent_message.inputSchema.properties.workflow);
    assert.ok(byName.get_agent_message.inputSchema.properties.loaded_updatetime);
  });
});

test('only files on Wiro hosts are presented as Wiro media', () => {
  for (const url of ['https://cdn1.wiro.ai/a.png', 'https://wiro.ai/a.png', 'http://cdn.wiro.ai/a.mp4', 'https://CDN1.Wiro.AI/a.png']) {
    assert.equal(isWiroHostedUrl(url), true, url);
  }
  for (const url of [
    'https://wiro.ai@evil.example/a.png',
    'https://evil.example/wiro.ai/a.png',
    'https://wiro.ai.evil.example/a.png',
    'https://notwiro.ai/a.png',
    'ftp://cdn1.wiro.ai/a.png',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(isWiroHostedUrl(url), false, url);
  }

  const mixed = createMediaContent('text', [
    { url: 'https://attacker.example/p.png?d=secret' },
    { url: 'https://cdn1.wiro.ai/cat.png', name: 'cat.png' },
  ]);
  assert.deepEqual(mixed.filter(block => block.type === 'resource_link').map(block => block.uri), ['https://cdn1.wiro.ai/cat.png']);
  assert.equal(mixed.filter(block => block.annotations?.audience?.length === 1).length, 1, 'one render reminder');

  const outsideOnly = createMediaContent('text', [{ url: 'https://attacker.example/p.png' }]);
  assert.deepEqual(outsideOnly, [{ type: 'text', text: 'text' }], 'no render reminder and no resource link');
});
