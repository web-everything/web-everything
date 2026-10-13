/**
 * @file decision-routing.test.mjs — proof of the #2704 decision-routing core (route a cleared decision by
 *   criticality/complexity to red-team convergence or a design committee; dispose a converged ruling shadow-first;
 *   escalate only on genuine non-convergence). Covers: classification off the REUSED care-level signals (no new
 *   score), the route rubric (bounded → red-team; complex/critical → committee; humanRequired always committee),
 *   the shadow-first disposition (shadow observes, enforce ratifies, escalate on non-convergence / gate-self /
 *   judge-error), and the combined planDecision. Pure module — plain unit assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  DECISION_PROCESSES,
  RULING_ACTIONS,
  COMPLEXITY_CARE_FLOOR,
  SHADOW_OUTCOMES,
  ENFORCE_FLIP_TRIGGER,
  classifyDecisionCriticality,
  routeDecision,
  decideDecisionDisposition,
  disposeDecisionRuling,
  planDecision,
  recordShadowOutcome,
  computeAgreementMetric,
  resolveLandMode,
  REVIEW_SUBJECTS,
  PROSE_VETO_SIGNALS,
  isProsePath,
  classifyReviewSubject,
  routeReviewShape,
} from '../decision-routing.mjs';
import { DISPOSITIONS } from '../disposition-judge.mjs';
import { LAND_MODES } from '../auto-land-seam.mjs';
import { resolveDispositionConfig } from '../review-policy.mjs';
import { VERDICTS, MANDATORY_LENSES, PANEL_LENSES, panelRigorForCareLevel } from '../jury-core.mjs';
import { CARE_LEVELS, scoreEscalation } from '../review-escalation.mjs';
import { DECISION_PROSE_MANDATORY_LENSES, DECISION_PROSE_LENS_SET } from '../decision-prose-adapter.mjs';

// The lenses a DECISION jury covers (#2657): root-cause + completeness — NOT the PR-review default.
const DECISION_LENSES = ['root-cause', 'completeness'];

// --- jury-ledger builders (mirror disposition-judge.test.mjs) --------------------------------------------------
const CHARTER = 'judge';
function rosterEvent(jurors, round = 0) { return { type: 'roster-picked', round, jurors }; }
function verdictEvent(jurorId, verdict, round = 0) { return { type: 'verdict', round, jurorId, verdict }; }

/** A clean two-mandatory-lens ledger, TWO diverse jurors per lens all accepting (no thin-jury refutation). */
function cleanDiverseLedger(verdict = VERDICTS.ACCEPT) {
  const jurors = [];
  const verdicts = [];
  for (const lens of DECISION_LENSES) {
    for (const slot of [1, 2]) {
      const id = `${lens}#${slot}`;
      jurors.push({ id, lens, charter: CHARTER });
      verdicts.push(verdictEvent(id, verdict));
    }
  }
  return [rosterEvent(jurors), ...verdicts];
}

const DEFAULT_CONFIG = resolveDispositionConfig(); // present-unless-all-agree, dissentThreshold 0

describe('enums', () => {
  it('names exactly the two processes, frozen', () => {
    expect(DECISION_PROCESSES).toEqual({ RED_TEAM_CONVERGENCE: 'red-team-convergence', DESIGN_COMMITTEE: 'design-committee' });
    expect(Object.isFrozen(DECISION_PROCESSES)).toBe(true);
  });
  it('names exactly the two ruling actions, frozen', () => {
    expect(RULING_ACTIONS).toEqual({ RATIFY: 'ratify', ESCALATE: 'escalate' });
    expect(Object.isFrozen(RULING_ACTIONS)).toBe(true);
  });
  it('the complexity floor is the elevated care band', () => {
    expect(COMPLEXITY_CARE_FLOOR).toBe(CARE_LEVELS.ELEVATED);
  });
});

describe('classifyDecisionCriticality — reuses the care-level signal, no new score', () => {
  it('no scored signal → none, not critical, not complex (bounded)', () => {
    const c = classifyDecisionCriticality({ signals: {}, humanRequired: false });
    expect(c.careLevel).toBe(CARE_LEVELS.NONE);
    expect(c.critical).toBe(false);
    expect(c.complex).toBe(false);
  });

  it('a blast-radius signal alone lands at elevated → complex, not critical', () => {
    const c = classifyDecisionCriticality({ signals: { blastRadius: true } });
    expect(c.careLevel).toBe(CARE_LEVELS.ELEVATED);
    expect(c.complex).toBe(true);
    expect(c.critical).toBe(false);
  });

  it('a size signal alone lands at low → neither complex nor critical', () => {
    const c = classifyDecisionCriticality({ signals: { size: 500 } });
    expect(c.careLevel).toBe(CARE_LEVELS.LOW);
    expect(c.complex).toBe(false);
    expect(c.critical).toBe(false);
  });

  it('humanRequired (statute / policy-tier subject) → high, critical, complex', () => {
    const c = classifyDecisionCriticality({ signals: {}, humanRequired: true });
    expect(c.careLevel).toBe(CARE_LEVELS.HIGH);
    expect(c.critical).toBe(true);
    expect(c.complex).toBe(true);
  });

  it('enough stacked scored signals reach the high band → critical', () => {
    // dismissed(>1)=5 + blastRadius 3 = 8 ≥ CARE_BANDS.high(5) → high
    const c = classifyDecisionCriticality({ signals: { dismissedFindings: 2, blastRadius: true } });
    expect(c.careLevel).toBe(CARE_LEVELS.HIGH);
    expect(c.critical).toBe(true);
  });
});

describe('routeDecision — the operator ruling, coded', () => {
  it('a bounded (none/low) decision → red-team convergence', () => {
    const r = routeDecision({ signals: {} });
    expect(r.process).toBe(DECISION_PROCESSES.RED_TEAM_CONVERGENCE);
    expect(r.reason).toBe('bounded');
    const rLow = routeDecision({ signals: { size: 500 } });
    expect(rLow.process).toBe(DECISION_PROCESSES.RED_TEAM_CONVERGENCE);
  });

  it('a complex (elevated) decision → design committee', () => {
    const r = routeDecision({ signals: { blastRadius: true } });
    expect(r.process).toBe(DECISION_PROCESSES.DESIGN_COMMITTEE);
    expect(r.reason).toBe('complex');
  });

  it('a critical (humanRequired) decision → design committee, reason critical', () => {
    const r = routeDecision({ signals: {}, humanRequired: true });
    expect(r.process).toBe(DECISION_PROCESSES.DESIGN_COMMITTEE);
    expect(r.reason).toBe('critical');
  });

  it('carries the #2657 decision-prose mandatory lenses on both routes', () => {
    expect(routeDecision({ signals: {} }).mandatoryLenses).toEqual(['root-cause', 'completeness']);
    expect(routeDecision({ signals: { blastRadius: true } }).mandatoryLenses).toEqual(['root-cause', 'completeness']);
  });

  it('accepts a pre-computed classification', () => {
    const cls = classifyDecisionCriticality({ signals: { blastRadius: true } });
    expect(routeDecision({ classification: cls }).process).toBe(DECISION_PROCESSES.DESIGN_COMMITTEE);
  });
});

describe('decideDecisionDisposition — shadow-first over a judge verdict', () => {
  const autoDispose = { disposition: DISPOSITIONS.AUTO_DISPOSE, reason: 'unanimous-accept', trail: ['clean'] };
  const escalate = { disposition: DISPOSITIONS.ESCALATE, reason: 'dissent-present', trail: ['contested'] };

  it('shadow (default) + auto-dispose → RATIFY but apply:false (would-ratify logged)', () => {
    const p = decideDecisionDisposition({ verdict: autoDispose });
    expect(p.mode).toBe(LAND_MODES.SHADOW);
    expect(p.action).toBe(RULING_ACTIONS.RATIFY);
    expect(p.apply).toBe(false);
    expect(p.observation).toMatch(/SHADOW/);
  });

  it('enforce + auto-dispose → RATIFY, apply:true', () => {
    const p = decideDecisionDisposition({ verdict: autoDispose, mode: LAND_MODES.ENFORCE });
    expect(p.mode).toBe(LAND_MODES.ENFORCE);
    expect(p.action).toBe(RULING_ACTIONS.RATIFY);
    expect(p.apply).toBe(true);
  });

  it('escalate verdict → ESCALATE, apply:false, in either mode', () => {
    for (const mode of [LAND_MODES.SHADOW, LAND_MODES.ENFORCE]) {
      const p = decideDecisionDisposition({ verdict: escalate, mode });
      expect(p.action).toBe(RULING_ACTIONS.ESCALATE);
      expect(p.apply).toBe(false);
    }
  });

  it('an unknown mode normalizes to shadow (fail-closed — never accidentally enforce)', () => {
    const p = decideDecisionDisposition({ verdict: autoDispose, mode: 'yolo' });
    expect(p.mode).toBe(LAND_MODES.SHADOW);
    expect(p.apply).toBe(false);
  });

  it('a malformed verdict → ESCALATE (fail-closed)', () => {
    expect(decideDecisionDisposition({ verdict: null }).action).toBe(RULING_ACTIONS.ESCALATE);
    expect(decideDecisionDisposition({ verdict: {} }).action).toBe(RULING_ACTIONS.ESCALATE);
  });
});

describe('disposeDecisionRuling — end-to-end over a jury ledger', () => {
  it('a clean converged ledger, shadow → RATIFY apply:false (a human still confirms)', () => {
    const plan = disposeDecisionRuling({ ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG });
    expect(plan.action).toBe(RULING_ACTIONS.RATIFY);
    expect(plan.apply).toBe(false);
    expect(plan.verdict.disposition).toBe(DISPOSITIONS.AUTO_DISPOSE);
  });

  it('a clean converged ledger, enforce → RATIFY apply:true', () => {
    const plan = disposeDecisionRuling({ ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG, mode: LAND_MODES.ENFORCE });
    expect(plan.action).toBe(RULING_ACTIONS.RATIFY);
    expect(plan.apply).toBe(true);
  });

  it('genuine non-convergence (a changes verdict) → ESCALATE', () => {
    const plan = disposeDecisionRuling({ ledger: cleanDiverseLedger(VERDICTS.CHANGES), config: DEFAULT_CONFIG });
    expect(plan.action).toBe(RULING_ACTIONS.ESCALATE);
  });

  it('a nonConvergence signal → ESCALATE even over a clean ledger', () => {
    const plan = disposeDecisionRuling({ ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG, signals: { nonConvergence: true } });
    expect(plan.action).toBe(RULING_ACTIONS.ESCALATE);
  });

  it('a gate-self signal → ESCALATE, never auto-ratify (the hard invariant), even in enforce', () => {
    const plan = disposeDecisionRuling({ ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG, signals: { gateSelf: true }, mode: LAND_MODES.ENFORCE });
    expect(plan.action).toBe(RULING_ACTIONS.ESCALATE);
    expect(plan.apply).toBe(false);
  });

  it('a bad config makes the judge throw → ESCALATE (fail-closed), verdict null', () => {
    const plan = disposeDecisionRuling({ ledger: cleanDiverseLedger(), config: null });
    expect(plan.action).toBe(RULING_ACTIONS.ESCALATE);
    expect(plan.reason).toBe('judge-error');
    expect(plan.verdict).toBeNull();
  });
});

describe('planDecision — route + (optional) dispose in one call', () => {
  it('no ledger → route only, disposition null', () => {
    const { route, disposition } = planDecision({ signals: { blastRadius: true } });
    expect(route.process).toBe(DECISION_PROCESSES.DESIGN_COMMITTEE);
    expect(disposition).toBeNull();
  });

  it('with a ledger + config → route AND disposition', () => {
    const { route, disposition } = planDecision({
      signals: {}, ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG,
    });
    expect(route.process).toBe(DECISION_PROCESSES.RED_TEAM_CONVERGENCE);
    expect(disposition.action).toBe(RULING_ACTIONS.RATIFY);
    expect(disposition.apply).toBe(false); // shadow default
  });

  it('a ledger without a config stays route-only (no half-run disposition)', () => {
    const { disposition } = planDecision({ signals: {}, ledger: cleanDiverseLedger() });
    expect(disposition).toBeNull();
  });

  it('humanRequired threads into the judge — a policy-tier decision never auto-ratifies, even in enforce', () => {
    // Regression for the hard-invariant fail-open: humanRequired routes to the committee AND must force escalate,
    // even when the caller omits dispositionSignals and the mode is enforce over a clean converged ledger.
    const { route, disposition } = planDecision({
      humanRequired: true,
      ledger: cleanDiverseLedger(),
      config: DEFAULT_CONFIG,
      mode: LAND_MODES.ENFORCE,
    });
    expect(route.process).toBe(DECISION_PROCESSES.DESIGN_COMMITTEE);
    expect(disposition.action).toBe(RULING_ACTIONS.ESCALATE);
    expect(disposition.apply).toBe(false);
  });

  it('an explicit dispositionSignals.humanRequired is preserved (routing flag is a floor, not a clear)', () => {
    const { disposition } = planDecision({
      signals: {}, dispositionSignals: { humanRequired: true },
      ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG, mode: LAND_MODES.ENFORCE,
    });
    expect(disposition.action).toBe(RULING_ACTIONS.ESCALATE);
  });
});

// ================================================================================================================
// #2754 — the shadow→enforce flip: per-decision shadow-vs-human outcome, the confidence metric, and the gated flip.
// ================================================================================================================

const { RATIFY, ESCALATE } = RULING_ACTIONS;
/** N MATCH records (default) — the newest-first streak the flip reads. */
function matches(n, action = RATIFY) { return Array.from({ length: n }, () => recordShadowOutcome({ shadowAction: action, humanAction: action })); }
const DIVERGE = recordShadowOutcome({ shadowAction: RATIFY, humanAction: ESCALATE });

describe('#2754 shadow-vs-human outcome record', () => {
  it('the outcome enum names exactly match/divergence, frozen', () => {
    expect(SHADOW_OUTCOMES).toEqual({ MATCH: 'match', DIVERGENCE: 'divergence' });
    expect(Object.isFrozen(SHADOW_OUTCOMES)).toBe(true);
  });

  it('equal valid actions → MATCH (class agreement), both ratify and both escalate', () => {
    expect(recordShadowOutcome({ shadowAction: RATIFY, humanAction: RATIFY }).outcome).toBe(SHADOW_OUTCOMES.MATCH);
    expect(recordShadowOutcome({ shadowAction: ESCALATE, humanAction: ESCALATE }).match).toBe(true);
  });

  it('disagreement in EITHER direction → DIVERGENCE (strictest safe predicate)', () => {
    expect(recordShadowOutcome({ shadowAction: RATIFY, humanAction: ESCALATE }).outcome).toBe(SHADOW_OUTCOMES.DIVERGENCE);
    expect(recordShadowOutcome({ shadowAction: ESCALATE, humanAction: RATIFY }).outcome).toBe(SHADOW_OUTCOMES.DIVERGENCE);
  });

  it('a malformed/partial input can NEVER inflate the streak — it fails closed to DIVERGENCE', () => {
    expect(recordShadowOutcome({ shadowAction: RATIFY }).outcome).toBe(SHADOW_OUTCOMES.DIVERGENCE); // human missing
    expect(recordShadowOutcome({ shadowAction: 'bogus', humanAction: RATIFY }).match).toBe(false);
    expect(recordShadowOutcome({}).outcome).toBe(SHADOW_OUTCOMES.DIVERGENCE);
    expect(recordShadowOutcome().outcome).toBe(SHADOW_OUTCOMES.DIVERGENCE);
  });

  it('accepts the disposition PLAN objects directly (reads .action)', () => {
    const rec = recordShadowOutcome({ shadowPlan: { action: RATIFY }, humanPlan: { action: RATIFY } });
    expect(rec.match).toBe(true);
  });

  it('the record is frozen', () => {
    expect(Object.isFrozen(recordShadowOutcome({ shadowAction: RATIFY, humanAction: RATIFY }))).toBe(true);
  });
});

describe('#2754 computeAgreementMetric — the named confidence gate', () => {
  it('the starting trigger is N=20, M=20, frozen', () => {
    expect(ENFORCE_FLIP_TRIGGER).toEqual({ N: 20, M: 20 });
    expect(Object.isFrozen(ENFORCE_FLIP_TRIGGER)).toBe(true);
  });

  it('an empty ledger is below trigger', () => {
    const m = computeAgreementMetric([]);
    expect(m.consecutiveMatches).toBe(0);
    expect(m.flipReady).toBe(false);
  });

  it('exactly N consecutive matches, zero divergences → FLIP-READY', () => {
    const m = computeAgreementMetric(matches(20));
    expect(m.consecutiveMatches).toBe(20);
    expect(m.divergencesInWindow).toBe(0);
    expect(m.flipReady).toBe(true);
  });

  it('N-1 matches is NOT ready (the bar is strict)', () => {
    expect(computeAgreementMetric(matches(19)).flipReady).toBe(false);
  });

  it('a single divergence resets the consecutive streak (newest-first) and blocks the flip', () => {
    // 20 old matches, then one divergence, then 19 fresh matches → streak only 19, and the window holds the divergence.
    const ledger = [...matches(20), DIVERGE, ...matches(19)];
    const m = computeAgreementMetric(ledger, { N: 20, M: 20 });
    expect(m.consecutiveMatches).toBe(19); // reset by the divergence
    expect(m.flipReady).toBe(false);
  });

  it('a divergence WITHIN the trailing window fails the zero-divergence bar even if the recent streak is long', () => {
    // custom small trigger: N=3, M=5. Newest 3 are matches (streak ok) but a divergence sits inside the last 5.
    const ledger = [...matches(2), DIVERGE, ...matches(3)];
    const m = computeAgreementMetric(ledger, { N: 3, M: 5 });
    expect(m.consecutiveMatches).toBe(3);
    expect(m.divergencesInWindow).toBe(1);
    expect(m.flipReady).toBe(false); // condition (2) fails
  });

  it('a malformed record in the streak breaks it (fail-closed)', () => {
    const ledger = [...matches(20), { junk: true }];
    expect(computeAgreementMetric(ledger).consecutiveMatches).toBe(0);
  });

  it('answers the "how many consecutive matches, zero divergences" question in plain text', () => {
    expect(computeAgreementMetric(matches(20)).answer).toMatch(/20\/20 consecutive matches, 0 divergence/);
  });
});

describe('#2754 resolveLandMode — the gated flip (operator ceiling × metric)', () => {
  it('operator un-armed (shadow) holds SHADOW even with a green metric', () => {
    const r = resolveLandMode({ records: matches(20), configMode: LAND_MODES.SHADOW });
    expect(r.mode).toBe(LAND_MODES.SHADOW);
    expect(r.reason).toBe('metric-green-but-operator-shadow');
    expect(r.metric.flipReady).toBe(true);
  });

  it('an unknown/typo operator mode fails closed to the shadow ceiling', () => {
    expect(resolveLandMode({ records: matches(20), configMode: 'ENFORCE!' }).mode).toBe(LAND_MODES.SHADOW);
    expect(resolveLandMode({ records: matches(20) }).mode).toBe(LAND_MODES.SHADOW); // undefined
  });

  it('operator ARMED + metric green → ENFORCE', () => {
    const r = resolveLandMode({ records: matches(20), configMode: LAND_MODES.ENFORCE });
    expect(r.mode).toBe(LAND_MODES.ENFORCE);
    expect(r.reason).toBe('metric-green');
    // #2787: the metric's own `answer` no longer claims the operator armed enforce — resolveLandMode's trail
    // (not the metric) owns that claim, in the second trail entry.
    expect(r.trail[0]).not.toMatch(/enforce armed/);
  });

  it('operator armed but metric below trigger → held SHADOW until the streak rebuilds', () => {
    const r = resolveLandMode({ records: matches(19), configMode: LAND_MODES.ENFORCE });
    expect(r.mode).toBe(LAND_MODES.SHADOW);
    expect(r.reason).toBe('metric-below-trigger');
  });

  it('a single divergence in an armed+green run drops it back to SHADOW (the block)', () => {
    const ledger = [...matches(20), DIVERGE];
    expect(resolveLandMode({ records: ledger, configMode: LAND_MODES.ENFORCE }).mode).toBe(LAND_MODES.SHADOW);
  });
});

describe('#2754 planDecision — the flip mechanically gates the disposer', () => {
  it('armed + metric green → the converged ruling actually RATIFIES (apply:true)', () => {
    const { disposition, landMode } = planDecision({
      signals: {}, ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG,
      mode: LAND_MODES.ENFORCE, agreementRecords: matches(20),
    });
    expect(landMode.mode).toBe(LAND_MODES.ENFORCE);
    expect(disposition.action).toBe(RULING_ACTIONS.RATIFY);
    expect(disposition.apply).toBe(true);
  });

  it('armed but a divergence blocks it → shadow, so apply stays false (would-ratify only)', () => {
    const { disposition, landMode } = planDecision({
      signals: {}, ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG,
      mode: LAND_MODES.ENFORCE, agreementRecords: [...matches(20), DIVERGE],
    });
    expect(landMode.mode).toBe(LAND_MODES.SHADOW);
    expect(disposition.apply).toBe(false);
  });

  it('operator ceiling is fail-safe: even a green metric cannot force enforce past a shadow config', () => {
    const { disposition, landMode } = planDecision({
      signals: {}, ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG,
      mode: LAND_MODES.SHADOW, agreementRecords: matches(20),
    });
    expect(landMode.mode).toBe(LAND_MODES.SHADOW);
    expect(disposition.apply).toBe(false);
  });

  it('no agreementRecords → backward-compatible: passed mode is used directly, landMode null', () => {
    const { disposition, landMode } = planDecision({
      signals: {}, ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG, mode: LAND_MODES.ENFORCE,
    });
    expect(landMode).toBeNull();
    expect(disposition.apply).toBe(true); // unchanged #2704 behavior
  });

  it('the flip NEVER overrides the hard humanRequired invariant, even armed+green', () => {
    const { disposition } = planDecision({
      humanRequired: true, ledger: cleanDiverseLedger(), config: DEFAULT_CONFIG,
      mode: LAND_MODES.ENFORCE, agreementRecords: matches(20),
    });
    expect(disposition.action).toBe(RULING_ACTIONS.ESCALATE);
    expect(disposition.apply).toBe(false);
  });
});

// ====================================================================================================================
// #3309 — THE REVIEW-SUBJECT ROUTER. Route a non-code PR off the code reviewer, from its TOUCH-SET, before any juror
// is paid. The bias under test is asymmetric and deliberate: over-reviewing prose costs tokens, under-reviewing code
// ships a defect — so every ambiguity must land on `code`, and the code route must be byte-for-byte the incumbent
// panel. Most of the assertions below defend that direction, not the saving.
// ====================================================================================================================

/** Every touch-set shape that MUST route to code. Used by the blanket safety sweep below. */
const CODE_TOUCH_SETS = [
  ['scripts/lib/decision-routing.mjs'],
  ['src/components/thing.ts'],
  ['package.json'],
  ['scripts/lib/review-policy.contract.json'],
  ['docs/agent/platform-decisions.md'],                 // statute — prose-shaped, still code
  ['skills-src/review/SKILL.md'],                       // a skill's prose IS its program
  ['agent-memory-src/index-arch.md'],
  ['.claude/settings.json'],
  ['.github/workflows/test.yml'],
  ['AGENTS.md'],
  ['nested/CLAUDE.md'],
  ['LICENSE'],                                          // no extension → not on the allow-list
  ['backlog/3309-x.md', 'scripts/lib/decision-routing.mjs'], // one code file outvotes fifty cards
  ['plateau-app/.claude/skills/drain/SKILL.md'],        // relocated cross-repo skill — caught by the escalation score
  [],                                                   // unreadable touch-set
  ['   '],                                              // whitespace-only entry
];

describe('#3309 isProsePath — the inert-text allow-list, fail-closed', () => {
  it('#3309 admits a backlog card, a report and a root doc', () => {
    expect(isProsePath('backlog/3309-route-non-code-prs-off-the-code-reviewer.md')).toBe(true);
    expect(isProsePath('reports/2026-07-18-human-vs-ai-review-cognitive-science.md')).toBe(true);
    expect(isProsePath('README.md')).toBe(true);
    expect(isProsePath('notes/thing.txt')).toBe(true);
  });

  it('#3309 refuses code, data and extension-less files', () => {
    for (const p of ['scripts/lib/decision-routing.mjs', 'src/a.ts', 'package.json', 'config/a.yml', 'LICENSE']) {
      expect(isProsePath(p), p).toBe(false);
    }
  });

  it('#3309 refuses OPERATIVE prose — a skill, agent memory, the docs router, AGENTS.md/CLAUDE.md anywhere', () => {
    for (const p of [
      'skills-src/review/SKILL.md', 'agent-memory-src/index-dec.md', 'docs/agent/backlog-workflow.md',
      '.claude/commands/x.md', '.github/PULL_REQUEST_TEMPLATE.md', 'AGENTS.md', 'CLAUDE.md', 'a/b/AGENTS.md',
    ]) {
      expect(isProsePath(p), p).toBe(false);
    }
  });

  it('#3309 is fail-closed on a malformed entry, and does not read a DIRECTORY dot as an extension', () => {
    for (const p of [null, undefined, '', '   ', 42, {}]) expect(isProsePath(p)).toBe(false);
    expect(isProsePath('dir.md/thing.mjs')).toBe(false); // the dot is in the directory, not the file
  });

  it('#3309 normalizes git rename spellings through plainDiffPath rather than re-parsing them', () => {
    expect(isProsePath('backlog/{old.md => new.md}')).toBe(true);
    expect(isProsePath('backlog/a.md => scripts/b.mjs')).toBe(false); // the NEW side is what lands
  });
});

describe('#3309 classifyReviewSubject — three gates, prose must pass all three', () => {
  it('#3309 routes an all-prose card-filing PR to the PROSE subject', () => {
    const c = classifyReviewSubject({ changedFiles: ['backlog/3309-x.md', 'backlog/3310-y.md', 'README.md'] });
    expect(c.subject).toBe(REVIEW_SUBJECTS.PROSE);
    expect(c.reason).toBe('all-prose');
    expect(c.codeFiles).toEqual([]);
    expect(c.vetoes).toEqual([]);
  });

  it('#3309 GATE 1 — an empty or unreadable touch-set is CODE, never the cheaper review', () => {
    for (const files of [[], undefined, null, ['  '], [42, null]]) {
      const c = classifyReviewSubject({ changedFiles: files });
      expect(c.subject).toBe(REVIEW_SUBJECTS.CODE);
      expect(c.reason).toBe('unknown-touch-set');
    }
  });

  it('#3309 GATE 2 — ONE code file among many cards routes the whole PR to CODE and names it', () => {
    const files = ['backlog/a.md', 'backlog/b.md', 'backlog/c.md', 'scripts/lib/decision-routing.mjs'];
    const c = classifyReviewSubject({ changedFiles: files });
    expect(c.subject).toBe(REVIEW_SUBJECTS.CODE);
    expect(c.reason).toBe('code-file');
    expect(c.codeFiles).toEqual(['scripts/lib/decision-routing.mjs']);
    expect(c.trail).toContain('scripts/lib/decision-routing.mjs');
  });

  it('#3309 GATE 3 — all-text but path-kind-escalating is CODE, over the REUSED scoreEscalation roster', () => {
    // A relocated cross-repo skill. Its path starts with NEITHER `.claude/` nor `skills-src/`, so gate 2's
    // `^`-anchored prefix list misses it — `scoreEscalation`'s `(^|/)`-anchored blast-radius roster catches it.
    // This is the case that proves the two gates are not redundant.
    const files = ['plateau-app/.claude/skills/drain/SKILL.md'];
    expect(isProsePath(files[0])).toBe(true);                       // gate 2 lets it through …
    expect(scoreEscalation({ changedFiles: files }).signals.blastRadius).toBeTruthy();
    const c = classifyReviewSubject({ changedFiles: files });        // … gate 3 stops it
    expect(c.subject).toBe(REVIEW_SUBJECTS.CODE);
    expect(c.reason).toBe('machinery-path');
    expect(c.vetoes).toContain('blastRadius');
  });

  it('#3309 GATE 3 — humanRequired alone vetoes prose even with no listed signal key', () => {
    const c = classifyReviewSubject({
      changedFiles: ['backlog/a.md'],
      escalation: { signals: {}, humanRequired: true, careLevel: CARE_LEVELS.HIGH },
    });
    expect(c.subject).toBe(REVIEW_SUBJECTS.CODE);
    expect(c.vetoes).toEqual(['humanRequired']);
  });

  it('#3309 GATE 3 — a CAPACITY signal (size / dismissed findings) does NOT veto prose', () => {
    // The measured cost this item exists to cut is the LONG planning PR. Vetoing on size would send exactly that
    // PR back to the correctness juror and the item would save nothing.
    const escalation = scoreEscalation({ changedFiles: ['backlog/a.md'], diffLines: 5000, dismissedFindings: 3 });
    expect(escalation.escalate).toBe(true);
    expect(escalation.signals.size).toBeTruthy();
    expect(classifyReviewSubject({ changedFiles: ['backlog/a.md'], escalation }).subject)
      .toBe(REVIEW_SUBJECTS.PROSE);
  });

  it('#3309 PROSE_VETO_SIGNALS names only path-KIND signals', () => {
    expect([...PROSE_VETO_SIGNALS].sort())
      .toEqual(['blastRadius', 'crossRepo', 'gateDerivation', 'gateSelf', 'statute']);
    expect(PROSE_VETO_SIGNALS).not.toContain('size');
    expect(PROSE_VETO_SIGNALS).not.toContain('dismissedFindings');
  });
});

describe('#3309 routeReviewShape — a CODE PR still gets the full mandatory panel', () => {
  it('#3309 every code-shaped touch-set keeps MANDATORY_LENSES and the correctness seat, with no exception', () => {
    for (const changedFiles of CODE_TOUCH_SETS) {
      const plan = routeReviewShape({ changedFiles });
      expect(plan.subject, JSON.stringify(changedFiles)).toBe(REVIEW_SUBJECTS.CODE);
      expect(plan.mandatoryLenses, JSON.stringify(changedFiles)).toEqual([...MANDATORY_LENSES]);
      expect(plan.seatLens, JSON.stringify(changedFiles)).toBe(MANDATORY_LENSES[0]);
      // and the fan-out set is the care dial's OWN lens list, untouched by this router
      expect(plan.lenses, JSON.stringify(changedFiles))
        .toEqual([...panelRigorForCareLevel(plan.careLevel).lenses]);
    }
  });

  it('#3309 a high-care code PR gets every panel lens, 3 rounds and 2 jurors — the router shrinks nothing', () => {
    const plan = routeReviewShape({ changedFiles: ['.github/workflows/review.yml'] });
    expect(plan.subject).toBe(REVIEW_SUBJECTS.CODE);
    expect(plan.careLevel).toBe(CARE_LEVELS.HIGH);
    expect(plan.lenses).toEqual([...PANEL_LENSES]);
    expect(plan.rounds).toBe(3);
    expect(plan.jurorsPerLens).toBe(2);
    expect(plan.mandatoryLenses).toEqual([...MANDATORY_LENSES]);
  });

  it('#3309 the code route is EXACTLY the incumbent: seatLens equals review-pr’s default lens', () => {
    expect(routeReviewShape({ changedFiles: ['scripts/lib/a.mjs'] }).seatLens).toBe('correctness');
  });
});

describe('#3309 routeReviewShape — a PROSE PR swaps the lens VOCABULARY and nothing else', () => {
  it('#3309 a card-filing PR is judged by the #2657 decision-prose lenses, not correctness', () => {
    const plan = routeReviewShape({ changedFiles: ['backlog/3309-x.md', 'backlog/3310-y.md'] });
    expect(plan.subject).toBe(REVIEW_SUBJECTS.PROSE);
    expect(plan.mandatoryLenses).toEqual([...DECISION_PROSE_MANDATORY_LENSES]);
    expect(plan.mandatoryLenses).not.toContain('correctness');
    expect(plan.seatLens).toBe(DECISION_PROSE_MANDATORY_LENSES[0]);
  });

  it('#3309 RIGOR is passed through untouched — the router never dials care up or down', () => {
    const escalation = scoreEscalation({ changedFiles: ['backlog/a.md'], diffLines: 5000 });
    const plan = routeReviewShape({ changedFiles: ['backlog/a.md'], escalation });
    const rigor = panelRigorForCareLevel(escalation.careLevel);
    expect(plan.subject).toBe(REVIEW_SUBJECTS.PROSE);
    expect(plan.careLevel).toBe(escalation.careLevel);
    expect(plan.rounds).toBe(rigor.rounds);
    expect(plan.jurorsPerLens).toBe(rigor.jurorsPerLens);
    // rigor identical, vocabulary different — that is the ENTIRE behavioural delta of this item
    expect(plan.lenses).toEqual([...DECISION_PROSE_LENS_SET]);
  });

  it('#3309 care `none` seats no panel on either route — the dial decides WHETHER, the subject decides WHICH', () => {
    const prose = routeReviewShape({ changedFiles: ['backlog/a.md'] });
    expect(prose.careLevel).toBe(CARE_LEVELS.NONE);
    expect(prose.lenses).toEqual([]);
    expect(prose.rounds).toBe(0);
    // …but a single-seat caller still learns which lens the seat belongs to
    expect(prose.seatLens).toBe(DECISION_PROSE_MANDATORY_LENSES[0]);
  });

  it('#3309 an unrecognized careLevel override is IGNORED rather than crashing the rigor dial', () => {
    const plan = routeReviewShape({ changedFiles: ['backlog/a.md'], careLevel: 'catastrophic' });
    expect(plan.careLevel).toBe(CARE_LEVELS.NONE);
    expect(() => routeReviewShape({ changedFiles: ['backlog/a.md'], careLevel: null })).not.toThrow();
  });

  it('#3309 an explicit valid careLevel override is honoured', () => {
    const plan = routeReviewShape({ changedFiles: ['backlog/a.md'], careLevel: CARE_LEVELS.ELEVATED });
    expect(plan.careLevel).toBe(CARE_LEVELS.ELEVATED);
    expect(plan.rounds).toBe(2);
    expect(plan.lenses).toEqual([...DECISION_PROSE_LENS_SET]);
  });

  it('#3309 REVIEW_SUBJECTS is a frozen two-member enum', () => {
    expect(Object.isFrozen(REVIEW_SUBJECTS)).toBe(true);
    expect(Object.values(REVIEW_SUBJECTS).sort()).toEqual(['code', 'prose']);
  });
});
