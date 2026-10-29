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

test('text schemas list each option value with its label, and never "undefined"', () => {
  const text = formatModelSchema(model);
  assert.match(text, /Options: `hd` \(HD\), `fhd` \(Full HD\)/);
  assert.match(text, /Options: `vivid` \(Vivid\), `plain`\n/);
  assert.match(text, /Options: `v2\/en_speaker_0` \(\[EN\] Speaker 0 Male\), `v2\/en_speaker_1` \(\[EN\] Speaker 1 Male\)/);
  assert.match(text, /Options: `666` \(someone\/flux-dev-fp8\)/);
  assert.doesNotMatch(text, /undefined/);
});
