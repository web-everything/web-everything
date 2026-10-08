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
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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
