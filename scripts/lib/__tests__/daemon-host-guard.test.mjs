// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as guard from '../daemon-host-guard.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(),
  execFileSync: () => { throw new Error('unexpected child process; inject transport'); },
}));

const ID = '12345678-1234-4234-8234-123456789abc';
const OTHER = '87654321-4321-4321-8321-cba987654321';
const SHA = 'a'.repeat(40);
const NOW = 1_800_000_000_000;
const source = (host = ID) => ({ readOwner: vi.fn(async () => ({ host, version: SHA })) });
const decide = (extra = {}) => guard.decideHostRole({ thisHost: ID, owner: ID, ownerReadAt: NOW, now: NOW, ...extra });

describe('fresh ownership only', () => {
  it('a fresh read naming this ID activates; another ID or unset stands by', () => {
    expect(decide().role).toBe('active');
    expect(decide({ owner: OTHER }).role).toBe('standby');
    expect(decide({ owner: '' }).reason).toBe('owner-unset');
  });
  it('invalid local identity, time, timeout or missing source always gives standby', async () => {
    for (const thisHost of ['', null, 'unknown', ID + '\n']) {
      const ownershipSource = source();
      expect((await guard.resolveHostRole({ thisHost, ownershipSource })).role).toBe('standby');
      expect(ownershipSource.readOwner).not.toHaveBeenCalled();
    }
    for (const now of [undefined, NaN, Infinity]) expect(decide({ now }).role).toBe('standby');
    for (const timeoutMs of [0, -1, NaN, Infinity, 15001]) {
      expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource: source(), timeoutMs })).role).toBe('standby');
    }
    for (const ownershipSource of [null, {}, { readOwner: 1 }]) {
      expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource })).role).toBe('standby');
    }
  });
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029', '\u200b'])('opaque comparison rejects a trailing separator %j', (suffix) => {
    expect(decide({ owner: ID + suffix }).role).toBe('standby');
  });
  it.each([undefined, null, NaN, Infinity, NOW - 60_001, NOW + 1])('missing, stale or future evidence %s cannot activate', (ownerReadAt) => {
    expect(decide({ ownerReadAt }).role).toBe('standby');
  });
  it.each([undefined, null, {}, 42, 'bad id', '--bad', 'a\nb', 'a\r', 'a\u2028', 'a\u200b', 'é', '../a', '`x`', '"x"', 'x'.repeat(254)])('unexpected owner %j stands by', (owner) => {
    expect(decide({ owner }).role).toBe('standby');
  });
  it('every invocation reads again after success, handoff, failure and recovery', async () => {
    const ownershipSource = source();
    const call = () => guard.resolveHostRole({ thisHost: ID, ownershipSource });
    expect((await call()).role).toBe('active');
    ownershipSource.readOwner.mockResolvedValue({ host: OTHER, version: SHA });
    expect((await call()).role).toBe('standby');
    ownershipSource.readOwner.mockRejectedValue(new Error('offline'));
    expect((await call()).role).toBe('standby');
    ownershipSource.readOwner.mockResolvedValue({ host: ID, version: SHA });
    expect((await call()).role).toBe('active');
    expect(ownershipSource.readOwner).toHaveBeenCalledTimes(4);
  });
  it.each([undefined, null, {}, { host: ID }, { host: ID, version: '' }, { host: ID, version: 1 },
    { host: {}, version: SHA }, { host: ID, version: SHA, status: 'error' }])('malformed response %j fails closed', async (record) => {
    expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource: { readOwner: () => record } })).role).toBe('standby');
  });
  it.each(['throw', 'reject', 'timeout'])('source %s gives standby', async (kind) => {
    const ownershipSource = { readOwner: () => {
      if (kind === 'throw') throw new Error('offline');
      if (kind === 'reject') return Promise.reject(new Error('offline'));
      return new Promise(() => {});
    } };
    expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource, timeoutMs: 5 })).role).toBe('standby');
  });
  it('an overdue successful read and backward clock both give standby', async () => {
    for (const elapsed of [60_001, -1]) {
      const clock = vi.fn().mockReturnValueOnce(NOW).mockReturnValue(NOW + elapsed);
      expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource: source(), clock })).role).toBe('standby');
    }
  });
  it('late completion after timeout cannot be reused', async () => {
    let finish;
    const ownershipSource = { readOwner: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource, timeoutMs: 5 })).role).toBe('standby');
    finish({ host: ID, version: SHA });
    ownershipSource.readOwner.mockRejectedValue(new Error('offline'));
    expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource })).role).toBe('standby');
    expect(ownershipSource.readOwner).toHaveBeenCalledTimes(2);
  });
  it('overlapping invocations make independent fresh reads', async () => {
    let finish;
    const ownershipSource = source();
    ownershipSource.readOwner.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = guard.resolveHostRole({ thisHost: ID, ownershipSource });
    await Promise.resolve();
    expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource })).role).toBe('active');
    finish({ host: OTHER, version: SHA });
    expect((await first).role).toBe('standby');
    expect(ownershipSource.readOwner).toHaveBeenCalledTimes(2);
  });
});

describe('persistent opaque identity', () => {
  it('concurrent processes all observe the same fully published ID', async () => {
    const home = mkdtempSync(join(tmpdir(), 'guard-id-race-'));
    try {
      const moduleUrl = new URL('../daemon-host-guard.mjs', import.meta.url).href;
      const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e',
          `import { getThisHost } from ${JSON.stringify(moduleUrl)}; process.stdout.write(getThisHost({ home: process.argv[1] }));`, home],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error('identity child failed')));
      })));
      expect(new Set(outputs).size).toBe(1);
      expect(outputs[0]).toMatch(/^[a-f0-9-]{36}$/);
      expect(guard.getThisHost({ home })).toBe(outputs[0]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('identity creation failure cannot fall back to an OS alias', () => {
    const home = mkdtempSync(join(tmpdir(), 'guard-id-failed-'));
    try {
      writeFileSync(join(home, '.claude'), 'not a directory');
      expect(guard.getThisHost({ home })).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('generates one random ID, persists mode 600 and reuses it', () => {
    const home = mkdtempSync(join(tmpdir(), 'guard-id-'));
    try {
      const id = guard.getThisHost({ home });
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      expect(guard.getThisHost({ home })).toBe(id);
      const file = guard.defaultHostIdPath(home);
      expect(readFileSync(file, 'utf8')).toBe(id + '\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(guard.getThisHost({ home: join(home, 'other') })).not.toBe(id);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('read-only lookup neither creates nor replaces missing/corrupt data', () => {
    const home = mkdtempSync(join(tmpdir(), 'guard-id-read-'));
    try {
      expect(guard.getThisHost({ home, create: false })).toBe('');
      expect(existsSync(join(home, '.claude'))).toBe(false);
      mkdirSync(join(home, '.claude'));
      const file = guard.defaultHostIdPath(home);
      writeFileSync(file, 'invalid', { mode: 0o600 });
      expect(guard.getThisHost({ home })).toBe('');
      expect(readFileSync(file, 'utf8')).toBe('invalid');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('insecure permissions, oversized data, directories and symlinks fail closed', () => {
    const home = mkdtempSync(join(tmpdir(), 'guard-id-invalid-'));
    try {
      mkdirSync(join(home, '.claude'));
      const file = guard.defaultHostIdPath(home);
      writeFileSync(file, ID, { mode: 0o644 });
      expect(guard.getThisHost({ home })).toBe('');
      chmodSync(file, 0o600);
      writeFileSync(file, 'x'.repeat(4096));
      expect(guard.getThisHost({ home })).toBe('');
      rmSync(file);
      mkdirSync(file);
      expect(guard.getThisHost({ home })).toBe('');
      rmSync(file, { recursive: true });
      const target = join(home, 'target');
      writeFileSync(target, ID, { mode: 0o600 });
      symlinkSync(target, file);
      expect(guard.getThisHost({ home })).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('legacy aliases match only the local migration identity', () => {
    for (const legacyHost of guard.LEGACY_OWNER_VALUES) {
      expect(decide({ owner: legacyHost, legacyHost }).role).toBe('active');
      expect(decide({ owner: legacyHost }).role).toBe('standby');
      expect(decide({ owner: legacyHost, legacyHost: 'unknown' }).role).toBe('standby');
    }
    expect(decide({ owner: 'unknown', legacyHost: 'unknown' }).role).toBe('standby');
  });
  it('resolver accepts legacy ownership only from a new read matching its local alias', async () => {
    const legacyHost = guard.LEGACY_OWNER_VALUES[0];
    const ownershipSource = source(legacyHost);
    expect((await guard.resolveHostRole({ thisHost: ID, legacyHost, ownershipSource })).role).toBe('active');
    expect((await guard.resolveHostRole({ thisHost: ID, legacyHost: guard.LEGACY_OWNER_VALUES[1], ownershipSource })).role).toBe('standby');
    ownershipSource.readOwner.mockRejectedValue(new Error('offline'));
    expect((await guard.resolveHostRole({ thisHost: ID, legacyHost, ownershipSource })).role).toBe('standby');
    expect(ownershipSource.readOwner).toHaveBeenCalledTimes(3);
  });
  it('legacy discovery accepts only migration constants and bounds its subprocess', () => {
    const exec = vi.fn(() => guard.LEGACY_OWNER_VALUES[0]);
    expect(guard.getLegacyHost({ exec })).toBe(guard.LEGACY_OWNER_VALUES[0]);
    expect(exec).toHaveBeenCalledWith('scutil', ['--get', 'HostName'], expect.objectContaining({ timeout: 15000, maxBuffer: 1024 * 1024 }));
    expect(guard.getLegacyHost({ exec: () => { throw new Error(); }, hostname: () => guard.LEGACY_OWNER_VALUES[1] })).toBe(guard.LEGACY_OWNER_VALUES[1]);
    expect(guard.getLegacyHost({ exec: () => 'unknown', hostname: () => 'unknown' })).toBe('');
    expect(guard.getLegacyHost({ exec: () => 'unknown', hostname: () => guard.LEGACY_OWNER_VALUES[0] })).toBe('');
  });
});

describe('GitHub ownership source', () => {
  const ref = { ok: true, status: 200, body: { object: { sha: SHA } } };
  const file = (text) => ({ ok: true, status: 200, body: { encoding: 'base64', content: Buffer.from(text).toString('base64') } });
  it('pins contents to the ref version and returns the interface shape', async () => {
    const ghApi = vi.fn().mockResolvedValueOnce(ref).mockResolvedValueOnce(file(ID + '\n'));
    expect(await guard.createGithubOwnershipSource({ ghApi }).readOwner()).toEqual({ host: ID, version: SHA });
    expect(ghApi.mock.calls[1][0]).toContain('?ref=' + SHA);
  });
  it('absent branch and empty file are unset', async () => {
    expect(await guard.createGithubOwnershipSource({ ghApi: () => ({ ok: false, status: 404 }) }).readOwner()).toEqual({ host: '', version: null });
    const ghApi = vi.fn().mockResolvedValueOnce(ref).mockResolvedValueOnce(file(''));
    expect(await guard.createGithubOwnershipSource({ ghApi }).readOwner()).toEqual({ host: '', version: SHA });
  });
  it.each([403, 429, 500, null])('API status %s is unreadable', async (status) => {
    const ownershipSource = guard.createGithubOwnershipSource({ ghApi: () => ({ ok: false, status }) });
    expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource })).source).toBe('remote-failed');
  });
  it.each([{}, { object: { sha: '../bad' } }])('invalid ref %j fails closed', async (body) => {
    await expect(guard.createGithubOwnershipSource({ ghApi: () => ({ ...ref, body }) }).readOwner()).rejects.toThrow();
  });
  it.each([
    { ok: false, status: 404 }, { ok: true, status: 200, body: {} },
    { ok: true, status: 200, body: { encoding: 'utf8', content: 'AAAA' } },
    { ok: true, status: 200, body: { encoding: 'base64', content: '!!!!' } },
    { ok: true, status: 200, body: { encoding: 'base64', content: 'YR==' } },
    { ok: true, status: 200, body: { encoding: 'base64', content: 'A'.repeat(1024 * 1024 + 4) } },
    file('bad\nowner'), file(ID + '\u2028'), file(' ' + ID),
  ])('malformed or missing contents fail closed', async (response) => {
    const ghApi = vi.fn().mockResolvedValueOnce(ref).mockResolvedValueOnce(response);
    expect((await guard.resolveHostRole({ thisHost: ID, ownershipSource: guard.createGithubOwnershipSource({ ghApi }) })).role).toBe('standby');
  });
  it('runGhApi bounds output and time and reports parse/exec errors', () => {
    const execFile = vi.fn(() => '{}');
    expect(guard.runGhApi('fixture', { execFile }).ok).toBe(true);
    expect(execFile).toHaveBeenCalledWith('gh', ['api', 'fixture'], expect.objectContaining({ timeout: 15000, maxBuffer: 1024 * 1024 }));
    for (const output of ['{', '']) expect(guard.runGhApi('fixture', { execFile: () => output }).ok).toBe(false);
    expect(guard.runGhApi('fixture', { execFile: () => { throw new Error('HTTP 403'); } }).status).toBe(403);
  });
});
