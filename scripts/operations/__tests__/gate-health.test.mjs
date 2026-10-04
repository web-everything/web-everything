/**
 * @file gate-health.test.mjs — proof of the `gate-health` operation and the statistics behind it.
 *
 * The load-bearing tests are the four PRECONDITIONS. Each removes a way the naive comparison lies, and each
 * has a mutation test: delete the correction and a named test goes red.
 */
import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../registry.mjs';
import { startRun, advanceWhileRunning } from '../engine.mjs';
import { isReadOnlyDeclaration } from '../http-adapter.mjs';
import { importGraph } from './import-graph.mjs';
import {
  bandOf, classifyFollowUp, stratifyBySize, compareProportions, compareGroups,
  assessCriteria, censor, clusterEffectiveN, requiredNPerGroup, expectedValidityFloorNPerGroup,
  zForAlpha, SIZE_BANDS,
} from '../../lib/gate-health.mjs';
import { joinHistory, hotFileCut, HOT_FILE_MIN, createHistoryReader } from '../gate-health-io.mjs';
import { gateHealthOperation, GATE_HEALTH_REPOS, GATE_HEALTH_OP, clampLimit, shapeHistoryFinding } from '../gate-health.mjs';
import { OPERATIONS } from '../run.mjs';

const NOW = 1_800_000_000;
const DAY = 86_400;
/** A record merged `ageDays` ago — old enough to be observable unless stated. */
const pr = (n, lines, escalated, followUp = null, ageDays = 60, followUpSource = null) => ({
  number: n, title: `pr ${n}`, lines, files: 2, escalated, followUp, followUpSource,
  mergedAtSec: NOW - ageDays * DAY,
});

function runGateHealth(input = {}, history) {
  const declaration = gateHealthOperation({ loadHistory: () => history });
  const registry = createRegistry();
  registry.register(declaration);
  return { declaration, run: advanceWhileRunning(startRun({ op: GATE_HEALTH_OP, id: 'run-gh-test', input, registry }), { registry }) };
}

describe('the operation is REGISTERED — it shipped callable by nothing', () => {
  it('run.mjs can resolve it', () => {
    // PR #1163 declared it and never registered it, so `resolveOperation` threw and the whole
    // "an operation, not a script" claim was false. A declaration nothing can reach is a script with extra steps.
    expect(Object.keys(OPERATIONS)).toContain(GATE_HEALTH_OP);
    expect(typeof OPERATIONS[GATE_HEALTH_OP]).toBe('function');
  });
});

describe('precondition 1 — a review-driven fix is the gate WORKING, not a defect', () => {
  it('separates the two populations by real merge subjects', () => {
    for (const s of ['Merge pull request #1147 from chalbert/lane/fix-live-review-findings',
      'Merge pull request #1043 from chalbert/lane/memory-land-bar-review-fix']) {
      expect(classifyFollowUp(s), s).toBe('review-followup');
    }
    for (const s of ['fix(board): count declarations', 'Revert "the digest change"']) {
      expect(classifyFollowUp(s), s).toBe('independent-fix');
    }
    expect(classifyFollowUp('feat(judge): the tool-free juror spawn')).toBeNull();
  });

  it('counts only independent fixes as defects', () => {
    const band = { escalated: Array.from({ length: 12 }, (_, i) => pr(100 + i, 1200, true, i < 10 ? 'review-followup' : 'independent-fix')), clean: [] };
    const out = compareGroups(band);
    expect(out.escalated.k).toBe(2);
    expect(out.escalated.reviewDriven).toBe(10);
  });
});

describe('precondition 2 — censoring, the confound that survived the first build', () => {
  it('excludes a PR whose follow-up window has not closed', () => {
    // A PR merged 3 days ago cannot show a 14-day follow-up. Scoring it "no defect" is not an observation.
    const recent = pr(1, 100, true, null, 3);
    const old = pr(2, 100, true, null, 60);
    const out = censor([recent, old], { nowSec: NOW, windowDays: 14 });
    expect(out.observed.map((r) => r.number)).toEqual([2]);
    expect(out.censored).toBe(1);
  });

  it('reports the per-group age gap, which is what makes censoring a BIAS rather than noise', () => {
    const out = censor([pr(1, 10, true, null, 2), pr(2, 10, true, null, 4), pr(3, 10, false, null, 40), pr(4, 10, false, null, 60)], { nowSec: NOW });
    expect(out.medianAgeDaysEscalated).toBeLessThan(out.medianAgeDaysClean);
  });

  it('blocks a verdict when most of the window is unobservable', () => {
    const records = Array.from({ length: 20 }, (_, i) => pr(i, 100, i % 2 === 0, null, 2));
    const out = assessCriteria({ records, nowSec: NOW });
    expect(out.verdict.conclusive).toBe(false);
    expect(out.verdict.blockers.join(' ')).toMatch(/censoring/);
  });
});

describe('precondition 3 — clustered observations', () => {
  it('counts one fix commit touching many PRs as ONE source, not many trials', () => {
    const records = Array.from({ length: 15 }, (_, i) => pr(200 + i, 100, true, 'independent-fix', 60, 'sha-one'));
    const out = clusterEffectiveN(records);
    expect(out.observations).toBe(15);
    expect(out.distinctSources).toBe(1);
    expect(out.largestClusterShare).toBe(1);
    expect(out.clustered).toBe(true);
  });

  it('does not flag genuinely independent observations', () => {
    const records = Array.from({ length: 10 }, (_, i) => pr(300 + i, 100, true, 'independent-fix', 60, `sha-${i}`));
    expect(clusterEffectiveN(records).clustered).toBe(false);
  });

  // MEDIUM clumping used to pass. A 0.5 threshold let 20 observations from 11 commits read as independent
  // while the interval was built on 20 trials that do not exist. The test is "are these independent at all".
  it('flags medium clumping, not only the extreme case', () => {
    const records = [
      ...Array.from({ length: 10 }, (_, i) => pr(400 + i, 100, true, 'independent-fix', 60, 'shared-sha')),
      ...Array.from({ length: 10 }, (_, i) => pr(420 + i, 100, true, 'independent-fix', 60, `own-${i}`)),
    ];
    const out = clusterEffectiveN(records);
    expect(out.observations).toBe(20);
    expect(out.distinctSources).toBe(11);
    expect(out.clustered).toBe(true);
  });
});

describe('the repo input reaches the reader', () => {
  // It was validated against the enum and then never passed, so `--repo=frontier-ui/frontierui` was accepted and
  // answered with web-everything's history — a wrong answer wearing the right label.
  it('a request for another repo is refused, not silently answered with this one', () => {
    const reader = createHistoryReader({ repo: 'web-everything/web-everything', classify: classifyFollowUp });
    expect(() => reader({ repo: 'frontier-ui/frontierui' })).toThrow(/bound to web-everything\/web-everything/);
  });

  it('the declaration passes `repo` through', () => {
    let seen = null;
    const declaration = gateHealthOperation({
      loadHistory: (o) => { seen = o.repo; return { repo: o.repo, nowSec: NOW, records: [], unmeasurable: 0, hotFiles: [] }; },
    });
    const registry = createRegistry();
    registry.register(declaration);
    advanceWhileRunning(startRun({ op: GATE_HEALTH_OP, id: 'r-repo', input: { repo: 'frontier-ui/frontierui' }, registry }), { registry });
    expect(seen).toBe('frontier-ui/frontierui');
  });
});

describe('precondition 4 — multiplicity, and the interval', () => {
  it('tightens alpha for the number of bands actually tested', () => {
    // Five uncorrected tests at 0.05 is a family-wise error near 25%. An untestable band is not a test, so
    // the correction is over the testable ones only.
    const wide = compareProportions({ n: 60, k: 30 }, { n: 60, k: 20 }, { alpha: 0.05 });
    const tight = compareProportions({ n: 60, k: 30 }, { n: 60, k: 20 }, { alpha: 0.01 });
    expect(tight.ci[1] - tight.ci[0]).toBeGreaterThan(wide.ci[1] - wide.ci[0]);
    expect(zForAlpha(0.05)).toBeCloseTo(1.96, 2);
    expect(zForAlpha(0.01)).toBeCloseTo(2.576, 2);
  });

  it('forces `separated` false when the normal approximation is invalid', () => {
    const tiny = compareProportions({ n: 8, k: 2 }, { n: 200, k: 180 });
    expect(tiny.usable).toBe(false);
    expect(tiny.separated).toBe(false);
  });

  it('reports WHICH group is worse — the headline used to assert one direction regardless', () => {
    // Fed data where CLEAN PRs are worse, the old summary still said escalation correlates with defects.
    const records = [
      ...Array.from({ length: 60 }, (_, i) => pr(400 + i, 200, true, i < 6 ? 'independent-fix' : null, 60, `e${i}`)),
      ...Array.from({ length: 60 }, (_, i) => pr(500 + i, 200, false, i < 30 ? 'independent-fix' : null, 60, `c${i}`)),
    ];
    const out = assessCriteria({ records, nowSec: NOW });
    expect(out.bands.m.comparison.direction).toBe('clean-worse');
    expect(out.verdict.summary).toMatch(/UNESCALATED/);
    expect(out.verdict.summary).not.toMatch(/escalated PRs are followed/);
  });
});

describe('the verdict names blockers rather than producing a number it cannot support', () => {
  it('reports required-n at the observed base rate — the actionable output', () => {
    const out = assessCriteria({ records: Array.from({ length: 40 }, (_, i) => pr(i, 100, i % 2 === 0, i < 2 ? 'independent-fix' : null, 60, `s${i}`)), nowSec: NOW });
    expect(out.power.requiredNPerGroup).toBe(requiredNPerGroup(out.power.baseRate, 0.05));
    expect(out.verdict.blockers.join(' ')).toMatch(/insufficient observations/);
  });

  // PINNED AGAINST A REFERENCE, not against itself. The previous test compared the function to its own output,
  // so dropping the 80%-power term (404 → 232) left it green and the headline "~404" number unpinned.
  // Reference: n = (z_{α/2} + z_β)² · 2p̄(1−p̄) / d² with p̄ = p + d/2, z = 1.96 / 0.84. Computed
  // independently of this module, then rounded up: p=0.044,d=0.05 → 403; p=0.5,d=0.1 → 389.
  // Dropping the 0.84 power term changes both, which is what the previous self-comparison missed.
  it('required-n matches the textbook two-proportion formula, not just itself', () => {
    expect(requiredNPerGroup(0.044, 0.05)).toBe(403);
    expect(requiredNPerGroup(0.5, 0.1)).toBe(389);
    // A RARER event needs more, up to p̄=0.5 — pinned as values, not as an inequality, so a monotonicity bug
    // in either direction is caught.
    expect(requiredNPerGroup(0.02, 0.05)).toBe(270);
    expect(requiredNPerGroup(0.2, 0.05)).toBe(1094);
    // A bigger detectable difference needs far fewer.
    expect(requiredNPerGroup(0.044, 0.2)).toBe(49);
  });

  // #3090. Every case above sits in the range the shipped callers use — defect rates well under 0.5 — which
  // is precisely why the boundary break survived. At a 98% base rate the function answered `1`: `pbar` hit
  // its `1 - 1e-6` clamp, `pbar * (1 - pbar)` collapsed to ~0, and the numerator went with it. The tool that
  // tells a reader whether they have enough data was saying one observation is plenty.
  it('refuses instead of answering when a detectable rise would exceed 100%', () => {
    // p + d > 1: there is no comparison arm at 1.03, so no sample size detects one.
    expect(requiredNPerGroup(0.98, 0.05)).toBeNull();
    expect(requiredNPerGroup(0.99, 0.05)).toBeNull();
    // The silent half of the bug, and the worse one. 0.96 never reached the clamp — it returned a
    // plausible 93 for an effect that cannot occur, so nothing looked wrong.
    expect(requiredNPerGroup(0.96, 0.05)).toBeNull();
    // The refusal tracks `mdd`, not a hardcoded rate — the same base rate answers with a smaller step.
    expect(requiredNPerGroup(0.96, 0.1)).toBeNull();
    // p̄ = 0.97 → 7.84 · 2 · 0.0291 / 0.0004 = 1140.72, rounded up. Derived by hand, not read off the
    // output. (An earlier comment said 1140.5; the ceiling is 1141 either way, but a derivation offered
    // as the reason to trust a constant has to be right.)
    expect(requiredNPerGroup(0.96, 0.02)).toBe(1141);
  });

  // #1203 review, finding 4. An earlier cut of this fix used `p + d > 1` and pinned 153 here, on the
  // reasoning that "at p + d === 1 the arm is 1.0, not past it". The arm being exactly 1.0 IS the problem:
  // its variance q(1 - q) is zero, so there is no normal approximation to invert and no n at which this
  // module's own `compareProportions` would accept it — zero failures at every n. 153 was the PR's own
  // "credible wrong number" one row down, and the backlog card was telling the next author to derive a
  // constant from it.
  it('refuses at the boundary too, where the comparison arm is a point mass at 1.0', () => {
    expect(requiredNPerGroup(0.95, 0.05)).toBeNull();
    expect(requiredNPerGroup(0.5, 0.5)).toBeNull();
    expect(requiredNPerGroup(0, 1)).toBeNull();
    // Just below it an answer still exists, so the refusal is a boundary and not a blanket.
    expect(requiredNPerGroup(0.94, 0.05)).toBe(212);
  });

  // #1203 review, finding 3. The clamps ran BEFORE the guard, so it tested a different pair than the
  // caller passed — and disagreed in both directions. Both of these were live: the first was answered
  // (7839997) although the true sum exceeds 1, the second refused although the true sum is exactly 1.
  // With the clamps gone the stated rule is the implemented rule. Mutation-proven: re-adding either clamp
  // reddens this test.
  it('guards the arguments AS PASSED, not a clamped version of them', () => {
    expect(requiredNPerGroup(0.9999999, 1e-6)).toBeNull();  // sums to 1.0000009 — impossible
    expect(requiredNPerGroup(1, 0.05)).toBeNull();
    expect(requiredNPerGroup(-0.5, 0.05)).toBeNull();       // was 153, via a clamp up to 1e-6
    expect(requiredNPerGroup(1.5, 0.05)).toBeNull();
    // A base rate of exactly 0 is NOT refused: p̄ = d / 2 is non-degenerate, and a rise from 0 can occur.
    // p̄ = 0.025 → 7.84 · 2 · 0.025 · 0.975 / 0.0025 = 152.88, rounded up.
    expect(requiredNPerGroup(0, 0.05)).toBe(153);
  });

  // THE ABSENCE OF THE CLAMP, pinned on its own. Re-adding `Math.min(1 - 1e-6, …)` leaves every assertion
  // above green: once the boundary became `>=`, a clamped base rate and a raw one agree on null for every
  // `mdd` at or above 1e-6, so the clamp is invisible in any realistic range. It is NOT invisible below
  // that, and a surviving mutation is a finding whether or not the input is realistic — this is the case
  // that distinguishes them. `mdd = 5e-8` is deliberately absurd; the assertion is a regression guard
  // against the clamp coming back, not a scenario anyone should run.
  it('does not clamp the base rate before computing, either', () => {
    // p̄ from the raw 0.9999999 → 470399965. From a clamped 0.999999 → 6115194039, thirteen times larger.
    expect(requiredNPerGroup(0.9999999, 5e-8)).toBe(470399965);
  });

  // #1203 review, finding 2 and finding 5. `Number(mdd) || 0.05` silently replaced an explicit zero, and
  // `Number(baseRate) || 0` silently replaced NaN — both reachable, neither tested. Mutation-proven:
  // restoring either `||` fallback reddens this test.
  it('refuses a step it cannot size rather than substituting a default for it', () => {
    expect(requiredNPerGroup(0.5, 0)).toBeNull();           // was 1565 — a 5-point answer to a 0-point ask
    expect(requiredNPerGroup(0.5, -0.05)).toBeNull();       // was 3919999999997, via a clamp to 1e-6
    expect(requiredNPerGroup(NaN, 0.05)).toBeNull();        // was 153
    expect(requiredNPerGroup(undefined, 0.05)).toBeNull();  // was 153
    expect(requiredNPerGroup(0.5, NaN)).toBeNull();
    expect(requiredNPerGroup(0.5, Infinity)).toBeNull();
    // The DEFAULT still applies — refusing an omitted `mdd` would break every existing caller.
    expect(requiredNPerGroup(0.5)).toBe(1565);
  });

  // #1203 round 2, finding 7. The guard coerced, and `Number(null)` / `Number([])` are both 0 — so a base
  // rate nobody supplied was silently replaced by 0 and answered 153. That is the same silent substitution
  // the docstring says was removed, surviving through `Number()` instead of through `|| 0`. It is now a
  // `typeof` check. Mutation-proven: restoring `Number(baseRate)` reddens this test.
  it('refuses a non-number rather than coercing one into existence', () => {
    // `'0.1'` earns its place: every other value here coerces to 0, 1 or NaN, all of which the domain and
    // boundary guards refuse anyway — so with only those, coercing `mdd` is invisible. At `p = 0.5` a
    // coerced `'0.1'` answers 389 while `typeof` refuses. (`'0.5'` would NOT distinguish them: 0.5 + 0.5
    // lands exactly on the boundary and is refused either way.)
    for (const bad of [null, [], '0.5', '0.1', {}, true, '']) {
      expect(`${JSON.stringify(bad)}: ${requiredNPerGroup(bad, 0.05)}`).toBe(`${JSON.stringify(bad)}: null`);
      expect(`${JSON.stringify(bad)}: ${requiredNPerGroup(0.5, bad)}`).toBe(`${JSON.stringify(bad)}: null`);
    }
    // THE ONE EXCEPTION, and it is stated in the docstring rather than left to be discovered: an OMITTED
    // `mdd` takes the documented default, so these two agree. An omitted `baseRate` has no default.
    expect(requiredNPerGroup(0.5, undefined)).toBe(1565);
    expect(requiredNPerGroup(0.5)).toBe(1565);
    expect(requiredNPerGroup(undefined, 0.05)).toBeNull();
  });

  it('the blocker reports the shortfall in counts, and prints no null', () => {
    // 39 of 40 defects. All 20 escalated records are defects, so the `escalated non-defects` cell holds 0 —
    // the whole 5 short, and the smallest of the four cells.
    const records = Array.from({ length: 40 }, (_, i) => pr(i, 100, i % 2 === 0, i < 39 ? 'independent-fix' : null, 60, `s${i}`));
    const out = assessCriteria({ records, nowSec: NOW });
    expect(out.power.requiredNPerGroup).toBeNull();
    const blocker = out.verdict.blockers.find((b) => b.startsWith('insufficient observations'));
    // Two cells are short — escalated non-defects at 0 and clean non-defects at 1 — so the distance is 9,
    // not the 5 the single worst cell would report. Both are named.
    expect(blocker).toMatch(/closest is band `s`, 9 observation\(s\) short across 2 cell\(s\) — escalated non-defects: 0 of 5; clean non-defects: 1 of 5/);
    expect(blocker).not.toMatch(/null|undefined|NaN/);
    // NO MODELLED NUMBER AND NO RATE IN THE PROSE — the round-3 model change. The blocker states the
    // validity fact in counts; every sample size and every rate lives in `power.perBand`.
    expect(blocker).not.toMatch(/~\d+ PRs per group/);
    expect(blocker).not.toMatch(/\d+(\.\d+)?%/);
    expect(blocker).not.toMatch(/no sample size would/);
  });

  /**
   * #1203 round 2, finding 1 — a NEW regression of the round-1 class, and the reason the sentence stopped
   * fusing. The categorical branch inferred a REASON from a `null` it never checked: `requiredNPerGroup`
   * returns null for four distinct reasons and only one of them says anything about a band. A negative
   * `minDetectableDiff` made every band null at once and lit the branch with
   * "every band's clean arm is already within -5 points of 100%" — printed beside a payload showing a band
   * at 10.0%, and strictly worse than the visibly-absurd huge number `main` printed for the same input.
   */
  it('an unsizeable `mdd` is its OWN blocker, naming the input, not a claim about bands', () => {
    const records = [
      ...Array.from({ length: 20 }, (_, i) => pr(i, 10, i % 2 === 0, i < 2 ? 'independent-fix' : null, 60, `a${i}`)),
      ...Array.from({ length: 20 }, (_, i) => pr(100 + i, 2000, i % 2 === 0, 'independent-fix', 60, `b${i}`)),
    ];
    for (const bad of [-0.05, 0, 1, 1.5, NaN, Infinity]) {
      const out = assessCriteria({ records, nowSec: NOW, mdd: bad });
      const unsizeable = out.verdict.blockers.find((b) => b.startsWith('unsizeable effect'));
      expect(`${bad}: ${typeof unsizeable}`).toBe(`${bad}: string`);
      expect(unsizeable).toMatch(/`minDetectableDiff` is/);
      // The observations blocker must say NOTHING about why the power figures are null — no inferred
      // reason, no rate, no number it did not count.
      const obs = out.verdict.blockers.find((b) => b.startsWith('insufficient observations'));
      expect(obs).not.toMatch(/points? of 100%/);
      expect(obs).not.toMatch(/\d+(\.\d+)?%/);
      expect(obs).not.toMatch(/~\d+ PRs per group/);
      // And the payload must not contradict itself: a band at 10% is still reported as being at 10%.
      const xs = out.power.perBand.find((b) => b.band === 'xs');
      expect(xs.baseRate).toBeCloseTo(0.1, 10);
      expect(xs.requiredNPerGroup).toBeNull();
    }
    // A SIZEABLE mdd raises no such blocker — otherwise the assertion above passes for the wrong reason.
    const ok = assessCriteria({ records, nowSec: NOW, mdd: 0.2 });
    expect(ok.verdict.blockers.find((b) => b.startsWith('unsizeable effect'))).toBeUndefined();
  });

  /**
   * #1203 round 3, findings 3 and 5 — the cells and the boundary. Seven mutations survived round 3 here:
   * swapping either CLEAN cell's label to an escalated one, dropping either clean cell from the rule
   * entirely, `Math.max(0, …)` removed, and `testable: have >= 5` loosened to `> 5`. Nothing pinned which
   * four cells the rule is over, what they are called, or where its boundary sits.
   */
  describe('the 5-and-5 rule is over four NAMED cells, at an exact boundary', () => {
    // Every cell distinct, so a swapped label or a dropped cell cannot hide behind an equal count:
    // escalated 9 records / 1 defect → 1 and 8; clean 7 records / 2 defects → 2 and 5.
    const distinct = () => [
      ...Array.from({ length: 9 }, (_, i) => pr(i, 10, true, i < 1 ? 'independent-fix' : null, 60, `e${i}`)),
      ...Array.from({ length: 7 }, (_, i) => pr(100 + i, 10, false, i < 2 ? 'independent-fix' : null, 60, `c${i}`)),
    ];

    it('names all four cells, and counts each from its own arm', () => {
      const out = assessCriteria({ records: distinct(), nowSec: NOW });
      const xs = out.power.perBand.find((b) => b.band === 'xs');
      // Two are short (1 and 2), two are not (8 and 5). Swapping any label, or dropping either clean cell,
      // changes this list.
      expect(xs.shortCells).toEqual([
        { cell: 'escalated defects', have: 1 },
        { cell: 'clean defects', have: 2 },
      ]);
      expect(xs.shortBy).toBe(4 + 3);
      expect(xs.testable).toBe(false);
    });

    it('a cell at EXACTLY 5 is enough — the boundary is `>= 5`, not `> 5`', () => {
      // Both arms exactly 5-and-5. `>` would call this untestable and `>= 4` would accept one short.
      const exact = [
        ...Array.from({ length: 10 }, (_, i) => pr(i, 10, true, i < 5 ? 'independent-fix' : null, 60, `e${i}`)),
        ...Array.from({ length: 10 }, (_, i) => pr(100 + i, 10, false, i < 5 ? 'independent-fix' : null, 60, `c${i}`)),
      ];
      const out = assessCriteria({ records: exact, nowSec: NOW });
      const xs = out.power.perBand.find((b) => b.band === 'xs');
      expect(xs.testable).toBe(true);
      expect(xs.shortBy).toBe(0);
      expect(xs.shortCells).toEqual([]);
      // And it agrees with the module's OWN rule, which is what `testable` claims to mirror.
      expect(out.bands.xs.comparison.usable).toBe(true);
      expect(out.multiplicity.bandsTested).toBe(1);
      // One observation fewer in a single cell flips both, together.
      const oneShort = [...exact.slice(0, 9), ...exact.slice(10)];
      const flipped = assessCriteria({ records: oneShort, nowSec: NOW });
      expect(flipped.power.perBand.find((b) => b.band === 'xs').testable).toBe(false);
      expect(flipped.bands.xs.comparison.usable).toBe(false);
    });

    // #1203 round 3, finding 3. A band with an escalated arm and NO clean arm had zero coverage — two
    // mutations survived through it. Its `requiredNPerGroup` is null because there is no rate to size
    // against, which is a DIFFERENT reason from an unsizeable `mdd`, and the payload must not conflate them.
    it('a band with one arm reports a null rate without borrowing the other arm’s', () => {
      const escalatedOnly = Array.from({ length: 12 }, (_, i) => pr(i, 10, true, i < 6 ? 'independent-fix' : null, 60, `e${i}`));
      const out = assessCriteria({ records: escalatedOnly, nowSec: NOW });
      const xs = out.power.perBand.find((b) => b.band === 'xs');
      expect(xs).toBeDefined();                       // the band is REPORTED, not filtered away
      expect(xs.baseRate).toBeNull();
      expect(xs.requiredNPerGroup).toBeNull();
      // The clean arm is empty, so both its cells are 0 — the shortfall counts them, it does not skip them.
      expect(xs.shortCells).toEqual([
        { cell: 'clean defects', have: 0 },
        { cell: 'clean non-defects', have: 0 },
      ]);
      expect(xs.shortBy).toBe(10);
      // And NOT because the effect size was unsizeable — that blocker must not fire here.
      expect(out.verdict.blockers.find((b) => b.startsWith('unsizeable effect'))).toBeUndefined();
    });
  });

  /**
   * #1203 round 3, finding 2 — a regression the round-3 fix introduced. Removing the `Math.max(1e-6, …)`
   * clamp on `mdd` made `d * d` underflow to 0 below about 1e-160, so the estimator returned `Infinity`.
   * `sizeableMdd` had re-stated the estimator's rules instead of asking it, so it still said "sizeable",
   * no blocker fired, and `Infinity` JSON-serialises to `null` — an HTTP caller saw every power figure
   * empty with nothing anywhere explaining why. Impossible on `main`; created by this PR.
   */
  it('refuses a step so small its square underflows, rather than answering Infinity', () => {
    expect(requiredNPerGroup(0.5, 1e-200)).toBeNull();
    expect(requiredNPerGroup(0, Number.MIN_VALUE)).toBeNull();
    // Just above the underflow the answer is a real, finite number — so this is a boundary, not a blanket.
    expect(Number.isFinite(requiredNPerGroup(0.5, 1e-150))).toBe(true);
    // JSON is where the damage landed: `Infinity` has no representation and arrives as an unexplained null.
    expect(JSON.stringify({ n: Infinity })).toBe('{"n":null}');
  });

  it('and the blocker fires for it, because the check ASKS the estimator instead of restating its rules', () => {
    const records = Array.from({ length: 20 }, (_, i) => pr(i, 10, i % 2 === 0, i < 2 ? 'independent-fix' : null, 60, `a${i}`));
    const out = assessCriteria({ records, nowSec: NOW, mdd: 1e-200 });
    expect(out.verdict.blockers.find((b) => b.startsWith('unsizeable effect'))).toBeDefined();
    expect(out.power.requiredNPerGroup).toBeNull();
  });

  // #1203 round 3, finding 4. The blocker exists to NAME the input, and `JSON.stringify` renders NaN,
  // Infinity and -Infinity all as the string "null" — which names nothing and reads as a missing value
  // rather than a rejected one. Mutation-proven: dropping the interpolation entirely used to survive.
  it('prints the offending value truthfully, including the ones JSON cannot represent', () => {
    const records = Array.from({ length: 20 }, (_, i) => pr(i, 10, i % 2 === 0, i < 2 ? 'independent-fix' : null, 60, `a${i}`));
    for (const [bad, shown] of [[NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'], [0, '0'], [-0.05, '-0.05']]) {
      const out = assessCriteria({ records, nowSec: NOW, mdd: bad });
      const blocker = out.verdict.blockers.find((b) => b.startsWith('unsizeable effect'));
      expect(`${shown}: ${blocker}`).toContain(`\`minDetectableDiff\` is ${shown},`);
    }
  });

  // #1203 round 2, finding 4. The third branch — no band holds anything at all — was unreachable from any
  // test, so making it dead code cost nothing. It is the state the tool is actually in on a fresh repo.
  it('says so plainly when there is no band to be close to', () => {
    const out = assessCriteria({ records: [], nowSec: NOW });
    expect(out.power.perBand).toEqual([]);
    const blocker = out.verdict.blockers.find((b) => b.startsWith('insufficient observations'));
    expect(blocker).toMatch(/no band holds a single observation/);
    expect(blocker).not.toMatch(/closest is band/);
    expect(blocker).not.toMatch(/null|undefined|NaN/);
  });

  /**
   * #1203 review, finding 1 — the regression the previous cut introduced, and the reason this test exists.
   *
   * `baseRate` is pooled over every band and both arms; the blocker asks a per-band question. Answering it
   * from the pooled rate turned a soft under-estimate into a categorical "no sample size would detect a
   * 20-point rise" for an input where one band needs 63 observations per group. The tool told the operator
   * that collecting more data was futile, which is the opposite of true.
   */
  describe('the blocker sizes from the population its own sentence names', () => {
    // THREE occupied bands, deliberately, so the assertions below can tell apart "used the corpus",
    // "used the wrong band" and "used the band's escalated arm":
    //   xl — clean arm 39/40 = 97.5% → refuses at a 20-point step (1.175 exceeds 1)
    //   m  — clean arm  5/10 = 50.0% → 95 per group
    //   xs — clean arm  1/10 = 10.0% → 63 per group, the reachable one
    // Pooled across all three and both arms the rate is 80%, which with a 20-point step lands exactly on
    // the boundary and REFUSES. So the corpus says "impossible" while two bands say "63" and "95" — the
    // regression, reproduced.
    const skewed = () => [
      ...Array.from({ length: 80 }, (_, i) => pr(i, 2000, i % 2 === 0, i < 79 ? 'independent-fix' : null, 60, `a${i}`)),
      ...Array.from({ length: 20 }, (_, i) => pr(100 + i, 200, i % 2 === 0, (i % 2 === 0 || i <= 9) ? 'independent-fix' : null, 60, `b${i}`)),
      ...Array.from({ length: 20 }, (_, i) => pr(200 + i, 10, i % 2 === 0, i < 2 ? 'independent-fix' : null, 60, `c${i}`)),
    ];

    it('sizes each band from its own CLEAN arm, not from the corpus and not from both arms pooled', () => {
      const out = assessCriteria({ records: skewed(), nowSec: NOW, mdd: 0.2 });
      const byBand = Object.fromEntries(out.power.perBand.map((b) => [b.band, b]));
      // Clean-arm rates. Pooling `xs` across arms would give 2/20 = 10% as well — so `m` is the one that
      // discriminates: clean 5/10 = 50% needs 95, but pooled across arms 15/20 = 75% needs only 50.
      expect(byBand.xs.baseRate).toBeCloseTo(0.1, 10);
      expect(byBand.xs.requiredNPerGroup).toBe(63);
      expect(byBand.m.baseRate).toBeCloseTo(0.5, 10);
      expect(byBand.m.requiredNPerGroup).toBe(95);
      expect(byBand.xl.requiredNPerGroup).toBeNull();
      // Bands with no observations at all carry no entry, rather than a rate invented from nothing.
      expect(out.power.perBand.map((b) => b.band).sort()).toEqual(['m', 'xl', 'xs']);
      // The corpus figure is a DIFFERENT number over a different population, and both are reported.
      expect(out.power.baseRate).toBeCloseTo(0.8, 10);
      expect(out.power.requiredNPerGroup).toBeNull();
    });
  });

  /**
   * #1203 round 2, finding 2 — "the nearest band" was ranked on the smallest REQUIREMENT, which is not
   * nearness. It never looked at what a band already has, so a band ONE observation from clearing the bar
   * lost to a band needing ~53 more PRs in each arm, and an operator following the sentence did about 106
   * PRs of work instead of 1. Ranking is now on the deficit against the 5-and-5 rule, which is countable
   * without any model and is what the word means.
   */
  describe('the blocker ranks bands by how close they are, not by how small their sample size is', () => {
    // band `s`  — clean 200/60, escalated 100/4 → smallest cell is 4 (escalated defects): ONE short.
    //             Its own requiredNPerGroup at 30% is 95, already exceeded in both arms, and it is STILL
    //             not testable — which is the pair of criteria the old sentence spliced together.
    // band `xs` — clean 10/1, escalated 10/1 → smallest cell is 1: FOUR short, but requires only 63.
    const nearVsCheap = () => [
      ...Array.from({ length: 200 }, (_, i) => pr(i, 60, false, i < 60 ? 'independent-fix' : null, 60, `s-c${i}`)),
      ...Array.from({ length: 100 }, (_, i) => pr(1000 + i, 60, true, i < 4 ? 'independent-fix' : null, 60, `s-e${i}`)),
      ...Array.from({ length: 10 }, (_, i) => pr(2000 + i, 10, false, i < 1 ? 'independent-fix' : null, 60, `x-c${i}`)),
      ...Array.from({ length: 10 }, (_, i) => pr(3000 + i, 10, true, i < 1 ? 'independent-fix' : null, 60, `x-e${i}`)),
    ];

    it('names the band that is CLOSEST, not the one with the smallest requirement', () => {
      const out = assessCriteria({ records: nearVsCheap(), nowSec: NOW, mdd: 0.2 });
      expect(out.multiplicity.bandsTested).toBe(0);          // the blocker really does fire — not vacuous
      const byBand = Object.fromEntries(out.power.perBand.map((b) => [b.band, b]));
      // The two criteria disagree on purpose: `s` is nearer, `xs` is cheaper.
      expect(`${byBand.s.shortBy} vs ${byBand.xs.shortBy}`).toBe('1 vs 8');
      expect(byBand.s.requiredNPerGroup).toBeGreaterThan(byBand.xs.requiredNPerGroup);
      const blocker = out.verdict.blockers.find((b) => b.startsWith('insufficient observations'));
      expect(blocker).toMatch(/closest is band `s`, 1 observation\(s\) short across 1 cell\(s\) — escalated defects: 4 of 5/);
      expect(blocker).not.toMatch(/`xs`/);
    });

    /**
     * #1203 round 3, finding 1 — instance three of the class, and the reason `shortBy` sums all four cells.
     * The first cut counted the deficit in the SINGLE WORST cell and then ranked and printed it as the band's
     * whole distance to testability: a statistic about one part driving a decision about the whole.
     *
     * The reviewer followed the sentence literally and it did not work. Adding an observation to the band it
     * named left `bandsTested: 0` and the blocker still firing; adding two to the band it did NOT name
     * cleared it. Testability needs EVERY cell at 5, so the distance is the sum of the shortfalls.
     */
    it('sums the shortfall over ALL FOUR cells, so the named band is the one that clears first', () => {
      // band `s`  — every cell at 4: worst cell is 1 short, but the band needs 4 observations.
      // band `xs` — one cell at 3, the rest at 10: worst cell is 2 short, and that is the whole distance.
      // Ranking on the worst cell alone names `s` (1 < 2). Ranking on the total names `xs` (2 < 4).
      const deficitTrap = () => [
        ...Array.from({ length: 8 }, (_, i) => pr(i, 60, true, i < 4 ? 'independent-fix' : null, 60, `se${i}`)),
        ...Array.from({ length: 8 }, (_, i) => pr(100 + i, 60, false, i < 4 ? 'independent-fix' : null, 60, `sc${i}`)),
        ...Array.from({ length: 13 }, (_, i) => pr(200 + i, 10, true, i < 3 ? 'independent-fix' : null, 60, `xe${i}`)),
        ...Array.from({ length: 20 }, (_, i) => pr(300 + i, 10, false, i < 10 ? 'independent-fix' : null, 60, `xc${i}`)),
      ];
      const out = assessCriteria({ records: deficitTrap(), nowSec: NOW, mdd: 0.2 });
      expect(out.multiplicity.bandsTested).toBe(0);          // the blocker really does fire — not vacuous
      const byBand = Object.fromEntries(out.power.perBand.map((b) => [b.band, b]));
      // The trap, stated as data: `s`'s worst cell is HIGHER than `xs`'s, and its total is larger too.
      expect(byBand.s.shortCells.map((c) => c.have)).toEqual([4, 4, 4, 4]);
      expect(byBand.xs.shortCells.map((c) => c.have)).toEqual([3]);
      expect(`${byBand.s.shortBy} vs ${byBand.xs.shortBy}`).toBe('4 vs 2');
      // Ranked on the total, `xs` wins. Ranked on the worst cell — the old rule — `s` would.
      const blocker = out.verdict.blockers.find((b) => b.startsWith('insufficient observations'));
      expect(blocker).toMatch(/closest is band `xs`, 2 observation\(s\) short across 1 cell\(s\) — escalated defects: 3 of 5/);
      expect(blocker).not.toMatch(/band `s`/);
    });

    it('publishes `testable` alongside the sample size, so an already-met requirement cannot read as unmet', () => {
      const out = assessCriteria({ records: nearVsCheap(), nowSec: NOW, mdd: 0.2 });
      const s = out.power.perBand.find((b) => b.band === 's');
      // 200 and 100 observations against a requirement of 95 — the POWER bar is met in both arms.
      expect(s.requiredNPerGroup).toBe(95);
      // …and the band is still not testable. Publishing the first without the second is what let a reader
      // conclude "collect 95 and the blocker clears".
      expect(s.testable).toBe(false);
      expect(s.shortBy).toBe(1);
      expect(s.shortCells).toEqual([{ cell: 'escalated defects', have: 4 }]);
      // The three cells that are NOT short carry no entry — `shortCells` is the shortfall, not a census.
      expect(s.shortCells).toHaveLength(1);
      // The blocker says so in as many words, rather than leaving the two adjacent and unexplained.
      const blocker = out.verdict.blockers.find((b) => b.startsWith('insufficient observations'));
      expect(blocker).toMatch(/different question from having enough data to detect a difference/);
    });
  });

  // The multiplicity correction had no test at all — making it a no-op stayed green.
  it('alpha is divided by the number of TESTABLE bands', () => {
    const twoBands = [
      ...Array.from({ length: 60 }, (_, i) => pr(800 + i, 200, i % 2 === 0, i < 30 ? 'independent-fix' : null, 60, `m${i}`)),
      ...Array.from({ length: 60 }, (_, i) => pr(900 + i, 600, i % 2 === 0, i < 30 ? 'independent-fix' : null, 60, `l${i}`)),
    ];
    const out = assessCriteria({ records: twoBands, nowSec: NOW });
    expect(out.multiplicity.bandsTested).toBe(2);
    expect(out.multiplicity.alphaPerBand).toBeCloseTo(0.025, 10);
    expect(out.bands.m.comparison.alpha).toBeCloseTo(0.025, 10);
  });

  // An off-by-one in the censor cutoff stayed green: nothing pinned the boundary itself.
  it('the censor boundary is exact — a PR at exactly the window edge is observable', () => {
    const atEdge = pr(1, 100, true, null, 14);
    const justInside = pr(2, 100, true, null, 13.9);
    const out = censor([atEdge, justInside], { nowSec: NOW, windowDays: 14 });
    expect(out.observed.map((r) => r.number)).toEqual([1]);
    expect(out.censored).toBe(1);
  });

  it('concludes only when a band separates AND nothing is blocking', () => {
    const records = [
      ...Array.from({ length: 60 }, (_, i) => pr(600 + i, 200, true, i < 30 ? 'independent-fix' : null, 60, `e${i}`)),
      ...Array.from({ length: 60 }, (_, i) => pr(700 + i, 200, false, i < 6 ? 'independent-fix' : null, 60, `c${i}`)),
    ];
    const out = assessCriteria({ records, nowSec: NOW });
    expect(out.verdict.blockers).toEqual([]);
    expect(out.verdict.conclusive).toBe(true);
    expect(out.bands.m.comparison.direction).toBe('escalated-worse');
  });

  it('does not put the whole record set inside the finding', () => {
    // `observability.observed` was the working array — 300 records of payload to say "23% were observable".
    const out = assessCriteria({ records: [pr(1, 10, true, null, 60)], nowSec: NOW });
    expect(typeof out.observability.observed).toBe('number');
  });
});

// #3143 (ratified). A SEPARATE named export, not a fold into `requiredNPerGroup` — Fork 1 rejected folding
// the floor into the power formula (no prior art, doesn't deliver its own guarantee, breaks `sizeableMdd`
// at p=0 — see that function's docstring). This is the expected-cell-5 validity floor Fork 2 decided the
// module should publish instead of leaving to a docstring formula.
describe('expectedValidityFloorNPerGroup — the validity floor, published as its own question', () => {
  // Pinned against the decision's own measured divergence table (backlog #3143), not against the function's
  // own output — the same discipline `requiredNPerGroup` is held to above.
  it('matches the measured divergence table', () => {
    expect(expectedValidityFloorNPerGroup(0.94, 0.05)).toBe(500);
    expect(expectedValidityFloorNPerGroup(0.93, 0.05)).toBe(251);
    expect(expectedValidityFloorNPerGroup(0.90, 0.05)).toBe(101);
    expect(expectedValidityFloorNPerGroup(0.044, 0.20)).toBe(114);
    expect(expectedValidityFloorNPerGroup(0.021, 0.10)).toBe(239);
    expect(expectedValidityFloorNPerGroup(0.021, 0.20)).toBe(239);
    expect(expectedValidityFloorNPerGroup(0.50, 0.05)).toBe(12);
  });

  // THE FORCED INVARIANT (backlog #3143): `p = 0` is not a corner case here — it is this module's own
  // `sizeableMdd` probe input (`requiredNPerGroup(0, mdd)`) and the ordinary clean-arm rate of a band with
  // no recorded defects. `5 / min(...)` is `5/0 = Infinity` there; the floor must refuse, not return it.
  it('refuses at p = 0 rather than returning Infinity', () => {
    expect(expectedValidityFloorNPerGroup(0, 0.05)).toBeNull();
    // And at the mirrored zero-width cell: p + d === 1.
    expect(expectedValidityFloorNPerGroup(0.95, 0.05)).toBeNull();
  });

  // Same domain guards as `requiredNPerGroup`, since both read the same four-cell shape.
  it('refuses non-numbers, non-finite results, and out-of-domain inputs, exactly like requiredNPerGroup', () => {
    expect(expectedValidityFloorNPerGroup(NaN, 0.05)).toBeNull();
    expect(expectedValidityFloorNPerGroup(0.5, NaN)).toBeNull();
    expect(expectedValidityFloorNPerGroup(0.5, 0)).toBeNull();
    expect(expectedValidityFloorNPerGroup(0.5, -0.05)).toBeNull();
    expect(expectedValidityFloorNPerGroup(-0.5, 0.05)).toBeNull();
    expect(expectedValidityFloorNPerGroup(1.5, 0.05)).toBeNull();
    expect(expectedValidityFloorNPerGroup(0.9999999, 1e-6)).toBeNull(); // sums past 1
  });

  it('is published beside the power number in assessCriteria, as a separately-labelled field', () => {
    const records = Array.from({ length: 40 }, (_, i) => pr(i, 100, i % 2 === 0, i < 2 ? 'independent-fix' : null, 60, `s${i}`));
    const out = assessCriteria({ records, nowSec: NOW });
    const band = out.power.perBand.find((b) => b.band === 's');
    expect(band.requiredNForExpectedValidity).toBe(expectedValidityFloorNPerGroup(band.baseRate, 0.05));
    // Two different questions, two different numbers — not fused into one.
    expect(band.requiredNForExpectedValidity).not.toBe(band.requiredNPerGroup);
  });
});

describe('bandOf / stratifyBySize', () => {
  it('places a line count in the largest band it reaches', () => {
    expect([0, 49, 50, 150, 400, 1000, 99999].map(bandOf)).toEqual(['xs', 'xs', 's', 'm', 'l', 'xl', 'xl']);
  });
  it('always returns every band, so an empty one is visible rather than missing', () => {
    expect(Object.keys(stratifyBySize([pr(1, 10, true)])).sort()).toEqual(SIZE_BANDS.map(([l]) => l).sort());
  });
});

describe('joinHistory', () => {
  const commits = [
    { sha: 'fix1', t: 2000, subject: 'fix the thing', files: ['a.mjs'] },
    { sha: 'rev1', t: 1900, subject: 'Merge pull request #9 from chalbert/lane/x-review-fix', files: ['a.mjs'] },
    { sha: 'm1', t: 1000, subject: 'Merge pull request #1', files: ['a.mjs'] },
    { sha: 'm2', t: 900, subject: 'Merge pull request #2', files: ['hot.mjs'] },
  ];
  const prs = [
    { number: 1, title: 'one', labels: [{ name: 'review:accepted' }], additions: 10, deletions: 0, changedFiles: 1, mergeCommit: { oid: 'm1' } },
    { number: 2, title: 'two', labels: [], additions: 10, deletions: 0, changedFiles: 1, mergeCommit: { oid: 'm2' } },
    { number: 3, title: 'three', labels: [], additions: 10, deletions: 0, changedFiles: 1, mergeCommit: { oid: 'gone' } },
  ];

  it('drops a PR with no attributable surface rather than scoring it clean', () => {
    const { records, unmeasurable } = joinHistory({ prs, commits, classify: classifyFollowUp });
    expect(unmeasurable).toBeGreaterThanOrEqual(1);
    expect(records.map((r) => r.number)).not.toContain(3);
  });

  it('records the merge time and the follow-up SOURCE, which the preconditions need', () => {
    const r = joinHistory({ prs, commits, classify: classifyFollowUp }).records.find((x) => x.number === 1);
    expect(r.mergedAtSec).toBe(1000);
    expect(r.followUp).toBe('independent-fix');
    expect(r.followUpSource).toBe('fix1');
  });

  it('does not call a file hot on a short history', () => {
    expect(hotFileCut(4)).toBe(HOT_FILE_MIN);
    expect(hotFileCut(10_000)).toBe(200);
    expect(joinHistory({ prs, commits, classify: classifyFollowUp }).hotFiles).toEqual([]);
  });
});

describe('the declaration', () => {
  const history = { repo: 'web-everything/web-everything', nowSec: NOW, records: [pr(1, 10, true, null, 60)], unmeasurable: 2, hotFiles: ['x'] };

  it('is read-only and GET-shaped — both steps are `compute`', () => {
    expect(isReadOnlyDeclaration(runGateHealth({}, history).declaration)).toBe(true);
  });

  it('reaches no `node:` specifier and not its own io module', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const { files, external } = importGraph(resolve(HERE, '..', 'gate-health.mjs'));
    expect(external.filter((s) => s.startsWith('node:'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('gate-health-io.mjs'))).toEqual([]);
  });

  it('refuses a reader with no clock — censoring cannot be assessed without one', () => {
    expect(() => shapeHistoryFinding({ repo: 'x', records: [] })).toThrow(/nowSec/);
    expect(() => shapeHistoryFinding({ repo: 'x' })).toThrow(/must return/);
  });

  it('refuses a repo outside the closed set, before a run record exists', () => {
    const registry = createRegistry();
    registry.register(gateHealthOperation({ loadHistory: () => history }));
    expect(() => startRun({ op: GATE_HEALTH_OP, id: 'r', input: { repo: 'chalbert/nope' }, registry })).toThrow();
  });

  it('reports requested and applied limit, so an underpowered verdict is not read as a real one', () => {
    const { run } = runGateHealth({ limit: 99999 }, history);
    expect(run.findings.assess.requestedLimit).toBe(99999);
    expect(run.findings.assess.limit).toBe(1000);
    expect(clampLimit(1)).toBe(10);
    expect(clampLimit('nonsense')).toBe(300);
  });

  it('carries the unknown-parameter-set caveat beside the numbers', () => {
    const { run } = runGateHealth({}, history);
    expect(run.findings.assess.parameterSet).toBeNull();
    expect(run.findings.assess.parameterSetCaveat).toMatch(/nothing stamps the policy-contract version/);
  });

  /**
   * #1203 round 2, finding 3 — the round-1 `mdd = 0` fix landed one layer BELOW where the substitution
   * happens. `assessCriteria` grew a refusal for a step it cannot size, and this operation ran its own
   * `Number(...) || 0.05` first, so the refusal was unreachable from the only shipped surface that can
   * produce the input. The library looked fixed and the operator's symptom was byte-identical.
   *
   * Driven through `startRun`/`advanceWhileRunning`, because that is the layer the defect lived at — a
   * direct `assessCriteria` call could never have seen it.
   */
  describe('the operation passes `minDetectableDiff` through instead of substituting for it', () => {
    it('an explicit 0 reaches the assessment and is refused, not silently turned into 0.05', () => {
      const { run } = runGateHealth({ minDetectableDiff: 0 }, history);
      const assess = run.findings.assess;
      expect(assess.power.minDetectableDiff).toBe(0);          // the caller's 0 survives into the payload
      expect(assess.power.requiredNPerGroup).toBeNull();
      expect(assess.verdict.blockers.join(' ')).toMatch(/unsizeable effect/);
      // The old symptom, asserted as absent: a sample size for an effect nobody asked about.
      expect(assess.verdict.blockers.join(' ')).not.toMatch(/5-point difference/);
    });

    it('a negative reaches it too, and produces no claim about the bands', () => {
      const { run } = runGateHealth({ minDetectableDiff: -0.05 }, history);
      const assess = run.findings.assess;
      expect(assess.power.minDetectableDiff).toBe(-0.05);
      expect(assess.verdict.blockers.join(' ')).toMatch(/unsizeable effect/);
      expect(assess.verdict.blockers.join(' ')).not.toMatch(/within -5 points of 100%/);
    });

    it('an ABSENT field still gets the schema default, so the pass-through costs nothing', () => {
      const { run } = runGateHealth({}, history);
      expect(run.findings.assess.power.minDetectableDiff).toBe(0.05);
      expect(run.findings.assess.verdict.blockers.join(' ')).not.toMatch(/unsizeable effect/);
    });
  });
});

it('gate-health accepts exactly the shared constellation slugs', async () => {
  const { CONSTELLATION_REPOS } = await import('../../lib/constellation-repos.mjs');
  expect(GATE_HEALTH_REPOS).toEqual(Object.values(CONSTELLATION_REPOS).map(({ slug }) => slug));
  const reader = createHistoryReader({ classify: classifyFollowUp });
  expect(() => reader({ repo: CONSTELLATION_REPOS.frontierui.slug }))
    .toThrow(`bound to ${CONSTELLATION_REPOS.we.slug}`);
});
