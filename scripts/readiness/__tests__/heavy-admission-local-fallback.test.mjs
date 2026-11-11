// @vitest-environment node
/** remote.localFallback=off: a heavy run that would fall back to the Mac for a Forge reason waits and retries Forge. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runWithRemoteDecision, resolveAdmissionPolicy } from '../heavy-admission.mjs';

vi.mock('../../lib/host-load.mjs', async (importOriginal) => ({
  ...await importOriginal(), hostLoadAdmission: vi.fn(() => ({ admitted: true })),
}));

const argv = ['npm', 'run', 'test:unit', '--', 'a.test.mjs'];
const remoteDefaults = { enabled: true, mode: 'always', loadPerCoreThreshold: 3, clientPath: null,
  slotUnitsByKind: { FULL: 'auto', soak: 'auto', standards: 'auto' }, elasticSlots: { enabled: true }, autoSlotUnits: 3,
  maxConcurrent: 8, backoffMs: 120000, backoffFailures: 3, maxLoadPerCore: 0.8, minFreeRamPct: 15, stuckMinSlots: 2,
  stuckAgeMs: 600000, stuckSignalEveryMs: 600000, transport: 'rsync', bundle: { mainMaxAgeMin: 10 } };
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const healthyRead = async () => ({ sampledAtET: (await import('../forge-exec-run.mjs')).easternTimestamp(Date.now()),
  cores: 8, loadPerCore: 0.1, memFreePct: 90, activeRuns: 0, recent: [] });

function fixture({ remote = {}, results = [] } = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, 'admission-lf-')); roots.push(root);
  let now = Date.now(); let i = 0;
  const notStarted = (reason, detail) => ({ mode: 'not-started', terminated: true, reason, detail });
  return {
    lockRoot: join(root, 'heavy'), readTelemetry: healthyRead, argv: [...argv], cwd: 'fixture-checkout',
    policy: resolveAdmissionPolicy({ platform: { remote: { ...remoteDefaults, ...remote } } }),
    loadPerCore: () => 4, log: vi.fn(), clock: () => now,
    sleep: vi.fn(async (ms) => { now += ms; }),
    remoteExec: vi.fn(async () => { const r = results[Math.min(i++, results.length - 1)]; return typeof r === 'function' ? r(notStarted) : r; }),
  };
}
const fail = (reason, detail) => (ns) => ns(reason, detail);

describe('remote.localFallback setting', () => {
  it('defaults to allow and accepts off', () => {
    expect(resolveAdmissionPolicy({ platform: { remote: remoteDefaults } }).settings.remote.localFallback).toBe('allow');
    expect(resolveAdmissionPolicy({ platform: { remote: { ...remoteDefaults, localFallback: 'off' } } }).settings.remote.localFallback).toBe('off');
  });
});

describe('localFallback=off', () => {
  it('waits and retries Forge instead of falling back to the Mac', async () => {
    const f = fixture({ remote: { localFallback: 'off' }, results: [fail('forge-unreachable'), fail('copy-failed'), { mode: 'remote', code: 0 }] });
    const out = await runWithRemoteDecision(f);
    expect(out).toMatchObject({ handled: true, exitCode: 0 });
    expect(f.remoteExec).toHaveBeenCalledTimes(3);
    expect(f.sleep).toHaveBeenCalledTimes(2);
    expect(f.log.mock.calls.map(c => c[0]).join('')).toMatch(/localFallback=off.*waiting.*forge-unreachable/s);
  });

  it('keeps today\'s local fallback under the default (allow)', async () => {
    const f = fixture({ results: [fail('forge-unreachable')] });
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it('fails loudly (never local) once the hard timeout passes', async () => {
    const f = fixture({ remote: { localFallback: 'off', localFallbackTimeoutMs: 60000 }, results: [fail('forge-unreachable')] });
    const out = await runWithRemoteDecision(f);
    expect(out).toEqual({ handled: true, exitCode: 124 });
    expect(f.log.mock.calls.map(c => c[0]).join('')).toMatch(/localFallback=off.*timed out.*never runs locally/is);
  });

  it('still runs locally, with a logged reason, for work impossible remotely', async () => {
    const f = fixture({ remote: { localFallback: 'off' }, results: [fail('command-not-allowed')] });
    expect(await runWithRemoteDecision(f)).toEqual({ handled: false });
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.log.mock.calls.map(c => c[0]).join('')).toMatch(/localFallback=off.*locally.*command-not-allowed/s);
  });

  it('retries a generic bundle-credential-hit finding', async () => {
    const f = fixture({ remote: { localFallback: 'off' }, results: [fail('bundle-credential-hit', 'x.bin: unsupported-text-encoding'), { mode: 'remote', code: 0 }] });
    expect(await runWithRemoteDecision(f)).toMatchObject({ handled: true, exitCode: 0 });
    expect(f.remoteExec).toHaveBeenCalledTimes(2);
  });

  it.each(['github-token', 'private-key', 'aws-access-key', 'some-new-finding'])('blocks a live-token credential hit (%s): no retry, no local run', async (finding) => {
    const f = fixture({ remote: { localFallback: 'off' }, results: [fail('bundle-credential-hit', `src/x.js: ${finding}`)] });
    const out = await runWithRemoteDecision(f);
    expect(out).toEqual({ handled: true, exitCode: 125 });
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.log.mock.calls.map(c => c[0]).join('')).toMatch(/credential.*BLOCKED/is);
  });
});
