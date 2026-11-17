// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { planRedTeamOnSkip, runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { proveEquivalentRedTeamDiff } from '../red-team-empty-net-diff.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

const repo = 'example/project', pr = 42, head = 'a'.repeat(40), old = 'b'.repeat(40), base = 'c'.repeat(40);
const patch = 'diff --git a/example.mjs b/example.mjs\n--- a/example.mjs\n+++ b/example.mjs\n@@ -1 +1 @@\n-old\n+new\n';
const trusted = body => ({ body, author: { login: 'web-everything' } });
const accept = rev => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${rev} -->`);
const result = rev => trusted(renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm',
  findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' }));

function fixture() {
  let clock = 0;
  const raw = { number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'],
    reviews: [], comments: [accept(old), result(old)] };
  const evidence = { loopPayload: { verdict: { verdict: 'accept' }, findings: { read: {
    netBasis: { rev: old }, diffText: patch, netChangedFiles: ['example.mjs'],
  } } }, inFlight: false, recorded: false, seatRecorded: false, completedRecorded: false };
  const options = { repo, env: { WE_REVIEW_CARRY_ACROSS_REBASE: 'on' }, rawPrs: [raw],
    plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
    readEvidence: () => evidence, readStatus: () => null, readSeal: () => null, readReviewRuns: () => [],
    headNeverReviewed: () => false, readComments: () => raw.comments,
    setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), now: () => clock,
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 123 })),
    log: vi.fn(), escalate: vi.fn(), emit: vi.fn(),
    exec: vi.fn((_file, args) => args[0] === 'merge-base' ? `${base}\n` : args[0] === 'patch-id' ? `${base} ${old}\n` : patch) };
  return { raw, options,
    advance: ms => { clock += ms; },
    plan: () => planRedTeamOnSkip({ ...options, refusals: options.plan.refusals, now: options.now(), gitExec: options.exec })[0],
    tick: () => runRedTeamOnSkip(options) };
}

describe('round 4: old-head settlement obeys carryAcrossRebase', () => {
  it.each(['off', 'on'])('equal net diffs use the full review path when off and settle when on (%s)', setting => {
    const f = fixture();
    expect(proveEquivalentRedTeamDiff({ fromSha: old, toSha: head, exec: f.options.exec })).toMatchObject({ ok: true });
    f.options.exec.mockClear();
    f.options.env.WE_REVIEW_CARRY_ACROSS_REBASE = setting;
    expect(f.plan()).toMatchObject({ action: setting === 'off' ? 'review' : 'settle-result' });
    if (setting === 'off') {
      expect(f.options.exec).not.toHaveBeenCalled();
      expect(f.tick().dispatched).toEqual([{ prNumber: pr, jobPid: 123, mode: 'review' }]);
    } else expect(f.plan().from).toBe(old);
  });

  it.each(['off', 'on'])('exact-head result still settles with carry %s', setting => {
    const f = fixture();
    f.options.env.WE_REVIEW_CARRY_ACROSS_REBASE = setting;
    f.raw.comments = [accept(head), result(head)];
    expect(f.plan()).toMatchObject({ action: 'settle-result' });
    expect(f.options.exec).not.toHaveBeenCalled();
  });

  it.each(['label', 'formal review', 'unreadable reviews'])('carry off preserves the full review hold for %s', hold => {
    const f = fixture();
    f.options.env.WE_REVIEW_CARRY_ACROSS_REBASE = 'off';
    if (hold === 'label') f.raw.labels.push('review:needs-human');
    if (hold === 'formal review') f.raw.reviews.push({ state: 'CHANGES_REQUESTED', submittedAt: '2026-11-17T12:00:00Z' });
    if (hold === 'unreadable reviews') f.raw.reviews = undefined;
    expect(f.plan()).toMatchObject({ action: 'skip' });
    expect(f.options.exec).not.toHaveBeenCalled();
  });
});

function escalationFixture() {
  const f = fixture();
  f.options.readEvidence = () => ({ ok: false, reason: 'review-unfinished' });
  f.options.escalate.mockImplementation(() => { throw Error('sink unavailable'); });
  return f;
}

describe('round 4: escalation retries while open', () => {
  it('doubles the retry interval from one minute and caps it at thirty minutes', () => {
    const f = escalationFixture();
    f.tick();
    let attempts = 1;
    for (const minutes of [1, 2, 4, 8, 16, 30, 30, 30]) {
      f.advance(minutes * 60_000 - 1);
      f.tick();
      expect(f.options.escalate).toHaveBeenCalledTimes(attempts);
      f.advance(1);
      f.tick();
      expect(f.options.escalate).toHaveBeenCalledTimes(++attempts);
    }
  });

  it('never gives up after many failures and later recovery delivers once, then stops', () => {
    const f = escalationFixture();
    for (let attempt = 0; attempt < 40; attempt++) {
      f.tick();
      f.advance(30 * 60_000);
    }
    expect(f.options.escalate).toHaveBeenCalledTimes(40);
    f.options.escalate.mockImplementation(() => undefined);
    f.tick();
    expect(f.options.escalate).toHaveBeenCalledTimes(41);
    for (const minutes of [30, 60, 24 * 60]) {
      f.advance(minutes * 60_000);
      f.tick();
    }
    expect(f.options.escalate).toHaveBeenCalledTimes(41);
    expect(f.options.dispatch).not.toHaveBeenCalled();
  });

  it('emits the typed event on the first failure and at most hourly thereafter', () => {
    const f = escalationFixture();
    f.tick();
    expect(f.options.emit).toHaveBeenCalledOnce();
    expect(f.options.emit).toHaveBeenCalledWith({ kind: 'escalation-notify-failed', repo, pr, daemon: 'review',
      detail: { head, reason: 'review-unfinished', attempts: 1, error: 'sink unavailable' } });
    const emittedAt = [f.options.now()];
    for (let minute = 1; minute <= 240; minute++) {
      f.advance(60_000);
      const before = f.options.emit.mock.calls.length;
      f.tick();
      if (f.options.emit.mock.calls.length > before) emittedAt.push(f.options.now());
      if (minute < 60) expect(f.options.emit).toHaveBeenCalledOnce();
    }
    expect(emittedAt.length).toBeGreaterThan(1);
    for (let i = 1; i < emittedAt.length; i++) expect(emittedAt[i] - emittedAt[i - 1]).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it('schedules async failures from completion time and suppresses retries while pending', async () => {
    const f = escalationFixture();
    let reject;
    f.options.escalate.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    f.tick();
    f.advance(60 * 60_000);
    f.tick();
    expect(f.options.escalate).toHaveBeenCalledOnce();
    reject(Error('sink unavailable'));
    await new Promise(done => setImmediate(done));
    f.advance(59_999);
    f.tick();
    expect(f.options.escalate).toHaveBeenCalledOnce();
    f.advance(1);
    f.options.escalate.mockImplementation(() => Promise.resolve());
    f.tick();
    await new Promise(done => setImmediate(done));
    f.advance(60 * 60_000);
    f.tick();
    expect(f.options.escalate).toHaveBeenCalledTimes(2);
  });
});
