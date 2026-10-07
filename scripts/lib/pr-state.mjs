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
import { EVENT_TYPES, foldVerdictLedger, verdictLabel, validateLedgerEvent } from './verdict-ledger.mjs';
import { deriveReferrals, openReferralKeys } from './pr-state/referrals.mjs';
import { evaluateHolds } from './pr-state/holds/index.mjs';
import { approvalLiftsAfter } from './pr-state/holds/verdict.mjs';
import { HUMAN_HOLD_CI_RED, lifecycleRow, renderLabels } from '../conveyor/pr-lifecycle.mjs';

const isVerdictRow = e => e.type === EVENT_TYPES.VERDICT || e.type === undefined;
const slug = r => String(r ?? '').trim().toLowerCase();
/** The PR this derive is about: both its number and its repo are required, or the scope is unknown. */
const scopeOf = facts => {
  const pr = Number(facts?.pr);
  return Number.isInteger(pr) && pr > 0 && slug(facts?.repo) ? { pr, repo: slug(facts.repo) } : null;
};

const unreadable = why => Object.assign(new Error(why), { ledgerUnreadable: true });

/**
 * This PR's events (this repo, this number; never "all PRs"), each one VALIDATED AND NORMALISED by the ledger's own
 * schema check (`validateLedgerEvent`): a raw row is untrusted input, so a forged `clears`, a string `pr`, an
 * unknown or mis-cased `type`, an approval with no kind, or a referral with no keys is an unreadable ledger (a
 * hold), never a row the folds quietly skip or trust. A row that cannot even be attributed to a PR and repo is
 * unreadable for every PR; another PR's well-attributed row is simply not ours and is not inspected further.
 */
function scopedEvents(events, scope) {
  const mine = [];
  for (const e of events) {
    if (!Number.isInteger(e.pr) || typeof e.repo !== 'string') throw unreadable('a ledger row has no integer pr and string repo');
    if (e.pr !== scope.pr || slug(e.repo) !== scope.repo) continue;
    const { valid, errors, record } = validateLedgerEvent(e);
    if (!valid) throw unreadable(`a ledger row for this PR is invalid: ${errors[0]}`);
    mine.push(record);
  }
  return mine;
}

/** Fold ONE PR's events (this repo, this number; never "all PRs") into the view every hold rule reads. Throws `ledgerUnreadable` on an invalid row. */
export function ledgerView(events, facts) {
  const scope = scopeOf(facts);
  const mine = scope ? scopedEvents(events, scope) : [];
  const folded = scope ? foldVerdictLedger(mine.filter(isVerdictRow)).get(scope.pr) ?? null : null;
  const cur = folded?.current ?? null;
  let clears = !!folded?.clears;
  // A human hold is lifted by a LATER valid approval (unexpired delegation, provable clock); an unknown position never lifts.
  if (cur && !clears && cur.verdict === 'human' && approvalLiftsAfter(mine, mine.indexOf(cur), facts?.now)) clears = true;
  return { events: mine, folded, clears, referrals: deriveReferrals(mine) };
}

/** Map a core phase plus the hold picture to a lifecycle state. The core's phase is kept except for two restrictions. */
function lifecycleOf(core, { holds, humanGate, facts }) {
  let state = core.phase;
  if (state === 'READY-TO-MERGE' && holds.length) {
    state = holds.every(h => h.code === 'referral-unruled') ? 'NEEDS-RULING' : 'NEEDS-OPERATOR';
  }
  if (state === 'NEEDS-OPERATOR' && humanGate && (facts.requiredChecks ?? []).some(c => c.state === 'red')) state = HUMAN_HOLD_CI_RED;
  return state;
}

/**
 * @param {object[]|null} events This PR's ledger events (any types, append order). `null` = the ledger was
 *   unreadable, which is a hold and never "empty".
 * @param {object} facts The GitHub facts, in `pr-state-core.mjs`'s shape plus `repo` (required with `pr`, or the
 *   derive holds as `scope-unknown`). `facts.labels` is ignored.
 * @param {object} [settings] pr-state-core DEFAULTS overrides plus `sameHeadMaxReviews` (default 1; 0 = off) and
 *   `holdRules` (extra rules that run NEXT TO the built-ins; they never replace them).
 * @returns {{lifecycleState:string, verdict:string|null, clears:boolean, holds:object[], needsYou:string[],
 *   labels:string[], reasons:string[], next:string, owner:string|null, maxTimeInState:number|null, phase:object}}
 */
export function derivePrState(events, facts, settings = {}) {
  const unreadableLedger = why => heldOutright('ledger-unreadable', `the verdict ledger could not be read (${why}); unreadable is a hold, never empty`, 'retry the ledger read');
  if (!Array.isArray(events) || events.some(e => !e || typeof e !== 'object')) return unreadableLedger('not an array of rows');
  if (!scopeOf(facts)) return heldOutright('scope-unknown', 'facts.pr and facts.repo are both required to scope the ledger; an unknown scope is a hold, never "all PRs"', 'pass the PR number and repo');
  try {
    return derive(events, facts, plain(settings));
  } catch (e) { // an invalid row is an unreadable ledger; anything else (a throwing getter, a facts slip) is a crash: hold, never throw and never guess
    if (e?.ledgerUnreadable) return unreadableLedger(e.message);
    return heldOutright('derive-crashed', `the ledger derive crashed (${String(e?.message ?? e).slice(0, 120)}); a crash is a hold, never a clear`, 'fix the malformed ledger row or facts');
  }
}

/** `settings` is optional config: anything but an object (null, a string, a number) is "no overrides". */
const plain = settings => (settings && typeof settings === 'object' ? settings : {});

function derive(events, facts, settings) {
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

/** A derive that cannot trust its input holds the PR in NEEDS-OPERATOR without consulting the core. */
function heldOutright(code, reason, next) {
  const hold = { code, reason, needsYou: null, rule: 'input' };
  return finish({ lifecycleState: 'NEEDS-OPERATOR', verdict: null, clears: false, holds: [hold], phase: { phase: 'NEEDS-OPERATOR', headline: reason, next, evidence: [] } });
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
  settings = plain(settings);
  const phase = derivePrPhase(facts, settings);
  const labels = facts.labels ?? [];
  const humanGate = labels.includes('review:human');
  const lifecycleState = lifecycleOf(phase, { holds: [], humanGate, facts });
  return finish({ lifecycleState, verdict: null, clears: lifecycleState === 'READY-TO-MERGE', holds: [], phase });
}
