// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const recorded = JSON.parse(readFileSync(new URL('./fixtures/main-push-runs.json', import.meta.url)));
const sha = 'a'.repeat(40), fui = 'b'.repeat(40);
const input = () => ({ sha, before: 'c'.repeat(40), event: 'push', ref: 'refs/heads/main', currentRunId: 101,
  now: Date.parse('2026-11-20T12:00:00Z'), env: {}, platform: {}, log: () => {}, runs: structuredClone(recorded), queueFuiSha: fui, fuiTip: fui, beforeIsAncestor: true });
const decide = async value => (await import('../main-push-skip.mjs')).decideMainPushSkip(value);
describe('exact-SHA main push reuse', () => {
  it.each([undefined, null, '', 'invalid', '2026-11-20T09:59:59Z', '2026-11-20T12:00:01Z'])(
    'runs full for old, unknown or future queue attempt start %s', async stamp => {
      const x = input(); x.runs.workflow_runs[0].run_started_at = stamp;
      expect(await decide(x)).toMatchObject({ skip: false, reason: expect.stringContaining('full CI') });
    });
  it('uses queue attempt start rather than creation or the current push time', async () => {
    const x = input(); x.runs.workflow_runs[0].created_at = '2020-01-01T00:00:00Z';
    expect((await decide(x)).skip).toBe(true);
    x.runs.workflow_runs[0].run_started_at = '2026-11-20T09:00:00Z';
    x.runs.workflow_runs[1].run_started_at = '2026-11-20T12:00:00Z';
    expect((await decide(x)).skip).toBe(false);
  });
  it('allows the two-hour boundary but an environment limit can shorten it', async () => {
    const x = input(); x.runs.workflow_runs[0].run_started_at = '2026-11-20T10:00:00Z';
    expect((await decide(x)).skip).toBe(true);
    x.env.WE_CI_MAIN_PUSH_SKIP_MAX_AGE_MS = '3600000';
    expect((await decide(x)).skip).toBe(false);
  });
  it.each(['7200001', '999999999', 'invalid', '', '0', '-1', 'Infinity', '1.5'])(
    'rejects invalid or oversized age limit %j and retains two hours', async setting => {
      const x = input(); x.env.WE_CI_MAIN_PUSH_SKIP_MAX_AGE_MS = setting;
      expect((await decide(x)).skip).toBe(true);
      x.runs.workflow_runs[0].run_started_at = '2026-11-20T09:59:59Z';
      expect((await decide(x)).skip).toBe(false);
    });
  it('applies a shorten-only platform setting', async () => {
    const x = input(); x.platform = { maxAgeMs: 1 };
    expect((await decide(x)).skip).toBe(false);
    x.platform.maxAgeMs = 7200001;
    expect((await decide(x)).skip).toBe(true);
  });
  it('skips a proven queue SHA and names its run id', async () => {
    expect(await decide(input())).toMatchObject({ skip: true, reason: expect.stringContaining('100') });
  });
  it.each([
    ['direct push', x => { x.runs.workflow_runs.shift(); x.runs.total_count--; }],
    ['failure after success', x => x.runs.workflow_runs.push({ ...x.runs.workflow_runs[0], id: 102, conclusion: 'failure' }) && x.runs.total_count++],
    ['newer queued run', x => x.runs.workflow_runs.push({ ...x.runs.workflow_runs[1], id: 102 }) && x.runs.total_count++],
    ['newer non-queue success from another producer', x => x.runs.workflow_runs.push({ ...x.runs.workflow_runs[0], id: 102, event: 'workflow_dispatch', head_branch: 'main', check_suite: { app: { id: 42 } } }) && x.runs.total_count++],
    ['unreadable check suite', x => { delete x.runs.workflow_runs[0].check_suite; }],
    ['wrong workflow', x => { x.runs.workflow_runs[0].path = '.github/workflows/other.yml'; }],
    ['moved FUI tip', x => { x.fuiTip = 'd'.repeat(40); }],
    ['missing FUI tip', x => { x.fuiTip = undefined; }],
    ['unreadable FUI tip', x => { x.fuiTip = 'bad'; }],
    ['unreadable FUI record', x => { x.queueFuiSha = 'bad'; }],
    ['missing FUI record', x => { x.queueFuiSha = null; }],
    ['ambiguous FUI record', x => { x.queueFuiSha = [fui, fui]; }],
    ['truncated run data', x => { x.runs.total_count++; }],
    ['API error', x => { x.runs = null; }],
    ['malformed SHA', x => { x.sha = 'abc'; }],
    ['malformed before', x => { x.before = '0'.repeat(40); }],
    ['non-ancestor before', x => { x.beforeIsAncestor = false; }],
    ['unknown ancestry', x => { x.beforeIsAncestor = null; }],
    ['same tree but different SHA', x => { x.runs.workflow_runs[0].head_sha = 'd'.repeat(40); x.runs.workflow_runs[0].tree = sha; }],
    ['wrong queue branch', x => { x.runs.workflow_runs[0].head_branch = 'gh-readonly-queue/other/pr-1'; }],
    ['schedule', x => { x.event = 'schedule'; }],
    ['dispatch', x => { x.event = 'workflow_dispatch'; }],
    ['wrong ref', x => { x.ref = 'refs/heads/other'; }],
    ['oversized evidence', x => { x.runs.total_count = 1001; }],
  ])('runs full on %s', async (_, mutate) => {
    const x = input(); mutate(x); expect(await decide(x)).toMatchObject({ skip: false, reason: expect.any(String) });
  });
  it.each([undefined, null, 'invalid', '2026-01-01T00:00:00Z'])('ignores equal/missing/invalid timestamps (%s), ordering only by id', async stamp => {
    const x = input(); x.runs.workflow_runs.forEach(r => { r.created_at = stamp; });
    expect((await decide(x)).skip).toBe(true);
    x.runs.workflow_runs.push({ ...x.runs.workflow_runs[0], id: 102, conclusion: 'cancelled', created_at: '1900-01-01' }); x.runs.total_count++;
    expect((await decide(x)).skip).toBe(false);
  });
  it('excludes the current in-progress push from the newer non-success scan', async () => {
    expect((await decide(input())).skip).toBe(true);
    const x = input(); x.currentRunId = 999; expect((await decide(x)).skip).toBe(false);
  });
  it.each([
    ['queued push', { event: 'push', status: 'queued', conclusion: null }],
    ['in-progress push', { event: 'push', status: 'in_progress', conclusion: null }],
    ['skipped queue run', { event: 'merge_group', status: 'completed', conclusion: 'skipped' }],
    ['cancelled queue run', { event: 'merge_group', status: 'completed', conclusion: 'cancelled' }],
    ['foreign producer success', { event: 'workflow_dispatch', status: 'completed', conclusion: 'success', check_suite: { app: { id: 42 } } }],
  ])('ignores another workflow with a %s', async (_, fields) => {
    const x = input();
    x.runs.workflow_runs.push({ ...x.runs.workflow_runs[0], id: 102, path: '.github/workflows/other.yml', ...fields });
    x.runs.total_count++;
    expect((await decide(x)).skip).toBe(true);
  });
  it.each(['merge_group', 'push', 'workflow_dispatch', 'pull_request'])('runs full for an older-id failed or unfinished %s rerun (finding 3)', async event => {
    for (const status of ['completed', 'in_progress']) {
      const x = input();
      x.runs.workflow_runs.push({ ...x.runs.workflow_runs[0], id: 99, event, run_attempt: 2,
        status, conclusion: status === 'completed' ? 'failure' : null });
      x.runs.total_count++;
      expect((await decide(x)).skip).toBe(false);
    }
  });
  it('exports the verified FUI SHA for the remaining push checkouts (finding 4)', async () => {
    expect(await decide(input())).toMatchObject({ skip: true, fuiSha: fui });
  });
});

describe('queue sibling artifact content', () => {
  const queue = { id: 100, head_sha: sha, run_attempt: 2 };
  const artifact = { id: 7, name: `fui-sibling-${fui}`, expired: false };
  const record = { sha, run_id: 100, run_attempt: 2, job: 'queue-reuse-record', conclusion: 'success' };
  it('reads the record rather than trusting its artifact name', async () => {
    const { readQueueSiblingRecord } = await import('../main-push-skip.mjs');
    expect(readQueueSiblingRecord({ queue, artifacts: [artifact], download: () => JSON.stringify(record) })).toBe(fui);
  });
  it.each([
    ['missing content', () => ''], ['unreadable download', () => { throw Error('unreadable'); }],
    ['legacy content', () => 'recorded'], ['wrong SHA', () => JSON.stringify({ ...record, sha: 'd'.repeat(40) })],
    ['wrong run', () => JSON.stringify({ ...record, run_id: 99 })],
    ['wrong producer', () => JSON.stringify({ ...record, job: 'changes' })],
    ['failed conclusion', () => JSON.stringify({ ...record, conclusion: 'failure' })],
    ['missing attempt', () => JSON.stringify({ ...record, run_attempt: undefined })],
    ['quarantined later attempt published no record', () => JSON.stringify({ ...record, run_attempt: 1 })],
  ])('refuses %s', async (_, download) => {
    const { readQueueSiblingRecord } = await import('../main-push-skip.mjs');
    expect(() => readQueueSiblingRecord({ queue, artifacts: [artifact], download })).toThrow();
  });
  it.each([true, undefined])('refuses expired or unknown expiry (%s)', async expired => {
    const { readQueueSiblingRecord } = await import('../main-push-skip.mjs');
    expect(() => readQueueSiblingRecord({ queue, artifacts: [{ ...artifact, expired }], download: () => JSON.stringify(record) })).toThrow();
  });
});


describe('queue reuse age policy', () => {
  it('resolves standard, platform, tool and environment in order and logs provenance', async () => {
    const { readMainPushSkipPolicy } = await import('../main-push-skip.mjs');
    const log = vi.fn();
    const base = { platform: {}, env: {}, log };
    expect(readMainPushSkipPolicy(base).value.maxAgeMs).toBe(7200000);
    expect(readMainPushSkipPolicy({ ...base, platform: { maxAgeMs: 600000 } }).sources.maxAgeMs).toBe('platform');
    const settings = { ...base, platform: { maxAgeMs: 600000 }, tool: { maxAgeMs: 300000 } };
    expect(readMainPushSkipPolicy(settings).sources.maxAgeMs).toBe('tool');
    const result = readMainPushSkipPolicy({ ...settings, env: { WE_CI_MAIN_PUSH_SKIP_MAX_AGE_MS: '1000' } });
    expect(result.value.maxAgeMs).toBe(1000);
    expect(result.sources.maxAgeMs).toBe('env');
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('maxAgeMs=1000 (env)'));
    const rejected = readMainPushSkipPolicy({ ...base, env: { WE_CI_MAIN_PUSH_SKIP_MAX_AGE_MS: '7200001' } });
    expect(rejected.value.maxAgeMs).toBe(7200000);
    expect(rejected.invalid.length).toBeGreaterThan(0);
  });
});
