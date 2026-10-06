/**
 * @file scripts/operations/free-scope-io.mjs
 * @description IMPURE snapshot and registry boundary for free-scope. GitHub, YAML, clock and filesystem
 * reads live here; atomic locked updates keep concurrent workers from overwriting one another's scopes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { DEFAULT_REPOS, qualifyFile } from './free-scope.mjs';
const matter = createRequire(import.meta.url)('gray-matter');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function defaultRegistryPath(env = process.env) {
  return env.WE_AGENT_SCOPES_PATH || path.join(os.homedir(), 'workspace/.operations/coordination/agent-scopes.json');
}
export function readRegistry(file) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    const parsed = JSON.parse(source);
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(entries)) throw new Error('expected an array or { entries: [] }');
    return entries;
  } catch (error) { throw new Error(`free-scope: cannot read registry ${file}: ${error.message}`); }
}
export function writeRegistry(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(temp, `${JSON.stringify({ entries }, null, 2)}\n`); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const LOCK_STALE_MS = 30000;
/** The steal guard is held for microseconds, so one orphaned by a crashed stealer is reaped far sooner than a lock
 *  (and well inside withFileLock's 5s wait), instead of blocking every acquirer for the full 30s. */
const GUARD_STALE_MS = 1000;
const isStale = (stat, ms = LOCK_STALE_MS) => Date.now() - stat.mtimeMs > ms;
/** The owner token a holder writes inside its lock directory: a random nonce plus pid and host for diagnosis. Who
 *  holds a lock is decided by this token alone, never by the directory's inode: Linux reuses a freed inode number, so
 *  a steal followed by an immediate retake can leave the very same inode behind. */
const OWNER_FILE = 'owner';
const newOwnerToken = () => JSON.stringify({ nonce: crypto.randomBytes(16).toString('hex'), pid: process.pid, host: os.hostname() });
function readOwner(lock) {
  try { return fs.readFileSync(path.join(lock, OWNER_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}
/** What a waiter saw of a lock: its age plus who owns it. An ownerless lock (a holder between its mkdir and its token
 *  write, or one left by an older build) is still a held lock; it falls back to inode+mtime so it is never taken for fresh. */
function observeLock(lock) {
  const { ino, mtimeMs } = fs.statSync(lock);
  return { ino, mtimeMs, owner: readOwner(lock) };
}
const sameLock = (a, b) => a.owner === b.owner && a.mtimeMs === b.mtimeMs && (a.owner !== null || a.ino === b.ino);
/**
 * Remove the lock (or steal guard) directory at `dir` only if its owner token is still `expectedOwner`. The removal is
 * a rename to a unique tombstone, which is atomic: the lock path is either still held or gone, never left half-removed
 * (a kill between unlinking `owner` and `rmdir` would leave an ownerless lock that looks fresh for a whole stale window).
 * The token is then re-read INSIDE the tombstone, so a lock that changed hands between the caller's check and the
 * rename is put back instead of being destroyed. Returns whether the expected lock was removed.
 */
function takeDown(dir, expectedOwner) {
  const tomb = `${dir}.gone-${crypto.randomBytes(6).toString('hex')}`;
  try { fs.renameSync(dir, tomb); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (readOwner(tomb) === expectedOwner) { fs.rmSync(tomb, { recursive: true, force: true }); return true; }
  try { fs.renameSync(tomb, dir); } catch { fs.rmSync(tomb, { recursive: true, force: true }); }
  return false;
}
/**
 * Remove `lock` if it is STILL the abandoned lock the caller observed (`seen`). A bare stat-then-rmdir lets two
 * waiters that both saw the stale lock each remove a directory: the second removes the fresh lock the first
 * just took, and both then hold the "exclusive" lock. So stealers take a short-lived `<lock>.steal` guard
 * (mkdir is atomic, one winner), then re-observe under it and require the same owner token and mtime and a still-stale
 * age before removing. A loser backs off and re-reads the lock, which by then is the winner's fresh one.
 * The guard carries its own owner token too: a stealer stalled past GUARD_STALE_MS has its guard reaped and retaken by
 * another stealer, and when it wakes it neither removes the lock (the rename re-checks the lock's token inside the
 * tombstone) nor the new stealer's guard (it only removes a guard that still holds its own token).
 * A steal guard abandoned by a crashed stealer is itself reaped after GUARD_STALE_MS (the guard is only ever held
 * for a stat and a rename).
 */
export function stealStaleLock(lock, seen, staleMs = LOCK_STALE_MS) {
  const guard = `${lock}.steal`, guardToken = newOwnerToken();
  try {
    fs.mkdirSync(guard);
    try { fs.writeFileSync(path.join(guard, OWNER_FILE), guardToken, { flag: 'wx' }); }
    catch (error) { fs.rmSync(guard, { recursive: true, force: true }); throw error; }
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code !== 'EEXIST') throw error;
    try { const g = observeLock(guard); if (isStale(g, GUARD_STALE_MS)) takeDown(guard, g.owner); } catch (race) { if (race.code !== 'ENOENT') throw race; }
    return false;
  }
  try {
    const now = observeLock(lock);
    if (!sameLock(now, seen) || !isStale(now, staleMs)) return false;
    return takeDown(lock, seen.owner);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  finally { takeDown(guard, guardToken); }
}
/**
 * Run `fn` while holding the exclusive `<file>.lock` directory lock, so a read-modify-write of `file` by
 * concurrent processes is serialized. A lock older than `staleMs` (default 30s) is treated as abandoned and stolen
 * (see `stealStaleLock`). A holder that runs longer than that (a multi-minute filing run) passes a larger `staleMs`
 * and calls the `touch()` it is handed between steps: touching changes the lock's mtime, so it counts as alive and a
 * waiter that saw the older mtime cannot steal it. A wait that times out throws with `code: 'ELOCKTIMEOUT'`.
 */
export function withFileLock(file, fn, { timeoutMs = 5000, staleMs = LOCK_STALE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const token = newOwnerToken();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try { fs.writeFileSync(path.join(lock, OWNER_FILE), token, { flag: 'wx' }); }
      catch (error) {
        // ENOENT: a very long stall between mkdir and this write let a waiter steal the still-ownerless lock. Retry.
        if (error.code === 'ENOENT') continue;
        fs.rmSync(lock, { recursive: true, force: true }); throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { const seen = observeLock(lock); if (isStale(seen, staleMs) && stealStaleLock(lock, seen, staleMs)) continue; }
      catch (race) { if (race.code !== 'ENOENT') throw race; }
      if (Date.now() >= deadline) throw Object.assign(new Error(`free-scope: timed out acquiring ${lock}`), { code: 'ELOCKTIMEOUT' });
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  // Refresh only OUR lock: if it was stolen (and maybe re-taken by someone else) refreshing would keep their lock
  // alive for us, so report the loss instead of touching.
  const touch = () => {
    try {
      if (readOwner(lock) !== token) throw Object.assign(new Error(`free-scope: lost ${lock}`), { code: 'ELOCKLOST' });
      const t = new Date(); fs.utimesSync(lock, t, t);
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error(`free-scope: lost ${lock}`), { code: 'ELOCKLOST' });
      throw error;
    }
  };
  let result, failure, failed = false;
  try { result = fn({ touch }); } catch (error) { failed = true; failure = error; }
  // A holder that lost its lock must learn it on the way out, not return success over a commit that may have raced.
  // (An error from `fn` itself stays the error reported.)
  const released = readOwner(lock) === token && takeDown(lock, token);
  if (failed) throw failure;
  if (!released) throw Object.assign(new Error(`free-scope: lost ${lock}`), { code: 'ELOCKLOST' });
  return result;
}
export function updateRegistry(file, fn) {
  return withFileLock(file, ({ touch }) => {
    const entries = fn(readRegistry(file));
    touch(); // still ours? Then commit.
    writeRegistry(file, entries);
    return entries;
  });
}
export function ghExec(env = process.env) {
  return (args) => env.WE_FREE_SCOPE_GH_BIN
    ? execFileSync(env.WE_FREE_SCOPE_GH_BIN, args, { encoding: 'utf8' })
    : runGhSync(args, { encoding: 'utf8' });
}
/** `gh pr list --limit` page size. A page this full may have been cut off, so it is never trusted as complete. */
export const OPEN_PR_LIMIT = 200;
/** `gh pr list --json files` lists at most this many files per PR; a PR at the cap may touch more than it shows. */
export const PR_FILES_LIMIT = 100;
export function readOpenPrs({ repos = DEFAULT_REPOS, exec }) {
  const prs = [], unreadable = [];
  for (const repo of repos) {
    try {
      const rows = JSON.parse(exec(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,url,files']));
      prs.push(...rows.map(({ number, title, url, files }) => ({ repo, number, title, url, files: files.map((f) => f.path) })));
      // The rows read still count as holders, but the snapshot is incomplete: never let it answer "free".
      const why = [];
      if (rows.length >= OPEN_PR_LIMIT) why.push(`open PR list hit the ${OPEN_PR_LIMIT}-row limit and may be truncated`);
      const capped = rows.filter(({ files }) => files.length >= PR_FILES_LIMIT).map(({ number }) => `#${number}`);
      if (capped.length) why.push(`PR ${capped.join(', ')} list${capped.length === 1 ? 's' : ''} ${PR_FILES_LIMIT} files (the gh cap) and may touch more`);
      if (why.length) unreadable.push({ repo, error: why.join('; ') });
    } catch (error) { unreadable.push({ repo, error: error.message.split(/\r?\n/)[0] }); }
  }
  return { prs, unreadable };
}
export function findCardFile(card, { root }) {
  const id = String(card).replace(/^#/, '');
  if (!id || /[/\\]/.test(id)) return null;
  let names;
  try { names = fs.readdirSync(path.resolve(root, 'backlog')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const name = names.sort().find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
  return name ? path.resolve(root, 'backlog', name) : null;
}
/** gray-matter's executable engines, each replaced by one that refuses (same guard as probation-build-run.mjs, #4291). */
const REFUSE_ENGINE = () => { throw new Error('executable frontmatter refused'); };
const NO_EXEC_ENGINES = Object.freeze({ js: REFUSE_ENGINE, javascript: REFUSE_ENGINE, coffee: REFUSE_ENGINE, coffeescript: REFUSE_ENGINE, cson: REFUSE_ENGINE });
export function readCardScope(card, { root }) {
  const file = findCardFile(card, { root });
  if (!file) throw new Error(`free-scope: card ${card} not found`);
  const text = fs.readFileSync(file, 'utf8');
  // gray-matter's default engines `eval` a `---js` block, and a card may come from an unreviewed PR checkout.
  if (!/^---\r?\n/.test(text)) throw new Error(`free-scope: card ${card} front matter is not a plain YAML block`);
  const scope = matter(text, { language: 'yaml', engines: NO_EXEC_ENGINES }).data.scope;
  const entries = scope == null ? [] : Array.isArray(scope) ? scope : [scope];
  if (!entries.length || entries.some((e) => typeof e !== 'string' || !e.trim())) throw new Error(`free-scope: card ${card} has no scope of strings`);
  return entries;
}
export function collectFreeScope({ files = '', card = '', root = repoRoot, repos = DEFAULT_REPOS,
  env = process.env, now = Date.now, exec = ghExec(env), registryPath = defaultRegistryPath(env) } = {}) {
  const scope = [...new Set([...files.split(','), ...(card ? readCardScope(card, { root }) : [])].map((f) => qualifyFile(f)).filter(Boolean))];
  if (!scope.length) throw new TypeError('free-scope: give --files=a,b or --card=<id>');
  return { files: scope, nowMs: now(), ...readOpenPrs({ repos, exec }), agents: readRegistry(registryPath) };
}
