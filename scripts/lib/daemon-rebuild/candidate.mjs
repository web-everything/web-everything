/** @file scripts/lib/daemon-rebuild/candidate.mjs — Disposable candidate worktree and smoke environment.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { randomBytes } from 'node:crypto';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { stateDir } from './state.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { makeGit } from './shared.mjs';
import { rmSync, mkdirSync, existsSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { defaultPoolRoot, workspaceFor } from '../lane-pool-paths.mjs';

// ── candidate worktree (xa4qo7n) — where the live smoke actually runs, never `root` ─────────────────────────

/**
 * Per-ATTEMPT staging path for the candidate worktree the live smoke runs against — OUTSIDE any git tree, same
 * `stateDir`/`cloneKey` convention as every other per-clone sidecar this module owns, suffixed with the build
 * lease's own `token` (see {@link claimBuildLease}). PR #2731 review: this used to be ONE fixed path per clone,
 * and two sibling daemons rebuilding the same clone at once force-removed each other's worktree mid-smoke. The
 * single-flight lease already stops two builds overlapping; a unique path means an aged-lease takeover builds
 * beside, never on top of, a tree a slow attempt may still be reading. A crashed attempt's leftover is found
 * through the lease record it left behind (`state.building.path`) and torn down by whoever takes the lease over
 * next — only once its owner is provably gone (see {@link leaseOwnerIsGone}).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [token] - the build lease's token (default: a fresh random one, never a shared fixed path).
 * @returns {string}
 */
export function candidateWorktreePath(root, env = process.env, token = `manual-${randomBytes(4).toString('hex')}`) {
  return join(stateDir(env), `${cloneKey(root)}.candidate-${token}`);
}

/**
 * Check `sha` out into a disposable `git worktree` at `path` (default {@link candidateWorktreePath}) — a SECOND working copy of
 * the SAME `root` repository (`git worktree add` shares the object database; this never fetches or copies a
 * single object, unlike {@link dryRunRebuild}'s separate scratch-bare-repo trick, which exists only because a
 * dry run must never write anything into `root`'s own refs — this module already owns `root` outright once it
 * holds the write lock, so a plain worktree is enough). Anything already at `path` is force-torn-down first —
 * `path` is unique to this attempt's lease, so that is only ever this attempt's own leftover. `node_modules` is symlinked in from
 * `root` on a best-effort basis — a fresh worktree checkout carries only git-tracked files, and the live
 * smoke's checks spawn real `node`/`gh` child processes from it that need real dependencies; a repo with no
 * `node_modules` (or one whose checks then fail on a missing module) surfaces that as an ordinary check
 * failure, never a silent skip.
 *
 * xa4qo7n LIVE BUG, caught proving this very fix (2026-09-26 15:20 ET on `wev-review-daemon`): a `node_modules/`
 * `.gitignore` entry (the near-universal convention — trailing slash, "directories only") does NOT match a
 * SYMLINK of the same name (confirmed: `git status --porcelain` reports `?? node_modules` for a symlink even
 * with that exact ignore rule in place), so the symlink this function creates made {@link checkTreeStaysClean}
 * ALWAYS see the candidate as dirty — poisoning the reject-cache (`tree-stays-clean` is `mayBeTransient:false`)
 * on every single rebuild that reached this step, in a repo with a `node_modules/`-style ignore rule. Fixed by
 * {@link ensureNodeModulesExcluded}: a one-time, idempotent, repo-wide `node_modules` line (no trailing slash —
 * matches files AND symlinks, not just real directories) appended to the shared `info/exclude` (this is NOT
 * per-worktree; git resolves it from `--git-common-dir`, confirmed empirically — a PRIVATE per-worktree
 * `info/exclude` file is never even read), so every worktree's status reads the symlink as ignored, exactly
 * like the tracked `.gitignore` already treats the real directory.
 * @param {{root:string, sha:string, run:typeof gitRun, env?:NodeJS.ProcessEnv, path?:string}} o
 * @returns {{ok:true, path:string}|{ok:false, reason:string}}
 */
export function materializeCandidate({
  root, sha, run, env, path = candidateWorktreePath(root, env),
}) {
  const git = makeGit({ run, cwd: root, env, timeoutMs: 120_000 });
  git(['worktree', 'remove', '--force', path]);
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort teardown of a stale attempt */ }
  git(['worktree', 'prune']);
  mkdirSync(dirname(path), { recursive: true });
  const add = git(['worktree', 'add', '--detach', '--quiet', path, sha]);
  if (add.status !== 0) {
    return { ok: false, reason: `worktree-add-failed: ${String(add.stderr || add.stdout || '').trim().split('\n')[0]}` };
  }
  try {
    const nodeModules = join(root, 'node_modules');
    if (existsSync(nodeModules) && !existsSync(join(path, 'node_modules'))) {
      ensureNodeModulesExcluded({ root, git });
      symlinkSync(nodeModules, join(path, 'node_modules'), 'dir');
    }
  } catch { /* best-effort — see docblock above */ }
  return { ok: true, path };
}

/**
 * One-time, idempotent: append a bare `node_modules` line (no trailing slash, so it matches a SYMLINK too, not
 * only a real directory — see {@link materializeCandidate}'s docblock) to the repo's shared `info/exclude`,
 * unless a line already says exactly that. Best-effort — a failure here just means a future candidate's
 * `tree-stays-clean` check may see the symlink as dirt, same as before this fix; it never blocks the build.
 * @param {{root:string, git:(args:string[])=>{status:number,stdout:string,stderr:string}}} o
 */
function ensureNodeModulesExcluded({ root, git }) {
  const gd = git(['rev-parse', '--git-common-dir']);
  if (gd.status !== 0) return;
  const raw = String(gd.stdout || '').trim();
  if (!raw) return;
  const commonDir = isAbsolute(raw) ? raw : resolvePath(root, raw);
  const excludePath = join(commonDir, 'info', 'exclude');
  let existing = '';
  try { existing = readFileSync(excludePath, 'utf8'); } catch { /* missing is fine — starts empty */ }
  if (existing.split('\n').map((l) => l.trim()).includes('node_modules')) return; // already present
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, `${existing.replace(/\n?$/, '\n')}node_modules\n`);
}

/** Best-effort teardown of a candidate worktree — never throws. A failure here just leaves the fixed path for
 *  the NEXT {@link materializeCandidate} call to clear before it reuses it. */
export function removeCandidate({ root, path, run, env }) {
  const git = makeGit({ run, cwd: root, env, timeoutMs: 60_000 });
  try { git(['worktree', 'remove', '--force', path]); } catch { /* best-effort */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { git(['worktree', 'prune']); } catch { /* best-effort */ }
}

// ── x5wbsbc — the candidate smoke runs in the LIVE daemon's environment, not the candidate path's ──────────

/** Env var a candidate smoke carries naming the live clone it stands in for (diagnostics only). */
export const SMOKE_LIVE_CLONE_ENV = 'WE_SMOKE_LIVE_CLONE';
/** `dispatch-lane-io.mjs#DISPATCH_CWD_ENV` — restated (not imported: that module is far too heavy for the
 *  rebuild mechanism to load); a unit test pins the two names equal. */
export const DISPATCH_CWD_ROOT_ENV = 'WE_DISPATCH_CWD_ROOT';

/**
 * PURE: the env the live smoke runs with when its tree is a disposable candidate worktree instead of `root`.
 *
 * x5wbsbc, live 2026-09-26 12:11-12:40 ET on `wev-review-daemon`: every rebuild since #2731 was
 * `smoke-rejected` (sticky) on `lane-acquire-release` — "no lanes provisioned for web-everything under
 * ~/.claude/daemon-self-sync-state/.lanes/web-everything". Everything that derives a location from WHERE the
 * checkout sits (`lane-pool-paths.mjs#defaultPoolRoot` → `<workspace>/.lanes`; `dispatch-lane-io.mjs`'s dispatch
 * scratch root → `<workspace>/.operations/dispatch`) resolved against the CANDIDATE's path, which lives under the
 * rebuild state dir — a pool with no lanes, and `.operations/` litter in the state dir. The live daemon
 * resolves those from `root`. So every such location is resolved HERE, from `root`, and passed explicitly: an
 * explicit `LANE_POOL_ROOT`/`WE_DISPATCH_CWD_ROOT` already in `env` wins (that is what the daemon itself would
 * use); `PATH`/`HOME` are guaranteed present (a spawn with no PATH is `spawn git ENOENT`). The WE_*, GitHub App
 * and `gh` env ride along untouched from `env` (the daemon's own), exactly as the old in-place smoke had them.
 * @param {{root:string, env?:NodeJS.ProcessEnv}} o
 * @returns {NodeJS.ProcessEnv}
 */
export function candidateSmokeEnv({ root, env = process.env }) {
  const out = { ...env };
  if (!out.PATH) out.PATH = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  if (!out.HOME) out.HOME = process.env.HOME || homedir();
  out.LANE_POOL_ROOT = defaultPoolRoot(root, out);
  if (!String(out[DISPATCH_CWD_ROOT_ENV] ?? '').trim()) {
    out[DISPATCH_CWD_ROOT_ENV] = join(workspaceFor(root), '.operations', 'dispatch');
  }
  out[SMOKE_LIVE_CLONE_ENV] = root;
  return out;
}
