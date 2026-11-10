import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadyRecord, writeReadyRecord, readyRecordPath, parseArgs } from '../fix-ready-record.mjs';
import { readyEvidence } from '../prototype-load.mjs';

const sha = 'b7bb8b2743e5c582d44e22e71a40f9e23ae07f6b';
const ref = 'lane/example';
const base = { ref, sha, tests: 'green' };
const findings = ['a.mjs:1 — one', 'b.mjs:2 — two'];
const tmp = () => join(mkdtempSync(join(tmpdir(), 'fix-ready-')), 'fix-ready.jsonl');

describe('fix-ready-record', () => {
  it('builds NOT WEAKENED and WEAKENED records the reader accepts', () => {
    const ok = buildReadyRecord({ ...base, audit: 'NOT WEAKENED' });
    expect(ok.record).toEqual({ ref, sha, tests: 'green', audit: 'NOT WEAKENED' });
    const w = buildReadyRecord({ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings });
    expect(readyEvidence([w.record], { branch: ref, sha }, [{ ref, sha, ruling: 'R816', findings }]).source).toBe('ready-record');
  });
  it.each([
    [{ ...base, sha: 'abc', audit: 'NOT WEAKENED' }, /40-hex/],
    [{ ...base, ref: ' ', audit: 'NOT WEAKENED' }, /ref/],
    [{ ...base, tests: 'red', audit: 'NOT WEAKENED' }, /green/],
    [{ ...base, audit: 'maybe' }, /audit must be/],
    [{ ...base, audit: 'WEAKENED', auditDisclosed: findings }, /auditRuling/],
    [{ ...base, audit: 'WEAKENED', auditRuling: 'x', auditDisclosed: findings }, /auditRuling/],
    [{ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: [] }, /auditDisclosed/],
    [{ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: ['ok', ' '] }, /auditDisclosed/],
    [{ ...base, audit: 'NOT WEAKENED', auditRuling: 'R816' }, /only belong/],
  ])('refuses invalid input %#', (input, message) => {
    const r = buildReadyRecord(input);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(message);
  });
  it('appends one line and refuses a duplicate ref+sha', () => {
    const file = tmp();
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    const dup = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file });
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/duplicate/);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(writeReadyRecord({ ...base, ref: 'lane/other', audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('reports an unreadable (non-ENOENT) file without writing', () => {
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file: tmpdir() });
    expect(r.ok).toBe(false);
  });
  it('resolves the reader path with ~ expanded against HOME and parses args', () => {
    const settingsFile = join(mkdtempSync(join(tmpdir(), 'fix-ready-s-')), 'p.json');
    writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: '~/x/fix-ready.jsonl' }));
    expect(readyRecordPath({ env: { HOME: '/h' }, settingsFile })).toBe('/h/x/fix-ready.jsonl');
    expect(readyRecordPath({ env: { HOME: '/h' } })).toMatch(/\/h\/.*fix-ready\.jsonl$/);
    expect(parseArgs(['--ref=a', '--audit=NOT-WEAKENED'])).toEqual({ ref: 'a', audit: 'NOT-WEAKENED' });
  });
});
