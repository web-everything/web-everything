// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ESCALATION_NOTIFY_MAX_ATTEMPTS, planRedTeamOnSkip, runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';

const repo = 'example/project', pr = 42, head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const patch = 'diff --git a/example.mjs b/example.mjs\n--- a/example.mjs\n+++ b/example.mjs\n@@ -1 +1 @@\n-old\n+new\n';

function fixture() {
  const raw = { number: pr, headRefOid: head, reviews: [], labels: ['review:accepted', 'red-team:pending'],
    comments: [{ author: { login: 'web-everything' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->` }] };
  const payload = { verdict: { verdict: 'accept' }, findings: { read: {
    netBasis: { rev: head, base: otherHead, scored: true }, diffScored: true,
    diffText: patch, netChangedFiles: ['example.mjs'],
  } } };
  const status = { repo, pr, head, status: 'finished', result: 'not-owed', sealedBreaks: [], loopPayload: payload };
  const evidence = { loopPayload: payload, status, inFlight: false, queued: false, recorded: false,
    seatRecorded: false, completedRecorded: false };
  const options = { repo, rawPrs: [raw], plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
    readEvidence: () => evidence, readStatus: () => status, readSeal: () => null, readReviewRuns: () => [],
    headNeverReviewed: () => false, readComments: () => raw.comments,
    setting: { enabled: true, retryCooldownMin: 30 }, now: () => 2_000_000, lastDispatch: new Map(),
    exec: vi.fn(() => ''), log: vi.fn(), escalate: vi.fn(), emit: vi.fn(),
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 123 })) };
  const plan = () => planRedTeamOnSkip({ ...options, refusals: options.plan.refusals, now: options.now(), gitExec: options.exec })[0];
  return { options, payload, status, evidence, plan };
}

describe('round 3: a sealed empty break list never proves a pass is not owed', () => {
  it('fails closed to a full review for an accepted non-empty code diff that still owes a pass', () => {
    const f = fixture();
    expect(redTeamOwedFor(f.payload)).toBe(true);
    expect(f.plan()).toMatchObject({ action: 'review', settlementRetry: true });
    expect(f.plan().settle).toBeUndefined();
  });

  it('settles a proven empty diff even when the accepted verdict normally owes a pass', () => {
    const f = fixture();
    f.payload.findings.read.diffText = '';
    f.payload.findings.read.netChangedFiles = [];
    expect(redTeamOwedFor(f.payload)).toBe(true);
    expect(f.plan()).toMatchObject({ action: 'clear' });
    expect(f.options.exec).toHaveBeenCalledWith('git', expect.arrayContaining([`${otherHead}..${head}`]), expect.any(Object));
  });

  it('settles when the shared owed-pass policy proves nothing is owed on the exact head', () => {
    const f = fixture();
    f.payload.verdict.verdict = 'changes';
    expect(redTeamOwedFor(f.payload)).toBe(false);
    expect(f.plan()).toMatchObject({ action: 'clear' });
  });

  it('never clears using an owed-pass proof for another head', () => {
    const f = fixture();
    f.status.loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
      ...f.payload.findings.read, netBasis: { rev: otherHead },
    } } };
    expect(redTeamOwedFor(f.status.loopPayload)).toBe(false);
    expect(f.plan()).toMatchObject({ action: 'review' });
    expect(f.plan().settle).toBeUndefined();
  });

  it.each(['missing verdict', 'unknown verdict', 'unverified empty diff'])('retains the hold for %s', kind => {
    const f = fixture();
    if (kind === 'missing verdict') delete f.payload.verdict;
    if (kind === 'unknown verdict') f.payload.verdict.verdict = 'new-verdict';
    if (kind === 'unverified empty diff') {
      f.payload.findings.read.diffText = '';
      f.payload.findings.read.netChangedFiles = [];
      f.options.exec.mockImplementation(() => { throw Error('unreadable diff'); });
    }
    expect(f.plan().action).not.toBe('clear');
    expect(f.plan().settle).toBeUndefined();
  });
});

function escalationFixture() {
  const f = fixture();
  f.options.readEvidence = () => ({ ok: false, reason: 'review-unfinished' });
  return { ...f, tick: () => runRedTeamOnSkip(f.options) };
}

describe('round 3: escalation notification delivery', () => {
  it('retries a throwing sink on the next tick, then marks success done without repeating', () => {
    const f = escalationFixture();
    f.options.escalate.mockImplementationOnce(() => { throw Error('sink unavailable'); });
    expect(f.tick().rows[0]).toMatchObject({ escalate: true, settleError: 'sink unavailable' });
    expect(f.options.escalate).toHaveBeenCalledOnce();
    f.tick();
    expect(f.options.escalate).toHaveBeenCalledTimes(2);
    f.tick();
    expect(f.options.escalate).toHaveBeenCalledTimes(2);
    expect(f.options.emit).not.toHaveBeenCalled();
    expect(f.options.lastDispatch.size).toBe(0);
  });

  it.each(['throw', 'error result'])('emits escalation-notify-failed once at the retry bound and stops (%s)', kind => {
    const f = escalationFixture();
    f.options.escalate.mockImplementation(() => {
      if (kind === 'throw') throw Error('sink unavailable');
      return { outcome: 'error', reason: 'sink unavailable' };
    });
    f.tick(); f.tick(); f.tick();
    expect(ESCALATION_NOTIFY_MAX_ATTEMPTS).toBe(3);
    expect(f.options.escalate).toHaveBeenCalledTimes(ESCALATION_NOTIFY_MAX_ATTEMPTS);
    expect(f.options.emit).toHaveBeenCalledOnce();
    expect(f.options.emit).toHaveBeenCalledWith({ kind: 'escalation-notify-failed', repo, pr, daemon: 'review',
      detail: { head, reason: 'review-unfinished', attempts: ESCALATION_NOTIFY_MAX_ATTEMPTS, error: 'sink unavailable' } });
    f.tick(); f.tick();
    expect(f.options.escalate).toHaveBeenCalledTimes(ESCALATION_NOTIFY_MAX_ATTEMPTS);
    expect(f.options.emit).toHaveBeenCalledOnce();
    expect(f.options.log).toHaveBeenCalledWith(expect.stringContaining('operator must inspect'));
    expect(f.options.lastDispatch.size).toBe(0);
  });

  it('keeps an async notification pending across ticks and only marks it done after resolution', async () => {
    const f = escalationFixture();
    let resolve;
    f.options.escalate.mockReturnValue(new Promise(done => { resolve = done; }));
    f.tick(); f.tick();
    expect(f.options.escalate).toHaveBeenCalledOnce();
    resolve();
    await new Promise(done => setImmediate(done));
    f.tick();
    expect(f.options.escalate).toHaveBeenCalledOnce();
  });

  it('retries a rejected async notification on the next tick', async () => {
    const f = escalationFixture();
    const delivery = Promise.reject(Error('sink unavailable'));
    f.options.escalate.mockReturnValueOnce(delivery);
    f.tick();
    await new Promise(done => setImmediate(done));
    f.tick(); f.tick();
    expect(f.options.escalate).toHaveBeenCalledTimes(2);
    expect(f.options.emit).not.toHaveBeenCalled();
  });
});
