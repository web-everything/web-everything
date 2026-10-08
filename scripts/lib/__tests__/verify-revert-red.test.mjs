/**
 * #5466 — the revert-red check against a REAL git repo and working tree.
 *
 * What is real: git (the range, the diff, the pre-fix contents, through the hardened runner), the file writes and the
 * restore. What is faked: the test runner — and every fake reads the REAL file on disk at the moment it runs, so "did
 * the revert actually reach the tree while the tests ran" is checked, not assumed (the same seam
 * `we:scripts/operations/__tests__/mutation-check-integration.test.mjs` uses).
 */
import { describe, expect, it } from 'vitest';
import * as realFs from 'node:fs';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withRealRepo } from '../../operations/__tests__/helpers/real-repo.mjs';
import { createRevertProbe, runSuite } from '../../operations/mutation-check-io.mjs';
import { runRevertRedCheck, revertRedForVerify, appendRevertRedLog, parseNameStatusZ, recoverRevertRed, textOrNull, REVERT_JOURNAL } from '../verify-revert-red.mjs';

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

  it('a restore that fails is reported not-restored and the journal stays; the next run puts the fix back from git', async () => {
    await withFix(async (ctx) => {
      let failRestore = true;
      const write = (p, text) => {
        if (failRestore && text === FIXED) throw new Error('EIO on restore');
        realFs.writeFileSync(p, text);
      };
      const probe = createRevertProbe({ run: runner(ctx.root, []), write });
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe });
      expect(v).toMatchObject({ status: 'unproven', reason: 'not-restored' });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(BUGGY);
      const journal = join(ctx.root, '.git', REVERT_JOURNAL);
      expect(JSON.parse(readFileSync(journal, 'utf8'))).toMatchObject({ head: ctx.fix, files: [SRC] });
      failRestore = false;
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ pending: true, ok: true, restored: [SRC] });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(FIXED);
      expect(existsSync(journal)).toBe(false);
      expect(ctx.porcelain()).toBe('');
      expect(recoverRevertRed({ checkout: ctx.root })).toEqual({ pending: false, ok: true, restored: [] });
    });
  });

  it('a journal naming a path outside the checkout is refused, not followed', async () => {
    await withFix(async (ctx) => {
      writeFileSync(join(ctx.root, '.git', REVERT_JOURNAL), JSON.stringify({ head: ctx.fix, files: ['../outside.mjs'] }));
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ pending: true, ok: false });
      expect(existsSync(join(ctx.root, '..', 'outside.mjs'))).toBe(false);
    });
  });

  it('binary and symlinked sources are never reverted', async () => {
    await withRealRepo(async (ctx) => {
      const BIN = 'assets/logo.bin';
      ctx.commit({ [SRC]: BUGGY, [TEST]: OLD_TEST, [BIN]: 'v1' }, 'base');
      const base = ctx.head();
      realFs.mkdirSync(join(ctx.root, 'assets'), { recursive: true });
      realFs.writeFileSync(join(ctx.root, BIN), Buffer.from([0, 0xff, 0xfe, 1]));
      ctx.git(['add', BIN]);
      ctx.commit({ [TEST]: NEW_TEST }, 'fix: binary only');
      const v = await runRevertRedCheck({ checkout: ctx.root, base, mode: 'enforce', probe: () => { throw new Error('must not run'); } });
      expect(v).toMatchObject({ status: 'skipped', reason: 'no-source-to-revert', unrevertable: [BIN] });
      expect(ctx.git(['status', '--porcelain']).trim()).toBe('');
    });
    await withRealRepo(async (ctx) => {
      const LINK = 'scripts/x/link.mjs';
      ctx.commit({ [SRC]: BUGGY, [TEST]: OLD_TEST }, 'base');
      realFs.mkdirSync(join(ctx.root, 'scripts/x'), { recursive: true });
      symlinkSync('guard.mjs', join(ctx.root, LINK));
      ctx.git(['add', LINK]);
      ctx.commit({}, 'link');
      const base = ctx.head();
      realFs.unlinkSync(join(ctx.root, LINK));
      symlinkSync('../../README.md', join(ctx.root, LINK));
      ctx.git(['add', LINK]);
      ctx.commit({ [TEST]: NEW_TEST }, 'fix: retarget the link');
      const v = await runRevertRedCheck({ checkout: ctx.root, base, mode: 'enforce', probe: () => { throw new Error('must not run'); } });
      expect(v).toMatchObject({ status: 'skipped', reason: 'no-source-to-revert', unrevertable: [LINK] });
    });
    expect(textOrNull(Buffer.from([0xff, 0x41]))).toBe(null);
    expect(textOrNull(Buffer.from([0x41, 0x00, 0x42]))).toBe(null); // valid UTF-8, but a NUL byte: binary
    expect(textOrNull(Buffer.from('plain\n'))).toBe('plain\n');
  });

  it('a base that is not an ancestor of the head is unproven (blocks in enforce), never skipped', async () => {
    await withFix(async (ctx) => {
      ctx.git(['checkout', '-q', '-b', 'other', ctx.base]);
      ctx.commit({ 'scripts/x/other.mjs': 'y\n' }, 'unrelated');
      const other = ctx.head();
      ctx.git(['checkout', '-q', 'main']);
      const v = await runRevertRedCheck({ checkout: ctx.root, base: other, mode: 'enforce', probe: createRevertProbe({ run: runner(ctx.root, []) }) });
      expect(v).toMatchObject({ status: 'unproven', reason: 'base-not-ancestor', blocking: true });
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
  ])('%s is skipped before any git read', async (_name, record, reason) => {
    await withFix(async (ctx) => {
      const probe = () => { throw new Error('must not run'); };
      const v = await revertRedForVerify({ repo: ctx.root, headSha: ctx.fix, record: record && { ...record, sha: record.sha === 'SELF' ? ctx.fix : record.sha }, settings, probe });
      expect(v).toMatchObject({ status: 'skipped', reason, blocking: false });
    });
  });

  it('a fix record with an unsafe ref is unproven (it names no pre-fix base), and nothing runs', async () => {
    await withFix(async (ctx) => {
      const v = await revertRedForVerify({ repo: ctx.root, headSha: ctx.fix, record: { kind: 'ci-heal', sha: ctx.fix, ref: 'lane/../main' },
        settings: { mode: 'enforce' }, probe: () => { throw new Error('must not run'); } });
      expect(v).toMatchObject({ status: 'unproven', reason: 'fix-record-has-no-ref', blocking: true });
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
