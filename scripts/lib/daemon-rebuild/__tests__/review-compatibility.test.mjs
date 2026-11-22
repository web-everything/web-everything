/** PR 7196: tick compatibility, unattended lease deferral and setting overrides. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { createJobStore, enqueueJob } from '../../daemon-jobs-runtime.mjs';
import { markSucceeded } from '../../daemon-jobs.mjs';
import { rebuildCloneAsJob, REBUILD_JOB_KIND, RESULT_SUFFIX } from '../rebuild-job.mjs';
import { claimBuildLease, releaseBuildLease } from '../lease.mjs';
import { strictRebuildEvidence } from '../evidence-context.mjs';
import { resolveEarlyLaunch } from '../../daemon-rebuild-early-watch.mjs';
import { resolveRecovery } from '../recovery.mjs';
import { writeRebuildState } from '../state.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rebuild-review-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const quiet = { error() {} };

it.each(['job', 'consumed', 'result'].flatMap(fault => [undefined, '0', '1'].flatMap(setting =>
  ['tick-start', 'early', 'recovery'].flatMap(launchedBy => ['adopt', 'build'].map(action => [fault, setting, launchedBy, action])))))(
  '%s evidence, strict=%s, %s %s: compatibility ticks progress; unattended and opted-in ticks refuse',
  async (fault, setting, launchedBy, action) => {
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'),
      ...(setting === undefined ? {} : { WE_DAEMON_REBUILD_STRICT_EVIDENCE: setting }) };
    const store = createJobStore(join(root, 'jobs'));
    mkdirSync(store.dir);
    const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: 1000 });
    store.update(old.id, r => markSucceeded(r, { at: new Date(1000).toISOString() }));
    const file = join(store.dir, fault === 'job' ? `${old.id}.json` : fault === 'result' ? `${old.id}${RESULT_SUFFIX}` : 'consumed.json');
    writeFileSync(file, '{torn');
    const adopt = vi.fn(async () => action === 'adopt' ? { moved: true, adopted: true } : { moved: false, reason: 'needs-build' });
    const reattach = vi.fn();
    const result = await rebuildCloneAsJob({ root, env, store, launchedBy, launchOnly: launchedBy !== 'tick-start',
      adopt, reattach, evict() {}, now: () => 2000, log: quiet, codeSha: 'a'.repeat(40),
      settings: { minIntervalMs: 0, minIntervalJitterPct: 0 } });
    const strict = launchedBy !== 'tick-start' || setting === '1';
    if (strict) {
      expect(result.reason).toBe('state-unreadable');
      expect(adopt).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe('{torn');
    } else {
      if (action === 'adopt') expect(result.adopted).toBe(true);
      else expect(result.reason).toBe('rebuild-job-started');
      expect(adopt).toHaveBeenCalledOnce();
    }
    expect(reattach).toHaveBeenCalledTimes(!strict && action === 'build' ? 1 : 0);
  });

it.each([undefined, '0', '1', 'invalid'])('ordinary strict rollout is opt-in (%s), unattended remains strict', value => {
  const env = value === undefined ? {} : { WE_DAEMON_REBUILD_STRICT_EVIDENCE: value };
  expect(strictRebuildEvidence(env)).toBe(value === '1');
  for (const source of ['early', 'recovery', 'unknown']) expect(strictRebuildEvidence(env, source)).toBe(true);
});

it.each(['early', 'recovery'])('%s abandoned lease stays recorded until tick-start removes the worktree', () => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  const path = join(root, 'abandoned'); mkdirSync(path);
  writeFileSync(join(path, 'evidence'), 'old candidate');
  const building = { token: 'dead', pid: process.pid, host: hostname(), startedAt: new Date(0).toISOString(), path };
  const state = { building };
  const run = vi.fn(() => ({ status: 0, stdout: '' }));
  const options = { state, root, env, run, plan: { finalSha: 'new', inputsKey: 'new' }, nowMs: 1000 };
  expect(claimBuildLease({ ...options, cleanupAbandoned: false })).toBeNull();
  expect(state.building).toEqual(building);
  expect(existsSync(path)).toBe(true);
  const lease = claimBuildLease(options);
  expect(lease).not.toBeNull();
  expect(existsSync(path)).toBe(false);
  expect(run.mock.calls.some(([args]) => args.includes('worktree') && args.includes('remove') && args.includes(path))).toBe(true);
  releaseBuildLease(state, lease);
});

it.each([
  [undefined, false, false], [undefined, true, true], ['0', true, false], ['0', false, false],
  ['1', false, true], ['1', true, true], ['invalid', true, true], ['invalid', false, false], ['', true, true],
])('early enablement env %s over tool=%s falls through when invalid', (value, toolEnabled, enabled) => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'missing'),
      ...(value === undefined ? {} : { WE_DAEMON_REBUILD_EARLY_LAUNCH: value }) };
    expect(resolveEarlyLaunch({ env, tool: { enabled: toolEnabled }, log() {} }).enabled).toBe(enabled);
  });

it.each([[undefined, 123], ['42', 42], ['0', 0], ['-1', 123], ['Infinity', 123], ['NaN', 123], ['bad', 123]])(
  'early debounce env %s validates and falls through', (value, debounceMs) => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'missing'),
      ...(value === undefined ? {} : { WE_DAEMON_REBUILD_EARLY_DEBOUNCE_MS: value }) };
    expect(resolveEarlyLaunch({ env, tool: { debounceMs: 123 }, log() {} }).debounceMs).toBe(debounceMs);
  });

it.each(['ENV_TIMEOUT_BASE_MS', 'ENV_TIMEOUT_MAX_MS', 'OVERLAY_OVERDUE_MS'].flatMap(name =>
  [undefined, '42', '0', '-1', 'Infinity', 'bad', '1.5'].map(value => [name, value])))(
  'recovery %s env %s validates and falls through', (name, value) => {
    const key = { ENV_TIMEOUT_BASE_MS: 'envTimeoutBaseMs', ENV_TIMEOUT_MAX_MS: 'envTimeoutMaxMs', OVERLAY_OVERDUE_MS: 'overlayOverdueMs' }[name];
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'missing'),
      ...(value === undefined ? {} : { [`WE_DAEMON_RECOVERY_${name}`]: value }) };
    expect(resolveRecovery({ env, tool: { [key]: 123 }, log() {} })[key]).toBe(value === '42' ? 42 : 123);
  });

it('recovery spacing includes nonzero jitter at the exact retry boundary', async () => {
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  writeRebuildState(root, { held: { reason: 'smoke-env-timeout', retryAt: new Date(0).toISOString() } }, env);
  const store = createJobStore(join(root, 'jobs'));
  mkdirSync(store.dir);
  const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: 1000 });
  store.update(old.id, r => markSucceeded(r, { at: new Date(1000).toISOString() }));
  writeFileSync(join(store.dir, old.id + RESULT_SUFFIX), JSON.stringify({ reason: 'ready-recorded', readyRecorded: true }));
  const options = { root, env, store, codeSha: 'a'.repeat(40), log: quiet, reattach: async () => {}, evict() {},
    adopt: async () => ({ moved: false, reason: 'up-to-date' }),
    settings: { minIntervalMs: 1000, minIntervalJitterPct: 20 }, rng: () => 1 };
  expect(await rebuildCloneAsJob({ ...options, now: () => 2199 })).toMatchObject({ reason: 'rebuild-job-spaced', retryInMs: 1 });
  expect(store.list().records).toHaveLength(1);
  expect(await rebuildCloneAsJob({ ...options, now: () => 2200 })).toMatchObject({ reason: 'rebuild-job-started' });
  expect(store.list().records).toHaveLength(2);
});
