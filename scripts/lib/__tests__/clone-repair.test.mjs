/**
 * @file scripts/lib/__tests__/clone-repair.test.mjs
 * @description Daemon-clone health: dangling remote-tracking refs are pruned (and only those) before any fetch,
 *   a damaged clone is quarantined + re-cloned, and the fetch paths (self-sync, overlay) call the repair.
 *   REAL temporary git repos. Live incident: `.lanes/we-drain-daemon/lane-1` had refs/remotes/origin/lane/* naming
 *   objects absent from the shared store ("invalid sha1 pointer"), and a drain overlay fetch was rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repairCloneRefs } from '../lane-repair.mjs';
import { selfSyncCheckout, selfSyncCheckoutPoc } from '../daemon-self-sync.mjs';
import { mergeOverlayRef } from '../daemon-load-overlay.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const GHOST = 'deadbeef'.repeat(5);

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
    const r = repairCloneRefs(clone, { allowReclone: true });
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
    const r = repairCloneRefs(clone, { allowReclone: true });
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('edited');
  });

  it('fails CLOSED on a corrupt index with local edits (a failed probe is not "clean")', () => {
    writeFileSync(join(clone, 'a.txt'), 'edited');
    writeFileSync(join(clone, '.git/index'), 'not an index');
    expect(() => g(clone, 'ls-files', '--stage')).toThrow();
    const r = repairCloneRefs(clone, { allowReclone: true });
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
    const r = repairCloneRefs(clone, { allowReclone: true });
    expect(r.problems.some((p) => /history walk failed/.test(p))).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(existsSync(join(clone, 'c.txt'))).toBe(true);
  });

  it('never throws: a throwing reclone becomes {ok:false} and the clone stays put', () => {
    const head = g(clone, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone, { allowReclone: true, reclone: () => { throw new Error('EXDEV: cross-device link'); } });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/EXDEV/);
    expect(existsSync(join(clone, 'a.txt'))).toBe(true);
  });

  it('restores the original clone when the replacement clone fails', () => {
    const head = g(clone, 'rev-parse', 'HEAD');
    g(clone, 'remote', 'set-url', 'origin', join(tmp, 'no-such-origin.git'));
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone, { allowReclone: true });
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
    const r = repairCloneRefs(wt, { allowReclone: true });
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(existsSync(join(wt, 'a.txt'))).toBe(true);
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
