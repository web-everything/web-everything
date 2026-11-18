/** Pure decisions, including closed paths and idempotency. */
import { describe, it, expect } from 'vitest';
import { decideActions, actionKey } from '../assistant-babysit-actions.mjs';

const snapshot = { repo: 'org/repo', number: 2, headSha: 'abc', nowMs: 120 * 60000,
  isDraft: false, labels: ['review:changes'], mergeable: 'MERGEABLE', claims: [] };
const report = { rule: 'no-worker', reason: 'owed work without a live worker' };
const ctx = { minutes: 20, why: { owner: 'fix daemon', fixLogLine: 'fix: skipped at cap' } };
const decide = (patch = {}, context = ctx, r = report) => decideActions({ ...snapshot, ...patch }, r, context);

describe('shadow action decisions', () => {
  it('rearms refused fix work with the exact display argv', () => {
    expect(decide().actions).toEqual([{ type: 'rearm', repo: 'org/repo', pr: 2, head: 'abc',
      argv: ['node', 'scripts/operations/run.mjs', 'rearm', '--pr=2', '--repo=org/repo'], reason: 'fix work refused or skipped' }]);
    expect(decide().escalations).toEqual([]);
  });
  it.each(['review:changes', 'red-team:blocked', 'status:sent-back-review', 'status:sent-back-red-team'])('rearms owed %s from waitingFor', (label) => {
    expect(decide({ labels: [label] }, { minutes: 20, why: { owner: 'fix daemon', waitingFor: 'refused at cap' } }).actions[0].type).toBe('rearm');
  });
  it.each([
    [{}, { ...ctx, minutes: 19.99 }], [{}, { ...ctx, minutes: null }], [{}, { minutes: 20, why: {} }],
    [{ labels: ['status:ci-red'], ciFailing: true }, ctx],
    [{ claims: [{ kind: 'fixing', claimedAtMs: 0, heartbeatAtMs: snapshot.nowMs, ttlMinutes: 10 }] }, ctx],
  ])('does not rearm without qualifying evidence %j', (patch, context) => expect(decide(patch, context).actions).toEqual([]));
  it.each([['expired fixer', 'fix', 0, true], ['live ci-heal', 'ci-heal', snapshot.nowMs, false]])('%s rearm => %s', (_, kind, heartbeatAtMs, allowed) => {
    expect(decide({ claims: [{ kind, claimedAtMs: 0, heartbeatAtMs, ttlMinutes: 10 }] }).actions.some((a) => a.type === 'rearm')).toBe(allowed);
  });
  it.each(['main is red', 'failing on main', 'behind main'])('updates a branch for %s', (fixLogLine) => {
    const result = decide({ ciFailing: true }, { why: { fixLogLine } });
    expect(result.actions[0]).toMatchObject({ type: 'update-branch', argv: ['gh', 'api', '-X', 'PUT', 'repos/org/repo/pulls/2/update-branch'] });
  });
  it('updates BEHIND without CI failure, but never a conflicting branch', () => {
    expect(decide({ mergeStateStatus: 'BEHIND' }, {}).actions[0].type).toBe('update-branch');
    expect(decide({ mergeStateStatus: 'BEHIND', mergeable: 'CONFLICTING' }, {}).actions).toEqual([]);
    expect(decide({ mergeStateStatus: 'CLEAN' }, {}).actions).toEqual([]);
    expect(decide({}, { why: { fixLogLine: 'behind main' } }).actions).toEqual([]);
  });
  it('reruns only the first distinct infra run with exact argv', () => {
    const failedChecks = ['TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].map((conclusion, i) => ({ conclusion, runId: i < 2 ? '42' : '43' }));
    expect(decide({ ciFailing: true, failedChecks }, {}).actions).toEqual([expect.objectContaining({ type: 'rerun-failed',
      argv: ['gh', 'run', 'rerun', '42', '--failed', '--repo=org/repo'] })]);
  });
  it.each([undefined, [], [{ conclusion: 'FAILURE', runId: '42' }], [{ conclusion: 'ERROR', runId: '42' }],
    [{ conclusion: 'TIMED_OUT', runId: null }], [{ conclusion: 'UNKNOWN', runId: '42' }],
    [{ conclusion: 'CANCELLED', runId: '42' }, { conclusion: 'FAILURE', runId: '43' }]])('fails closed on incomplete or noninfra checks %j', (failedChecks) => {
    expect(decide({ ciFailing: true, failedChecks }, {}).actions).toEqual([]);
  });
  it.each([{ isDraft: true }, ...['review:human', 'status:stood-down', 'review-status:stood-down'].map((label) => ({ labels: ['review:changes', label] }))])('blocks all actions for %j', (patch) => {
    expect(decide({ ciFailing: true, mergeStateStatus: 'BEHIND', failedChecks: [{ conclusion: 'TIMED_OUT', runId: '42' }], ...patch }).actions).toEqual([]);
  });
  it.each(['no-worker', 'human-wait', 'gate-red-stalled', 'stale-claim'])('escalates unhandled %s with exact log evidence', (rule) => {
    const fixLogLine = 'fix: waiting | exact\nline';
    expect(decide({}, { why: { fixLogLine } }, { rule, reason: 'waiting' }).escalations).toEqual([
      { type: 'escalate', repo: 'org/repo', pr: 2, head: 'abc', reason: 'waiting', logLine: fixLogLine },
    ]);
  });
  it('uses an empty missing log and does not escalate unrelated reports', () => {
    expect(decide({}, {}).escalations[0].logLine).toBe('');
    expect(decide({}, {}, { rule: 'contradiction' }).escalations).toEqual([]);
  });
  it.each(['set', 'object'])('dedupes by repo, PR, head and type with %s without mutation while escalating persistence', (kind) => {
    const action = decide().actions[0];
    const key = actionKey(action);
    expect(key).toBe('org/repo#2@abc:rearm');
    const context = { ...ctx, done: kind === 'set' ? new Set([key]) : { [key]: 1 } };
    const before = structuredClone(context);
    const source = structuredClone(snapshot);
    expect(decideActions(source, report, context)).toEqual({ actions: [], escalations: [expect.objectContaining({ reason: 'action already recorded for this head; condition persists', logLine: ctx.why.fixLogLine })] });
    expect(context).toEqual(before);
    expect(source).toEqual(snapshot);
    expect(decide({ headSha: 'def' }, context).actions).toHaveLength(1);
  });
});


describe('live owner and sticky decisions', () => {
  it.each([
    ['plain refusal', 'fix daemon', 'fix: refused at cap', '', true],
    ['serializing refusal', 'fix daemon', 'fix: refused, serializing work', '', false],
    ['session owner', 'fix daemon (session)', 'fix: refused', '', false],
    ['operator', 'operator', 'fix: refused', '', false],
    ['missing owner', undefined, 'fix: refused', '', false],
    ['suggested op only', 'fix daemon', 'fix: idle', '', false],
    ['waiting refusal', 'fix daemon', 'fix: idle', 'skipped at cap', true],
    ...['scope-overlap', 'priority-shadow', 'waiting 2', 'retrying next pass', 'in progress', 'queued', 'take-over', 'takeover']
      .map((text) => [text, 'fix daemon', 'fix: refused at cap', text, false]),
  ])('%s rearm => %s with exact escalation evidence', (_, owner, fixLogLine, waitingFor, allowed) => {
    const result = decide({}, { minutes: 20, why: { owner, fixLogLine, waitingFor, suggestedOp: 'rearm' } });
    expect(result.actions.some((a) => a.type === 'rearm')).toBe(allowed);
    if (!allowed) expect(result.escalations[0].logLine).toBe(fixLogLine);
  });
  it.each(['MERGEABLE', 'CONFLICTING'])('sticky %s updates or escalates conflict', (mergeable) => {
    const result = decide({ mergeable, labels: ['status:ci-red'], conflictFiles: ['shared.mjs'] }, {}, { rule: 'sticky-label' });
    if (mergeable === 'CONFLICTING') {
      expect(result.actions).toEqual([]);
      expect(result.escalations).toEqual([expect.objectContaining({ type: 'escalate', reason: 'conflict: branch cannot be updated automatically', files: ['shared.mjs'], logLine: '' })]);
    } else {
      expect(result.actions).toEqual([expect.objectContaining({ type: 'update-branch', argv: ['gh', 'api', '-X', 'PUT', 'repos/org/repo/pulls/2/update-branch'], reason: 'a new head clears per-head escalations' })]);
      expect(actionKey(result.actions[0])).toBe('org/repo#2@abc:update-branch');
    }
  });
});
