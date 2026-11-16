import { describe, it, expect } from 'vitest';
import { REVIEW_GATE_MARKER, REVIEW_GATE_VERDICT_STEPS, deriveReviewHold } from '../review-hold-model.mjs';
import { parseReviewGateMarker, readReviewGateEvidence } from '../review-hold-io.mjs';

const REPO = 'o/r';
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const RUN = 31;
const JOB = 32;
const mk = (o = {}) => `${REVIEW_GATE_MARKER} ${JSON.stringify({ holds: ['review-hold-labels'], headSha: HEAD, runId: RUN, ...o })}`;
const row = (o = {}) => ({ id: 555, name: 'review-gate', status: 'completed', conclusion: 'failure', head_sha: HEAD,
  details_url: `https://github.com/${REPO}/actions/runs/${RUN}/job/${JOB}`, ...o });
const job = (o = {}) => ({ id: JOB, run_id: RUN, name: 'review-gate', head_sha: HEAD, status: 'completed', conclusion: 'failure',
  check_run_url: `https://api.github.com/repos/${REPO}/check-runs/555`,
  steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' },
    { name: REVIEW_GATE_VERDICT_STEPS[1], status: 'completed', conclusion: 'failure' }], ...o });
const runObj = (o = {}) => ({ id: RUN, path: '.github/workflows/review-gate.yml', head_sha: HEAD, ...o });
const gh = (j, log, r = runObj()) => (args) => {
  const p = args.at(-1);
  if (p.endsWith('/logs')) return log;
  return JSON.stringify(/\/actions\/runs\/\d+$/.test(p) ? r : j);
};
const read = (o = {}) => readReviewGateEvidence([row(o.row)], { repo: REPO, headSha: HEAD, runGh: gh(o.job ?? job(), o.log ?? `2026-11-16T00:00:00.1Z ${mk()}\n`) });

describe('parseReviewGateMarker', () => {
  it('accepts exactly one bound marker (timestamp prefix tolerated)', () => {
    expect(parseReviewGateMarker(`2026-11-16T00:00:00.1Z ${mk()}`, { headSha: HEAD, runId: RUN }).ok).toBe(true);
  });
  it('rejects missing, duplicate and foreign-head or foreign-run markers', () => {
    const b = { headSha: HEAD, runId: RUN };
    expect(parseReviewGateMarker('nothing', b).ok).toBe(false);
    expect(parseReviewGateMarker(`${mk()}\n${mk()}`, b).ok).toBe(false);
    expect(parseReviewGateMarker(mk({ headSha: OTHER }), b).ok).toBe(false);
    expect(parseReviewGateMarker(mk({ runId: 99 }), b).ok).toBe(false);
    expect(parseReviewGateMarker(`${REVIEW_GATE_MARKER} {nope`, b).ok).toBe(false);
  });
});

describe('readReviewGateEvidence', () => {
  it('returns evidence the S1 model accepts as review-gate proof', () => {
    const rg = read();
    expect(rg.state).toBe('failure');
    expect(rg.logText).toContain(REVIEW_GATE_MARKER);
    const r = deriveReviewHold({ headSha: HEAD, prNumber: 1, labels: ['review:pending'], mergeGate: null, reviewGate: rg });
    expect(r.publishable).toBe(true);
  });
  const pub = (rg) => deriveReviewHold({ headSha: HEAD, prNumber: 1, labels: ['review:pending'], mergeGate: null, reviewGate: rg }).publishable;
  it('a red row with a foreign head, job, repo or name fails closed (never null)', () => {
    for (const rg of [read({ row: { head_sha: OTHER } }), read({ job: job({ head_sha: OTHER }) }), read({ job: job({ run_id: 1 }) }),
      read({ job: job({ name: 'other' }) }), read({ row: { details_url: 'https://github.com/x/y/actions/runs/31/job/32' } })]) {
      expect(rg).not.toBeNull();
      expect(pub(rg)).toBe(false);
    }
  });
  it('an API error on a red row fails closed', () => {
    const rg = readReviewGateEvidence([row()], { repo: REPO, headSha: HEAD, runGh: () => { throw new Error('boom'); } });
    expect(pub(rg)).toBe(false);
  });
  it('no row, or a green or unfinished row, is null', () => {
    expect(readReviewGateEvidence([], { repo: REPO, headSha: HEAD, runGh: gh(job(), '') })).toBeNull();
    expect(read({ row: { conclusion: 'success' } })).toBeNull();
    expect(read({ row: { status: 'in_progress', conclusion: null } })).toBeNull();
  });
  it('a full 100-row rollup cannot prove absence or a green row', () => {
    const filler = Array.from({ length: 99 }, (_, i) => ({ id: i + 1000, name: `c${i}`, status: 'completed', conclusion: 'success', head_sha: HEAD }));
    expect(pub(readReviewGateEvidence(filler.concat([{ ...row(), conclusion: 'success' }]), { repo: REPO, headSha: HEAD, runGh: gh(job(), '') }))).toBe(false);
    expect(pub(readReviewGateEvidence(filler.concat([{ id: 5, name: 'x', status: 'completed', conclusion: 'success', head_sha: HEAD }]), { repo: REPO, headSha: HEAD, runGh: gh(job(), '') }))).toBe(false);
  });
  it('a full rollup holding a red row, and malformed entries, fail closed', () => {
    const filler = Array.from({ length: 99 }, (_, i) => ({ id: i + 1000, name: `c${i}`, status: 'completed', conclusion: 'success', head_sha: HEAD }));
    const ok = { repo: REPO, headSha: HEAD, runGh: gh(job(), `${mk()}\n`) };
    expect(pub(readReviewGateEvidence(filler.concat([row()]), ok))).toBe(false);
    expect(pub(readReviewGateEvidence([null, {}], ok))).toBe(false);
  });
  it('strict rows: {}, [], a missing head_sha and a wrong-type status make the whole read unreadable', () => {
    const ok = { repo: REPO, headSha: HEAD, runGh: gh(job(), `${mk()}\n`) };
    for (const rows of [[{}], [[]], [row({ head_sha: undefined })], [row({ status: 5 })], [row(), {}], [row({ name: '' })]]) {
      const rg = readReviewGateEvidence(rows, ok);
      expect(rg).not.toBeNull();
      expect(rg.state).toBe('unreadable');
      expect(pub(rg)).toBe(false);
    }
  });
  it('an unrelated newer green review-gate row cannot hide a red one', () => {
    const foreign = row({ id: 999, conclusion: 'success', details_url: 'https://github.com/other/repo/actions/runs/9/job/8' });
    const rg = readReviewGateEvidence([row(), foreign], { repo: REPO, headSha: HEAD, runGh: gh(job(), `${mk()}\n`) });
    expect(rg.state).toBe('unreadable');
    expect(pub(rg)).toBe(false);
  });
  it('a green row from another workflow path or job name does not prove clear', () => {
    expect(read({ row: { conclusion: 'success' } })).toBeNull();
    const badPath = readReviewGateEvidence([row({ conclusion: 'success' })], { repo: REPO, headSha: HEAD, runGh: gh(job(), '', runObj({ path: '.github/workflows/evil.yml' })) });
    expect(badPath.state).toBe('unreadable');
    expect(read({ row: { conclusion: 'success' }, job: job({ name: 'other' }) }).state).toBe('unreadable');
  });
  it('unknown status, foreign-head success and malformed rows fail closed', () => {
    for (const rg of [read({ row: { status: undefined } }), read({ row: { conclusion: 'success', head_sha: OTHER } }),
      readReviewGateEvidence({}, { repo: REPO, headSha: HEAD, runGh: gh(job(), '') })]) {
      expect(rg).not.toBeNull();
      expect(pub(rg)).toBe(false);
    }
  });
  it('a missing or duplicate or foreign marker yields evidence the model refuses', () => {
    for (const log of ['no marker\n', `${mk()}\n${mk()}\n`, `${mk({ headSha: OTHER })}\n`]) {
      const rg = read({ log });
      const r = deriveReviewHold({ headSha: HEAD, prNumber: 1, labels: ['review:pending'], mergeGate: null, reviewGate: rg });
      expect(r.publishable).toBe(false);
    }
  });
  it('is read-only: only gh api GET calls', () => {
    const seen = [];
    readReviewGateEvidence([row()], { repo: REPO, headSha: HEAD, runGh: (a) => { seen.push(a); return a.at(-1).endsWith('/logs') ? mk() : JSON.stringify(job()); } });
    expect(seen.every((a) => a[0] === 'api' && !a.includes('-X'))).toBe(true);
  });
});
