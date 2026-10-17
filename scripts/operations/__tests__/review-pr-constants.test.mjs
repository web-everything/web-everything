/**
 * #5725 — `review-pr-constants.mjs` is the extracted home of `CONFIRM_ACTORS` / `CONFIRM_OPTIONS` / `REVIEW_EFFECTS`.
 * The old import path (`review-pr.mjs`) must keep exporting the SAME frozen objects, with the same values.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as constants from '../review-pr-constants.mjs';
import * as operation from '../review-pr.mjs';
import { LEDGER_EFFECT_TYPE } from '../effect-executor.mjs';

describe('review-pr-constants — export identity with the full operation', () => {
  for (const name of ['CONFIRM_ACTORS', 'CONFIRM_OPTIONS', 'REVIEW_EFFECTS']) {
    it(`${name} is the very same object from both modules, and frozen`, () => {
      expect(constants[name]).toBeDefined();
      expect(operation[name]).toBe(constants[name]);
      expect(Object.isFrozen(constants[name])).toBe(true);
    });
  }
});

describe('review-pr-constants — values', () => {
  it('CONFIRM_ACTORS and CONFIRM_OPTIONS keep their closed sets', () => {
    expect(constants.CONFIRM_ACTORS).toEqual({ HUMAN: 'human', AGENT: 'agent' });
    expect(constants.CONFIRM_OPTIONS).toEqual(['accept', 'changes', 'abstain']);
  });

  it('REVIEW_EFFECTS keeps every effect key and value, with the ledger type owned by the executor', () => {
    expect(constants.REVIEW_EFFECTS).toEqual({
      WRITE_UP: 'review.write-up',
      LABEL: 'review.label-swap',
      LEDGER: LEDGER_EFFECT_TYPE,
      NOTICE: 'review.notice',
      MANDATORY_REFERRALS: 'review.mandatory-referrals',
      ADVISORY_NOTE: 'review.advisory-note',
      ADVISORY_LABEL: 'review.advisory-label',
      AWAITING_ADVISORY_CLEAR: 'review.awaiting-advisory-clear',
      LEDGER_EVENTS: 'review.ledger-events',
      SCOPED_REREVIEW_SHADOW: 'review.scoped-rereview-shadow',
      STACK_HOLD: 'review.stack-hold',
    });
    expect(constants.REVIEW_EFFECTS.LEDGER).toBe('verdict-ledger.append');
  });

  it('the constants module imports only the ledger type owner — never the full operation back (the cheap-import property)', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'review-pr-constants.mjs'), 'utf8');
    const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers).toEqual(['./effect-executor.mjs']);
  });

  it('effect types are unique, so a sink lookup keyed on type can never confuse two effects', () => {
    const values = Object.values(constants.REVIEW_EFFECTS);
    expect(new Set(values).size).toBe(values.length);
  });
});
