/**
 * @file The ledger-derived PR state (plan slice D of #verdict-ledger-pr-state-store; = #5052 narrowed). Pure.
 *
 * RELATIONSHIP TO `pr-state-core.mjs` (#4052): that file is the evidence-based phase derivation (live sessions,
 * claims, checks, hand-offs) and it stays the ONLY place that decides a phase. This file does not re-derive one.
 * It (1) folds the ledger events into verdict / referral / hold facts, (2) projects them into the facts the core
 * already understands, (3) calls the core's `derivePrState`, and (4) layers the ledger's holds on top, which can
 * only RESTRICT (a ready PR with a hold is no longer ready). The lifecycle table is `conveyor/pr-lifecycle.mjs`.
 * Labels are an OUTPUT here (`labels[]`); any `facts.labels` the caller passes are ignored by `derivePrState`.
 * `labelsToLedgerState` is the migration adapter for the opposite direction while labels are still the store.
 * No callers are switched by this slice.
 */
import { derivePrState as derivePrPhase } from './pr-state-core.mjs';
import { EVENT_TYPES, foldVerdictLedger, verdictLabel, verdictClears } from './verdict-ledger.mjs';
import { deriveReferrals, openReferralKeys } from './pr-state/referrals.mjs';
import { evaluateHolds } from './pr-state/holds/index.mjs';
import { HUMAN_HOLD_CI_RED, lifecycleRow, renderLabels } from '../conveyor/pr-lifecycle.mjs';

const isVerdictRow = e => e.type === EVENT_TYPES.VERDICT || e.type === undefined;
const time = v => (typeof v === 'number' ? v : Date.parse(v));

/** A human hold is lifted by a LATER approval event whose delegation (if any) has not expired. */
function approvalLifts(events, cur, now) {
  const at = events.indexOf(cur);
  return events.slice(at + 1).some(e => e.type === EVENT_TYPES.APPROVAL
    && (!e.delegation || !Number.isFinite(time(now)) || time(e.delegation.expires) > time(now)));
}

/** Fold one PR's events into the view every hold rule reads. */
export function ledgerView(events, facts) {
  const mine = events.filter(e => !facts?.pr || e.pr === facts.pr);
  const folded = foldVerdictLedger(mine.filter(isVerdictRow)).get(facts?.pr ?? mine[0]?.pr) ?? null;
  const cur = folded?.current ?? null;
  let clears = !!folded?.clears;
  if (cur && !clears && cur.verdict === 'human' && approvalLifts(mine, cur, facts?.now)) clears = true;
  return { events: mine, folded, clears, referrals: deriveReferrals(mine) };
}

/** Map a core phase plus the hold picture to a lifecycle state. The core's phase is kept except for two restrictions. */
function lifecycleOf(core, { holds, humanGate, facts }) {
  let state = core.phase;
  if (state === 'READY-TO-MERGE' && holds.length) {
    state = holds.every(h => h.rule === 'referral-unruled') ? 'NEEDS-RULING' : 'NEEDS-OPERATOR';
  }
  if (state === 'NEEDS-OPERATOR' && humanGate && (facts.requiredChecks ?? []).some(c => c.state === 'red')) state = HUMAN_HOLD_CI_RED;
  return state;
}

/**
 * @param {object[]|null} events This PR's ledger events (any types, append order). `null` = the ledger was
 *   unreadable, which is a hold and never "empty".
 * @param {object} facts The GitHub facts, in `pr-state-core.mjs`'s shape. `facts.labels` is ignored.
 * @param {object} [settings] pr-state-core DEFAULTS overrides plus `sameHeadMaxReviews` (default 1; 0 = off) and `holdRules`.
 * @returns {{lifecycleState:string, verdict:string|null, clears:boolean, holds:object[], needsYou:string[],
 *   labels:string[], reasons:string[], next:string, owner:string|null, maxTimeInState:number|null, phase:object}}
 */
export function derivePrState(events, facts, settings = {}) {
  if (events == null) {
    const hold = { code: 'ledger-unreadable', reason: 'the verdict ledger could not be read; unreadable is a hold, never empty', needsYou: null, rule: 'ledger' };
    return finish({ lifecycleState: 'NEEDS-OPERATOR', verdict: null, clears: false, holds: [hold], phase: { phase: 'NEEDS-OPERATOR', headline: hold.reason, next: 'retry the ledger read', evidence: [] } });
  }
  const view = ledgerView(events, facts);
  const holds = evaluateHolds({ view, facts, settings }, settings.holdRules);
  const cur = view.folded?.current ?? null;
  const covered = view.clears && !holds.some(h => h.code === 'stale-acceptance');
  const labels = covered ? ['review:accepted'] : cur && !view.clears ? [verdictLabel(cur.verdict)].filter(Boolean) : [];
  const open = openReferralKeys(view.referrals);
  const capHold = holds.find(h => h.code === 'same-head-cap' && h.needsYou);
  const coreFacts = { ...facts, labels,
    referrals: { pending: open, ruled: [...view.referrals.values()].filter(k => k.state !== 'open').length },
    roundCapNote: !!capHold || !!facts.roundCapNote };
  const phase = derivePrPhase(coreFacts, settings);
  const humanGate = (cur?.verdict === 'human' && !view.clears) || holds.some(h => h.code === 'label-input:review:human');
  const lifecycleState = lifecycleOf(phase, { holds, humanGate, facts });
  return finish({ lifecycleState, verdict: cur?.verdict ?? null, clears: view.clears && holds.length === 0, holds, phase });
}

function finish({ lifecycleState, verdict, clears, holds, phase }) {
  const row = lifecycleRow(lifecycleState);
  const needsYou = [...new Set(holds.map(h => h.needsYou).filter(Boolean))];
  if (row?.owner === 'operator' && !['MERGED', 'CLOSED'].includes(lifecycleState) && !needsYou.length) needsYou.push(phase.headline);
  return { lifecycleState, verdict, clears, holds, needsYou, labels: renderLabels(lifecycleState),
    reasons: [...holds.map(h => h.reason), phase.headline], next: phase.next, owner: row?.owner ?? null,
    maxTimeInState: row?.maxTimeInState ?? null, phase };
}

/**
 * MIGRATION ADAPTER (removed when authority flips to the ledger, slice L). While labels are still the store, read
 * the live labels plus check status (the core's own label-aware path) and return the same lifecycle state the
 * ledger derive would. Nothing else in the lifecycle map reads labels.
 * @param {object} facts `pr-state-core.mjs` facts with `labels` set.
 */
export function labelsToLedgerState(facts, settings = {}) {
  const phase = derivePrPhase(facts, settings);
  const labels = facts.labels ?? [];
  const humanGate = labels.includes('review:human');
  const lifecycleState = lifecycleOf(phase, { holds: [], humanGate, facts });
  return finish({ lifecycleState, verdict: null, clears: lifecycleState === 'READY-TO-MERGE', holds: [], phase });
}
