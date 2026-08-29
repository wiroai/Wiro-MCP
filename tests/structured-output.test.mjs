import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskResult } from '../dist/utils/format.js';
import { toStructuredTaskResult } from '../dist/utils/structured.js';

function taskWithContent(content, overrides = {}) {
  return {
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_postprocess_end',
    pexit: '0',
    debugoutput: 'raw debug transport must not become the response',
    starttime: '',
    endtime: '',
    elapsedseconds: '4',
    totalcost: '0.01',
    modelslugowner: 'owner',
    modelslugproject: 'model',
    outputs: [{
      contenttype: 'raw',
      content,
    }],
    ...overrides,
  };
}

test('text-only tasks preserve segment order and completion metadata', () => {
  const task = taskWithContent({
    raw: 'raw debug transport must not become the response',
    segments: [
      { type: 'thinking', text: 'Consider the request.' },
      { type: 'answer', text: 'First' },
      { type: 'thinking', text: 'Check the result.' },
      { type: 'answer', text: ' second.' },
    ],
    finishreason: 'stop',
    usage: {
      input_tokens: 12,
      input_tokens_details: {
        cached_tokens: 4,
        private_counter: 99,
      },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 21,
      server_tool_use: { web_search_requests: 1 },
      provider_private_usage: 'must not pass through',
    },
  });

  const result = toStructuredTaskResult(task);
  assert.deepEqual(
    result.outputs[0].segments.map(segment => segment.type),
    ['thinking', 'answer', 'thinking', 'answer'],
  );
  assert.equal(result.outputs[0].finishreason, 'stop');
  assert.deepEqual(result.outputs[0].usage, {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 9,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 21,
    server_tool_use: { web_search_requests: 1 },
  });
  assert.equal(Object.hasOwn(result.outputs[0], 'malformed'), false);
  assert.equal(result.outputs[0].text, 'First second.');
  assert.equal(result.response, 'First second.');

  const formatted = formatTaskResult(task);
  assert.doesNotMatch(formatted, /raw debug transport/);
  assert.match(formatted, /Finish reason:\*\* `stop`/);
  assert.match(formatted, /Token usage:\*\* 12 input, 9 output, 21 total/);
  assert.ok(formatted.indexOf('Consider the request.')
    < formatted.indexOf('First'));
  assert.ok(formatted.indexOf('First')
    < formatted.indexOf('Check the result.'));
});

test('function calls retain stable IDs and return ordinary continuation params', () => {
  const task = taskWithContent({
    segments: [{
      type: 'function_call',
      id: 'fc_01',
      call_id: 'call_01',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
      status: 'completed',
      provider_private_state: 'must not pass through',
    }],
    finishreason: 'tool_calls',
  }, {
    parameters: { session_id: 'weather-session' },
  });

  const result = toStructuredTaskResult(task);
  assert.deepEqual(result.outputs[0].segments, [{
    type: 'function_call',
    id: 'fc_01',
    call_id: 'call_01',
    name: 'get_weather',
    arguments: '{"city":"Paris"}',
    status: 'completed',
  }]);
  assert.equal(result.response, undefined);
  assert.equal(result.outputs[0].text, undefined);
  assert.equal(
    Object.hasOwn(result.outputs[0].segments[0], 'provider_private_state'),
    false,
  );
  assert.deepEqual(result.nextAction.arguments, {
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

  const formatted = formatTaskResult(task);
  assert.match(formatted, /Function call:\*\* `get_weather`/);
  assert.match(formatted, /Call ID:\*\* `call_01`/);
  assert.match(formatted, /\{"city":"Paris"\}/);
  assert.doesNotMatch(formatted, /raw debug transport/);
});

test('custom tool calls expose input and continuation call IDs', () => {
  const result = toStructuredTaskResult(taskWithContent({
    segments: [{
      type: 'custom_tool_call',
      id: 'ct_01',
      call_id: 'call_custom_01',
      name: 'shell_grammar',
      input: 'status --short',
      status: 'completed',
    }],
    finishreason: 'tool_calls',
  }));

  assert.deepEqual(result.outputs[0].segments, [{
    type: 'custom_tool_call',
    id: 'ct_01',
    call_id: 'call_custom_01',
    name: 'shell_grammar',
    input: 'status --short',
    status: 'completed',
  }]);
  assert.deepEqual(
    result.nextAction.arguments.params.toolOutputs,
    [{ call_id: 'call_custom_01', output: '<tool result>' }],
  );
});

test('one malformed segment rejects the full ordered snapshot', () => {
  const task = taskWithContent({
    raw: 'signed raw transport must not become public output',
    segments: [
      { type: 'answer', text: 'Do not partially trust this.' },
      {
        type: 'function_call',
        id: 'fc_01',
        call_id: 'call_01',
        name: 'get_weather',
        arguments: { city: 'Paris' },
        status: 'completed',
        provider_private_state: 'must not pass through',
      },
    ],
    finishreason: 'tool_calls',
  });

  const result = toStructuredTaskResult(task);
  assert.equal(result.outputs[0].segments, undefined);
  assert.equal(Object.hasOwn(result.outputs[0], 'malformed'), false);
  assert.equal(result.outputs[0].finishreason, undefined);
  assert.equal(result.outputs[0].text, undefined);
  assert.equal(result.response, undefined);
  assert.equal(result.nextAction, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /provider_private_state|signed raw transport|raw debug transport/,
  );

  const formatted = formatTaskResult(task);
  assert.match(formatted, /could not be validated and was omitted/);
  assert.doesNotMatch(
    formatted,
    /provider_private_state|signed raw transport|raw debug transport/,
  );
});

test('final tool calls require the matching finish reason', () => {
  const result = toStructuredTaskResult(taskWithContent({
    segments: [{
      type: 'function_call',
      id: 'fc_01',
      call_id: 'call_01',
      name: 'get_weather',
      arguments: '{}',
      status: 'completed',
    }],
    finishreason: 'stop',
  }));

  assert.equal(result.outputs[0].segments, undefined);
  assert.equal(Object.hasOwn(result.outputs[0], 'malformed'), false);
  assert.equal(result.response, undefined);
  assert.equal(result.nextAction, undefined);
});

test('non-array and oversized typed projections fail closed privately', () => {
  const invalidSegments = [
    { type: 'answer', text: 'not an array' },
    Array.from(
      { length: 1025 },
      (_, index) => ({ type: 'answer', text: `segment-${index}` }),
    ),
  ];

  for (const segments of invalidSegments) {
    const content = {
      raw: 'signed raw transport must stay private',
      segments,
      finishreason: 'stop',
    };
    assert.equal(Object.hasOwn(content, 'malformed'), false);

    const task = taskWithContent(content, {
      debugoutput: 'debug transport must stay private',
    });
    const result = toStructuredTaskResult(task);
    const output = result.outputs[0];

    assert.equal(Object.hasOwn(output, 'malformed'), false);
    assert.equal(output.text, undefined);
    assert.equal(output.segments, undefined);
    assert.equal(output.finishreason, undefined);
    assert.equal(output.usage, undefined);
    assert.equal(result.response, undefined);
    assert.equal(result.nextAction, undefined);
    assert.doesNotMatch(
      JSON.stringify(result),
      /signed raw transport|debug transport/,
    );

    const formatted = formatTaskResult(task);
    assert.doesNotMatch(
      formatted,
      /signed raw transport|debug transport/,
    );
  }
});

test('ordinary legacy task content keeps generic compatibility fallbacks', () => {
  const task = taskWithContent({
    raw: 'Legacy raw response.',
    thinking: ['Legacy thought.'],
    answer: ['Legacy', 'answer.'],
  }, {
    debugoutput: 'Legacy debug compatibility response.',
  });

  const result = toStructuredTaskResult(task);
  assert.equal(result.response, 'Legacy debug compatibility response.');
  assert.equal(result.outputs[0].text, 'Legacy\nanswer.');
  assert.equal(result.outputs[0].segments, undefined);
  assert.equal(Object.hasOwn(result.outputs[0], 'malformed'), false);

  const formatted = formatTaskResult(task);
  assert.match(formatted, /Legacy debug compatibility response/);
  assert.match(formatted, /Legacy thought/);
  assert.match(formatted, /\*\*Answer:\*\*/);
  assert.match(formatted, /Legacy\nanswer\./);
});

test('tasks without typed segments keep normal debug output compatibility', () => {
  const result = toStructuredTaskResult(taskWithContent(undefined, {
    outputs: [],
    debugoutput: 'Normal non-tool model response.',
  }));

  assert.equal(result.response, 'Normal non-tool model response.');
  assert.deepEqual(result.outputs, []);
});
