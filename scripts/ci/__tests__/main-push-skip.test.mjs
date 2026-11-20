// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const recorded = JSON.parse(readFileSync(new URL('./fixtures/main-push-runs.json', import.meta.url)));
const sha = 'a'.repeat(40), fui = 'b'.repeat(40);
const input = () => ({ sha, before: 'c'.repeat(40), event: 'push', ref: 'refs/heads/main', currentRunId: 101,
  runs: structuredClone(recorded), queueFuiSha: fui, fuiTip: fui, beforeIsAncestor: true });
const decide = async value => (await import('../main-push-skip.mjs')).decideMainPushSkip(value);
describe('exact-SHA main push reuse', () => {
  it('skips a proven queue SHA and names its run id', async () => {
    expect(await decide(input())).toMatchObject({ skip: true, reason: expect.stringContaining('100') });
  });
  it.each([
    ['direct push', x => { x.runs.workflow_runs.shift(); x.runs.total_count--; }],
    ['failure after success', x => x.runs.workflow_runs.push({ ...x.runs.workflow_runs[0], id: 102, conclusion: 'failure' }) && x.runs.total_count++],
    ['newer queued run', x => x.runs.workflow_runs.push({ ...x.runs.workflow_runs[1], id: 102 }) && x.runs.total_count++],
    ['newer success from another producer', x => x.runs.workflow_runs.push({ ...x.runs.workflow_runs[0], id: 102, check_suite: { app: { id: 42 } } }) && x.runs.total_count++],
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
});
