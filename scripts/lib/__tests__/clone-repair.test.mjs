/**
 * @file scripts/lib/__tests__/clone-repair.test.mjs
 * @description Daemon-clone health: dangling remote-tracking refs are pruned (and only those) before any fetch,
 *   a damaged clone is quarantined + re-cloned, and the fetch paths (self-sync, overlay) call the repair.
 *   REAL temporary git repos. Live incident: `.lanes/we-drain-daemon/lane-1` had refs/remotes/origin/lane/* naming
 *   objects absent from the shared store ("invalid sha1 pointer"), and a drain overlay fetch was rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repairCloneRefs, recloneInPlace } from '../lane-repair.mjs';
import { withWriteLock, withReadLock } from '../daemon-clone-lock.mjs';
import { selfSyncCheckout, selfSyncCheckoutPoc } from '../daemon-self-sync.mjs';
import { mergeOverlayRef } from '../daemon-load-overlay.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const GHOST = 'deadbeef'.repeat(5);
// A re-clone needs the caller's opt-in AND proof the daemon-clone write lock is held (tests stand the proof in).
const RECLONE = { allowReclone: true, holdsWriteLock: () => true };

let tmp, origin, clone;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clone-repair-'));
  origin = join(tmp, 'origin.git');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(tmp, 'seed');
  g(tmp, 'clone', '-q', origin, seed);
  g(seed, 'config', 'user.email', 't@t'); g(seed, 'config', 'user.name', 't');
  writeFileSync(join(seed, 'a.txt'), 'a'); g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'one'); g(seed, 'push', '-q', 'origin', 'HEAD:main');
  clone = join(tmp, 'clone');
  g(tmp, 'clone', '-q', origin, clone);
  g(clone, 'config', 'user.email', 't@t'); g(clone, 'config', 'user.name', 't');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const plant = (rel) => { const f = join(clone, '.git', rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, `${GHOST}\n`); };

describe('repairCloneRefs', () => {
  it('prunes dangling refs/remotes/* so fsck is clean', () => {
    plant('refs/remotes/origin/lane/gone-1'); plant('refs/remotes/origin/lane/gone-2');
    expect(() => g(clone, 'fsck', '--connectivity-only')).toThrow();
    const r = repairCloneRefs(clone);
    expect(r.ok).toBe(true);
    expect(r.pruned.sort()).toEqual(['refs/remotes/origin/lane/gone-1', 'refs/remotes/origin/lane/gone-2']);
    expect(() => g(clone, 'fsck', '--connectivity-only')).not.toThrow();
  });

  it('NEVER deletes a dangling local branch or tag: it reports it', () => {
    plant('refs/heads/precious'); plant('refs/tags/v0'); plant('refs/remotes/origin/lane/gone');
    const r = repairCloneRefs(clone);
    expect(r.pruned).toEqual(['refs/remotes/origin/lane/gone']);
    expect(r.reported.some((x) => x.startsWith('refs/heads/precious'))).toBe(true);
    expect(r.reported.some((x) => x.startsWith('refs/tags/v0'))).toBe(true);
    expect(existsSync(join(clone, '.git/refs/heads/precious'))).toBe(true);
    expect(existsSync(join(clone, '.git/refs/tags/v0'))).toBe(true);
    expect(r.quarantinedTo).toBeUndefined(); // dangling non-remote refs alone never trigger a re-clone
  });

  it('heals a stale commit-graph that makes fsck fail even with healthy refs', () => {
    g(clone, 'commit-graph', 'write', '--reachable');
    const gp = join(clone, '.git/objects/info/commit-graph');
    expect(existsSync(gp)).toBe(true);
    chmodSync(gp, 0o644); const bytes = readFileSync(gp); bytes[bytes.length - 30] ^= 0xff; writeFileSync(gp, bytes); // corrupt the cache
    expect(() => g(clone, 'commit-graph', 'verify')).toThrow();
    const r = repairCloneRefs(clone);
    expect(r.ok).toBe(true);
    expect(r.commitGraphHealed).toBe(true);
    expect(() => g(clone, 'fsck', '--connectivity-only')).not.toThrow();
  });

  it('is a no-op on a healthy clone and skips a non-clone', () => {
    expect(repairCloneRefs(clone)).toMatchObject({ ok: true, pruned: [], reported: [] });
    expect(repairCloneRefs(join(tmp, 'nope')).skipped).toBe('not-a-clone');
  });

  it('quarantines (never deletes) and re-clones a clone whose HEAD object is gone', () => {
    const head = g(clone, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.ok).toBe(true);
    expect(r.quarantinedTo).toBeTruthy();
    expect(existsSync(r.quarantinedTo)).toBe(true);
    expect(g(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(readdirSync(join(tmp, '.quarantine')).length).toBe(1);
  });

  it('never re-clones unless the caller opts in (default is prune-only)', () => {
    const head = g(clone, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmp, '.quarantine'))).toBe(false);
  });

  it('refuses to re-clone a damaged clone with local edits', () => {
    writeFileSync(join(clone, 'a.txt'), 'edited');
    const head = g(clone, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('edited');
  });

  it('fails CLOSED on a corrupt index with local edits (a failed probe is not "clean")', () => {
    writeFileSync(join(clone, 'a.txt'), 'edited');
    writeFileSync(join(clone, '.git/index'), 'not an index');
    expect(() => g(clone, 'ls-files', '--stage')).toThrow();
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('edited');
    expect(existsSync(join(tmp, '.quarantine'))).toBe(false);
  });

  it('refuses to re-clone when edits are STAGED only (working files match the index)', () => {
    writeFileSync(join(clone, 'b.txt'), 'b'); g(clone, 'add', 'b.txt'); g(clone, 'commit', '-qm', 'two');
    const parent = g(clone, 'rev-parse', 'HEAD~1');
    writeFileSync(join(clone, 'c.txt'), 'staged'); g(clone, 'add', 'c.txt');
    expect(g(clone, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard')).toBe('');
    rmSync(join(clone, '.git/objects', parent.slice(0, 2), parent.slice(2)), { force: true }); // history walk now fails
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.problems.some((p) => /history walk failed/.test(p))).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(existsSync(join(clone, 'c.txt'))).toBe(true);
  });

  it('never throws: a throwing reclone becomes {ok:false} and the clone stays put', () => {
    const head = g(clone, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone, { ...RECLONE, reclone: () => { throw new Error('EXDEV: cross-device link'); } });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/EXDEV/);
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
  });

  it('restores the original clone when the replacement clone fails', () => {
    const head = g(clone, 'rev-parse', 'HEAD');
    g(clone, 'remote', 'set-url', 'origin', join(tmp, 'no-such-origin.git'));
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
    expect(g(clone, 'config', '--get', 'remote.origin.url')).toMatch(/no-such-origin/);
    expect(readdirSync(tmp).filter((n) => n === 'clone')).toEqual(['clone']);
  });

  it('refuses to re-clone (or rewrite the shared commit-graph of) a linked worktree', () => {
    const wt = join(tmp, 'wt');
    g(clone, 'worktree', 'add', '-q', '--detach', wt);
    const head = g(wt, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(wt, RECLONE);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(existsSync(join(wt, 'a.txt'))).toBe(true);
  });
});

// Review round 2 (#4402): what a re-clone must carry over, when it must refuse, and how often it may try.
describe('re-clone safety (review round 2)', () => {
  const loseHead = () => { const head = g(clone, 'rev-parse', 'HEAD'); rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true }); return head; };
  // commit `two` on top of `one`, then lose `one` so the history walk fails while HEAD itself still resolves.
  const commitTwo = () => { writeFileSync(join(clone, 'b.txt'), 'b'); g(clone, 'add', 'b.txt'); g(clone, 'commit', '-qm', 'two'); return g(clone, 'rev-parse', 'HEAD~1'); };
  const loseObject = (sha) => rmSync(join(clone, '.git/objects', sha.slice(0, 2), sha.slice(2)), { force: true });

  it('carries clone-local config, hooks, info/exclude and ignored files into the replacement', () => {
    g(clone, 'config', 'user.email', 'daemon@example.test'); g(clone, 'config', 'core.commitGraph', 'false');
    g(clone, 'remote', 'add', 'extra', join(tmp, 'origin.git'));
    mkdirSync(join(clone, '.git/hooks'), { recursive: true }); writeFileSync(join(clone, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(join(clone, '.git/info'), { recursive: true }); writeFileSync(join(clone, '.git/info/exclude'), 'node_modules/\n');
    mkdirSync(join(clone, 'node_modules/dep'), { recursive: true }); writeFileSync(join(clone, 'node_modules/dep/index.js'), 'ok');
    loseHead();
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.quarantinedTo).toBeTruthy();
    expect(g(clone, 'config', '--get', 'user.email')).toBe('daemon@example.test');
    expect(g(clone, 'config', '--get', 'core.commitGraph')).toBe('false');
    expect(g(clone, 'remote')).toContain('extra');
    expect(existsSync(join(clone, '.git/hooks/pre-commit'))).toBe(true);
    expect(readFileSync(join(clone, '.git/info/exclude'), 'utf8')).toContain('node_modules/');
    expect(readFileSync(join(clone, 'node_modules/dep/index.js'), 'utf8')).toBe('ok');
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it('refuses when HEAD carries unpushed commits and older history is damaged', () => {
    loseObject(commitTwo());
    const head = g(clone, 'rev-parse', 'HEAD');
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.problems.some((p) => /history walk failed/.test(p))).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(g(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(tmp, '.quarantine'))).toBe(false);
  });

  it('refuses when a NON-checked-out local branch has unpushed commits', () => {
    writeFileSync(join(clone, 'b.txt'), 'b'); g(clone, 'add', 'b.txt'); g(clone, 'commit', '-qm', 'two'); g(clone, 'push', '-q', 'origin', 'HEAD:main');
    const parent = g(clone, 'rev-parse', 'HEAD~1');
    g(clone, 'checkout', '-q', '-b', 'side'); writeFileSync(join(clone, 'c.txt'), 'c'); g(clone, 'add', 'c.txt'); g(clone, 'commit', '-qm', 'three'); g(clone, 'checkout', '-q', 'main');
    loseObject(parent);
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.quarantinedTo).toBeUndefined();
    expect(r.ok).toBe(false);
    expect(g(clone, 'rev-parse', '--verify', 'side')).toBeTruthy();
  });

  it('refuses when the clone holds a stash', () => {
    writeFileSync(join(clone, 'b.txt'), 'b'); g(clone, 'add', 'b.txt'); g(clone, 'commit', '-qm', 'two'); g(clone, 'push', '-q', 'origin', 'HEAD:main');
    const parent = g(clone, 'rev-parse', 'HEAD~1');
    writeFileSync(join(clone, 'a.txt'), 'stashed'); g(clone, 'stash', 'push', '-q');
    loseObject(parent);
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.quarantinedTo).toBeUndefined();
    expect(r.ok).toBe(false);
    expect(g(clone, 'stash', 'list')).toMatch(/stash@\{0\}/);
  });

  it('still re-clones when HEAD is pushed and only older history is damaged (not over-refusing)', () => {
    writeFileSync(join(clone, 'b.txt'), 'b'); g(clone, 'add', 'b.txt'); g(clone, 'commit', '-qm', 'two'); g(clone, 'push', '-q', 'origin', 'HEAD:main');
    loseObject(g(clone, 'rev-parse', 'HEAD~1'));
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.ok).toBe(true);
    expect(r.quarantinedTo).toBeTruthy();
    expect(() => g(clone, 'rev-list', 'HEAD')).not.toThrow();
  });

  it('does not read the daemon\'s own reproducible overlay merge commits as unpushed work, but still refuses anyone else\'s', () => {
    // one (pushed) -> two (pushed = origin/main) -> three (local). Losing `one` damages history below the remote tip.
    writeFileSync(join(clone, 'b.txt'), 'b'); g(clone, 'add', 'b.txt'); g(clone, 'commit', '-qm', 'two'); g(clone, 'push', '-q', 'origin', 'HEAD:main');
    const one = g(clone, 'rev-parse', 'HEAD~1');
    writeFileSync(join(clone, 'c.txt'), 'c'); g(clone, 'add', 'c.txt');
    g(clone, '-c', 'user.email=daemon-rebuild@localhost', 'commit', '-qm', 'daemon-rebuild: merge overlay x');
    loseObject(one);
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.ok).toBe(true);
    expect(r.quarantinedTo).toBeTruthy();
  });

  it('keeps the fresh config when the carried-over one breaks the fresh clone', () => {
    g(clone, 'config', 'user.email', 'carried@example.test');
    loseHead();
    let calls = 0;
    const verify = () => ({ problems: ++calls === 1 ? [] : ['config broke git'] }); // healthy fresh clone, broken after carry-over
    const r = recloneInPlace(clone, join(tmp, '.quarantine'), { verify });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(clone, '.git/config'), 'utf8')).not.toContain('carried@example.test'); // the poisoned old config was NOT kept
    expect(readdirSync(join(clone, '.git')).filter((n) => n.startsWith('config.'))).toEqual([]); // no temp files left behind
  });

  it('never carries an ignored path through a symlink that the fresh clone tracks', () => {
    const seed = join(tmp, 'seed');
    mkdirSync(join(tmp, 'outside'), { recursive: true });
    symlinkSync('../outside', join(seed, 'build')); g(seed, 'add', 'build'); g(seed, 'commit', '-qm', 'link'); g(seed, 'push', '-q', 'origin', 'HEAD:main');
    mkdirSync(join(clone, '.git/info'), { recursive: true }); writeFileSync(join(clone, '.git/info/exclude'), 'build/\n');
    mkdirSync(join(clone, 'build/x'), { recursive: true }); writeFileSync(join(clone, 'build/x/f'), 'x');
    loseHead();
    const r = recloneInPlace(clone, join(tmp, '.quarantine'));
    expect(r.ok).toBe(true);
    expect(readdirSync(join(tmp, 'outside'))).toEqual([]);
    expect(existsSync(join(r.quarantinedTo, 'build/x/f'))).toBe(true); // stayed in quarantine
  });

  it('a backoff stamp from the future (clock skew, garbage) does not block the re-clone', () => {
    loseHead();
    mkdirSync(join(tmp, '.quarantine'), { recursive: true });
    writeFileSync(join(tmp, '.quarantine/.reclone-attempt-clone'), '9999999999999999');
    const r = repairCloneRefs(clone, RECLONE);
    expect(r.ok).toBe(true);
    expect(r.quarantinedTo).toBeTruthy();
  });

  it('a re-clone that leaves the clone still broken is undone: old clone restored, nothing piles up in quarantine', () => {
    loseHead();
    const r = recloneInPlace(clone, join(tmp, '.quarantine'), { verify: () => ({ ok: false, problems: ['history walk failed: still bad'] }) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/still (broken|damaged)/);
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
    expect(readdirSync(join(tmp, '.quarantine'))).toEqual([]);
  });

  it('an unhealable clone is re-cloned at most once per backoff window, not on every call', () => {
    loseHead();
    let attempts = 0;
    const reclone = () => { attempts++; return { ok: false, error: 'persistent shared-store damage' }; };
    const t0 = Date.now();
    repairCloneRefs(clone, { ...RECLONE, reclone, now: t0 });
    const second = repairCloneRefs(clone, { ...RECLONE, reclone, now: t0 + 60_000 });
    expect(attempts).toBe(1);
    expect(second.ok).toBe(false);
    repairCloneRefs(clone, { ...RECLONE, reclone, now: t0 + 2 * 60 * 60_000 });
    expect(attempts).toBe(2); // the window passes, it may try again
  });

  it('a clone URL that starts with "-" is never handed to git clone as an option', () => {
    g(clone, 'config', 'remote.origin.url', '-ouploadpack');
    loseHead();
    const r = recloneInPlace(clone, join(tmp, '.quarantine'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsafe|starts with/);
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmp, '.quarantine'))).toBe(false);
  });
});

describe('re-clone is gated on the daemon-clone write lock (review round 2)', () => {
  let lockRoot, oldLockRoot;
  beforeEach(() => { lockRoot = join(tmp, 'locks'); oldLockRoot = process.env.WE_DAEMON_CLONE_LOCK_ROOT; process.env.WE_DAEMON_CLONE_LOCK_ROOT = lockRoot; });
  afterEach(() => { if (oldLockRoot === undefined) delete process.env.WE_DAEMON_CLONE_LOCK_ROOT; else process.env.WE_DAEMON_CLONE_LOCK_ROOT = oldLockRoot; });
  const loseHead = () => { const head = g(clone, 'rev-parse', 'HEAD'); rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true }); };

  it('refuses to move the clone when the caller holds no lock at all', () => {
    loseHead();
    const r = repairCloneRefs(clone, { allowReclone: true });
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
  });

  it('refuses while a sibling reader holds a read lock on the clone', async () => {
    loseHead();
    const res = await withReadLock(clone, () => repairCloneRefs(clone, { allowReclone: true }));
    expect(res.ok).toBe(true);
    expect(res.value.ok).toBe(false);
    expect(res.value.quarantinedTo).toBeUndefined();
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
  });

  it('re-clones when this process holds the write lock', async () => {
    loseHead();
    const res = await withWriteLock(clone, () => repairCloneRefs(clone, { allowReclone: true }));
    expect(res.ok).toBe(true);
    expect(res.value.ok).toBe(true);
    expect(res.value.quarantinedTo).toBeTruthy();
  });

  it('only the rebuild prepare step (which runs under withWriteLock) opts in to re-cloning', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    const sites = [['scripts/lib/daemon-self-sync.mjs', false], ['scripts/lib/daemon-load-overlay.mjs', false], ['scripts/lib/daemon-rebuild/prepare.mjs', true]];
    for (const [file, opts] of sites) {
      const src = readFileSync(join(root, file), 'utf8');
      expect(/repairCloneRefs\([^;]*allowReclone: true/.test(src), file).toBe(opts);
    }
  });
});

describe('repairCloneRefs cost and noise', () => {
  const gitLog = () => join(tmp, 'git-calls.log');
  const withGitShim = (fn) => {
    const bin = join(tmp, 'bin'); mkdirSync(bin, { recursive: true });
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${gitLog()}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
    try { return fn(); } finally { process.env.PATH = old; }
  };
  const calls = () => (existsSync(gitLog()) ? readFileSync(gitLog(), 'utf8').split('\n').filter(Boolean) : []);

  it('a healthy clone costs two git calls once the deep check has run', () => {
    repairCloneRefs(clone); // first call runs (and stamps) the deep check
    withGitShim(() => repairCloneRefs(clone));
    expect(calls()).toHaveLength(2);
    expect(calls().some((c) => /commit-graph|ls-files|rev-list/.test(c))).toBe(false);
  });

  it('a persistent dangling LOCAL ref does not force the deep checks on every sync', () => {
    plant('refs/heads/precious-cost');
    repairCloneRefs(clone);
    withGitShim(() => repairCloneRefs(clone));
    expect(calls().length).toBeLessThanOrEqual(3); // for-each-ref, cat-file, symbolic-ref
    expect(calls().some((c) => /commit-graph|ls-files|rev-list/.test(c))).toBe(false);
  });

  it('a failed ref probe is "unverified", not healthy: ok:false and no throttle stamp', () => {
    const bin = join(tmp, 'bin-fail'); mkdirSync(bin, { recursive: true });
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = for-each-ref ]; then exit 128; fi\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
    let r;
    try { r = repairCloneRefs(clone); } finally { process.env.PATH = old; }
    expect(r.ok).toBe(false);
    expect(existsSync(join(clone, '.git/.clone-repair-deep-checked'))).toBe(false);
  });

  it('re-runs the deep check once its interval has passed', () => {
    repairCloneRefs(clone);
    withGitShim(() => repairCloneRefs(clone, { now: Date.now() + 11 * 60_000 }));
    expect(calls().some((c) => /commit-graph verify/.test(c))).toBe(true);
  });

  it('warns about a dangling local branch once per process, not on every sync', () => {
    plant('refs/heads/precious-warn-once');
    const lines = [];
    const first = repairCloneRefs(clone, { log: (m) => lines.push(m) });
    const second = repairCloneRefs(clone, { log: (m) => lines.push(m) });
    expect(first.reportedNew).toHaveLength(1);
    expect(second.reportedNew).toHaveLength(0);
    expect(second.reported).toHaveLength(1); // still reported as state, just not re-announced
    expect(lines.filter((l) => /precious-warn-once/.test(l))).toHaveLength(1);
  });
});

describe('fetch paths call the repair first', () => {
  it('selfSyncCheckout prunes a dangling remote-tracking ref', () => {
    plant('refs/remotes/origin/lane/gone');
    selfSyncCheckout({ root: clone });
    expect(existsSync(join(clone, '.git/refs/remotes/origin/lane/gone'))).toBe(false);
  });
  it('mergeOverlayRef prunes a dangling remote-tracking ref before fetching the overlay', () => {
    plant('refs/remotes/origin/lane/gone');
    mergeOverlayRef({ root: clone, ref: 'main' });
    expect(existsSync(join(clone, '.git/refs/remotes/origin/lane/gone'))).toBe(false);
  });
  it('selfSyncCheckoutPoc prunes a dangling remote-tracking ref', () => {
    plant('refs/remotes/origin/lane/gone');
    selfSyncCheckoutPoc({ root: clone, pocBranch: 'main' });
    expect(existsSync(join(clone, '.git/refs/remotes/origin/lane/gone'))).toBe(false);
  });
});

// The rebuild prepare step and the drain's own clone sync are too heavy to drive end to end here, so pin the ORDER
// instead: in each, `repairCloneRefs` runs before the first fetch/pull. Deleting the call (or moving it after the
// fetch) reddens this. (The drain data clone is the incident's actual clone.)
describe('every daemon fetch site repairs first', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const body = (file, startRe) => {
    const src = readFileSync(join(root, file), 'utf8');
    const at = src.search(startRe);
    expect(at, `${file} ${startRe}`).toBeGreaterThanOrEqual(0);
    return src.slice(at, at + 4000);
  };
  const repairsBeforeFetch = (text) => {
    const repair = text.indexOf('repairCloneRefs(');
    const fetch = text.search(/'(fetch|pull)'|fetchMainAndOverlays\(/);
    return repair >= 0 && fetch >= 0 && repair < fetch;
  };
  it.each([
    ['scripts/lib/daemon-rebuild/prepare.mjs', /Step 2: fetch/],
    ['scripts/lane-drain.mjs', /function syncMain\(/],
    ['scripts/lane-drain.mjs', /function readResolveReachable\(/],
    ['scripts/lib/daemon-self-sync.mjs', /export function selfSyncCheckoutPoc\(/],
  ])('%s %s', (file, re) => {
    expect(repairsBeforeFetch(body(file, re))).toBe(true);
  });
});
