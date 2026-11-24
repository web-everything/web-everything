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
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/** Do not retry a failed clone for this long (ms). */
export const CLONE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const failures = new Map();

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

/**
 * Make sure `<parentDir>/<name>` is a usable git clone of `slug`; returns its path, or `null` (fail closed).
 * @param {{slug:string, name:string, parentDir:string, localOrigin:string|null, exec?:Function, exists?:Function,
 *   rename?:Function, now?:()=>number}} o
 */
export function ensureSiblingClone({ slug, name, parentDir, localOrigin, exec = execFileSync, exists = existsSync, rename = renameSync, now = Date.now } = {}) {
  const dir = resolve(parentDir, name);
  if (exists(join(dir, '.git'))) return dir;
  const key = `${dir}\0${slug}`;
  const failedAt = failures.get(key);
  if (failedAt !== undefined && now() - failedAt < CLONE_RETRY_COOLDOWN_MS) return null;
  const url = siblingCloneUrl(localOrigin, slug);
  if (!url || exists(dir)) { failures.set(key, now()); return null; } // never clobber a squatting non-clone dir
  const tmp = `${dir}.clone-${process.pid}-${now()}`;
  try {
    exec('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '-c', 'gc.auto=0', url, tmp],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: CLONE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    rename(tmp, dir);
    failures.delete(key);
    return exists(join(dir, '.git')) ? dir : null;
  } catch {
    failures.set(key, now());
    return null;
  }
}

/** Test seam: forget remembered clone failures. */
export function resetSiblingCloneFailures() { failures.clear(); }

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
