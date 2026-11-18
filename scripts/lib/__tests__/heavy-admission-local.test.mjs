// @vitest-environment node
/** `heavy-admission.mjs run --local`: run on this machine while still holding a LOCAL admission slot. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { main, heldSlots, tryAcquireSlot, shellQuoteWord, ADMISSION_DEFERRED_EXIT } from '../../readiness/heavy-admission.mjs';

vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal(), execSync: vi.fn() }));
vi.mock('../host-load.mjs', async (importOriginal) => ({ ...await importOriginal(), hostLoadAdmission: vi.fn(() => ({ admitted: true })) }));

const argv = ['npm', 'run', 'test:unit', '--', 'a.test.mjs'];
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const healthy = async () => ({ sampledAtET: (await import('../../readiness/forge-exec-run.mjs')).easternTimestamp(Date.now()), cores: 8, loadPerCore: 0.1, memFreePct: 90, activeRuns: 0, recent: [] });

function setup(extraEnv = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, 'admission-local-')); roots.push(root);
  const pool = join(root, 'pool'); mkdirSync(pool);
  const prefs = join(root, 'preferences.json');
  writeFileSync(prefs, JSON.stringify({ heavyAdmission: { remote: { enabled: true, mode: 'always' }, fastScale: { maxSlots: 1 } } }));
  const exited = new Error('test exit');
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exited; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const [k, v] of Object.entries({ LANE_POOL_ROOT: pool, WE_PLATFORM_PREFERENCES: prefs, CI: '', WE_HEAVY_ADMISSION: 'on',
    WE_HEAVY_ADMISSION_HELD: '', WE_FORGE_GATE_DISPATCH: '', WE_HEAVY_ADMISSION_CONTAINER: '', WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES: '',
    WE_HEAVY_ADMISSION_RUN_WAIT_MS: '0', WE_VERIFY_REMOTE_REPORT: join(root, 'verify.jsonl'), ...extraEnv })) vi.stubEnv(k, v);
  return { root, lockRoot: join(pool, '.admission', 'heavy'), exited, exit, stderr, remoteExec: vi.fn(async () => ({ mode: 'remote', code: 23, run: 'run-123456' })) };
}
const teardown = (s) => { vi.mocked(execSync).mockReset(); s.exit.mockRestore(); s.stderr.mockRestore(); vi.unstubAllEnvs(); };

describe('heavy-admission run --local', () => {
  it('runs locally while holding a local slot, logs its provenance, and never dispatches remotely', async () => {
    const s = setup(); let heldRow;
    vi.mocked(execSync).mockImplementation(() => {
      heldRow = heldSlots({ lockRoot: s.lockRoot, cap: 2, fastSlots: 1 });
      throw Object.assign(new Error('local exit'), { status: 17 });
    });
    try {
      await expect(main(['run', `--repo=${s.root}`, '--local', '--', ...argv], { remoteExec: s.remoteExec, readTelemetry: healthy })).rejects.toBe(s.exited);
      expect(s.remoteExec).not.toHaveBeenCalled();
      expect(execSync).toHaveBeenCalledWith(argv.map(shellQuoteWord).join(' '), expect.objectContaining({ cwd: s.root }));
      expect(heldRow).toHaveLength(1);
      expect(heldRow[0].meta.location).toBe('local');
      expect(s.stderr).toHaveBeenCalledWith(expect.stringContaining('location=local reason=--local'));
      expect(s.exit).toHaveBeenCalledWith(17);
      expect(heldSlots({ lockRoot: s.lockRoot, cap: 2, fastSlots: 1 })).toHaveLength(0);
    } finally { teardown(s); }
  });

  it('waits for a slot when the pool is full (never skips admission or the cap)', async () => {
    const s = setup();
    const now = Date.now();
    for (let i = 0; i < 3; i++) tryAcquireSlot({ lockRoot: s.lockRoot, cap: 2, owner: `other-${i}`, nowMs: now, nowIso: new Date(now).toISOString(), pid: process.pid, slots: [0, 1, 2] });
    expect(heldSlots({ lockRoot: s.lockRoot, cap: 2, fastSlots: 1 })).toHaveLength(3);
    try {
      await expect(main(['run', `--repo=${s.root}`, '--local', '--wait-ms=300', '--', ...argv], { remoteExec: s.remoteExec, readTelemetry: healthy })).rejects.toBe(s.exited);
      expect(execSync).not.toHaveBeenCalled();
      expect(s.remoteExec).not.toHaveBeenCalled();
      expect(s.exit).toHaveBeenCalledWith(ADMISSION_DEFERRED_EXIT);
    } finally { teardown(s); }
  });

  it('without --local behaviour is unchanged: remote dispatch still happens, and no env default turns local on', async () => {
    const s = setup({ WE_HEAVY_ADMISSION_LOCAL: '1', WE_HEAVY_LOCAL: '1' });
    try {
      await expect(main(['run', `--repo=${s.root}`, '--', ...argv], { remoteExec: s.remoteExec, readTelemetry: healthy })).rejects.toBe(s.exited);
      expect(s.remoteExec).toHaveBeenCalledTimes(1);
      expect(execSync).not.toHaveBeenCalled();
      expect(s.exit).toHaveBeenCalledWith(23);
    } finally { teardown(s); }
  });
});
