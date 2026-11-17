import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADVISORY_REASONS, recordLocalSlotFallback, summarize, readFallbackRows } from '../remote-fallback-log.mjs';

describe('summarize', () => {
  it('excludes credential warnings from real counts and the top cause', () => {
    expect(ADVISORY_REASONS).toEqual(new Set(['credential-warn']));
    const rows = [
      ...Array.from({ length: 5 }, () => ({ reason: 'credential-warn' })),
      { reason: 'remote-disabled' }, { reason: 'needs-git' }, { reason: 'needs-git' },
    ];
    expect(summarize(rows)).toEqual({ total: 8, advisory: 5, real: 3,
      byReason: { 'remote-disabled': 1, 'needs-git': 2 },
      advisoryByReason: { 'credential-warn': 5 }, topReal: { reason: 'needs-git', count: 2 } });
  });

  it('returns zero counts for empty or non-object rows', () => {
    const empty = { total: 0, advisory: 0, real: 0, byReason: {}, advisoryByReason: {}, topReal: null };
    expect(summarize([])).toEqual(empty);
    expect(summarize([null, undefined, 1, 'text', true, []])).toEqual(empty);
  });

  it('has no top real cause for advisory-only rows', () => {
    expect(summarize([{ reason: 'credential-warn' }])).toEqual({ total: 1, advisory: 1, real: 0,
      byReason: {}, advisoryByReason: { 'credential-warn': 1 }, topReal: null });
  });

  it('keeps unknown and prototype-like reasons as real, and breaks ties by encounter order', () => {
    const result = summarize([{ reason: '__proto__' }, { reason: 'constructor' }, {}, { reason: null }]);
    expect(result.byReason).toEqual(JSON.parse('{"__proto__":1,"constructor":1,"unknown":2}'));
    expect(result.topReal).toEqual({ reason: 'unknown', count: 2 });
    expect(summarize([{ reason: 'b' }, { reason: 'a' }]).topReal).toEqual({ reason: 'b', count: 1 });
    expect(result.real).toBe(4);
  });
});

describe('readFallbackRows', () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'rfl-read-'));
    roots.push(root);
    return join(root, 'remote-fallbacks.jsonl');
  };

  it('reads valid JSONL around malformed and partial lines, including a complete final line without newline', () => {
    const file = fixture();
    writeFileSync(file, '{"reason":"needs-git"}\ninvalid\n\n{"reason":\n{"reason":"credential-warn"}');
    expect(readFallbackRows(file)).toEqual([{ reason: 'needs-git' }, { reason: 'credential-warn' }]);
  });

  it('returns no rows when missing or empty', () => {
    const file = fixture();
    expect(readFallbackRows(file)).toEqual([]);
    writeFileSync(file, '');
    expect(readFallbackRows(file)).toEqual([]);
  });

  it('surfaces non-missing read failures instead of reporting zero fallbacks', () => {
    expect(() => readFallbackRows(join(fixture(), 'bad\0path'))).toThrow();
  });
});

describe('recordLocalSlotFallback', () => {
  it('appends one heavy-report-shaped row per call', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfl-'));
    try {
      recordLocalSlotFallback({ lockRoot: root, reason: 'remote-disabled', repo: '/x/lane-43', kind: 'test-unit', now: () => 0 });
      recordLocalSlotFallback({ lockRoot: root, reason: 'r2', repo: '/x/lane-43', kind: 'k' });
      const rows = readFileSync(join(root, 'remote-fallbacks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ ts: '1970-01-01T00:00:00.000Z', reason: 'remote-disabled', detail: null, lane: 'lane-43', kind: 'test-unit' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('never throws on an unwritable root', () => {
    expect(recordLocalSlotFallback({ lockRoot: '/dev/null/x', reason: 'r', repo: '/x/l', kind: 'k' })).toBeNull();
    expect(() => recordLocalSlotFallback({})).not.toThrow();
  });
});

describe('recordLocalSlotFallback detail', () => {
  it('records a bounded detail and keeps null when absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfl-detail-'));
    try {
      const withDetail = recordLocalSlotFallback({ lockRoot: root, reason: 'raw-command', detail: 'npx vitest run', repo: '/x/lane-1', kind: 'files', now: () => 0 });
      expect(withDetail.detail).toBe('npx vitest run');
      expect(recordLocalSlotFallback({ lockRoot: root, reason: 'raw-command', repo: '/x/lane-1', kind: 'files', now: () => 0 }).detail).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('verify-lane local-slot paths', () => {
  it('every acquireSlotBlocking call in verify-lane.mjs is preceded by recordLocalSlotFallback', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'verify-lane.mjs'), 'utf8');
    const lines = src.split('\n');
    const calls = lines.map((l, i) => (/\bawait acquireSlotBlocking\(/.test(l) || /= await acquireSlotBlocking\(/.test(l) ? i : -1)).filter(i => i >= 0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const i of calls) {
      const before = lines.slice(Math.max(0, i - 4), i).join('\n');
      expect(before, `acquireSlotBlocking at line ${i + 1} must log a fallback row`).toMatch(/recordLocalSlotFallback\(/);
    }
  });
});
