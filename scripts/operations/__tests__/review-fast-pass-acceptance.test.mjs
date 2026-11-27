import { it, expect } from 'vitest';
import { checkReviewFastLatency } from '../review-fast-pass-acceptance.mjs';

const iso = ms => new Date(Date.UTC(2026, 10, 25) + ms).toISOString();
function evidence(latencies = Array(10).fill(150000)) {
  return {
    labels: latencies.map((_, i) => ({ repo: 'fixture/repo', pr: i + 1, label: 'review:pending', createdAt: iso(0) })),
    logLines: latencies.map((ms, i) => `${iso(ms)} review-fast-pass: fixture/repo#${i + 1} dispatched`),
    loadSamples: Array.from({ length: 21 }, (_, i) => ({ at: iso(i * 10000), loadPerCore: 0.5 })),
  };
}
it('checks ten label-to-dispatch intervals and the median with continuous host load evidence', () => {
  expect(checkReviewFastLatency(evidence())).toMatchObject({ ok: true, maxMs: 150000, medianMs: 150000 });
});
it('allows a maximum of exactly 180s when the median is below 180s', () => {
  expect(checkReviewFastLatency(evidence([180000, ...Array(9).fill(150000)]))).toMatchObject({ ok: true, maxMs: 180000 });
});
it.each([
  ['over maximum', e => { e.logLines[0] = `${iso(180001)} review-fast-pass: fixture/repo#1 dispatched`; }],
  ['median at threshold', e => { e.logLines = evidence(Array(10).fill(180000)).logLines; }],
  ['missing log', e => { e.logLines.pop(); }],
  ['wrong label', e => { e.labels[0].label = 'review:accepted'; }],
  ['duplicate PR', e => { e.labels[1] = e.labels[0]; }],
  ['missing host samples', e => { e.loadSamples = []; }],
  ['host sample gap', e => { e.loadSamples.splice(3, 4); }],
  ['light host', e => { e.loadSamples[4].loadPerCore = 0.1; }],
  ['malformed timestamp', e => { e.labels[0].createdAt = 'unknown'; }],
])('fails deployment acceptance for %s', (_name, change) => {
  const input = evidence(); change(input);
  expect(checkReviewFastLatency(input).ok).toBe(false);
});
