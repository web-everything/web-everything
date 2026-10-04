/**
 * @file main-staleness.test.mjs — proof of the #2204 fetch-first staleness guard. The git calls are the I/O
 *   boundary (injected `run`); the fresh/auto-ff/warn CLASSIFICATION and the fail-soft behaviour are decided
 *   here and unit-tested without a real repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyStaleness, checkMainStaleness, assertMainNotStale, staleRemedy, isCodePath,
  isStaleMainRefusalMessage, STALE_MAIN_REFUSAL_MARKER, behindFiles, codeDirty,
} from '../main-staleness.mjs';

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
    const st = withManagedCloneEnv(undefined, () => assertMainNotStale(clonePath, undefined, { label: 'test' }));
    expect(st.synced).toBe(true);
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('0');
  });

  it('managed clone (WE_DAEMON_MANAGED_CLONE=1): the SAME clean-behind checkout REFUSES instead of fast-forwarding', () => {
    const clonePath = makeBehindClone();
    expect(() => withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, { label: 'test' })))
      .toThrow(/STALE code from this checkout/);
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).not.toBe('0'); // never touched
  });
  // #4044 (live 2026-09-25): the fix daemon refused whole repos when its clone was a few backlog-only commits
  // behind. Commits that change no code file cannot make a checkout's import path stale.
  it('managed clone behind ONLY in non-code files (backlog/*.md) is not stale — no throw, and the clone is never touched', () => {
    const clonePath = makeBehindClone('9999-backlog-card.md');
    const st = withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, { label: 'test' }));
    expect(st).toMatchObject({ fresh: true, behindNonCodeOnly: true, behind: 1 });
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('1'); // only the rebuild moves it
  });
  // #4387 — a caller's `dispatchPath` narrows the refusal to the files that dispatch actually runs.
  it('managed clone behind in code OFF the dispatch path dispatches and logs the tolerated lag (#4387)', () => {
    const clonePath = makeBehindClone('unrelated.mjs');
    const logs = [];
    const st = withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, {
      label: 'test', dispatchPath: (p) => p === 'review.mjs', write: (s) => logs.push(s),
    }));
    expect(st).toMatchObject({ fresh: true, behindOffDispatchPath: true, behind: 1, codeFiles: 1 });
    expect(logs.join('')).toMatch(/1 commit\(s\) behind origin\/main .*tolerating the lag/);
    expect(git(clonePath, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('1'); // never touched
  });
  it('managed clone behind in code ON the dispatch path still refuses (#4387)', () => {
    const clonePath = makeBehindClone('review.mjs');
    expect(() => withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, {
      label: 'test', dispatchPath: (p) => p === 'review.mjs', write: () => {},
    }))).toThrow(/STALE code from this checkout/);
  });
  it('dispatchPath fails closed: unknown or empty behind-file list refuses; unset keeps the #4044 rule (#4387)', () => {
    const warn = () => ({ action: 'warn', reason: 'not-auto-syncing', behind: 3, ahead: 0, dirty: false });
    const opts = { label: 'test', dispatchPath: () => false, write: () => {}, lastGood: () => null };
    withManagedCloneEnv('1', () => {
      expect(() => assertMainNotStale('/repo', warn, { ...opts, listBehindFiles: () => null })).toThrow(/STALE/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, listBehindFiles: () => [] })).toThrow(/STALE/);
      expect(() => assertMainNotStale('/repo', warn, { ...opts, dispatchPath: null, listBehindFiles: () => ['x.mjs'] }))
        .toThrow(/STALE/);
      // a behind TEST file on the dispatch path is not code — tolerated
      expect(assertMainNotStale('/repo', warn, { ...opts, dispatchPath: (p) => p.startsWith('a/'), listBehindFiles: () => ['a/__tests__/r.mjs', 'x.mjs'] }))
        .toMatchObject({ fresh: true, behindOffDispatchPath: true });
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
    try { withManagedCloneEnv('1', () => assertMainNotStale(clonePath, undefined, { label: 'test' })); } catch (e) { message = e.message; }
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
