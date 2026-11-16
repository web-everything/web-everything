import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard } from '../drain-queue-safety.mjs';

const repo = 'fixture/drain', pr = 6665;
const head = 'a'.repeat(40), mergeCommit = 'b'.repeat(40);
const now = Date.parse('2026-11-11T22:00:00Z');
const removal = () => ({
  __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-11T21:11:00Z',
  beforeCommit: { oid: mergeCommit, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } },
});
const run = (id, conclusion, created_at, updated_at) => ({
  id, conclusion, created_at, updated_at, status: 'completed',
  path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
});
const shard = (i, conclusion = 'cancelled') => ({ id: 100 + i, name: `ci / test-shard (${i})`, status: 'completed', conclusion, output: { title: '', summary: '' } });
const FREEZE = '2026-11-11T21:02:22Z   hold              red-main-freeze        main is RED (freeze: main CI red since ac12ebdb5)';
let gateLog = FREEZE;
const gate = (log = FREEZE) => { gateLog = log;
  return { id: 50, name: 'ci / merge-gate', status: 'completed', conclusion: 'failure', output: { title: null, summary: null },
    details_url: `https://github.com/${repo}/actions/runs/1/job/50` }; };

// Main was red when the PR was removed (21:11Z) and is green now.
const redAtRemoval = [run(2, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'),
  run(1, 'failure', '2026-11-11T20:50:00Z', '2026-11-11T21:05:00Z')];
// Main looked green (or had no earlier completed run) when the PR was removed: only the job evidence can excuse it.
const greenAtRemoval = [run(2, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'),
  run(1, 'success', '2026-11-11T20:50:00Z', '2026-11-11T21:05:00Z')];

function fixture(checks, mainRuns = redAtRemoval) {
  const log = vi.fn();
  const exec = vi.fn((command, args) => {
    if (args.some(arg => arg.includes('isInMergeQueue')))
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
    if (args.some(arg => arg.includes('timelineItems')))
      return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: [removal()], pageInfo: { hasPreviousPage: false } } } } } });
    if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.startsWith(`repos/${repo}/commits/${mergeCommit}/check-runs?`))
      return JSON.stringify({ total_count: checks.length, check_runs: checks });
    if (endpoint?.startsWith(`repos/${repo}/actions/workflows/ci.yml/runs?`)) {
      const query = new URLSearchParams(endpoint.split('?')[1]);
      let selected = [...mainRuns].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const before = query.get('created');
      if (before?.startsWith('<')) selected = selected.filter(item => Date.parse(item.created_at) < Date.parse(before.slice(1)));
      return JSON.stringify({ total_count: selected.length, workflow_runs: selected });
    }
    if (endpoint === `repos/${repo}/actions/jobs/50/logs`) return gateLog;
    if (endpoint?.includes('/logs')) throw new Error('no log');
    throw new Error(`unexpected GitHub read: ${args.join(' ')}`);
  });
  return { log, guard: () => mqSameHeadGuard({ repo, pr, head, exec, log, quarantine: { readList: null } }),
    retried: () => log.mock.calls.some(([line]) => String(line).startsWith('mq-same-head-retry:')) };
}

describe('same-head MQ ejection caused by a red-main freeze or cancelled shards retries once main is green', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => vi.useRealTimers());

  it('retries when the merge-gate failed with the red-main-freeze hold and every other failure is cancelled', () => {
    const f = fixture([gate(), ...[1, 2, 3].map(i => shard(i))]);
    expect(f.guard().hold).toBe(false);
    expect(f.retried()).toBe(true);
  });

  it('retries a freeze ejection with more than 10 cancelled shards (no log reads)', () => {
    const f = fixture([gate(), ...Array.from({ length: 14 }, (_, i) => shard(i + 1))]);
    expect(f.guard().hold).toBe(false);
  });

  it('retries when every failed job is cancelled, even above the 10-job limit', () => {
    const f = fixture(Array.from({ length: 14 }, (_, i) => shard(i + 1)));
    expect(f.guard().hold).toBe(false);
  });

  it('retries a freeze ejection even when main looked green at removal', () => {
    const f = fixture([gate(), ...[1, 2].map(i => shard(i))], greenAtRemoval);
    expect(f.guard().hold).toBe(false);
  });

  it('still holds a real failing shard next to the freeze hold', () => {
    const f = fixture([gate(), shard(1, 'failure'), shard(2)], greenAtRemoval);
    expect(f.guard().hold).toBe(true);
  });

  it('still holds a merge-gate failure that is not the red-main-freeze hold', () => {
    const f = fixture([gate('2026-11-11T21:02:22Z   hold              required-checks        2 tests failed'), shard(1)], greenAtRemoval);
    expect(f.guard().hold).toBe(true);
  });

  it('still holds a merge-gate with a second hold reason next to the freeze', () => {
    const f = fixture([gate(`${FREEZE}\n2026-11-11T21:02:23Z   hold              required-checks        test red`), shard(1)], greenAtRemoval);
    expect(f.guard().hold).toBe(true);
  });

  it('still holds a merge-gate whose log does not show the freeze hold', () => {
    const f = fixture([gate('not a gate log'), shard(1)], greenAtRemoval);
    expect(f.guard().hold).toBe(true);
  });

  it('retries when the only merge-gate failure is the red-main freeze unreadable while main CI re-ran (transient fail-closed)', () => {
    const line = '2026-11-16T02:19:19.9232865Z   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 43786703233 is being re-run (attempt 2) — verdict pending';
    const f = fixture([gate(line)], [{ ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 2 }, greenAtRemoval[1]]);
    expect(f.guard().hold).toBe(false);
    expect(f.retried()).toBe(true);
  });

  it('still holds an unreadable freeze next to another fail-closed reason', () => {
    const line = '2026-11-16T02:19:19.9232865Z   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 1 is being re-run (attempt 2) — verdict pending\n2026-11-16T02:19:19.9Z   fail-closed       codeql                 unreadable';
    const f = fixture([gate(line)], greenAtRemoval);
    expect(f.guard().hold).toBe(true);
  });

  it('holds an unreadable freeze that is not the pending-rerun case', () => {
    const f = fixture([gate('2026-11-16T02:19:19Z   fail-closed       red-main-freeze        red-main freeze unreadable: HTTP 403')], greenAtRemoval);
    expect(f.guard().hold).toBe(true);
  });

  it('holds a pending-rerun freeze while a main run is still unfinished', () => {
    const line = '2026-11-16T02:19:19Z   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 1 is being re-run (attempt 2) — verdict pending';
    const open = { ...run(3, null, '2026-11-11T21:50:00Z', '2026-11-11T21:50:00Z'), status: 'in_progress', conclusion: null };
    const f = fixture([gate(line)], [open, ...greenAtRemoval]);
    expect(f.guard().hold).toBe(true);
  });

  it('holds a pending-rerun freeze when the named run is missing or was cancelled', () => {
    const line = '2026-11-16T02:19:19Z   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 43786703233 is being re-run (attempt 2) — verdict pending';
    expect(fixture([gate(line)], greenAtRemoval).guard().hold).toBe(true);
    expect(fixture([gate(line)], [run(43786703233, 'cancelled', '2026-11-11T21:35:00Z', '2026-11-11T21:36:00Z'), ...greenAtRemoval]).guard().hold).toBe(true);
  });

  const PENDING = '2026-11-16T02:19:19Z   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 43786703233 is being re-run (attempt 2) — verdict pending';
  it('holds when the named attempt is not the run latest attempt', () => {
    const r = { ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 1 };
    expect(fixture([gate(PENDING)], [r, greenAtRemoval[1]]).guard().hold).toBe(true);
  });
  it('holds when a second hold sits outside the old 64 KiB tail window', () => {
    const other = '2026-11-16T02:19:19Z   hold              required-checks        test red';
    const log = `${other}\n${'x'.repeat(70 * 1024)}\n${PENDING}`;
    const r = { ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 2 };
    expect(fixture([gate(log)], [r, greenAtRemoval[1]]).guard().hold).toBe(true);
  });
  it('holds when the gate log is too large to classify', () => {
    const log = `${'x'.repeat(4 * 1024 * 1024)}\n${PENDING}`;
    const r = { ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 2 };
    expect(fixture([gate(log)], [r, greenAtRemoval[1]]).guard().hold).toBe(true);
  });
});
