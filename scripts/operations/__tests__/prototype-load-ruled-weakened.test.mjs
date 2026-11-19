import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readyEvidence, mergeRuledWeakened, refusal } from '../prototype-load.mjs';

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
  it('ships exactly the twenty-eight ruled entries with pinned refs, full shas and rulings', () => {
    const shipped = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/prototype-load.json'), 'utf8'));
    expect(shipped.ruledWeakened.map(({ ref, sha, ruling }) => [ref, sha, ruling])
      .sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['lane/author-lookup-defer', 'f62437a87d2831fdb56be1ec3d8387243b5e2f57', 'R521'],
      ['lane/bound-session-stale', '95d22a251a5389eb5b703b66cc705cb569743f8f', 'R810+R794'],
      ['lane/cheap-pr-list-retry', '393b3f42378fc25dd729b4d17c930dd7fb89a56c', 'R517'],
      ['lane/ci-heal-reset', '1e3b7159e4f9d463087b412c7a885621c97ecb8e', 'R815'],
      ['lane/dispatch-scope-multi', '2fe6208f8409668f0a74a637c5b53ac46f5031cf', 'R396'],
      ['lane/drain-freeze-priority', 'cbcec6ed1c53f31ba7586a8b99be954e87911dda', 'R813'],
      ['lane/drain-rest-reader-r557', 'cc8ac117222de6f7146f7a059f55df0fe00aa587', 'R563'],
      ['lane/forge-slot-reconciler-r475', '0cbd4303bc0a961fdafda162bec407af8b8709dc', 'R475+R485'],
      ['lane/freeze-read-retry-lkg', 'f8564fc77a42e3c5a326fc17e38c3873f66696b3', 'R432'],
      ['lane/fresh-plan-read', '83be0f19530ef10b5634c1ce9b8f69074e620e7a', 'R521'],
      ['lane/merge-gate-retrigger-wip2', '2003ae3eaf94c3995fec985331527f9d58b26358', 'R813'],
      ['lane/mq-removed-event-hold', '9730180d08259a7def9e8c4590ac9b7697515c65', 'R443'],
      ['lane/mq-same-head-merge-conflict', '94eb862d0f5595cb6d322c09d5945bbdcf92bfa9', 'R466+R484'],
      ['lane/mq-same-head-merge-conflict', '1c2c1cacd9ae0d3bc55324817a705e9a50e38b2c', 'R594'],
      ['lane/overlay-sync-flake-rerun', '23a90dd0f25512eb575f34c8685c8dda8523e2b7', 'R635+R637'],
      ['lane/platform-settings-reach-verify', '33b0209818ac4016f8428bc3e880e327a183328e', 'R606'],
      ['lane/r452-restart-ceiling', 'be8f9f26291bad2acfd3cc45c458efed18d1c998', 'R452'],
      ['lane/rebuild-adopt-chase', 'a7200c7282fd29ac9c792bb4fad48bd65a94110e', 'R790'],
      ['lane/rebuild-spawner-reader-thin', 'd2c55f72173c6da0c88612507fc86e144cf176a4', 'R384+R396'],
      ['lane/redteam-capacity-floor', 'b7bb8b2743e5c582d44e22e71a40f9e23ae07f6b', 'R816'],
      ['lane/redteam-check-run', 'dc7a0efb1c64862460b26d141815dbaf84c55d36', 'R787+R773'],
      ['lane/redteam-dispatch-queue', 'f86f066e17bd0eeb3a8c2f945d4d4f6236d30c75', 'R786'],
      ['lane/redteam-foreign-host', 'df6f584666eecef95c6a0b2c72d393cd8e54dd6d', 'R757'],
      ['lane/redteam-pending-on-accept-m1', '166689d13b300960fbf2f458ff3ba18f560b097a', 'R796'],
      ['lane/redteam-ran-verdict', 'e9cce536ad8cfebb3b343b52ee58de387d9b3a78', 'R813'],
      ['lane/review-early-start', 'bfa5d088cd1a630dd36f37c54bc3e8d250dccfc2', 'R464+R468+R474'],
      ['lane/runs-scan-bound-aff4', 'aff4a567812cd837234ceeadd0cd7d8a0f658fdb', 'R545'],
      ['lane/stall-sweep-live', 'c305b4d9990be329d41d4577cf193ef729282899', 'R803+R804'],
      ['lane/verify-forge-route', '2b6ac7d67b5e4fc1b7137c6d7e59d202eb45a41b', 'R396'],
    ]);
    for (const e of shipped.ruledWeakened) { expect(e.sha).toMatch(/^[a-f0-9]{40}$/); expect(e.findings.length).toBeGreaterThan(0); }
  });
});

describe('ruledWeakened union of platform and tool layers', () => {
  it('takes platform-only entries and lets a matching record load, naming the layer', () => {
    const merged = mergeRuledWeakened([entry()], []);
    expect(merged).toHaveLength(1);
    expect(readyEvidence([record()], input, merged)).toMatchObject({ ruledWeakened: { ruling: 'R396', layer: 'platform' } });
  });
  it('keeps tool entries and unions both, de-duplicated by ref+sha+ruling (tool wins)', () => {
    const other = entry({ ref: 'lane/other', ruling: 'R7' });
    const merged = mergeRuledWeakened([entry(), other], [entry()]);
    expect(merged.map((e) => [e.ref, e.layer])).toEqual([[REF, 'tool'], ['lane/other', 'platform']]);
    expect(readyEvidence([record()], input, merged)).toMatchObject({ ruledWeakened: { layer: 'tool' } });
  });
  it('accepts combined rulings (R475+R485, three-way) from the platform layer exactly as the tool layer does', () => {
    for (const ruling of ['R475+R485', 'R384+R396', 'R464+R468+R474']) {
      const e = entry({ ruling });
      const fromPlatform = mergeRuledWeakened([e], []);
      expect(fromPlatform).toHaveLength(1);
      expect(fromPlatform[0]).toMatchObject({ ruling, layer: 'platform' });
      expect(readyEvidence([record({ auditRuling: ruling })], input, fromPlatform)).toMatchObject({ ruledWeakened: { ruling, layer: 'platform' } });
      expect(readyEvidence([record({ auditRuling: ruling })], input, mergeRuledWeakened([], [e]))).toMatchObject({ ruledWeakened: { ruling, layer: 'tool' } });
    }
  });
  it('ignores malformed platform entries with a warning', () => {
    const warnings = [];
    const bad = [entry({ sha: 'abc' }), entry({ ruling: 'R1+' }), entry({ ruling: 'R1++R2' }), entry({ ruling: 'R1 R2' }), entry({ ruling: 'r1' }), entry({ findings: [] }), entry({ ref: '' }), null, 'x'];
    expect(mergeRuledWeakened(bad, [], (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(bad.length);
    expect(readyEvidence([record()], input, mergeRuledWeakened(bad, []))).toBeNull();
  });
  it('rejects non-string ref/sha/ruling (JSON-round-tripped) without throwing, warning once per entry', () => {
    const warnings = [];
    const json = (v) => JSON.parse(JSON.stringify(v));
    const bad = [
      entry({ ruling: json({ toString: null }) }), // RegExp.test coerces -> TypeError
      entry({ ruling: json(['R396']) }), // array coerces to "R396" and would alias a real ruling
      entry({ ruling: json({ toString: 'R396' }) }),
      entry({ ref: json({ toString: null }) }),
      entry({ sha: json({ toString: null }) }),
      entry({ sha: json([SHA]) }),
    ];
    let merged;
    expect(() => { merged = mergeRuledWeakened(bad, [], (m) => warnings.push(m)); }).not.toThrow();
    expect(merged).toEqual([]);
    expect(warnings).toHaveLength(bad.length);
  });
  it('drops non-string tool entries without throwing in the de-dup key, keeping valid ones', () => {
    const warnings = [];
    const json = (v) => JSON.parse(JSON.stringify(v));
    const tool = [entry({ ref: json({ toString: null }) }), entry({ ruling: json({ toString: null }) }), entry({ sha: json([SHA]) }), entry()];
    let merged;
    expect(() => { merged = mergeRuledWeakened([], tool, (m) => warnings.push(m)); }).not.toThrow();
    expect(merged.map((e) => [e.ref, e.layer])).toEqual([[REF, 'tool']]);
    expect(warnings).toHaveLength(3);
  });
  it('readyEvidence refuses a record with a non-string audit/auditRuling instead of throwing', () => {
    const json = (v) => JSON.parse(JSON.stringify(v));
    const hostile = [json({ toString: null }), json(['R396']), json(['NOT WEAKENED'])];
    for (const v of hostile) {
      expect(() => readyEvidence([record({ auditRuling: v })], input, [entry()])).not.toThrow();
      expect(readyEvidence([record({ auditRuling: v })], input, [entry()])).toBeNull();
      expect(() => readyEvidence([record({ audit: v })], input, [entry()])).not.toThrow();
      expect(readyEvidence([record({ audit: v })], input, [entry()])).toBeNull();
    }
  });
  it('refusal ignores hostile non-string at/kind/event/type without throwing', () => {
    const hostile = JSON.parse('{"toString":null}');
    const rows = [{ ref: REF, at: hostile, kind: 'removed' }, { ref: REF, at: '2026-01-02T00:00:00Z', kind: hostile, event: hostile, type: ['removed'] }];
    expect(() => refusal(rows, REF, 0)).not.toThrow();
    expect(refusal(rows, REF, 0)).toBeUndefined();
    expect(refusal([{ ref: REF, at: '2026-01-02T00:00:00Z', kind: hostile, event: 'dropped' }], REF, 0)).toBeDefined();
  });
  it('tolerates non-array layers', () => {
    expect(mergeRuledWeakened(undefined, 'x')).toEqual([]);
  });
});
