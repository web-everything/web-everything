/**
 * @file scripts/operations/record-referral-ruling.mjs
 * @description THE `record-referral-ruling` DECLARATION (#4979) — the sanctioned way to record an OPERATOR's
 *   block / card / not-real ruling on a PR's mandatory referrals (CONFIRMED broken/unrecoverable findings).
 *
 * WHY. A mandatory referral holds `review-set-label.mjs --to=clear-human` until each finding has a
 * finding-specific ruling. The only writer of rulings was the assigned independent reviewer (its id is derived
 * from the referral run). When the OPERATOR ruled — PR #3771, 2026-10-04: "card" on the remaining protected-list
 * findings, follow-up card xvm9vbu — nothing could record it, and the PR could not move. Hand-posting a ruling
 * comment would be a forged record. This operation is the one writer; the gate
 * (we:scripts/lib/jury-core.mjs#mandatoryReferralState) reads what it writes.
 *
 *   | step    | kind      | does                                                                           |
 *   |---------|-----------|--------------------------------------------------------------------------------|
 *   | `read`  | `compute` | the PR's live head, body and comments, plus the resolved `--card` reference   |
 *   | `plan`  | `compute` | THE VERDICT: the open findings on the live head, the ones selected, the record |
 *   | `write` | `effect`  | posts the one comment, then reads the thread back and proves the gate sees it  |
 *
 * WHAT IT REFUSES (every refusal is a thrown error naming why; nothing is posted):
 *   - an actor that is not a registered operator login, a blank `--reason` (the operator's words, verbatim),
 *     a blank or multi-line `--channel`;
 *   - `--ruling=card` without a card that resolves to a readable we:backlog card in this checkout, or a
 *     `--card` on any other ruling;
 *   - a selection naming nothing open on the live head (the head is pinned at read time; the write re-checks it);
 *   - a malformed referral thread (the gate already holds it; a ruling cannot repair a broken record).
 *
 * `--finding` selects from the OPEN findings on the live head (pending or blocked), numbered from 1 in thread
 * order: `all-open`, a comma list of numbers (`1,3`), `<file>:<line>`, `<file>` (no line), or one exact finding key.
 * `--preview` plans and prints without posting.
 *
 * SUPERSEDING A CARRIED RULING (held item 132, live #4271 and #4361). A `block` carried onto a new head leaves the
 * finding neither pending nor blocked, so the selection above finds nothing and the operator's later `card` or
 * `not-real` could not be recorded, while the dispute and `advisory:ruling-needed` stayed up. `--supersedes=<id[,id]>`
 * names the standing ruling(s) to replace (a reviewer ruling's `id`, or `operator:<head>:<hash>`; the refusal lists
 * them). Then `--finding` selects among the findings of the live head that those ids stand on, and each recorded
 * ruling carries the ids it supersedes. Only this operator path writes it (actor is a registered operator login,
 * `--reason` the operator's quoted words); a reviewer ruling never gains this power. An id that names no standing
 * ruling on the live head, or that no selected finding uses, refuses.
 *
 * FOLLOW-UP (plateau-app #202, 2026-10-04). Once this ruling leaves no pending finding on the head: any `block`
 * sends the PR back through review-set-label's own `--to=changes` path (listing each blocked finding and its
 * rationale); otherwise the posted ruling wakes the paused review. Both clear `advisory:ruling-needed`.
 * Set `--sendBack=false` or `WE_REFERRAL_RULING_FOLLOW_UP=0` to disable this follow-up (enabled by default).
 *
 * PURE. The reader and the sink live in `./record-referral-ruling-io.mjs`.
 */

import { FALSE_FINDING_CAUSES } from '../lib/false-finding-causes.mjs';
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import {
  sameRepo, activeReferrals, buildOperatorRulingComment, mandatoryReferralState, referralRecordState,
  validateOperatorRuling, OPERATOR_RULING_RESULTS, AUTO_POLICY_ACTOR, operatorRulingId, sameFindingForClearing,
  readReferralRecords, readOperatorRulings, carriedBackingHolds, sameReferralForPolicy, referralRecheck,
} from '../lib/jury-core.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { ignoredRulings } from '../lib/ruling-ledger.mjs';

export const RECORD_REFERRAL_RULING_OP = 'record-referral-ruling';
export const OPERATOR_RULING_POST_EFFECT = 'github.operator-referral-ruling';
export const OPERATOR_RULING_FOLLOW_UP_EFFECT = 'github.operator-referral-ruling-follow-up';
/** Mirrors the derived label of PR #3889's ruling-needed sweep. */
export const RULING_NEEDED_LABEL = 'advisory:ruling-needed';

/** Every `state` an open finding can carry. A new state goes here and into exactly one predicate below. */
export const OPEN_FINDING_STATES = Object.freeze({ PENDING: 'pending', NEEDS_RECHECK: 'needs-recheck', BLOCKED: 'blocked' });
const AWAITING_STATES = new Set([OPEN_FINDING_STATES.PENDING, OPEN_FINDING_STATES.NEEDS_RECHECK]);
/** Still waiting on an answer (operator ruling or reviewer re-check), so a ruling elsewhere must re-arm. PURE. */
export const isAwaitingRuling = (o) => AWAITING_STATES.has(o?.state);
/** Held by a standing `block`. PURE. */
export const isBlockedFinding = (o) => o?.state === OPEN_FINDING_STATES.BLOCKED;

/**
 * The findings still open on `head`: every active referral of a current-head record that the gate leaves
 * pending or blocked. Numbered from 1 in thread order. PURE.
 */
export function openReferralFindings({ comments, repo, pr, head, body = '', createdAt = '', cardReadable = () => false,
  unchangedFinding = () => null, autoPolicyRespectsNotReal = true }) {
  const context = { repo, pr, head, body, createdAt, cardReadable };
  const state = mandatoryReferralState(comments, context);
  // Unlike the gate's current-head hold, automatic writes require sound historical proof too.
  const protectionMalformed = readReferralRecords(comments).malformed || readOperatorRulings(comments).malformed;
  const protection = new Map();
  const policyTargets = [];
  const open = [];
  const ruled = [];
  for (const record of state.records) {
    if (record.head !== head || record.repo !== repo || record.pr !== Number(pr)) continue;
    const s = referralRecordState(record, { ...context, records: state.records, operatorRulings: state.operatorRulings });
    const held = new Set([...s.pending, ...s.blocked]);
    for (const f of activeReferrals(record)) {
      const proof = operatorProtection(f, record, state, unchangedFinding, autoPolicyRespectsNotReal);
      const recheck = referralRecheck(record, f.key);
      if (recheck && s.pending.includes(f.key)) proof.protectionUnknown.push('needs re-check on live head');
      protection.set(JSON.stringify([record.runId, f.key]), proof);
      policyTargets.push({ runId: record.runId, key: f.key, seat: f.seat, file: f.finding?.file ?? '',
        line: Number.isInteger(f.finding?.line) ? f.finding.line : null, summary: f.finding?.summary ?? '' });
      if (!held.has(f.key)) {
        const standing = standingRulings(f, record, state);
        if (standing.length) ruled.push({ runId: record.runId, key: f.key, seat: f.seat, file: f.finding?.file ?? '',
          line: Number.isInteger(f.finding?.line) ? f.finding.line : null, summary: f.finding?.summary ?? '',
          state: 'ruled', rulingIds: standing.map((x) => x.id), standing });
      }
      if (held.has(f.key)) {
        const blocked = s.blocked.includes(f.key);
        const effective = s.rulings.filter((r) => r.key === f.key).at(-1);
        open.push({ index: open.length + 1, runId: record.runId, key: f.key, seat: f.seat,
          file: f.finding?.file ?? '', line: Number.isInteger(f.finding?.line) ? f.finding.line : null,
          summary: f.finding?.summary ?? '',
          state: blocked ? OPEN_FINDING_STATES.BLOCKED : recheck ? OPEN_FINDING_STATES.NEEDS_RECHECK : OPEN_FINDING_STATES.PENDING,
          rationale: blocked ? (effective?.rationale ?? effective?.reason ?? '') : '' });
      }
    }
  }
  // The ruling-dispute's findings (a `block` carried onto this head): valid targets for a superseding ruling even though
  // the gate holds nothing "open". Each names the standing ruling that IS the disputed block (`blockIds`).
  const dispute = ignoredRulings({ number: Number(pr), headRefOid: head, body, createdAt, comments });
  const disputed = [];
  for (const m of dispute?.matches ?? []) {
    const hit = ruled.find((r) => r.key === m.finding.key && (!m.runId || r.runId === m.runId))
      ?? ruled.find((r) => r.key === m.finding.key);
    const blockIds = m.blockRulingId ? [m.blockRulingId] : [];
    const base = hit ?? { runId: m.runId, key: m.finding.key, seat: m.finding.seat, file: m.finding.file ?? '',
      line: Number.isInteger(m.finding.line) ? m.finding.line : null, summary: m.finding.summary ?? '', state: 'ruled',
      rulingIds: [], standing: [] };
    if (!base.runId) continue;
    const rulingIds = [...new Set([...base.rulingIds, ...blockIds])];
    const standing = [...base.standing, ...blockIds.filter((id) => !base.rulingIds.includes(id)).map((id) => ({ id, result: 'block', source: 'record' }))];
    disputed.push({ ...base, state: 'disputed', rulingIds, standing, blockIds });
  }
  const withProtection = (targets) => targets.map((target) => ({ ...target,
    ...(protection.get(JSON.stringify([target.runId, target.key]))
      ?? { protectingRulings: [], protectionUnknown: ['missing current-head source record'] }) }));
  return { open: withProtection(open), ruled: withProtection(ruled), disputed: withProtection(disputed),
    policyTargets: withProtection(policyTargets), protectionMalformed, malformed: state.malformed, pending: state.pending, blocked: state.blocked };
}

const view = (f) => ({ file: f?.finding?.file, line: f?.finding?.line, summary: f?.finding?.summary,
  verdict: f?.finding?.verdict, impactIfUnfixed: f?.finding?.impactIfUnfixed });

/** Authenticated operator provenance and counted reviewer negatives; a policy skip never grants clearance. */
function operatorProtection(target, record, state, unchangedFinding, autoPolicyRespectsNotReal) {
  const protectingRulings = [], protectionUnknown = [];
  const subject = (x) => sameRepo(x.repo, record.repo) && x.pr === record.pr;
  const sourceOf = (o) => state.records.find((r) => subject(r) && r.head === o.head && r.runId === o.runId)
    ?.referrals.find((f) => f.key === o.key);
  const operators = state.operatorRulings.filter((o) => subject(o) && OPERATOR_LOGINS.includes(o.actor.toLowerCase()));
  for (const o of operators) {
    const source = sourceOf(o);
    // Without the source we cannot disprove equivalence, even if the serialized keys differ.
    if (!source) { protectionUnknown.push(`missing source ${o.head}/${o.runId}/${o.key}`); continue; }
    if (!(autoPolicyRespectsNotReal && o.result === 'not-real' && sameReferralForPolicy(source, target))
      && source.key !== target.key && !sameFindingForClearing(view(source), view(target))) continue;
    if (o.head !== record.head) {
      let unchanged = null;
      try { unchanged = unchangedFinding({ repo: record.repo, base: o.head, head: record.head,
        source: view(source), target: view(target) }); } catch { /* Unknown proof refuses an automatic write. */ }
      if (unchanged !== true && unchanged !== false) {
        protectionUnknown.push(`unavailable comparison ${o.head}/${o.runId}/${o.key}`); continue;
      }
      if (!unchanged) continue;
    }
    protectingRulings.push({ id: operatorRulingId(o), repo: o.repo, pr: o.pr, head: o.head,
      runId: o.runId, key: o.key, actor: o.actor, result: o.result });
  }
  if (autoPolicyRespectsNotReal) for (const sourceRecord of state.records) {
    if (!subject(sourceRecord)) continue;
    for (const ruling of sourceRecord.rulings) {
      if (ruling.result !== 'not-real') continue;
      // Policy remembers any independently authored negative, even if an old auto-block later masked it.
      // This is write protection only: the gate still resolves the complete ruling history normally.
      const historical = { ...sourceRecord, carried: undefined,
        rulings: [{ ...ruling, supersedes: undefined, sameAs: undefined }] };
      const counted = referralRecordState(historical, { head: sourceRecord.head }).rulings;
      if (!counted.some(r => r.id === ruling.id)) continue;
      const source = sourceRecord.referrals.find(f => f.key === ruling.key);
      if (!source || (!sameReferralForPolicy(source, target) && !sameFindingForClearing(view(source), view(target)))) continue;
      if (sourceRecord.head !== record.head) {
        let unchanged = null;
        try { unchanged = unchangedFinding({ repo: record.repo, base: sourceRecord.head, head: record.head,
          source: view(source), target: view(target) }); } catch { /* Refuse without proof. */ }
        if (unchanged === false) continue;
        if (unchanged !== true) { protectionUnknown.push(`unavailable comparison ${sourceRecord.head}/${sourceRecord.runId}/${source.key}`); continue; }
      }
      protectingRulings.push({ id: ruling.id, repo: record.repo, pr: record.pr, head: sourceRecord.head,
        runId: sourceRecord.runId, key: source.key, actor: 'reviewer', result: 'not-real' });
    }
  }
  for (const carry of record.carried ?? []) {
    if (carry.key !== target.key || carry.from.rulingId !== undefined) continue; // Reviewer provenance is checked against the source record above.
    const backing = carriedBackingHolds(carry, { repo: record.repo, pr: record.pr, operatorRulings: state.operatorRulings });
    if (!backing || !sourceOf(backing)) protectionUnknown.push(`unbacked operator carry ${carry.from.runId}/${carry.from.key}`);
    else if (!sameFindingForClearing(view(sourceOf(backing)), view(target))) protectionUnknown.push('operator carry source does not match target');
  }
  return { protectingRulings, protectionUnknown };
}

/** Stable diagnostics used by both the operation result and the sink warning channel. */
export const describePolicySkip = (skip) => `auto-policy skip ${skip.repo}#${skip.pr} head ${skip.head} run ${skip.runId} key ${skip.key}: `
  + skip.protectingRulings.map((r) => `${r.id} (${r.actor} ${r.result}, ${r.head}/${r.runId}/${r.key})`).join(', ');

/** Preserve open numbering before appending protected ruled/disputed targets for automatic selection. */
export function automaticPolicyTargets(read) {
  const targets = [...read.open];
  for (const target of [...(read.ruled ?? []), ...(read.disputed ?? []), ...(read.policyTargets ?? [])]) {
    if (targets.some((t) => t.runId === target.runId && t.key === target.key)) continue;
    if (target.protectingRulings?.length || target.protectionUnknown?.length) targets.push({ ...target, index: targets.length + 1 });
  }
  return targets;
}

/** State relevant to automatic protection, pinned across the read/plan/write boundary. */
export const policyProtectionSnapshot = (read) => automaticPolicyTargets(read).map((o) => ({ runId: o.runId, key: o.key,
  protectingRulings: o.protectingRulings, protectionUnknown: o.protectionUnknown }))
  .sort((a, b) => JSON.stringify([a.runId, a.key]).localeCompare(JSON.stringify([b.runId, b.key])));

/**
 * Every ruling that still stands on `f` (a referral of a current-head record), from any head: the record's own
 * rulings, the reviewer ruling a `carried` entry came from, earlier-head rulings on the same finding, and the
 * operator's own. Each has the id another ruling can cite in `supersedes`. PURE.
 */
export function standingRulings(f, record, state) {
  const out = new Map();
  const add = (id, result, source) => { if (id && !out.has(id)) out.set(id, { id, result, source }); };
  for (const r of record.rulings) if (r.key === f.key) add(r.id, r.result, 'record');
  for (const c of record.carried ?? []) if (c.key === f.key) add(c.from?.rulingId, c.result, 'carried');
  const referralOf = (runId, head, key) => state.records.find((x) => x.runId === runId && x.head === head)
    ?.referrals.find((x) => x.key === key);
  const same = (g) => g && (g.key === f.key || sameFindingForClearing(view(g), view(f)));
  for (const other of state.records) {
    for (const r of other.rulings) if (same(other.referrals.find((x) => x.key === r.key))) add(r.id, r.result, 'record');
  }
  for (const o of state.operatorRulings ?? []) {
    if (same(referralOf(o.runId, o.head, o.key))) add(operatorRulingId(o), o.result, 'operator');
  }
  return [...out.values()];
}

/** Would `finding` select something in `list`? PURE. */
function selectsOpen(list, finding) {
  try { return selectFindings(list ?? [], finding).length > 0; } catch { return false; }
}

/** Pick the selected open findings. PURE; throws on a selection that names nothing or something not open. */
export function selectFindings(open, finding) {
  const sel = String(finding ?? '').trim();
  if (!sel) throw new Error('--finding is required: all-open, a comma list of open-finding numbers, <file>:<line>, <file>, or one exact key');
  if (sel === 'all-open') {
    if (!open.length) throw new Error('no open mandatory-referral findings on the live head — nothing to rule on');
    return open;
  }
  if (/^\d+(,\d+)*$/.test(sel)) {
    const picked = [...new Set(sel.split(',').map(Number))].map((n) => {
      const hit = open.find((o) => o.index === n);
      if (!hit) throw new Error(`--finding=${n} is not an open finding on the live head (open: 1..${open.length})`);
      return hit;
    });
    return picked;
  }
  const hits = open.filter((o) => o.key === sel);
  if (hits.length) return hits;
  const location = /^(.+):(\d+)$/.exec(sel);
  const matches = open.filter((o) => location
    ? o.file === location[1] && o.line === Number(location[2])
    : o.file === sel && o.line == null);
  if (matches.length === 1) return matches;
  const list = (entries) => entries.map((o) => `  ${o.index}. ${o.seat} ${findingLocation(o)} — ${o.summary}`).join('\n');
  if (matches.length > 1) throw new Error(`--finding=${sel} is ambiguous:\n${list(matches)}\nPick by number.`);
  throw new Error(`--finding=${sel} matches no open finding on the live head. Open:\n${list(open)}`);
}

/** Render a finding's location. PURE. */
const findingLocation = ({ file, line }) => `${file ?? ''}${line == null ? '' : `:${line}`}`;

/** Decide the handoff after the last pending ruling, preserving blocks from other findings. PURE. */
export function planRulingFollowUp({ open, selected, ruling, reason, enabled, head, actor = '' }) {
  if (!enabled) return null;
  const isSelected = (o) => selected.some((s) => s.runId === o.runId && s.key === o.key);
  // Findings still waiting on a ruling after this one. The ruling comment itself wakes the paused review (the hold
  // reads it as a wake), so the review re-runs on this head and posts a fresh advisory; it just cannot clear the
  // label or send anything back yet. Say so, with the exact remaining set, instead of returning nothing.
  // A reviewer-owned re-check counts too: it has no answer yet, so the PR is not settled.
  const remaining = open.filter((o) => isAwaitingRuling(o) && !isSelected(o));
  if (remaining.length) return { action: 'rearm', remaining: remaining.map((o) => ({ seat: o.seat, file: o.file, line: o.line, summary: o.summary })) };
  const blocked = open.filter((o) => isSelected(o) ? ruling === 'block' : isBlockedFinding(o))
    .map((o) => ({ seat: o.seat, file: o.file, line: o.line, summary: o.summary,
      rationale: isSelected(o) ? reason : o.rationale }));
  if (!blocked.length) return { action: 'resume' };
  const prose = (s) => String(s ?? '').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').replace(/\s+/g, ' ').trim();
  const byPolicy = actor === AUTO_POLICY_ACTOR;
  const body = `### Blocked referral findings (${byPolicy ? 'automatic policy ruling' : 'operator ruling'})\n\n`
    + `${byPolicy ? 'Policy (review.referralDefault=auto-block) ruled' : 'The operator ruled'} these mandatory-referral findings \`block\` on head \`${head}\`. Fix each one, then push.\n\n`
    + blocked.map((o, i) => `${i + 1}. \`${findingLocation(o)}\` (${o.seat}) — ${prose(o.summary)}`
      + (prose(o.rationale) ? `\n   Rationale: ${prose(o.rationale)}` : '')).join('\n');
  return { action: 'send-back', blocked, body };
}

/** THE VERDICT. Build and validate the record; refuse anything the gate would not honour. PURE. */
export function planOperatorRuling(read, input) {
  const { repo, pr, finding, ruling, actor, channel, reason } = input;
  if (!OPERATOR_RULING_RESULTS.includes(ruling)) throw new Error(`--ruling must be one of ${OPERATOR_RULING_RESULTS.join('|')}`);
  if (input.cause !== undefined && (ruling !== 'not-real' || !FALSE_FINDING_CAUSES.includes(input.cause))) throw new Error('--cause requires not-real and a known false-finding cause');
  const byPolicy = String(actor ?? '').toLowerCase() === AUTO_POLICY_ACTOR;
  if (byPolicy && ruling !== 'block') throw new Error(`--actor=${AUTO_POLICY_ACTOR} may only rule \`block\`; card and not-real are the operator's`);
  if (!byPolicy && !OPERATOR_LOGINS.includes(String(actor ?? '').toLowerCase())) {
    throw new Error(`--actor must be a registered operator login (${OPERATOR_LOGINS.join(', ')}); this ruling is the operator's`);
  }
  if (!String(reason ?? '').trim()) throw new Error('--reason is required: the operator\'s words, verbatim');
  if (!String(channel ?? '').trim() || /[\r\n]/.test(channel)) throw new Error('--channel is required and must be one line');
  if (ruling === 'card' && !read.card) throw new Error('--ruling=card requires --card=<id or we:backlog path> naming a readable backlog card');
  if (ruling === 'card' && !read.card.readable) throw new Error(`--card ${read.card.requested} does not resolve to a readable backlog card in this checkout (${read.card.reason})`);
  if (ruling !== 'card' && read.card) throw new Error('--card applies only to --ruling=card');
  if (read.malformed) throw new Error('the PR thread carries a malformed referral record or ruling; the gate holds it and a ruling cannot repair it');
  const supersedeIds = [...new Set(String(input.supersedes ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (byPolicy && supersedeIds.length) throw new Error('auto-policy cannot supersede rulings');
  if (byPolicy && read.protectionMalformed) throw new Error('automatic policy refuses malformed referral history');
  // Disputed findings are ruled targets too: merge them over the ruled list (same finding = same runId + key).
  const ruled = [...(read.ruled ?? []).filter((r) => !(read.disputed ?? []).some((d) => d.runId === r.runId && d.key === r.key)),
    ...(read.disputed ?? [])];
  const disputedOf = (o) => (read.disputed ?? []).find((d) => d.runId === o.runId && d.key === o.key);
  const describe = (r) => `  ${findingLocation(r)} — ${r.summary}\n    standing: ${r.standing.map((x) => `${x.id} (${x.result})`).join(', ')}`
    + (r.blockIds?.length ? `\n    DISPUTED BLOCK (supersede this one): ${r.blockIds.join(', ')}` : '');
  let selected;
  let skipped = [];
  let supersedesFor = () => [];
  const autoSupersede = !supersedeIds.length && !selectsOpen(read.open, finding) && (read.disputed ?? []).length
    && selectsOpen(read.disputed, finding);
  if (byPolicy) {
    selected = selectFindings(automaticPolicyTargets(read), finding);
    for (const target of selected) {
      if (!Array.isArray(target.protectingRulings) || !Array.isArray(target.protectionUnknown)
        || (!target.protectingRulings.length && target.protectionUnknown.length)) {
        throw new Error(`automatic policy protection is unknown for ${target.runId}/${target.key}: ${(target.protectionUnknown ?? ['missing protection evidence']).join('; ')}`);
      }
    }
    skipped = selected.filter((o) => o.protectingRulings.length).map((o) => ({ repo, pr: Number(pr), head: read.head,
      runId: o.runId, key: o.key, protectingRulings: o.protectingRulings }));
    selected = selected.filter((o) => !o.protectingRulings.length);
    if (!selected.length) return { noop: true, record: null, body: null, followUp: null, selected, skipped,
      open: read.open, disputed: read.disputed ?? [], supersedes: [] };
  } else if (autoSupersede) {
    // --finding names a disputed finding and no --supersedes: the block it is disputed over is the one to supersede.
    selected = selectFindings(read.disputed, finding);
    supersedesFor = (o) => disputedOf(o)?.blockIds ?? [];
    if (!selected.some((o) => supersedesFor(o).length)) throw new Error('the disputed finding names no block ruling id; pass --supersedes=<id> from the standing list');
  } else if (supersedeIds.length) {
    const standing = new Set(ruled.flatMap((r) => r.rulingIds));
    const unknown = supersedeIds.filter((id) => !standing.has(id));
    if (unknown.length) throw new Error(`--supersedes ${unknown.join(', ')} names no standing ruling on a finding of the live head (standing ids: ${[...standing].join(', ') || 'none'})`);
    const pool = ruled.filter((r) => r.rulingIds.some((id) => supersedeIds.includes(id))).map((r, i) => ({ ...r, index: i + 1 }));
    selected = selectFindings(pool, finding);
    const used = new Set(selected.flatMap((o) => o.rulingIds));
    const idle = supersedeIds.filter((id) => !used.has(id));
    if (idle.length) throw new Error(`--supersedes ${idle.join(', ')} is not a standing ruling on any selected finding; nothing posted`);
    supersedesFor = (o) => o.rulingIds.filter((id) => supersedeIds.includes(id));
  } else {
    try { selected = selectFindings(read.open, finding); } catch (error) {
      if (!ruled.length) throw error;
      throw new Error(`${error.message}\nFinding(s) on the live head carry a standing ruling, which --finding cannot select. To record a later ruling over one, pass --supersedes=<id> (operator only):\n`
        + ruled.map(describe).join('\n'));
    }
  }
  const record = {
    version: 1, repo, pr: Number(pr), head: read.head,
    rulings: selected.map((o) => ({ runId: o.runId, key: o.key, result: ruling, ...(ruling === 'not-real' ? { lens: o.seat ?? JSON.parse(o.key)[0] } : {}),
      ...(input.cause ? { cause: input.cause } : {}), ...(ruling === 'card' ? { card: read.card.ref } : {}),
      ...(supersedesFor(o).length ? { supersedes: supersedesFor(o) } : {}) })),
    actor: String(actor).toLowerCase(), channel: String(channel).trim(), reason: String(reason), at: read.now,
    clearerId: read.clearerId,
  };
  if (!validateOperatorRuling(record)) throw new Error('the operator ruling record failed validation; nothing posted');
  const followUp = planRulingFollowUp({ open: [...read.open, ...selected.filter((o) => !read.open.some((p) => p.runId === o.runId && p.key === o.key))], selected, ruling, reason, head: read.head, actor: String(actor).toLowerCase(),
    enabled: input.sendBack !== false && read.followUpEnabled !== false });
  return { record, body: buildOperatorRulingComment(record), selected, skipped,
    ...(byPolicy ? { protectionSnapshot: policyProtectionSnapshot(read) } : {}), open: read.open, disputed: read.disputed ?? [],
    supersedes: record.rulings.flatMap((r) => r.supersedes ?? []), followUp };
}

export function recordReferralRulingOperation({ readRulingContext } = {}) {
  if (typeof readRulingContext !== 'function') {
    throw new TypeError('record-referral-ruling: needs a `readRulingContext({repo, pr, card})` reader — the real '
      + 'binding is `we:scripts/operations/record-referral-ruling-io.mjs`.');
  }
  return op(RECORD_REFERRAL_RULING_OP, {
    input: {
      pr: 'number',
      repo: 'string',
      finding: 'string',
      ruling: { type: 'string', enum: [...OPERATOR_RULING_RESULTS] },
      card: { type: 'string', required: false },
      supersedes: { type: 'string', required: false },
      cause: { type: 'string', enum: [...FALSE_FINDING_CAUSES], required: false },
      actor: 'string',
      channel: 'string',
      reason: 'string',
      sendBack: { type: 'boolean', required: false, default: true },
      preview: { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    read: compute({
      reads: ['input.repo', 'input.pr', 'input.card'],
      fn: (view) => readRulingContext({ repo: view.input.repo, pr: view.input.pr, card: view.input.card }),
    }),
    plan: compute({
      reads: ['input.repo', 'input.pr', 'input.finding', 'input.ruling', 'input.actor', 'input.channel',
        'input.reason', 'input.cause', 'input.sendBack', 'input.supersedes', 'findings.read'],
      fn: (view) => planOperatorRuling(view.findings.read, view.input),
    }),
    write: effectStep({
      reads: ['verdict', 'input.preview'],
      // NOT idempotent: a repeat posts a second comment. The sink re-reads the thread first and skips a
      // byte-identical ruling already present, so a replay after a crash cannot double-post.
      effects: (view) => (view.input.preview || view.verdict.noop ? [] : [{
        type: OPERATOR_RULING_POST_EFFECT, idempotent: false,
        payload: { repo: view.verdict.record.repo, pr: view.verdict.record.pr, head: view.verdict.record.head, body: view.verdict.body,
          rulings: view.verdict.record.rulings.map((r) => ({ runId: r.runId, key: r.key, result: r.result })),
          skipped: view.verdict.skipped,
          protectionSnapshot: view.verdict.protectionSnapshot,
          actor: view.verdict.record.actor, channel: view.verdict.record.channel },
      }, ...(view.verdict.followUp ? [{
        type: OPERATOR_RULING_FOLLOW_UP_EFFECT, idempotent: true,
        payload: { repo: view.verdict.record.repo, pr: view.verdict.record.pr, head: view.verdict.record.head,
          action: view.verdict.followUp.action, body: view.verdict.followUp.body,
          remaining: view.verdict.followUp.remaining ?? [],
          actor: view.verdict.record.actor, channel: view.verdict.record.channel },
      }] : [])]),
    }),
  });
}
