import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGhSync, recordGhWaitLogEntry, ghWaitLogCaller, GH_WAITLOG_FILENAME, GH_WAITLOG_MAX_BYTES } from '../gh-throttle.mjs';

function fixture(fn) {
  const lockRoot = mkdtempSync(join(tmpdir(), 'gh-waitlog-'));
  try { return fn(lockRoot); } finally { rmSync(lockRoot, { recursive: true, force: true }); }
}
const base = (lockRoot, extra = {}) => ({ lockRoot, env: {}, warn: vi.fn(), exec: vi.fn(() => '[]'), caller: 'drain.mjs', ...extra });
const lines = (lockRoot) => readFileSync(join(lockRoot, GH_WAITLOG_FILENAME), 'utf8').trim().split('\n').map(l => JSON.parse(l));

describe('gh-throttle wait log', () => {
  it('redacts a token-shaped caller (GH_CALLER / throttle.caller) and keeps normal labels', () => fixture(lockRoot => {
    runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: base(lockRoot, { caller: 'gh\x70_SECRET1234567890abcdefghijklmnop' }) });
    const raw = readFileSync(join(lockRoot, GH_WAITLOG_FILENAME), 'utf8');
    expect(raw).not.toContain('SECRET');
    expect(lines(lockRoot)[0].caller).toBe('redacted');
    expect(ghWaitLogCaller('we:scripts/pr-land.mjs')).toBe('we:scripts/pr-land.mjs');
    expect(ghWaitLogCaller('has space token')).toBe('redacted');
  }));
  it('when rotation fails, drops the line instead of growing past the cap', () => fixture(lockRoot => {
    const p = join(lockRoot, GH_WAITLOG_FILENAME);
    writeFileSync(p, 'x'.repeat(GH_WAITLOG_MAX_BYTES + 1));
    mkdirSync(`${p}.1`); // rename onto a directory fails
    writeFileSync(join(`${p}.1`, 'keep'), '');
    recordGhWaitLogEntry(p, { at: 'now', caller: 'c', op: 'pr list', waitMs: 1, durMs: 2, ok: true });
    expect(readFileSync(p, 'utf8')).toBe('x'.repeat(GH_WAITLOG_MAX_BYTES + 1));
  }));
  it('writes one JSONL line with at/caller/op/waitMs/durMs/ok per throttled call', () => fixture(lockRoot => {
    runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: base(lockRoot) });
    const [row, ...rest] = lines(lockRoot);
    expect(rest).toEqual([]);
    expect(Object.keys(row).sort()).toEqual(['at', 'caller', 'durMs', 'ok', 'op', 'waitMs']);
    expect(row).toMatchObject({ caller: 'drain.mjs', op: 'pr list', ok: true });
    expect(typeof row.at).toBe('string');
    expect(row.waitMs).toBeGreaterThanOrEqual(0);
    expect(row.durMs).toBeGreaterThanOrEqual(0);
  }));
  it('records ok:false for a failed call and still rethrows it', () => fixture(lockRoot => {
    const exec = vi.fn(() => { throw Object.assign(new Error('boom'), { status: 1, stderr: 'boom' }); });
    expect(() => runGhSync(['pr', 'view', '1'], { encoding: 'utf8', throttle: base(lockRoot, { exec }) })).toThrow('boom');
    expect(lines(lockRoot)[0]).toMatchObject({ op: 'pr view', ok: false });
  }));
  it('never records argv, tokens or a caller-supplied op label', () => fixture(lockRoot => {
    runGhSync(['api', 'repos/o/r', '-H', 'Authorization: token ghp_SECRET123'], { encoding: 'utf8', throttle: base(lockRoot, { op: 'leak ghp_SECRET123' }) });
    const raw = readFileSync(join(lockRoot, GH_WAITLOG_FILENAME), 'utf8');
    expect(raw).not.toContain('ghp_SECRET123');
    expect(raw).not.toContain('repos/o/r');
    expect(lines(lockRoot)[0].op).toBe('api');
  }));
  it('swallows a write failure: the call still succeeds', () => fixture(lockRoot => {
    const blocked = join(lockRoot, 'log-is-a-dir');
    mkdirSync(blocked);
    const out = runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: base(lockRoot, { waitLogPath: blocked }) });
    expect(out).toBe('[]');
    expect(() => recordGhWaitLogEntry(blocked, { at: 'x' })).not.toThrow();
  }));
  it('rotates past the size cap, keeping one generation', () => fixture(lockRoot => {
    expect(GH_WAITLOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    const p = join(lockRoot, GH_WAITLOG_FILENAME);
    writeFileSync(p, 'x'.repeat(GH_WAITLOG_MAX_BYTES + 1));
    recordGhWaitLogEntry(p, { at: 'now', caller: 'c', op: 'pr list', waitMs: 1, durMs: 2, ok: true });
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(1);
  }));
  it('does not change throttle behaviour: result and exec count are untouched', () => fixture(lockRoot => {
    const t = base(lockRoot);
    expect(runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: t })).toBe('[]');
    expect(t.exec).toHaveBeenCalledTimes(1);
  }));
});
