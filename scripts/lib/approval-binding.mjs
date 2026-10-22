/**
 * @file scripts/lib/approval-binding.mjs
 * @description THE one answer to "does the operator's human clearance cover the PR's live head?" — shared by every
 *   reader that decides the human gate is cleared, removes `review:accepted`, or re-adds `review:human`.
 *
 *   THE PROBLEM (operator, 2026-10-21). A `review-set-label --to=clear-human` clearance was effectively bound to the
 *   commit sha: every mechanical new head (the drain's rebase/restamp, its card-numbering commit, a conflict-watch
 *   merge, a ci-heal restoring the same files) dropped it — #5742 (3×), #5773, #5502, #5530 (renumbering), and #5485,
 *   where a fresh review on the SAME head stamped a plain accept and so hid the clearance from every
 *   "latest accept is a clearance" reader.
 *
 *   THE RULE. A clearance is valid at live head X iff the PR's net change at X (vs its merge-base with main, read from
 *   git by trusted code — never from a comment) matches the fingerprint the clearance itself recorded:
 *     • X is the cleared sha                                                         → covered (`sha`);
 *     • the strict `reviewed-diff` fingerprint (`fingerprint`) or the `reviewed-contribution` fingerprint
 *       (`contribution`) matches, AND the cleared change replayed onto X's base reproduces X's tree exactly (git object
 *       ids: every byte, mode, path) — the text digests alone miss a relocation (#x413mbt) and a lossy UTF-8 decode;
 *     • no later comment stands against the clearance and the PR's formal reviews were read with no standing change
 *       request (both required for every tier below the sha one);
 *     • X = B + only the drain's own numbering commits (proved by numbering-carry's exact rename map + reference
 *       rewrite proof) and B is covered by the rules above                           → covered (`numbering`).
 *   Anything unprovable — an unreadable diff, a git error, a missing fingerprint, a failed proof — is NOT covered.
 *   Any content change (one byte, a mode, a trailing newline) changes both fingerprints and fails the replay.
 *
 *   WHICH RECORD COUNTS. Only a trusted-author comment that carries `reviewed-sha` AND `cleared-human` in the SAME
 *   comment (what `review-set-label --to=clear-human` writes, and what the trusted carry/restamp writers re-stamp after
 *   their own proofs). Unlike `parseLatestHumanClearedSha`, a LATER plain accept does not hide it: a fresh review on
 *   the same head never invalidates a clearance, and an older clearance can never lend itself to different content
 *   because coverage is decided by the content proof above. A later review's findings still apply through the normal
 *   gates (`review:changes`, the red-team gate, the guard-file classification) — this module decides only whether the
 *   recorded human clearance covers the head.
 *
 *   SETTINGS (policy cascade, `review.clearance`): `bindTo` fingerprint|sha (default fingerprint; `sha` is the kill
 *   switch — exact sha identity only, today's behaviour) and `normalizeNumbering` true|false (default true). Env
 *   `WE_REVIEW_CLEARANCE_BIND_TO`, `WE_REVIEW_CLEARANCE_NORMALIZE_NUMBERING`. Logged once per process with source. The
 *   existing switches only narrow it: `review.humanClearanceCarryForward=false` forces `bindTo=sha`,
 *   `review.carryHumanClearanceAcrossNumbering=false` forces `normalizeNumbering=false`. `bindTo=sha` restores the
 *   behaviour before this module; the older mechanical carry writers (human-clearance-carry, the restamp) keep their
 *   own switch (`review.humanClearanceCarryForward`).
 */
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import {
  parseReviewedShaMarker, parseReviewedDiff, parseReviewedContribution, parseOperatorClearance, clearanceBindsHead,
} from './review-escalation.mjs';

export { clearanceBindsHead };
import { compareCarryFingerprints } from './carry-equivalence.mjs';
import { isNumberingTolerableLaterBody, resolveNumberingHumanClearanceSetting } from './numbering-carry.mjs';
import { resolveHumanClearanceCarrySetting } from './human-clearance-carry.mjs';
import { laterReviewHold, isLaterVerdictBody } from './accept-carry-forward.mjs';

export const CLEARANCE_BIND_TO_ENV = 'WE_REVIEW_CLEARANCE_BIND_TO';
export const CLEARANCE_NORMALIZE_NUMBERING_ENV = 'WE_REVIEW_CLEARANCE_NORMALIZE_NUMBERING';
const SHA40 = /^[0-9a-f]{40}$/;
// The acceptance writers' own headings, at byte 0 (caller text is always appended after them and `<!--` in it is
// escaped, so prose cannot open with one). Only these, AND a `reviewed-sha` marker, AND no later-verdict shape, make a
// later comment an acceptance record rather than a possible hold.
const ACCEPTANCE_HEADING_RE = /^(?:✅ review — accepted\n|✅ review — `review:human` cleared via the sanctioned path\n|📌 review — acceptance re-stamped after a rebase \(no new review\)\n|📌 review — human clearance carried forward \(equivalent change after a mechanical refresh, no new review\)\n)/;
const isAcceptanceRecordBody = (body) => ACCEPTANCE_HEADING_RE.test(body) && !!parseReviewedShaMarker(body) && !isLaterVerdictBody(body);
// The review-hold reconcile's own heal notice (`buildContradictoryVerdictHealComment`): a sha-bound diagnostic, not a hold.
const MUTUAL_EXCLUSIVITY_HEAL_RE = /^\*\*`review:accepted` removed — mutual exclusivity \(#2766\/#2767\)\.\*\*\n/;
const BIND_TO = ['fingerprint', 'sha'];

const parseBool = (raw) => (raw === undefined ? undefined
  : /^(on|true|1|yes)$/i.test(String(raw).trim()) ? true
    : /^(off|false|0|no)$/i.test(String(raw).trim()) ? false : raw);

/**
 * IO: resolve `review.clearance.{bindTo,normalizeNumbering}` through standard → platform → tool → env. Never throws;
 * an invalid value never overrides a lower layer (an invalid env value falls back, it is not honoured).
 * @returns {{bindTo:{value:'fingerprint'|'sha',source:string}, normalizeNumbering:{value:boolean,source:string}}}
 */
export function resolveClearanceBindingSettings({ env = process.env, tool, platform, humanCarry, numberingCarry } = {}) {
  const resolved = resolveBindingLeaves({ env, tool, platform });
  // The existing kill switches keep their meaning: with the human-clearance carry off, a clearance binds by sha only;
  // with the numbering carry off, numbering is not normalized. Either can only narrow coverage.
  let human = humanCarry;
  if (human === undefined) { try { human = resolveHumanClearanceCarrySetting({ env }); } catch { human = { value: false, source: 'unreadable' }; } }
  let numbering = numberingCarry;
  if (numbering === undefined) { try { numbering = resolveNumberingHumanClearanceSetting({ env }); } catch { numbering = { value: false, source: 'unreadable' }; } }
  if (human?.value !== true && resolved.bindTo.value !== 'sha') {
    resolved.bindTo = { value: 'sha', source: `review.humanClearanceCarryForward=${human?.value} (${human?.source})` };
  }
  if (numbering?.value !== true && resolved.normalizeNumbering.value !== false) {
    resolved.normalizeNumbering = { value: false, source: `review.carryHumanClearanceAcrossNumbering=${numbering?.value} (${numbering?.source})` };
  }
  return resolved;
}

function resolveBindingLeaves({ env, tool, platform }) {
  let review = tool;
  if (review === undefined) { try { review = readSettings()?.review; } catch { review = undefined; } }
  const clearance = review && typeof review === 'object' ? review.clearance : undefined;
  const leaf = (key, standard, valid, envRaw) => {
    try {
      const p = cascadePolicy('review.clearance', clearance && typeof clearance === 'object' ? { [key]: clearance[key] } : undefined, {
        standard: { [key]: standard }, env, ...(platform === undefined ? {} : { platform }),
        valid: { [key]: valid }, envValues: { [key]: envRaw },
      });
      return { value: p.value?.[key] ?? standard, source: p.sources?.[key] ?? 'standard' };
    } catch { return { value: standard, source: 'standard (cascade unreadable)' }; }
  };
  const bindRaw = env?.[CLEARANCE_BIND_TO_ENV];
  return {
    bindTo: leaf('bindTo', 'fingerprint', (v) => BIND_TO.includes(v),
      bindRaw === undefined ? undefined : String(bindRaw).trim().toLowerCase()),
    normalizeNumbering: leaf('normalizeNumbering', true, (v) => typeof v === 'boolean',
      parseBool(env?.[CLEARANCE_NORMALIZE_NUMBERING_ENV])),
  };
}

const logged = new Set();
/** IO: one `policy · review.clearance.*` line per process per distinct effective value (stderr → the daemon log). */
export function logClearanceBindingSettings(settings, write = (s) => process.stderr.write(s)) {
  const key = `${settings?.bindTo?.value}:${settings?.bindTo?.source}:${settings?.normalizeNumbering?.value}:${settings?.normalizeNumbering?.source}`;
  if (logged.has(key)) return;
  logged.add(key);
  write(`policy · review.clearance.bindTo=${settings?.bindTo?.value} (${settings?.bindTo?.source}) · `
    + `review.clearance.normalizeNumbering=${settings?.normalizeNumbering?.value} (${settings?.normalizeNumbering?.source})\n`);
}
/** Test seam. @test-only-export-ok */
export function _resetClearanceBindingLog() { logged.clear(); }

/**
 * PURE: the latest recorded operator clearance on the thread — a trusted comment carrying a full `reviewed-sha` and a
 * named `cleared-human` in THAT SAME comment, with that comment's own fingerprints. A later plain accept does NOT hide
 * it (see the file note); a later clearance replaces it. `null` when none.
 * @returns {{sha:string, diff:string|null, contribution:string|null, actor:string, index:number}|null}
 */
export function latestOperatorClearanceRecord(comments) {
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (!c || typeof c.body !== 'string' || !isTrustedMarkerAuthor(c)) continue;
    const sha = parseReviewedShaMarker(c.body);
    if (!sha) continue;
    const clearance = parseOperatorClearance([c]);
    if (!clearance) continue;
    // Only a full sha can be compared to the live head and fed to git; an abbreviated clearance is sha-unbindable.
    if (!SHA40.test(sha)) return null;
    // Nothing after the record may stand against it for a content-bound (non-sha) cover: a later comment must be a known
    // machine shape / head-move diagnostic (numbering-carry's vocabulary) or a trusted acceptance record (a fresh accept,
    // a re-stamp or carry record — only acceptance writers stamp `reviewed-sha`). Any other comment, from anyone, is a
    // possible hold (the carry's inverted rule).
    const laterStands = list.slice(i + 1).some((l) => {
      const body = typeof l?.body === 'string' ? l.body : '';
      if (isTrustedMarkerAuthor(l) && isAcceptanceRecordBody(body)) return false;
      if (isTrustedMarkerAuthor(l) && MUTUAL_EXCLUSIVITY_HEAL_RE.test(body)) return false;
      return !isNumberingTolerableLaterBody(body);
    });
    const at = typeof c.createdAt === 'string' ? c.createdAt : (typeof c.created_at === 'string' ? c.created_at : null);
    return { sha, diff: parseReviewedDiff([c]), contribution: parseReviewedContribution([c]), actor: clearance.actor, index: i, at, laterStands };
  }
  return null;
}

/**
 * PURE (given pure injections): does the recorded operator clearance cover the live head?
 * @param {{clearance:{sha:string,diff?:string|null,contribution?:string|null,at?:string|null,laterStands?:boolean}|null, liveHead:string,
 *   fingerprintOf?:(sha:string)=>({diff:string|null,contribution:string|null}|null),
 *   proveReplay?:(fromSha:string,toSha:string)=>({ok:boolean,reason?:string}),
 *   numberingProof?:(liveHead:string)=>({ok:boolean,base?:string,reason?:string}),
 *   bindTo?:'fingerprint'|'sha', normalizeNumbering?:boolean, equivalence?:'contribution'|'strict'}} o
 *   `fingerprintOf` MUST read the net diff from git (trusted code), never from a comment.
 * @returns {{covers:boolean, liveHead:string, tier?:'sha'|'fingerprint'|'contribution'|'numbering', reason:string, base?:string}}
 */
export function clearanceCovers(o = {}) {
  const head = String(o?.liveHead ?? '').toLowerCase();
  // The verdict names the head it was computed for, so `clearanceBindsHead` can refuse it for any other head.
  return { ...evaluateClearance(o), liveHead: head };
}

function evaluateClearance({
  clearance = null, liveHead = '', fingerprintOf = null, proveReplay = null, numberingProof = null,
  bindTo = 'fingerprint', normalizeNumbering = true, equivalence = 'contribution', reviews = undefined,
} = {}) {
  const no = (reason) => ({ covers: false, reason });
  const cleared = String(clearance?.sha ?? '').toLowerCase();
  const head = String(liveHead ?? '').toLowerCase();
  if (!SHA40.test(cleared)) return no('no recorded operator clearance with a full reviewed sha');
  if (!SHA40.test(head)) return no('live head unknown');
  if (cleared === head) return { covers: true, tier: 'sha', reason: `the clearance names the live head ${head.slice(0, 9)}` };
  if (bindTo !== 'fingerprint') return no(`review.clearance.bindTo=${bindTo}: the clearance names ${cleared.slice(0, 9)}, not the live head`);
  if (clearance.laterStands === true) return no('a later comment that is not an acceptance or a known machine note stands after the clearance');
  // `reviews` (the PR's formal reviews, or a lazy reader of them) is REQUIRED for any content-bound cover: omitted or
  // unreadable refuses (a standing change request is unproven absent); a standing one refuses (`laterReviewHold`).
  let formal = reviews;
  if (typeof formal === 'function') { try { formal = formal(); } catch { formal = null; } }
  if (!Array.isArray(formal)) return no('the PR\'s formal reviews were not read; a standing change request is unproven absent');
  if (laterReviewHold(formal, clearance.at ?? null)) return no('a formal changes-requested review stands');
  if (typeof fingerprintOf !== 'function') return no('no trusted git fingerprint reader');
  const recorded = { diff: clearance.diff ?? null, contribution: clearance.contribution ?? null };
  const mode = equivalence === 'strict' ? 'strict' : 'contribution';

  // One content proof: X's fingerprint matches the recorded one AND the cleared change replayed onto X's base reproduces
  // X's tree. The replay compares git object ids (every byte, mode and path), so it also closes what the text digests
  // cannot see — a lossy decode (two invalid UTF-8 bytes hash alike) or a relocation (#x413mbt). Both tiers need it.
  const contentProof = (sha) => {
    let live;
    try { live = fingerprintOf(sha); } catch { live = null; }
    if (!live || (!live.diff && !live.contribution)) return no(`net diff at ${sha.slice(0, 9)} unreadable`);
    const match = compareCarryFingerprints({ mode, cleared: recorded, live });
    if (!match.same) return no(match.reason);
    let replay;
    try { replay = typeof proveReplay === 'function' ? proveReplay(cleared, sha) : null; } catch { replay = null; }
    if (!replay?.ok) return no(`${match.reason}, but the replay proof failed: ${replay?.reason || 'unproven'}`);
    return { covers: true, tier: match.tier === 'strict' ? 'fingerprint' : 'contribution', reason: `${match.reason}; ${replay.reason}` };
  };

  const direct = contentProof(head);
  if (direct.covers) return direct;
  if (!normalizeNumbering || typeof numberingProof !== 'function') return direct;
  let proof;
  try { proof = numberingProof(head); } catch { proof = null; }
  const base = String(proof?.base ?? '').toLowerCase();
  if (!proof?.ok || !SHA40.test(base)) return no(`${direct.reason}; numbering: ${proof?.reason || 'no proven drain numbering commits on top'}`);
  if (base === cleared) return { covers: true, tier: 'numbering', base, reason: `the head is the cleared head plus the drain's own numbering (${proof.reason})` };
  const below = contentProof(base);
  if (!below.covers) return no(`${direct.reason}; numbering base ${base.slice(0, 9)}: ${below.reason}`);
  return { covers: true, tier: 'numbering', base, reason: `numbering base ${base.slice(0, 9)} covered (${below.reason}); on top: ${proof.reason}` };
}

