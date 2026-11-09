import { describe, expect, it, vi } from 'vitest';
import { collectMqFailureEvidence, classifyMqFailureEvidence } from '../mq-failure-evidence.mjs';

const removal = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
const run = { id: 701, event: 'merge_group', head_branch: `gh-readonly-queue/main/pr-42-${removal.head}`, conclusion: 'failure' };
const failed = { id: 901, name: 'unit (node 22)', conclusion: 'failure' };
const log = '\u001b[31m FAIL  scripts/lib/__tests__/widget.test.mjs > widget > preserves state\u001b[0m\nAssertionError: expected 2 to be 3\n';

// IO pages explicitly carry completeness; no fixture invokes gh or reads live state.
function fixture() {
  return {
    listRuns: vi.fn(async () => ({ runs: [run], complete: true, nextPage: null })),
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
      { ...run, id: 2, head_branch: `gh-readonly-queue/main/pr-43-${removal.head}` },
      { ...run, id: 3, head_branch: `gh-readonly-queue/main/pr-42-${'b'.repeat(40)}` }, run,
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
