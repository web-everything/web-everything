/**
 * @file run-record.test.mjs — the run record keeps WHY a juror seat failed (held item 223, item 3).
 *
 * Live 2026-10-10: 15 of 119 review runs died on "the juror did not emit parseable JSON on stdout", and the run
 * record could not say why — the telemetry allow-list dropped everything but the cost fields. A failed seat's exit
 * code, signal, attempts, bounded stderr tail and failure kind now survive onto the record. Saved seat answers
 * (`prefilledSeats`) are validated when present.
 */
import { describe, it, expect } from 'vitest';

import { newRunRecord, normalizeJudgeTelemetry, validateRunRecord } from '../run-record.mjs';

describe('normalizeJudgeTelemetry — a failed seat keeps its spawn evidence', () => {
  it('keeps exitCode, attempts, signal, stderrTail and failure', () => {
    const row = normalizeJudgeTelemetry({
      step: 'judgeSecurity', stepIndex: 2,
      telemetry: { sessionId: 's', wallMs: 15_000, exitCode: 143, signal: 'SIGTERM', attempts: 2, stderrTail: 'boom', failure: 'unparseable-stdout' },
    });
    expect(row).toMatchObject({ step: 'judgeSecurity', stepIndex: 2, sessionId: 's', wallMs: 15_000, exitCode: 143, signal: 'SIGTERM', attempts: 2, stderrTail: 'boom', failure: 'unparseable-stdout' });
  });

  it('drops a null exit code and an empty signal rather than recording noise', () => {
    const row = normalizeJudgeTelemetry({ telemetry: { exitCode: null, signal: '', attempts: 1 } });
    expect('exitCode' in row).toBe(false);
    expect('signal' in row).toBe(false);
    expect(row.attempts).toBe(1);
  });

  it('bounds the stderr tail to its last 1000 characters', () => {
    const row = normalizeJudgeTelemetry({ telemetry: { stderrTail: `${'x'.repeat(4000)}END` } });
    expect(row.stderrTail.length).toBe(1000);
    expect(row.stderrTail.endsWith('END')).toBe(true);
  });

  it('still drops a field that is not on the allow-list', () => {
    const row = normalizeJudgeTelemetry({ telemetry: { argv: ['--append-system-prompt', 'the mandate'], exitCode: 1 } });
    expect('argv' in row).toBe(false);
  });
});

describe('validateRunRecord — saved seat answers', () => {
  const base = () => newRunRecord({ id: 'r-1', op: 'review-pr', input: {} });
  it('tolerates a record without prefilledSeats and accepts a well-formed list', () => {
    expect(validateRunRecord(base()).ok).toBe(true);
    expect(validateRunRecord({ ...base(), prefilledSeats: [{ step: 'judgeAdvisory', stepIndex: 3, request: {}, value: {} }] }).ok).toBe(true);
  });
  it('refuses a malformed one', () => {
    expect(validateRunRecord({ ...base(), prefilledSeats: {} }).ok).toBe(false);
    expect(validateRunRecord({ ...base(), prefilledSeats: [{ stepIndex: 3 }] }).ok).toBe(false);
    expect(validateRunRecord({ ...base(), prefilledSeats: [{ step: 'x', stepIndex: -1 }] }).ok).toBe(false);
  });
});
