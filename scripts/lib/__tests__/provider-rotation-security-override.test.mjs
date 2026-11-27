import { describe, expect, it } from 'vitest';
import { drawArm, routeFor } from '../provider-rotation.mjs';

const builder = { provider: 'codex', model: 'sol', effort: 'high' };
const reviewer = { provider: 'claude', model: 'sonnet', effort: 'high' };
const weakReviewer = { provider: 'claude', model: 'haiku', effort: 'high' };
const capacity = Object.fromEntries(['codex', 'claude'].map(provider => [provider,
  { available: true, usedPct: 20, hoursToReset: 4, manualResetsHeld: 0 }]));
const policyFor = (kind, arm) => ({
  mode: 'on', catalog: [builder, reviewer, weakReviewer],
  exhaustedPercent: 98, reserveReleaseHours: 6, reservePercent: 10,
  minPanelFamilies: 2, strongArms: ['sol', 'sonnet'],
  smallArms: ['haiku'], smallTiers: ['small'],
  keyLenses: ['correctness', 'security', 'red-team'],
  strongShapes: ['security', 'merge-path'],
  kinds: { [kind]: { arms: [{ arm, tier: arm === weakReviewer ? 'small' : 'strong', share: 1 }] } },
});

describe('security lens overrides fail closed', () => {
  it.each(['review-lens', 'build', 'review-security'])(
    '%s refuses downgrades without waiving vendor independence or model strength', kind => {
      for (const counting of [true, false]) {
        for (const [arm, refusal] of [[builder, 'no-cross-vendor-seat'],
          [weakReviewer, 'no-strong-seat'], [reviewer, undefined]]) {
          const args = { kind, lens: 'security', counting, builder, capacity,
            subject: 'fixture#security-override', policy: policyFor(kind, arm) };
          // Establish both security floors and a usable independent strong seat.
          expect(drawArm(args)).toMatchObject(refusal ? { arm: null, refusal } : { arm });
          for (const lensOverride of ['style', 'simplicity', 'performance', null, '']) {
            expect(drawArm({ ...args, lensOverride }))
              .toMatchObject({ arm: null, refusal: 'kind-lens-mismatch' });
            expect(routeFor({ ...args, lensOverride }))
              .toEqual({ route: null, shadow: null, refusal: 'kind-lens-mismatch' });
          }
          expect(drawArm({ ...args, lensOverride: 'security' }))
            .toMatchObject(refusal ? { arm: null, refusal } : { arm });
        }
      }
    });

  it('an implicit security kind also refuses a null override', () => {
    const args = { kind: 'review-security', lensOverride: null, builder, capacity,
      subject: 'fixture#implicit-security', policy: policyFor('review-security', builder) };
    expect(drawArm(args)).toMatchObject({ arm: null, refusal: 'kind-lens-mismatch' });
    expect(routeFor(args)).toEqual({ route: null, shadow: null, refusal: 'kind-lens-mismatch' });
  });
});
