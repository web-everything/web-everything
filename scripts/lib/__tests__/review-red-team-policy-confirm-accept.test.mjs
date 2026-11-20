// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';

describe('redTeamOwedFor: confirm-step accept of prevention-outstanding (live #6949)', () => {
  it('owes a red team when the run was confirmed accept', () => {
    expect(redTeamOwedFor({ verdict: { verdict: 'prevention-outstanding' }, findings: { confirm: 'accept' } })).toBe(true);
  });
  it('does not owe one without the accept confirm', () => {
    expect(redTeamOwedFor({ verdict: { verdict: 'prevention-outstanding' }, findings: {} })).toBe(false);
    expect(redTeamOwedFor({ verdict: { verdict: 'prevention-outstanding' }, findings: { confirm: 'reject' } })).toBe(false);
  });
  it('still owes on a plain accept and not on changes', () => {
    expect(redTeamOwedFor({ verdict: { verdict: 'accept' } })).toBe(true);
    expect(redTeamOwedFor({ verdict: { verdict: 'changes' }, findings: { confirm: 'accept' } })).toBe(false);
  });
});
