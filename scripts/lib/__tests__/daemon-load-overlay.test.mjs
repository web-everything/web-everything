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
  mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runDaemonLoadOverlay, mergeOverlayRef, dryRunOverlay } from '../daemon-load-overlay.mjs';

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
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', addOverlayFn, rebuild });
    expect(order).toEqual(['addOverlay', 'rebuild']);
    expect(result).toMatchObject({ registered: true, mergedAnything: false, adopted: false, reason: 'up-to-date' });
  });

  it('an ADOPTED rebuild is reported adopted:true, with the new head', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: true, adopted: true, head: 'deadbeef', alerts: [] }));
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', addOverlayFn, rebuild });
    expect(result).toMatchObject({ mergedAnything: true, adopted: true, head: 'deadbeef' });
  });

  it('a REJECTED rebuild (smoke-rejected) is reported adopted:false, the reason surfaced', async () => {
    const addOverlayFn = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'smoke-rejected', rolledBack: true, alerts: [{ kind: 'smoke-rejected', detail: { failed: 'gh-api-repo' } }] }));
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', addOverlayFn, rebuild });
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
    await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', addOverlayFn, rebuild });
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
  DISPATCH_PATH_DEFAULTS,
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
      clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), rebuild, settings: settingsOn, log: quietLog,
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
      clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn, settings: settingsOn, log: quietLog,
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

  it('adopted WITHOUT the candidate dispatch smoke (a cached tree, or a daemon tick adopted it first) → smoke the live clone, roll back on failure', async () => {
    const removeOverlayFn = vi.fn(() => ({ removed: true, list: [] }));
    const rebuild = vi.fn()
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'h1' })
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'h0' });
    const dispatchSmoke = vi.fn(async () => ({ ok: false, reason: 'no-commands-ran' }));
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
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
      clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, settings: settingsOn, log: quietLog,
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
      clone: '/c', ref: 'lane/x', pr: null, addOverlayFn, rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
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
      clone: '/c', ref: 'lane/x', pr: null, addOverlayFn, rebuild, settings: { ...settingsOn, noPr: 'refuse' }, log: quietLog,
    });
    expect(addOverlayFn).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(r).toMatchObject({ registered: false, refused: true, reason: 'no-pr' });
  });

  it('dispatchSmoke=off → the plain rebuild smoke, no wrapper', async () => {
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), rebuild, settings: { ...settingsOn, dispatchSmoke: 'off' }, log: quietLog,
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
    clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), settings: settingsOn, versions: vctx, wait: true,
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

describe('runRealDispatchSmoke — the smoke worker\'s completion record goes to a SCRATCH store, never the real one', () => {
  let work;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'dlo-scratch-test-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('pins OPERATION_COMPLETIONS_DIR to a fresh scratch dir in the child env AND in the prompt\'s own report command, and leaves a real store untouched', async () => {
    const realStore = join(work, 'REAL-completions');
    mkdirSync(realStore, { recursive: true });
    const settings = { ...overlaySafetySettings({}, { readSettings: () => null }), smokeTimeoutMs: 5_000 };
    let seen;
    // Stands in for the launch harness + the worker: records what it was given, then does what the prompt tells it.
    const spawn = vi.fn((_node, args, opts) => {
      const [, , , tree, slug, kind, pr, sessionId, prompt] = args;
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
      const [, , , , slug, , , , prompt] = args;
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
    const spawn = vi.fn(() => ({ status: 1, stdout: '', stderr: 'boom\n' }));
    const r = await runRealDispatchSmoke({ tree: '/tree', env: {}, settings, spawn, pollMs: 1, home: join(work, 'home'), log: quietLog });
    expect(r).toMatchObject({ ok: false, reason: 'launch-failed', detail: 'boom' });
  });
});

describe('runDaemonLoadOverlay — a non-versioned load whose overlay never reached the tree is not silently "registered"', () => {
  const settingsOn = overlaySafetySettings({}, { readSettings: () => null });

  it('rebuild rejected / lock busy (overlay not in the live tree) → no worker, a warning', async () => {
    const dispatchSmoke = vi.fn();
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), rebuild: async () => ({ moved: true, adopted: false, reason: 'smoke-rejected' }),
      settings: settingsOn, log: quietLog, dispatchSmoke, inspect: () => ({ inTree: false, required: false }),
    });
    expect(dispatchSmoke).not.toHaveBeenCalled();
    expect(r.warnings).toContain('dispatch-smoke-not-run');
  });

  it('the post-adopt smoke THROWING rolls back instead of rejecting with the overlay left registered', async () => {
    const removeOverlayFn = vi.fn();
    const rebuild = vi.fn().mockResolvedValueOnce({ moved: true, adopted: true, head: 'h1' }).mockResolvedValueOnce({ moved: true, adopted: true, head: 'h0' });
    const r = await runDaemonLoadOverlay({
      clone: '/c', ref: 'lane/x', pr: 1, addOverlayFn: vi.fn(), rebuild, removeOverlayFn, appendEventFn: vi.fn(), settings: settingsOn, log: quietLog,
      inspect: () => ({ inTree: true, required: true, matched: ['x'] }), dispatchSmoke: async () => { throw new Error('boom'); },
    });
    expect(removeOverlayFn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ rolledBack: true, head: 'h0', dispatchSmoke: { result: { reason: 'smoke-threw' } } });
  });
});
