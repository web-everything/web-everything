import { describe, it, expect, vi } from 'vitest';
import { appendLoadRecord, sanitize, MAX_LOAD_RECORD_BYTES } from '../overlay-load-record.mjs';

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
  it.each(['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'API-KEY', 'Authorization', 'credential', 'cookie', 'accessToken', 'db_password', 'credentials'])(
    'redacts values by property name %s at every depth, including non-string values', (key) => {
      const fs = fakeFs('records.jsonl');
      appendLoadRecord({ record: { ...record, [key]: 'short-value', detail: [
        { [key]: { nested: 'another-value' }, safe: 'readable' }, { [key]: 123 }, { [key]: null },
      ] }, env: {}, fs, now });
      expect(JSON.parse(fs.appendFileSync.mock.calls[0][1])).toMatchObject({
        ...record, [key]: '<redacted>', detail: [
          { [key]: '<redacted>', safe: 'readable' }, { [key]: '<redacted>' }, { [key]: '<redacted>' },
        ],
      });
    });
  it('sanitizes the entire string without truncating diagnostic context', () => {
    const prefix = 'context '.repeat(600);
    expect(sanitize(`${prefix}password: "two words" tail`)).toBe(`${prefix}password: <redacted> tail`);
  });

  it.each([
    ['Bearer short-bearer', 'Bearer <redacted>'],
    ['Bearer\tshort-bearer', 'Bearer <redacted>'],
    ['bAsIc dXNlcjpwYXNz', 'bAsIc <redacted>'],
    ['https://user:p%40ss@host.example/path', 'https://<redacted>@host.example/path'],
    ...['token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'API-KEY', 'authorization']
      .map((key) => [`${key}=short-credential`, `${key}=<redacted>`]),
    ['password="two secret words"', 'password=<redacted>'],
    ['"password": "x"', '"password": <redacted>'],
    ['"password": "escaped \\" secret"', '"password": <redacted>'],
    ["'secret': 'two secret words'", "'secret': <redacted>"],
    ...['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'authorization', 'credential', 'cookie']
      .map((key) => [`${key}: short-credential`, `${key}: <redacted>`]),
    ["secret = 'two secret words'", 'secret = <redacted>'],
    ['https://host.example/?token=short-token&next=ok', 'https://host.example/?token=<redacted>&next=ok'],
    ['0123456789abcdef'.repeat(2), '<redacted>'],
    ['AbCdEfGh01234567+/AbCdEfGh01234567==', '<redacted>'],
    ['AbCdEfGh01234567_-AbCdEfGh01234567', '<redacted>'],
    ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_']
      .map((prefix) => [`${prefix}secret123`, `${prefix}<redacted>`]),
  ])('sanitizes every record string and writer error containing %s', (input, expected) => {
    const fs = fakeFs('records.jsonl');
    const detail = `failed: ${input}\n\u001b`;
    const clean = `failed: ${expected}`;
    appendLoadRecord({ record: {
      ...record, error: detail, triggerError: detail, transcript: detail, detail: { nested: [detail] },
    }, env: {}, fs, now });
    expect(JSON.parse(fs.appendFileSync.mock.calls[0][1])).toMatchObject({
      ...record, error: clean, triggerError: clean, transcript: clean, detail: { nested: [clean] },
    });
    fs.appendFileSync.mockImplementation(() => { throw new Error(detail); });
    expect(appendLoadRecord({ record, env: {}, fs, now })).toMatchObject({ ok: false, error: clean });
  });

  it('scrubs core fields too while retaining readable ref, clone and outcome context', () => {
    const fs = fakeFs('records.jsonl');
    appendLoadRecord({ record: {
      ...record, clone: 'https://user:pass@host.example/clone', ref: 'lane/token=hidden',
      outcome: 'not-adopted secret=hidden',
    }, env: {}, fs, now });
    expect(JSON.parse(fs.appendFileSync.mock.calls[0][1])).toMatchObject({
      clone: 'https://<redacted>@host.example/clone', ref: 'lane/token=<redacted>',
      outcome: 'not-adopted secret=<redacted>',
    });
  });

  it('masks tokens at the 32-character boundary without masking shorter identifiers', () => {
    const fs = fakeFs('records.jsonl');
    appendLoadRecord({ record: { ...record, detail: ['a'.repeat(31), 'a'.repeat(32)] }, env: {}, fs, now });
    expect(JSON.parse(fs.appendFileSync.mock.calls[0][1]).detail).toEqual(['a'.repeat(31), '<redacted>']);
  });

  it('sanitizes secrets before oversized-row core truncation can split them', () => {
    const fs = fakeFs('records.jsonl');
    const error = `${'context '.repeat(19)}${'a'.repeat(40)}`;
    appendLoadRecord({ record: { ...record, error, diagnostics: Array(1000).fill('context '.repeat(100)) }, env: {}, fs, now });
    const line = fs.appendFileSync.mock.calls[0][1];
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LOAD_RECORD_BYTES);
    expect(JSON.parse(line)).toMatchObject({ ...record, detailsTruncated: true,
      error: `${'context '.repeat(19)}<redacted>`.slice(0, 160),
    });
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
    appendLoadRecord({ record: { ...record, diagnostics: Array(1000).fill('diagnostic '.repeat(100)) }, env: {}, fs, now });
    const line = fs.appendFileSync.mock.calls[0][1];
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LOAD_RECORD_BYTES);
    expect(JSON.parse(line)).toMatchObject({ ...record, detailsTruncated: true });
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });

  it('keeps long branch names readable while masking token-like secrets', () => {
    const fs = fakeFs('records.jsonl');
    const ref = 'lane/loader-swap-after-adopt-and-more-words-here';
    appendLoadRecord({ record: { ...record, ref, error: 'key abcdef0123456789abcdef0123456789ab' }, env: {}, fs, now });
    const row = JSON.parse(fs.appendFileSync.mock.calls[0][1]);
    expect(row.ref).toBe(ref);
    expect(row.error).not.toContain('abcdef0123456789abcdef0123456789ab');
  });
});
