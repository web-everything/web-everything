// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDrainFreeze, resolveDrainFreezeSettings, drainFreezeSignal } from '../red-main-freeze-shared.mjs';
import { decideRedMainHold } from '../red-main-hold.mjs';
import { resolveFreezeLastGoodPath } from '../freeze-last-good.mjs';
import { buildSkipReasons } from '../drain-skip-reasons.mjs';
import { DrainReadError } from '../drain-api-reads.mjs';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, renameSync: vi.fn(fs.renameSync), rmSync: vi.fn(fs.rmSync) };
});

const clear = { frozen: false, source: 'ops/freeze:freeze.json' };
const transient = { error: 'drain-read-transient', transient: true, source: clear.source };
let dir, file, clock, logs, readShared, sleep;
const settings = values => resolveDrainFreezeSettings({ env: {}, tool: values ?? {}, platform: {} });
const pass = (overrides = {}) => prepareDrainFreeze({ settings: settings(), readShared, sleep, lastGoodFile: file,
  nowMs: () => clock, stderr: s => logs.push(s), ...overrides });
const hold = (state, isLocal = true, holdOn = true) => decideRedMainHold({ num: 7, isLocal,
  signal: drainFreezeSignal({ state, now: clock, holdOn, priority: { repo: 'we', pr: 7, expiresAt: clock + 1000 } }) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freeze-last-good-')); file = join(dir, 'last-good.json');
  clock = 1_000_000; logs = []; readShared = vi.fn(() => transient); sleep = vi.fn(async () => {});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
async function seed(result = clear) { await pass({ readShared: () => result }); }

describe('bounded freeze reads', () => {
  it('retry succeeds on second try: no hold and fetch time is persisted atomically', async () => {
    readShared.mockReturnValueOnce(transient).mockReturnValueOnce(clear);
    expect(hold(await pass()).hold).toBe(false);
    expect(readShared).toHaveBeenCalledTimes(2); expect(sleep.mock.calls).toEqual([[500]]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ result: clear, fetchedAt: clock });
    expect(readdirSync(dir)).toEqual(['last-good.json']);
  });
  it('two retries then fresh last-good from a previous pass: no hold, reuse logged, age not extended', async () => {
    await seed(); clock += 30_000;
    const state = await pass();
    expect(hold(state).hold).toBe(false); expect(readShared).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1500]]);
    expect(logs.join('')).toContain('freeze read transient, reusing last good read 30s old');
    expect(JSON.parse(readFileSync(file, 'utf8')).fetchedAt).toBe(clock - 30_000);
    expect(logs.join('')).toContain('freezeReadLastGoodTtlMin setting 10 via default');
  });
  it.each([600_000, 600_001])('never merges at or beyond TTL (%i ms), even with fresh mtime', async age => {
    await seed(); clock += age; utimesSync(file, new Date(clock), new Date(clock));
    const decision = hold(await pass());
    expect(decision.hold).toBe(true); expect(decision.reason).toContain('freeze unreadable');
    expect(decision.reason).not.toContain('red-main'); expect(logs.join('')).not.toContain('reusing');
  });
  it('unknown without last-good holds every repo and the fix, even with hold off; uses pass-level kind', async () => {
    const state = await pass();
    for (const local of [true, false]) for (const holdOn of [true, false]) expect(hold(state, local, holdOn).hold).toBe(true);
    expect(readShared).toHaveBeenCalledTimes(3);
    expect(buildSkipReasons({ verdicts: [{ num: 7, decision: 'skip', reason: hold(state).reason }] })[0].kind).toBe('red-main-hold');
  });
  it('last-good frozen:true still holds after a transient failure', async () => {
    await seed({ ...clear, frozen: true }); clock += 1000;
    const state = await pass(); expect(state.shared.frozen).toBe(true);
    expect(hold(state).hold).toBe(true); expect(hold(state, false).hold).toBe(true);
  });
  it('real frozen:true always holds and replaces a cached clear', async () => {
    await seed(); readShared.mockReturnValue({ ...clear, frozen: true });
    expect(hold(await pass()).hold).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).result.frozen).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
  it.each([false, true])('failed frozen:true cache replacement never reuses an older clear (removal fails: %s)', async removalFails => {
    await seed(); clock += 1000;
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('cache replacement failed'); });
    if (removalFails) vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error('cache removal failed'); });
    expect(hold(await pass({ readShared: () => ({ ...clear, frozen: true }) })).hold).toBe(true);
    if (removalFails) expect(JSON.parse(readFileSync(file, 'utf8')).result.frozen).toBe(false);
    else expect(readdirSync(dir)).toEqual([]);
    clock += 1000;
    const state = await pass();
    for (const local of [true, false]) for (const holdOn of [true, false]) expect(hold(state, local, holdOn).hold).toBe(true);
    expect(logs.join('')).not.toContain('reusing');
    // Only new successfully persisted evidence restores fallback eligibility.
    await seed();
    expect(hold(await pass()).hold).toBe(false);
  });
  it('permanent error never retries or reuses a fresh clear', async () => {
    await seed(); readShared.mockReturnValue({ error: 'forbidden' });
    expect(hold(await pass()).hold).toBe(true);
    expect(readShared).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    expect(logs.join('')).not.toContain('reusing');
  });
  it('TTL zero disables reuse', async () => {
    await seed(); expect(hold(await pass({ settings: settings({ freezeReadLastGoodTtlMin: 0 }) })).hold).toBe(true);
  });
  it.each(['corrupt', 'future', 'invalid-result', 'wrong-source', 'missing-time'])('%s cache means no cache and a hold', async kind => {
    const record = { result: clear, fetchedAt: clock };
    if (kind === 'future') record.fetchedAt++;
    if (kind === 'invalid-result') record.result = { frozen: false, error: 'failed' };
    if (kind === 'wrong-source') record.result = { ...clear, source: 'other' };
    if (kind === 'missing-time') delete record.fetchedAt;
    writeFileSync(file, kind === 'corrupt' ? '{bad' : JSON.stringify(record));
    expect(hold(await pass()).hold).toBe(true);
  });
  it('unreadable cache means no cache and a hold', async () => {
    expect(hold(await pass({ lastGoodFile: dir })).hold).toBe(true);
  });
  it('bounds injected backoffs and retries across a publication re-read', async () => {
    const publish = vi.fn(async () => ({}));
    expect(hold(await pass({ local: { reason: 'manual' }, publish, backoffMs: [Infinity, 1e9] })).hold).toBe(true);
    expect(readShared).toHaveBeenCalledTimes(4); // initial + two retries + mandatory post-publication read
    expect(sleep.mock.calls).toEqual([[500], [1500]]); expect(publish).toHaveBeenCalledTimes(1);
  });
  it('accepts injected short backoffs', async () => {
    await pass({ backoffMs: [1, 2] }); expect(sleep.mock.calls).toEqual([[1], [2]]);
  });
  it('thrown transient DrainReadError retries; thrown permanent error holds immediately', async () => {
    readShared.mockImplementationOnce(() => { throw new DrainReadError('freeze-read', 'drain-read-transient', 'down'); }).mockReturnValue(clear);
    expect(hold(await pass()).hold).toBe(false); expect(readShared).toHaveBeenCalledTimes(2);
    readShared.mockReset().mockImplementation(() => { throw new Error('permanent'); }); sleep.mockClear();
    expect(hold(await pass()).hold).toBe(true); expect(readShared).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });
});

describe('TTL setting and portable paths', () => {
  const key = 'freezeReadLastGoodTtlMin', envKey = 'WE_DRAIN_RED_MAIN_FREEZE_LAST_GOOD_TTL_MIN';
  const resolve = o => resolveDrainFreezeSettings({ env: {}, tool: {}, platform: {}, ...o })[key];
  it('resolves standard, platform, tool and env with provenance', () => {
    expect(resolve({})).toEqual({ value: 10, source: 'default' });
    expect(resolve({ platform: { [key]: 3 } })).toEqual({ value: 3, source: 'platform' });
    expect(resolve({ platform: { [key]: 3 }, tool: { [key]: 2 } })).toEqual({ value: 2, source: 'settings' });
    expect(resolve({ tool: { [key]: 2 }, env: { [envKey]: '0' } })).toEqual({ value: 0, source: 'env' });
  });
  it.each(['invalid', '', '-1', 'Infinity', '1e308', null, true])('invalid/oversized value %s falls back to 10', raw => {
    expect(resolve({ tool: { [key]: raw }, env: { [envKey]: raw } })).toEqual({ value: 10, source: 'default' });
  });
  it('uses the marker override or coordination location and isolates unit tests', () => {
    expect(resolveFreezeLastGoodPath({ WE_RED_MAIN_FREEZE: join(dir, 'marker') })).toBe(join(dir, 'marker.last-good.json'));
    expect(resolveFreezeLastGoodPath({ WE_COORDINATION_ROOT: dir })).toBe(join(dir, 'red-main-freeze.last-good.json'));
    expect(resolveFreezeLastGoodPath({ VITEST: 'true' })).toBe(null);
  });
});
