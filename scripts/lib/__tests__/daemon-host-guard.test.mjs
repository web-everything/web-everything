// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import * as guard from '../daemon-host-guard.mjs';

vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal() }));

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;
const VERSION = 'a'.repeat(40);
const LEGACY_NAMES = ['legacy-alpha', 'legacy-beta'];
// Each alias is bound to the UUID of the host it names; ME is the local host in these tests.
const LEGACY_ALIASES = Object.freeze({ 'legacy-alpha': ME, 'legacy-beta': ME });
const LEGACY_ENV = LEGACY_NAMES.map((name) => name + '=' + ME).join(',');
const record = (host = ME) => ({ host, version: VERSION });
const aliasRecord = (host = LEGACY_NAMES[0], legacyOwnerValues = LEGACY_ALIASES) => ({ ...record(host), legacyOwnerValues });
const resolve = (readOwner, extra = {}) => guard.resolveHostRole({
  thisHost: ME, source: { readOwner }, ...extra,
});
const roots = [];
function home() { const root = mkdtempSync(join(tmpdir(), 'host-id-')); roots.push(root); return root; }
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('fresh ownership only', () => {
  it('two local alias bindings cannot authorize either host; one shared binding authorizes only its UUID', () => {
    const owner = 'legacy-alpha';
    const decide = (thisHost, ownerRecord) => guard.decideHostRole({ thisHost, owner,
      ownerReadAt: NOW, now: NOW, legacyHost: owner, legacyOwnerValues: { [owner]: thisHost }, ownerRecord });
    expect([decide(ME), decide(OTHER)]).toEqual([
      { role: 'standby', reason: 'owner-alias-ambiguous' },
      { role: 'standby', reason: 'owner-alias-ambiguous' },
    ]);
    const shared = { ...record(owner), legacyOwnerValues: { [owner]: ME } };
    expect(decide(ME, shared)).toEqual({ role: 'active', reason: 'fresh-owner-is-this-host' });
    expect(decide(OTHER, shared)).toEqual({ role: 'standby', reason: 'owner-is-other-host' });
    expect(guard.decideHostRole({ thisHost: ME, owner: ME, now: NOW, ownerReadAt: NOW }).role).toBe('active');
  });

  it.each([undefined, {}, { 'legacy-alpha': [ME, OTHER] }, { 'legacy-alpha': ME + ',' + OTHER },
    { 'legacy-alpha': ME + '\n' }, Object.create({ 'legacy-alpha': ME })])(
    'missing or ambiguous shared alias binding %j fails closed despite a local binding', (bindings) => {
      expect(guard.decideHostRole({ thisHost: ME, owner: 'legacy-alpha', now: NOW, ownerReadAt: NOW,
        legacyHost: 'legacy-alpha', legacyOwnerValues: LEGACY_ALIASES,
        ownerRecord: { ...record('legacy-alpha'), legacyOwnerValues: bindings },
      })).toEqual({ role: 'standby', reason: 'owner-alias-ambiguous' });
    },
  );

  it('shared bindings must belong to the record naming the observed owner', () => {
    expect(guard.decideHostRole({ thisHost: ME, owner: 'legacy-alpha', now: NOW, ownerReadAt: NOW,
      legacyHost: 'legacy-alpha', legacyOwnerValues: LEGACY_ALIASES,
      ownerRecord: { ...record('legacy-beta'), legacyOwnerValues: LEGACY_ALIASES },
    })).toEqual({ role: 'standby', reason: 'owner-alias-ambiguous' });
  });

  it('fresh local owner activates; another owner and unset stay standby', async () => {
    expect((await resolve(() => record())).role).toBe('active');
    expect(await resolve(() => record(OTHER))).toMatchObject({ role: 'standby', reason: 'owner-is-other-host' });
    expect(await resolve(() => record(''))).toMatchObject({ role: 'standby', reason: 'owner-unset' });
  });

  it.each([undefined, null, {}, { host: ME }, { host: ME, version: '' },
    { host: ME, version: 1 }, { host: ME, version: VERSION, status: 'error' },
    record(1), record('unknown'), record(ME + '\nextra'), record(ME + '\n'), record(' ' + ME),
    { host: ME, version: VERSION + '\n' },
    { status: 'error', error: 'offline' }, { status: 'ok', owner: ME }])(
    'unexpected source result %j gives standby', async (value) => {
      expect((await resolve(() => value)).role).toBe('standby');
    },
  );

  it.each(['offline', 'HTTP 403', 'HTTP 429', 'HTTP 500', 'timeout', 'maxBuffer exceeded'])(
    'source failure %s gives standby after successful ownership', async (message) => {
      let reads = 0;
      const readOwner = () => { if (++reads === 1) return record(); throw new Error(message); };
      expect((await resolve(readOwner)).role).toBe('active');
      expect(await resolve(readOwner)).toMatchObject({ role: 'standby', source: 'remote-failed' });
      expect(reads).toBe(2);
    },
  );

  it('every invocation reads again across handoff, failure, restart and recovery', async () => {
    const values = [record(), record(OTHER), null, record(''), record()];
    const readOwner = vi.fn(() => values.shift());
    const roles = [];
    for (let i = 0; i < 5; i++) roles.push((await resolve(readOwner)).role);
    expect(roles).toEqual(['active', 'standby', 'standby', 'standby', 'active']);
    expect(readOwner).toHaveBeenCalledTimes(5);
  });

  it('concurrent invocations each require their own fresh read', async () => {
    let finish;
    const pending = resolve(() => new Promise((done) => { finish = done; }));
    await Promise.resolve();
    expect((await resolve(() => { throw new Error('offline'); })).role).toBe('standby');
    finish(record());
    expect((await pending).role).toBe('active');
  });

  it('a stalled source times out and a late success cannot activate its caller', async () => {
    vi.useFakeTimers();
    let finish;
    const pending = resolve(() => new Promise((done) => { finish = done; }), { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ role: 'standby', source: 'remote-failed' });
    finish(record());
    expect((await pending).role).toBe('standby');
  });

  it('stale or backwards elapsed time cannot activate a successful read', async () => {
    for (const elapsed of [60_001, -1, NaN]) {
      const times = [0, elapsed];
      expect((await resolve(() => record(), { clock: () => times.shift() })).role).toBe('standby');
    }
  });

  it('pure decisions require valid identity and fresh evidence', () => {
    for (const extra of [{}, { owner: ME }, { owner: ME, ownerReadAt: NOW - 60_001 },
      { owner: ME, ownerReadAt: NOW + 1 }, { owner: ME, ownerReadAt: NOW, thisHost: '' },
      { owner: ME, ownerReadAt: NOW, now: NaN }]) {
      expect(guard.decideHostRole({ thisHost: ME, now: NOW, ...extra }).role).toBe('standby');
    }
    expect(guard.decideHostRole({ thisHost: ME, owner: ME, ownerReadAt: NOW, now: NOW }).role).toBe('active');
  });

  it('invalid identity, missing source method and source rejection fail closed', async () => {
    for (const thisHost of ['', null, 'unknown', ME + '\n']) {
      const readOwner = vi.fn(() => record());
      expect((await resolve(readOwner, { thisHost })).role).toBe('standby');
      expect(readOwner).not.toHaveBeenCalled();
    }
    expect((await resolve(null)).role).toBe('standby');
    expect((await resolve(() => Promise.reject(new Error('offline')))).role).toBe('standby');
  });
});

describe('opaque local identity', () => {
  it.each([0, 7])('legacy discovery uses the remaining resolver budget after %i ms of source work', async (sourceMs) => {
    let now = 1000;
    const started = now;
    // Model a synchronous 100 ms scutil call that respects its supplied timeout.
    const exec = vi.spyOn(childProcess, 'execFileSync').mockImplementation((_file, _args, options) => {
      now += Math.min(100, options.timeout);
      if (options.timeout < 100) throw new Error('scutil timed out');
      return 'legacy-alpha\n';
    });
    try {
      const decision = await resolve(() => { now += sourceMs; return aliasRecord(); }, {
        timeoutMs: 20, clock: () => now,
      });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith('scutil', ['--get', 'HostName'],
        expect.objectContaining({ timeout: 20 - sourceMs }));
      expect(now - started).toBeLessThanOrEqual(20);
      expect(decision).toEqual({ role: 'standby', reason: 'host-identity-unknown', source: 'remote' });
    } finally { exec.mockRestore(); }
  });

  it.each([20, 21])('legacy discovery skips scutil when the resolver budget expired after %i ms', async (sourceMs) => {
    let now = 1000;
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('legacy-alpha\n');
    try {
      const decision = await resolve(() => { now += sourceMs; return aliasRecord(); }, {
        timeoutMs: 20, clock: () => now,
      });
      expect(exec).not.toHaveBeenCalled();
      expect(decision).toEqual({ role: 'standby', reason: 'host-identity-unknown', source: 'remote' });
    } finally { exec.mockRestore(); }
  });

  it('generates once, persists mode 600, and independent homes have different IDs', () => {
    const root = home();
    const id = guard.getThisHost({ home: root });
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(guard.getThisHost({ home: root })).toBe(id);
    expect(guard.getThisHost({ home: home() })).not.toBe(id);
    expect(readFileSync(join(root, '.claude', 'host-id'), 'utf8')).toBe(id + '\n');
    expect(statSync(join(root, '.claude', 'host-id')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, '.claude'))).toEqual(['host-id']);
  });

  it('read-only identity lookup never provisions a missing ID', () => {
    const root = home();
    expect(guard.getThisHost({ home: root, create: false })).toBe('');
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(['empty', 'malformed', 'oversized', 'permissions', 'symlink', 'directory', 'unwritable-parent'])(
    '%s identity fails closed without replacement', (kind) => {
      const root = home();
      const dir = join(root, '.claude');
      if (kind === 'unwritable-parent') writeFileSync(dir, 'not a directory');
      else {
        mkdirSync(dir);
        const path = join(dir, 'host-id');
        if (kind === 'directory') mkdirSync(path);
        else if (kind === 'symlink') { writeFileSync(join(root, 'target'), ME + '\n', { mode: 0o600 }); symlinkSync(join(root, 'target'), path); }
        else {
          writeFileSync(path, kind === 'empty' ? '' : kind === 'oversized' ? 'x'.repeat(1024) : kind === 'malformed' ? 'unknown' : ME + '\n', { mode: 0o600 });
          if (kind === 'permissions') chmodSync(path, 0o644);
        }
      }
      expect(guard.getThisHost({ home: root })).toBe('');
    },
  );

  it('a second process reuses the persisted ID', () => {
    const root = home();
    const id = guard.getThisHost({ home: root });
    const url = new URL('../daemon-host-guard.mjs', import.meta.url).href;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e',
      'import { getThisHost } from ' + JSON.stringify(url) + '; console.log(getThisHost());'], {
      env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    });
    expect(result.trim()).toBe(id);
  });

  it('simultaneous initializers publish one complete identity without overwriting', async () => {
    const root = home();
    const url = new URL('../daemon-host-guard.mjs', import.meta.url).href;
    const code = 'import { getThisHost } from ' + JSON.stringify(url)
      + '; process.send("ready"); process.once("message", () => { process.send(getThisHost()); process.disconnect(); });';
    const children = Array.from({ length: 3 }, () => spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }));
    try {
      const exits = children.map((child) => once(child, 'exit'));
      await Promise.all(children.map((child) => once(child, 'message')));
      const ids = children.map((child) => once(child, 'message'));
      children.forEach((child) => child.send('go'));
      const values = (await Promise.all(ids)).map(([id]) => id);
      expect(values[0]).toMatch(/^[a-f0-9-]{36}$/);
      expect(new Set(values).size).toBe(1);
      expect((await Promise.all(exits)).every(([code]) => code === 0)).toBe(true);
      expect(guard.getThisHost({ home: root })).toBe(values[0]);
      expect(readdirSync(join(root, '.claude'))).toEqual(['host-id']);
    } finally { children.forEach((child) => child.kill()); }
  });

  it('shared legacy migration still requires the locally established alias', async () => {
    for (const alias of LEGACY_NAMES) {
      expect((await resolve(() => aliasRecord(alias), { legacyHost: alias })).role).toBe('active');
      expect((await resolve(() => aliasRecord(alias), { legacyHost: '' })).role).toBe('standby');
    }
    expect((await resolve(() => aliasRecord(LEGACY_NAMES[0]), {
      legacyHost: LEGACY_NAMES[1],
    })).role).toBe('standby');
  });

  it('two hosts sharing an alias but with different UUIDs: only the UUID match activates', async () => {
    const alias = LEGACY_NAMES[0];
    // The alias is bound to ME's UUID; both hosts report the same local name via scutil.
    const bindings = Object.freeze({ [alias]: ME });
    const legacyHost = guard.getLegacyHost({ exec: () => alias + '\n', legacyOwnerValues: bindings });
    expect(legacyHost).toBe(alias);
    const roleOf = (thisHost) => guard.resolveHostRole({ thisHost, legacyHost,
      source: { readOwner: () => aliasRecord(alias, bindings) } });
    expect(await roleOf(ME)).toMatchObject({ role: 'active', reason: 'fresh-owner-is-this-host' });
    expect(await roleOf(OTHER)).toMatchObject({ role: 'standby', reason: 'owner-is-other-host' });
    // The pure decision agrees: a matching alias name alone never replaces the UUID check.
    expect(guard.decideHostRole({ thisHost: OTHER, owner: alias, ownerReadAt: NOW, now: NOW,
      legacyHost: alias, ownerRecord: aliasRecord(alias, bindings) })).toEqual({ role: 'standby', reason: 'owner-is-other-host' });
  });

  it('the deprecated discovery helper parses local configuration without supplying ownership evidence', () => {
    expect({ ...guard.getLegacyOwnerValues({}) }).toEqual({});
    expect({ ...guard.getLegacyOwnerValues({ WE_DAEMON_LEGACY_OWNER_VALUES: LEGACY_ENV }) }).toEqual(LEGACY_ALIASES);
    vi.stubEnv('WE_DAEMON_LEGACY_OWNER_VALUES', LEGACY_ENV);
    try { expect({ ...guard.getLegacyOwnerValues() }).toEqual(LEGACY_ALIASES); }
    finally { vi.unstubAllEnvs(); }
  });

  it.each(['legacy-alpha=', 'legacy-alpha=' + ME + ',', 'legacy-alpha=' + ME + '\n', 'legacy-alpha=' + ME + '\r',
    '`legacy-alpha=' + ME, '--legacy-alpha=' + ME, '../legacy-alpha=' + ME,
    String.fromCharCode(0x200b) + 'legacy-alpha=' + ME, 'legacy-alpha=not-a-uuid',
    'legacy-alpha=' + ME + '=' + ME, ME + '=' + ME,
    'legacy-alpha=' + ME + ',legacy-alpha=' + OTHER, 'legacy-alpha=' + ME + ' legacy-beta=' + ME])(
    'alias configuration without exactly one valid UUID binding per alias %j disables migration', (value) => {
      expect({ ...guard.getLegacyOwnerValues({ WE_DAEMON_LEGACY_OWNER_VALUES: value }) }).toEqual({});
    },
  );

  it('a failing scutil fails closed: no legacy host, no OS-hostname fallback, no activation', async () => {
    const alias = LEGACY_NAMES[0];
    const osHostname = vi.fn(() => alias);
    for (const failure of [
      () => { throw Object.assign(new Error('scutil unavailable'), { code: 'ENOENT' }); },
      () => { throw Object.assign(new Error('scutil timed out'), { code: 'ETIMEDOUT' }); },
      () => '', () => '\n',
    ]) {
      // A stray hostname option must not be honoured: the OS name is never consulted.
      const legacyHost = guard.getLegacyHost({ exec: failure, hostname: osHostname, legacyOwnerValues: LEGACY_ALIASES });
      expect(legacyHost).toBeNull();
      expect(await guard.resolveHostRole({ thisHost: ME, legacyHost,
        source: { readOwner: () => aliasRecord(alias) } })).toEqual({ role: 'standby', reason: 'host-identity-unknown', source: 'remote' });
    }
    expect(osHostname).not.toHaveBeenCalled();
  });

  it('remote resolver refuses a failed scutil lookup without an injected alias', async () => {
    const exec = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('scutil unavailable'), { code: 'ENOENT' });
    });
    try {
      expect(await resolve(() => aliasRecord())).toEqual({ role: 'standby', reason: 'host-identity-unknown', source: 'remote' });
      expect(exec).toHaveBeenCalledWith('scutil', ['--get', 'HostName'], expect.any(Object));
    } finally { exec.mockRestore(); }
  });

  it('a readable non-matching scutil name still identifies another owner', async () => {
    const legacyHost = guard.getLegacyHost({ exec: () => 'unrecognized\n', legacyOwnerValues: LEGACY_ALIASES });
    expect(legacyHost).toBe('');
    expect(await resolve(() => aliasRecord(), { legacyHost })).toEqual({ role: 'standby', reason: 'owner-is-other-host', source: 'remote' });
  });

  it.each([0, -1, NaN, Infinity])('invalid legacy lookup timeout %s fails closed without executing', (timeoutMs) => {
    const exec = vi.fn();
    expect(guard.getLegacyHost({ exec, legacyOwnerValues: LEGACY_ALIASES, timeoutMs })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['', 'legacy-alpha,', 'legacy-alpha\n', 'legacy-alpha\r', 'legacy-alpha\u2028',
    '`legacy-alpha', '"legacy-alpha', '--legacy-alpha', '../legacy-alpha', '\u200blegacy-alpha',
    'ｌegacy-alpha', 'legacy-alpha legacy-beta', 'x'.repeat(1025), ME])(
    'invalid local alias configuration %j disables migration', (value) => {
      expect({ ...guard.getLegacyOwnerValues({ WE_DAEMON_LEGACY_OWNER_VALUES: value }) }).toEqual({});
    },
  );

  it('unconfigured aliases fail closed even when the local name matches', async () => {
    const owner = LEGACY_NAMES[0];
    expect(await resolve(() => record(owner), { legacyOwnerValues: {}, legacyHost: owner }))
      .toMatchObject({ role: 'standby', reason: 'owner-alias-ambiguous' });
    expect(guard.decideHostRole({ thisHost: ME, owner, ownerReadAt: NOW, now: NOW, legacyHost: owner }))
      .toEqual({ role: 'standby', reason: 'owner-alias-ambiguous' });
  });

  it('legacy discovery bounds argv execution and fails closed on unknown names', () => {
    const alias = LEGACY_NAMES[0];
    const legacyOwnerValues = LEGACY_ALIASES;
    const exec = vi.fn(() => alias + '\n');
    expect(guard.getLegacyHost({ exec, legacyOwnerValues })).toBe(alias);
    expect(exec).toHaveBeenCalledWith('scutil', ['--get', 'HostName'], expect.objectContaining({ timeout: 15000, maxBuffer: 1024 * 1024 }));
    expect(guard.getLegacyHost({ legacyOwnerValues, exec: () => 'unrecognized' })).toBe('');
    exec.mockClear();
    expect(guard.getLegacyHost({ exec, legacyOwnerValues: {} })).toBe('');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('GitHub ownership source', () => {
  const file = (text = ME + '\n') => ({ ok: true, status: 200,
    body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } });
  const ref = { ok: true, status: 200, body: { object: { type: 'commit', sha: VERSION } } };
  const source = (responses) => guard.createGitHubOwnershipSource({ ghApi: () => responses.shift() });

  it.each([
    ['a'.repeat(253), true], ['a'.repeat(254), false], ['legacy-alpha-', false], ['legacy-alpha.', false],
  ])('alias boundary %s is validated as owner and binding key (valid=%s)', async (alias, valid) => {
    const bindings = guard.getLegacyOwnerValues({ WE_DAEMON_LEGACY_OWNER_VALUES: `${alias}=${ME}` });
    expect({ ...bindings }).toEqual(valid ? { [alias]: ME } : {});
    const shared = source([ref, file(`${alias}\n${alias}=${ME}\n`)]);
    if (valid) {
      expect(await shared.readOwner()).toEqual(aliasRecord(alias, { [alias]: ME }));
    } else {
      await expect(shared.readOwner()).rejects.toThrow('invalid owner ID');
    }
    const bindingRecord = await source([ref, file(`legacy-alpha\n${alias}=${ME}\n`)]).readOwner();
    expect({ ...bindingRecord.legacyOwnerValues }).toEqual(valid ? { [alias]: ME } : {});
  });

  it('rejects a shared alias owner file with a third extra line', async () => {
    await expect(source([ref, file(`legacy-alpha\nlegacy-alpha=${ME}\njunk\n`)]).readOwner())
      .rejects.toThrow('invalid owner record');
  });

  it.each(['\n', '\r\n'])('reads owner and alias bindings from the same pinned file with %j endings', async (newline) => {
    const api = vi.fn().mockResolvedValueOnce(ref)
      .mockResolvedValueOnce(file(['legacy-alpha', LEGACY_ENV, ''].join(newline)));
    const shared = await guard.createGitHubOwnershipSource({ ghApi: api,
      legacyOwnerValues: { 'legacy-alpha': OTHER } }).readOwner();
    expect(shared).toEqual(aliasRecord());
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[1][0]).toContain('/contents/host?ref=' + VERSION);
    expect(await resolve(() => shared, { legacyHost: 'legacy-alpha' })).toMatchObject({ role: 'active' });
    expect(await resolve(() => shared, { thisHost: OTHER, legacyHost: 'legacy-alpha',
      legacyOwnerValues: { 'legacy-alpha': OTHER } })).toMatchObject({ role: 'standby', reason: 'owner-is-other-host' });
  });

  it.each([undefined, '', 'legacy-beta=' + ME, 'legacy-alpha=' + ME + ',legacy-alpha=' + OTHER,
    'legacy-alpha=' + ME + ',legacy-alpha=' + ME, 'legacy-alpha=' + ME + ',',
    'legacy-alpha=' + ME + '\rjunk', 'legacy-alpha=' + ME + '\u2028',
    'legacy-alpha=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'legacy-alpha=not-a-uuid',
    '`legacy-alpha=' + ME, '"legacy-alpha=' + ME, '--legacy-alpha=' + ME,
    '../legacy-alpha=' + ME, '\u200blegacy-alpha=' + ME, 'ｌegacy-alpha=' + ME])(
    'shared alias record with missing, duplicate or malformed bindings %j cannot use local fallback', async (bindings) => {
      const contents = 'legacy-alpha' + (bindings === undefined ? '' : '\n' + bindings) + '\n';
      expect(await resolve(() => source([ref, file(contents)]).readOwner(), {
        legacyHost: 'legacy-alpha', legacyOwnerValues: LEGACY_ALIASES,
      })).toMatchObject({ role: 'standby', reason: 'owner-alias-ambiguous' });
    },
  );

  it('does not reuse shared alias authority after it disappears or the next read fails', async () => {
    const values = [aliasRecord(), record('legacy-alpha'), aliasRecord('legacy-alpha', { 'legacy-alpha': OTHER }), null];
    const roles = [];
    for (const value of values) roles.push(await resolve(() => value, { legacyHost: 'legacy-alpha', legacyOwnerValues: LEGACY_ALIASES }));
    expect(roles.map(({ reason }) => reason)).toEqual([
      'fresh-owner-is-this-host', 'owner-alias-ambiguous', 'owner-is-other-host', 'owner-unreadable',
    ]);
  });

  it('reads owner at the observed commit and returns host and version', async () => {
    const api = vi.fn().mockResolvedValueOnce(ref).mockResolvedValueOnce(file());
    expect(await guard.createGitHubOwnershipSource({ ghApi: api }).readOwner()).toEqual(record());
    expect(api.mock.calls[0][0]).toMatch(/git\/ref\/heads\/daemon-host-owner$/);
    expect(api.mock.calls[1][0]).toContain('/contents/host?ref=' + VERSION);
  });

  it('missing branch and empty owner are explicit unset results', async () => {
    expect((await source([{ ok: false, status: 404 }]).readOwner()).host).toBe('');
    expect(await source([ref, file('')]).readOwner()).toEqual(record(''));
  });

  it.each([ME, ME + '\n', ME + '\r\n'])('accepts a single ID with supported line ending', async (value) => {
    expect(await source([ref, file(value)]).readOwner()).toEqual(record());
  });

  it.each([
    { type: 'file', encoding: 'base64', content: '!!!!' },
    { type: 'file', encoding: 'base64', content: 'Zh==' },
    { type: 'file', encoding: 'none', content: '' },
    { type: 'symlink', encoding: 'base64', content: '' },
    { type: 'file', encoding: 'base64', content: 1 },
  ])('bad encoding or file type fails closed: %j', async (body) => {
    expect((await guard.resolveHostRole({ thisHost: ME,
      source: source([ref, { ok: true, status: 200, body }]),
    })).role).toBe('standby');
  });

  it.each([
    [[{ ok: false, status: 403 }]], [[{ ok: true, status: 200, body: {} }]],
    [[ref, { ok: false, status: 404 }]], [[ref, { ok: false, status: 500 }]],
    [[ref, { ok: true, status: 200, body: { encoding: 'base64', content: '!!!!' } }]],
    [[ref, file('unknown')]], [[ref, file(ME + '\n' + OTHER)]], [[ref, file('x'.repeat(1024))]],
    [[ref, file('\u200b' + ME)]], [[ref, file('--' + ME)]], [[ref, file('../' + ME)]],
    [[ref, file(ME + '\n\n')]], [[ref, file(ME + '\u2028')]], [[ref, file('`' + ME)]],
    [[ref, file('"' + ME)]], [[ref, file(ME + OTHER)]],
  ])('invalid transport or content %j resolves standby', async (responses) => {
    expect((await guard.resolveHostRole({ thisHost: ME, source: source([...responses]) })).role).toBe('standby');
  });

  it('transport bounds output and duration; execution and JSON errors fail closed', () => {
    const exec = vi.fn(() => '{"ok":true}');
    expect(guard.runGhApi('fixture', { execFile: exec }).ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('gh', ['api', 'fixture'], expect.objectContaining({ timeout: 15000, maxBuffer: 1024 * 1024 }));
    expect(guard.runGhApi('fixture', { execFile: () => '{' }).ok).toBe(false);
    expect(guard.runGhApi('fixture', { execFile: () => { throw new Error('HTTP 403'); } })).toMatchObject({ ok: false, status: 403 });
  });

  describe('synchronous production source honors the read deadline', () => {
    // A real sync child (`exec sleep`) cannot be interrupted by a timer: only the child's own timeout can stop it.
    function stubGh(seconds) {
      const dir = home();
      const bin = join(dir, 'gh');
      const marker = join(dir, 'started');
      writeFileSync(bin, '#!/bin/sh\n: > "' + marker + '"\nexec sleep ' + seconds + '\n');
      chmodSync(bin, 0o755);
      return { bin, marker };
    }
    const syncSource = (bin, errors = []) => guard.createGitHubOwnershipSource({
      ghApi: (path, options) => guard.runGhApi(path, { ...options, execFile: (_file, args, opts) => {
        try { return execFileSync(bin, args, opts); } catch (error) { errors.push(error); throw error; }
      } }),
    });

    it('kills a stalled gh child at the deadline and fails closed', async () => {
      const { bin, marker } = stubGh(30);
      const errors = [];
      const started = Date.now();
      const decision = await guard.resolveHostRole({ thisHost: ME, source: syncSource(bin, errors), timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(5000);
      // The stub really ran and was killed by its own timeout (not a fast spawn failure).
      expect(statSync(marker).isFile()).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: 'ETIMEDOUT' });
      expect(decision).toMatchObject({ role: 'standby', reason: 'owner-unreadable', source: 'remote-failed' });
    });

    it('runGhApi caps the child timeout at the caller deadline and kills with SIGKILL', () => {
      const exec = vi.fn(() => '{"ok":true}');
      guard.runGhApi('fixture', { execFile: exec, timeoutMs: 250 });
      expect(exec.mock.calls[0][2]).toMatchObject({ timeout: 250, killSignal: 'SIGKILL' });
      guard.runGhApi('fixture', { execFile: exec, timeoutMs: 10 ** 9 });
      expect(exec.mock.calls[1][2]).toMatchObject({ timeout: 15000, killSignal: 'SIGKILL' });
      guard.runGhApi('fixture', { execFile: exec, timeoutMs: 0.2 });
      expect(exec.mock.calls[2][2].timeout).toBe(1);
      guard.runGhApi('fixture', { execFile: exec });
      expect(exec.mock.calls[3][2]).toMatchObject({ timeout: 15000, killSignal: 'SIGKILL' });
    });

    it('gives each read only the time left before the shared deadline, and stops once it has passed', async () => {
      let now = 1000;
      const seen = [];
      const api = vi.fn(async (path, options) => { seen.push(options.timeoutMs); now += 400; return path.includes('/git/ref/') ? ref : file(); });
      const clock = () => now;
      expect(await guard.createGitHubOwnershipSource({ ghApi: api }).readOwner({ deadline: 2000, clock })).toEqual(record());
      expect(seen).toEqual([1000, 600]);
      now = 1000;
      api.mockClear();
      await expect(guard.createGitHubOwnershipSource({ ghApi: api }).readOwner({ deadline: 1300, clock }))
        .rejects.toThrow('owner read deadline');
      expect(api).toHaveBeenCalledTimes(1);
      now = 5000;
      api.mockClear();
      await expect(guard.createGitHubOwnershipSource({ ghApi: api }).readOwner({ deadline: 4000, clock }))
        .rejects.toThrow('owner read deadline');
      expect(api).not.toHaveBeenCalled();
    });

    it('resolveHostRole hands the source the read deadline derived from timeoutMs', async () => {
      const readOwner = vi.fn(() => record());
      await guard.resolveHostRole({ thisHost: ME, source: { readOwner }, timeoutMs: 700, clock: () => 50 });
      expect(readOwner.mock.calls[0][0]).toMatchObject({ deadline: 750 });
      expect(typeof readOwner.mock.calls[0][0].clock).toBe('function');
    });

    it('legacy hostname lookup also kills a stalled child', () => {
      const exec = vi.fn(() => LEGACY_NAMES[0] + '\n');
      guard.getLegacyHost({ exec, legacyOwnerValues: LEGACY_ALIASES });
      expect(exec.mock.calls[0][2]).toMatchObject({ timeout: 15000, killSignal: 'SIGKILL' });
    });
  });
});
