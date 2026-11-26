import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import b, { probe } from './smoke-dispatch-fix-live-claim-no-prompt.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('passes the real child fix row with a live sentinel claim (unconditional GREEN)', () => {
  const report = b.run();
  expect(b.judge(report)).toEqual([]);
  expect(report.fix).toMatchObject({ kind: 'fix', pr: 900002, ok: true });
});

it('reproduces no prompt captured when the default live claim reader is restored (RED)', () => {
  const { fix } = probe(undefined, { restoreLiveClaimReader: true });
  expect(fix.ok).toBe(false);
  expect(fix.error).toContain('no prompt captured');
  expect(b.judge({ violations: [`fix PR #900002: ${fix.error}`] })).not.toEqual([]);
});

it('fails closed when the source tree is unavailable', () => {
  const missing = resolve(fileURLToPath(import.meta.url), '../missing-smoke-source');
  expect(b.fixPresent(missing)).toBe(false);
  expect(b.judge(b.run({ sourceRoot: missing }))).toEqual([
    expect.stringContaining('dispatch-dry-run probe incomplete'),
  ]);
});
