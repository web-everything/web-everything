import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, relative } from 'node:path';
import { decidePublish, createGhPublishIo } from '../review-hold-io.mjs';
import * as exports from '../review-hold-io.mjs';

const HEAD = 'a'.repeat(40);
const PREFIX = 'review-gate-verdict/v1 ';
function gateClosure(entry = 'scripts/check-review-gate.mjs', seen = new Set()) {
  const file = resolve(entry);
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const imports = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"](\.[^'"]+)['"]/g; // static edges: CI never takes the lazy --pr reader
  for (const match of source.matchAll(imports)) gateClosure(resolve(dirname(file), match[1]), seen);
  return seen;
}
// One valid GitHub world. IO methods return raw REST shapes, never a judgment.
function world() {
  const input = { repo: 'o/n', pr: 7, head: HEAD, liveLabels: ['review:pending'], changedFiles: ['docs/example.md'] };
  const pull = { state: 'open', head: { sha: HEAD, repo: { full_name: 'o/n' } }, base: { repo: { full_name: 'o/n' } },
    labels: [{ name: 'review:pending' }], changed_files: 1 };
  const files = [{ filename: 'docs/example.md' }];
  const run = { id: 31, run_number: 8, run_attempt: 1, created_at: '2026-11-16T01:00:00Z',
    event: 'pull_request', path: '.github/workflows/review-gate.yml', head_sha: HEAD,
    repository: { full_name: 'o/n' }, pull_requests: [{ number: 7 }], status: 'completed', conclusion: 'failure' };
  const runs = { total_count: 1, workflow_runs: [run] };
  const verdict = { name: 'review-gate verdict', status: 'completed', conclusion: 'failure' };
  const job = { id: 32, name: 'review-gate', run_id: 31, run_attempt: 1, head_sha: HEAD, status: 'completed', conclusion: 'failure',
    steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, verdict] };
  const jobs = { total_count: 1, jobs: [job] };
  const marker = { v: 1, repo: 'o/n', pr: 7, head: HEAD, runId: 31, runAttempt: 1,
    event: 'pull_request', labels: ['review:pending'], verdict: 'hold', holdLabels: ['review:pending'] };
  const w = { input, pull, files, run, runs, job, jobs, marker };
  w.io = { getPull: vi.fn(async () => pull), listPullFiles: vi.fn(async () => files), listGateRuns: vi.fn(async () => runs),
    listAttemptJobs: vi.fn(async () => jobs), getJobLog: vi.fn(async () => PREFIX + JSON.stringify(marker)) };
  w.decide = () => decidePublish(input, w.io);
  return w;
}
const no = async w => {
  const result = await w.decide();
  expect(result).toEqual({ publish: false, reason: expect.any(String) });
  expect(result.reason.length).toBeGreaterThan(0);
  expect(Object.isFrozen(result)).toBe(true);
};
const yes = async (w, reason = 'verified-hold') => expect(await w.decide()).toEqual({ publish: true, reason });
const addRun = (w, over) => { w.runs.workflow_runs.push({ ...structuredClone(w.run), id: 41, run_number: 9,
  created_at: '2026-11-16T02:00:00Z', ...over }); w.runs.total_count++; };
function clear(w) {
  w.input.liveLabels = []; w.pull.labels = []; w.marker.labels = []; w.marker.holdLabels = []; w.marker.verdict = 'clear';
  w.run.conclusion = w.job.conclusion = w.job.steps[1].conclusion = 'success';
}

describe('decidePublish v2', () => {
  it('world', async () => { await yes(world()); });
  it('io-null-sweep', async () => {
    for (const method of Object.keys(world().io)) for (const value of [null, undefined, {}, [], '', new Error('offline')]) {
      const w = world(); w.io[method].mockImplementation(async () => { if (value instanceof Error) throw value; return value; });
      await no(w);
    }
  });
  it('malformed-run-sweep', async () => {
    const invalid = { id: [0, '31'], run_number: [0, '8'], run_attempt: [0, '1'], created_at: ['invalid', 7],
      event: [null, 7], path: [null, 7], head_sha: [null, 7], status: [null, 7], pull_requests: [null, {}], repository: [null, {}] };
    for (const filtered of [false, true]) for (const [key, values] of Object.entries(invalid)) for (const value of [undefined, ...values]) {
      const w = world(); if (filtered) addRun(w, { path: 'other.yml' });
      const row = w.runs.workflow_runs.at(-1); if (value === undefined) delete row[key]; else row[key] = value;
      await no(w);
    }
  });
  it('pages-short-of-total_count', async () => { const w = world(); w.runs.total_count = 2; await no(w); });
  it('duplicate-run-id', async () => { const w = world(); addRun(w, { id: 31 }); await no(w); });
  it('shadow-other-path-green', async () => { const w = world(); w.job.steps[0].conclusion = 'failure'; addRun(w, { path: 'other.yml', conclusion: 'success' }); await no(w); expect(w.io.listAttemptJobs).toHaveBeenCalledWith(31, 1); });
  it('shadow-other-repo-green', async () => { const w = world(); w.job.steps[0].conclusion = 'failure'; addRun(w, { repository: { full_name: 'other/repo' }, conclusion: 'success' }); await no(w); expect(w.io.listAttemptJobs).toHaveBeenCalledWith(31, 1); });
  it('io-has-no-check-runs-method', async () => { const w = world(); expect(Object.keys(w.io).sort()).toEqual(['getJobLog', 'getPull', 'listAttemptJobs', 'listGateRuns', 'listPullFiles']); await yes(w); });
  it('newer-in-progress-over-failure', async () => { const w = world(); addRun(w, { status: 'in_progress', conclusion: null }); await no(w); });
  it('newer-in-progress-over-success', async () => { const w = world(); clear(w); addRun(w, { status: 'in_progress', conclusion: null }); await no(w); });
  it('latest-cancelled', async () => { const w = world(); w.run.conclusion = 'cancelled'; await no(w); });
  it('dispatch-newest-is-ignored', async () => { const w = world(); addRun(w, { event: 'workflow_dispatch' }); await yes(w); });
  it('dispatch-only-means-no-run', async () => { const w = world(); w.run.event = 'workflow_dispatch'; await no(w); });
  it('marker-event-not-pull_request', async () => { const w = world(); w.marker.event = 'workflow_dispatch'; await no(w); });
  it('gate-file-edit', async () => { const w = world(); w.files[0].filename = w.input.changedFiles[0] = '.github/workflows/review-gate.yml'; await no(w); });
  it('gate-file-renamed-away', async () => { const w = world(); w.files[0].previous_filename = '.github/workflows/review-gate.yml'; w.input.changedFiles.push(w.files[0].previous_filename); await no(w); });
  it('any-dot-github-edit', async () => { const w = world(); w.files[0].filename = w.input.changedFiles[0] = '.github/anything.md'; await no(w); });
  it('script-closure-edit', async () => {
    for (const absolute of gateClosure()) {
      const file = relative(process.cwd(), absolute).replaceAll('\\', '/');
      const w = world(); w.files[0].filename = w.input.changedFiles[0] = file; await no(w);
    }
  });
  it('files-count-mismatch', async () => { const w = world(); w.pull.changed_files = 2; await no(w); });
  it('files-3000-cap', async () => { const w = world(); w.files.splice(0, 1, ...Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md` }))); w.pull.changed_files = 3000; w.input.changedFiles = w.files.map(f => f.filename); await no(w); });
  it('caller-files-differ', async () => { const w = world(); w.input.changedFiles = ['docs/other.md']; await no(w); });
  it('omitted-caller-files-use-complete-api-list-including-renames', async () => {
    const w = world(); delete w.input.changedFiles;
    w.files[0].previous_filename = 'docs/old.md';
    await yes(w);
    expect(w.io.listPullFiles).toHaveBeenCalledTimes(1);
  });
  it('omitted-caller-files-still-refuse-gate-edits-and-renames', async () => {
    for (const key of ['filename', 'previous_filename']) {
      const w = world(); delete w.input.changedFiles;
      w.files[0][key] = '.github/workflows/review-gate.yml';
      expect(await w.decide()).toEqual({ publish: false, reason: 'gate-file-edit' });
    }
  });
  it('omitted-caller-files-refuse-incomplete-malformed-and-capped-api-evidence', async () => {
    for (const patch of [{ changed_files: 2 }, { changed_files: 3000 }, { changed_files: undefined }]) {
      const w = world(); delete w.input.changedFiles; Object.assign(w.pull, patch);
      expect(await w.decide()).toEqual({ publish: false, reason: 'files-incomplete' });
    }
    for (const files of [null, [{}], [{ filename: 'docs/example.md', previous_filename: '' }]]) {
      const w = world(); delete w.input.changedFiles; w.io.listPullFiles.mockResolvedValue(files);
      expect(await w.decide()).toEqual({ publish: false, reason: 'files-incomplete' });
    }
  });
  it('omitted-caller-files-refuse-read-errors-and-head-races', async () => {
    const w = world(); delete w.input.changedFiles;
    w.io.listPullFiles.mockRejectedValue(new Error('offline'));
    expect(await w.decide()).toEqual({ publish: false, reason: 'unreadable-evidence' });
    const moved = world(); delete moved.input.changedFiles;
    moved.io.getPull.mockResolvedValueOnce(moved.pull).mockResolvedValue({ ...moved.pull, head: { sha: 'b'.repeat(40) } });
    expect(await moved.decide()).toEqual({ publish: false, reason: 'pull-changed' });
  });
  it('success-no-verdict-step', async () => { const w = world(); clear(w); w.job.steps.pop(); await no(w); });
  it('verdict-step-skipped', async () => { const w = world(); w.job.steps[1].conclusion = 'skipped'; await no(w); });
  it('bootstrap-success-no-marker', async () => { const w = world(); clear(w); w.io.getJobLog.mockResolvedValue('not bootstrapped'); await no(w); });
  it('two-markers', async () => { const w = world(); w.io.getJobLog.mockResolvedValue(`${PREFIX}${JSON.stringify(w.marker)}\n${PREFIX}${JSON.stringify(w.marker)}`); await no(w); });
  it('marker-oversize-log', async () => { const w = world(); w.io.getJobLog.mockResolvedValue('x'.repeat(1024 * 1024) + '\n' + PREFIX + JSON.stringify(w.marker)); await no(w); });
  it('attempt2-infra-fail-attempt1-success', async () => {
    const w = world(); w.run.run_attempt = w.job.run_attempt = w.marker.runAttempt = 2;
    w.job.steps[0].conclusion = 'failure';
    w.io.listAttemptJobs.mockImplementation(async (_id, attempt) => attempt === 2 ? w.jobs : { total_count: 1, jobs: [{ ...w.job, run_attempt: 1, conclusion: 'success' }] });
    await no(w); expect(w.io.listAttemptJobs.mock.calls).toEqual([[31, 2]]);
  });
  it('attempt1-fail-attempt2-clear', async () => { const w = world(); clear(w); w.run.run_attempt = w.job.run_attempt = w.marker.runAttempt = 2;
    w.io.listAttemptJobs.mockImplementation(async (_id, attempt) => attempt === 2 ? w.jobs : { total_count: 1, jobs: [{ ...w.job, run_attempt: 1, conclusion: 'failure' }] });
    await yes(w, 'verified-clear'); expect(w.io.listAttemptJobs.mock.calls).toEqual([[31, 2]]); });
  it('rerun-of-old-run-has-highest-ids', async () => { const w = world(); addRun(w, { id: 999, run_number: 7, run_attempt: 4, created_at: '2026-11-16T00:00:00Z', updated_at: '2099-01-01T00:00:00Z' }); await yes(w); expect(w.io.listAttemptJobs).toHaveBeenCalledWith(31, 1); });
  it('run_number-tie', async () => { const w = world(); addRun(w, { run_number: 8 }); await no(w); });
  it('created_at-inverted', async () => { const w = world(); addRun(w, { created_at: '2026-11-16T00:00:00Z' }); await no(w); });
  // liveLabelNames is the third export: callers holding provider label rows need the same name projection.
  it('module-exports-exactly-three', () => { expect(Object.keys(exports).sort()).toEqual(['createGhPublishIo', 'decidePublish', 'liveLabelNames']); });
  it('liveLabelNames-projects-names-and-keeps-bad-rows-invalid', async () => {
    expect(exports.liveLabelNames([{ name: 'review:pending', color: 'x' }, 'bug'])).toEqual(['review:pending', 'bug']);
    expect(exports.liveLabelNames([])).toEqual([]);
    for (const bad of [undefined, null, {}, 'review:pending', { labels: [] }]) expect(exports.liveLabelNames(bad)).toBeNull();
    expect(exports.liveLabelNames([{ color: 'x' }, { name: 7 }, null])).toEqual([null, null, null]);
    // A projected bad row fails closed in decidePublish, before any GitHub read.
    const w = world(); w.input.liveLabels = exports.liveLabelNames([{ name: 'review:pending' }, { color: 'x' }]);
    await expect(w.decide()).resolves.toEqual({ publish: false, reason: 'invalid-input' });
    expect(w.io.getPull).not.toHaveBeenCalled();
  });
  it('result-frozen-two-keys', async () => { const result = await world().decide(); expect(Object.isFrozen(result)).toBe(true); expect(Object.keys(result).sort()).toEqual(['publish', 'reason']); });
  it('extra-input-keys-change-nothing', async () => { const w = world(); Object.assign(w.input, { evidence: { verified: true }, seal: true, reviewGate: { state: 'success' } }); await yes(w); });
  it('binding-sweep', async () => {
    for (const [key, value] of Object.entries({ repo: 'other/repo', pr: 8, head: 'b'.repeat(40), runId: 99, runAttempt: 2, labels: [], verdict: 'clear', holdLabels: [], v: 2 })) {
      const w = world(); w.marker[key] = value; await no(w);
    }
  });
  it('live-labels-changed-after-run', async () => { const w = world(); w.pull.labels.push({ name: 'bug' }); w.input.liveLabels.push('bug'); await no(w); });
  it('caller-labels-differ', async () => { const w = world(); w.input.liveLabels = []; await no(w); });
  it('toctou-head-or-labels-move', async () => {
    for (const change of [{ head: { ...world().pull.head, sha: 'b'.repeat(40) } }, { labels: [] }]) {
      const w = world(); w.io.getPull.mockResolvedValueOnce(w.pull).mockResolvedValue({ ...w.pull, ...change }); await no(w);
    }
  });
  it('toctou-latest-run-moves', async () => {
    for (const change of [{ id: 99 }, { run_attempt: 2 }, { status: 'in_progress' }, { conclusion: 'success' }]) {
      const w = world(); w.io.listGateRuns.mockResolvedValueOnce(structuredClone(w.runs))
        .mockResolvedValue({ total_count: 1, workflow_runs: [{ ...w.run, ...change }] }); await no(w);
    }
  });
  it('second-read-unreadable-sweep', async () => {
    for (const method of ['getPull', 'listGateRuns']) for (const value of [null, undefined, {}, [], '', new Error('offline')]) {
      const w = world(); const initial = method === 'getPull' ? w.pull : w.runs;
      w.io[method].mockResolvedValueOnce(initial).mockImplementation(async () => { if (value instanceof Error) throw value; return value; });
      await no(w);
    }
  });
  it('run-page-and-job-count-sweep', async () => {
    for (const value of [undefined, null, -1, '1', 2]) {
      const w = world(); w.jobs.total_count = value; await no(w);
      const r = world(); r.runs.total_count = value; await no(r);
    }
  });
  it('marker-size-is-bounded-in-bytes', async () => {
    const w = world(); w.io.getJobLog.mockResolvedValue('é'.repeat(600000) + '\n' + PREFIX + JSON.stringify(w.marker)); await no(w);
  });

  it('input-validation-sweep', async () => {
    for (const [key, values] of Object.entries({ repo: [null, '', 'owner', 'o/n/extra'], pr: [0, -1, 1.5, '7'],
      head: [null, '', 'a', 'g'.repeat(40)], liveLabels: [null, {}, ['bug', null]], changedFiles: [null, {}, [7]] })) {
      for (const value of [...(key === 'changedFiles' ? [] : [undefined]), ...values]) {
        const w = world(); w.input[key] = value; await no(w);
      }
    }
  });
  it('pull-binding-sweep', async () => {
    for (const patch of [{ state: 'closed' }, { head: { sha: 'b'.repeat(40), repo: { full_name: 'o/n' } } },
      { base: { repo: { full_name: 'other/repo' } } }, { labels: null }, { labels: [{}] }, { changed_files: -1 }, { changed_files: '1' }]) {
      const w = world(); Object.assign(w.pull, patch); await no(w);
    }
  });
  it('job-binding-sweep', async () => {
    for (const [key, value] of Object.entries({ name: 'other', run_id: 99, run_attempt: 2, head_sha: 'b'.repeat(40),
      status: 'in_progress', conclusion: 'success', steps: null })) {
      for (const replacement of [undefined, value]) { const w = world(); w.job[key] = replacement; await no(w); }
    }
    for (const jobs of [[], [world().job, world().job]]) { const w = world(); w.jobs.jobs = jobs; w.jobs.total_count = jobs.length; await no(w); }
  });
  it('step-completion-and-conclusion-sweep', async () => {
    for (const index of [0, 1]) for (const patch of [{ status: 'in_progress' }, { status: undefined }, { conclusion: 'skipped' }, { conclusion: undefined }]) {
      const w = world(); Object.assign(w.job.steps[index], patch); await no(w);
    }
    const w = world(); w.job.steps.push({ ...w.job.steps[1] }); await no(w);
  });
  it('success-requires-every-step-successful', async () => {
    const w = world(); clear(w); w.job.steps[0].conclusion = 'failure'; await no(w);
  });
  it('marker-exact-schema-sweep', async () => {
    for (const key of Object.keys(world().marker)) { const w = world(); delete w.marker[key]; await no(w); }
    const extra = world(); extra.marker.seal = true; await no(extra);
    for (const log of [PREFIX + '{', PREFIX + 'null', PREFIX + '[]']) { const w = world(); w.io.getJobLog.mockResolvedValue(log); await no(w); }
  });
  it('timestamped-marker-and-case-insensitive-repo', async () => {
    const w = world(); w.marker.repo = 'O/N';
    w.io.getJobLog.mockResolvedValue('2026-11-16T01:00:00.000Z ' + PREFIX + JSON.stringify(w.marker)); await yes(w);
  });
  it('hold-labels-use-the-complete-shared-definition', async () => {
    for (const label of ['review:pending', 'review:changes', 'review:human', 'review:held-mechanical']) {
      const w = world(); w.input.liveLabels = [label]; w.pull.labels = [{ name: label }];
      w.marker.labels = w.marker.holdLabels = [label]; await yes(w);
    }
  });
  it('default-io-get-only', () => {
    expect(typeof createGhPublishIo).toBe('function');
    const source = readFileSync('scripts/lib/review-hold-io.mjs', 'utf8');
    expect(source).not.toMatch(/['"`](?:-X|--method|-f|-F)(?:[='"`\s])/);
    expect(createGhPublishIo.toString()).not.toMatch(/['"`](?:-X|--method|-f|-F)(?:[='"`\s])/);
  });
  it('script-roundtrip', async () => {
    const w = world();
    const child = spawnSync(process.execPath, ['scripts/check-review-gate.mjs', '--repo=o/n', '--pr-number=7', `--head-sha=${HEAD}`, '--run-id=31', '--run-attempt=1', '--labels-json=["review:pending"]'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    w.io.getJobLog.mockResolvedValue(child.stdout); await yes(w);
  });
});
