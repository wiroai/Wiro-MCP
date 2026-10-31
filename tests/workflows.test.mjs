import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WiroApiError } from '../dist/client.js';
import { createMcpServer } from '../dist/server.js';

async function withClient(fakeWiroClient, callback, options) {
  const server = createMcpServer({ authType: 'apikey-only', ...fakeWiroClient }, options);
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

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      const route = routes[path];
      if (!route) throw new Error(`Unexpected call to ${path}`);
      return typeof route === 'function' ? route(body, calls) : route;
    },
  };
}

function graph() {
  return {
    version: '1',
    nodes: {
      'node-a1': {
        type: 'run',
        id: 'node-a1',
        tool: 'owner/image-model',
        depends: ['input'],
        input: { prompt: '$input.prompt', apiKey: '[REDACTED]' },
        metadata: { position: { x: 400, y: 0 } },
      },
      output: {
        type: 'display',
        id: 'output',
        depends: ['node-a1'],
        input: {},
        fields: { image: '$node-a1.outputs' },
        metadata: { position: { x: 800, y: 0 } },
      },
    },
    output: { image: '$node-a1.outputs' },
    schema: {
      input: {
        prompt: {
          name: 'prompt', label: 'Prompt', type: 'string', description: 'A text field',
          required: false, defaultValue: 'a fox', examples: [], ui: { field: 'textarea' },
          modelId: null, sourceParamType: null,
        },
      },
      output: {},
    },
    metadata: { input: { position: { x: 0, y: 0 } } },
  };
}

function storedRow(overrides = {}) {
  const contents = graph();
  contents.nodes['node-a1'].input.apiKey = 'real-secret';
  contents.metadata.input.values = { prompt: 'saved prompt', removed: 'x' };
  return {
    id: 7,
    useruuid: 'owner-uuid',
    teamguid: null,
    creatoruuid: 'owner-uuid',
    slug: 'fox-maker',
    slugid: 'Ab3xZ',
    title: 'Fox maker',
    description: 'Makes foxes',
    contents,
    ispublic: 0,
    status: null,
    tags: ['image'],
    isprotected: 0,
    clonedfromid: null,
    updatetime: '1761700000',
    createtime: '1761600000',
    rejectreason: null,
    ...overrides,
  };
}

test('list_workflows sends the scope, string filters and parses a string total', async () => {
  const fake = fakeClient({
    '/Workflow/List': {
      result: true,
      errors: [],
      total: '3',
      workflow: [
        { ...storedRow(), contents: undefined, stepcount: 1, toolcount: 1 },
        { ...storedRow({ slug: 'second', slugid: 'Zz9Yy', title: 'Second' }), contents: undefined },
      ],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'list_workflows',
      arguments: { scope: 'mine', visibility: 'private', limit: 2 },
    });
    assert.notEqual(result.isError, true);
    assert.equal(fake.calls[0].body.scope, 'my');
    assert.equal(fake.calls[0].body.ispublic, '0');
    assert.equal(result.structuredContent.total, 3);
    assert.equal(result.structuredContent.nextStart, 2);
    assert.equal(result.structuredContent.workflows[0].fullSlug, 'fox-maker-Ab3xZ');
    assert.equal(result.structuredContent.workflows[0].state, 'private');
    assert.equal(JSON.stringify(result.structuredContent).includes('owner-uuid'), false);
  });
});

test('list_workflows says whose view a protected graph is hidden from', async () => {
  const rows = [
    { ...storedRow({ slug: 'mine-protected', slugid: 'Aa1Aa', isprotected: 1 }), contents: undefined },
    { ...storedRow({ slug: 'protected-clone', slugid: 'Bb2Bb', isprotected: 1, clonedfromid: 3 }), contents: undefined },
  ];
  const fake = fakeClient({ '/Workflow/List': { result: true, errors: [], total: 2, workflow: rows } });
  await withClient(fake, async client => {
    const mine = await client.callTool({ name: 'list_workflows', arguments: { scope: 'mine' } });
    const text = mine.content[0].text;
    assert.match(text, /mine-protected-Aa1Aa` \(private, graph hidden from others\)/);
    assert.match(text, /protected-clone-Bb2Bb` \(private, graph hidden\)/);
    const gallery = await client.callTool({ name: 'list_workflows', arguments: { scope: 'public' } });
    assert.match(gallery.content[0].text, /mine-protected-Aa1Aa` \(graph hidden\)/);
  });
});

test('get_workflow accepts a page URL and hides identities', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'get_workflow',
      arguments: { slug: 'https://wiro.ai/workflows/fox-maker-Ab3xZ?run=abc' },
    });
    assert.notEqual(result.isError, true);
    assert.equal(fake.calls[0].body.slug, 'fox-maker-Ab3xZ');
    const workflow = result.structuredContent.workflow;
    assert.equal(workflow.insider, true);
    assert.equal(workflow.canEditGraph, true);
    assert.equal(workflow.inputs[0].key, 'prompt');
    assert.equal(workflow.inputs[0].savedValue, 'saved prompt');
    assert.equal(JSON.stringify(result.structuredContent).includes('owner-uuid'), false);
  });
});

test('an HTTP refusal shows Wiro\'s own sentence instead of the raw answer', async () => {
  const sentence = 'The person who created this API key is no longer in its team. Ask a team admin for a new key.';
  const fake = fakeClient({
    '/Workflow/List': () => { throw new WiroApiError(401, JSON.stringify({ result: false, errors: [{ code: 0, message: sentence }] })); },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'list_workflows', arguments: { scope: 'mine' } });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `## Error\n\nWiro API error 401: ${sentence}`);
  });
});

test('get_workflow refuses a slug without its id', async () => {
  await withClient(fakeClient({}), async client => {
    const result = await client.callTool({ name: 'get_workflow', arguments: { slug: 'fox-makers' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /full workflow slug/);
  });
});

test('create_workflow prepares the graph on Wiro, then saves the prepared graph', async () => {
  const prepared = graph();
  prepared.nodes['node-a1'].input = { prompt: '$input.prompt', steps: '30' };
  const fake = fakeClient({
    '/Workflow/Prepare': { result: true, errors: [], contents: prepared, warnings: [] },
    '/Workflow/Add': body => ({
      result: true,
      errors: [],
      workflow: [{ slug: body.slug, slugid: 'Qw3rT', title: 'Fox maker-1', updatetime: '1761700100' }],
    }),
  });
  await withClient(fake, async client => {
    const contents = graph();
    delete contents.nodes['node-a1'].input.apiKey;
    const result = await client.callTool({
      name: 'create_workflow',
      arguments: { title: 'Fox maker', contents, tags: ['image'] },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls.map(call => call.path), ['/Workflow/Prepare', '/Workflow/Add']);
    assert.equal(fake.calls[0].body.mode, 'create');
    assert.equal(fake.calls[1].body.slug, 'fox-maker');
    assert.deepEqual(JSON.parse(fake.calls[1].body.contents), prepared);
    assert.equal(fake.calls[1].body.tags, '["image"]');
    assert.equal(result.structuredContent.fullSlug, 'fox-maker-Qw3rT');
    assert.equal(result.structuredContent.renamed, true);
    assert.equal(result.structuredContent.nextAction.tool, 'run_workflow');
    assert.match(result.structuredContent.nextAction.reason, /uses its saved value or default/);
  });
});

test('create_workflow returns every preparation problem at once and saves nothing', async () => {
  const fake = fakeClient({
    '/Workflow/Prepare': {
      result: false,
      errors: [{ code: 0, message: 'Unknown input' }],
      issues: [
        { code: 'unknown-input', message: 'Unknown input "promt"', nodeId: 'node-a1', input: 'promt' },
        { code: 'missing-required', message: 'Required input "image" is missing', nodeId: 'node-b2' },
      ],
    },
  });
  await withClient(fake, async client => {
    const contents = graph();
    delete contents.nodes['node-a1'].input.apiKey;
    const result = await client.callTool({
      name: 'create_workflow',
      arguments: { title: 'Fox maker', contents },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /promt/);
    assert.match(result.content[0].text, /node-b2/);
    assert.deepEqual(fake.calls.map(call => call.path), ['/Workflow/Prepare']);
  });
});

test('create_workflow refuses reserved tags before calling Wiro', async () => {
  const fake = fakeClient({});
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'create_workflow',
      arguments: { title: 'Fox maker', contents: graph(), tags: ['wiro-featured'] },
    });
    assert.equal(result.isError, true);
    assert.equal(fake.calls.length, 0);
  });
});

test('update_workflow previews a graph replacement, then restores hidden values and saved inputs on confirm', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Update': { result: true, errors: [], workflow: [{ ...storedRow(), updatetime: '1761700200' }] },
  });
  const edited = graph();
  edited.schema.input.prompt.label = 'Describe the fox';
  await withClient(fake, async client => {
    const preview = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000' },
    });
    assert.notEqual(preview.isError, true);
    assert.equal(preview.structuredContent.preview, true);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Update'), false);
    assert.equal(preview.structuredContent.nextAction.arguments.confirm, true);
    assert.equal(preview.structuredContent.nextAction.arguments.loaded_updatetime, '1761700000');

    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.notEqual(result.isError, true);
    const prepare = fake.calls.find(call => call.path === '/Workflow/Prepare');
    assert.equal(prepare.body.mode, 'apply');
    assert.deepEqual(prepare.body.anchorNodeIds, ['input', 'node-a1']);
    assert.equal(prepare.body.contents.nodes['node-a1'].input.apiKey, 'real-secret');
    assert.deepEqual(prepare.body.contents.metadata.input.values, { prompt: 'saved prompt' });
    const update = fake.calls.find(call => call.path === '/Workflow/Update');
    assert.equal(update.body.loadedUpdatetime, '1761700000');
    assert.equal(update.body.force, undefined);
    assert.equal(result.structuredContent.updatetime, '1761700200');
    assert.equal(result.structuredContent.contentsChanged, true);
  });
});

test('hidden Start defaults and nested secrets come back from the saved workflow', async () => {
  const stored = storedRow();
  stored.contents.schema.input.api_key = {
    name: 'api_key', label: 'API key', type: 'string', description: 'A text field', required: false,
    defaultValue: 'sk-REAL-DEFAULT', examples: [], ui: {}, modelId: null, sourceParamType: null,
  };
  stored.contents.nodes['node-a1'].input.config = { headers: { authorization: 'Bearer REAL-NESTED' } };
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [stored] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Update': { result: true, errors: [], workflow: [stored] },
  });
  const edited = graph();
  edited.schema.input.api_key = { ...stored.contents.schema.input.api_key, defaultValue: '[REDACTED]' };
  edited.nodes['node-a1'].input.config = { headers: { authorization: '[REDACTED]' } };
  edited.nodes['node-a1'].input.prompt = 'a new prompt';
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.notEqual(result.isError, true);
    const prepare = fake.calls.find(call => call.path === '/Workflow/Prepare');
    assert.equal(prepare.body.contents.schema.input.api_key.defaultValue, 'sk-REAL-DEFAULT');
    assert.equal(prepare.body.contents.nodes['node-a1'].input.config.headers.authorization, 'Bearer REAL-NESTED');
    assert.equal(JSON.stringify(result).includes('REAL'), false);
  });
});

test('a hidden secret is not moved into a step that now uses another model', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
  });
  const edited = graph();
  edited.nodes['node-a1'].tool = 'other-vendor/image-model';
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /does not keep the same model/);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Prepare'), false);
  });
});

test('a hidden value in a step the saved workflow does not have is refused as a new step', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
  });
  const edited = graph();
  edited.nodes['node-b2'] = {
    type: 'run', id: 'node-b2', tool: 'owner/image-model', depends: ['input'],
    input: { prompt: '$input.prompt', apiKey: '[REDACTED]' }, metadata: { position: { x: 400, y: 200 } },
  };
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /node-b2 is a new step, so the saved workflow has no value to restore there/);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Prepare'), false);
  });
});

test('create_workflow refuses a hidden placeholder among the saved Start values', async () => {
  const fake = fakeClient({});
  const contents = graph();
  delete contents.nodes['node-a1'].input.apiKey;
  contents.metadata.input.values = { prompt: '[hidden]' };
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'create_workflow', arguments: { title: 'Fox maker', contents } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /saved value of Start field prompt/);
    assert.equal(fake.calls.length, 0);
  });
});

test('update_workflow restores a hidden saved Start value, but never into a new place', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Update': { result: true, errors: [], workflow: [{ ...storedRow(), updatetime: '1761700200' }] },
  });
  const edited = graph();
  edited.schema.input.prompt.label = 'Describe the fox';
  edited.metadata.input.values = { prompt: '[REDACTED]' };
  const moved = graph();
  moved.metadata.input.values = { prompt: '[REDACTED]' };
  moved.nodes['node-b2'] = {
    type: 'run', id: 'node-b2', tool: 'other-vendor/text-model', depends: ['input'],
    input: { text: '$input.prompt' }, metadata: { position: { x: 400, y: 200 } },
  };
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.notEqual(result.isError, true);
    const prepare = fake.calls.find(call => call.path === '/Workflow/Prepare');
    assert.deepEqual(prepare.body.contents.metadata.input.values, { prompt: 'saved prompt' });

    const refused = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: moved, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Saved value of Start field prompt is hidden and the new steps use it in a different place/);
  });
});

test('update_workflow does not prepare the saved graph sent back unchanged', async () => {
  const stored = storedRow();
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [stored] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: storedRow().contents, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.unchanged, true);
    assert.deepEqual(fake.calls.map(call => call.path), ['/Workflow/Detail']);
  });
});

test('save results list the model defaults Prepare filled, samples first', async () => {
  const prepared = graph();
  prepared.nodes['node-a1'].input = {
    prompt: '$input.prompt',
    apiKey: 'k',
    inputImage: ['https://cdn.wiro.ai/uploads/sampleinputs/koala.png'],
    aspectRatio: '1:1',
  };
  prepared.nodes['node-b2'] = {
    type: 'run', id: 'node-b2', tool: 'owner/edit-model', depends: ['input'],
    input: { prompt: 'Make the shirt with the logo pattern on the koala.' }, metadata: { position: { x: 400, y: 200 } },
  };
  prepared.nodes['node-c3'] = {
    type: 'run', id: 'node-c3', tool: 'workflow-utilities/merge-text', depends: ['node-b2'],
    input: { texts: ['a'], skipEmpty: 'true' }, metadata: { position: { x: 800, y: 200 } },
  };
  const fake = fakeClient({
    '/Workflow/Prepare': { result: true, errors: [], contents: prepared, warnings: [] },
    '/Workflow/Add': body => ({ result: true, errors: [], workflow: [{ slug: body.slug, slugid: 'Qw3rT', title: 'Fox maker' }] }),
  });
  const contents = graph();
  contents.nodes['node-a1'].input = { prompt: '$input.prompt', apiKey: 'k' };
  contents.nodes['node-b2'] = { ...prepared.nodes['node-b2'], input: {} };
  contents.nodes['node-c3'] = { ...prepared.nodes['node-c3'], input: { texts: ['a'] } };
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'create_workflow', arguments: { title: 'Fox maker', contents } });
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /### Notes/);
    assert.match(text, /- `node-a1`: Wiro filled `inputImage` \(sample files\) from the model's page, and every run uses it as is\..*Also filled with the model's defaults: `aspectRatio` "1:1"\./);
    assert.match(text, /- `node-b2`: Wiro filled `prompt` \(the sample text "Make the shirt with the logo pattern on the koala\."\)/);
    assert.doesNotMatch(text, /node-c3/);
    assert.deepEqual(result.structuredContent.warnings.map(warning => warning.code), ['sample-defaults-filled', 'sample-defaults-filled']);
  });
});

test('preparation problems name End and Start fields, and the size limit gets its own answer', async () => {
  const fake = fakeClient({
    '/Workflow/Prepare': body => (body.contents.version === '1'
      ? {
        result: false,
        errors: [{ code: 0, message: 'x' }],
        issues: [
          { code: 'unknown-reference', message: 'Reference "$node-gone.outputs" targets an unknown step.', nodeId: 'output', input: 'broken' },
          { code: 'invalid-schema-field', message: 'Workflow input "text" must be an object.', nodeId: 'input', input: 'text' },
        ],
      }
      : {
        result: false,
        errors: [{ code: 0, message: 'too large' }],
        issues: [{ code: 'prepared-contents-too-large', message: 'Workflow JSON exceeds the 40960-byte limit after catalog validation.' }],
      }),
  });
  await withClient(fake, async client => {
    const contents = graph();
    delete contents.nodes['node-a1'].input.apiKey;
    const issues = await client.callTool({ name: 'create_workflow', arguments: { title: 'Fox maker', contents } });
    assert.equal(issues.isError, true);
    assert.match(issues.content[0].text, /- End field `broken`: Reference/);
    assert.match(issues.content[0].text, /- Start field `text`: Workflow input/);

    const large = await client.callTool({ name: 'create_workflow', arguments: { title: 'Fox maker', contents: { ...contents, version: '1.0' } } });
    assert.equal(large.isError, true);
    assert.match(large.content[0].text, /after catalog validation\. It grew past the limit when Wiro filled each model step's left-out inputs/);
    assert.match(large.content[0].text, /can be at most 40 KB of JSON/);
    assert.doesNotMatch(large.content[0].text, /get_model_schema/);
  });
});

test('update_workflow puts the new update time on its own line', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Update': { result: true, errors: [], workflow: [{ ...storedRow({ title: 'New title' }), updatetime: '1761700200' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'update_workflow', arguments: { slug: 'fox-maker-Ab3xZ', title: 'New title' } });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /- Title: "Fox maker" to "New title"\n\n\*\*updatetime:\*\* `1761700200`/);
  });
});

test('get_workflow explains a protected copy and offers editing only to insiders', async () => {
  const copy = storedRow({ isprotected: 1, clonedfromid: 3, estimatedcost: { type: 'fixed', value: 0.04 } });
  copy.contents = { version: '1', nodes: {}, schema: graph().schema, metadata: { input: { position: { x: 0, y: 0 } } } };
  const outsider = storedRow();
  delete outsider.rejectreason;
  const fake = fakeClient({
    '/Workflow/Detail': body => ({ result: true, errors: [], workflow: [body.slug === 'fox-maker-Ab3xZ' ? copy : outsider] }),
  });
  await withClient(fake, async client => {
    const own = await client.callTool({ name: 'get_workflow', arguments: { slug: 'fox-maker-Ab3xZ' } });
    assert.match(own.content[0].text, /\*\*Steps:\*\* hidden\. This is a copy of a protected workflow/);
    assert.doesNotMatch(own.content[0].text, /hidden by the creator/);
    assert.equal(own.structuredContent.workflow.stepCount, undefined);

    const other = await client.callTool({ name: 'get_workflow', arguments: { slug: 'fox-maker-Zz9Yy' } });
    assert.doesNotMatch(other.content[0].text, /loaded_updatetime/);
  });
});

test('list_workflows counts only gallery runs and leaves out an empty count', async () => {
  const fake = fakeClient({
    '/Workflow/List': {
      result: true,
      errors: [],
      total: 2,
      workflow: [
        { ...storedRow({ slug: 'private-one', slugid: 'Aa1Aa' }), contents: undefined, runcount: 0 },
        { ...storedRow({ slug: 'gallery-one', slugid: 'Bb2Bb' }), contents: undefined, runcount: '5' },
      ],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'list_workflows', arguments: { scope: 'mine' } });
    assert.match(result.content[0].text, /private-one-Aa1Aa` \(private\)/);
    assert.match(result.content[0].text, /gallery-one-Bb2Bb` \(private, 5 gallery runs\)/);
    assert.equal(result.structuredContent.workflows[0].runCount, undefined);
  });
});

test('clone_workflow says which workflows can be cloned when Wiro refuses', async () => {
  const fake = fakeClient({
    '/Workflow/Clone': { result: false, errors: [{ code: 0, message: 'This workflow cannot be cloned' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'clone_workflow', arguments: { slug: 'fox-maker-Ab3xZ' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /This workflow cannot be cloned/);
    assert.match(result.content[0].text, /Only a published workflow from the public gallery that is not itself a copy can be cloned/);
  });
});

// A stored workflow whose secret Start field feeds node-a1 directly and node-a2
// through a merge-text step, with its real value saved and its default empty.
function tokenRow() {
  const row = storedRow();
  row.contents.schema.input.api_token = {
    name: 'API token', label: 'API token', type: 'string', description: 'A text field', required: false,
    defaultValue: '', examples: [], ui: { field: 'textarea' }, modelId: null, sourceParamType: null,
  };
  row.contents.nodes['node-a1'].input.apiKey = '$input.api_token';
  row.contents.nodes['node-fmt'] = {
    type: 'run', id: 'node-fmt', tool: 'workflow-utilities/merge-text', depends: ['input'],
    input: { texts: ['Bearer', '$input.api_token'] }, metadata: { position: { x: 400, y: 200 } },
  };
  row.contents.nodes['node-a2'] = {
    type: 'run', id: 'node-a2', tool: 'owner/image-model', depends: ['node-fmt'],
    input: { prompt: 'a fox', header: '$node-fmt.result' }, metadata: { position: { x: 800, y: 200 } },
  };
  row.contents.metadata.input.values = { prompt: 'saved prompt', api_token: 'sk-REAL-SAVED' };
  return row;
}

// What a Workflow Agent proposal looks like: no saved values.
function proposalFrom(row) {
  const contents = JSON.parse(JSON.stringify(row.contents));
  delete contents.metadata.input.values;
  return contents;
}

test('a saved secret is not carried into a proposal that sends it to another model', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [tokenRow()] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Update': { result: true, errors: [], workflow: [{ ...tokenRow(), updatetime: '1761700200' }] },
  });
  const direct = proposalFrom(tokenRow());
  direct.nodes['node-b1'] = {
    type: 'run', id: 'node-b1', tool: 'other-vendor/collector', depends: ['input'],
    input: { token: '$input.api_token' }, metadata: { position: { x: 400, y: 400 } },
  };
  const throughUtility = proposalFrom(tokenRow());
  throughUtility.nodes['node-b1'] = {
    type: 'run', id: 'node-b1', tool: 'other-vendor/collector', depends: ['node-fmt'],
    input: { prompt: '$node-fmt.result' }, metadata: { position: { x: 400, y: 400 } },
  };
  const intoResult = proposalFrom(tokenRow());
  intoResult.nodes.output.fields.debug = '$node-fmt.result';
  intoResult.nodes.output.depends = [...intoResult.nodes.output.depends, 'node-fmt'];
  intoResult.output = { ...intoResult.nodes.output.fields };
  const relabeled = proposalFrom(tokenRow());
  relabeled.schema.input.api_token.label = 'Service token';
  relabeled.nodes['node-b1'] = {
    type: 'run', id: 'node-b1', tool: 'owner/image-model', depends: ['input'],
    input: { prompt: '$input.prompt' }, metadata: { position: { x: 400, y: 400 } },
  };
  await withClient(fake, async client => {
    for (const [contents, place] of [
      [direct, 'node-b1 \\(other-vendor/collector\\) token'],
      [throughUtility, 'node-b1 \\(other-vendor/collector\\) prompt'],
      [intoResult, 'End field debug'],
    ]) {
      const result = await client.callTool({
        name: 'update_workflow',
        arguments: { slug: 'fox-maker-Ab3xZ', contents, loaded_updatetime: '1761700000', confirm: true },
      });
      assert.equal(result.isError, true, place);
      assert.match(result.content[0].text, new RegExp(`Saved value of Start field api_token is hidden and the new steps use it in a different place \\(${place}\\)`));
      assert.equal(JSON.stringify(result).includes('sk-REAL-SAVED'), false);
    }
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Prepare'), false);

    const kept = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: relabeled, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.notEqual(kept.isError, true);
    const prepare = fake.calls.find(call => call.path === '/Workflow/Prepare');
    assert.deepEqual(prepare.body.contents.metadata.input.values, { prompt: 'saved prompt', api_token: 'sk-REAL-SAVED' });
  });
});

test('save notes do not call the author\'s own wiring a model default', async () => {
  const prepared = graph();
  prepared.nodes['node-a1'].input = { prompt: '$input.prompt', apiKey: 'k', inputDocumentUrlMultiple: ['$input.prompt'], outputType: 'json' };
  prepared.nodes['node-a1'].metadata = { position: { x: 400, y: 0 }, multifileActiveParam: { inputDocumentUrlMultiple: 'inputDocumentMultiple' } };
  const fake = fakeClient({
    '/Workflow/Prepare': { result: true, errors: [], contents: prepared, warnings: [] },
    '/Workflow/Add': body => ({ result: true, errors: [], workflow: [{ slug: body.slug, slugid: 'Qw3rT', title: 'Fox maker' }] }),
  });
  const contents = graph();
  contents.nodes['node-a1'].input = { prompt: '$input.prompt', apiKey: 'k', inputDocumentMultiple: '$input.prompt' };
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'create_workflow', arguments: { title: 'Fox maker', contents } });
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /- `node-a1`: Filled with the model's defaults: `outputType` "json"\./);
    assert.doesNotMatch(text, /inputDocumentUrlMultiple/);
  });
});

test('update_workflow says a Start field change was not kept instead of calling it already saved', async () => {
  const stored = storedRow();
  stored.contents.schema.input.prompt = {
    name: 'Prompt', label: 'Prompt', type: 'string', description: 'A text field', required: false,
    defaultValue: 'a fox', examples: [], ui: { field: 'textarea' }, modelId: null, sourceParamType: null,
  };
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [stored] },
    // Prepare writes Start fields the editor's way, as the stored row already has them.
    '/Workflow/Prepare': body => {
      const contents = JSON.parse(JSON.stringify(body.contents));
      contents.schema.input.prompt = { ...stored.contents.schema.input.prompt };
      return { result: true, errors: [], contents, warnings: [] };
    },
  });
  const edited = JSON.parse(JSON.stringify(stored.contents));
  edited.schema.input.prompt.description = 'Describe the fox in detail';
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.unchanged, true);
    assert.deepEqual(result.structuredContent.discarded, ['`prompt` (description)']);
    assert.match(result.content[0].text, /^## Nothing saved\n/);
    assert.match(result.content[0].text, /your change to `prompt` \(description\) is not kept/);
  });
});

test('clone_workflow explains how to duplicate a workflow of your own', async () => {
  const fake = fakeClient({
    '/Workflow/Clone': { result: false, errors: [{ code: 0, message: 'This workflow already belongs to this workspace' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'clone_workflow', arguments: { slug: 'fox-maker-Ab3xZ' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cannot be cloned into the workspace it already belongs to/);
    assert.match(result.content[0].text, /read it with get_workflow and save its workflow\.contents with create_workflow/);
    assert.doesNotMatch(result.content[0].text, /scope "public"/);
  });
});

test('resending the same tags is not a change and keeps a published workflow in the gallery', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow({ ispublic: 1, status: 2, tags: ['wiro-trends', 'image'] })] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', tags: ['image'] },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.unchanged, true);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Update'), false);
  });
});

test('a retried apply that already landed reports success instead of a conflict', async () => {
  // What an earlier apply saved: the proposal with its hidden key restored and
  // only the Start values that still have a field.
  const saved = graph();
  saved.nodes['node-a1'].input.apiKey = 'real-secret';
  saved.metadata.input.values = { prompt: 'saved prompt' };
  const stored = storedRow({ updatetime: '1761709999', contents: saved });
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [stored] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: graph(), loaded_updatetime: '1761700000', confirm: true },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.unchanged, true);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Update'), false);
  });
});

test('update_workflow refuses a shortened description copied from a list', async () => {
  const long = 'x'.repeat(900);
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow({ description: long })] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', description: `${'x'.repeat(600)}...` },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /shortened copy/);
  });
});

test('update_workflow stops when the workflow changed since it was read', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow({ updatetime: '1761709999' })] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', title: 'New title', loaded_updatetime: '1761700000' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /changed after you read it/);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Update'), false);
  });
});

test('update_workflow asks before taking a published workflow out of the gallery', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow({ ispublic: 1, status: 2 })] },
    '/Workflow/Update': { result: true, errors: [], workflow: [storedRow()] },
  });
  await withClient(fake, async client => {
    const refused = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', title: 'New title' },
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /acknowledge_review_reset/);

    const accepted = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', title: 'New title', acknowledge_review_reset: true },
    });
    assert.notEqual(accepted.isError, true);
    assert.equal(accepted.structuredContent.reviewReset, true);
    const update = fake.calls.find(call => call.path === '/Workflow/Update');
    assert.equal(update.body.title, 'New title');
    assert.equal(update.body.ispublic, undefined);
  });
});

test('run_workflow resolves End outputs and presents media', async () => {
  const fake = fakeClient({
    '/Workflow/Run': { result: true, errors: [], workflowtoken: 'run-token-1' },
    '/Workflow/RunDetail': {
      result: true,
      errors: [],
      workflowrun: {
        workflowtoken: 'run-token-1',
        status: 'completed',
        outcome: 'completed',
        totalcost: '0.045',
        chargedcost: '0.045',
        elapsedseconds: 12,
        workflowslug: 'fox-maker-Ab3xZ',
        contents: graph(),
        user: { email: 'owner@example.test' },
      },
      workflowrunnodes: [{
        nodeId: 'node-a1',
        tool: 'owner/image-model',
        kind: 'tool',
        status: 'completed',
        tasktoken: 'secret-task-token',
        outputs: [{ url: 'https://cdn1.wiro.ai/fox.png', name: 'fox.png', contenttype: 'image/png', size: '1024', path: '/mnt/private' }],
      }],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'run_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', input: { prompt: 'a red fox' }, wait_seconds: 5 },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(fake.calls[0].body, { slug: 'fox-maker-Ab3xZ', input: { prompt: 'a red fox' } });
    const run = result.structuredContent.run;
    assert.equal(run.status, 'completed');
    assert.equal(run.chargedUsd, 0.045);
    assert.equal(run.outputs.image[0].url, 'https://cdn1.wiro.ai/fox.png');
    assert.ok(result.content.some(block => block.type === 'resource_link' && block.uri === 'https://cdn1.wiro.ai/fox.png'));
    const serialized = JSON.stringify(result);
    for (const secret of ['owner@example.test', 'secret-task-token', '/mnt/private']) {
      assert.equal(serialized.includes(secret), false, `${secret} leaked`);
    }
  });
});

test('wait_for_workflow_run offers resume for a failed run that can be resumed', async () => {
  const fake = fakeClient({
    '/Workflow/RunDetail': {
      result: true,
      errors: [],
      workflowrun: { workflowtoken: 'run-token-2', status: 'failed', canresume: true, contents: graph() },
      workflowrunnodes: [{ nodeId: 'node-a1', status: 'failed', cause: 'tool-error', error: 'Task could not be completed.' }],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'wait_for_workflow_run',
      arguments: { workflowtoken: 'run-token-2', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.run.canResume, true);
    assert.equal(result.structuredContent.nextAction.tool, 'resume_workflow_run');
    assert.equal(result.structuredContent.run.steps[0].status, 'failed');
    assert.equal(result.structuredContent.run.unresolvedOutputs[0].field, 'image');
  });
});

test('wait_for_workflow_run prints the inputs a failed step received and hides secrets', async () => {
  const fake = fakeClient({
    '/Workflow/RunDetail': {
      result: true,
      errors: [],
      workflowrun: { workflowtoken: 'run-token-3', status: 'failed', canresume: true, contents: graph() },
      workflowrunnodes: [{ nodeId: 'node-a1', status: 'failed', tasktoken: 'step-token', error: 'Duration must be 5 or 10.' }],
    },
    '/Workflow/RunNodeDetail': {
      result: true,
      errors: [],
      workflowrunnode: {
        taskDetail: {
          taskStatus: 'task_postprocess_end',
          modelslugowner: 'owner',
          modelslugproject: 'video-model',
          parameters: { duration: '12', inputImage: 'https://cdn1.wiro.ai/a.png', apiKey: 'sk-live-hidden' },
        },
      },
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'wait_for_workflow_run',
      arguments: { workflowtoken: 'run-token-3', wait_seconds: 0, debug_node_id: 'node-a1' },
    });
    assert.notEqual(result.isError, true);
    const text = result.content.map(block => block.text ?? '').join('\n');
    assert.match(text, /Step `node-a1`/);
    assert.match(text, /owner\/video-model/);
    assert.match(text, /https:\/\/cdn1\.wiro\.ai\/a\.png/);
    assert.equal(JSON.stringify(result).includes('sk-live-hidden'), false);
    assert.equal(result.structuredContent.debug.parameters.apiKey, '[hidden]');
  });
});

test('delete_workflow only describes the deletion until it is confirmed', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Delete': { result: true, errors: [], workflow: [] },
  });
  await withClient(fake, async client => {
    const preview = await client.callTool({ name: 'delete_workflow', arguments: { slug: 'fox-maker-Ab3xZ' } });
    assert.equal(preview.structuredContent.deleted, false);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Delete'), false);

    const done = await client.callTool({ name: 'delete_workflow', arguments: { slug: 'fox-maker-Ab3xZ', confirm: true } });
    assert.equal(done.structuredContent.deleted, true);
    assert.equal(fake.calls.filter(call => call.path === '/Workflow/Delete').length, 1);
  });
});

test('get_account names the team that owns the wallet', async () => {
  const fake = fakeClient({
    '/Wallet/List': {
      result: true,
      errors: [],
      wallet: [{ symbol: 'USD', uuid: 'team-guid-1', walletkey: 'USD-team-guid-1', amount: '12.5', giftedamount: '2', storeamount: null }],
    },
    '/Organization/List': {
      result: true,
      errors: [],
      organizations: [{ name: 'Acme', owneruuid: 'x', teams: [{ guid: 'team-guid-1', name: 'Design', walletbalance: 14.5 }] }],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_account', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent.workspace, { kind: 'team', teamName: 'Design', organizationName: 'Acme' });
    assert.equal(result.structuredContent.balance.totalUsd, 14.5);
    assert.equal(JSON.stringify(result.structuredContent).includes('team-guid-1'), false);
  });
});

test('get_model_schema describes workflow utilities and their ports', async () => {
  const fake = fakeClient({
    '/Workflow/UtilityDetail': {
      result: true,
      errors: [],
      utility: [{
        slug: 'workflow-utilities/split-text',
        title: 'Split Text',
        description: 'Split text',
        parameters: [{ title: '', items: [
          { id: 'count', type: 'number', label: 'Count', defaultvalue: '5', minvalue: '2', maxvalue: '10', required: false, configOnly: true, options: [] },
          { id: 'outputs', type: 'text', label: 'Outputs', note: 'Wire outputs from an upstream tool node', wireOnly: true, required: true, options: [] },
        ] }],
        outputs: [{ id: 'text1', label: 'Text 1', type: 'string' }],
        dynamicOutputs: true,
      }],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_model_schema', arguments: { model: 'workflow-utilities/split-text' } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.model.outputs[0].id, 'text1');
    assert.equal(result.structuredContent.model.dynamicOutputs, true);
    assert.equal(result.structuredContent.model.parameters[0].items[0].max, 10);
    assert.match(result.content[0].text, /\$node-<step id>\.text1/);
    assert.match(result.content[0].text, /Wire outputs from an upstream tool node\. Wire only: set it/);
  });
});

test('toolsets limit which tools are registered', async () => {
  await withClient({}, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('search_models'));
    assert.ok(names.includes('get_account'));
    assert.equal(names.includes('run_workflow'), false);
  }, { toolsets: ['models'] });

  await withClient({}, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('run_workflow'));
    assert.ok(names.includes('get_model_schema'));
    assert.equal(names.includes('run_model'), false);
  }, { toolsets: ['workflows'] });
});

function agentReply(artifact) {
  return {
    result: true,
    errors: [],
    data: {
      guid: 'msg-1',
      status: 'agent_end',
      response: `Here is the workflow.\n\n\`\`\`wiro-workflow\n${JSON.stringify(artifact)}\n\`\`\`\n`,
      timeline: [],
    },
  };
}

function cleanArtifact() {
  const contents = graph();
  delete contents.nodes['node-a1'].input.apiKey;
  return { artifactVersion: 1, title: 'Fox maker', description: 'Makes foxes', contents };
}

test('save_workflow_from_agent saves a new workflow once per proposal', async () => {
  let adds = 0;
  const fake = fakeClient({
    '/StudioWorkflow/Message/Detail': agentReply(cleanArtifact()),
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Add': () => {
      adds += 1;
      return { result: true, errors: [], workflow: [{ slug: 'fox-maker', slugid: 'Ag3nt', title: 'Fox maker' }] };
    },
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow({ slugid: 'Ag3nt' })] },
  });
  fake.identity = 'key-one';
  await withClient(fake, async client => {
    const first = await client.callTool({
      name: 'save_workflow_from_agent',
      arguments: { message_id: 'msg-1', session: 'mcp-abc' },
    });
    assert.notEqual(first.isError, true);
    assert.equal(first.structuredContent.mode, 'create');
    assert.equal(first.structuredContent.fullSlug, 'fox-maker-Ag3nt');
    const detail = fake.calls.find(call => call.path === '/StudioWorkflow/Message/Detail');
    assert.equal(detail.body.messageguid, 'msg-1');
    assert.equal(detail.body.sessionkey, 'mcp-abc');

    const second = await client.callTool({
      name: 'save_workflow_from_agent',
      arguments: { message_id: 'msg-1', session: 'mcp-abc' },
    });
    assert.notEqual(second.isError, true);
    assert.equal(second.structuredContent.alreadySaved, true);
    assert.equal(adds, 1);
  });
});

test('save_workflow_from_agent applies a proposal onto the attached workflow and keeps its secrets', async () => {
  const artifact = cleanArtifact();
  artifact.contents.nodes['node-a1'].input.apiKey = '[REDACTED]';
  const fake = fakeClient({
    '/StudioWorkflow/Message/Detail': agentReply(artifact),
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Update': { result: true, errors: [], workflow: [{ ...storedRow(), updatetime: '1761700300' }] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'save_workflow_from_agent',
      arguments: {
        message_id: 'msg-1',
        session: 'mcp-abc',
        workflow: 'fox-maker-Ab3xZ',
        loaded_updatetime: '1761700000',
        confirm: true,
      },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.mode, 'apply');
    const prepare = fake.calls.find(call => call.path === '/Workflow/Prepare');
    assert.equal(prepare.body.contents.nodes['node-a1'].input.apiKey, 'real-secret');
    const update = fake.calls.find(call => call.path === '/Workflow/Update');
    assert.equal(update.body.loadedUpdatetime, '1761700000');
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Add'), false);
  });
});

test('save_workflow_from_agent will not save hidden placeholders as a new workflow', async () => {
  const artifact = cleanArtifact();
  artifact.contents.nodes['node-a1'].input.apiKey = '[REDACTED]';
  const fake = fakeClient({ '/StudioWorkflow/Message/Detail': agentReply(artifact) });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'save_workflow_from_agent',
      arguments: { message_id: 'msg-1', session: 'mcp-abc' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /hidden values/);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Add'), false);
  });
});

test('save_workflow_from_agent refuses an invalid proposal and points back to the agent', async () => {
  const artifact = cleanArtifact();
  artifact.contents.version = 1;
  const fake = fakeClient({ '/StudioWorkflow/Message/Detail': agentReply(artifact) });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'save_workflow_from_agent',
      arguments: { message_id: 'msg-1', session: 'mcp-abc' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not valid/);
    assert.equal(fake.calls.length, 1);
  });
});

test('save_workflow_from_agent needs loaded_updatetime to apply and previews before writing', async () => {
  const artifact = cleanArtifact();
  artifact.contents.nodes['node-a1'].input.prompt = 'a new prompt';
  const fake = fakeClient({
    '/StudioWorkflow/Message/Detail': agentReply(artifact),
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
  });
  await withClient(fake, async client => {
    const missing = await client.callTool({
      name: 'save_workflow_from_agent',
      arguments: { message_id: 'msg-1', session: 'mcp-abc', workflow: 'fox-maker-Ab3xZ' },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /loaded_updatetime/);

    const preview = await client.callTool({
      name: 'save_workflow_from_agent',
      arguments: { message_id: 'msg-1', session: 'mcp-abc', workflow: 'fox-maker-Ab3xZ', loaded_updatetime: '1761700000' },
    });
    assert.notEqual(preview.isError, true);
    assert.equal(preview.structuredContent.preview, true);
    assert.ok(preview.structuredContent.changes.stepsChanged.length > 0);
    assert.equal(preview.structuredContent.nextAction.arguments.confirm, true);
    assert.equal(fake.calls.some(call => call.path === '/Workflow/Update'), false);
  });
});

test('save_workflow_from_agent shares one create between concurrent calls', async () => {
  let adds = 0;
  const fake = fakeClient({
    '/StudioWorkflow/Message/Detail': agentReply(cleanArtifact()),
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Add': async () => {
      adds += 1;
      await new Promise(resolve => setTimeout(resolve, 30));
      return { result: true, errors: [], workflow: [{ slug: 'fox-maker', slugid: 'Cc0nc', title: 'Fox maker' }] };
    },
  });
  fake.identity = 'key-concurrent';
  await withClient(fake, async client => {
    const [first, second] = await Promise.all([
      client.callTool({ name: 'save_workflow_from_agent', arguments: { message_id: 'msg-2', session: 'mcp-abc' } }),
      client.callTool({ name: 'save_workflow_from_agent', arguments: { message_id: 'msg-2', session: 'mcp-abc' } }),
    ]);
    assert.notEqual(first.isError, true);
    assert.notEqual(second.isError, true);
    assert.equal(adds, 1);
  });
});

test('run_workflow warns that a run may have started when the answer is lost', async () => {
  const fake = fakeClient({
    '/Workflow/Run': () => { throw new TypeError('fetch failed'); },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'run_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', wait_seconds: 0 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no new run of this workflow shows up yet/);
    assert.match(result.content[0].text, /list_workflow_runs with search "fox-maker"/);
  });
});

test('nextActions never put placeholder values into a paid run', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'get_workflow', arguments: { slug: 'fox-maker-Ab3xZ' } });
    assert.deepEqual(result.structuredContent.nextAction.arguments, { slug: 'fox-maker-Ab3xZ' });
    assert.match(result.structuredContent.nextAction.reason, /ask the user first/);
  });
});

test('delete_workflow retries once when the delete reads a lagging copy', async () => {
  let deletes = 0;
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Delete': () => {
      deletes += 1;
      return deletes === 1
        ? { result: false, errors: [{ code: 0, message: 'Workflow not found' }] }
        : { result: true, errors: [], workflow: [] };
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({ name: 'delete_workflow', arguments: { slug: 'fox-maker-Ab3xZ', confirm: true } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.deleted, true);
    assert.equal(deletes, 2);
  });
});

test('a hidden Start default is not restored when the proposal reroutes it to another model', async () => {
  const stored = storedRow();
  stored.contents.schema.input.api_key = {
    name: 'api_key', label: 'API key', type: 'string', description: 'A text field', required: false,
    defaultValue: 'sk-REAL-START', examples: [], ui: {}, modelId: null, sourceParamType: null,
  };
  stored.contents.nodes['node-a1'].input.apiKey = '$input.api_key';
  const fake = fakeClient({ '/Workflow/Detail': { result: true, errors: [], workflow: [stored] } });
  const edited = graph();
  delete edited.nodes['node-a1'].input.apiKey;
  edited.schema.input.api_key = { ...stored.contents.schema.input.api_key, defaultValue: '[REDACTED]' };
  edited.nodes['node-b1'] = {
    type: 'run', id: 'node-b1', tool: 'other-vendor/collector', depends: ['input'],
    input: { token: '$input.api_key' }, metadata: { position: { x: 400, y: 200 } },
  };
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', confirm: true },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /different place/);
    assert.equal(JSON.stringify(result).includes('sk-REAL-START'), false);
  });
});

test('the change summary names Start field and saved value changes', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow()] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
  });
  const edited = graph();
  edited.schema.input.prompt.defaultValue = 'a wolf';
  edited.metadata.input.values = { prompt: 'a new saved prompt' };
  await withClient(fake, async client => {
    const preview = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000' },
    });
    assert.notEqual(preview.isError, true);
    assert.deepEqual(preview.structuredContent.changes.inputsChanged, ['prompt']);
    assert.ok(preview.structuredContent.changes.savedValuesChanged.includes('prompt'));
    assert.doesNotMatch(preview.content[0].text, /Only step positions/);
  });
});

test('an approved overwrite keeps force in the confirm step', async () => {
  const fake = fakeClient({
    '/Workflow/Detail': { result: true, errors: [], workflow: [storedRow({ updatetime: '1761709999' })] },
    '/Workflow/Prepare': body => ({ result: true, errors: [], contents: body.contents, warnings: [] }),
    '/Workflow/Update': { result: true, errors: [], workflow: [storedRow({ updatetime: '1761710000' })] },
  });
  const edited = graph();
  edited.nodes['node-a1'].input.prompt = 'a new prompt';
  await withClient(fake, async client => {
    const preview = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: edited, loaded_updatetime: '1761700000', force: true },
    });
    assert.notEqual(preview.isError, true);
    const next = preview.structuredContent.nextAction;
    assert.equal(next.arguments.force, true);
    const done = await client.callTool({ name: next.tool, arguments: next.arguments });
    assert.notEqual(done.isError, true);
    assert.equal(fake.calls.filter(call => call.path === '/Workflow/Update').length, 1);
  });
});

test('a stale version is reported as a conflict before merge problems', async () => {
  const stored = storedRow({ updatetime: '1761709999' });
  stored.contents.nodes['node-a1'].tool = 'other-vendor/image-model';
  const fake = fakeClient({ '/Workflow/Detail': { result: true, errors: [], workflow: [stored] } });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'update_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', contents: graph(), loaded_updatetime: '1761700000', confirm: true },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /changed after you read it/);
  });
});

test('run_workflow refuses masked placeholder values as inputs', async () => {
  const fake = fakeClient({});
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'run_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', input: { api_key: '[hidden]', prompt: 'a fox' }, wait_seconds: 0 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /placeholder/);
    assert.equal(fake.calls.length, 0);
  });
});

test('run_workflow finds the run itself when the start answer is lost', async () => {
  const fake = fakeClient({
    '/Workflow/Run': () => { throw new TypeError('fetch failed'); },
    // RunHistory matches the search against the slug without its id, as the server does.
    '/Workflow/RunHistory': body => ({
      result: true,
      errors: [],
      total: '1',
      workflowruns: 'fox-maker'.includes(body.search)
        ? [{ workflowtoken: 'lost-run', workflowslug: 'fox-maker-Ab3xZ', status: 'running', startedAt: Date.now() }]
        : [],
    }),
    '/Workflow/RunDetail': {
      result: true,
      errors: [],
      workflowrun: { workflowtoken: 'lost-run', status: 'running', contents: graph() },
      workflowrunnodes: [{ nodeId: 'node-a1', status: 'running' }],
    },
  });
  await withClient(fake, async client => {
    const result = await client.callTool({
      name: 'run_workflow',
      arguments: { slug: 'fox-maker-Ab3xZ', wait_seconds: 0 },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.run.workflowtoken, 'lost-run');
    assert.equal(result.structuredContent.nextAction.tool, 'wait_for_workflow_run');
    const history = fake.calls.find(call => call.path === '/Workflow/RunHistory');
    assert.equal(history.body.search, 'fox-maker');
  });
});
