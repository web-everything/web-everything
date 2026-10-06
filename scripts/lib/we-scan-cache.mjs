#!/usr/bin/env node
/**
 * we-scan-cache.mjs — #70d: one shared, content-keyed build of the optional `we-scan` Rust binary for every
 * checkout on this host (the main checkout and every lane clone).
 *
 * WHY. rust-scan-bridge.mjs judges a binary stale by MTIME: a JS reference file newer than the binary means the
 * binary may no longer match it. A lane clone resets every file's mtime to clone time, so a lane's own
 * `scripts/rust-scan/target/release/we-scan` (built weeks ago, or never) is always "stale", and every lane fell
 * back to the slower JS scanners. Rebuilding per lane would cost a full cargo build per lane.
 *
 * WHAT. Binaries live in `~/.cache/we-scan/<key>/we-scan` (override: WE_SCAN_CACHE_DIR), where `<key>` hashes the
 * Rust SOURCE (Cargo.toml, Cargo.lock, src/**) by content. Freshness is by CONTENT, not mtime: `<key>/stamps.json`
 * lists reference-file blob sets this binary is trusted against. A stamp is added only when origin/main has the
 * SAME Rust source and the SAME reference-file blobs as the caller's tree — main is where the cross-language
 * parity tests (scripts/__tests__/rust-scan-*-parity.test.mjs) run before landing. A lane that edits a reference
 * file (or the Rust source) gets no match and falls back to JS, exactly as before. CI never uses this (`CI` set),
 * so the authoritative unscoped CI run is unchanged.
 *
 * BUILD. `node scripts/lib/we-scan-cache.mjs --build` builds origin/main's Rust source into the cache (refuses when
 * the working tree's Rust source differs from origin/main's). On a cache miss the bridge starts that build once in
 * the background (niced, lock-guarded, skipped without cargo; WE_SCAN_AUTOBUILD=0 turns it off), so the NEXT run
 * uses Rust. The current run uses JS.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const CRATE_REL = 'scripts/rust-scan';
const MAX_STAMPS = 50;
const LOCK_STALE_MS = 30 * 60 * 1000;

export function cacheRoot(env = process.env) {
  return env.WE_SCAN_CACHE_DIR || join(homedir(), '.cache', 'we-scan');
}

/** git's blob id for `buf` — the same id `git ls-tree` reports, so working-tree and origin/main compare directly. */
export function gitBlobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** [repo-relative path, blob id] for every Rust-source file in the working tree, sorted. */
export function rustSrcEntries(root) {
  const out = [];
  for (const f of ['Cargo.toml', 'Cargo.lock']) {
    const abs = join(root, CRATE_REL, f);
    if (existsSync(abs)) out.push([`${CRATE_REL}/${f}`, gitBlobSha(readFileSync(abs))]);
  }
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push([relative(root, p).split(sep).join('/'), gitBlobSha(readFileSync(p))]);
    }
  };
  walk(join(root, CRATE_REL, 'src'));
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function rustSrcKey(entries) {
  const h = createHash('sha256');
  for (const [p, s] of entries) h.update(`${p}\0${s}\n`);
  return h.digest('hex').slice(0, 32);
}

const defaultRunGit = (root) => (args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
});

/** origin/main's blob ids for the given paths (files, or directories walked recursively). Map path → blob id. */
export function mainBlobs(paths, runGit) {
  const out = new Map();
  const text = runGit(['ls-tree', '-r', 'origin/main', '--', ...paths]);
  for (const line of text.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** Rust-source entries as origin/main has them, sorted like `rustSrcEntries`. */
export function mainRustSrcEntries(runGit) {
  const blobs = mainBlobs([`${CRATE_REL}/Cargo.toml`, `${CRATE_REL}/Cargo.lock`, `${CRATE_REL}/src`], runGit);
  return [...blobs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const readStamps = (dir) => {
  try { const s = JSON.parse(readFileSync(join(dir, 'stamps.json'), 'utf8')); return Array.isArray(s) ? s : []; } catch { return []; }
};

const writeStamps = (dir, stamps) => {
  const tmp = join(dir, `stamps.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(stamps.slice(-MAX_STAMPS), null, 1));
  renameSync(tmp, join(dir, 'stamps.json'));
};

/**
 * The cached binary path this tree may trust for a call with these reference files, or null.
 * @param {{root?:string, referenceFiles?:string[], env?:object, runGit?:(args:string[])=>string, autoBuild?:(root:string)=>void}} opts
 */
export function resolveSharedWeScan({ root = REPO_ROOT, referenceFiles = [], env = process.env, runGit, autoBuild = startBackgroundBuild } = {}) {
  try {
    if (env.CI) return null;
    const git = runGit || defaultRunGit(root);
    const key = rustSrcKey(rustSrcEntries(root));
    const dir = join(cacheRoot(env), key);
    const bin = join(dir, 'we-scan');
    if (!existsSync(bin)) {
      if (env.WE_SCAN_AUTOBUILD !== '0') autoBuild(root, env);
      return null;
    }
    const current = {};
    for (const abs of referenceFiles) {
      const rel = relative(root, abs).split(sep).join('/');
      current[rel] = existsSync(abs) ? gitBlobSha(readFileSync(abs)) : null;
    }
    const rels = Object.keys(current);
    const stamps = readStamps(dir);
    if (stamps.some((st) => rels.every((r) => st?.refs?.[r] === current[r]))) return bin;
    // No stamp yet: trust it when this tree matches origin/main for the Rust source AND every reference file.
    if (rustSrcKey(mainRustSrcEntries(git)) !== key) return null;
    const main = rels.length ? mainBlobs(rels, git) : new Map();
    if (!rels.every((r) => (main.get(r) ?? null) === current[r])) return null;
    writeStamps(dir, [...stamps, { at: new Date().toISOString(), refs: current }]);
    return bin;
  } catch {
    return null; // never a reason for the gate to fail — the caller falls back to JS
  }
}

/** Start `--build` detached and niced, once per Rust-source key (the build itself takes the lock). */
export function startBackgroundBuild(root = REPO_ROOT, env = process.env) {
  try {
    if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) return;
    const key = rustSrcKey(rustSrcEntries(root));
    if (lockHeld(join(cacheRoot(env), key))) return;
    const child = spawn('nice', ['-n', '10', process.execPath, fileURLToPath(import.meta.url), '--build', `--root=${root}`],
      { detached: true, stdio: 'ignore', env });
    child.unref();
  } catch { /* best effort */ }
}

function lockHeld(dir) {
  try { return Date.now() - statSync(join(dir, '.lock')).mtimeMs < LOCK_STALE_MS; } catch { return false; }
}

/**
 * Build origin/main's Rust source into the cache. Returns { ok, bin?, reason? }. Refuses when the working tree's
 * Rust source differs from origin/main's: a cache entry must only ever hold a binary of main's source.
 */
export function buildSharedWeScan({ root = REPO_ROOT, env = process.env, runGit, runCargo } = {}) {
  const git = runGit || defaultRunGit(root);
  const entries = rustSrcEntries(root);
  const key = rustSrcKey(entries);
  if (rustSrcKey(mainRustSrcEntries(git)) !== key) return { ok: false, reason: 'working-tree Rust source differs from origin/main — not caching it' };
  const dir = join(cacheRoot(env), key);
  const bin = join(dir, 'we-scan');
  if (existsSync(bin)) return { ok: true, bin, reason: 'already built' };
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.lock');
  try { mkdirSync(lock); } catch {
    if (lockHeld(dir)) return { ok: false, reason: 'another build holds the lock' };
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  try {
    const cargo = runCargo || ((args) => execFileSync('cargo', args, { stdio: 'ignore' }));
    cargo(['build', '--release', '--manifest-path', join(root, CRATE_REL, 'Cargo.toml'), '--target-dir', join(dir, 'target')]);
    const built = join(dir, 'target', 'release', 'we-scan');
    const tmp = join(dir, `we-scan.${process.pid}.tmp`);
    copyFileSync(built, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, bin);
    rmSync(join(dir, 'target'), { recursive: true, force: true }); // one key = one build; keep only the binary
    return { ok: true, bin };
  } catch (e) {
    return { ok: false, reason: `cargo build failed: ${String(e?.message || e).split('\n')[0]}` };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArg = process.argv.find((a) => a.startsWith('--root='));
  const root = rootArg ? resolve(rootArg.slice('--root='.length)) : REPO_ROOT;
  if (process.argv.includes('--build')) {
    const r = buildSharedWeScan({ root });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    const key = rustSrcKey(rustSrcEntries(root));
    process.stdout.write(`${JSON.stringify({ key, dir: join(cacheRoot(), key), built: existsSync(join(cacheRoot(), key, 'we-scan')) })}\n`);
  }
}
