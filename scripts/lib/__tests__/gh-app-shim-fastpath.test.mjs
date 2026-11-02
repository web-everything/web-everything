import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, mkdirSync, openSync, closeSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderGhShimScript } from '../gh-app-shim.mjs';
import { OWNER_INSTALLATIONS, installationCachePath } from '../github-app-installations.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const secret = 'ghs_private_TEST123';
function fixture({ cache = {}, missing = false, unreadable = false, roleTable = {}, owner = 'web-everything', nowEpoch, measureRead = false, unsupportedRead = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gh-fastpath-')); dirs.push(root);
  const dir = join(root, "bin ' $&` $(never)*"); mkdirSync(dir);
  const marker = join(dir, 'marker');
  const real = join(dir, "real 'gh");
  writeFileSync(real, '#!/bin/sh\nprintf "REAL argc=%s tokenlen=%s\\n" "$#" "${#GH_TOKEN}" >> "$MARKER"\nfor arg do case "$arg" in *"$GH_TOKEN"*) exit 91 ;; esac; done\n');
  chmodSync(real, 0o755);
  writeFileSync(join(dir, 'node'), '#!/bin/sh\nprintf "NODE\\n" >> "$MARKER"\n'); chmodSync(join(dir, 'node'), 0o755);
  const cachePath = join(dir, "cache 'x.json");
  const path = installationCachePath(cachePath, OWNER_INSTALLATIONS[owner]);
  if (unreadable) mkdirSync(path);
  else if (!missing) writeFileSync(path, typeof cache === 'string' ? cache : JSON.stringify({ v: 2, token: secret, expiresAt: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'), ...cache }));
  const clockMarker = join(dir, 'clock');
  const dateBin = nowEpoch !== undefined ? join(dir, "clock 'date") : undefined;
  if (nowEpoch !== undefined) {
    writeFileSync(dateBin, '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = +%s ] || exit 92\nprintf "DATE\\n" >> "$CLOCK_MARKER"\nprintf "%s\\n" "$CLOCK_EPOCH"\n');
    chmodSync(dateBin, 0o755);
  }
  const shim = join(dir, 'gh');
  const src = renderGhShimScript({ realGhPath: real, cachePath, roleTable, dateBin });
  // Use an inherited descriptor for the cache so its shared offset measures the
  // actual bytes consumed by the shell, including any builtin read-ahead.
  const readFd = measureRead ? openSync(path, 'r') : undefined;
  let bytesRead;
  let executable = measureRead ? src.replace('< "$cache"', '<&3') : src;
  if (unsupportedRead) executable = executable.replace('gh_fastpath "$@"\n', 'read() { return 2; }\ngh_fastpath "$@"\n');
  if (measureRead) expect(executable).not.toBe(src);
  writeFileSync(shim, executable); chmodSync(shim, 0o755);
  const env = { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, MARKER: marker, LC_ALL: 'C', CLOCK_MARKER: clockMarker, CLOCK_EPOCH: String(nowEpoch) };
  return { dir, src, bytesRead: () => bytesRead, clockCalls: () => readFileSync(clockMarker, 'utf8'), run(args = ['-R', 'web-everything/x'], extra = {}) {
    let r;
    try {
      r = spawnSync(shim, args, {
        env: { ...env, ...extra }, encoding: 'utf8',
        ...(measureRead ? { stdio: ['ignore', 'pipe', 'pipe', readFd] } : {}),
      });
    } finally {
      if (measureRead) {
        bytesRead = fstatSync(readFd).size - readFileSync(readFd).length;
        closeSync(readFd);
      }
    }
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(secret);
    return readFileSync(marker, 'utf8');
  } };
}
describe('gh shim shell fast path', () => {
  it('uses the baked /bin/date default instead of a PATH-planted date', () => {
    const f = fixture();
    const plantedDate = join(f.dir, 'date');
    writeFileSync(plantedDate, '#!/bin/sh\nprintf "PATH_DATE\\n" >> "$MARKER"\nexit 93\n');
    chmodSync(plantedDate, 0o755);
    expect(f.run()).toBe(`REAL argc=2 tokenlen=${secret.length}\n`);
  });
  it.each([['ASCII', 'x'], ['NUL', '\0']])('bounds bytes consumed from an oversized single-line %s cache before falling back', (_, char) => {
    const f = fixture({ cache: char.repeat(8 * 1024 * 1024), measureRead: true });
    expect(f.run()).toBe('NODE\n');
    expect(f.bytesRead()).toBeGreaterThan(0);
    expect(f.bytesRead()).toBeLessThanOrEqual(16385);
  });
  it('falls back when the shell does not support the bounded-read builtin', () => {
    expect(fixture({ unsupportedRead: true }).run()).toBe('NODE\n');
  });
  it('accepts a complete cache at the 16 KiB read limit', () => {
    const cache = JSON.stringify({ v: 2, token: secret, expiresAt: '2099-01-01T00:00:00Z' }).padEnd(16384, ' ');
    const f = fixture({ cache, measureRead: true });
    expect(f.run()).toBe(`REAL argc=2 tokenlen=${secret.length}\n`);
    expect(f.bytesRead()).toBe(16384);
  });
  it('rejects a NUL after an otherwise valid cache without reading its large suffix', () => {
    const cache = JSON.stringify({ v: 2, token: secret, expiresAt: '2099-01-01T00:00:00Z' }) + '\0' + 'x'.repeat(8 * 1024 * 1024);
    const f = fixture({ cache, measureRead: true });
    expect(f.run()).toBe('NODE\n');
    expect(f.bytesRead()).toBeLessThanOrEqual(16385);
  });
  it.each(Object.keys(OWNER_INSTALLATIONS))('bakes the real installation map for %s', owner => {
    expect(fixture({ owner }).run(['-R', `${owner}/x`])).toBe(`REAL argc=2 tokenlen=${secret.length}\n`);
  });
  it.each(['2032-02-29T23:59:59Z', '2100-03-01T00:00:00Z', '2000-02-29T00:00:00Z'])('uses civil arithmetic and exactly one date call for %s', expiresAt => {
    const epoch = Date.parse(expiresAt) / 1000;
    for (const [offset, expected] of [[601, `REAL argc=2 tokenlen=${secret.length}\n`], [600, 'NODE\n'], [599, 'NODE\n']]) {
      const f = fixture({ nowEpoch: epoch - offset, cache: { expiresAt } });
      expect(f.run()).toBe(expected);
      expect(f.clockCalls()).toBe('DATE\n');
    }
  });
  it('keeps shell quoting inert and the shell block free of closing JS comments', () => {
    const f = fixture();
    expect(f.src.indexOf('*/')).toBe(f.src.indexOf('\n*/') + 1);
    expect(f.run(undefined, { GH_TOKEN: 'inherited', GITHUB_TOKEN: 'also-inherited', XPC_SERVICE_NAME: 'unrelated.service' })).toBe(`REAL argc=2 tokenlen=${secret.length}\n`);
  });
  it.each([
    [['-R', 'web-everything/x'], {}], [['api', 'repos/web-everything/x/issues'], {}],
    [['api', '/repos/web-everything/x/issues'], {}], [['pr', 'list'], { GH_REPO: 'github.com/web-everything/x' }],
    [['--repo=github.com/WEB-EVERYTHING/x'], {}], [['-Rweb-everything/x'], {}],
    [['--repo', 'web-everything/x', '-R', 'unknown/x'], {}],
  ])('execs REAL only, preserving argv %j', (args, env) => {
    expect(fixture().run(args, env)).toBe(`REAL argc=${args.length} tokenlen=${secret.length}\n`);
  });
  it.each([
    ['near expiry', { cache: { expiresAt: new Date(Date.now() + 300e3).toISOString().replace(/\.\d{3}Z$/, 'Z') } }],
    ['missing', { missing: true }], ['unreadable file', { unreadable: true }], ['malformed', { cache: '{broken' }],
    ['trailing junk', { cache: '{"v":2,"expiresAt":"2099-01-01T00:00:00Z","token":"ghs_x"} junk' }],
    ['duplicate field', { cache: '{"v":2,"v":2,"expiresAt":"2099-01-01T00:00:00Z","token":"ghs_x"}' }],
    ['wrong version', { cache: { v: 1 } }], ['unsafe token', { cache: { token: 'bad-token' } }],
    ['missing token', { cache: '{"v":2,"expiresAt":"2099-01-01T00:00:00Z"}' }],
    ['invalid date', { cache: { expiresAt: '2099-02-30T00:00:00Z' } }],
    ['oversized cache', { cache: ' '.repeat(16385) }],
  ])('falls back for %s', (_, opts) => expect(fixture(opts).run()).toBe('NODE\n'));
  it.each(['unknown/x', 'chalbert/web-everything', 'CHALBERT/x', 'bad_owner/x', 'web-everything/'])('falls back for owner %s', repo => {
    expect(fixture().run(['-R', repo])).toBe('NODE\n');
  });
  it('falls back without an owner', () => expect(fixture().run(['pr', 'list'])).toBe('NODE\n'));
  it.each(['WE_GH_SHIM_NO_FASTPATH', 'WE_GH_DAEMON_CALLER', 'GH_HOST', 'GH_DEBUG', 'WE_GITHUB_APP_INSTALLATIONS', 'WE_GH_THROTTLE_PERSONAL_ROUTE'])('falls back with %s', key => {
    expect(fixture().run(undefined, { [key]: '1' })).toBe('NODE\n');
  });
  it.each(['com.we.worker', 'com.plateau.worker'])('falls back for daemon %s', value => expect(fixture().run(undefined, { XPC_SERVICE_NAME: value })).toBe('NODE\n'));
  it('keeps a single polyglot file and omits fast path for role tables', () => {
    const f = fixture({ roleTable: { worker: {} } });
    expect(f.src).toMatch(/^#!\/bin\/sh\n':' \/\*/);
    expect(f.src).not.toContain('gh_fastpath');
    expect(f.run()).toBe('NODE\n');
  });
});
