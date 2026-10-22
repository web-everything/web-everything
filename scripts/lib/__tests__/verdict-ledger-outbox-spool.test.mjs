/**
 * @file verdict-ledger-outbox-spool.test.mjs - the ledger OUTBOX + PLUMBING flush (live 2026-10-21: 3+ same-host writers
 *   raced 9-second worktree pushes to `ops/review-requests`, the losers exhausted 5 short retries and referral holds
 *   and rulings never persisted, #5502 #5530 #5773 #5742 #5768).
 *
 * The append writes its rows to a host-local outbox first, then ONE writer at a time (a host-wide flusher lock)
 * pushes everything queued as ONE plumbing commit. These tests pin the invariants: every row lands exactly once,
 * a crash between push and delete never duplicates, an off-host (CI) writer's push is retried on the new tip,
 * nothing is ever forced, and a failure still surfaces.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOutboxSettings, formatOutboxSettings, OUTBOX_ENV, enqueueOutboxEntry, listOutboxEntries,
  readEntry, tryLock, stillOwn, unlock, outboxLockRoot, OUTBOX_LOCK_PATH,
} from '../verdict-ledger-outbox-spool.mjs';
import { ledgerGitPath } from '../verdict-ledger-path.mjs';
import { buildLedgerEvent, checkLedgerAppendRows, parseLedgerEvents } from '../verdict-ledger.mjs';
import { lockDirFor, readLockEntry } from '../../readiness/file-locks.mjs';

const REPO = 'web-everything/web-everything';
const scratch = [];
const outbox = () => { const dir = mkdtempSync(join(tmpdir(), 'ob-regression-')); scratch.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const holdEntry = (extra = {}) => {
  const check = checkLedgerAppendRows([buildLedgerEvent({
    type: 'hold', repo: REPO, pr: 7, at: '2026-10-22T00:00:00.000Z', source: 'test',
    reasonCode: 'load-flake', holdSource: 'drain', ...extra,
  })], REPO);
  expect(check.ok).toBe(true);
  return { path: ledgerGitPath(REPO), repo: REPO, lines: check.lines, ids: check.ids };
};

describe('outbox JSONL framing', () => {
  it.each(['\n', '\r', '\r\n'])('refuses a physical line terminator %j before publication and on recovery', (separator) => {
    const dir = outbox();
    const entry = holdEntry();
    const line = entry.lines[0];
    entry.lines = [JSON.stringify(JSON.parse(line), null, 2).replaceAll('\n', separator)];
    expect(() => enqueueOutboxEntry(dir, entry)).toThrow(/single.line/);
    expect(readdirSync(dir)).toEqual([]);

    // A checksum-valid entry left by an older writer must be quarantined too.
    const name = '000000000000001-1-abcdef.json';
    const sum = createHash('sha256').update(JSON.stringify([entry.path, entry.repo, null, entry.lines, entry.ids])).digest('hex');
    writeFileSync(join(dir, name), JSON.stringify({ ...entry, sum }));
    const log = vi.fn();
    expect(readEntry(dir, name, log)).toEqual({ corrupt: true });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/single.line/));
    expect(listOutboxEntries(dir)).toEqual([]);
  });

  it('requires strings rather than values JSON.parse coerces into strings', () => {
    const dir = outbox();
    const entry = holdEntry();
    entry.lines = [[entry.lines[0]]];
    expect(() => enqueueOutboxEntry(dir, entry)).toThrow(/single.line/);
    expect(listOutboxEntries(dir)).toEqual([]);
  });

  it('keeps compact rows with escaped newlines, quotes and Unicode readable by the ledger reader', () => {
    const dir = outbox();
    const writer = 'text\n\r\u2028\u2029`"--../\u200b';
    const entry = holdEntry({ writer });
    // JSON.stringify escapes LF/CR. Raw Unicode separators inside strings are valid JSONL content.
    const name = enqueueOutboxEntry(dir, entry);
    const { entry: saved } = readEntry(dir, name, vi.fn());
    expect(saved.lines).toEqual(entry.lines);
    expect(parseLedgerEvents(`${saved.lines.join('\n')}\n`)).toMatchObject([{ writer }]);
  });
});

describe('outbox holder lease', () => {
  it.each([120_000, 600_000, 1_800_000])('honors the holder budget with a %i ms contender, including heartbeats and expiry', (budget) => {
    const dir = outbox();
    const start = Date.parse('2026-10-22T00:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      const owner = tryLock(dir, 600_000);
      expect(owner).toEqual(expect.any(String));
      vi.setSystemTime(start + 6 * 60_000);
      expect(tryLock(dir, budget)).toBeNull();
      expect(stillOwn(dir, owner)).toBe(true);
      vi.setSystemTime(start + 21 * 60_000);
      expect(tryLock(dir, budget)).toBeNull();
      vi.setSystemTime(start + 26 * 60_000);
      expect(tryLock(dir, budget)).toBeNull();
      vi.setSystemTime(start + 26 * 60_000 + 1);
      const next = tryLock(dir, budget);
      expect(next).toEqual(expect.any(String));
      expect(stillOwn(dir, owner)).toBe(false);
      unlock(dir, owner, vi.fn());
      expect(readLockEntry(outboxLockRoot(dir), OUTBOX_LOCK_PATH)?.owner).toBe(next);
    } finally { vi.useRealTimers(); }
  });

  it('reclaims a provably dead process without waiting for its recorded lease', () => {
    const dir = outbox();
    const owner = tryLock(dir, 600_000);
    const file = join(lockDirFor(outboxLockRoot(dir), OUTBOX_LOCK_PATH), 'lock.json');
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...entry, pid: process.pid + 1 }));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    const next = tryLock(dir, 120_000);
    expect(next).toEqual(expect.any(String));
    expect(next).not.toBe(owner);
  });

  it.each([undefined, null, 0, -1, '20'])('uses the shared default for missing or invalid holder lease %j', (leaseMinutes) => {
    const dir = outbox();
    const start = Date.parse('2026-10-22T00:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      tryLock(dir, 600_000);
      const file = join(lockDirFor(outboxLockRoot(dir), OUTBOX_LOCK_PATH), 'lock.json');
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...entry, meta: leaseMinutes === undefined ? undefined : { leaseMinutes } }));
      vi.setSystemTime(start + 6 * 60_000);
      expect(tryLock(dir, 120_000)).toBeNull();
      vi.setSystemTime(start + 15 * 60_000 + 1);
      expect(tryLock(dir, 1_800_000)).toEqual(expect.any(String));
    } finally { vi.useRealTimers(); }
  });
});

describe('outbox settings: a cascade, logged with its source', () => {
  it('defaults on, with a time budget and a stale age, sources named', () => {
    const s = resolveOutboxSettings({ repo: {}, env: {} });
    expect(s.enabled).toBe(true);
    expect(s.flushBudgetMs).toBeGreaterThan(10_000);
    expect(s.staleMs).toBeGreaterThan(s.flushBudgetMs);
    expect(s.sources).toEqual({ enabled: 'standard', flushBudgetMs: 'standard', staleMs: 'standard' });
  });

  it('is OFF in CI (an ephemeral runner would lose its outbox) unless the env forces it', () => {
    expect(resolveOutboxSettings({ repo: {}, env: { GITHUB_ACTIONS: 'true' } })).toMatchObject({ enabled: false, sources: { enabled: 'ci' } });
    expect(resolveOutboxSettings({ repo: {}, env: { GITHUB_ACTIONS: 'true', [OUTBOX_ENV]: '1' } })).toMatchObject({ enabled: true, sources: { enabled: 'env' } });
  });

  it('repo overrides standard, env overrides repo, invalid layers are ignored and named', () => {
    const s = resolveOutboxSettings({ repo: { verdictLedger: { outbox: false, flushBudgetMs: 30_000, outboxStaleMs: 'x' } }, env: {} });
    expect(s).toMatchObject({ enabled: false, flushBudgetMs: 30_000, sources: { enabled: 'repo', flushBudgetMs: 'repo', staleMs: 'standard' } });
    expect(s.invalid).toEqual(['repo.verdictLedger.outboxStaleMs']);
    expect(formatOutboxSettings(s)).toMatch(/verdictLedger\.flushBudgetMs=30000 \(repo\)/);
  });
});

describe('real git: outbox + plumbing flush', () => {
  it('a short or corrupt entry write throws BEFORE anything is queued (read-back check)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ob-')), 'outbox');
    const bad = { path: ledgerGitPath(REPO), repo: REPO, message: 'm', lines: ['{"not":"an event"}'], ids: ['x'] };
    expect(() => enqueueOutboxEntry(dir, bad)).toThrow(/write check/);
    expect(listOutboxEntries(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
