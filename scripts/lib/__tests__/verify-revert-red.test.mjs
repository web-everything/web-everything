/**
 * #5466 — the revert-red check against a REAL git repo and working tree.
 *
 * What is real: git (the range, the diff, the pre-fix contents, through the hardened runner), the file writes and the
 * restore. What is faked: the test runner — and every fake reads the REAL file on disk at the moment it runs, so "did
 * the revert actually reach the tree while the tests ran" is checked, not assumed (the same seam
 * `we:scripts/operations/__tests__/mutation-check-integration.test.mjs` uses).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withRealRepo } from '../../operations/__tests__/helpers/real-repo.mjs';
import { createRevertProbe, runSuite } from '../../operations/mutation-check-io.mjs';
import { runRevertRedCheck, revertRedForVerify, appendRevertRedLog, parseNameStatusZ } from '../verify-revert-red.mjs';

const SRC = 'scripts/x/guard.mjs';
const TEST = 'scripts/x/__tests__/guard.test.mjs';
const BUGGY = 'export const guard = (name) => name.length > 0;\n';
const FIXED = 'export const guard = (name) => name.length > 0 && !name.startsWith(\'.\');\n';
const OLD_TEST = "it('accepts a plain name', () => {});\n";
const NEW_TEST = `${OLD_TEST}it('refuses a dot name', () => {});\n`;

/** A runner standing in for vitest: the new test is red exactly when the file on disk is the buggy one. */
function runner(root, seen, { discriminates = true } = {}) {
  return (_cmd, _args, opts) => {
    const onDisk = readFileSync(join(opts.cwd, SRC), 'utf8');
    seen.push(onDisk);
    if (discriminates && onDisk === BUGGY) {
      const error = new Error('exit 1');
      error.stdout = 'Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n';
      error.stderr = ` FAIL  ${TEST} > refuses a dot name\n`;
      throw error;
    }
    return 'Test Files  1 passed (1)\n      Tests  2 passed (2)\n';
  };
}

async function withFix(fn) {
  return withRealRepo(async (ctx) => {
    ctx.commit({ [SRC]: BUGGY, [TEST]: OLD_TEST }, 'base');
    const base = ctx.head();
    ctx.commit({ [SRC]: FIXED, [TEST]: NEW_TEST, 'backlog/1-card.md': 'x\n' }, 'fix');
    const porcelain = () => ctx.git(['status', '--porcelain']).trim();
    return fn({ ...ctx, base, fix: ctx.head(), porcelain });
  });
}

describe('revert-red check on a real checkout', () => {
  it('a new test that goes red with the fix reverted is clean; the revert reached disk and was restored', async () => {
    await withFix(async (ctx) => {
      const seen = [];
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe: createRevertProbe({ run: runner(ctx.root, seen) }) });
      expect(v).toMatchObject({ status: 'clean', blocking: false, reverted: [SRC], base: ctx.base, head: ctx.fix });
      expect(v.discriminating).toEqual([{ file: TEST, test: 'refuses a dot name' }]);
      expect(seen).toEqual([FIXED, BUGGY]); // baseline on the fix, then the reverted source
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(FIXED);
      expect(ctx.porcelain()).toBe('');
    });
  });

  it('a new test that passes with the fix reverted is flagged by name; warn does not block, enforce does', async () => {
    await withFix(async (ctx) => {
      const probe = createRevertProbe({ run: runner(ctx.root, [], { discriminates: false }) });
      const warn = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe });
      expect(warn).toMatchObject({ status: 'flagged', blocking: false, nonDiscriminating: [{ file: TEST, test: 'refuses a dot name' }] });
      expect(warn.line).toContain('NOT discriminating: scripts/x/__tests__/guard.test.mjs > refuses a dot name');
      const enforce = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'enforce', probe });
      expect(enforce).toMatchObject({ status: 'flagged', blocking: true });
      expect(ctx.porcelain()).toBe('');
    });
  });

  it('the tree is restored even when the runner throws mid-run', async () => {
    await withFix(async (ctx) => {
      let calls = 0;
      const run = () => { calls += 1; if (calls === 2) throw Object.assign(new Error('runner died'), { stdout: '', stderr: '' }); return 'Test Files  1 passed (1)\n      Tests  2 passed (2)\n'; };
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'enforce', probe: createRevertProbe({ run }) });
      expect(v).toMatchObject({ status: 'unproven', reason: 'reverted-run-unrun', blocking: true });
      expect(ctx.porcelain()).toBe('');
    });
  });

  it('a working tree that drifted from the fixed commit is never touched', async () => {
    await withFix(async (ctx) => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(ctx.root, SRC), 'edited\n');
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe: createRevertProbe({ run: runner(ctx.root, []) }) });
      expect(v).toMatchObject({ status: 'unproven', reason: 'baseline-unrun' });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe('edited\n');
    });
  });

  it('a merge in the fix range is skipped with its reason, never guessed around', async () => {
    await withFix(async (ctx) => {
      ctx.git(['checkout', '-q', '-b', 'side', ctx.base]);
      ctx.commit({ 'scripts/x/other.mjs': 'x\n' }, 'side');
      ctx.git(['checkout', '-q', 'main']);
      ctx.git(['merge', '-q', '--no-edit', 'side']);
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'enforce', probe: createRevertProbe({ run: runner(ctx.root, []) }) });
      expect(v).toMatchObject({ status: 'skipped', reason: 'merge-in-range', blocking: false });
    });
  });

  it('an unreadable base is unproven (blocks in enforce), never clean', async () => {
    await withFix(async (ctx) => {
      const v = await runRevertRedCheck({ checkout: ctx.root, base: 'refs/remotes/origin/lane/missing', mode: 'enforce', probe: createRevertProbe({ run: runner(ctx.root, []) }) });
      expect(v).toMatchObject({ status: 'unproven', reason: 'base-unreadable', blocking: true });
    });
  });
});

describe('the verify-lane entry decides from the fix role\'s own record', () => {
  const settings = { mode: 'warn', maxFiles: 40 };
  it('runs for a fix record naming this head, against the lane ref as last fetched', async () => {
    await withFix(async (ctx) => {
      ctx.git(['update-ref', 'refs/remotes/origin/lane/demo', ctx.base]);
      const record = { v: 1, kind: 'fix', sha: ctx.fix, ref: 'lane/demo', pr: 1 };
      const v = await revertRedForVerify({ repo: ctx.root, headSha: ctx.fix, record, settings, probe: createRevertProbe({ run: runner(ctx.root, []) }) });
      expect(v).toMatchObject({ status: 'clean', base: ctx.base, head: ctx.fix });
    });
  });

  it.each([
    ['no record (not a fix push)', null, 'not-a-fix-push'],
    ['a delivery record', { kind: 'delivery', sha: 'SELF', ref: 'lane/demo' }, 'not-a-fix-push'],
    ['a fix record for another head', { kind: 'fix', sha: 'a'.repeat(40), ref: 'lane/demo' }, 'fix-record-not-for-this-head'],
    ['a fix record with an unsafe ref', { kind: 'ci-heal', sha: 'SELF', ref: 'lane/../main' }, 'fix-record-has-no-ref'],
  ])('%s is skipped before any git read', async (_name, record, reason) => {
    await withFix(async (ctx) => {
      const probe = () => { throw new Error('must not run'); };
      const v = await revertRedForVerify({ repo: ctx.root, headSha: ctx.fix, record: record && { ...record, sha: record.sha === 'SELF' ? ctx.fix : record.sha }, settings, probe });
      expect(v).toMatchObject({ status: 'skipped', reason, blocking: false });
    });
  });

  it('mode off runs nothing even for a fix push (today\'s behaviour)', async () => {
    await withFix(async (ctx) => {
      const v = await revertRedForVerify({ repo: ctx.root, headSha: ctx.fix, record: { kind: 'fix', sha: ctx.fix, ref: 'lane/demo' }, settings: { mode: 'off' }, probe: () => { throw new Error('must not run'); } });
      expect(v).toMatchObject({ status: 'skipped', reason: 'mode-off' });
    });
  });
});

describe('parts', () => {
  it('parses -z name-status output', () => {
    expect(parseNameStatusZ('M\0a b.mjs\0A\0c.mjs\0')).toEqual([{ status: 'M', path: 'a b.mjs' }, { status: 'A', path: 'c.mjs' }]);
  });

  it('appends a log line under the coordination root, and a failed append is reported, not thrown', () => {
    const root = mkdtempSync(join(tmpdir(), 'revert-red-log-'));
    try {
      expect(appendRevertRedLog({ status: 'clean' }, { root })).toBe(true);
      expect(readFileSync(join(root, 'revert-red', 'log.jsonl'), 'utf8')).toBe('{"status":"clean"}\n');
      expect(appendRevertRedLog({}, { root, append: () => { throw new Error('EROFS'); } })).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runSuite runs several files in one call and says when the failure list was cut', () => {
    const lines = Array.from({ length: 5 }, (_, i) => ` FAIL  a.test.mjs > t${i}`).join('\n');
    const run = (_f, args) => {
      expect(args.slice(-3)).toEqual(['./a.test.mjs', './b.test.mjs', '--reporter=basic']);
      throw Object.assign(new Error('x'), { stdout: 'Test Files  1 failed (2)\n Tests  5 failed (9)\n', stderr: lines });
    };
    const r = runSuite({ cwd: '.', suite: ['./a.test.mjs', './b.test.mjs'], run, maxFailures: 3 });
    expect(r).toMatchObject({ ran: true, green: false, failuresTruncated: true });
    expect(r.failures).toHaveLength(3);
  });
});
