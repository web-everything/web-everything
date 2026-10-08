/**
 * @file scripts/lib/lane-repair.mjs
 * @description Lane-clone self-healing for `scripts/lane-pool.mjs` (card xj1vryw).
 *
 * LIVE INCIDENT (2026-10-08 ~04:10Z): two ci-heal sessions (#4368, #4370) could not acquire a lane.
 *   - lane-2: `git fetch origin --prune` died with `fatal: bad object refs/heads/pr-1686` — a leftover LOCAL
 *     branch (`pr-1686`, `pr1638`) pointing at an object that no longer exists in the shared `--reference`
 *     store. One dangling ref fails every fetch.
 *   - lane-3: `fatal: ... is in the commit graph file but not in the object database` — a stale commit-graph
 *     cache plus tags/tmp refs naming missing objects.
 *   Both left the claimed lane unprovisionable, so acquire fell through lane after lane.
 *
 * THE FIX, in three escalating steps (each logged with its reason):
 *   1. {@link healLaneRefs} — drop the commit-graph cache (rebuildable, never data) and delete every ref whose
 *      target object is MISSING (it points at nothing recoverable, so deleting loses no work).
 *   2. {@link diagnoseLane} — cheap health probe (HEAD resolves, index parses, recent history walks, no ref
 *      dangles). No full `git fsck` (minutes on a big repo).
 *   3. {@link quarantineLane} — move an unhealthy clone aside (NEVER delete) so the caller re-clones a fresh one.
 *
 * Pure git/fs, no dependency on lane-pool.mjs (which runs its CLI at import and cannot be unit-tested by import).
 * Callers only ever run this on a lane they hold the lease for (or one with no live lease).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const GIT_TIMEOUT_MS = 60_000;

function runGit(args, cwd, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** Does a git failure message look like repository corruption (as opposed to network/auth/lock trouble)? */
export function looksLikeCorruption(message) {
  return /bad object|missing (blob|tree|commit|object)|corrupt|commit[ -]graph|not in the object database|did not send all necessary objects|invalid sha1 pointer|unable to read|bad index|index file|object file .* is empty|broken ref|not a git repository/i.test(String(message || ''));
}

/** Refs whose target object is missing from the (possibly alternates-backed) object store. */
export function findBrokenRefs(dir) {
  const refs = runGit(['for-each-ref', '--format=%(objectname) %(refname)'], dir);
  const rows = refs.out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(' ');
    return { sha: l.slice(0, i), ref: l.slice(i + 1) };
  });
  if (!rows.length) return [];
  const check = runGit(['cat-file', '--batch-check'], dir, rows.map((r) => r.sha).join('\n') + '\n');
  const lines = check.out.split('\n');
  const broken = [];
  rows.forEach((r, i) => { if (/\bmissing\b/.test(lines[i] || '')) broken.push(r); });
  return broken;
}

/**
 * Repair that cannot lose work: remove commit-graph caches, delete refs that point at missing objects,
 * drop a leftover `refs/pull/*` fetch refspec.
 * @returns {{ actions: string[] }} human-readable reasons, one per action (already logged via `log`).
 */
export function healLaneRefs(dir, { log = () => {} } = {}) {
  const actions = [];
  const gitDir = join(dir, '.git');
  for (const rel of ['objects/info/commit-graph', 'objects/info/commit-graphs']) {
    const p = join(gitDir, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      actions.push(`removed stale ${rel} cache`);
    }
  }
  // The shared --reference store may carry its own commit-graph naming an absent object; this lane ignores it
  // (we never write into the primary checkout).
  if (runGit(['config', '--get', 'core.commitGraph'], dir).out.trim() !== 'false') {
    runGit(['config', 'core.commitGraph', 'false'], dir);
    actions.push('set core.commitGraph=false for this lane (a commit-graph can name an absent object)');
  }
  const head = runGit(['symbolic-ref', '-q', 'HEAD'], dir).out.trim();
  for (const { ref, sha } of findBrokenRefs(dir)) {
    if (ref === head) continue; // the checked-out branch is a diagnoseLane concern (quarantine), not a ref prune
    const r = runGit(['update-ref', '-d', ref], dir);
    actions.push(r.code === 0
      ? `deleted dangling ref ${ref} (target ${sha.slice(0, 8)} missing from the object store)`
      : `could not delete dangling ref ${ref}: ${r.err.trim().split('\n')[0]}`);
  }
  for (const spec of runGit(['config', '--get-all', 'remote.origin.fetch'], dir).out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (/refs\/pull\//.test(spec)) {
      runGit(['config', '--fixed-value', '--unset-all', 'remote.origin.fetch', spec], dir);
      actions.push(`removed leftover fetch refspec ${spec}`);
    }
  }
  for (const a of actions) log(`  ⚑ lane-repair ${basename(dir)}: ${a}`);
  return { actions };
}

/** Cheap health probe. `{ ok:false, problems }` means the clone itself is damaged (not just a bad ref). */
export function diagnoseLane(dir) {
  const problems = [];
  if (!existsSync(join(dir, '.git'))) return { ok: false, problems: ['no .git directory'] };
  const head = runGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], dir);
  if (head.code !== 0) problems.push(`HEAD does not resolve to a commit: ${(head.err || 'missing object').trim().split('\n')[0]}`);
  const idx = runGit(['ls-files', '--stage'], dir);
  if (idx.code !== 0) problems.push(`index unreadable: ${idx.err.trim().split('\n')[0]}`);
  if (head.code === 0) {
    if (runGit(['rev-parse', '--verify', '-q', 'HEAD^{tree}'], dir).code !== 0) problems.push('HEAD tree missing');
    const walk = runGit(['rev-list', '--max-count=200', 'HEAD'], dir);
    if (walk.code !== 0) problems.push(`history walk failed: ${walk.err.trim().split('\n')[0]}`);
  }
  const broken = findBrokenRefs(dir);
  if (broken.length) problems.push(`${broken.length} ref(s) point at missing objects: ${broken.slice(0, 3).map((b) => b.ref).join(', ')}`);
  return { ok: problems.length === 0, problems };
}

/**
 * Move a damaged lane clone aside. NEVER deletes it (its bytes may still hold salvageable work).
 * The caller re-clones into the vacated path. The lease marker is removed from the quarantined copy so the
 * moved directory can never be read as a held lane.
 * @returns {string} the quarantine path
 */
export function quarantineLane(dir, quarantineRoot, { log = () => {}, reason = '', now = Date.now() } = {}) {
  mkdirSync(quarantineRoot, { recursive: true });
  const dest = join(quarantineRoot, `${basename(dir)}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
  renameSync(dir, dest);
  rmSync(join(dest, '.git', '.lane-lease'), { force: true });
  log(`  ⚑ lane-repair ${basename(dir)}: QUARANTINED → ${dest}${reason ? ` (${reason})` : ''}`);
  return dest;
}

// ── Shared reference store: commit-graph self-heal (card xsxu243) ─────────────────────────────────────────
//
// LIVE INCIDENT (2026-10-08 ~05:08Z, ci-heal #4368 blocked again after #4382's per-lane repair): the PRIMARY
// checkout's `.git/objects/info/commit-graph` (dated Oct 3) named commits that a later gc had pruned from the
// object store. Every lane clones `--reference` the primary, so every lane git op that walks history reads that
// graph through `objects/info/alternates` and dies with
//   `fatal: You are attempting to fetch <sha>, which is in the commit graph file but not in the object database`
// or `failed to parse commit <sha> from object database for commit-graph`. A lane's own repair cannot reach it.
//
// WHY THIS IS SAFE: a commit-graph is a DERIVED CACHE (git rebuilds it from the objects and works without it).
// `git fsck` with the graph disabled was clean — the "missing" commits were unreachable garbage, so nothing
// reachable is lost. The heal therefore touches ONLY `objects/info/commit-graph` and `objects/info/commit-graphs/`
// of the store: no refs, no objects, no tracked files, no config. The bad file is moved ASIDE (kept, one copy),
// then `git commit-graph write --reachable` regenerates it (git writes a temp file and renames, so a concurrent
// reader sees either the old or the new graph, never a half-written one; a missing graph is also valid).

/** Does a git failure message name a commit-graph problem? (Narrower than {@link looksLikeCorruption}.) */
export function looksLikeCommitGraphError(message) {
  return /commit[ -]graph/i.test(String(message || ''));
}

/** Is the store's commit-graph unreadable / naming absent objects? Read-only. `null` = no graph / cannot tell. */
export function verifyCommitGraph(storeDir) {
  const r = runGit(['commit-graph', 'verify'], storeDir);
  return { ok: r.code === 0, detail: (r.err || r.out).trim().split('\n').filter(Boolean).slice(0, 2).join(' | ') };
}

/** Tiny mkdir lock with owner record + dead-owner/orphan reclaim, so two healers never run the move+write at once. */
function takeLock(lockDir, { now = Date.now(), orphanGraceMs = 10_000, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: now }));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const o = JSON.parse(readFileSync(join(lockDir, 'owner'), 'utf8'));
        stale = !isAlive(o.pid);
      } catch {
        try { stale = now - statSync(lockDir).mtimeMs > orphanGraceMs; } catch { stale = true; }
      }
      if (!stale) return false;
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return false;
}

/**
 * Regenerate a shared reference store's commit-graph when (and only when) it fails `commit-graph verify`.
 * Idempotent and re-checked UNDER the lock, so a second healer that lost the race sees a clean graph and does nothing.
 * @param {string} storeDir   the primary checkout (worktree root or bare dir) whose object store lanes share
 * @param {{lockDir:string, log?:Function, waitMs?:number, now?:number}} opts
 * @returns {{ healed:boolean, reason:string, movedTo?:string }}
 */
export function healSharedCommitGraph(storeDir, { lockDir, log = () => {}, waitMs = 30_000, now = Date.now() } = {}) {
  const before = verifyCommitGraph(storeDir);
  if (before.ok) return { healed: false, reason: 'commit-graph verifies clean' };
  const deadline = Date.now() + waitMs;
  let locked = takeLock(lockDir, { now: Date.now() });
  while (!locked && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); // sleep 250ms without a busy loop
    locked = takeLock(lockDir, { now: Date.now() });
  }
  if (!locked) return { healed: false, reason: 'another process holds the shared commit-graph lock' };
  try {
    const again = verifyCommitGraph(storeDir); // a concurrent healer may have just fixed it
    if (again.ok) return { healed: false, reason: 'healed by a concurrent process' };
    const gitDir = runGit(['rev-parse', '--git-common-dir'], storeDir).out.trim();
    const infoDir = join(resolveFrom(storeDir, gitDir), 'objects', 'info');
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    let movedTo;
    for (const name of ['commit-graph', 'commit-graphs']) {
      const p = join(infoDir, name);
      if (!existsSync(p)) continue;
      const dest = join(infoDir, `${name}.corrupt-${stamp}`);
      renameSync(p, dest); // moved aside, never deleted; ONLY the derived cache
      movedTo ??= dest;
    }
    const w = runGit(['commit-graph', 'write', '--reachable', '--no-progress'], storeDir);
    const after = verifyCommitGraph(storeDir);
    const wrote = existsSync(join(infoDir, 'commit-graph')) || existsSync(join(infoDir, 'commit-graphs'));
    const outcome = w.code === 0 && after.ok && wrote
      ? 'regenerated with `git commit-graph write --reachable`'
      : w.code === 0 && after.ok
        // git writes NOTHING (exit 0) for a shallow repository (the primary has .git/shallow); a missing graph is valid.
        ? 'git wrote no new graph (e.g. a shallow store); the store now runs without one, which is valid and verifies clean'
        : `regeneration failed (${w.err.trim().split('\n')[0] || after.detail}); store runs without a graph, which git treats as valid`;
    log(`  ⚑ lane-repair shared-store: commit-graph was corrupt (${before.detail}) — moved aside${movedTo ? ` → ${basename(movedTo)}` : ''} and ${outcome}`);
    return { healed: true, reason: before.detail, movedTo };
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

const resolveFrom = (base, p) => (p.startsWith('/') ? p : join(base, p));
