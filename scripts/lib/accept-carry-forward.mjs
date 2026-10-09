/**
 * @file scripts/lib/accept-carry-forward.mjs
 * @description Card xu7kxtt (#5472, ruling P4, operator 2026-10-08): "an equivalent merge-main keeps the accept; a heal
 *   commit gets a delta review of its own diff only".
 *
 *   THE RULE. An accept (an agent `review:accepted`, or the operator's `clear-human`) is recorded against a head SHA
 *   AND the strict `reviewed-diff` fingerprint of the PR's own net diff (vs its merge-base). When the head moves, the
 *   accept is CARRIED to the new head only when the new head's net diff fingerprint is byte-identical to the
 *   accepted one (`normalizeDiffFingerprint`: only text-section `index` lines and the root lane manifest are left
 *   out). That is what a pure merge/rebase of main produces. Anything else (a conflict resolution, a new commit,
 *   a fingerprint that cannot be read) is NOT carried: a review of the change is owed, as today.
 *
 *   WHY THIS EXISTS (live, #4535, 2026-10-09). The operator cleared #4535 at head fcc29ce1. The merge queue (#4619)
 *   refreshed it onto main at 14:25Z (new head 143107a87, a merge commit). The net diff stayed byte-identical
 *   (reviewed-diff b945d333… on both heads). The drain's anti-test-gaming gate bound the clearance to the SHA only,
 *   so it re-parked `review:human` at 14:36Z, and the PR waited for a second operator approval of the same diff.
 *
 *   WHAT IT NEVER DOES. It never widens to the contribution digest (context-insensitive): a carry needs the STRICT
 *   fingerprint. It never carries past a later verdict or a body-derived hold (manifest tamper): those are not
 *   content of the diff, so an identical diff proves nothing about them.
 *
 *   SETTING `acceptCarryForward` (`on` | `off`), policy cascade (card x5wnfcg): standard default (built-in `off` =
 *   today: a moved head loses a SHA-bound accept) → platform preference (`we:scripts/settings/accept-carry-forward.json`)
 *   → tool override (env `WE_ACCEPT_CARRY_FORWARD`).
 *
 *   Pure except {@link resolveAcceptCarryForward} (reads the settings file).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export const ACCEPT_CARRY_FORWARD_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'accept-carry-forward.json');

/** Built-in standard default: today's behaviour. */
export const ACCEPT_CARRY_FORWARD_DEFAULT = 'off';

const onOff = (v) => { const x = String(v ?? '').trim().toLowerCase(); return x === 'on' || x === 'off' ? x : null; };

/** env `WE_ACCEPT_CARRY_FORWARD` > settings `acceptCarryForward` > built-in `off`. */
export function resolveAcceptCarryForward({ env = process.env, file = ACCEPT_CARRY_FORWARD_SETTINGS_FILE } = {}) {
  const fromEnv = onOff(env?.WE_ACCEPT_CARRY_FORWARD);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  try { const f = onOff(JSON.parse(readFileSync(file, 'utf8'))?.acceptCarryForward); if (f) return { value: f, source: 'settings' }; } catch { /* built-in */ }
  return { value: ACCEPT_CARRY_FORWARD_DEFAULT, source: 'default' };
}

const SHA_RE = /^[0-9a-f]{40}$/;
const FP_RE = /^[0-9a-f]{64}$/;
const REVIEWED_SHA_RE = /<!--\s*reviewed-sha:\s*([0-9a-f]{40})\s*-->/gi;
const REVIEWED_DIFF_RE = /<!--\s*reviewed-diff:\s*([0-9a-f]{64})\s*-->/gi;
const CLEARED_HUMAN_RE = /<!--\s*cleared-human:\s*([^>]*?)\s*-->/i;
/** A drain park whose reason is NOT a function of the diff: an identical diff proves nothing about it. */
const BODY_DERIVED_HOLD_RE = /manifest baseline mismatch/i;

const lastMatch = (re, body) => { re.lastIndex = 0; let m; let out = null; while ((m = re.exec(body)) !== null) out = m[1].toLowerCase(); return out; };

/**
 * The latest trusted accept record on a PR thread, and what was posted after it. Pure.
 * @param {Array<{body?:string, author?:object, createdAt?:string}>} comments
 * @returns {{sha:string, diff:string|null, humanCleared:boolean, actor:string|null, index:number,
 *   laterBodyDerivedHold:boolean}|null}
 */
export function latestAcceptRecord(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let rec = null;
  list.forEach((c, index) => {
    if (!isTrustedMarkerAuthor(c)) return;
    const body = typeof c?.body === 'string' ? c.body : '';
    const sha = body ? lastMatch(REVIEWED_SHA_RE, body) : null;
    if (!sha) return;
    const human = CLEARED_HUMAN_RE.exec(body);
    rec = { sha, diff: lastMatch(REVIEWED_DIFF_RE, body), humanCleared: !!human, actor: human ? human[1] || null : null, index };
  });
  if (!rec) return null;
  const laterBodyDerivedHold = list.slice(rec.index + 1)
    .some((c) => isTrustedMarkerAuthor(c) && BODY_DERIVED_HOLD_RE.test(typeof c?.body === 'string' ? c.body : ''));
  return { ...rec, laterBodyDerivedHold };
}

/**
 * THE RULE. Facts in, verdict out. Pure.
 * @param {{setting?:'on'|'off', record?:ReturnType<typeof latestAcceptRecord>, headSha?:string|null,
 *   headDiff?:string|null, laterVerdict?:boolean}} facts — `headDiff` is the strict `normalizeDiffFingerprint` of the
 *   live head's net diff (null when it could not be read).
 * @returns {{action:'off'|'none'|'same-head'|'carry'|'review-owed', from?:string, to?:string, human?:boolean,
 *   reason:string}}
 *   `carry` = the accept holds on the new head (record both SHAs). `review-owed` = the net diff changed or could not
 *   be proven identical: today's path (a review of the change; a `review:human` PR goes back to the operator).
 */
export function decideAcceptCarryForward({ setting = ACCEPT_CARRY_FORWARD_DEFAULT, record = null, headSha = null, headDiff = null, laterVerdict = false } = {}) {
  if (setting !== 'on') return { action: 'off', reason: 'acceptCarryForward is off (today: a moved head loses a SHA-bound accept)' };
  const head = typeof headSha === 'string' ? headSha.toLowerCase() : '';
  if (!record || !SHA_RE.test(record.sha ?? '')) return { action: 'none', reason: 'no trusted accept record on the PR' };
  if (!SHA_RE.test(head)) return { action: 'none', reason: 'live head unknown' };
  const base = { from: record.sha, to: head, human: !!record.humanCleared };
  if (record.sha === head) return { ...base, action: 'same-head', reason: 'the accept already names the live head' };
  if (laterVerdict) return { ...base, action: 'none', reason: 'a later verdict supersedes the accept' };
  if (record.laterBodyDerivedHold) return { ...base, action: 'none', reason: 'a later hold is not derived from the diff (manifest tamper); an identical diff proves nothing about it' };
  const accepted = typeof record.diff === 'string' ? record.diff.toLowerCase() : '';
  const live = typeof headDiff === 'string' ? headDiff.toLowerCase() : '';
  if (!FP_RE.test(accepted)) return { ...base, action: 'review-owed', reason: 'the accept carries no reviewed-diff fingerprint; identity unproven' };
  if (!FP_RE.test(live)) return { ...base, action: 'review-owed', reason: 'the live net diff could not be read; identity unproven' };
  if (accepted !== live) {
    return { ...base, action: 'review-owed', reason: `net diff changed since the accept at ${record.sha.slice(0, 9)} — a review of the change is owed${record.humanCleared ? '; it goes back to the operator' : ''}` };
  }
  return { ...base, action: 'carry', reason: `net diff byte-identical to the accept at ${record.sha.slice(0, 9)} (reviewed-diff ${accepted.slice(0, 12)}); accept carried to ${head.slice(0, 9)}` };
}
