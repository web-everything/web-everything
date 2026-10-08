/**
 * @file scripts/conveyor/health-smells/__tests__/ci-job-hung.test.mjs
 * @description we:backlog/xncfkf2 — pure daemon-log fixtures for second-hang escalation (no fs).
 */
import { describe, it, expect } from 'vitest';
import ciJobHung, { parseEscalations } from '../ci-job-hung.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';

const payload = {
  repo: 'web-everything/web-everything', pr: 4450, headSha: 'db9f116', check: 'daemon-soak',
  runId: 37796107550, jobId: 222, inProgressMin: 40, thresholdMin: 30, reruns: 1,
};
const line = (value = payload) => `ci-job-hung: ESCALATE ${JSON.stringify(value)}`;
const sample = (text, name = 'ci-queue-watch') => ({ name, text, mtimeMs: 0, sizeBytes: text.length, bootstrap: false });

describe('parseEscalations', () => {
  it.each([
    ['plain', ''],
    ['timestamped', '2026-10-08T16:00:00.000Z '],
    ['repeat-marker', '2026-10-08T16:00:00.000Z (repeated 3 times since 2026-10-08T15:59:00.000Z) '],
    ['arbitrary prefix', '[daemon] stderr: '],
  ])('parses a %s line', (_label, prefix) => {
    expect(parseEscalations(prefix + line())).toEqual([payload]);
  });

  it('skips malformed JSON and non-object values while preserving valid lines', () => {
    expect(parseEscalations([
      'ci-job-hung: ESCALATE {broken', line(), 'ci-job-hung: ESCALATE null',
      'ci-job-hung: ESCALATE []', 'ci-job-hung: ESCALATE 42', 'ci-job-hung: ESCALATE ',
    ].join('\n'))).toEqual([payload]);
  });

  it('ignores non-escalation lines', () => {
    const text = ['RECOVER', 'DETECTED'].map((kind) => `ci-job-hung: ${kind} ${JSON.stringify(payload)}`).join('\n');
    expect(parseEscalations(text)).toEqual([]);
    expect(ciJobHung.evaluate({ daemonLogs: [sample(text)] })).toEqual([]);
  });

  it('tolerates empty and undefined text', () => {
    expect(parseEscalations('')).toEqual([]);
    expect(parseEscalations(undefined)).toEqual([]);
  });
});

describe('ci-job-hung.evaluate', () => {
  it('reports the complete evidence and directs repair to the job log', () => {
    const out = ciJobHung.evaluate({ daemonLogs: [sample(line())] });
    expect(out).toEqual([{
      subject: 'web-everything/web-everything#4450:daemon-soak',
      breach: true,
      measure: { ...payload, daemon: 'ci-queue-watch' },
      summary: 'web-everything/web-everything#4450 check "daemon-soak" hung again (40 min in progress, threshold 30 min) after 1 automatic re-run(s).',
      recommendation: expect.any(String),
    }]);
    expect(out[0].recommendation).toContain('automatic re-run did not clear it');
    expect(out[0].recommendation).toContain('not a one-off GitHub glitch');
    expect(out[0].recommendation).toContain('https://github.com/web-everything/web-everything/actions/runs/37796107550/job/222');
    expect(out[0].recommendation).toContain('fix the cause in the workflow or the product');
    expect(out[0].recommendation).toContain('do not re-run it by hand');
  });

  it('returns one result for each of two subjects', () => {
    const other = { ...payload, check: 'unit' };
    const out = ciJobHung.evaluate({ daemonLogs: [sample(`${line()}\n${line(other)}`)] });
    expect(out.map((r) => r.subject)).toEqual([
      'web-everything/web-everything#4450:daemon-soak', 'web-everything/web-everything#4450:unit',
    ]);
  });

  it('uses the last payload for a subject across lines and daemon samples', () => {
    const latest = { ...payload, headSha: 'new-head', runId: 123, jobId: 456, inProgressMin: 50, reruns: 2 };
    const out = ciJobHung.evaluate({ daemonLogs: [
      sample(`${line()}\n${line({ ...payload, inProgressMin: 45 })}`),
      sample(line(latest), 'another-daemon'),
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].measure).toEqual({ ...latest, daemon: 'another-daemon' });
    expect(out[0].summary).toContain('(50 min in progress, threshold 30 min) after 2 automatic re-run(s).');
    expect(out[0].recommendation).toContain('/actions/runs/123/job/456');
  });

  it('returns nothing for empty, undefined, or missing probes', () => {
    expect(ciJobHung.evaluate({ daemonLogs: [sample('')] })).toEqual([]);
    expect(ciJobHung.evaluate({ daemonLogs: [] })).toEqual([]);
    expect(ciJobHung.evaluate({ daemonLogs: undefined })).toEqual([]);
    expect(ciJobHung.evaluate({})).toEqual([]);
    expect(ciJobHung.evaluate()).toEqual([]);
  });

  it('passes discovery validation and declares first-tick high escalation', () => {
    expect(validateSmellShape(ciJobHung, 'ci-job-hung.mjs')).toBe(ciJobHung);
    expect(ciJobHung).toMatchObject({
      id: 'ci-job-hung', scope: 'host', cadence: 'every-tick', probes: ['daemonLogs'],
      openAfter: 1, closeAfter: 3, severity: 'high', action: 'alert',
      recommendationHint: expect.any(String),
    });
  });
});
