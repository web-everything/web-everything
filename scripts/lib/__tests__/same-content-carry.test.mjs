import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The guarantees themselves use node:test; this adapter keeps the host heavy queue's Vitest entry point.
it('same-content classifier, carry and hostile-history integration (node:test, real git)', () => {
  try { execFileSync(process.execPath, ['--test', join(dirname(fileURLToPath(import.meta.url)), 'same-content-carry.cases.mjs')], {
    encoding: 'utf8', env: process.env, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  }); } catch (error) {
    throw new Error(`${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`);
  }
}, 185000);
