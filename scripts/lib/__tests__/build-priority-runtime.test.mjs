import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readBuildPrioritySettings, filterIdsToRuntimeOnly, extraPrepareSlot } from '../build-queue.mjs';
import { resolveCoordinationRoot } from '../../operations/coordination-root.mjs';

const now = Date.parse('2026-11-17T12:00:00Z');
const record = { ids: ['42', 'xxanl0v'], mode: 'only', setBy: 'operator', at: '2026-11-17T11:00:00Z', ttlHours: 2 };
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const options = { env: { WE_POLICY_CASCADE_LOG: '0' }, read: () => ({ build: { priority: ['9'] } }), now: () => now };
const read = (value = record, overrides = {}) => readBuildPrioritySettings({ ...options, readRuntime: () => JSON.stringify(value), ...overrides });

describe('runtime build priority', () => {
  it('absent runtime deep-equals the previous repo-setting result', () => {
    expect(readBuildPrioritySettings({ ...options, readRuntime: missing })).toEqual({ ids: ['9'], source: 'tool' });
  });

  it('resolves the shared coordination default, env path and explicit path in order', () => {
    const readRuntime = vi.fn(() => JSON.stringify(record));
    read(record, { readRuntime });
    expect(readRuntime).toHaveBeenLastCalledWith(join(resolveCoordinationRoot({ env: options.env }), 'build-priority.runtime.json'), 'utf8');
    read(record, { readRuntime, env: { ...options.env, WE_BUILD_PRIORITY_RUNTIME_FILE: 'runtime-env.json' } });
    expect(readRuntime).toHaveBeenLastCalledWith('runtime-env.json', 'utf8');
    read(record, { readRuntime, runtimePath: 'runtime-option.json', env: { ...options.env, WE_BUILD_PRIORITY_RUNTIME_FILE: 'runtime-env.json' } });
    expect(readRuntime).toHaveBeenLastCalledWith('runtime-option.json', 'utf8');
  });

  it('only mode never admits an unlisted candidate, including with an empty list', () => {
    expect(filterIdsToRuntimeOnly(['9', '42', 'xxanl0v', '8'], read())).toEqual(record.ids);
    expect(filterIdsToRuntimeOnly(['42'], read({ ...record, ids: [] }))).toEqual([]);
  });

  it('lift mode retains other candidates by identity and preserves ordered priority ids', () => {
    const settings = read({ ...record, mode: 'lift' });
    const ids = ['9', '42'];
    expect(settings).toMatchObject({ ids: record.ids, source: 'runtime', mode: 'lift', only: false });
    expect(filterIdsToRuntimeOnly(ids, settings)).toBe(ids);
  });

  it('accepts only new candidate input and never mutates it or accepts an in-flight parameter', () => {
    const ids = Object.freeze(['9', '42']);
    expect(filterIdsToRuntimeOnly.length).toBe(2);
    expect(filterIdsToRuntimeOnly(ids, read())).toEqual(['42']);
    expect(ids).toEqual(['9', '42']);
  });

  it('only mode filters new candidates without cancelling an unlisted in-flight build', () => {
    const settings = read();
    const state = { inFlight: new Set(['9']) };
    const inFlight = state.inFlight;
    const candidates = ['9', '42', 'xxanl0v', '8'];

    const result = filterIdsToRuntimeOnly(candidates, settings);

    expect(settings.ids).not.toContain('9');
    expect(result).toEqual(['42', 'xxanl0v']);
    expect(result).not.toContain('9');
    expect(state.inFlight).toBe(inFlight);
    expect(state.inFlight).toEqual(new Set(['9']));
  });

  it('extraPrepareSlot returns only the first allowed id and otherwise null', () => {
    expect(extraPrepareSlot(read())).toBe('42');
    expect(extraPrepareSlot(read({ ...record, mode: 'lift' }))).toBeNull();
    expect(extraPrepareSlot(read({ ...record, ids: [] }))).toBeNull();
    expect(extraPrepareSlot({ only: true, held: true, ids: ['42'] })).toBeNull();
  });

  it('reports canonical list hash, age, applied count and author on one line', () => {
    const settings = read({ ...record, ids: [' 42 ', '42', 'xxanl0v'] });
    const hash = createHash('sha256').update(JSON.stringify({ ids: record.ids, mode: record.mode })).digest('hex').slice(0, 12);
    expect(settings.runtime).toMatchObject({ hash, ageMs: 3600000, appliedCount: 2, expired: false, setBy: 'operator' });
    expect(settings.runtime.line).toContain(`list=${hash} ageMs=3600000 applied=2`);
    expect(settings.runtime.line).not.toMatch(/[\r\n]/);
    expect(read({ ...record, mode: 'lift' }).runtime.hash).not.toBe(hash);
  });

  it('expired TTL warns but still applies the list; exactly TTL is not expired', () => {
    expect(read({ ...record, ttlHours: 1 }).runtime.expired).toBe(false);
    const settings = read({ ...record, ttlHours: 0.5 });
    expect(settings.runtime.expired).toBe(true);
    expect(settings.runtime.line).toContain('WARNING expired');
    expect(filterIdsToRuntimeOnly(['9', '42'], settings)).toEqual(['42']);
  });

  it.each([
    ['bad JSON', '{'], ['null', 'null'], ['bad ids type', JSON.stringify({ ...record, ids: '42' })],
    ['bad id', JSON.stringify({ ...record, ids: ['bad'] })],
    ['bad mode', JSON.stringify({ ...record, mode: 'other' })],
    ['bad author', JSON.stringify({ ...record, setBy: 4 })],
    ['bad timestamp', JSON.stringify({ ...record, at: 'Infinity' })],
    ['numeric timestamp', JSON.stringify({ ...record, at: now })],
    ['bad TTL type', JSON.stringify({ ...record, ttlHours: '2' })],
    ['nonfinite TTL', JSON.stringify({ ...record, ttlHours: null })],
    ['negative TTL', JSON.stringify({ ...record, ttlHours: -1 })],
  ])('%s holds with one warning and never falls through to repo settings', (_name, raw) => {
    const settings = read(record, { readRuntime: () => raw });
    expect(settings).toEqual({ ids: [], source: 'runtime-malformed', only: true, held: true,
      runtime: { malformed: true, warning: expect.any(String) } });
    expect(settings.runtime.warning).not.toMatch(/[\r\n]/);
    expect(filterIdsToRuntimeOnly(['9'], settings)).toEqual([]);
    expect(extraPrepareSlot(settings)).toBeNull();
  });

  it('read errors other than ENOENT fail closed without leaking error text', () => {
    const settings = read(record, { readRuntime: () => { throw Object.assign(new Error('private\ntext'), { code: 'EACCES' }); } });
    expect(settings).toMatchObject({ ids: [], held: true, source: 'runtime-malformed' });
    expect(settings.runtime.warning).not.toContain('private');
  });

  it.each(['7', ''])('valid env %j overrides valid and malformed runtime', value => {
    const env = { ...options.env, WE_BUILD_PRIORITY: value };
    const expected = { ids: value ? [value] : [], source: 'env' };
    expect(read(record, { env })).toEqual(expected);
    expect(read(null, { env })).toEqual(expected);
  });

  it('invalid env cannot bypass a malformed runtime hold', () => {
    expect(read(null, { env: { ...options.env, WE_BUILD_PRIORITY: 'bad' } }).held).toBe(true);
  });
});
