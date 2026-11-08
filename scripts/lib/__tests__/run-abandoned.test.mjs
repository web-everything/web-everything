import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidRunId, listRunIds } from '../../operations/run-store.mjs';
import { abandonedPath, markRunAbandoned, isRunAbandoned, isAbandonedGivenStats, isRunTerminalOrAbandoned, runRecordVersion } from '../run-abandoned.mjs';

let dir;
const id = 'review-dead';
const options = () => ({ id, dir, reason: 'dead', probes: { pid: false }, by: 'test', now: 1800000000000 });
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'run-abandoned-')); fs.writeFileSync(join(dir, `${id}.json`), '{}'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it.each([[10, 9, true], [10, 10, true], [10, 11, false], [NaN, 1, false], [1, undefined, false]])(
  'mtime rule: tombstone %s record %s abandoned %s', (t, r, expected) => expect(isAbandonedGivenStats(t, r)).toBe(expected));
it('tombstone makes a nonterminal record terminal via the reader helper', () => {
  markRunAbandoned(options());
  expect(isRunTerminalOrAbandoned({}, id, dir, () => false)).toBe(true);
  expect(isRunTerminalOrAbandoned({}, 'missing', dir, () => true)).toBe(true);
});
it('newer record is neither abandoned nor terminal', () => {
  markRunAbandoned(options());
  const t = fs.statSync(abandonedPath(id, dir)).mtimeMs;
  fs.utimesSync(join(dir, `${id}.json`), new Date(t + 1000), new Date(t + 1000));
  expect(isRunAbandoned(id, dir)).toBe(false);
  expect(isRunTerminalOrAbandoned({}, id, dir, () => false)).toBe(false);
});
it('uses exclusive creation and keeps original content and mtime on EEXIST', () => {
  const openSync = vi.fn(fs.openSync);
  expect(markRunAbandoned({ ...options(), fs: { ...fs, openSync } })).toEqual({ written: true, alreadyAbandoned: false });
  expect(openSync).toHaveBeenCalledWith(abandonedPath(id, dir), 'wx');
  const before = fs.readFileSync(abandonedPath(id, dir)), mtime = fs.statSync(abandonedPath(id, dir)).mtimeMs;
  expect(markRunAbandoned({ ...options(), reason: 'different' })).toEqual({ written: false, alreadyAbandoned: true });
  expect(fs.readFileSync(abandonedPath(id, dir))).toEqual(before);
  expect(fs.statSync(abandonedPath(id, dir)).mtimeMs).toBe(mtime);
  expect(JSON.parse(before)).toEqual({ at: new Date(options().now).toISOString(), reason: 'dead', probes: { pid: false }, by: 'test' });
});
// R755: run-record reserves the `.abandoned` suffix for tombstone sidecars.
it('listRunIds ignores sidecars because abandonment suffixes are invalid run ids', () => {
  markRunAbandoned(options());
  expect(isValidRunId(`${id}.abandoned`)).toBe(false);
  expect(listRunIds(dir)).toEqual([id]);
});
it.each(['{', '{}', 'null', '[]', '{"at":"bad","reason":"dead","probes":{},"by":"test"}'])(
  'malformed tombstone fails closed toward alive: %s', body => {
    fs.writeFileSync(abandonedPath(id, dir), body);
    expect(isRunAbandoned(id, dir)).toBe(false);
  });
it('unreadable tombstone and missing record fail closed toward alive', () => {
  fs.mkdirSync(abandonedPath(id, dir)); expect(isRunAbandoned(id, dir)).toBe(false);
  fs.rmSync(abandonedPath(id, dir), { recursive: true }); markRunAbandoned(options());
  fs.rmSync(join(dir, `${id}.json`)); expect(isRunAbandoned(id, dir)).toBe(false);
});
it('stat and read errors fail closed toward alive', () => {
  markRunAbandoned(options());
  for (const method of ['statSync', 'readFileSync']) {
    expect(isRunAbandoned(id, dir, { fs: { ...fs, [method]: () => { throw Error('denied'); } } })).toBe(false);
  }
});
it('creation errors other than EEXIST propagate', () => {
  expect(() => markRunAbandoned({ ...options(), fs: { openSync: () => { throw Error('denied'); } } })).toThrow('denied');
});

it('a bound tombstone abandons the observed version but not an atomic replacement with the same mtime', () => {
  const path = join(dir, `${id}.json`), observed = fs.statSync(path);
  markRunAbandoned({ ...options(), probes: { recordVersion: runRecordVersion(observed) } });
  expect(isRunAbandoned(id, dir)).toBe(true);
  const replacement = join(dir, 'replacement');
  fs.writeFileSync(replacement, '{}');
  fs.utimesSync(replacement, observed.atime, observed.mtime);
  fs.renameSync(replacement, path);
  expect(isRunAbandoned(id, dir)).toBe(false);
});
it.each([null, [], 1, 'garbage'])('invalid record-version binding %j fails closed toward alive', recordVersion => {
  markRunAbandoned({ ...options(), probes: { recordVersion } });
  expect(isRunAbandoned(id, dir)).toBe(false);
});
it('unreadable stat identity on a bound tombstone fails closed toward alive', () => {
  markRunAbandoned({ ...options(), probes: { recordVersion: runRecordVersion(fs.statSync(join(dir, `${id}.json`))) } });
  expect(isRunAbandoned(id, dir, { fs: { ...fs, statSync: () => ({ mtimeMs: 0 }) } })).toBe(false);
});
