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
import { execFileSync } from 'node:child_process';
import { createMutationProbe, createRevertProbe, runSuite, BOUNDED_RUN_SHIM } from '../../operations/mutation-check-io.mjs';
import { runRevertRedCheck, revertRedForVerify, appendRevertRedLog, parseNameStatusZ, recoverRevertRed, textOrNull, REVERT_JOURNAL, REVERT_MAX_AGE_MS, applyRevertRedToVerdict } from '../verify-revert-red.mjs';

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

  it('preserves target edits made during the baseline run: the edit survives and the revert is refused', async () => {
    await withFix(async (ctx) => {
      const seen = [];
      const base = runner(ctx.root, seen);
      let first = true;
      const run = (...a) => {
        if (first) { first = false; writeFileSync(join(ctx.root, SRC), `${FIXED}// edited while the baseline ran\n`); }
        return base(...a);
      };
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'enforce', probe: createRevertProbe({ run }) });
      expect(v).toMatchObject({ status: 'unproven', reason: 'target-changed-during-baseline', blocking: true });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(`${FIXED}// edited while the baseline ran\n`);
      expect(seen).toHaveLength(1); // the reverted run never happened
    });
  });

  it('an edit made while the reverted run executes is left alone, and the tree is reported not restored', async () => {
    await withFix(async (ctx) => {
      let calls = 0;
      const run = (...a) => {
        calls += 1;
        if (calls === 2) writeFileSync(join(ctx.root, SRC), 'someone else was here\n');
        return runner(ctx.root, [])(...a);
      };
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe: createRevertProbe({ run }) });
      expect(v).toMatchObject({ status: 'unproven', reason: 'not-restored' });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe('someone else was here\n');
    });
  });

  it('a revert write that throws part-way is NOT a failed restore: the files are back, the run is simply unrun', async () => {
    await withRealRepo(async (ctx) => {
      // Two source files are reverted; the second revert write throws after the first has landed.
      const SRC2 = 'scripts/x/guard2.mjs';
      ctx.commit({ [SRC]: BUGGY, [SRC2]: 'old2\n', [TEST]: OLD_TEST }, 'base');
      const base = ctx.head();
      ctx.commit({ [SRC]: FIXED, [SRC2]: 'new2\n', [TEST]: NEW_TEST }, 'fix');
      let reverts = 0;
      const write = (p, text) => {
        if (text === 'old2\n') { reverts += 1; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
        realFs.writeFileSync(p, text);
      };
      const v = await runRevertRedCheck({ checkout: ctx.root, base, mode: 'warn', probe: createRevertProbe({ write, run: runner(ctx.root, []) }) });
      expect(reverts).toBe(1);
      expect(v).toMatchObject({ status: 'unproven', reason: 'reverted-run-unrun' });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(FIXED); // the first revert landed, then was put back
      expect(ctx.git(['status', '--porcelain']).trim()).toBe('');
      expect(existsSync(join(ctx.git(['rev-parse', '--absolute-git-dir']).trim(), REVERT_JOURNAL))).toBe(false);
    });
  });

  it('a probe that throws still reads the tree back: files intact is unrun, not not-restored', async () => {
    await withFix(async (ctx) => {
      const probe = async () => { throw new Error('probe blew up before touching anything'); };
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe });
      expect(v).toMatchObject({ status: 'unproven', reason: 'reverted-run-unrun' });
      expect(ctx.porcelain()).toBe('');
    });
  });

  it('a probe that dies with the revert still on disk is put back from git right away, not left for the next verify', async () => {
    await withFix(async (ctx) => {
      const probe = async () => { writeFileSync(join(ctx.root, SRC), BUGGY); throw new Error('killed mid-run'); };
      const v = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe });
      expect(v).toMatchObject({ status: 'unproven', reason: 'reverted-run-unrun' });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(FIXED);
      expect(ctx.porcelain()).toBe('');
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
      expect(JSON.parse(readFileSync(journal, 'utf8'))).toMatchObject({ head: ctx.fix, files: [{ path: SRC }] });
      failRestore = false;
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ pending: true, ok: true, restored: [SRC], leftAlone: [] });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(FIXED);
      expect(existsSync(journal)).toBe(false);
      expect(ctx.porcelain()).toBe('');
      expect(recoverRevertRed({ checkout: ctx.root })).toEqual({ pending: false, ok: true, restored: [] });
    });
  });

  it('recovery never overwrites work done after the kill: an edited file, or a moved HEAD, is left alone', async () => {
    const leaveReverted = async (ctx) => {
      const write = (p, text) => { if (text === FIXED) throw new Error('EIO'); realFs.writeFileSync(p, text); };
      await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'warn', probe: createRevertProbe({ run: runner(ctx.root, []), write }) });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(BUGGY);
    };
    await withFix(async (ctx) => {
      await leaveReverted(ctx);
      writeFileSync(join(ctx.root, SRC), 'the fixer kept working\n');
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ ok: true, restored: [], leftAlone: [SRC] });
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe('the fixer kept working\n');
      expect(existsSync(join(ctx.root, '.git', REVERT_JOURNAL))).toBe(false);
    });
    await withFix(async (ctx) => {
      await leaveReverted(ctx);
      ctx.commit({ 'scripts/x/next.mjs': 'n\n' }, 'the fixer committed again');
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ ok: true, restored: [], leftAlone: [SRC] });
    });
  });

  it('a half-written or headless journal is dropped (no revert ever happened under it), never wedges the lane', async () => {
    await withFix(async (ctx) => {
      const journal = join(ctx.root, '.git', REVERT_JOURNAL);
      writeFileSync(journal, '{"head":"ab');
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ pending: true, ok: true, restored: [] });
      expect(existsSync(journal)).toBe(false);
      writeFileSync(journal, JSON.stringify({ files: [{ path: SRC }] }));
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ ok: true });
      expect(existsSync(journal)).toBe(false);
    });
  });

  it('a journaled file deleted after the kill is left alone; a live revert in progress is never restored under', async () => {
    await withFix(async (ctx) => {
      const journal = join(ctx.root, '.git', REVERT_JOURNAL);
      writeFileSync(journal, JSON.stringify({ head: ctx.fix, files: [{ path: 'scripts/x/gone.mjs', reverted: 'x' }] }));
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ ok: true, leftAlone: ['scripts/x/gone.mjs'] });
      const { hostname } = await import('node:os');
      writeFileSync(journal, JSON.stringify({ head: ctx.fix, files: [{ path: SRC, reverted: 'x' }], pid: process.ppid, host: hostname(), at: new Date().toISOString() }));
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ pending: true, ok: false });
      expect(existsSync(journal)).toBe(true);
      expect(readFileSync(join(ctx.root, SRC), 'utf8')).toBe(FIXED);
      // An OLD journal whose pid is alive is a reused pid, not a live writer: recovered (here: left alone, bytes differ).
      writeFileSync(journal, JSON.stringify({ head: ctx.fix, files: [{ path: SRC, reverted: 'x' }], pid: process.ppid, host: hostname(), at: '2026-01-01T00:00:00Z' }));
      expect(recoverRevertRed({ checkout: ctx.root })).toMatchObject({ pending: true, ok: true, leftAlone: [SRC] });
    });
  });

  it('a journal naming a path outside the checkout is refused, not followed', async () => {
    await withFix(async (ctx) => {
      writeFileSync(join(ctx.root, '.git', REVERT_JOURNAL), JSON.stringify({ head: ctx.fix, files: [{ path: '../outside.mjs', reverted: 'x' }] }));
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

  // The ceiling rides INSIDE the admitted command (the shim), so it starts when the heavy pool grants the slot — never
  // on the wrapper process, whose lifetime also covers the queue wait.
  const ceilingOf = (args) => JSON.parse(args.at(-1)).ms;

  it('the reverted run carries its ceiling inside the admitted command, never as a timeout on the wrapper', () => {
    const seen = [];
    const run = (_f, args, opts) => {
      seen.push({ wrapperTimeout: opts.timeout, ceiling: ceilingOf(args) });
      throw Object.assign(new Error('exit 124'), { status: 124, stdout: ' RUN v1\n', stderr: 'revert-red-timeout: run exceeded 1234ms and was killed\n' });
    };
    expect(runSuite({ cwd: '.', suite: ['./a.test.mjs'], run, timeoutMs: 1234 })).toMatchObject({ ran: false, green: false, timedOut: true });
    expect(seen).toEqual([{ wrapperTimeout: undefined, ceiling: 1234 }]);
    expect(runSuite({ cwd: '.', suite: ['./a.test.mjs'], run: (_f, _a, opts) => { expect(opts.timeout).toBeUndefined(); return 'Test Files  1 passed (1)\n'; } })).toMatchObject({ ran: true, timedOut: false });
  });

  it('the shim bounds only the command it wraps: it kills the whole process group when the ceiling passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'revert-red-shim-'));
    try {
      const pidFile = join(dir, 'pid');
      const payload = JSON.stringify({ argv: ['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], ms: 400 });
      const started = Date.now();
      let caught;
      try { execFileSync(process.execPath, ['-e', BOUNDED_RUN_SHIM, payload], { encoding: 'utf8', stdio: 'pipe', timeout: 20_000 }); } catch (e) { caught = e; }
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(caught?.status).toBe(124);
      expect(String(caught?.stderr)).toContain('revert-red-timeout');
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(grandchild, 0)).toThrow(); // the grandchild is gone, not orphaned against a restored tree
      // A command that finishes in time keeps its own exit code and output.
      const ok = execFileSync(process.execPath, ['-e', BOUNDED_RUN_SHIM, JSON.stringify({ argv: [process.execPath, '-e', 'console.log("fine")'], ms: 20_000 })], { encoding: 'utf8' });
      expect(ok.trim()).toBe('fine');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a failure list past the output buffer is said to be cut, and the marker text alone is not a timeout', () => {
    const big = Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS', stdout: 'Test Files  1 failed (1)\n Tests  9 failed (9)\n', stderr: ' FAIL  a.test.mjs > t1\n' });
    expect(runSuite({ cwd: '.', suite: ['./a.test.mjs'], run: () => { throw big; } })).toMatchObject({ ran: true, failuresTruncated: true });
    let seenBuffer;
    runSuite({ cwd: '.', suite: ['./a.test.mjs'], run: (_f, _a, o) => { seenBuffer = o.maxBuffer; return 'Test Files  1 passed (1)\n'; } });
    expect(seenBuffer).toBeGreaterThan(1024 * 1024);
    // A failing assertion that merely PRINTS the marker, exiting 1, is a red run, not a hung one.
    const spoof = Object.assign(new Error('x'), { status: 1, stdout: 'Test Files  1 failed (1)\n Tests  1 failed (1)\n', stderr: ' FAIL  a.test.mjs > revert-red-timeout: run exceeded\n' });
    expect(runSuite({ cwd: '.', suite: ['./a.test.mjs'], run: () => { throw spoof; }, timeoutMs: 1000 })).toMatchObject({ ran: true, timedOut: false });
  });

  it('a journal is trusted as live for as long as two QUEUED runs can take, not just two run ceilings', () => {
    expect(REVERT_MAX_AGE_MS).toBeGreaterThan(2 * 120 * 60 * 1000);
  });

  it('a timed-out run is its own reason, not a generic unrun (baseline and reverted run)', async () => {
    await withFix(async (ctx) => {
      const timedOut = () => { throw Object.assign(new Error('exit 124'), { status: 124, stdout: '', stderr: 'revert-red-timeout: run exceeded 1ms and was killed\n' }); };
      const baseline = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'enforce', probe: createRevertProbe({ run: timedOut, timeoutMs: 1 }) });
      expect(baseline).toMatchObject({ status: 'unproven', reason: 'baseline-timeout', blocking: true });
      let calls = 0;
      const second = () => { calls += 1; if (calls === 1) return 'Test Files  1 passed (1)\n'; return timedOut(); };
      const reverted = await runRevertRedCheck({ checkout: ctx.root, base: ctx.base, mode: 'enforce', probe: createRevertProbe({ run: second, timeoutMs: 1 }) });
      expect(reverted).toMatchObject({ status: 'unproven', reason: 'reverted-run-timeout', blocking: true });
      expect(ctx.porcelain()).toBe('');
    });
  });

  it('the revert probe bounds BOTH of its runs with a 10-minute ceiling by default', () => {
    const seen = [];
    const probe = createRevertProbe({ read: () => 'fixed', write: () => {}, run: (_f, args) => { seen.push(ceilingOf(args)); return 'Test Files  1 passed (1)\n'; } });
    probe({ cwd: '.', targets: [{ target: 'a.mjs', fixed: 'fixed', revert: 'old' }], suite: ['./a.test.mjs'] });
    expect(seen).toEqual([600000, 600000]);
  });

  it('the single-file mutation probe also refuses to write over an edit made during its baseline run', () => {
    const files = new Map([['/w/a.mjs', 'const a = 1;\n']]);
    let calls = 0;
    const run = () => { calls += 1; if (calls === 1) files.set('/w/a.mjs', 'const a = 1; // edited meanwhile\n'); return 'Test Files  1 passed (1)\n'; };
    const probe = createMutationProbe({ read: (p) => files.get(p), write: (p, s) => files.set(p, s), run });
    const r = probe({ cwd: '/w', target: 'a.mjs', find: 'const a = 1;', replace: 'const a = 2;', suite: './a.test.mjs' });
    expect(r).toMatchObject({ applied: false, restored: true });
    expect(files.get('/w/a.mjs')).toBe('const a = 1; // edited meanwhile\n');
    expect(calls).toBe(1);
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

// The ONE place verify-lane's exit code is decided for a revert-red result (verify-lane assigns exactly this).
describe('what a revert-red result does to the verify verdict', () => {
  const flagged = { reason: 'tests-pass-with-fix-reverted', blocking: false, line: 'L', nonDiscriminating: [{ file: 'a.test.mjs', test: 't' }], unproven: [] };
  it('warn never changes a green verdict', () => {
    for (const r of [flagged, { reason: 'base-not-ancestor', blocking: false }, { reason: 'mode-off', blocking: false }, null]) {
      expect(applyRevertRedToVerdict({ exitCode: 0, failureDetails: undefined, revertRed: r })).toEqual({ exitCode: 0, failureDetails: undefined });
    }
  });
  it('enforce turns a blocking result red, naming the tests', () => {
    const r = applyRevertRedToVerdict({ exitCode: 0, revertRed: { ...flagged, blocking: true } });
    expect(r.exitCode).toBe(1);
    expect(r.failureDetails.tests).toEqual([{ file: 'a.test.mjs', name: 't (passes with the fix reverted)' }]);
  });
  it('a failed restore is red in every mode (the tree is not the verified commit)', () => {
    expect(applyRevertRedToVerdict({ exitCode: 0, revertRed: { reason: 'not-restored', blocking: false, line: 'L' } }).exitCode).toBe(1);
  });
  it('never turns a red gate green', () => {
    expect(applyRevertRedToVerdict({ exitCode: 2, failureDetails: { x: 1 }, revertRed: { reason: 'all-new-tests-red-with-fix-reverted', blocking: false } })).toEqual({ exitCode: 2, failureDetails: { x: 1 } });
  });
});
