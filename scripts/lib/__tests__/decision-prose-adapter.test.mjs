/**
 * @file decision-prose-adapter.test.mjs — proof of the #2657 decision-prose subject adapter (S5 of epic #2649):
 *   the root-cause / completeness lens-set, the `plan-critique` grounding method, that the adapter is THIN over
 *   the shipped plan-handshake (its buildMandate delegates to buildPlanCritiqueMandate and the proposer↔critic
 *   loop is re-exported), and that it conforms to the #2656 F2 `SUBJECT_ADAPTER_CONTRACT` and drives
 *   `resolveAdapterRoster`.
 */
import { describe, it, expect } from 'vitest';
import {
  DECISION_PROSE_LENSES,
  DECISION_PROSE_LENS_SET,
  DECISION_PROSE_MANDATORY_LENSES,
  DECISION_PROSE_METHODS,
  DECISION_PROSE_METHOD_REGISTRY,
  hasDecisionInput,
  decisionMethodsForLens,
  buildDecisionMandate,
  buildDecisionFraming,
  DECISION_PROSE_ADAPTER,
  buildPlanMandate,
  buildPlanCritiqueMandate,
  derivePlanOutcome,
  PLAN_ROUND_CAP,
  PLAN_OUTCOMES,
} from '../decision-prose-adapter.mjs';
import { validateSubjectAdapter, resolveAdapterRoster } from '../jury-core.mjs';

describe('the decision-prose lens-set (#2657)', () => {
  it('is exactly root-cause / completeness, both mandatory', () => {
    expect(DECISION_PROSE_LENS_SET).toEqual(['root-cause', 'completeness']);
    expect(DECISION_PROSE_LENSES).toEqual({ ROOT_CAUSE: 'root-cause', COMPLETENESS: 'completeness' });
    expect(DECISION_PROSE_MANDATORY_LENSES).toEqual(['root-cause', 'completeness']);
  });
});

describe('the plan-critique grounding method (#2657)', () => {
  it('one method, callable (never deferred) — plan-critique grounds both decision lenses', () => {
    expect(DECISION_PROSE_METHODS).toEqual({ PLAN_CRITIQUE: 'plan-critique' });
    expect(DECISION_PROSE_METHOD_REGISTRY).toHaveLength(1);
    const [m] = DECISION_PROSE_METHOD_REGISTRY;
    expect(m.id).toBe('plan-critique');
    expect(m.grounds).toEqual(['root-cause', 'completeness']);
    expect(m.deferred).toBe(false);
  });

  it('decisionMethodsForLens → [plan-critique] for a decision lens, [] for an unknown lens', () => {
    expect(decisionMethodsForLens('root-cause')).toEqual(['plan-critique']);
    expect(decisionMethodsForLens('completeness')).toEqual(['plan-critique']);
    expect(decisionMethodsForLens('correctness')).toEqual([]);
  });
});

describe('hasDecisionInput — the empty-input gate (#2657)', () => {
  it('true for non-empty prose or an object with approach/task', () => {
    expect(hasDecisionInput('refactor the loop')).toBe(true);
    expect(hasDecisionInput({ approach: 'do X' })).toBe(true);
    expect(hasDecisionInput({ task: 'fix Y' })).toBe(true);
  });
  it('false for empty / missing input', () => {
    expect(hasDecisionInput('')).toBe(false);
    expect(hasDecisionInput('   ')).toBe(false);
    expect(hasDecisionInput({})).toBe(false);
    expect(hasDecisionInput()).toBe(false);
    expect(hasDecisionInput(['x'])).toBe(false);
  });
});

describe('THIN over the plan-handshake (#2657)', () => {
  it('buildDecisionMandate IS buildPlanCritiqueMandate over the approach (no second copy of the prose)', () => {
    const approach = 'cache the parsed config at module load';
    expect(buildDecisionMandate({ approach, round: 1 }))
      .toBe(buildPlanCritiqueMandate({ approach, round: 1, roundCap: PLAN_ROUND_CAP }));
  });

  it('re-exports the plan-handshake proposer + outcome derivation through this module', () => {
    expect(typeof buildPlanMandate).toBe('function');
    expect(typeof derivePlanOutcome).toBe('function');
    expect(PLAN_ROUND_CAP).toBe(2);
    // the plan-outcome vocabulary comes straight through — agreed on accept, escalate at the cap
    expect(derivePlanOutcome({ verdict: 'accept', round: 1 })).toBe(PLAN_OUTCOMES.AGREED);
    expect(derivePlanOutcome({ verdict: 'changes', round: PLAN_ROUND_CAP })).toBe(PLAN_OUTCOMES.ESCALATE);
  });

  it('buildDecisionFraming uses the shared subject-neutral skeleton, anchored to a passage', () => {
    const f = buildDecisionFraming();
    expect(f).toContain('reviewing a decision approach');
    expect(f).toContain('passage');
    expect(f).toContain('PROSE');
  });
});

describe('DECISION_PROSE_ADAPTER — conforms to the F2 contract + drives the seam (#2657)', () => {
  it('conforms to the subject-adapter contract and is frozen', () => {
    expect(validateSubjectAdapter(DECISION_PROSE_ADAPTER)).toEqual({ valid: true, errors: [] });
    expect(DECISION_PROSE_ADAPTER.subject).toBe('decision-prose');
    expect(Object.isFrozen(DECISION_PROSE_ADAPTER)).toBe(true);
  });

  it('extractTouchSet earns both lenses for a real decision, none for empty input', () => {
    expect(DECISION_PROSE_ADAPTER.extractTouchSet('cache the config')).toEqual(['root-cause', 'completeness']);
    expect(DECISION_PROSE_ADAPTER.extractTouchSet('')).toEqual([]);
  });

  it('resolveMethods maps a decision lens to plan-critique; buildMandate delegates to the plan critic', () => {
    expect(DECISION_PROSE_ADAPTER.resolveMethods('root-cause')).toEqual(['plan-critique']);
    const approach = 'add a guard clause';
    expect(DECISION_PROSE_ADAPTER.buildMandate({ approach }))
      .toBe(buildPlanCritiqueMandate({ approach, round: 1, roundCap: PLAN_ROUND_CAP }));
  });

  it('resolveAdapterRoster builds a decision roster whose seats carry the decision lenses + plan-critique', () => {
    const plan = resolveAdapterRoster({
      adapter: DECISION_PROSE_ADAPTER,
      careLevel: 'low',
      input: 'cache the parsed config at module load',
    });
    const bySeat = Object.fromEntries(plan.lenses.map((s) => [s.lens, s]));
    expect(bySeat['root-cause'].methods).toEqual(['plan-critique']);
    expect(bySeat['root-cause'].attachedBy).toBe('touch-set');
    expect(bySeat.completeness.methods).toEqual(['plan-critique']);
  });

  it('INVARIANT: every mandatory lens is present in the roster resolved for a REAL decision review', () => {
    for (const careLevel of ['low', 'elevated', 'high']) {
      const plan = resolveAdapterRoster({
        adapter: DECISION_PROSE_ADAPTER,
        careLevel,
        input: 'cache the parsed config at module load',
      });
      const seated = new Set(plan.lenses.map((s) => s.lens));
      for (const lens of DECISION_PROSE_ADAPTER.mandatoryLenses) expect(seated.has(lens)).toBe(true);
    }
  });
});
