import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSnapshot, clearJsonSnapshots } from '../json-file-snapshot.mjs';
import { readStore, readStoreShared } from '../../conveyor/run-scorecard-store.mjs';

// ctime cannot be set back, so "settled" is reached by moving the clock this module reads forward.
const realNow = Date.now.bind(Date);
const settle = () => { const at = realNow() + 60_000; vi.spyOn(Date, 'now').mockReturnValue(at); };
const old = () => settle();

describe('readJsonSnapshot (xwu9oxh S2a)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'json-snap-')); clearJsonSnapshots(); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it('reuses one frozen parse while the settled file is unchanged', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ records: [{ a: 1 }] }));
    old(p);
    const one = readJsonSnapshot(p).value;
    const two = readJsonSnapshot(p).value;
    expect(two).toBe(one);
    expect(Object.isFrozen(one.records[0])).toBe(true);
    expect(() => { 'use strict'; one.records.push({}); }).toThrow();
  });

  it('re-reads after an atomic replace or an in-place rewrite', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ records: [1] }));
    old(p);
    const first = readJsonSnapshot(p).value;
    expect(readJsonSnapshot(p).value).toBe(first);
    writeFileSync(`${p}.tmp`, JSON.stringify({ records: [2] }));
    renameSync(`${p}.tmp`, p);
    expect(readJsonSnapshot(p).value.records).toEqual([2]);
    readJsonSnapshot(p);
    writeFileSync(p, JSON.stringify({ records: [3] }));
    expect(readJsonSnapshot(p).value.records).toEqual([3]);
    expect(first.records).toEqual([1]);
  });

  it('never caches a file changed within the settle window', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ records: [1] }));
    expect(readJsonSnapshot(p).value).not.toBe(readJsonSnapshot(p).value);
  });

  it('a mtime set back by a writer is still caught by ctime', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ records: [1] }));
    const t = new Date(realNow() - 60_000);
    utimesSync(p, t, t);
    expect(readJsonSnapshot(p).value).not.toBe(readJsonSnapshot(p).value);
  });

  it('an open error after a cached read is thrown, not hidden by the cache', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ records: [1] }));
    old(p);
    readJsonSnapshot(p);
    rmSync(p);
    expect(() => readJsonSnapshot(p)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('freezes deeply nested values without overflowing the stack', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, `{"records":[{"q":1,"deep":${'['.repeat(20000)}${']'.repeat(20000)}}]}`);
    old(p);
    expect(readStore({ path: p }).records.map((r) => r.q)).toEqual([1]);
    expect(readStoreShared({ path: p }).records.map((r) => r.q)).toEqual([1]);
    expect(Object.isFrozen(readStoreShared({ path: p }).records[0].deep)).toBe(true);
  });

  it('throws read errors as is and returns parse errors, never cached', () => {
    const p = join(dir, 'missing.json');
    expect(() => readJsonSnapshot(p)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    writeFileSync(p, '{nope');
    old(p);
    expect(readJsonSnapshot(p).parseError).toBeInstanceOf(SyntaxError);
  });

  it('WE_JSON_SNAPSHOT_SHARED=off reads fresh, unfrozen', () => {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ records: [1] }));
    old(p);
    const env = { WE_JSON_SNAPSHOT_SHARED: 'off' };
    const a = readJsonSnapshot(p, { env }).value;
    expect(readJsonSnapshot(p, { env }).value).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(false);
  });

  it('readStoreShared gives the same answer as readStore for good, malformed and missing stores', () => {
    const cases = {
      good: JSON.stringify({ version: 2, records: [{ x: 1 }], migrations: ['m'] }),
      noMigrations: JSON.stringify({ records: [{ x: 1 }] }),
      notStore: JSON.stringify({ rows: [] }),
      nullJson: 'null',
      malformed: '{',
    };
    for (const [name, text] of Object.entries(cases)) {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, text);
      old(p);
      expect(readStoreShared({ path: p }), name).toEqual(readStore({ path: p }));
      expect(readStoreShared({ path: p }), name).toEqual(readStore({ path: p }));
    }
    expect(readStoreShared({ path: join(dir, 'none.json') })).toEqual(readStore({ path: join(dir, 'none.json') }));
  });
});
