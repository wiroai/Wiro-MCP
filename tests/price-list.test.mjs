import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, PRICE_LIST_META_KEY } from '../dist/server.js';
import { PRICE_LIST_META_KEY as KEY_FROM_TOOLS } from '../dist/tools/index.js';
import { formatModelSchema, priceList } from '../dist/utils/format.js';
import { toStructuredModelDetail } from '../dist/utils/structured.js';

// get_model_schema gives a model's price rows as Wiro bills them in the result's `_meta`, under
// `ai.wiro/priceList`, to a program that prices each setting itself and asks for them with
// `_meta: { "ai.wiro/priceList": true }` in the call's params. Some clients show a result's `_meta` to
// the model, so without the ask there are none, and either way the text and the structured output,
// which assistants read, stay as they were.

const ASK = { 'ai.wiro/priceList': true };

function model(slug, dynamicprice, items = []) {
  const [cleanslugowner, cleanslugproject] = slug.split('/');
  return {
    cleanslugowner,
    cleanslugproject,
    title: slug,
    categories: ['tool'],
    parameters: [{ title: '', items }],
    dynamicprice,
    approximatelycost: 0,
    cps: 0,
  };
}

const select = (id, values, required = false) => ({ id, type: 'select', label: id, required, options: values.map(value => ({ text: value, value })) });

async function callSchema(detail, options, requestMeta) {
  const server = createMcpServer({ getModelSchema: async () => ({ result: true, errors: [], tool: [detail] }) }, options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({
      name: 'get_model_schema',
      arguments: { model: `${detail.cleanslugowner}/${detail.cleanslugproject}` },
      ...(requestMeta === undefined ? {} : { _meta: requestMeta }),
    });
  } finally {
    await client.close();
    await server.close();
  }
}

// What assistants read is the same as without a price list in _meta.
function assertModelOutputUnchanged(result, detail) {
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].text, formatModelSchema(detail));
  assert.equal(JSON.stringify(result.structuredContent), JSON.stringify(toStructuredModelDetail(detail)));
  assert.equal('priceList' in result.structuredContent.model, false);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /priceMethod/);
}

// What 2.2.0 (#35's head, 64366b5) gave for these inputs, made by running its get_model_schema on them.
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/get-model-schema-2.2.0.json', import.meta.url), 'utf8'));

test('the text and the structured output are byte for byte what 2.2.0 gave, with the ask and without it', async () => {
  const withRows = new Set([
    'per-run rows with a discount (Veo 3.1)',
    'per-input-video-second rows with maxSeconds (Kandinsky VSR)',
    'per-output-megapixel rows with notes and extra amounts',
    'per-run rows in the workflows-only tool group',
  ]);
  assert.equal(GOLDEN.cases.length, 6);
  for (const { name, detail, options, content, structuredContent } of GOLDEN.cases) {
    for (const requestMeta of [undefined, ASK]) {
      const label = `${name}, ${requestMeta ? 'asked' : 'not asked'}`;
      const result = await callSchema(detail, options, requestMeta);
      assert.notEqual(result.isError, true, label);
      assert.equal(JSON.stringify(result.content), JSON.stringify(content), label);
      assert.equal(JSON.stringify(result.structuredContent), JSON.stringify(structuredContent), label);
      if (requestMeta && withRows.has(name)) assert.deepEqual(Object.keys(result._meta), [PRICE_LIST_META_KEY], label);
      else assert.equal(result._meta, undefined, label);
    }
  }
});

// google/veo3-1 on prod, 2026-11-28.
const VEO_ROWS = [
  { inputs: { durationSeconds: '4', resolution: '720p' }, price: 1.6, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '6', resolution: '720p' }, price: 2.4, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '8', resolution: '720p' }, price: 3.2, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '4', resolution: '1080p' }, price: 1.6, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '6', resolution: '1080p' }, price: 2.4, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '8', resolution: '1080p' }, price: 3.2, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '4', resolution: '4k' }, price: 2.4, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '6', resolution: '4k' }, price: 3.6, priceMethod: 'per-run' },
  { inputs: { durationSeconds: '8', resolution: '4k' }, price: 4.8, priceMethod: 'per-run' },
];

function veo(discount = null) {
  return {
    ...model('google/veo3-1', VEO_ROWS, [
      { id: 'prompt', type: 'textarea', label: 'Prompt' },
      select('resolution', ['720p', '1080p', '4k']),
      select('durationSeconds', ['4', '6', '8'], true),
    ]),
    title: 'Veo 3.1',
    discount,
  };
}

test('asked, per-run rows come in _meta at list price, and the text and structured output stay as they were', async () => {
  assert.equal(PRICE_LIST_META_KEY, 'ai.wiro/priceList');
  assert.equal(KEY_FROM_TOOLS, PRICE_LIST_META_KEY);
  const detail = veo(20);
  const result = await callSchema(detail, undefined, ASK);
  assert.deepEqual(result._meta, { 'ai.wiro/priceList': VEO_ROWS });
  assert.deepEqual(result._meta[PRICE_LIST_META_KEY].at(-1), { inputs: { durationSeconds: '8', resolution: '4k' }, price: 4.8, priceMethod: 'per-run' });
  // The discount stays out of the rows: discountPercent carries it, as before.
  assert.equal(result.structuredContent.model.discountPercent, 20);
  assert.equal(result.structuredContent.model.pricing, '$1.6 to $4.8 / per run');
  assertModelOutputUnchanged(result, detail);
});

test('per-input-video-second rows keep each row\'s maxSeconds', async () => {
  // kandinskylab/kandinsky-6-0-vsr-2-0 on prod, 2026-11-28. Wiro may send the list as text, and its
  // row model also allows an amount as text, which becomes a number.
  const vsr = model(
    'kandinskylab/kandinsky-6-0-vsr-2-0',
    '[{"inputs":{"resolution":"720p"},"price":0.015,"priceMethod":"per-input-video-second","maxSeconds":60},'
      + '{"inputs":{"resolution":"1080p"},"price":0.025,"priceMethod":"per-input-video-second","maxSeconds":60},'
      + '{"inputs":{"resolution":"2160p"},"price":0.1,"priceMethod":"per-input-video-second","maxSeconds":"20"}]',
    [{ id: 'inputVideo', type: 'combinefileinput', label: 'Input Video', required: true }, select('resolution', ['720p', '1080p', '2160p'], true)],
  );
  const result = await callSchema(vsr, undefined, ASK);
  assert.deepEqual(result._meta[PRICE_LIST_META_KEY], [
    { inputs: { resolution: '720p' }, price: 0.015, priceMethod: 'per-input-video-second', maxSeconds: 60 },
    { inputs: { resolution: '1080p' }, price: 0.025, priceMethod: 'per-input-video-second', maxSeconds: 60 },
    { inputs: { resolution: '2160p' }, price: 0.1, priceMethod: 'per-input-video-second', maxSeconds: 20 },
  ]);
  assert.match(result.structuredContent.model.pricing, /^\$0\.015 to \$0\.1 \/ per second of input video\. .* Each input counts at most 20 or 60 seconds, depending on the settings\.$/);
  assertModelOutputUnchanged(result, vsr);
});

test('a model without price rows gets no _meta, even when asked', async () => {
  for (const dynamicprice of [undefined, null, '', '[]', [], 'not json', '{"price":1}']) {
    const detail = { ...model('acme/run-time', dynamicprice), cps: 0.0005 };
    const result = await callSchema(detail, undefined, ASK);
    assert.equal(result._meta, undefined, JSON.stringify(dynamicprice));
    assertModelOutputUnchanged(result, detail);
  }
});

test('a model used as a workflow step gets its price rows in _meta too, when asked', async () => {
  const detail = veo();
  const result = await callSchema(detail, { toolsets: ['workflows'] }, ASK);
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.nextAction.tool, 'get_playbook');
  assert.deepEqual(result._meta, { [PRICE_LIST_META_KEY]: VEO_ROWS });
  assert.equal((await callSchema(detail, { toolsets: ['workflows'] }))._meta, undefined);
});

test('without the ask, or with anything but true under the key, there are no price rows', async () => {
  const detail = veo();
  for (const requestMeta of [undefined, {}, { progressToken: 7 }, { 'ai.wiro/priceList': 'true' }, { 'ai.wiro/priceList': 1 }, { 'ai.wiro/priceList': false }, { priceList: true }]) {
    const result = await callSchema(detail, undefined, requestMeta);
    assert.equal(result._meta, undefined, JSON.stringify(requestMeta));
    assertModelOutputUnchanged(result, detail);
  }
  assert.deepEqual((await callSchema(detail, undefined, { progressToken: 7, ...ASK }))._meta, { [PRICE_LIST_META_KEY]: VEO_ROWS });
});

test('a row\'s note, extra amounts and counts come as Wiro bills them, and an unreadable list is left out', () => {
  const pixel = model('acme/image', [
    { inputs: { inputImage: 'QUANTITY:0' }, price: 0.03, priceMethod: 'per-output-megapixel', priceExtra: 0.01, priceInput: null, note: '  First block,\n then  each one. ' },
    { inputs: { inputImage: 'QUANTITY:1' }, price: 0.03, priceMethod: 'per-output-megapixel', priceExtra: '0.01', priceInput: 0.005, note: '' },
  ], [{ id: 'inputImage', type: 'combinefileinput', label: 'Images' }]);
  assert.deepEqual(priceList(pixel), [
    { inputs: { inputImage: 'QUANTITY:0' }, price: 0.03, priceMethod: 'per-output-megapixel', note: 'First block, then each one.', priceExtra: 0.01 },
    { inputs: { inputImage: 'QUANTITY:1' }, price: 0.03, priceMethod: 'per-output-megapixel', priceExtra: 0.01, priceInput: 0.005 },
  ]);

  // A row without inputs prices every run; a number stays a number.
  assert.deepEqual(priceList(model('acme/flat', [{ price: 0.2, priceMethod: 'per-run' }, { inputs: { steps: 5 }, price: 0.3, priceMethod: 'per-run' }])), [
    { inputs: {}, price: 0.2, priceMethod: 'per-run' },
    { inputs: { steps: 5 }, price: 0.3, priceMethod: 'per-run' },
  ]);

  // One row that cannot be read as Wiro bills it leaves the whole list out, so no program prices
  // from part of it.
  const good = { inputs: { resolution: '720p' }, price: 1, priceMethod: 'per-run' };
  for (const bad of [
    { ...good, price: '1.6' },
    { ...good, price: null },
    { inputs: {}, price: 1 },
    { ...good, inputs: { resolution: { value: '4k' } } },
    { ...good, inputs: ['720p'] },
    { ...good, priceMethod: 'per-input-video-second', maxSeconds: 'sixty' },
  ]) {
    assert.equal(priceList(model('acme/broken', [good, bad])), undefined, JSON.stringify(bad));
  }
});
