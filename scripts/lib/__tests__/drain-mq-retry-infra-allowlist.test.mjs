import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard, readDrainQueueSafety } from '../drain-queue-safety.mjs';

// Exercise the production readSettings().drain path without reading developer settings.
const settings = vi.hoisted(() => ({ drain: {} }));
vi.mock('../settings-files.mjs', async importOriginal => ({
  ...await importOriginal(), readSettings: vi.fn(() => ({ drain: settings.drain })),
}));

const repo = 'fixture/drain', pr = 6215;
const head = 'a'.repeat(40), mergeCommit = 'b'.repeat(40);
const now = Date.parse('2026-11-01T14:00:00Z');
const standard = ['could not fetch \\S+ from promisor remote'];
const infraLog = 'fatal: could not fetch deadbeef from promisor remote\n';
const testLog = 'FAIL test/shard.test.ts > adds numbers\nAssertionError: expected 2 to be 3\n';
const MAX_JOBS = 10, MAX_LOG_BYTES = 4 * 1024 * 1024;
const removal = (createdAt = '2026-11-01T13:45:00Z') => ({
  __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt,
  beforeCommit: { oid: mergeCommit, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } },
});
const run = (id, conclusion = 'success', created_at = '2026-11-01T13:20:00Z') => ({
  id, conclusion, created_at, updated_at: created_at, status: 'completed',
  path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
});
const job = (id, conclusion = 'failure') => ({
  id, name: `test-shard-${id}`, status: 'completed', conclusion,
  details_url: `https://github.com/${repo}/actions/runs/201/job/${id}`,
  output: { title: '', summary: '', text: '' },
});

// As in drain-mq-retry-main-green.test.mjs, model the API's filters and limits.
// No summary hints or quarantine coverage can mask the log-based classification.
function fixture({ checks = [job(21)], logs = new Map([[21, infraLog]]),
  runs = [{ ...run(103, null, '2026-11-01T13:50:00Z'), status: 'in_progress' }, run(102)],
  events = [removal()], mergeState = 'CLEAN' } = {}) {
  const log = vi.fn(), logReads = [];
  const exec = vi.fn((command, args, opts) => {
    if (command !== 'gh') throw new Error('unexpected non-GitHub IO');
    if (args.some(arg => arg.includes('isInMergeQueue'))) {
      return JSON.stringify({ data: { repository: { pullRequest: {
        isInMergeQueue: false, headRefOid: head,
      } } } });
    }
    if (args.some(arg => arg.includes('timelineItems'))) {
      return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
        nodes: events, pageInfo: { hasPreviousPage: false },
      } } } } });
    }
    if (args.includes('mergeStateStatus,headRefOid')) {
      return JSON.stringify({ headRefOid: head, mergeStateStatus: mergeState });
    }
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.startsWith(`repos/${repo}/commits/${mergeCommit}/check-runs?`)) {
      return JSON.stringify({ total_count: checks.length, check_runs: checks });
    }
    const match = endpoint?.match(/\/actions\/jobs\/(\d+)\/logs(?:\?|$)/);
    if (match) {
      const id = Number(match[1]);
      logReads.push({ id, opts });
      if (!logs.has(id)) throw new Error(`unreadable job ${id}`);
      const value = logs.get(id);
      if (value instanceof Error) throw value;
      return value;
    }
    if (endpoint?.startsWith(`repos/${repo}/actions/workflows/ci.yml/runs?`)) {
      const query = new URLSearchParams(endpoint.split('?')[1]);
      let selected = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
      if (query.get('status')) selected = selected.filter(item => item.status === query.get('status'));
      const before = query.get('created');
      if (before?.startsWith('<')) selected = selected.filter(item => Date.parse(item.created_at) < Date.parse(before.slice(1)));
      const total_count = selected.length, limit = Number(query.get('per_page') ?? 100);
      const page = Number(query.get('page') ?? 1);
      return JSON.stringify({ total_count, workflow_runs: selected.slice((page - 1) * limit, page * limit) });
    }
    throw new Error(`unexpected GitHub read: ${args.join(' ')}`);
  });
  return { exec, log, logReads, guard: () => mqSameHeadGuard({
    repo, pr, head, exec, log, now, quarantine: { readList: null },
  }) };
}

// The reader is private: the public retry line exposes its infra classification.
function expectInfraRetry(decision) {
  expect(decision.hold).toBe(false);
  expect(decision.line).toContain('failed_checks infra retry 1/2 (main green, PR CLEAN, infra)');
  expect(decision.line).toContain('main run 102');
}

function expectVisibleDecision(decision, reason, mainRunId = 102) {
  // Either structured fields or the returned line is sufficient. A separate log callback
  // is insufficient: merge-ai-prs forwards guard.line as the not-enqueued reason today.
  const text = decision.reason ?? decision.line;
  expect(text).toMatch(reason);
  expect(decision.mainRunId ?? (text?.includes(`main run ${mainRunId}`) ? mainRunId : undefined)).toBe(mainRunId);
}

describe('same-head MQ retry job-log infrastructure allowlist', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    // Production settings resolution is intentional; all operational IO stays injected.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('WE_UNDER_TEST', '');
    settings.drain = {};
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it.each([
    ['green main and CLEAN PR', 'success', 'CLEAN', false],
    ['red main and CLEAN PR', 'failure', 'CLEAN', true],
    ['green main and BLOCKED PR', 'success', 'BLOCKED', true],
    ['green main and BEHIND PR', 'success', 'BEHIND', true],
    ['green main and unknown PR state', 'success', null, true],
  ])('rerun-confirmed admission requires green main and a CLEAN PR: %s', (_name, conclusion, mergeState, hold) => {
    const original = { ...job(21), id: 1021, head_sha: mergeCommit,
      started_at: '2026-11-01T13:30:00Z', completed_at: '2026-11-01T13:40:00Z' };
    const successor = { ...job(41, 'success'), id: 1041, name: original.name, head_sha: mergeCommit,
      started_at: '2026-11-01T13:46:00Z', completed_at: '2026-11-01T13:49:00Z' };
    const f = fixture({ checks: [successor, original], logs: new Map([[21, testLog]]),
      runs: [run(102, conclusion)], mergeState });
    const decision = f.guard();
    expect(decision.hold).toBe(hold);
    if (!hold) expect(decision.line).toMatch(/rerun-green.*rerun-confirmed flake/);
    else if (conclusion !== 'success') expect(decision.reason).toMatch(/main CI is not green/);
    else expect(decision.reason).toMatch(/PR is not CLEAN/);
    expect(f.exec.mock.calls.filter(([, args]) => args.includes('POST'))).toEqual([]);
  });

  it('accepts failure-conclusion test shards only when every failed job log matches the standard allowlist', () => {
    const f = fixture({ checks: [job(21), job(22)], logs: new Map([[21, infraLog], [22, infraLog]]) });
    expectInfraRetry(f.guard());
    expect(f.logReads.map(read => read.id).sort()).toEqual([21, 22]);
  });

  it('holds mixed infrastructure and real test failures, inspecting both failed jobs', () => {
    const f = fixture({ checks: [job(21), job(22)], logs: new Map([[21, infraLog], [22, testLog]]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id).sort()).toEqual([21, 22]);
  });

  it.each([
    ['throwing', new Error('logs unavailable')], ['empty', ''],
    ['object', { message: infraLog }], ['null', null], ['number', 42],
  ])('fails closed and holds when a failed job log is %s', (_name, value) => {
    const f = fixture({ logs: new Map([[21, value]]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toEqual([21]);
  });

  it('uses the newest completed main run, holding a failure even when an older run is green', () => {
    const f = fixture({ runs: [run(102, 'failure'), run(101, 'success', '2026-11-01T13:00:00Z')] });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toEqual([21]);
    expectVisibleDecision(decision, /main CI is not green.*102.*failure/);
  });

  it('keeps the two-retry bound after a third same-head failed_checks removal', () => {
    const f = fixture({ events: [removal(), {
      __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-01T13:46:00Z',
    }, removal('2026-11-01T13:50:00Z'), {
      __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-01T13:51:00Z',
    }, removal('2026-11-01T13:55:00Z')] });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(decision.line).toMatch(/3 removals on this head.*operator must inspect history and enqueue manually/);
    expect(f.logReads).toHaveLength(0);
  });

  it('reads a custom drain setting through readSettings and changes the verdict in both directions', () => {
    settings.drain = { mqInfraSignatures: ['fixture infrastructure outage'] };
    expectInfraRetry(fixture({ logs: new Map([[21, 'fixture infrastructure outage\n']]) }).guard());
    expect(fixture().guard().hold).toBe(true);
  });

  it('resolves and logs the standard allowlist and its provenance through the drain cascade', () => {
    const log = vi.fn();
    const r = readDrainQueueSafety({ env: {}, tool: {}, platform: {}, log });
    expect(r.value.mqInfraSignatures).toEqual(standard);
    expect(r.sources.mqInfraSignatures).toBe('standard');
    expect(log.mock.calls.flat().join('\n')).toMatch(/mqInfraSignatures=.*\(standard\)/);
  });

  it('resolves platform then tool allowlists with effective-value provenance', () => {
    const platform = { mqInfraSignatures: ['platform outage'] }, log = vi.fn();
    const p = readDrainQueueSafety({ env: {}, tool: {}, platform, log });
    expect(p.value.mqInfraSignatures).toEqual(platform.mqInfraSignatures);
    expect(p.sources.mqInfraSignatures).toBe('platform');
    const tool = { mqInfraSignatures: ['tool outage'] };
    const t = readDrainQueueSafety({ env: {}, tool, platform, log });
    expect(t.value.mqInfraSignatures).toEqual(tool.mqInfraSignatures);
    expect(t.sources.mqInfraSignatures).toBe('tool');
    expect(log.mock.calls.flat().join('\n')).toMatch(/mqInfraSignatures=.*tool outage.*\(tool\)/);
  });

  it.each([
    ['empty source', ['']], ['star catch-all', ['.*']], ['anchor catch-all', ['^']],
    ['plus catch-all', ['.+']], ['non-string entry', [42]], ['uncompilable', ['[']],
    ['mixed valid and invalid entries', [...standard, '.*']], ['non-array', 'outage'],
  ])('rejects %s, reports validation, and falls back to the standard default', (_name, value) => {
    const r = readDrainQueueSafety({ env: {}, tool: { mqInfraSignatures: value }, platform: {} });
    expect(r.value.mqInfraSignatures).toEqual(standard);
    expect(r.sources.mqInfraSignatures).toBe('standard');
    expect(r.invalid.join('\n')).toContain('mqInfraSignatures');
    settings.drain = { mqInfraSignatures: value };
    expectInfraRetry(fixture().guard());
    expect(fixture({ logs: new Map([[21, testLog]]) }).guard().hold).toBe(true);
  });

  it('fetches only failed jobs using bounded, throttled exec calls', () => {
    const f = fixture({ checks: [job(21), job(22, 'success'), job(23, 'neutral'), job(24, 'skipped')] });
    expectInfraRetry(f.guard());
    expect(f.logReads.map(read => read.id)).toEqual([21]);
    const opts = f.logReads[0].opts;
    expect(opts.encoding).toBe('utf8');
    expect(opts.throttle).toMatchObject({ maxAttempts: 1 });
    expect(opts.maxBuffer).toBeGreaterThan(0);
    expect(opts.maxBuffer).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThanOrEqual(60_000);
  });

  it('accepts exactly ten matching failed jobs without fetching any job twice', () => {
    const checks = Array.from({ length: MAX_JOBS }, (_, i) => job(21 + i));
    const f = fixture({ checks, logs: new Map(checks.map(check => [check.id, infraLog])) });
    expectInfraRetry(f.guard());
    expect(f.logReads.map(read => read.id).sort()).toEqual(checks.map(check => check.id).sort());
  });

  it('holds above the ten-job bound and returns the operator inspection fallback', () => {
    const checks = Array.from({ length: MAX_JOBS + 1 }, (_, i) => job(21 + i));
    const f = fixture({ checks, logs: new Map(checks.map(check => [check.id, infraLog])) });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(f.logReads.length).toBeLessThanOrEqual(MAX_JOBS);
    expect(decision.reason ?? decision.line).toMatch(/(?:bound|cap|limit|too many).*operator.*inspect/i);
  });

  it('tail-scans oversized returned text: an old prefix signature cannot authorize a retry', () => {
    const f = fixture({ logs: new Map([[21, infraLog + 'x'.repeat(MAX_LOG_BYTES * 2) + '\n' + testLog]]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toEqual([21]);
  });

  it('tail-scans oversized returned text and recognizes a signature at the end', () => {
    // Injected IO may return more than maxBuffer; the classifier must bound its scan too.
    const f = fixture({ logs: new Map([[21, 'x'.repeat(MAX_LOG_BYTES * 2) + '\n' + infraLog]]) });
    expectInfraRetry(f.guard());
    expect(f.logReads.map(read => read.id)).toEqual([21]);
  });

  it('holds on exec output overflow and returns an operator-visible incomplete-log fallback', () => {
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' });
    const f = fixture({ logs: new Map([[21, overflow]]) });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toEqual([21]);
    expect(decision.reason ?? decision.line).toMatch(/(?:log|evidence).*operator.*inspect/i);
  });

  it('returns the accept reason and deciding main run for catch-up outcome visibility', () => {
    const decision = fixture().guard();
    expectInfraRetry(decision);
    expectVisibleDecision(decision, /infra retry 1\/2/);
  });

  it('returns the decline reason and deciding main run on the guard result consumed by merge-ai-prs', () => {
    const decision = fixture({ logs: new Map([[21, testLog]]) }).guard();
    expect(decision.hold).toBe(true);
    expectVisibleDecision(decision, /non-infrastructure.*test-shard-21/);
  });
});
