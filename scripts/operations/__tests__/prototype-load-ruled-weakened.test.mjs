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
  it('requires the record to disclose exactly the allowlisted findings', () => {
    expect(readyEvidence([record({ auditDisclosed: ['something unrelated'] })], input, [entry()])).toBeNull();
    expect(readyEvidence([record({ auditDisclosed: [null] })], input, [entry({ findings: [null] })])).toBeNull();
    expect(readyEvidence([record({ auditDisclosed: ['excluded-file drop made loud', 'extra'] })], input, [entry()])).toBeNull();
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
  it('ships exactly the fourteen ruled entries with pinned refs, full shas and rulings', () => {
    const shipped = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/prototype-load.json'), 'utf8'));
    expect(shipped.ruledWeakened.map(({ ref, sha, ruling }) => [ref, sha, ruling])
      .sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['lane/author-lookup-defer', 'f62437a87d2831fdb56be1ec3d8387243b5e2f57', 'R521'],
      ['lane/cheap-pr-list-retry', '393b3f42378fc25dd729b4d17c930dd7fb89a56c', 'R517'],
      ['lane/dispatch-scope-multi', '2fe6208f8409668f0a74a637c5b53ac46f5031cf', 'R396'],
      ['lane/drain-rest-reader-r557', 'cc8ac117222de6f7146f7a059f55df0fe00aa587', 'R563'],
      ['lane/forge-slot-reconciler-r475', '0cbd4303bc0a961fdafda162bec407af8b8709dc', 'R475+R485'],
      ['lane/freeze-read-retry-lkg', 'f8564fc77a42e3c5a326fc17e38c3873f66696b3', 'R432'],
      ['lane/fresh-plan-read', '83be0f19530ef10b5634c1ce9b8f69074e620e7a', 'R521'],
      ['lane/mq-removed-event-hold', '9730180d08259a7def9e8c4590ac9b7697515c65', 'R443'],
      ['lane/mq-same-head-merge-conflict', '94eb862d0f5595cb6d322c09d5945bbdcf92bfa9', 'R466+R484'],
      ['lane/r452-restart-ceiling', 'be8f9f26291bad2acfd3cc45c458efed18d1c998', 'R452'],
      ['lane/rebuild-spawner-reader-thin', 'd2c55f72173c6da0c88612507fc86e144cf176a4', 'R384+R396'],
      ['lane/review-early-start', 'bfa5d088cd1a630dd36f37c54bc3e8d250dccfc2', 'R464+R468+R474'],
      ['lane/runs-scan-bound-aff4', 'aff4a567812cd837234ceeadd0cd7d8a0f658fdb', 'R545'],
      ['lane/verify-forge-route', '2b6ac7d67b5e4fc1b7137c6d7e59d202eb45a41b', 'R396'],
    ]);
    for (const e of shipped.ruledWeakened) { expect(e.sha).toMatch(/^[a-f0-9]{40}$/); expect(e.findings.length).toBeGreaterThan(0); }
  });
});
