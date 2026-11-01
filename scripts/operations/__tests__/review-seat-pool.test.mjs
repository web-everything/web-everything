import { it, expect, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, renameSync, symlinkSync, utimesSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireSeatSlot, pruneSeatPool, slotBusy } from '../../lib/review-seat-pool.mjs';
import { ownReviewScratch, removeReviewScratch } from '../../lib/review-scratch.mjs';
import { spawnKeepAlive } from '../../lib/test-keepalive.mjs';
// Collect the review module before test deadlines start; cold module transforms are not slot operations.
import { repoRelativeFindings, seatInputDir } from '../review-extra-seats.mjs';

const roots = [];
let lane; let pool; let rev1; let rev2;
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'we-pool-test-')); roots.push(base);
  lane = join(base, 'lane'); pool = join(base, 'pool');
  spawnSync('git', ['init', '--quiet', lane]);
  writeFileSync(join(lane, 'stable.txt'), 'same\n'); writeFileSync(join(lane, 'moves.txt'), 'one\n');
  git(lane, 'add', '-A'); git(lane, 'commit', '-qm', 'one'); rev1 = git(lane, 'rev-parse', 'HEAD');
  writeFileSync(join(lane, 'moves.txt'), 'two\n'); git(lane, 'commit', '-qam', 'two'); rev2 = git(lane, 'rev-parse', 'HEAD');
});
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

it('gives two concurrent seats on one commit separate slots, then reuses a released one without rewriting files', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(a.slotDir).not.toBe(b.slotDir);
  for (const s of [a, b]) { expect(readFileSync(join(s.dir, 'moves.txt'), 'utf8')).toBe('one\n'); expect(git(s.dir, 'rev-parse', 'HEAD')).toBe(rev1); }
  writeFileSync(join(a.dir, 'junk.txt'), 'seat wrote this'); // a seat must not leak into another seat
  expect(existsSync(join(b.dir, 'junk.txt'))).toBe(false);
  const inode = statSync(join(a.dir, 'stable.txt')).ino; const mtime = statSync(join(a.dir, 'stable.txt')).mtimeMs;
  a.release();
  const c = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(c.slotDir).toBe(a.slotDir); expect(c.reused).toBe(true);
  expect(existsSync(join(c.dir, 'junk.txt'))).toBe(false);
  expect(statSync(join(c.dir, 'stable.txt')).ino).toBe(inode); expect(statSync(join(c.dir, 'stable.txt')).mtimeMs).toBe(mtime);
  b.release(); c.release();
});

it('keeps seat inputs outside the pinned tree and clears them on reuse; a live or fresh lock is never reclaimed', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  const input = seatInputDir(a.dir);
  expect(input.startsWith(a.slotDir + '/')).toBe(false);
  mkdirSync(input, { recursive: true }); writeFileSync(join(input, 'net.diff'), 'x');
  // lock held by a live pid, even if backdated: not reclaimable
  const lock = join(pool, 'locks', 'slot-1');
  utimesSync(lock, new Date(0), new Date(0));
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(b.slotDir).not.toBe(a.slotDir);
  a.release(); b.release();
  const c = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(existsSync(input)).toBe(false);
  c.release();
  // dead owner: a young lock is kept; an old one is reclaimed unless a reclaim of that exact token is in flight
  const dead = () => { mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 't0', expiresAt: Date.now() + 3600e3 })); };
  rmSync(lock, { recursive: true, force: true }); dead();
  expect(acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }).slotDir).not.toBe(c.slotDir); // young
  mkdirSync(`${lock}.reclaim-t0`);
  expect(acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }).slotDir).not.toBe(c.slotDir); // reclaim in flight
  rmSync(`${lock}.reclaim-t0`, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 't0', expiresAt: Date.now() - 1 }));
  const d = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(d.slotDir).toBe(c.slotDir);
  expect(existsSync(`${lock}.reclaim-t0`)).toBe(false);
});

it('a repeated release or cleanup never frees or deletes a slot another seat now holds', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  ownReviewScratch(a.dir, undefined, { release: a.release });
  removeReviewScratch(a.dir);
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  ownReviewScratch(b.dir, undefined, { release: b.release });
  expect(b.slotDir).toBe(a.slotDir); expect(b.dir).not.toBe(a.dir);
  removeReviewScratch(a.dir); a.release(); // stale handle of seat A, repeated
  const c = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(c.slotDir).not.toBe(b.slotDir); // B still holds its slot
  expect(existsSync(join(b.dir, 'moves.txt'))).toBe(true);
  removeReviewScratch(b.dir); removeReviewScratch(b.dir);
  expect(existsSync(join(b.slotDir, 'moves.txt'))).toBe(true); // slot stays warm
  c.release();
  expect(readdirSync(join(pool, 'views'))).toEqual([]);
});

it('normalizes findings cited by the view path or by the physical slot path to repo-relative', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  const mk = (file) => ({ s: { findings: [{ file }] } });
  for (const file of [join(a.dir, 'src/x.mjs'), join(a.slotDir, 'src/x.mjs'), join(realpathSync(a.slotDir), 'src/x.mjs'), join(readlinkSync(a.dir), 'src/x.mjs')]) {
    expect(repoRelativeFindings(mk(file), a.dir).s.findings[0].file).toBe('src/x.mjs');
  }
  a.release();
});

it('refuses a planted slot link: never resets a directory it did not create', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  rmSync(a.slotDir, { recursive: true, force: true });
  symlinkSync(lane, a.slotDir); // attacker/mistake: slot-1 -> the lane
  writeFileSync(join(lane, 'precious.txt'), 'keep');
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(b.slotDir).not.toBe(a.slotDir); // the planted path is skipped, never reset or deleted
  expect(readFileSync(join(lane, 'precious.txt'), 'utf8')).toBe('keep');
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(rev2);
  b.release(); expect(readdirSync(join(pool, 'locks'))).toEqual([]);
});

it('restores a slot a seat left sparse, and refuses a slot whose admin dir is redirected or a planted store', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  git(a.slotDir, 'sparse-checkout', 'set', '--no-cone', 'stable.txt'); // a seat narrowing the tree
  expect(existsSync(join(a.slotDir, 'moves.txt'))).toBe(false);
  a.release();
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(b.slotDir).toBe(a.slotDir);
  expect(readFileSync(join(b.dir, 'moves.txt'), 'utf8')).toBe('one\n'); // whole tree again
  b.release();
  // redirect the slot's admin dir at the lane's own .git
  const admin = join(pool, 'repo.git', 'worktrees', 'slot-1');
  rmSync(admin, { recursive: true }); symlinkSync(join(lane, '.git'), admin);
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool })).toThrow();
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(rev2);
  // a planted store link never reaches git init
  const pool2 = join(pool, '..', 'pool2'); mkdirSync(pool2);
  const target = join(pool, '..', 'victim'); mkdirSync(target); symlinkSync(target, join(pool2, 'repo.git'));
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool2 })).toThrow(/private directory/);
  expect(readdirSync(target)).toEqual([]);
});

it('ignores replace refs and refuses a store that points at another repository', () => {
  acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }).release(); // both commits present in the store
  const a = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool }); a.release();
  git(join(pool, 'repo.git'), 'replace', rev2, rev1); // the shared store claims rev2 is rev1
  const b = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool });
  expect(readFileSync(join(b.dir, 'moves.txt'), 'utf8')).toBe('two\n'); // still the real rev2 tree
  b.release();
  writeFileSync(join(pool, 'repo.git', '.git'), `gitdir: ${join(lane, '.git')}\n`);
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool })).toThrow(/bare repository/);
  expect(git(lane, 'worktree', 'list').split('\n').length).toBe(1);
});

it('rewrites a poisoned store config, and a slot with a live cwd inside it is never reclaimed', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const marker = join(lane, 'hook-ran');
  writeFileSync(join(pool, 'repo.git', 'config'), `[core]\n\tbare = true\n\thooksPath = ${join(lane, 'hooks')}\n[filter "x"]\n\tsmudge = touch ${marker}\n`);
  const b = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool });
  expect(readFileSync(join(pool, 'repo.git', 'config'), 'utf8')).not.toMatch(/filter|hooksPath/);
  expect(existsSync(marker)).toBe(false);
  b.release();
  expect(slotBusy(b.slotDir, () => ({ status: 0, stdout: `p1\nn${realpathSync(b.slotDir)}/sub\n` }))).toBe(true);
  expect(slotBusy(b.slotDir, () => ({ status: 0, stdout: 'p1\nn/elsewhere\n' }))).toBe(false);
  expect(() => slotBusy(b.slotDir, () => ({ status: 2, stdout: '' }))).toThrow(/lsof/); // unknown disables pooling
});

it('refuses a store whose objects are redirected or borrowed, and never fetches into the lane', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const objects = join(pool, 'repo.git', 'objects');
  mkdirSync(join(objects, 'info'), { recursive: true });
  writeFileSync(join(objects, 'info', 'alternates'), `${join(lane, '.git', 'objects')}\n`);
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool })).toThrow(/borrows/);
  rmSync(join(objects, 'info', 'alternates'));
  const moved = join(pool, 'objects.real'); renameSync(objects, moved); symlinkSync(join(lane, '.git', 'objects'), objects);
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool })).toThrow(/private directory/);
  expect(readdirSync(join(lane, '.git', 'objects')).length).toBeGreaterThan(0);
});

it('skips a released slot a surviving process still sits in, and rejects links inside object storage', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const sitter = spawnKeepAlive({ cwd: a.slotDir, maxLifetimeMs: 30_000 });
  try {
    const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
    expect(b.slotDir).not.toBe(a.slotDir);
    expect(existsSync(join(pool, 'locks', 'slot-1'))).toBe(false);
    b.release();
  } finally { sitter.kill(); }
  const fan = readdirSync(join(pool, 'repo.git', 'objects')).find((n) => /^[0-9a-f]{2}$/.test(n));
  const real = join(pool, 'fan.real'); renameSync(join(pool, 'repo.git', 'objects', fan), real);
  symlinkSync(real, join(pool, 'repo.git', 'objects', fan));
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool })).toThrow(/contains a link/);
});

it('refuses a planted worktrees admin link before git writes, and ignores injected GIT_CONFIG_* env', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const wt = join(pool, 'repo.git', 'worktrees');
  rmSync(wt, { recursive: true, force: true }); symlinkSync(join(lane, '.git'), wt);
  rmSync(a.slotDir, { recursive: true, force: true });
  const before = readdirSync(join(lane, '.git')).sort();
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool })).toThrow();
  expect(readdirSync(join(lane, '.git')).sort()).toEqual(before);
  rmSync(wt);
  const marker = join(lane, 'smudge-ran'); const old = { ...process.env };
  process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'filter.x.smudge'; process.env.GIT_CONFIG_VALUE_0 = `touch ${marker}`;
  try { writeFileSync(join(lane, '.gitattributes'), '* filter=x\n'); git(lane, 'add', '.gitattributes'); git(lane, 'commit', '-qm', 'attrs'); }
  finally { for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k]; Object.assign(process.env, old); }
  const rev3 = git(lane, 'rev-parse', 'HEAD');
  process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'filter.x.smudge'; process.env.GIT_CONFIG_VALUE_0 = `touch ${marker}`;
  try { const b = acquireSeatSlot({ lanePath: lane, rev: rev3, poolDir: pool }); b.release(); }
  finally { delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0; }
  expect(existsSync(marker)).toBe(false);
});

it('refuses a reused slot whose admin dir holds a link', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  symlinkSync(join(lane, '.git', 'logs'), join(pool, 'repo.git', 'worktrees', 'slot-1', 'logs'));
  const before = readdirSync(join(lane, '.git')).sort();
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool })).toThrow(/contains a link/);
  expect(readdirSync(join(lane, '.git')).sort()).toEqual(before);
});

it('refuses a store with a redirected refs dir, and prune will not delete through a redirected parent', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const refs = join(pool, 'repo.git', 'refs', 'seat');
  mkdirSync(join(pool, 'repo.git', 'refs'), { recursive: true }); rmSync(refs, { recursive: true, force: true });
  symlinkSync(join(lane, '.git', 'refs'), refs);
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool })).toThrow(/contains a link/);
  rmSync(refs);
  // a redirected views dir must not expose a foreign foo.input to deletion
  const victim = join(pool, '..', 'victim-views'); mkdirSync(join(victim, 'foo.input'), { recursive: true });
  rmSync(join(pool, 'views'), { recursive: true, force: true }); symlinkSync(victim, join(pool, 'views'));
  expect(pruneSeatPool({ poolDir: pool, keep: 0 })).toEqual([]);
  expect(existsSync(join(victim, 'foo.input'))).toBe(true);
  expect(existsSync(join(a.slotDir, '.git'))).toBe(true);
});

it('prune keeps a foreign directory in a slot path, and a hard-linked store file is refused', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  rmSync(a.slotDir, { recursive: true }); mkdirSync(a.slotDir); writeFileSync(join(a.slotDir, 'foreign.txt'), 'not ours');
  expect(pruneSeatPool({ poolDir: pool, keep: 0 })).toEqual([]);
  expect(existsSync(join(a.slotDir, 'foreign.txt'))).toBe(true);
  const store = join(pool, 'repo.git');
  linkSync(join(lane, 'stable.txt'), join(store, 'hardlinked'));
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool })).toThrow(/hard link/);
});

it('moves a warm slot to a new commit rewriting only the changed file', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  const stable = statSync(join(a.dir, 'stable.txt')).ino; a.release();
  const b = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool });
  expect(b.slotDir).toBe(a.slotDir); expect(b.reused).toBe(false);
  expect(git(b.dir, 'rev-parse', 'HEAD')).toBe(rev2);
  expect(readFileSync(join(b.dir, 'moves.txt'), 'utf8')).toBe('two\n');
  expect(statSync(join(b.dir, 'stable.txt')).ino).toBe(stable);
  expect(git(b.dir, 'status', '--porcelain')).toBe('');
  b.release();
});

it('releases locks, prunes idle slots with their worktrees, and never touches the lane', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  const b = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool });
  expect(pruneSeatPool({ poolDir: pool, keep: 0 })).toEqual([]); // both held: nothing pruned
  a.release(); b.release();
  expect(readdirSync(join(pool, 'locks'))).toEqual([]);
  expect(pruneSeatPool({ poolDir: pool, keep: 1 }).length).toBe(1);
  expect(readdirSync(join(pool, 'slots')).length).toBe(1);
  expect(pruneSeatPool({ poolDir: pool, keep: 0 }).length).toBe(1);
  expect(readdirSync(join(pool, 'slots'))).toEqual([]);
  expect(git(pool + '/repo.git', 'worktree', 'list').split('\n').length).toBe(1);
  expect(git(lane, 'worktree', 'list').split('\n').length).toBe(1);
  expect(git(lane, 'status', '--porcelain')).toBe('');
});

it('makeScratch hands out a pooled checkout at the pinned rev and removeScratch frees the slot, not deletes it', () => {
  const url = pathToFileURL(resolve('scripts/operations/review-extra-seats.mjs')).href;
  const code = `import { createExtraSeatsIo } from ${JSON.stringify(url)}; import { readFileSync, existsSync } from 'node:fs';
    const io = createExtraSeatsIo(); const d = io.makeScratch({ lanePath: ${JSON.stringify(lane)}, rev: ${JSON.stringify(rev1)} });
    if (readFileSync(d + '/moves.txt', 'utf8') !== 'one\\n') throw new Error('wrong tree');
    io.removeScratch(d); if (existsSync(d)) throw new Error('view should be gone');
    if (!existsSync(process.env.WE_REVIEW_SEAT_POOL_DIR + '/slots/slot-1/moves.txt')) throw new Error('slot should stay warm');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, WE_REVIEW_SEAT_POOL_DIR: pool, TMPDIR: join(pool, 'tmp') }, encoding: 'utf8', timeout: 30000 });
  expect(r.status, r.stderr).toBe(0);
  expect(readdirSync(join(pool, 'locks'))).toEqual([]);
});

it('expired live-owner lock is preserved', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  const ownerPath = join(pool, 'locks', 'slot-1', 'owner.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  writeFileSync(ownerPath, JSON.stringify({ ...owner, expiresAt: 1 }));
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool, now: () => 100 });
  expect(b.slotDir).not.toBe(a.slotDir);
  expect(JSON.parse(readFileSync(ownerPath, 'utf8')).token).toBe(owner.token);
  a.release(); b.release();
});

it('expired dead-owner lock with reclaim marker is preserved', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const lock = join(pool, 'locks', 'slot-1'); mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'expired', expiresAt: 1 }));
  mkdirSync(`${lock}.reclaim-expired`);
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool, now: () => 100 });
  expect(b.slotDir).not.toBe(a.slotDir);
  expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token).toBe('expired');
  expect(existsSync(`${lock}.reclaim-expired`)).toBe(true);
  b.release();
});

it('default pruning retains four recent idle slots', () => {
  const seats = Array.from({ length: 6 }, () => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }));
  seats.forEach((s, i) => {
    s.release();
    utimesSync(join(pool, 'state', `slot-${i + 1}.rev`), new Date(1000 + i * 1000), new Date(1000 + i * 1000));
  });
  expect(pruneSeatPool({ poolDir: pool, now: () => 10_000 })).toEqual([2, 1]);
  expect(readdirSync(join(pool, 'slots')).sort()).toEqual(['slot-3', 'slot-4', 'slot-5', 'slot-6']);
});

it('default pruning expires an idle slot after 24 hours', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const stamp = join(pool, 'state', 'slot-1.rev'); utimesSync(stamp, new Date(1000), new Date(1000));
  expect(pruneSeatPool({ poolDir: pool, now: () => 1000 + 24 * 3600_000 - 1 })).toEqual([]);
  expect(pruneSeatPool({ poolDir: pool, now: () => 1000 + 24 * 3600_000 })).toEqual([1]);
  expect(readdirSync(join(pool, 'slots'))).toEqual([]);
});

it('prune honors an injected idle age and clock', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  utimesSync(join(pool, 'state', 'slot-1.rev'), new Date(1000), new Date(1000));
  expect(pruneSeatPool({ poolDir: pool, now: () => 1099, maxIdleMs: 100 })).toEqual([]);
  expect(pruneSeatPool({ poolDir: pool, now: () => 1100, maxIdleMs: 100 })).toEqual([1]);
  expect(existsSync(a.slotDir)).toBe(false);
});

it('prune removes abandoned views and inputs after reclaim while preserving the current seat', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  mkdirSync(`${a.dir}.input`); writeFileSync(join(`${a.dir}.input`, 'net.diff'), 'private diff');
  const ownerPath = join(pool, 'locks', 'slot-1', 'owner.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 2 ** 22 + 12345, expiresAt: 1 }));
  const b = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool, now: () => 100 });
  expect(b.slotDir).toBe(a.slotDir);
  mkdirSync(`${b.dir}.input`); writeFileSync(join(`${b.dir}.input`, 'net.diff'), 'current diff');
  pruneSeatPool({ poolDir: pool, now: () => 100, maxIdleMs: 1 });
  expect(existsSync(a.dir)).toBe(false);
  expect(existsSync(`${a.dir}.input`)).toBe(false);
  expect(readFileSync(join(`${b.dir}.input`, 'net.diff'), 'utf8')).toBe('current diff');
  expect(existsSync(b.dir)).toBe(true);
  a.release(); b.release();
});

it.each([
  ['missing', { error: Object.assign(new Error('missing lsof'), { code: 'ENOENT' }) }],
  ['timed out', { error: Object.assign(new Error('lsof timeout'), { code: 'ETIMEDOUT' }) }],
  ['failed', { status: 2, stdout: '' }],
])('unavailable lsof (%s) refuses acquisition without growing the pool or leaking locks', (_label, result) => {
  acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }).release();
  const runLsof = () => result;
  for (let i = 0; i < 5; i++) {
    expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool, runLsof })).toThrow(/lsof/);
    expect(pruneSeatPool({ poolDir: pool, keep: 0, runLsof })).toEqual([]);
    expect(readdirSync(join(pool, 'slots'))).toEqual(['slot-1']);
    expect(readdirSync(join(pool, 'locks'))).toEqual([]);
  }
  const cold = join(pool, 'cold');
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: cold, runLsof })).toThrow(/lsof/);
  expect(existsSync(cold)).toBe(false);
});

it('a probe failure after claiming a free slot releases the new lock', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  let calls = 0;
  const runLsof = () => ++calls === 1 ? { status: 1, stdout: '' } : { error: new Error('lsof timeout') };
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool, runLsof })).toThrow(/lsof/);
  expect(calls).toBe(2);
  expect(readdirSync(join(pool, 'locks'))).toEqual([]);
  expect(readdirSync(join(pool, 'slots'))).toEqual(['slot-1']);
});

it('recovers after one malformed slot and quarantines it without deleting foreign files', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  rmSync(a.slotDir, { recursive: true }); mkdirSync(a.slotDir); writeFileSync(join(a.slotDir, 'foreign.txt'), 'keep');
  const b = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool });
  expect(b.slotDir).toBe(join(pool, 'slots', 'slot-2'));
  expect(readFileSync(join(b.dir, 'moves.txt'), 'utf8')).toBe('two\n');
  expect(existsSync(join(pool, 'state', 'slot-1.bad'))).toBe(true);
  b.release();
  const c = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool });
  expect(c.slotDir).toBe(b.slotDir);
  expect(readFileSync(join(a.slotDir, 'foreign.txt'), 'utf8')).toBe('keep');
  c.release(); expect(readdirSync(join(pool, 'locks'))).toEqual([]);
});

it('recovers from a reset failure and prune removes the quarantined owned worktree', () => {
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  writeFileSync(join(pool, 'repo.git', 'worktrees', 'slot-1', 'index.lock'), 'interrupted git');
  const b = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool });
  expect(b.slotDir).toBe(join(pool, 'slots', 'slot-2'));
  expect(existsSync(join(pool, 'state', 'slot-1.bad'))).toBe(true);
  expect(pruneSeatPool({ poolDir: pool, keep: 0 })).toEqual([1]); // B still held
  expect(existsSync(join(pool, 'state', 'slot-1.bad'))).toBe(false);
  expect(readFileSync(join(b.dir, 'moves.txt'), 'utf8')).toBe('two\n');
  b.release();
});

it('caps all slots including quarantined paths and falls back when capacity is exhausted', () => {
  // Unverified paths must count toward the cap even though housekeeping cannot delete them.
  const runLsof = () => ({ status: 1, stdout: '' });
  for (let i = 1; i <= 16; i++) {
    const seat = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool, runLsof }); seat.release();
    rmSync(seat.slotDir, { recursive: true }); mkdirSync(seat.slotDir);
    writeFileSync(join(seat.slotDir, 'foreign.txt'), 'keep');
    // The next acquisition quarantines this slot and moves to the next number.
  }
  for (let i = 0; i < 3; i++) expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool, runLsof })).toThrow(/no review seat slot/);
  expect(readdirSync(join(pool, 'slots')).length).toBe(16);
  expect(readdirSync(join(pool, 'locks'))).toEqual([]);
  expect(pruneSeatPool({ poolDir: pool, keep: 0, runLsof })).toEqual([]);
  expect(readdirSync(join(pool, 'slots')).length).toBe(16);
});

for (const [mode, title] of Object.entries({
  'opt-out': 'pool opt-out returns a standalone checkout',
  private: 'explicit private checkout bypasses the pool',
  'red-team': 'private re-check requests a standalone checkout',
  'probe-failure': 'makeScratch falls back to a standalone checkout when lsof is unavailable',
})) {
  it(title, () => {
    const url = pathToFileURL(resolve('scripts/operations/review-extra-seats.mjs')).href;
    const code = `import { createExtraSeatsIo, createRedTeamIo } from ${JSON.stringify(url)};
      import { lstatSync, existsSync, renameSync } from 'node:fs';
      const check = d => {
        if (lstatSync(d).isSymbolicLink() || !lstatSync(d + '/.git').isDirectory()) throw new Error('not a standalone checkout');
        if (existsSync(process.env.WE_REVIEW_SEAT_POOL_DIR)) throw new Error('pool must not be acquired');
      };
      ${mode === 'red-team' ? `
      let called = false, dir;
      const io = createRedTeamIo({ spawnRecheck: async options => {
        called = true; dir = options.cwd; check(dir);
        return { value: { verdict: 'accept', findings: [] } };
      } });
      await io.runRecheck({ pr: 1, lanePath: ${JSON.stringify(lane)}, rev: ${JSON.stringify(rev1)}, mandate: 'test', input: 'test', shape: {} });
      if (!called || existsSync(dir)) throw new Error('recheck did not run or clean up');
      ` : `
      const io = createExtraSeatsIo();
      const d = io.makeScratch({ lanePath: ${JSON.stringify(lane)}, rev: ${JSON.stringify(rev1)}, private: ${mode === 'private'} });
      check(d); const moved = d + '-renamed'; renameSync(d, moved); io.removeScratch(d); check(moved); io.removeScratch(moved);
      if (existsSync(moved)) throw new Error('checkout should be cleaned');
      `}`;
    const scratchTmp = join(lane, '..', 'scratch-tmp'); mkdirSync(scratchTmp);
    // A missing host lsof must not make a bypass regression pass by falling back before the pool is created.
    const bin = join(scratchTmp, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\nexit ${mode === 'probe-failure' ? 2 : 1}\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WE_REVIEW_SEAT_POOL: mode === 'opt-out' ? '0' : '1', WE_REVIEW_SEAT_POOL_DIR: pool, TMPDIR: scratchTmp },
      encoding: 'utf8', timeout: 30000,
    });
    expect(r.status, r.stderr).toBe(0);
    if (mode === 'probe-failure') expect(r.stderr).toMatch(/review seat pool unavailable.*lsof unavailable/);
    expect(existsSync(pool)).toBe(false);
    expect(readdirSync(scratchTmp).filter(name => name.startsWith('we-review-seat-') || name.startsWith('we-red-team-recheck-'))).toEqual([]);
  });
}
