import { it, expect, afterEach, beforeEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, symlinkSync, utimesSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireSeatSlot, pruneSeatPool } from '../../lib/review-seat-pool.mjs';

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

it('keeps seat inputs outside the pinned tree and clears them on reuse; a live or fresh lock is never reclaimed', async () => {
  const { seatInputDir } = await import('../review-extra-seats.mjs');
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

it('a repeated release or cleanup never frees or deletes a slot another seat now holds', async () => {
  const { ownReviewScratch, removeReviewScratch } = await import('../../lib/review-scratch.mjs');
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

it('normalizes findings cited by the view path or by the physical slot path to repo-relative', async () => {
  const { repoRelativeFindings } = await import('../review-extra-seats.mjs');
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
  expect(() => acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool })).toThrow(/not a private directory/); // caller falls back to a full copy
  expect(readFileSync(join(lane, 'precious.txt'), 'utf8')).toBe('keep');
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(rev2);
  expect(readdirSync(join(pool, 'locks'))).toEqual([]);
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

it('rewrites a poisoned store config, and a slot with a live cwd inside it is never reclaimed', async () => {
  const { slotBusy } = await import('../../lib/review-seat-pool.mjs');
  const a = acquireSeatSlot({ lanePath: lane, rev: rev1, poolDir: pool }); a.release();
  const marker = join(lane, 'hook-ran');
  writeFileSync(join(pool, 'repo.git', 'config'), `[core]\n\tbare = true\n\thooksPath = ${join(lane, 'hooks')}\n[filter "x"]\n\tsmudge = touch ${marker}\n`);
  const b = acquireSeatSlot({ lanePath: lane, rev: rev2, poolDir: pool });
  expect(readFileSync(join(pool, 'repo.git', 'config'), 'utf8')).not.toMatch(/filter|hooksPath/);
  expect(existsSync(marker)).toBe(false);
  b.release();
  expect(slotBusy(b.slotDir, () => ({ status: 0, stdout: `p1\nn${realpathSync(b.slotDir)}/sub\n` }))).toBe(true);
  expect(slotBusy(b.slotDir, () => ({ status: 0, stdout: 'p1\nn/elsewhere\n' }))).toBe(false);
  expect(slotBusy(b.slotDir, () => ({ status: 2, stdout: '' }))).toBe(true); // unknown counts as busy
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
  const sitter = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { cwd: a.slotDir, stdio: 'ignore' });
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
