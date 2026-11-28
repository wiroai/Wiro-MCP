import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { fileLimit, formatModelSchema } from '../dist/utils/format.js';
import { toStructuredModelDetail } from '../dist/utils/structured.js';
import { modelDetailOutputSchema } from '../dist/tools/schemas.js';

// get_model_schema tells how many files a file field takes: maxFiles, from the field's
// maxinputlength, and maxFilesByOption, the choices of another field that raise it (Wiro's run
// takes the chosen option's `<id>Count` when it is higher). A run with more files is refused.

function model(items) {
  return {
    cleanslugowner: 'acme',
    cleanslugproject: 'files',
    title: 'acme/files',
    categories: ['tool'],
    parameters: [{ title: '', items }],
    dynamicprice: '[{"inputs":{},"price":0.04,"priceMethod":"per-run"}]',
    approximatelycost: 0,
    cps: 0,
  };
}

const items = detail => detail.model.parameters.flatMap(group => group.items);

test('a file field with a limit gets maxFiles, and the text says it', () => {
  // klingai/kling-image-v4-long: productImages takes 3.
  const kling = model([
    { id: 'prompt', type: 'textarea', label: 'Prompt', maxinputlength: null },
    { id: 'productImages', type: 'combinefileinput', label: 'Product Images', maxinputlength: 3 },
    { id: 'styleImage', type: 'combinefileinput', label: 'Style', maxinputlength: 1 },
  ]);
  const detail = toStructuredModelDetail(kling);
  assert.equal(items(detail).find(item => item.id === 'productImages').maxFiles, 3);
  assert.equal(items(detail).find(item => item.id === 'styleImage').maxFiles, 1);
  assert.equal('maxFiles' in items(detail).find(item => item.id === 'prompt'), false);
  assert.equal(items(detail).some(item => 'maxFilesByOption' in item), false);

  const text = formatModelSchema(kling);
  assert.match(text, /- \*\*`productImages`\*\* \(combinefileinput\)\n {2}Product Images\n {2}Pass an array of URLs directly: [^\n]+\n {2}At most 3 files\. More is refused\./);
  assert.match(text, /At most 1 file\. More is refused\./);
  assert.doesNotThrow(() => z.object(modelDetailOutputSchema).parse(detail));
});

test('an option that lets the field take more files is listed with it', () => {
  // wiro/product-studio: one image, two for the effect that takes a second one.
  const studio = model([
    { id: 'inputImage', type: 'combinefileinput', label: 'Images', maxinputlength: 1 },
    {
      id: 'effectType',
      type: 'selectwithcover',
      label: 'Effect',
      options: [
        { value: 'product-360', text: 'Product 360', inputImageCount: 2 },
        { value: 'ghost-mannequin', text: 'Ghost Mannequin', inputImageCount: 1 },
        { value: 'studio', text: 'Studio' },
      ],
    },
  ]);
  const detail = toStructuredModelDetail(studio);
  const field = items(detail).find(item => item.id === 'inputImage');
  assert.equal(field.maxFiles, 1);
  assert.deepEqual(field.maxFilesByOption, [{ parameter: 'effectType', value: 'product-360', maxFiles: 2 }]);
  // A workflow step takes the field's own limit whatever the choice (Wiro's Workflow/Prepare): the raise is for a run.
  assert.match(formatModelSchema(studio), /At most 1 file; a run takes 2 files when `effectType` is `product-360`\. A workflow step takes 1 file whatever the choice\. More is refused\./);
  assert.doesNotThrow(() => z.object(modelDetailOutputSchema).parse(detail));
});

test('no limit, a limit on a field that holds no files, and the old misspelled key give nothing', () => {
  const none = (item, all = [item]) => fileLimit(item, all);
  assert.deepEqual(none({ id: 'inputImage', type: 'combinefileinput' }), {});
  for (const value of [null, '', 0, -2, 'many']) assert.deepEqual(none({ id: 'inputImage', type: 'combinefileinput', maxinputlength: value }), {});
  // An LLM's messages list has a limit of its own, which is no file limit.
  assert.deepEqual(none({ id: 'messages', type: 'json-array', maxinputlength: 4096 }), {});
  assert.deepEqual(none({ id: 'inputImage', type: 'combinefileinput', ['maxinput' + 'lenght']: 2 }), {});
  // The text form of a number counts, as the run reads it; every file type the run counts gets it.
  assert.deepEqual(none({ id: 'inputImage', type: 'combinefileinput', maxinputlength: '2' }), { maxFiles: 2 });
  for (const type of ['fileinput', 'multifileinput', 'multifileinputdrop']) assert.deepEqual(none({ id: 'f', type, maxinputlength: 1 }), { maxFiles: 1 });
  // An option count at or under the field's own limit raises nothing.
  const field = { id: 'inputImage', type: 'combinefileinput', maxinputlength: 4 };
  assert.deepEqual(none(field, [field, { id: 'mode', type: 'select', options: [{ value: 'a', inputImageCount: 2 }, { value: 'b', inputImageCount: 4 }] }]), { maxFiles: 4 });
});
