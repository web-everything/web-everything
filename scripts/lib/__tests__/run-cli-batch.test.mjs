/**
 * @file run-cli-batch.test.mjs
 * @description The build-hook default runner must survive child output far above spawnSync's pipe
 *   maxBuffer (ENOBUFS regression on the docs smoke build) and fail with a typed error on child failure.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runCliToFile, CliBatchError } = require('../run-cli-batch.cjs');

describe('runCliToFile', () => {
  it('returns >100 MB of child stdout without ENOBUFS and feeds stdin', () => {
    const script = `
      const chunks = []; process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        const tag = Buffer.concat(chunks).toString();
        const line = 'x'.repeat(1023) + '\\n';
        for (let i = 0; i < 110 * 1024; i++) process.stdout.write(line);
        process.stdout.write(tag);
      });`;
    const out = runCliToFile('node', ['-e', script], { input: 'TAIL-MARKER' });
    expect(out.length).toBeGreaterThan(100 * 1024 * 1024);
    expect(out.endsWith('TAIL-MARKER')).toBe(true);
  }, 60000);

  it('throws a typed error on non-zero exit', () => {
    expect(() => runCliToFile('node', ['-e', 'process.exit(3)'])).toThrow(CliBatchError);
    try {
      runCliToFile('node', ['-e', 'process.exit(3)']);
    } catch (e) {
      expect(e.code).toBe('E_CLI_BATCH');
      expect(e.status).toBe(3);
    }
  });
});
