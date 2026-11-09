import { describe, expect, it, vi } from 'vitest';
import { collectMqFailureEvidence, classifyMqFailureEvidence } from '../mq-failure-evidence.mjs';
import { classifyMqFailureIntake } from '../../conveyor/mq-failure-intake.mjs';

const removal = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
const baseHead = 'c'.repeat(40), mergeHead = 'd'.repeat(40);
const run = { id: 701, event: 'merge_group', head_branch: `gh-readonly-queue/main/pr-42-${baseHead}`, head_sha: mergeHead, conclusion: 'failure' };
const failed = { id: 901, name: 'unit (node 22)', conclusion: 'failure' };
const log = '\u001b[31m FAIL  scripts/lib/__tests__/widget.test.mjs > widget > preserves state\u001b[0m\nAssertionError: expected 2 to be 3\n';

// IO pages explicitly carry completeness; no fixture invokes gh or reads live state.
function fixture() {
  return {
    listRuns: vi.fn(async () => ({ runs: [run], complete: true, nextPage: null })),
    isAncestor: vi.fn(async ({ descendant }) => descendant === mergeHead),
    listJobs: vi.fn(async () => ({ jobs: [failed], complete: true, nextPage: null })),
    readJobLog: vi.fn(async () => ({ text: log, complete: true })),
  };
}
const collect = (io, limits) => collectMqFailureEvidence({ removal, io, limits });

describe('mq failure evidence', () => {
  it('binds merge_group branch to PR/head, strips ANSI, and extracts job, test and assertion names', async () => {
    const io = fixture();
    io.listRuns.mockResolvedValue({ runs: [
      { ...run, id: 1, event: 'pull_request' },
      { ...run, id: 2, head_branch: `gh-readonly-queue/main/pr-43-${baseHead}` },
      { ...run, id: 3, head_branch: `gh-readonly-queue/main/pr-42-${baseHead}`, head_sha: 'e'.repeat(40) }, run,
    ], complete: true, nextPage: null });
    const evidence = await collect(io);
    expect(evidence).toEqual({ failedJobs: [failed.name], testFiles: ['scripts/lib/__tests__/widget.test.mjs'],
      assertions: ['FAIL  scripts/lib/__tests__/widget.test.mjs > widget > preserves state', 'AssertionError: expected 2 to be 3'], complete: true });
    expect(io.listRuns).toHaveBeenCalledWith(expect.objectContaining({ repo: removal.repo }));
    expect(io.listJobs).toHaveBeenCalledTimes(1);
    expect(io.listJobs).toHaveBeenCalledWith(expect.objectContaining({ repo: removal.repo, runId: 701, page: 1 }));
    expect(io.readJobLog).toHaveBeenCalledTimes(1);
    expect(io.readJobLog).toHaveBeenCalledWith(expect.objectContaining({ repo: removal.repo, jobId: 901 }));
    expect(JSON.stringify(evidence)).not.toContain('\u001b');
    expect(classifyMqFailureEvidence(evidence)).toBe('real');
  });

  it('paginates jobs and reads every failed job but never a successful job log', async () => {
    const io = fixture();
    io.listJobs.mockImplementation(async ({ page }) => page === 1
      ? { jobs: [{ id: 900, name: 'lint', conclusion: 'success' }, failed], complete: true, nextPage: 2 }
      : { jobs: [{ id: 902, name: 'browser', conclusion: 'failure' }], complete: true, nextPage: null });
    io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === 901 ? log
      : 'FAIL tests/navigation.spec.ts > menu\nAssertionError: missing menu', complete: true }));
    expect(await collect(io)).toMatchObject({ failedJobs: [failed.name, 'browser'],
      testFiles: ['scripts/lib/__tests__/widget.test.mjs', 'tests/navigation.spec.ts'], complete: true });
    expect(io.listJobs.mock.calls.map(([args]) => args.page)).toEqual([1, 2]);
    expect(io.readJobLog.mock.calls.map(([args]) => args.jobId)).toEqual([901, 902]);
  });

  it('paginates runs before concluding no bound run exists', async () => {
    const io = fixture();
    io.listRuns.mockImplementation(async ({ page }) => ({ runs: page === 1 ? [] : [run], complete: true, nextPage: page === 1 ? 2 : null }));
    expect((await collect(io)).complete).toBe(true);
    expect(io.listRuns.mock.calls.map(([args]) => args.page)).toEqual([1, 2]);
  });

  it.each(['expired', 'unparseable', 'truncated', 'one-unreadable-job'])('misparsed/incomplete evidence fails closed: %s', async mode => {
    const io = fixture();
    if (mode === 'expired') io.readJobLog.mockRejectedValue(new Error('410 logs expired'));
    if (mode === 'unparseable') io.readJobLog.mockResolvedValue({ text: 'process exited 1', complete: true });
    if (mode === 'truncated') io.readJobLog.mockResolvedValue({ text: log, complete: false });
    if (mode === 'one-unreadable-job') {
      io.listJobs.mockResolvedValue({ jobs: [failed, { ...failed, id: 902 }], complete: true, nextPage: null });
      io.readJobLog.mockImplementation(async ({ jobId }) => { if (jobId === 902) throw new Error('410'); return { text: log, complete: true }; });
    }
    const evidence = await collect(io);
    expect(evidence.complete).toBe(false);
    expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
  });

  it.each(['no-run', 'history-error', 'incomplete-runs', 'incomplete-jobs'])('refuses unknown binding/history: %s', async mode => {
    const io = fixture();
    if (mode === 'no-run') io.listRuns.mockResolvedValue({ runs: [], complete: true, nextPage: null });
    if (mode === 'history-error') io.listRuns.mockRejectedValue(new Error('unreadable'));
    if (mode === 'incomplete-runs') io.listRuns.mockResolvedValue({ runs: [run], complete: false, nextPage: null });
    if (mode === 'incomplete-jobs') io.listJobs.mockResolvedValue({ jobs: [failed], complete: false, nextPage: null });
    expect((await collect(io)).complete).toBe(false);
  });

  it('classifies explicit runner loss as infra, while real assertions veto infra wording', async () => {
    const io = fixture();
    io.readJobLog.mockResolvedValue({ text: 'The runner has lost communication with the server.', complete: true });
    expect(classifyMqFailureEvidence(await collect(io))).toBe('infra');
    io.readJobLog.mockResolvedValue({ text: `The runner has lost communication with the server.\n${log}`, complete: true });
    expect(classifyMqFailureEvidence(await collect(io))).toBe('real');
  });

  it('bounds pagination and log size; oversized input stays incomplete for fix/operator inspection', async () => {
    const io = fixture();
    io.listJobs.mockImplementation(async ({ page }) => ({ jobs: [failed], complete: true, nextPage: page + 1 }));
    expect((await collect(io, { maxPages: 2, maxLogBytes: 1024 })).complete).toBe(false);
    expect(io.listJobs.mock.calls.length).toBeLessThanOrEqual(2);
    const oversized = fixture();
    oversized.readJobLog.mockResolvedValue({ text: log + 'x'.repeat(1025), complete: true });
    expect((await collect(oversized, { maxPages: 2, maxLogBytes: 1024 })).complete).toBe(false);
  });
});


describe('mq failure per-marker path attribution', () => {
  it('normalises every absolute failure path before declaring evidence complete', async () => {
    const io = fixture();
    io.readJobLog.mockResolvedValue({ text: [
      'FAIL tests/outside.test.mjs > outside', 'AssertionError: expected true',
      'FAIL /workspace/tests/inside.test.mjs > inside', 'AssertionError: expected false',
    ].join('\n'), complete: true });
    expect(await collect(io)).toMatchObject({
      testFiles: ['tests/outside.test.mjs', 'tests/inside.test.mjs'], complete: true,
    });
  });

  it.each(['FAIL unidentified test', 'failure: unidentified test', '\nAssertionError: unidentified test',
    'FAIL /unknown-root/tests/inside.test.mjs > inside',
    'AssertionError: /unknown-root/tests/inside.test.mjs > inside',
    'FAIL tests/other.test.mjs /unknown-root/tests/inside.test.mjs > inside'])('unattributed failure marker prevents completeness: %s', marker => {
    const io = fixture();
    io.readJobLog.mockResolvedValue({ text: `FAIL tests/outside.test.mjs > outside\nAssertionError: expected true\n${marker}`, complete: true });
    return expect(collect(io)).resolves.toMatchObject({
      testFiles: marker.includes('tests/other.test.mjs') ? ['tests/outside.test.mjs', 'tests/other.test.mjs'] : ['tests/outside.test.mjs'],
      complete: false,
    });
  });
});


describe('mq proven failure versus path completeness', () => {
  it('proven real failure with incomplete paths remains real while refresh stays blocked', async () => {
    const io = fixture();
    io.readJobLog.mockResolvedValue({ text: `${log}\nFAIL unidentified failing test\nAssertionError: expected false`, complete: true });
    const evidence = await collect(io);
    expect(evidence).toMatchObject({ complete: false, failureProven: true, failedJobs: [failed.name],
      testFiles: ['scripts/lib/__tests__/widget.test.mjs'] });
    expect(evidence.assertions).toContain('AssertionError: expected false');
    expect(classifyMqFailureEvidence(evidence)).toBe('real');
  });
});


describe('mq merge-group ancestry binding', () => {
  it('accepts the real PR 6499 branch base SHA only after proving PR-head ancestry', async () => {
    const liveRemoval = { repo: 'web-everything/web-everything', pr: 6499, head: 'b61098f219912effa23af28b37bcd63fc0270796' };
    const io = fixture();
    io.listRuns.mockResolvedValue({ runs: [{ ...run, id: 42419082611,
      head_branch: 'gh-readonly-queue/main/pr-6499-2f277907d10c6025a2c5514a87f1d416cbcc3912' }], complete: true, nextPage: null });
    expect(await collectMqFailureEvidence({ removal: liveRemoval, io })).toMatchObject({ complete: true, failedJobs: [failed.name] });
    expect(io.isAncestor).toHaveBeenCalledWith({ repo: liveRemoval.repo, ancestor: liveRemoval.head, descendant: mergeHead });
    expect(io.listJobs).toHaveBeenCalledWith(expect.objectContaining({ runId: 42419082611 }));
  });

  it.each(['non-ancestor', 'throws', 'missing reader', 'unknown proof', 'missing merge SHA', 'malformed branch'])(
    'unverified merge-group ancestry yields empty evidence: %s', async mode => {
      const io = fixture();
      if (mode === 'non-ancestor') io.isAncestor.mockResolvedValue(false);
      if (mode === 'throws') io.isAncestor.mockRejectedValue(new Error('compare unavailable'));
      if (mode === 'missing reader') delete io.isAncestor;
      if (mode === 'unknown proof') io.isAncestor.mockResolvedValue(undefined);
      if (mode === 'missing merge SHA') io.listRuns.mockResolvedValue({ runs: [{ ...run, head_sha: undefined }], complete: true, nextPage: null });
      if (mode === 'malformed branch') io.listRuns.mockResolvedValue({ runs: [{ ...run, head_branch: run.head_branch + '\n' }], complete: true, nextPage: null });
      expect(await collect(io)).toEqual({ failedJobs: [], testFiles: [], assertions: [], complete: false });
      expect(io.listJobs).not.toHaveBeenCalled();
      expect(io.readJobLog).not.toHaveBeenCalled();
    });
});


// ANSI-normalized excerpt copied from PR 6499's test-shard (5) log. Keep this inline and hermetic.
const log6499 = [
  '2026-11-07T22:09:13.9991847Z stderr | scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs > overlay main sync > refuses a passing empty describe suite before publication',
  '2026-11-07T22:09:13.9994023Z overlay-main-sync failed ref=lane/fix step=tests: tests: ambiguous test inventory: TAP leaves differ from typed-test counts; empty suites may be present',
  '2026-11-07T22:09:13.9994810Z ',
  '2026-11-07T22:09:38.2817277Z stderr | scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs > overlay main sync > tests failure preserves structured incomplete report evidence ahead of the output tail',
  '2026-11-07T22:09:38.2824492Z overlay-main-sync failed ref=lane/fix step=tests: tests: command failed or incomplete; operator review required: overlay.test.mjs > suite > structured case | ooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooterfooter',
  '2026-11-07T22:09:38.2829412Z ',
  '2026-11-07T22:09:38.2830984Z stderr | scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs > overlay main sync > tests failure includes stdout diagnostics when stderr is empty and no names are known',
  '2026-11-07T22:09:38.2832320Z overlay-main-sync failed ref=lane/fix step=tests: tests: command failed or incomplete; operator review required: AssertionError: stdout-only diagnostic',
  '2026-11-07T22:09:38.2832805Z ',
  '2026-11-07T22:10:28.2097150Z ❯ scripts/lib/__tests__/delivery-policy.test.mjs > policy journal > serializes two child-process appends with stale lock into intact JSON lines',
  '2026-11-07T22:17:16.4166900Z FAIL  scripts/lib/__tests__/delivery-policy.test.mjs > policy journal > serializes two child-process appends with stale lock into intact JSON lines',
  '2026-11-07T22:17:16.4180960Z AssertionError: expected +0 to be 1 // Object.is equality',
].join('\n');

describe('mq captured-output filtering', () => {
  it('PR 6499 real log excerpt extracts only delivery-policy with complete paths', async () => {
    const io = fixture();
    io.listJobs.mockResolvedValue({ jobs: [{ ...failed, name: 'test-shard (5)' }], complete: true, nextPage: null });
    io.readJobLog.mockResolvedValue({ text: log6499, complete: true });
    const evidence = await collect(io);
    expect(evidence).toMatchObject({ testFiles: ['scripts/lib/__tests__/delivery-policy.test.mjs'],
      failedJobs: ['test-shard (5)'], complete: true });
    expect(evidence.assertions).toContain('AssertionError: expected +0 to be 1 // Object.is equality');
    expect(evidence.assertions.some(line => /stdout-only|overlay|stderr/.test(line))).toBe(false);
    expect(evidence.assertions.some(line => line.startsWith('❯ scripts/lib/__tests__/delivery-policy.test.mjs'))).toBe(true);
  });

  it.each(['stdout', 'stderr'])('a real FAIL after the blank ending a timestamped %s block is still counted', async stream => {
    const io = fixture();
    io.readJobLog.mockResolvedValue({ text: [
      `2026-11-07T22:09:38.2817277Z \u001b[90m${stream}\u001b[2m | scripts/x.test.mjs > logs a fake failure\u001b[0m`,
      '2026-11-07T22:09:38.2824492Z FAIL scripts/phantom.test.mjs > fake',
      '2026-11-07T22:09:38.2824500Z AssertionError: captured diagnostic',
      '2026-11-07T22:09:38.2829412Z ',
      '2026-11-07T22:17:16.4166900Z FAIL tests/real.test.mjs > actual failure',
      '2026-11-07T22:17:16.4180960Z AssertionError: actual failure',
    ].join('\n'), complete: true });
    const evidence = await collect(io);
    expect(evidence).toMatchObject({ testFiles: ['tests/real.test.mjs'], complete: true });
    expect(evidence.assertions.some(line => /phantom|captured|scripts\/x/.test(line))).toBe(false);
  });

  it('captured output alone cannot prove any real failure', async () => {
    const io = fixture();
    io.readJobLog.mockResolvedValue({ text: 'stderr | scripts/x.test.mjs > diagnostic\nFAIL scripts/phantom.test.mjs > fake\nAssertionError: fake', complete: true });
    const evidence = await collect(io);
    expect(evidence).toMatchObject({ testFiles: [], assertions: [], complete: false });
    expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
  });
});


describe('mq derived failed jobs', () => {
  const shard = { id: 901, name: 'test-shard (5)', conclusion: 'failure' };
  const aggregates = [
    { id: 902, name: 'coverage-merge', conclusion: 'failure' },
    { id: 903, name: 'test', conclusion: 'failure' },
  ];
  const shardLog = 'FAIL scripts/lib/__tests__/delivery-policy.test.mjs > policy journal > serializes two child-process appends with stale lock into intact JSON lines\nAssertionError: expected +0 to be 1';
  const aggregateShellLog = [
    '2026-11-07T22:17:17.0000000Z ##[group]Run if [ "failure" != "success" ]; then',
    '2026-11-07T22:17:17.0000001Z if [ "failure" != "success" ]; then',
    '2026-11-07T22:17:17.0000002Z ##[endgroup]',
  ].join('\n');
  function jobsFixture(jobs) {
    const io = fixture();
    io.listJobs.mockResolvedValue({ jobs, complete: true, nextPage: null });
    io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === shard.id ? shardLog
      : 'Some required jobs were not successful.', complete: true }));
    return io;
  }

  it.each(['plain', 'workflow prefix and matrix suffix', 'aggregates first', 'real aggregate shell lines', 'unattributed aggregate status markers'])(
    'PR 6499 shard plus derived jobs stays complete and classifies refresh: %s', async shape => {
      const derived = shape === 'workflow prefix and matrix suffix'
        ? aggregates.map(job => ({ ...job, name: `CI / ${job.name} (node 22)` })) : aggregates;
      const jobs = shape === 'aggregates first' ? [...derived, shard] : [shard, ...derived];
      const io = jobsFixture(jobs);
      if (shape === 'real aggregate shell lines' || shape === 'unattributed aggregate status markers') {
        io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === shard.id ? shardLog
          : aggregateShellLog + '\nSome required jobs were not successful.'
            + (shape === 'unattributed aggregate status markers' ? '\nfailure: upstream shard failed' : ''), complete: true }));
      }
      const evidence = await collect(io);
      expect(evidence).toMatchObject({ complete: true, failedJobs: jobs.map(job => job.name),
        testFiles: ['scripts/lib/__tests__/delivery-policy.test.mjs'] });
      expect(evidence.assertions).toContain('AssertionError: expected +0 to be 1');
      expect(io.readJobLog).toHaveBeenCalledTimes(3);
      expect(classifyMqFailureEvidence(evidence)).toBe('real');
      expect(classifyMqFailureIntake({ ...removal, route: { ...removal, ...evidence, version: 1, stale: false },
        changedFiles: { ...removal, files: ['src/unrelated.mjs'], complete: true } })).toBe('refresh');
    });

  it.each(['lint', 'build', 'unknown job', 'coverage-merge-extra', 'CI / lint (node 22)'])(
    'an unrelated unparsed failed job stays incomplete even alongside a proven shard: %s', async name => {
      const evidence = await collect(jobsFixture([shard, ...aggregates, { id: 904, name, conclusion: 'failure' }]));
      expect(evidence.complete).toBe(false);
      expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
    });

  it.each([{ names: ['coverage-merge'] }, { names: ['test'] }, { names: ['coverage-merge', 'test'] }])(
    'aggregate-only failed jobs cannot certify evidence: $names', async ({ names }) => {
      const evidence = await collect(jobsFixture(names.map((name, index) => ({ id: 902 + index, name, conclusion: 'failure' }))));
      expect(evidence).toMatchObject({ complete: false, testFiles: [], assertions: [] });
      expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
    });

  it('an aggregate cannot borrow assertion evidence from another run', async () => {
    const io = jobsFixture([]);
    io.listRuns.mockResolvedValue({ runs: [run, { ...run, id: 702 }], complete: true, nextPage: null });
    io.listJobs.mockImplementation(async ({ runId }) => ({ jobs: runId === run.id ? [shard] : aggregates, complete: true, nextPage: null }));
    const evidence = await collect(io);
    expect(evidence.complete).toBe(false);
    expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
  });

  it.each(['unreadable', 'truncated'])('a derived job still requires a readable complete log: %s', async mode => {
    const io = jobsFixture([shard, aggregates[0]]);
    io.readJobLog.mockImplementation(async ({ jobId }) => {
      if (jobId === 901) return { text: shardLog, complete: true };
      if (mode === 'unreadable') throw new Error('log unavailable');
      return { text: '', complete: false };
    });
    const evidence = await collect(io);
    expect(evidence.complete).toBe(false);
    expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
  });

  it.each(['coverage-merge', 'test'])('aggregate %s with real assertions is parsed and attributed as a normal job', async name => {
    const io = jobsFixture([shard, { id: 902, name, conclusion: 'failure' }]);
    io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === shard.id ? shardLog
      : aggregateShellLog + '\nFAIL tests/aggregate.test.mjs > reports assertion\nAssertionError: expected true', complete: true }));
    const evidence = await collect(io);
    expect(evidence).toMatchObject({ complete: true, failedJobs: [shard.name, name],
      testFiles: ['scripts/lib/__tests__/delivery-policy.test.mjs', 'tests/aggregate.test.mjs'] });
    expect(evidence.assertions).toContain('FAIL tests/aggregate.test.mjs > reports assertion');
    expect(evidence.assertions).toContain('AssertionError: expected true');
  });

  it('an aggregate with unattributed real assertions cannot use the exemption', async () => {
    const io = jobsFixture([shard, aggregates[0]]);
    io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === shard.id ? shardLog
      : aggregateShellLog + '\nFAIL unidentified test\nAssertionError: expected true', complete: true }));
    expect(await collect(io)).toMatchObject({ complete: false, failureProven: true,
      testFiles: ['scripts/lib/__tests__/delivery-policy.test.mjs'],
      assertions: expect.arrayContaining(['FAIL unidentified test', 'AssertionError: expected true']) });
  });

  it('unknown lint with only the aggregate shell noise remains incomplete', async () => {
    const io = jobsFixture([shard, ...aggregates, { id: 904, name: 'lint', conclusion: 'failure' }]);
    io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === shard.id ? shardLog
      : jobId === 904 ? aggregateShellLog : 'Some required jobs were not successful.', complete: true }));
    const evidence = await collect(io);
    expect(evidence.failedJobs).toContain('lint');
    expect(evidence.complete).toBe(false);
    expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
  });

  it('aggregate-only shell noise cannot certify complete evidence', async () => {
    const io = jobsFixture(aggregates);
    io.readJobLog.mockResolvedValue({ text: aggregateShellLog, complete: true });
    const evidence = await collect(io);
    expect(evidence).toMatchObject({ complete: false, testFiles: [], assertions: [] });
    expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
  });

  it.each(['coverage-merge', 'test'])(
    'independent aggregate error prevents refresh: %s', async name => {
      const io = jobsFixture([shard, { id: 902, name, conclusion: 'failure' }]);
      io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === shard.id ? shardLog
        : 'Error: ENOENT: missing coverage artifact', complete: true }));
      const evidence = await collect(io);
      expect(evidence.complete).toBe(false);
      expect(classifyMqFailureIntake({ ...removal, route: { ...removal, ...evidence, version: 1, stale: false },
        changedFiles: { ...removal, files: ['src/unrelated.mjs'], complete: true } })).toBe('fix');
    });

  it.each(['', aggregateShellLog, 'Some required jobs were not successful.\nError: ENOENT: missing coverage artifact',
    'Some required jobs were not successful.\nartifact merge unexpectedly terminated'])(
    'aggregate exemption refuses missing or contradictory upstream-only proof: %j', async text => {
      const io = jobsFixture([shard, aggregates[0]]);
      io.readJobLog.mockImplementation(async ({ jobId }) => ({ text: jobId === shard.id ? shardLog : text, complete: true }));
      const evidence = await collect(io);
      expect(evidence.complete).toBe(false);
      expect(classifyMqFailureIntake({ ...removal, route: { ...removal, ...evidence, version: 1, stale: false },
        changedFiles: { ...removal, files: ['src/unrelated.mjs'], complete: true } })).toBe('fix');
    });

  it('an aggregate cannot borrow infrastructure wording as a parsed test assertion', async () => {
    const io = jobsFixture([shard, aggregates[0]]);
    io.readJobLog.mockResolvedValue({ text: '', complete: true });
    io.readJobLog.mockResolvedValueOnce({ text: 'The runner has lost communication with the server.', complete: true });
    const evidence = await collect(io);
    expect(evidence.complete).toBe(false);
    expect(classifyMqFailureEvidence(evidence)).toBe('unknown');
  });
});

// #6499 regression (R772): real lines from the merge-group run's test-shard (5), coverage-merge and test logs.
describe('mq failure evidence: real #6499 log shapes', () => {
  const shardLog = [
    'list=$(node scripts/ci/shard-assign.mjs --suite=unit --group=covered --shard=5/9) || { echo "::error::shard-assign failed; refusing to run an unfiltered suite"; exit 1; }',
    ' ❯ scripts/lib/__tests__/delivery-policy.test.mjs  (187 tests | 1 failed) 34228ms'.trim(),
    '❯ scripts/lib/__tests__/delivery-policy.test.mjs > policy journal > serializes two child-process appends with stale lock into intact JSON lines',
    'probation-build-run #4291 [codex]: escalated-needs-human — already-done landing failed: landOne: cited commit is on main',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    'FAIL  scripts/lib/__tests__/delivery-policy.test.mjs > policy journal > serializes two child-process appends with stale lock into intact JSON lines',
    'AssertionError: expected +0 to be 1 // Object.is equality',
    '❯ scripts/lib/__tests__/delivery-policy.test.mjs:1203:75',
    'Test Files  1 failed | 160 passed (161)',
    'Tests  1 failed | 7581 passed (7582)',
  ].join('\n');
  const ghAggregate = (annotation) => ['##[group]Run if [ "failure" != "success" ]; then', 'if [ "failure" != "success" ]; then',
    `  echo "::error::${annotation}"`, '  exit 1', 'fi', '##[endgroup]', `##[error]${annotation}`,
    '##[error]Process completed with exit code 1.'].join('\n');
  const jobs = [{ id: 901, name: 'test-shard (5)', conclusion: 'failure' },
    { id: 902, name: 'coverage-merge', conclusion: 'failure' }, { id: 903, name: 'test', conclusion: 'failure' }];
  const io = (logs) => ({ ...fixture(), listJobs: vi.fn(async () => ({ jobs, complete: true, nextPage: null })),
    readJobLog: vi.fn(async ({ jobId }) => ({ text: logs[jobId], complete: true })) });

  it('ordinary lines containing failed/Failed are not unattributed failure markers', async () => {
    const evidence = await collect(io({ 901: shardLog, 902: ghAggregate('Unit shards did not succeed; refusing incomplete coverage.'),
      903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence).toMatchObject({ complete: true, failedJobs: ['test-shard (5)', 'coverage-merge', 'test'],
      testFiles: ['scripts/lib/__tests__/delivery-policy.test.mjs'] });
  });
  it('a hosted aggregate log with an extra unrelated ##[error] stays incomplete', async () => {
    const evidence = await collect(io({ 901: shardLog,
      902: `${ghAggregate('Unit shards did not succeed; refusing incomplete coverage.')}\n##[error]ENOENT: coverage artifact missing`,
      903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence.complete).toBe(false);
  });
  it.each(['Error: ENOENT: missing artifact', 'runner: FAIL unidentified test', 'failure: independent artifact failure'])(
    'a hosted aggregate log carrying independent failure text %j never authorizes refresh', async extra => {
      const evidence = await collect(io({ 901: shardLog,
        902: `${ghAggregate('Unit shards did not succeed; refusing incomplete coverage.')}\n${extra}`,
        903: ghAggregate('Unit shards did not succeed.') }));
      expect(evidence.complete).toBe(false);
    });
  it.each(['TypeError: Cannot read properties of undefined', 'artifact merge: Error: ENOENT: missing artifact'])(
    'hosted aggregate log with embedded error text %j never authorizes refresh', async extra => {
      const evidence = await collect(io({ 901: shardLog,
        902: `${ghAggregate('Unit shards did not succeed; refusing incomplete coverage.')}\n${extra}`,
        903: ghAggregate('Unit shards did not succeed.') }));
      expect(evidence.complete).toBe(false);
    });
  it('an uppercase FAILED failure line in a changed file is still collected', async () => {
    const evidence = await collect(io({ 901: `${shardLog}\nFAILED tests/inside.test.mjs > breaks`,
      902: ghAggregate('Unit shards did not succeed; refusing incomplete coverage.'), 903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence.testFiles).toContain('tests/inside.test.mjs');
  });
  it('an unterminated captured-output block cannot hide a later real FAIL', async () => {
    const text = `FAIL  scripts/lib/__tests__/delivery-policy.test.mjs > a\nAssertionError: x\nstderr | scripts/a.test.mjs > passing\nnoise without blank line\nFAIL  tests/inside.test.mjs > breaks\nAssertionError: y\nTest Files  1 failed | 1 passed (2)`;
    const evidence = await collect(io({ 901: text, 902: ghAggregate('Unit shards did not succeed; refusing incomplete coverage.'),
      903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence.complete).toBe(false);
  });
  it('hosted aggregate with an independent diagnostic (artifact merge unexpectedly terminated) never authorizes refresh', async () => {
    const evidence = await collect(io({ 901: shardLog,
      902: `${ghAggregate('Unit shards did not succeed; refusing incomplete coverage.')}\nartifact merge unexpectedly terminated`,
      903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence.complete).toBe(false);
  });
  it('a captured block that swallows a FAIL before a later blank is caught by the runner summary totals', async () => {
    const text = ['FAIL  scripts/lib/__tests__/delivery-policy.test.mjs > a', 'AssertionError: x',
      'stderr | scripts/a.test.mjs > passing', 'FAIL  tests/inside.test.mjs > breaks', 'AssertionError: y', '',
      'Test Files  2 failed | 1 passed (3)', 'Tests  2 failed | 5 passed (7)'].join('\n');
    const evidence = await collect(io({ 901: text, 902: ghAggregate('Unit shards did not succeed; refusing incomplete coverage.'),
      903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence.complete).toBe(false);
  });
  it('an embedded labelled lowercase failure line is collected so a changed file blocks refresh', async () => {
    const evidence = await collect(io({ 901: `${shardLog}\nrunner: failure tests/inside.test.mjs > breaks`,
      902: ghAggregate('Unit shards did not succeed; refusing incomplete coverage.'), 903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence.testFiles).toContain('tests/inside.test.mjs');
  });
  it('vitest unhandled errors (stackless rejection) keep evidence incomplete so refresh is never chosen', async () => {
    const evidence = await collect(io({ 901: `${shardLog}\nUnhandled Rejection\nErrors  1 error`,
      902: ghAggregate('Unit shards did not succeed; refusing incomplete coverage.'), 903: ghAggregate('Unit shards did not succeed.') }));
    expect(evidence.complete).toBe(false);
  });
});
