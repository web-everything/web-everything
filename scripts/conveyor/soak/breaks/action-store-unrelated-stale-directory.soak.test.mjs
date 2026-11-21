import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b from './action-store-unrelated-stale-directory.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('resource-scoped stale-directory replay', () => {
  // A regressed current tree must fail, even if fixPresent would mark the historical replay expected-fail.
  it('allows unrelated corrupt history while preserving own-resource refusal and retry fencing', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });

  it.each(['global-scan', 'skip-own-history'])('rejects the %s regression behaviorally', (regression) => {
    const dir = mkdtempSync(join(tmpdir(), 'action-store-regression-'));
    try {
      mkdirSync(join(dir, 'scripts/operations'), { recursive: true });
      const source = new URL('../../../operations/action-store.mjs', import.meta.url).href;
      writeFileSync(join(dir, 'scripts/operations/action-store.mjs'), `
        import { createActionStore as realStore } from ${JSON.stringify(source)};
        export { CoordinationUnavailableError } from ${JSON.stringify(source)};
        export function createActionStore(options) {
          const store = realStore(options);
          const claim = store.claim;
          store.claim = args => {
            ${regression === 'global-scan'
              ? 'store.list(); return claim(args);'
              : "if (args.resource.endsWith('#pr:2345')) return { ok: true }; return claim(args);"}
          };
          return store;
        }
      `);
      expect(b.fixPresent(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
