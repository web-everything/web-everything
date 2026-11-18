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

  it('fails with a typed error naming the limit when output exceeds it', () => {
    const script = `const l = 'y'.repeat(1023) + '\\n'; for (let i = 0; i < 270 * 1024; i++) process.stdout.write(l);`;
    expect(() => runCliToFile('node', ['-e', script])).toThrow(/MAX_OUTPUT_BYTES/);
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

describe('renderComponents batch-splitting recovery on the runner output limit', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { renderComponents, FUI_CLI_RELATIVE } = require('../component-render-build-hook.cjs');
  const { CliBatchError, MAX_OUTPUT_BYTES, isOutputLimitError } = require('../run-cli-batch.cjs');

  function withStubFui(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'we-fui-stub-'));
    const cli = path.join(root, FUI_CLI_RELATIVE);
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '');
    const prev = process.env.WE_FUI_ROOT;
    process.env.WE_FUI_ROOT = root;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.WE_FUI_ROOT;
      else process.env.WE_FUI_ROOT = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const limitError = () =>
    new CliBatchError('[cli-batch] node wrote too much stdout (MAX_OUTPUT_BYTES)', {
      reason: 'output-limit', size: MAX_OUTPUT_BYTES + 1, limit: MAX_OUTPUT_BYTES,
    });

  // A runner that overflows the limit whenever it is handed more than `maxEntries` specs.
  const overflowingRunner = (maxEntries, calls) => (_cmd, _args, opts) => {
    const entries = JSON.parse(opts.input);
    calls.push(entries.length);
    if (entries.length > maxEntries) throw limitError();
    return JSON.stringify({
      producer: 'frontierui/component-render-build-harness/1',
      results: entries.map((e) => ({ key: e.key, html: `<x>${e.key}</x>` })),
    });
  };
  const specs = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, component: 'badge', config: {} }));

  it('isOutputLimitError recognises the typed limit error and not other CliBatchErrors', () => {
    expect(isOutputLimitError(limitError())).toBe(true);
    expect(isOutputLimitError(new CliBatchError('boom', { status: 3 }))).toBe(false);
    expect(isOutputLimitError(new Error('x'))).toBe(false);
    expect(isOutputLimitError(null)).toBe(false);
  });

  it('splits an over-limit batch and merges every key (no abort)', () => {
    const calls = [];
    const out = withStubFui(() => renderComponents(specs(2), '/unused', overflowingRunner(1, calls)));
    expect([...out.keys()].sort()).toEqual(['k0', 'k1']);
    expect(calls).toEqual([2, 1, 1]);
  });

  it('still hard-errors with the typed limit error when a single spec overflows alone', () => {
    const calls = [];
    expect(() => withStubFui(() => renderComponents(specs(1), '/unused', overflowingRunner(0, calls)))).toThrow(
      /MAX_OUTPUT_BYTES/,
    );
    expect(calls).toEqual([1]);
  });

  it('does not split on an unrelated runner failure', () => {
    const runner = () => { throw new CliBatchError('[cli-batch] node exited with status 3', { status: 3 }); };
    expect(() => withStubFui(() => renderComponents(specs(2), '/unused', runner))).toThrow(/status 3/);
  });
});
