// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { constants, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as provenanceIo from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRemoteExec, formatAdmissionPolicy, privateAdmissionPool, resolveAdmissionPolicy, resolveRemoteClient, runWithRemoteDecision } from '../heavy-admission.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFile: vi.fn(),
}));
// Preserve real IO while making the built-in namespace configurable for read-range observation.
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal() }));
vi.mock('../../lib/daemon-events.mjs', async (importOriginal) => ({
  ...await importOriginal(), appendDaemonEvent: vi.fn(async () => true),
}));

const roots = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(execFile).mockReset();
  vi.mocked(appendDaemonEvent).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const success = "export async function runRemote() { return { mode: 'remote', code: 0 }; }";
function fixture(source = success) {
  const root = mkdtempSync(join(tmpdir(), 'remote-client-'));
  roots.push(root);
  const clientPath = join(root, 'client', 'remote-exec.mjs');
  mkdirSync(dirname(clientPath));
  writeFileSync(clientPath, source);
  const lockRoot = join(root, 'pool', '.admission', 'heavy');
  const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always', clientPath } } });
  const seams = { policy, lockRoot, laneRoots: [], readSha: vi.fn(() => 'abc123'),
    log: vi.fn(), appendEvent: vi.fn(async () => true), notice: { logged: false } };
  const run = (extra = {}) => runWithRemoteDecision({ argv: ['npm', 'run', 'build'], cwd: root, env: {},
    policy, loadPerCore: () => 0, log: seams.log, remoteExec: createRemoteExec({ ...seams, ...extra }) });
  return { root, clientPath, policy, seams, run, state: join(dirname(lockRoot), 'remote', 'client-override.json') };
}

function mockProvenanceFs() {
  return { lstat: vi.fn(async () => ({ isFile: () => true, size: 2 })),
    readFile: vi.fn(async () => '{}'), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
}
function makeFifo(file, context) {
  try { execFileSync('mkfifo', [file], { timeout: 1000, maxBuffer: 4096 }); }
  catch (error) {
    if (['ENOENT', 'ENOSYS', 'ENOTSUP'].includes(error.code)) context.skip();
    throw error;
  }
}

describe('remote client override', () => {
  it.each([undefined, null])('unset %s imports the bundled path and preserves the existing log', async (clientPath) => {
    const f = fixture();
    f.policy.settings.remote.clientPath = clientPath;
    const runRemote = vi.fn(async () => ({ mode: 'remote', code: 0 }));
    const importClient = vi.fn(async () => ({ runRemote }));
    expect(await f.run({ importClient })).toEqual({ handled: true, exitCode: 0 });
    expect(importClient).toHaveBeenCalledTimes(1);
    expect(importClient).toHaveBeenCalledWith('./remote-exec.mjs');
    expect(f.seams.log.mock.calls).toEqual([['heavy-admission: remote (remote.enabled=true (platform); mode=always)\n']]);
    expect(f.seams.readSha).not.toHaveBeenCalled();
    expect(f.seams.appendEvent).not.toHaveBeenCalled();
    const baseline = resolveAdmissionPolicy();
    expect(formatAdmissionPolicy(baseline)).not.toContain('clientPath');
  });

  it('delegates a real module; logs once and persists events only when path or sha changes', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
    const first = { clientPath: f.clientPath, sha: 'abc123' };
    // realpath may expand a platform tmpdir symlink.
    first.clientPath = resolveRemoteClient({ clientPath: f.clientPath }).clientPath;
    expect(f.seams.log).toHaveBeenCalledWith(`heavy-admission: remote client override ${first.clientPath} @ abc123\n`);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual(first));
    expect(f.seams.appendEvent).toHaveBeenCalledTimes(1);
    expect(f.seams.appendEvent).toHaveBeenCalledWith({ kind: 'remote-client-override', detail: { ...first, previous: null } });
    const realOpen = provenanceIo.open;
    let close;
    const reads = vi.spyOn(provenanceIo, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      close = vi.spyOn(handle, 'close');
      return handle;
    });
    await f.run();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await close.mock.results[0].value;
    reads.mockRestore();
    expect(f.seams.appendEvent).toHaveBeenCalledTimes(1);
    f.seams.readSha.mockReturnValue('def456');
    await f.run();
    await vi.waitFor(() => expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual({ ...first, sha: 'def456' }));
    expect(f.seams.appendEvent).toHaveBeenCalledTimes(2);
    expect(f.seams.appendEvent.mock.calls[1][0].detail).toEqual({ ...first, sha: 'def456', previous: first });
    const other = fixture();
    f.policy.settings.remote.clientPath = other.clientPath;
    await f.run();
    await vi.waitFor(() => expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual({
      clientPath: resolveRemoteClient({ clientPath: other.clientPath }).clientPath, sha: 'def456',
    }));
    expect(f.seams.appendEvent).toHaveBeenCalledTimes(3);
    expect(f.seams.appendEvent.mock.calls[2][0].detail.previous).toEqual({ ...first, sha: 'def456' });
    expect(f.seams.log.mock.calls.filter(([line]) => line.includes(' @ '))).toHaveLength(1);
  });

  it('uses createRemoteExec by default and keeps an invalid override local', async () => {
    const f = fixture();
    f.policy.settings.remote.clientPath = 'relative/remote-exec.mjs';
    expect(await runWithRemoteDecision({ argv: ['npm', 'run', 'build'], policy: f.policy, cwd: f.root,
      env: {}, log: f.seams.log })).toEqual({ handled: false });
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('clientPath must be absolute'));
  });

  it('forwards lockRoot through the production runWithRemoteDecision default executor', async () => {
    const f = fixture();
    vi.stubEnv('WE_DAEMON_EVENTS', join(f.root, 'events.jsonl'));
    const lockRoot = join(f.root, 'explicit-pool', '.admission', 'heavy');
    const env = { LANE_POOL_ROOT: join(f.root, 'derived-pool') };
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => callback(null, 'production-sha\n'));
    // main() supplies lockRoot to this entry point; leave remoteExec unset to exercise its wiring.
    expect(await runWithRemoteDecision({ argv: ['npm', 'run', 'build'], cwd: f.root, env,
      policy: f.policy, lockRoot, log: f.seams.log })).toEqual({ handled: true, exitCode: 0 });
    const pair = { clientPath: resolveRemoteClient({ clientPath: f.clientPath }).clientPath, sha: 'production-sha' };
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dirname(lockRoot), 'remote', 'client-override.json'), 'utf8'))).toEqual(pair));
    expect(appendDaemonEvent).toHaveBeenCalledWith({ kind: 'remote-client-override', detail: { ...pair, previous: null } });
    expect(existsSync(join(env.LANE_POOL_ROOT, '.admission', 'remote', 'client-override.json'))).toBe(false);
    expect(existsSync(f.state)).toBe(false);
  });

  it('passes the exact options object to runRemote and imports a file URL', async () => {
    const f = fixture();
    const options = { argv: ['echo', '$(literal)'], cwd: f.root, env: { A: 'b' }, signal: new AbortController().signal };
    const runRemote = vi.fn(async () => ({ mode: 'remote', code: 7 }));
    const importClient = vi.fn(async () => ({ runRemote }));
    expect(await createRemoteExec({ ...f.seams, importClient })(options)).toEqual({ mode: 'remote', code: 7 });
    expect(runRemote.mock.calls[0][0]).toBe(options);
    expect(importClient).toHaveBeenCalledWith(pathToFileURL(resolveRemoteClient({ clientPath: f.clientPath }).clientPath).href);
  });

  it.each(['relative', 'missing', 'directory', 'basename', 'lane', 'custom pool', 'symlink into lane'])('rejects %s and falls back locally with a reason', async (kind) => {
    const f = fixture();
    let path = f.clientPath;
    if (kind === 'relative') path = 'remote-exec.mjs';
    if (kind === 'missing') path = join(f.root, 'missing', 'remote-exec.mjs');
    if (kind === 'directory') { path = join(f.root, 'directory', 'remote-exec.mjs'); mkdirSync(path, { recursive: true }); }
    if (kind === 'basename') { path = join(f.root, 'other.mjs'); writeFileSync(path, success); }
    if (kind === 'lane' || kind === 'symlink into lane' || kind === 'custom pool') {
      const pool = join(f.root, kind === 'custom pool' ? 'custom-pool' : '.lanes');
      path = join(pool, 'x', 'remote-exec.mjs');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, success);
      if (kind === 'custom pool') f.seams.laneRoots = [pool];
      if (kind === 'symlink into lane') { rmSync(f.clientPath); symlinkSync(path, f.clientPath); path = f.clientPath; }
    }
    f.policy.settings.remote.clientPath = path;
    const importClient = vi.fn();
    expect(resolveRemoteClient({ clientPath: path, laneRoots: f.seams.laneRoots }).reason).toEqual(expect.any(String));
    expect(await f.run({ importClient })).toEqual({ handled: false });
    expect(importClient).not.toHaveBeenCalled();
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('remote client override ignored ('));
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
    expect(f.seams.log).not.toHaveBeenCalledWith(expect.stringContaining('bundled client'));
  });

  it('rejects a custom LANE_POOL_ROOT with default laneRoots before import', async () => {
    const f = fixture();
    const pool = join(f.root, 'custom-pool');
    const clientPath = join(pool, 'lane-1', 'remote-exec.mjs');
    mkdirSync(dirname(clientPath), { recursive: true });
    writeFileSync(clientPath, success);
    f.policy.settings.remote.clientPath = clientPath;
    const importClient = vi.fn();
    const remoteExec = createRemoteExec({ policy: f.policy, cwd: f.root,
      env: { LANE_POOL_ROOT: pool }, importClient, log: f.seams.log });
    expect(await remoteExec({ argv: ['npm', 'run', 'build'] })).toEqual({
      mode: 'not-started', terminated: true, reason: 'remote client override: clientPath is inside a lane pool',
    });
    expect(importClient).not.toHaveBeenCalled();
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
  });

  it.each(['export const other = true;', 'export const runRemote = true;'])('preserves exit 124 for a missing or non-callable runRemote export: %s', async (source) => {
    const f = fixture(source);
    expect(await f.run()).toEqual({ handled: true, exitCode: 124 });
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('runRemote export is not a function'));
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
    expect(f.seams.log).not.toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
  });

  it.each([
    ['named', '.LANES'], ['real', '.Lanes'],
    ['named', 'Custom-Pool'], ['real', 'Custom-Pool'],
  ])('rejects case variants of lane pools on the %s path (%s)', async (side, pool) => {
    const f = fixture();
    const lanePath = join(f.root.toUpperCase(), pool, 'lane-1', 'remote-exec.mjs');
    f.seams.laneRoots = [join(f.root, 'custom-pool')];
    const named = side === 'named' ? lanePath : f.clientPath;
    const real = side === 'real' ? lanePath : f.clientPath;
    const fs = { realpathSync: vi.fn(() => real), statSync: vi.fn(() => ({ isFile: () => true })) };
    f.policy.settings.remote.clientPath = named;
    const importClient = vi.fn();
    expect(resolveRemoteClient({ clientPath: named, laneRoots: f.seams.laneRoots, fs }))
      .toEqual({ reason: 'clientPath is inside a lane pool' });
    expect(await f.run({ fs, importClient })).toEqual({ handled: false });
    expect(importClient).not.toHaveBeenCalled();
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  it.each(['custom-pool', '.lanes'])('rejects a dot-dot named path into %s even when its symlink target is trusted', async (poolName) => {
    const f = fixture();
    const pool = join(f.root, poolName);
    const laneClient = join(pool, 'lane-1', 'remote-exec.mjs');
    mkdirSync(dirname(laneClient), { recursive: true });
    symlinkSync(f.clientPath, laneClient);
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    // Keep dot segments in the input: join() would normalize away the regression.
    const clientPath = `${outside}${sep}..${sep}.${sep}${poolName}${sep}lane-1${sep}remote-exec.mjs`;
    f.seams.laneRoots = poolName === 'custom-pool' ? [pool] : [];
    f.policy.settings.remote.clientPath = clientPath;
    const importClient = vi.fn();
    expect(resolveRemoteClient({ clientPath, laneRoots: f.seams.laneRoots }))
      .toEqual({ reason: 'clientPath is inside a lane pool' });
    expect(await f.run({ importClient })).toEqual({ handled: false });
    expect(importClient).not.toHaveBeenCalled();
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
  });

  it.each(['outside', 'custom-pool', '.lanes'])('accepts a dot-dot named path from %s that resolves outside lane pools', async (prefix) => {
    const f = fixture();
    const outside = join(f.root, prefix);
    mkdirSync(outside);
    const clientPath = `${outside}${sep}..${sep}.${sep}client${sep}remote-exec.mjs`;
    f.seams.laneRoots = [join(f.root, 'custom-pool')];
    f.policy.settings.remote.clientPath = clientPath;
    const real = resolveRemoteClient({ clientPath: f.clientPath }).clientPath;
    expect(real).toEqual(expect.any(String));
    expect(resolveRemoteClient({ clientPath, laneRoots: f.seams.laneRoots })).toEqual({ clientPath: real });
    const importClient = vi.fn(async () => ({ runRemote: async () => ({ mode: 'remote', code: 0 }) }));
    expect(await f.run({ importClient })).toEqual({ handled: true, exitCode: 0 });
    expect(importClient).toHaveBeenCalledWith(pathToFileURL(real).href);
  });

  it('keeps the lane-root directory boundary when comparing case-insensitively', () => {
    const f = fixture();
    const clientPath = join(f.root, 'CUSTOM-POOL-sibling', 'remote-exec.mjs');
    const fs = { realpathSync: () => clientPath, statSync: () => ({ isFile: () => true }) };
    expect(resolveRemoteClient({ clientPath, laneRoots: [join(f.root, 'custom-pool')], fs }))
      .toEqual({ clientPath });
  });

  it('refuses local rerun when import starts work before a missing runRemote export', async () => {
    const f = fixture(`import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./import-started', import.meta.url), 'remote work started');
      export const other = true;`);
    expect(await f.run()).toEqual({ handled: true, exitCode: 124 });
    expect(readFileSync(join(dirname(f.clientPath), 'import-started'), 'utf8')).toBe('remote work started');
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('runRemote export is not a function'));
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
    expect(f.seams.log).not.toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
    expect(f.seams.readSha).not.toHaveBeenCalled();
    expect(f.seams.appendEvent).not.toHaveBeenCalled();
  });

  it('preserves exit 124 when importing throws', async () => {
    const f = fixture("throw new Error('import-boom');");
    expect(await f.run()).toEqual({ handled: true, exitCode: 124 });
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('remote client override import failed: import-boom'));
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
    expect(f.seams.log).not.toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
  });

  it('refuses local rerun when import starts work before throwing', async () => {
    const f = fixture(`import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./import-started', import.meta.url), 'remote work started');
      throw new Error('initialization failed after starting work');`);
    expect(await f.run()).toEqual({ handled: true, exitCode: 124 });
    expect(readFileSync(join(dirname(f.clientPath), 'import-started'), 'utf8')).toBe('remote work started');
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
    expect(f.seams.log).not.toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
    expect(f.seams.readSha).not.toHaveBeenCalled();
    expect(f.seams.appendEvent).not.toHaveBeenCalled();
  });

  it('adapts forge-unreachable to local fallback after invocation', async () => {
    const f = fixture("export function runRemote() { return { mode: 'fallback', reason: 'forge-unreachable' }; }");
    expect(await f.run()).toEqual({ handled: false });
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('fallback: forge-unreachable'));
  });

  it.each(["throw new Error('invoked-boom');", "return { mode: 'fallback', reason: 'unknown' };"])('preserves exit 124 for unconfirmed invoked clients: %s', async (body) => {
    const f = fixture(`export function runRemote() { ${body} }`);
    expect(await f.run()).toEqual({ handled: true, exitCode: 124 });
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun'));
  });

  it('git and event failures never block remote execution', async () => {
    const f = fixture();
    expect(await f.run({ readSha: () => { throw new Error('no git'); }, appendEvent: async () => { throw new Error('no storage'); } }))
      .toEqual({ handled: true, exitCode: 0 });
    await vi.waitFor(() => expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('@ unknown')));
  });

  it('sanitizes and bounds a control-bearing readSha through oneLine', async () => {
    const f = fixture();
    const sha = 'ab\n\x1bc'.repeat(100);
    f.seams.readSha.mockReturnValue(sha);
    expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
    const line = f.seams.log.mock.calls.find(([value]) => value.includes(' @ '))[0];
    expect(line).toMatch(/^[\x20-\x7e]+\n$/);
    expect(line.split(' @ ')[1]).toBe(`${'ab??c'.repeat(16)}\n`);
    await vi.waitFor(() => expect(f.seams.appendEvent.mock.calls[0][0].detail.sha).toBe('ab??c'.repeat(16)));
    expect(line).not.toContain(sha);
  });

  it.each([
    ['oversized state file', JSON.stringify({ clientPath: 'old-client', sha: 'old-sha' }) + ' '.repeat(4096)],
    ['oversized UTF-8 state file', JSON.stringify({ clientPath: 'old-client', sha: 'old-sha', extra: 'é'.repeat(2048) })],
    ['control-character clientPath', JSON.stringify({ clientPath: 'old\n\x1bclient', sha: 'old-sha' })],
    ['control-character sha', JSON.stringify({ clientPath: 'old-client', sha: 'old\r\x7fsha' })],
    ['non-string clientPath', JSON.stringify({ clientPath: { raw: 'untrusted' }, sha: 'old-sha' })],
    ['non-string sha', JSON.stringify({ clientPath: 'old-client', sha: ['untrusted'] })],
    ['numeric clientPath', JSON.stringify({ clientPath: 42, sha: 'old-sha' })],
    ['null sha', JSON.stringify({ clientPath: 'old-client', sha: null })],
    ['missing fields', '{}'],
    ['null state', 'null'],
    ['malformed JSON', 'untrusted: not JSON'],
    ['truncated JSON', '{"clientPath":"old-client","sha":'],
  ])('treats %s as missing provenance and replaces it without raw event data', async (_kind, raw) => {
    const f = fixture();
    mkdirSync(dirname(f.state), { recursive: true });
    writeFileSync(f.state, raw);
    expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
    const pair = { clientPath: resolveRemoteClient({ clientPath: f.clientPath }).clientPath, sha: 'abc123' };
    await vi.waitFor(() => expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual(pair));
    expect(f.seams.appendEvent.mock.calls).toEqual([[{
      kind: 'remote-client-override', detail: { ...pair, previous: null },
    }]]);
    expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual(pair);
  });

  it('bounds previous string fields and discards all other parsed fields', async () => {
    const f = fixture();
    mkdirSync(dirname(f.state), { recursive: true });
    writeFileSync(f.state, JSON.stringify({ clientPath: 'p'.repeat(1300), sha: 's'.repeat(200), extra: '\n\x1braw' }));
    expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
    await vi.waitFor(() => expect(f.seams.appendEvent.mock.calls[0][0].detail.previous).toEqual({ clientPath: 'p'.repeat(1024), sha: 's'.repeat(80) }));
  });

  it('accepts provenance at the 4096-byte read limit', async () => {
    const f = fixture();
    const previous = { clientPath: 'old-client', sha: 'old-sha' };
    mkdirSync(dirname(f.state), { recursive: true });
    writeFileSync(f.state, JSON.stringify(previous).padEnd(4096, ' '));
    expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
    await vi.waitFor(() => expect(f.seams.appendEvent.mock.calls[0][0].detail.previous).toEqual(previous));
  });

  it.each([4096, 8192])('production provenance reader bounds a file growing to %i bytes to one 4097-byte read', async (size) => {
    const f = fixture();
    mkdirSync(dirname(f.state), { recursive: true });
    const raw = JSON.stringify({ clientPath: 'old-client', sha: 'old-sha' });
    writeFileSync(f.state, raw.padEnd(4096, ' '));
    const realOpen = provenanceIo.open;
    let handle;
    let read;
    let close;
    const open = vi.spyOn(provenanceIo, 'open').mockImplementationOnce(async (...args) => {
      handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      read = vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs) => {
        // Grow after both path and descriptor stat: the read itself must still be bounded.
        writeFileSync(f.state, raw.padEnd(size, ' '));
        return realRead(...readArgs);
      });
      close = vi.spyOn(handle, 'close');
      return handle;
    });
    try {
      expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
      await vi.waitFor(() => expect(JSON.parse(readFileSync(f.state, 'utf8')).sha).toBe('abc123'));
      expect(open.mock.calls.filter(([file]) => file === f.state)).toEqual([
        [f.state, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)],
      ]);
      expect(read).toHaveBeenCalledTimes(1);
      const [buffer, offset, length, position] = read.mock.calls[0];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.byteLength).toBeLessThanOrEqual(4097);
      expect(offset).toBe(0);
      expect(length).toBe(4097);
      expect(position).toBe(0);
      expect((await read.mock.results[0].value).bytesRead).toBe(Math.min(size, 4097));
      expect(close).toHaveBeenCalledTimes(1);
      expect(f.seams.appendEvent.mock.calls[0][0].detail.previous)
        .toEqual(size === 4096 ? { clientPath: 'old-client', sha: 'old-sha' } : null);
    } finally {
      open.mockRestore();
      if (handle) await handle.close();
    }
  });

  it('replaces oversized regular provenance without opening it for reading', async () => {
    const f = fixture();
    mkdirSync(dirname(f.state), { recursive: true });
    writeFileSync(f.state, 'x'.repeat(8192));
    const open = vi.spyOn(provenanceIo, 'open');
    try {
      expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
      await vi.waitFor(() => expect(JSON.parse(readFileSync(f.state, 'utf8')).sha).toBe('abc123'));
      expect(open).toHaveBeenCalledTimes(1);
      const [temporary, flags, mode] = open.mock.calls[0];
      expect(dirname(temporary)).toBe(dirname(f.state));
      expect(temporary).not.toBe(f.state);
      expect(flags).toBe(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      expect(mode).toBe(0o600);
      expect(f.seams.appendEvent.mock.calls[0][0].detail.previous).toBeNull();
    } finally { open.mockRestore(); }
  });

  it.each([false, true])('publishes complete sibling provenance atomically and cleans up when rename fails=%s', async (fail) => {
    const f = fixture();
    mkdirSync(dirname(f.state), { recursive: true });
    writeFileSync(f.state, '{}');
    const realRename = provenanceIo.rename;
    let publication;
    const rename = vi.spyOn(provenanceIo, 'rename').mockImplementationOnce(async (temporary, destination) => {
      publication = { temporary, destination, previous: readFileSync(f.state, 'utf8'),
        next: JSON.parse(readFileSync(temporary, 'utf8')) };
      if (fail) throw new Error('rename unavailable');
      return realRename(temporary, destination);
    });
    const realUnlink = provenanceIo.unlink;
    let cleanup;
    const unlink = vi.spyOn(provenanceIo, 'unlink').mockImplementationOnce((...args) => {
      cleanup = realUnlink(...args);
      return cleanup;
    });
    try {
      expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
      await vi.waitFor(() => expect(unlink).toHaveBeenCalledTimes(1));
      await cleanup.catch(() => {});
      expect(rename).toHaveBeenCalledTimes(1);
      expect(dirname(publication.temporary)).toBe(dirname(f.state));
      expect(publication.destination).toBe(f.state);
      expect(publication.previous).toBe('{}');
      expect(publication.next).toEqual({
        clientPath: resolveRemoteClient({ clientPath: f.clientPath }).clientPath, sha: 'abc123',
      });
      expect(readdirSync(dirname(f.state))).toEqual(['client-override.json']);
      expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual(fail ? {} : {
        clientPath: resolveRemoteClient({ clientPath: f.clientPath }).clientPath, sha: 'abc123',
      });
    } finally { rename.mockRestore(); unlink.mockRestore(); }
  });

  it.each(['directory', 'symlink', 'dangling symlink', 'FIFO'])(
    'skips all provenance IO for a %s while the client succeeds', async (kind, context) => {
      const f = fixture();
      mkdirSync(dirname(f.state), { recursive: true });
      const target = join(f.root, 'untouched.json');
      writeFileSync(target, 'untouched');
      if (kind === 'directory') mkdirSync(f.state);
      else if (kind === 'FIFO') makeFifo(f.state, context);
      else symlinkSync(kind === 'symlink' ? target : join(f.root, 'absent'), f.state);
      const before = lstatSync(f.state);
      const stat = vi.spyOn(provenanceIo, 'lstat');
      const open = vi.spyOn(provenanceIo, 'open');
      const mkdir = vi.spyOn(provenanceIo, 'mkdir');
      const rename = vi.spyOn(provenanceIo, 'rename');
      try {
        expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
        await vi.waitFor(() => expect(stat).toHaveBeenCalledWith(f.state));
        await stat.mock.results[0].value;
        expect(open).not.toHaveBeenCalled();
        expect(mkdir).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
        expect(f.seams.appendEvent).not.toHaveBeenCalled();
        expect(lstatSync(f.state).ino).toBe(before.ino);
        expect(readFileSync(target, 'utf8')).toBe('untouched');
      } finally { stat.mockRestore(); open.mockRestore(); mkdir.mockRestore(); rename.mockRestore(); }
    },
  );

  it.each(['directory', 'symlink', 'FIFO'])(
    'refuses to replace a target changed to a %s before publication and removes the temp file', async (kind, context) => {
      const f = fixture();
      mkdirSync(dirname(f.state), { recursive: true });
      writeFileSync(f.state, '{}');
      const target = join(f.root, 'untouched.json');
      writeFileSync(target, 'untouched');
      // Verify mkfifo availability before background provenance attempts the race.
      if (kind === 'FIFO') { makeFifo(f.state + '.probe', context); rmSync(f.state + '.probe'); }
      f.seams.appendEvent.mockImplementationOnce(async () => {
        rmSync(f.state);
        if (kind === 'directory') mkdirSync(f.state);
        else if (kind === 'FIFO') makeFifo(f.state, context);
        else symlinkSync(target, f.state);
      });
      const unlink = vi.spyOn(provenanceIo, 'unlink');
      const rename = vi.spyOn(provenanceIo, 'rename');
      try {
        expect(await f.run()).toEqual({ handled: true, exitCode: 0 });
        await vi.waitFor(() => expect(unlink).toHaveBeenCalledTimes(1));
        await unlink.mock.results[0].value;
        expect(rename).not.toHaveBeenCalled();
        expect(lstatSync(f.state).isFile()).toBe(false);
        expect(readFileSync(target, 'utf8')).toBe('untouched');
        expect(readdirSync(dirname(f.state))).toEqual(['client-override.json']);
      } finally { unlink.mockRestore(); rename.mockRestore(); }
    },
  );

  it('bounds the default git SHA lookup to at most one second and continues on timeout', async () => {
    const f = fixture();
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => callback(new Error('ETIMEDOUT')));
    expect(await f.run({ readSha: undefined })).toEqual({ handled: true, exitCode: 0 });
    expect(execFile).toHaveBeenCalledWith('git', ['-C', expect.any(String), 'rev-parse', 'HEAD'],
      expect.objectContaining({ timeout: expect.any(Number), maxBuffer: 4096 }), expect.any(Function));
    const { timeout } = vi.mocked(execFile).mock.calls[0][2];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1000);
    await vi.waitFor(() => expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('@ unknown')));
  });

  it('hard-kills a timed-out default git SHA lookup and records unknown without blocking remote execution', async () => {
    const f = fixture();
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT', signal: 'SIGKILL' }));
    });
    expect(await f.run({ readSha: undefined })).toEqual({ handled: true, exitCode: 0 });
    expect(execFile).toHaveBeenCalledTimes(1);
    const { clientPath } = resolveRemoteClient({ clientPath: f.clientPath });
    expect(execFile).toHaveBeenCalledWith('git', ['-C', dirname(clientPath), 'rev-parse', 'HEAD'],
      expect.objectContaining({ killSignal: 'SIGKILL', timeout: expect.any(Number), maxBuffer: 4096 }), expect.any(Function));
    const { timeout } = vi.mocked(execFile).mock.calls[0][2];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1000);
    await vi.waitFor(() => expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('@ unknown')));
    await vi.waitFor(() => expect(JSON.parse(readFileSync(f.state, 'utf8')).sha).toBe('unknown'));
    expect(f.seams.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'remote-client-override', detail: expect.objectContaining({ sha: 'unknown' }),
    }));
  });

  it.each(['readSha', 'appendEvent', 'git'])('a never-resolving %s cannot consume the remote execution deadline', async (operation) => {
    const f = fixture();
    vi.useFakeTimers();
    const stalled = vi.fn(() => new Promise(() => {}));
    if (operation === 'git') vi.mocked(execFile).mockImplementation(stalled);
    const extra = operation === 'git' ? { readSha: undefined } : { [operation]: stalled };
    const runRemote = vi.fn(async () => ({ mode: 'remote', code: 0 }));
    const provenanceFs = mockProvenanceFs();
    let result;
    const pending = runWithRemoteDecision({ argv: ['npm', 'run', 'build'], cwd: f.root, env: {},
      policy: f.policy, timeoutMs: 1000, loadPerCore: () => 0, log: f.seams.log,
      remoteExec: createRemoteExec({ ...f.seams, provenanceFs, ...extra,
        importClient: async () => ({ runRemote }) }),
    }).then((value) => { result = value; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(runRemote).toHaveBeenCalledTimes(1);
    expect(runRemote.mock.invocationCallOrder[0]).toBeLessThan(stalled.mock.invocationCallOrder[0]);
    expect(result).toEqual({ handled: true, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await pending).toEqual({ handled: true, exitCode: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a delayed SHA only in provenance and logs the resolved pair once', async () => {
    const f = fixture();
    vi.useFakeTimers();
    let resolveSha;
    const readSha = vi.fn(() => new Promise((resolve) => { resolveSha = resolve; }));
    const provenanceFs = mockProvenanceFs();
    const runRemote = vi.fn(async () => ({ mode: 'remote', code: 0 }));
    expect(await f.run({ readSha, provenanceFs, importClient: async () => ({ runRemote }) }))
      .toEqual({ handled: true, exitCode: 0 });
    expect(runRemote).toHaveBeenCalledTimes(1);
    expect(f.seams.log.mock.calls.filter(([line]) => line.includes(' @ '))).toHaveLength(0);
    resolveSha('delayed-sha');
    await vi.advanceTimersByTimeAsync(0);
    const pair = { clientPath: resolveRemoteClient({ clientPath: f.clientPath }).clientPath, sha: 'delayed-sha' };
    expect(f.seams.log.mock.calls.filter(([line]) => line.includes(' @ ')))
      .toEqual([[`heavy-admission: remote client override ${pair.clientPath} @ delayed-sha\n`]]);
    expect(f.seams.appendEvent).toHaveBeenCalledWith({ kind: 'remote-client-override', detail: { ...pair, previous: null } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['log', 'async log', 'notice'])('a throwing provenance %s cannot fail client execution', async (operation) => {
    const f = fixture();
    const extra = operation === 'notice'
      ? { notice: { get logged() { throw new Error('notice unavailable'); } } }
      : { log: () => {
        if (operation === 'async log') return Promise.reject(new Error('log unavailable'));
        throw new Error('log unavailable');
      } };
    const runRemote = vi.fn(async () => ({ mode: 'remote', code: 0 }));
    expect(await f.run({ ...extra, importClient: async () => ({ runRemote }) }))
      .toEqual({ handled: true, exitCode: 0 });
    expect(runRemote).toHaveBeenCalledTimes(1);
    expect(f.seams.appendEvent).not.toHaveBeenCalled();
  });

  it.each(['readSha', 'lstat', 'readFile', 'appendEvent', 'mkdir', 'writeFile'])(
    'a stalled provenance %s has a deadline and never prevents invocation', async (operation) => {
      const f = fixture();
      vi.useFakeTimers();
      let release;
      const stalled = vi.fn(() => new Promise((resolve) => { release = resolve; }));
      const provenanceFs = mockProvenanceFs();
      const extra = { provenanceFs };
      if (operation in provenanceFs) provenanceFs[operation] = stalled;
      else extra[operation] = stalled;
      const runRemote = vi.fn(async () => ({ mode: 'remote', code: 0 }));
      const pending = f.run({ ...extra, importClient: async () => ({ runRemote }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(stalled).toHaveBeenCalledTimes(1);
      expect(runRemote).toHaveBeenCalledTimes(1);
      expect(await pending).toEqual({ handled: true, exitCode: 0 });
      expect(runRemote.mock.invocationCallOrder[0]).toBeLessThan(stalled.mock.invocationCallOrder[0]);
      await vi.advanceTimersByTimeAsync(operation === 'readSha' ? 1000 : 100);
      expect(runRemote).toHaveBeenCalledTimes(1);
      if (operation === 'readSha') expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('@ unknown'));
      // A late storage completion must not resume the timed-out persistence chain.
      const writes = provenanceFs.writeFile.mock.calls.length;
      release('{}');
      await vi.advanceTimersByTimeAsync(0);
      expect(provenanceFs.writeFile).toHaveBeenCalledTimes(writes);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['lstat', 'readFile', 'mkdir', 'writeFile'])('provenance %s rejection never fails the gate', async (operation) => {
    const f = fixture();
    const provenanceFs = mockProvenanceFs();
    provenanceFs[operation].mockRejectedValue(new Error('storage unavailable'));
    expect(await f.run({ provenanceFs })).toEqual({ handled: true, exitCode: 0 });
    await vi.waitFor(() => expect(provenanceFs[operation]).toHaveBeenCalledTimes(1));
    if (operation === 'lstat') {
      expect(provenanceFs.readFile).not.toHaveBeenCalled();
      expect(provenanceFs.mkdir).not.toHaveBeenCalled();
      expect(provenanceFs.writeFile).not.toHaveBeenCalled();
      expect(f.seams.appendEvent).not.toHaveBeenCalled();
    }
  });

  it.each(['selected', 'unreadable', 'import failure'])('sanitizes and bounds policy and %s path logs', async (kind) => {
    const f = fixture();
    const clientPath = join(f.root, `unsafe\n\x1b\x7f${'x'.repeat(4096)}`, 'remote-exec.mjs');
    f.policy.settings.remote.clientPath = clientPath;
    const formatted = formatAdmissionPolicy(f.policy);
    const displayPath = clientPath.replace(/[^\x20-\x7e]/g, '?').slice(0, 1024);
    expect(formatted).toContain(`remote.clientPath=${displayPath} (platform)`);
    expect(formatted).toMatch(/^[\x20-\x7e\u00b7]+$/);
    expect(formatted.length).toBeLessThan(2000);
    const fs = { realpathSync: () => {
      if (kind === 'unreadable') throw new Error(`read\n\x1b failed: ${clientPath}`);
      return clientPath;
    }, statSync: () => ({ isFile: () => true }) };
    const importClient = vi.fn(async () => {
      if (kind === 'import failure') throw new Error(`import\n\x1b failed: ${clientPath}`);
      return { runRemote: async () => ({ mode: 'remote', code: 0 }) };
    });
    expect(await f.run({ fs, importClient })).toEqual(kind === 'unreadable'
      ? { handled: false } : { handled: true, exitCode: kind === 'selected' ? 0 : 124 });
    for (const [line] of f.seams.log.mock.calls) {
      expect(line).toMatch(/^[\x20-\x7e]+\n$/);
      expect(line.length).toBeLessThan(1200);
    }
    if (kind === 'selected') expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining(displayPath));
    if (kind === 'unreadable') {
      expect(importClient).not.toHaveBeenCalled();
      expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('override ignored (clientPath unreadable: read?? failed:'));
    }
  });

  it.each(['tool', 'env'])('ignores %s clientPath in a private pool without importing it', async (layer) => {
    const f = fixture();
    const env = { LANE_POOL_ROOT: join(f.root, 'private-pool'),
      ...(layer === 'env' ? { WE_HEAVY_ADMISSION_REMOTE_CLIENT_PATH: f.clientPath } : {}) };
    expect(privateAdmissionPool(env, f.root)).toBe(true);
    const policy = resolveAdmissionPolicy({
      platform: { remote: { enabled: true, mode: 'always' } },
      tool: layer === 'tool' ? { remote: { clientPath: f.clientPath } } : {},
      env, checkoutRoot: f.root,
    });
    expect(policy.settings.remote.clientPath).toBeNull();
    expect(policy.sources['remote.clientPath']).toBe('standard');
    if (layer === 'tool') expect(policy.ignored).toContainEqual(expect.stringContaining('tool.remote.clientPath='));
    const importClient = vi.fn(async () => ({ runRemote: async () => ({ mode: 'remote', code: 0 }) }));
    expect(await runWithRemoteDecision({ argv: ['npm', 'run', 'build'], cwd: f.root, env, policy,
      log: f.seams.log, remoteExec: createRemoteExec({ ...f.seams, policy, env, importClient }) }))
      .toEqual({ handled: true, exitCode: 0 });
    expect(importClient.mock.calls).toEqual([['./remote-exec.mjs']]);
    expect(f.seams.readSha).not.toHaveBeenCalled();
    expect(f.seams.appendEvent).not.toHaveBeenCalled();
  });

  describe.each(['platform', 'tool'])('%s clientPath diagnostics', (layer) => {
    it.each([
      ['null toString', { value: { toString: null } }],
      ['Symbol', { value: Symbol('clientPath') }],
      ['throwing toString getter', { value: { get toString() { throw new Error('must not coerce'); } } }],
      ['throwing toJSON getter', { value: { get toJSON() { throw new Error('must not serialize'); } } }],
      ['throwing clientPath getter', { get() { throw new Error('cannot read path'); } }],
      ['cyclic object', { value: (() => { const value = {}; value.self = value; return value; })() }],
    ])('logs a bounded placeholder for %s and preserves the previous policy', (_kind, descriptor) => {
      const f = fixture();
      const remote = Object.defineProperty({}, 'clientPath', descriptor);
      const policy = resolveAdmissionPolicy({
        platform: layer === 'tool' ? { remote: { clientPath: f.clientPath } } : { remote },
        tool: layer === 'tool' ? { remote } : {},
      });
      expect(policy.settings.remote.clientPath).toBe(layer === 'tool' ? f.clientPath : null);
      expect(policy.sources['remote.clientPath']).toBe(layer === 'tool' ? 'platform' : 'standard');
      const diagnostics = layer === 'tool' ? policy.ignored : policy.invalid;
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain(`${layer}.remote.clientPath=<unprintable>`);
      expect(diagnostics[0]).toMatch(/^[\x20-\x7e]+$/);
      expect(diagnostics[0].length).toBeLessThan(200);
      expect(formatAdmissionPolicy(policy)).toContain(diagnostics[0]);
    });
  });

  it('bounds oversized ignored tool clientPath logs and strips control characters', () => {
    const policy = resolveAdmissionPolicy({ tool: { remote: { clientPath: '\n\x1b' + 'x'.repeat(4096) } } });
    expect(policy.settings.remote.clientPath).toBeNull();
    expect(policy.ignored).toEqual([
      `tool.remote.clientPath=${'??' + 'x'.repeat(1022)} (only platform preferences may select executable client code)`,
    ]);
    expect(formatAdmissionPolicy(policy)).toMatch(/^[\x20-\x7e\u00b7]+$/);
  });

  it('resolves the leaf with provenance, ignores shared tool settings and has no env mapping', () => {
    const f = fixture();
    const policy = resolveAdmissionPolicy({ platform: { remote: { clientPath: f.clientPath } },
      tool: { remote: { clientPath: 'ignored' } }, env: { WE_HEAVY_ADMISSION_REMOTE_CLIENT_PATH: 'ignored' } });
    expect(policy.settings.remote.clientPath).toBe(f.clientPath);
    expect(policy.sources['remote.clientPath']).toBe('platform');
    expect(formatAdmissionPolicy(policy)).toContain(`remote.clientPath=${f.clientPath} (platform)`);
    expect(resolveAdmissionPolicy({ platform: { remote: { clientPath: 42 } } }).invalid).toContain('platform.remote.clientPath=42');
  });
});
