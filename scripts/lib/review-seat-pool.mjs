// A pool of reusable, read-only review-seat checkouts (perf plan item 8, B5).
// One bare object store plus numbered `git worktree` slots. A seat claims one slot exclusively (a lock dir), the slot
// is forced to exactly the pinned commit's tree, and on release it stays warm: the next seat on the same commit
// rewrites nothing, and a seat on another commit rewrites only the files that differ. Idle slots are pruned.
// The user's primary checkout and the lane are never touched: objects arrive by `fetch` into the pool's own store.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, renameSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const SEAT_POOL_KEEP = 4;
export const SEAT_POOL_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
export const SEAT_LEASE_DEFAULT_MS = 6 * 60 * 60 * 1000;
const SLOT = /^slot-(\d+)$/;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

export const defaultPoolDir = (env = process.env) => env.WE_REVIEW_SEAT_POOL_DIR || join(tmpdir(), 'we-seat-pool');

// Pool git calls run with no hooks, no user/system config and no replace refs: a seat or a stale file in the shared
// store can then never cause code to run, or a pinned commit to mean something else, during slot setup.
/** The process environment without any GIT_* variable: no inherited repo, config or object redirection. */
export const cleanGitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const gitEnv = () => ({ ...cleanGitEnv(),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const STORE_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';

/** No symlink anywhere under `dir` (object storage: fanout dirs, packs, info). Bounded by the store's own size. */
function assertNoLinks(dir) {
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) throw new Error(`seat pool object storage contains a link: ${join(dir, name)}`);
    if (st.isFile() && st.nlink > 1) throw new Error(`seat pool object storage contains a hard link: ${join(dir, name)}`);
    if (st.isDirectory()) assertNoLinks(join(dir, name));
  }
}

/** Is any process's working directory inside `dir`? Unknown (lsof failed) counts as busy. */
export function slotBusy(dir, run = spawnSync) {
  let real;
  try { real = realpathSync(dir); } catch { return false; }
  const r = run('lsof', ['-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return true;
  return String(r.stdout).split('\n').some((l) => l.startsWith('n') && (l.slice(1) === real || l.slice(1).startsWith(`${real}/`)));
}

/** `repo.git/worktrees`, when present, must be a real owned directory holding no links, before git writes into it. */
function checkAdminRoot(p) {
  const root = join(p.repo, 'worktrees');
  if (!lstatOrNull(root)) return;
  ownPrivateDir(root);
  assertNoLinks(root);
}

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    env: gitEnv(),  // a replace ref in the shared store must never change what a pinned commit means
     encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim().slice(0, 300)}`);
  return r;
}
/** The pool lives at a predictable temp path: use a directory only if it is a real one, ours, and not group/world writable. */
function ownPrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o022) !== 0) {
    throw new Error(`seat pool path is not a private directory owned by this user: ${dir}`);
  }
}
const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const paths = (poolDir) => ({
  repo: join(poolDir, 'repo.git'), slots: join(poolDir, 'slots'), views: join(poolDir, 'views'), locks: join(poolDir, 'locks'), state: join(poolDir, 'state'),
});

/**
 * Claim `lockDir` for this process. A held lock is reclaimed only when its owner is dead AND it is older than
 * its own recorded lease (`expiresAt`, the seat's wall clock plus margin) has passed, since a seat can outlive its
 * parent; a lock with no lease is never reclaimed. Reclaiming is keyed to
 * the stale lock's own token: a marker `<lock>.reclaim-<staleToken>` is taken exclusively (mkdir), the lock is
 * re-read and must STILL carry that token, and the replacement lock exists before the marker is dropped. So of
 * several reclaimers of one stale lock exactly one wins, and none can remove a lock a later seat has taken. A
 * process killed inside that few-millisecond window leaks the one slot (it is skipped, never shared).
 */
function tryLock(lockDir, now, token = randomUUID(), leaseMs = SEAT_LEASE_DEFAULT_MS, busy = () => false) {
  const take = () => {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token, expiresAt: now() + leaseMs }));
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  };
  if (take()) return true;
  let owner = {};
  try { owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')); } catch { /* half-written lock */ }
  if (!owner.token || (owner.pid && pidAlive(owner.pid))) return false;
  if (!Number.isFinite(owner.expiresAt) || now() < owner.expiresAt) return false;
  if (busy()) return false; // a surviving seat still has its working directory in the slot
  const marker = `${lockDir}.reclaim-${owner.token}`;
  try { mkdirSync(marker); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try {
    let again = {};
    try { again = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')); } catch { return false; }
    if (again.token !== owner.token) return false; // someone else already replaced it
    rmSync(lockDir, { recursive: true, force: true });
    return take();
  } finally { rmSync(marker, { recursive: true, force: true }); }
}

function slotNumbers(p) {
  const names = new Set();
  for (const dir of [p.slots, p.locks]) if (existsSync(dir)) for (const n of readdirSync(dir)) if (SLOT.test(n)) names.add(Number(n.match(SLOT)[1]));
  return [...names].sort((a, b) => a - b);
}
const readRev = (p, n) => { try { return readFileSync(join(p.state, `slot-${n}.rev`), 'utf8').trim(); } catch { return null; } };

/** A slot is ours only if it is a real owned directory registered in THIS pool's store through a real, link-free admin dir. */
function validateSlot(p, dir) {
  ownPrivateDir(dir);
  const admin = join(p.repo, 'worktrees', basename(dir));
  checkAdminRoot(p); ownPrivateDir(admin); // every admin dir, logs/ and info/ included, must be link-free before git writes
  const dotGit = lstatOrNull(join(dir, '.git'));
  if (!dotGit?.isFile()) throw new Error(`seat slot is not a worktree of this pool: ${dir}`);
  const forward = readFileSync(join(dir, '.git'), 'utf8').trim().replace(/^gitdir: /, '');
  const reverse = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
  if (realpathSync(forward) !== realpathSync(admin) || realpathSync(reverse) !== realpathSync(join(dir, '.git'))
    || readFileSync(join(admin, 'commondir'), 'utf8').trim() !== '../..') throw new Error(`seat slot is not registered in this pool: ${dir}`);
  return admin;
}

/**
 * Claim a read-only checkout of exactly `rev`, fetched from `lanePath`.
 * `dir` is a path unique to THIS acquisition (a symlink to the slot), so a repeated cleanup of an old handle can never
 * name, release or delete a later seat's checkout; `slotDir` is the shared slot behind it.
 * @returns {{dir:string, slotDir:string, reused:boolean, release:()=>void}}
 */
export function acquireSeatSlot({ lanePath, rev, poolDir = defaultPoolDir(), now = Date.now, keep = SEAT_POOL_KEEP, leaseMs = SEAT_LEASE_DEFAULT_MS } = {}) {
  const p = paths(poolDir);
  for (const d of [poolDir, p.slots, p.locks, p.state, p.views]) ownPrivateDir(d);
  // Validate before Git ever touches it: a planted `repo.git` link must never reach `git init`.
  if (lstatOrNull(p.repo)) ownPrivateDir(p.repo);
  else git(['init', '--quiet', '--bare', p.repo]);
  ownPrivateDir(p.repo);
  if (!existsSync(join(p.repo, 'HEAD')) || lstatOrNull(join(p.repo, '.git'))) throw new Error('seat pool store is not a bare repository');
  const cfgTmp = join(p.repo, `config.${process.pid}.${randomUUID()}.tmp`); // rename, never write through a planted link
  writeFileSync(cfgTmp, STORE_CONFIG, { flag: 'wx' });
  renameSync(cfgTmp, join(p.repo, 'config')); // no leftover filter drivers, hooks path or worktree-config extension
  // Object storage must be this pool's own: no linked objects dir, no alternates borrowing a lane's objects.
  ownPrivateDir(join(p.repo, 'objects'));
  assertNoLinks(p.repo); // refs/, logs/, objects/, worktrees/, hooks/ ...: nothing Git writes can be redirected out of the store
  if (lstatOrNull(join(p.repo, 'objects', 'info', 'alternates'))) throw new Error('seat pool store borrows another repository\'s objects');
  // Git must resolve exactly this directory as the bare store, not follow a pointer inside it to another repository.
  if (realpathSync(git(['-C', p.repo, 'rev-parse', '--absolute-git-dir']).stdout.trim()) !== realpathSync(p.repo)
    || git(['-C', p.repo, 'rev-parse', '--is-bare-repository']).stdout.trim() !== 'true') throw new Error('seat pool store is not its own bare repository');
  if (git(['-C', p.repo, 'cat-file', '-e', `${rev}^{commit}`], { allowFail: true }).status !== 0) {
    git(['-C', p.repo, 'fetch', '--quiet', '--no-tags', '--depth=1', lanePath, `+${rev}:refs/seat/${rev}`]);
  }
  const known = slotNumbers(p);
  const order = [...known.filter((n) => readRev(p, n) === rev), ...known.filter((n) => readRev(p, n) !== rev), (known.at(-1) ?? 0) + 1];
  for (const n of order) {
    const lockDir = join(p.locks, `slot-${n}`);
    const token = randomUUID();
    if (!tryLock(lockDir, now, token, leaseMs, () => slotBusy(join(p.slots, `slot-${n}`)))) continue;
    const dir = join(p.slots, `slot-${n}`);
    // A lock being free does not prove nothing is reading the slot: a surviving descendant may still sit in it.
    if (lstatOrNull(dir) && slotBusy(dir)) { rmSync(lockDir, { recursive: true, force: true }); continue; }
    // Idempotent and token-checked: a repeated release can never free a lock that a later seat now holds.
    const view = join(p.views, token);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { if (JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token !== token) return; } catch { return; }
      rmSync(view, { force: true });
      rmSync(`${view}.input`, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    };
    try {
      const reused = existsSync(join(dir, '.git')) && readRev(p, n) === rev;
      rmSync(join(p.state, `slot-${n}.rev`), { force: true }); // unknown while the tree is being brought to `rev`
      if (lstatOrNull(dir)) {
        const admin = validateSlot(p, dir);
        // A previous seat may have left sparse-checkout state or per-worktree config: reset to the plain full tree.
        rmSync(join(admin, 'config.worktree'), { force: true });
        git(['-C', dir, 'sparse-checkout', 'disable'], { allowFail: true }); // restores the full tree and clears skip-worktree bits
        rmSync(join(admin, 'config.worktree'), { force: true });
        rmSync(join(admin, 'info'), { recursive: true, force: true });
        git(['-C', dir, '-c', 'core.sparseCheckout=false', 'reset', '--quiet', '--hard', rev]);
        git(['-C', dir, '-c', 'core.sparseCheckout=false', 'read-tree', '--reset', '-u', rev]); // also clears skip-worktree bits
        git(['-C', dir, 'clean', '--quiet', '-ffdx']); // drop anything a previous seat left, ignored files included
        const tags = git(['-C', dir, 'ls-files', '-v']).stdout.split('\n').filter((l) => l && !l.startsWith('H '));
        if (tags.length || git(['-C', dir, 'status', '--porcelain', '--untracked-files=all']).stdout.trim()) throw new Error(`seat slot is not exactly ${rev}`);
      } else {
        rmSync(dir, { recursive: true, force: true });
        checkAdminRoot(p); // before prune/add write anything under it
        git(['-C', p.repo, 'worktree', 'prune'], { allowFail: true });
        git(['-C', p.repo, 'worktree', 'add', '--quiet', '--detach', '--force', dir, rev]);
      }
      if (!existsSync(join(dir, '.git'))) throw new Error('seat slot has no worktree after setup');
      if (git(['-C', dir, 'rev-parse', 'HEAD']).stdout.trim() !== rev
        || realpathSync(git(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()) !== realpathSync(p.repo)) throw new Error(`seat slot is not ${rev} of this pool`);
      git(['-C', p.repo, 'update-ref', '-d', `refs/seat/${rev}`], { allowFail: true });
      writeFileSync(join(p.state, `slot-${n}.rev`), `${rev}\n`);
      symlinkSync(dir, view); // inputs for this acquisition live in `${view}.input`, outside every PR tree
      return { dir: view, slotDir: dir, reused, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  throw new Error('no review seat slot could be claimed');
}

/** Remove idle slots beyond `keep` (oldest first) and any idle longer than maxIdleMs. Best effort, never throws. */
export function pruneSeatPool({ poolDir = defaultPoolDir(), now = Date.now, keep = SEAT_POOL_KEEP, maxIdleMs = SEAT_POOL_MAX_IDLE_MS } = {}) {
  const p = paths(poolDir);
  const removed = [];
  try {
    if (!lstatOrNull(poolDir)) return removed;
    // Same trust as acquisition, before anything is deleted through these parents.
    for (const d of [poolDir, p.slots, p.locks, p.state, p.views, p.repo]) { if (lstatOrNull(d)) ownPrivateDir(d); }
    if (lstatOrNull(p.repo)) assertNoLinks(p.repo);
    const slots = slotNumbers(p).map((n) => {
      let mtime = 0;
      try { mtime = statSync(join(p.state, `slot-${n}.rev`)).mtimeMs; } catch { /* no state: oldest */ }
      return { n, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    slots.forEach(({ n, mtime }, i) => {
      if (i < keep && now() - mtime < maxIdleMs) return;
      const lockDir = join(p.locks, `slot-${n}`);
      if (!tryLock(lockDir, now, undefined, undefined, () => slotBusy(join(p.slots, `slot-${n}`)))) return;
      try {
        if (slotBusy(join(p.slots, `slot-${n}`))) return;
        const slotDir = join(p.slots, `slot-${n}`);
        if (lstatOrNull(slotDir)) {
          validateSlot(p, slotDir); // never delete a directory that is not provably this pool's worktree
          if (git(['-C', p.repo, 'worktree', 'remove', '--force', slotDir], { allowFail: true }).status !== 0) return; // keep it, retry later
        }
        rmSync(slotDir, { recursive: true, force: true });
        rmSync(join(p.state, `slot-${n}.rev`), { force: true });
        removed.push(n);
      } catch { /* an unverifiable slot is kept, not deleted */ } finally { rmSync(lockDir, { recursive: true, force: true }); }
    });
    for (const name of existsSync(p.views) ? readdirSync(p.views) : []) { // views whose slot is gone or whose seat died
      const v = join(p.views, name);
      if (name.endsWith('.input')) { if (!existsSync(v.slice(0, -6)) && !lstatOrNull(v.slice(0, -6))) rmSync(v, { recursive: true, force: true }); continue; }
      if (!existsSync(v)) rmSync(v, { force: true });
    }
    if (removed.length) { checkAdminRoot(p); git(['-C', p.repo, 'worktree', 'prune'], { allowFail: true }); }
  } catch { /* pruning is housekeeping */ }
  return removed;
}
