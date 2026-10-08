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
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, statSync, lstatSync, copyFileSync, cpSync, realpathSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { inspectCloneLock, defaultOwner } from './daemon-clone-lock.mjs';

const GIT_TIMEOUT_MS = 60_000;

function runGit(args, cwd, input) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, timeout: GIT_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || ''), failed: Boolean(r.error) };
}

/** Does a git failure message look like repository corruption (as opposed to network/auth/lock trouble)? */
export function looksLikeCorruption(message) {
  return /bad object|missing (blob|tree|commit|object)|corrupt|commit[ -]graph|not in the object database|did not send all necessary objects|invalid sha1 pointer|unable to read|bad index|index file|object file .* is empty|broken ref|not a git repository/i.test(String(message || ''));
}

/** Refs whose target object is missing from the (possibly alternates-backed) object store. */
export function findBrokenRefs(dir) {
  return probeBrokenRefs(dir).broken;
}

/** Like {@link findBrokenRefs} but says when the probe itself FAILED (`probeFailed`), so a caller that is about to
 *  call a clone healthy can tell "no broken refs" from "could not look". */
export function probeBrokenRefs(dir) {
  const refs = runGit(['for-each-ref', '--format=%(objectname) %(refname)'], dir);
  if (refs.code !== 0) return { broken: [], probeFailed: true };
  const rows = refs.out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(' ');
    return { sha: l.slice(0, i), ref: l.slice(i + 1) };
  });
  if (!rows.length) return { broken: [], probeFailed: false };
  const check = runGit(['cat-file', '--batch-check'], dir, rows.map((r) => r.sha).join('\n') + '\n');
  if (check.code !== 0 && check.out.split('\n').filter(Boolean).length < rows.length) return { broken: [], probeFailed: true };
  const lines = check.out.split('\n');
  const broken = [];
  rows.forEach((r, i) => { if (/\bmissing\b/.test(lines[i] || '')) broken.push(r); });
  return { broken, probeFailed: false };
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
    const r = runGit(['update-ref', '--no-deref', '-d', ref], dir); // a symref is removed itself, never its target
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

// ── Daemon clones: repair before any fetch (card xdaemoncl) ───────────────────────────────────────────────
//
// LIVE INCIDENT (2026-10-08 overnight): the WE drain's data clone (`.lanes/we-drain-daemon/lane-1`, and by the
// same mechanism every other daemon clone: `wev-*`, `we-drain-daemon/code`) carried `refs/remotes/origin/lane/*`
// refs whose target objects are gone from the shared `--reference` store (`git fsck`: "invalid sha1 pointer").
// A drain overlay fetch was rejected because of it. #4382 healed this for POOL lanes on acquire/refresh, but
// daemon clones are never acquired through lane-pool, so nothing ever healed them.
//
// THE POLICY (stricter than {@link healLaneRefs}, because a daemon clone is long-lived and owns real local state):
//   1. PRUNE only `refs/remotes/*` refs whose object is missing. A remote-tracking ref is a cache of what origin
//      said; the next fetch re-creates it, so deleting it can never lose work.
//   2. NEVER delete any other ref (local branch, tag, stash). A broken one is REPORTED loudly, not touched.
//   3. VERIFY with the cheap {@link diagnoseLane} probe (HEAD/index/history). Dangling non-remote refs alone are
//      reported, not a reason to re-clone.
//   4. Only if the clone ITSELF is still broken: QUARANTINE (move aside, never delete) and re-clone, and only when
//      the caller holds the daemon-clone write lock, the working tree is clean, and no local commit/stash exists that
//      a remote-tracking ref does not contain. The fresh clone is verified (else the old one is restored), inherits the
//      old clone's config/hooks/ignored files, and a failed attempt is not repeated for an hour. Otherwise report
//      `needs-attention`.

/** Does a freshly made clone still fail the cheap health probe? (Dangling refs are the caller's prune job, not damage.) */
function cloneProblems(dir) {
  return diagnoseLane(dir).problems.filter((p) => !/ref\(s\) point at missing objects/.test(p));
}

/** Top-level IGNORED paths of `dir` (node_modules, build output): derived state a bare `git clone` would not bring
 *  back. Best-effort: an unreadable index yields none, and they then stay in quarantine with everything else. */
function ignoredTopLevelPaths(dir) {
  const r = runGit(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], dir);
  if (r.code !== 0) return [];
  return r.out.split('\0').map((p) => p.replace(/\/$/, '')).filter((p) => p && p !== '.git' && !p.startsWith('.git/') && !p.split('/').includes('..'));
}

/** Does any existing ancestor of `rel` inside `root` (or `rel` itself) sit behind a symlink? The fresh clone is at the
 *  origin tip, so a tracked symlink can stand where the old tree had a real directory; moving through it would write
 *  outside the clone. */
function throughSymlink(root, rel) {
  let p = root;
  for (const part of rel.split('/')) {
    p = join(p, part);
    try { if (lstatSync(p).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

/** Carry the old clone's local state into the replacement: `.git/config` (identity, extra remotes, core.* flags),
 *  hooks, `info/exclude`, and ignored files. Each step is best-effort and logged; none can fail the re-clone, and
 *  everything is still in quarantine (ignored paths are moved, the rest copied). */
function carryOverLocalState(oldDir, newDir, ignored, log) {
  const note = (what, e) => log(`  ⚠ clone-repair ${basename(newDir)}: could not carry over ${what} (${String(e && e.message || e).split('\n')[0]}); it is still in quarantine`);
  try { // temp file + rename: a crash mid-copy never leaves a truncated config in the live clone
    const tmp = join(newDir, '.git', `config.carry-${process.pid}`);
    copyFileSync(join(oldDir, '.git', 'config'), tmp);
    renameSync(tmp, join(newDir, '.git', 'config'));
  } catch (e) { note('.git/config', e); }
  for (const rel of ['hooks', 'info/exclude']) {
    try { if (existsSync(join(oldDir, '.git', rel))) cpSync(join(oldDir, '.git', rel), join(newDir, '.git', rel), { recursive: true, force: true }); } catch (e) { note(`.git/${rel}`, e); }
  }
  for (const rel of ignored) {
    try {
      if (!existsSync(join(oldDir, rel)) || existsSync(join(newDir, rel)) || throughSymlink(newDir, rel)) continue;
      mkdirSync(dirname(join(newDir, rel)), { recursive: true });
      renameSync(join(oldDir, rel), join(newDir, rel));
    } catch (e) { note(rel, e); }
  }
}

/** Resolve a LOCAL relative path (a remote URL git reads against the checkout) to an absolute one against `base`.
 *  Everything else is returned unchanged: absolute paths, `~`, `scheme://`, scp-style `host:path` and `ext::`. A leading
 *  `./` or `../` is always a path (git's own rule), even when a later segment contains a colon. */
export function resolveLocalPath(url, base) {
  // git runs with the PHYSICAL cwd, so `..` after a symlinked component climbs the real tree: resolve from the real path.
  const from = (() => { try { return realpathSync(base); } catch { return base; } })();
  if (url.startsWith('./') || url.startsWith('../') || url === '.' || url === '..') return resolve(from, url);
  if (url.startsWith('/') || /^[^/]*:/.test(url)) return url;
  return resolve(from, url); // includes `~...`: git does not expand it for a local path, it is a directory literally named `~`
}

/** Re-provision a broken daemon clone in place: move it to `quarantineRoot`, clone fresh from the same origin
 *  (reusing the old shared-reference alternate), check the same branch out, VERIFY the fresh clone is healthy, then
 *  carry over the old clone's local config/hooks/ignored files. Restores the old clone if the clone fails or is
 *  itself still broken. `verify` is injectable for tests. */
export function recloneInPlace(dir, quarantineRoot, { log = () => {}, reason = '', verify = (d) => ({ problems: cloneProblems(d) }) } = {}) {
  const rawUrl = runGit(['config', '--get', 'remote.origin.url'], dir).out.trim();
  if (!rawUrl) return { ok: false, error: 'no remote.origin.url to re-clone from' };
  if (rawUrl.startsWith('-')) return { ok: false, error: `remote.origin.url starts with "-" (${rawUrl.slice(0, 40)}); refusing to hand it to git clone` };
  // The clone runs from dirname(dir) after `dir` has moved, but git resolves a relative origin against the checkout itself:
  // resolve it here, before anything moves, so a repo that happens to sit at the wrong path is never cloned instead.
  const url = resolveLocalPath(rawUrl, dir);
  const branch = runGit(['symbolic-ref', '--short', '-q', 'HEAD'], dir).out.trim() || 'main';
  let reference = null;
  try {
    // A relative alternates entry is relative to the object store (.git/objects), not to the clone's parent either.
    const first = readFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8').split('\n').map((l) => l.trim()).find(Boolean);
    if (first) reference = resolve(join(dir, '.git', 'objects'), first).replace(/\/objects\/?$/, '');
  } catch { /* no alternates */ }
  const ignored = ignoredTopLevelPaths(dir); // before the move: the old index is still in place
  let moved;
  try { moved = quarantineLane(dir, quarantineRoot, { log, reason }); }
  catch (e) { return { ok: false, error: `could not quarantine the clone (${String(e && e.message || e).split('\n')[0]}); left in place` }; }
  // `--` ends option parsing: a URL is never read as a flag. `--reference=<p>` / `--branch=<b>` bind their values.
  const args = ['clone', '--quiet', ...(reference ? [`--reference=${reference}`] : []), `--branch=${branch}`, '--', url, dir];
  const c = runGit(args, dirname(dir));
  let failure = c.code !== 0 ? `re-clone failed (${c.err.trim().split('\n')[0]})` : '';
  if (!failure) {
    const after = verify(dir);
    if (after.problems.length) failure = `the fresh clone is still broken (${after.problems.slice(0, 2).join('; ')}), so a re-clone cannot fix this`;
  }
  if (failure) {
    try {
      rmSync(dir, { recursive: true, force: true }); // only the half-made / still-broken new clone
      renameSync(moved, dir); // put the old one back: nothing is lost
    } catch (e) {
      return { ok: false, error: `${failure} and the old clone could not be restored (${String(e && e.message || e).split('\n')[0]}); it is at ${moved}` };
    }
    return { ok: false, error: `${failure}; old clone restored` };
  }
  // The old config is carried over AFTER the fresh clone verified healthy, so re-verify: an old setting that breaks git
  // (extensions.*, core.worktree, include.path, ...) must not turn a good re-clone into a bad one. Fall back to the fresh config.
  const freshConfig = (() => { try { return readFileSync(join(dir, '.git', 'config')); } catch { return null; } })();
  carryOverLocalState(moved, dir, ignored, log);
  if (freshConfig && verify(dir).problems.length) {
    try {
      const tmp = join(dir, '.git', `config.restore-${process.pid}`);
      writeFileSync(tmp, freshConfig); renameSync(tmp, join(dir, '.git', 'config'));
      log(`  ⚠ clone-repair ${basename(dir)}: the old .git/config broke the fresh clone; kept the fresh config (the old one is in quarantine)`);
    } catch (e) { return { ok: false, error: `the carried-over config broke the fresh clone and could not be undone (${String(e && e.message || e).split('\n')[0]}); the old clone is at ${moved}` }; }
  }
  return { ok: true, quarantinedTo: moved };
}

/** Is `dir` a standalone clone (its `.git` is a directory)? A linked worktree has a `.git` FILE and shares its
 *  common dir with other checkouts, so it is never re-cloned, nor has its shared commit-graph rewritten, from here. */
function isStandaloneClone(dir) {
  try { return statSync(join(dir, '.git')).isDirectory() && !existsSync(join(dir, '.git', 'worktrees')); } catch { return false; }
}

/**
 * Is it SAFE to move this clone aside? Fails CLOSED: only affirmative evidence of a clean tree returns `safe:true`.
 * A failed probe (corrupt index, unreadable tree) is never read as clean. Checks unstaged/untracked edits straight
 * from the index (no HEAD needed) AND staged edits against HEAD when HEAD resolves. When HEAD itself is gone no
 * baseline exists to compare the index to, so staged-only edits cannot be seen; that residual is reported
 * (`unprovenIndex`) and the quarantine keeps every byte, so nothing is lost.
 * @returns {{safe:boolean, why?:string, unprovenIndex?:boolean}}
 */
function provenCleanTree(dir) {
  const edits = runGit(['ls-files', '--modified', '--deleted', '--others', '--exclude-standard'], dir);
  if (edits.code !== 0) return { safe: false, why: `could not read the working tree state (${edits.err.trim().split('\n')[0] || `exit ${edits.code}`})` };
  if (edits.out.trim() !== '') return { safe: false, why: 'its working tree has local edits' };
  // Only a clean "HEAD does not resolve" (git exited, did not time out or fail to spawn) means HEAD is gone.
  const headCommit = runGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], dir);
  if (headCommit.failed) return { safe: false, why: 'could not probe HEAD' };
  let result;
  if (headCommit.code !== 0) result = { safe: true, unprovenIndex: true };
  else {
    if (runGit(['rev-parse', '--verify', '-q', 'HEAD^{tree}'], dir).code !== 0) return { safe: false, why: 'HEAD resolves but its tree is unreadable' };
    const staged = runGit(['diff', '--cached', '--quiet', 'HEAD', '--'], dir);
    if (staged.code !== 0) return { safe: false, why: staged.code === 1 ? 'its index has staged edits' : `could not compare the index to HEAD (${staged.err.trim().split('\n')[0] || `exit ${staged.code}`})` };
    result = { safe: true };
  }
  const unpushed = unpushedWork(dir, headCommit.code === 0 ? headCommit.out.trim() : '');
  return unpushed.safe ? result : unpushed;
}

/**
 * Does the clone hold work that exists NOWHERE else? A re-clone checks out the remote branch, so a local commit that no
 * remote-tracking ref contains would drop out of the active checkout. Fails CLOSED: a stash, any local ref (branch, tag,
 * notes, ...) or a detached HEAD with a commit no `refs/remotes/*` ref reaches, or any git failure while proving it, is "not safe".
 * A ref whose commit object is already gone has nothing left to lose and is skipped. When older history is damaged,
 * only a ref that equals (or is cleanly reachable from) a remote-tracking ref can be proven pushed.
 * @returns {{safe:boolean, why?:string}}
 */
const DAEMON_REBUILD_EMAIL = 'daemon-rebuild@localhost'; // GIT_AUTHOR_EMAIL in daemon-rebuild/shared.mjs
function unpushedWork(dir, headSha) {
  const stash = runGit(['rev-parse', '--verify', '-q', 'refs/stash'], dir);
  if (stash.failed) return { safe: false, why: 'could not probe for a stash' };
  if (stash.code === 0) return { safe: false, why: 'it holds a stash (local work not on any remote)' };
  // EVERY local ref except the remote-tracking baseline (and the stash, probed above): branches, tags (lightweight or
  // annotated; `^{commit}` below peels them), notes, custom namespaces. Any one of them can be the only thing keeping an
  // unpushed commit alive once the branch that made it is gone.
  const heads = runGit(['for-each-ref', '--format=%(objectname) %(refname)'], dir);
  if (heads.code !== 0) return { safe: false, why: `could not list local refs (${heads.err.trim().split('\n')[0] || `exit ${heads.code}`})` };
  const tips = new Map(); // sha -> label
  for (const line of heads.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(' ');
    const ref = line.slice(i + 1);
    // refs/notes/* are conveyor metadata force-fetched from / pushed to origin (branch-drift) outside refs/remotes, so they
    // can never read as "pushed" here; counting them would refuse every re-clone of a clone that carries one.
    if (ref.startsWith('refs/remotes/') || ref.startsWith('refs/notes/') || ref === 'refs/stash') continue;
    tips.set(line.slice(0, i), ref);
  }
  if (headSha && !tips.has(headSha)) tips.set(headSha, 'HEAD');
  for (const [sha, label] of tips) {
    const here = runGit(['cat-file', '-e', `${sha}^{commit}`], dir);
    if (here.failed) return { safe: false, why: `could not probe ${label}` };
    if (here.code !== 0) continue; // its commit is already gone: nothing recoverable to protect
    const ahead = runGit(['log', '--format=%ae', sha, '--not', '--remotes'], dir);
    if (ahead.code !== 0) return { safe: false, why: `could not prove ${label} is pushed (${ahead.err.trim().split('\n')[0] || `exit ${ahead.code}`})` };
    // The rebuild mints its overlay merge commits locally (fixed identity, deterministic from origin + the overlay
    // list), so they are reproducible rather than someone's unpushed work; any other author's commit is.
    if (ahead.out.split('\n').some((e) => e.trim() && e.trim() !== DAEMON_REBUILD_EMAIL)) return { safe: false, why: `${label} has local commits no remote-tracking ref contains` };
  }
  return { safe: true };
}

/** Does THIS process hold the daemon-clone WRITE lock on `dir`? Moving a clone's root out from under a sibling reader
 *  or a child session's cwd is exactly what the #4044 lock exists to prevent, so a re-clone requires this proof. */
export function holdsCloneWriteLock(dir, { lockRoot } = {}) {
  try {
    const snap = inspectCloneLock(dir, lockRoot ? { lockRoot } : {});
    return Boolean(snap.writer && snap.writerLive && snap.writer.owner === defaultOwner());
  } catch { return false; }
}

// A re-clone that did not fix the clone must not be retried on every sync: the cause is outside the clone (the shared
// reference store, an unreachable origin), so each attempt would only move the path away and back. The stamp lives in
// the quarantine root (a clone's own `.git` is replaced by the re-clone) and records when the last attempt STARTED.
const RECLONE_BACKOFF_MS = 60 * 60_000;
const recloneStamp = (quarantineRoot, dir) => join(quarantineRoot, `.reclone-attempt-${basename(dir)}`);
function recloneBackoffLeft(quarantineRoot, dir, now, backoffMs) {
  try {
    const at = Number(readFileSync(recloneStamp(quarantineRoot, dir), 'utf8'));
    return Number.isFinite(at) && at <= now && now - at < backoffMs ? backoffMs - (now - at) : 0; // a future/garbage stamp (clock skew) never blocks
  } catch { return 0; }
}

// A healthy clone is probed with the two cheap ref calls on every fetch; the heavier checks (commit-graph verify,
// the HEAD/index/history probe) run when a ref is broken or at most once per interval, so a drain that syncs per
// card does not pay for `ls-files --stage` / `commit-graph verify` on a large clone each time.
const DEEP_CHECK_INTERVAL_MS = 10 * 60_000;
const deepStamp = (dir) => join(dir, '.git', '.clone-repair-deep-checked');
// A clone found damaged but not re-clonable is throttled too (else every sync re-pays the deep checks and re-logs
// "needs attention"). The stamp is per caller kind: a prune-only caller finding the clone damaged says nothing about
// whether a caller that MAY re-clone could fix it, so it must never delay that caller. Its body holds the problems, so a
// throttled call still reports the clone as damaged.
const damagedStamp = (dir, mode) => join(dir, '.git', `.clone-repair-damaged-${mode}`);
const stampAge = (file, now) => { try { return now - statSync(file).mtimeMs; } catch { return Infinity; } };
// The recorded problems are JSON, written via temp file + rename. A fresh stamp whose body cannot be read back as a
// non-empty list (truncated, empty, garbage) is NOT trusted: it must never turn "damaged" into "healthy", so the check re-runs.
// The throttle can hold a caller that has since become able to re-clone (lock freed, tree cleaned) off for up to one
// interval, and replays "damaged" for that long if the clone is fixed outside this code; both are accepted for the quiet.
function recordedProblems(dir, mode) {
  try {
    const list = JSON.parse(readFileSync(damagedStamp(dir, mode), 'utf8'));
    return Array.isArray(list) && list.length && list.every((p) => typeof p === 'string') ? list : [];
  } catch { return []; }
}
function writeDamagedStamp(dir, mode, problems) {
  const file = damagedStamp(dir, mode);
  const tmp = `${file}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(problems)); renameSync(tmp, file); }
  catch { try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ } } // the stamp only throttles
}
function deepCheckDue(dir, intervalMs, now, mode) {
  if (stampAge(deepStamp(dir), now) < intervalMs) return false;
  return !(stampAge(damagedStamp(dir, mode), now) < intervalMs && recordedProblems(dir, mode).length);
}
// A dangling non-remote ref stays dangling until a person looks; warn about each once per process, not every sync.
const warnedDangling = new Set();

/**
 * Make a daemon clone safe to `git fetch` in. Idempotent; a healthy clone costs two git calls per fetch (the deep
 * checks run when a ref is broken or once per `deepIntervalMs`). Never throws. A re-clone happens ONLY when the caller
 * passes `allowReclone:true` (default false: callers that cannot prove `dir` is a daemon-owned clone get prune-only).
 * @param {string} dir  the clone's worktree root
 * Even then it only re-clones while holding the daemon-clone WRITE lock ({@link holdsCloneWriteLock}; `holdsWriteLock` is
 * injectable) and at most once per `recloneBackoffMs` for a clone it could not fix.
 * @param {{log?:Function, allowReclone?:boolean, holdsWriteLock?:Function, quarantineRoot?:string, reclone?:Function, recloneBackoffMs?:number, deepIntervalMs?:number, now?:number}} [opts]
 * @returns {{ok:boolean, skipped?:string, pruned:string[], reported:string[], reportedNew:string[], quarantinedTo?:string, problems:string[]}}
 */
export function repairCloneRefs(dir, opts = {}) {
  // A best-effort pre-fetch step must never abort the caller's sync or tick: any throw (rename EXDEV/EACCES, a
  // throwing reclone) becomes `{ok:false}` and the caller proceeds to its own fetch exactly as it did before.
  try {
    return repairCloneRefsUnguarded(dir, opts);
  } catch (e) {
    const msg = String(e && e.message || e).split('\n')[0];
    (opts.log || (() => {}))(`  ⚠ clone-repair ${dir ? basename(dir) : '?'}: repair threw (${msg}) — skipped`);
    return { ok: false, pruned: [], reported: [], reportedNew: [], problems: [`repair threw: ${msg}`] };
  }
}

function repairCloneRefsUnguarded(dir, { log = () => {}, allowReclone = false, holdsWriteLock = holdsCloneWriteLock, quarantineRoot = join(dirname(dir), '.quarantine'), reclone = recloneInPlace, recloneBackoffMs = RECLONE_BACKOFF_MS, deepIntervalMs = DEEP_CHECK_INTERVAL_MS, now = Date.now() } = {}) {
  const out = { ok: true, pruned: [], reported: [], reportedNew: [], problems: [] };
  if (!dir || !existsSync(join(dir, '.git'))) return { ...out, skipped: 'not-a-clone' };
  const name = basename(dir);
  const { broken, probeFailed } = probeBrokenRefs(dir);
  if (probeFailed) { out.ok = false; log(`  ⚠ clone-repair ${name}: could not list refs (git failed) — treating the clone as unverified`); }
  const head = broken.length ? runGit(['symbolic-ref', '-q', 'HEAD'], dir).out.trim() : '';
  for (const { ref, sha } of broken) {
    if (ref.startsWith('refs/remotes/') && ref !== head) {
      // --no-deref: the namespace check above names THIS ref; without it git follows a symref and deletes its
      // target (a remote-tracking alias of a dangling local branch would take the branch with it).
      const r = runGit(['update-ref', '--no-deref', '-d', ref], dir);
      if (r.code === 0) out.pruned.push(ref);
      else out.reported.push(`${ref} (target ${sha.slice(0, 8)} missing; prune failed: ${r.err.trim().split('\n')[0]})`);
    } else {
      out.reported.push(`${ref} (target ${sha.slice(0, 8)} missing; not a remote-tracking ref, left in place)`);
    }
  }
  if (out.pruned.length) log(`  ⚑ clone-repair ${name}: pruned ${out.pruned.length} dangling remote-tracking ref(s): ${out.pruned.slice(0, 5).join(', ')}${out.pruned.length > 5 ? ', …' : ''}`);
  for (const r of out.reported) {
    const key = `${dir}\0${r}`;
    if (warnedDangling.has(key)) continue;
    warnedDangling.add(key);
    out.reportedNew.push(r);
    log(`  ⚠ clone-repair ${name}: dangling ref NOT deleted — ${r}`);
  }

  // Nothing pruned, the ref probe worked, and the deep check is not due: done after the two ref calls above. (A
  // dangling NON-remote ref stays put and is reported once; it must not force the deep checks on every sync.)
  const pruneFailedEarly = out.reported.some((r) => r.includes('prune failed'));
  const mode = allowReclone ? 'reclone' : 'prune';
  if (!probeFailed && !out.pruned.length && !pruneFailedEarly && !deepCheckDue(dir, deepIntervalMs, now, mode)) {
    // Throttled because an earlier check found it damaged (not because it was healthy): replay that, never report healthy.
    const known = stampAge(deepStamp(dir), now) < deepIntervalMs ? [] : recordedProblems(dir, mode);
    if (known.length) { out.ok = false; out.problems = known; }
    return out;
  }
  const standalone = isStandaloneClone(dir);

  // A stale commit-graph cache (naming commits that left the object store) breaks `fsck` and history walks even with
  // every ref healthy (live: the drain data clone still failed fsck after its refs were pruned). It is a derived cache:
  // move it aside and regenerate (shared helper from xsxu243; touches only this clone's objects/info/commit-graph*).
  // Standalone clones only: for a linked worktree `--git-common-dir` is SHARED with other checkouts.
  if (standalone) {
    try {
      const cg = healSharedCommitGraph(dir, { lockDir: join(dir, '.git', '.commit-graph-heal.lock'), log, waitMs: 5_000 });
      if (cg.healed) out.commitGraphHealed = true;
    } catch (e) { log(`  ⚠ clone-repair ${name}: commit-graph heal failed: ${String(e && e.message || e).split('\n')[0]}`); }
  }

  const problems = diagnoseLane(dir).problems.filter((p) => !/ref\(s\) point at missing objects/.test(p));
  const pruneFailed = out.reported.some((r) => r.includes('prune failed'));
  if (!problems.length && !pruneFailed) {
    if (probeFailed) return out; // never stamp a clone whose ref probe failed
    try { writeFileSync(deepStamp(dir), String(now)); } catch { /* the stamp only throttles; a failed write re-runs the check */ }
    for (const m of ['reclone', 'prune']) { try { rmSync(damagedStamp(dir, m), { force: true }); } catch { /* the fresh healthy stamp outranks it */ } } // healthy again: no stale "damaged" replay
    return out;
  }
  out.problems = problems;
  // Fail closed (card edge cases 2 + 4): a re-clone needs the caller's opt-in, a standalone clone, the daemon-clone
  // write lock (nobody else may be reading the tree we move), AND affirmative evidence of a clean tree with no
  // unpushed work. Anything else reports "needs attention" and leaves the clone exactly where it is.
  const locked = problems.length && allowReclone && standalone ? holdsWriteLock(dir) : false;
  const tree = locked ? provenCleanTree(dir) : null;
  const backoffLeft = tree?.safe ? recloneBackoffLeft(quarantineRoot, dir, now, recloneBackoffMs) : 0;
  if (!problems.length || !allowReclone || !standalone || !locked || !tree.safe || backoffLeft > 0) {
    out.ok = !problems.length && !pruneFailed && !probeFailed;
    if (problems.length) {
      const why = !allowReclone ? 're-clone is disabled for this caller'
        : !standalone ? 'it is not a standalone clone (linked worktree or shared store)'
          : !locked ? 'the daemon-clone write lock is not held, so the clone cannot be moved safely'
            : !tree.safe ? tree.why
              : `a re-clone was already tried and did not fix it; backing off for ${Math.ceil(backoffLeft / 60_000)} more minute(s)`;
      log(`  ⚠ clone-repair ${name}: clone is damaged (${problems.join('; ')}) but ${why} — needs attention`);
      // Throttle the failure outcome too, so the next syncs skip the deep checks and the repeated warning until the interval
      // passes. Not when the ref probe or a prune failed: those are retryable now, and the clone is not fully examined.
      if (!probeFailed && !pruneFailed) writeDamagedStamp(dir, mode, problems);
    }
    return out;
  }
  if (tree.unprovenIndex) log(`  ⚠ clone-repair ${name}: HEAD is gone, so staged-only edits cannot be ruled out; the whole clone is kept in quarantine`);
  try { mkdirSync(quarantineRoot, { recursive: true }); writeFileSync(recloneStamp(quarantineRoot, dir), String(now)); } catch { /* an unwritable stamp only loses the rate limit */ }
  const r = reclone(dir, quarantineRoot, { log, reason: problems.join('; ') });
  if (r.ok) {
    rmSync(recloneStamp(quarantineRoot, dir), { force: true }); // verified healthy: a later, unrelated failure may re-clone at once
    out.ok = true; out.quarantinedTo = r.quarantinedTo; out.problems = []; return out;
  }
  out.ok = false;
  log(`  ⚠ clone-repair ${name}: ${r.error}`);
  return out;
}

const resolveFrom = (base, p) => (p.startsWith('/') ? p : join(base, p));
