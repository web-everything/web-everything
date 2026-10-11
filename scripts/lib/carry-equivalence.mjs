/**
 * @file scripts/lib/carry-equivalence.mjs
 * @description The one shared carry equivalence for the drain carry, the merge-gate carry (via
 *   proveHumanClearanceCarry), and the review re-stamp (decideAcceptCarryForward).
 *   Strict fingerprints compare reviewed diffs; the contribution tier compares added/removed lines
 *   when only context or offsets move, with replay proof required by human-clearance carry.
 *   patch-id is not used: `git patch-id --stable` hashes context lines too.
 *   review.carryEquivalence (contribution|strict), overridden by WE_REVIEW_CARRY_EQUIVALENCE,
 *   selects the tier; invalid or unreadable policy fails closed to strict.
 *   TRANSIENT_CARRY_PATHS lists only the root .lane-manifest.json; nested manifests remain substantive.
 *   Replay compares the cleared change on the new main base with the live tree, ignoring that list.
 *   Missing evidence, conflicts, unreadable trees, or git failures refuse replay equivalence (fail-closed).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDiffFingerprint, normalizeContributionFingerprint } from './review-escalation.mjs';
import { LANE_MANIFEST } from './rebase-drop-manifest.mjs';

/** Only the drain's root manifest is transient; nested files remain substantive. */
export const TRANSIENT_CARRY_PATHS = Object.freeze([LANE_MANIFEST]);
const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'human-clearance-carry.json');
const ENV_KEY = 'WE_REVIEW_CARRY_EQUIVALENCE';
const failClosed = (layer, value) => ({ value: 'strict', source: `fail-closed (${layer}=${JSON.stringify(value)})` });
const settingValue = (value, source) => ['contribution', 'strict'].includes(value)
  ? { value, source } : failClosed(source, value);

/** IO: env > settings > contribution. Present invalid or unreadable policy fails closed; never throws. */
export function resolveCarryEquivalenceSetting({ env = process.env, file = SETTINGS_FILE, readFile = readFileSync } = {}) {
  try {
    if (env != null && Object.hasOwn(env, ENV_KEY)) return settingValue(env[ENV_KEY], 'env');
  } catch { return failClosed('env', 'unreadable'); }
  try {
    const review = JSON.parse(String(readFile(file, 'utf8')))?.review;
    if (review != null && Object.hasOwn(review, 'carryEquivalence')) return settingValue(review.carryEquivalence, 'settings');
  } catch (e) {
    if (e?.code !== 'ENOENT') return failClosed('settings', 'unreadable');
  }
  return { value: 'contribution', source: 'default' };
}

/** PURE: derive both fingerprints from the same live net diff. */
export function liveCarryFingerprints(diffText) {
  return { diff: normalizeDiffFingerprint(diffText), contribution: normalizeContributionFingerprint(diffText) };
}

const fingerprint = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
const short = (value) => value?.slice(0, 12) || 'none';

/** PURE: prefer strict identity; the contribution tier permits context/offset movement only. */
export function compareCarryFingerprints({ mode = 'contribution', cleared = {}, live = {} } = {}) {
  const cd = fingerprint(cleared.diff); const cc = fingerprint(cleared.contribution);
  const ld = fingerprint(live.diff); const lc = fingerprint(live.contribution);
  if (!ld && !lc) return { same: false, reason: 'live net diff unreadable' };
  if (!cd && !cc) return { same: false, reason: 'the clearance recorded no reviewed-diff fingerprint' };
  if (cd && ld && cd === ld) return { same: true, tier: 'strict', fingerprint: live.diff, reason: `net diff byte-identical (${short(ld)})` };
  if (mode === 'contribution' && cc && lc && cc === lc) {
    return { same: true, tier: 'contribution', fingerprint: live.diff, contribution: live.contribution,
      reason: `the PR's own added/removed lines are identical (contribution ${short(lc)}); only context/offsets moved` };
  }
  return { same: false,
    reason: `net diff changed (${short(cd)} → ${short(ld)}; contribution ${short(cc)} → ${short(lc)})`
      + (mode === 'strict' ? ' [review.carryEquivalence=strict]' : '') + ' — a human must re-approve' };
}

/** IO: ensure a commit is readable, fetching a missing object once and re-checking. Never throws. */
export function ensureCommitReadable({ exec, sha } = {}) {
  try {
    if (typeof exec !== 'function' || typeof sha !== 'string' || !sha) return { ok: false, reason: 'no git reader or head' };
    const git = (args) => exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try { git(['cat-file', '-e', `${sha}^{commit}`]); } catch {
      try { git(['fetch', '--no-tags', '-q', 'origin', sha]); } catch { /* Re-check even if fetch failed. */ }
      try { git(['cat-file', '-e', `${sha}^{commit}`]); } catch {
        return { ok: false, reason: `head ${sha.slice(0, 9)} is not readable locally` };
      }
    }
    return { ok: true, reason: `head ${sha.slice(0, 9)} is readable locally` };
  } catch {
    return { ok: false, reason: 'commit readability check failed' };
  }
}

/**
 * IO: replay the cleared change onto the live main base and compare trees, ignoring exact transient paths.
 * `exec` is execFileSync-shaped and may already bind cwd. Missing objects get one fetch; every error refuses.
 * @returns {{ok:boolean, reason:string}}
 */
export function proveReplayEquivalent({ exec, fromSha, toSha, mainRef = 'origin/main', transient = TRANSIENT_CARRY_PATHS } = {}) {
  try {
    if (typeof exec !== 'function' || !fromSha || !toSha || !mainRef) return { ok: false, reason: 'no git reader or head' };
    const git = (args) => String(exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '');
    const readable = ensureCommitReadable({ exec, sha: fromSha });
    if (!readable.ok) return readable;
    const oldBase = git(['merge-base', fromSha, mainRef]).trim();
    const newBase = git(['merge-base', toSha, mainRef]).trim();
    if (![oldBase, newBase].every((sha) => /^[0-9a-f]{40}$/i.test(sha))) return { ok: false, reason: 'replay merge bases unreadable' };
    let output;
    try { output = git(['merge-tree', '--write-tree', `--merge-base=${oldBase}`, newBase, fromSha]); } catch {
      return { ok: false, reason: 'replaying the cleared change onto main conflicts' };
    }
    const tree = output.split('\n')[0].trim();
    if (!/^[0-9a-f]{40}$/i.test(tree)) return { ok: false, reason: 'replay tree unreadable' };
    const paths = git(['diff', '--name-only', '--no-renames', tree, toSha]).split('\n').filter((p) => p && !transient.includes(p));
    if (paths.length) return { ok: false, reason: `the live head differs from the cleared change replayed onto main in: ${paths.slice(0, 3).join(', ')}` };
    return { ok: true, reason: `replay of ${fromSha.slice(0, 9)} onto main ${newBase.slice(0, 9)} reproduces ${toSha.slice(0, 9)} (transient ignored: ${transient.join(', ')})` };
  } catch (e) {
    return { ok: false, reason: `replay proof failed: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}
