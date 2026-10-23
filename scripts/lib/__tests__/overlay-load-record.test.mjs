import { describe, it, expect, vi } from 'vitest';
import { appendLoadRecord, MAX_LOAD_RECORD_BYTES } from '../overlay-load-record.mjs';

const fakeFs = (path = '~/coordination/loads.jsonl') => ({
  readFileSync: vi.fn(() => JSON.stringify({ recordPath: path })),
  mkdirSync: vi.fn(), appendFileSync: vi.fn(),
});
const record = { clone: 'clone', ref: 'lane/example', pr: 42, outcome: 'adopted' };
const now = () => Date.parse('2026-10-23T12:00:00Z');

describe('appendLoadRecord', () => {
  it('expands settings with HOME, reports provenance, and appends one timestamped JSON line', () => {
    const fs = fakeFs();
    expect(appendLoadRecord({ record, env: { HOME: '/home/test' }, fs, now })).toEqual({
      ok: true, path: '/home/test/coordination/loads.jsonl', pathSource: 'settings:prototype-load.json#recordPath',
    });
    expect(fs.mkdirSync).toHaveBeenCalledWith('/home/test/coordination', { recursive: true });
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const line = fs.appendFileSync.mock.calls[0][1];
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toMatchObject({ ...record, at: '2026-10-23T12:00:00.000Z', source: 'daemon-load-overlay' });
  });

  it('env override wins without reading settings and expands HOME', () => {
    const fs = fakeFs();
    const out = appendLoadRecord({ record, env: { HOME: '/home/test', WE_PROTOTYPE_LOAD_RECORD: '~/override.jsonl' }, fs, now });
    expect(out).toMatchObject({ ok: true, path: '/home/test/override.jsonl', pathSource: 'env:WE_PROTOTYPE_LOAD_RECORD' });
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it.each(['readFileSync', 'mkdirSync', 'appendFileSync'])('never throws on %s failure', (method) => {
    const fs = fakeFs('records.jsonl');
    fs[method].mockImplementation(() => { throw new Error('disk unavailable'); });
    expect(appendLoadRecord({ record, env: {}, fs, now })).toMatchObject({ ok: false, error: 'disk unavailable' });
  });

  it.each([null, '', 42])('refuses missing or invalid settings path %s without appending', (path) => {
    const fs = fakeFs(path);
    expect(appendLoadRecord({ record, env: {}, fs, now }).ok).toBe(false);
    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });

  it('refuses tilde expansion without HOME', () => {
    const fs = fakeFs();
    expect(appendLoadRecord({ record, env: {}, fs, now })).toMatchObject({ ok: false, error: 'HOME required to expand recordPath' });
    expect(fs.appendFileSync).not.toHaveBeenCalled();
  });

  it('redacts tokens and strips controls in nested diagnostics', () => {
    const fs = fakeFs('records.jsonl');
    appendLoadRecord({ record: { ...record, detail: { error: 'ghp_secret123\u001b\n' } }, env: {}, fs, now });
    expect(JSON.parse(fs.appendFileSync.mock.calls[0][1]).detail.error).toBe('ghp_<redacted>');
  });

  it('bounds even oversized core fields containing escaped Unicode', () => {
    const fs = fakeFs('records.jsonl');
    const hostile = Object.fromEntries(['clone', 'ref', 'pr', 'outcome', 'registered', 'adopted', 'rolledBack', 'error', 'triggerError']
      .map((key) => [key, '\ud800'.repeat(20_000)]));
    appendLoadRecord({ record: hostile, env: {}, fs, now });
    const line = fs.appendFileSync.mock.calls[0][1];
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LOAD_RECORD_BYTES);
    expect(JSON.parse(line).detailsTruncated).toBe(true);
  });

  it('bounds oversized lines with an explicit truncation marker and retained outcome', () => {
    const fs = fakeFs('records.jsonl');
    appendLoadRecord({ record: { ...record, diagnostics: Array(1000).fill('x'.repeat(1000)) }, env: {}, fs, now });
    const line = fs.appendFileSync.mock.calls[0][1];
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LOAD_RECORD_BYTES);
    expect(JSON.parse(line)).toMatchObject({ ...record, detailsTruncated: true });
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });
});
