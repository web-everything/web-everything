/**
 * @file scripts/lib/drain-sibling-clone.mjs
 * @description CLEAR-HUMAN-NOT-STICKY (root cause) — the drain must be able to read the NET DIFF of every repo it
 *   drains. It reads a constellation repo's diff through the clone that sits NEXT TO its own checkout
 *   (`<parent>/<name>`, e.g. `../frontierui`). The drain daemon's pool had `plateau-app` but no `frontierui`, so every
 *   frontierui PR was "net diff unverified (no-clone)" and the safe hold re-added `review:human` on every pass, even
 *   right after a recorded `--to=clear-human` (frontierui #53/#54/#58, 2026-11-24). The hold itself stays strict (a
 *   clearance never overrides it); this module removes the cause instead.
 *
 *   {@link ensureSiblingClone} provisions the missing sibling as a BLOBLESS, NO-CHECKOUT clone (`--filter=blob:none
 *   --no-checkout`): the drain only runs `git fetch`/`merge-base`/`diff` over it, and git fetches the few blobs a
 *   diff needs on demand. It clones into a temp dir and renames, so a half-written clone is never mistaken for a
 *   usable one. FAIL CLOSED: any failure returns `null` (the caller keeps the unverified hold as before) and is not
 *   retried until a cooldown passes, so a broken remote cannot make every drain pass hammer the network.
 *
 *   {@link describeUnverifiedDiffHold} is the reasoned hold text: the cause and the wake event, never a silent re-park.
 */
import { existsSync, renameSync } from 'node:fs';
import { execRead } from './proc-read.mjs';
import { join, resolve } from 'node:path';

/** Do not retry a failed clone for this long (ms). */
export const CLONE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const POOL_SIBLINGS = ['frontierui', 'plateau-app'];
const failures = new Map();

/** The one real clone: blobless (blobs are fetched on demand by the diff), no checkout (the drain never reads a worktree). */
function blobsFreeClone(url, tmp, opts) {
  return execRead('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '-c', 'gc.auto=0', url, tmp], opts);
}

/**
 * The clone URL for `slug` (`owner/name`), taken from the local checkout's own origin so the transport (ssh or
 * https) and host match what this machine already authenticates with. Pure. `null` when it cannot be derived.
 * @param {string|null} localOrigin  e.g. `git@github.com:chalbert/web-everything.git`
 * @param {string} slug  e.g. `chalbert/frontierui`
 */
export function siblingCloneUrl(localOrigin, slug) {
  if (typeof localOrigin !== 'string' || typeof slug !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(slug)) return null;
  const m = /^(.*[:/])[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/.exec(localOrigin.trim());
  return m ? `${m[1]}${slug}.git` : null;
}

/** `owner/name` (lower-cased) from a git remote URL, or null. Pure. */
export function slugOfRemote(url) {
  const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Real checks (injectable): is `dir` a working git dir, and what is its origin URL. */
const realIsGitDir = (dir) => { try { execRead('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; } };
const realOriginOf = (dir) => { try { return String(execRead('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch { return null; } };

const rejections = new Map();
/** Why the last ensureSiblingClone for `slug` returned null (e.g. `origin-mismatch`), or null. */
export function siblingCloneRejection(slug) { return rejections.get(slug) || null; }

/**
 * Make sure `<parentDir>/<name>` is a usable git clone of `slug`; returns its path, or `null` (fail closed).
 * An existing clone is trusted only when it is a real git dir whose origin IS `slug` (case-insensitive).
 * Under `dryRun` nothing is cloned: the would-provision is reported and `null` returned.
 */
export function ensureSiblingClone({ slug, name, parentDir, localOrigin, clone = blobsFreeClone, exists = existsSync, rename = renameSync, now = Date.now, env = process.env,
  isGitDir = realIsGitDir, originOf = realOriginOf, dryRun = false, log = () => {} } = {}) {
  const dir = resolve(parentDir, name);
  const reject = (why) => { rejections.set(slug, why); return null; };
  rejections.delete(slug);
  if (exists(join(dir, '.git'))) {
    if (!isGitDir(dir)) return reject('not-a-git-dir');
    const got = slugOfRemote(originOf(dir));
    if (!got || got !== String(slug).toLowerCase()) return reject(`origin-mismatch (${got || 'no origin'} is not ${slug})`);
    return dir;
  }
  // `WE_DRAIN_SIBLING_CLONE=off` disables provisioning; under a test runner it is off unless explicitly `on`
  // (no suite may reach the network by accident).
  const mode = env.WE_DRAIN_SIBLING_CLONE;
  if (mode === 'off' || (env.VITEST && mode !== 'on')) return null;
  // Only provision into a real lane-pool root: one that already holds ANOTHER constellation sibling that is a working
  // git dir. A scratch or temp parent (a test fixture, an empty `.git`) is never a drain pool.
  if (!POOL_SIBLINGS.some((s) => s !== name && exists(join(parentDir, s, '.git')) && isGitDir(join(parentDir, s)))) return null;
  const key = `${dir}\0${slug}`;
  const failedAt = failures.get(key);
  if (failedAt !== undefined && now() - failedAt < CLONE_RETRY_COOLDOWN_MS) return null;
  const url = siblingCloneUrl(localOrigin, slug);
  if (!url || exists(dir)) { failures.set(key, now()); return null; } // never clobber a squatting non-clone dir
  if (dryRun) { log(`would provision ${dir} from ${url}`); return null; }
  const tmp = `${dir}.clone-${process.pid}-${now()}`;
  try {
    clone(url, tmp, { stdio: ['ignore', 'pipe', 'pipe'], timeout: CLONE_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' } }); // never block on a prompt
    rename(tmp, dir);
    failures.delete(key);
    return exists(join(dir, '.git')) ? dir : null;
  } catch {
    failures.set(key, now());
    return null;
  }
}

/** Test seam: forget remembered clone failures. */
export function resetSiblingCloneFailures() { failures.clear(); rejections.clear(); }

/**
 * The sibling-clone directory resolver the drain uses (extracted so the real call path is testable). Local repos
 * need no clone; others resolve `<cwd>/../<name>` through {@link ensureSiblingClone}.
 */
export function createSiblingCloneDir({ isLocalRepo, siblingCloneName, cwd = process.cwd(), readOrigin, dryRun = false, log = () => {}, ensure = ensureSiblingClone } = {}) {
  const verified = new Map(); // a verified clone stays verified for this drain run (no git spawn per call)
  return (repo) => {
    if (isLocalRepo(repo)) return null;
    if (verified.has(repo)) return verified.get(repo);
    const name = siblingCloneName(repo);
    if (!name) return null;
    let localOrigin = null;
    try { localOrigin = readOrigin(); } catch { /* no origin → no clone */ }
    const dir = ensure({ slug: repo, name, parentDir: resolve(cwd, '..'), localOrigin, dryRun, log });
    if (dir) verified.set(repo, dir);
    return dir;
  };
}

/**
 * The drain's hold decision for diff evidence: unscored, incomplete or tampered evidence parks (fail closed; a
 * recorded clear-human never lifts an unscored diff). Returns `null` (no hold) or `{ reasons }`.
 */
export function describeDiffEvidenceHold({ netDiffText, gaming, workflowHoldRepark = false, tamperRepark = false, repo = null, rejection = null }) {
  if (workflowHoldRepark) return null;
  const scored = netDiffText?.scored === true;
  if (scored && !gaming?.evidenceIncomplete && !tamperRepark) return null;
  if (scored) return { reasons: gaming?.reasons || [] };
  const reason = rejection || netDiffText?.reason || 'unscored';
  return { reasons: [describeUnverifiedDiffHold({ repo, reason,
    base: `net diff unverified (${reason}); restore diff access and rerun the drain, or obtain human review of the full diff` })] };
}

/**
 * The reasoned text for an unverified-diff hold: what failed, why, and what wakes it. Stable per (repo, reason) so the
 * drain's own comment de-dup posts it once per cause, not once per pass.
 * @param {{repo?:string|null, reason?:string|null, base:string}} o  `base` is the existing "net diff unverified (...)" sentence
 */
export function describeUnverifiedDiffHold({ repo = null, reason = null, base }) {
  const where = repo ? ` of ${repo}` : '';
  return `${base} — Cause: the drain could not read the net diff${where} (${reason || 'unverified evidence'}); `
    + 'with no verified diff the anti-test-gaming scan cannot run, so the hold fails closed and a recorded clear-human does not override it. '
    + 'Wake event: the drain re-reads automatically on its next pass once a clone of this repo beside the drain checkout is readable '
    + '(it provisions one itself), and a new head re-arms it. Nothing else needs to be done.';
}
