/**
 * @file scripts/lib/__tests__/daemon-load-overlay.test.mjs
 * @description #4044 Module E — the operator's manual "load this early" CLI. `--ref` REGISTERS the ref as a
 *   standing overlay (`daemon-overlays.mjs#addOverlay`) then runs a gated rebuild
 *   (`daemon-rebuild.mjs#rebuildClone`) — the same rebuild-fresh-from-main-plus-overlays → live-smoke →
 *   adopt/rollback path a daemon's own `daemon-self-sync.mjs#withSelfSync` runs every tick. `--dry-run` never
 *   writes the overlay list; it previews via `dryRunRebuild`'s own `extraOverlays` option instead.
 *
 * HISTORY (#3383, PR #2601 follow-up, 2026-09-24): the first cut called `daemon-self-sync.mjs#selfSyncCheckout`
 * directly with `--ref` spliced in as its own `base` — conflating the HOME branch with the ref being merged
 * in. That standalone merge path ({@link mergeOverlayRef}/{@link dryRunOverlay} below) is KEPT and exported
 * for back-compat and is still tested directly (real git, proving the conflict-abort fix) — but
 * `runDaemonLoadOverlay` no longer calls it, since a one-shot merge left no durable record for the NEXT
 * automatic rebuild (which rebuilds fresh from `origin/main` + the REGISTERED overlay list only) to keep.
 *
 * `runDaemonLoadOverlay`'s wiring tests inject `addOverlayFn`/`rebuild`/`dryRunRebuildFn` — no real git, no
 * real child process (those are `daemon-overlays.mjs`'s and `daemon-rebuild.mjs`'s own test suites' job).
 * `mergeOverlayRef`/`dryRunOverlay`'s own tests inject `run` (git) — proving the ACTUAL git sequence, including
 * one REAL-git suite (temp repos) for the conflict-abort behavior, since that is exactly the live bug.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, readSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
vi.mock('../overlay-load-record.mjs', () => ({ appendLoadRecord: vi.fn(() => ({ ok: true })) }));
import { runDaemonLoadOverlay, mergeOverlayRef, dryRunOverlay, overlayInstalled } from '../daemon-load-overlay.mjs';
import finalizeWaitBreak from '../../conveyor/soak/breaks/overlay-admission-finalize-wait.mjs';

it('preserves the real rebuild finalize wait on first admission, late retries, and starvation', async () => {
  const report = await finalizeWaitBreak.run();
  expect(finalizeWaitBreak.judge(report)).toEqual([]);
}, 60_000);

describe('runDaemonLoadOverlay — wiring (injected addOverlayFn/rebuild/dryRunRebuildFn)', () => {
  it('requires --clone', async () => {
    await expect(runDaemonLoadOverlay({ clone: null, ref: 'lane/x' })).rejects.toThrow(/--clone/);
  });

  it('requires --ref', async () => {
    await expect(runDaemonLoadOverlay({ clone: '/some/clone', ref: null })).rejects.toThrow(/--ref/);
  });

  it('registers the overlay THEN rebuilds, in order', async () => {
    const order = [];
    const addOverlayFn = vi.fn(() => { order.push('addOverlay'); });
    const rebuild = vi.fn(async () => { order.push('rebuild'); return { moved: false, reason: 'up-to-date' }; });
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), addOverlayFn, rebuild });
    expect(order).toEqual(['addOverlay', 'rebuild']);
    expect(result).toMatchObject({ registered: true, mergedAnything: false, adopted: false, reason: 'up-to-date' });
  });

  it('an ADOPTED rebuild is reported adopted:true, with the new head', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: true, adopted: true, head: 'deadbeef', alerts: [] }));
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), addOverlayFn, rebuild });
    expect(result).toMatchObject({ mergedAnything: true, adopted: true, head: 'deadbeef' });
  });

  it('a REJECTED rebuild (smoke-rejected) is reported adopted:false, the reason surfaced', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'smoke-rejected', rolledBack: true, alerts: [{ kind: 'smoke-rejected', detail: { failed: 'gh-api-repo' } }] }));
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), addOverlayFn, rebuild });
    expect(result.adopted).toBe(false);
    expect(result.reason).toBe('smoke-rejected');
    expect(result.alerts[0].detail.failed).toBe('gh-api-repo');
  });

  it('addOverlayFn is called with the ref, pr, addedBy, and reason', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    await runDaemonLoadOverlay({
      clone: '/some/clone', ref: 'lane/xkse05k-gh-app-shim-401-fallback', pr: 42, addedBy: 'nic', reason: 'early load', addOverlayFn, rebuild,
    });
    expect(addOverlayFn).toHaveBeenCalledWith('/some/clone', expect.objectContaining({
      ref: 'lane/xkse05k-gh-app-shim-401-fallback', pr: 42, addedBy: 'nic', reason: 'early load',
    }), expect.anything());
  });

  it('rebuild always runs with mainOnly:false — a manual overlay load is never the main-only case', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), addOverlayFn, rebuild });
    expect(rebuild).toHaveBeenCalledWith(expect.objectContaining({ mainOnly: false }));
  });

  it('--dry-run never calls addOverlayFn or rebuild at all', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn();
    const dryRunRebuildFn = vi.fn(async () => ({ dryRun: true, wouldDo: 'rebuild-and-smoke', plan: { finalSha: 'x' } }));
    const result = await runDaemonLoadOverlay({
      clone: '/some/clone', ref: 'lane/x', dryRun: true, addOverlayFn, rebuild, dryRunRebuildFn,
    });
    expect(addOverlayFn).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  it('--dry-run appends the ref VIRTUALLY via extraOverlays, never writing it', async () => {
    const dryRunRebuildFn = vi.fn(async () => ({ dryRun: true, wouldDo: 'nothing' }));
    await runDaemonLoadOverlay({
      clone: '/some/clone', ref: 'lane/x', pr: 7, dryRun: true, dryRunRebuildFn,
    });
    expect(dryRunRebuildFn).toHaveBeenCalledWith(expect.objectContaining({
      root: '/some/clone', extraOverlays: [{ ref: 'lane/x', pr: 7 }],
    }));
  });
});

describe('mergeOverlayRef — injected git', () => {
  const runner = (overrides = {}) => {
    const calls = [];
    const run = (args) => {
      calls.push(args.join(' '));
      const key = args[0] === 'rev-list' ? 'rev-list' : args[0];
      const r = overrides[key];
      if (typeof r === 'function') return r(args);
      return r ?? { status: 0, stdout: key === 'symbolic-ref' ? 'main\n' : key === 'rev-list' ? '2\n' : '' };
    };
    return { run, calls };
  };

  it('on the home branch, clean, behind → fetches and merges the OVERLAY ref, not the home branch', () => {
    const { run, calls } = runner();
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/xkse05k-gh-app-shim-401-fallback', run });
    expect(r).toEqual({ merged: true, commits: 2, reason: 'merged' });
    expect(calls).toContain('fetch --quiet -- origin lane/xkse05k-gh-app-shim-401-fallback');
    expect(calls.some((c) => c.startsWith('merge origin/lane/xkse05k-gh-app-shim-401-fallback'))).toBe(true);
  });

  it('THE LIVE BUG: on `main` (the home branch), overlaying a DIFFERENT ref is never refused as not-on-base', () => {
    const { run } = runner(); // symbolic-ref reports 'main' by default
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/some-other-branch', homeBranch: 'main', run });
    expect(r.reason).not.toBe('not-on-base');
    expect(r.merged).toBe(true);
  });

  it('NOT on the home branch → not-on-base, never fetches', () => {
    const { run, calls } = runner({ 'symbolic-ref': { status: 0, stdout: 'some-other-branch\n' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', homeBranch: 'main', run });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'not-on-base' });
    expect(calls.some((c) => c.startsWith('fetch'))).toBe(false);
  });

  it('a dirty tree never reaches fetch or merge', () => {
    const { run, calls } = runner({ status: { status: 0, stdout: ' M file.txt\n' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r.reason).toBe('dirty');
    expect(calls.some((c) => c.startsWith('fetch') || c.startsWith('merge'))).toBe(false);
  });

  it('a merge CONFLICT is ALWAYS aborted before returning — never left mid-merge', () => {
    const { run, calls } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: 'CONFLICT' }) });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(calls).toContain('merge --abort');
  });

  it('already up to date on the overlay ref → reports it, never merges', () => {
    const { run, calls } = runner({ 'rev-list': { status: 0, stdout: '0\n' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'up-to-date' });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it.each(['fetch', 'symbolic-ref', 'status'])('a failed/timed-out `%s` fails closed, never reaching merge', (site) => {
    const { run, calls } = runner({ [site]: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r.merged).toBe(false);
    expect(['head-failed', 'status-failed', 'fetch-failed']).toContain(r.reason);
    expect(calls.some((c) => c.startsWith('merge') && !c.includes('--abort'))).toBe(false);
  });

  it('a `--ref` that looks like a git option is refused before any git runs (argv injection)', () => {
    expect(() => mergeOverlayRef({ root: '/x', ref: '--upload-pack=touch /tmp/pwned;', run: () => ({ status: 0, stdout: '' }) })).toThrow(/not a safe branch name/);
  });
});

describe('dryRunOverlay — injected git, never merges', () => {
  it('reports onHome/dirty/behind without ever calling merge', () => {
    const calls = [];
    const run = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'main\n' };
      if (args[0] === 'status') return { status: 0, stdout: '' };
      if (args[0] === 'fetch') return { status: 0, stdout: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: '3\n' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'deadbeef\n' };
      return { status: 0, stdout: '' };
    };
    const r = dryRunOverlay({ root: '/x', ref: 'lane/x', run });
    expect(r).toEqual({ onHome: true, dirty: false, fetched: true, behind: 3, headSha: 'deadbeef', wouldMerge: true });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('not on home branch → wouldMerge:false, still read-only', () => {
    const run = (args) => {
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'some-other\n' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'deadbeef\n' };
      return { status: 0, stdout: '' };
    };
    const r = dryRunOverlay({ root: '/x', ref: 'lane/x', run });
    expect(r.onHome).toBe(false);
    expect(r.wouldMerge).toBe(false);
  });
});

describe('mergeOverlayRef / dryRunOverlay — REAL git (temp repos), proving the conflict-abort fix live', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`); };
  const realRun = (args, opts) => {
    try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overlay-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    const up = join(dir, 'upstream');
    git(up, 'checkout', '-q', '-b', 'main');
    commit(up, 'a.txt', 'one\n');
    git(up, 'push', '-q', 'origin', 'main');
    // an overlay branch, diverged from main with its own commit
    git(up, 'checkout', '-q', '-b', 'lane/overlay');
    commit(up, 'overlay.txt', 'overlay side\n');
    git(up, 'push', '-q', 'origin', 'lane/overlay');
    git(up, 'checkout', '-q', 'main');
    // the daemon clone — stays on `main` throughout, exactly like the real incident
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'daemon');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('the race: overlay registered AFTER the build being adopted was smoked (live 2026-10-09, PR #4669)', () => {
    it.each([1, 0])('checks actual installed ancestry with %s follow-up rebuilds', async (followUpRebuilds) => {
      const daemon = join(dir, 'daemon');
      git(daemon, 'fetch', 'origin');
      const head = git(daemon, 'rev-parse', 'HEAD').trim();
      const tip = git(daemon, 'rev-parse', 'origin/lane/overlay').trim();
      expect(overlayInstalled({ root: daemon, ref: 'lane/overlay', run: realRun }))
        .toEqual({ inHead: false, tip, head, reason: 'not-in-head' });
      const rebuild = vi.fn()
        .mockResolvedValueOnce({ moved: true, adopted: true, head, reason: 'ready-adopted' })
        .mockImplementationOnce(async () => {
          expect(realRun(['merge', '--no-edit', 'origin/lane/overlay'], { cwd: daemon }).status).toBe(0);
          return { moved: true, adopted: true, head: git(daemon, 'rev-parse', 'HEAD').trim() };
        });
      const result = await runDaemonLoadOverlay({
        clone: daemon, ref: 'lane/overlay', pr: 1, versions: null, log: quietLog,
        settings: overlaySafetySettings({ WE_OVERLAY_DISPATCH_SMOKE: 'off' }, { readSettings: () => null }),
        addOverlayFn: vi.fn(), rebuild, followUpRebuilds,
        installed: (o) => overlayInstalled({ ...o, run: realRun }),
      });
      expect(result.staleAdopt).toEqual({ head, tip, reason: 'not-in-head' });
      expect(result.followUps).toBe(followUpRebuilds);
      expect(rebuild).toHaveBeenCalledTimes(1 + followUpRebuilds);
      expect(result.adopted).toBe(!!followUpRebuilds);
      expect(realRun(['merge-base', '--is-ancestor', tip, 'HEAD'], { cwd: daemon }).status).toBe(followUpRebuilds ? 0 : 1);
      if (!followUpRebuilds) expect(result).toMatchObject({ reason: 'installed-build-lacks-overlay', pending: true });
    });
  });

  it('a clean overlay merges into `main` while the clone stays ON `main` the whole time', () => {
    const d = join(dir, 'daemon');
    const r = mergeOverlayRef({ root: d, ref: 'lane/overlay', homeBranch: 'main', run: realRun });
    expect(r).toEqual({ merged: true, commits: 1, reason: 'merged' });
    expect(git(d, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(git(d, 'ls-files')).toContain('overlay.txt');
    expect(git(d, 'status', '--porcelain').trim()).toBe('');
  });

  it('a CONFLICTING overlay is aborted — HEAD and the tree are exactly as before, never left mid-merge', () => {
    const d = join(dir, 'daemon');
    commit(d, 'overlay.txt', 'conflicting local content\n'); // conflicts with the overlay branch's own overlay.txt
    const headBefore = git(d, 'rev-parse', 'HEAD').trim();
    const r = mergeOverlayRef({ root: d, ref: 'lane/overlay', homeBranch: 'main', run: realRun });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(git(d, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(d, 'status', '--porcelain').trim()).toBe(''); // NOT mid-merge — this is the live bug, fixed
    expect(existsSync(join(d, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('--dry-run reports a real fetch + real ahead/behind count with NO merge ever attempted', () => {
    const d = join(dir, 'daemon');
    const headBefore = git(d, 'rev-parse', 'HEAD').trim();
    const preview = dryRunOverlay({ root: d, ref: 'lane/overlay', homeBranch: 'main', run: realRun });
    expect(preview.onHome).toBe(true);
    expect(preview.dirty).toBe(false);
    expect(preview.fetched).toBe(true);
    expect(preview.behind).toBe(1);
    expect(preview.wouldMerge).toBe(true);
    expect(git(d, 'rev-parse', 'HEAD').trim()).toBe(headBefore); // untouched
    expect(git(d, 'ls-files')).not.toContain('overlay.txt'); // not merged
  });
});

// ── xkhtg2a — the dispatch smoke (incident 2026-10-08: lane/worker-contract-s3b's detached `claude -p` launch had no
// `--permission-mode`, every fix/ci-heal worker died at step 0 on an approval prompt, and the load's smoke passed
// because it never launched a real worker). These tests pin the gate's decisions; the real-worker launch itself is
// proven live (see the PR), never from a unit test. The "smoke completions never touch the real store" guarantee is
// defended by the `runRealDispatchSmoke — ... SCRATCH store` describe below, which drives the prompt's own report
// command and the child env through the REAL completion-cli against a real store dir and asserts it stays empty.
import {
  overlaySafetySettings, matchDispatchPaths, overlayDispatchFiles, judgeDispatchSmoke, withDispatchSmoke, runRealDispatchSmoke,
  rollbackVersionIfCurrent, DISPATCH_PATH_DEFAULTS, readFileTail,
} from '../daemon-load-overlay.mjs';

const quietLog = { error: () => {}, log: () => {} };

describe('overlaySafetySettings — defaults < settings file < env', () => {
  it('defaults: smoke on, the derived dispatch-path set, no-PR warns', () => {
    const s = overlaySafetySettings({}, { readSettings: () => null });
    expect(s.dispatchSmoke).toBe('on');
    expect(s.noPr).toBe('warn');
    expect(s.dispatchPaths).toEqual(DISPATCH_PATH_DEFAULTS);
    expect(s.smokeKind).toBe('ci-heal');
    expect(s.smokeTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('the settings file overrides the defaults, env overrides the file', () => {
    const readSettings = () => ({ overlaySafety: { noPr: 'refuse', dispatchSmoke: 'off', dispatchPaths: ['a/**'] } });
    expect(overlaySafetySettings({}, { readSettings })).toMatchObject({ noPr: 'refuse', dispatchSmoke: 'off', dispatchPaths: ['a/**'] });
    const env = { WE_OVERLAY_NO_PR: 'warn', WE_OVERLAY_DISPATCH_SMOKE: 'on', WE_OVERLAY_DISPATCH_PATHS: 'x/*.mjs, y/**' };
    expect(overlaySafetySettings(env, { readSettings })).toMatchObject({ noPr: 'warn', dispatchSmoke: 'on', dispatchPaths: ['x/*.mjs', 'y/**'] });
  });

  it('an invalid value falls back to the default, never to "off"', () => {
    const s = overlaySafetySettings({ WE_OVERLAY_DISPATCH_SMOKE: 'maybe', WE_OVERLAY_NO_PR: 'ignore' }, { readSettings: () => null });
    expect(s.dispatchSmoke).toBe('on');
    expect(s.noPr).toBe('warn');
  });
});

describe('matchDispatchPaths — which overlay files are on the dispatch path', () => {
  it('the defaults catch the incident file and the worker launch files, not their tests or unrelated files', () => {
    const files = [
      'scripts/operations/worker-wrapper-launch.mjs',
      'scripts/operations/dispatch-lane-io.mjs',
      'scripts/conveyor/reconcile-fix-dispatch.mjs',
      'scripts/operations/__tests__/worker-wrapper-launch.test.mjs',
      'docs/agent/backlog-workflow.md',
      'scripts/lib/daemon-overlays.mjs',
    ];
    expect(matchDispatchPaths(files, DISPATCH_PATH_DEFAULTS)).toEqual([
      'scripts/operations/worker-wrapper-launch.mjs',
      'scripts/operations/dispatch-lane-io.mjs',
      'scripts/conveyor/reconcile-fix-dispatch.mjs',
    ]);
  });

  it('`*` stops at a slash, `**` does not', () => {
    expect(matchDispatchPaths(['a/b.mjs', 'a/c/d.mjs'], ['a/*.mjs'])).toEqual(['a/b.mjs']);
    expect(matchDispatchPaths(['a/b.mjs', 'a/c/d.mjs'], ['a/**'])).toEqual(['a/b.mjs', 'a/c/d.mjs']);
  });
});

describe('overlayDispatchFiles — is the overlay in this tree, and does it touch the dispatch path (injected git)', () => {
  const fakeGit = (map) => vi.fn((args) => {
    const key = args.join(' ');
    for (const [k, v] of Object.entries(map)) if (key.startsWith(k)) return v;
    return { status: 1, stdout: '', stderr: 'unexpected' };
  });

  it('an overlay in the tree that touches a dispatch file is required', () => {
    const run = fakeGit({
      'rev-parse --verify --quiet origin/lane/x^{commit}': { status: 0, stdout: 'tip\n' },
      'merge-base --is-ancestor tip HEAD': { status: 0, stdout: '' },
      'merge-base origin/main tip': { status: 0, stdout: 'base\n' },
      'diff --name-only base tip': { status: 0, stdout: 'scripts/operations/worker-wrapper-launch.mjs\nREADME.md\n' },
    });
    const r = overlayDispatchFiles({ tree: '/t', ref: 'lane/x', patterns: DISPATCH_PATH_DEFAULTS, run });
    expect(r).toMatchObject({ inTree: true, required: true, matched: ['scripts/operations/worker-wrapper-launch.mjs'], tip: 'tip' });
  });

  it('an overlay that touches no dispatch file is not required', () => {
    const run = fakeGit({
      'rev-parse --verify --quiet origin/lane/x^{commit}': { status: 0, stdout: 'tip\n' },
      'merge-base --is-ancestor tip HEAD': { status: 0, stdout: '' },
      'merge-base origin/main tip': { status: 0, stdout: 'base\n' },
      'diff --name-only base tip': { status: 0, stdout: 'README.md\n' },
    });
    expect(overlayDispatchFiles({ tree: '/t', ref: 'lane/x', patterns: DISPATCH_PATH_DEFAULTS, run })).toMatchObject({ inTree: true, required: false });
  });

  it('an overlay NOT in this tree (a fallback build without it) is never smoked here', () => {
    const run = fakeGit({
      'rev-parse --verify --quiet origin/lane/x^{commit}': { status: 0, stdout: 'tip\n' },
      'merge-base --is-ancestor tip HEAD': { status: 1, stdout: '' },
    });
    expect(overlayDispatchFiles({ tree: '/t', ref: 'lane/x', patterns: DISPATCH_PATH_DEFAULTS, run })).toMatchObject({ inTree: false, required: false });
  });

  it('fails CLOSED: an unreadable diff of an in-tree overlay is required', () => {
    const run = fakeGit({
      'rev-parse --verify --quiet origin/lane/x^{commit}': { status: 0, stdout: 'tip\n' },
      'merge-base --is-ancestor tip HEAD': { status: 0, stdout: '' },
      'merge-base origin/main tip': { status: 1, stdout: '' },
    });
    expect(overlayDispatchFiles({ tree: '/t', ref: 'lane/x', patterns: DISPATCH_PATH_DEFAULTS, run })).toMatchObject({ inTree: true, required: true, files: null, reason: 'diff-unknown' });
  });
});

describe('judgeDispatchSmoke — the pass/fail rule for one real worker', () => {
  const done = { status: 'done', outcome: 'not-applicable', result: { blocker: null } };

  it('passes when the marker carries the nonce, the completion record is done, and nothing was denied', () => {
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: 'n1', record: done, denials: [] })).toMatchObject({ ok: true, reason: 'passed' });
  });

  it('THE INCIDENT: the worker ended at step 0 on an approval prompt — record done, no marker, a denial in the transcript', () => {
    const record = { status: 'done', result: { outcome: 'blocked', blocker: { kind: 'permission-wall', detail: 'gh pr view' } } };
    const r = judgeDispatchSmoke({ nonce: 'n1', marker: null, record, denials: ['This command requires approval'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('commands-denied');
    expect(r.detail).toBe('1 denied tool call(s) in the transcript');
  });

  it('a worker-written blocker kind reaches the detail only as a plain token', () => {
    const record = (kind) => ({ status: 'done', result: { blocker: { kind } } });
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: 'n1', record: record('permission-wall'), denials: [] }).detail).toBe('blocker=permission-wall');
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: 'n1', record: record('permission "mikeword13x"'), denials: [] }).detail).toBe('blocker=unrecognised');
  });

  it('a done record without the marker fails even with no transcript to read', () => {
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: null, record: done, denials: [] })).toMatchObject({ ok: false, reason: 'no-commands-ran' });
  });

  it('a permission-wall blocker on the record fails even when the marker exists', () => {
    const record = { status: 'done', result: { blocker: { kind: 'permission-wall' } } };
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: 'n1', record, denials: [] })).toMatchObject({ ok: false, reason: 'commands-denied' });
  });

  it('no completion record (yet) is not a pass; at the deadline it is a timeout', () => {
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: 'n1', record: null, denials: [] })).toMatchObject({ ok: false, pending: true });
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: 'n1', record: null, denials: [], timedOut: true })).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('a wrong nonce (a stale marker from another run) is not a pass', () => {
    expect(judgeDispatchSmoke({ nonce: 'n1', marker: 'n0', record: done, denials: [] })).toMatchObject({ ok: false, reason: 'no-commands-ran' });
  });
});

describe('withDispatchSmoke — the candidate smoke runs ONE real worker when the overlay touches the dispatch path', () => {
  const settings = overlaySafetySettings({}, { readSettings: () => null });
  const pass = { verdict: 'pass', smoke: { results: [] } };

  it('base smoke passes + overlay on the dispatch path → the dispatch smoke runs against the CANDIDATE tree', async () => {
    const ctl = {};
    const dispatchSmoke = vi.fn(async () => ({ ok: true, reason: 'passed' }));
    const runSmoke = withDispatchSmoke({
      baseSmoke: async () => pass, ref: 'lane/x', settings, dispatchSmoke, ctl, log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['scripts/operations/worker-wrapper-launch.mjs'] }),
    });
    const r = await runSmoke({ root: '/cand', env: { A: '1' }, changedFiles: null });
    expect(r.verdict).toBe('pass');
    expect(dispatchSmoke).toHaveBeenCalledWith(expect.objectContaining({ tree: '/cand', env: { A: '1' } }));
    expect(ctl).toMatchObject({ ran: true, phase: 'candidate', result: { ok: true } });
  });

  it('a FAILED dispatch smoke throws, so the rebuild holds on the last-good tree and never adopts — or drops other overlays', async () => {
    const ctl = {};
    const runSmoke = withDispatchSmoke({
      baseSmoke: async () => pass, ref: 'lane/x', settings, ctl, log: quietLog,
      dispatchSmoke: async () => ({ ok: false, reason: 'commands-denied', detail: 'requires approval' }),
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
    });
    await expect(runSmoke({ root: '/cand', env: {} })).rejects.toThrow(/dispatch-smoke-failed/);
    expect(ctl).toMatchObject({ ran: true, result: { ok: false, reason: 'commands-denied' } });
  });

  it('a worker launch that THROWS is recorded as a failed smoke in ctl (so the caller rolls back), and still throws so the rebuild holds', async () => {
    const ctl = {};
    const runSmoke = withDispatchSmoke({
      baseSmoke: async () => pass, ref: 'lane/x', settings, ctl, log: quietLog,
      dispatchSmoke: async () => { throw new Error('spawn EMFILE\n  at stack line'); },
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
    });
    await expect(runSmoke({ root: '/cand', env: {} })).rejects.toThrow(/dispatch-smoke-failed: smoke-threw — spawn EMFILE/);
    expect(ctl).toMatchObject({ ran: true, phase: 'candidate', result: { ok: false, reason: 'smoke-threw', detail: 'spawn EMFILE' } });
  });

  it('an inspect that THROWS fails CLOSED: the overlay is treated as on the dispatch path and the smoke runs', async () => {
    const ctl = {};
    const dispatchSmoke = vi.fn(async () => ({ ok: true, reason: 'passed' }));
    const runSmoke = withDispatchSmoke({
      baseSmoke: async () => pass, ref: 'lane/x', settings, ctl, log: quietLog, dispatchSmoke,
      inspect: () => { throw new Error('git diff unreadable'); },
    });
    await runSmoke({ root: '/cand', env: {} });
    expect(dispatchSmoke).toHaveBeenCalledTimes(1);
    expect(ctl).toMatchObject({ ran: true, phase: 'candidate', required: true });
  });

  it('a failing BASE smoke is returned untouched and no worker is launched', async () => {
    const dispatchSmoke = vi.fn();
    const fail = { verdict: 'code', smoke: { results: [{ name: 'x', ok: false }] } };
    const runSmoke = withDispatchSmoke({
      baseSmoke: async () => fail, ref: 'lane/x', settings, dispatchSmoke, ctl: {}, log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
    });
    expect(await runSmoke({ root: '/cand', env: {} })).toBe(fail);
    expect(dispatchSmoke).not.toHaveBeenCalled();
  });

  it('an overlay off the dispatch path (or not in this candidate) launches nothing', async () => {
    const dispatchSmoke = vi.fn();
    const runSmoke = withDispatchSmoke({
      baseSmoke: async () => pass, ref: 'lane/x', settings, dispatchSmoke, ctl: {}, log: quietLog,
      inspect: () => ({ inTree: true, required: false, matched: [] }),
    });
    expect((await runSmoke({ root: '/cand', env: {} })).verdict).toBe('pass');
    expect(dispatchSmoke).not.toHaveBeenCalled();
  });
});

describe('runDaemonLoadOverlay — dispatch smoke wiring, rollback of ONLY this overlay, the no-PR policy', () => {
  const settingsOn = overlaySafetySettings({}, { readSettings: () => null });

  it('passes a dispatch-smoke-wrapped runSmoke into the gated rebuild', async () => {
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, settings: settingsOn, log: quietLog,
      inspect: () => ({ inTree: false, required: false }),
    });
    expect(typeof rebuild.mock.calls[0][0].runSmoke).toBe('function');
  });

  it('a candidate dispatch-smoke failure removes ONLY this overlay, rebuilds, and reports why (exit-worthy)', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [{ ref: 'lane/other' }] }));
    const appendEventFn = vi.fn();
    let calls = 0;
    const rebuild = vi.fn(async ({ runSmoke }) => {
      calls += 1;
      if (calls === 1) {
        try { await runSmoke({ root: '/cand', env: {} }); } catch (e) { return { moved: false, reason: 'smoke-threw', alerts: [{ kind: 'smoke-threw', detail: String(e.message) }] }; }
      }
      return { moved: false, reason: 'up-to-date' };
    });
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn, settings: settingsOn, log: quietLog,
      baseSmoke: async () => ({ verdict: 'pass' }),
      inspect: () => ({ inTree: true, required: true, matched: ['scripts/operations/worker-wrapper-launch.mjs'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'commands-denied', detail: 'This command requires approval' }),
    });
    expect(removeOverlayFn).toHaveBeenCalledWith('/c', 'lane/x', expect.objectContaining({ why: expect.stringMatching(/dispatch-smoke-failed/) }));
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(appendEventFn).toHaveBeenCalledWith('/c', expect.objectContaining({ kind: 'removed', ref: 'lane/x' }), expect.anything());
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ adopted: false, rolledBack: true, reason: 'dispatch-smoke-failed', dispatchSmoke: { phase: 'candidate', result: { reason: 'commands-denied' } } });
  });

  // The real smoke builds `detail` from an allow-listed summary (the runRealDispatchSmoke tests below); this sink only
  // bounds whatever detail an injected smoke returns and redacts token shapes.
  it('the rollback path bounds a smoke-supplied detail before the event log, the thrown error and the log', async () => {
    const secrets = ['ghp_secretAAAA', 'github_pat_secretBBBB'];
    const appendEventFn = vi.fn();
    const log = { error: vi.fn(), log: () => {} };
    const thrown = [];
    let calls = 0;
    const rebuild = vi.fn(async ({ runSmoke }) => {
      calls += 1;
      if (calls === 1) {
        try { await runSmoke({ root: '/cand', env: {} }); } catch (e) { thrown.push(String(e.message)); return { moved: false, reason: 'smoke-threw', alerts: [] }; }
      }
      return { moved: false, reason: 'up-to-date' };
    });
    await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn: vi.fn(() => ({ removed: true, list: [] })), appendEventFn, settings: settingsOn, log,
      baseSmoke: async () => ({ verdict: 'pass' }),
      inspect: () => ({ inTree: true, required: true, matched: ['scripts/operations/worker-wrapper-launch.mjs'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'commands-denied', detail: `${secrets.join(' ')} ${'w'.repeat(20_000)}` }),
    });
    const reason = appendEventFn.mock.calls[0][1].reason;
    // The dispatch detail is an allow-listed summary, bounded at 4,000 so its trailing file path is never cut off.
    expect(reason.length).toBeLessThanOrEqual(4_000);
    const sinks = [reason, thrown.join('\n'), log.error.mock.calls.map((c) => c.join(' ')).join('\n')];
    for (const s of ['secretAAAA', 'secretBBBB']) for (const sink of sinks) expect(sink).not.toContain(s);
  });

  it('a candidate worker launch that THROWS removes ONLY this overlay and rebuilds without it — it is not left registered with a not-in-tree warning', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [] }));
    let calls = 0;
    const rebuild = vi.fn(async ({ runSmoke }) => {
      calls += 1;
      if (calls === 1) {
        try { await runSmoke({ root: '/cand', env: {} }); } catch (e) { return { moved: false, reason: 'smoke-threw', alerts: [{ kind: 'smoke-threw', detail: String(e.message) }] }; }
      }
      return { moved: false, reason: 'up-to-date' };
    });
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
      baseSmoke: async () => ({ verdict: 'pass' }),
      inspect: ({ tree }) => ({ inTree: tree === '/cand', required: true, matched: ['scripts/operations/worker-wrapper-launch.mjs'] }),
      dispatchSmoke: async () => { throw new Error('spawn EMFILE'); },
    });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({
      registered: false, rolledBack: true, reason: 'dispatch-smoke-failed', dispatchSmoke: { phase: 'candidate', result: { ok: false, reason: 'smoke-threw' } },
    });
  });

  it('a rebuild that REJECTS after the candidate smoke already failed still removes the overlay (ctl holds the failure)', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [] }));
    let calls = 0;
    const rebuild = vi.fn(async ({ runSmoke }) => {
      calls += 1;
      if (calls === 1) {
        try { await runSmoke({ root: '/cand', env: {} }); } catch { /* the rebuild swallows it, then dies on something else */ }
        throw new Error('lock busy');
      }
      return { moved: false, reason: 'up-to-date' };
    });
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
      baseSmoke: async () => ({ verdict: 'pass' }),
      inspect: ({ tree }) => ({ inTree: tree === '/cand', required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'commands-denied' }),
    });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ rolledBack: true, registered: false });
  });

  it('a rebuild that rejects with NO failed smoke is not swallowed', async () => {
    await expect(runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild: async () => { throw new Error('boom'); }, settings: settingsOn, log: quietLog,
      baseSmoke: async () => ({ verdict: 'pass' }), inspect: () => ({ inTree: false, required: false }),
    })).rejects.toThrow('boom');
  });

  it('removeOverlay THROWING (list lock timeout) is reported — the overlay is NOT claimed removed, and no rebuild runs on a list that still has it', async () => {
    const rebuildWithout = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const dispatchSmoke = async () => ({ ok: false, reason: 'no-commands-ran' });
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild: vi.fn(async () => ({ moved: true, adopted: true, reason: 'adopted' })),
      removeOverlayFn: () => { throw new Error('overlay list lock timeout'); }, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
      dispatchSmoke, inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
    });
    expect(rebuildWithout).not.toHaveBeenCalled();
    expect(r).toMatchObject({ rolledBack: true, removed: false, rollback: { adopted: false, reason: expect.stringMatching(/remove-failed.*lock timeout/) } });
  });

  it('a dispatch smoke that resolves to a non-object is a failed smoke, not a TypeError outside every guard', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [] }));
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild: vi.fn(async () => ({ moved: true, adopted: true, reason: 'adopted' })),
      removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
      dispatchSmoke: async () => undefined, inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
    });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ rolledBack: true, dispatchSmoke: { result: { ok: false, reason: 'smoke-bad-result' } } });
  });

  it('the live-clone inspect THROWING fails CLOSED: the live clone is smoked (and rolled back on failure) instead of the load rejecting with the overlay registered', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [] }));
    const dispatchSmoke = vi.fn(async () => ({ ok: false, reason: 'no-commands-ran' }));
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild: vi.fn(async () => ({ moved: true, adopted: true, reason: 'adopted', head: 'h' })),
      removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog, dispatchSmoke,
      inspect: () => { throw new Error('git diff unreadable'); },
    });
    expect(dispatchSmoke).toHaveBeenCalledWith(expect.objectContaining({ tree: '/c' }));
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ rolledBack: true, dispatchSmoke: { phase: 'post-adopt', required: true } });
  });

  it('adopted WITHOUT the candidate dispatch smoke (a cached tree, or a daemon tick adopted it first) → smoke the live clone, roll back on failure', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [] }));
    const rebuild = vi.fn()
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'h1' })
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'h0' });
    const dispatchSmoke = vi.fn(async () => ({ ok: false, reason: 'no-commands-ran' }));
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }), dispatchSmoke,
    });
    expect(dispatchSmoke).toHaveBeenCalledWith(expect.objectContaining({ tree: '/c' }));
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ rolledBack: true, reason: 'dispatch-smoke-failed', head: 'h0', dispatchSmoke: { phase: 'post-adopt' } });
  });

  it('a passing dispatch smoke keeps the overlay and reports the pass', async () => {
    const removeOverlayFn = vi.fn();
    const rebuild = vi.fn(async ({ runSmoke }) => { await runSmoke({ root: '/cand', env: {} }); return { moved: true, adopted: true, head: 'h1' }; });
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, settings: settingsOn, log: quietLog,
      baseSmoke: async () => ({ verdict: 'pass' }),
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: true, reason: 'passed' }),
    });
    expect(removeOverlayFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ adopted: true, dispatchSmoke: { ran: true, phase: 'candidate', result: { ok: true } } });
  });

  it('no PR + noPr=warn → warns loudly and still loads', async () => {
    const errors = [];
    const addOverlayFn = vi.fn();
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: null, addOverlayFn, rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
      settings: settingsOn, log: { error: (m) => errors.push(m) }, inspect: () => ({ inTree: false, required: false }),
    });
    expect(addOverlayFn).toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/NO PR/);
    expect(r.warnings).toContain('no-pr');
  });

  it('no PR + noPr=refuse → refuses before registering anything', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn();
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: null, addOverlayFn, rebuild, settings: { ...settingsOn, noPr: 'refuse' }, log: quietLog,
    });
    expect(addOverlayFn).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(r).toMatchObject({ registered: false, refused: true, reason: 'no-pr' });
  });

  it('dispatchSmoke=off → the plain rebuild smoke, no wrapper', async () => {
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, settings: { ...settingsOn, dispatchSmoke: 'off' }, log: quietLog,
      baseSmoke: 'BASE',
    });
    expect(rebuild.mock.calls[0][0].runSmoke).toBe('BASE');
  });
});

// ── xkhtg2a review round 1 — (1) a VERSIONED clone returned before any smoke or rollback could run; (2) nothing
// defended "the smoke's completion record never touches the real store".
describe('runDaemonLoadOverlay — versioned clone (the in-tick updater builds; this CLI smokes what --wait reports adopted)', () => {
  const settingsOn = overlaySafetySettings({}, { readSettings: () => null });
  const vctx = { name: 'v', dir: '/v' };
  const versionedBase = {
    clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), settings: settingsOn, versions: vctx, wait: true,
    rebuild: () => { throw new Error('a versioned clone is never rebuilt from this CLI'); },
  };

  it('no --wait → queues the request, launches NOTHING, and says loudly that no smoke ran', async () => {
    const errors = [];
    const dispatchSmoke = vi.fn();
    const r = await runDaemonLoadOverlay({
      ...versionedBase, wait: false, submit: () => 'req1', dispatchSmoke, log: { error: (m) => errors.push(m) },
    });
    expect(dispatchSmoke).not.toHaveBeenCalled();
    expect(r).toMatchObject({ versioned: true, pending: true, dispatchSmoke: { ran: false, skipped: 'versioned-no-wait' } });
    expect(r.warnings).toContain('dispatch-smoke-not-run');
    expect(errors.join('\n')).toMatch(/NO dispatch smoke ran/);
  });

  const adopted = { status: 'answered', moved: true, adopted: true, reason: 'adopted', head: 'h1', versionId: 'v1' };

  it('--wait + adopted + the overlay IS in THAT version → smoke it; a failure removes ONLY this overlay and rolls the VERSION back (never a no-op re-request)', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [] }));
    const appendEventFn = vi.fn();
    const submit = vi.fn(() => 'req1');
    const rollbackVersionFn = vi.fn(async () => ({ status: 'switched', id: 'v0', previous: 'v1' }));
    const dispatchSmoke = vi.fn(async () => ({ ok: false, reason: 'commands-denied', detail: 'This command requires approval' }));
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit, waitFor: async () => adopted, removeOverlayFn, appendEventFn, dispatchSmoke, rollbackVersionFn, log: quietLog,
      inspect: ({ tree }) => ({ inTree: tree === '/v/versions/v1', required: true, matched: ['scripts/operations/worker-wrapper-launch.mjs'] }),
    });
    expect(dispatchSmoke).toHaveBeenCalledWith(expect.objectContaining({ tree: '/v/versions/v1' })); // the version the request adopted
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(removeOverlayFn).toHaveBeenCalledWith('/c', 'lane/x', expect.objectContaining({ why: expect.stringMatching(/dispatch-smoke-failed/) }));
    expect(appendEventFn).toHaveBeenCalledWith('/c', expect.objectContaining({ kind: 'removed', ref: 'lane/x' }), expect.anything());
    expect(rollbackVersionFn).toHaveBeenCalledWith(expect.objectContaining({ clone: vctx.clone, home: vctx.home }));
    expect(submit).toHaveBeenCalledTimes(1); // no second queued request, no second wait
    expect(r).toMatchObject({
      rolledBack: true, adopted: false, reason: 'dispatch-smoke-failed', rollback: { reason: 'switched', adopted: true },
      dispatchSmoke: { phase: 'post-adopt', result: { reason: 'commands-denied' } },
    });
  });

  it('the smoke targets the version in the RESULT, not whatever `current` points at now', async () => {
    const dispatchSmoke = vi.fn(async () => ({ ok: true, reason: 'passed' }));
    await runDaemonLoadOverlay({
      ...versionedBase, submit: () => 'req1', waitFor: async () => ({ ...adopted, versionId: 'v7' }), dispatchSmoke, log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
    });
    expect(dispatchSmoke).toHaveBeenCalledWith(expect.objectContaining({ tree: '/v/versions/v7' }));
  });

  it('a version rollback that does NOT switch is reported as such (never "recovered")', async () => {
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit: vi.fn(() => 'r'), waitFor: async () => adopted, removeOverlayFn: vi.fn(), appendEventFn: vi.fn(), log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'no-commands-ran' }),
      rollbackVersionFn: async () => ({ status: 'no-previous' }),
    });
    expect(r).toMatchObject({ rolledBack: true, rollback: { reason: 'no-previous', adopted: false } });
  });

  it('the version rollback is told WHICH version failed, so it can refuse to touch a newer one', async () => {
    const rollbackVersionFn = vi.fn(async () => ({ status: 'switched' }));
    await runDaemonLoadOverlay({
      ...versionedBase, submit: vi.fn(() => 'r'), waitFor: async () => ({ ...adopted, versionId: 'v7' }), removeOverlayFn: vi.fn(), appendEventFn: vi.fn(), log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'no-commands-ran' }), rollbackVersionFn,
    });
    expect(rollbackVersionFn).toHaveBeenCalledWith(expect.objectContaining({ versionId: 'v7' }));
  });

  it('a newer version already superseded the failed one → nothing is rolled back and the result says so (never "may still be live")', async () => {
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit: vi.fn(() => 'r'), waitFor: async () => adopted, removeOverlayFn: vi.fn(), appendEventFn: vi.fn(), log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'no-commands-ran' }),
      rollbackVersionFn: async () => ({ status: 'current-moved', actual: 'v2' }),
    });
    expect(r).toMatchObject({ rolledBack: true, rollback: { reason: 'current-moved', adopted: false, superseded: true, actual: 'v2' } });
  });

  it('a worker launch that THROWS is a failed smoke → rolled back, not an unhandled rejection with the overlay left registered', async () => {
    const removeOverlayFn = vi.fn();
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit: () => 'r', waitFor: async () => adopted, removeOverlayFn, appendEventFn: vi.fn(), log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => { throw new Error('spawn EMFILE'); },
      rollbackVersionFn: async () => ({ status: 'switched' }),
    });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ rolledBack: true, dispatchSmoke: { result: { ok: false, reason: 'smoke-threw', detail: 'spawn EMFILE' } } });
  });

  it('a throw while recovering still returns the rolled-back result and its evidence', async () => {
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit: () => 'r', waitFor: async () => adopted, removeOverlayFn: vi.fn(), appendEventFn: vi.fn(), log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'no-commands-ran' }),
      rollbackVersionFn: async () => { throw new Error('lock busy'); },
    });
    expect(r).toMatchObject({ rolledBack: true, rollback: { reason: 'error: lock busy', adopted: false } });
  });

  it('--wait + adopted + a passing smoke keeps the overlay', async () => {
    const removeOverlayFn = vi.fn();
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit: () => 'req1', waitFor: async () => adopted,
      removeOverlayFn, log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: true, reason: 'passed' }),
    });
    expect(removeOverlayFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ adopted: true, dispatchSmoke: { ran: true, phase: 'post-adopt', result: { ok: true } } });
    expect(r.rolledBack).toBeUndefined();
  });

  it('--wait + adopted but the overlay is NOT in the version (the updater builds origin/main only) → no worker, a loud warning, no rollback', async () => {
    const errors = [];
    const dispatchSmoke = vi.fn();
    const removeOverlayFn = vi.fn();
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit: () => 'req1', waitFor: async () => adopted,
      removeOverlayFn, dispatchSmoke, log: { error: (m) => errors.push(m) },
      inspect: () => ({ inTree: false, required: false }),
    });
    expect(dispatchSmoke).not.toHaveBeenCalled();
    expect(removeOverlayFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ adopted: true, dispatchSmoke: { ran: false, skipped: 'overlay-not-in-versioned-tree' } });
    expect(r.warnings).toContain('dispatch-smoke-not-run');
    expect(errors.join('\n')).toMatch(/NO dispatch smoke ran/);
  });

  it('--wait but the request was not adopted (timeout / smoke-failed) → nothing launched, and a loud warning that the overlay stays unsmoked', async () => {
    const dispatchSmoke = vi.fn();
    const r = await runDaemonLoadOverlay({
      ...versionedBase, submit: () => 'req1', waitFor: async () => ({ status: 'timeout', id: 'req1' }), dispatchSmoke, log: quietLog,
    });
    expect(dispatchSmoke).not.toHaveBeenCalled();
    expect(r).toMatchObject({ versioned: true, timedOut: true, adopted: false, dispatchSmoke: { ran: false, skipped: 'not-adopted' } });
    expect(r.warnings).toContain('dispatch-smoke-not-run'); // registered-but-unsmoked is never silent
  });

  it('dispatchSmoke=off → the versioned path adds no warning and launches nothing', async () => {
    const dispatchSmoke = vi.fn();
    const r = await runDaemonLoadOverlay({
      ...versionedBase, wait: false, submit: () => 'req1', dispatchSmoke, settings: { ...settingsOn, dispatchSmoke: 'off' }, log: quietLog,
    });
    expect(dispatchSmoke).not.toHaveBeenCalled();
    expect(r.warnings).not.toContain('dispatch-smoke-not-run');
  });
});

describe('rollbackVersionIfCurrent — undo ONLY the version that failed its smoke (compare-and-swap on `current`)', () => {
  const opts = { clone: '/c', home: '/h', settings: {}, versionId: 'v1', by: 'daemon-load-overlay', reason: 'dispatch-smoke-failed: lane/x' };

  it('current is still the failed version → switch to `previous` guarded by expectCurrent, rejecting the failed version', async () => {
    const statusFn = vi.fn(async () => ({ current: 'v1', previous: 'v0' }));
    const switchFn = vi.fn(async () => ({ status: 'switched', id: 'v0', previous: 'v1' }));
    const r = await rollbackVersionIfCurrent({ ...opts, statusFn, switchFn });
    expect(switchFn).toHaveBeenCalledWith(expect.objectContaining({
      clone: '/c', home: '/h', id: 'v0', expectCurrent: 'v1', rollback: true, reject: 'v1', by: 'daemon-load-overlay',
    }));
    expect(r.status).toBe('switched');
  });

  it('a NEWER version was adopted since (current moved on) → no switch at all: the newer version is not undone, and v1 is not re-adopted', async () => {
    const switchFn = vi.fn();
    const r = await rollbackVersionIfCurrent({ ...opts, statusFn: async () => ({ current: 'v2', previous: 'v1' }), switchFn });
    expect(switchFn).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'current-moved', actual: 'v2' });
  });

  it('no `previous` to go back to → no-previous, nothing switched', async () => {
    const switchFn = vi.fn();
    const r = await rollbackVersionIfCurrent({ ...opts, statusFn: async () => ({ current: 'v1', previous: null }), switchFn });
    expect(switchFn).not.toHaveBeenCalled();
    expect(r.status).toBe('no-previous');
  });

  it('a clone that is not versioned (status disabled) is reported disabled, nothing switched', async () => {
    const switchFn = vi.fn();
    const r = await rollbackVersionIfCurrent({ ...opts, statusFn: async () => ({ status: 'disabled' }), switchFn });
    expect(switchFn).not.toHaveBeenCalled();
    expect(r.status).toBe('disabled');
  });

  it('the swap itself finds current moved between the read and the lock (aborted/current-moved) → passed through, not a rollback', async () => {
    const r = await rollbackVersionIfCurrent({
      ...opts, statusFn: async () => ({ current: 'v1', previous: 'v0' }), switchFn: async () => ({ status: 'aborted', reason: 'current-moved', actual: 'v2' }),
    });
    expect(r).toMatchObject({ status: 'aborted', reason: 'current-moved' });
  });
});

describe('runRealDispatchSmoke — the smoke worker\'s completion record goes to a SCRATCH store, never the real one', () => {
  let work;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'dlo-scratch-test-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  function launchFixture(action = () => {}) {
    return vi.fn((_node, args, opts) => {
      const [, , slug, , , sessionId, prompt, , scratch] = args;
      const [, marker, nonce] = prompt.match(/process\.argv\[2\]\)" '([^']+)' '([^']+)'/);
      action({ slug, sessionId, marker, nonce, store: opts.env.OPERATION_COMPLETIONS_DIR, scratch });
      return { status: 0, stdout: JSON.stringify({ handle: 'pid:12345', wrapperPid: 12345 }), stderr: '' };
    });
  }
  const fastSettings = () => ({ ...overlaySafetySettings({}, { readSettings: () => null }), smokeTimeoutMs: 0 });
  const finish = ({ marker, nonce, store, slug }) => {
    writeFileSync(marker, nonce);
    writeFileSync(join(store, `${slug}.json`), JSON.stringify({ status: 'done' }));
  };
  const smoke = (spawn, extra = {}) => runRealDispatchSmoke({
    tree: '.', env: {}, settings: fastSettings(), spawn, home: join(work, 'home'), log: quietLog, probeAlive: () => false,
    diagnosticsDir: join(work, 'diag'), ...extra,
  });

  it('retries a launch timeout once with fresh evidence, then accepts the passing worker', async () => {
    const spawn = launchFixture((a) => { if (spawn.mock.calls.length === 2) finish(a); });
    const r = await smoke(spawn);
    expect(r).toMatchObject({ ok: true, note: 'retried after launch timeout' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1][5]).not.toBe(spawn.mock.calls[1][1][5]);
    expect(spawn.mock.calls[0][2].env.OPERATION_COMPLETIONS_DIR).not.toBe(spawn.mock.calls[1][2].env.OPERATION_COMPLETIONS_DIR);
  });

  it('rejects two launch timeouts with both attempts diagnostics and stops live wrappers', async () => {
    const spawn = launchFixture(({ scratch }) => {
      writeFileSync(join(scratch, 'wrapper.stderr'), Array.from({ length: 40 }, (_, n) => `line ${n}`).join('\n'));
      writeFileSync(join(scratch, 'first-output.json'), JSON.stringify({ ms: 17 }));
    });
    const stopWrapper = vi.fn();
    const r = await smoke(spawn, { probeAlive: () => true, stopWrapper });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(stopWrapper).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: false, reason: 'timeout', diagnostics: { wrapperPid: 12345, wrapperAliveAtTimeout: true, sessionAppeared: false, transcriptAppeared: false, firstOutputMs: 17 } });
    // The retry note comes first: the summary's last field is the error class (child text), which cannot pose as it.
    expect(r.detail).toMatch(/^retried after launch timeout; attempts=timeout,timeout; /);
    expect(r.diagnostics.launchStartedAt).toMatch(/^\d{4}-/);
    expect(r.diagnostics).not.toHaveProperty('stderrTail');
    // Each attempt's last 30 stderr lines are in its own 0600 file under the diagnostics dir; the capture is gone.
    expect(r.attempts).toHaveLength(2);
    for (const a of r.attempts) {
      const file = a.diagnostics.stderrFile;
      expect(file.startsWith(join(work, 'diag'))).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toEqual(Array.from({ length: 30 }, (_, n) => `line ${n + 10}`));
    }
    expect(r.detail).toContain(`stderrFile=${r.diagnostics.stderrFile}`);
    for (const call of spawn.mock.calls) expect(existsSync(join(call[1][8], 'wrapper.stderr'))).toBe(false);
  });

  it('never carries wrapper stderr text beyond its error class in detail, diagnostics, attempts or logs', async () => {
    // Not secret-shaped: only the design (the allow-listed summary), never a redactor, keeps these out.
    const lines = ['booting alphaword1x', 'TypeError: cannot read "password: bravoword2x', 'charlieword3x deltaword4x"',
      'API_KEY="echoword5x', 'foxtrotword6x"', 'progress\rgolfword7x', 'y'.repeat(20_000)];
    const spawn = launchFixture(({ scratch }) => writeFileSync(join(scratch, 'wrapper.stderr'), lines.join('\n')));
    const log = { error: vi.fn() };
    const r = await smoke(spawn, { log });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(r.diagnostics.errorClass).toBe('TypeError: cannot read <…>');
    const sinks = [JSON.stringify(r), log.error.mock.calls.map((c) => c.join(' ')).join('\n')];
    for (const w of ['alphaword1x', 'bravoword2x', 'charlieword3x', 'deltaword4x', 'echoword5x', 'foxtrotword6x', 'golfword7x', 'yyyyyyyy']) {
      for (const sink of sinks) expect(sink).not.toContain(w);
    }
    expect(readFileSync(r.diagnostics.stderrFile, 'utf8')).toContain('golfword7x');
  });

  it('a launch-harness failure carries its signal, exit code and class, with its stderr only in the 0600 file', async () => {
    const spawn = vi.fn(() => ({ status: 3, signal: null, stderr: 'loading hotelword8x\nSyntaxError: Unexpected token "indiaword9x"\n    at julietword10x\n' }));
    const r = await smoke(spawn);
    expect(r).toMatchObject({ ok: false, reason: 'launch-failed', diagnostics: { exitCode: 3, signal: null, errorClass: 'SyntaxError: Unexpected token <…>' } });
    for (const w of ['hotelword8x', 'indiaword9x', 'julietword10x']) expect(JSON.stringify(r)).not.toContain(w);
    expect(statSync(r.diagnostics.stderrFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.diagnostics.stderrFile, 'utf8')).toContain('julietword10x');
  });

  it('retries a launch timeout whose only record is the wrapper\'s own started record', async () => {
    const spawn = launchFixture((a) => {
      if (spawn.mock.calls.length === 2) finish(a);
      else writeFileSync(join(a.store, `${a.slug}.json`), JSON.stringify({ status: 'started', pid: 12345 }));
    });
    const r = await smoke(spawn);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, note: 'retried after launch timeout' });
  });

  it('reads at most the final 64 KiB of wrapper stderr', () => {
    const file = join(work, 'wrapper.stderr');
    const text = Array.from({ length: 4_000 }, (_, n) => `line ${String(n).padStart(4, '0')} ${'s'.repeat(40)}`).join('\n');
    writeFileSync(file, text);
    const size = Buffer.byteLength(text);
    const reads = [];
    const tail = readFileTail(file, 64 * 1024, (fd, buf, off, len, pos) => { reads.push({ len, pos }); return readSync(fd, buf, off, len, pos); });
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.len).toBeLessThanOrEqual(65_536);
      expect(r.pos).toBe(size - 65_536);
    }
    expect(tail).not.toContain('line 0000');
    expect(tail.endsWith(text.split('\n').pop())).toBe(true);
    // A mid-file read holds whole lines only.
    expect(tail.startsWith('line ')).toBe(true);
    expect(text.endsWith(tail)).toBe(true);
  });

  it('never returns a mid-line window: drops to the first break of any kind, and a window with none is empty', () => {
    const cr = join(work, 'cr.stderr');
    writeFileSync(cr, 'progress 50%\r'.repeat(6_000));
    expect(readFileTail(cr).startsWith('progress 50%')).toBe(true);
    const oneLine = join(work, 'one-line.stderr');
    writeFileSync(oneLine, `export DB_PASSWORD="${'secretword '.repeat(8_000)}" FATAL`);
    expect(readFileTail(oneLine)).toBe('');
  });

  it('a transcript denial is counted, never quoted, in the detail', async () => {
    const body = 'This command requires approval: deploy --password "kiloword11x limaword12x"';
    const spawn = launchFixture(({ sessionId }) => {
      const dir = join(work, 'home', '.claude', 'projects', 'test');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: body }] } }));
    });
    const r = await smoke(spawn);
    expect(r).toMatchObject({ ok: false, reason: 'commands-denied' });
    expect(r.detail).toMatch(/^1 denied tool call\(s\) in the transcript; /);
    for (const w of ['requires approval', 'deploy', 'kiloword11x', 'limaword12x']) expect(JSON.stringify(r)).not.toContain(w);
  });

  it.skipIf(process.platform === 'win32')('never blocks on a FIFO left at the wrapper stderr path', () => {
    const fifo = join(work, 'fifo.stderr');
    execFileSync('mkfifo', [fifo]);
    expect(readFileTail(fifo)).toBe('');
  });

  it('does not retry a worker that finishes without its commands', async () => {
    const spawn = launchFixture(({ store, slug }) => writeFileSync(join(store, `${slug}.json`), JSON.stringify({ status: 'done' })));
    expect(await smoke(spawn)).toMatchObject({ ok: false, reason: 'no-commands-ran' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['marker', 'session', 'transcript'])('does not retry a timeout with %s evidence', async (evidence) => {
    const spawn = launchFixture(({ marker, nonce, sessionId }) => {
      if (evidence === 'marker') writeFileSync(marker, nonce);
      else {
        const dir = join(work, 'home', '.claude', evidence === 'session' ? 'sessions' : 'projects/test');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, evidence === 'session' ? '123.json' : `${sessionId}.jsonl`), JSON.stringify({ sessionId }));
      }
    });
    expect(await smoke(spawn)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('resolves the retry limit and source, allowing disable but never more than one retry', async () => {
    expect(fastSettings()).toMatchObject({ dispatchLaunchRetries: 1, dispatchLaunchRetriesSource: 'standard' });
    const readSettings = () => ({ overlaySmoke: { dispatchLaunchRetries: 0 } });
    expect(overlaySafetySettings({}, { readSettings })).toMatchObject({ dispatchLaunchRetries: 0, dispatchLaunchRetriesSource: 'tool' });
    expect(overlaySafetySettings({ WE_OVERLAY_DISPATCH_LAUNCH_RETRIES: '1' }, { readSettings })).toMatchObject({ dispatchLaunchRetries: 1, dispatchLaunchRetriesSource: 'env' });
    expect(overlaySafetySettings({ WE_OVERLAY_DISPATCH_LAUNCH_RETRIES: '2' }, { readSettings }).dispatchLaunchRetries).toBe(0);
    for (const blank of ['', '  ', ' 0 ', '0x0', '-0']) {
      expect(overlaySafetySettings({ WE_OVERLAY_DISPATCH_LAUNCH_RETRIES: blank }, { readSettings: () => null }))
        .toMatchObject({ dispatchLaunchRetries: 1, dispatchLaunchRetriesSource: 'standard' });
    }
    const spawn = launchFixture();
    const log = { error: vi.fn() };
    await smoke(spawn, { settings: { ...fastSettings(), dispatchLaunchRetries: 0, dispatchLaunchRetriesSource: 'tool' }, log });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('dispatchLaunchRetries=0 (source tool)'));
  });

  it('pins OPERATION_COMPLETIONS_DIR to a fresh scratch dir in the child env AND in the prompt\'s own report command, and leaves a real store untouched', async () => {
    const realStore = join(work, 'REAL-completions');
    mkdirSync(realStore, { recursive: true });
    const settings = { ...overlaySafetySettings({}, { readSettings: () => null }), smokeTimeoutMs: 5_000 };
    let seen;
    // Stands in for the launch harness + the worker: records what it was given, then does what the prompt tells it.
    const spawn = vi.fn((_node, args, opts) => {
      const [, tree, slug, kind, pr, sessionId, prompt] = args;
      seen = { tree, slug, kind, pr, sessionId, prompt, env: opts.env };
      const [, marker, nonce] = prompt.match(/process\.argv\[2\]\)" '([^']+)' '([^']+)'/);
      writeFileSync(marker, nonce);
      const reportStore = prompt.match(/OPERATION_COMPLETIONS_DIR='([^']+)'/)[1];
      writeFileSync(join(reportStore, `${slug}.json`), JSON.stringify({ status: 'done', outcome: 'not-applicable', result: { blocker: null } }));
      return { status: 0, stdout: `${JSON.stringify({ handle: `pid:1`, wrapperPid: null, cwd: tree })}\n`, stderr: '' };
    });
    const r = await runRealDispatchSmoke({
      tree: '/tree', env: { PATH: process.env.PATH, OPERATION_COMPLETIONS_DIR: realStore }, settings, spawn, pollMs: 1, home: join(work, 'home'), log: quietLog,
    });
    expect(r).toMatchObject({ ok: true, reason: 'passed' });
    const childStore = seen.env.OPERATION_COMPLETIONS_DIR;
    expect(childStore).not.toBe(realStore);
    expect(childStore.startsWith(tmpdir())).toBe(true);
    expect(childStore).toBe(join(r.scratch, 'completions'));
    expect(seen.prompt).toContain(`OPERATION_COMPLETIONS_DIR='${childStore}'`); // the report command carries it explicitly too
    expect(seen.prompt).not.toContain(realStore);
    expect(seen.pr).toBe('999998'); // a synthetic id, never a real PR's record
    expect(seen.env.WE_SMOKE_ALLOW_REAL_WORKER).toBe('1');
    expect(existsSync(join(childStore, `${seen.slug}.json`))).toBe(true);
    expect(readdirSync(realStore)).toEqual([]); // the real store saw nothing
  });

  it('runs the prompt\'s own report command and the child env through the REAL completion-cli: the record lands in the scratch store, the real store stays empty', async () => {
    const realStore = join(work, 'REAL-completions');
    mkdirSync(realStore, { recursive: true });
    const treeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // this checkout: owns scripts/operations/completion-cli.mjs
    const settings = { ...overlaySafetySettings({}, { readSettings: () => null }), smokeTimeoutMs: 20_000 };
    const reportOutputs = [];
    const spawn = vi.fn((_node, args, opts) => {
      const [, , slug, , , , prompt] = args;
      const [, marker, nonce] = prompt.match(/process\.argv\[2\]\)" '([^']+)' '([^']+)'/);
      writeFileSync(marker, nonce);
      // (a) the worker's literal step 3, exactly as the prompt spells it, run with the PARENT's env pointing at the real store
      const step3 = prompt.split('\n').find((l) => l.startsWith('3. ')).slice(3);
      reportOutputs.push(execFileSync('bash', ['-c', step3], { cwd: treeRoot, env: { ...opts.env, OPERATION_COMPLETIONS_DIR: realStore }, encoding: 'utf8' }));
      // (b) the launched child's inherited env alone (no prefix) must also resolve to the scratch store, not the real one
      reportOutputs.push(execFileSync(process.execPath, [
        join(treeRoot, 'scripts', 'operations', 'completion-cli.mjs'), 'report', `--session=${slug}-envonly`, '--kind=ci-heal', '--pr=999998', '--status=done', '--outcome=not-applicable',
      ], { cwd: treeRoot, env: opts.env, encoding: 'utf8' }));
      return { status: 0, stdout: `${JSON.stringify({ handle: 'pid:1', wrapperPid: null, cwd: opts.cwd })}\n`, stderr: '' };
    });
    const r = await runRealDispatchSmoke({
      tree: treeRoot, env: { PATH: process.env.PATH, OPERATION_COMPLETIONS_DIR: realStore }, settings, spawn, pollMs: 1, home: join(work, 'home'), log: quietLog,
    });
    expect(r).toMatchObject({ ok: true, reason: 'passed' });
    expect(reportOutputs).toHaveLength(2);
    const scratchStore = join(r.scratch, 'completions');
    const scratched = readdirSync(scratchStore).sort();
    expect(scratched).toEqual(expect.arrayContaining(['ci-heal-999998.json', 'ci-heal-999998-envonly.json']));
    expect(readdirSync(realStore)).toEqual([]); // neither the prompt's command nor the inherited env wrote to the real store
  });

  it('a launch that exits non-zero fails the smoke with launch-failed, without waiting for a record', async () => {
    const settings = { ...overlaySafetySettings({}, { readSettings: () => null }), smokeTimeoutMs: 5_000 };
    const spawn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'boomword\n' }));
    const r = await runRealDispatchSmoke({ tree: '/tree', env: {}, settings, spawn, pollMs: 1, home: join(work, 'home'), log: quietLog, diagnosticsDir: join(work, 'diag') });
    expect(r).toMatchObject({ ok: false, reason: 'launch-failed' });
    expect(r.detail).toMatch(/^the launch harness failed; .*exitCode=1/);
    expect(JSON.stringify(r)).not.toContain('boomword');
  });
});

describe('runDaemonLoadOverlay — a non-versioned load whose overlay never reached the tree is not silently "registered"', () => {
  const settingsOn = overlaySafetySettings({}, { readSettings: () => null });

  it('rebuild rejected / lock busy (overlay not in the live tree) → no worker, a warning', async () => {
    const dispatchSmoke = vi.fn();
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild: async () => ({ moved: true, adopted: false, reason: 'smoke-rejected' }),
      settings: settingsOn, log: quietLog, dispatchSmoke, inspect: () => ({ inTree: false, required: false }),
    });
    expect(dispatchSmoke).not.toHaveBeenCalled();
    expect(r.warnings).toContain('dispatch-smoke-not-run');
  });

  it('the post-adopt smoke THROWING rolls back instead of rejecting with the overlay left registered', async () => {
    const removeOverlayFn = vi.fn();
    const rebuild = vi.fn().mockResolvedValueOnce({ moved: true, adopted: true, head: 'h1' }).mockResolvedValueOnce({ moved: true, adopted: true, head: 'h0' });
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', installed: () => ({ inHead: true, tip: 'abc', head: 'deadbeef', reason: 'in-head' }), pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }), dispatchSmoke: async () => { throw new Error('boom'); },
    });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ rolledBack: true, head: 'h0', dispatchSmoke: { result: { reason: 'smoke-threw' } } });
  });
});

describe('overlayInstalled — fail-closed injected git', () => {
  it.each([
    [1, 0, 0, 'ref-unresolved', null, 'head'],
    [0, 1, 0, 'head-unresolved', 'tip', null],
    [0, 0, 128, 'check-failed', 'tip', 'head'],
    [0, 0, 1, 'not-in-head', 'tip', 'head'],
    [0, 0, 0, 'in-head', 'tip', 'head'],
  ])('handles git statuses %s/%s/%s', (tipStatus, headStatus, status, reason, tip, head) => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: tipStatus, stdout: 'tip\n' })
      .mockReturnValueOnce({ status: headStatus, stdout: 'head\n' })
      .mockReturnValueOnce({ status });
    expect(overlayInstalled({ root: '/c', ref: 'lane/x', run }))
      .toEqual({ inHead: reason === 'in-head', tip, head, reason });
    expect(run).toHaveBeenNthCalledWith(1, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/lane/x^{commit}'],
      { cwd: '/c', timeout: 60_000, killSignal: 'SIGKILL' });
    expect(run).toHaveBeenNthCalledWith(2, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      { cwd: '/c', timeout: 60_000, killSignal: 'SIGKILL' });
    if (tip && head) expect(run).toHaveBeenNthCalledWith(3, ['merge-base', '--is-ancestor', tip, head], expect.anything());
    else expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails closed when git throws', () => {
    expect(overlayInstalled({ root: '/c', ref: 'lane/x', run: () => { throw new Error('git'); } }))
      .toEqual({ inHead: false, tip: null, head: null, reason: 'check-threw' });
  });
});

describe('the race: overlay registered AFTER the build being adopted was smoked (live 2026-10-09, PR #4669)', () => {
  const stale = { inHead: false, tip: 'abc', head: 'stale1', reason: 'not-in-head' };
  const options = () => ({
    clone: '/c', ref: 'lane/x', pr: 1, versions: null, addOverlayFn: vi.fn(), log: quietLog,
    settings: overlaySafetySettings({ WE_OVERLAY_DISPATCH_SMOKE: 'off' }, { readSettings: () => null }),
  });
  const first = { moved: true, adopted: true, head: 'stale1', reason: 'ready-adopted', alerts: [{ kind: 'first' }] };

  it('rebuilds the newly registered overlay and reports the fresh installed head', async () => {
    const rebuild = vi.fn().mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'fresh2', alerts: [{ kind: 'second' }] });
    const installed = vi.fn().mockReturnValueOnce(stale)
      .mockReturnValueOnce({ inHead: true, tip: 'abc', head: 'fresh2', reason: 'in-head' });
    const result = await runDaemonLoadOverlay({ ...options(), rebuild, installed });
    expect(result).toMatchObject({
      adopted: true, head: 'fresh2', overlayInHead: true, followUps: 1,
      staleAdopt: { head: 'stale1', tip: 'abc', reason: 'not-in-head' },
      alerts: [{ kind: 'first' }, { kind: 'second' }],
    });
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(rebuild.mock.calls[1][0]).toEqual({
      ...rebuild.mock.calls[0][0], admissionWaitMs: expect.any(Number),
    });
    expect(rebuild.mock.calls[1][0].admissionWaitMs).toBeLessThanOrEqual(rebuild.mock.calls[0][0].admissionWaitMs);
    expect(installed).toHaveBeenCalledTimes(2);
  });

  it('waits within the shared budget when another rebuild owns the follow-up and leaves a pending verdict', async () => {
    let time = 0;
    const rebuild = vi.fn().mockResolvedValueOnce(first)
      .mockResolvedValue({ moved: false, reason: 'rebuild-in-progress' });
    const result = await runDaemonLoadOverlay({ ...options(), rebuild, installed: () => stale, followUpRebuilds: 3,
      env: { WE_DAEMON_REBUILD_LOCK_WAIT_MS: '250' }, clock: () => time, sleep: async (ms) => { time += ms; },
    });
    expect(result).toMatchObject({
      adopted: false, reason: 'installed-build-lacks-overlay', rebuildReason: 'rebuild-in-progress',
      pending: true, followUps: 1, overlayInHead: false, installedCheck: stale,
      checkCommand: expect.stringContaining('merge-base --is-ancestor'),
    });
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('never reports adoption when the installed checker throws', async () => {
    const result = await runDaemonLoadOverlay({
      ...options(), rebuild: vi.fn().mockResolvedValue(first),
      installed: () => { throw new Error('cannot inspect'); },
    });
    expect(result).toMatchObject({
      adopted: false, pending: true, reason: 'installed-build-lacks-overlay',
      installedCheck: { inHead: false, reason: 'check-threw' }, followUps: 1,
    });
  });

  it('keeps a non-adopted rebuild verdict unchanged while including the ancestry check', async () => {
    const rebuild = vi.fn().mockResolvedValue({ moved: false, adopted: false, reason: 'smoke-rejected' });
    const result = await runDaemonLoadOverlay({ ...options(), rebuild, installed: () => stale });
    expect(result).toMatchObject({
      adopted: false, reason: 'smoke-rejected', overlayInHead: false, installedCheck: stale, followUps: 0,
    });
    expect(result.staleAdopt).toBeUndefined();
    expect(result.pending).toBeUndefined();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('rolls back only this overlay when the follow-up throws after a failed dispatch smoke', async () => {
    const rebuild = vi.fn().mockResolvedValueOnce(first)
      .mockImplementationOnce(async ({ runSmoke }) => {
        await runSmoke({ root: '/candidate', env: {} });
      })
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'recovered', reason: 'adopted' });
    const removeOverlayFn = vi.fn();
    const baseSmoke = vi.fn(async () => ({ verdict: 'pass' }));
    const result = await runDaemonLoadOverlay({
      ...options(), rebuild, installed: () => stale, removeOverlayFn, appendEventFn: vi.fn(), baseSmoke,
      settings: overlaySafetySettings({}, { readSettings: () => null }),
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'commands-denied' }),
    });
    expect(result).toMatchObject({
      adopted: false, registered: false, rolledBack: true, reason: 'dispatch-smoke-failed',
      followUps: 1, head: 'recovered', rollback: { adopted: true },
    });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(removeOverlayFn).toHaveBeenCalledWith('/c', 'lane/x', expect.anything());
    expect(rebuild).toHaveBeenCalledTimes(3);
    expect(rebuild.mock.calls[2][0].runSmoke).toBe(baseSmoke);
  });

  it('propagates a follow-up rebuild error without a failed dispatch smoke', async () => {
    const rebuild = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('follow-up failed'));
    await expect(runDaemonLoadOverlay({ ...options(), rebuild, installed: () => stale })).rejects.toThrow('follow-up failed');
  });
});


describe('legacy explicit load — bounded busy wait', () => {
  const busy = { moved: false, adopted: false, reason: 'rebuild-in-progress' };
  const present = { inHead: true, tip: 'tip', head: 'fresh', reason: 'in-head' };
  function fixture(budget = 600) {
    let time = 0;
    const sleep = vi.fn(async (ms) => { time += ms; });
    return {
      options: {
        clone: '/c', ref: 'lane/x', pr: 1, versions: null, addOverlayFn: vi.fn(),
        env: { WE_DAEMON_REBUILD_LOCK_WAIT_MS: String(budget) }, log: quietLog,
        settings: overlaySafetySettings({ WE_OVERLAY_DISPATCH_SMOKE: 'off' }, { readSettings: () => null }),
        installed: () => present, clock: () => time, sleep,
      },
      sleep, advance: (ms) => { time += ms; },
    };
  }

  it('retries busy → busy → adopted with decreasing lock budgets and installed evidence', async () => {
    const { options, sleep } = fixture();
    const log = { error: vi.fn() };
    const rebuild = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(busy)
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'fresh' });
    const result = await runDaemonLoadOverlay({ ...options, rebuild, log });
    expect(result).toMatchObject({ adopted: true, overlayInHead: true, installedCheck: present, waitedMs: 500 });
    expect(sleep.mock.calls).toEqual([[250], [250]]);
    expect(rebuild.mock.calls.map(([o]) => o.admissionWaitMs)).toEqual([600, 350, 100]);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('bounds perpetual busy attempts and clips the last sleep to the deadline', async () => {
    const { options, sleep } = fixture();
    const rebuild = vi.fn().mockResolvedValue(busy);
    const result = await runDaemonLoadOverlay({ ...options, rebuild });
    expect(result).toMatchObject({ adopted: false, reason: 'rebuild-in-progress', waitedMs: 600 });
    expect(rebuild.mock.calls.map(([o]) => o.admissionWaitMs)).toEqual([600, 350, 100]);
    expect(sleep.mock.calls).toEqual([[250], [250], [100]]);
  });

  it('shares the deadline with the stale-adoption follow-up', async () => {
    const { options } = fixture();
    const rebuild = vi.fn().mockResolvedValueOnce(busy)
      .mockResolvedValueOnce({ adopted: true, head: 'old' }).mockResolvedValueOnce(busy)
      .mockResolvedValueOnce({ adopted: true, head: 'fresh' });
    const installed = vi.fn().mockReturnValueOnce({ ...present, inHead: false, head: 'old' }).mockReturnValue(present);
    const result = await runDaemonLoadOverlay({ ...options, rebuild, installed });
    expect(result).toMatchObject({ adopted: true, followUps: 1, waitedMs: 500 });
    expect(rebuild.mock.calls.map(([o]) => o.admissionWaitMs)).toEqual([600, 350, 350, 100]);
  });

  it('does not admit a stale-adoption follow-up after the deadline', async () => {
    const { options, advance } = fixture();
    const rebuild = vi.fn(async () => { advance(700); return { adopted: true, head: 'old' }; });
    const result = await runDaemonLoadOverlay({ ...options, rebuild, installed: () => ({ ...present, inHead: false }) });
    expect(result).toMatchObject({ adopted: false, pending: true, followUps: 0 });
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('lets an admitted rebuild finish beyond the wait budget', async () => {
    const { options, advance, sleep } = fixture();
    const rebuild = vi.fn().mockResolvedValueOnce(busy).mockImplementationOnce(async () => {
      advance(1_000);
      return { adopted: true, head: 'fresh' };
    });
    expect(await runDaemonLoadOverlay({ ...options, rebuild })).toMatchObject({ adopted: true, waitedMs: 1_250 });
    expect(sleep.mock.calls).toEqual([[250]]);
    expect(rebuild.mock.calls.map(([o]) => o.admissionWaitMs)).toEqual([600, 350]);
  });

  it('still removes the overlay and recovers when candidate smoke fails after a busy wait', async () => {
    const { options } = fixture();
    const baseSmoke = vi.fn(async () => ({ verdict: 'pass' }));
    const removeOverlayFn = vi.fn();
    const rebuild = vi.fn().mockResolvedValueOnce(busy).mockImplementationOnce(async ({ runSmoke }) => {
      await runSmoke({ root: '/candidate', env: {} });
    }).mockResolvedValueOnce({ adopted: true, head: 'recovered' });
    const log = { error: vi.fn() };
    const result = await runDaemonLoadOverlay({
      ...options, rebuild, baseSmoke, removeOverlayFn, appendEventFn: vi.fn(), log,
      settings: overlaySafetySettings({}, { readSettings: () => null }),
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'commands-denied' }),
    });
    expect(result).toMatchObject({ adopted: false, registered: false, rolledBack: true, reason: 'dispatch-smoke-failed', rollback: { adopted: true } });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(3);
    expect(rebuild.mock.calls[2][0].runSmoke).toBe(baseSmoke);
    expect(log.error.mock.calls.at(-1)[0]).toContain('not adopted (dispatch-smoke-failed)');
  });

  it.each(['Infinity', '-Infinity', 'NaN', 'invalid', '0', '-1'])('falls back to the default budget for %s', async (budget) => {
    const { options } = fixture(budget);
    const rebuild = vi.fn().mockResolvedValue({ adopted: true });
    await runDaemonLoadOverlay({ ...options, rebuild });
    expect(rebuild.mock.calls[0][0].admissionWaitMs).toBe(60_000);
  });

  it('does not retry another refusal or a thrown rebuild error', async () => {
    const { options, sleep } = fixture();
    const rebuild = vi.fn().mockResolvedValue({ adopted: false, reason: 'permission-denied' });
    expect(await runDaemonLoadOverlay({ ...options, rebuild })).toMatchObject({ adopted: false, reason: 'permission-denied' });
    expect(rebuild).toHaveBeenCalledTimes(1);
    rebuild.mockRejectedValueOnce(new Error('git failed'));
    await expect(runDaemonLoadOverlay({ ...options, rebuild })).rejects.toThrow('git failed');
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['check-failed', 'not-in-head'])('never adopts without installed-tip proof (%s)', async (reason) => {
    const { options } = fixture();
    const rebuild = vi.fn().mockResolvedValueOnce(busy).mockResolvedValue({ adopted: true, head: 'old' });
    const result = await runDaemonLoadOverlay({ ...options, rebuild, installed: () => ({ ...present, inHead: false, tip: 'advanced', reason }) });
    expect(result).toMatchObject({ adopted: false, pending: true, installedCheck: { tip: 'advanced', reason } });
  });

  it('keeps dry-run and versioned waiting outside the legacy retry loop', async () => {
    const { options, sleep } = fixture();
    const rebuild = vi.fn();
    await runDaemonLoadOverlay({ ...options, rebuild, dryRun: true, dryRunRebuildFn: async () => ({}) });
    await runDaemonLoadOverlay({ ...options, rebuild, versions: {}, wait: true, submit: () => 'req', waitFor: async () => busy });
    expect(rebuild).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('load outcome audit and registration trigger', () => {
  const options = () => ({
    clone: '/c', ref: 'lane/record', pr: 42, env: {}, versions: null,
    settings: { noPr: 'refuse', dispatchSmoke: 'off' }, log: { error: vi.fn() },
    addOverlayFn: vi.fn(), rebuild: vi.fn(async () => ({ moved: false, adopted: false, reason: 'up-to-date' })),
    installed: () => ({ inHead: true, reason: 'in-head' }),
    recordFn: vi.fn(() => ({ ok: true })), triggerFn: vi.fn(() => 'req'),
  });

  it.each([
    ['dry-run', { dryRun: true, dryRunRebuildFn: async () => ({}) }],
    ['refused', { pr: null }],
    ['versioned/pending', { versions: {} }],
    ['adopted', { rebuild: async () => ({ moved: true, adopted: true }) }],
    ['not-adopted', {}],
    ['timeout', { versions: {}, wait: true, submit: () => 'req', waitFor: async () => ({ status: 'timeout' }) }],
    ['not-adopted', { versions: {}, wait: true, submit: () => 'req', waitFor: async () => ({ status: 'rejected' }) }],
  ])('records exactly once for %s', async (outcome, overrides) => {
    const opts = { ...options(), ...overrides };
    const result = await runDaemonLoadOverlay(opts);
    expect(opts.recordFn).toHaveBeenCalledTimes(1);
    expect(opts.recordFn).toHaveBeenCalledWith({ env: opts.env, record: expect.objectContaining({
      clone: '/c', ref: 'lane/record', pr: opts.pr, outcome, registered: result.registered ?? false,
    }) });
  });

  it('records dispatch-smoke failure and rollback together', async () => {
    const opts = { ...options(), versions: { dir: '/versions' }, wait: true,
      settings: { noPr: 'refuse', dispatchSmoke: 'on', dispatchPaths: [] },
      submit: () => 'req', waitFor: async () => ({ adopted: true, moved: true, versionId: 'v1' }),
      inspect: () => ({ inTree: true, required: true, matched: ['dispatch.mjs'] }),
      dispatchSmoke: async () => ({ ok: false, reason: 'commands-denied' }),
      removeOverlayFn: vi.fn(), appendEventFn: vi.fn(), rollbackVersionFn: async () => ({ status: 'switched' }),
    };
    await runDaemonLoadOverlay(opts);
    expect(opts.recordFn).toHaveBeenCalledTimes(1);
    expect(opts.recordFn.mock.calls[0][0].record).toMatchObject({
      outcome: 'dispatch-smoke-failed', rolledBack: true, registered: false, rollback: { adopted: true },
    });
  });

  it.each(['validation', 'registration', 'rebuild', 'preview', 'wait'])('records %s exceptions then rethrows the original error', async (stage) => {
    const error = new Error('failed ghp_secret123');
    const fail = () => { throw error; };
    const opts = { ...options(), ...({
      validation: { clone: null }, registration: { addOverlayFn: fail }, rebuild: { rebuild: fail },
      preview: { dryRun: true, dryRunRebuildFn: fail },
      wait: { versions: {}, wait: true, submit: () => 'req', waitFor: fail },
    })[stage] };
    if (stage === 'validation') await expect(runDaemonLoadOverlay(opts)).rejects.toThrow('--clone');
    else await expect(runDaemonLoadOverlay(opts)).rejects.toBe(error);
    expect(opts.recordFn).toHaveBeenCalledTimes(1);
    expect(opts.recordFn.mock.calls[0][0].record).toMatchObject({
      outcome: 'error', registered: ['rebuild', 'wait'].includes(stage),
    });
    expect(opts.recordFn.mock.calls[0][0].record.error).not.toContain('secret123');
  });

  it.each([() => ({ ok: false, error: 'disk full' }), () => { throw new Error('disk full'); },
    async () => { throw new Error('disk full'); }])('record failure never breaks results or masks original errors', async (recordFn) => {
    await expect(runDaemonLoadOverlay({ ...options(), recordFn })).resolves.toMatchObject({ registered: true });
    const original = new Error('rebuild failed');
    await expect(runDaemonLoadOverlay({ ...options(), recordFn, rebuild: () => { throw original; } })).rejects.toBe(original);
  });

  it('triggers once after successful registration and before the immediate legacy rebuild', async () => {
    const opts = options();
    const order = [];
    opts.addOverlayFn = () => { order.push('register'); };
    opts.triggerFn.mockImplementation(() => { order.push('trigger'); });
    opts.rebuild.mockImplementation(async () => { order.push('rebuild'); return { adopted: false }; });
    await runDaemonLoadOverlay(opts);
    expect(order).toEqual(['register', 'trigger', 'rebuild']);
    expect(opts.triggerFn).toHaveBeenCalledTimes(1);
  });

  it.each([{ dryRun: true, dryRunRebuildFn: async () => ({}) }, { pr: null },
    { wait: true }, { addOverlayFn: () => { throw new Error('registration failed'); } }])('never triggers for dry-run, refusal, wait or failed registration: %j', async (override) => {
    const opts = { ...options(), ...override };
    try { await runDaemonLoadOverlay(opts); } catch { /* expected registration error */ }
    expect(opts.triggerFn).not.toHaveBeenCalled();
  });

  it('uses exactly one existing versioned request when no trigger is injected', async () => {
    const opts = { ...options(), triggerFn: undefined, versions: {}, submit: vi.fn(() => 'request-id') };
    const result = await runDaemonLoadOverlay(opts);
    expect(opts.submit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pending: true, requestId: 'request-id' });
    expect(opts.rebuild).not.toHaveBeenCalled();
  });

  it('a failed default versioned submission stays registered and is never reported queued', async () => {
    const opts = { ...options(), triggerFn: undefined, versions: {},
      submit: vi.fn(() => { throw new Error('request write failed'); }) };
    await expect(runDaemonLoadOverlay(opts)).resolves.toMatchObject({
      registered: true, pending: true, requestQueued: false, triggerError: 'request write failed',
    });
    expect(opts.submit).toHaveBeenCalledTimes(1);
    expect(opts.recordFn.mock.calls[0][0].record).toMatchObject({ triggerError: 'request write failed' });
  });

  it('the default legacy path rebuilds immediately without submitting a versioned request', async () => {
    const opts = { ...options(), triggerFn: undefined, submit: vi.fn() };
    await runDaemonLoadOverlay(opts);
    expect(opts.submit).not.toHaveBeenCalled();
    expect(opts.rebuild).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}])('trigger failure is recorded and never fails the load (versions=%j)', async (versions) => {
    const opts = { ...options(), versions, triggerFn: vi.fn(async () => { throw new Error('wake failed ghp_secret123\n\u001b'); }) };
    const result = await runDaemonLoadOverlay(opts);
    expect(result).toMatchObject({ registered: true, triggerError: 'wake failed ghp_<redacted>' });
    expect(opts.triggerFn).toHaveBeenCalledTimes(1);
    expect(opts.recordFn.mock.calls[0][0].record).toMatchObject({ triggerError: 'wake failed ghp_<redacted>' });
    expect(opts.rebuild).toHaveBeenCalledTimes(versions ? 0 : 1);
  });
});
