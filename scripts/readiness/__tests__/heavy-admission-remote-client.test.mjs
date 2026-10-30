// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRemoteExec, formatAdmissionPolicy, resolveAdmissionPolicy, resolveRemoteClient, runWithRemoteDecision } from '../heavy-admission.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFileSync: vi.fn(),
}));

const roots = [];
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(execFileSync).mockReset();
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
    expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual(first);
    expect(f.seams.appendEvent).toHaveBeenCalledTimes(1);
    expect(f.seams.appendEvent).toHaveBeenCalledWith({ kind: 'remote-client-override', detail: { ...first, previous: null } });
    await f.run();
    expect(f.seams.appendEvent).toHaveBeenCalledTimes(1);
    f.seams.readSha.mockReturnValue('def456');
    await f.run();
    expect(f.seams.appendEvent).toHaveBeenCalledTimes(2);
    expect(f.seams.appendEvent.mock.calls[1][0].detail).toEqual({ ...first, sha: 'def456', previous: first });
    const other = fixture();
    f.policy.settings.remote.clientPath = other.clientPath;
    await f.run();
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
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('@ unknown'));
  });

  it('bounds the default git SHA lookup to at most one second and continues on timeout', async () => {
    const f = fixture();
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ETIMEDOUT'); });
    expect(await f.run({ readSha: undefined })).toEqual({ handled: true, exitCode: 0 });
    expect(execFileSync).toHaveBeenCalledWith('git', ['-C', expect.any(String), 'rev-parse', 'HEAD'],
      expect.objectContaining({ timeout: expect.any(Number), maxBuffer: 4096 }));
    const { timeout } = vi.mocked(execFileSync).mock.calls[0][2];
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1000);
    expect(f.seams.log).toHaveBeenCalledWith(expect.stringContaining('@ unknown'));
  });

  it.each(['readSha', 'readFile', 'appendEvent', 'mkdir', 'writeFile'])(
    'a stalled provenance %s has a deadline and never prevents invocation', async (operation) => {
      const f = fixture();
      vi.useFakeTimers();
      let release;
      const stalled = vi.fn(() => new Promise((resolve) => { release = resolve; }));
      const provenanceFs = { readFile: vi.fn(async () => '{}'), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
      const extra = { provenanceFs };
      if (operation in provenanceFs) provenanceFs[operation] = stalled;
      else extra[operation] = stalled;
      const runRemote = vi.fn(async () => ({ mode: 'remote', code: 0 }));
      const pending = f.run({ ...extra, importClient: async () => ({ runRemote }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(stalled).toHaveBeenCalledTimes(1);
      expect(runRemote).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(operation === 'readSha' ? 1000 : 100);
      expect(await pending).toEqual({ handled: true, exitCode: 0 });
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

  it.each(['readFile', 'mkdir', 'writeFile'])('provenance %s rejection never fails the gate', async (operation) => {
    const f = fixture();
    const provenanceFs = { readFile: vi.fn(async () => '{}'), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
    provenanceFs[operation].mockRejectedValue(new Error('storage unavailable'));
    expect(await f.run({ provenanceFs })).toEqual({ handled: true, exitCode: 0 });
    expect(provenanceFs[operation]).toHaveBeenCalledTimes(1);
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
