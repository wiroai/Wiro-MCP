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

function schemaPricing(model) {
  const text = formatModelSchema(model);
  return text.slice(text.indexOf('### Pricing'), text.indexOf('\n### Usage')).trim();
}

const NANO_NOTE = 'Pricing is token-based: input $0.2 per 1M tokens, output $1.25 per 1M tokens. Image inputs are billed as input tokens. If web search is enabled, each search call costs an additional $0.01. Final cost depends on your prompt, attached images, and response length.';

test('a token-billed model shows the rates from its note instead of $0', () => {
  const model = catalogModel('openai/gpt-5-4-nano', [{ inputs: {}, price: 0, priceMethod: 'cp-readoutput', note: NANO_NOTE }]);
  const pricing = `usage-based: ${NANO_NOTE}`;

  assert.equal(formatPricing(model), pricing);
  assert.equal(searchPricingLine(model), `- **Pricing:** ${pricing}`);
  assert.equal(schemaPricing(model), `### Pricing (usage-based)\n${NANO_NOTE} The price is set from usage when the run completes.`);
  assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /\$0 \/|model-reported/);

  const structured = toStructuredModel(model);
  assert.equal(structured.pricing, pricing);
  assert.equal(structured.estimatedCostUsd, null);
  assert.equal(toStructuredModelDetail(model).model.estimatedCostUsd, null);

  // The note is shown on one line, without the spaces around it.
  const spaced = catalogModel('openai/gpt-5-4-nano', [{ inputs: {}, price: 0, priceMethod: 'cp-readoutput', note: `\n  ${NANO_NOTE.replace('tokens. Image', 'tokens.\n\n   Image')}  ` }]);
  assert.equal(formatPricing(spaced), pricing);
});

test('a token-billed row without a note says the price is set when the run completes', () => {
  for (const note of [undefined, '', '  \n ']) {
    const row = { inputs: {}, price: 0, priceMethod: 'cp-readoutput', ...(note === undefined ? {} : { note }) };
    const model = catalogModel('openai/gpt-5-4-nano', JSON.stringify([row]));

    assert.equal(formatPricing(model), 'usage-based: the price is set from usage when the run completes');
    assert.equal(schemaPricing(model), '### Pricing (usage-based)\nThe price is set from usage when the run completes.');
    assert.doesNotMatch(`${formatModelList([model])}\n${formatModelSchema(model)}`, /\$0/);
    assert.equal(toStructuredModel(model).pricing, 'usage-based: the price is set from usage when the run completes');
    assert.equal(toStructuredModel(model).estimatedCostUsd, null);
  }
});

test('a price-0 row with a note shows the note as its price', () => {
  const note = "Voice session $0.05 per minute, billed per second. When the voice model delegates, the backend model's tokens are billed separately at the selected backend model's rate. Each web search costs an additional $0.01.";
  const model = catalogModel('openai/gpt-live-1', [{ inputs: {}, price: 0, priceMethod: 'cp-realtimeturn', note }]);

  assert.equal(formatPricing(model), note);
  assert.equal(schemaPricing(model), `### Pricing (per turn)\n${note}`);
  assert.equal(toStructuredModel(model).estimatedCostUsd, null);
});

test('a per-megapixel model shows its extra megapixel and input image prices', () => {
  const model = catalogModel('black-forest-labs/flux-2-max', [
    { inputs: { inputImage: 'QUANTITY:0' }, price: 0.07, priceMethod: 'cp-pixel', priceExtra: 0.03, priceInput: 0 },
    { inputs: { inputImage: 'QUANTITY:1' }, price: 0.07, priceMethod: 'cp-pixel', priceExtra: 0.03, priceInput: 0.03 },
  ]);
  const pricing = '$0.07 for the first megapixel of output, +$0.03 per extra megapixel, +$0.03 per input image megapixel';

  assert.equal(formatPricing(model), pricing);
  assert.equal(searchPricingLine(model), `- **Pricing:** ${pricing}`);
  assert.equal(toStructuredModel(model).pricing, pricing);
  assert.equal(
    toStructuredModelDetail(model).model.pricing,
    '$0.07 for the first megapixel of output, +$0.03 per extra megapixel, +$0.03 per megapixel of each input image, up to 4 per image. '
      + 'A megapixel is 1024x1024 pixels, and a started one counts in full: a 2048x2048 image is 4.',
  );
  assert.equal(schemaPricing(model), [
    '### Pricing (per megapixel)',
    '| inputImage | Price |',
    '| --- | --- |',
    '| qty: 0 | $0.07 for the first megapixel of output, +$0.03 per extra megapixel |',
    '| qty: 1 or more | $0.07 for the first megapixel of output, +$0.03 per extra megapixel, +$0.03 per megapixel of each input image, up to 4 per image |',
    '',
    'A megapixel is 1024x1024 pixels, and a started one counts in full: a 2048x2048 image is 4.',
  ].join('\n'));
  assert.doesNotMatch(formatModelSchema(model), /per pixel/);
  assert.equal(toStructuredModel(model).estimatedCostUsd, null);
  assert.equal(toStructuredModelDetail(model).model.estimatedCostUsd, null);
});

test('a per-megapixel row without extra prices shows only the first megapixel', () => {
  for (const extras of [{}, { priceExtra: 0, priceInput: 0 }]) {
    const model = catalogModel('black-forest-labs/flux-2-max', [{ inputs: {}, price: 0.07, priceMethod: 'cp-pixel', ...extras }]);

    assert.equal(formatPricing(model), '$0.07 for the first megapixel of output');
    assert.equal(toStructuredModel(model).pricing, '$0.07 for the first megapixel of output');
    assert.equal(
      toStructuredModelDetail(model).model.pricing,
      '$0.07 for the first megapixel of output. A megapixel is 1024x1024 pixels, and a started one counts in full: a 2048x2048 image is 4.',
    );
    assert.equal(schemaPricing(model), [
      '### Pricing (per megapixel)',
      '$0.07 for the first megapixel of output',
      '',
      'A megapixel is 1024x1024 pixels, and a started one counts in full: a 2048x2048 image is 4.',
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
