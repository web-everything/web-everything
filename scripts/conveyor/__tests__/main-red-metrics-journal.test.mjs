import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendMainRedMetrics, readMainRedMetrics, metricRecovery } from '../main-red-metrics-journal.mjs';

const metric = (changes = {}) => ({ v: 1, key: 'fixture-event', repo: 'fixture/repo', head: 'abcdef0',
  seq: 1, runId: 1, kind: 'red', at: 1000, since: 0, queue: { waitMs: 100, serviceMs: null },
  signature: null, truncated: false, ...changes });
const inJournal = async action => {
  const dir = mkdtempSync(join(tmpdir(), 'red-metrics-'));
  try { await action(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('red metrics journal acknowledgement', () => {
  it('rejects persisted filename/key mismatches while retaining correctly named evidence', () => inJournal(dir => {
    const e = metric();
    expect(appendMainRedMetrics(dir, [e])).toEqual({ warnings: [] });
    const misplaced = metric({ key: 'misplaced' });
    writeFileSync(join(dir, 'main-red-metrics', 'different-key.json'), JSON.stringify(misplaced));
    const replay = readMainRedMetrics(dir);
    expect(replay.events).toEqual([e]);
    expect(replay.warnings.join(' ')).toMatch(/Incomplete.*filename.*key.*archive.*recover/i);
    expect(readdirSync(join(dir, 'main-red-metrics')).sort())
      .toEqual(['different-key.json', `${e.key}.json`]);
  }));

  it('refuses new journal events at capacity while acknowledging existing events', async () => {
    const { readdirSync } = await import('node:fs');
    const { appendMainRedMetrics } = await import('../main-red-metrics-journal.mjs');
    await inJournal(async dir => {
      const event = metric();
      const second = { ...event, key: 'second' };
      expect(appendMainRedMetrics(dir, [event], { limit: 1 }).warnings).toEqual([]);
      expect(appendMainRedMetrics(dir, [event], { limit: 1 }).warnings).toEqual([]);
      const writeFile = vi.fn();
      expect(appendMainRedMetrics(dir, [second], { limit: 1, writeFile }).warnings).toHaveLength(1);
      expect(writeFile).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, 'main-red-metrics'))).toEqual([`${event.key}.json`]);
    });
  });

  it('bounds directory iteration for readers and appenders including the overflow probe', async () => {
    const { mkdirSync } = await import('node:fs');
    const { appendMainRedMetrics, readMainRedMetrics } = await import('../main-red-metrics-journal.mjs');
    await inJournal(async dir => {
      mkdirSync(join(dir, 'main-red-metrics'));
      const event = metric();
      const entries = Array(4).fill({ name: 'entry.json', isFile: () => true });
      let index = 0;
      const readSync = vi.fn(() => entries[index++] ?? null);
      const closeSync = vi.fn();
      const openDir = () => ({ readSync, closeSync });
      expect(readMainRedMetrics(dir, { limit: 2, openDir }).warnings).toHaveLength(1);
      expect(readSync).toHaveBeenCalledTimes(3);
      expect(closeSync).toHaveBeenCalledTimes(1);
      readSync.mockClear(); closeSync.mockClear();
      index = 0;
      const writeFile = vi.fn();
      expect(appendMainRedMetrics(dir, [event], { limit: 2, openDir, writeFile }).warnings).toHaveLength(1);
      expect(readSync).toHaveBeenCalledTimes(3);
      expect(closeSync).toHaveBeenCalledTimes(1);
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  it('bounds event bytes read to eight KiB plus one overflow byte', async () => {
    const { readSync } = await import('node:fs');
    const { appendMainRedMetrics, readMainRedMetrics } = await import('../main-red-metrics-journal.mjs');
    await inJournal(async dir => {
      const event = metric();
      appendMainRedMetrics(dir, [event]);
      const path = join(dir, 'main-red-metrics', `${event.key}.json`);
      writeFileSync(path, JSON.stringify(event).padEnd(8192, ' '));
      const read = vi.fn((...args) => readSync(...args));
      expect(readMainRedMetrics(dir, { read }).events).toEqual([event]);
      expect(read).toHaveBeenCalled();
      expect(read.mock.results.reduce((sum, result) => sum + result.value, 0)).toBeLessThanOrEqual(8193);
      expect(read.mock.calls.every(args => args[2] + args[3] <= 8193)).toBe(true);
      writeFileSync(path, JSON.stringify(event).padEnd(16384, ' '));
      read.mockClear();
      const oversized = readMainRedMetrics(dir, { read });
      expect(oversized.events).toEqual([]);
      expect(oversized.warnings.join(' ')).toMatch(/oversized.*archive/i);
      expect(read).toHaveBeenCalled();
      expect(read.mock.results.reduce((sum, result) => sum + result.value, 0)).toBeLessThanOrEqual(8193);
      expect(read.mock.calls.every(args => args[2] + args[3] <= 8193)).toBe(true);
    });
  });

  it.each(['', '{broken', 'conflict', 'identical'])('validates a concurrent EEXIST winner (%s) before acknowledgement', async winner => {
    const { appendMainRedMetrics } = await import('../main-red-metrics-journal.mjs');
    await inJournal(async dir => {
      const event = metric();
      const writeFile = vi.fn((path, text, options) => {
        writeFileSync(path, winner === 'identical' ? text : winner === 'conflict'
          ? JSON.stringify({ ...event, seq: 99 }) : winner, options);
        throw Object.assign(new Error('competing writer'), { code: 'EEXIST' });
      });
      const receipt = appendMainRedMetrics(dir, [event], { writeFile });
      expect(writeFile).toHaveBeenCalledTimes(1);
      if (winner === 'identical') expect(receipt.warnings).toEqual([]);
      else expect(receipt.warnings.join(' ')).toMatch(/incomplete.*recover/i);
    });
  });


  it('acknowledges identical transitions with a later poll time and never rewrites evidence', () => inJournal(dir => {
    const e = metric();
    expect(appendMainRedMetrics(dir, [e])).toEqual({ warnings: [] });
    expect(appendMainRedMetrics(dir, [{ ...e, at: 2000 }])).toEqual({ warnings: [] });
    expect(readMainRedMetrics(dir)).toEqual({ events: [e], warnings: [] });
    expect(readdirSync(join(dir, 'main-red-metrics'))).toEqual([`${e.key}.json`]);
  }));
  it.each(['v', 'repo', 'head', 'seq', 'runId', 'kind', 'since', 'signature', 'truncated', 'queue'])(
    'refuses a conflicting %s transition field', field => inJournal(dir => {
      const e = metric();
      appendMainRedMetrics(dir, [e]);
      const changes = { v: 2, repo: 'other/repo', head: 'aaaaaaa', seq: 2, runId: 2, kind: 'queue',
        since: 1, signature: `v1:${'a'.repeat(64)}`, truncated: true, queue: { waitMs: 101, serviceMs: null } };
      expect(appendMainRedMetrics(dir, [{ ...e, [field]: changes[field] }]).warnings).toEqual([metricRecovery]);
      expect(readMainRedMetrics(dir).events).toEqual([e]);
    }));
  it.each(['../../escaped', 'nested/key', '..'])('rejects unsafe journal key %s at append and persisted boundaries', key => inJournal(dir => {
    expect(appendMainRedMetrics(dir, [metric({ key })]).warnings).toEqual([metricRecovery]);
    writeFileSync(join(dir, 'main-red-metrics', 'bad.json'), JSON.stringify(metric({ key })));
    expect(readMainRedMetrics(dir).events).toEqual([]);
    expect(readMainRedMetrics(dir).warnings.join(' ')).toMatch(/malformed.*recover/);
  }));
  it('red metrics journal — an over-cap count after a concurrent write warns and deletes nothing', () => inJournal(dir => {
    const e = metric();
    const writeFile = (path, text, options) => {
      writeFileSync(path, text, options);
      writeFileSync(join(dir, 'main-red-metrics', 'competitor.json'), JSON.stringify(metric({ key: 'competitor' })));
    };
    expect(appendMainRedMetrics(dir, [e], { limit: 1, writeFile }).warnings).toEqual([metricRecovery]);
    expect(readdirSync(join(dir, 'main-red-metrics')).sort()).toEqual(['competitor.json', `${e.key}.json`]);
    expect(readMainRedMetrics(dir, { limit: 1 })).toEqual({ events: [], warnings: [metricRecovery] });
  }));
  it('refuses missing, unreadable or malformed journal evidence with an operator fallback', () => inJournal(dir => {
    expect(readMainRedMetrics(dir).warnings).toEqual([metricRecovery]);
    expect(appendMainRedMetrics(dir, [metric()], { openDir: () => { throw new Error('unreadable'); } }).warnings)
      .toEqual([metricRecovery]);
    writeFileSync(join(dir, 'main-red-metrics', 'bad.json'), '{broken');
    expect(readMainRedMetrics(dir).warnings.join(' ')).toMatch(/malformed.*recover/);
  }));
});
