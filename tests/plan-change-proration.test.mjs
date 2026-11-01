import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { estimateProratedUsd, underOneDayLeft } from '../dist/utils/agent-config.js';

// The table holds Wiro's own answers for a plan's price change over a grid. The
// quote has to give the same number, so this is checked against the answers and
// not against a second copy of the sum.
const table = JSON.parse(readFileSync(new URL('./fixtures/plan-change-proration.json', import.meta.url), 'utf8'));
const nowMs = table.now * 1000;

test('a quote gives the same amount as the charge, over the whole grid of a 30-day period', () => {
  let compared = 0;
  table.deltas.forEach((delta, d) => {
    table.secondsLeft.forEach(({ label, value }, s) => {
      assert.equal(estimateProratedUsd(delta, table.now + value, nowMs), table.usd[d][s], `${delta} with ${label} left`);
      compared += 1;
    });
  });
  assert.equal(compared, table.deltas.length * table.secondsLeft.length);
});

test('a rise costs at least one day and a credit is only for the time left, as the table says', () => {
  const row = delta => table.deltas.indexOf(delta);
  const column = label => table.secondsLeft.findIndex(entry => entry.label === label);
  // A rise in a period's last hours, and in the day after its end, costs one day of it, never $0.00.
  for (const label of ['at the end', 'one second left', 'eleven hours', 'under a day', 'exactly a day', 'past the end, 23 hours']) {
    assert.equal(table.usd[row(108)][column(label)], 3.6, label);
  }
  assert.equal(table.usd[row(108)][column('just over a day')], 3.61);
  // A credit has nothing to give back once no time is left.
  for (const label of ['at the end', 'past the end, a second', 'past the end, 23 hours']) {
    assert.equal(table.usd[row(-108)][column(label)], 0, label);
  }
  assert.equal(table.usd[row(-108)][column('the whole period')], -108);
  // Rounded apart: up for a charge and down for a credit, so a pair never gains.
  assert.equal(table.usd[row(29)][column('14.5 days')], 14.02);
  assert.equal(table.usd[row(-29)][column('14.5 days')], -14.01);
});

test('with the real length of the period the sum is the same for any length', () => {
  for (const { days, left, delta, usd } of table.otherLengths) {
    assert.equal(estimateProratedUsd(delta, table.now + left, nowMs, days * 86400), usd, `${delta} with ${left} s left of ${days} days`);
  }
});

test('a period of another length is the one place a quote can differ from the charge', () => {
  // A 28-day period with 14 days left: half the difference, where 30 days give less.
  const row = table.otherLengths.find(entry => entry.days === 28 && entry.left === 14 * 86400 && entry.delta === 108);
  assert.equal(row.usd, 54);
  assert.equal(estimateProratedUsd(108, table.now + 14 * 86400, nowMs), 50.4);
});

test('the one-day minimum is named only with under a day left', () => {
  assert.equal(underOneDayLeft(null, nowMs), false);
  assert.equal(underOneDayLeft(table.now + 86400, nowMs), false);
  assert.equal(underOneDayLeft(table.now + 86400, nowMs + 999), false, 'by whole seconds, as the charge counts them');
  assert.equal(underOneDayLeft(table.now + 86399, nowMs), true);
  assert.equal(underOneDayLeft(table.now, nowMs), true);
  assert.equal(underOneDayLeft(table.now - 3600, nowMs), true);
});
