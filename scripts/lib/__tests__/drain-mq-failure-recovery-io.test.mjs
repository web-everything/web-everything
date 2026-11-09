import { describe, expect, it, vi } from 'vitest';
import { createDrainMqFailureRecoveryIo, routeMqFailureOnHold } from '../drain-mq-failure-recovery-io.mjs';
import { createMqFailureLedger } from '../mq-failure-ledger.mjs';
import { parseMqFailureRoute } from '../mq-failure-route.mjs';
import { admitMqFailureRoute } from '../../conveyor/mq-failure-intake.mjs';

const identity = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
const mergeHead = 'b'.repeat(40);
const branch = `gh-readonly-queue/main/pr-${identity.pr}-${'c'.repeat(40)}`;
const guard = { hold: true, line: `mq-same-head-failed: #42 head ${identity.head} — failed_checks` };
const failureLog = 'FAIL tests/widget.test.mjs > keeps state\nAssertionError: expected true';
function fixture(mode = 'real') {
  let state = {};
  const ledger = createMqFailureLedger({ io: { atomicUpdate(update) {
    const next = update(structuredClone(state)); state = structuredClone(next.state); return next.result;
  } } });
  const event = { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
    createdAt: '2026-11-08T10:00:00Z', beforeCommit: { oid: mergeHead,
      parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: identity.head }] } } };
  if (mode === 'wrong parent') event.beforeCommit.parents.nodes[1].oid = 'd'.repeat(40);
  if (mode === 'wrong reason') event.reason = 'manual';
  if (mode === 'missing merge commit') delete event.beforeCommit.oid;
  const events = [event];
  if (mode === 'unknown event') events.push({ __typename: 'FutureMergeQueueEvent', createdAt: '2026-11-08T10:01:00Z' });
  if (mode === 'unknown reason') events.push({ ...structuredClone(event), reason: 'future_removal_reason', createdAt: '2026-11-08T10:01:00Z' });
  if (mode === 'repeated matching removal') events.push({ ...structuredClone(event), createdAt: '2026-11-08T10:01:00Z' });
  if (mode === 'retry exhausted') events.push({ __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-08T10:01:00Z' });
  if (mode === 'oversized timeline') events.push(...Array.from({ length: 100 }, () => ({ __typename: 'AddedToMergeQueueEvent' })));
  const exec = vi.fn((file, args, options) => {
    expect(file).toBe('gh');
    if (mode === 'unreadable') throw new Error('unreadable remote');
    if (args.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: {
      timelineItems: { nodes: events, pageInfo: { hasPreviousPage: mode === 'incomplete timeline' } },
    } } } });
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: mode === 'stale head' ? 'd'.repeat(40) : identity.head,
      mergeStateStatus: mode === 'conflict' ? 'DIRTY' : 'CLEAN', baseRefName: 'main',
      labels: mode === 'unknown labels' ? null : [] });
    const endpoint = args.find(arg => arg.startsWith(`repos/${identity.repo}/`));
    if (args[0] === 'pr' && args[1] === 'comment') { expect(typeof options.input).toBe('string'); return ''; }
    if (args.includes('POST')) {
      const payload = JSON.parse(options.input);
      if (endpoint.endsWith('/labels')) { expect(payload.labels).toEqual(['mq-failure-recovery']); return '[]'; }
    }
    if (endpoint?.includes('/compare/')) {
      if (mode === 'ancestor lookup throws') throw new Error('compare unavailable');
      return JSON.stringify(mode === 'non-ancestor' ? { status: 'diverged', behind_by: 1 }
        : mode === 'ancestor unknown' ? {} : mode === 'ancestor behind' ? { status: 'ahead', behind_by: 1 }
        : { status: mode === 'identical ancestor' ? 'identical' : 'ahead', behind_by: 0 });
    }
    if (endpoint?.includes('/actions/runs?')) return JSON.stringify({ total_count: mode === 'oversized runs' ? 1001 : 1,
      workflow_runs: [{ id: 701, event: 'merge_group', head_sha: mode === 'wrong run commit' ? 'd'.repeat(40) : mergeHead,
        head_branch: branch, conclusion: 'failure' }] });
    if (endpoint?.includes('/actions/runs/701/jobs?')) {
      const sibling = mode === 'cancelled sibling' ? 'cancelled' : mode === 'timed out sibling' ? 'timed_out' : null;
      return JSON.stringify({ total_count: sibling ? 2 : 1, jobs: [{ id: 901, name: 'unit', status: 'completed', conclusion: 'failure' },
        ...(sibling ? [{ id: 902, name: 'e2e', status: 'completed', conclusion: sibling }] : [])] });
    }
    if (endpoint?.endsWith('/actions/jobs/901/logs')) {
      if (mode === 'expired log') throw new Error('410 expired');
      return mode === 'infra' ? 'The runner has lost communication with the server.'
        : mode === 'incomplete test paths' ? `${failureLog}\nFAIL unidentified failing test\nAssertionError: expected false`
        : mode === 'oversized log' ? failureLog + 'x'.repeat(300000) : failureLog;
    }
    throw new Error('Unexpected request');
  });
  const io = createDrainMqFailureRecoveryIo({ exec, ledger });
  const log = vi.fn();
  const options = { ...identity, guard, dryRun: false, log, io };
  return { options, exec, log, writes: () => exec.mock.calls.filter(([, args]) => args.includes('POST') || (args[0] === 'pr' && args[1] === 'comment')) };
}

describe('drain MQ failure production adapter', () => {
  it('real failure derives the timeline removal and emits comment plus label once per head', async () => {
    const f = fixture();
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: true, reason: expect.any(String) });
    const writes = f.writes();
    expect(writes).toHaveLength(2);
    const comment = writes.find(([, args]) => args[0] === 'pr' && args[1] === 'comment');
    const body = comment[2].input;
    expect(parseMqFailureRoute({ comment: { body, author: { login: 'chalbert' } }, expected: identity }))
      .toMatchObject({ ...identity, failedJobs: ['unit'], testFiles: ['tests/widget.test.mjs'], complete: true, stale: false });
    const runCall = f.exec.mock.calls.find(([, args]) => args.some(arg => arg.includes('/actions/runs?')));
    expect(runCall[1].join(' ')).toContain(`head_sha=${mergeHead}`);
    expect(runCall[1].join(' ')).not.toContain('branch=');
    expect(f.exec.mock.calls.some(([, args]) => args.includes(`repos/${identity.repo}/compare/${identity.head}...${mergeHead}`))).toBe(true);
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: false, reason: expect.stringMatching(/already/i) });
    expect(f.writes()).toHaveLength(2);
    expect(f.exec.mock.calls.every(([, , opts]) => Number.isFinite(opts.timeout) && Number.isFinite(opts.maxBuffer))).toBe(true);
  });

  it.each(['infra', 'unreadable', 'wrong parent', 'wrong reason', 'missing merge commit', 'wrong run commit',
    'incomplete timeline', 'oversized timeline', 'retry exhausted', 'stale head', 'conflict',
    'unknown labels', 'expired log', 'oversized log', 'oversized runs'])('retains the hold without writes for %s', async mode => {
    const f = fixture(mode);
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: false, reason: expect.any(String) });
    expect(f.writes()).toEqual([]);
  });

  it.each(['unknown event', 'unknown reason', 'repeated matching removal'])(
    'excludes ineligible timeline history without publication: %s', async mode => {
      const f = fixture(mode);
      expect(await routeMqFailureOnHold(f.options)).toMatchObject({
        routed: false, reason: expect.stringMatching(/operator inspection required/i),
      });
      expect(f.writes()).toEqual([]);
      // These exclusions must win before any Actions evidence read or publication is attempted.
      expect(f.exec.mock.calls.some(([, args]) => args.some(arg => arg.includes('/actions/')))).toBe(false);
    });

  it('dryRun performs no reads, claims or writes and leaves a later real attempt eligible', async () => {
    const f = fixture();
    expect(await routeMqFailureOnHold({ ...f.options, dryRun: true })).toMatchObject({ routed: false, reason: expect.stringMatching(/dry.run/i) });
    expect(f.exec).not.toHaveBeenCalled();
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: true });
  });

  it.each([null, { hold: false, line: guard.line }, { hold: true, line: `quoted\n${guard.line}` },
    { hold: true, line: 'mq-same-head-retry: failed_checks' }])('does not read evidence without the precise held guard: %j', async badGuard => {
    const f = fixture();
    expect(await routeMqFailureOnHold({ ...f.options, guard: badGuard })).toMatchObject({ routed: false });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('throwing IO and throwing log callbacks never escape the best-effort boundary', async () => {
    const f = fixture();
    const result = await routeMqFailureOnHold({ ...f.options,
      io: { forRoute() { throw new Error('broken IO'); } }, log() { throw new Error('broken logger'); } });
    expect(result).toMatchObject({ routed: false, reason: expect.stringMatching(/operator|unreadable|unavailable/i) });
    expect(f.writes()).toEqual([]);
  });

  it('the shared call bound retains the hold with an operator-visible reason', async () => {
    const f = fixture();
    const io = createDrainMqFailureRecoveryIo({ exec: f.exec, maxCalls: 2 });
    expect(await routeMqFailureOnHold({ ...f.options, io })).toMatchObject({ routed: false, reason: expect.stringMatching(/operator|evidence|unreadable/i) });
    expect(f.exec.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.writes()).toEqual([]);
  });
});


describe('drain proven real failure routing', () => {
  it('proven real failure with incomplete paths publishes evidence for the normal fixer', async () => {
    const f = fixture('incomplete test paths');
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: true });
    expect(f.writes()).toHaveLength(2);
    const comment = f.writes().find(([, args]) => args[0] === 'pr' && args[1] === 'comment');
    const route = parseMqFailureRoute({ expected: identity, comment: {
      body: comment[2].input, author: { login: 'chalbert' },
    } });
    expect(route).toMatchObject({ ...identity, complete: false, failureProven: true, failedJobs: ['unit'],
      testFiles: ['tests/widget.test.mjs'], assertions: expect.arrayContaining(['FAIL unidentified failing test', 'AssertionError: expected false']) });
    expect(admitMqFailureRoute({ ...identity, route,
      changedFiles: { ...identity, complete: true, files: ['src/unrelated.mjs'] } }))
      .toMatchObject({ kind: 'fix', recoveryAction: 'fix', evidence: { complete: false, failedJobs: ['unit'] } });
  });
});


describe('drain sibling job conclusions', () => {
  it('a cancelled sibling (fail-fast) does not block routing the fully read failed job', async () => {
    const f = fixture('cancelled sibling');
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: true });
    expect(f.writes()).toHaveLength(2);
    // Only the failed job's log is read; the cancelled sibling contributes nothing.
    expect(f.exec.mock.calls.some(([, args]) => args.some(arg => String(arg).endsWith('/actions/jobs/902/logs')))).toBe(false);
  });
  it('a timed_out sibling stays incomplete: the collector would skip it, so it can never be proven away', async () => {
    const f = fixture('timed out sibling');
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: false });
    expect(f.writes()).toEqual([]);
  });
});

describe('drain production ancestry proof', () => {
  it.each(['real', 'identical ancestor'])('base-SHA branch routes only with positive compare proof: %s', async mode => {
    const f = fixture(mode);
    expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: true });
    expect(f.writes()).toHaveLength(2);
    expect(f.exec.mock.calls.some(([, args]) => args.includes(`repos/${identity.repo}/compare/${identity.head}...${mergeHead}`))).toBe(true);
  });
  it.each(['non-ancestor', 'ancestor lookup throws', 'ancestor unknown', 'ancestor behind'])(
    'unverified compare evidence cannot publish a route: %s', async mode => {
      const f = fixture(mode);
      expect(await routeMqFailureOnHold(f.options)).toMatchObject({ routed: false });
      expect(f.writes()).toEqual([]);
    });
});
