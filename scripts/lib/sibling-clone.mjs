/**
 * @file scripts/lib/sibling-clone.mjs
 * @description Provision a constellation SIBLING clone (`../<name>` next to the drain's WE clone) on demand, so the
 *   drain can refresh / rebuild a cross-repo PR the same way it rebuilds a WE one.
 *
 * WHY: 2026-10-09, plateau-app PR #217 was accepted, MERGEABLE/CLEAN, and skipped every drain pass with
 *   `merge-queue: refresh (…) → skipped-remote failed: no plateauapp/plateau-app clone provisioned`. The resident
 *   drain runs from `.lanes/we-drain-daemon/lane-1`; only the WE lane pool provisions `../plateau-app` /
 *   `../frontierui` (we:scripts/lane-pool.mjs `ensureRepoSiblings`), so in the drain's own pool the sibling never
 *   existed, the freshness refresh could never run, and no plateau PR whose main moved could ever merge.
 *
 * WHY A CLONE AND NOT GitHub's update-branch API: after any refresh the head moves, and the drain's review gate must
 *   then re-verify the acceptance against the new head's NET diff (`readDrainAcceptance` → `netDiff`), and the
 *   acceptance re-stamp computes the same fingerprint (`review-set-label.mjs restamp`). Both are git reads in a
 *   checkout of THAT repo. Without a clone the moved head reads as `headReadFailed` → acceptance does not cover →
 *   the PR never lands. A clone fixes the refresh AND every later verification.
 *
 * HOW: same transport as the drain clone's own origin (its URL with the target slug), `--reference-if-able` the
 *   primary checkout's sibling (found through the lane's objects/info/alternates) and `--dissociate`, so the new
 *   clone shares no object store with a checkout someone else may gc. A clone that exists is reused untouched (the
 *   rebuild path fetches what it needs). Never throws; a failed clone removes its partial directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** PURE. The drain clone's origin URL with its `owner/repo` swapped for `repo`. null for an unknown shape. */
export function siblingCloneUrl(originUrl, repo) {
  const url = String(originUrl ?? '').trim();
  if (!SLUG_RE.test(String(repo ?? ''))) return null;
  const scp = /^([^@\s/]+@[^:\s]+):[^/\s]+\/[^/\s]+?(?:\.git)?\/?$/.exec(url);
  if (scp) return `${scp[1]}:${repo}.git`;
  const web = /^((?:https?|ssh|git):\/\/[^/\s]+)\/[^/\s]+\/[^/\s]+?(?:\.git)?\/?$/.exec(url);
  if (web) return `${web[1]}/${repo}.git`;
  return null;
}

/** PURE. The checkout whose `.git/objects` the lane borrows (first alternates line), or null. */
export function referenceRootFromAlternates(text) {
  const first = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!first || !/\/\.git\/objects\/?$/.test(first)) return null;
  return first.replace(/\/\.git\/objects\/?$/, '');
}

/** PURE. Where the sibling goes, where it comes from, and what to borrow objects from. */
export function planSiblingClone({ repo, name, cwd, originUrl, alternates = '' }) {
  if (!name) return { ok: false, error: `${repo} is not a constellation sibling (no clone name)` };
  const url = siblingCloneUrl(originUrl, repo);
  if (!url) return { ok: false, error: `cannot derive a ${repo} URL from the drain clone's origin URL (${originUrl || 'none'})` };
  const primary = referenceRootFromAlternates(alternates);
  return { ok: true, dest: resolve(cwd, '..', name), url, reference: primary ? join(dirname(primary), name) : null };
}

const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0].slice(0, 200);

/**
 * Reuse or create `../<name>` beside `cwd`. Never throws.
 * @returns {{ok: true, dir: string, created: boolean} | {ok: false, error: string}}
 */
export function ensureSiblingClone({
  repo, name, cwd = process.cwd(),
  git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, ...opts }),
  exists = (p) => existsSync(p),
  readAlternates = (dir) => { try { return readFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8'); } catch { return ''; } },
  rm = (p) => rmSync(p, { recursive: true, force: true }),
}) {
  if (!name) return { ok: false, error: `${repo} is not a constellation sibling (no clone name)` };
  const dest = resolve(cwd, '..', name);
  if (exists(join(dest, '.git'))) return { ok: true, dir: dest, created: false };
  if (exists(dest)) return { ok: false, error: `${dest} exists and is not a git clone — not touching it` };
  let originUrl = '';
  try { originUrl = String(git(['remote', 'get-url', 'origin'], { cwd })).trim(); } catch (e) { return { ok: false, error: `cannot read the drain clone's origin: ${firstLine(e)}` }; }
  const plan = planSiblingClone({ repo, name, cwd, originUrl, alternates: readAlternates(cwd) });
  if (!plan.ok) return plan;
  const ref = plan.reference ? ['--reference-if-able', plan.reference, '--dissociate'] : [];
  try {
    git(['clone', '--quiet', ...ref, plan.url, plan.dest]);
  } catch (e) {
    try { rm(plan.dest); } catch { /* best-effort */ }
    return { ok: false, error: `clone failed: ${firstLine(e)}` };
  }
  return { ok: true, dir: plan.dest, created: true };
}
