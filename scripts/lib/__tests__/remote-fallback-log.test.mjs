import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordLocalSlotFallback } from '../remote-fallback-log.mjs';

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
