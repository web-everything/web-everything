import b from './smoke-failfast-env-checks.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(source) {
  const root = mkdtempSync(join(tmpdir(), 'failfast-presence-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts/lib/daemon-rebuild'), { recursive: true });
  writeFileSync(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs'), source);
  return root;
}

it('presence probe is independent of the replay and its judge', () => {
  vi.spyOn(b, 'run').mockImplementation(() => { throw new Error('must not replay'); });
  vi.spyOn(b, 'judge').mockImplementation(() => { throw new Error('must not judge'); });
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  expect(b.fixPresent(root)).toBe(true);
});

it('recognizes the old broad-stop behavior as missing the fix', () => {
  const root = fixture(`export function budgetedRunChild({runChild}) {
    let stopped = false;
    return async (...args) => {
      if (stopped) throw new Error('skipped: fail-fast');
      try { return await runChild(...args); } catch (e) { stopped = true; throw e; }
    };
  }`);
  expect(b.fixPresent(root)).toBe(false);
});

it('a regression in boot classification still selects a required-pass replay', async () => {
  const root = fixture(`export function budgetedRunChild({runChild}) {
    let stopped = false;
    return async (cmd, args) => {
      if (stopped && cmd === 'node') throw new Error('skipped: fail-fast');
      try { return await runChild(cmd, args); } catch (e) { stopped = true; throw e; }
    };
  }
  export function smokeCheckOfChild(cmd, args) {
    return args[0] === 'scripts/conveyor/reconcile-pass.mjs' ? 'reconcile-dry-run' : null;
  }`);
  for (const name of ['daemon-live-smoke', 'daemon-boot-smoke']) {
    const url = new URL(`../../../lib/${name}.mjs`, import.meta.url).href;
    writeFileSync(join(root, `scripts/lib/${name}.mjs`), `export * from ${JSON.stringify(url)};`);
  }
  expect(b.fixPresent(root)).toBe(true);
  expect(b.judge(await b.run({ sourceRoot: root }))).toEqual(expect.arrayContaining([expect.stringContaining('boot still runs')]));
});

it('presence probe errors throw rather than enabling expected failure', () => {
  const root = fixture('throw new Error("presence probe exploded");');
  expect(() => b.fixPresent(root)).toThrow('presence probe exploded');
});
