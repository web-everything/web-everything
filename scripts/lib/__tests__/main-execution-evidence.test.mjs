// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readMainExecutionEvidence, readDrainQueueSafety } from '../drain-queue-safety.mjs';

const sha = 'd'.repeat(40), now = Date.parse('2026-11-01T14:00:00Z');
const maxAgeMs = 7_200_000;
const push = { id: 102, event: 'push', head_sha: sha, conclusion: 'success',
  created_at: '2026-11-01T13:50:00Z', updated_at: '2026-11-01T13:55:00Z' };
const queue = { id: 90, event: 'merge_group', path: '.github/workflows/ci.yml', head_sha: sha,
  head_branch: 'gh-readonly-queue/main/pr-1', status: 'completed', conclusion: 'success',
  created_at: '2026-11-01T11:55:00Z', updated_at: '2026-11-01T12:00:00Z' };
const page = (key, rows) => ({ total_count: rows.length, [key]: rows });
function fixture() {
  const replies = {
    'actions/runs/102/jobs?filter=latest&per_page=100': page('jobs', [{ name: 'test-shard (1)', status: 'completed', conclusion: 'skipped' }]),
    [`actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=100`]: page('workflow_runs', [{ ...queue }]),
    'actions/runs/90/jobs?filter=latest&per_page=100': page('jobs', [{ name: 'test-shard (1)', status: 'completed', conclusion: 'success' }]),
  };
  const readJson = vi.fn(endpoint => {
    if (!(endpoint in replies)) throw Error('unreadable evidence');
    return replies[endpoint];
  });
  return { replies, readJson, read: (overrides = {}) => readMainExecutionEvidence({ run: push, readJson, now, maxAgeMs, ...overrides }) };
}

describe('light push main execution evidence', () => {
  it('uses the queue run id and both queue timestamps at the age boundary', () => {
    const f = fixture();
    expect(f.read()).toEqual({ ...queue, reusedQueue: true });
    expect(f.readJson).toHaveBeenCalledTimes(3);
  });
  it('honors a configured shorter age limit', () => {
    expect(() => fixture().read({ maxAgeMs: maxAgeMs - 1 })).toThrow(/stale/);
  });
  it('does not let a light push renew an old queue run', () => {
    expect(() => fixture().read({ now: now + 1 })).toThrow(/fresh main CI or inspect manually/);
  });
  it.each(['unreadable jobs', 'oversized jobs', 'truncated jobs', 'unreadable queue', 'oversized queue',
    'no queue', 'queue failed', 'queue unfinished', 'wrong workflow', 'wrong SHA', 'wrong event',
    'wrong branch', 'missing timestamp', 'future timestamp', 'queue skipped tests'])(
    'fails closed on %s', kind => {
      const f = fixture();
      const jobsKey = 'actions/runs/102/jobs?filter=latest&per_page=100';
      const queueKey = `actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=100`;
      const q = f.replies[queueKey].workflow_runs[0];
      if (kind === 'unreadable jobs') delete f.replies[jobsKey];
      if (kind === 'oversized jobs') f.replies[jobsKey].total_count = 501;
      if (kind === 'truncated jobs') f.replies[jobsKey].total_count = 2;
      if (kind === 'unreadable queue') delete f.replies[queueKey];
      if (kind === 'oversized queue') f.replies[queueKey].total_count = 101;
      if (kind === 'no queue') f.replies[queueKey] = page('workflow_runs', []);
      if (kind === 'queue failed') q.conclusion = 'failure';
      if (kind === 'queue unfinished') { q.status = 'in_progress'; q.conclusion = null; }
      if (kind === 'wrong workflow') q.path = 'other.yml';
      if (kind === 'wrong SHA') q.head_sha = 'e'.repeat(40);
      if (kind === 'wrong event') q.event = 'pull_request';
      if (kind === 'wrong branch') q.head_branch = 'main';
      if (kind === 'missing timestamp') delete q.updated_at;
      if (kind === 'future timestamp') q.updated_at = '2026-11-01T14:00:01Z';
      if (kind === 'queue skipped tests') f.replies['actions/runs/90/jobs?filter=latest&per_page=100'].jobs[0].conclusion = 'skipped';
      expect(() => f.read()).toThrow();
    });
  it('permits reuse beyond two hours when the resolved setting allows it', () => {
    expect(fixture().read({ now: now + 1, maxAgeMs: maxAgeMs + 1 })).toEqual({ ...queue, reusedQueue: true });
  });
  it('retains timestamps for a push that actually executed tests', () => {
    const f = fixture();
    f.replies['actions/runs/102/jobs?filter=latest&per_page=100'].jobs[0].conclusion = 'success';
    expect(f.read()).toBe(push);
    expect(f.readJson).toHaveBeenCalledTimes(1);
  });
});

describe('reused main-green age policy', () => {
  it.each([
    ['standard', {}, {}, {}, maxAgeMs],
    ['platform', {}, {}, { mqReusedMainGreenMaxAgeMs: 1000 }, 1000],
    ['tool', {}, { mqReusedMainGreenMaxAgeMs: 2000 }, { mqReusedMainGreenMaxAgeMs: 1000 }, 2000],
    ['env', { WE_DRAIN_MQ_REUSED_MAIN_GREEN_MAX_AGE_MS: '3000' }, { mqReusedMainGreenMaxAgeMs: 2000 }, {}, 3000],
  ])('resolves and logs %s provenance', (source, env, tool, platform, value) => {
    const log = vi.fn();
    expect(readDrainQueueSafety({ env, tool, platform, log })).toMatchObject({
      value: { mqReusedMainGreenMaxAgeMs: value }, sources: { mqReusedMainGreenMaxAgeMs: source } });
    expect(log.mock.calls.flat().join('\n')).toContain(`mqReusedMainGreenMaxAgeMs=${value} (${source})`);
  });
  it.each([0, -1, NaN, Infinity, 'bad'])('rejects invalid age %s and retains the standard bound', value => {
    expect(readDrainQueueSafety({ env: {}, tool: { mqReusedMainGreenMaxAgeMs: value }, platform: {} })).toMatchObject({
      value: { mqReusedMainGreenMaxAgeMs: maxAgeMs }, sources: { mqReusedMainGreenMaxAgeMs: 'standard' } });
  });
});
