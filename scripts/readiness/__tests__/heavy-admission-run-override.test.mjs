// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemoteExec, resolveAdmissionPolicy, resolveRunClientOverride, settleClientProvenance } from '../heavy-admission.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const src = "export async function runRemote() { return { mode: 'remote', code: 0 }; }";
function make() {
  const root = mkdtempSync(join(tmpdir(), 'run-override-'));
  roots.push(root);
  const pool = join(root, 'pool');
  const laneClient = join(pool, 'web-everything', 'lane-3', 'scripts', 'readiness', 'remote-exec.mjs');
  const outside = join(root, 'elsewhere', 'scripts', 'readiness', 'remote-exec.mjs');
  const host = join(root, 'host', 'remote-exec.mjs');
  for (const f of [laneClient, outside, host]) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, src); }
  const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always', clientPath: host } } });
  const importClient = vi.fn(async () => ({ runRemote: async () => ({ mode: 'remote', code: 0 }) }));
  const appendEvent = vi.fn(async () => true);
  const log = vi.fn();
  const exec = (runOverride) => createRemoteExec({ policy, cwd: root, env: {}, lockRoot: join(root, 'a', 'heavy'),
    laneRoots: [pool], importClient, appendEvent, log, readSha: () => 'abc123', runOverride, notice: { logged: false } });
  return { root, pool, laneClient, outside, host, importClient, appendEvent, log, exec };
}

describe('per-run remote client override', () => {
  it('uses a lane-pool lane client, logs it per-run, and emits scope:run', async () => {
    const f = make();
    await f.exec(f.laneClient)({});
    await settleClientProvenance();
    expect(f.importClient).toHaveBeenCalledWith(expect.stringContaining('/pool/web-everything/lane-3/scripts/readiness/remote-exec.mjs'));
  });
  it('emits the remote-client-override event with scope run and the per-run log line', async () => {
    const f = make();
    await f.exec(f.laneClient)({});
    await settleClientProvenance();
    expect(f.log.mock.calls.flat().join('')).toMatch(/remote client override \(per-run\) .*remote-exec\.mjs @ abc123/);
    expect(f.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'remote-client-override',
      detail: expect.objectContaining({ scope: 'run', sha: 'abc123' }) }));
  });
  it('refuses a client outside the lane roots', async () => {
    const f = make();
    const r = await f.exec(f.outside)({});
    expect(f.importClient).not.toHaveBeenCalled();
    expect(r).toMatchObject({ mode: 'not-started', terminated: true });
    expect(r.reason).toMatch(/not a lane-pool lane/);
  });
  it('refuses a symlink from a lane that points outside the lanes', () => {
    const f = make();
    const link = join(f.pool, 'web-everything', 'lane-4', 'scripts', 'readiness', 'remote-exec.mjs');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(f.outside, link);
    expect(resolveRunClientOverride({ overridePath: link, laneRoots: [f.pool] }).reason).toMatch(/not a lane-pool lane/);
  });
  it('accepts the host clientPath and refuses relative paths', () => {
    const f = make();
    expect(resolveRunClientOverride({ overridePath: f.host, hostClientPath: f.host, laneRoots: [f.pool] }).clientPath).toBeTruthy();
    expect(resolveRunClientOverride({ overridePath: 'remote-exec.mjs', laneRoots: [f.pool] }).reason).toMatch(/absolute/);
  });
  it('without an override the host pref client is used and no scope field is emitted', async () => {
    const f = make();
    await f.exec(null)({});
    await settleClientProvenance();
    expect(f.importClient).toHaveBeenCalledWith(expect.stringContaining('/host/remote-exec.mjs'));
    expect(f.log.mock.calls.flat().join('')).not.toContain('per-run');
    for (const [e] of f.appendEvent.mock.calls) expect(e.detail.scope).toBeUndefined();
  });
});
