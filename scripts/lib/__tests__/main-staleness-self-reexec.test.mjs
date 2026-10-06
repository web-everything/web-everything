/**
 * @file main-staleness-self-reexec.test.mjs — xgqz204: a dispatcher that fast-forwards its OWN checkout must not
 *   keep running the pre-fast-forward code it already loaded. Live 2026-09-25: review-dispatch fast-forwarded 47
 *   commits (PR #2674's job-mode default among them) and the old in-memory CLI still started a `claude --bg`
 *   session. The last describe block reproduces that shape end to end on a real temp repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  assertMainNotStale, selfFastForwardAction, armSelfReexecOnFastForward, reexecSelf, isSameCheckout,
  changedFilesBetween, SELF_SYNC_REEXEC_ENV, STALE_MAIN_REFUSAL_MARKER, THIS_CODE_ROOT,
} from '../main-staleness.mjs';

const SYNCED = { synced: true, behind: 47, from: 'aaaaaaaaaaaa', to: 'bbbbbbbbbbbb' };
const quiet = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterEach(() => vi.restoreAllMocks());

describe('selfFastForwardAction (pure)', () => {
  it.each([
    [{ sameCheckout: false, codeChanged: true, armed: true, reexeced: false }, 'proceed'],
    [{ sameCheckout: true, codeChanged: false, armed: false, reexeced: false }, 'proceed'],
    [{ sameCheckout: true, codeChanged: true, armed: true, reexeced: false }, 'reexec'],
    [{ sameCheckout: true, codeChanged: null, armed: true, reexeced: false }, 'reexec'],
    [{ sameCheckout: true, codeChanged: true, armed: false, reexeced: false }, 'refuse'],
    [{ sameCheckout: true, codeChanged: true, armed: true, reexeced: true }, 'refuse'],
  ])('%j → %s', (input, want) => expect(selfFastForwardAction(input)).toBe(want));
});

describe('assertMainNotStale — after a fast-forward of the checkout this code runs from', () => {
  const opts = (over = {}) => ({
    codeRoot: '/repo', armed: true, reexeced: false,
    changedFiles: () => ['scripts/operations/review-job.mjs', 'backlog/x.md'], reexec: vi.fn(), ...over,
  });

  it('an armed CLI re-executes (label + fast-forward status handed over) instead of proceeding', () => {
    quiet();
    const o = opts();
    const st = assertMainNotStale('/repo', () => SYNCED, o);
    expect(o.reexec).toHaveBeenCalledWith({ label: 'review-dispatch', st: SYNCED });
    expect(st).toMatchObject({ synced: true, reexeced: true });
  });

  it('an UNARMED caller refuses with the stale marker rather than dispatching on old code', () => {
    quiet();
    const o = opts({ armed: false });
    expect(() => assertMainNotStale('/repo', () => SYNCED, { ...o, label: 'fix-dispatch' }))
      .toThrow(new RegExp(`^fix-dispatch: fast-forwarded .*47 commit.*${STALE_MAIN_REFUSAL_MARKER}.*cannot re-execute itself`));
    expect(o.reexec).not.toHaveBeenCalled();
  });

  it('a process that already re-executed once refuses instead of looping', () => {
    quiet();
    const o = opts({ reexeced: true });
    expect(() => assertMainNotStale('/repo', () => SYNCED, o)).toThrow(/already re-executed itself once/);
    expect(o.reexec).not.toHaveBeenCalled();
  });

  it('a fast-forward that touched only non-code files proceeds (the code in memory is still current)', () => {
    quiet();
    const o = opts({ changedFiles: () => ['backlog/x.md', 'skills-src/conveyor/fix-agent-brief.md', 'scripts/__tests__/a.test.mjs'] });
    expect(assertMainNotStale('/repo', () => SYNCED, o)).toBe(SYNCED);
    expect(o.reexec).not.toHaveBeenCalled();
  });

  it('an unreadable diff counts as changed code (fail closed)', () => {
    quiet();
    const o = opts({ changedFiles: () => null });
    assertMainNotStale('/repo', () => SYNCED, o);
    expect(o.reexec).toHaveBeenCalledTimes(1);
  });

  it('fast-forwarding a checkout OTHER than the one this code was loaded from proceeds untouched', () => {
    quiet();
    const o = opts({ codeRoot: '/elsewhere', changedFiles: vi.fn(() => ['a.mjs']) });
    expect(assertMainNotStale('/repo', () => SYNCED, o)).toBe(SYNCED);
    expect(o.reexec).not.toHaveBeenCalled();
    expect(o.changedFiles).not.toHaveBeenCalled();
  });

  it('fresh / offline never reach the self-sync branch', () => {
    const o = opts();
    expect(assertMainNotStale('/repo', () => ({ fresh: true, behind: 0 }), o)).toEqual({ fresh: true, behind: 0 });
    expect(assertMainNotStale('/repo', () => ({ offline: true }), o)).toEqual({ offline: true });
    expect(o.reexec).not.toHaveBeenCalled();
  });

  it('the default code root is this repo checkout (the module\'s own tree)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(isSameCheckout(THIS_CODE_ROOT, join(here, '..', '..', '..'))).toBe(true);
  });
});

describe('armSelfReexecOnFastForward', () => {
  it('reads AND removes the loop guard, so a process it spawns later does not inherit it', () => {
    const env = { [SELF_SYNC_REEXEC_ENV]: '1', KEEP: 'x' };
    expect(armSelfReexecOnFastForward(env)).toEqual({ armed: true, reexeced: true });
    expect(env).toEqual({ KEEP: 'x' });
    expect(armSelfReexecOnFastForward({})).toEqual({ armed: true, reexeced: false });
  });
});

describe('reexecSelf', () => {
  it('re-runs the same node flags + script + argv with the loop guard set, stdio inherited, and exits with its status', () => {
    const spawn = vi.fn(() => ({ status: 3 }));
    const exit = vi.fn();
    const write = vi.fn();
    reexecSelf({
      label: 'review-dispatch', st: SYNCED, spawn, exit, write,
      argv: ['/usr/bin/node', '/c/scripts/operations/review-dispatch.mjs', '--pr=1'], execArgv: ['--no-warnings'],
      env: { A: '1' }, cwd: '/c',
    });
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['--no-warnings', '/c/scripts/operations/review-dispatch.mjs', '--pr=1'], {
      stdio: 'inherit', cwd: '/c', env: { A: '1', [SELF_SYNC_REEXEC_ENV]: '1' },
    });
    expect(exit).toHaveBeenCalledWith(3);
    expect(write.mock.calls[0][0]).toMatch(/review-dispatch: re-executing .*47 commit\(s\) aaaaaaaaa\.\.bbbbbbbbb/);
  });

  it('a child that could not start throws (never proceeds on the old code)', () => {
    const exit = vi.fn();
    expect(() => reexecSelf({ spawn: () => ({ error: new Error('ENOENT') }), exit, write: () => {} }))
      .toThrow(/could not re-execute itself \(ENOENT\)/);
    expect(exit).not.toHaveBeenCalled();
  });

  it('a child killed by a signal exits non-zero', () => {
    const exit = vi.fn();
    reexecSelf({ spawn: () => ({ status: null, signal: 'SIGKILL' }), exit, write: () => {} });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

// The live shape, reproduced: a CLI in a clean checkout N commits behind origin/main, whose NEWER version on
// origin behaves differently. Before xgqz204 the old in-memory version ran after the fast-forward; now the
// re-executed process runs the new one, exactly once.
describe('end to end — a real CLI in a real checkout behind a real origin', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'main-staleness.mjs');
  const cli = (mode) => `import { armSelfReexecOnFastForward, assertMainNotStale, THIS_CODE_ROOT } from './scripts/lib/main-staleness.mjs';
armSelfReexecOnFastForward();
const MODE = '${mode}';
process.stdout.write('loaded mode=' + MODE + '\\n');
assertMainNotStale(THIS_CODE_ROOT, undefined, { label: 'toy-dispatch' });
process.stdout.write('dispatched mode=' + MODE + '\\n');
`;

  function fixture({ codeChange = true } = {}) {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'xgqz204-')));
    const origin = join(dir, 'origin.git');
    const pusher = join(dir, 'pusher');
    const checkout = join(dir, 'checkout');
    git(dir, 'init', '--bare', '-b', 'main', origin);
    git(dir, 'clone', origin, pusher);
    git(pusher, 'config', 'user.email', 't@t'); git(pusher, 'config', 'user.name', 't');
    mkdirSync(join(pusher, 'scripts', 'lib'), { recursive: true });
    copyFileSync(MODULE, join(pusher, 'scripts', 'lib', 'main-staleness.mjs'));
    // x5wbsbc — main-staleness.mjs imports its last-good read; the toy checkout needs it too.
    copyFileSync(join(dirname(MODULE), 'daemon-clone-layout.mjs'), join(pusher, 'scripts', 'lib', 'daemon-clone-layout.mjs'));
    copyFileSync(join(dirname(MODULE), 'daemon-last-good.mjs'), join(pusher, 'scripts', 'lib', 'daemon-last-good.mjs'));
    writeFileSync(join(pusher, 'cli.mjs'), cli('session'));
    git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', 'old: session mode');
    git(pusher, 'push', '-q', 'origin', 'main');
    git(dir, 'clone', '-q', origin, checkout);
    if (codeChange) writeFileSync(join(pusher, 'cli.mjs'), cli('job'));
    else writeFileSync(join(pusher, 'NOTES.md'), 'docs only\n');
    git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', 'new');
    git(pusher, 'push', '-q', 'origin', 'main');
    return { checkout, originHead: git(pusher, 'rev-parse', 'HEAD') };
  }
  const run = (checkout, env = {}) => spawnSync(process.execPath, ['cli.mjs'], {
    cwd: checkout, encoding: 'utf8', env: { ...process.env, WE_DAEMON_MANAGED_CLONE: '', [SELF_SYNC_REEXEC_ENV]: '', ...env },
  });

  it('fast-forwards, re-executes ONCE, and the NEW code dispatches', () => {
    const { checkout, originHead } = fixture();
    const r = run(checkout);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('loaded mode=session\nloaded mode=job\ndispatched mode=job\n');
    expect(r.stderr).toMatch(/toy-dispatch: re-executing so the fast-forwarded code runs \(1 commit/);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(originHead);
  });

  it('a docs-only fast-forward does not re-execute — the loaded code is still current', () => {
    const { checkout } = fixture({ codeChange: false });
    const r = run(checkout);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('loaded mode=session\ndispatched mode=session\n');
    expect(r.stderr).not.toMatch(/re-executing/);
  });

  it('an already re-executed process that fast-forwards again refuses (no loop), exit non-zero', () => {
    const { checkout } = fixture();
    const r = run(checkout, { [SELF_SYNC_REEXEC_ENV]: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('loaded mode=session\n');
    expect(r.stderr).toMatch(/already re-executed itself once/);
  });

  it('changedFilesBetween reads the real diff; a missing sha is unknown (null)', () => {
    const { checkout } = fixture();
    const before = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'fetch', '-q', 'origin', 'main');
    expect(changedFilesBetween(checkout, before, git(checkout, 'rev-parse', 'origin/main'))).toEqual(['cli.mjs']);
    expect(changedFilesBetween(checkout, null, before)).toBeNull();
  });
});
