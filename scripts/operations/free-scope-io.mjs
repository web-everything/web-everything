/**
 * @file scripts/operations/free-scope-io.mjs
 * @description IMPURE snapshot and registry boundary for free-scope. GitHub, YAML, clock and filesystem
 * reads live here; atomic locked updates keep concurrent workers from overwriting one another's scopes.
 */
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
  const temp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(temp, `${JSON.stringify({ entries }, null, 2)}\n`); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const LOCK_STALE_MS = 30000;
/** The steal guard is held for microseconds, so one orphaned by a crashed stealer is reaped far sooner than a lock
 *  (and well inside withFileLock's 5s wait), instead of blocking every acquirer for the full 30s. */
const GUARD_STALE_MS = 1000;
const isStale = (stat, ms = LOCK_STALE_MS) => Date.now() - stat.mtimeMs > ms;
const sameDir = (a, b) => a.ino === b.ino && a.mtimeMs === b.mtimeMs;
/**
 * Remove `lock` if it is STILL the abandoned lock the caller observed (`seen`). A bare stat-then-rmdir lets two
 * waiters that both saw the stale lock each remove a directory: the second removes the fresh lock the first
 * just took, and both then hold the "exclusive" lock. So stealers take a short-lived `<lock>.steal` guard
 * (mkdir is atomic, one winner), then re-stat under it and require the same inode and mtime and a still-stale age
 * before removing. A loser backs off and re-reads the lock, which by then is the winner's fresh one.
 * A steal guard abandoned by a crashed stealer is itself reaped after GUARD_STALE_MS (the guard is only ever held
 * for a stat and an rmdir). Reaping a guard is a best-effort rmdir; a double crash plus a simultaneous reap is the
 * one residual window, far rarer than the crashed-holder case this lock exists for.
 */
export function stealStaleLock(lock, seen) {
  const guard = `${lock}.steal`;
  try { fs.mkdirSync(guard); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { if (isStale(fs.statSync(guard), GUARD_STALE_MS)) fs.rmdirSync(guard); } catch (race) { if (race.code !== 'ENOENT') throw race; }
    return false;
  }
  try {
    const now = fs.statSync(lock);
    if (!sameDir(now, seen) || !isStale(now)) return false;
    fs.rmdirSync(lock);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  finally { fs.rmSync(guard, { recursive: true, force: true }); }
}
/**
 * Run `fn` while holding the exclusive `<file>.lock` directory lock, so a read-modify-write of `file` by
 * concurrent processes is serialized. A lock older than 30s is treated as abandoned and stolen (see `stealStaleLock`).
 */
export function withFileLock(file, fn, { timeoutMs = 5000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let identity;
  for (;;) {
    try { fs.mkdirSync(lock); identity = fs.statSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { const seen = fs.statSync(lock); if (isStale(seen) && stealStaleLock(lock, seen)) continue; }
      catch (race) { if (race.code !== 'ENOENT') throw race; }
      if (Date.now() >= deadline) throw new Error(`free-scope: timed out acquiring ${lock}`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  try { return fn(); }
  finally {
    try { if (fs.statSync(lock).ino === identity.ino) fs.rmdirSync(lock); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export function updateRegistry(file, fn) {
  return withFileLock(file, () => { const entries = fn(readRegistry(file)); writeRegistry(file, entries); return entries; });
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
export function readCardScope(card, { root }) {
  const file = findCardFile(card, { root });
  if (!file) throw new Error(`free-scope: card ${card} not found`);
  const scope = matter(fs.readFileSync(file, 'utf8')).data.scope;
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
