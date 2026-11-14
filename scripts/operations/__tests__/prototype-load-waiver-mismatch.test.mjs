import { describe, it, expect } from 'vitest';
import { readyEvidence } from '../prototype-load.mjs';
import { diagnoseWaiverMismatch } from '../prototype-load-io.mjs';

const REF = 'lane/example-fix';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const LONG = `R903+R907: ${'explanation '.repeat(20)}`;
const record = (over = {}) => ({ ref: REF, sha: SHA, tests: 'green', audit: 'WEAKENED', auditRuling: 'R903+R907', auditDisclosed: ['f1'], ...over });
const entry = (over = {}) => ({ ref: REF, sha: SHA, ruling: 'R903+R907', findings: ['f1'], ...over });
const input = { branch: REF, sha: SHA };

describe('prototype-load waiver-mismatch diagnosis (message only; match stays exact)', () => {
  it('names the ruling field with both values, truncated to 80 chars', () => {
    const got = diagnoseWaiverMismatch([record()], input, [entry({ ruling: LONG })]);
    expect(got).toMatchObject({ field: 'ruling', record: 'R903+R907' });
    expect(got.waiver).toHaveLength(80);
    expect(got.waiver).toBe(LONG.slice(0, 80));
    expect(got.message).toContain('ruling');
    expect(got.message).toContain('R903+R907');
    expect(got.message).toContain(LONG.slice(0, 80));
  });
  it('the mismatching waiver still does not load (exact match unchanged)', () => {
    expect(readyEvidence([record()], input, [entry({ ruling: LONG })])).toBeNull();
  });
  it('reports a missing entry when no waiver exists for the ref', () => {
    expect(diagnoseWaiverMismatch([record()], input, [])).toMatchObject({ field: 'missing entry' });
    expect(diagnoseWaiverMismatch([record()], input, [entry({ ref: 'lane/other' })])).toMatchObject({ field: 'missing entry' });
    expect(diagnoseWaiverMismatch([record()], input, undefined)).toMatchObject({ field: 'missing entry' });
  });
  it('reports the sha field when the ref is listed under another sha', () => {
    expect(diagnoseWaiverMismatch([record()], input, [entry({ sha: OTHER })])).toMatchObject({ field: 'sha', record: SHA, waiver: OTHER });
  });
  it('returns null for a matching waiver, which still loads as today', () => {
    expect(diagnoseWaiverMismatch([record()], input, [entry()])).toBeNull();
    expect(readyEvidence([record()], input, [entry()])).toMatchObject({ source: 'ready-record', ruledWeakened: { ruling: 'R903+R907' } });
  });
  it('returns null (so no-fix-ready-record stays) when there is no record, or the record is not a waiver attempt', () => {
    expect(diagnoseWaiverMismatch([], input, [entry()])).toBeNull();
    expect(diagnoseWaiverMismatch([record({ ref: 'lane/other' })], input, [])).toBeNull();
    expect(diagnoseWaiverMismatch([record({ sha: OTHER })], input, [])).toBeNull();
    expect(diagnoseWaiverMismatch([record({ auditRuling: undefined })], input, [])).toBeNull();
    expect(diagnoseWaiverMismatch([record({ tests: 'red' })], input, [])).toBeNull();
    expect(diagnoseWaiverMismatch([record({ audit: 'NOT WEAKENED' })], input, [])).toBeNull();
  });
});
