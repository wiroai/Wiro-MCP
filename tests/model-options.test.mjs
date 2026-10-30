import assert from 'node:assert/strict';
import test from 'node:test';
import { formatModelSchema } from '../dist/utils/format.js';
import { toStructuredModelDetail } from '../dist/utils/structured.js';

// Options as the model detail answer carries them: select rows with
// {value, text} or {value, label}, multiselect rows with {id, name}, and a
// model picker whose options are whole model rows.
const model = {
  cleanslugowner: 'owner',
  cleanslugproject: 'model',
  title: 'Model',
  categories: ['text-to-speech'],
  parameters: [{
    title: '',
    items: [
      { id: 'resolution', type: 'select', label: 'resolution', options: [{ value: 'hd', text: 'HD' }, { value: 'fhd', text: 'Full HD' }] },
      { id: 'style', type: 'select', label: 'style', options: [{ value: 'vivid', label: 'Vivid' }, { value: 'plain', text: 'plain' }] },
      { id: 'speakers', type: 'multiselect', label: 'speakers', options: [{ id: 'v2/en_speaker_0', name: '[EN] Speaker 0 Male' }, { id: 'v2/en_speaker_1', name: '[EN] Speaker 1 Male' }] },
      { id: 'selectedModel', type: 'select', label: 'selected-model', options: [{ id: '666', slugowner: 'someone', slugproject: 'flux-dev-fp8' }] },
    ],
  }],
};

test('structured schemas carry the value Wiro accepts and a label for every option shape', () => {
  const items = toStructuredModelDetail(model).model.parameters[0].items;
  assert.deepEqual(items.map(item => item.options), [
    [{ label: 'HD', value: 'hd' }, { label: 'Full HD', value: 'fhd' }],
    [{ label: 'Vivid', value: 'vivid' }, { label: 'plain', value: 'plain' }],
    [{ label: '[EN] Speaker 0 Male', value: 'v2/en_speaker_0' }, { label: '[EN] Speaker 1 Male', value: 'v2/en_speaker_1' }],
    [{ label: 'someone/flux-dev-fp8', value: '666' }],
  ]);
});

// Tool/Detail sends a parameter's default as defaultvalue and value, and its
// range as minvalue, maxvalue and incrementby text ("" when there is none).
const sampled = {
  cleanslugowner: 'google',
  cleanslugproject: 'nano-banana',
  title: null,
  categories: [],
  parameters: [{
    title: '',
    items: [
      { id: 'inputImage', type: 'combinefileinput', label: 'Input image', defaultvalue: ['https://cdn.wiro.ai/uploads/sampleinputs/a.png'], value: ['https://cdn.wiro.ai/uploads/sampleinputs/a.png'], minvalue: '', maxvalue: '', incrementby: '' },
      { id: 'temperature', type: 'float', label: 'Temperature', defaultvalue: '1', value: '1', minvalue: '0', maxvalue: '1', incrementby: '0.1' },
      { id: 'seed', type: 'text', label: 'Seed', defaultvalue: '', value: '', minvalue: '', maxvalue: '', incrementby: '' },
      { id: 'prompt', type: 'textarea', label: 'Prompt', required: true, defaultvalue: 'A koala in a red shirt', value: 'A koala in a red shirt' },
      { id: 'enhance', type: 'checkbox', label: 'Enhance', defaultvalue: 'false', value: 'true' },
    ],
  }],
};

// A run leaves the prompt and file inputs empty when they are left out, so their
// catalog values are shown as samples, which only a workflow step picks up.
test('schemas show the catalog default and range, and keep samples apart', () => {
  const items = toStructuredModelDetail(sampled).model.parameters[0].items;
  assert.deepEqual([items[0].default, items[0].sample], [undefined, '["https://cdn.wiro.ai/uploads/sampleinputs/a.png"]']);
  assert.deepEqual([items[1].default, items[1].min, items[1].max, items[1].step], ['1', 0, 1, 0.1]);
  assert.deepEqual([items[2].default, items[2].min, items[2].max], [undefined, undefined, undefined]);
  assert.deepEqual([items[3].default, items[3].sample], [undefined, 'A koala in a red shirt']);
  assert.equal(items[4].default, 'true');

  const text = formatModelSchema(sampled);
  assert.match(text, /^## google\/nano-banana\n/);
  assert.match(text, /`inputImage`\*\* \(combinefileinput\) \(sample files on the model's page, used only by a workflow step that leaves it out\)/);
  assert.match(text, /`prompt`\*\* \(textarea\) \*\*\(required\)\*\* \(sample: `A koala in a red shirt`, used only by a workflow step that leaves it out\)/);
  assert.match(text, /`temperature`\*\* \(float\) \(default: `1`\)\n  Temperature\n  Range: 0 to 1, step 0\.1/);
  assert.match(text, /`seed`\*\* \(text\) \(a run picks a random seed when it is left out or 0\)\n/);
});

// A run refuses a required parameter that is left out, picks a random seed, reads a
// checkbox as on or off, checks ranges only on numbers, and turns parallel tool calls
// on whenever tools are sent. Only a workflow step takes the catalog value as it is.
test('schemas say what a run and a workflow step each do with a left-out parameter', () => {
  const llm = {
    cleanslugowner: 'owner',
    cleanslugproject: 'llm',
    title: 'LLM',
    categories: [],
    parameters: [{
      title: '',
      items: [
        { id: 'seed', type: 'text', label: 'Seed', defaultvalue: '123456', value: '123456' },
        { id: 'resolution', type: 'select', label: 'Resolution', required: true, defaultvalue: '1K', value: '1K', minvalue: '0', maxvalue: '0', options: [{ value: '1K', text: '1K' }, { value: '2K', text: '2K' }] },
        { id: 'do_sample', type: 'checkbox', label: 'Sample', defaultvalue: '--do_sample', value: '--do_sample' },
        { id: 'quantize', type: 'checkbox', label: 'Quantize', defaultvalue: '--quantization', value: '' },
        { id: 'parallel_tool_calls', type: 'checkbox', label: 'Parallel tool calls', defaultvalue: 'true', value: 'true' },
        { id: 'color', type: 'text', label: 'Color', defaultvalue: '#FFFFFF', value: '#FFFFFF', minvalue: '0', maxvalue: '0', incrementby: '1' },
      ],
    }],
  };
  const items = Object.fromEntries(toStructuredModelDetail(llm).model.parameters[0].items.map(item => [item.id, item]));
  assert.deepEqual([items.seed.default, items.seed.sample], [undefined, '123456']);
  assert.deepEqual([items.resolution.default, items.resolution.sample, items.resolution.min], [undefined, '1K', undefined]);
  assert.equal(items.do_sample.default, 'true');
  assert.equal(items.quantize.default, 'false');
  assert.deepEqual([items.parallel_tool_calls.default, items.parallel_tool_calls.sample], ['true', undefined]);
  assert.deepEqual([items.color.default, items.color.min, items.color.max, items.color.step], ['#FFFFFF', undefined, undefined, undefined]);

  const text = formatModelSchema(llm);
  assert.match(text, /`seed`\*\* \(text\) \(a run picks a random seed when it is left out or 0; a workflow step that leaves it out gets `123456`\)/);
  assert.match(text, /`resolution`\*\* \(select\) \*\*\(required\)\*\* \(sample: `1K`, used only by a workflow step that leaves it out\)/);
  assert.match(text, /`do_sample`\*\* \(checkbox\) \(default: `true`\)/);
  assert.match(text, /`quantize`\*\* \(checkbox\) \(default: `false`\)/);
  assert.match(text, /`parallel_tool_calls`\*\* \(checkbox\) \(default: `true` when `tools` are sent\)/);
  assert.doesNotMatch(text, /Range/);
});

test('text schemas list each option value with its label, and never "undefined"', () => {
  const text = formatModelSchema(model);
  assert.match(text, /Options: `hd` \(HD\), `fhd` \(Full HD\)/);
  assert.match(text, /Options: `vivid` \(Vivid\), `plain`\n/);
  assert.match(text, /Options: `v2\/en_speaker_0` \(\[EN\] Speaker 0 Male\), `v2\/en_speaker_1` \(\[EN\] Speaker 1 Male\)/);
  assert.match(text, /Options: `666` \(someone\/flux-dev-fp8\)/);
  assert.doesNotMatch(text, /undefined/);
});
