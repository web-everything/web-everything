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
  id, conclusion, created_at, updated_at, status: 'completed', head_sha: 'c'.repeat(40),
  path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
});
const shard = (i, conclusion = 'cancelled') => ({ id: 100 + i, name: `ci / test-shard (${i})`, status: 'completed', conclusion, output: { title: '', summary: '' } });
const GATE_ROWS = ['required-check-read', 'candidate-label', 'producer-certified', 'default-base', 'required-check-green',
  'codeql', 'mergeable', 'landable-state', 'non-empty-body', 'red-team', 'review-hold-labels', 'review-acceptance',
  'manifest-baseline', 'test-gaming', 'head-pin', 'freshness', 'red-main-freeze', 'duplicate-id-on-main', 'couple-whole',
  'blocked-by', 'overlap-yield', 'card-group', 'pass-cap', 'ledger'];
const TS = '2026-11-16T02:19:19.9Z';
const PENDING_ROW = `${TS}   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 43786703233 is being re-run (attempt 2) — verdict pending`;
const fullLog = ({ pr: n = pr, rows = {}, drop = [], extra = [], header = true, final = true } = {}) => [
  header && `${TS} #${n}: HOLD`,
  ...GATE_ROWS.filter(n => !drop.includes(n)).map(n => rows[n] ?? (n === 'red-main-freeze' ? PENDING_ROW : `${TS}   pass              ${n.padEnd(22)} ok`)),
  ...extra, final && `${TS} merge-gate: HOLD — held: #${n}`].filter(Boolean).join('\n');
const FREEZE = '2026-11-11T21:02:22Z   hold              red-main-freeze        main is RED (freeze: main CI red since ac12ebdb5)';
let gateLog = FREEZE;
const goodRun = () => ({ id: 1, path: '.github/workflows/merge-gate.yml', event: 'merge_group', head_sha: mergeCommit });
let runMeta = goodRun();
const goodJob = () => ({ id: 50, run_id: 1, name: 'merge-gate', workflow_name: 'Merge gate', head_sha: mergeCommit, status: 'completed', conclusion: 'failure' });
let jobMeta = goodJob(), freezeState = { frozen: false };
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
    if (endpoint === `repos/${repo}/actions/jobs/50`) return JSON.stringify(jobMeta);
    if (endpoint === `repos/${repo}/actions/runs/1`) { if (runMeta === null) throw new Error('run unreadable'); return JSON.stringify(runMeta); }
    const mainMatch = endpoint?.match(/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/);
    if (mainMatch) {
      const item = mainRuns.find(r => r.id === Number(mainMatch[1]));
      if (item) return JSON.stringify({ ...item, ...(mainMatch[2] ? { run_attempt: Number(mainMatch[2]) } : {}) });
    }
    if (endpoint?.includes('/logs')) throw new Error('no log');
    throw new Error(`unexpected GitHub read: ${args.join(' ')}`);
  });
  return { log, guard: () => mqSameHeadGuard({ repo, pr, head, exec, log, quarantine: { readList: null }, readFreeze: () => freezeState }),
    retried: () => log.mock.calls.some(([line]) => String(line).startsWith('mq-same-head-retry:')) };
}

describe('same-head MQ ejection caused by a red-main freeze or cancelled shards retries once main is green', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); jobMeta = goodJob(); runMeta = goodRun(); freezeState = { frozen: false }; });
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
    const f = fixture([gate(fullLog())], [{ ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 2 }, greenAtRemoval[1]]);
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
    const f = fixture([gate(fullLog())], [open, ...greenAtRemoval]);
    expect(f.guard().hold).toBe(true);
  });

  it('holds a pending-rerun freeze when the named run is missing or was cancelled', () => {
    const line = '2026-11-16T02:19:19Z   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 43786703233 is being re-run (attempt 2) — verdict pending';
    expect(fixture([gate(fullLog())], greenAtRemoval).guard().hold).toBe(true);
    expect(fixture([gate(fullLog())], [run(43786703233, 'cancelled', '2026-11-11T21:35:00Z', '2026-11-11T21:36:00Z'), ...greenAtRemoval]).guard().hold).toBe(true);
  });

  const PENDING = '2026-11-16T02:19:19Z   fail-closed       red-main-freeze        red-main freeze unreadable: main CI run 43786703233 is being re-run (attempt 2) — verdict pending';
  it('holds when the named attempt is not the run latest attempt', () => {
    const r = { ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 1 };
    expect(fixture([gate(fullLog())], [r, greenAtRemoval[1]]).guard().hold).toBe(true);
  });
  it('holds when a second hold sits outside the old 64 KiB tail window', () => {
    // A tail-only scan would see just the valid table below (one freeze row) and retry; the whole log shows two rows.
    const stray = `${TS}   hold              codeql                 CodeQL check failed`;
    const log = `${stray}\n${'x'.repeat(70 * 1024)}\n${fullLog()}`;
    const r = { ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 2 };
    expect(fixture([gate(log)], [r, greenAtRemoval[1]]).guard().hold).toBe(true);
  });
  it('holds when the gate log is too large to classify', () => {
    const log = `${'x'.repeat(4 * 1024 * 1024)}\n${PENDING}`;
    const r = { ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 2 };
    expect(fixture([gate(log)], [r, greenAtRemoval[1]]).guard().hold).toBe(true);
  });

  const att2 = [{ ...run(43786703233, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 2 }, greenAtRemoval[1]];
  const att2red = [att2[0], redAtRemoval[1]];
  it('holds a lone freeze row with no gate table', () => {
    expect(fixture([gate(PENDING_ROW)], att2).guard().hold).toBe(true);
  });
  it('holds when the final merge-gate HOLD line is missing', () => {
    expect(fixture([gate(fullLog({ final: false }))], att2).guard().hold).toBe(true);
  });
  it('holds when the #N: HOLD header is missing', () => {
    expect(fixture([gate(fullLog({ header: false }))], att2).guard().hold).toBe(true);
  });
  it('holds when an expected gate row is missing', () => {
    expect(fixture([gate(fullLog({ drop: ['ledger'] }))], att2).guard().hold).toBe(true);
  });
  it('holds when a malformed extra row sits in the table', () => {
    expect(fixture([gate(fullLog({ extra: [`${TS}   ??  garbled row`] }))], att2).guard().hold).toBe(true);
  });
  it('retries on a structurally complete log (control)', () => {
    expect(fixture([gate(fullLog())], att2).guard().hold).toBe(false);
  });
  it('holds when the log table belongs to another PR', () => {
    expect(fixture([gate(fullLog({ pr: 6903 }))], att2).guard().hold).toBe(true);
  });
  it('holds while a manual freeze is active, whatever the rerun state', () => {
    freezeState = { frozen: true, kind: 'manual', reason: 'operator' };
    expect(fixture([gate(fullLog())], att2).guard().hold).toBe(true);
  });
  it('holds when the shared freeze is unreadable', () => {
    freezeState = { error: 'branch unreadable' };
    expect(fixture([gate(fullLog())], att2).guard().hold).toBe(true);
  });
  it('holds when the log job is not the merge_group Merge gate run for this merge commit', () => {
    for (const bad of [{ name: 'other-job' }, { workflow_name: 'CI' }, { head_sha: 'd'.repeat(40) }, { conclusion: 'success' }]) {
      jobMeta = { ...goodJob(), ...bad };
      expect(fixture([gate(fullLog())], att2).guard().hold).toBe(true);
    }
  });
  it('holds when the job run is not the merge-gate workflow merge_group run for this merge commit (display names are not identity)', () => {
    for (const bad of [{ path: '.github/workflows/ci.yml' }, { event: 'push' }, { head_sha: 'd'.repeat(40) }, null]) {
      runMeta = bad === null ? null : { ...goodRun(), ...bad };
      expect(fixture([gate(fullLog())], att2).guard().hold).toBe(true);
    }
    runMeta = goodRun(); jobMeta = { ...goodJob(), run_id: 2 };
    expect(fixture([gate(fullLog())], att2).guard().hold).toBe(true);
  });
  it('main red at removal, green now, active manual freeze: no retry (blocked beats the main-red fallback)', () => {
    freezeState = { frozen: true, kind: 'manual', reason: 'operator' };
    expect(fixture([gate(fullLog())], att2red).guard().hold).toBe(true);
  });
  it('main red at removal, green now, unreadable gate log: no retry', () => {
    expect(fixture([gate(fullLog({ drop: ['ledger'] }))], att2red).guard().hold).toBe(true);
  });
  it('main red at removal, green now, no freeze: the retry still works', () => {
    expect(fixture([gate(fullLog())], att2red).guard().hold).toBe(false);
  });
});


// Incident facts are fixed here; mutations below remove one proof at a time.
function pendingFixture(edit = () => {}) {
  const n = 7496, N = 45625379144, group = 45637335054, summaryId = 139288907316;
  const bound = { run_id: group, run_attempt: 1, head_sha: mergeCommit, status: 'completed' };
  const parts = ['scan-chain', 'sim-scenarios', 'lane-pool-a', 'lane-pool-b', 'parallel'];
  const summary = { ...bound, id: summaryId, name: 'integration', conclusion: 'failure',
    steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Gate on integration results', conclusion: 'failure' },
      { name: 'Complete job', conclusion: 'success' }] };
  const check = job => ({ ...job, details_url: `https://github.com/${repo}/actions/runs/${group}/job/${job.id}` });
  const cancelled = Array.from({ length: 27 }, (_, i) => ({ ...bound, id: 200 + i,
    name: i < 5 ? `integration-part (${parts[i]})` : `cancelled-${i}`, conclusion: 'cancelled' }));
  const latest = { ...run(N, 'success', '2026-11-11T21:30:00Z', '2026-11-11T21:40:00Z'), run_attempt: 3 };
  const state = {
    checks: [{ ...gate(), id: 139286224799 }, check(summary), ...cancelled,
      ...Array.from({ length: 6 }, (_, i) => ({ id: 300 + i, name: `passing-${i}`, status: 'completed', conclusion: 'success' }))],
    jobs: [summary, { ...bound, id: 199, name: 'changes', conclusion: 'success' }, ...cancelled],
    summary, groupRun: { id: group, path: '.github/workflows/ci.yml', event: 'merge_group', head_sha: mergeCommit },
    latest, named: { ...latest, run_attempt: 2, conclusion: 'failure' },
    main: [latest, greenAtRemoval[1]],
    log: fullLog({ pr: n }).replaceAll('43786703233', String(N)),
    gateJob: goodJob(), gateRun: goodRun(), freeze: { frozen: false }, clean: 'CLEAN',
    events: [removal()], overrides: new Map(),
  };
  edit(state);
  const calls = [], log = vi.fn();
  const exec = vi.fn((_command, args) => {
    const endpoint = args.find(a => a.startsWith(`repos/${repo}/`));
    if (!endpoint) {
      if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
      if (args.some(a => a.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: state.events, pageInfo: { hasPreviousPage: false } } } } } });
      if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: state.clean });
      throw new Error('unexpected non-API read');
    }
    calls.push(endpoint);
    if (state.overrides.has(endpoint)) {
      const value = state.overrides.get(endpoint);
      if (value instanceof Error) throw value;
      return JSON.stringify(value);
    }
    if (endpoint.includes('/check-runs?')) return JSON.stringify({ total_count: state.checks.length, check_runs: state.checks });
    if (endpoint.endsWith('/jobs/50/logs')) return state.log;
    if (endpoint.endsWith('/jobs/50')) return JSON.stringify(state.gateJob);
    if (endpoint.endsWith('/runs/1')) return JSON.stringify(state.gateRun);
    if (endpoint.includes('/workflows/ci.yml/runs?')) {
      const items = endpoint.includes('created=<') ? [state.atRemoval ?? greenAtRemoval[1]] : state.main;
      return JSON.stringify({ total_count: items.length, workflow_runs: items });
    }
    if (endpoint.endsWith(`/runs/${N}/attempts/2`)) return JSON.stringify(state.named);
    if (endpoint.endsWith(`/runs/${N}`)) return JSON.stringify(state.latest);
    if (endpoint.endsWith(`/runs/${group}`)) return JSON.stringify(state.groupRun);
    if (endpoint.includes(`/runs/${group}/attempts/1/jobs?`)) return JSON.stringify({ total_count: state.jobs.length, jobs: state.jobs });
    const job = state.jobs.find(j => endpoint.endsWith(`/jobs/${j.id}`));
    if (job) return JSON.stringify(job);
    throw new Error(`unexpected read ${endpoint}`);
  });
  return { state, calls, log, guard: () => mqSameHeadGuard({ repo, pr: n, head, now, exec, log,
    quarantine: { readList: null }, readFreeze: () => state.freeze }) };
}

const holdPending = edit => expect(pendingFixture(edit).guard().hold).toBe(true);

describe('pending freeze beside a summary failed only by cancelled needs (#7496)', () => {
  it('retries the #7496 shape', () => {
    const f = pendingFixture();
    expect(f.state.checks).toHaveLength(35);
    const result = f.guard();
    expect(result.hold, result.reason).toBe(false);
    expect(f.log.mock.calls.flat().join('\n')).toContain('infra retry 1/2');
  });
  it.each(['failure', 'timed_out', 'skipped', 'neutral', 'pending', 'missing', 'duplicated', 'extra', 'unknown', 'startup_failure'])(
    'holds when an integration-part member is %s', value => holdPending(s => {
      const j = s.jobs.find(j => j.name === 'integration-part (parallel)');
      if (value === 'missing') s.jobs.splice(s.jobs.indexOf(j), 1);
      else if (value === 'duplicated' || value === 'extra') s.jobs.push({ ...j, id: 999, name: value === 'extra' ? 'integration-part (other)' : j.name });
      else { j.conclusion = value; if (value === 'pending') j.status = 'in_progress'; }
    }));
  it.each(['cancelled', 'failure'])('holds when changes is %s', value => holdPending(s => { s.jobs[1].conclusion = value; }));
  it('holds when every need succeeded', () => holdPending(s => s.jobs.slice(2).forEach(j => { j.conclusion = 'success'; })));
  it.each([{ run_id: 7 }, { run_attempt: 2 }, { head_sha: head }, { id: 7 }, { name: 'other' }, { status: 'in_progress' }])(
    'holds when the summary binds to another run, attempt, commit or identity: %j', bad => holdPending(s => Object.assign(s.summary, bad)));
  it('holds when the summary binds to another workflow', () => holdPending(s => { s.groupRun.path = '.github/workflows/other.yml'; }));
  it.each([undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])('holds when run_attempt is missing or invalid: %s', value => holdPending(s => { s.summary.run_attempt = value; }));
  it.each(['absent', 'duplicated'])('holds when the summary is %s in its attempt jobs', value => holdPending(s => {
    if (value === 'absent') s.jobs.shift(); else s.jobs.push({ ...s.summary });
  }));
  it.each(['unreadable', 'truncated', 'inconsistent'])('holds when the attempt jobs list is %s', value => holdPending(s => {
    const endpoint = `repos/${repo}/actions/runs/45637335054/attempts/1/jobs?per_page=100&page=1`;
    s.overrides.set(endpoint, value === 'unreadable' ? new Error('unreadable') : { total_count: value === 'truncated' ? 999 : 1, jobs: s.jobs });
  }));
  it('holds a failed summary that is not in the P map, whatever drain.mqAggregateJobs says', () => {
    vi.stubEnv('WE_DRAIN_MQ_AGGREGATE_JOBS', '["other-summary"]');
    try { holdPending(s => { s.summary.name = 'other-summary'; s.checks[1].name = 'other-summary'; }); }
    finally { vi.unstubAllEnvs(); }
  });
  it.each(['test', 'coverage-merge'])('retries a proven %s summary on P independently of aggregate settings', name => {
    vi.stubEnv('WE_DRAIN_MQ_AGGREGATE_JOBS', '["other-summary"]');
    try {
      const f = pendingFixture(s => {
        s.summary.name = name; s.checks[1].name = name;
        s.summary.steps[1].name = name === 'test' ? 'Gate on shard results' : 'Require successful shards';
        const bound = { run_id: 45637335054, run_attempt: 1, head_sha: mergeCommit, status: 'completed' };
        s.jobs = [s.summary, { ...bound, id: 199, name: 'changes', conclusion: 'success' },
          ...Array.from({ length: 10 }, (_, i) => ({ ...bound, id: 400 + i, name: `test-shard (${i + 1})`, conclusion: 'cancelled' }))];
        if (name === 'test') s.jobs.push(...['integration', 'standards', 'coverage-merge', 'host-paths'].map((n, i) => ({ ...bound, id: 500 + i, name: n, conclusion: 'success' })));
      });
      expect(f.guard().hold).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['run_id', 'run_attempt', 'head_sha'])('holds when an attempt job has mismatched %s', key => holdPending(s => { s.jobs[1][key] = key === 'head_sha' ? head : 99; }));
  it.each(['id', 'event', 'head_sha'])('holds when the CI run has mismatched %s', key => holdPending(s => { s.groupRun[key] = key === 'id' ? 99 : key === 'event' ? 'push' : head; }));
  it.each(['unreadable', 'foreign repo', 'query URL', 'missing steps', 'duplicate failed summary step'])(
    'holds when the summary evidence is %s', value => holdPending(s => {
      if (value === 'unreadable') s.overrides.set(`repos/${repo}/actions/jobs/139288907316`, new Error('unreadable'));
      if (value === 'foreign repo') s.checks[1].details_url = 'https://github.com/other/repo/actions/runs/45637335054/job/139288907316';
      if (value === 'query URL') s.checks[1].details_url += '?other=1';
      if (value === 'missing steps') delete s.summary.steps;
      if (value === 'duplicate failed summary step') s.summary.steps.push({ ...s.summary.steps[1] });
    }));
  it('holds an oversized five-page attempt jobs list and names operator inspection', () => {
    const f = pendingFixture(s => {
      for (let page = 1; page <= 5; page++) s.overrides.set(
        `repos/${repo}/actions/runs/45637335054/attempts/1/jobs?per_page=100&page=${page}`,
        { total_count: 501, jobs: Array.from({ length: 100 }, (_, i) => ({ ...s.jobs[1], id: page * 1000 + i })) });
    });
    const result = f.guard();
    expect(result.hold).toBe(true);
    expect(result.reason).toContain('operator must inspect');
    expect(f.calls.filter(c => c.includes('/attempts/1/jobs?'))).toHaveLength(5);
  });
  it('holds an extra failed step', () => holdPending(s => s.summary.steps.push({ name: 'Install', conclusion: 'failure' })));
  it('holds a #7487-shaped soak-shard failure', () => holdPending(s => s.checks.push({ id: 999, name: 'soak-shard (1)', status: 'completed', conclusion: 'failure' })));
  it.each(['unrecognized log', 'invalid gate URL'])('a failed P-map summary with %s holds and never falls to the main-red retry', value => {
    const f = pendingFixture(s => {
      s.atRemoval = { ...greenAtRemoval[1], conclusion: 'failure' };
      // Under the 10-job cap, with a readable non-infra log, so only the main-red fallback could authorize.
      s.checks = s.checks.filter(c => !/^cancelled-/.test(c.name));
      s.overrides.set(`repos/${repo}/actions/jobs/139288907316/logs`, 'AssertionError: expected 1 to be 2\n');
      if (value === 'unrecognized log') s.log = 'unrecognized gate output\n';
      else s.checks[0].details_url = 'https://github.com/other/repo/actions/runs/45637335054/job/139286224799';
    });
    const result = f.guard();
    expect(result.hold).toBe(true);
    expect(f.log.mock.calls.flat().join('\n')).not.toContain('infra retry');
  });
  it('on branch R a failed integration still holds, as today', () => holdPending(s => { s.log = FREEZE; }));
  it.each(['incomplete log', 'gate job', 'gate run', 'shared freeze', 'stale main', 'unfinished run', 'not CLEAN'])(
    'P guards: %s', value => holdPending(s => {
      if (value === 'incomplete log') s.log = s.log.split('\n').slice(1).join('\n');
      if (value === 'gate job') s.gateJob.head_sha = head;
      if (value === 'gate run') s.gateRun.event = 'push';
      if (value === 'shared freeze') s.freeze = { error: 'unreadable' };
      if (value === 'stale main') s.latest.updated_at = '2026-11-11T18:00:00Z';
      if (value === 'unfinished run') s.main.push({ ...s.latest, id: 77, status: 'in_progress', conclusion: null });
      if (value === 'not CLEAN') s.clean = 'BLOCKED';
    }));
  it.each(['second blocking row', 'main not green', 'not CLEAN'])('R guards: %s', value => holdPending(s => {
    s.checks.splice(1, 1); s.log = FREEZE;
    if (value === 'second blocking row') s.log += `\n${TS}   hold              codeql                 failure`;
    if (value === 'main not green') s.latest.conclusion = 'failure';
    if (value === 'not CLEAN') s.clean = 'BLOCKED';
  }));
});

describe('settled green (ruling 9)', () => {
  it('accepts a later successful attempt (attempt 2 failure, attempt 3 success)', () => {
    const f = pendingFixture(s => s.checks.splice(1, 1));
    expect(f.guard().hold).toBe(false);
  });
  it.each(['failure', 'cancelled', 'unfinished'])('holds when the latest attempt is %s', value => holdPending(s => {
    s.latest.conclusion = value === 'unfinished' ? null : value;
    if (value === 'unfinished') s.latest.status = 'in_progress';
  }));
  it.each([undefined, 0, 1.5, '3', Number.MAX_SAFE_INTEGER + 1])('holds an invalid latest attempt %s', value => holdPending(s => { s.latest.run_attempt = value; }));
  it('holds a duplicated named run in the newest page', () => holdPending(s => { s.main.push({ ...s.latest }); }));
  it('holds a missing main commit', () => holdPending(s => { delete s.latest.head_sha; }));
  it('holds when the named run is outside the newest 100', () => holdPending(s => { s.main = greenAtRemoval; }));
  it.each(['latest unreadable', 'named unreadable', 'latest id', 'latest attempt', 'latest conclusion', 'latest sha', 'latest workflow', 'latest event', 'latest branch', 'named id', 'named attempt', 'named unfinished'])(
    'holds when runs/{N} or attempts/{A} is unreadable or mismatched: %s', value => holdPending(s => {
      const latest = { ...s.latest }, named = { ...s.named };
      const targets = { 'latest id': [latest, 'id', 9], 'latest attempt': [latest, 'run_attempt', 4],
        'latest conclusion': [latest, 'conclusion', 'failure'], 'latest sha': [latest, 'head_sha', head],
        'latest workflow': [latest, 'path', 'other'], 'latest event': [latest, 'event', 'merge_group'],
        'latest branch': [latest, 'head_branch', 'other'], 'named id': [named, 'id', 9],
        'named attempt': [named, 'run_attempt', 3], 'named unfinished': [named, 'status', 'in_progress'] };
      if (targets[value]) { const [obj, key, v] = targets[value]; obj[key] = v; }
      s.overrides.set(`repos/${repo}/actions/runs/45625379144`, value === 'latest unreadable' ? new Error('unreadable') : latest);
      s.overrides.set(`repos/${repo}/actions/runs/45625379144/attempts/2`, value === 'named unreadable' ? new Error('unreadable') : named);
    }));
  it('names the freeze attempt in the decline', () => {
    const f = pendingFixture(s => { s.latest.run_attempt = 1; });
    const result = f.guard();
    expect(result.hold).toBe(true);
    expect(result.reason).toMatch(/45625379144.*attempt 2.*latest attempt 1.*success/);
  });
});

function summaries(s, count) {
  for (let i = 1; i < count; i++) {
    const j = { ...s.summary, id: s.summary.id + i };
    s.jobs.push(j);
    s.checks.push({ ...j, details_url: `https://github.com/${repo}/actions/runs/45637335054/job/${j.id}` });
  }
}
describe('budget', () => {
  it('#7496 path makes the exact call list', () => {
    const f = pendingFixture();
    expect(f.guard().hold).toBe(false);
    expect(f.calls).toEqual([
      `repos/${repo}/commits/${mergeCommit}/check-runs?filter=all&per_page=100&page=1`,
      `repos/${repo}/actions/jobs/50/logs`, `repos/${repo}/actions/jobs/50`, `repos/${repo}/actions/runs/1`,
      `repos/${repo}/actions/jobs/139288907316`, `repos/${repo}/actions/runs/45637335054`,
      `repos/${repo}/actions/runs/45637335054/attempts/1/jobs?per_page=100&page=1`,
      `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100`,
      `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&created=<2026-11-11T21:11:00.000Z&per_page=100`,
      `repos/${repo}/actions/runs/45625379144`, `repos/${repo}/actions/runs/45625379144/attempts/2`,
    ]);
  });
  it('holds at exhaustion before the proof, keeping the 2-call reserve', () => {
    const f = pendingFixture(s => summaries(s, 9));
    expect(f.guard().hold).toBe(true);
    expect(f.calls).toHaveLength(28);
    expect(f.calls.some(c => c.includes('/workflows/ci.yml/runs?'))).toBe(false);
  });
  it('holds at exhaustion before the ruling 9 reads', () => {
    const f = pendingFixture(s => summaries(s, 8));
    expect(f.guard().hold).toBe(true);
    expect(f.calls).toHaveLength(30);
    expect(f.calls).not.toContain(`repos/${repo}/actions/runs/45625379144`);
  });
  it('counts the gate-run read', () => {
    const f = pendingFixture(s => summaries(s, 8)); f.guard();
    expect(f.calls).toContain(`repos/${repo}/actions/runs/1`);
    expect(f.calls).toHaveLength(30);
  });
  it('grants 2/2 after one manual re-add and holds the third', () => {
    const add = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-11T21:12:00Z' };
    const f = pendingFixture(s => { s.events.push(add, { ...removal(), createdAt: '2026-11-11T21:13:00Z' }); });
    expect(f.guard().hold).toBe(false);
    expect(f.log.mock.calls.flat().join('\n')).toContain('infra retry 2/2');
    holdPending(s => { s.events.push(add, { ...add, createdAt: '2026-11-11T21:13:00Z' }); });
  });
});
