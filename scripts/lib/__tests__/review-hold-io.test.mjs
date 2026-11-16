import { describe, it, expect } from 'vitest';
import { REVIEW_GATE_MARKER, REVIEW_GATE_VERDICT_STEPS, deriveReviewHold } from '../review-hold-model.mjs';
import { parseReviewGateMarker, readReviewGateEvidence } from '../review-hold-io.mjs';

const REPO = 'o/r';
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const RUN = 31;
const JOB = 32;
const binding = { headSha: HEAD, runId: RUN };
const evidence = { runId: RUN, jobId: JOB, headSha: HEAD };
const mk = (over = {}) => `${REVIEW_GATE_MARKER} ${JSON.stringify({ holds: ['review-hold-labels'], ...binding, ...over })}`;
const step = (name, conclusion = 'success', status = 'completed') => ({ name, status, conclusion });
const verdict = (conclusion = 'failure') => step(REVIEW_GATE_VERDICT_STEPS[1], conclusion);
const row = (over = {}) => ({ id: 555, name: 'review-gate', status: 'completed', conclusion: 'failure', head_sha: HEAD,
  details_url: `https://github.com/${REPO}/actions/runs/${RUN}/job/${JOB}`, ...over });
const job = (over = {}) => ({ id: JOB, run_id: RUN, name: 'review-gate', head_sha: HEAD, status: 'completed', conclusion: 'failure',
  check_run_url: `https://api.github.com/repos/${REPO}/check-runs/555`,
  run_attempt: 1, steps: [step('Set up job'), step(REVIEW_GATE_VERDICT_STEPS[0], 'skipped'), verdict(over.conclusion ?? 'failure')], ...over });
const runObj = (over = {}) => ({ id: RUN, event: 'pull_request', pull_requests: [{ number: 1 }],
  path: '.github/workflows/review-gate.yml', head_sha: HEAD, status: 'completed', conclusion: 'failure', run_attempt: 1, ...over });
const gh = (j, log, r) => (args) => {
  const path = args.at(-1);
  if (path.endsWith('/logs')) return log;
  if (path === `repos/${REPO}/actions/runs/${RUN}`) return JSON.stringify(r);
  if (path === `repos/${REPO}/actions/jobs/${JOB}`) return JSON.stringify(j);
  throw new Error(`Unexpected API call: ${path}`);
};
const read = (over = {}) => {
  const { rows = [row()], job: j = job(), log = `2026-11-16T00:00:00.1Z ${mk()}\n`, run = runObj(), ...options } = over;
  return readReviewGateEvidence(rows, { repo: REPO, headSha: HEAD, prNumber: 1, changedFiles: [],
    runGh: gh(j, log, run), ...options });
};
const green = { rows: [row({ conclusion: 'success' })], job: job({ conclusion: 'success' }), run: runObj({ conclusion: 'success' }) };
const filler = Array.from({ length: 99 }, (_, i) => row({ id: i + 1000, name: `other-${i}`, conclusion: 'success' }));
const unreadable = (value) => {
  expect(value).toEqual({ state: 'unreadable', reason: expect.any(String) });
  expect(value.reason.trim().length).toBeGreaterThan(0);
};

// Each case exercises a separate loss of proof. Only the two controls may yield evidence.
const branches = [
  ['fully proven success', green, 'clear'],
  ['fully proven hold', {}, 'hold'],
  ['missing check', { rows: [] }],
  ['only unrelated checks', { rows: [row({ name: 'other' })] }],
  ['unfinished run', { rows: [row({ status: 'in_progress', conclusion: null })], job: job({ status: 'in_progress', conclusion: null }) }],
  ['queued run', { rows: [row({ status: 'queued', conclusion: null })], job: job({ status: 'queued', conclusion: null }) }],
  ['success without verdict step', { ...green, job: job({ conclusion: 'success', steps: [step('Set up job')] }) }],
  ['success with skipped verdict step', { ...green, job: job({ conclusion: 'success', steps: [step('Set up job'), verdict('skipped')] }) }],
  ['success with incomplete verdict', { ...green, job: job({ conclusion: 'success', steps: [step('Set up job'), { ...verdict('success'), status: 'in_progress' }] }) }],
  ['success with missing steps', { ...green, job: job({ conclusion: 'success', steps: undefined }) }],
  ['success with unrelated step', { ...green, job: job({ conclusion: 'success', steps: [step('Some other step')] }) }],
  ['workflow edit', { ...green, changedFiles: ['.github/workflows/review-gate.yml'] }],
  ['script edit', { changedFiles: ['a.md', 'scripts/check-review-gate.mjs'] }],
  ['missing PR number', { prNumber: undefined }],
  ['zero PR number', { prNumber: 0 }],
  ['string PR number', { prNumber: '1' }],
  ['fractional PR number', { prNumber: 1.5 }],
  ['missing changed files', { changedFiles: undefined }],
  ['non-array changed files', { changedFiles: 'docs/x.md' }],
  ['non-string changed file', { changedFiles: [42] }],
  ['non-array rows', { rows: {} }],
  ['null row', { rows: [null] }],
  ['empty row', { rows: [{}] }],
  ['array row', { rows: [[]] }],
  ['malformed row beside valid row', { rows: [row(), {}] }],
  ['missing row head', { rows: [row({ head_sha: undefined })] }],
  ['unknown row status', { rows: [row({ status: 'weird' })] }],
  ['non-string row status', { rows: [row({ status: 5 })] }],
  ['empty row name', { rows: [row({ name: '' })] }],
  ['truncated red rollup', { rows: [...filler, row()] }],
  ['truncated green rollup', { ...green, rows: [...filler, ...green.rows] }],
  ['truncated rollup without gate', { rows: [...filler, row({ name: 'other' })] }],
  ['foreign row head', { rows: [row({ head_sha: OTHER })] }],
  ['foreign green head', { ...green, rows: [row({ conclusion: 'success', head_sha: OTHER })] }],
  ['foreign repo', { rows: [row({ details_url: 'https://github.com/x/y/actions/runs/31/job/32' })] }],
  ['foreign URL origin', { rows: [row({ details_url: 'https://example.com/o/r/actions/runs/31/job/32' })] }],
  ['invalid details URL', { rows: [row({ details_url: 'invalid' })] }],
  ['missing check id', { rows: [row({ id: undefined })] }],
  ['older successful attempt, latest attempt pending', { ...green, run: runObj({ status: 'in_progress', conclusion: null, run_attempt: 2 }) }],
  ['older successful attempt, latest attempt failed', { ...green, run: runObj({ conclusion: 'failure', run_attempt: 2 }) }],
  ['run still going on the same attempt', { ...green, run: runObj({ status: 'in_progress', conclusion: null }) }],
  ['run failed but job reads success', { ...green, run: runObj({ conclusion: 'failure' }) }],
  ['job without run_attempt', { ...green, job: { ...job({ conclusion: 'success' }), run_attempt: undefined } }],
  ['run without run_attempt', { ...green, run: runObj({ conclusion: 'success', run_attempt: undefined }) }],
  ['foreign job id', { job: job({ id: 33 }) }],
  ['foreign job run', { job: job({ run_id: 99 }) }],
  ['foreign job head', { job: job({ head_sha: OTHER }) }],
  ['foreign job name', { ...green, job: job({ conclusion: 'success', name: 'other' }) }],
  ['foreign check run', { job: job({ check_run_url: `https://api.github.com/repos/${REPO}/check-runs/999` }) }],
  ['row and job disagree', { ...green, job: job() }],
  ['foreign workflow run', { run: runObj({ id: 99 }) }],
  ['foreign run head', { run: runObj({ head_sha: OTHER }) }],
  ['foreign PR', { ...green, run: runObj({ conclusion: 'success', pull_requests: [{ number: 2 }] }) }],
  ['missing run PR', { ...green, run: runObj({ conclusion: 'success', pull_requests: [] }) }],
  ['foreign event', { ...green, run: runObj({ event: 'workflow_dispatch' }) }],
  ['foreign workflow path', { ...green, run: runObj({ path: '.github/workflows/evil.yml' }) }],
  ['API throws', { runGh: () => { throw new Error('boom'); } }],
  ['unparseable API response', { runGh: () => '{nope' }],
  ['oversize log', { log: `${mk()}\n${'x'.repeat(1024 * 1024)}` }],
  ['missing steps', { job: job({ steps: undefined }) }],
  ['empty steps', { job: job({ steps: [] }) }],
  ['incomplete steps', { job: job({ steps: [step('Set up job'), { ...verdict(), status: 'in_progress' }] }) }],
  ['infrastructure failure', { job: job({ steps: [step('Run npm ci', 'failure'), verdict('skipped')] }) }],
  ['two failed steps', { job: job({ steps: [step('Set up job', 'failure'), verdict()] }) }],
  ['timed-out infrastructure', { job: job({ steps: [step('Run npm ci', 'timed_out'), verdict()] }) }],
  ['cancelled run', { rows: [row({ conclusion: 'cancelled' })], job: job({ conclusion: 'cancelled' }) }],
  ['missing marker', { log: 'no marker' }],
  ['duplicate marker', { log: `${mk()}\n${mk()}` }],
  ['invalid marker JSON', { log: `${REVIEW_GATE_MARKER} {nope` }],
  ['oversize marker', { log: mk({ padding: 'x'.repeat(1024) }) }],
  ['numeric hold kind', { log: mk({ holds: [42] }) }],
  ['unknown hold kind', { log: mk({ holds: ['unknown'] }) }],
  ['empty marker holds', { log: mk({ holds: [] }) }],
  ['mixed marker holds', { log: mk({ holds: ['review-hold-labels', 'test-gaming'] }) }],
  ['omitted marker run id', { log: mk({ runId: undefined }) }],
  ['omitted marker head', { log: mk({ headSha: undefined }) }],
  ['foreign marker run', { log: mk({ runId: 99 }) }],
  ['foreign marker head', { log: mk({ headSha: OTHER }) }],
  ['foreign newer green row', { rows: [row(), row({ id: 999, conclusion: 'success', details_url: 'https://github.com/x/y/actions/runs/9/job/8' })] }],
  ['failed row older than unfinished row', {
    rows: [row(), row({ id: 600, status: 'in_progress', conclusion: null,
      details_url: `https://github.com/${REPO}/actions/runs/${RUN}/job/33` })],
    runGh: (args) => {
      const path = args.at(-1);
      if (path.endsWith('/33')) return JSON.stringify(job({ id: 33, status: 'in_progress', conclusion: null,
        check_run_url: `https://api.github.com/repos/${REPO}/check-runs/600` }));
      return gh(job(), mk(), runObj())(args);
    },
  }],
];

describe('parseReviewGateMarker', () => {
  it('accepts exactly one bound marker (timestamp prefix tolerated)', () => {
    expect(parseReviewGateMarker(`2026-11-16T00:00:00.1Z ${mk()}`, binding)).toEqual({ ok: true, holds: ['review-hold-labels'] });
  });
  it('holds:[42] -> marker-holds', () => {
    expect(parseReviewGateMarker(mk({ holds: [42] }), binding)).toEqual({ ok: false, why: 'marker-holds' });
  });
  it.each([
    ['missing', 'nothing'], ['duplicate', `${mk()}\n${mk()}`], ['malformed', `${REVIEW_GATE_MARKER} {nope`],
    ['unknown hold', mk({ holds: ['unknown'] })], ['empty holds', mk({ holds: [] })],
    ['omitted run id', mk({ runId: undefined })], ['omitted head', mk({ headSha: undefined })],
    ['foreign run', mk({ runId: 99 })], ['foreign head', mk({ headSha: OTHER })],
    ['non-array holds', mk({ holds: 'review-hold-labels' })],
    ['zero run', mk({ runId: 0 })], ['fractional run', mk({ runId: 1.5 })], ['string run', mk({ runId: '31' })],
  ])('rejects %s marker', (_name, log) => { expect(parseReviewGateMarker(log, binding).ok).toBe(false); });
  it.each([undefined, {}, { headSha: HEAD }, { runId: RUN }, { headSha: 'bad', runId: RUN },
    { headSha: HEAD, runId: 0 }, { headSha: HEAD, runId: 1.5 }, { headSha: HEAD, runId: '31' }])(
    'requires valid caller binding %j even if the marker matches', (expected) => {
      expect(parseReviewGateMarker(mk({ headSha: expected?.headSha, runId: expected?.runId }), expected).ok).toBe(false);
    });
});

describe('readReviewGateEvidence', () => {
  it('a realistic successful job yields clear evidence', () => {
    expect(read(green)).toEqual({ state: 'clear', evidence });
  });
  it('a realistic failed verdict yields hold evidence accepted by the model end to end', () => {
    const reviewGate = read();
    expect(reviewGate).toEqual({ state: 'hold', holds: ['review-hold-labels'], evidence });
    expect(deriveReviewHold({ headSha: HEAD, prNumber: 1, labels: ['review:pending'], mergeGate: null, reviewGate }).publishable).toBe(true);
  });
  it.each([
    ['missing check -> unreadable', { rows: [] }],
    ['unfinished run -> unreadable', branches.find(([name]) => name === 'unfinished run')[1]],
    ['holds:[42] -> parse error -> unreadable', { log: mk({ holds: [42] }) }],
    ['omitted run ids in marker -> unreadable', { log: mk({ runId: undefined }) }],
    ['success with skipped verdict step -> unreadable', branches.find(([name]) => name === 'success with skipped verdict step')[1]],
    ['gate-file edit -> unreadable', { ...green, changedFiles: ['.github/workflows/review-gate.yml'] }],
  ])('%s', (_name, options) => { unreadable(read(options)); });
  it('foreign PR/event/path -> unreadable', () => {
    for (const run of [runObj({ pull_requests: [{ number: 2 }] }), runObj({ event: 'workflow_dispatch' }), runObj({ path: 'evil.yml' })]) {
      unreadable(read({ ...green, run }));
    }
  });
  it.each(branches.filter(([, , state]) => !state))('%s -> unreadable with a reason', (_name, options) => {
    unreadable(read(options));
  });
  it('every reader branch yields one of three states and only the fully-proven branch is clear', () => {
    expect(branches.length).toBeGreaterThanOrEqual(25);
    // Read every branch before asserting, so an early red result cannot hide later probes.
    const results = branches.map(([name, options, expected = 'unreadable']) => ({ name, expected, value: read(options) }));
    for (const { name, expected, value } of results) {
      expect.soft(value, name).not.toBeNull();
      expect.soft(value, name).not.toBeUndefined();
      expect.soft(['clear', 'hold', 'unreadable'], name).toContain(value?.state);
      expect.soft(value?.state, name).toBe(expected);
      if (value?.state === 'unreadable') {
        expect.soft(value, name).toEqual({ state: 'unreadable', reason: expect.any(String) });
        expect.soft(typeof value.reason === 'string' && value.reason.trim().length > 0, name).toBe(true);
      } else if (value?.state === 'clear' || value?.state === 'hold') {
        expect.soft(value, name).toEqual(value.state === 'clear'
          ? { state: 'clear', evidence } : { state: 'hold', holds: ['review-hold-labels'], evidence });
      }
    }
    expect(results.filter((r) => r.value?.state === 'clear').map((r) => r.name)).toEqual(['fully proven success']);
    expect(results.filter((r) => r.value?.state === 'hold').map((r) => r.name)).toEqual(['fully proven hold']);
  });
  it('is read-only: only gh api GET calls with bounded IO', () => {
    const seen = [];
    read({ runGh: (args, options) => { seen.push({ args, options }); return gh(job(), mk(), runObj())(args); } });
    expect(seen.map(({ args }) => args)).toEqual([
      ['api', `repos/${REPO}/actions/jobs/${JOB}`], ['api', `repos/${REPO}/actions/runs/${RUN}`],
      ['api', `repos/${REPO}/actions/jobs/${JOB}/logs`],
    ]);
    for (const { options } of seen) {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.maxBuffer).toBe(1024 * 1024);
    }
  });
});
