import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileRunStore, newRunRecord, runPath } from '../../operations/run-store.mjs';
import { readDetachedWrapperPids, readWrapperPidsForPass } from '../lease-reaper.mjs';
import { readDetachedWrapperPidsIndexed, resolveRunScanSettings } from '../lease-reaper-run-index.mjs';

let root, dir, indexPath, store;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'lease-reaper-index-'));
  dir = join(root, 'runs');
  indexPath = join(root, 'lease-reaper-run-index.json');
  store = createFileRunStore(dir);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const record = (id, session, pid, status = 'in-flight') => ({
  ...newRunRecord({ id, op: 'fixture-dispatch' }),
  effects: session ? [{ key: `${id}#0#0`, stepIndex: 0, index: 0, type: 'dispatch',
    status, handle: `pid:${pid}`, payload: { sessionSlug: session } }] : [],
});
const scan = (options = {}) => readDetachedWrapperPidsIndexed({ dir, read: store.read, ...options });
const seed = () => {
  store.write(record('a', 'conveyor-1', 101));
  store.write(record('b'));
  store.write(record('c', 'conveyor-1', 303)); // sorted-id last wins
  store.write(record('d', 'conveyor-2', 202));
};

describe('card 311 incremental run index', () => {
  it('parses every record initially, then reuses all without reading or rewriting', () => {
    seed();
    const first = scan();
    expect(first.bySession).toEqual(readDetachedWrapperPids(store));
    expect(first.stats).toMatchObject({ listed: 4, statted: 4, parsed: 4, reused: 0, skippedOld: 0 });
    expect(first.stats.ms).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).b.p).toEqual([]);
    const read = vi.fn(() => { throw new Error('unchanged records must not be read'); });
    const writeFileSync = vi.fn(fs.writeFileSync);
    const second = scan({ read, fs: { ...fs, writeFileSync } });
    expect(second.bySession).toEqual(first.bySession);
    expect(second.stats).toMatchObject({ parsed: 0, reused: 4 });
    expect(read).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('reparses rewrites, picks up new records, and removes deleted ids', () => {
    seed(); scan();
    store.write(record('d', 'conveyor-2', 202, 'applied')); // terminal effect (done)
    store.write(record('e', 'conveyor-3', 303));
    store.delete('c');
    const result = scan();
    expect(result.bySession).toEqual(readDetachedWrapperPids(store));
    expect([...result.bySession]).toEqual([['conveyor-1', 101], ['conveyor-3', 303]]);
    expect(result.stats).toMatchObject({ listed: 4, parsed: 2, reused: 2 });
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).not.toHaveProperty('c');
  });

  it.each(['{broken', 'null', '{"a":{"m":0,"s":0,"p":"bad"}}'])('rebuilds a corrupt index: %s', (text) => {
    seed(); fs.writeFileSync(indexPath, text);
    const result = scan();
    expect(result.stats.parsed).toBe(4);
    expect(result.bySession).toEqual(readDetachedWrapperPids(store));
  });

  it('skips corrupt records without caching them and retries on the next pass', () => {
    seed(); scan();
    fs.writeFileSync(runPath('d', dir), '{broken');
    const first = scan();
    expect([...first.bySession]).toEqual([['conveyor-1', 303]]);
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).not.toHaveProperty('d');
    const read = vi.fn(store.read);
    scan({ read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('d');
  });

  it('skips and drops old cached files only when an age limit is enabled', () => {
    seed();
    const nowMs = Date.now();
    const old = new Date(nowMs - 60_000);
    fs.utimesSync(runPath('d', dir), old, old);
    expect(scan().bySession.has('conveyor-2')).toBe(true);
    const result = scan({ maxAgeMs: 30_000, nowMs });
    expect(result.stats).toMatchObject({ skippedOld: 1, reused: 3, parsed: 0 });
    expect(result.bySession.has('conveyor-2')).toBe(false);
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).not.toHaveProperty('d');
    expect(scan().bySession.has('conveyor-2')).toBe(true);
  });

  it('write failures do not fail the sweep', () => {
    seed();
    const result = scan({ indexPath, fs: { ...fs, renameSync: () => { throw new Error('read only'); } } });
    expect(result.bySession).toEqual(readDetachedWrapperPids(store));
    expect(fs.readdirSync(root)).toEqual(['runs']);
  });

  it('honors an explicit index path and ignores stray filenames', () => {
    seed(); fs.writeFileSync(join(dir, '.invalid.json'), '{}');
    fs.writeFileSync(join(dir, 'a.json.tmp'), '{}');
    const custom = join(root, 'custom-index');
    expect(scan({ indexPath: custom }).stats.listed).toBe(4);
    expect(fs.existsSync(custom)).toBe(true);
    expect(fs.existsSync(indexPath)).toBe(false);
  });
});

describe('run scan policy and pass wiring', () => {
  const env = () => ({ WE_PLATFORM_PREFERENCES_FILE: join(root, 'preferences.json') });
  it('defaults to index without an age limit', () => {
    expect(resolveRunScanSettings(env())).toEqual({ mode: 'index', maxAgeMs: 0,
      source: { mode: 'standard', maxAgeMs: 'standard' } });
  });
  it('accepts env overrides and independently falls back for invalid values', () => {
    expect(resolveRunScanSettings({ ...env(), WE_LEASE_REAPER_RUN_SCAN: 'full', WE_LEASE_REAPER_RUN_SCAN_MAX_AGE_MS: '123' }))
      .toEqual({ mode: 'full', maxAgeMs: 123, source: { mode: 'env', maxAgeMs: 'env' } });
    for (const value of ['-1', '1.5', 'oops', '']) {
      expect(resolveRunScanSettings({ ...env(), WE_LEASE_REAPER_RUN_SCAN: 'bad', WE_LEASE_REAPER_RUN_SCAN_MAX_AGE_MS: value }))
        .toEqual(resolveRunScanSettings(env()));
    }
  });
  it('uses platform preferences below env overrides', () => {
    fs.writeFileSync(env().WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ leaseReaperRunScan: { mode: 'full', maxAgeMs: 500 } }));
    expect(resolveRunScanSettings({ ...env(), WE_LEASE_REAPER_RUN_SCAN: 'index' }))
      .toEqual({ mode: 'index', maxAgeMs: 500, source: { mode: 'env', maxAgeMs: 'platform' } });
  });
  it('logs index and full passes and falls back to full when directory listing fails', () => {
    seed(); vi.stubEnv('OPERATION_RUNS_DIR', dir);
    const log = vi.fn();
    const settings = env();
    expect(readWrapperPidsForPass({ env: settings, log })).toEqual(readDetachedWrapperPids(store));
    expect(log.mock.calls[0][0]).toMatch(/^lease-reaper: run scan mode=index \(source standard\) listed=4 parsed=4 reused=0 skippedOld=0 in \d+ms$/);
    readWrapperPidsForPass({ env: { ...settings, WE_LEASE_REAPER_RUN_SCAN: 'full' }, log });
    expect(log.mock.calls[1][0]).toMatch(/mode=full \(source env\) listed=4 parsed=4 reused=0 skippedOld=0/);
    const file = join(root, 'not-a-directory'); fs.writeFileSync(file, '');
    vi.stubEnv('OPERATION_RUNS_DIR', file);
    expect(readWrapperPidsForPass({ env: settings, log })).toEqual(new Map());
    expect(log.mock.calls[2][0]).toMatch(/mode=full/);
  });
});
