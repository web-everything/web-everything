/** Pure decisions, including closed paths and idempotency. */
import { describe, it, expect } from 'vitest';
import { decideActions, actionKey } from '../assistant-babysit-actions.mjs';

const snapshot = { repo: 'org/repo', number: 2, headSha: 'abc', nowMs: 120 * 60000,
  isDraft: false, labels: ['review:changes'], mergeable: 'MERGEABLE', claims: [] };
const report = { rule: 'no-worker', reason: 'owed work without a live worker' };
const ctx = { minutes: 20, why: { fixLogLine: 'fix: skipped at cap' } };
const decide = (patch = {}, context = ctx, r = report) => decideActions({ ...snapshot, ...patch }, r, context);

describe('shadow action decisions', () => {
  it('rearms refused fix work with the exact display argv', () => {
    expect(decide().actions).toEqual([{ type: 'rearm', repo: 'org/repo', pr: 2, head: 'abc',
      argv: ['node', 'scripts/operations/run.mjs', 'rearm', '--pr=2', '--repo=org/repo'], reason: 'fix work refused or skipped' }]);
    expect(decide().escalations).toEqual([]);
  });
  it.each(['review:changes', 'red-team:blocked', 'status:sent-back-review', 'status:sent-back-red-team'])('rearms owed %s from suggestedOp', (label) => {
    expect(decide({ labels: [label] }, { minutes: 20, why: { suggestedOp: 'run rearm' } }).actions[0].type).toBe('rearm');
  });
  it.each([
    [{}, { ...ctx, minutes: 19.99 }], [{}, { ...ctx, minutes: null }], [{}, { minutes: 20, why: {} }],
    [{ labels: ['status:ci-red'], ciFailing: true }, ctx],
    [{ claims: [{ kind: 'fixing', claimedAtMs: 0, heartbeatAtMs: snapshot.nowMs, ttlMinutes: 10 }] }, ctx],
  ])('does not rearm without qualifying evidence %j', (patch, context) => expect(decide(patch, context).actions).toEqual([]));
  it('expired fixer and live ci-heal do not count as a live fixer', () => {
    for (const claim of [{ kind: 'fix', claimedAtMs: 0, heartbeatAtMs: 0, ttlMinutes: 10 },
      { kind: 'ci-heal', claimedAtMs: 0, heartbeatAtMs: snapshot.nowMs, ttlMinutes: 10 }]) {
      expect(decide({ claims: [claim] }).actions[0].type).toBe('rearm');
    }
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
  it.each(['set', 'object'])('dedupes by repo, PR, head and type with %s without mutation or escalation', (kind) => {
    const action = decide().actions[0];
    const key = actionKey(action);
    expect(key).toBe('org/repo#2@abc:rearm');
    const context = { ...ctx, done: kind === 'set' ? new Set([key]) : { [key]: 1 } };
    const before = structuredClone(context);
    const source = structuredClone(snapshot);
    expect(decideActions(source, report, context)).toEqual({ actions: [], escalations: [] });
    expect(context).toEqual(before);
    expect(source).toEqual(snapshot);
    expect(decide({ headSha: 'def' }, context).actions).toHaveLength(1);
  });
});
