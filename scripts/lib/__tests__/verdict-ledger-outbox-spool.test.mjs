/**
 * @file verdict-ledger-outbox-spool.test.mjs - layer 1: settings, durable local publication,
 * validation/quarantine, retryable reads, stale diagnostics, and the host-wide flusher lock.
 * Flush and remote-push invariants belong to the later layers that call this spool.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  resolveOutboxSettings, formatOutboxSettings, OUTBOX_ENV, enqueueOutboxEntry, listOutboxEntries,
  readEntry, tryLock, stillOwn, unlock, outboxLockRoot, OUTBOX_LOCK_PATH,
  oldestAgeMs, reportIfStale, staleLine, safeLog, defaultLog, defaultSleep,
  FLUSH_BUDGET_ENV, OUTBOX_STALE_ENV, OUTBOX_DIR_ENV,
} from '../verdict-ledger-outbox-spool.mjs';
import { ledgerGitPath } from '../verdict-ledger-path.mjs';
import { buildLedgerEvent, checkLedgerAppendRows, parseLedgerEvents } from '../verdict-ledger.mjs';
import { lockDirFor, readLockEntry } from '../../readiness/file-locks.mjs';

// Node's named builtin exports must be synchronized after replacing a default-export
// method. Spy on the guarded native fs so faults also reach already-loaded ESM consumers.
function spyOnFs(method) {
  const spy = vi.spyOn(fs, method);
  syncBuiltinESMExports();
  return spy;
}

const REPO = 'web-everything/web-everything';
const scratch = [];
const outbox = () => { const dir = mkdtempSync(join(tmpdir(), 'ob-regression-')); scratch.push(dir); return dir; };
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const holdEntry = (extra = {}) => {
  const check = checkLedgerAppendRows([buildLedgerEvent({
    type: 'hold', repo: REPO, pr: 7, at: '2026-10-22T00:00:00.000Z', source: 'test',
    reasonCode: 'load-flake', holdSource: 'drain', ...extra,
  })], REPO);
  expect(check.ok).toBe(true);
  return { path: ledgerGitPath(REPO), repo: REPO, lines: check.lines, ids: check.ids };
};

const checksum = (entry) => createHash('sha256')
  .update(JSON.stringify([entry.path, entry.repo, entry.originKey ?? null, entry.lines, entry.ids])).digest('hex');
const sealed = (entry) => ({ ...entry, sum: checksum(entry) });
const ioError = () => Object.assign(new Error('injected I/O failure'), { code: 'EACCES' });

// Split-layer checklist: exercise every public helper here, and give each reachable validation
// clause an independent rejection case. Deeper guards receive a recomputed checksum.
// Publication, recovery and diagnostics get fault cases. ledgerEventId honors explicit ids:
// after row.id === ids[i], its remaining reachable rejection is an invalid ledger event.
describe('outbox validation and recovery', () => {
  it.each([
    ['null entry', () => null, /malformed entry/],
    ['array entry', () => [], /malformed entry/],
    ['non-string path', e => ({ ...e, path: 1 }), /malformed entry/],
    ['non-string repo', e => ({ ...e, repo: null }), /malformed entry/],
    ['non-array lines', e => ({ ...e, lines: null }), /malformed entry/],
    ['non-array ids', e => ({ ...e, ids: null }), /malformed entry/],
    ['empty rows', e => ({ ...e, lines: [], ids: [] }), /malformed entry/],
    ['unequal row and id counts', e => ({ ...e, ids: [] }), /malformed entry/],
    ['wrong checksum', e => ({ ...e, sum: 'wrong' }), /integrity sum mismatch/],
    ['tampered origin key', e => ({ ...e, originKey: 'another-remote' }), /integrity sum mismatch/],
    ['wrong ledger path', e => sealed({ ...e, path: '../other.jsonl' }), /not the ledger path/],
    ['non-string row', e => sealed({ ...e, lines: [42] }), /single-line JSON string/],
    ['non-JSON row', e => sealed({ ...e, lines: ['{'] }), /line 0 is not JSON/],
    ['primitive row', e => sealed({ ...e, lines: ['null'] }), /does not carry id/],
    ['row id differs', e => sealed({ ...e, ids: ['different'] }), /does not carry id different/],
    ['row repo differs', e => sealed({ ...e, lines: [JSON.stringify({ ...JSON.parse(e.lines[0]), repo: 'other/repo' })] }), /is for other\/repo/],
    ['invalid ledger event', e => sealed({ ...e, lines: [JSON.stringify({ ...JSON.parse(e.lines[0]), type: 'unknown' })] }), /line 0 invalid:/],
    ['invalid second row', e => sealed({ ...e, lines: [...e.lines, '{'], ids: [...e.ids, 'second'] }), /line 1 is not JSON/],
  ])('quarantines %s with its original bytes and a diagnostic', (_label, tamper, reason) => {
    const dir = outbox();
    const name = '000000000000001-1-abcdef.json';
    const bytes = JSON.stringify(tamper(sealed(holdEntry())));
    writeFileSync(join(dir, name), bytes);
    const log = vi.fn();
    expect(readEntry(dir, name, log)).toEqual({ corrupt: true });
    expect(readdirSync(dir)).toEqual([`.corrupt-${name}`]);
    expect(readFileSync(join(dir, `.corrupt-${name}`), 'utf8')).toBe(bytes);
    expect(listOutboxEntries(dir)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(reason));
    expect(log.mock.calls[0][0]).toContain('ledger-write-miss:');
    expect(log.mock.calls[0][0]).toContain(`set aside as .corrupt-${name}`);
  });

  it('quarantines non-JSON entry content', () => {
    const dir = outbox();
    const name = '000000000000001-1-abcdef.json';
    writeFileSync(join(dir, name), '{');
    const log = vi.fn();
    expect(readEntry(dir, name, log)).toEqual({ corrupt: true });
    expect(readFileSync(join(dir, `.corrupt-${name}`), 'utf8')).toBe('{');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not JSON'));
  });

  it('preserves retryable read errors unchanged, then recovers the same entry', () => {
    const dir = outbox();
    const name = enqueueOutboxEntry(dir, holdEntry());
    const bytes = readFileSync(join(dir, name), 'utf8');
    const error = ioError();
    const log = vi.fn();
    spyOnFs('readFileSync').mockImplementationOnce(() => { throw error; });
    expect(readEntry(dir, name, log)).toEqual({ io: error });
    expect(readdirSync(dir)).toEqual([name]);
    expect(readFileSync(join(dir, name), 'utf8')).toBe(bytes);
    expect(readEntry(dir, name, log)).toEqual({ entry: JSON.parse(bytes) });
    expect(log).not.toHaveBeenCalled();
  });

  it('returns gone for a missing entry without logging or quarantining', () => {
    const dir = outbox();
    const log = vi.fn();
    expect(readEntry(dir, '000000000000001-1-abcdef.json', log)).toEqual({ gone: true });
    expect(readdirSync(dir)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps corrupt content retryable when quarantine rename fails', () => {
    const dir = outbox();
    const name = '000000000000001-1-abcdef.json';
    writeFileSync(join(dir, name), '{');
    const error = ioError();
    spyOnFs('renameSync').mockImplementationOnce(() => { throw error; });
    const log = vi.fn();
    expect(readEntry(dir, name, log)).toEqual({ io: error });
    expect(readFileSync(join(dir, name), 'utf8')).toBe('{');
    expect(log).not.toHaveBeenCalled();
    expect(readEntry(dir, name, log)).toEqual({ corrupt: true });
  });

  it('returns corrupt after quarantine even when its diagnostic sink throws', () => {
    const dir = outbox();
    const name = '000000000000001-1-abcdef.json';
    writeFileSync(join(dir, name), '{');
    const log = vi.fn(() => { throw new Error('sink failed'); });
    expect(readEntry(dir, name, log)).toEqual({ corrupt: true });
    expect(readdirSync(dir)).toEqual([`.corrupt-${name}`]);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

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
  it.each(['maybe', '2', 'null', ' '])('ignores and names invalid env boolean %j without overriding the repo', (value) => {
    const s = resolveOutboxSettings({ repo: { verdictLedger: { outbox: false } }, env: { [OUTBOX_ENV]: value } });
    expect(s).toMatchObject({ enabled: false, sources: { enabled: 'repo' }, invalid: [`env.${OUTBOX_ENV}`] });
    expect(formatOutboxSettings(s)).toContain(`ignored invalid: env.${OUTBOX_ENV}`);
  });

  it.each([[' YES ', true], ['TrUe', true], ['on', true], ['0', false], [' OFF ', false], ['no', false]])(
    'accepts env boolean %j with env precedence', (value, enabled) => {
      expect(resolveOutboxSettings({ repo: { verdictLedger: { outbox: !enabled } }, env: { [OUTBOX_ENV]: value } }))
        .toMatchObject({ enabled, sources: { enabled: 'env' }, invalid: [] });
    });

  it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])('ignores invalid env durations %j', (value) => {
    expect(resolveOutboxSettings({
      repo: { verdictLedger: { flushBudgetMs: 100, outboxStaleMs: 200 } },
      env: { [FLUSH_BUDGET_ENV]: value, [OUTBOX_STALE_ENV]: value },
    })).toMatchObject({ flushBudgetMs: 100, staleMs: 200,
      sources: { flushBudgetMs: 'repo', staleMs: 'repo' }, invalid: [`env.${FLUSH_BUDGET_ENV}`, `env.${OUTBOX_STALE_ENV}`] });
  });

  it('takes valid env durations and treats empty env values as unset', () => {
    expect(resolveOutboxSettings({ env: { [FLUSH_BUDGET_ENV]: ' 123 ', [OUTBOX_STALE_ENV]: '456' } }))
      .toMatchObject({ flushBudgetMs: 123, staleMs: 456, sources: { flushBudgetMs: 'env', staleMs: 'env' }, invalid: [] });
    expect(resolveOutboxSettings({ env: { [OUTBOX_ENV]: '', [FLUSH_BUDGET_ENV]: '', [OUTBOX_STALE_ENV]: '' } }))
      .toEqual(resolveOutboxSettings({ env: {} }));
    // This layer exports the directory key; directory resolution belongs to its later caller.
    expect(OUTBOX_DIR_ENV).toBe('WE_VERDICT_LEDGER_OUTBOX_DIR');
  });

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

describe('outbox publication', () => {
  it.each(['short write', 'altered read-back bytes'])('rejects %s before rename and cleans up the temporary file', (fault) => {
    const dir = outbox();
    const realWrite = fs.writeFileSync;
    if (fault === 'short write') {
      spyOnFs('writeFileSync').mockImplementationOnce((fd, text) => realWrite(fd, text.slice(0, -2)));
    } else {
      const realRead = fs.readFileSync;
      // Still valid JSON with the same payload and checksum: only byte comparison detects this.
      spyOnFs('readFileSync').mockImplementationOnce((...args) => `${realRead(...args)} `);
    }
    const rename = spyOnFs('renameSync');
    expect(() => enqueueOutboxEntry(dir, holdEntry())).toThrow(/read-back differs/);
    expect(rename).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fsyncs and closes the file before read-back and rename, then syncs every ancestor on every enqueue', () => {
    const root = outbox();
    const dir = join(root, 'nested', 'outbox');
    const calls = [];
    const paths = new Map();
    for (const method of ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'readFileSync', 'renameSync']) {
      const real = fs[method];
      spyOnFs(method).mockImplementation((...args) => {
        calls.push([method, paths.get(args[0]) ?? args[0]]);
        const result = real(...args);
        if (method === 'openSync') paths.set(result, args[0]);
        if (method === 'closeSync') paths.delete(args[0]);
        return result;
      });
    }
    const ancestors = [];
    for (let d = resolve(dir); ; d = dirname(d)) { ancestors.push(d); if (dirname(d) === d) break; }
    for (let i = 0; i < 2; i += 1) {
      calls.length = 0;
      const name = enqueueOutboxEntry(dir, holdEntry());
      const tmp = join(dir, `.tmp-${name}`);
      const renameIndex = calls.findIndex(([method]) => method === 'renameSync');
      expect(calls.slice(renameIndex - 5, renameIndex + 1)).toEqual([
        ['openSync', tmp], ['writeFileSync', tmp], ['fsyncSync', tmp], ['closeSync', tmp],
        ['readFileSync', tmp], ['renameSync', tmp],
      ]);
      expect(calls.slice(renameIndex + 1)).toEqual(ancestors.flatMap(d => [
        ['openSync', d], ['fsyncSync', d], ['closeSync', d],
      ]));
      if (i === 0) {
        expect(calls.slice(0, renameIndex - 5)).toEqual([join(root, 'nested'), root].flatMap(d => [
          ['openSync', d], ['fsyncSync', d], ['closeSync', d],
        ]));
      } else expect(renameIndex).toBe(5);
    }
  });

  it('fails before publication on file fsync failure, closes the descriptor and cleans up', () => {
    const dir = outbox();
    const error = ioError();
    const close = spyOnFs('closeSync');
    const rename = spyOnFs('renameSync');
    spyOnFs('fsyncSync').mockImplementationOnce(() => { throw error; });
    expect(() => enqueueOutboxEntry(dir, holdEntry())).toThrow(error);
    expect(close).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not publish if syncing a newly created directory fails', () => {
    const dir = join(outbox(), 'nested', 'outbox');
    const error = ioError();
    const close = spyOnFs('closeSync');
    const rename = spyOnFs('renameSync');
    spyOnFs('fsyncSync').mockImplementationOnce(() => { throw error; });
    expect(() => enqueueOutboxEntry(dir, holdEntry())).toThrow(error);
    expect(close).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EBADF'])('tolerates unsupported directory fsync %s', (code) => {
    const dir = outbox();
    const realSync = fs.fsyncSync;
    spyOnFs('fsyncSync').mockImplementationOnce(realSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('unsupported'), { code });
    });
    const log = vi.fn();
    const name = enqueueOutboxEntry(dir, holdEntry(), { log });
    expect(listOutboxEntries(dir)).toEqual([name]);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([false, true])('returns the published name on directory fsync failure (throwing logger: %s)', (throwing) => {
    const dir = outbox();
    const realSync = fs.fsyncSync;
    spyOnFs('fsyncSync').mockImplementationOnce(realSync).mockImplementationOnce(() => { throw ioError(); });
    const log = vi.fn(() => { if (throwing) throw new Error('sink failed'); });
    const name = enqueueOutboxEntry(dir, holdEntry(), { log });
    expect(listOutboxEntries(dir)).toEqual([name]);
    expect(readEntry(dir, name, vi.fn())).toMatchObject({ entry: holdEntry() });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`failed after queuing ${name}`));
    expect(log.mock.calls[0][0]).toContain('ledger-write-miss:');
  });

  it('rejects an invalid event before publication and removes its temporary file', () => {
    const dir = join(outbox(), 'outbox');
    const bad = { path: ledgerGitPath(REPO), repo: REPO, message: 'm', lines: ['{"not":"an event"}'], ids: ['x'] };
    expect(() => enqueueOutboxEntry(dir, bad)).toThrow(/write check/);
    expect(listOutboxEntries(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('outbox stale diagnostics', () => {
  it('reports the oldest of multiple entries only after the strict stale boundary', () => {
    const dir = outbox();
    const first = 1_000_000;
    const staleMs = 120_000;
    // Enqueue newest first to catch reliance on directory insertion order or the last sorted name.
    enqueueOutboxEntry(dir, holdEntry(), { now: () => first + 60_000 });
    enqueueOutboxEntry(dir, holdEntry(), { now: () => first });
    const log = vi.fn();
    for (const ageMs of [staleMs - 1, staleMs, staleMs + 1]) {
      expect(oldestAgeMs(dir, first + ageMs)).toEqual({ count: 2, ageMs });
      expect(reportIfStale({ dir, staleMs, log, now: () => first + ageMs }, 'test flush')).toBe(ageMs > staleMs);
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`ledger-write-miss: verdict-ledger outbox ${dir} holds 2 entries, oldest 2m old (test flush)`);
    expect(oldestAgeMs(dir, first - 1)).toEqual({ count: 2, ageMs: 0 });
    expect(staleLine(dir, { count: 1, ageMs: 90_000 }, 'held')).toBe(
      `ledger-write-miss: verdict-ledger outbox ${dir} holds 1 entry, oldest 2m old (held)`);
  });

  it('does not report an empty or missing outbox, ignoring temporary and quarantined files', () => {
    const dir = outbox();
    writeFileSync(join(dir, '.tmp-000000000000001-1-abcdef.json'), '{}');
    writeFileSync(join(dir, '.corrupt-000000000000001-1-abcdef.json'), '{}');
    const log = vi.fn();
    for (const path of [dir, join(dir, 'missing')]) {
      expect(oldestAgeMs(path, 1_000_000)).toEqual({ count: 0, ageMs: 0 });
      expect(reportIfStale({ dir: path, now: () => 1_000_000, staleMs: 1, log }, 'empty')).toBe(false);
    }
    expect(log).not.toHaveBeenCalled();
  });

  it.each([false, true])('treats inspection failure as stale, without throwing (throwing logger: %s)', (throwing) => {
    const dir = outbox();
    spyOnFs('readdirSync').mockImplementationOnce(() => { throw ioError(); });
    const log = vi.fn(() => { if (throwing) throw new Error('sink failed'); });
    expect(reportIfStale({ dir, now: () => 1_000_000, staleMs: 1, log }, 'retry later')).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot be inspected (injected I/O failure); retry later'));
  });

  it('preserves the stale result when the diagnostic sink throws', () => {
    const dir = outbox();
    enqueueOutboxEntry(dir, holdEntry(), { now: () => 1 });
    const log = vi.fn(() => { throw new Error('sink failed'); });
    expect(reportIfStale({ dir, now: () => 10, staleMs: 1, log }, 'held')).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('outbox never-throw helpers', () => {
  it('releases an owned lock and permits a subsequent owner', () => {
    const dir = outbox();
    const owner = tryLock(dir, 120_000);
    const log = vi.fn();
    unlock(dir, owner, log);
    expect(readLockEntry(outboxLockRoot(dir), OUTBOX_LOCK_PATH)).toBeNull();
    expect(stillOwn(dir, owner)).toBe(false);
    expect(tryLock(dir, 120_000)).toEqual(expect.any(String));
    expect(log).not.toHaveBeenCalled();
  });

  it('treats heartbeat I/O failure as lost ownership and leaves the lock for its lease', () => {
    const dir = outbox();
    const owner = tryLock(dir, 120_000);
    const write = spyOnFs('writeFileSync').mockImplementation(() => { throw ioError(); });
    const log = vi.fn();
    expect(stillOwn(dir, owner)).toBe(false);
    expect(() => unlock(dir, owner, log)).not.toThrow();
    expect(readLockEntry(outboxLockRoot(dir), OUTBOX_LOCK_PATH)?.owner).toBe(owner);
    expect(log).not.toHaveBeenCalled();
    write.mockRestore();
    syncBuiltinESMExports();
  });

  it('safeLog and defaultLog swallow diagnostic sink failures', () => {
    const log = vi.fn(() => { throw new Error('sink failed'); });
    expect(() => safeLog(log)('diagnostic')).not.toThrow();
    expect(log).toHaveBeenCalledWith('diagnostic');
    vi.spyOn(process.stderr, 'write').mockImplementationOnce(() => { throw ioError(); });
    expect(() => defaultLog('diagnostic')).not.toThrow();
  });

  it('defaultSleep forwards its bounded timeout to Atomics.wait', () => {
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    defaultSleep(7);
    expect(wait).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 7);
  });

  it.each([false, true])('unlock leaves a failed release to its lease without throwing (throwing logger: %s)', (throwing) => {
    const dir = outbox();
    const owner = tryLock(dir, 120_000);
    spyOnFs('renameSync').mockImplementationOnce(() => { throw ioError(); });
    const log = vi.fn(() => { if (throwing) throw new Error('sink failed'); });
    expect(() => unlock(dir, owner, log)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('releasing the flusher lock'));
    expect(readLockEntry(outboxLockRoot(dir), OUTBOX_LOCK_PATH)?.owner).toBe(owner);
  });
});
