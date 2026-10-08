/**
 * @file scripts/lib/__tests__/clone-repair.test.mjs
 * @description Daemon-clone health: dangling remote-tracking refs are pruned (and only those) before any fetch,
 *   a damaged clone is quarantined + re-cloned, and the fetch paths (self-sync, overlay) call the repair.
 *   REAL temporary git repos. Live incident: `.lanes/we-drain-daemon/lane-1` had refs/remotes/origin/lane/* naming
 *   objects absent from the shared store ("invalid sha1 pointer"), and a drain overlay fetch was rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repairCloneRefs } from '../lane-repair.mjs';
import { selfSyncCheckout } from '../daemon-self-sync.mjs';
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

  it('is a no-op on a healthy clone and skips a non-clone', () => {
    expect(repairCloneRefs(clone)).toMatchObject({ ok: true, pruned: [], reported: [] });
    expect(repairCloneRefs(join(tmp, 'nope')).skipped).toBe('not-a-clone');
  });

  it('quarantines (never deletes) and re-clones a clone whose HEAD object is gone', () => {
    const head = g(clone, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone);
    expect(r.ok).toBe(true);
    expect(r.quarantinedTo).toBeTruthy();
    expect(existsSync(r.quarantinedTo)).toBe(true);
    expect(g(clone, 'rev-parse', 'HEAD')).toBe(head);
    expect(readdirSync(join(tmp, '.quarantine')).length).toBe(1);
  });

  it('refuses to re-clone a damaged clone with local edits', () => {
    writeFileSync(join(clone, 'a.txt'), 'edited');
    const head = g(clone, 'rev-parse', 'HEAD');
    rmSync(join(clone, '.git/objects', head.slice(0, 2)), { recursive: true, force: true });
    const r = repairCloneRefs(clone);
    expect(r.ok).toBe(false);
    expect(r.quarantinedTo).toBeUndefined();
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('edited');
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
});
