// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { readRedTeamStatus } from '../drain-red-team-evidence.mjs';
import { sealedStatusPath } from '../red-team-sealed-status.mjs';
import { CARRIED_CHECK_ESCALATION, planRedTeamOnSkip, runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { proveEquivalentRedTeamDiff } from '../red-team-empty-net-diff.mjs';
import { syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { redTeamMarker, redTeamGateMarker, redTeamResultId, redTeamForHead } from '../red-team-gate.mjs';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';
import { settleRedTeamResult } from '../red-team-result-settlement.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { runGhSync } from '../gh-throttle.mjs';

vi.mock('../gh-throttle.mjs', async original => ({ ...await original(), runGhSync: vi.fn() }));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
const repo = 'example/project', pr = 42, head = 'a'.repeat(40), old = 'b'.repeat(40), base = 'c'.repeat(40);
const trusted = body => ({ body, author: { login: 'web-everything' }, createdAt: '2026-11-10T12:00:00Z' });
const accept = rev => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${rev} -->`);
const result = (rev = head, blocked = false) => trusted(renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm',
  findings: blocked ? [{ confirmedByRecheck: true, category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 1, summary: 'break' }] : [],
  recheckStatus: 'not-needed', foldedVerdict: blocked ? 'changes' : 'accept' }));
const patch = 'diff --git a/example.mjs b/example.mjs\n--- a/example.mjs\n+++ b/example.mjs\n@@ -1 +1 @@\n-old\n+new\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-team-settlement-')); roots.push(root);
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_CHECK_LOCK_DIR: join(root, 'locks'), WE_RED_TEAM_STATUS_LABELS: '1' };
  const raw = { number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'], reviews: [], comments: [accept(head), result()] };
  const payload = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head }, diffText: patch, netChangedFiles: ['example.mjs'] } } };
  const evidence = { loopPayload: payload, inFlight: false, recorded: false, seatRecorded: false, completedRecorded: false };
  const provider = { readPrState: vi.fn(() => raw), readComments: () => raw.comments, readPrFiles: () => ['example.mjs'],
    ensureLabel: vi.fn(), setLabels: vi.fn((_repo, _pr, change) => {
      raw.labels = raw.labels.filter(label => !change.remove.includes(label));
      if (change.add) raw.labels.push(change.add);
    }) };
  const options = { repo, env, rawPrs: [raw], plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
    readEvidence: () => evidence, readStatus: () => null, readSeal: () => null, provider,
    readComments: () => raw.comments, syncLabels: vi.fn(syncRedTeamStatusLabels),
    setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), now: () => 2_000_000,
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 123 })), escalate: vi.fn(),
    publishCarriedCheck: vi.fn(() => ({ ok: true })), publishCheck: vi.fn(() => ({ ok: true })),
    exec: vi.fn((_file, args) => args[0] === 'merge-base' ? `${base}\n` : args[0] === 'patch-id' ? `${base} ${old}\n` : patch) };
  runGhSync.mockImplementation((_args, io) => { raw.comments.push(trusted(io.input)); return ''; });
  const plan = () => planRedTeamOnSkip({ ...options, refusals: options.plan.refusals, now: options.now(), gitExec: options.exec });
  return { raw, evidence, options, provider, plan };
}

describe('one red-team result settlement path', () => {
  it.each([false, true])('an owed carried check permits its first dispatch, then escalates failed retries once per head (pending: %s)', pending => {
    const f = fixture();
    f.raw.comments[1].body = `<!-- review-verdict-carried from=${old} to=${head} patch-id=${base} -->\nReview verdict carried across an identical contribution.\n${f.raw.comments[1].body}`;
    // Acceptance is re-stamped after the carry, so the carry does not supersede it.
    f.raw.comments.reverse();
    if (!pending) f.raw.labels = ['review:accepted', 'red-team:clear'];
    f.options.readCarriedCheck = () => true;
    f.options.readStatus = key => readRedTeamStatus({ ...key, env: f.options.env });
    f.options.publishCarriedCheck.mockReturnValue({ ok: false, remoteHold: true, reason: 'publication hold not cleared' });
    const first = runRedTeamOnSkip(f.options);
    expect(first.rows[0]).toMatchObject({ action: 'review',
      carriedRetryResultId: redTeamResultId(redTeamForHead(f.raw.comments, pr, head)) });
    expect(first.dispatched).toEqual([{ prNumber: pr, jobPid: 123, mode: 'review' }]);
    expect(f.options.escalate).not.toHaveBeenCalled();
    expect(readRedTeamStatus({ repo, pr, head, env: f.options.env })).toMatchObject({ retryCount: 1 });
    for (const at of [4_000_000, 9_000_000]) {
      f.options.now = () => at;
      f.options.capacity = { lanes: 1, budget: { left: 1 } };
      expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip', escalate: true });
      expect(f.options.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    }
    expect(f.options.dispatch).toHaveBeenCalledOnce();
    expect(f.options.escalate).toHaveBeenCalledOnce();
    expect(f.options.lastDispatch.get(`${repo}#${pr}@${head}`)).toBe(2_000_000);
  });
  it('a fully settled result with a present check settles stale pending directly and never dispatches', () => {
    const f = fixture();
    f.options.readCheckFact = vi.fn(() => ({ ok: true }));
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'settle-result' });
    expect(f.raw.labels).toEqual(['review:accepted', 'red-team:clear']);
    for (const at of [4_000_000, 9_000_000]) {
      f.options.now = () => at;
      expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
    }
    expect(f.options.syncLabels).toHaveBeenCalledOnce();
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.publishCarriedCheck).not.toHaveBeenCalled();
    expect(f.options.publishCheck).not.toHaveBeenCalled();
    expect(f.options.escalate).not.toHaveBeenCalled();
    expect(f.options.lastDispatch.size).toBe(0);
  });
  it('a carried check settled during retry authorization refuses dispatch without spending a retry', () => {
    const f = fixture();
    f.raw.comments[1].body = `<!-- review-verdict-carried from=${old} to=${head} patch-id=${base} -->\nReview verdict carried across an identical contribution.\n${f.raw.comments[1].body}`;
    f.raw.comments.reverse();
    let owed = true;
    f.options.readCarriedCheck = () => owed;
    f.options.publishCarriedCheck.mockReturnValue({ ok: false, remoteHold: true, reason: 'publication hold not cleared' });
    f.options.readCompleteReviews = () => { owed = false; return []; };
    const out = runRedTeamOnSkip(f.options);
    expect(out.rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('outcome already settled') });
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).not.toHaveBeenCalled();
    expect(f.options.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(f.options.lastDispatch.has(`${repo}#${pr}@${head}`)).toBe(false);
    expect(readRedTeamStatus({ repo, pr, head, env: f.options.env })).toBeNull();
  });
  it('check progress alone permits replanning after a dispatch', () => {
    const f = fixture(); f.raw.comments.pop();
    f.options.readCheckFact = vi.fn(() => ({ ok: false, reason: 'no red-team check run on head' }));
    runRedTeamOnSkip(f.options);
    f.options.now = () => 4_000_000;
    f.options.capacity = { lanes: 1, budget: { left: 1 } };
    f.options.readCheckFact.mockReturnValue({ ok: true });
    expect(f.plan()[0]).toMatchObject({ action: 'dispatch' });
    runRedTeamOnSkip(f.options);
    expect(f.options.dispatch).toHaveBeenCalledTimes(2);
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('the final dispatch guard refuses unchanged evidence even when planning saw a new comment', () => {
    const f = fixture(); f.raw.comments.pop();
    runRedTeamOnSkip(f.options);
    const unchanged = [...f.raw.comments];
    f.raw.comments.push(trusted('Additional context in the planning snapshot'));
    f.options.readComments = () => unchanged;
    for (const at of [4_000_000, 9_000_000]) {
      f.options.now = () => at;
      f.options.capacity = { lanes: 1, budget: { left: 1 } };
      expect(f.plan()[0]).toMatchObject({ action: 'dispatch' });
      expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip', escalate: true,
        why: expect.stringContaining('no comment or label progress') });
      expect(f.options.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    }
    expect(f.options.dispatch).toHaveBeenCalledOnce();
    expect(f.options.escalate).toHaveBeenCalledOnce();
    expect(f.options.lastDispatch.get(`${repo}#${pr}@${head}`)).toBe(2_000_000);
  });
  it('unreadable check evidence at dispatch holds without consuming capacity or dispatch history', () => {
    const f = fixture(); f.raw.comments.pop();
    f.options.readCheckFact = () => { throw Error('check read unavailable'); };
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip',
      why: expect.stringContaining('check evidence unreadable before dispatch; operator must inspect') });
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(f.options.lastDispatch.size).toBe(0);
  });
  it('unreadable checks after a prior dispatch hold that PR without throwing and continue planning another PR', () => {
    const f = fixture(); f.raw.comments.pop();
    f.options.readCheckFact = vi.fn(() => ({ ok: false, reason: 'no red-team check run on head' }));
    expect(runRedTeamOnSkip(f.options).dispatched).toEqual([{ prNumber: pr, jobPid: 123, mode: 'fresh' }]);
    f.options.now = () => 4_000_000;
    f.options.capacity = { lanes: 1, budget: { left: 1 } };
    f.options.rawPrs.push({ ...f.raw, number: pr + 1 });
    f.options.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: pr + 1, headSha: head });
    f.options.readCheckFact.mockClear();
    f.options.readCheckFact.mockImplementation(() => { throw Error('check read unavailable'); });
    let rows;
    expect(() => { rows = f.plan(); }).not.toThrow();
    expect(rows).toEqual([
      expect.objectContaining({ prNumber: pr, action: 'skip',
        why: 'check evidence unreadable while planning retry; operator must inspect' }),
      expect.objectContaining({ prNumber: pr + 1, action: 'dispatch', mode: 'fresh' }),
    ]);
    expect(f.options.readCheckFact).toHaveBeenCalledOnce();
    expect(f.options.readCheckFact).toHaveBeenCalledWith({ repo, pr, headSha: head });
    expect(f.options.dispatch).toHaveBeenCalledOnce();
    expect(f.options.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect([...f.options.lastDispatch]).toEqual([[`${repo}#${pr}@${head}`, 2_000_000]]);
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it.each([false, true])('a refused carried-check retry keeps its escalation once per head (pending: %s)', pending => {
    const f = fixture();
    f.raw.comments = [trusted(`<!-- review-verdict-carried from=${old} to=${head} patch-id=${base} -->\nReview verdict carried across an identical contribution.\n${result().body}`), accept(head)];
    if (!pending) f.raw.labels = ['review:accepted'];
    f.options.readCarriedCheck = () => true;
    let readsSincePublication = null;
    f.options.publishCarriedCheck.mockImplementation(() => {
      readsSincePublication = 0;
      return { ok: false, remoteHold: true, reason: 'publication hold not cleared' };
    });
    f.options.readComments = () => {
      // A different settled result arrives at the final dispatch boundary, after retry authorization.
      if (readsSincePublication !== null && ++readsSincePublication === 3) {
        readsSincePublication = null;
        return [accept(head), result(head, true)];
      }
      return f.raw.comments;
    };
    for (const at of [2_000_000, 4_000_000, 9_000_000]) {
      f.options.now = () => at;
      const out = runRedTeamOnSkip(f.options);
      expect(out.rows[0]).toMatchObject({ action: 'review', escalate: true,
        why: `${CARRIED_CHECK_ESCALATION}: publication hold not cleared` });
      expect(out.dispatched).toEqual([]);
      expect(out.notStarted).toEqual([{ prNumber: pr, reason: out.rows[0].why }]);
      expect(f.options.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
      expect(f.options.lastDispatch.has(`${repo}#${pr}@${head}`)).toBe(false);
      expect(readRedTeamStatus({ repo, pr, head, env: f.options.env })).toBeNull();
    }
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).toHaveBeenCalledOnce();
    expect(f.options.escalate).toHaveBeenCalledWith({ repo, pr, head,
      why: `${CARRIED_CHECK_ESCALATION}: publication hold not cleared` });
  });
  it.each(['operator-card', 'operator-block', 'operator-not-real'])('recorded %s settles pending through the gate and never dispatches on repeated ticks', outcome => {
    const f = fixture(); f.raw.comments[1] = result(head, true);
    const id = redTeamResultId(redTeamForHead(f.raw.comments, pr, head));
    f.raw.comments.push(trusted(`${redTeamGateMarker(pr, head, 'round-cap', id)}\n- 1 confirmed break(s) NOT sent back: cap (#1).`));
    const line = outcome === 'operator-card' ? '- 1 finding(s) carded by the operator to `#7000` (#1).'
      : outcome === 'operator-not-real' ? '- 1 finding(s) left advisory (#1).'
        : '- 1 confirmed break(s) sent back to the fixer (#1).';
    f.raw.comments.push({ body: `${redTeamGateMarker(pr, head, outcome, id)}\n${line}`,
      author: { login: OPERATOR_LOGINS[0], type: 'User' }, createdAt: '2026-11-10T13:00:00Z' });
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result' });
    const settled = settleRedTeamResult({ prNumber: pr, head }, { ...f.options, note: () => {} });
    expect(settled).toEqual({ blocked: outcome === 'operator-block' });
    expect(f.raw.labels).toEqual(['review:accepted', outcome === 'operator-block' ? 'red-team:blocked' : 'red-team:clear']);
    for (const at of [2_000_000, 4_000_000, 9_000_000]) {
      f.options.now = () => at;
      expect(f.plan()[0].action).toBe('skip');
      runRedTeamOnSkip(f.options);
    }
    expect(f.options.dispatch).not.toHaveBeenCalled();
  });
  it.each(['clear', 'blocked', 'not-owed'])('settled %s never dispatches even with an unfinished carry journal', outcome => {
    const f = fixture();
    if (outcome === 'blocked') f.raw.comments[1] = result(head, true);
    if (outcome === 'not-owed') f.raw.comments[1] = trusted(`${redTeamMarker(pr, head)}\nRed team not required on this head: not owed (stored review)`);
    f.options.readCarry = () => ({ step: 'publishing' });
    for (const at of [2_000_000, 4_000_000, 9_000_000]) {
      f.options.now = () => at;
      expect(['review', 'dispatch']).not.toContain(f.plan()[0].action);
      runRedTeamOnSkip(f.options);
    }
    expect(f.options.dispatch).not.toHaveBeenCalled();
  });
  it('unreadable settled labels hold and escalate once per head', () => {
    const f = fixture(); f.raw.labels = null;
    runRedTeamOnSkip(f.options); runRedTeamOnSkip(f.options);
    f.options.now = () => 9_000_000; runRedTeamOnSkip(f.options);
    expect(f.options.escalate).toHaveBeenCalledOnce();
    expect(f.options.dispatch).not.toHaveBeenCalled(); expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it('a no-progress dispatch cannot repeat after the cooldown; changed comments permit recovery', () => {
    const f = fixture(); f.raw.comments.pop();
    runRedTeamOnSkip(f.options);
    for (const at of [4_000_000, 9_000_000]) {
      f.options.now = () => at;
      f.options.capacity = { lanes: 1, budget: { left: 1 } };
      expect(f.plan()[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('no comment or label progress') });
      runRedTeamOnSkip(f.options);
    }
    expect(f.options.dispatch).toHaveBeenCalledOnce(); expect(f.options.escalate).toHaveBeenCalledOnce();
    f.raw.comments.push(trusted('Additional review context'));
    expect(f.plan()[0].action).toBe('dispatch');
  });
  it('variant 3: plans and applies an exact-head clear result, removing pending without escalation', () => {
    const f = fixture();
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result' });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'settle-result' });
    expect(f.raw.labels).toEqual(['review:accepted', 'red-team:clear']);
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('variant 1: settles pending before publishing an owed carried check', () => {
    const f = fixture();
    f.raw.comments[1].body = `<!-- review-verdict-carried from=${old} to=${head} patch-id=${base} -->\nReview verdict carried across an identical contribution.\n${f.raw.comments[1].body}`;
    f.options.readCarriedCheck = () => true;
    f.options.publishCarriedCheck.mockImplementation(() => {
      expect(f.raw.labels).toContain('red-team:clear');
      expect(f.raw.labels).not.toContain('red-team:pending');
      return { ok: true };
    });
    expect(f.plan()[0]).toMatchObject({ action: 'publish-carried-check' });
    runRedTeamOnSkip(f.options);
    expect(f.options.publishCarriedCheck).toHaveBeenCalledOnce();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('variant 2: sealed finished not-owed on a proven accepted head settles through stored policy clear', () => {
    const f = fixture(); f.raw.comments = [accept(head)];
    f.evidence.loopPayload.verdict.verdict = 'changes';
    const status = { repo, pr, head, status: 'finished', result: 'not-owed', sealedBreaks: [], loopPayload: f.evidence.loopPayload };
    f.evidence.status = status; f.options.readStatus = () => status;
    expect(f.plan()[0]).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'clear' });
    expect(f.raw.comments.at(-1).body).toContain('not owed (stored review)');
    expect(f.raw.labels).toEqual(['review:accepted', 'red-team:clear']);
    expect(redTeamEnqueueHold({ ...f.evidence, repo, pr, head, comments: f.raw.comments, env: f.options.env })).toBeNull();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it.each(['unfinished', 'unsealed', 'wrong head', 'guard-deferred', 'blocked'])('not-owed fails closed with %s evidence', kind => {
    const f = fixture(); f.raw.comments = [accept(head)]; f.evidence.loopPayload.verdict.verdict = 'changes';
    const status = { head, status: 'finished', result: 'not-owed', sealedBreaks: [], loopPayload: f.evidence.loopPayload };
    if (kind === 'unfinished') status.status = 'running';
    if (kind === 'unsealed') delete status.sealedBreaks;
    if (kind === 'wrong head') status.head = old;
    if (kind === 'guard-deferred') status.result = { status: 'not-owed', deferredByGuard: true };
    if (kind === 'blocked') status.sealedBreaks = ['break'];
    f.evidence.status = status; f.options.readStatus = () => status;
    expect(f.plan()[0].action).not.toBe('clear');
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled();
    expect(f.options.publishCheck).not.toHaveBeenCalled();
  });
  it('a blocked exact-head result applies blocked and removes pending without becoming clear', () => {
    const f = fixture(); f.raw.comments[1] = result(head, true);
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result' });
    runRedTeamOnSkip(f.options);
    expect(f.raw.labels).toEqual(['review:accepted', 'red-team:blocked']);
    expect(f.options.publishCheck).not.toHaveBeenCalled();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('a blocked label on the head wins even over a clean result', () => {
    const f = fixture(); f.raw.labels.push('red-team:blocked');
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result' });
    runRedTeamOnSkip(f.options);
    expect(f.raw.labels).toContain('red-team:blocked'); expect(f.raw.labels).not.toContain('red-team:clear');
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it.each(['missing', 'untrusted'])('never clears without a real result (%s)', kind => {
    const f = fixture();
    if (kind === 'missing') f.raw.comments.pop(); else f.raw.comments[1].author.login = 'outsider';
    expect(f.plan()[0].action).toBe('dispatch');
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled();
    expect(f.options.dispatch).toHaveBeenCalledOnce();
  });
  it('carries a valid result only when the complete net patches are equal', () => {
    const f = fixture(); f.raw.comments = [accept(old), result(old)];
    f.evidence.loopPayload.findings.read.netBasis.rev = old;
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result', from: old });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'settle-result', from: old });
    expect(f.raw.comments.at(-1).body).toContain(redTeamMarker(pr, head));
    expect(f.raw.labels).toContain('red-team:clear');
    expect(f.options.publishCarriedCheck).toHaveBeenCalledOnce();
    expect(f.options.dispatch).not.toHaveBeenCalled();
  });
  it.each(['different', 'unreadable', 'oversized'])('re-runs instead of carrying a %s net diff', kind => {
    const f = fixture(); f.raw.comments = [accept(old), result(old)];
    f.evidence.loopPayload.findings.read.netBasis.rev = old;
    f.options.exec.mockImplementation((_file, args) => {
      if (kind === 'unreadable') throw Error('objects unavailable');
      if (args[0] === 'merge-base') return `${base}\n`;
      return kind === 'oversized' ? 'x'.repeat(1024 * 1024 + 1) : args.includes(`${base}..${head}`) ? `${patch}+different\n` : patch;
    });
    expect(f.plan()[0]).toMatchObject({ action: 'review', why: 'unprovable head move needs a full review' });
    runRedTeamOnSkip(f.options);
    expect(f.options.dispatch).toHaveBeenCalledWith({ repo, pr });
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(runGhSync).not.toHaveBeenCalled();
  });
  it('a valid published result with unknown evidence holds once without a review retry', () => {
    const f = fixture(); f.evidence.ok = false;
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.publishCarriedCheck).not.toHaveBeenCalled();
    expect(f.options.dispatch).not.toHaveBeenCalled(); expect(f.options.escalate).toHaveBeenCalledOnce();
    f.options.capacity.lanes = 1; f.options.capacity.budget.left = 1;
    const second = runRedTeamOnSkip(f.options).rows[0];
    expect(second).toMatchObject({ action: 'skip', escalate: true, why: expect.stringContaining('settled red-team outcome') });
    expect(f.options.dispatch).not.toHaveBeenCalled(); expect(f.options.escalate).toHaveBeenCalledOnce();
  });
  it.each(['review:human', 'review:changes', 'review:pending', 'unreadable seal', 'formal review', 'unreadable reviews'])(
    'published-result settlement failure holds without a review retry: %s', hold => {
      const f = fixture(); let seal = null;
      f.options.readSeal = () => seal;
      f.options.readCompleteReviews = () => f.raw.reviews;
      // Reach the settlement failure first; retry authorization must read the current hold evidence.
      f.options.syncLabels.mockImplementation(() => {
        if (hold.startsWith('review:')) f.raw.labels.push(hold);
        if (hold === 'unreadable seal') seal = { unreadable: true };
        if (hold === 'formal review') f.raw.reviews = [{ state: 'CHANGES_REQUESTED' }];
        if (hold === 'unreadable reviews') f.raw.reviews = null;
        throw Error('label settlement unavailable');
      });
      const row = runRedTeamOnSkip(f.options).rows[0];
      expect(row).toMatchObject({ action: 'skip', escalate: true, why: expect.stringContaining('settled red-team outcome') });
      expect(f.options.syncLabels).toHaveBeenCalledOnce();
      expect(f.options.dispatch).not.toHaveBeenCalled();
      expect(f.provider.setLabels).not.toHaveBeenCalled();
      expect(f.options.publishCheck).not.toHaveBeenCalled();
      expect(readRedTeamStatus({ repo, pr, head, env: f.options.env })).toBeNull();
    });
  it.each(['absent', 'incomplete'].flatMap(publication =>
    ['review:human', 'review:changes', 'review:pending', 'unreadable seal', 'formal review', 'unreadable reviews']
      .map(hold => ({ publication, hold }))))(
    '$publication publication cannot spend a full-review retry under $hold', ({ publication, hold }) => {
      const f = fixture(); let seal = null;
      f.options.readSeal = vi.fn(() => seal);
      f.options.readCompleteReviews = vi.fn(() => f.raw.reviews);
      // Begin with a publishable result to reach settlement. Withdraw or truncate it at
      // the failed write so retry authorization must use its full-review guards.
      f.options.syncLabels.mockImplementation(() => {
        if (publication === 'absent') f.raw.comments.pop();
        else f.raw.comments[1] = trusted(redTeamMarker(pr, head));
        // An incomplete result after acceptance is itself an acceptance hold. Remove
        // acceptance so that it cannot mask the specific retry guard under test.
        f.raw.comments.shift();
        if (hold.startsWith('review:')) f.raw.labels.push(hold);
        if (hold === 'unreadable seal') seal = { unreadable: true };
        if (hold === 'formal review') {
          f.raw.reviews = [{ state: 'CHANGES_REQUESTED' }];
        }
        if (hold === 'unreadable reviews') f.raw.reviews = null;
        throw Error('label settlement unavailable');
      });
      const refusal = hold.startsWith('review:') ? 'conflicting label prevents policy-clear'
        : hold === 'unreadable seal' ? 'red-team seal unreadable; not-owed check not published'
          : hold === 'formal review' ? 'formal review hold prevents full review; inspect formal reviews'
            : 'fresh PR evidence unreadable or head changed before settlement; inspect PR evidence';
      const row = runRedTeamOnSkip(f.options).rows[0];
      expect(row).toMatchObject({ action: 'skip', why: `red-team settlement retry held: ${refusal}` });
      expect(f.options.syncLabels).toHaveBeenCalledOnce();
      expect(f.options.readCompleteReviews).toHaveBeenCalledOnce();
      if (hold === 'unreadable seal') expect(f.options.readSeal).toHaveLastReturnedWith({ unreadable: true });
      expect(f.options.dispatch).not.toHaveBeenCalled();
      expect(f.provider.setLabels).not.toHaveBeenCalled();
      expect(f.options.publishCheck).not.toHaveBeenCalled();
      expect(f.options.capacity).toMatchObject({ lanes: 1, budget: { left: 1 } });
      expect(f.options.lastDispatch.has(`${repo}#${pr}@${head}`)).toBe(false);
      expect(row.settlementRetry).toBeUndefined();
      expect(readRedTeamStatus({ repo, pr, head, env: f.options.env })).toBeNull();
    });
  it('an already unreadable seal holds settlement without dispatching a retry', () => {
    const f = fixture(); f.options.readSeal = () => ({ unreadable: true });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('seal unreadable') });
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.provider.setLabels).not.toHaveBeenCalled();
    expect(f.options.escalate).toHaveBeenCalledOnce();
  });
  it.each(['absent', 'finished'])('spends the full-review retry durably before dispatch and across a daemon restart (%s status)', prior => {
    const f = fixture(); f.evidence.ok = false;
    // An incomplete publication still needs the pre-existing bounded full review retry.
    // The acceptance follows the incomplete publication, so it adds no unrelated later hold.
    f.raw.comments = [trusted(redTeamMarker(pr, head)), accept(head)];
    const key = { repo, pr, head, env: f.options.env }, path = sealedStatusPath(key, f.options.env);
    const stored = { repo, pr, head, status: 'finished', loopPayload: f.evidence.loopPayload,
      result: { status: 'ran', findings: [], comment: { status: 'posted' } }, sealedBreaks: [], sealedPosted: [], sentinel: 'preserve' };
    if (prior === 'finished') { mkdirSync(dirname(path), { recursive: true }); writeJsonAtomic(path, stored); }
    f.options.readStatus = args => readRedTeamStatus({ ...args, env: f.options.env });
    f.options.dispatch.mockImplementation(() => {
      expect(readRedTeamStatus(key)).toMatchObject({ retryCount: 1 });
      return { jobPid: 123 };
    });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'review' });
    if (prior === 'finished') expect(readRedTeamStatus(key)).toEqual({ ...stored, retryCount: 1 });
    f.options.lastDispatch = new Map();
    f.options.capacity = { lanes: 1, budget: { left: 1 } };
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip', escalate: true,
      why: expect.stringContaining('retry budget spent') });
    expect(f.options.dispatch).toHaveBeenCalledOnce();
    expect(f.options.escalate).toHaveBeenCalledOnce();
  });
  it('failed durable retry persistence holds without dispatch and escalates to operator inspection', () => {
    const f = fixture();
    f.options.syncLabels.mockImplementation(() => {
      // Withdraw the result only once the label write is reached; retry must then
      // attempt its durable claim rather than stop at the published-result guard.
      f.raw.comments.pop();
      const path = sealedStatusPath({ repo, pr, head }, f.options.env);
      mkdirSync(dirname(dirname(path)), { recursive: true });
      writeFileSync(dirname(path), 'not a directory');
      throw Error('settlement write failed');
    });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip', escalate: true,
      why: expect.stringContaining('settlement retry could not be persisted; inspect stored evidence') });
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).toHaveBeenCalledOnce();
    expect(f.options.capacity).toMatchObject({ lanes: 1, budget: { left: 1 } });
  });
  it('a head moving during settlement changes no labels or checks and starts no job', () => {
    const f = fixture();
    f.provider.readPrState.mockImplementation(() => ({ ...f.raw, headRefOid: old }));
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.publishCarriedCheck).not.toHaveBeenCalled();
    expect(f.options.dispatch).not.toHaveBeenCalled(); expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('a head moving at the final label write changes nothing', () => {
    const f = fixture(); let reads = 0;
    f.provider.readPrState.mockImplementation(() => ({ ...f.raw, headRefOid: ++reads >= 4 ? old : head }));
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.dispatch).not.toHaveBeenCalled();
  });
  it('a seal becoming unreadable at the final label write holds without dispatch', () => {
    const f = fixture(); let reads = 0;
    f.options.readSeal = () => ++reads === 1 ? null : { unreadable: true };
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'skip',
      why: 'settled red-team outcome needs operator inspection: result evidence changed before label settlement' });
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).toHaveBeenCalledOnce();
  });
  it('a net patch changing between planning and settlement re-runs without carrying', () => {
    const f = fixture(); f.raw.comments = [accept(old), result(old)];
    f.evidence.loopPayload.findings.read.netBasis.rev = old;
    let patches = 0;
    f.options.exec.mockImplementation((_file, args) => args[0] === 'merge-base' ? `${base}\n`
      : args[0] === 'patch-id' ? `${base} ${old}\n` : ++patches > 2 ? `${patch}+changed\n${patches}\n` : patch);
    runRedTeamOnSkip(f.options);
    expect(runGhSync).not.toHaveBeenCalled(); expect(f.provider.setLabels).not.toHaveBeenCalled();
    expect(f.options.dispatch).toHaveBeenCalledOnce(); expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('a persisted spent retry escalates unreadable evidence without launching another job', () => {
    const f = fixture(); f.options.readSeal = () => ({ unreadable: true });
    f.options.readStatus = () => ({ head, retryCount: 1 });
    const row = runRedTeamOnSkip(f.options).rows[0];
    expect(row).toMatchObject({ action: 'skip', escalate: true, why: expect.stringContaining('settled red-team outcome') });
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).toHaveBeenCalledOnce();
  });
});

describe('bounded net-diff proof', () => {
  it('refuses carry for different binary payloads and requires --binary when generating both net patches', () => {
    const root = mkdtempSync(join(tmpdir(), 'red-team-binary-patches-')); roots.push(root);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global-gitconfig'),
      GIT_AUTHOR_NAME: 'Binary fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Binary fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2026-11-10T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-10T12:00:00Z' };
    const git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'core.hooksPath', 'no-hooks']);
    const commitBinary = payload => {
      writeFileSync(join(root, 'asset.bin'), Buffer.from(payload));
      git(['add', '--', 'asset.bin']);
      git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Binary fixture']);
      return git(['rev-parse', 'HEAD']).trim();
    };
    const mainRef = commitBinary([0, 0, 0, 0, 0, 0]);
    const fromSha = commitBinary([0, 1, 2, 3, 4, 5]);
    git(['checkout', '--quiet', '--detach', mainRef]);
    const toSha = commitBinary([0, 5, 4, 3, 2, 1]);
    const patches = [];
    const exec = vi.fn((file, args, options) => {
      const output = execFileSync(file, args, { ...options, env });
      if (args[0] === 'diff') patches.push(output);
      return output;
    });

    expect(proveEquivalentRedTeamDiff({ fromSha, toSha, mainRef, cwd: root, exec })).toEqual({ ok: false });
    // Keep these outside the injected executor: the proof catches executor errors and fails closed.
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'diff').map(([, args]) => args)).toEqual([
      expect.arrayContaining(['--binary', `${mainRef}..${fromSha}`]),
      expect.arrayContaining(['--binary', `${mainRef}..${toSha}`]),
    ]);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toContain('GIT binary patch');
    expect(patches[1]).toContain('GIT binary patch');
    expect(patches[0].slice(patches[0].indexOf('GIT binary patch')))
      .not.toBe(patches[1].slice(patches[1].indexOf('GIT binary patch')));
  });

  it('never carries empty patches; empty-net-diff settlement keeps its separate positive-proof rules', () => {
    const exec = vi.fn((_file, args) => args[0] === 'merge-base' ? `${base}\n` : '');
    expect(proveEquivalentRedTeamDiff({ fromSha: old, toSha: head, exec })).toEqual({ ok: false });
  });
});
