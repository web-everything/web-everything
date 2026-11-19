import { describe, it, expect } from 'vitest';
import { resolveWaitState } from '../pr-sweep-core.mjs';

const now = Date.parse('2026-11-08T05:00:00Z');
const at = new Date(now - 10 * 60000).toISOString();
const open = { number: 6531, headRefOid: 'abc', labels: ['review:accepted'], isDraft: false };
const line = (kind, tail) => `reconcile-fix-dispatch-daemon: reconcile-refused ${kind} web-everything/web-everything PR #6531 — ${tail}`;
const refusal = (reason, extra = {}) => ({ kind: 'refusal', at, name: 'fix-dispatch-daemon', reason, ...extra });
const ctx = { now };

describe('resolveWaitState: informational daemon refusals are not a wait owner', () => {
  it('reconcile-refused nothing-owed (phase `queued`) does not produce kind refused', () => {
    const r = refusal(line('nothing-owed', 'phase `queued` — reviewed and queued, or already landed; this pass has nothing to dispatch'));
    expect(resolveWaitState(open, { daemons: [r] }, ctx)).toBeNull();
  });
  it('reconcile-refused draft does not produce kind refused; a draft PR is parked', () => {
    const r = refusal(line('draft', 'PR is still a draft — no independent review is dispatched'));
    expect(resolveWaitState({ ...open, isDraft: true }, { daemons: [r] }, ctx)).toMatchObject({ kind: 'parked', detail: 'draft' });
    expect(resolveWaitState(open, { daemons: [r] }, ctx)).toBeNull();
  });
  it('health-store reasons (`reconcile-refused nothing-owed`, `refused draft: ...`) are informational too', () => {
    expect(resolveWaitState(open, { daemons: [refusal('reconcile-refused nothing-owed')] }, ctx)).toBeNull();
    expect(resolveWaitState(open, { daemons: [refusal('refused draft: PR is still a draft')] }, ctx)).toBeNull();
  });
  it.each(['no-lane', 'cap-exhausted', 'owed-elsewhere', 'review-referrals-pending', 'dispatch-failed'])('refused %s still counts', (kind) => {
    expect(resolveWaitState(open, { daemons: [refusal(line(kind, 'x'))] }, ctx)).toMatchObject({ kind: 'refused', by: 'fix-dispatch-daemon' });
  });
  it('an unparseable reason fails closed and still counts', () => {
    expect(resolveWaitState(open, { daemons: [refusal('something refused')] }, ctx)).toMatchObject({ kind: 'refused' });
  });
  it('a newer informational refusal supersedes an older blocking one', () => {
    const older = refusal(line('no-lane', 'x'), { at: new Date(now - 60 * 60000).toISOString() });
    expect(resolveWaitState(open, { daemons: [older, refusal(line('nothing-owed', 'x'))] }, ctx)).toBeNull();
  });
  it('R502 precedence unchanged: live claim > refusal > parked', () => {
    const real = refusal(line('no-lane', 'x'));
    const draft = { ...open, isDraft: true };
    expect(resolveWaitState(draft, { fixClaim: { who: 'fix-1' }, daemons: [real] }, ctx)).toMatchObject({ kind: 'live-claim' });
    expect(resolveWaitState(draft, { daemons: [real] }, ctx)).toMatchObject({ kind: 'refused' });
    expect(resolveWaitState(draft, {}, ctx)).toMatchObject({ kind: 'parked' });
  });
});
