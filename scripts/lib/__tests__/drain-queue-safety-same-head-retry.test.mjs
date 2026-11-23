// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mqSameHeadGuard, decideMqSameHead, createMqSameHeadRefreshStore } from '../drain-queue-safety.mjs';
import unreadableBreak from '../../conveyor/soak/breaks/mq-unreadable-log-single-retry.mjs';

const repo = 'fixture/drain', pr = 7284, head = 'a'.repeat(40), merge = 'b'.repeat(40);
const removed = (testedHead = head) => ({ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
  beforeCommit: { oid: merge, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: testedHead }] } },
  createdAt: '2026-11-21T12:00:00Z' });
const added = { __typename: 'AddedToMergeQueueEvent' };

function fixture(test) {
  const dir = mkdtempSync(join(tmpdir(), 'mq-single-refresh-'));
  const path = join(dir, 'ledger.json');
  const f = { path, head, events: [removed()], text: new Error('HTTP 404'), logs: [], writes: [], log: vi.fn() };
  const exec = vi.fn((file, args, options) => {
    expect(file).toBe('gh');
    expect(options.env.WE_GH_READ_MEMO_DIR).toBeUndefined();
    expect(options.throttle.env.WE_GH_READ_MEMO_DIR).toBeUndefined();
    if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: {
      pullRequest: { headRefOid: f.head, isInMergeQueue: false } } } });
    if (args.some(a => a.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: {
      timelineItems: { nodes: f.events, pageInfo: { hasPreviousPage: false } } } } } });
    if (args.includes('PUT')) { if (f.requestError) throw f.requestError; f.writes.push(args); if (f.afterHead) f.head = f.afterHead; return '{}'; }
    if (args.includes('headRefOid') && f.postReadFails) throw new Error('post-write read unavailable');
    if (args[0] === 'pr' && f.readError) throw f.readError;
    if (args.includes('labels,headRefOid') && f.labeled) return JSON.stringify(f.labeled);
    if (args[0] === 'pr' && f.live) return JSON.stringify(f.live);
    if (args[0] === 'pr') return JSON.stringify({ headRefOid: f.head, mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], labels: ['ready-to-merge'] });
    const endpoint = args.find(a => a.startsWith('repos/'));
    if (endpoint?.includes('/actions/runs?head_sha=') && f.runs instanceof Error) throw f.runs;
    if (endpoint?.includes('/actions/runs?head_sha=') && f.runs) return JSON.stringify(f.runs);
    if (endpoint?.includes('/actions/runs?head_sha=')) return JSON.stringify({ total_count: 1,
      workflow_runs: [{ created_at: '2099-01-01T00:00:00Z' }] });
    if (endpoint?.includes('/check-runs') && f.checksOverride) return JSON.stringify(f.checksOverride);
    if (endpoint?.includes('/check-runs')) return JSON.stringify({ total_count: 1, check_runs: [{
      id: 12, name: 'test-shard (1)', head_sha: merge, status: 'completed', conclusion: 'failure',
      details_url: `https://github.com/${repo}/actions/runs/800/job/901` }] });
    if (endpoint?.includes('/commits/')) return JSON.stringify({ sha: f.head,
      parents: f.afterHead === f.head ? [{ sha: head }, { sha: 'c'.repeat(40) }] : [{ sha: 'c'.repeat(40) }] });
    if (endpoint?.endsWith('/logs')) {
      f.logs.push({ args, options });
      expect(args).toContain('--allow-escape-sequences');
      if (f.text instanceof Error) throw f.text;
      return f.text;
    }
    throw new Error(`unexpected IO: ${args.join(' ')}`);
  });
  f.run = (options = {}) => mqSameHeadGuard({ repo, pr, head: f.head, exec, log: f.log,
    refresh: { store: createMqSameHeadRefreshStore({ path }), allow: () => true }, ...options });
  try { test(f); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('same-head failures never authorize re-enqueue from logs', () => {
  const decisions = f => f.log.mock.calls.map(([line]) => line)
    .filter(line => line.startsWith('mq-same-head-refresh-decision:'));
  const prefix = `mq-same-head-refresh-decision: #${pr} head ${head}`;

  it.each([
    ['head moved', f => { f.live = { headRefOid: 'd'.repeat(40) }; }],
    ['not CLEAN', f => { f.live = { headRefOid: head, mergeStateStatus: 'BEHIND' }; }],
    ['checks not green', f => { f.live = { headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: [] }; }],
    ['checks unreadable', f => { f.readError = new Error('offline'); }],
    ['labels unreadable', f => { f.labeled = { headRefOid: head, labels: null }; }],
    ['blocking label', f => { f.labeled = { headRefOid: head, labels: ['review:changes'] }; }],
  ])('logs every repeated %s evaluation while preserving the deduplicated skip', (reason, arrange) => fixture(f => {
    arrange(f);
    const options = { repo: `fixture/repeated-${reason.replaceAll(' ', '-')}` };
    f.run(options); f.run(options);
    expect(decisions(f)).toEqual(Array(2).fill(`${prefix} retry=false executed=unknown spent=false outcome=skipped reason=${reason}`));
    expect(f.log.mock.calls.filter(([line]) => line === `mq-same-head-refresh: #${pr} head ${head} — skipped (${reason})`).length).toBe(1);
    expect(f.writes).toHaveLength(0);
  }));
  it.each([
    ['authorization refused or unreadable; inspect red-team evidence and workflow/human approval before retrying', { allow: () => false }],
    ['state unavailable; inspect shared refresh ledger and lock before retrying', { store: undefined }],
    ['claim lost', { store: { has: () => false, claim: () => false } }],
    ['already requested', null],
  ])('logs every repeated refresh skip: %s', (reason, refresh) => fixture(f => {
    let reads = 0;
    refresh ??= { store: { has: () => ++reads % 2 === 0 } };
    const options = { refresh: { store: createMqSameHeadRefreshStore({ path: f.path }), allow: () => true, ...refresh } };
    f.run(options); f.run(options);
    expect(decisions(f)).toEqual(Array(2).fill(`${prefix} retry=false executed=unknown spent=false outcome=skipped reason=${reason}`));
    expect(f.writes).toHaveLength(0);
  }));
  it('logs a requested refresh and each subsequent spent fixer hold', () => fixture(f => {
    f.run(); f.run(); f.run();
    expect(decisions(f)).toEqual([
      `${prefix} retry=false executed=unknown spent=false outcome=requested reason=update-branch requested`,
      ...Array(2).fill(`${prefix} retry=false executed=true spent=true outcome=held-fixer reason=single refresh already spent or second same-head failure; hold for fixer`),
    ]);
    expect(f.writes).toHaveLength(1);
  }));
  it('a claimed but never executed head retries instead of being treated as spent', () => fixture(f => {
    const store = createMqSameHeadRefreshStore({ path: f.path });
    store.claim(`${repo}#${pr}@${head}`);
    f.runs = { total_count: 0, workflow_runs: [] };
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'refresh-first' });
    expect(decisions(f)).toEqual([`${prefix} retry=true executed=false spent=false outcome=requested reason=update-branch retried`]);
    expect(f.writes).toHaveLength(1);
    expect(store.has(`${repo}#${pr}@${head}#retry`)).toBe(true);
  }));
  it.each(['ledger', 'runs'])('logs repeated unreadable %s fixer holds with detail', kind => fixture(f => {
    let options = {};
    if (kind === 'ledger') options = { refresh: { store: { has: () => { throw new Error('offline'); } } } };
    else {
      createMqSameHeadRefreshStore({ path: f.path }).claim(`${repo}#${pr}@${head}`);
      f.runs = new Error('offline');
    }
    f.run(options); f.run(options);
    expect(decisions(f)).toHaveLength(2);
    for (const line of decisions(f)) {
      expect(line).toContain('executed=unknown');
      expect(line).toContain(`spent=${kind === 'ledger' ? 'unknown' : 'true'} outcome=held-fixer reason=refresh ${kind === 'ledger' ? 'ledger' : 'run evidence'} unreadable`);
      expect(line).toContain('fixer inspection');
    }
    expect(f.writes).toHaveLength(0);
  }));
  it('logs every real failure routed to fixer', () => fixture(f => {
    f.text = 'AssertionError: expected true';
    f.run(); f.run();
    expect(decisions(f)).toEqual(Array(2).fill(`${prefix} retry=false executed=unknown spent=false outcome=held-fixer reason=real failure observed; route to fixer without refresh`));
    expect(f.writes).toHaveLength(0);
  }));
  it('logs a refused request once and sanitizes the reason', () => fixture(f => {
    f.requestError = new Error('HTTP 422: \x1bhead\x9bmoved\u2028');
    f.run();
    expect(decisions(f)).toEqual([`${prefix} retry=false executed=unknown spent=false outcome=skipped reason=update-branch refused (HTTP 422:  head moved )`]);
  }));
  it('logs unavailable refresh evaluation and leaves dry-run decisions silent', () => fixture(f => {
    f.run({ refresh: undefined });
    expect(decisions(f)).toEqual([`${prefix} retry=false executed=unknown spent=false outcome=not-evaluated reason=refresh unavailable`]);
    f.log.mockClear();
    f.run({ dryRun: true });
    createMqSameHeadRefreshStore({ path: f.path }).claim(`${repo}#${pr}@${head}`);
    f.run({ dryRun: true });
    expect(decisions(f)).toEqual([]);
    expect(f.writes).toHaveLength(0);
  }));
  it('initializes and cleans up the fixture when TMPDIR is unset', () => {
    // Keep scratch in the task's temp root while exercising the OS fallback.
    const root = tmpdir();
    const previousTmpdir = process.env.TMPDIR;
    vi.stubEnv('TMP', root);
    vi.stubEnv('TEMP', root);
    delete process.env.TMPDIR;
    try {
      expect(process.env.TMPDIR).toBeUndefined();
      let ledger;
      fixture(f => {
        ledger = f.path;
        expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'refresh-first' });
        expect(f.writes).toHaveLength(1);
        expect(existsSync(ledger)).toBe(true);
      });
      expect(existsSync(ledger)).toBe(false);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      vi.unstubAllEnvs();
    }
  });
  it.each(['infra', 'exact-test', 'quarantined', 'rerun-green', 'cancelled-regroup', 'unreadable-log'])(
    'ignores retired %s retry evidence and holds admission', infra => {
      expect(decideMqSameHead({ repo, pr, head, timeline: { nodes: [removed()], hasPreviousPage: false },
        retryEvidence: { infra, mainGreen: true, mergeState: 'CLEAN' } }).hold).toBe(true);
    });
  it.each(['AssertionError: expected true', ' FAIL tests/widget.test.mjs > keeps state',
    'Unhandled Rejection: broken', 'Errors 1 error', 'Error: assertion failed',
    '2026-11-21T12:00:00Z ##[error]AssertionError: expected true',
    '2026-11-21T12:00:00Z  FAIL tests/widget.test.mjs > keeps state',
    'Expected: true', 'Received: false', 'TypeError: cannot read property',
    ' × suite > keeps state', '⎯⎯⎯ Unhandled Rejection ⎯⎯⎯'])(
    'real failure %s goes to fixer with zero refreshes across repeated failures', text => fixture(f => {
      f.text = `${text}\n${'x'.repeat(70000)}\nfatal: could not fetch deadbeef from promisor remote`;
      expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
      f.events.push(added, removed());
      expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
      expect(f.writes).toHaveLength(0);
    }));
  it('infrastructure log containing Run npm test gets one refresh before fixer', () => fixture(f => {
    f.text = '2026-11-21T12:00:00Z ##[group]Run npm test\n'
      + '2026-11-21T12:00:00Z npm test\n'
      + '2026-11-21T12:00:01Z The runner has lost communication with the server.\n';
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'refresh-first' });
    expect(f.writes).toHaveLength(1);
    f.events.push(added, removed());
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
    expect(f.writes).toHaveLength(1);
  }));
  it.each(['Run node --test tests/assert.test.mjs', 'Run npm test -- --testNamePattern="expected state"'])(
    'infrastructure log with command header %s does not prove an assertion failure', header => fixture(f => {
      f.text = `${header}\nThe runner has lost communication with the server.\n`;
      expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'refresh-first' });
      expect(f.writes).toHaveLength(1);
    }));
  it.each([new Error('HTTP 404'), new Error('maxBuffer exceeded'), '', null,
    '\x1b]0;title\x07', '\x1b[Errors 1 error', '\x9bFAIL tests/widget.test.mjs'])(
    'unreadable or normalization-failed log %j permits one refresh, then holds for fixer', text => fixture(f => {
      f.text = text;
      expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'refresh-first' });
      expect(f.writes).toHaveLength(1);
      f.events.push(added, removed());
      expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
      expect(f.writes).toHaveLength(1);
    }));
  it('a second same-head failure cannot refresh even with an empty ledger', () => fixture(f => {
    f.events.push(added, removed());
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
    expect(f.writes).toHaveLength(0);
  }));
  it('two manual re-enqueues never renew the exact-head refresh budget', () => fixture(f => {
    expect(f.run({ dryRun: true })).toMatchObject({ hold: true, retriesExhausted: false });
    expect(f.run()).toMatchObject({ hold: true, retriesExhausted: true });
    expect(f.writes).toHaveLength(1);
    f.events.push(added, removed());
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer', retriesExhausted: true });
    f.events.push(added, removed());
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer', retriesExhausted: true });
    expect(f.writes).toHaveLength(1);
  }));
  it('shared ledger blocks another pass and store; a new PR-authored head gets one refresh', () => fixture(f => {
    f.run(); f.run();
    expect(f.writes).toHaveLength(1);
    f.head = 'd'.repeat(40); f.events.push(removed(f.head));
    f.run(); f.run();
    expect(f.writes).toHaveLength(2);
    expect(f.writes.map(args => args.at(-1))).toEqual([`expected_head_sha=${head}`, `expected_head_sha=${f.head}`]);
  }));
  it('re-reads after update and binds the generated refresh head to the spent ledger', () => fixture(f => {
    f.afterHead = 'e'.repeat(40);
    f.run();
    f.events.push(removed(f.head));
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
    expect(f.writes).toHaveLength(1);
  }));
  it('recovers spent successor binding after an unreadable post-write head read', () => fixture(f => {
    f.afterHead = 'e'.repeat(40); f.postReadFails = true;
    f.run();
    f.events.push(removed(f.head));
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
    expect(f.writes).toHaveLength(1);
  }));
  it('dry-run diagnoses a spent successor without writing its ledger binding', () => fixture(f => {
    f.afterHead = 'e'.repeat(40); f.postReadFails = true;
    f.run();
    f.events.push(removed(f.head));
    expect(f.run({ dryRun: true })).toMatchObject({ hold: true, recoveryAction: 'fixer' });
    expect(createMqSameHeadRefreshStore({ path: f.path }).has(`${repo}#${pr}@${f.head}`)).toBe(false);
    expect(f.writes).toHaveLength(1);
  }));
  it('oversized failed-job evidence gets one refresh and an explicit fixer fallback', () => fixture(f => {
    f.checksOverride = { total_count: 11, check_runs: Array.from({ length: 11 }, (_, i) => ({
      id: i + 1, head_sha: merge, status: 'completed', conclusion: 'failure' })) };
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'refresh-first', reason: expect.stringMatching(/10-job limit.*fixer/) });
    expect(f.writes).toHaveLength(1);
    expect(f.logs).toHaveLength(0);
    expect(f.run()).toMatchObject({ hold: true, recoveryAction: 'fixer' });
    expect(f.writes).toHaveLength(1);
  }));
  it('normalizes the full Actions job log with bounded IO, using job rather than check ID', () => fixture(f => {
    f.text = '\x1b[31mAssertionError: expected true\x1b[0m';
    f.run();
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0].args.at(-1)).toBe(`repos/${repo}/actions/jobs/901/logs`);
    expect(f.logs[0].options).toMatchObject({ timeout: 60000, maxBuffer: 4 * 1024 * 1024, throttle: { maxAttempts: 1 } });
    expect(f.writes).toHaveLength(0);
  }));
  it('retains the unreadable-log soak break', async () => {
    expect((await unreadableBreak.run()).violations).toEqual([]);
  });
});
