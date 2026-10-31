import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatModelList,
  formatModelSchema,
  formatPricing,
  formatTaskList,
  formatTaskPending,
  formatTaskResult,
} from '../dist/utils/format.js';
import {
  createTaskContent,
  toStructuredModel,
  toStructuredModelDetail,
} from '../dist/utils/structured.js';

test('formatTaskResult renders image outputs directly in chat', () => {
  const text = formatTaskResult({
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_postprocess_end',
    pexit: '0',
    debugoutput: '',
    starttime: '',
    endtime: '',
    elapsedseconds: '4',
    totalcost: '0.01',
    outputs: [{
      name: 'result.png',
      contenttype: 'image/png',
      size: '2048',
      url: 'https://cdn.example/result.png',
    }],
  });

  assert.match(text, /\*\*Result:\*\* Success/);
  assert.match(text, /!\[result\.png\]\(https:\/\/cdn\.example\/result\.png\)/);
  assert.match(text, /\[Open image\]\(https:\/\/cdn\.example\/result\.png\)/);
});

test('completed media asks the assistant to present resource links to the user', () => {
  const content = createTaskContent('Task complete.', {
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_postprocess_end',
    pexit: '0',
    debugoutput: '',
    starttime: '',
    endtime: '',
    elapsedseconds: '4',
    totalcost: '0.01',
    outputs: [{
      name: 'result.png',
      contenttype: 'image/png',
      size: '2048',
      url: 'https://cdn.example/result.png',
    }],
  });

  const deliveryInstruction = content.find(block => block.type === 'text'
    && block.annotations?.audience?.includes('assistant'));
  const media = content.find(block => block.type === 'resource_link');

  assert.match(deliveryInstruction?.text ?? '', /Present every generated media output/);
  assert.deepEqual(deliveryInstruction?.annotations, {
    audience: ['assistant'],
    priority: 1,
  });
  assert.equal(media?.uri, 'https://cdn.example/result.png');
  assert.match(media?.description ?? '', /Present this media/);
  assert.deepEqual(media?.annotations, {
    audience: ['user', 'assistant'],
    priority: 1,
  });
});

test('running tasks do not ask the assistant to present unfinished media', () => {
  const content = createTaskContent('Task running.', {
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_start',
    pexit: '',
    debugoutput: '',
    starttime: '',
    endtime: '',
    elapsedseconds: '4',
    totalcost: '0.01',
    outputs: [],
  });

  assert.equal(content.some(block => block.type === 'text'
    && block.annotations?.audience?.includes('assistant')), false);
});

test('formatTaskResult keeps DB task_error non-terminal', () => {
  const text = formatTaskResult({
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_error',
    pexit: '',
    debugoutput: '',
    debugerror: 'User has no output folder',
    starttime: '',
    endtime: '',
    elapsedseconds: '0',
    totalcost: '0',
    outputs: [],
  });

  assert.doesNotMatch(text, /\*\*Result:\*\*/);
  assert.match(text, /User has no output folder/);
});

test('formatTaskPending tells the assistant to resume instead of rerun', () => {
  const text = formatTaskPending({
    taskid: '123',
    tasktoken: 'task-token',
    status: 'task_start',
    timeoutSeconds: 45,
  });

  assert.match(text, /wait_for_task/);
  assert.match(text, /Do not call `run_model` again/);
  assert.match(text, /task-token/);
});

test('formatTaskResult shows the task token and what the wallet was charged', () => {
  const base = {
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_postprocess_end',
    pexit: '0',
    debugoutput: 'Hello',
    starttime: '',
    endtime: '',
    elapsedseconds: '2',
    totalcost: '0.05',
    outputs: [],
  };
  assert.match(formatTaskResult(base), /\*\*Task Token:\*\* task-token/);
  // A successful task reads as finished a moment before its charge is recorded.
  assert.match(formatTaskResult(base), /\*\*Cost:\*\* \$0\.05 list price; the charged amount is not recorded yet$/m);
  assert.match(formatTaskResult({ ...base, chargedcost: null }), /\$0\.05 list price; the charged amount is not recorded yet/);
  assert.match(formatTaskResult({ ...base, chargedcost: '0.0400000' }), /\*\*Cost:\*\* \$0\.04 charged \(list price \$0\.05\)/);
  assert.match(formatTaskResult({ ...base, chargedcost: '0.05' }), /\*\*Cost:\*\* \$0\.05$/m);
  assert.match(formatTaskResult({ ...base, pexit: '1', chargedcost: '0' }), /\*\*Cost:\*\* \$0 \(not charged\)/);
  // A cancelled task can still be charged when work it had started ends.
  const cancelled = formatTaskResult({ ...base, status: 'task_cancel', pexit: '', chargedcost: '0' });
  assert.match(cancelled, /\*\*Cost:\*\* no charge recorded yet/);
  assert.doesNotMatch(cancelled, /not charged/);
});

test('formatTaskResult calls a task cancelled while queued free, and only that one', () => {
  const cancelled = {
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: {},
    status: 'task_cancel',
    pexit: '',
    debugoutput: '',
    starttime: '0',
    endtime: '',
    elapsedseconds: '0',
    totalcost: '0.05',
    chargedcost: '0',
    outputs: [],
  };
  // No worker took it, so it never ran.
  assert.match(formatTaskResult({ ...cancelled, accepttime: '0' }), /\*\*Cost:\*\* \$0 \(cancelled while queued, not charged\)$/m);
  assert.match(formatTaskResult({ ...cancelled, accepttime: 0, chargedcost: undefined }), /\*\*Cost:\*\* \$0 \(cancelled while queued, not charged\)$/m);
  // Stopped after a worker took it, even before it started: a charge can still come.
  const running = formatTaskResult({ ...cancelled, accepttime: '1761700000' });
  assert.match(running, /\*\*Cost:\*\* no charge recorded yet/);
  assert.doesNotMatch(running, /not charged/);
  // A row without accepttime is never shown as free.
  const missing = formatTaskResult(cancelled);
  assert.match(missing, /\*\*Cost:\*\* no charge recorded yet/);
  assert.doesNotMatch(missing, /not charged/);
  // A charge Wiro reports still shows.
  assert.match(formatTaskResult({ ...cancelled, accepttime: '0', chargedcost: '0.05' }), /\*\*Cost:\*\* \$0\.05$/m);
});

test('formatTaskList keeps history concise and points to get_task', () => {
  const text = formatTaskList([{
    id: '123',
    socketaccesstoken: 'task-token',
    parameters: { prompt: 'must not be rendered' },
    status: 'task_postprocess_end',
    pexit: '0',
    debugoutput: 'must not be rendered',
    starttime: '2026-08-01T10:00:00Z',
    endtime: '2026-08-01T10:00:04Z',
    elapsedseconds: '4',
    totalcost: '0.01',
    modelslugowner: 'owner',
    modelslugproject: 'model',
    outputs: [{
      name: 'result.png',
      contenttype: 'image/png',
      size: '2048',
      url: 'https://cdn.example/result.png',
    }],
  }], 1, 0);

  assert.match(text, /Task History \(1 total\)/);
  assert.match(text, /owner\/model/);
  assert.match(text, /get_task/);
  assert.doesNotMatch(text, /must not be rendered/);
});

// A catalog row with its price fields as Tool/Detail returns them.
function catalogModel(slug, dynamicprice) {
  const [owner, project] = slug.split('/');
  return {
    cleanslugowner: owner,
    cleanslugproject: project,
    title: slug,
    categories: ['tool'],
    parameters: null,
    dynamicprice,
    approximatelycost: 0,
    cps: 0,
  };
}

const searchPricingLine = model => formatModelList([model])
  .split('\n')
  .find(line => line.startsWith('- **Pricing:**'));

// The Pricing section, up to the next section (Parameters or Usage).
function schemaPricing(model) {
  const text = formatModelSchema(model);
  const start = text.indexOf('### Pricing');
  return text.slice(start, text.indexOf('\n### ', start)).trim();
}

const NANO_NOTE = 'Pricing is token-based: input $0.2 per 1M tokens, output $1.25 per 1M tokens. Image inputs are billed as input tokens. If web search is enabled, each search call costs an additional $0.01. Final cost depends on your prompt, attached images, and response length.';

test('a price set when the run ends shows the rates from its note instead of $0', () => {
  const model = catalogModel('openai/gpt-5-4-nano', [{ inputs: {}, price: 0, priceMethod: 'cp-readoutput', note: NANO_NOTE }]);
  const pricing = `Set by the run when it ends: ${NANO_NOTE}`;

  assert.equal(formatPricing(model), pricing);
  assert.equal(searchPricingLine(model), `- **Pricing:** ${pricing}`);
  assert.equal(schemaPricing(model), `### Pricing\n${pricing}`);
  assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /\$0 \/|model-reported|usage-based/);

  const structured = toStructuredModel(model);
  assert.equal(structured.pricing, pricing);
  assert.equal(structured.estimatedCostUsd, null);
  assert.equal(toStructuredModelDetail(model).model.estimatedCostUsd, null);
  assert.deepEqual(toStructuredModelDetail(model).model.pricingNotes, [NANO_NOTE]);

  // The note is shown on one line, without the spaces around it.
  const spaced = catalogModel('openai/gpt-5-4-nano', [{ inputs: {}, price: 0, priceMethod: 'cp-readoutput', note: `\n  ${NANO_NOTE.replace('tokens. Image', 'tokens.\n\n   Image')}  ` }]);
  assert.equal(formatPricing(spaced), pricing);
});

test('a price set when the run ends without a note says the finished task shows the cost', () => {
  for (const note of [undefined, '', '  \n ']) {
    const row = { inputs: {}, price: 0, priceMethod: 'cp-readoutput', ...(note === undefined ? {} : { note }) };
    const model = catalogModel('openai/gpt-5-4-nano', JSON.stringify([row]));
    const pricing = 'Set by the run when it ends. The finished task shows the cost.';

    assert.equal(formatPricing(model), pricing);
    assert.equal(schemaPricing(model), `### Pricing\n${pricing}`);
    assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /\$0/);
    assert.equal(toStructuredModel(model).pricing, pricing);
    assert.equal(toStructuredModel(model).estimatedCostUsd, null);
  }
});

test('a live model is priced by the rates in its note, never as $0 per turn', () => {
  const note = "Voice session $0.05 per minute, billed per second. When the voice model delegates, the backend model's tokens are billed separately at the selected backend model's rate. Each web search costs an additional $0.01.";
  const model = catalogModel('openai/gpt-live-1', [{ inputs: {}, price: 0, priceMethod: 'cp-realtimeturn', note }]);
  const pricing = `Billed turn by turn during the live session. Rates: ${note}`;

  assert.equal(formatPricing(model), pricing);
  assert.equal(searchPricingLine(model), `- **Pricing:** ${pricing}`);
  assert.equal(schemaPricing(model), `### Pricing\n${pricing}`);
  assert.equal(toStructuredModel(model).pricing, pricing);
  assert.equal(toStructuredModelDetail(model).model.pricing, pricing);
  assert.equal(toStructuredModel(model).estimatedCostUsd, null);
  assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /\$0 \/|per turn\b/);

  // Without a note, a live model still has no $0 price.
  const bare = catalogModel('openai/gpt-live-1', JSON.stringify([{ inputs: {}, price: 0, priceMethod: 'cp-realtimeturn' }]));
  assert.equal(formatPricing(bare), 'Billed turn by turn during the live session. No fixed price per run.');
  assert.equal(schemaPricing(bare), '### Pricing\nBilled turn by turn during the live session. No fixed price per run.');
});

const PIXEL_RULES = 'Pixels are counted in blocks of 1024 x 1024 (1,048,576 pixels), and part of a block counts as a whole one: 1000 x 1050 is 2 blocks. Only the first output image is measured.';

test('a model priced by image size shows its extra block and input image prices', () => {
  const model = catalogModel('black-forest-labs/flux-2-max', [
    { inputs: { inputImage: 'QUANTITY:0' }, price: 0.07, priceMethod: 'cp-pixel', priceExtra: 0.03, priceInput: 0 },
    { inputs: { inputImage: 'QUANTITY:1' }, price: 0.07, priceMethod: 'cp-pixel', priceExtra: 0.03, priceInput: 0.03 },
  ]);
  const pricing = '$0.07 per run for an output image up to 1024 x 1024 pixels, plus $0.03 per further 1024 x 1024 block, '
    + 'plus $0.03 per 1024 x 1024 block of each input image (at most 4 blocks per image)';

  assert.equal(formatPricing(model), pricing);
  assert.equal(searchPricingLine(model), `- **Pricing:** ${pricing}`);
  assert.equal(toStructuredModel(model).pricing, pricing);
  assert.equal(toStructuredModelDetail(model).model.pricing, `${pricing}. ${PIXEL_RULES}`);
  assert.equal(schemaPricing(model), [
    '### Pricing (by image size)',
    PIXEL_RULES,
    '- No `inputImage`: $0.07 for the first block of the output image, plus $0.03 for each further block.',
    '- With `inputImage`: $0.07 for the first block of the output image, plus $0.03 for each further block, plus $0.03 per block of each input image, at most 4 blocks ($0.12) per image.',
    '- Example: a 1440 x 1440 output with no input image is 2 blocks, so $0.1.',
  ].join('\n'));
  assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /per pixel|megapixel|qty:/);
  assert.equal(toStructuredModel(model).estimatedCostUsd, null);
  assert.equal(toStructuredModelDetail(model).model.estimatedCostUsd, null);
});

test('a row priced by image size without extra prices shows only the first block', () => {
  for (const extras of [{}, { priceExtra: 0, priceInput: 0 }]) {
    const model = catalogModel('black-forest-labs/flux-2-max', [{ inputs: {}, price: 0.07, priceMethod: 'cp-pixel', ...extras }]);
    const pricing = '$0.07 per run for an output image up to 1024 x 1024 pixels';

    assert.equal(formatPricing(model), pricing);
    assert.equal(toStructuredModel(model).pricing, pricing);
    assert.equal(toStructuredModelDetail(model).model.pricing, `${pricing}. ${PIXEL_RULES}`);
    assert.equal(schemaPricing(model), [
      '### Pricing (by image size)',
      PIXEL_RULES,
      '- Every run: $0.07 for the first block of the output image.',
      '- Example: a 1440 x 1440 output with no input image is 2 blocks, so $0.07.',
    ].join('\n'));
  }
});

test('per-request prices keep their range and table', () => {
  const model = catalogModel('blackforestlabs/flux-3', [
    { inputs: { resolution: 'hd', duration: '5' }, price: 0.85, priceMethod: 'cpr' },
    { inputs: { resolution: 'fhd', duration: '20' }, price: 5.8, priceMethod: 'cpr' },
  ]);

  assert.equal(formatPricing(model), '$0.85 to $5.8 / per request');
  assert.equal(schemaPricing(model), [
    '### Pricing (per request)',
    '| resolution | duration | Price |',
    '| --- | --- | --- |',
    '| hd | 5 | $0.85 |',
    '| fhd | 20 | $5.8 |',
  ].join('\n'));
  assert.equal(toStructuredModel(model).estimatedCostUsd, null);
});

test('a price table shows row values that are numbers', () => {
  const model = catalogModel('ace-step/text-to-song-ace-step1-5', [
    { inputs: { duration: 10 }, price: 0.005, priceMethod: 'cpr' },
    { inputs: { duration: 30 }, price: 0.015, priceMethod: 'cpr' },
  ]);

  assert.equal(formatPricing(model), '$0.005 to $0.015 / per request');
  assert.equal(schemaPricing(model), [
    '### Pricing (per request)',
    '| duration | Price |',
    '| --- | --- |',
    '| 10 | $0.005 |',
    '| 30 | $0.015 |',
  ].join('\n'));
});

test('estimatedCostUsd is a run estimate only when there is one above 0', () => {
  const estimated = { ...catalogModel('qwen/qwen-image-2-1'), approximatelycost: 0.051095 };
  assert.equal(formatPricing(estimated), '~$0.051095 per run (estimated)');
  assert.equal(toStructuredModel(estimated).estimatedCostUsd, 0.051095);

  // A model without finished runs has 0, which is no estimate.
  assert.equal(toStructuredModel(catalogModel('iic/cosyvoice-300m')).estimatedCostUsd, null);

  const { approximatelycost, ...unsent } = catalogModel('qwen/qwen-image-2-1');
  assert.equal('estimatedCostUsd' in toStructuredModel(unsent), false);
});

// One test per price method. Rows the run bills by their own price print as in
// 1.4.0; their notes are added.
test('per-request, per-output and per-video-second prices print as before, with the notes of their rows', () => {
  const nano = catalogModel('google/nano-banana-pro', '[{"inputs":{"resolution":"1K"},"price":0.14,"priceMethod":"cpo"},{"inputs":{"resolution":"2K"},"price":0.14,"priceMethod":"cpo"},{"inputs":{"resolution":"4K"},"price":0.24,"priceMethod":"cpo"}]');
  assert.equal(searchPricingLine(nano), '- **Pricing:** $0.14 to $0.24 / per output');
  assert.equal(schemaPricing(nano), '### Pricing (per output)\n| resolution | Price |\n| --- | --- |\n| 1K | $0.14 |\n| 2K | $0.14 |\n| 4K | $0.24 |');

  const avatar = catalogModel('pruna/p-video-avatar', '[{"inputs":{"resolution":"720p"},"price":0.025,"priceMethod":"cp-outputVideoLength"},{"inputs":{"resolution":"1080p"},"price":0.045,"priceMethod":"cp-outputVideoLength"}]');
  assert.equal(searchPricingLine(avatar), '- **Pricing:** $0.025 to $0.045 / per video second');
  assert.equal(schemaPricing(avatar), '### Pricing (per video second)\n| resolution | Price |\n| --- | --- |\n| 720p | $0.025 |\n| 1080p | $0.045 |');

  // Notes that differ by row get a column, as the model's page shows them.
  const mesh = catalogModel('tencent/hunyuan3d-2-1', '[{"inputs":{"generate_texture":"true"},"price":0.9,"priceMethod":"cpr","note":"$0.9 for textured mesh"},{"inputs":{"generate_texture":"false"},"price":0.3,"priceMethod":"cpr","note":"$0.30 for untextured white mesh."}]');
  assert.equal(searchPricingLine(mesh), '- **Pricing:** $0.3 to $0.9 / per request');
  assert.equal(schemaPricing(mesh), [
    '### Pricing (per request)',
    '| generate_texture | Price | Note |',
    '| --- | --- | --- |',
    '| true | $0.9 | $0.9 for textured mesh |',
    '| false | $0.3 | $0.30 for untextured white mesh. |',
  ].join('\n'));
  assert.deepEqual(toStructuredModelDetail(mesh).model.pricingNotes, ['$0.9 for textured mesh', '$0.30 for untextured white mesh.']);

  // A $0 request price is the charge, and its note follows it.
  const free = catalogModel('xiaomimimo/mimo-2-5-tts', '[{"inputs":{},"price":0,"priceMethod":"cpr","note":"Xiaomi currently offers this model for free. Price might change"}]');
  assert.equal(searchPricingLine(free), '- **Pricing:** $0 / per request');
  assert.equal(schemaPricing(free), '### Pricing (per request)\n$0 / per request\nNote: Xiaomi currently offers this model for free. Price might change');
  assert.equal(toStructuredModel(free).pricing, '$0 / per request');

  // A note shared by every row is shown once, after the table.
  const shared = catalogModel('acme/video', [
    { inputs: { resolution: '720p' }, price: 0.1, priceMethod: 'cpr', note: 'Same | note.' },
    { inputs: { resolution: '1080p' }, price: 0.2, priceMethod: 'cpr', note: 'Same | note.' },
  ]);
  assert.equal(schemaPricing(shared), '### Pricing (per request)\n| resolution | Price |\n| --- | --- |\n| 720p | $0.1 |\n| 1080p | $0.2 |\n\nNote: Same | note.');
  assert.equal('pricingNotes' in toStructuredModelDetail(nano).model, false);
});

test('a price per second of run time says so', () => {
  const model = catalogModel('acme/upscaler', [{ inputs: {}, price: 0.0006, priceMethod: 'cps' }]);
  assert.equal(formatPricing(model), '$0.0006 / per second of run time');
  assert.equal(schemaPricing(model), '### Pricing (per second of run time)\n$0.0006 / per second of run time');
});

test('a price per token says input and output tokens count together, with its note', () => {
  const model = catalogModel('google/gemini-2-5-tts', '[{"inputs":{},"price":0.00001,"priceMethod":"cpt","note":"Final costs are determined after the task is finished. Cost per token is $0.00001"}]');
  const rule = 'Input and output tokens count together, and generated audio counts as output tokens, so the total is known only when the run ends.';

  assert.equal(searchPricingLine(model), '- **Pricing:** $0.00001 / per input and output token');
  assert.equal(schemaPricing(model), [
    '### Pricing (per input and output token)',
    '$0.00001 / per input and output token',
    rule,
    'Note: Final costs are determined after the task is finished. Cost per token is $0.00001',
  ].join('\n'));
  assert.equal(toStructuredModelDetail(model).model.pricing, `$0.00001 / per input and output token. ${rule}`);
});

test('a price per prompt character counts the whole prompt value', () => {
  const rule = 'Every character of the `prompt` value counts, including the brackets, keys and quotes of a JSON prompt.';
  const dialogue = catalogModel('elevenlabs/eleven-v4-dialogue', '[{"inputs":{},"price":0.00008,"priceMethod":"cp-promptlength"}]');
  assert.equal(formatPricing(dialogue), '$0.00008 / per prompt character');
  assert.equal(schemaPricing(dialogue), `### Pricing (per prompt character)\n$0.00008 / per prompt character\n${rule}`);

  // After a table, a blank line keeps the rule out of it.
  const speech = catalogModel('elevenlabs/text-to-speech', '[{"inputs":{"model":"eleven_flash_v2_5"},"price":0.00005,"priceMethod":"cp-promptlength"},{"inputs":{"model":"eleven_flash_v2"},"price":0.00005,"priceMethod":"cp-promptlength"},{"inputs":{"model":"eleven_multilingual_v2"},"price":0.0001,"priceMethod":"cp-promptlength"},{"inputs":{"model":"eleven_v3"},"price":0.0001,"priceMethod":"cp-promptlength"}]');
  assert.equal(formatPricing(speech), '$0.00005 to $0.0001 / per prompt character');
  assert.match(schemaPricing(speech), new RegExp(`\\| eleven_v3 \\| \\$0\\.0001 \\|\\n\\n${rule.replace(/[.`]/g, '\\$&')}$`));
});

test('a price per second of audio names the inputAudio field it measures', () => {
  const music = catalogModel('wiro/video-background-music-v2', '[{"inputs":{},"price":0.008,"priceMethod":"cp-audiosecondslength"}]');
  assert.equal(searchPricingLine(music), '- **Pricing:** $0.008 / per second of audio in inputAudio');
  assert.equal(schemaPricing(music), '### Pricing (per second of audio in inputAudio)\n$0.008 / per second of audio in inputAudio');
});

test('a price by image size gives each row its own extra and input rates', () => {
  const model = catalogModel('black-forest-labs/flux-2-klein-9b', '[{"inputs":{"inputImage":"QUANTITY:0"},"price":0.015,"priceMethod":"cp-pixel","priceExtra":0.015,"priceInput":0},{"inputs":{"inputImage":"QUANTITY:1"},"price":0.015,"priceMethod":"cp-pixel","priceExtra":0.002,"priceInput":0.002}]');
  assert.equal(formatPricing(model), '$0.015 per run for an output image up to 1024 x 1024 pixels, plus $0.002 to $0.015 per further 1024 x 1024 block, plus $0.002 per 1024 x 1024 block of each input image (at most 4 blocks per image)');
  const schema = schemaPricing(model);
  assert.match(schema, /- No `inputImage`: \$0\.015 for the first block of the output image, plus \$0\.015 for each further block\./);
  assert.match(schema, /- With `inputImage`: \$0\.015 for the first block of the output image, plus \$0\.002 for each further block, plus \$0\.002 per block of each input image, at most 4 blocks \(\$0\.008\) per image\./);
  assert.match(schema, /- Example: a 1440 x 1440 output with no input image is 2 blocks, so \$0\.03\.$/);

  // Counts past the first: each row covers the counts up to the next one.
  const counted = catalogModel('acme/edit', [
    { inputs: { inputImage: 'QUANTITY:0' }, price: 0.01, priceMethod: 'cp-pixel' },
    { inputs: { inputImage: 'QUANTITY:1' }, price: 0.02, priceMethod: 'cp-pixel' },
    { inputs: { inputImage: 'QUANTITY:3' }, price: 0.03, priceMethod: 'cp-pixel' },
  ]);
  assert.match(schemaPricing(counted), /- 1 to 2 `inputImage` files: \$0\.02 for the first block of the output image\.\n- 3 or more `inputImage` files: \$0\.03/);
});

test('a price set when the run ends keeps a listed estimate and notes without token rates', () => {
  const omni = catalogModel('google/gemini-omni-flash-r2v', '[{"inputs":{},"price":1.1,"priceMethod":"cp-readoutput","note":"Approximate. Final price is metered from actual token usage (input images/video + generated video length) when the task completes."}]');
  const pricing = 'Set by the run when it ends (listed estimate $1.1): Approximate. Final price is metered from actual token usage (input images/video + generated video length) when the task completes.';
  assert.equal(searchPricingLine(omni), `- **Pricing:** ${pricing}`);
  assert.equal(schemaPricing(omni), `### Pricing\n${pricing}`);
  assert.equal(toStructuredModel(omni).estimatedCostUsd, 1.1);
  assert.equal(toStructuredModelDetail(omni).model.estimatedCostUsd, 1.1);

  // A note with per-second rates, not per-1M token rates, is the price as written.
  const video = catalogModel('pruna/p-video', '[{"inputs":{},"price":0,"priceMethod":"cp-readoutput","note":"The price is calculated per second of output video based on resolution and draft mode: 720p costs $0.02/s (or $0.005/s with draft on), and 1080p costs $0.04/s (or $0.01/s with draft on)."}]');
  assert.equal(formatPricing(video), 'Set by the run when it ends: The price is calculated per second of output video based on resolution and draft mode: 720p costs $0.02/s (or $0.005/s with draft on), and 1080p costs $0.04/s (or $0.01/s with draft on).');
  assert.equal(toStructuredModel(video).estimatedCostUsd, null);
});

const NO_FIXED = 'No fixed price: the charge follows the time the run takes and is set when it ends';

test('rows of an unknown price method show no fixed price, never the method or the row price', () => {
  const tiered = catalogModel('acme/clip', '[{"inputs":{"resolution":"1080P"},"price":0.06,"priceMethod":"cp","note":"Per second $0.06 for 1080P"},{"inputs":{"resolution":"1440P"},"price":0.12,"priceMethod":"cp","note":"Per second $0.12 for 1440P"},{"inputs":{"resolution":"2160P"},"price":0.24,"priceMethod":"cp","note":"Per second $0.24 for 2160P"}]');
  const single = catalogModel('acme/translate', '[{"inputs":{},"price":0.05,"priceMethod":"cp"}]');
  for (const model of [tiered, single]) {
    assert.equal(formatPricing(model), NO_FIXED);
    assert.equal(toStructuredModel(model).pricing, NO_FIXED);
    assert.equal(toStructuredModelDetail(model).model.pricing, NO_FIXED);
    assert.equal(schemaPricing(model), `### Pricing\n${NO_FIXED}.`);
    assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /\/ cp\b|\(cp\)|\$0\.(06|12|24|05)\b|Per second/);
    assert.equal('pricingNotes' in toStructuredModelDetail(model).model, false);
  }

  const mixed = catalogModel('acme/mixed', [
    { inputs: { r: 'a' }, price: 0.1, priceMethod: 'cpr' },
    { inputs: { r: 'b' }, price: 0.2, priceMethod: 'cp' },
  ]);
  assert.equal(formatPricing(mixed), '$0.1 / per request, other settings have no fixed price');
  assert.match(schemaPricing(mixed), /\| a \| \$0\.1 \|\n\| b \| No fixed price, charged for run time \|/);
});

// A model as Tool/Detail returns it, with the settings that its price rows name.
function detailModel(slug, dynamicprice, items) {
  return { ...catalogModel(slug, dynamicprice), parameters: [{ title: '', items }] };
}

test('get_model_schema shows no fixed price when no run can match the price rows', () => {
  // Rows keyed to a setting the model does not have.
  const keyed = detailModel('acme/image','[{"inputs":{"size":"1K"},"price":0.05,"priceMethod":"cpo"},{"inputs":{"size":"2K"},"price":0.085,"priceMethod":"cpo"}]',
    [{ id: 'resolution', type: 'select', label: 'Resolution', required: true, defaultvalue: '1K', optionsLoad: '', options: [{ value: '1K', text: '1K' }, { value: '2K', text: '2K' }] }]);
  // Rows keyed to values the setting does not offer.
  const valued = detailModel('acme/talking-video','[{"inputs":{"resolution":"480P"},"price":0.045,"priceMethod":"cpr"},{"inputs":{"resolution":"580P"},"price":0.07,"priceMethod":"cpr"},{"inputs":{"resolution":"720P"},"price":0.095,"priceMethod":"cpr"}]',
    [{ id: 'resolution', type: 'select', label: 'resolution', defaultvalue: '832*480', optionsLoad: '', options: [{ value: '832*480', text: '480P (16:9)' }, { value: '1280*720', text: '720P (16:9)' }] }]);
  for (const model of [keyed, valued]) {
    assert.equal(schemaPricing(model), `### Pricing\n${NO_FIXED}.`);
    assert.equal(toStructuredModelDetail(model).model.pricing, NO_FIXED);
  }
  // Search rows carry no settings, so they keep the price list.
  assert.equal(formatPricing(keyed), '$0.05 to $0.085 / per output');
  assert.equal(toStructuredModel(keyed).pricing, '$0.05 to $0.085 / per output');
});

test('get_model_schema names the offered values that no price row covers', () => {
  const model = detailModel('acme/song', '[{"inputs":{"duration":10},"price":0.005,"priceMethod":"cpr"},{"inputs":{"duration":30},"price":0.015,"priceMethod":"cpr"},{"inputs":{"duration":60},"price":0.03,"priceMethod":"cpr"},{"inputs":{"duration":90},"price":0.045,"priceMethod":"cpr"},{"inputs":{"duration":120},"price":0.06,"priceMethod":"cpr"},{"inputs":{"duration":180},"price":0.09,"priceMethod":"cpr"}]',
    [{ id: 'duration', type: 'select', label: 'Duration', defaultvalue: '60', optionsLoad: '', options: ['10', '30', '60', '90', '120', '180', '240'].map(value => ({ value, text: value })) }]);
  assert.match(schemaPricing(model), /\| 180 \| \$0\.09 \|\n\nOther values of `duration` \(`240`\): no fixed price; the charge follows the time the run takes\.$/);
  assert.equal(toStructuredModelDetail(model).model.pricing, '$0.005 to $0.09 / per request. Other values of `duration` (`240`): no fixed price; the charge follows the time the run takes.');
  // Search rows carry no settings, so they keep the range alone.
  assert.equal(toStructuredModel(model).pricing, '$0.005 to $0.09 / per request');

  // A row that leaves the key out prices every value of it, unless no run can match that row.
  const typeItem = { id: 'outputType', type: 'select', label: 'Output', optionsLoad: '', options: ['image', 'video'].map(value => ({ value, text: value })) };
  const durationItem = { id: 'duration', type: 'select', label: 'Duration', optionsLoad: '', options: ['5', '10'].map(value => ({ value, text: value })) };
  const effects = detailModel('acme/effects', [{ inputs: { outputType: 'image' }, price: 0.1, priceMethod: 'cpr' }, { inputs: { outputType: 'video', duration: '5' }, price: 0.5, priceMethod: 'cpr' }], [typeItem, durationItem]);
  assert.match(schemaPricing(effects), /\| image \| - \| \$0\.1 \|\n\| video \| 5 \| \$0\.5 \|$/);
  const fallback = detailModel('acme/fallback', [{ inputs: { duration: '5' }, price: 0.5, priceMethod: 'cpr' }, { inputs: {}, price: 0.2, priceMethod: 'cpr' }], [durationItem]);
  assert.doesNotMatch(schemaPricing(fallback), /Other values/);
  const unmatched = detailModel('acme/unmatched', [{ inputs: { size: '1K' }, price: 0.1, priceMethod: 'cpr' }, { inputs: { duration: '5' }, price: 0.5, priceMethod: 'cpr' }], [durationItem]);
  assert.match(schemaPricing(unmatched), /Other values of `duration` \(`10`\)/);

  // Count rows, settings without options and options loaded for each account are not checked.
  const pro = detailModel('black-forest-labs/flux-2-pro', '[{"inputs":{"inputImage":"QUANTITY:0"},"price":0.03,"priceMethod":"cp-pixel","priceExtra":0.015,"priceInput":0},{"inputs":{"inputImage":"QUANTITY:1"},"price":0.03,"priceMethod":"cp-pixel","priceExtra":0.015,"priceInput":0.015}]',
    [{ id: 'inputImage', type: 'combinefileinput', label: 'Input Image', optionsLoad: '' }]);
  assert.match(schemaPricing(pro), /^### Pricing \(by image size\)/);
  const loaded = detailModel('acme/lora', [{ inputs: { selectedModel: '42' }, price: 0.2, priceMethod: 'cpr' }],
    [{ id: 'selectedModel', type: 'select', label: 'Model', optionsLoad: ['LIST:categories=x'], options: [{ value: '7', text: 'Seven' }] }]);
  assert.match(schemaPricing(loaded), /\| 42 \| \$0\.2 \|/);
});

test('a model billed by run time shows its rate', () => {
  // Without its own rate, a run is billed per second of run time at quegroupcps.
  const pixart = { ...catalogModel('wiro/pixart-sigma'), dynamicprice: null, cps: '0.000000000000', quegroupcps: '0.000600000000' };
  assert.equal(searchPricingLine(pixart), '- **Pricing:** $0.0006 per second of run time');
  assert.equal(schemaPricing(pixart), '### Pricing\n- **Rate:** $0.0006 per second of run time');
  assert.equal(toStructuredModel(pixart).estimatedCostUsd, null);

  // An empty price list is billed by run time too; the search line points to
  // get_model_schema, which gives the rate and the estimate.
  const listed = catalogModel('fishaudio/s2-pro', '[]');
  assert.equal(searchPricingLine(listed), '- **Pricing:** per second of run time; `get_model_schema` gives the rate');
  const detail = { ...catalogModel('fishaudio/s2-pro', []), cps: '0.000000000000', quegroupcps: '0.000600000000', approximatelycost: 0.07137073170731707 };
  assert.equal(schemaPricing(detail), '### Pricing\n- **Rate:** $0.0006 per second of run time\n- **Estimated cost:** ~$0.071371 per run');
  assert.equal(toStructuredModelDetail(detail).model.estimatedCostUsd, 0.07137073170731707);

  const own = { ...catalogModel('acme/trainer'), cps: '0.0012' };
  assert.equal(formatPricing(own), '$0.0012 per second of run time');
});

test('a model shows the caller\'s discount when Wiro returns one', () => {
  const rows = '[{"inputs":{"resolution":"1K"},"price":0.14,"priceMethod":"cpo"},{"inputs":{"resolution":"4K"},"price":0.24,"priceMethod":"cpo"}]';
  for (const discount of [20, '20.00']) {
    const model = { ...catalogModel('google/nano-banana-pro', rows), discount };
    assert.match(formatModelList([model]), /- \*\*Pricing:\*\* \$0\.14 to \$0\.24 \/ per output\n- \*\*Your discount:\*\* 20% off the part of a charge paid from deposits\n/);
    assert.match(formatModelSchema(model), /\| 4K \| \$0\.24 \|\n\n\*\*Your discount:\*\* 20% off the part of a charge paid from deposits\. Charges use coupon credit and store revenue first, at the list price\.\n/);
    assert.equal(toStructuredModel(model).discountPercent, 20);
    assert.equal(toStructuredModelDetail(model).model.discountPercent, 20);
    // Prices stay list prices.
    assert.equal(toStructuredModel(model).pricing, '$0.14 to $0.24 / per output');
  }
  for (const discount of [null, undefined, 0, -5, 150, '', 'n/a']) {
    const model = { ...catalogModel('google/nano-banana-pro', rows), discount };
    assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /Your discount/);
    assert.equal('discountPercent' in toStructuredModel(model), false);
  }
});

test('estimatedCostUsd is null whenever there is no positive estimate', () => {
  const kling = catalogModel('klingai/kling-v4', '[{"inputs":{"duration":"5","resolution":"720p"},"price":0.785,"priceMethod":"cpr"},{"inputs":{"duration":"30","resolution":"1080p"},"price":7.05,"priceMethod":"cpr"}]');
  assert.equal(toStructuredModel(kling).estimatedCostUsd, null);
  assert.equal(toStructuredModel(kling).pricing, '$0.785 to $7.05 / per request');
  assert.equal(toStructuredModel({ ...catalogModel('acme/model'), approximatelycost: -1 }).estimatedCostUsd, null);
  assert.equal(toStructuredModel({ ...catalogModel('acme/model'), approximatelycost: 'n/a' }).estimatedCostUsd, null);
  assert.equal(toStructuredModel({ ...catalogModel('qwen/qwen3-8-27b'), approximatelycost: 0.01950320415013732 }).estimatedCostUsd, 0.01950320415013732);
});
