/** Exercise the actual tick gate with host IO fenced, so each excluded flag is tested independently. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../health-watch.mjs';
import { probeAndOwnMainCi } from '../main-ci-red-io.mjs';
import { runMainRedAlert } from '../health-watch-main-red.mjs';

const io = vi.hoisted(() => ({ active: false, files: new Map() }));
vi.mock('node:fs', async original => {
  const real = await original();
  const missing = () => { throw Object.assign(new Error('isolated tick: absent file'), { code: 'ENOENT' }); };
  const fake = {
    readFileSync: path => io.files.has(String(path)) ? io.files.get(String(path)) : missing(),
    readdirSync: () => [], existsSync: path => io.files.has(String(path)),
    statSync: missing, lstatSync: missing, openSync: missing,
    mkdirSync: () => {}, appendFileSync: () => {},
    writeFileSync: (path, value) => { io.files.set(String(path), value); },
    renameSync: (from, to) => { io.files.set(String(to), io.files.get(String(from))); io.files.delete(String(from)); },
    unlinkSync: path => { io.files.delete(String(path)); },
  };
  const wrapped = Object.fromEntries(Object.entries(fake).map(([name, fn]) =>
    [name, (...args) => io.active ? fn(...args) : real[name](...args)]));
  return { ...real, ...wrapped, default: { ...real.default, ...wrapped } };
});
vi.mock('node:child_process', async original => {
  const real = await original();
  const isolated = () => { throw new Error('isolated tick: no host subprocesses'); };
  const wrapped = Object.fromEntries(['execFileSync', 'execSync', 'spawn', 'spawnSync', 'execFile', 'exec', 'fork']
    .map(name => [name, (...args) => io.active ? isolated() : real[name](...args)]));
  return { ...real, ...wrapped, default: { ...real.default, ...wrapped } };
});
vi.mock('../main-ci-red-io.mjs', () => ({ probeAndOwnMainCi: vi.fn() }));
vi.mock('../health-watch-main-red.mjs', () => ({ runMainRedAlert: vi.fn() }));
vi.mock('../health-watch-section.mjs', async original => ({
  ...await original(), healthDir: () => '/isolated-health',
}));
vi.mock('../needs-you-feed-job.mjs', () => ({ superviseNeedsYouFeed: vi.fn() }));
vi.mock('../../operations/card-batch-seal-io.mjs', () => ({ sealDueBatches: vi.fn() }));
vi.mock('../pr-sweep-job.mjs', async original => ({ ...await original(), prSweepTickAllowed: () => false }));
vi.mock('../nightly-coroner-job.mjs', async original => ({ ...await original(), nightlyCoronerTickAllowed: () => false }));
vi.mock('../health-watch-job.mjs', async original => ({
  ...await original(), resolveHealthJobSwitches: () => ({ ghProbes: false }),
}));
vi.mock('../review-tmp-health.mjs', () => ({ sweepReviewTmp: vi.fn(), probeDiskSpace: vi.fn() }));
vi.mock('../../lib/quiet-hours-io.mjs', async original => ({ ...await original(), flushDigest: vi.fn() }));
vi.mock('../../lib/ledger-readiness-daily.mjs', async original => ({ ...await original(), runDailyReadinessCheck: vi.fn() }));

const NOW = '2026-10-27T12:00:00.000Z';
const probe = { runs: [{ headSha: 'a'.repeat(40), status: 'completed', conclusion: 'success' }], tip: null };
const baseFlags = { now: NOW, 'no-diagnose': true, 'no-investigate': true, 'no-file': true, 'no-notify': true };
const deps = { smells: [], collectGh: () => ({ probes: {}, errors: {} }), collectInventory: () => ({}) };

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.files.set('/isolated-health/config.json', JSON.stringify({
    tmpSweepEnabled: false, claudeJobsArchiveEnabled: false,
  }));
  probeAndOwnMainCi.mockResolvedValue(probe);
  io.active = true;
});
afterEach(() => { io.active = false; });

describe('tick — main-red alert publication gate', () => {
  it.each([
    ['dry-run', true], ['no-gh', true],
    ['logs-dir', '/isolated-logs'], ['state-root', '/isolated-state'], ['lock-root', '/isolated-locks'],
    ['main-ci-runs-fixture', '/isolated-runs.json'], ['ps-fixture', '/isolated-ps.txt'],
    ['machine-load-fixture', '/isolated-load.json'], ['future-fixture', '/isolated-future.json'],
  ])('skips the side-effecting runner for --%s alone', async (flag, value) => {
    const summary = await tick({ ...baseFlags, [flag]: value }, deps);
    expect(summary.now).toBe(NOW); // The real tick reached its return, rather than failing before the gate.
    expect(runMainRedAlert).not.toHaveBeenCalled();
  });

  it('calls the runner once with the awaited main-CI probe on a live tick', async () => {
    let resolved = false;
    probeAndOwnMainCi.mockImplementationOnce(async () => {
      await Promise.resolve();
      expect(runMainRedAlert).not.toHaveBeenCalled();
      resolved = true;
      return probe;
    });
    runMainRedAlert.mockImplementationOnce(async args => {
      expect(resolved).toBe(true);
      expect(args.probe).toBe(probe);
    });
    const summary = await tick(baseFlags, deps);
    expect(summary.probeErrors.mainCiRuns).toBeUndefined();
    expect(summary.probeErrors.mainRedAlert).toBeUndefined();
    expect(probeAndOwnMainCi).toHaveBeenCalledTimes(1);
    expect(runMainRedAlert).toHaveBeenCalledTimes(1);
    expect(runMainRedAlert).toHaveBeenCalledWith({
      probe, dir: '/isolated-health', now: Date.parse(NOW), config: expect.any(Object),
    });
  });
});
