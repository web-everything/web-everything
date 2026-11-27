/**
 * @file main-staleness.test.mjs — proof of the #2204 fetch-first staleness guard. The git calls are the I/O
 *   boundary (injected `run`); the fresh/auto-ff/warn CLASSIFICATION and the fail-soft behaviour are decided
 *   here and unit-tested without a real repo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyStaleness, checkMainStaleness, assertMainNotStale, staleRemedy, isCodePath,
  isStaleMainRefusalMessage, STALE_MAIN_REFUSAL_MARKER, behindFiles, codeDirty, PreStartDispatchRefusalError,
} from '../main-staleness.mjs';
import { cloneKeyOf, readRebuildStateFile, decideLastGood } from '../daemon-last-good.mjs';

describe('classifyStaleness', () => {
  it('behind 0 → fresh', () => {
    expect(classifyStaleness({ behind: 0, ahead: 0, dirty: false, autoFf: true }).fresh).toBe(true);
  });
  it('behind + clean + not diverged + autoFf → auto-ff', () => {
    expect(classifyStaleness({ behind: 5, ahead: 0, dirty: false, autoFf: true }).action).toBe('auto-ff');
  });
  it('behind + dirty + not diverged → auto-ff (autostash carries the dirty tree)', () => {
    const c = classifyStaleness({ behind: 5, ahead: 0, dirty: true, autoFf: true });
    expect(c.action).toBe('auto-ff');
    expect(c.dirty).toBe(true);
  });
  it('behind + dirty + diverged → warn (a diverged tree can not fast-forward)', () => {
    const c = classifyStaleness({ behind: 5, ahead: 2, dirty: true, autoFf: true });
    expect(c.action).toBe('warn');
    expect(c.warning).toMatch(/diverged/);
  });
  it('behind + diverged (ahead>0) → warn, not auto-ff', () => {
    const c = classifyStaleness({ behind: 5, ahead: 1, dirty: false, autoFf: true });
    expect(c.action).toBe('warn');
    expect(c.warning).toMatch(/diverged/);
  });
  it('behind but autoFf disabled → warn', () => {
    expect(classifyStaleness({ behind: 5, ahead: 0, dirty: false, autoFf: false }).action).toBe('warn');
  });
});

// A scripted git runner: canned result per subcommand.
function scripted(map, calls = []) {
  return (args) => { calls.push(args); const h = map[args[0]]; return { status: 0, stdout: '', stderr: '', ...((typeof h === 'function' ? h(args) : h) || {}) }; };
}

describe('checkMainStaleness (fail-soft IO)', () => {
  it('a fetch failure → offline (never hard-fails a read)', () => {
    const run = scripted({ fetch: { status: 1, stderr: 'could not resolve host' } });
    expect(checkMainStaleness({ run })).toEqual({ offline: true });
  });
  it('local === origin → fresh (no pull)', () => {
    const calls = [];
    const run = scripted({ fetch: { status: 0 }, 'rev-parse': { status: 0, stdout: 'sha1\n' } }, calls);
    expect(checkMainStaleness({ run }).fresh).toBe(true);
    expect(calls.some((a) => a[0] === 'pull')).toBe(false);
  });
  it('behind + clean → auto fast-forwards (pull --ff-only --autostash)', () => {
    const calls = [];
    const run = scripted({
      fetch: { status: 0 },
      'rev-parse': (a) => ({ stdout: a[1] === 'main' ? 'localsha\n' : 'originsha\n' }),
      'rev-list': (a) => ({ stdout: a[2].startsWith('main..') ? '7\n' : '0\n' }), // behind 7, ahead 0
      status: { stdout: '' }, // clean
      pull: { status: 0 },
    }, calls);
    const r = checkMainStaleness({ run });
    expect(r).toMatchObject({ synced: true, behind: 7 });
    expect(calls.find((a) => a[0] === 'pull')).toEqual(['pull', '--ff-only', '--autostash']);
  });
  it('behind + dirty + not diverged → autostash fast-forwards (pull --ff-only --autostash)', () => {
    const calls = [];
    const run = scripted({
      fetch: { status: 0 },
      'rev-parse': (a) => ({ stdout: a[1] === 'main' ? 'localsha\n' : 'originsha\n' }),
      'rev-list': (a) => ({ stdout: a[2].startsWith('main..') ? '3\n' : '0\n' }),
      status: { stdout: ' M claims.json\n' }, // dirty, but not diverged
      pull: { status: 0 },
    }, calls);
    const r = checkMainStaleness({ run });
    expect(r).toMatchObject({ synced: true, behind: 3 });
    expect(calls.find((a) => a[0] === 'pull')).toEqual(['pull', '--ff-only', '--autostash']);
  });
  it('behind + dirty + a failed autostash-ff → warn (fail-soft, e.g. stash-pop conflict)', () => {
    const run = scripted({
      fetch: { status: 0 },
      'rev-parse': (a) => ({ stdout: a[1] === 'main' ? 'l\n' : 'o\n' }),
      'rev-list': (a) => ({ stdout: a[2].startsWith('main..') ? '3\n' : '0\n' }),
      status: { stdout: ' M claims.json\n' },
      pull: { status: 1, stderr: 'conflict in claims.json' },
    });
    expect(checkMainStaleness({ run }).action).toBe('warn');
  });
  it('behind + auto-ff fails → warn (still fail-soft)', () => {
    const run = scripted({
      fetch: { status: 0 },
      'rev-parse': (a) => ({ stdout: a[1] === 'main' ? 'l\n' : 'o\n' }),
      'rev-list': (a) => ({ stdout: a[2].startsWith('main..') ? '2\n' : '0\n' }),
      status: { stdout: '' },
      pull: { status: 1, stderr: 'not possible to fast-forward' },
    });
    expect(checkMainStaleness({ run }).action).toBe('warn');
  });
});

// #3474 — `cleanOnly`: the dispatch-safe gate (fast-forward a CLEAN, on-base, non-diverged tree; never autostash).
describe('classifyStaleness — cleanOnly (#3474)', () => {
  const base = { behind: 4, autoFf: true, cleanOnly: true };
  it('behind + clean + on base + not diverged → auto-ff', () => {
    expect(classifyStaleness({ ...base, ahead: 0, dirty: false }).action).toBe('auto-ff');
  });
  it('behind + dirty → warn (reason dirty), NOT auto-ff — the autostash carry is off in this mode', () => {
    expect(classifyStaleness({ ...base, ahead: 0, dirty: true })).toMatchObject({ action: 'warn', reason: 'dirty' });
  });
  it('behind + diverged → warn (reason diverged)', () => {
    expect(classifyStaleness({ ...base, ahead: 2, dirty: false })).toMatchObject({ action: 'warn', reason: 'diverged', ahead: 2 });
  });
  it('behind + HEAD not on base → warn (reason not-on-base)', () => {
    expect(classifyStaleness({ ...base, ahead: 0, dirty: false, onBase: false })).toMatchObject({ action: 'warn', reason: 'not-on-base' });
  });
  it('the default (cleanOnly off) is unchanged: dirty still auto-ffs', () => {
    expect(classifyStaleness({ behind: 4, ahead: 0, dirty: true, autoFf: true }).action).toBe('auto-ff');
  });
});

describe('checkMainStaleness — cleanOnly (#3474)', () => {
  const behind = (over = {}, calls = []) => scripted({
    fetch: { status: 0 },
    'rev-parse': (a) => ({ stdout: a[1] === 'main' ? 'l\n' : 'o\n' }),
    'rev-list': (a) => ({ stdout: a[2].startsWith('main..') ? '2\n' : '0\n' }),
    'symbolic-ref': { stdout: 'main\n' },
    status: { stdout: '' },
    merge: { status: 0 },
    ...over,
  }, calls);
  it('clean + on main → `merge --ff-only origin/main`, never `pull`', () => {
    const calls = [];
    expect(checkMainStaleness({ cleanOnly: true, run: behind({}, calls) })).toEqual({ synced: true, behind: 2, from: 'l', to: 'o' });
    expect(calls.find((a) => a[0] === 'merge')).toEqual(['merge', '--ff-only', 'origin/main']);
    expect(calls.some((a) => a[0] === 'pull')).toBe(false);
  });
  it('dirty → warn with reason dirty, and neither merge nor pull is run', () => {
    const calls = [];
    const r = checkMainStaleness({ cleanOnly: true, run: behind({ status: { stdout: ' M a.txt\n' } }, calls) });
    expect(r).toMatchObject({ action: 'warn', reason: 'dirty', behind: 2 });
    expect(calls.some((a) => a[0] === 'merge' || a[0] === 'pull')).toBe(false);
  });
  it('HEAD on another branch (or detached) → warn with reason not-on-base, no merge', () => {
    const calls = [];
    expect(checkMainStaleness({ cleanOnly: true, run: behind({ 'symbolic-ref': { stdout: 'lane/x\n' } }, calls) })).toMatchObject({ reason: 'not-on-base' });
    expect(checkMainStaleness({ cleanOnly: true, run: behind({ 'symbolic-ref': { status: 128 } }, calls) })).toMatchObject({ reason: 'not-on-base' });
    expect(calls.some((a) => a[0] === 'merge')).toBe(false);
  });
  it('a failing merge → warn with reason ff-failed carrying git\'s own message', () => {
    const r = checkMainStaleness({ cleanOnly: true, run: behind({ merge: { status: 128, stderr: 'fatal: Not possible to fast-forward\n' } }) });
    expect(r).toMatchObject({ action: 'warn', reason: 'ff-failed', detail: 'fatal: Not possible to fast-forward' });
  });
});

// #3875 — assertMainNotStale/staleRemedy, extracted verbatim from we:scripts/operations/review-dispatch.mjs
// (which now re-exports them, byte-identical default behavior) so a future daemon can self-check freshness
// without depending on the whole review-dispatch module. The one genuinely NEW surface is `label`.
describe('assertMainNotStale', () => {
  it('fresh/offline pass through unchanged, no throw', () => {
    expect(assertMainNotStale('/repo', () => ({ fresh: true, behind: 0 }))).toEqual({ fresh: true, behind: 0 });
    expect(assertMainNotStale('/repo', () => ({ offline: true }))).toEqual({ offline: true });
  });

  it('a synced (auto-ff) result logs, does not throw, and returns the synced status', () => {
    const st = { synced: true, behind: 4 };
    expect(assertMainNotStale('/repo', () => st)).toBe(st);
  });

  it('default label is "review-dispatch" — unchanged wording for its original, still most common caller', () => {
    expect(() => assertMainNotStale('/repo', () => ({ action: 'warn', reason: 'dirty', behind: 3, ahead: 0, dirty: true })))
      .toThrow(/^review-dispatch: the dispatching checkout is 3 commit\(s\) behind origin\/main/);
  });

  it('a caller-supplied label replaces the prefix — the whole point of the #3875 extraction', () => {
    expect(() => assertMainNotStale('/repo', () => ({ action: 'warn', reason: 'dirty', behind: 3, ahead: 0, dirty: true }), { label: 'pass-daemon' }))
      .toThrow(/^pass-daemon: the dispatching checkout is 3 commit\(s\) behind origin\/main/);
  });

  it('a non-default base flows through both the thrown message and staleRemedy', () => {
    expect(() => assertMainNotStale('/repo', () => ({ action: 'warn', reason: 'diverged', behind: 1, ahead: 2, dirty: false }), { base: 'lane/mechanical-dispatcher', label: 'infra-blocked' }))
      .toThrow(/infra-blocked: the dispatching checkout is 1 commit\(s\) behind origin\/lane\/mechanical-dispatcher.*DIVERGED \(2 local commit\(s\) ahead of origin\/lane\/mechanical-dispatcher\)/s);
  });
});

// #4044 Module E — a MANAGED clone (`WE_DAEMON_MANAGED_CLONE=1`, set by daemon-self-sync.mjs#withSelfSync at
// wrapper construction) must never be fast-forwarded by a dispatch chokepoint: a dispatch-side auto-ff would
// pull in un-smoked (possibly rejected) code straight past daemon-rebuild.mjs's live-smoke gate. Real temp
// git repos throughout (no injected checkStaleness) — this proves the DEFAULT checker's own `autoFf` wiring,
// which every other test in this file bypasses by injecting its own checkStaleness directly.
describe('assertMainNotStale — managed clone never auto-ffs (#4044 Module E)', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, 'add', file);
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`);
  };

  const withManagedCloneEnv = (value, fn) => {
    const prev = process.env.WE_DAEMON_MANAGED_CLONE;
    if (value === undefined) delete process.env.WE_DAEMON_MANAGED_CLONE;
    else process.env.WE_DAEMON_MANAGED_CLONE = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.WE_DAEMON_MANAGED_CLONE;
      else process.env.WE_DAEMON_MANAGED_CLONE = prev;
    }
  };

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  function makeBehindClone(behindFile = 'b.mjs') {
    dir = mkdtempSync(join(tmpdir(), 'main-staleness-managed-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    const up = join(dir, 'upstream');
    commit(up, 'a.txt', 'one\n');
    git(up, 'push', '-q', 'origin', 'main');
    const clonePath = join(dir, 'clone');
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'clone');
    commit(up, behindFile, 'two\n');
    git(up, 'push', '-q', 'origin', 'main');
    return clonePath;
  }

  it('unmanaged (env unset): a clean behind checkout auto-fast-forwards silently', () => {
    const clonePath = makeBehindClone();
    const st = withManagedCloneEnv(undefined, () => assertMainNotStale(clonePath, undefined, { label: 'test', adoptedHead: r => git(r, 'rev-parse', 'HEAD').trim(), treeDirtyForCode: r => codeDirty(r) }));
    expect(st.synced).toBe(true);
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('0');
  });

  it('managed clone (WE_DAEMON_MANAGED_CLONE=1): the SAME clean-behind checkout REFUSES instead of fast-forwarding', () => {
    const clonePath = makeBehindClone();
    expect(() => withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, { label: 'test', adoptedHead: r => git(r, 'rev-parse', 'HEAD').trim(), treeDirtyForCode: r => codeDirty(r) })))
      .toThrow(/STALE code from this checkout/);
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).not.toBe('0'); // never touched
  });
  // #4044 (live 2026-09-25): the fix daemon refused whole repos when its clone was a few backlog-only commits
  // behind. Commits that change no code file cannot make a checkout's import path stale.
  it('managed clone behind ONLY in non-code files (backlog/*.md) is not stale — no throw, and the clone is never touched', () => {
    const clonePath = makeBehindClone('9999-backlog-card.md');
    const st = withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, { label: 'test', adoptedHead: r => git(r, 'rev-parse', 'HEAD').trim(), treeDirtyForCode: r => codeDirty(r) }));
    expect(st).toMatchObject({ fresh: true, behindNonCodeOnly: true, behind: 1 });
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('1'); // only the rebuild moves it
  });
  // #4387 — a caller's `dispatchPath` narrows the refusal to the files that dispatch actually runs.
  it('managed clone behind in code OFF the dispatch path dispatches and logs the tolerated lag (#4387)', () => {
    const clonePath = makeBehindClone('unrelated.mjs');
    const logs = [];
    const st = withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, {
      adoptedHead: r => git(r, 'rev-parse', 'HEAD').trim(), treeDirtyForCode: r => codeDirty(r),
      label: 'test', dispatchPath: (p) => p === 'review.mjs', write: (s) => logs.push(s),
    }));
    expect(st).toMatchObject({ fresh: true, behindOffDispatchPath: true, behind: 1, codeFiles: 1 });
    expect(logs.join('')).toMatch(/1 commit\(s\) behind origin\/main .*tolerating the lag/);
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('1'); // never touched
  });
  it('managed clone behind in code ON the dispatch path still refuses (#4387)', () => {
    const clonePath = makeBehindClone('review.mjs');
    expect(() => withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, {
      adoptedHead: r => git(r, 'rev-parse', 'HEAD').trim(), treeDirtyForCode: r => codeDirty(r),
      label: 'test', dispatchPath: (p) => p === 'review.mjs', write: () => {},
    }))).toThrow(/STALE code from this checkout/);
  });
  it('dispatchPath fails closed: unknown or empty behind-file list refuses; unset keeps the #4044 rule (#4387)', () => {
    const warn = () => ({ action: 'warn', reason: 'not-auto-syncing', behind: 3, ahead: 0, dirty: false });
    const opts = { adoptedHead: () => 'fixture-head', readHeadSha: () => 'fixture-head', treeDirtyForCode: () => false, label: 'test', dispatchPath: () => false, write: () => {}, lastGood: () => null };
    withManagedCloneEnv('1', () => {
      expect(() => assertMainNotStale('/repo', warn, { ...opts, listBehindFiles: () => null })).toThrow(/STALE/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, listBehindFiles: () => [] })).toThrow(/STALE/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, dispatchPath: null, listBehindFiles: () => ['x.mjs'] }))
        .toThrow(/STALE/);
      // A declared path includes its own test files; no non-code shortcut applies.
      expect(() => assertMainNotStale('/repo', warn, { ...opts, dispatchPath: (p) => p.startsWith('a/'), listBehindFiles: () => ['a/__tests__/r.mjs', 'x.mjs'] }))
        .toThrow(/STALE/);
    });
  });
  it('dispatchPath never widens an UNMANAGED checkout\'s rule — a diverged checkout still refuses (#4387)', () => {
    const warn = () => ({ action: 'warn', reason: 'diverged', behind: 3, ahead: 1, dirty: false });
    withManagedCloneEnv(undefined, () => {
      expect(() => assertMainNotStale('/repo', warn, { dispatchPath: () => false, listBehindFiles: () => ['x.mjs'] }))
        .toThrow(/DIVERGED/);
    });
  });
  // Live 2026-10-04 (PRs #3923/#3924): a daemon clone is main + overlay MERGES, so it has several merge bases
  // with origin/main and `git diff HEAD...origin/main` picked the plain-main one — counting a file an overlay
  // already brought in (and that later landed on main) as behind, and refusing for code the clone already runs.
  function makeOverlayClone() {
    dir = mkdtempSync(join(tmpdir(), 'main-staleness-overlay-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    const up = join(dir, 'upstream');
    commit(up, 'a.txt', 'one\n');
    git(up, 'push', '-q', 'origin', 'main');
    git(up, 'checkout', '-q', '-b', 'lane/overlay');
    commit(up, 'review.mjs', 'overlay\n');
    git(up, 'push', '-q', 'origin', 'lane/overlay');
    git(up, 'checkout', '-q', 'main');
    commit(up, 'base.txt', 'two\n');
    git(up, 'push', '-q', 'origin', 'main');
    const clonePath = join(dir, 'clone');
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'clone');
    git(clonePath, 'fetch', '-q', 'origin', 'lane/overlay');
    git(clonePath, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'overlay', 'origin/lane/overlay');
    // main moves on: the overlay lands (a merge), then an unrelated code commit
    git(up, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'land overlay', 'lane/overlay');
    commit(up, 'unrelated.mjs', 'x\n');
    git(up, 'push', '-q', 'origin', 'main');
    git(clonePath, 'fetch', '-q', 'origin');
    return clonePath;
  }
  it('behindFiles lists only the MISSING commits\' files — never an overlay file the clone already has', () => {
    const clonePath = makeOverlayClone();
    expect(behindFiles(clonePath, 'main', undefined, {}).sort()).toEqual(['unrelated.mjs']);
    // the knob restores the old merge-base diff (which over-reports the overlay's review.mjs)
    expect(behindFiles(clonePath, 'main', undefined, { WE_STALE_GUARD_MISSING_COMMITS: '0' })).toContain('review.mjs');
  });
  it('managed clone behind only in files an overlay already brought in (plus off-path code) dispatches', () => {
    const clonePath = makeOverlayClone();
    const logs = [];
    const st = withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, {
      adoptedHead: r => git(r, 'rev-parse', 'HEAD').trim(), treeDirtyForCode: r => codeDirty(r),
      label: 'test', dispatchPath: (p) => p === 'review.mjs', write: (s) => logs.push(s),
      lastGood: () => null, rebuildGrace: () => ({ grace: false }),
    }));
    expect(st).toMatchObject({ fresh: true, behindOffDispatchPath: true, toleratedFiles: ['unrelated.mjs'] });
  });
  // The bounded rebuild-in-progress grace: on-path lag while the clone's own rebuild runs still dispatches.
  it('rebuild grace: on-path lag dispatches only while a rebuild is in progress; unknown diff still refuses', () => {
    const warn = () => ({ action: 'warn', reason: 'not-auto-syncing', behind: 9, ahead: 0, dirty: false });
    const logs = [];
    const opts = {
      adoptedHead: () => 'fixture-head', readHeadSha: () => 'fixture-head', treeDirtyForCode: () => false,
      label: 'test', dispatchPath: (p) => p === 'review.mjs', write: (s) => logs.push(s), lastGood: () => null,
      listBehindFiles: () => ['review.mjs', 'backlog/x.md'],
    };
    withManagedCloneEnv('1', () => {
      const building = () => ({ grace: true, reason: 'rebuild-in-progress', target: 'a'.repeat(40), sinceAdoptMs: 600_000 });
      expect(assertMainNotStale('/repo', warn, { ...opts, rebuildGrace: building }))
        .toMatchObject({ fresh: true, rebuildGrace: true, onPathFiles: ['review.mjs'] });
      expect(logs.join('')).toMatch(/ON this dispatch's code path \(review\.mjs\).*rebuild to aaaaaaaaaaaa is in progress/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, rebuildGrace: () => ({ grace: false, reason: 'grace-expired' }) }))
        .toThrow(/STALE/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, rebuildGrace: () => { throw new Error('x'); } })).toThrow(/STALE/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, listBehindFiles: () => null, rebuildGrace: building })).toThrow(/STALE/);
      // a caller with no dispatch path never gets the grace
      expect(() => assertMainNotStale('/repo', warn, { ...opts, dispatchPath: null, rebuildGrace: building })).toThrow(/STALE/);
    });
  });
  it('codeDirty: untracked non-code files do not count; a tracked change or untracked code does', () => {
    const run = (out, status = 0) => () => ({ status, stdout: out });
    expect(codeDirty('/r', run('?? backlog/x1.md\n?? backlog/x2.md\n'))).toBe(false);
    expect(codeDirty('/r', run('?? backlog/x1.md\n?? scripts/new.mjs\n'))).toBe(true);
    expect(codeDirty('/r', run(' M backlog/x1.md\n'))).toBe(true);
    expect(codeDirty('/r', run('', 128))).toBe(true);
  });
  it('last-good fallback ignores untracked non-code files (live 2026-10-04: review cards left in the clone)', () => {
    const warn = () => ({ action: 'warn', reason: 'not-auto-syncing', behind: 9, ahead: 0, dirty: true });
    const seen = [];
    const opts = {
      adoptedHead: () => 'fixture-head', readHeadSha: () => 'fixture-head',
      label: 'test', write: () => {}, listBehindFiles: () => ['review.mjs'], dispatchPath: (p) => p === 'review.mjs',
      rebuildGrace: () => ({ grace: false }),
      lastGood: (_r, dirty) => { seen.push(dirty); return dirty ? { onLastGood: false } : { onLastGood: true, lastGood: 'a'.repeat(40) }; },
    };
    withManagedCloneEnv('1', () => {
      expect(assertMainNotStale('/repo', warn, { ...opts, treeDirtyForCode: () => false })).toMatchObject({ fresh: true, onLastGood: true });
      expect(() => assertMainNotStale('/repo', warn, { ...opts, treeDirtyForCode: () => true })).toThrow(/STALE/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, treeDirtyForCode: () => { throw new Error('x'); } })).toThrow(/STALE/);
    });
    expect(seen).toEqual([false, true, true]);
  });
  it('isCodePath: modules and JSON are code; markdown and tests are not', () => {
    expect(['a.mjs', 'x/y.js', 'c.cjs', 'd.ts', 'src/_data/x.json', 'package-lock.json'].every(isCodePath)).toBe(true);
    expect(['backlog/1.md', 'docs/a.njk', 'scripts/__tests__/a.mjs', 'x/a.test.mjs'].some(isCodePath)).toBe(false);
  });
  it('managed clone: the refusal points at the rebuild\'s clone-held-stale alert, never "rebase or merge by hand"', () => {
    const clonePath = makeBehindClone();
    let message = '';
    try { withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, { label: 'test', adoptedHead: r => git(r, 'rev-parse', 'HEAD').trim(), treeDirtyForCode: r => codeDirty(r) })); } catch (e) { message = e.message; }
    expect(message).toContain('DAEMON-MANAGED');
    expect(message).toContain('clone-held-stale');
    expect(message).not.toMatch(/by hand\)?\s*$/);
    expect(message).not.toContain('rebase or merge origin/main into it by hand');
  });
});

// #3383 bug 1 — a downstream forEachRepo caller only ever keeps the flattened first-line message (the Error
// object and any .code are discarded), so recognizing "this tick failure IS the stale-main refusal" (as
// opposed to any other tick failure landing in the same bucket) has to work off that string alone.
describe('isStaleMainRefusalMessage (#3383 bug 1)', () => {
  it('recognizes the real message assertMainNotStale throws, for every reason', () => {
    for (const reason of ['dirty', 'diverged', 'not-on-base', 'ff-failed']) {
      let message = null;
      try {
        assertMainNotStale('/repo', () => ({ action: 'warn', reason, behind: 2, ahead: reason === 'diverged' ? 3 : 0, dirty: reason === 'dirty' }));
      } catch (e) { message = e.message; }
      expect(message).not.toBeNull();
      expect(message).toContain(STALE_MAIN_REFUSAL_MARKER);
      expect(isStaleMainRefusalMessage(message)).toBe(true);
    }
  });
  it('an ordinary, unrelated tick failure is NOT mistaken for the stale-main refusal', () => {
    expect(isStaleMainRefusalMessage('gh: rate limited')).toBe(false);
    expect(isStaleMainRefusalMessage('ENOTFOUND api.github.com')).toBe(false);
  });
  it('is false for anything non-string (a missing/undefined why field is common on the non-error shapes)', () => {
    expect(isStaleMainRefusalMessage(undefined)).toBe(false);
    expect(isStaleMainRefusalMessage(null)).toBe(false);
  });
});

describe('staleRemedy', () => {
  it('names the right remedy per reason, and falls back to a generic one for an unknown/absent reason', () => {
    expect(staleRemedy({ reason: 'diverged', ahead: 2 }, 'main')).toMatch(/DIVERGED \(2 local commit\(s\) ahead/);
    expect(staleRemedy({ reason: 'dirty' }, 'main')).toMatch(/uncommitted changes/);
    expect(staleRemedy({ reason: 'not-on-base' }, 'main')).toMatch(/HEAD is not on main/);
    expect(staleRemedy({ reason: 'ff-failed', detail: 'conflict' }, 'main')).toMatch(/failed \(conflict\)/);
    expect(staleRemedy({}, 'main')).toMatch(/^Sync \(git pull --ff-only\)/);
  });
});

describe('strict freshness reads for fast review admission', () => {
  it.each(['dirty', 'off-base'])('refuses ahead-only checkout with %s evidence', failure => {
    const run = args => ({ status: 0, stdout: args[0] === 'rev-parse' ? args[1]
      : args[0] === 'rev-list' ? (args.at(-1).startsWith('main..') ? '0' : '1')
      : args[0] === 'status' ? (failure === 'dirty' ? ' M file' : '')
      : args[0] === 'symbolic-ref' ? (failure === 'off-base' ? 'lane/x' : 'main') : '' });
    expect(checkMainStaleness({ strict: true, cleanOnly: true, autoFf: false, run })).toEqual({ offline: true });
  });
  it.each(['fetch', 'rev-parse', 'rev-list', 'status', 'symbolic-ref'])('refuses failed %s evidence', failed => {
    const run = args => {
      if (args[0] === failed) return { status: 1, stdout: '', stderr: 'unreadable' };
      return { status: 0, stdout: args[0] === 'rev-parse' ? args[1] : args[0] === 'rev-list' ? '1' : args[0] === 'symbolic-ref' ? 'main' : '', stderr: '' };
    };
    expect(checkMainStaleness({ strict: true, cleanOnly: true, autoFf: false, run })).toEqual({ offline: true });
  });
});


// All IO is injected or confined to a per-test repository. No network or host state.
describe('REVIEW-GUARD-RELEVANT-BEHIND', () => {
  const H = '931427a';
  const A = '0148225';
  const warn = { action: 'warn', behind: 6, ahead: 0, dirty: false };
  const fresh = { fresh: true, behind: 0 };
  const checks = [warn, fresh, { offline: true }, null];
  let root, logs, options;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'review-guard-'));
    vi.stubEnv('WE_DAEMON_MANAGED_CLONE', '1');
    vi.stubEnv('WE_DAEMON_STATE_DIR', join(root, 'state'));
    logs = [];
    options = {
      env: { WE_DAEMON_MANAGED_CLONE: '1', WE_DAEMON_STATE_DIR: join(root, 'state') },
      adoptedHead: () => H, readHeadSha: () => H, treeDirtyForCode: () => false,
      listBehindFiles: () => ['off-path.mjs'], dispatchPath: p => p === 'scripts/lib/review-core.mjs',
      lastGood: () => null, rebuildGrace: () => null, write: s => logs.push(s),
      originRefProbe: () => ({ status: 1 }),
      run: () => ({ status: 0, stdout: '1\n' }),
    };
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
  const guard = (st = warn, extra = {}) => assertMainNotStale(root, () => st, { ...options, ...extra });
  function refused(fn, reason) {
    let err;
    try { fn(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PreStartDispatchRefusalError);
    expect(isStaleMainRefusalMessage(err.message)).toBe(true);
    if (reason) expect(err.reason).toBe(reason);
    return err;
  }
  // Only local git operations; fetch is injected below, never sent to a remote.
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_DATE: '2026-11-27T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-27T12:00:00Z' } }).trim();
  function commit(file, text) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
    git('add', file); git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  }
  function realFixture(files = []) {
    git('init', '-q', '-b', 'main');
    const adopted = commit('tracked.txt', 'base');
    git('init', '-q', '--bare', join(root, 'origin.git'));
    git('remote', 'add', 'origin', join(root, 'origin.git'));
    // Ignore all fixture infrastructure, so status measures only deliberate edits.
    writeFileSync(join(root, '.git/info/exclude'), 'origin.git/\nstate/\n');
    for (const [i, file] of files.entries()) commit(file, `change ${i}`);
    const origin = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', origin);
    git('checkout', '-q', '--detach', adopted);
    const state = { adopted: { head: adopted, at: '2026-11-27T00:00:00Z', applied: [] } };
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state', `${cloneKeyOf(root)}.rebuild.json`), JSON.stringify(state));
    expect(readRebuildStateFile(root).adopted.head).toBe(adopted);
    const run = (args, opts = {}) => {
      if (args[0] === 'fetch') return { status: 0, stdout: '' };
      try { return { status: 0, stdout: git(...args), stderr: '' }; }
      catch (error) { if (error.status == null) throw error; return { status: error.status, stdout: '', stderr: String(error.stderr) }; }
    };
    const realOptions = { ...options, adoptedHead: () => readRebuildStateFile(root)?.adopted?.head,
      readHeadSha: () => git('rev-parse', 'HEAD'), treeDirtyForCode: () => codeDirty(root, run),
      listBehindFiles: () => behindFiles(root, 'main', run, {}), run };
    return { adopted, origin, state, run, realOptions };
  }

  it('1 off-adopted-build refuses the historical off-path fixture (origin 0744f35)', () => {
    const e = refused(() => guard(warn, { adoptedHead: () => A }), 'off-adopted-build');
    expect(e.message).toContain(`HEAD ${H} is not the adopted build ${A}`);
    expect(logs).toEqual([]);
  });
  it('2 behind zero and HEAD unequal to adopted refuses', () => {
    refused(() => guard(fresh, { adoptedHead: () => A }), 'off-adopted-build');
  });
  it('3 unreadable adopted state refuses behind and passes fresh-like without probing the tree', () => {
    for (const adoptedHead of [() => null, () => undefined, () => { throw Error('unreadable'); }]) {
      expect(refused(() => guard(warn, { adoptedHead }), 'off-adopted-build').message).toContain('<unreadable>');
      for (const st of checks.slice(1)) {
        const dirty = vi.fn(() => { throw Error('must not run'); });
        expect(() => guard(st, { adoptedHead, treeDirtyForCode: dirty })).not.toThrow();
        expect(dirty).not.toHaveBeenCalled();
      }
    }
  });
  it('4 unreadable HEAD refuses every checker result with a readable adoption', () => {
    for (const st of checks) for (const readHeadSha of [() => null, () => { throw Error('HEAD'); }]) {
      const e = refused(() => guard(st, { readHeadSha }), 'off-adopted-build');
      expect(e.message).toContain('HEAD <unreadable>');
      expect(e.message).not.toMatch(/null|undefined/);
    }
  });
  it('5 unmanaged clones preserve synced results and self re-execution without clean-tree probes', () => {
    vi.stubEnv('WE_DAEMON_MANAGED_CLONE', '');
    const dirty = vi.fn(() => { throw Error('must not run'); });
    const opts = { env: {}, treeDirtyForCode: dirty };
    expect(guard(fresh, opts)).toMatchObject({ ...fresh, guardPath: 'unmanaged' });
    const reexec = vi.fn();
    const st = { synced: true, behind: 3, from: A, to: H };
    expect(guard(st, { ...opts, codeRoot: root, armed: true, reexeced: false,
      changedFiles: () => ['scripts/x.mjs'], reexec })).toMatchObject({ ...st, reexeced: true });
    expect(reexec).toHaveBeenCalledOnce();
    expect(dirty).not.toHaveBeenCalled();
  });
  it('6 offline and null checkers still enforce identity', () => {
    for (const st of [null, { offline: true }]) {
      expect(() => guard(st)).not.toThrow();
      refused(() => guard(st, { adoptedHead: () => A }), 'off-adopted-build');
      refused(() => guard(st, { readHeadSha: () => null }), 'off-adopted-build');
    }
  });
  it('7 legitimate overlay HEAD is adopted; commit-list semantics exclude its own files', () => {
    const { adopted, realOptions } = realFixture();
    git('checkout', '-q', '-b', 'fixture-overlay');
    const overlay = commit('scripts/lib/review-core.mjs', 'overlay');
    git('checkout', '-q', 'main');
    commit('backlog/main.md', 'main');
    git('merge', '-q', '--no-ff', '-m', 'overlay', overlay);
    const head = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', overlay);
    const state = { adopted: { head, applied: [{ head: overlay }], at: '2026-11-27T00:00:00Z' } };
    writeFileSync(join(root, 'state', `${cloneKeyOf(root)}.rebuild.json`), JSON.stringify(state));
    expect(head).not.toBe(adopted);
    expect(behindFiles(root, 'main', realOptions.run, {})).toEqual([]);
    refused(() => guard(warn, realOptions));
    expect(assertMainNotStale(root, undefined, realOptions).guardPath).toBe('fresh');
  });
  it('8 forceUnverified tree hashes and skipped-unrelated adoptions pass identity', () => {
    const { realOptions } = realFixture();
    const head = git('rev-parse', 'HEAD');
    for (const extra of [{ forceUnverifiedTrees: [git('rev-parse', 'HEAD^{tree}')] }, { result: 'skipped-unrelated' }]) {
      const state = { adopted: { head, at: '2026-11-27T00:00:00Z' }, ...extra };
      writeFileSync(join(root, 'state', `${cloneKeyOf(root)}.rebuild.json`), JSON.stringify(state));
      expect(guard(fresh, realOptions).guardPath).toBe('fresh');
    }
  });
  it('9 adoption-window mismatch refuses with a neutral mid-adoption diagnosis', () => {
    const e = refused(() => guard(fresh, { adoptedHead: () => A }), 'off-adopted-build');
    expect(e.message).toContain('a rebuild may be mid-adoption, or a foreign checkout moved this clone');
  });
  it('10 independent dirty-tree gate covers every checker and rejects failed status probes', () => {
    for (const st of checks) {
      for (const treeDirtyForCode of [() => true, () => { throw Error('status failed'); }]) {
        refused(() => guard(st, { treeDirtyForCode, rebuildGrace: () => ({ grace: true }), lastGood: () => ({ onLastGood: true }) }),
          st?.action === 'warn' ? undefined : 'dirty-managed-tree');
      }
      for (const [status, allowed] of [[' M tracked.txt\n', false], ['?? backlog/x.md\n', true], ['?? scripts/x.mjs\n', false]]) {
        const treeDirtyForCode = () => codeDirty(root, () => ({ status: 0, stdout: status }));
        if (allowed) expect(() => guard(st, { treeDirtyForCode })).not.toThrow();
        else refused(() => guard(st, { treeDirtyForCode }));
      }
    }
    expect(guard(fresh, { listBehindFiles: () => [] }).guardPath).toBe('fresh');
  });
  it('11 tolerance precedence refuses relevant, unknown or empty files', () => {
    for (const files of [null, ['scripts/lib/review-core.mjs'], ['backlog/x.md', 'scripts/lane-pool.mjs', 'scripts/lib/jury-core.mjs']]) {
      refused(() => guard(warn, { listBehindFiles: () => files,
        dispatchPath: p => /review-core|jury-core/.test(p) }));
    }
    expect(guard(warn, { listBehindFiles: () => ['backlog/x.md'], dispatchPath: null }).guardPath).toBe('non-code');
    refused(() => guard(warn, { listBehindFiles: () => [] }));
    refused(() => guard(warn, { listBehindFiles: () => [], dispatchPath: null }));
    refused(() => guard(warn, { listBehindFiles: () => ['a/__tests__/r.mjs'], dispatchPath: p => p.startsWith('a/') }));
    refused(() => guard(warn, { listBehindFiles: () => ['a/__tests__/r.json'], dispatchPath: p => p.startsWith('a/') }));
  });
  it('behind managed clone with empty evidence refuses without last-good and cannot use rebuild grace', () => {
    const lastGood = vi.fn(() => null);
    const rebuildGrace = vi.fn(() => ({ grace: true }));
    const opts = { listBehindFiles: () => [], lastGood, rebuildGrace };
    const error = refused(() => guard(warn, opts));
    expect(error.message).toContain('6 commit(s) behind origin/main');
    expect(error.message).toContain('0 file(s) behind');
    expect(error.message).toContain('clone-held-stale');
    expect(lastGood).toHaveBeenCalledOnce();
    expect(rebuildGrace).not.toHaveBeenCalled();
    expect(guard(warn, { ...opts, lastGood: () => ({ onLastGood: true, lastGood: H }) }).guardPath).toBe('last-good');
    expect(guard(fresh, opts).guardPath).toBe('fresh');
  });
  it('15 overrides are explicit and ordered after identity and cleanliness; unknown diff may use last-good', () => {
    const lastGood = () => ({ onLastGood: true, lastGood: H });
    const rebuildGrace = () => ({ grace: true });
    const onPath = { listBehindFiles: () => ['scripts/lib/review-core.mjs'] };
    expect(guard(warn, { ...onPath, lastGood }).guardPath).toBe('last-good');
    expect(logs.join('')).toContain('LAST-KNOWN-GOOD');
    expect(guard(warn, { ...onPath, rebuildGrace }).guardPath).toBe('grace');
    expect(logs.join('')).toContain('within the grace');
    expect(guard(warn, { listBehindFiles: () => null, lastGood }).guardPath).toBe('last-good');
    for (const override of [{ lastGood }, { rebuildGrace }]) {
      refused(() => guard(warn, { ...onPath, ...override, adoptedHead: () => A }), 'off-adopted-build');
      refused(() => guard(warn, { ...onPath, ...override, treeDirtyForCode: () => true }));
    }
    expect(decideLastGood({ headSha: H, dirty: false, nowMs: Date.parse('2026-11-27T12:00:00Z'),
      state: { adopted: { head: H, at: '2026-11-27T11:59:00Z' } }, freshAdoptMs: 3_600_000 }).onLastGood).toBe(true);
  });
  it('16 refusal and grace diagnostics name up to five relevant prompt paths', () => {
    const files = Array.from({ length: 7 }, (_, i) => `skills-src/review/prompt-${i}.md`);
    const opts = { listBehindFiles: () => files, dispatchPath: p => p.startsWith('skills-src/review/') };
    const e = refused(() => guard(warn, opts));
    guard(warn, { ...opts, rebuildGrace: () => ({ grace: true }) });
    for (const text of [e.message, logs.join('')]) {
      expect(text).toContain(files[0]); expect(text).toContain(files[4]);
      expect(text).not.toContain(files[5]); expect(text).toContain('+2 more');
    }
  });
  it('17 real fresh-by-local-main does not hide lagging adopted HEAD; off-path and empty lists pass', () => {
    const { run, realOptions, origin } = realFixture(['scripts/lib/review-core.mjs']);
    expect(checkMainStaleness({ run, autoFf: false, cleanOnly: true })).toEqual(fresh);
    const e = refused(() => assertMainNotStale(root, undefined, realOptions));
    expect(e.message).toContain('scripts/lib/review-core.mjs');
    expect(assertMainNotStale(root, undefined, { ...realOptions, dispatchPath: () => false }).guardPath).toBe('off-path');
    git('checkout', '-q', '--detach', origin);
    const listBehindFiles = vi.fn(() => behindFiles(root, 'main', run, {}));
    expect(assertMainNotStale(root, undefined, { ...realOptions, adoptedHead: () => origin, listBehindFiles }).guardPath).toBe('fresh');
    expect(listBehindFiles).toHaveBeenCalledOnce();
  });
  it('19 comparison failure is not an absent ref, including signals/errors from the production adapter', () => {
    const absent = { listBehindFiles: () => null, originRefProbe: () => ({ status: 1 }) };
    expect(guard(fresh, absent).guardPath).toBe('fresh');
    for (const probe of [() => ({ status: 0 }), () => ({ status: 128 }), () => ({ status: null, signal: 'SIGKILL' }),
      () => ({ status: 1, error: Error('timeout') }), () => { throw Error('probe'); }]) {
      expect(refused(() => guard(fresh, { ...absent, originRefProbe: probe })).message).toContain('could not compare HEAD with origin/main');
    }
    expect(guard(fresh, { ...absent, originRefProbe: () => ({ status: 0 }), lastGood: () => ({ onLastGood: true, lastGood: H }) }).guardPath).toBe('last-good');
    const probe = vi.fn(() => { throw Error('empty must not probe'); });
    expect(guard(fresh, { listBehindFiles: () => [], originRefProbe: probe }).guardPath).toBe('fresh');
    expect(probe).not.toHaveBeenCalled();
    for (const result of [{ status: null, signal: 'SIGKILL' }, { status: 1, error: Error('spawn') }]) {
      const spawnSync = vi.fn(() => result);
      refused(() => guard(fresh, { ...absent, originRefProbe: undefined, spawnSync }));
      expect(spawnSync).toHaveBeenCalledWith('git', ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'],
        expect.objectContaining({ cwd: root, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: expect.any(Number) }));
    }
    git('init', '-q', '-b', 'main');
    expect(guard(fresh, { ...absent, originRefProbe: undefined }).guardPath).toBe('fresh');
    const e = refused(() => guard(fresh, { ...absent, base: 'release', originRefProbe: (_r, base) => {
      expect(base).toBe('release'); return { status: 0 };
    } }));
    expect(e.message).toContain('could not compare HEAD with origin/release');
    expect(e.message).not.toContain('origin/main');
  });
  it('19 real log failure refuses while origin is readable and counts against the configurable base', () => {
    const { run, realOptions, origin } = realFixture(['scripts/lib/review-core.mjs']);
    const failLog = (args, opts) => args[0] === 'log' ? { status: null, signal: 'SIGKILL' } : run(args, opts);
    refused(() => assertMainNotStale(root, undefined, { ...realOptions,
      listBehindFiles: () => behindFiles(root, 'main', failLog, {}), originRefProbe: undefined }));
    git('update-ref', 'refs/remotes/origin/release', origin);
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    const counts = [];
    const releaseRun = (args, opts) => { counts.push(args); return run(args, opts); };
    const e = refused(() => assertMainNotStale(root, () => fresh, { ...realOptions, base: 'release', run: releaseRun,
      listBehindFiles: () => behindFiles(root, 'release', releaseRun, {}) }));
    expect(e.message).toContain('1 commit(s) behind origin/release');
    expect(counts).toContainEqual(['rev-list', '--count', 'HEAD..origin/release']);
  });
  it('20 file and commit counts stay separate on both checker and HEAD-based warn paths', () => {
    const { realOptions } = realFixture(Array(3).fill('scripts/lib/review-core.mjs'));
    for (const checker of [undefined, () => ({ ...warn, behind: 3 })]) {
      const e = refused(() => assertMainNotStale(root, checker, realOptions));
      expect(e.message).toContain('3 commit(s) behind origin/main');
      expect(e.message).toContain('1 file(s)');
    }
  });
  it('21 observations preserve checker classification and unknown counts across tolerances', () => {
    for (const st of checks) {
      const result = guard(st);
      expect(result.guardPath).toBe('off-path');
      expect(result.checker).toBe(st === null ? 'null' : st.offline ? 'offline' : st.fresh ? 'fresh' : 'warn');
      expect(result.behindCommits).toBe(st == null || st.offline ? null : st.fresh ? 1 : st.behind);
      expect(result.behindFileCount).toBe(1);
    }
    const unknown = guard({ offline: true }, { listBehindFiles: () => null });
    expect(unknown.behindCommits).toBeNull();
    expect(unknown.behindFileCount).toBeNull();
  });
  it('22 a child environment cannot disable the managed process identity gate', () => {
    refused(() => guard(fresh, { env: {}, adoptedHead: () => A }), 'off-adopted-build');
  });
});
