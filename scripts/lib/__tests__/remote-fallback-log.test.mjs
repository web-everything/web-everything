import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributionLogPath, ADVISORY_REASONS, isLocalDecisionReason, recordLocalSlotFallback, summarize, readFallbackLog, readFallbackRows } from '../remote-fallback-log.mjs';

describe('local decision reasons', () => {
  it.each([
    'explicit-local', 'explicit-container', 'admission-off', 'ci-bypass', 'no-pool',
    'raw-command', 'vitest-related-local-only', 'no-checkout-admission-wrapper', 'base-comparison-rerun',
    'remote.enabled=false (standard)',
    'remote.enabled=false (platform)',
    'remote.enabled=true (platform); loadPerCore=2.9 <= 3',
    'remote.enabled=true (platform); loadPerCore=3 <= 3',
    'remote.enabled=true (platform); load-unreadable',
  ])('classifies %s as diagnostic evidence rather than a remote failure', reason => {
    expect(isLocalDecisionReason(reason)).toBe(true);
    expect(summarize([{reason}])).toMatchObject({total: 1, real: 0, advisory: 1, topReal: null});
  });
  it.each([
    undefined, 'unknown', 'remote-disabled', 'explicit-local extra',
    'remote.enabled=true (platform); loadPerCore=NaN <= 3',
    'remote.enabled=true (platform); loadPerCore=0x1 <= 3',
    'remote.enabled=true (platform); loadPerCore=4 <= 3',
    'remote.enabled=true (platform); loadPerCore=2 <= 3; needs-git',
    'remote.enabled=true (platform); loadPerCore=2 <= 3; host overloaded',
  ])('keeps unknown or nonlocal reason %s as a real fallback', reason => {
    expect(isLocalDecisionReason(reason)).toBe(false);
    expect(summarize([{reason}]).real).toBe(1);
  });
});

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

describe('readFallbackLog', () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'rfl-read-'));
    roots.push(root);
    return join(root, 'remote-fallbacks.jsonl');
  };

  it('counts corrupt interior lines and retains a complete final object without newline', () => {
    const file = fixture();
    writeFileSync(file, '{"reason":"needs-git"}\ninvalid\n\n{"reason":\n{"reason":"credential-warn"}');
    expect(readFallbackRows(file)).toEqual([{ reason: 'needs-git' }, { reason: 'credential-warn' }]);
    expect(readFallbackLog(file)).toEqual({ rows: [{ reason: 'needs-git' }, { reason: 'credential-warn' }],
      invalid: 2, missing: false, partial: 0 });
  });

  it('distinguishes a missing log from an empty readable log', () => {
    const file = fixture();
    expect(readFallbackLog(file)).toEqual({ rows: [], invalid: 0, missing: true, partial: 0 });
    expect(readFallbackRows(file)).toEqual([]);
    writeFileSync(file, '');
    expect(readFallbackLog(file)).toEqual({ rows: [], invalid: 0, missing: false, partial: 0 });
    expect(readFallbackRows(file)).toEqual([]);
  });

  it.each(['null', '1', 'true', '"text"', '[]'])('counts parsed non-object %s as invalid even without a final newline', line => {
    const file = fixture();
    writeFileSync(file, `${line}\n${line}`);
    expect(readFallbackLog(file)).toEqual({ rows: [], invalid: 2, missing: false, partial: 0 });
  });

  it('counts only the unterminated final parse failure as partial, ignoring blank lines', () => {
    const file = fixture();
    writeFileSync(file, '{"reason":\n \t\n{"reason":"needs-git"}\n{"reason":');
    expect(readFallbackLog(file)).toEqual({ rows: [{ reason: 'needs-git' }], invalid: 1, missing: false, partial: 1 });
  });

  it('counts a malformed final line with a trailing newline as invalid', () => {
    const file = fixture();
    writeFileSync(file, '{"reason":\n');
    expect(readFallbackLog(file)).toEqual({ rows: [], invalid: 1, missing: false, partial: 0 });
  });

  it('surfaces non-missing read failures instead of reporting zero fallbacks', () => {
    expect(() => readFallbackLog(join(fixture(), 'bad\0path'))).toThrow();
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

describe('separate local attribution', () => {
  it.each(['raw-command', 'vitest-related-local-only', 'no-checkout-admission-wrapper', 'base-comparison-rerun'])(
    'records exactly one advisory %s row without creating the pool', reason => {
      const root = mkdtempSync(join(tmpdir(), 'verify-attribution-'));
      const lockRoot = join(root, 'pool', '.admission', 'heavy');
      try {
        const row = recordLocalSlotFallback({lockRoot, reason, repo:'lane-1', kind:'files'});
        expect(row).toMatchObject({reason});
        expect(existsSync(join(root, 'pool'))).toBe(false);
        const log = readFallbackLog(join(lockRoot, 'remote-fallbacks.jsonl'));
        expect(log.rows).toEqual([row]);
        expect(summarize(log.rows)).toMatchObject({real:0, advisory:1});
      } finally { rmSync(root, {recursive:true, force:true}); }
    });
  it('drops attribution best effort when all bounded ancestors are absent without creating a pool', () => {
    const root = mkdtempSync(join(tmpdir(), 'absent-ancestors-'));
    try {
      const lockRoot = join(root, 'missing', 'parent', 'pool', '.admission', 'heavy');
      expect(recordLocalSlotFallback({lockRoot, reason:'raw-command', repo:'lane'})).toBeNull();
      expect(existsSync(join(root, 'missing'))).toBe(false);
    } finally { rmSync(root, {recursive:true, force:true}); }
  });
  it('isolates sibling pools and lock roots even when their basenames sanitize identically', () => {
    const root = mkdtempSync(join(tmpdir(), 'pool-isolation-'));
    const roots = ['pool-a/.admission/heavy', 'pool-b/.admission/heavy', 'pool-a/.admission/heavy?', 'pool-a/.admission/heavy!'].map(p => join(root, p));
    try {
      const rows = roots.map((lockRoot, i) => recordLocalSlotFallback({lockRoot, reason:'no-pool', repo:`lane-${i}`, kind:'files'}));
      expect(new Set(roots.map(attributionLogPath)).size).toBe(roots.length);
      roots.forEach((lockRoot, i) => {
        expect(rows[i]).not.toBeNull();
        expect(readFallbackLog(join(lockRoot, 'remote-fallbacks.jsonl')).rows).toEqual([rows[i]]);
      });
      roots.forEach(lockRoot => mkdirSync(lockRoot, {recursive:true}));
      roots.forEach((lockRoot, i) => {
        recordLocalSlotFallback({lockRoot, reason:'explicit-local', repo:`lane-${i}`, kind:'files'});
        expect(readFallbackLog(join(lockRoot, 'remote-fallbacks.jsonl')).rows).toEqual([expect.objectContaining({reason:'explicit-local', lane:`lane-${i}`}), rows[i]]);
      });
    } finally { rmSync(root, {recursive:true, force:true}); }
  });
  it.each(['raw-command', 'vitest-related-local-only', 'no-checkout-admission-wrapper', 'base-comparison-rerun'])(
    'never throws when attribution for %s is unwritable', reason => {
      expect(recordLocalSlotFallback({lockRoot:'/dev/null/pool/heavy', reason, repo:'lane'})).toBeNull();
    });
  it('writes one row without creating a missing pool and reads it after pool creation', () => {
    const root = mkdtempSync(join(tmpdir(), 'attribution-'));
    const pool = join(root, 'pool'), lockRoot = join(pool, '.admission', 'heavy');
    try {
      const row = recordLocalSlotFallback({lockRoot, reason:'no-pool', repo:'lane-1', kind:'files'});
      expect(row).toMatchObject({reason:'no-pool'});
      expect(existsSync(pool)).toBe(false);
      expect(readFallbackLog(join(lockRoot, 'remote-fallbacks.jsonl')).rows).toEqual([row]);
      mkdirSync(lockRoot, {recursive:true});
      expect(readFallbackLog(join(lockRoot, 'remote-fallbacks.jsonl')).rows).toEqual([row]);
      recordLocalSlotFallback({lockRoot, reason:'explicit-local', repo:'lane-1', kind:'files'});
      expect(readFallbackLog(join(lockRoot, 'remote-fallbacks.jsonl')).rows).toHaveLength(2);
      expect(existsSync(join(lockRoot, 'remote-fallbacks.jsonl'))).toBe(false);
    } finally { rmSync(root, {recursive:true, force:true}); }
  });
  it('surfaces corrupt attribution evidence rather than hiding it', () => {
    const root = mkdtempSync(join(tmpdir(), 'attribution-corrupt-'));
    const lockRoot = join(root, 'heavy');
    try {
      const file = attributionLogPath(lockRoot);
      mkdirSync(join(file, '..'), {recursive:true});
      writeFileSync(file, 'bad\n{"reason":');
      expect(readFallbackLog(join(lockRoot, 'remote-fallbacks.jsonl'))).toMatchObject({invalid:1, partial:1, missing:false});
    } finally { rmSync(root, {recursive:true, force:true}); }
  });
});
