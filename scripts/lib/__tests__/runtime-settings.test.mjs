// Runtime-operator settings layer (operator 2026-10-20: hot-swap operational knobs with no rebuild).
// Precedence env > runtime > tool > platform > standard; allowlist + bounds; read fresh each call; never throws.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RUNTIME_SETTINGS_ALLOWLIST, RUNTIME_SETTINGS_ENV, planRuntimeSetting, readRuntimeFile, readRuntimeLayer,
  runtimeAuditPath, runtimeSettingsPath, writeRuntimeSettings, isLiveRuntimeFile, runtimeAuditStatus,
} from '../runtime-settings.mjs';
import { withPathLock } from '../../readiness/with-lock.mjs';
import { cascadePolicy, resetCascadeLogForTest } from '../policy-cascade.mjs';
import { resolveBatchingSettings } from '../merge-queue-adaptive-batching.mjs';
import { applyReviewCapMemoryFloor, liveReviewRoundBudget, resetReviewCapFloorForTest, resolveRedTeamSeatShare } from '../../../skills-src/conveyor/review-daemon.mjs';
import { runtimeSettingArgv, runtimeSettingOperation } from '../../operations/runtime-setting.mjs';

let dir; let path; let env;
const write = (settings) => writeFileSync(path, JSON.stringify({ settings }));
const entry = (value) => ({ value, setBy: 'chalbert', setAt: '2026-10-20T00:00:00Z', reason: 'test' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-settings-'));
  path = join(dir, 'runtime.json');
  env = { VITEST: 'true', [RUNTIME_SETTINGS_ENV]: path, WE_POLICY_CASCADE_LOG: '0' };
  resetCascadeLogForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runtime settings path', () => {
  it('is off under test unless the env names a file, and lives outside any clone otherwise', () => {
    expect(runtimeSettingsPath({ env: { VITEST: 'true' } })).toBeNull();
    // Even a reader handed a bare env never reads the host's live file while this process is under test.
    expect(runtimeSettingsPath({ env: {}, home: '/h' })).toBeNull();
    expect(runtimeSettingsPath({ env })).toBe(path);
    // An override inherited from an operator shell that names the LIVE file is refused under test.
    expect(runtimeSettingsPath({ env: { [RUNTIME_SETTINGS_ENV]: join('/h', 'workspace', '.operations', 'settings', 'runtime.json') }, home: '/h' })).toBeNull();
    // …also through a symlink (real-path identity, not spelling).
    const fakeHome = join(dir, 'home');
    mkdirSync(join(fakeHome, 'workspace', '.operations', 'settings'), { recursive: true });
    writeFileSync(join(fakeHome, 'workspace', '.operations', 'settings', 'runtime.json'), '{}');
    symlinkSync(join(fakeHome, 'workspace', '.operations', 'settings', 'runtime.json'), join(dir, 'link.json'));
    expect(isLiveRuntimeFile(join(dir, 'link.json'), { home: fakeHome })).toBe(true);
    expect(runtimeSettingsPath({ env: { [RUNTIME_SETTINGS_ENV]: join(dir, 'link.json') }, home: fakeHome })).toBeNull();
    // …and through `..` AFTER a symlink (resolve the symlink first; never normalise `..` textually). From
    // <dir>/links/deep -> <fakeHome>/a/b, `deep/../../workspace/...` is the live file; textual normalisation would
    // instead produce <dir>/workspace/... and miss it.
    mkdirSync(join(fakeHome, 'a', 'b'), { recursive: true });
    mkdirSync(join(dir, 'links'), { recursive: true });
    symlinkSync(join(fakeHome, 'a', 'b'), join(dir, 'links', 'deep'));
    const dotdot = `${join(dir, 'links', 'deep')}/../../workspace/.operations/settings/runtime.json`;
    expect(isLiveRuntimeFile(dotdot, { home: fakeHome })).toBe(true);
    expect(runtimeSettingsPath({ env: { [RUNTIME_SETTINGS_ENV]: dotdot }, home: fakeHome })).toBeNull();
    // …and through a HARD LINK (a different path to the same inode): matched by identity (dev + ino).
    linkSync(join(fakeHome, 'workspace', '.operations', 'settings', 'runtime.json'), join(dir, 'hard.json'));
    expect(isLiveRuntimeFile(join(dir, 'hard.json'), { home: fakeHome })).toBe(true);
    expect(runtimeSettingsPath({ env: { [RUNTIME_SETTINGS_ENV]: join(dir, 'hard.json') }, home: fakeHome })).toBeNull();
    // A copy (same contents, different inode) is not the live file.
    writeFileSync(join(dir, 'copy.json'), '{}');
    expect(isLiveRuntimeFile(join(dir, 'copy.json'), { home: fakeHome })).toBe(false);
    // A `..` that cannot be placed without resolving fails closed; an ordinary temp path is not the live file.
    expect(isLiveRuntimeFile(join(dir, 'nope') + '/missing/../x.json', { home: fakeHome })).toBe(true);
    expect(isLiveRuntimeFile(path, { home: fakeHome })).toBe(false);
    // …and for an explicit `path` argument naming the host's real live file (refused before any read or write).
    const live = join(homedir(), 'workspace', '.operations', 'settings', 'runtime.json');
    expect(readRuntimeFile({ path: live }).path).toBeNull();
    expect(() => writeRuntimeSettings({ path: live, next: { settings: {} }, audit: {} })).toThrow(/refusing to write the live/);
    const liveViaDotdot = `${join(homedir(), 'workspace')}/.operations/../.operations/settings/runtime.json`;
    expect(readRuntimeFile({ path: liveViaDotdot }).path).toBeNull();
    expect(() => writeRuntimeSettings({ path: liveViaDotdot, next: { settings: {} }, audit: {} })).toThrow(/refusing to write the live/);
  });
});

describe('readRuntimeLayer', () => {
  it('missing file → no layer, no warning', () => {
    expect(readRuntimeLayer('reviewConcurrency', { env })).toEqual({ block: undefined, warnings: [] });
  });
  it('malformed file → layer ignored with a warning, never throws', () => {
    writeFileSync(path, '{not json');
    const r = readRuntimeLayer('reviewConcurrency', { env });
    expect(r.block).toBeUndefined();
    expect(r.warnings[0]).toMatch(/unreadable/);
  });
  it('honours only allowlisted keys within bounds', () => {
    write({
      'reviewConcurrency.maxLiveReviewRounds': entry(13),
      'reviewConcurrency.redTeamReservedSeats': entry(2),
      'reviewConcurrency.somethingElse': entry(1),
    });
    const r = readRuntimeLayer('reviewConcurrency', { env });
    expect(r.block).toEqual({ redTeamReservedSeats: 2 });
    expect(r.warnings.join('\n')).toMatch(/maxLiveReviewRounds=13 outside integer 1\.\.12/);
    expect(r.warnings.join('\n')).toMatch(/somethingElse is not runtime-settable/);
  });
  it('reads fresh on every call (no caching across ticks)', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(8) });
    expect(readRuntimeLayer('reviewConcurrency', { env }).block).toEqual({ maxLiveReviewRounds: 8 });
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(10) });
    expect(readRuntimeLayer('reviewConcurrency', { env }).block).toEqual({ maxLiveReviewRounds: 10 });
  });
  it('never allowlists a guard or trust setting', () => {
    for (const k of Object.keys(RUNTIME_SETTINGS_ALLOWLIST)) expect(k).not.toMatch(/auth|roundCap|redTeamGate|trust|override/i);
  });
});

describe('cascade precedence: env > runtime > tool > platform > standard', () => {
  const valid = { maxLiveReviewRounds: (v) => Number.isSafeInteger(v) && v >= 1 };
  it('runtime beats tool and platform, logged as (runtime)', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(8) });
    const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 5 }, { env, platform: { maxLiveReviewRounds: 3 }, standard: { maxLiveReviewRounds: null }, valid });
    expect(r.value.maxLiveReviewRounds).toBe(8);
    expect(r.sources.maxLiveReviewRounds).toBe('runtime');
    expect(r.layered.maxLiveReviewRounds).toBe(8);
  });
  it('env beats runtime', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(8) });
    const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 5 }, { env, envValues: { maxLiveReviewRounds: 2 }, valid });
    expect(r.value.maxLiveReviewRounds).toBe(2);
    expect(r.sources.maxLiveReviewRounds).toBe('env');
  });
  it('removing the runtime value falls back to the tool layer', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(8) });
    expect(cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 5 }, { env, valid }).sources.maxLiveReviewRounds).toBe('runtime');
    write({});
    const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 5 }, { env, valid });
    expect(r.value.maxLiveReviewRounds).toBe(5);
    expect(r.sources.maxLiveReviewRounds).toBe('tool');
  });
  it('a runtime value the reader itself rejects never overrides', () => {
    write({ 'reviewConcurrency.redTeamReservedSeats': entry(3) });
    const r = cascadePolicy('reviewConcurrency', { redTeamReservedSeats: 1 }, { env, valid: { redTeamReservedSeats: (v) => v <= 2 } });
    expect(r.value.redTeamReservedSeats).toBe(1);
    expect(r.invalid.join()).toMatch(/runtime\.redTeamReservedSeats=3/);
  });
  it('runtime: null disables the layer', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(8) });
    expect(cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 5 }, { env, runtime: null, valid }).value.maxLiveReviewRounds).toBe(5);
  });
  it('a policy with no runtime keys is unchanged', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(8) });
    const r = cascadePolicy('build', { x: 1 }, { env });
    expect(r.value).toEqual({ x: 1 });
    expect(r.sources).toEqual({ x: 'tool' });
  });
});

describe('wired readers', () => {
  it('review daemon live-review cap reads the runtime value with its source', () => {
    const toolPath = join(dir, 'review-concurrency.json');
    writeFileSync(toolPath, JSON.stringify({ maxLiveReviewRounds: 5 }));
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(8) });
    const b = liveReviewRoundBudget({ env, toolPath, listCommands: () => 'node review-job.mjs\n' });
    expect(b).toMatchObject({ max: 8, live: 1, left: 7 });
    expect(b.reason).toMatch(/maxLiveReviewRounds=8 \(runtime\)/);
    write({});
    expect(liveReviewRoundBudget({ env, toolPath, listCommands: () => '' }).reason).toMatch(/maxLiveReviewRounds=5 \(tool\)/);
  });
  it('memory floor (pure): engages below floor, holds through hysteresis, releases above floor+hysteresis, never raises', () => {
    const o = { max: 10, floorMb: 3072, floorValue: 5, hysteresisMb: 1024 };
    expect(applyReviewCapMemoryFloor({ ...o, freeMb: 4000 })).toEqual({ max: 10, engaged: false, switched: false });
    expect(applyReviewCapMemoryFloor({ ...o, freeMb: 3000 })).toEqual({ max: 5, engaged: true, switched: true });
    expect(applyReviewCapMemoryFloor({ ...o, freeMb: 3500, engaged: true })).toEqual({ max: 5, engaged: true, switched: false });
    expect(applyReviewCapMemoryFloor({ ...o, freeMb: 4096, engaged: true })).toEqual({ max: 10, engaged: false, switched: true });
    expect(applyReviewCapMemoryFloor({ ...o, freeMb: null, engaged: true }).engaged).toBe(true);
    expect(applyReviewCapMemoryFloor({ ...o, freeMb: null })).toEqual({ max: 5, engaged: true, switched: true }); // fail closed
    expect(applyReviewCapMemoryFloor({ ...o, max: 3, freeMb: 100 }).max).toBe(3);
    expect(applyReviewCapMemoryFloor({ ...o, floorMb: 0, freeMb: 100, engaged: true })).toMatchObject({ max: 10, engaged: false });
  });
  it('memory floor (wired): runtime-set floor and value apply, each switch logged with values', () => {
    const toolPath = join(dir, 'review-concurrency.json');
    writeFileSync(toolPath, JSON.stringify({ maxLiveReviewRounds: 8 }));
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(10), 'reviewConcurrency.capFloorValue': entry(4) });
    resetReviewCapFloorForTest(false);
    const logs = [];
    const tick = (freeMb) => liveReviewRoundBudget({ env, toolPath, listCommands: () => '', readFreeMb: () => freeMb, log: (l) => logs.push(l) });
    expect(tick(8000)).toMatchObject({ max: 10, floorEngaged: false });
    const low = tick(2000);
    expect(low).toMatchObject({ max: 4, configured: 10, floorEngaged: true });
    expect(low.reason).toMatch(/maxLiveReviewRounds=4 \(memory floor: free RAM\+swap 2000 MB, floor 3072 MB, releases at 4096 MB; configured 10 \(runtime\)\)/);
    expect(logs.at(-1)).toMatch(/memory floor ENGAGED — free RAM\+swap 2000 MB < 3072 MB; live-review cap 10 → 4 .*capFloorValue=4 \(runtime\)/);
    expect(tick(3500).max).toBe(4);
    expect(tick(5000)).toMatchObject({ max: 10, floorEngaged: false });
    expect(logs.at(-1)).toMatch(/memory floor RELEASED — free RAM\+swap 5000 MB ≥ 4096 MB; live-review cap back to 10 \(runtime\)/);
    expect(logs).toHaveLength(2);
    write({ 'reviewConcurrency.capMemoryFloorMb': entry(70000) });
    expect(readRuntimeLayer('reviewConcurrency', { env }).block).toBeUndefined();
    resetReviewCapFloorForTest(false);
  });
  // The red-team seat share lives on the review stack (not every base has it yet); skip where it is absent.
  it.skipIf(typeof resolveRedTeamSeatShare !== 'function')('review daemon red-team seats read the runtime value', () => {
    write({ 'reviewConcurrency.redTeamReservedSeats': entry(2) });
    expect(resolveRedTeamSeatShare({ env, toolPath: join(dir, 'none.json') })).toEqual({ reserved: 2, source: 'runtime' });
  });
  it('drain batching: env > runtime > repo, invalid runtime named', () => {
    write({ 'mergeQueueBatching.maxGroupsInFlight': entry(6), 'mergeQueueBatching.groupFormMinutes': entry(99) });
    const s = resolveBatchingSettings({ env, settings: { mergeQueueBatching: { maxGroupsInFlight: 8, groupFormMinutes: 5 } }, platform: {} });
    expect(s.maxGroupsInFlight).toBe(6);
    expect(s.sources.maxGroupsInFlight).toBe('runtime');
    expect(s.groupFormMinutes).toBe(5);
    expect(s.invalid.join()).toMatch(/runtime: .*groupFormMinutes=99/);
    const e = resolveBatchingSettings({ env: { ...env, WE_MQ_BATCHING_MAX_GROUPS_IN_FLIGHT: '2' }, settings: { mergeQueueBatching: {} }, platform: {} });
    expect(e.maxGroupsInFlight).toBe(2);
    expect(e.sources.maxGroupsInFlight).toBe('env');
  });
});

describe('planRuntimeSetting + atomic write', () => {
  const base = { path: '/x/runtime.json', entries: {}, actor: 'chalbert', reason: 'r', now: '2026-10-20T00:00:00Z' };
  it('refuses unknown keys, out-of-bounds values, and missing actor/reason', () => {
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'github.auth', value: '1' }).error).toMatch(/not runtime-settable/);
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '13' }).error).toMatch(/outside/);
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '8', actor: '' }).error).toMatch(/actor/);
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '8', reason: '' }).error).toMatch(/reason/);
    expect(planRuntimeSetting({ ...base, action: 'unset', key: 'reviewConcurrency.maxLiveReviewRounds' }).error).toMatch(/no runtime value/);
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'constructor', value: '1' }).error).toMatch(/not runtime-settable/);
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'reviewConcurrency.capMemoryHysteresisMb', value: '0' }).error).toMatch(/outside/);
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '8', reason: 'x'.repeat(501) }).error).toMatch(/reason is longer/);
    expect(planRuntimeSetting({ ...base, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '8', actor: 'a'.repeat(65) }).error).toMatch(/actor is longer/);
  });
  it('a concurrent change since the read is refused, never lost', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(2) });
    const stale = planRuntimeSetting({ ...base, path, action: 'set', key: 'mergeQueueBatching.maxGroupsInFlight', value: '4', entries: {} });
    expect(() => writeRuntimeSettings(stale)).toThrow(/changed since/);
    expect(readRuntimeFile({ env }).entries['reviewConcurrency.maxLiveReviewRounds'].value).toBe(2);
  });
  it('an injected runtime block gets the same allowlist + bounds', () => {
    const r = cascadePolicy('reviewConcurrency', { maxLiveReviewRounds: 5 }, { env, runtime: { maxLiveReviewRounds: 50, bogus: 1 } });
    expect(r.value.maxLiveReviewRounds).toBe(5);
    expect(r.sources.maxLiveReviewRounds).toBe('tool');
  });
  it('set → write → audit line; unset removes it', () => {
    const p = planRuntimeSetting({ ...base, path, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '8' });
    expect(p.ok).toBe(true);
    writeRuntimeSettings(p);
    expect(readRuntimeFile({ env }).entries['reviewConcurrency.maxLiveReviewRounds'].value).toBe(8);
    const u = planRuntimeSetting({ ...base, path, action: 'unset', key: 'reviewConcurrency.maxLiveReviewRounds', entries: readRuntimeFile({ env }).entries });
    writeRuntimeSettings(u);
    expect(readRuntimeFile({ env }).entries).toEqual({});
    const audit = readFileSync(runtimeAuditPath(path), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.filter((a) => a.outcome === 'intent').map((a) => [a.action, a.before, a.after, a.actor])).toEqual([['set', null, 8, 'chalbert'], ['unset', 8, null, 'chalbert']]);
    expect(audit.map((a) => a.outcome)).toEqual(['intent', 'applied', 'intent', 'applied']);
    expect(audit[1].id).toBe(audit[0].id);
  });
  it('uses the repo file lock: a write while the lock is held times out and changes nothing', () => {
    writeRuntimeSettings(planRuntimeSetting({ ...base, path, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '6' }));
    const p = planRuntimeSetting({ ...base, path, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '7', entries: readRuntimeFile({ env }).entries });
    withPathLock(path, () => { expect(() => writeRuntimeSettings(p, { env })).toThrow(/timed out/); });
    expect(readRuntimeFile({ env }).entries['reviewConcurrency.maxLiveReviewRounds'].value).toBe(6);
    writeRuntimeSettings(p, { env });
    expect(readRuntimeFile({ env }).entries['reviewConcurrency.maxLiveReviewRounds'].value).toBe(7);
  }, 20_000);
  it('get surfaces an unconfirmed or failed last change', () => {
    const rec = [{ key: 'k', id: 'a', outcome: 'intent', at: 't', actor: 'x' }];
    expect(runtimeAuditStatus(rec, 'k').status).toBe('unconfirmed');
    expect(runtimeAuditStatus([...rec, { id: 'a', outcome: 'failed', error: 'boom' }], 'k')).toMatchObject({ status: 'failed', error: 'boom' });
    expect(runtimeAuditStatus([...rec, { id: 'a', outcome: 'applied', warnings: ['directory fsync failed'] }], 'k')).toMatchObject({ status: 'applied', warnings: ['directory fsync failed'] });
    expect(runtimeAuditStatus([], 'k').status).toBe('none');
    const g = planRuntimeSetting({ action: 'get', key: 'reviewConcurrency.maxLiveReviewRounds', path, entries: {}, auditTail: [{ key: 'reviewConcurrency.maxLiveReviewRounds', id: 'z', outcome: 'intent' }] });
    expect(g.audit.status).toBe('unconfirmed');
  });
  it('a failed apply leaves an intent + failed audit pair and the old file', () => {
    write({ 'reviewConcurrency.maxLiveReviewRounds': entry(4) });
    const p = planRuntimeSetting({ ...base, path, action: 'set', key: 'reviewConcurrency.maxLiveReviewRounds', value: '6', entries: readRuntimeFile({ env }).entries });
    // Make the target a directory so the rename fails.
    rmSync(path); mkdirSync(path);
    expect(() => writeRuntimeSettings({ ...p, expected: undefined })).toThrow();
    const audit = readFileSync(runtimeAuditPath(path), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.map((a) => a.outcome)).toEqual(['intent', 'failed']);
  });
});

describe('runtime-setting operation', () => {
  it('positional sugar maps to flags', () => {
    expect(runtimeSettingArgv(['set', 'k', '8', '--actor=a', '--reason=r'])).toEqual(['--action=set', '--key=k', '--value=8', '--actor=a', '--reason=r']);
    expect(runtimeSettingArgv(['list', '--json'])).toEqual(['--action=list', '--json']);
    expect(runtimeSettingArgv(['--action=get', '--key=k'])).toEqual(['--action=get', '--key=k']);
  });
  it('declares', () => {
    expect(runtimeSettingOperation({ readRuntime: () => ({ path, entries: {}, warnings: [] }) }).name).toBe('runtime-setting');
  });
});
