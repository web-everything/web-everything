import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The guarantees themselves use node:test; this adapter keeps the host heavy queue's Vitest entry point.
it('same-content classifier and carry integration (node:test, real git)', () => {
  execFileSync(process.execPath, ['--test', join(dirname(fileURLToPath(import.meta.url)), 'same-content-carry.cases.mjs')], {
    encoding: 'utf8', env: process.env, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
  });
}, 95000);
