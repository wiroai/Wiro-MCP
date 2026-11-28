import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Wiro names a model parameter item's file limit `maxinputlength` (2026-11-28). The misspelled
// key it replaced is gone from the Wiro API, so neither the code nor the fixtures here name it.
const OLD = 'maxinput' + 'lenght';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('no tracked file names the misspelled maxinputlength key', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
  const found = files.filter(file => {
    let buffer;
    try {
      buffer = readFileSync(resolve(ROOT, file));
    } catch {
      return false;
    }
    if (buffer.length > 32 * 1024 * 1024 || buffer.includes(0)) return false;
    return buffer.toString('utf8').toLowerCase().includes(OLD);
  });
  assert.deepEqual(found, []);
});
