import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { reviewGateHoldMarker } from '../check-review-gate.mjs';
import { parseReviewGateMarker } from '../lib/review-hold-io.mjs';
import { REVIEW_GATE_MARKER } from '../lib/review-hold-model.mjs';

const HEAD = 'a'.repeat(40);
const run = (labels, extra = []) => spawnSync(process.execPath, ['scripts/check-review-gate.mjs',
  `--labels-json=${JSON.stringify(labels)}`, ...extra], { encoding: 'utf8' });
const markers = (r) => `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => l.startsWith(REVIEW_GATE_MARKER));

describe('review-gate marker emission', () => {
  it('builds one parseable marker bound to head and run', () => {
    const m = reviewGateHoldMarker({ holdLabels: ['review:pending'], headSha: HEAD, runId: '77' });
    expect(m.startsWith(REVIEW_GATE_MARKER)).toBe(true);
    expect(JSON.parse(m.slice(REVIEW_GATE_MARKER.length))).toEqual({ holds: ['review-hold-labels'], headSha: HEAD, runId: 77 });
  });
  it('builds no marker when unbound or not held', () => {
    expect(reviewGateHoldMarker({ holdLabels: [], headSha: HEAD, runId: '77' })).toBeNull();
    expect(reviewGateHoldMarker({ holdLabels: ['review:pending'], headSha: '', runId: '77' })).toBeNull();
    expect(reviewGateHoldMarker({ holdLabels: ['review:pending'], headSha: HEAD, runId: 'x' })).toBeNull();
  });
  it('a red CLI run carries exactly one marker', () => {
    const r = run([{ name: 'review:pending' }, { name: 'review:human' }], [`--head-sha=${HEAD}`, '--run-id=77']);
    expect(r.status).toBe(1);
    expect(markers(r)).toHaveLength(1);
  });
  it('the CLI marker is accepted by parseReviewGateMarker and always contains headSha and runId', () => {
    for (const labels of [[{ name: 'review:pending' }], [{ name: 'review:human' }], [{ name: 'review:pending' }, { name: 'review:human' }]]) {
      const r = run(labels, [`--head-sha=${HEAD}`, '--run-id=77']);
      expect(r.status).toBe(1);
      const emitted = markers(r);
      expect(emitted).toHaveLength(1);
      const json = JSON.parse(emitted[0].slice(REVIEW_GATE_MARKER.length));
      expect(json).toHaveProperty('headSha', HEAD);
      expect(json).toHaveProperty('runId', 77);
      expect(parseReviewGateMarker(emitted[0], { headSha: HEAD, runId: 77 })).toEqual({ ok: true, holds: ['review-hold-labels'] });
    }
  });
  it('a green CLI run carries none, and a red run without binding carries none', () => {
    expect(markers(run([], [`--head-sha=${HEAD}`, '--run-id=77']))).toHaveLength(0);
    expect(markers(run([{ name: 'review:pending' }]))).toHaveLength(0);
  });
  it('the workflow fast path emits the same marker and passes binding to the script', () => {
    const yml = readFileSync('.github/workflows/review-gate.yml', 'utf8');
    expect(yml).toContain('review-gate-hold:');
    expect(yml).toContain('--head-sha=');
    expect(yml).toContain('--run-id=');
  });
  it('a null, non-array or unparseable labels input fails closed: non-zero, no marker, logged reason', () => {
    for (const raw of ['null', '{}', '"x"', '42', '{nope', '[null,{},42]', '[{"name":7}]']) {
      const r = spawnSync(process.execPath, ['scripts/check-review-gate.mjs', `--labels-json=${raw}`, `--head-sha=${HEAD}`, '--run-id=77'], { encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(markers(r)).toHaveLength(0);
      expect(r.stderr).toContain('labels');
    }
  });
});
