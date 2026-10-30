import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  WORKFLOW_ARTIFACT_MAX_BYTES,
  WORKFLOW_ASSISTANT_MAX_BYTES,
  WORKFLOW_LIST_LIMIT_MAX,
  WORKFLOW_LIST_SEARCH_MAX_LENGTH,
  WORKFLOW_REQUEST_ID_MAX_LENGTH,
  canonicalHash,
  canonicalStringify,
  createWorkflowArtifactIdentity,
  parseAgentChatArtifacts,
  utf8ByteLength,
  validateWorkflowArtifact,
  validateWorkflowArtifactJson,
  validateWorkflowContents,
  validateWorkflowListRequest,
} from '../dist/utils/workflow-artifacts.js';

function workflowField() {
  return {
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
}

function runNode(id, tool, depends, input, x) {
  return {
    type: 'run',
    id,
    tool,
    depends,
    input,
    metadata: { position: { x, y: 0 } },
  };
}

function validContents() {
  return {
    version: '1',
    nodes: {
      'node-model-a': runNode('node-model-a', 'openai/gpt-image', ['input'], { prompt: '$input.prompt' }, 300),
      'node-util-b': runNode('node-util-b', 'workflow-utilities/output-filter', ['node-model-a'], { outputs: '$node-model-a.outputs', mode: 'file' }, 600),
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
    schema: {
      input: { prompt: workflowField() },
      output: {},
    },
    metadata: {
      input: { position: { x: 0, y: 0 } },
    },
  };
}

function fanOutContents(branchCount = 5) {
  const rootId = 'node-llm';
  const branchIds = Array.from({ length: branchCount }, (_, index) => `node-branch-${index}`);
  const nodes = {
    [rootId]: runNode(rootId, 'openai/gpt-5', ['input'], { prompt: '$input.prompt' }, 300),
  };
  branchIds.forEach((id, index) => {
    nodes[id] = {
      ...runNode(id, `provider/model-${index}`, [rootId], { prompt: `$${rootId}.outputs` }, 600),
      metadata: { position: { x: 600, y: (index - (branchCount - 1) / 2) * 140 } },
    };
  });
  const fields = Object.fromEntries(branchIds.map((id, index) => [`result${index + 1}`, `$${id}.outputs`]));
  nodes.output = {
    type: 'display',
    id: 'output',
    depends: branchIds,
    input: {},
    fields,
    metadata: { position: { x: 900, y: 0 } },
  };

  return {
    version: '1',
    nodes,
    output: fields,
    schema: {
      input: { prompt: workflowField() },
      output: {},
    },
    metadata: {
      input: { position: { x: 0, y: 0 } },
    },
  };
}

function validArtifact() {
  return {
    artifactVersion: 1,
    title: 'Campaign workflow',
    description: 'Creates a campaign asset',
    contents: validContents(),
  };
}

function fenced(language, value) {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

function hasIssue(result, code) {
  return result.issues.some(issue => issue.code === code);
}

describe('agent workflow artifact parsing', () => {
  it('separates prose from complete request and workflow fences', () => {
    const request = {
      protocolVersion: 1,
      requestId: 'req-list-1',
      operation: 'workflow.list',
      args: { search: 'campaign', limit: 50 },
    };
    const source = ['I can help with that.', fenced('wiro-workflow-request', JSON.stringify(request)), 'Here is the candidate.', fenced('wiro-workflow', JSON.stringify(validArtifact()))].join('\n');

    const parsed = parseAgentChatArtifacts(source);

    assert.equal(parsed.streamState, 'complete');
    assert.equal(parsed.prose, 'I can help with that.\nHere is the candidate.');
    assert.equal(parsed.requests[0].status, 'valid');
    assert.equal(parsed.requests[0].request.operation, 'workflow.list');
    assert.equal(parsed.artifacts[0].status, 'valid');
    assert.equal(parsed.artifacts[0].artifact.title, 'Campaign workflow');
    assert.equal(parsed.artifacts[0].raw, undefined);
    assert.equal(Object.hasOwn(parsed.artifacts[0], 'canonicalJson'), false);
    assert.equal(parsed.prose.includes('"contents"'), false);
  });

  it('hides an incomplete workflow fence while streaming', () => {
    const source = 'Preparing your workflow.\n```wiro-workflow\n{"artifactVersion":1,"title":"Still';
    const parsed = parseAgentChatArtifacts(source);

    assert.equal(parsed.streamState, 'building-workflow');
    assert.equal(parsed.prose, 'Preparing your workflow.');
    assert.equal(parsed.artifacts[0].status, 'incomplete');
    assert.equal(parsed.artifacts[0].raw, undefined);
  });

  it('returns loading state for an incomplete list request', () => {
    const parsed = parseAgentChatArtifacts('One moment.\n```wiro-workflow-request\n{"protocolVersion":1');

    assert.equal(parsed.streamState, 'loading-workflows');
    assert.equal(parsed.requests[0].status, 'incomplete');
    assert.equal(parsed.prose, 'One moment.');
  });

  it('returns an invalid state for malformed closed JSON without leaking it into prose', () => {
    const parsed = parseAgentChatArtifacts(`Before\n${fenced('wiro-workflow', '{"artifactVersion":')}\nAfter`);

    assert.equal(parsed.artifacts[0].status, 'invalid');
    assert.equal(parsed.artifacts[0].issues[0].code, 'malformed-workflow-json');
    assert.equal(parsed.prose, 'Before\nAfter');
  });

  it('marks duplicate request ids invalid', () => {
    const request = JSON.stringify({
      protocolVersion: 1,
      requestId: 'req-same',
      operation: 'workflow.list',
      args: {},
    });
    const parsed = parseAgentChatArtifacts(`${fenced('wiro-workflow-request', request)}\n${fenced('wiro-workflow-request', request)}`);

    assert.deepEqual(parsed.requests.map(item => item.status), ['valid', 'invalid']);
    assert.equal(parsed.requests[1].issues[0].code, 'duplicate-workflow-request-id');
  });

  it('disables every action when the complete answer exceeds 45 KB', () => {
    const request = {
      protocolVersion: 1,
      requestId: 'req-answer-limit',
      operation: 'workflow.list',
      args: {},
    };
    const source = `${'x'.repeat(WORKFLOW_ASSISTANT_MAX_BYTES)}\n${fenced('wiro-workflow-request', JSON.stringify(request))}`;
    const parsed = parseAgentChatArtifacts(source);

    assert.equal(parsed.requests[0].status, 'oversize');
    assert.equal(parsed.requests[0].request, undefined);
    assert.equal(hasIssue(parsed.requests[0], 'workflow-answer-oversize'), true);
  });

  it('keeps an over-limit artifact value but never marks it valid', () => {
    const source = `${'x'.repeat(WORKFLOW_ASSISTANT_MAX_BYTES)}\n${fenced('wiro-workflow', JSON.stringify(validArtifact()))}`;
    const parsed = parseAgentChatArtifacts(source);

    assert.equal(parsed.artifacts[0].status, 'oversize');
    assert.ok(parsed.artifacts[0].artifact);
    assert.equal(hasIssue(parsed.artifacts[0], 'workflow-answer-oversize'), true);
  });

  it('only accepts the exact fence names on their own line', () => {
    const body = JSON.stringify(validArtifact());
    for (const source of [fenced('json', body), fenced('wiro-workflow json', body), `    ${fenced('wiro-workflow', body)}`, `text \`\`\`wiro-workflow\n${body}\n\`\`\``]) {
      assert.equal(parseAgentChatArtifacts(source).artifacts.length, 0, source.slice(0, 40));
    }
    const crlf = parseAgentChatArtifacts(`Intro\r\n\`\`\`wiro-workflow\r\n${body}\r\n\`\`\`\r\nOutro`);
    assert.equal(crlf.artifacts[0].status, 'valid');
  });
});

describe('workflow.list request validation', () => {
  it('accepts only the exact read operation and bounded args', () => {
    const valid = validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: 'req_1:page.2',
      operation: 'workflow.list',
      args: { search: '  campaign  ', limit: WORKFLOW_LIST_LIMIT_MAX },
    });

    assert.deepEqual(valid.value, {
      protocolVersion: 1,
      requestId: 'req_1:page.2',
      operation: 'workflow.list',
      args: { search: 'campaign', limit: 50 },
    });

    assert.equal(validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: 'req-write',
      operation: 'workflow.update',
      args: {},
    }).valid, false);
    assert.equal(validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: 'req-limit',
      operation: 'workflow.list',
      args: { limit: WORKFLOW_LIST_LIMIT_MAX + 1 },
    }).valid, false);
    assert.equal(validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: 'req-extra',
      operation: 'workflow.list',
      args: { endpoint: '/Workflow/Delete' },
    }).valid, false);
  });

  it('enforces exact search and requestId length bounds', () => {
    assert.equal(validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: `r${'x'.repeat(WORKFLOW_REQUEST_ID_MAX_LENGTH - 1)}`,
      operation: 'workflow.list',
      args: { search: 'x'.repeat(WORKFLOW_LIST_SEARCH_MAX_LENGTH) },
    }).valid, true);
    assert.equal(validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: `r${'x'.repeat(WORKFLOW_REQUEST_ID_MAX_LENGTH)}`,
      operation: 'workflow.list',
      args: {},
    }).valid, false);
    assert.equal(validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: 'req-search-over',
      operation: 'workflow.list',
      args: { search: 'x'.repeat(WORKFLOW_LIST_SEARCH_MAX_LENGTH + 1) },
    }).valid, false);
  });

  it('requires args and an integer limit', () => {
    assert.equal(hasIssue(validateWorkflowListRequest({
      protocolVersion: 1,
      requestId: 'req-no-args',
      operation: 'workflow.list',
    }), 'invalid-workflow-request-args'), true);
    for (const limit of ['10', 2.5]) {
      assert.equal(validateWorkflowListRequest({
        protocolVersion: 1,
        requestId: 'req-bad-limit',
        operation: 'workflow.list',
        args: { limit },
      }).valid, false);
    }
  });
});

describe('workflow artifact validation', () => {
  it('accepts an acyclic LLM fan-out into five parallel model branches', () => {
    const result = validateWorkflowContents(fanOutContents());

    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
  });

  it('accepts a candidate exactly at 40 KB and rejects one byte over', () => {
    const artifact = validArtifact();
    const modelNode = artifact.contents.nodes['node-model-a'];
    modelNode.input.padding = '';
    const base = JSON.stringify(artifact);
    const paddingLength = WORKFLOW_ARTIFACT_MAX_BYTES - utf8ByteLength(base);
    assert.ok(paddingLength > 0);

    modelNode.input.padding = 'x'.repeat(paddingLength);
    const atBoundary = JSON.stringify(artifact);
    assert.equal(utf8ByteLength(atBoundary), WORKFLOW_ARTIFACT_MAX_BYTES);
    assert.equal(validateWorkflowArtifactJson(atBoundary).status, 'valid');

    modelNode.input.padding += 'x';
    const overBoundary = JSON.stringify(artifact);
    assert.equal(utf8ByteLength(overBoundary), WORKFLOW_ARTIFACT_MAX_BYTES + 1);
    assert.equal(validateWorkflowArtifactJson(overBoundary).status, 'oversize');
  });

  it('rejects references to missing nodes', () => {
    const contents = validContents();
    const utility = contents.nodes['node-util-b'];
    utility.depends = ['node-missing'];
    utility.input.outputs = '$node-missing.outputs';

    const result = validateWorkflowContents(contents);

    assert.equal(result.valid, false);
    assert.equal(hasIssue(result, 'unknown-node-reference'), true);
  });

  it('rejects workflow references embedded inside static prompt text', () => {
    const contents = validContents();
    contents.nodes['node-model-a'].input.prompt = 'Create an image from $input.prompt';

    const result = validateWorkflowContents(contents);

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(issue => issue.code === 'embedded-workflow-reference'
      && issue.path === '$.contents.nodes.node-model-a.input.prompt'));
  });

  it('requires top-level output to exactly match nodes.output.fields', () => {
    const contents = validContents();
    contents.output = { other: '$node-util-b.result' };

    const result = validateWorkflowContents(contents);

    assert.equal(result.valid, false);
    assert.equal(hasIssue(result, 'output-mapping-mismatch'), true);
  });

  it('keeps schema.output empty for builder round-trip compatibility', () => {
    const contents = validContents();
    contents.schema.output = { result: { type: 'string' } };

    const result = validateWorkflowContents(contents);

    assert.equal(result.valid, false);
    assert.equal(hasIssue(result, 'noncanonical-schema-output'), true);
  });

  it('supports utility port refs while requiring normal tools to use outputs', () => {
    assert.equal(validateWorkflowContents(validContents()).valid, true);

    const dynamicUtility = validContents();
    const utilityNode = dynamicUtility.nodes['node-util-b'];
    utilityNode.tool = 'workflow-utilities/split-text';
    utilityNode.input = { text: '$node-model-a.outputs', count: 10 };
    dynamicUtility.nodes.output.fields = { result: '$node-util-b.text10' };
    dynamicUtility.output = { result: '$node-util-b.text10' };
    assert.equal(validateWorkflowContents(dynamicUtility).valid, true);

    const invalid = validContents();
    invalid.nodes.output.depends = ['node-model-a'];
    invalid.nodes.output.fields = { result: '$node-model-a.result' };
    invalid.output = { result: '$node-model-a.result' };

    const result = validateWorkflowContents(invalid);

    assert.equal(result.valid, false);
    assert.equal(hasIssue(result, 'invalid-tool-output-reference'), true);
  });

  it('rejects duplicate node ids even when object keys differ', () => {
    const contents = validContents();
    contents.nodes['node-model-b'] = {
      ...runNode('node-model-a', 'openai/another-model', [], {}, 400),
    };

    const result = validateWorkflowContents(contents);

    assert.equal(result.valid, false);
    assert.equal(hasIssue(result, 'duplicate-node-id'), true);
  });

  it('rejects saved Start values and incomplete workflow field schemas', () => {
    const withValues = validContents();
    withValues.metadata.input.values = { prompt: 'belongs to the user' };
    assert.equal(hasIssue(validateWorkflowContents(withValues), 'protected-input-values-forbidden'), true);

    const incompleteField = validContents();
    delete incompleteField.schema.input.prompt.defaultValue;
    assert.equal(hasIssue(validateWorkflowContents(incompleteField), 'missing-schema-field-default'), true);
  });

  it('rejects reserved object keys anywhere in workflow contents', () => {
    const contents = validContents();
    contents.nodes['node-model-a'].input = JSON.parse('{"__proto__":{"polluted":true},"prompt":"$input.prompt"}');
    const result = validateWorkflowContents(contents);

    assert.equal(result.valid, false);
    assert.equal(hasIssue(result, 'reserved-object-key'), true);
  });

  it('rejects pathologically deep workflow JSON before recursive validation', () => {
    const contents = validContents();
    let nested = {};
    for (let depth = 0; depth < 40; depth++) nested = { value: nested };
    contents.nodes['node-model-a'].input = nested;
    const result = validateWorkflowContents(contents);

    assert.equal(result.valid, false);
    assert.equal(hasIssue(result, 'workflow-json-too-deep'), true);
  });

  it('drops model-provided identity and source provenance', () => {
    const untrusted = {
      ...validArtifact(),
      artifactId: 'model-controlled-id',
      source: { workflowRef: 'another-users-workflow' },
    };
    const result = validateWorkflowArtifact(untrusted);

    assert.equal(result.valid, true);
    assert.equal(Object.hasOwn(result.value, 'artifactId'), false);
    assert.equal(Object.hasOwn(result.value, 'source'), false);
    assert.equal(canonicalHash(result.value), canonicalHash(validArtifact()));
  });

  it('never accepts inherited object members as inputs or dependencies', () => {
    const inherited = validContents();
    inherited.nodes['node-model-a'].depends = ['input', 'toString'];
    assert.equal(hasIssue(validateWorkflowContents(inherited), 'unknown-node-dependency'), true);

    const outputInherited = validContents();
    outputInherited.nodes.output.depends = ['node-util-b', 'hasOwnProperty'];
    assert.equal(hasIssue(validateWorkflowContents(outputInherited), 'unknown-output-dependency'), true);

    const inputInherited = validContents();
    inputInherited.nodes['node-model-a'].input.prompt = '$input.toString';
    assert.equal(hasIssue(validateWorkflowContents(inputInherited), 'unknown-input-reference'), true);
  });

  it('refuses a static value that starts with "$" and a string artifactVersion', () => {
    const contents = validContents();
    contents.nodes['node-model-a'].input.caption = '$5 off sale banner';
    assert.equal(hasIssue(validateWorkflowContents(contents), 'malformed-reference'), true);

    assert.equal(hasIssue(validateWorkflowArtifact({ ...validArtifact(), artifactVersion: '1' }), 'unsupported-artifact-version'), true);
  });

  it('detects dependency cycles', () => {
    const contents = validContents();
    contents.nodes['node-model-a'].depends = ['input', 'node-util-b'];
    assert.equal(hasIssue(validateWorkflowContents(contents), 'workflow-cycle'), true);
  });
});

describe('canonical helpers', () => {
  it('produces stable strings and hashes regardless of object key order', () => {
    const left = { z: 3, nested: { b: true, a: ['x', 'y'] }, a: 1 };
    const right = { a: 1, nested: { a: ['x', 'y'], b: true }, z: 3 };

    assert.equal(canonicalStringify(left), canonicalStringify(right));
    assert.equal(canonicalHash(left), canonicalHash(right));
    assert.notEqual(canonicalHash(left), canonicalHash({ ...right, z: 4 }));
  });

  it('measures UTF-8 bytes rather than JavaScript string units', () => {
    assert.equal(utf8ByteLength('é'), 2);
    assert.equal(utf8ByteLength('🚀'), 4);
  });

  it('hashes the UTF-8 bytes of the canonical JSON with SHA-256', () => {
    const value = { b: ['é', '🚀'], a: 1 };
    assert.equal(canonicalStringify(value), '{"a":1,"b":["é","🚀"]}');
    assert.equal(
      canonicalHash(value),
      createHash('sha256').update(Buffer.from('{"a":1,"b":["é","🚀"]}', 'utf8')).digest('hex'),
    );
    assert.match(canonicalHash(value), /^[0-9a-f]{64}$/);
    assert.equal(
      createWorkflowArtifactIdentity('message/1', validArtifact()),
      `message%2F1:${canonicalHash(validArtifact())}`,
    );
  });
});
