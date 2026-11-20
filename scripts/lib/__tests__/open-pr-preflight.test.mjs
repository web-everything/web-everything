import { describe, it, expect } from 'vitest';
import { HINTS, blocker, mergeBlockers, formatBlockers } from '../open-pr-preflight.mjs';
import { planOpen, classifySubmit, describeSubmit } from '../../operations/open-pr.mjs';

describe('open-pr preflight presentation', () => {
  it('formats every blocker and its fix, stripping terminal control characters', () => {
    const blockers = [blocker('verify', 'verify-red', 'failed\x1b'), blocker('soak', 'soak-declaration', 'missing break')];
    const detail = formatBlockers(blockers);
    expect(detail).toContain(HINTS['verify-red']);
    expect(detail).toContain('module + .soak.test.mjs');
    expect(detail).not.toContain('\x1b');
    expect(formatBlockers([])).toBe('');
  });
  it('merges duplicate evidence in first-seen order and binds audit hints to the sha', () => {
    const audit = blocker('canonical-audit', 'canonical-audit-weakened', 'weakened', 'a'.repeat(40));
    const verify = blocker('verify', 'unverified', 'missing');
    expect(mergeBlockers([audit], [audit, verify], [])).toEqual([audit, verify]);
    expect(audit.hint).toContain(`waiver request for sha ${'a'.repeat(40)}`);
  });
  it('plans --check without requiring a body and renders preflight success', () => {
    const plan = planOpen({ ref: 'lane/x', base: 'main', mode: 'no-wait', check: true });
    expect(plan.argv).toContain('--check');
    const result = classifySubmit({ status: 0, stdout: JSON.stringify({ reason: 'check-ok' }) });
    expect(result.outcome).toBe('checked');
    expect(describeSubmit(result).failed).toBe(false);
  });
});
