/**
 * Table tests for the head-binding fold (design v2). Each case names the finding or break it pins:
 * #5492 findings 1–5, the red-team break on b0be22ada, Codex design breaks B/C/D/E/F/G, and the legacy table.
 * Writer/reader-contract breaks (B2, B3, B11, C2, W1–W8) are not fold-observable; later slices test them.
 */
import { describe, it, expect } from 'vitest';
import { ledgerAt, rowIdentity } from '../ledger-binding.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), T = 'd'.repeat(40);
const NOW = '2026-10-21T12:00:00.000Z';
const K = `sha256:${'1'.repeat(64)}`;
const D_ = 'e'.repeat(40), X_ = 'f'.repeat(40);

/**
 * Build a ledger. Each spec is a row; `id` defaults to `r<pos>`; `sees: n` becomes seen `"n:<id of row n>"`,
 * `sees: 0` becomes `"empty"`. A `retry: n` row copies row n (same id) with the overrides applied.
 */
function ledger(...specs) {
  const out = [];
  specs.forEach((s, i) => {
    const { sees, retry, ...rest } = s;
    const row = retry ? { ...structuredClone(out[retry - 1]), ...rest } : { id: `r${i + 1}`, ...rest };
    if (sees !== undefined) row.seen = sees === 0 ? 'empty' : `${sees}:${out[sees - 1].id}`;
    out.push(row);
  });
  return out;
}
const v = (verdict, head, extra = {}) => ({ type: 'verdict', verdict, coverage: { headSha: head }, ...extra });
const appr = (head, extra = {}) => ({ type: 'approval', approval: 'clear-human', delegation: null, headSha: head, ...extra });
const sendBack = (head, extra = {}) => ({ type: 'send-back', cause: 'changes', ...(head ? { headSha: head } : {}), ...extra });
const label = (l, extra = {}) => ({ type: 'label-input', label: l, change: 'added', sender: 'nic', ...extra });
const referral = (head, keys = [K], extra = {}) => ({ type: 'referral', headSha: head, findingKeys: keys, ...extra });
const run = (head, extra = {}) => ({ type: 'review-run', headSha: head, phase: 'completed', posted: true, scope: 'full', raised: [], ...extra });
const ruling = (r, extra = {}) => ({ type: 'ruling', findingKey: K, ruling: r, ...extra });
const retire = (extra = {}) => ruling('not-real', { source: 'review-pr', actor: { channel: 'mandatory-referral-retired' }, ...extra });
const proof = (from, to) => ({ v: 1, rule: 'tree-identical', fromHead: from, toHead: to, fromTree: T, toTree: T });
const carried = (to, from, extra = {}) => v('carried', to, { fromHead: from, source: 'merge-ai-prs', proof: proof(from, to), carryHuman: false, ...extra });
const release = (holdSource, reasonCode) => ({ type: 'release', holdSource, reasonCode });

const at = (rows, head, now = NOW) => ledgerAt(rows, head, { now });
const codes = r => r.holds.map(h => h.code);

const CASES = [
  // ── #5492 findings ──
  ['5492-1 a verdict at X counts at X (no observations exist)', ledger(v('accepted', A, { sees: 0 })), A, true],
  ['5492-2 a delayed review of intermediate M does not touch X',
    ledger(v('accepted', B, { sees: 0 }), v('changes', A, { sees: 0 })), B, true],
  ['5492-3 reconcile: a new run at the same head is a new row, not skipped as replay',
    ledger(v('changes', A, { sees: 0, runId: 'r1' }), v('accepted', A, { sees: 1, runId: 'r2' })), A, true],
  ['5492-4/5 an approval at A never makes a human base at B', ledger(v('clear-human', B, { sees: 0 }), appr(A, { sees: 0 })), B, false, ['no-clearance']],
  ['5492-4/5 an approval at A never answers a human hold at B', ledger(v('accepted', B, { sees: 0 }), v('human', B, { sees: 1 }), appr(A, { sees: 2 })), B, false, ['verdict:human']],
  ['5492-red-team accepted(A), force-push back to A, changes(A), send-back(A), accepted(A): held at A',
    ledger(v('accepted', A, { sees: 0 }), v('changes', A, { sees: 1 }), sendBack(A, { sees: 2 }), v('accepted', A, { sees: 3 })), A, false, ['send-back']],
  ['5492-red-team a new head C does not see the send-back of A',
    ledger(v('accepted', A, { sees: 0 }), v('changes', A, { sees: 1 }), sendBack(A, { sees: 2 }), v('accepted', C, { sees: 3 })), C, true],
  ['B12 a targeted operator release frees that one send-back',
    [...ledger(v('accepted', A, { sees: 0 }), sendBack(A, { sees: 1 })), release('send-back', 'r2')], A, true],
  ['B12 a release naming another send-back frees nothing',
    [...ledger(v('accepted', A, { sees: 0 }), sendBack(A, { sees: 1 }), sendBack(A, { sees: 2 })), release('send-back', 'r2')], A, false, ['send-back']],

  // ── round 1 ──
  ['B1 an expired delegated approval leaves its clear-human verdict no base',
    ledger(v('human', A, { sees: 0 }), v('clear-human', A, { sees: 1 }), appr(A, { sees: 1, delegation: { by: 'nic', scope: 'x', expires: '2026-10-21T11:00:00.000Z' } })), A, false],
  ['B1 a delegated approval with no clock is invalid',
    ledger(v('clear-human', A, { sees: 0 }), appr(A, { sees: 0, delegation: { by: 'nic', scope: 'x', expires: '2099-01-01T00:00:00.000Z' } })), A, false, ['no-clearance'], { now: null }],
  ['B1 partial write: clear-human verdict without its approval is no base', ledger(v('clear-human', A, { sees: 0 })), A, false, ['no-clearance']],
  ['B1 clear-human + valid approval is a human base', ledger(v('clear-human', A, { sees: 0 }), appr(A, { sees: 0 })), A, true],
  ['B4 a fresh review never releases an operational hold',
    ledger({ type: 'hold', holdSource: 'drain', reasonCode: 'red-main' }, v('accepted', A, { sees: 1 })), A, false, ['hold:drain:red-main']],
  ['B4 the matching release does', [...ledger({ type: 'hold', holdSource: 'drain', reasonCode: 'red-main' }, v('accepted', A, { sees: 1 })), release('drain', 'red-main')], A, true],
  ['B5 a visit with no complete raised set resolves nothing',
    ledger(v('accepted', B, { sees: 0 }), referral(A, [K], { sees: 1 }), run(B, { sees: 2, raised: undefined })), B, false, ['referral']],
  ['B5 an unposted run resolves nothing', ledger(v('accepted', B, { sees: 0 }), referral(A, [K], { sees: 1 }), run(B, { sees: 2, posted: false })), B, false, ['referral']],
  ['B5 a posted full run at X that saw K and omitted it resolves it', ledger(v('accepted', B, { sees: 0 }), referral(A, [K], { sees: 1 }), run(B, { sees: 2 })), B, true],
  ['B5 a run whose own raised set reopens K holds', ledger(v('accepted', B, { sees: 0 }), run(B, { sees: 1, raised: [K] })), B, false, ['referral']],
  ['B6 concurrent: changes then a delayed accept that never saw it holds',
    ledger(v('changes', A, { sees: 0, runId: 'R2' }), v('accepted', A, { sees: 0, runId: 'R1' })), A, false, ['verdict:changes']],
  ['B6 accept then a delayed changes holds', ledger(v('accepted', A, { sees: 0 }), v('changes', A, { sees: 0 })), A, false, ['verdict:changes']],
  ['B7 a carry never answers the destination rejection',
    ledger(v('changes', B, { sees: 0 }), v('accepted', A, { sees: 0 }), carried(B, A, { sees: 2 })), B, false, ['verdict:changes']],
  ['B8 a later-appended hold with an earlier clock still holds (append order, not at)',
    ledger(v('accepted', A, { sees: 0, at: '2026-10-21T12:00:02Z' }), label('review:human', { at: '2026-10-21T12:00:01Z' })), A, false, ['label-input:review:human']],
  ['B9 an answered hand hold survives a valid human carry',
    ledger(label('review:human'), v('accepted', A, { sees: 1 }), appr(A, { sees: 1 }), carried(B, A, { sees: 3, carryHuman: true })), B, true],
  ['B9 ...but not without carryHuman',
    ledger(label('review:human'), v('accepted', A, { sees: 1 }), appr(A, { sees: 1 }), carried(B, A, { sees: 3 })), B, false, ['label-input:review:human']],
  ['B10 a review exemption at X clears an unreviewed PR', ledger({ type: 'review-exempt', headSha: A, basis: 'no signal' }), A, true],
  ['B10 an exemption does not clear once any bearing verdict exists',
    ledger(v('changes', B, { sees: 0 }), { type: 'review-exempt', headSha: A, basis: 'no signal' }), A, false, ['no-clearance']],
  ['B13 a short-head accept is no base', ledger(v('accepted', A.slice(0, 7), { sees: 0 })), A, false, ['no-clearance']],
  ['B13 a short-head hold verdict is a PR-level hold', ledger(v('accepted', A, { sees: 0 }), v('human', A.slice(0, 7))), A, false, ['headless-verdict:human']],
  ['B13 a short restamp is no base', ledger(v('restamped', A.slice(0, 7))), A, false, ['no-clearance']],
  ['B14 conflicting verdicts under one runId hold', ledger(v('accepted', A, { sees: 0, runId: 'R' }), v('changes', B, { sees: 0, runId: 'R' }), v('accepted', C, { sees: 0 })), C, false, ['run-conflict']],
  ['B15 a carry with an inconsistent proof is no base',
    ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1, proof: { ...proof(A, B), toTree: C } })), B, false, ['no-clearance']],
  ['B15 a carry from an unlisted producer is no base', ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1, source: 'someone' })), B, false, ['no-clearance']],
  ['B15 a valid carry clears', ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1 })), B, true],
  ['carry cycle with no grounded source is no base (cycle guard is defence in depth; memo re-entry also stops it)', ledger(carried(B, A, { sees: 0 }), carried(A, B, { sees: 0, proof: proof(B, A) })), B, false, ['no-clearance']],
  ['carry chain A→B→C clears', ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1 }), carried(C, B, { sees: 2, proof: proof(B, C) })), C, true],

  // ── round 2 ──
  ['C1 a later block rolls back an earlier not-real',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), ruling('not-real', { sees: 2 }), ruling('block', { sees: 3 })), A, false, ['referral']],
  ['C1 latest not-real closes K even when re-raised', ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), ruling('not-real'), referral(A, [K], { sees: 3 })), A, true],
  ['C4 a carry written while the source was held never becomes valid',
    ledger(v('accepted', A, { sees: 0 }), v('changes', A, { sees: 1 }), carried(B, A, { sees: 2 }), v('accepted', A, { sees: 3 })), B, false, ['no-clearance']],
  ['C5 a source cleared through a human approval needs carryHuman',
    ledger(v('accepted', A, { sees: 0 }), v('human', A, { sees: 1 }), v('clear-human', A, { sees: 2 }), appr(A, { sees: 3 }), carried(B, A, { sees: 4 })), B, false, ['no-clearance']],
  ['C6/W7 same explicit id with a different payload holds', [v('accepted', A, { id: 'x', seen: 'empty', runId: 'R' }), v('changes', A, { id: 'x', seen: 'empty', runId: 'R' })], A, false, ['id-conflict']],
  ['C7 a forward seen is bad-seen', ledger(v('accepted', A, { seen: '3:r3' }), v('changes', A, { sees: 1 }), v('observed', A, { sees: 2 })), A, false, ['bad-seen']],
  ['C8 started + completed phases of one run do not conflict',
    ledger(run(A, { phase: 'started', posted: null, sees: 0, runId: 'R', scope: undefined, raised: undefined }), run(A, { sees: 1, runId: 'R' }), v('accepted', A, { sees: 2, runId: 'R' })), A, true],
  ['C9 a later occurrence of K is a new obligation',
    ledger(referral(A, [K], { sees: 0 }), run(B, { sees: 1 }), v('accepted', B, { sees: 2 }), referral(B, [K], { sees: 3 })), B, false, ['referral']],
  ['C10 a retirement then a re-raise holds', ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), retire({ sees: 2 }), referral(A, [K], { sees: 3 })), A, false, ['referral']],
  ['C11 a foreign seen id is bad-seen', ledger(v('accepted', A, { sees: 0 }), v('accepted', A, { seen: '1:foreign-0001' })), A, false, ['bad-seen']],
  ['C11 a seen whose position names a different row is bad-seen', ledger(v('accepted', A, { sees: 0 }), v('observed', A), v('accepted', A, { seen: '2:r1' })), A, false, ['bad-seen']],
  ['C11 a supplied seen:null is bad-seen, not legacy', ledger(v('accepted', A, { seen: null })), A, false, ['bad-seen']],
  ['C11 a released bad-seen row stays legacy (answers nothing)',
    [...ledger(v('changes', A, { sees: 0 }), v('accepted', A, { seen: '9:nope' })), release('bad-seen', 'r2')], A, false, ['verdict:changes']],

  // ── round 3 ──
  ['D1 a same-id hold retry collapses onto its first position (so an earlier release covers it)',
    [...ledger({ type: 'hold', holdSource: 'drain', reasonCode: 'x' }, release('drain', 'x')), { type: 'hold', holdSource: 'drain', reasonCode: 'x', id: 'r1', at: 'later' }, v('accepted', A, { seen: 'empty', id: 'r4' })], A, true],
  ['D1 two distinct-id holds with equal content never collapse',
    [...ledger({ type: 'hold', holdSource: 'drain', reasonCode: 'x' }, release('drain', 'x'), { type: 'hold', holdSource: 'drain', reasonCode: 'x' }, v('accepted', A, { sees: 0 }))], A, false, ['hold:drain:x']],
  ['D1 a same-id retry differing only in at collapses',
    ledger(v('accepted', A, { sees: 0 }), run(A, { sees: 1, at: '2026-10-21T12:01:00Z' }), { retry: 2, at: '2026-10-21T12:02:00Z' }), A, true],
  ['D2 a posted:false→true publication retry is no conflict',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), run(A, { sees: 2, runId: 'R', posted: false }), run(A, { sees: 2, runId: 'R' })), A, true],
  ['D3 a block after the omission run must be seen by a run',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), ruling('not-real', { sees: 2 }), run(A, { sees: 3 }), ruling('block', { sees: 4 })), A, false, ['referral']],
  ['D4 retirement is ignored once K has an explicit block', ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), retire({ sees: 2 }), ruling('block', { sees: 3 })), A, false, ['referral']],
  ['D4 converse: block then retirement still holds', ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), ruling('block', { sees: 2 }), retire({ sees: 3 })), A, false, ['referral']],
  ['D5 retirement closes only occurrences in its seenSet',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), referral(A, [K], { sees: 2 }), retire({ sees: 2 })), A, false, ['referral']],
  ['D5 legacy retirement (no seen) closes nothing', ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), retire()), A, false, ['referral']],
  ['D6 a hand hold answered at the carried head keeps the carry',
    ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1, carryHuman: true }), label('review:human', { sees: 2 }), appr(B, { sees: 3 })), B, true],
  ['C4 a later changes at the source breaks a carry written while it was clear',
    ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1 }), v('changes', A, { sees: 2 })), B, false, ['no-clearance']],
  ['D7 an exempt source cannot be carried (the carry row also voids the exemption)', ledger({ type: 'review-exempt', headSha: A, basis: 'x', seen: 'empty' }, carried(B, A, { sees: 1 })), B, false, ['no-clearance']],
  ['D8 later human dependence at the source needs carryHuman',
    ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1 }), v('human', A, { sees: 2 }), appr(A, { sees: 3 })), B, false, ['no-clearance']],

  // ── rounds 4–6 ──
  ['E1 an approval-backed answer to a non-human label needs carryHuman',
    ledger(v('accepted', A, { sees: 0 }), label('review:changes'), { ...appr(A, { approval: 'clear-operator' }), sees: 2 }, carried(B, A, { sees: 3 })), B, false, ['label-input:review:changes']],
  ['E2 posted evidence never combines across a released run conflict',
    [...ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), run(A, { sees: 2, runId: 'S', posted: false }), run(B, { sees: 3, runId: 'S' })), release('run-conflict', 'S')], A, false, ['referral']],
  ['E3 a release does not cover a later collision',
    [v('accepted', A, { id: 'x', seen: 'empty' }), v('accepted', B, { id: 'x', seen: 'empty' }), release('id-conflict', 'x'), v('accepted', C, { id: 'x', seen: '3:r3' })].map((r, i) => (i === 2 ? { ...r, id: 'r3' } : r)), C, false, ['id-conflict']],
  ['E3 a run-conflict release does not cover a later distinct payload',
    [...ledger(v('accepted', A, { sees: 0, runId: 'R' }), v('changes', A, { sees: 0, runId: 'R' }), v('accepted', A, { sees: 2 })), release('run-conflict', 'R'), v('pending', B, { seen: 'empty', runId: 'R' }), v('accepted', A, { seen: '3:r3' })], A, false, ['run-conflict']],
  ['E3 the release covers the conflict present before it', [v('accepted', A, { id: 'x', seen: 'empty' }), v('accepted', B, { id: 'x', seen: 'empty' }), { ...release('id-conflict', 'x'), id: 'r3' }], A, true],
  ['F1 a same-id posted:true retry is the publication witness',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), run(A, { sees: 2, posted: false }), { retry: 3, posted: true }), A, true],
  ['F2 publication after the carry is not transferred',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), run(A, { sees: 2, runId: 'R', posted: false }), carried(B, A, { sees: 3 }), run(A, { sees: 2, runId: 'R' })), B, false, ['referral']],
  ['F2 a same-id publication retry after the carry is not transferred',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), run(A, { sees: 2, posted: false }), carried(B, A, { sees: 3 }), { retry: 3, posted: true }), B, false, ['referral']],
  ['F2 publication before the carry is transferred',
    ledger(v('accepted', A, { sees: 0 }), referral(A, [K], { sees: 1 }), run(A, { sees: 2 }), carried(B, A, { sees: 3 })), B, true],
  ['G1 a publication retry does not hide rows between it and its first copy',
    ledger(run(A, { sees: 0, runId: 'ru', posted: false }), v('changes', A, { sees: 1, runId: 'rq' }), { retry: 1, posted: true }, v('accepted', A, { sees: 3, runId: 'ra' })), A, true],

  // ── slice audit (round 1) ──
  ['audit-1 a pre-carry transfer is never spliced with a post-carry replacement answer',
    ledger(v('accepted', A, { sees: 0 }), label('review:changes'), v('accepted', A, { sees: 2 }), carried(B, A, { sees: 3 }), carried(C, B, { sees: 4, proof: proof(B, C) }), v('changes', A, { sees: 5 }), v('accepted', B, { sees: 6 })), C, false, ['label-input:review:changes']],
  ['audit-2 a malformed referral payload holds', ledger(v('accepted', A, { sees: 0 }), { type: 'referral', headSha: A, findingKeys: 'K' }), A, false, ['malformed-row']],
  ['audit-2 an empty hold/release pair holds', ledger(v('accepted', A, { sees: 0 }), { type: 'hold' }, { type: 'release' }), A, false, ['malformed-row']],
  ['audit-2 a malformed delegation holds', ledger(v('clear-human', A, { sees: 0 }), appr(A, { sees: 0, delegation: false })), A, false, ['malformed-row']],
  ['audit-3 a verdict head outside coverage is headless', [{ type: 'verdict', verdict: 'accepted', headSha: A, seen: 'empty' }], A, false, ['no-clearance']],
  ['audit-3 an uppercase or padded row head is not bound', ledger(v('accepted', A.toUpperCase(), { sees: 0 }), v('accepted', ` ${A} `, { sees: 0 })), A, false, ['no-clearance']],
  ['audit-3 a proof head that differs by padding is no carry', ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1, proof: { ...proof(A, B), fromHead: ` ${A}` } })), B, false, ['no-clearance']],
  ['audit-5 a -Infinity clock does not authorize a delegated approval',
    ledger(v('clear-human', A, { sees: 0 }), appr(A, { sees: 0, delegation: { by: 'n', scope: 's', expires: '2000-01-01T00:00:00.000Z' } })), A, false, ['no-clearance'], { now: -Infinity }],
  ['audit-7 a valid carry answer is used even when the base is a review',
    ledger(label('review:changes'), v('accepted', A, { sees: 1 }), v('accepted', B, { sees: 0 }), carried(B, A, { sees: 2 })), B, true],
  ['audit-7 a second carry answer is not hidden by the first carry',
    ledger(label('review:changes'), v('accepted', A, { sees: 0 }), v('accepted', B, { sees: 1 }), carried(C, A, { sees: 3, proof: proof(A, C) }), carried(C, B, { sees: 4, proof: proof(B, C) })), C, true],
  // ── slice audit (round 2) ──
  ['audit2-1 nested carries: a prefix path and a different current path are never spliced',
    ledger(label('review:changes'), v('accepted', A, { sees: 1 }), v('accepted', D_, { sees: 1 }), carried(B, A, { seen: 'empty' }), carried(B, D_, { seen: 'empty', proof: proof(D_, B) }),
      v('changes', D_, { seen: 'empty' }), carried(X_, B, { seen: 'empty', proof: proof(B, X_) }), v('changes', A, { seen: 'empty' }), v('accepted', D_, { sees: 8 })), X_, false, ['label-input:review:changes']],
  ['audit2-2 a numeric coverage head is malformed', [v('accepted', A, { seen: 'empty' }), { type: 'verdict', verdict: 'accepted', coverage: { headSha: 42 } }], A, false, ['malformed-row']],
  ['audit2-2 an array coverage is malformed', [v('accepted', A, { seen: 'empty' }), { type: 'verdict', verdict: 'accepted', coverage: [] }], A, false, ['malformed-row']],
  ['audit2-4 a redundant direct approval does not hide a transferable non-human path',
    ledger(label('review:changes'), v('accepted', A, { sees: 1 }), v('accepted', B, { sees: 0 }), appr(B, { sees: 1 }), carried(B, A, { sees: 0 }), carried(X_, B, { sees: 0, proof: proof(B, X_) })), X_, true],
  ['judge approvals answer nothing', ledger(v('clear-human', A, { sees: 0 }), appr(A, { sees: 0, approval: 'judge' })), A, false, ['no-clearance']],
  ['multihop: an approval answer carried twice needs carryHuman at every link',
    ledger(label('review:human'), v('accepted', A, { sees: 1 }), appr(A, { sees: 1 }), carried(B, A, { sees: 3, carryHuman: true }), carried(C, B, { sees: 4, proof: proof(B, C) })), C, false, ['label-input:review:human']],
  ['multihop: carryHuman at every link carries it', ledger(label('review:human'), v('accepted', A, { sees: 1 }), appr(A, { sees: 1 }), carried(B, A, { sees: 3, carryHuman: true }), carried(C, B, { sees: 4, proof: proof(B, C), carryHuman: true })), C, true],

  // ── legacy table ──
  ['legacy headless accept is no base', ledger(v('accepted', null)), A, false, ['no-clearance']],
  ['legacy headless changes binds every head', ledger(v('changes', null), v('accepted', A, { sees: 1 })), A, true],
  ['legacy headless changes without a seeing answer holds', ledger(v('changes', null), v('accepted', A)), A, false, ['headless-verdict:changes']],
  ['legacy no-seen accept is a base but answers nothing', ledger(v('pending', A), v('accepted', A)), A, false, ['verdict:pending']],
  ['legacy headless approval answers nothing', ledger(v('accepted', A, { sees: 0 }), v('human', A, { sees: 1 }), appr(undefined, { sees: 2 })), A, false, ['verdict:human']],
  ['a short-head approval answers nothing', ledger(v('accepted', A, { sees: 0 }), v('human', A, { sees: 1 }), appr(A.slice(0, 7), { sees: 2 })), A, false, ['verdict:human']],
  ['legacy headless send-back: a fresh accept that saw it discharges', ledger(sendBack(null), v('accepted', A, { sees: 1 })), A, true],
  ['legacy head-moved rows are ignored', ledger(v('accepted', A, { sees: 0 }), v('head-moved', B)), A, true],
  ['legacy 40-hex restamp is a base at its own head only', ledger(v('restamped', A)), A, true],
  ['legacy 40-hex restamp never answers a hold', ledger(v('changes', A, { sees: 0 }), v('restamped', A, { sees: 1 })), A, false, ['verdict:changes']],
  ['force-push back to an accepted head with no obligation clears again',
    ledger(v('accepted', A, { sees: 0 }), v('changes', B, { sees: 1 })), A, true],
];

describe('ledgerAt — head-binding fold (design v2)', () => {
  it.each(CASES)('%s', (_name, rows, head, clears, mustHold = [], opts = { now: NOW }) => {
    const r = ledgerAt(rows, head, opts);
    expect(r.clears, JSON.stringify(r.holds)).toBe(clears);
    for (const c of mustHold) expect(codes(r)).toContain(c);
  });

  it('fails closed on an unknown, short or uppercase live head', () => {
    const rows = ledger(v('accepted', A, { sees: 0 }));
    for (const h of [undefined, '', A.slice(0, 7), A.toUpperCase(), 'zz'.repeat(20)]) expect(at(rows, h).holds[0].code).toBe('head-unknown');
  });
  it('fails closed on a malformed row or a non-array', () => {
    expect(codes(at([v('accepted', A, { seen: 'empty' }), 42], A))).toContain('malformed-row');
    expect(codes(at([v('weird', A)], A))).toContain('malformed-row');
    expect(codes(at([{ ...v('accepted', A, { seen: 'empty' }), type: null }], A))).toContain('malformed-row');
    expect(ledgerAt(null, A).holds[0].code).toBe('ledger-unreadable');
  });
  it('is deterministic: the same rows give the same answer', () => {
    const rows = ledger(v('accepted', A, { sees: 0 }), carried(B, A, { sees: 1 }));
    expect(at(rows, B)).toEqual(at(rows, B));
  });
  it('reports humanDependent for a human base and for a carried human answer', () => {
    expect(at(ledger(v('clear-human', A, { sees: 0 }), appr(A, { sees: 0 })), A).humanDependent).toBe(true);
    expect(at(ledger(v('accepted', A, { sees: 0 })), A).humanDependent).toBe(false);
    const carriedAnswer = at(ledger(label('review:human'), v('accepted', A, { sees: 1 }), appr(A, { sees: 1 }), carried(B, A, { sees: 3, carryHuman: true })), B);
    expect(carriedAnswer).toMatchObject({ clears: true, base: 'carry', humanDependent: true });
    // audit2-3: a referral answered at a human-based source, carried, is human-dependent even under a review base
    const viaHumanSource = at(ledger(referral(A, [K], { sees: 0 }), v('clear-human', A, { sees: 0 }), appr(A, { sees: 0 }), run(A, { sees: 1 }),
      carried(B, A, { sees: 4, carryHuman: true }), v('accepted', B, { sees: 0 })), B);
    expect(viaHumanSource).toMatchObject({ clears: true, base: 'review', humanDependent: true });
  });
  it('reports the base alternative', () => {
    expect(at(ledger(v('accepted', A, { sees: 0 })), A).base).toBe('review');
    expect(at(ledger(v('clear-human', A, { sees: 0 }), appr(A, { sees: 0 })), A).base).toBe('human');
    expect(at(ledger({ type: 'review-exempt', headSha: A, basis: 'x' }), A).base).toBe('exempt');
    expect(at(ledger(v('restamped', A)), A).base).toBe('carry');
  });
  it('caps a carry chain at 16 links', () => {
    const h = i => i.toString(16).padStart(2, '0').repeat(20);
    const rows = [v('accepted', h(0), { id: 'c0', seen: 'empty' })];
    for (let i = 1; i <= 17; i++) rows.push(carried(h(i), h(i - 1), { id: `c${i}`, seen: `${i}:c${i - 1}`, proof: proof(h(i - 1), h(i)) }));
    expect(at(rows, h(16)).clears).toBe(true);
    expect(at(rows, h(17)).holds.map(x => x.code)).toContain('no-clearance');
  });
  it('is total: null opts and a no-id row identity both work', () => {
    expect(ledgerAt(ledger(v('accepted', A, { sees: 0 })), A, null).clears).toBe(true);
    const first = v('changes', A, { seen: 'empty', unlocked: true });
    expect(rowIdentity(first)).toBe(rowIdentity({ ...first, unlocked: false })); // `unlocked` is not identity
    expect(rowIdentity(first)).not.toBe(rowIdentity({ ...first, seen: '1:x' })); // `seen` is
    expect(rowIdentity(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rowIdentity({ ...first, id: 'explicit-1' })).toBe('explicit-1');
    const rows = [first, v('accepted', A, { seen: `1:${rowIdentity({ ...first, unlocked: false })}` })];
    expect(at(rows, A).clears).toBe(true);
  });
});
