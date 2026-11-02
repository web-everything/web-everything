import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readyEvidence } from '../prototype-load.mjs';

const REF = 'lane/example-fix';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const record = (over = {}) => ({ ref: REF, sha: SHA, tests: 'green', audit: 'WEAKENED', auditRuling: 'R396', auditDisclosed: ['excluded-file drop made loud'], ...over });
const entry = (over = {}) => ({ ref: REF, sha: SHA, ruling: 'R396', findings: ['excluded-file drop made loud'], ...over });
const input = { branch: REF, sha: SHA };

describe('prototype-load ruled-WEAKENED exception (operator R396)', () => {
  it('refuses an unlisted WEAKENED record', () => {
    expect(readyEvidence([record()], input, [])).toBeNull();
    expect(readyEvidence([record()], input)).toBeNull();
  });
  it('refuses a listed entry with a different sha, ref or ruling', () => {
    expect(readyEvidence([record()], input, [entry({ sha: OTHER })])).toBeNull();
    expect(readyEvidence([record()], input, [entry({ ref: 'lane/other' })])).toBeNull();
    expect(readyEvidence([record({ auditRuling: 'R999' })], input, [entry()])).toBeNull();
  });
  it('refuses a short or malformed allowlist sha and a record without a ruling or disclosure', () => {
    expect(readyEvidence([record({ sha: SHA.slice(0, 12) })], { ...input, sha: SHA.slice(0, 12) }, [entry({ sha: SHA.slice(0, 12) })])).toBeNull();
    expect(readyEvidence([record({ auditRuling: undefined })], input, [entry()])).toBeNull();
    expect(readyEvidence([record({ auditDisclosed: [] })], input, [entry()])).toBeNull();
    expect(readyEvidence([record({ tests: 'red' })], input, [entry()])).toBeNull();
  });
  it('never lets a --audit argument claim the exception', () => {
    expect(readyEvidence([], { ...input, testsRun: 'x', audit: 'WEAKENED' }, [entry()])).toBeNull();
  });
  it('accepts an exact listed match and marks it as a ruled exception', () => {
    const got = readyEvidence([record()], input, [entry()]);
    expect(got).toMatchObject({ source: 'ready-record', ruledWeakened: { ruling: 'R396', findings: ['excluded-file drop made loud'] } });
  });
  it('NOT WEAKENED records are unchanged', () => {
    expect(readyEvidence([{ ref: REF, sha: SHA, tests: 'green', audit: 'NOT WEAKENED' }], input, [])).toMatchObject({ source: 'ready-record' });
  });
  it('ships the two ruled entries with full 40-char shas', () => {
    const shipped = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/prototype-load.json'), 'utf8'));
    const byRef = Object.fromEntries(shipped.ruledWeakened.map(e => [e.ref, e]));
    expect(byRef['lane/verify-forge-route']).toMatchObject({ sha: '2b6ac7d67b5e4fc1b7137c6d7e59d202eb45a41b', ruling: 'R396' });
    expect(byRef['lane/rebuild-spawner-reader-thin']).toMatchObject({ sha: 'd2c55f72173c6da0c88612507fc86e144cf176a4', ruling: 'R384+R396' });
    for (const e of shipped.ruledWeakened) { expect(e.sha).toMatch(/^[a-f0-9]{40}$/); expect(e.findings.length).toBeGreaterThan(0); }
  });
});
