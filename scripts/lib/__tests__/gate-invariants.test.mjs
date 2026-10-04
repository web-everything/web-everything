/**
 * @file gate-invariants.test.mjs — the TRIPWIRE suite for the auto-review/merge gate.
 *
 * WHAT THIS IS, AND WHY IT IS DIFFERENT FROM THE OTHER GATE TESTS.
 * The sibling suites (`review-escalation.test.mjs`, `pr-merge-gate.test.mjs`, `../../__tests__/
 * merge-ai-prs.test.mjs`, `../../__tests__/pr-land.test.mjs`) pin the CURRENT BEHAVIOUR of each gate
 * function with worked examples — they move with the code, so a change that intentionally alters an
 * output just updates its expectation. That is correct for behaviour, but it means those suites cannot,
 * by construction, catch a change that WEAKENS a safety property: the author edits the code and the
 * example in one PR and it stays green.
 *
 * This file is the other half. It does NOT assert what the gate returns for one input — it asserts, over
 * the ENTIRE cross-product of inputs, the small set of SAFETY INVARIANTS that must hold no matter how the
 * rubric is refactored. These are phrased independently of the implementation: "a human-gated PR never
 * reaches an auto-merge action, for ANY label set / escalation state / park age" rather than "input X →
 * action park". A refactor that keeps every invariant green is provably safe on the properties that matter;
 * a refactor that has to change an assertion HERE is, by definition, changing what "safe" means — and that
 * is exactly the diff a human should look at.
 *
 * SELF-REFERENCE (the load-bearing bit). This file's basename is in the `TRUST_CHAIN` roster (see
 * `../gate-config.mjs`, #2448), so editing it forces `review:human` on its own PR — the one class of change
 * that an agent reviewer may not clear. That closes the loop: the invariants review every future change to
 * the gate for free (in CI, via the required `test` check), and the ONLY gate change that still needs a
 * human is one that edits an invariant. Do not weaken an assertion here to make a diff pass; if an
 * invariant is genuinely wrong, changing it is a deliberate policy decision, reviewed by a human.
 *
 * Under #2162/#2171/#2285/#2366 (the auto-review gate) and #104 (gate-self ⇒ human).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { planReviewHoldCleanup } from '../../conveyor/review-hold-reconcile.mjs';
import {
  REVIEW_LABELS,
  isGateSelfPath,
  isStatutePath,
  scoreEscalation,
  coupleEscalation,
  decideReviewGate,
  producerReviewLabel,
  hasUnclearedReviewLabel,
  isPolicySpecPath,
  isEngineTierPath,
  acceptanceCoversHead,
  normalizeDiffFingerprint,
  normalizeContributionFingerprint,
  decideParkToHuman,
  findContradictoryReviewVerdicts,
} from '../review-escalation.mjs';
import {
  TRUST_CHAIN,
  POLICY_LEASH,
  POLICY_CORE_BASENAMES,
  POLICY_SPEC_BASENAMES,
  POLICY_DERIVATION_BASENAMES,
  RATIFIED_POLICY_SPEC_FLOOR,
  isTrustChainPath,
} from '../gate-config.mjs';
import { assertMayMerge, hasNonEmptyBody } from '../pr-merge-gate.mjs';
import { classifyChecks } from '../../pr-land.mjs';
import { classifyPr, basisTouchesEngineTier, engineTierForCandidate } from '../../merge-ai-prs.mjs';
import { decideSetLabel, REVIEW_LABEL_TARGETS } from '../../review-set-label.mjs';

// ── enumeration helpers (deterministic — no Math.random, so a failure reproduces exactly) ────────────────
/** Every subset of `items` (the powerset), as arrays. */
function powerset(items) {
  return items.reduce((sets, item) => sets.concat(sets.map((s) => [...s, item])), [[]]);
}
/** Cartesian product of the given arrays. */
function product(...arrays) {
  return arrays.reduce((acc, arr) => acc.flatMap((a) => arr.map((b) => [...a, b])), [[]]);
}

// #2445 two-tier flip + the #2771/#2785 POLICY-tier split. The trust chain has two TIERS (policy / engine), and
// the policy tier has two LEASHES:
//   • DECLARATIVE LEASH (`leash: 'spec'`) — the encoded policy itself. Forces review:human. Permanently pinned
//     by #2840 trigger 3: these files have no behaviour-preserving edit.
//   • DERIVATION CODE (`leash: 'code'`) — the code that derives the gate from that leash. Still ESCALATES, but a
//     converged INDEPENDENT committee verdict may clear it (#2771 Fork A) — it no longer forces a human.
//   • ENGINE tier — the lander, which obeys the gate. Escalates, agent-reviewable (unchanged, #2445).
const DECLARATIVE_LEASH_FILES = [
  'scripts/lib/review-policy.contract.json',  // #2566 — the machine-diffable policy SPEC; a diff here IS a policy change
  'scripts/lib/__tests__/review-policy.conformance.test.mjs', // #2566 — the impl↔contract bridge (weakening it is a spec change)
  'scripts/lib/gate-config.mjs',              // #2448 — the trust-chain roster; editing it is the closure
  'scripts/lib/__tests__/gate-invariants.test.mjs', // THIS file — self-referenced (see header)
  'scripts/check-standards.contract.json',    // #2769 — the check:standards definition-of-green contract
  'scripts/lib/__tests__/check-standards.conformance.test.mjs', // #2769 — its conformance bridge
  'scripts/lib/review-runner-core.mjs',       // #2830 — the forced-SHADOW zero-mutation guarantee (leash `spec` pending a #2840-trigger-2 ruling)
  'scripts/review-runner.mjs',                // #2830 — the `--enforce` refusal, the other half of that guarantee
  'scripts/lib/review-independence.mjs', // #2844/#3045 — WHO may clear a verdict; no conformance backstop
];
const DERIVATION_CODE_FILES = [
  'scripts/lib/review-escalation.mjs',        // the escalation rubric — derives the gate from the contract
  'scripts/lib/review-core.mjs',              // the converge-vs-human disposition router + round caps
  'scripts/lib/review-policy.mjs',            // #2566 — the spec loader + executable oracle
  'scripts/lib/disposition-land-seam.mjs',    // #2674 — the disposition→label router
  'scripts/lib/auto-land-seam.mjs',           // #2675 — the acting seam
];
// Both halves are still the POLICY TIER — `isGateSelfPath` (i.e. "is this the policy tier?") is true for every
// one of them, and every one of them ESCALATES. Only `humanRequired` distinguishes the two.
const POLICY_CORE_FILES = [...DECLARATIVE_LEASH_FILES, ...DERIVATION_CODE_FILES];
const ENGINE_FILES = [
  'scripts/merge-ai-prs.mjs',                 // the lander — obeys the gate, so agent-reviewable (#2445 flip)
  'frontierui/scripts/merge-ai-prs.mjs',      // a repo-prefixed clone path still counts
  // the conveyor's own dispatch-loop machinery (#3401, under epic #3383) — see gate-config.test.mjs for the
  // dedicated roster-membership pins (basename registration, tier, homes)
  'scripts/conveyor/tick-core.mjs',
  'scripts/operations/dispatch-lane.mjs',
  'scripts/operations/dispatch-lane-io.mjs',
  'skills-src/conveyor/runner.mjs',
  'skills-src/conveyor/supervisor.mjs',       // registered ahead of its own landing to `main`
];
// The STATUTE layer (#2412) — governance rules a human must ratify; forces review:human like the policy tier.
const STATUTE_FILES = ['docs/agent/platform-decisions.md', 'docs/agent/2026-06-example-statute.md'];
// #2448 — a trust-chain member RELOCATED out of we:scripts/ (the #2445 coordinator: a plateau-app module, a
// package dir, or its own repo). Basename-matched, so the TIER travels: a relocated POLICY file stays human, a
// relocated ENGINE file still escalates (it can never silently drop out of review) but stays agent-reviewable.
const RELOCATED_LEASH_FILES = [
  'plateau-loop/gate/gate-config.mjs',              // the roster, its own repo → still human
  'plateau-app/tools/loop/review-policy.contract.json', // the contract, extracted → still human
];
const RELOCATED_DERIVATION_FILES = [
  'plateau-app/tools/loop/review-escalation.mjs',   // derivation code, extracted → escalates, committee-clearable
];
const RELOCATED_POLICY_FILES = [...RELOCATED_LEASH_FILES, ...RELOCATED_DERIVATION_FILES];
const RELOCATED_ENGINE_FILES = [
  'packages/plateau-loop/src/merge-ai-prs.mjs',     // engine, extracted into a package dir → escalates, agent-reviewable
];
const LEAF_FILES = ['backlog/123-x.md', 'demos/spa.html', 'src/_data/other.json', 'reports/2026-07-09-x.md'];
// x30jq9n — the merge-anyway timeout is REMOVED; decideReviewGate no longer reads park age. These legacy
// park-age shapes are still swept below purely as tripwires: a caller passing them must change NOTHING.
const PARK_AGES = [
  { parkedSinceMs: null, nowMs: 0 },              // never parked
  { parkedSinceMs: 0, nowMs: 60_000 },            // freshly parked
  { parkedSinceMs: 0, nowMs: 1e12 },              // absurdly old park (would have timed out under the old window)
];
const AUTO_MERGE_ACTIONS = ['merge']; // the ONE action that puts a PR onto main without a human (merge-anyway removed, x30jq9n)

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 1 — the two-tier trust chain (#2445 flip). POLICY-CORE and STATUTE paths are ALWAYS human-required
// (and escalate). ENGINE paths (the lander) ALWAYS escalate but are NEVER human-required — a converged agent
// verdict may clear them. The tier travels with a relocated file's basename.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 1 — policy/statute ⇒ human; engine ⇒ escalate-but-agent-reviewable', () => {
  const noiseSignals = product(
    [0, 500],        // diffLines: below and above the size threshold
    [0, 3],          // dismissedFindings
    [false, true],   // crossRepo
  );
  it('every POLICY-CORE path is classified gate-self (human); every ENGINE path is NOT', () => {
    for (const f of POLICY_CORE_FILES) expect(isGateSelfPath(f)).toBe(true);
    for (const f of ENGINE_FILES) expect(isGateSelfPath(f)).toBe(false);
  });
  it('the DECLARATIVE LEASH ⇒ humanRequired across arbitrary other signals + noise (#2771/#2785)', () => {
    for (const gateFile of DECLARATIVE_LEASH_FILES) {
      for (const noise of powerset(LEAF_FILES)) {
        for (const [diffLines, dismissedFindings, crossRepo] of noiseSignals) {
          const r = scoreEscalation({ changedFiles: [...noise, gateFile], diffLines, dismissedFindings, crossRepo });
          expect(r.humanRequired).toBe(true); // the encoded policy — never falls to agent-reviewable
          expect(r.escalate).toBe(true);
        }
      }
    }
  });
  it('#2771 Fork A — policy-tier DERIVATION CODE ESCALATES but is NOT humanRequired, across noise', () => {
    for (const gateFile of DERIVATION_CODE_FILES) {
      for (const noise of powerset(LEAF_FILES)) {
        for (const [diffLines, dismissedFindings, crossRepo] of noiseSignals) {
          const r = scoreEscalation({ changedFiles: [...noise, gateFile], diffLines, dismissedFindings, crossRepo });
          expect(r.escalate).toBe(true);       // still gets a full independent review…
          expect(r.humanRequired).toBe(false); // …but the committee may clear it — the ratified narrowing
        }
      }
    }
  });
  it('MIXED — a diff touching BOTH the leash and derivation code stays humanRequired (the strictest half wins)', () => {
    for (const leash of DECLARATIVE_LEASH_FILES) {
      for (const code of DERIVATION_CODE_FILES) {
        for (const noise of powerset(LEAF_FILES).slice(0, 4)) {
          const r = scoreEscalation({ changedFiles: [...noise, code, leash] });
          expect(r.humanRequired).toBe(true);
          // …and on the cumulative human basis too, where the leash rides an ancestor commit (#2390).
          expect(scoreEscalation({ changedFiles: [code], humanBasisFiles: [code, leash] }).humanRequired).toBe(true);
        }
      }
    }
  });
  it('the leash never LOSES its human gate to a de-inflated stacked base (#2390 — the human basis wins)', () => {
    for (const leash of DECLARATIVE_LEASH_FILES) {
      // own-delta looks innocuous; the cumulative basis carries the leash edit → still human.
      expect(scoreEscalation({ changedFiles: ['demos/spa.html'], humanBasisFiles: ['demos/spa.html', leash] }).humanRequired).toBe(true);
    }
  });
  it('the STATUTE layer ⇒ humanRequired (a governance rule a human must ratify, #2412)', () => {
    for (const s of STATUTE_FILES) {
      expect(isStatutePath(s)).toBe(true);
      for (const noise of powerset(LEAF_FILES)) {
        const r = scoreEscalation({ changedFiles: [...noise, s] });
        expect(r.humanRequired).toBe(true);
        expect(r.escalate).toBe(true);
      }
    }
  });
  it('#2445 flip — an ENGINE (lander) edit ESCALATES but is NOT humanRequired (agent-reviewable)', () => {
    for (const engineFile of ENGINE_FILES) {
      for (const noise of powerset(LEAF_FILES)) {
        for (const [diffLines, dismissedFindings, crossRepo] of noiseSignals) {
          const r = scoreEscalation({ changedFiles: [...noise, engineFile], diffLines, dismissedFindings, crossRepo });
          expect(r.escalate).toBe(true);        // the lander always gets an independent review
          expect(r.humanRequired).toBe(false);  // but a converged agent verdict may clear it — the flip
        }
      }
    }
  });
  it('#2448/#2445/#2785 — the tier AND the leash TRAVEL: a relocated LEASH file stays human; relocated derivation code + a relocated ENGINE file escalate but stay agent-reviewable', () => {
    for (const moved of RELOCATED_POLICY_FILES) expect(isGateSelfPath(moved)).toBe(true);
    for (const moved of RELOCATED_LEASH_FILES) {
      for (const noise of powerset(LEAF_FILES)) {
        const r = scoreEscalation({ changedFiles: [...noise, moved], diffLines: 0 });
        expect(r.humanRequired).toBe(true); // the coordinator can never auto-clear a change to its own leash
        expect(r.escalate).toBe(true);
      }
    }
    for (const moved of RELOCATED_DERIVATION_FILES) {
      for (const noise of powerset(LEAF_FILES)) {
        const r = scoreEscalation({ changedFiles: [...noise, moved], diffLines: 0 });
        expect(r.humanRequired).toBe(false); // derivation code — the committee clears it wherever it lives
        expect(r.escalate).toBe(true);       // but it can never silently drop out of review
      }
    }
    for (const moved of RELOCATED_ENGINE_FILES) {
      expect(isGateSelfPath(moved)).toBe(false);
      for (const noise of powerset(LEAF_FILES)) {
        const r = scoreEscalation({ changedFiles: [...noise, moved], diffLines: 0 });
        expect(r.humanRequired).toBe(false);
        expect(r.escalate).toBe(true); // still escalates even though a package path no longer matches ^scripts/
      }
    }
  });
  it('a diff with NO policy/statute path is never humanRequired (the converse — no false human-gating)', () => {
    for (const files of powerset(LEAF_FILES)) {
      expect(scoreEscalation({ changedFiles: files, diffLines: 999, dismissedFindings: 9, crossRepo: true }).humanRequired).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 2 — a human-gated PR NEVER reaches an auto-merge action without an explicit human accept.
// This is the core safety property: no refactor of decideReviewGate may open a path by which a PR that is
// human-required (fresh score) OR already carries the sticky review:human label lands on main, EXCEPT when a
// human has applied review:accepted. Proven over the full cross-product of escalation × human signal ×
// label set × park age.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 2 — human-gated ⇒ no auto-merge without review:accepted', () => {
  const otherLabels = powerset([REVIEW_LABELS.pending, REVIEW_LABELS.changes]);
  const cases = product(
    [false, true],   // escalate (a sticky human label must veto even a de-escalated PR)
    [false, true],   // humanRequired (fresh gate-self score)
    [false, true],   // review:human label present (the sticky veto)
    [false, true],   // review:accepted present (the ONE human clear)
  );

  it('for every (escalate, humanRequired, humanLabel, accepted, extra labels, park age): human-tainted ⇒ never auto-merges unless accepted', () => {
    for (const [escalate, humanRequired, humanLabel, accepted] of cases) {
      for (const extra of otherLabels) {
        for (const age of PARK_AGES) {
          const labels = [...extra];
          if (humanLabel) labels.push(REVIEW_LABELS.human);
          if (accepted) labels.push(REVIEW_LABELS.accepted);
          const tainted = humanRequired || humanLabel; // the PR is under the human gate
          // xvzc4v4 (merge-safety review, bug 3) — a matching accepted/head SHA, so an `accepted` case here
          // exercises "human accept, verified against a live head that still matches it" — the property this
          // invariant is actually about. The now-separate "accepted but UNVERIFIABLE (no/failed SHA read) must
          // still fail closed" property is covered by its own tests in review-escalation.test.mjs; this
          // invariant never intended to also cover that axis (it iterates only escalate × humanRequired ×
          // humanLabel × accepted × extra labels × park age — SHA-coverage is orthogonal).
          const g = decideReviewGate({ escalate, humanRequired, labels, ...age, acceptedSha: 'abc1234', headSha: 'abc1234' });

          if (tainted && !accepted) {
            // the safety property: a human-gated PR with no human accept must NOT land, ever.
            expect(AUTO_MERGE_ACTIONS).not.toContain(g.action);
            // and no timeout path may resurrect (x30jq9n removed merge-anyway; the #289 hole stays closed)
            expect(g.action).not.toBe('merge-anyway');
            // the caller keys its auto-review routing on this: a tainted PR always reports humanRequired
            expect(g.humanRequired).toBe(true);
          }
          if (accepted) {
            // a human accept always wins — even over a sticky human label or a fresh human-required score
            expect(g.action).toBe('merge');
          }
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 3 — a red required check is NEVER mergeable. Neither the check classifier nor the PR classifier
// may ever call a PR with a failing required check landable, whatever else is true about it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 3 — a failed required check is never mergeable', () => {
  it('classifyChecks: any failing bucket ⇒ status "failed", regardless of other passed/pending rows', () => {
    const failBuckets = ['fail', 'cancel', 'timed_out', 'timeout', 'FAIL'];
    const filler = powerset([{ bucket: 'pass' }, { bucket: 'pending' }, { bucket: 'skipping' }]);
    for (const fb of failBuckets) {
      for (const rows of filler) {
        const r = classifyChecks([...rows, { bucket: fb }]);
        expect(r.status).toBe('failed');
        expect(r.status).not.toBe('passed');
      }
    }
  });
  it('classifyPr: a not-green required check ⇒ decision "skip" (never "merge"), across other signals', () => {
    const base = {
      number: 7,
      title: 'x',
      body: 'a real non-empty body',
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      labels: [{ name: 'ready-to-merge' }],
      statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }],
    };
    // even fully certified + clean + mergeable + bodied, a red required check must skip
    const v = classifyPr(base);
    expect(v.decision).toBe('skip');
    expect(v.decision).not.toBe('merge');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 4 — the drain is the SOLE writer to main. assertMayMerge lets ONLY caller 'drain' through; every
// other route throws unless break-glass is explicitly armed (and then it audits).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 4 — only the drain may write to main', () => {
  const nonDrainCallers = ['pr-land', 'lane-resume', 'merge', 'finish', '', 'drainish', 'DRAIN'];
  it('the drain always passes, without break-glass', () => {
    expect(assertMayMerge({ caller: 'drain', env: {} })).toEqual({ breakGlass: false });
  });
  it('every non-drain caller THROWS without break-glass', () => {
    for (const caller of nonDrainCallers) {
      expect(() => assertMayMerge({ caller, env: {} })).toThrow(/only the drain may merge/i);
    }
  });
  it('break-glass lets a non-drain caller through, but audits loudly every time', () => {
    for (const caller of nonDrainCallers) {
      const lines = [];
      const log = { write: (s) => lines.push(s) };
      const r = assertMayMerge({ caller, env: { WE_MERGE_BREAK_GLASS: '1' }, log });
      expect(r.breakGlass).toBe(true);
      expect(lines.join('')).toMatch(/BREAK-GLASS/); // never silent
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 5 — the concurrent-lander backstop (#2366). A merge path that does NOT run the full rubric this
// pass must refuse any un-cleared review label; review:accepted always clears; and review:human/review:changes
// are refused even under the operator's --no-review-escalation override.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 5 — hasUnclearedReviewLabel refuses un-cleared labels', () => {
  const all = [REVIEW_LABELS.pending, REVIEW_LABELS.human, REVIEW_LABELS.changes, REVIEW_LABELS.accepted];
  // #x9xqexm — TIGHTENED on the two HOLD pairs, in the refusing direction only. `review:accepted` used to clear
  // EVERY set it appeared in, which was safe only because the drain DELETED a stale accept whenever it re-parked.
  // It no longer deletes one (see INVARIANT 13), so a contradictory `accepted + hold` pair can survive a re-park
  // and this NON-SCORING predicate must fail closed on it — it is the only thing gating the bare `/merge` sweep,
  // which never calls `decideReviewGate` and certifies on `review:accepted` alone.
  // The rule is "could a SANCTIONED writer have produced this pair?":
  //   • `accepted + human`   — no. `--to=clear-human` removes `human` as it adds `accepted`; `--to=accepted` is
  //                            refused outright on a `review:human` PR.        ⇒ REFUSE
  //   • `accepted + pending` — no. Both `--to=accepted` and `--to=clear-human` carry `pending` in `removeLabels`,
  //                            so only the drain's stale re-park makes this pair — and that re-park is the COMMON
  //                            one (it applies `pending` whenever the fresh score is not `humanRequired`, the PR
  //                            #984 shape). Round-2 blocker 1.                  ⇒ REFUSE at allowPending:false
  //   • `accepted + changes` — LEFT ALONE. #2974 ruled the reviewer verdict wins over a stale bounce.  ⇒ clear
  it('review:accepted still clears a co-present review:changes (#2974 untouched)', () => {
    for (const set of powerset(all).filter((s) => s.includes(REVIEW_LABELS.accepted)
      && !s.includes(REVIEW_LABELS.human) && !s.includes(REVIEW_LABELS.pending))) {
      expect(hasUnclearedReviewLabel(set, { allowPending: false })).toBe(false);
      expect(hasUnclearedReviewLabel(set, { allowPending: true })).toBe(false);
    }
  });
  it('…but a CO-PRESENT review:human is refused even next to review:accepted', () => {
    for (const set of powerset(all).filter((s) => s.includes(REVIEW_LABELS.accepted)
      && s.includes(REVIEW_LABELS.human))) {
      expect(hasUnclearedReviewLabel(set, { allowPending: false })).toBe(true);
      expect(hasUnclearedReviewLabel(set, { allowPending: true })).toBe(true);
    }
  });
  it('…and so is a CO-PRESENT review:pending — the stale re-park pair the bare sweep would otherwise land', () => {
    for (const set of powerset(all).filter((s) => s.includes(REVIEW_LABELS.accepted)
      && s.includes(REVIEW_LABELS.pending) && !s.includes(REVIEW_LABELS.human))) {
      expect(hasUnclearedReviewLabel(set, { allowPending: false })).toBe(true);
      // The #2423 relief valve still waives it: that is an operator naming ONE PR, the same waiver a bare
      // `review:pending` gets. The pair is refused by DEFAULT, which is what the bare `/merge` sweep uses.
      expect(hasUnclearedReviewLabel(set, { allowPending: true })).toBe(false);
    }
  });
  it('bare sweep (allowPending:false): ANY of pending/human/changes (without accepted) ⇒ refuse', () => {
    for (const set of powerset(all).filter((s) => !s.includes(REVIEW_LABELS.accepted))) {
      const hasUncleared = [REVIEW_LABELS.pending, REVIEW_LABELS.human, REVIEW_LABELS.changes].some((l) => set.includes(l));
      expect(hasUnclearedReviewLabel(set, { allowPending: false })).toBe(hasUncleared);
    }
  });
  it('operator override (allowPending:true): pending is honoured, but human/changes are STILL refused', () => {
    for (const set of powerset(all).filter((s) => !s.includes(REVIEW_LABELS.accepted))) {
      const humanOrChanges = set.includes(REVIEW_LABELS.human) || set.includes(REVIEW_LABELS.changes);
      // human/changes always refuse; a lone pending is allowed through the override
      expect(hasUnclearedReviewLabel(set, { allowPending: true })).toBe(humanOrChanges);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 6 — the producer's PR-open label is consistent with the score: a POLICY-CORE or STATUTE open is
// ALWAYS review:human (never pending, never null), so a human-gated PR is human-gated from birth, not only once
// a drain sweeps it. An ENGINE (lander) open is review:pending (escalated, agent-reviewable — the #2445 flip).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 6 — producerReviewLabel matches the score across both tiers', () => {
  it('any DECLARATIVE-LEASH or STATUTE diff ⇒ producer label review:human, across noise', () => {
    for (const gateFile of [...DECLARATIVE_LEASH_FILES, ...STATUTE_FILES]) {
      for (const noise of powerset(LEAF_FILES)) {
        const score = scoreEscalation({ changedFiles: [...noise, gateFile] });
        expect(producerReviewLabel(score)).toBe(REVIEW_LABELS.human);
      }
    }
  });
  it('#2771 Fork A — a policy-tier DERIVATION-CODE diff ⇒ review:pending (committee), never review:human', () => {
    for (const gateFile of DERIVATION_CODE_FILES) {
      for (const noise of powerset(LEAF_FILES)) {
        expect(producerReviewLabel(scoreEscalation({ changedFiles: [...noise, gateFile] }))).toBe(REVIEW_LABELS.pending);
      }
    }
  });
  it('#2445 flip — an ENGINE (lander) diff ⇒ review:pending (escalated, agent-reviewable), never review:human', () => {
    for (const engineFile of ENGINE_FILES) {
      for (const noise of powerset(LEAF_FILES)) {
        expect(producerReviewLabel(scoreEscalation({ changedFiles: [...noise, engineFile] }))).toBe(REVIEW_LABELS.pending);
      }
    }
  });
  it('escalated-but-agent-reviewable ⇒ review:pending; a plain leaf ⇒ null', () => {
    expect(producerReviewLabel(scoreEscalation({ changedFiles: ['scripts/pr-land.mjs'] }))).toBe(REVIEW_LABELS.pending);
    expect(producerReviewLabel(scoreEscalation({ changedFiles: ['backlog/x.md'] }))).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 7 — a couple inherits the strictest member: one gate-self half makes the WHOLE couple human.
// Impl-first/WE-last ordering cannot tolerate half a human-gated couple slipping through.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 7 — a gate-self half taints the whole couple', () => {
  it('any member humanRequired ⇒ couple humanRequired, for every member arrangement', () => {
    const members = [{ escalate: true, humanRequired: true }, { escalate: false, humanRequired: false }, { escalate: true, humanRequired: false }];
    for (const a of members) for (const b of members) {
      const expected = a.humanRequired || b.humanRequired;
      expect(coupleEscalation([a, b]).humanRequired).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 8 — an empty/whitespace-only PR body never lands (#2324). Both the shared body guard and the PR
// classifier refuse it, even when everything else about the PR is landable.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 8 — an empty PR body never lands', () => {
  it('hasNonEmptyBody rejects every whitespace-only / absent body', () => {
    for (const b of ['', '   ', '\n\t ', undefined, null, 0]) expect(hasNonEmptyBody(b)).toBe(false);
    expect(hasNonEmptyBody('real content')).toBe(true);
  });
  it('classifyPr skips an otherwise-perfect PR with an empty body', () => {
    const v = classifyPr({
      number: 9, title: 'x', body: '   ',
      mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
      labels: [{ name: 'ready-to-merge' }],
      statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
    });
    expect(v.decision).toBe('skip');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 9 — a stale review:accepted NEVER auto-merges THROUGH decideReviewGate (#2409). A review:accepted
// verdict vouches ONLY for the tree the reviewer looked at. If the head has advanced past the reviewed
// commit-set, the acceptance is stale and this gate must NOT land it — no matter the escalation state, the
// human signal, or any other label. (This is the PR #368 hole: a second, unrelated commit honoured under an
// accept that named only the first.) SCOPE (honest): this pins the label-scoped DRAIN path, which routes
// through decideReviewGate. The bare `/merge` orphan-sweep path clears on the review:accepted LABEL alone via
// hasUnclearedReviewLabel (no SHA context) and is a documented residual, NOT covered by this invariant.
// The complementary property — an accept whose head STILL matches always merges — is pinned too, so the gate
// can never over-park (invalidate a legitimately-fresh accept). Proven over the full cross-product of inputs.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 9 — a stale review:accepted never auto-merges (#2409)', () => {
  const extraLabels = powerset([REVIEW_LABELS.pending, REVIEW_LABELS.human]);
  const cases = product(
    [false, true], // escalate
    [false, true], // humanRequired
  );
  it('accepted + head ADVANCED past the reviewed SHA ⇒ never merges, for every input arrangement', () => {
    for (const [escalate, humanRequired] of cases) {
      for (const extra of extraLabels) {
        const labels = [...extra, REVIEW_LABELS.accepted];
        const g = decideReviewGate({ escalate, humanRequired, labels, acceptedSha: 'aaaaaaa', headSha: 'bbbbbbb' });
        expect(AUTO_MERGE_ACTIONS).not.toContain(g.action);
        expect(g.staleAcceptance).toBe(true);
      }
    }
  });
  it('accepted + head STILL matches the reviewed SHA ⇒ always merges (never over-parks a fresh accept)', () => {
    for (const [escalate, humanRequired] of cases) {
      for (const extra of extraLabels) {
        const labels = [...extra, REVIEW_LABELS.accepted];
        const g = decideReviewGate({ escalate, humanRequired, labels, acceptedSha: 'abc1234', headSha: 'abc1234' });
        expect(g.action).toBe('merge');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 13 — A RE-SCORE NEVER REVOKES A RECORDED CLEARANCE (#x9xqexm). Two halves, both observed failing on
// WE PR #1100 (and PR #984) within 3m07s of a sanctioned `--to=clear-human` ceremony:
//   (a) a clearance covers the PR's own CONTRIBUTION, not the base it sits on — the drain rebasing an accepted
//       lane onto a newer `main` moves context lines and hunk offsets and must not invalidate the accept; and
//   (b) no automated pass may DELETE `review:accepted`. Refusing to land is the gate's verdict; deleting a
//       human's record is a reviewer action (`review-set-label.mjs --to=changes`) and nothing else.
// The complement is pinned too: content that the clearance did NOT cover still re-escalates, so a stale
// clearance can never launder a ride-in commit (the PR #368 hole stays shut — see INVARIANT 9).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 13 — a re-score never revokes a recorded clearance (#x9xqexm)', () => {
  // The measured PR #1100 shape: the SAME contribution replayed onto a newer `main`. Three things move and none
  // of them is the author's: the blob-pair headers, ONE CONTEXT LINE that main changed, and the hunk offsets
  // (the file grew above the hunk on main).
  const CLEARED = [
    'diff --git a/scripts/lib/review-escalation.mjs b/scripts/lib/review-escalation.mjs',
    'index 1fb268d1..191cf371 100644',
    '--- a/scripts/lib/review-escalation.mjs',
    '+++ b/scripts/lib/review-escalation.mjs',
    '@@ -197,3 +219,8 @@ What actually matters:',
    "  it('a policy-core diff (edits the leash-defining trust chain) → review:human, applied', () => {",
    '-const stale = true;',
    '+const stale = false;',
  ].join('\n');
  const REBASED_ONTO_NEWER_MAIN = [
    'diff --git a/scripts/lib/review-escalation.mjs b/scripts/lib/review-escalation.mjs',
    'index a18a829d..c79a543f 100644',                    // ← blob headers moved
    '--- a/scripts/lib/review-escalation.mjs',
    '+++ b/scripts/lib/review-escalation.mjs',
    '@@ -203,3 +225,8 @@ What actually matters:',    // ← hunk offsets moved (the file grew on main)
    "  it('a DECLARATIVE-LEASH diff (the roster — the encoded policy itself) → review:human, applied', () => {",
    '-const stale = true;',                               // ← the contribution is byte-identical
    '+const stale = false;',
  ].join('\n');
  const RIDE_IN = [
    REBASED_ONTO_NEWER_MAIN,
    '',
    'diff --git a/scripts/lib/gate-config.mjs b/scripts/lib/gate-config.mjs',
    'index aaaaaaa..bbbbbbb 100644',
    '--- a/scripts/lib/gate-config.mjs',
    '+++ b/scripts/lib/gate-config.mjs',
    '@@ -1 +1 @@',
    "-leash: 'spec',",
    "+leash: 'code',",
  ].join('\n');

  const cleared = [REVIEW_LABELS.accepted]; // what `--to=clear-human` leaves behind: human dropped, accepted added

  it('(a) a cleared PR survives a re-score at the SAME head — merge, no re-park', () => {
    for (const [escalate, humanRequired] of product([false, true], [false, true])) {
      const g = decideReviewGate({
        escalate, humanRequired, labels: cleared, acceptedSha: 'abc1234', headSha: 'abc1234',
      });
      expect(g.action).toBe('merge');
      expect(g.staleAcceptance).toBeFalsy();
    }
  });

  it('(a) a cleared PR survives the drain rebasing it onto a newer main — the base moved, not the contribution', () => {
    // The strict #x169fqe fingerprint CANNOT see this: it hashes the context and the hunk offsets too, which is
    // exactly why the clearance was revoked on #1100 despite that escape already existing.
    expect(normalizeDiffFingerprint(CLEARED)).not.toBe(normalizeDiffFingerprint(REBASED_ONTO_NEWER_MAIN));
    expect(normalizeContributionFingerprint(CLEARED)).toBe(normalizeContributionFingerprint(REBASED_ONTO_NEWER_MAIN));
    for (const [escalate, humanRequired] of product([false, true], [false, true])) {
      const g = decideReviewGate({
        escalate,
        humanRequired, // even a fresh leash score does not re-assert the gate over content already cleared
        labels: cleared,
        acceptedSha: '10b97e6a',
        headSha: '6b929515',
        acceptedDiff: CLEARED,
        headDiff: REBASED_ONTO_NEWER_MAIN,
        acceptedContribution: CLEARED,
        headContribution: REBASED_ONTO_NEWER_MAIN,
      });
      expect(g.action).toBe('merge');
      expect(g.staleAcceptance).toBeFalsy();
    }
  });

  it('(a) …but a cleared PR whose head ADVANCED onto a leash path DOES re-escalate, to review:human', () => {
    // The ride-in edits `gate-config.mjs` — the declarative leash — so the fresh score is humanRequired.
    const score = scoreEscalation({ changedFiles: ['scripts/lib/gate-config.mjs'] });
    expect(score.humanRequired).toBe(true);
    const g = decideReviewGate({
      escalate: score.escalate,
      humanRequired: score.humanRequired,
      labels: cleared,
      acceptedSha: '10b97e6a',
      headSha: '6b929515',
      acceptedDiff: CLEARED,
      headDiff: RIDE_IN,
      acceptedContribution: CLEARED,
      headContribution: RIDE_IN,
    });
    expect(AUTO_MERGE_ACTIONS).not.toContain(g.action);
    expect(g.staleAcceptance).toBe(true);
    expect(g.applyLabel).toBe(REVIEW_LABELS.human);
  });

  it('(a) the contribution escape is FAIL-CLOSED — a missing side can never honour an accept', () => {
    for (const args of [
      { acceptedContribution: CLEARED },
      { headContribution: REBASED_ONTO_NEWER_MAIN },
      { acceptedContribution: CLEARED, headContribution: '' },
      { acceptedContribution: null, headContribution: null }, // every pre-#x9xqexm accept
    ]) {
      expect(acceptanceCoversHead({ acceptedSha: 'aaaaaaa', headSha: 'bbbbbbb', ...args }).covers).toBe(false);
    }
  });

  it('(b) the drain issues NO `--remove-label review:accepted` anywhere — a re-score cannot strip a verdict', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs'), 'utf8');
    // Every label write in the drain is an `execFileSync('gh', ['pr','edit', …])` argv array, so the removal
    // this invariant forbids is literally the pair `'--remove-label', REVIEW_LABELS.accepted` (or the string).
    for (const forbidden of [
      /--remove-label'\s*,\s*REVIEW_LABELS\.accepted/,
      /--remove-label'\s*,\s*'review:accepted'/,
      /--remove-label=review:accepted/,
    ]) {
      expect(src).not.toMatch(forbidden);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 12 — THE LEASH SPLIT IS FAIL-CLOSED AND CANNOT SHRINK (#2771/#2785, pinned permanent by #2840
// trigger 3). The whole point of the narrowing is that a change to the ENCODED POLICY still reaches a human
// while its IMPLEMENTATION does not. Those two guarantees are only as good as the roster's classification, so
// this block pins the classification itself: the ratified leash floor is always human, the split partitions the
// policy tier exactly, every policy member declares its side explicitly, and an UNCLASSIFIED member falls to
// HUMAN rather than to the committee. A diff that has to weaken an assertion here is, by definition, moving the
// human boundary — the one class of change a human must look at.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 12 — the declarative-leash split is fail-closed and its floor cannot shrink', () => {
  it('every basename #2771 ratified as the declarative leash is STILL in POLICY_SPEC_BASENAMES', () => {
    for (const f of RATIFIED_POLICY_SPEC_FLOOR) {
      expect(POLICY_SPEC_BASENAMES.has(f)).toBe(true);   // dropping one would let an agent clear a policy change
      expect(POLICY_DERIVATION_BASENAMES.has(f)).toBe(false);
      expect(isPolicySpecPath(`any/relocated/dir/${f}`)).toBe(true); // the floor travels, like every other member
    }
  });
  it('every POLICY-tier member declares a VALID leash — an omission or a typo is a failing test, not a silent default', () => {
    for (const m of TRUST_CHAIN.filter((e) => e.tier === 'policy')) {
      expect([POLICY_LEASH.SPEC, POLICY_LEASH.CODE], `roster entry '${m.role}' must declare leash`).toContain(m.leash);
    }
  });
  it('an ENGINE-tier member never carries a leash (the field is meaningless off the policy tier)', () => {
    for (const m of TRUST_CHAIN.filter((e) => e.tier === 'engine')) expect(m.leash).toBeUndefined();
  });
  it('the two halves PARTITION the policy tier exactly — nothing lost, nothing double-counted', () => {
    const union = new Set([...POLICY_SPEC_BASENAMES, ...POLICY_DERIVATION_BASENAMES]);
    expect([...union].sort()).toEqual([...POLICY_CORE_BASENAMES].sort());
    for (const f of POLICY_SPEC_BASENAMES) expect(POLICY_DERIVATION_BASENAMES.has(f)).toBe(false);
    // …and every member of BOTH halves is still a trust-chain path, so both still ESCALATE.
    for (const f of union) expect(isTrustChainPath(f)).toBe(true);
  });
  it('FAIL-CLOSED — an unclassified / misspelled policy leash resolves to the HUMAN half, never the committee', () => {
    // The derivation predicate is `leash === 'code'` and the spec predicate is its complement WITHIN the policy
    // tier, so every value that is not exactly 'code' lands on the human side. Proven over the shapes a bad edit
    // actually produces rather than by re-reading the source.
    for (const bad of [undefined, null, '', 'CODE', 'Code', 'derivation', 'impl', 'spec ', 0, false, {}]) {
      const entry = { role: 'hypothetical', file: 'hypothetical.mjs', tier: 'policy', leash: bad };
      const specSide = entry.tier === 'policy' && entry.leash !== POLICY_LEASH.CODE;
      expect(specSide, `leash ${JSON.stringify(bad)} must fall to the HUMAN half`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 14 — an ENGINE-tier PR never auto-lands on `review:accepted` alone (#2412 layer 4). The lander /
// resident-daemon / dispatch-loop machinery is the surface that goes on to land every OTHER PR unattended, so
// stacking a SECOND, independent verdict (`redteam:accepted`, #2439) on top of the ordinary review is the whole
// point — one compromised or rubber-stamped review must not be enough to clear the machinery that then trusts
// itself for everything else. Proven over the full cross-product of inputs, exactly like INVARIANT 9 (whose
// staleness check this composes with, unchanged): `engineTier` is an ADDITIONAL requirement, never a
// substitute for it. A non-engine-tier PR (`engineTier:false`, every pre-#2412 caller) is UNCHANGED by this —
// see the complementary "always merges" case below.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 14 — engine tier never auto-lands without redteam:accepted (#2412)', () => {
  const cases = product(
    [false, true], // escalate
    [false, true], // humanRequired
  );
  it('every ENGINE_FILES member is classified isEngineTierPath — the roster the invariant below relies on', () => {
    for (const f of ENGINE_FILES) expect(isEngineTierPath(f)).toBe(true);
  });
  it('engineTier:true + review:accepted, NO redteam:accepted ⇒ never merges, for every input arrangement', () => {
    for (const [escalate, humanRequired] of cases) {
      const g = decideReviewGate({
        escalate, humanRequired, labels: [REVIEW_LABELS.accepted], engineTier: true,
        acceptedSha: 'abc1234', headSha: 'abc1234', // fresh accept — isolates the engine-tier check specifically
      });
      expect(AUTO_MERGE_ACTIONS).not.toContain(g.action);
      expect(g.action).toBe('park');
      expect(g.applyLabel).toBe(REVIEW_LABELS.pending);
    }
  });
  it('engineTier:true + review:accepted + redteam:accepted ⇒ always merges (both verdicts stacked)', () => {
    for (const [escalate, humanRequired] of cases) {
      const g = decideReviewGate({
        escalate, humanRequired,
        labels: [REVIEW_LABELS.accepted, REVIEW_LABELS.redteamAccepted],
        engineTier: true, acceptedSha: 'abc1234', headSha: 'abc1234',
      });
      expect(g.action).toBe('merge');
    }
  });
  it('engineTier:false (or omitted) ⇒ review:accepted alone still merges — this story adds no requirement off the engine tier', () => {
    for (const [escalate, humanRequired] of cases) {
      const g = decideReviewGate({
        escalate, humanRequired, labels: [REVIEW_LABELS.accepted],
        acceptedSha: 'abc1234', headSha: 'abc1234',
      });
      expect(g.action).toBe('merge');
    }
  });

  // #1920 round-2 review — the drain's ONE live call site (`runCli` in `merge-ai-prs.mjs`) does not yet wire
  // this invariant's real predicate into production: main's own `#3493` ("decideReviewGate must require
  // redteam:accepted before an engine-tier auto-land") deliberately stays `blockedBy: ["2410"]` — no code-level
  // /daemon-reachable writer applies `redteam:accepted` to a live PR yet. `basisTouchesEngineTier` is the real,
  // tested `score.basisFiles → engineTier` computation (ready to wire in); `engineTierForCandidate` is what the
  // call site ACTUALLY uses today, and is pinned here at `false` so re-enabling it is a deliberate, reviewed
  // test change — not a silent side effect of an unrelated refactor.
  it('the live call site does NOT enforce this yet (#3493 blockedBy #2410) — engineTierForCandidate is pinned false', () => {
    const engineScore = { basisFiles: [...ENGINE_FILES] };
    expect(basisTouchesEngineTier(engineScore)).toBe(true); // the real predicate DOES see the engine-tier basis…
    expect(engineTierForCandidate(engineScore)).toBe(false); // …but the call site's actual value stays false
  });
  it('basisTouchesEngineTier is false for a basis with no engine-tier member', () => {
    expect(basisTouchesEngineTier({ basisFiles: ['docs/README.md'] })).toBe(false);
    expect(basisTouchesEngineTier({})).toBe(false);
    expect(basisTouchesEngineTier({ basisFiles: [] })).toBe(false);
  });
  it('once wired, the real predicate composes with decideReviewGate exactly like INVARIANT 14 above', () => {
    const engineScore = { basisFiles: [...ENGINE_FILES] };
    const wiredEngineTier = basisTouchesEngineTier(engineScore); // what `engineTierForCandidate` will delegate to
    const g = decideReviewGate({
      escalate: true, humanRequired: false, labels: [REVIEW_LABELS.accepted], engineTier: wiredEngineTier,
      acceptedSha: 'abc1234', headSha: 'abc1234',
    });
    expect(g.action).toBe('park');
    expect(g.awaitingIndependentValidator).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 15 — a FRESH `review:accepted` stamped while clearing an EXPLICIT review hold must not let a stale
// `redteam:accepted` (no SHA marker of its own, #2439) ride through from an earlier, different head (#1920
// round-2 review — the concrete instance: `clear-human`). The documented EXCEPTION is the plain `accepted`
// target: it fresh-stamps `review:accepted` too, but from `pending`/`changes` rather than from clearing an
// explicit hold, and the engine-tier happy path (INVARIANT 14) relies on it PRESERVING a freshly-applied
// `redteam:accepted` so the two independent verdicts can stack for the same head — stripping it there would
// make the two sign-offs unable to ever coexist. `restamp` never fresh-stamps at all (its own precondition
// requires `review:accepted` already present — it carries an existing acceptance across a rebase, deciding
// nothing new). This enumerates `REVIEW_LABEL_TARGETS` (the closed set) so a newly added target is forced to
// make the same call deliberately rather than by omission.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 15 — a fresh review:accepted stamped while clearing an explicit hold strips stale redteam:accepted (#1920)', () => {
  const CLEARS_HOLD_AND_ACCEPTS = ['clear-human'];                    // strips stale redteam:accepted
  const ACCEPTS_WITHOUT_CLEARING_A_HOLD = ['accepted'];               // deliberately preserves it (INVARIANT 14)
  const NEVER_FRESH_STAMPS_ACCEPTED = ['changes', 'rearm', 'restamp']; // addLabel is never a FRESH review:accepted

  it('every REVIEW_LABEL_TARGETS member is classified into exactly one bucket — a new target cannot slip through unclassified', () => {
    for (const t of REVIEW_LABEL_TARGETS) {
      const buckets = [CLEARS_HOLD_AND_ACCEPTS, ACCEPTS_WITHOUT_CLEARING_A_HOLD, NEVER_FRESH_STAMPS_ACCEPTED]
        .filter((b) => b.includes(t));
      expect(buckets.length).toBe(1);
    }
  });

  it('clear-human strips a stale redteam:accepted', () => {
    for (const to of CLEARS_HOLD_AND_ACCEPTS) {
      const d = decideSetLabel({
        to, currentLabels: [{ name: REVIEW_LABELS.human }, { name: REVIEW_LABELS.redteamAccepted }],
      });
      expect(d.allowed).toBe(true);
      expect(d.addLabel).toBe(REVIEW_LABELS.accepted);
      expect(d.removeLabels).toContain(REVIEW_LABELS.redteamAccepted);
    }
  });

  it('accepted (no explicit hold cleared) PRESERVES redteam:accepted — the two verdicts must be able to stack', () => {
    for (const to of ACCEPTS_WITHOUT_CLEARING_A_HOLD) {
      const d = decideSetLabel({
        to, currentLabels: [{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.redteamAccepted }],
      });
      expect(d.allowed).toBe(true);
      expect(d.addLabel).toBe(REVIEW_LABELS.accepted);
      expect(d.removeLabels).not.toContain(REVIEW_LABELS.redteamAccepted);
    }
  });

  it('changes/rearm never fresh-stamp review:accepted; restamp carries an EXISTING one forward untouched', () => {
    for (const to of ['changes', 'rearm']) {
      const d = decideSetLabel({ to, currentLabels: [{ name: REVIEW_LABELS.changes }] });
      expect(d.addLabel).not.toBe(REVIEW_LABELS.accepted);
    }
    const restamped = decideSetLabel({
      to: 'restamp', currentLabels: [{ name: REVIEW_LABELS.accepted }, { name: REVIEW_LABELS.redteamAccepted }],
    });
    expect(restamped.allowed).toBe(true);
    expect(restamped.addLabel).toBe(REVIEW_LABELS.accepted); // re-stamps the SAME acceptance, decides nothing new
    expect(restamped.removeLabels).not.toContain(REVIEW_LABELS.redteamAccepted); // carries it forward untouched
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 16 — CROSS-PATH DIVERGENCE, DOCUMENTED (#1920 round-2 review). `decideReviewGate` (INVARIANT 14)
// and `hasUnclearedReviewLabel` (the bare `/merge` orphan-sweep's non-scoring merge-eligibility predicate,
// INVARIANT 9's own SCOPE note) are TWO SEPARATE checks reached by two separate CLI paths, and #2412's
// engine-tier requirement is enforced by only ONE of them: `hasUnclearedReviewLabel` has no file-diff access,
// so it structurally CANNOT apply "does this PR's basis touch an engine-tier member" (see its docblock in
// `review-escalation.mjs`, and `backlog/xy5uey0-…md`). This is a KNOWN, tracked residual, not an oversight this
// suite failed to catch — pinning it here as an EXPLICIT, named fact means closing `xy5uey0` means touching
// THIS test deliberately, rather than the divergence silently drifting further unnoticed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 16 — the bare /merge orphan-sweep path does not (yet) enforce the engine-tier requirement (#1920, tracked xy5uey0)', () => {
  it('an engine-tier PR with ONLY review:accepted (no redteam:accepted) is refused by decideReviewGate…', () => {
    const g = decideReviewGate({
      escalate: true, humanRequired: false, labels: [REVIEW_LABELS.accepted], engineTier: true,
      acceptedSha: 'abc1234', headSha: 'abc1234',
    });
    expect(AUTO_MERGE_ACTIONS).not.toContain(g.action);
  });
  it('…but clears the bare-sweep predicate regardless — hasUnclearedReviewLabel has no file-diff access to know it is engine-tier', () => {
    expect(hasUnclearedReviewLabel([REVIEW_LABELS.accepted])).toBe(false);
    expect(hasUnclearedReviewLabel([REVIEW_LABELS.accepted], { allowPending: true })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// INVARIANT 17 — parks clear pending and superseded acceptance, preserving explicit send-backs (#3507).
// keepHumanClearance also preserves accepted when the caller cannot prove the clearance stale.
describe('INVARIANT 17 — park cleanup preserves send-backs and proven human clearance', () => {
  const VERDICT_LABELS = [REVIEW_LABELS.pending, REVIEW_LABELS.accepted, REVIEW_LABELS.changes, REVIEW_LABELS.human];

  it('decideParkToHuman(keepHumanClearance:false) preserves exactly human and any send-back, over every label subset', () => {
    for (const set of powerset(VERDICT_LABELS)) {
      const decision = decideParkToHuman({ currentLabels: set, keepHumanClearance: false });
      const removed = new Set(decision.removeLabels);
      const after = [...new Set([...set.filter((l) => !removed.has(l)), decision.addLabel])];
      expect(after.sort()).toEqual([REVIEW_LABELS.human, ...set.filter(l => l === REVIEW_LABELS.changes)].sort());
    }
  });

  it('decideParkToHuman(keepHumanClearance:true) preserves co-present acceptance and send-back, never pending', () => {
    for (const set of powerset(VERDICT_LABELS)) {
      const decision = decideParkToHuman({ currentLabels: set, keepHumanClearance: true });
      const removed = new Set(decision.removeLabels);
      const after = [...new Set([...set.filter((l) => !removed.has(l)), decision.addLabel])];
      expect(after.sort()).toEqual([REVIEW_LABELS.human,
        ...set.filter(l => l === REVIEW_LABELS.accepted || l === REVIEW_LABELS.changes)].sort());
    }
  });

  it('findContradictoryReviewVerdicts is the CHECK — flags 2+, never 0 or 1, over the full verdict powerset', () => {
    for (const set of powerset(VERDICT_LABELS)) {
      const verdictsPresent = VERDICT_LABELS.filter((l) => set.includes(l));
      const flagged = findContradictoryReviewVerdicts(set);
      if (verdictsPresent.length > 1) expect(flagged.sort()).toEqual(verdictsPresent.sort());
      else expect(flagged).toEqual([]);
    }
  });

  it('#2766/#2767\'s own real label state is caught by the check (regression pin)', () => {
    const live = [REVIEW_LABELS.accepted, REVIEW_LABELS.human, 'review-status:reviewing', 'review-round:1', REVIEW_LABELS.awaitingAdvisory];
    expect(findContradictoryReviewVerdicts(live).sort()).toEqual([REVIEW_LABELS.accepted, REVIEW_LABELS.human].sort());
  });
});

describe('INVARIANT 18 — the review-hold sweep never flags a send-back the park preserved (#3657)', () => {
  const VERDICT_LABELS = [REVIEW_LABELS.pending, REVIEW_LABELS.accepted, REVIEW_LABELS.changes, REVIEW_LABELS.human];

  it('keepHumanClearance:false — no park outcome is ever flagged', () => {
    for (const set of powerset(VERDICT_LABELS)) {
      const decision = decideParkToHuman({ currentLabels: set, keepHumanClearance: false });
      const removed = new Set(decision.removeLabels);
      const after = [...new Set([...set.filter((l) => !removed.has(l)), decision.addLabel])];
      expect(planReviewHoldCleanup({ currentLabels: after }).flagged).toBeUndefined();
    }
  });

  it('keepHumanClearance:true — only accepted+human is flagged, never review:changes', () => {
    for (const set of powerset(VERDICT_LABELS)) {
      const decision = decideParkToHuman({ currentLabels: set, keepHumanClearance: true });
      const removed = new Set(decision.removeLabels);
      const after = [...new Set([...set.filter((l) => !removed.has(l)), decision.addLabel])];
      const { flagged } = planReviewHoldCleanup({ currentLabels: after });
      expect(flagged ?? []).not.toContain(REVIEW_LABELS.changes);
      expect(flagged).toEqual(after.includes(REVIEW_LABELS.accepted)
        ? [REVIEW_LABELS.accepted, REVIEW_LABELS.human].sort() : undefined);
    }
  });
});
