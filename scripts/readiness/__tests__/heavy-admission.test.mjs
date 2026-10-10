/**
 * @file scripts/readiness/__tests__/heavy-admission.test.mjs
 * @description Unit proof of the #3461 heavy-command admission-queue semaphore: slot acquisition/release built
 *   on `file-locks.mjs`'s existing atomic primitives, the observable waiting-intent markers, and the blocking
 *   wait primitive's fail-open timeout. Against a real temp lock root (mirrors `file-locks.test.mjs`'s own
 *   discipline of proving the atomic fs layer for real, not just its pure decision logic).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_ADMISSION_CAP, DEFAULT_TIMEOUT_MS, DEFAULT_ADMISSION_CEILING_MS, ADMISSION_SWITCH_ENV,
  ADMISSION_LEASE_MINUTES, resolveCap, resolveTimeoutMs, resolveCeilingMs, isAdmissionOff, slotPath,
  tryAcquireSlot, releaseOwnedSlot, heldSlots, probeSlotHolderLiveness,
  markWaiting, clearWaiting, listWaiting,
  acquireSlotBlocking, admissionStatus, isOldestLiveWaiter, isDeadOwnerWaiter,
  runUnderAdmission, shellQuoteWord,
  WAITING_TTL_MINUTES, ADMISSION_HELD_ENV, classifyWaiter, reapStaleWaiters, reapHistory, waiterRepo,
  admissionBypassReason, poolRootOf, admittedArgv, admittedShellCommand, HEAVY_ADMISSION_CLI,
  DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE, LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV, LOAD_ADMISSION_SWITCH_ENV,
  DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT, LOAD_ADMISSION_MIN_IDLE_PCT_ENV,
  DEFAULT_LOAD_ADMISSION_WINDOW, LOAD_ADMISSION_WINDOW_ENV,
  DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL, LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV,
  resolveLoadAdmissionBackstopPerCore, resolveLoadAdmissionMinIdlePct, resolveLoadAdmissionWindow,
  resolveLoadAdmissionMinPressureLevel,
  isLoadAdmissionOff, loadAdmissionDecision, readLatestLoad, resolveLoadAdmission,
} from '../heavy-admission.mjs';
import {
  ADMISSION_DEFERRED_EXIT, ADMISSION_POLICY_STANDARD, resolveAdmissionPolicy, formatAdmissionPolicy,
  resolveEffectiveFastSlots, resolveFastSlots, resolveSlotSpan,
} from '../heavy-admission.mjs';
import { utcDayKey } from '../../operations/telemetry-summary-io.mjs';
import { readLockEntry } from '../file-locks.mjs';

// In-process fixtures use a no-op; subprocess fixtures inherit the explicit off switch.
vi.mock('../../lib/resource-admission.mjs', () => ({ shadowAdmission: vi.fn(), admit: vi.fn(), decideAdmission: vi.fn(), readSnapshot: vi.fn() }));
// x6nuodj — the legacy telemetry rule's tests run with the shared decision observing only (`shadow`); the cut-over
// (admit() deciding) has its own describe below with an explicit `mode`.
beforeEach(() => { vi.stubEnv('WE_RESOURCE_SHADOW', 'off'); vi.stubEnv('WE_RESOURCE_CUTOVER', 'shadow'); });
// admission-no-fail-open — hermetic: the admission policy's platform layer never reads the operator's real file.
beforeEach(() => { vi.stubEnv('WE_PLATFORM_PREFERENCES', join(tmpdir(), 'heavy-admission-test-no-such-platform-preferences.json')); });
afterEach(() => vi.unstubAllEnvs());

describe('load admission shadow observation', () => {
  it.each([63, 3])('preserves the complete decision at load %s', (load1) => {
    const now = new Date('2026-10-09T12:00:00Z');
    writeFileSync(join(lockRoot, `${utcDayKey(now)}.jsonl`),
      metricLine('host.cpu.load1', load1, now.toISOString()) + metricLine('host.cpu.count', 12, now.toISOString()));
    const options = { env: {}, root: lockRoot, now };
    const baseline = resolveLoadAdmission({ ...options, shadow: () => {} });
    expect(baseline.held).toBe(load1 === 63);
    for (const kind of [undefined, 'review']) {
      const shadow = vi.fn(() => ({ verdict: baseline.held ? 'admit' : 'hold' }));
      expect(JSON.stringify(resolveLoadAdmission({ ...options, kind, shadow }))).toBe(JSON.stringify(baseline));
      expect(shadow).toHaveBeenCalledTimes(1);
      expect(shadow).toHaveBeenCalledWith({
        gate: 'heavy-admission.load-status', kind: kind ?? 'build',
        oldVerdict: baseline.held ? 'hold' : 'admit',
        oldReason: baseline.reason ?? `admitted (idle ${baseline.idlePct}%, load1 ${baseline.load1})`, env: options.env,
      });
    }
    expect(resolveLoadAdmission({ ...options, shadow: () => { throw Error('observer failed'); } })).toEqual(baseline);
  });

  it.each([{ [LOAD_ADMISSION_SWITCH_ENV]: 'off' }, { CI: 'true' }])('does not observe bypassed admission: %j', (env) => {
    const shadow = vi.fn();
    resolveLoadAdmission({ env, shadow });
    expect(shadow).not.toHaveBeenCalled();
  });

  it.each([undefined, 'review'])('keeps CLI JSON clean and sends kind %s only to the shadow log', (kind) => {
    const args = [CLI, 'load-status', '--json', `--load-root=${lockRoot}`];
    if (kind) args.push(`--kind=${kind}`);
    const env = { ...process.env, CI: '', [LOAD_ADMISSION_SWITCH_ENV]: 'on', WE_COORDINATION_ROOT: lockRoot };
    const baseline = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    const observed = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, WE_RESOURCE_SHADOW: 'on' } });
    expect(observed.status).toBe(0);
    expect(observed.stdout).toBe(baseline.stdout);
    expect(JSON.parse(observed.stdout).held).toBe(false);
    expect(observed.stderr).toContain(`resource-shadow gate=heavy-admission.load-status kind=${kind ?? 'build'}`);
    const rows = readFileSync(join(lockRoot, 'resource', 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows.at(-1)).toMatchObject({ gate: 'heavy-admission.load-status', kind: kind ?? 'build', old: { verdict: 'admit' } });
  });
});

describe('x6nuodj — load admission decided by admit() (enforce)', () => {
  const at = new Date('2026-10-09T12:00:00Z');
  const seed = (load1) => writeFileSync(join(lockRoot, `${utcDayKey(at)}.jsonl`),
    metricLine('host.cpu.load1', load1, at.toISOString()) + metricLine('host.cpu.count', 12, at.toISOString()));
  it('a high load average the legacy rule holds is admitted when admit() admits (CPU idle healthy)', () => {
    seed(63);
    const admitFn = vi.fn(() => ({ verdict: 'admit', reason: 'cpu idle 40% ≥ 15%', snapshotAge: 4, unknown: false }));
    const d = resolveLoadAdmission({ env: {}, root: lockRoot, now: at, shadow: () => undefined, admitFn, mode: 'enforce' });
    expect(admitFn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'build' }));
    expect(d).toMatchObject({ held: false, load1: 63, resourceAdmission: { verdict: 'admit', decidedBy: 'admit', legacyHeld: true, snapshotAge: 4 } });
    expect(d.reason).toBeUndefined();
  });
  it('a quiet legacy reading is held when admit() holds (stale snapshot = hold a heavy kind)', () => {
    seed(3);
    const admitFn = () => ({ verdict: 'hold', reason: 'snapshot-stale (age 300s)', snapshotAge: 300, unknown: true });
    const d = resolveLoadAdmission({ env: {}, root: lockRoot, now: at, kind: 'review', shadow: () => undefined, admitFn, mode: 'enforce' });
    expect(d).toMatchObject({ held: true, reason: 'resource-admission: hold — snapshot-stale (age 300s)', resourceAdmission: { unknown: true, legacyHeld: false } });
  });
  it('the shadow decision itself is used when the observer returns one (one admit() call per tick)', () => {
    seed(63);
    const admitFn = vi.fn();
    const shadow = vi.fn(() => ({ verdict: 'wait', reason: 'cpu idle 9% < 15%', snapshotAge: 2, unknown: false }));
    expect(resolveLoadAdmission({ env: {}, root: lockRoot, now: at, shadow, admitFn, mode: 'enforce' }).held).toBe(true);
    expect(admitFn).not.toHaveBeenCalled();
  });
  it('the off / CI bypasses stay bypasses', () => {
    const admitFn = vi.fn();
    expect(resolveLoadAdmission({ env: { [LOAD_ADMISSION_SWITCH_ENV]: 'off' }, admitFn, mode: 'enforce' })).toMatchObject({ held: false, bypassed: 'off' });
    expect(admitFn).not.toHaveBeenCalled();
  });
});

const T0 = Date.parse('2026-09-03T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let lockRoot;
beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'heavy-admission-test-')); });
afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

describe('CLI relative --repo', () => {
  it('resolves the repo before deriving the shared admission root and owner', () => {
    const repo = join(lockRoot, '.lanes', 'test-pool', 'lane-1');
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env };
    delete env.LANE_POOL_ROOT;
    execFileSync(process.execPath, [
      resolve('scripts/readiness/heavy-admission.mjs'),
      'acquire', '--repo=.', '--cap=1', '--json',
    ], { cwd: repo, env, encoding: 'utf8' });
    const held = heldSlots({ lockRoot: join(lockRoot, '.lanes', '.admission', 'heavy'), cap: 1 });
    expect(held).toHaveLength(1);
    expect(held[0].owner).toBe(realpathSync(repo));
  });
});

describe('resolveCap — env override (private pools only), clamped sane', () => {
  const priv = (cap) => ({ LANE_POOL_ROOT: '/tmp/private-pool', WE_HEAVY_ADMISSION_CAP: cap });
  it('defaults when unset', () => expect(resolveCap({})).toBe(DEFAULT_ADMISSION_CAP));
  it('reads WE_HEAVY_ADMISSION_CAP for a private pool', () => expect(resolveCap(priv('5'))).toBe(5));
  it('ignores WE_HEAVY_ADMISSION_CAP on the shared host pool', () => expect(resolveCap({ WE_HEAVY_ADMISSION_CAP: '5' })).toBe(DEFAULT_ADMISSION_CAP));
  it('falls back on a non-finite or sub-1 value', () => {
    expect(resolveCap(priv('nope'))).toBe(DEFAULT_ADMISSION_CAP);
    expect(resolveCap(priv('0'))).toBe(DEFAULT_ADMISSION_CAP);
  });
});

describe('resolveTimeoutMs — env override, clamped sane (the doc/impl mismatch this fix closes)', () => {
  it('defaults when unset', () => expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS));
  it('reads WE_HEAVY_ADMISSION_TIMEOUT_MS', () => expect(resolveTimeoutMs({ WE_HEAVY_ADMISSION_TIMEOUT_MS: '5000' })).toBe(5000));
  it('falls back on a non-finite or sub-1000ms value', () => {
    expect(resolveTimeoutMs({ WE_HEAVY_ADMISSION_TIMEOUT_MS: 'nope' })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ WE_HEAVY_ADMISSION_TIMEOUT_MS: '0' })).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('resolveCeilingMs — the xhlriy2 hard give-up ceiling, env override, clamped sane', () => {
  it('defaults to 120 minutes when unset', () => {
    expect(resolveCeilingMs({})).toBe(DEFAULT_ADMISSION_CEILING_MS);
    expect(DEFAULT_ADMISSION_CEILING_MS).toBe(120 * 60_000);
  });
  it('reads WE_HEAVY_ADMISSION_CEILING_MS', () => expect(resolveCeilingMs({ WE_HEAVY_ADMISSION_CEILING_MS: '9000' })).toBe(9000));
  it('falls back on a non-finite or sub-1000ms value', () => {
    expect(resolveCeilingMs({ WE_HEAVY_ADMISSION_CEILING_MS: 'nope' })).toBe(DEFAULT_ADMISSION_CEILING_MS);
    expect(resolveCeilingMs({ WE_HEAVY_ADMISSION_CEILING_MS: '0' })).toBe(DEFAULT_ADMISSION_CEILING_MS);
  });
});

describe('isAdmissionOff — the WE_HEAVY_ADMISSION=off escape hatch', () => {
  it('is off for off/0/false/no, case-insensitively', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'FALSE', 'no', 'No']) {
      expect(isAdmissionOff({ [ADMISSION_SWITCH_ENV]: v })).toBe(true);
    }
  });
  it('is on (not off) when unset or set to anything else', () => {
    expect(isAdmissionOff({})).toBe(false);
    expect(isAdmissionOff({ [ADMISSION_SWITCH_ENV]: 'on' })).toBe(false);
    expect(isAdmissionOff({ [ADMISSION_SWITCH_ENV]: '1' })).toBe(false);
  });
});

describe('tryAcquireSlot / releaseOwnedSlot / heldSlots — cap independent slots, each an ordinary file-lock', () => {
  it('admits up to cap concurrent owners, then refuses a (cap+1)th', () => {
    const cap = 2;
    const a = tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0) });
    const b = tryAcquireSlot({ lockRoot, cap, owner: 'B', nowMs: T0, nowIso: iso(T0) });
    const c = tryAcquireSlot({ lockRoot, cap, owner: 'C', nowMs: T0, nowIso: iso(T0) });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(new Set([a.slot, b.slot]).size).toBe(2); // distinct slots
    expect(c.ok).toBe(false);
    expect(heldSlots({ lockRoot, cap })).toHaveLength(2);
  });

  it('release frees the slot for a new owner', () => {
    const cap = 1;
    const a = tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0) });
    expect(a.ok).toBe(true);
    expect(tryAcquireSlot({ lockRoot, cap, owner: 'B', nowMs: T0, nowIso: iso(T0) }).ok).toBe(false);
    releaseOwnedSlot({ lockRoot, cap, owner: 'A' });
    expect(heldSlots({ lockRoot, cap })).toHaveLength(0);
    expect(tryAcquireSlot({ lockRoot, cap, owner: 'B', nowMs: T0, nowIso: iso(T0) }).ok).toBe(true);
  });

  it('re-acquiring your own held slot is a no-op success (heartbeat refresh), not a second slot', () => {
    const cap = 1;
    tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0) });
    const again = tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0 + 1000, nowIso: iso(T0 + 1000) });
    expect(again.ok).toBe(true);
    expect(heldSlots({ lockRoot, cap })).toHaveLength(1);
  });

  it('reclaims a slot whose lease has expired (stale-owner TTL floor, inherited from file-locks.mjs)', () => {
    const cap = 1;
    tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0) });
    const wayLater = T0 + (ADMISSION_LEASE_MINUTES + 5) * 60_000; // comfortably past the admission-specific lease
    const r = tryAcquireSlot({ lockRoot, cap, owner: 'B', nowMs: wayLater, nowIso: iso(wayLater) });
    expect(r.ok).toBe(true);
    expect(heldSlots({ lockRoot, cap })[0].owner).toBe('B');
  });

  it('does NOT reclaim a still-alive holder before its (deliberately long) lease expires — the fix for a false reclaim mid-gate', () => {
    const cap = 1;
    tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0) });
    // Past file-locks.mjs's general-purpose 15-minute default, but well inside ADMISSION_LEASE_MINUTES (60) —
    // a real test:unit + check:standards run can legitimately exceed 15 minutes; it must not be reclaimed.
    const midGate = T0 + 20 * 60_000;
    const r = tryAcquireSlot({ lockRoot, cap, owner: 'B', nowMs: midGate, nowIso: iso(midGate) });
    expect(r.ok).toBe(false);
    expect(heldSlots({ lockRoot, cap })[0].owner).toBe('A');
  });

  it('reclaims a provably-dead same-machine holder immediately via the PID fast path, ignoring the long TTL', () => {
    const cap = 1;
    // A pid that cannot exist (kill(pid,0) throws ESRCH) — simulates a crashed holder.
    const deadPid = 999999;
    tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0), pid: deadPid });
    const soonAfter = T0 + 1000; // well within the 60-minute lease — only the PID fast path can reclaim this
    const r = tryAcquireSlot({ lockRoot, cap, owner: 'B', nowMs: soonAfter, nowIso: iso(soonAfter) });
    expect(r.ok).toBe(true);
    expect(heldSlots({ lockRoot, cap })[0].owner).toBe('B');
  });

  it('does NOT fast-path-reclaim a slot held by a live pid, even well before the TTL', () => {
    const cap = 1;
    // process.ppid (this test's parent process) is a real, distinct, verifiably-alive pid — probing it must
    // report 'alive', not 'dead', and must NOT skip via the self-pid guard the way process.pid would.
    tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0), pid: process.ppid });
    const soonAfter = T0 + 1000;
    const r = tryAcquireSlot({ lockRoot, cap, owner: 'B', nowMs: soonAfter, nowIso: iso(soonAfter) });
    expect(r.ok).toBe(false);
  });

  it('forwards its own computed selfPid — not the raw omitted pid parameter — into the stored lock entry (#3679)', () => {
    const cap = 1;
    tryAcquireSlot({ lockRoot, cap, owner: 'A', nowMs: T0, nowIso: iso(T0) }); // pid intentionally omitted
    const entry = readLockEntry(lockRoot, slotPath(0));
    expect(entry.pid).toBe(process.pid); // BUG forwarded the raw (defaulted-null) `pid` param, so entry.pid was `null`
  });

  it('release is idempotent for an owner holding nothing', () => {
    expect(releaseOwnedSlot({ lockRoot, cap: 2, owner: 'nobody' })).toEqual({ released: false, slot: null });
  });

  it('slotPath is stable and distinct per index', () => {
    expect(slotPath(0)).toBe('slot-0');
    expect(slotPath(1)).not.toBe(slotPath(0));
  });
});

describe('#3383 live incident — slot reentrancy is keyed by REAL PROCESS IDENTITY, not the owner string alone', () => {
  // `owner` here is a LANE PATH (matches verify-lane.mjs's real call site: `owner: REPO`) — deliberately the
  // SAME string for two genuinely different real processes verifying the same lane back-to-back (a conveyor
  // auto-verify racing a manual re-verify, the confirmed live incident). `process.ppid` stands in for the
  // second process's pid — a real, distinct, verifiably-alive pid (the same trick this file's own
  // `probeSlotHolderLiveness` tests already use), so the liveness probe genuinely reports 'alive', not
  // 'dead' — proving this is NOT just the already-covered dead-pid-reclaim path.
  const SAME_LANE_PATH = '/Users/x/workspace/.lanes/web-everything/lane-34';

  it('omitting pid records the real process identity, including on same-owner re-acquisition', () => {
    const cap = 2;
    const first = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0) });
    expect(first.ok).toBe(true);
    expect(heldSlots({ lockRoot, cap })[0].pid).toBe(process.pid);
    const again = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0 + 1000, nowIso: iso(T0 + 1000) });
    expect(again.ok).toBe(true);
    expect(again.slot).toBe(first.slot); // both omitted-pid calls belong to THIS real process
    const held = heldSlots({ lockRoot, cap });
    expect(held).toHaveLength(1);
    expect(held[0].pid).toBe(process.pid);
  });

  it('BEFORE this fix, two different alive processes under the same owner string would have shared one slot — now the second genuinely different process takes a real SECOND slot', () => {
    const cap = 2;
    const a = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0), pid: process.pid });
    const b = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0 + 1000, nowIso: iso(T0 + 1000), pid: process.ppid });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.slot).not.toBe(a.slot); // a REAL second slot, never the "already mine" fast path
    expect(heldSlots({ lockRoot, cap })).toHaveLength(2); // status now correctly counts BOTH real holders
  });

  it('a genuinely different, still-alive process under the same owner string is BLOCKED (not reclaimed) once the cap is exhausted', () => {
    const cap = 1;
    tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0), pid: process.pid });
    const soonAfter = T0 + 1000; // well within the lease — must be BLOCKED, not fast-pathed or reclaimed
    const r = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: soonAfter, nowIso: iso(soonAfter), pid: process.ppid });
    expect(r.ok).toBe(false);
    expect(heldSlots({ lockRoot, cap })).toHaveLength(1);
  });

  it('the SAME process re-acquiring its own already-held slot under this owner string still fast-paths as "own" (heartbeat refresh) — the legitimate case this fix must not break', () => {
    const cap = 1;
    const first = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0), pid: process.pid });
    const again = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0 + 1000, nowIso: iso(T0 + 1000), pid: process.pid });
    expect(again.ok).toBe(true);
    expect(again.slot).toBe(first.slot);
    expect(heldSlots({ lockRoot, cap })).toHaveLength(1); // still just one real holder
  });

  it('a same-owner-string holder that is provably DEAD is still reclaimed immediately (the PID fast path survives this fix)', () => {
    const cap = 1;
    const deadPid = 999999; // kill(pid,0) throws ESRCH — cannot exist
    tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0), pid: deadPid });
    const soonAfter = T0 + 1000;
    const r = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: soonAfter, nowIso: iso(soonAfter), pid: process.pid });
    expect(r.ok).toBe(true);
    expect(heldSlots({ lockRoot, cap })[0].pid).toBe(process.pid);
  });

  it('releaseOwnedSlot releases the CALLING process\'s own slot, never a sibling process\'s slot held under the same owner string', () => {
    const cap = 2;
    const a = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0), pid: process.pid });
    const b = tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0 + 1000, nowIso: iso(T0 + 1000), pid: process.ppid });
    // Process A releases (as itself) — must free ITS OWN slot, not B's.
    const rel = releaseOwnedSlot({ lockRoot, cap, owner: SAME_LANE_PATH, pid: process.pid });
    expect(rel).toEqual({ released: true, slot: a.slot });
    const held = heldSlots({ lockRoot, cap });
    expect(held).toHaveLength(1);
    expect(held[0].pid).toBe(process.ppid); // B's slot is untouched
    void b;
  });

  it('releaseOwnedSlot never grabs a DIFFERENT real pid\'s slot as a fallback — a pid that matches nothing releases nothing', () => {
    const cap = 1;
    tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0), pid: process.ppid }); // B's real slot
    // A THIRD, different real pid (our own) tries to release "its" slot — it holds none; must be a no-op,
    // never mistakenly free B's still-live slot.
    const rel = releaseOwnedSlot({ lockRoot, cap, owner: SAME_LANE_PATH, pid: process.pid });
    expect(rel).toEqual({ released: false, slot: null });
    expect(heldSlots({ lockRoot, cap })).toHaveLength(1); // B's slot is untouched
  });

  it('releaseOwnedSlot with pid:null (the CLI\'s manual/operator escape hatch) keeps the old owner-only match — releases the FIRST owner-matching slot regardless of pid', () => {
    const cap = 2;
    tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0, nowIso: iso(T0), pid: process.pid });
    tryAcquireSlot({ lockRoot, cap, owner: SAME_LANE_PATH, nowMs: T0 + 1000, nowIso: iso(T0 + 1000), pid: process.ppid });
    const rel = releaseOwnedSlot({ lockRoot, cap, owner: SAME_LANE_PATH, pid: null });
    expect(rel.released).toBe(true); // some owner-matching slot was freed — the deliberate loose fallback
    expect(heldSlots({ lockRoot, cap })).toHaveLength(1);
  });
});

describe('probeSlotHolderLiveness — the PID fast path in isolation', () => {
  it('reports dead for a pid that cannot exist', () => {
    expect(probeSlotHolderLiveness(999999, process.pid)).toBe('dead');
  });
  it('reports alive for a real, distinct, live pid', () => {
    expect(probeSlotHolderLiveness(process.ppid, process.pid)).toBe('alive');
  });
  it('reports unknown (never accelerates) for a null pid, a non-positive pid, or the caller\'s own pid', () => {
    expect(probeSlotHolderLiveness(null, process.pid)).toBe('unknown');
    expect(probeSlotHolderLiveness(0, process.pid)).toBe('unknown');
    expect(probeSlotHolderLiveness(-1, process.pid)).toBe('unknown');
    expect(probeSlotHolderLiveness(process.pid, process.pid)).toBe('unknown');
  });
});

describe('waiting-intent markers — the observable queue', () => {
  it('markWaiting then listWaiting round-trips; clearWaiting removes it', () => {
    markWaiting({ lockRoot, owner: 'A', lane: '4', num: 99, nowIso: iso(T0) });
    const w = listWaiting(lockRoot);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ owner: 'A', lane: '4', num: 99 });
    clearWaiting({ lockRoot, owner: 'A' });
    expect(listWaiting(lockRoot)).toHaveLength(0);
  });

  it('listWaiting returns empty (never throws) when the waiting dir does not exist yet', () => {
    expect(listWaiting(join(lockRoot, 'never-created'))).toEqual([]);
  });

  it('an owner string with path-unsafe characters (a lane clone path) still yields a legible, safe marker', () => {
    markWaiting({ lockRoot, owner: '/Users/x/workspace/.lanes/web-everything/lane-27', lane: '27', nowIso: iso(T0) });
    const w = listWaiting(lockRoot);
    expect(w).toHaveLength(1);
    expect(w[0].owner).toContain('lane-27');
  });
});

describe('acquireSlotBlocking — polls until free, marks/clears waiting, FAILS OPEN only at the hard ceiling (xhlriy2)', () => {
  it('acquires immediately with zero wait when a slot is free', async () => {
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'A', now: () => T0, sleep: async () => {} });
    expect(r).toEqual({ ok: true, slot: 0, timedOut: false, waitedMs: 0 });
    expect(listWaiting(lockRoot)).toHaveLength(0); // never marked waiting — it never needed to
  });

  it('marks waiting while blocked, clears it once a slot frees, and returns the wait duration', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let clock = T0;
    const now = () => clock;
    let polls = 0;
    const sleep = async (ms) => {
      clock += ms;
      polls += 1;
      if (polls === 2) releaseOwnedSlot({ lockRoot, cap: 1, owner: 'HOLDER' }); // free it on the 2nd poll
    };
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'B', lane: '9', pollMs: 1000, now, sleep });
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBeGreaterThan(0);
    expect(listWaiting(lockRoot)).toHaveLength(0); // cleared on success
  });

  it('keeps polling PAST the old 20-minute DEFAULT_TIMEOUT_MS mark while the holder is still alive — the exact xhlriy2 fix', async () => {
    // 'HOLDER' is recorded under THIS test process's own pid (tryAcquireSlot's pid default), so the waiter's
    // liveness probe against it reports 'unknown' (never provably dead) — it must never be reclaimed by time
    // alone, and the old code's 20-minute elapsed-time give-up must no longer fire here.
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let clock = T0;
    const r = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'B', pollMs: 60_000, ceilingMs: 40 * 60_000, canDefer: true, // ceiling well past the old timeout
      now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    // Never acquires (the holder never frees or dies) — but must have polled well past DEFAULT_TIMEOUT_MS
    // (20 min) before finally giving up at the 40-minute ceiling, proving it did NOT give up early.
    expect(r).toMatchObject({ ok: false, slot: null, timedOut: true, ceilingHit: true });
    expect(r.waitedMs).toBeGreaterThanOrEqual(40 * 60_000);
    expect(r.waitedMs).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    expect(listWaiting(lockRoot)).toHaveLength(0); // marker cleared even on give-up (the `finally`)
  });

  it('with onTimeout=run, gives up and reports timedOut/ceilingHit only once the hard ceiling elapses — fails OPEN, never throws, with a loud warning', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let clock = T0;
    const logs = [];
    const r = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'B', pollMs: 1000, ceilingMs: 3000, log: (m) => logs.push(m), canDefer: true, policy: { settings: { ...ADMISSION_POLICY_STANDARD, onTimeout: 'run' }, sources: { onTimeout: 'tool' }, invalid: [], ignored: [] }, 
      now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    expect(r).toMatchObject({ ok: false, slot: null, timedOut: true, ceilingHit: true });
    expect(listWaiting(lockRoot)).toHaveLength(0); // marker cleared even on give-up (the `finally`)
    expect(logs.some((m) => /HARD CEILING/.test(m) && /proceeding unslotted/.test(m))).toBe(true);
  });

  it('logs a periodic "still waiting" line at stillWaitingLogMs cadence while blocked, well before the ceiling', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let clock = T0;
    let polls = 0;
    const sleep = async (ms) => { clock += ms; polls += 1; if (polls === 5) releaseOwnedSlot({ lockRoot, cap: 1, owner: 'HOLDER' }); };
    const logs = [];
    const r = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'B', pollMs: 1000, stillWaitingLogMs: 3000, ceilingMs: 60_000,
      log: (m) => logs.push(m), now: () => clock, sleep,
    });
    expect(r.ok).toBe(true);
    expect(logs.some((m) => /still waiting/.test(m))).toBe(true);
    expect(logs.some((m) => /HARD CEILING/.test(m))).toBe(false); // never hit the ceiling
  });

  it('a provably-dead holder is reclaimed immediately (a REAL slot, not "proceeding unslotted") — the mechanism the ceiling never needs to engage for a dead holder', async () => {
    const deadPid = 999999; // kill(pid,0) throws ESRCH — cannot exist
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0), pid: deadPid });
    let clock = T0;
    const r = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'B', pollMs: 1000, ceilingMs: 60_000,
      now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    expect(r).toMatchObject({ ok: true }); // a REAL slot, reclaimed — never "unslotted"
    expect(heldSlots({ lockRoot, cap: 1 })[0].owner).toBe('B');
  });

  it('WE_HEAVY_ADMISSION=off is a pure pass-through — returns unslotted immediately, never touches the lock root or a waiting marker', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    const sleep = async () => { throw new Error('must never poll/sleep when disabled'); };
    const r = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'B', now: () => T0, sleep, env: { [ADMISSION_SWITCH_ENV]: 'off' },
    });
    expect(r).toEqual({ ok: false, slot: null, timedOut: false, disabled: true, waitedMs: 0 });
    expect(listWaiting(lockRoot)).toHaveLength(0); // never marked waiting
  });
});

describe('isOldestLiveWaiter — the #3383 (card xb0iuxq) FCFS ranking, ignoring stale/dead waiters', () => {
  it('a solo caller with no other live marker is always "oldest"', () => {
    expect(isOldestLiveWaiter({ lockRoot, owner: 'A', nowMs: T0 })).toBe(true);
  });

  it('the earliest requestedAt among LIVE markers wins, regardless of listing order', () => {
    markWaiting({ lockRoot, owner: 'LATE', nowIso: iso(T0 + 20_000) });
    markWaiting({ lockRoot, owner: 'EARLY', nowIso: iso(T0) });
    expect(isOldestLiveWaiter({ lockRoot, owner: 'EARLY', nowMs: T0 + 20_000 })).toBe(true);
    expect(isOldestLiveWaiter({ lockRoot, owner: 'LATE', nowMs: T0 + 20_000 })).toBe(false);
  });

  it('a STALE/DEAD marker is ignored for ranking — a live newer waiter still counts as oldest', () => {
    const deadPid = 999999; // kill(pid,0) → ESRCH, provably dead
    // A marker older than the TTL, on this host, with a provably-dead pid — classifyWaiter would reap it.
    markWaiting({ lockRoot, owner: 'GHOST', nowIso: iso(T0), pid: deadPid });
    markWaiting({ lockRoot, owner: 'REAL', nowIso: iso(T0 + 10_000) });
    const nowMs = T0 + (WAITING_TTL_MINUTES + 5) * 60_000; // well past the TTL
    expect(isOldestLiveWaiter({ lockRoot, owner: 'GHOST', nowMs })).toBe(false); // dead debris never wins
    expect(isOldestLiveWaiter({ lockRoot, owner: 'REAL', nowMs })).toBe(true); // the only genuinely live waiter
  });

  // PR #2692 review finding: classifyWaiter's "fresh ⇒ never reap" shortcut skips the pid probe while the
  // marker is younger than the TTL, so a waiter that crashed moments after marking would otherwise block
  // every live waiter from a FREE slot for up to WAITING_TTL_MINUTES.
  it('a FRESH marker whose own pid is provably dead is ignored for ranking (no 30-minute freeze)', () => {
    markWaiting({ lockRoot, owner: 'CRASHED', nowIso: iso(T0), pid: 4141 });
    markWaiting({ lockRoot, owner: 'REAL', nowIso: iso(T0 + 10_000), pid: 4242 });
    const nowMs = T0 + 5 * 60_000; // well INSIDE the TTL window
    const seams = { pidLiveness: (pid) => (pid === 4141 ? 'dead' : 'alive') };
    expect(isOldestLiveWaiter({ lockRoot, owner: 'CRASHED', nowMs, ...seams })).toBe(false);
    expect(isOldestLiveWaiter({ lockRoot, owner: 'REAL', nowMs, ...seams })).toBe(true);
  });

  it('a FRESH marker whose pid is alive, unknown, or on another host still ranks first (FCFS kept)', () => {
    markWaiting({ lockRoot, owner: 'ALIVE', nowIso: iso(T0), pid: 4242 });
    markWaiting({ lockRoot, owner: 'REAL', nowIso: iso(T0 + 10_000) });
    const nowMs = T0 + 5 * 60_000;
    for (const live of ['alive', 'unknown']) {
      const seams = { pidLiveness: () => live };
      expect(isOldestLiveWaiter({ lockRoot, owner: 'REAL', nowMs, ...seams })).toBe(false);
      expect(isOldestLiveWaiter({ lockRoot, owner: 'ALIVE', nowMs, ...seams })).toBe(true);
    }
    // A dead verdict for a pid recorded on a DIFFERENT host proves nothing about that host's process.
    const other = { pidLiveness: () => 'dead', host: 'not-the-marker-host' };
    expect(isOldestLiveWaiter({ lockRoot, owner: 'ALIVE', nowMs, ...other })).toBe(true);
  });

  it('acquireSlotBlocking: a fresh crashed waiter never stops a live caller from winning a FREE slot', async () => {
    // A real child that has already exited and been reaped — a pid provably dead on any platform.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    markWaiting({ lockRoot, owner: 'CRASHED', nowIso: iso(T0), pid: deadPid });
    let t = T0 + 60_000;
    const r = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'REAL', pollMs: 2_000, ceilingMs: 10 * 60_000,
      now: () => t, sleep: async (ms) => { t += ms; }, log: () => {}, env: {},
    });
    expect(r).toMatchObject({ ok: true, slot: 0, waitedMs: 0 });
  });

  it('ties on identical requestedAt break deterministically on owner name', () => {
    markWaiting({ lockRoot, owner: 'B', nowIso: iso(T0) });
    markWaiting({ lockRoot, owner: 'A', nowIso: iso(T0) });
    expect(isOldestLiveWaiter({ lockRoot, owner: 'A', nowMs: T0 })).toBe(true);
    expect(isOldestLiveWaiter({ lockRoot, owner: 'B', nowMs: T0 })).toBe(false);
  });
});

describe('admissionStatus — the shape tick-core.mjs reads', () => {
  it('reports cap, held/free counts, and live waiting entries', () => {
    tryAcquireSlot({ lockRoot, cap: 2, owner: 'A', nowMs: T0, nowIso: iso(T0) });
    markWaiting({ lockRoot, owner: 'B', lane: '5', nowIso: iso(T0) });
    const s = admissionStatus({ lockRoot, cap: 2 });
    expect(s).toMatchObject({ cap: 2, heldCount: 1, freeCount: 1 });
    expect(s.held).toHaveLength(1);
    expect(s.waiting).toHaveLength(1);
    expect(s.waiting[0]).toMatchObject({ owner: 'B', lane: '5' });
  });
});

describe('shellQuoteWord — round-trips an already-split argv word through /bin/sh -c', () => {
  it('leaves a plain word untouched', () => expect(shellQuoteWord('check:standards')).toBe('check:standards'));
  it('single-quotes a word containing whitespace', () => expect(shellQuoteWord('a b')).toBe(`'a b'`));
  it('escapes an embedded single quote the POSIX way', () => expect(shellQuoteWord(`it's`)).toBe(`'it'\\''s'`));
});

describe('runUnderAdmission — acquire → exec → release, the #3621 container-hook seam', () => {
  it('acquires a slot, runs the injected exec, releases on success', async () => {
    const calls = [];
    const exec = (cmd, o) => calls.push({ cmd, cwd: o.cwd });
    const r = await runUnderAdmission({ lockRoot, cap: 2, owner: 'A', command: 'echo hi', cwd: '/repo', exec, now: () => T0, sleep: async () => {} });
    expect(r.exitCode).toBe(0);
    expect(r.admission.ok).toBe(true);
    expect(calls).toEqual([{ cmd: 'echo hi', cwd: '/repo' }]);
    expect(heldSlots({ lockRoot, cap: 2 })).toHaveLength(0); // released
  });

  it('maps a thrown exec error status to the returned exitCode, and still releases the slot', async () => {
    const exec = () => { const e = new Error('boom'); e.status = 7; throw e; };
    const r = await runUnderAdmission({ lockRoot, cap: 1, owner: 'A', command: 'false', exec, now: () => T0, sleep: async () => {} });
    expect(r.exitCode).toBe(7);
    expect(heldSlots({ lockRoot, cap: 1 })).toHaveLength(0);
  });

  it('defaults a thrown error with no numeric status to exitCode 1', async () => {
    const exec = () => { throw new Error('no status field'); };
    const r = await runUnderAdmission({ lockRoot, cap: 1, owner: 'A', command: 'false', exec, now: () => T0, sleep: async () => {} });
    expect(r.exitCode).toBe(1);
  });

  it('the exec seam is swappable — the #3621 container POC injects container-exec.mjs#execContainerized here instead of execSync, unchanged acquire/release sequencing either way', async () => {
    const seen = [];
    const fakeContainerExec = (cmd, o) => seen.push(`container:${cmd}`);
    const r = await runUnderAdmission({ lockRoot, cap: 1, owner: 'A', command: 'node scripts/check-standards.mjs', exec: fakeContainerExec, now: () => T0, sleep: async () => {} });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual(['container:node scripts/check-standards.mjs']);
  });

  it('with onTimeout=run, still fails open on a queuing timeout — runs unslotted rather than refusing', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let clock = T0;
    const calls = [];
    const r = await runUnderAdmission({
      lockRoot, cap: 1, owner: 'B', command: 'echo hi', ceilingMs: 3000, policy: { settings: { ...ADMISSION_POLICY_STANDARD, onTimeout: 'run' }, sources: { onTimeout: 'tool' }, invalid: [], ignored: [] }, 
      exec: (cmd) => calls.push(cmd), now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    expect(r.admission.timedOut).toBe(true);
    expect(calls).toEqual(['echo hi']); // ran anyway
  });
});

// ── xaipsbs: every heavy command through the pool ─────────────────────────────────────────────────────────

/** A clean env for a real CLI child: no CI / off switch / held flag leaking in from the runner's own env. */
function cliEnv(poolRoot, extra = {}) {
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot, ...extra };
  delete env.CI; delete env.WE_HEAVY_ADMISSION; delete env[ADMISSION_HELD_ENV];
  return env;
}
const CLI = resolve('scripts/readiness/heavy-admission.mjs');

describe('admissionBypassReason — when the wrapper is a pass-through', () => {
  it('queues by default', () => expect(admissionBypassReason({ env: {}, poolExists: true })).toBeNull());
  it('passes through when an outer wrapper holds the slot', () => expect(admissionBypassReason({ env: { [ADMISSION_HELD_ENV]: '1' } })).toBe('held'));
  it('passes through in CI', () => {
    expect(admissionBypassReason({ env: { CI: 'true' } })).toBe('ci');
    expect(admissionBypassReason({ env: { CI: '1' } })).toBe('ci');
    expect(admissionBypassReason({ env: { CI: 'false' }, poolExists: true })).toBeNull();
  });
  it('passes through with WE_HEAVY_ADMISSION=off', () => expect(admissionBypassReason({ env: { WE_HEAVY_ADMISSION: 'off' } })).toBe('off'));
  it('passes through when there is no pool directory', () => expect(admissionBypassReason({ env: {}, poolExists: false })).toBe('no-pool'));
  it('poolRootOf strips .admission/heavy', () => expect(poolRootOf('/w/.lanes/.admission/heavy')).toBe('/w/.lanes'));
});

describe('runUnderAdmission — re-entrancy flag and bypass', () => {
  it('runs the child with WE_HEAVY_ADMISSION_HELD=1 so a nested wrapper passes through', async () => {
    const seen = [];
    await runUnderAdmission({ lockRoot, cap: 1, owner: 'A', command: 'x', env: { FOO: 'bar' }, exec: (c, o) => seen.push(o.env), now: () => T0, sleep: async () => {} });
    expect(seen[0]).toMatchObject({ FOO: 'bar', [ADMISSION_HELD_ENV]: '1' });
  });
  it('a bypassed run takes no slot, creates no lock root, and keeps the exit code', async () => {
    const root = join(lockRoot, 'never');
    const r = await runUnderAdmission({ lockRoot: root, cap: 1, owner: 'A', command: 'x', bypass: 'no-pool', exec: () => { throw Object.assign(new Error('x'), { status: 4 }); } });
    expect(r.exitCode).toBe(4);
    expect(r.admission.bypassed).toBe('no-pool');
    expect(existsSync(root)).toBe(false);
  });
});

describe('the run wrapper as a real process (xaipsbs)', () => {
  it('a NESTED wrapper neither deadlocks nor takes a second slot (cap 1)', () => {
    const pool = join(lockRoot, '.lanes');
    mkdirSync(pool, { recursive: true });
    // outer run → inner run → status. With cap 1, a second acquire would wait on the outer's slot forever
    // (well, until the timeout, which is set far past the test's own limit).
    const out = execFileSync(process.execPath, [CLI, 'run', '--cap=1', '--', process.execPath, CLI, 'run', '--cap=1', '--', process.execPath, CLI, 'status', '--cap=1'], {
      cwd: lockRoot, env: cliEnv(pool, { WE_HEAVY_ADMISSION_TIMEOUT_MS: '600000' }), encoding: 'utf8', timeout: 30_000,
    });
    const status = JSON.parse(out.trim().split('\n').pop());
    expect(status.heldCount).toBe(1);             // only the OUTER wrapper holds a slot
    expect(status.held[0].owner).toMatch(/#\d+$/); // a per-process owner
    expect(heldSlots({ lockRoot: join(pool, '.admission', 'heavy'), cap: 1 })).toHaveLength(0); // released after
  });

  it('two wrappers from the SAME checkout are two owners: with cap 1 the second waits for the first', async () => {
    const pool = join(lockRoot, '.lanes');
    mkdirSync(pool, { recursive: true });
    const log = join(lockRoot, 'log.txt');
    writeFileSync(log, '');
    const body = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start '+Date.now()+'\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'end '+Date.now()+'\\n'),1500)`;
    const runOne = () => new Promise((res) => {
      const c = spawn(process.execPath, [CLI, 'run', '--cap=1', '--', process.execPath, '-e', body], { cwd: lockRoot, env: cliEnv(pool), stdio: 'ignore' });
      c.on('exit', (code) => res(code));
    });
    const codes = await Promise.all([runOne(), runOne()]);
    expect(codes).toEqual([0, 0]);
    const ev = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
    // never two `start`s without an `end` between them — the runs did not overlap
    expect(ev.map((e) => e[0])).toEqual(['start', 'end', 'start', 'end']);
  }, 30_000);

  it('CI=true: a pass-through that creates nothing', () => {
    const pool = join(lockRoot, 'no-such-pool');
    const out = execFileSync(process.execPath, [CLI, 'run', '--', 'echo', 'ran'], { cwd: lockRoot, env: { ...cliEnv(pool), CI: 'true' }, encoding: 'utf8' });
    expect(out.trim()).toBe('ran');
    expect(existsSync(pool)).toBe(false);
  });

  it('admittedArgv keeps the wrapped command\'s stdout and exit code (what the sync callers rely on)', () => {
    const pool = join(lockRoot, '.lanes');
    mkdirSync(pool, { recursive: true });
    const ok = admittedArgv(process.execPath, ['-e', 'process.stdout.write("hello")']);
    expect(ok.args.slice(0, 3)).toEqual([HEAVY_ADMISSION_CLI, 'run', '--']);
    expect(execFileSync(ok.file, ok.args, { cwd: lockRoot, env: cliEnv(pool), encoding: 'utf8' })).toBe('hello');
    const bad = admittedArgv(process.execPath, ['-e', 'process.exit(5)']);
    let status = null;
    try { execFileSync(bad.file, bad.args, { cwd: lockRoot, env: cliEnv(pool), stdio: 'ignore' }); } catch (e) { status = e.status; }
    expect(status).toBe(5);
  });

  it('admittedShellCommand keeps && semantics inside one slot', () => {
    const pool = join(lockRoot, '.lanes');
    mkdirSync(pool, { recursive: true });
    const out = execSync(admittedShellCommand('echo a && echo b'), { cwd: lockRoot, env: cliEnv(pool), encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual(['a', 'b']);
  });
});

describe('stale-waiter reap (xaipsbs)', () => {
  const TTL = WAITING_TTL_MINUTES * 60_000;
  const old = iso(T0 - TTL - 60_000);
  const opts = (over = {}) => ({ nowMs: T0, host: 'h', pidLiveness: () => 'unknown', readLease: () => null, ...over });

  it('never reaps a marker younger than the TTL, whatever the evidence', () => {
    expect(classifyWaiter({ owner: '/p/lane-1', requestedAt: iso(T0 - 1000), pid: 1, host: 'h' }, opts({ pidLiveness: () => 'dead' }))).toEqual({ reap: false, reason: 'fresh' });
  });
  it('reaps an old marker whose pid on this host is dead; keeps one whose pid is alive', () => {
    expect(classifyWaiter({ owner: 'x', requestedAt: old, pid: 7, host: 'h' }, opts({ pidLiveness: () => 'dead' })).reason).toBe('pid-dead');
    expect(classifyWaiter({ owner: 'x', requestedAt: old, pid: 7, host: 'h' }, opts({ pidLiveness: () => 'alive' })).reap).toBe(false);
  });
  it('ignores a pid recorded on another host and falls back to the lane lease', () => {
    expect(classifyWaiter({ owner: '/p/lane-2', requestedAt: old, pid: 7, host: 'other' }, opts({ pidLiveness: () => 'alive' })).reason).toBe('no-lease');
  });
  it('a legacy lane marker (no pid): no lease → reap; a lease taken after the wait began → reap; an older live lease → keep', () => {
    const m = { owner: '/p/lane-27', requestedAt: old };
    expect(classifyWaiter(m, opts()).reason).toBe('no-lease');
    expect(classifyWaiter(m, opts({ readLease: () => ({ acquiredAt: iso(T0 - 1000), ttlMinutes: 240 }) })).reason).toBe('lease-newer');
    expect(classifyWaiter(m, opts({ readLease: () => ({ acquiredAt: iso(T0 - TTL - 120_000), ttlMinutes: 240 }) }))).toEqual({ reap: false, reason: 'lease-live' });
    expect(classifyWaiter(m, opts({ readLease: () => ({ acquiredAt: iso(T0 - 10 * 3600_000), ttlMinutes: 240 }) })).reason).toBe('no-lease'); // stale lease
  });
  it('keeps an old non-lane marker with no pid — nothing proves its owner is gone', () => {
    expect(classifyWaiter({ owner: '/Users/x/webeverything', requestedAt: old }, opts())).toEqual({ reap: false, reason: 'owner-unknown' });
  });
  it('waiterRepo strips the per-process #pid suffix', () => {
    expect(waiterRepo({ owner: '/p/lane-3#123' })).toBe('/p/lane-3');
    expect(waiterRepo({ owner: 'x', repo: '/r' })).toBe('/r');
  });

  it('reapStaleWaiters previews without touching, --apply removes and logs, status reports both counts', () => {
    markWaiting({ lockRoot, owner: '/gone/lane-9', lane: '9', nowIso: old });
    markWaiting({ lockRoot, owner: 'fresh', nowIso: iso(T0) });
    const preview = reapStaleWaiters({ lockRoot, nowMs: T0, readLease: () => null });
    expect(preview.reaped.map((r) => r.owner)).toEqual(['/gone/lane-9']);
    expect(listWaiting(lockRoot)).toHaveLength(2);
    expect(admissionStatus({ lockRoot, cap: 1, nowMs: T0, readLease: () => null })).toMatchObject({ staleWaiting: 1, reaped: { count: 0 } });
    reapStaleWaiters({ lockRoot, nowMs: T0, readLease: () => null, apply: true });
    expect(listWaiting(lockRoot).map((w) => w.owner)).toEqual(['fresh']);
    expect(reapHistory(lockRoot)).toMatchObject({ count: 1, last: { owner: '/gone/lane-9', reason: 'no-lease' } });
    expect(admissionStatus({ lockRoot, cap: 1, nowMs: T0 })).toMatchObject({ staleWaiting: 0, reaped: { count: 1 } });
  });

  it('reaps a ten-second-old dead owner immediately and omits it from status waiting', () => {
    markWaiting({ lockRoot, owner: 'CRASHED', pid: 4141, nowIso: iso(T0 - 10_000) });
    const seams = { pidLiveness: () => 'dead' };
    expect(reapStaleWaiters({ lockRoot, nowMs: T0, ...seams })).toMatchObject({
      reaped: [{ owner: 'CRASHED', reason: 'pid-dead' }], kept: [],
    });
    expect(admissionStatus({ lockRoot, cap: 1, nowMs: T0, ...seams })).toMatchObject({
      waiting: [], staleWaiting: 1,
    });
    expect(listWaiting(lockRoot)).toHaveLength(1); // preview remains read-only
    reapStaleWaiters({ lockRoot, nowMs: T0, apply: true, ...seams });
    expect(listWaiting(lockRoot)).toEqual([]);
    expect(reapHistory(lockRoot)).toMatchObject({ count: 1, last: { owner: 'CRASHED', reason: 'pid-dead' } });
  });

  it.each(['alive', 'unknown'])('keeps a fresh owner whose pid is %s', (liveness) => {
    markWaiting({ lockRoot, owner: '/p/lane-1', pid: 4141, nowIso: iso(T0 - 10_000) });
    const seams = { pidLiveness: () => liveness, readLease: () => null };
    expect(reapStaleWaiters({ lockRoot, nowMs: T0, apply: true, ...seams })).toMatchObject({
      reaped: [], kept: [{ owner: '/p/lane-1', reason: 'fresh' }],
    });
    expect(listWaiting(lockRoot)).toHaveLength(1);
    expect(admissionStatus({ lockRoot, cap: 1, nowMs: T0, ...seams }).waiting).toHaveLength(1);
  });

  it('requires an integer pid on this host or a legacy marker with no host to prove death', () => {
    const seams = { host: 'here', pidLiveness: () => 'dead' };
    expect(isDeadOwnerWaiter({ pid: 4141, host: 'here' }, seams)).toBe(true);
    expect(isDeadOwnerWaiter({ pid: 4141 }, seams)).toBe(true);
    for (const marker of [null, {}, { pid: '4141' }, { pid: 1.5 }, { pid: 4141, host: 'elsewhere' }]) {
      expect(isDeadOwnerWaiter(marker, seams)).toBe(false);
    }
    for (const liveness of ['alive', 'unknown']) {
      expect(isDeadOwnerWaiter({ pid: 4141 }, { pidLiveness: () => liveness })).toBe(false);
    }
  });

  it('a blocked poll reaps a dead marker that appears mid-wait while preserving live waiters', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let clock = T0;
    let polls = 0;
    const result = await acquireSlotBlocking({
      lockRoot, cap: 1, owner: 'REAL', pollMs: 1000, ceilingMs: 5000, env: {},
      now: () => clock, pidLiveness: (pid) => pid === 4141 ? 'dead' : 'alive',
      sleep: async (ms) => {
        clock += ms;
        polls += 1;
        if (polls === 1) {
          markWaiting({ lockRoot, owner: 'CRASHED', pid: 4141, nowIso: iso(clock) });
          expect(listWaiting(lockRoot).map((m) => m.owner)).toContain('CRASHED');
        } else {
          expect(listWaiting(lockRoot).map((m) => m.owner)).toEqual(['REAL']);
          expect(reapHistory(lockRoot)).toMatchObject({ count: 1, last: { owner: 'CRASHED', reason: 'pid-dead' } });
          releaseOwnedSlot({ lockRoot, cap: 1, owner: 'HOLDER' });
        }
      },
    });
    expect(polls).toBe(2);
    expect(result).toMatchObject({ ok: true, waitedMs: 2000 });
    expect(listWaiting(lockRoot)).toEqual([]);
  });

  it('the next admission attempt reaps (real lease read: a lane path with no lease marker)', async () => {
    markWaiting({ lockRoot, owner: join(lockRoot, 'pool', 'lane-5'), lane: '5', nowIso: old });
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'B', now: () => T0, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(listWaiting(lockRoot)).toHaveLength(0);
    expect(reapHistory(lockRoot).count).toBe(1);
  });

  it('a new waiting marker records pid, host and repo — the evidence the reap reads', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let seen = null;
    await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'W', repo: '/r', pollMs: 1000, ceilingMs: 2000, now: (() => { let c = T0; return () => (c += 500); })(), sleep: async () => { seen = listWaiting(lockRoot)[0]; } });
    expect(seen).toMatchObject({ owner: 'W', repo: '/r', pid: process.pid });
    expect(typeof seen.host).toBe('string');
  });

  it('the reap CLI previews by default and removes with --apply', () => {
    const pool = join(lockRoot, '.lanes');
    const root = join(pool, '.admission', 'heavy');
    mkdirSync(root, { recursive: true });
    markWaiting({ lockRoot: root, owner: join(pool, 'wp', 'lane-8'), lane: '8', nowIso: '2026-09-04T15:04:58.681Z' });
    const preview = execFileSync(process.execPath, [CLI, 'reap'], { cwd: lockRoot, env: cliEnv(pool), encoding: 'utf8' });
    expect(preview).toMatch(/would reap: .*lane-8/);
    expect(listWaiting(root)).toHaveLength(1);
    execFileSync(process.execPath, [CLI, 'reap', '--apply'], { cwd: lockRoot, env: cliEnv(pool), encoding: 'utf8' });
    expect(listWaiting(root)).toHaveLength(0);
    const status = JSON.parse(execFileSync(process.execPath, [CLI, 'status'], { cwd: lockRoot, env: cliEnv(pool), encoding: 'utf8' }));
    expect(status.reaped.count).toBe(1);
  });
});

// ── #4343 (was #4076): the load-admission gate — idle%/mem-pressure PRIMARY, load1/cores a runaway backstop ──
// #4076's original single-sample `load1/cores` ratio is what #4343 replaces: our OWN fork-storm daemons
// (cards 4344/4345/4346) inflate `load1` independent of real host capacity (macOS counts runnable THREADS, and
// a burst of sub-second child processes counts for the whole burst). The cases below are exactly #4343's own
// "Test plan (each fails before the fix)" bullets.

describe('loadAdmissionDecision (pure)', () => {
  it.each([
    [[null, undefined, 40], { held: false, idlePct: 40 }],
    [[null, undefined], { held: false, idlePct: null, reason: 'no-sample' }],
    [[0], { held: true, idlePct: 0 }],
    [['40', '60'], { held: false, idlePct: 50 }],
  ])('omits nullish idle entries but preserves zero and numeric strings: %j', (idlePctSamples, expected) => {
    expect(loadAdmissionDecision({ idlePctSamples })).toMatchObject(expected);
  });

  it('admits when idle stays comfortably above the floor, pressure is normal, and load1/cores sits under the backstop (#4343 test-plan case 1)', () => {
    const d = loadAdmissionDecision({ idlePctSamples: [29.6, 31, 35, 40], pressureLevel: 1, load1: 27.7, cores: 12 });
    expect(d.held).toBe(false);
    expect(d.idlePct).toBeCloseTo(33, 5); // median of [29.6,31,35,40] sorted [29.6,31,35,40] -> (31+35)/2
    expect(d.perCore).toBeCloseTo(2.3083, 3); // well under the default backstop (4) — the whole point of raising it
  });

  it('holds once the idle MEDIAN drops below the floor — the reason names idle% (#4343 test-plan case 2)', () => {
    const d = loadAdmissionDecision({ idlePctSamples: [10, 12, 14, 30] });
    expect(d.held).toBe(true);
    expect(d.idlePct).toBe(13); // median of [10,12,14,30] sorted -> (12+14)/2
    expect(d.reason).toMatch(/idle/i);
  });

  it('holds on elevated memory pressure alone, even with comfortable idle (#4343 test-plan case 3)', () => {
    const d = loadAdmissionDecision({ idlePctSamples: [50], pressureLevel: 2 });
    expect(d.held).toBe(true);
    expect(d.reason).toMatch(/pressure/i);
  });

  it('the load1/cores BACKSTOP still holds a genuine runaway even with no idle/pressure data (#4343 test-plan case 4)', () => {
    const d = loadAdmissionDecision({ load1: 60, cores: 12 });
    expect(d.perCore).toBe(5);
    expect(d.held).toBe(true);
    expect(d.reason).toMatch(/backstop/i);
  });

  it('fails OPEN (admits) with reason no-sample when NONE of idle/pressure/load1-cores has any data (#4343 test-plan case 5, "no busy_pct samples")', () => {
    expect(loadAdmissionDecision({})).toMatchObject({ held: false, idlePct: null, pressureLevel: null, load1: null, cores: null, perCore: null, reason: 'no-sample' });
    expect(loadAdmissionDecision({ idlePctSamples: [], pressureLevel: null, load1: null, cores: null })).toMatchObject({ held: false, reason: 'no-sample' });
  });

  it('the #xupukxa incident ratio (34.95/12 ≈ 2.91) sits UNDER the new, higher backstop on its own — a HYPOTHETICAL low-idle reading alongside it demonstrates idle% would independently catch a similar saturation (no idle%-telemetry exists from that actual 2026-09-07 day to replay, so this is illustrative, not a historical replay)', () => {
    const backstopOnly = loadAdmissionDecision({ load1: 34.95, cores: 12 });
    expect(backstopOnly.backstopPerCore).toBe(DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE);
    expect(backstopOnly.held).toBe(false); // 2.91 < 4 — the backstop alone does NOT catch this incident
    // A HYPOTHETICAL low idle% alongside the SAME load1/cores reading — illustrating that idle% is a second,
    // independent detector for this class of saturation, NOT a replay of the actual (untracked) idle% that day.
    const withIdle = loadAdmissionDecision({ load1: 34.95, cores: 12, idlePctSamples: [8, 9, 10, 11] });
    expect(withIdle.held).toBe(true);
    expect(withIdle.reason).toMatch(/idle/i);
  });

  it('idle exactly AT the floor is NOT held; one hundredth below it IS — "held above, admitted at/above" contract', () => {
    expect(loadAdmissionDecision({ idlePctSamples: [15, 15, 15, 15] }).held).toBe(false);
    expect(loadAdmissionDecision({ idlePctSamples: [14.99, 14.99, 14.99, 14.99] }).held).toBe(true);
  });

  it('perCore exactly AT the backstop is NOT held; strictly over IS', () => {
    expect(loadAdmissionDecision({ load1: 48, cores: 12 }).held).toBe(false); // 48/12 = 4, not over
    expect(loadAdmissionDecision({ load1: 48.01, cores: 12 }).held).toBe(true);
  });

  it('a genuinely missing `null` load1/cores reading is never coerced to a false zero (Number(null) === 0 trap)', () => {
    // regression: an earlier draft coerced `load1`/`cores` through a bare `Number(...)`, which turns `null` into
    // `0` (a FINITE number) rather than "absent" — this would have reported `load1: 0` for "no data" and, worse,
    // could fabricate a 0/0 backstop reading instead of leaving `perCore` honestly `null`.
    const d = loadAdmissionDecision({ load1: null, cores: null });
    expect(d.load1).toBeNull();
    expect(d.cores).toBeNull();
    expect(d.perCore).toBeNull();
  });

  it('cores <= 0 is treated as no cores reading, never a divide-by-zero', () => {
    expect(loadAdmissionDecision({ load1: 20, cores: 0 }).perCore).toBeNull();
    expect(loadAdmissionDecision({ load1: 20, cores: 0 }).cores).toBeNull();
  });
});

describe('resolveLoadAdmissionMinIdlePct / resolveLoadAdmissionWindow / resolveLoadAdmissionBackstopPerCore / isLoadAdmissionOff (env resolution)', () => {
  it('resolveLoadAdmissionMinIdlePct defaults to 15 and clamps a non-positive/>100/garbage override back to the default', () => {
    expect(resolveLoadAdmissionMinIdlePct({})).toBe(DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT);
    expect(DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT).toBe(15);
    expect(resolveLoadAdmissionMinIdlePct({ [LOAD_ADMISSION_MIN_IDLE_PCT_ENV]: '0' })).toBe(DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT);
    expect(resolveLoadAdmissionMinIdlePct({ [LOAD_ADMISSION_MIN_IDLE_PCT_ENV]: '-5' })).toBe(DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT);
    expect(resolveLoadAdmissionMinIdlePct({ [LOAD_ADMISSION_MIN_IDLE_PCT_ENV]: '150' })).toBe(DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT);
    expect(resolveLoadAdmissionMinIdlePct({ [LOAD_ADMISSION_MIN_IDLE_PCT_ENV]: 'nope' })).toBe(DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT);
    expect(resolveLoadAdmissionMinIdlePct({ [LOAD_ADMISSION_MIN_IDLE_PCT_ENV]: '25' })).toBe(25);
  });

  it('resolveLoadAdmissionWindow defaults to 4 and clamps a non-integer/sub-1 override back to the default', () => {
    expect(resolveLoadAdmissionWindow({})).toBe(DEFAULT_LOAD_ADMISSION_WINDOW);
    expect(DEFAULT_LOAD_ADMISSION_WINDOW).toBe(4);
    expect(resolveLoadAdmissionWindow({ [LOAD_ADMISSION_WINDOW_ENV]: '0' })).toBe(DEFAULT_LOAD_ADMISSION_WINDOW);
    expect(resolveLoadAdmissionWindow({ [LOAD_ADMISSION_WINDOW_ENV]: '2.5' })).toBe(DEFAULT_LOAD_ADMISSION_WINDOW);
    expect(resolveLoadAdmissionWindow({ [LOAD_ADMISSION_WINDOW_ENV]: 'nope' })).toBe(DEFAULT_LOAD_ADMISSION_WINDOW);
    expect(resolveLoadAdmissionWindow({ [LOAD_ADMISSION_WINDOW_ENV]: '8' })).toBe(8);
  });

  it('resolveLoadAdmissionBackstopPerCore (the backstop ratio) defaults to 4 — #4343 raised it from the old primary threshold (1.5) — and clamps a non-positive/garbage override', () => {
    expect(resolveLoadAdmissionBackstopPerCore({})).toBe(DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE);
    expect(DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE).toBe(4);
    expect(resolveLoadAdmissionBackstopPerCore({ [LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV]: '0' })).toBe(DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE);
    expect(resolveLoadAdmissionBackstopPerCore({ [LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV]: '-1' })).toBe(DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE);
    expect(resolveLoadAdmissionBackstopPerCore({ [LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV]: 'nope' })).toBe(DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE);
    expect(resolveLoadAdmissionBackstopPerCore({ [LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV]: '6' })).toBe(6);
  });

  it('resolveLoadAdmissionMinPressureLevel defaults to 2 and clamps a sub-2/garbage override back to the default', () => {
    expect(resolveLoadAdmissionMinPressureLevel({})).toBe(DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL);
    expect(DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL).toBe(2);
    expect(resolveLoadAdmissionMinPressureLevel({ [LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV]: '1' })).toBe(DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL);
    expect(resolveLoadAdmissionMinPressureLevel({ [LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV]: '2.5' })).toBe(DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL);
    expect(resolveLoadAdmissionMinPressureLevel({ [LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV]: 'nope' })).toBe(DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL);
    expect(resolveLoadAdmissionMinPressureLevel({ [LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV]: '4' })).toBe(4);
  });

  it('isLoadAdmissionOff mirrors isAdmissionOff\'s own switch values, own env var', () => {
    expect(isLoadAdmissionOff({})).toBe(false);
    for (const v of ['off', 'OFF', '0', 'false', 'no']) expect(isLoadAdmissionOff({ [LOAD_ADMISSION_SWITCH_ENV]: v })).toBe(true);
    expect(isLoadAdmissionOff({ [LOAD_ADMISSION_SWITCH_ENV]: 'on' })).toBe(false);
  });
});

describe('loadAdmissionDecision — the mem-pressure floor is configurable, and the held idle% reading is FLOORED not rounded', () => {
  it('a raised minPressureLevel admits a pressure reading the default would have held on', () => {
    const held = loadAdmissionDecision({ idlePctSamples: [50], pressureLevel: 2 });
    expect(held.held).toBe(true);
    const admitted = loadAdmissionDecision({ idlePctSamples: [50], pressureLevel: 2, minPressureLevel: 3 });
    expect(admitted.held).toBe(false);
    expect(admitted.minPressureLevel).toBe(3);
  });

  it('a held idle% reading is FLOORED, never rounded — "cpu idle 15% (<15%)" would read as self-contradictory', () => {
    // regression: an earlier draft used Math.round, so a true 14.99% (held) displayed as "15%" next to "(<15%)",
    // which reads as though 15 were not below 15. Math.floor(x) <= x always, so this can never happen.
    const d = loadAdmissionDecision({ idlePctSamples: [14.99, 14.99, 14.99, 14.99] });
    expect(d.held).toBe(true);
    expect(d.reason).toBe('cpu idle 14% (<15%)'); // floored to 14, never rounded up to a self-contradictory "15%"
  });

  it('PRECEDENCE: when idle-low AND mem-pressure-high are BOTH true, idle wins and the reason never mentions pressure', () => {
    const d = loadAdmissionDecision({ idlePctSamples: [5, 5, 5, 5], pressureLevel: 4 });
    expect(d.held).toBe(true);
    expect(d.reason).toMatch(/idle/i);
    expect(d.reason).not.toMatch(/pressure/i);
  });

  it('PRECEDENCE: when idle-low AND the load1/cores backstop are BOTH true, idle wins and the reason never mentions the backstop', () => {
    const d = loadAdmissionDecision({ idlePctSamples: [5, 5, 5, 5], load1: 60, cores: 12 });
    expect(d.held).toBe(true);
    expect(d.reason).toMatch(/idle/i);
    expect(d.reason).not.toMatch(/backstop/i);
  });

  it('PRECEDENCE: when comfortable idle but mem-pressure-high AND the backstop are BOTH true, pressure wins and the reason never mentions the backstop', () => {
    const d = loadAdmissionDecision({ idlePctSamples: [50, 50, 50, 50], pressureLevel: 4, load1: 60, cores: 12 });
    expect(d.held).toBe(true);
    expect(d.reason).toMatch(/pressure/i);
    expect(d.reason).not.toMatch(/backstop/i);
  });
});

/** Write one host-sampler-shaped metric record — the same `{event:'metric', name, value, timestamp}` shape
 *  `telemetry-summary-io.mjs#readHostToday` filters for. */
function metricLine(name, value, timestamp) {
  return JSON.stringify({ event: 'metric', name, value, timestamp }) + '\n';
}

/** Write one `host.cpu.busy_pct` record carrying `idle_pct` as an ATTRIBUTE of the same sample — the shape
 *  `telemetry.mjs`'s own `METRIC_NAMES` comment documents for this metric (`value` IS busy_pct, `idle_pct`/
 *  `user_pct`/`sys_pct`/... ride as `attributes` of that SAME record, never a separate metric name), and the
 *  same shape the card's own live evidence-day capture (`load-status --json` returning a real `idle_pct`
 *  reading) confirms end to end. The ACTUAL producer (`host-sampler.mjs`) is a host-level daemon outside this
 *  repo, not something a unit test here can invoke — `telemetry.mjs`'s comment is the in-repo contract for its
 *  wire shape, and this fixture mirrors that contract rather than asserting against the daemon directly.
 *  `busyValue` defaults to the arithmetic complement so a fixture with no explicit busy value is still
 *  internally consistent. */
function busyLine(idlePct, timestamp, busyValue = 100 - idlePct) {
  return JSON.stringify({ event: 'metric', name: 'host.cpu.busy_pct', value: busyValue, timestamp, attributes: { idle_pct: idlePct } }) + '\n';
}

describe('readLatestLoad + resolveLoadAdmission (real fixture fs, injectable root — #4343)', () => {
  let telemetryRoot;
  let dayKey;
  const NOW = new Date('2026-09-25T13:00:00.000Z');

  beforeEach(() => {
    telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-test-'));
    dayKey = utcDayKey(NOW);
  });
  afterEach(() => { rmSync(telemetryRoot, { recursive: true, force: true }); });

  it('reads idle_pct off the busy_pct ATTRIBUTE, truncated to the last `window` samples by timestamp — an older 5th sample outside the window is excluded', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [
      busyLine(5, '2026-09-25T12:58:30.000Z'), // oldest — outside a window of 4
      busyLine(40, '2026-09-25T12:59:00.000Z'),
      busyLine(41, '2026-09-25T12:59:30.000Z'),
      busyLine(42, '2026-09-25T13:00:00.000Z'),
      busyLine(43, '2026-09-25T13:00:30.000Z'),
      metricLine('host.cpu.load1', 20, '2026-09-25T13:00:30.000Z'),
      metricLine('host.cpu.count', 12, '2026-09-25T13:00:00.000Z'),
      metricLine('host.mem.pressure_level', 1, '2026-09-25T13:00:00.000Z'),
    ].join(''));
    const r = readLatestLoad({ root: telemetryRoot, now: NOW, window: 4 });
    expect(r.idlePctSamples.slice().sort((a, b) => a - b)).toEqual([40, 41, 42, 43]); // the 5th (oldest, idle=5) is excluded
    expect(r.load1).toBe(20);
    expect(r.cores).toBe(12);
    expect(r.pressureLevel).toBe(1);
  });

  it('load1 is ALSO the MEDIAN over the window, never a single instantaneous sample — a brief fork-storm spike surrounded by normal readings must not alone cross the backstop (#4343 review finding)', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [
      metricLine('host.cpu.load1', 8, '2026-09-25T12:59:00.000Z'),
      metricLine('host.cpu.load1', 60, '2026-09-25T12:59:30.000Z'), // one brief burst — a fork storm, not a real cascade
      metricLine('host.cpu.load1', 9, '2026-09-25T13:00:00.000Z'),
      metricLine('host.cpu.load1', 10, '2026-09-25T13:00:30.000Z'),
      metricLine('host.cpu.count', 12, '2026-09-25T13:00:30.000Z'),
    ].join(''));
    const r = readLatestLoad({ root: telemetryRoot, now: NOW, window: 4 });
    expect(r.load1).toBe(9.5); // median of [8,60,9,10] sorted [8,9,10,60] -> (9+10)/2
    const d = loadAdmissionDecision({ load1: r.load1, cores: r.cores });
    expect(d.held).toBe(false); // 9.5/12 ≈ 0.79 — well under the backstop; the single 60 spike never surfaces alone
  });

  it('a non-positive/non-integer `window` falls back to the documented default, never reading as "no windowing" (an unbounded whole-day read)', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [
      busyLine(5, '2026-09-25T12:58:30.000Z'), // outside the DEFAULT window (4) — must still be excluded
      busyLine(40, '2026-09-25T12:59:00.000Z'),
      busyLine(41, '2026-09-25T12:59:30.000Z'),
      busyLine(42, '2026-09-25T13:00:00.000Z'),
      busyLine(43, '2026-09-25T13:00:30.000Z'),
    ].join(''));
    for (const badWindow of [0, -1, 2.5, NaN]) {
      const r = readLatestLoad({ root: telemetryRoot, now: NOW, window: badWindow });
      expect(r.idlePctSamples.slice().sort((a, b) => a - b)).toEqual([40, 41, 42, 43]);
    }
  });

  it('falls back to 100 - value when a busy_pct record carries no idle_pct attribute (an older sampler build)', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [metricLine('host.cpu.busy_pct', 63, '2026-09-25T13:00:00.000Z')].join(''));
    expect(readLatestLoad({ root: telemetryRoot, now: NOW }).idlePctSamples).toEqual([37]);
  });

  it('reads `attributes.idle_pct` itself, never just the `100 - value` arithmetic complement — a record whose attribute deliberately DISAGREES with its own value proves the attribute wins', () => {
    // regression: every OTHER fixture in this file sets `busyLine`'s busyValue to its own default (`100 -
    // idlePct`), so the attribute path and the fallback path always agreed and no test could tell which one the
    // code actually used. Here `value` (busy_pct=70, i.e. "30% idle" if you only look at `value`) deliberately
    // disagrees with `attributes.idle_pct` (5) — only reading the ATTRIBUTE, not deriving from `value`, explains
    // the result.
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [busyLine(5, '2026-09-25T13:00:00.000Z', /* busyValue */ 70)].join(''));
    expect(readLatestLoad({ root: telemetryRoot, now: NOW }).idlePctSamples).toEqual([5]);
  });

  it.each([
    [null, 63, [37]],
    [null, null, []],
    [undefined, null, []],
    [null, undefined, []],
    [undefined, undefined, []],
    [0, 63, [0]],
    [null, 0, [100]],
    ['40', 63, [40]],
    [null, '63', [37]],
    ['invalid', 63, [37]],
    [null, 'invalid', []],
  ])('handles nullish idle/busy readings through the reader and admission path: idle=%j busy=%j', (idlePct, busy, expected) => {
    // Build directly: busyLine's default argument would replace an explicitly missing busy value.
    writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), JSON.stringify({
      event: 'metric', name: 'host.cpu.busy_pct', timestamp: NOW.toISOString(),
      value: busy, attributes: { idle_pct: idlePct },
    }) + '\n');
    expect(readLatestLoad({ root: telemetryRoot, now: NOW }).idlePctSamples).toEqual(expected);
    const decision = resolveLoadAdmission({ env: {}, root: telemetryRoot, now: NOW });
    expect(decision).toMatchObject({ idlePct: expected[0] ?? null, held: expected[0] === 0 });
    if (!expected.length) expect(decision.reason).toBe('no-sample');
  });

  it('host.mem.pressure_level reads the LATEST sample only, never a median across the window — unlike idle_pct, an earlier "warn" reading must not linger once a later sample says "normal" again', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [
      metricLine('host.mem.pressure_level', 2, '2026-09-25T12:59:00.000Z'),
      metricLine('host.mem.pressure_level', 2, '2026-09-25T12:59:30.000Z'), // median would still be "warn"
      metricLine('host.mem.pressure_level', 1, '2026-09-25T13:00:00.000Z'), // back to "normal" — this is the latest
    ].join(''));
    expect(readLatestLoad({ root: telemetryRoot, now: NOW }).pressureLevel).toBe(1);
    expect(resolveLoadAdmission({ env: {}, root: telemetryRoot, now: NOW })).toMatchObject({
      pressureLevel: 1, minPressureLevel: 2, held: false,
    });
  });

  it('a missing day file reads as all-null/empty — not a read error', () => {
    expect(readLatestLoad({ root: telemetryRoot, now: NOW })).toEqual({ idlePctSamples: [], pressureLevel: null, load1: null, cores: null });
  });

  it('THE LIVE BEFORE/AFTER CONTRACT: the SAME real sampled idle% reading is admitted under one floor and held under a stricter one — proves the gate reacts to the actual numbers, not a canned verdict', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [
      busyLine(31, '2026-09-25T12:59:00.000Z'),
      busyLine(30, '2026-09-25T12:59:30.000Z'),
      busyLine(33, '2026-09-25T13:00:00.000Z'),
      busyLine(32, '2026-09-25T13:00:30.000Z'),
    ].join(''));
    const before = resolveLoadAdmission({ env: {}, root: telemetryRoot, now: NOW }); // default floor (15%)
    expect(before).toMatchObject({ held: false, idlePct: 31.5 }); // median of [30,31,32,33] -> (31+32)/2
    // AFTER: the identical real reading, only the floor config changed (a machine dialing WE_LOAD_ADMISSION_
    // MIN_IDLE_PCT up past today's own real idle%) — now HELD, off the exact same numbers.
    const after = resolveLoadAdmission({ env: { [LOAD_ADMISSION_MIN_IDLE_PCT_ENV]: '40' }, root: telemetryRoot, now: NOW });
    expect(after).toMatchObject({ held: true, idlePct: 31.5, minIdlePct: 40 });
  });

  it('a DIRECT JS-caller param (not just a CLI flag) is ALSO validated through the resolver\'s own clamp — a NaN/out-of-range param falls back to the default instead of bypassing the check', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [busyLine(10, '2026-09-25T13:00:00.000Z')].join(''));
    // regression: an earlier draft's `param ?? resolver(env)` let a caller-supplied NaN (or an out-of-range-but-
    // finite value like `0`) pass straight through unclamped — idle=10 is below the default floor (15), so a
    // correctly-falling-back NaN/0 override must still HOLD; a bypassed one would silently admit instead.
    for (const badMinIdlePct of [NaN, 0, -5, 200]) {
      const r = resolveLoadAdmission({ env: {}, minIdlePct: badMinIdlePct, root: telemetryRoot, now: NOW });
      expect(r).toMatchObject({ held: true, idlePct: 10, minIdlePct: DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT });
    }
    for (const badBackstop of [NaN, 0, -1]) {
      const r = resolveLoadAdmission({ env: {}, backstopPerCore: badBackstop, root: telemetryRoot, now: NOW });
      expect(r.backstopPerCore).toBe(DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE);
    }
  });

  it('a DIRECT JS-caller minPressureLevel/window param is ALSO validated — the same guarantee proven above for minIdlePct/backstopPerCore, closing the last two knobs', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [metricLine('host.mem.pressure_level', 2, '2026-09-25T13:00:00.000Z')].join(''));
    for (const badMinPressureLevel of [NaN, 1, 0, -1]) {
      const r = resolveLoadAdmission({ env: {}, minPressureLevel: badMinPressureLevel, root: telemetryRoot, now: NOW });
      // pressure=2 held against the DEFAULT floor (2) — a bypassed bad override (e.g. 1) would instead admit.
      expect(r).toMatchObject({ held: true, pressureLevel: 2, minPressureLevel: DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL });
    }
    writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [
      busyLine(5, '2026-09-25T12:58:30.000Z'), // oldest — outside the DEFAULT window (4); a passthrough NaN/0
      // `window` would read ALL 5 samples instead (via `readLatestLoad`'s own `window > 0` guard, absent the
      // fallback), dragging this outlier back into the median.
      busyLine(40, '2026-09-25T12:59:00.000Z'),
      busyLine(41, '2026-09-25T12:59:30.000Z'),
      busyLine(42, '2026-09-25T13:00:00.000Z'),
      busyLine(43, '2026-09-25T13:00:30.000Z'),
    ].join(''));
    for (const badWindow of [NaN, 0, -1, 2.5]) {
      const r = resolveLoadAdmission({ env: {}, window: badWindow, root: telemetryRoot, now: NOW });
      // Falls back to the DEFAULT window (4) — median of [40,41,42,43], the oldest outlier (5) excluded.
      expect(r.idlePct).toBeCloseTo(41.5, 5);
    }
  });

  it('WE_LOAD_ADMISSION=off bypasses the read entirely (admits, no fixture file needed)', () => {
    const r = resolveLoadAdmission({ env: { [LOAD_ADMISSION_SWITCH_ENV]: 'off' }, root: telemetryRoot, now: NOW });
    expect(r).toEqual({ held: false, idlePct: null, minIdlePct: DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT, pressureLevel: null, minPressureLevel: DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL, load1: null, cores: null, perCore: null, backstopPerCore: DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE, bypassed: 'off' });
  });

  it('a knob param can never arm/disarm the off/CI bypass switches — the switches read the REAL env only, ignoring any param passed alongside them', () => {
    const file = join(telemetryRoot, `${dayKey}.jsonl`);
    writeFileSync(file, [busyLine(5, '2026-09-25T13:00:00.000Z')].join('')); // idle=5 — would HOLD if the bypass did not fire
    const offDespiteKnob = resolveLoadAdmission({ env: { [LOAD_ADMISSION_SWITCH_ENV]: 'off' }, minIdlePct: 50, root: telemetryRoot, now: NOW });
    expect(offDespiteKnob).toMatchObject({ held: false, bypassed: 'off' });
    const ciDespiteKnob = resolveLoadAdmission({ env: { CI: 'true' }, minIdlePct: 50, root: telemetryRoot, now: NOW });
    expect(ciDespiteKnob).toMatchObject({ held: false, bypassed: 'ci' });
  });

  it('CI=true bypasses the read entirely (admits — a CI runner is its own machine)', () => {
    const r = resolveLoadAdmission({ env: { CI: 'true' }, root: telemetryRoot, now: NOW });
    expect(r.held).toBe(false);
    expect(r.bypassed).toBe('ci');
  });
});

describe('the `load-status` CLI mode as a real process (#4343)', () => {
  it.each([
    [null, 1, null, 'admitted — mem pressure 1 (threshold 2)'],
    [null, 2, null, 'HELD — mem pressure 2 (>=2)'],
    [40, 1, null, 'admitted — cpu idle 40.0% (min 15%)'],
    [null, 1, 4, 'admitted — mem pressure 1 (threshold 2)'],
    [40, 2, 4, 'HELD — mem pressure 2 (>=2)'],
    [null, 1, 20, 'HELD — load1 20.00/4 cores (5.00 > backstop 4)'],
  ])('reports pressure and preserves held/idle/backstop precedence: idle=%j pressure=%j load1=%j', (idle, pressure, load1, text) => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const now = new Date();
      const timestamp = now.toISOString();
      const records = [metricLine('host.mem.pressure_level', pressure, timestamp)];
      if (idle != null) records.push(busyLine(idle, timestamp));
      if (load1 != null) records.push(metricLine('host.cpu.load1', load1, timestamp), metricLine('host.cpu.count', 4, timestamp));
      writeFileSync(join(telemetryRoot, `${utcDayKey(now)}.jsonl`), records.join(''));
      const env = { ...process.env };
      for (const key of ['CI', LOAD_ADMISSION_SWITCH_ENV, LOAD_ADMISSION_MIN_IDLE_PCT_ENV,
        LOAD_ADMISSION_MIN_PRESSURE_LEVEL_ENV, LOAD_ADMISSION_BACKSTOP_PER_CORE_ENV, LOAD_ADMISSION_WINDOW_ENV]) delete env[key];
      const args = [CLI, 'load-status', `--load-root=${telemetryRoot}`];
      expect(execFileSync(process.execPath, args, { encoding: 'utf8', env })).toBe(`${text}\n`);
      const decision = JSON.parse(execFileSync(process.execPath, [...args, '--json'], { encoding: 'utf8', env }));
      expect(decision).toMatchObject({
        held: text.startsWith('HELD'), pressureLevel: pressure, minPressureLevel: 2,
        idlePct: idle, perCore: load1 == null ? null : load1 / 4,
      });
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('prints the admitted/held verdict as JSON, driven by --load-root + --min-idle-pct (the idle% path)', () => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const dayKey = utcDayKey(new Date());
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [busyLine(20, new Date().toISOString())].join(''));
      const env = { ...process.env }; delete env.CI; delete env.WE_LOAD_ADMISSION;
      const admitted = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--min-idle-pct=10'], { encoding: 'utf8', env }));
      expect(admitted).toMatchObject({ held: false, idlePct: 20, minIdlePct: 10 });
      const held = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--min-idle-pct=25'], { encoding: 'utf8', env }));
      expect(held).toMatchObject({ held: true, idlePct: 20, minIdlePct: 25, reason: expect.stringMatching(/idle/i) });
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('--window= round-trips through the real CLI child process with a VALID value — narrowing the window to the single latest sample flips the verdict', () => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const dayKey = utcDayKey(new Date());
      const base = Date.parse('2026-09-25T13:00:00.000Z');
      // Three OLD, low-idle samples followed by one recent, comfortable one.
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [
        busyLine(8, new Date(base - 90_000).toISOString()),
        busyLine(8, new Date(base - 60_000).toISOString()),
        busyLine(8, new Date(base - 30_000).toISOString()),
        busyLine(50, new Date(base).toISOString()),
      ].join(''));
      const env = { ...process.env }; delete env.CI; delete env.WE_LOAD_ADMISSION;
      // window=4 (the default): median of [8,8,8,50] is 8 — below the default 15% floor — HELD.
      const wide = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--window=4'], { encoding: 'utf8', env }));
      expect(wide).toMatchObject({ held: true, idlePct: 8 });
      // window=1: the flag actually narrowed the read to ONLY the latest sample (50) — now ADMITTED.
      const narrow = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--window=1'], { encoding: 'utf8', env }));
      expect(narrow).toMatchObject({ held: false, idlePct: 50 });
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('the load1/cores BACKSTOP still fires via the CLI when there is no idle/pressure sample at all', () => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const dayKey = utcDayKey(new Date());
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [
        metricLine('host.cpu.load1', 10, new Date().toISOString()),
        metricLine('host.cpu.count', 4, new Date().toISOString()),
      ].join(''));
      const env = { ...process.env }; delete env.CI; delete env.WE_LOAD_ADMISSION;
      const admitted = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--max-per-core=3'], { encoding: 'utf8', env }));
      expect(admitted).toMatchObject({ held: false, load1: 10, cores: 4, perCore: 2.5, backstopPerCore: 3 });
      const held = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--max-per-core=2'], { encoding: 'utf8', env }));
      expect(held).toMatchObject({ held: true, load1: 10, cores: 4, perCore: 2.5, backstopPerCore: 2, reason: expect.stringMatching(/backstop/i) });
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('a GARBAGE override value falls back to the documented default instead of silently disabling the check (NaN bypass regression)', () => {
    // regression: `Number('garbage')` is `NaN`, which is neither `null` nor `undefined` — a naive `flagValue ??
    // resolver(env)` would pass `NaN` straight through as if it were a real override, and `x < NaN` / `NaN > 0`
    // are always `false`, which silently disables the idle-check / widens the window to the whole day instead
    // of falling back to the default the way an OMITTED flag does.
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const dayKey = utcDayKey(new Date());
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [busyLine(10, new Date().toISOString())].join(''));
      const env = { ...process.env }; delete env.CI; delete env.WE_LOAD_ADMISSION;
      const r = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--min-idle-pct=garbage', '--window=garbage', '--max-per-core=garbage'], { encoding: 'utf8', env }));
      // idle=10 is below the DEFAULT floor (15) — a garbage override must fall back to it, not disable the check.
      expect(r).toMatchObject({ held: true, idlePct: 10, minIdlePct: DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT, backstopPerCore: DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE });
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('an OUT-OF-RANGE-but-finite override (0, or 1 for pressure) also falls back to the default, matching what the resolver itself would reject from an env var', () => {
    // regression: `0`/`1` are FINITE, so a bare `Number.isFinite` guard alone is not enough — each override must
    // be re-checked against the SAME predicate its own resolver applies, or an out-of-range CLI value would
    // silently disable the check (`idlePct < 0` never holds) instead of falling back the way env does.
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const dayKey = utcDayKey(new Date());
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [busyLine(10, new Date().toISOString())].join(''));
      const env = { ...process.env }; delete env.CI; delete env.WE_LOAD_ADMISSION;
      const r = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`, '--min-idle-pct=0', '--min-pressure-level=1', '--max-per-core=0'], { encoding: 'utf8', env }));
      expect(r).toMatchObject({ held: true, idlePct: 10, minIdlePct: DEFAULT_LOAD_ADMISSION_MIN_IDLE_PCT, minPressureLevel: DEFAULT_LOAD_ADMISSION_MIN_PRESSURE_LEVEL, backstopPerCore: DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE });
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('the OLD pre-#4343 env var name (WE_LOAD_ADMISSION_MAX_PER_CORE) is INERT for the backstop — proves the rename actually took, never silently reinterpreting an old low-value override as the new, much-higher backstop', () => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const dayKey = utcDayKey(new Date());
      // A comfortably-idle, no-pressure reading with a load1/cores ratio (2.5) that sits BETWEEN the old primary
      // threshold (1.5) and the new backstop default (4) — held under the old semantics, admitted under the new.
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [
        busyLine(50, new Date().toISOString()),
        metricLine('host.cpu.load1', 10, new Date().toISOString()),
        metricLine('host.cpu.count', 4, new Date().toISOString()),
      ].join(''));
      const env = { ...process.env, WE_LOAD_ADMISSION_MAX_PER_CORE: '1.5' }; // the OLD name, an OLD-style low value
      delete env.CI; delete env.WE_LOAD_ADMISSION;
      const r = JSON.parse(execFileSync(process.execPath, [CLI, 'load-status', '--json', `--load-root=${telemetryRoot}`], { encoding: 'utf8', env }));
      expect(r).toMatchObject({ held: false, backstopPerCore: DEFAULT_LOAD_ADMISSION_BACKSTOP_PER_CORE, perCore: 2.5 }); // NOT held — the old var never reached the backstop
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });

  it('the PLAIN-TEXT (non --json) mode reports the real reading, in the idle → backstop → no-sample priority — never a flat "no sample" when a load1/cores reading exists and was merely admitted', () => {
    const telemetryRoot = mkdtempSync(join(tmpdir(), 'load-admission-cli-test-'));
    try {
      const dayKey = utcDayKey(new Date());
      const env = { ...process.env }; delete env.CI; delete env.WE_LOAD_ADMISSION;

      // 1. idle-held: the reason string flows straight through.
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [busyLine(5, new Date().toISOString())].join(''));
      const idleHeld = execFileSync(process.execPath, [CLI, 'load-status', `--load-root=${telemetryRoot}`], { encoding: 'utf8', env });
      expect(idleHeld).toMatch(/^HELD — cpu idle 5% \(<15%\)/);

      // 2. no idle/pressure sample, but a real load1/cores reading exists and is ADMITTED — must report that
      //    reading, never a flat "no sample" (the #4343 review finding this test locks in).
      writeFileSync(join(telemetryRoot, `${dayKey}.jsonl`), [
        metricLine('host.cpu.load1', 4, new Date().toISOString()),
        metricLine('host.cpu.count', 4, new Date().toISOString()),
      ].join(''));
      const admittedBackstop = execFileSync(process.execPath, [CLI, 'load-status', `--load-root=${telemetryRoot}`], { encoding: 'utf8', env });
      expect(admittedBackstop).toMatch(/^admitted — load1 4\.00\/4 cores \(1\.00, backstop 4\)/);

      // 3. genuinely nothing sampled at all — the true "no sample" case.
      const emptyRoot = join(telemetryRoot, 'empty');
      mkdirSync(emptyRoot);
      const noSample = execFileSync(process.execPath, [CLI, 'load-status', `--load-root=${emptyRoot}`], { encoding: 'utf8', env });
      expect(noSample).toMatch(/^admitted — no sample\n$/);
    } finally {
      rmSync(telemetryRoot, { recursive: true, force: true });
    }
  });
});

// ── admission-no-fail-open: one cap source, a queue timeout DEFERS, a demand-scaled fast lane ───────────────
// Live 2026-10-10 13:30 ET: 6 `node (vitest)` processes against "cap 2 + 1 fast". The verify daemon's plist set
// WE_HEAVY_ADMISSION_CAP=4 / FAST_SLOTS=2 (six slots), every agent session read 2 + 1 (three slots): each side
// scanned a different slot range, so the daemon's slot-3…5 holders were invisible to the rest of the host.

describe('resolveAdmissionPolicy — the one cascade every process reads (standard → platform → tool → env)', () => {
  it('the standard: cap 2, 1 fast slot, a queue timeout DEFERS, no fast-lane scaling', () => {
    const p = resolveAdmissionPolicy({});
    expect(p.settings).toEqual({ cap: 2, fastSlots: 1, onTimeout: 'defer',
      fastScale: { maxSlots: null, minShortWaiters: 3, minShortShare: 0.6, minCpuIdlePct: 30, maxMemPressureLevel: 1 } });
    expect(p.settings).toEqual(ADMISSION_POLICY_STANDARD);
    expect(p.sources).toMatchObject({ cap: 'standard', fastSlots: 'standard', onTimeout: 'standard' });
  });

  it('layers platform under tool, and names each leaf\'s source', () => {
    const p = resolveAdmissionPolicy({ platform: { cap: 3, onTimeout: 'run' }, tool: { cap: 4, fastScale: { maxSlots: 3 } } });
    expect(p.settings).toMatchObject({ cap: 4, fastSlots: 1, onTimeout: 'run', fastScale: { maxSlots: 3 } });
    expect(p.sources).toMatchObject({ cap: 'tool', onTimeout: 'platform', 'fastScale.maxSlots': 'tool', fastSlots: 'standard' });
  });

  it('IGNORES a per-process cap / fast-slot env on the shared host pool and names the divergence', () => {
    const p = resolveAdmissionPolicy({ env: { WE_HEAVY_ADMISSION_CAP: '4', WE_HEAVY_ADMISSION_FAST_SLOTS: '2' } });
    expect(p.settings).toMatchObject({ cap: 2, fastSlots: 1 });
    expect(p.ignored.join('\n')).toMatch(/WE_HEAVY_ADMISSION_CAP=4/);
    expect(p.ignored.join('\n')).toMatch(/WE_HEAVY_ADMISSION_FAST_SLOTS=2/);
  });

  it('honours the cap env for a PRIVATE pool (LANE_POOL_ROOT set: a test or soak sandbox no other process shares)', () => {
    const p = resolveAdmissionPolicy({ env: { LANE_POOL_ROOT: '/tmp/private-pool', WE_HEAVY_ADMISSION_CAP: '5', WE_HEAVY_ADMISSION_FAST_SLOTS: '0' } });
    expect(p.settings).toMatchObject({ cap: 5, fastSlots: 0 });
    expect(p.sources.cap).toBe('env WE_HEAVY_ADMISSION_CAP');
    expect(p.ignored).toEqual([]);
  });

  it('onTimeout is per-caller behaviour, so its env is honoured anywhere; an invalid value never overrides', () => {
    expect(resolveAdmissionPolicy({ env: { WE_HEAVY_ADMISSION_ON_TIMEOUT: 'run' } }).settings.onTimeout).toBe('run');
    const bad = resolveAdmissionPolicy({ env: { WE_HEAVY_ADMISSION_ON_TIMEOUT: 'maybe' }, platform: { cap: 0 } });
    expect(bad.settings).toMatchObject({ onTimeout: 'defer', cap: 2 });
    expect(bad.invalid.join('\n')).toMatch(/WE_HEAVY_ADMISSION_ON_TIMEOUT/);
    expect(bad.invalid.join('\n')).toMatch(/platform\.cap/);
  });

  it('formatAdmissionPolicy names every value with its source (the logged line)', () => {
    const line = formatAdmissionPolicy(resolveAdmissionPolicy({ env: { WE_HEAVY_ADMISSION_CAP: '4' } }));
    expect(line).toMatch(/cap=2 \(standard\)/);
    expect(line).toMatch(/onTimeout=defer \(standard\)/);
    expect(line).toMatch(/ignored: .*WE_HEAVY_ADMISSION_CAP=4/);
  });
});

describe('resolveCap / resolveFastSlots — every process on the host pool agrees (the live divergence)', () => {
  let prefs;
  beforeEach(() => { prefs = join(lockRoot, 'platform-preferences.json'); });
  const daemonEnv = () => ({ WE_PLATFORM_PREFERENCES: prefs, WE_HEAVY_ADMISSION_CAP: '4', WE_HEAVY_ADMISSION_FAST_SLOTS: '2' });
  const sessionEnv = () => ({ WE_PLATFORM_PREFERENCES: prefs, WE_HEAVY_ADMISSION_CAP: '2' });

  it('a daemon with the plist env and an agent session resolve the SAME cap and fast slots', () => {
    expect(resolveCap(daemonEnv())).toBe(resolveCap(sessionEnv()));
    expect(resolveFastSlots(daemonEnv())).toBe(resolveFastSlots(sessionEnv()));
    expect(resolveCap(daemonEnv())).toBe(DEFAULT_ADMISSION_CAP);
  });

  it('the host-wide platform preference moves every process together', () => {
    writeFileSync(prefs, JSON.stringify({ heavyAdmission: { cap: 3, fastSlots: 2 } }));
    expect([resolveCap(daemonEnv()), resolveCap(sessionEnv())]).toEqual([3, 3]);
    expect([resolveFastSlots(daemonEnv()), resolveFastSlots(sessionEnv())]).toEqual([2, 2]);
  });

  it('a private pool keeps its own env cap (tests and soak sandboxes)', () => {
    expect(resolveCap({ WE_PLATFORM_PREFERENCES: prefs, LANE_POOL_ROOT: lockRoot, WE_HEAVY_ADMISSION_CAP: '5' })).toBe(5);
  });
});

describe('resolveEffectiveFastSlots — the fast lane scales with short-kind demand when the resource service allows', () => {
  const NOW = T0;
  const fresh = (idlePct, pressureLevel = 1) => ({ sampledAt: iso(NOW - 5_000), freshUntil: iso(NOW + 25_000), cpu: { idlePct }, memory: { pressureLevel } });
  const waiters = (files, full) => [...Array(files).fill({ kind: 'files' }), ...Array(full).fill({ kind: 'full' })];
  const scaled = (over = {}) => ({ ...ADMISSION_POLICY_STANDARD, fastScale: { ...ADMISSION_POLICY_STANDARD.fastScale, maxSlots: 3, ...over } });

  it('no scaling by default (maxSlots null): the configured fast slots', () => {
    expect(resolveEffectiveFastSlots({ policy: ADMISSION_POLICY_STANDARD, waiting: waiters(10, 0), snapshot: fresh(90), nowMs: NOW })).toBe(1);
  });
  it('scales up to maxSlots when short waiters dominate and CPU / memory allow', () => {
    expect(resolveEffectiveFastSlots({ policy: scaled(), waiting: waiters(4, 1), snapshot: fresh(50), nowMs: NOW })).toBe(3);
  });
  it.each([
    ['CPU too busy', waiters(4, 1), fresh(10)],
    ['memory pressure', waiters(4, 1), fresh(50, 2)],
    ['short waiters do not dominate', waiters(2, 3), fresh(50)],
    ['too few short waiters', waiters(2, 0), fresh(50)],
    ['no resource snapshot', waiters(4, 1), null],
    ['a stale resource snapshot', waiters(4, 1), { ...fresh(50), freshUntil: iso(NOW - 1) }],
  ])('stays at the configured fast slots: %s', (_why, waiting, snapshot) => {
    expect(resolveEffectiveFastSlots({ policy: scaled(), waiting, snapshot, nowMs: NOW })).toBe(1);
  });
  it('resolveSlotSpan covers every slot a scaled fast lane may hand out (what status / release must scan)', () => {
    expect(resolveSlotSpan(ADMISSION_POLICY_STANDARD)).toBe(3);
    expect(resolveSlotSpan(scaled())).toBe(5);
  });
});

describe('acquireSlotBlocking — a queue timeout DEFERS, never runs unslotted (admission-no-fail-open)', () => {
  const holdLive = () => tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
  const policy = (onTimeout) => ({ settings: { ...ADMISSION_POLICY_STANDARD, onTimeout }, sources: { onTimeout: 'tool' }, invalid: [], ignored: [] });

  it('a caller that can defer gets {deferred:true} at the ceiling, with a logged reason and no "proceeding unslotted"', async () => {
    holdLive();
    let clock = T0; const logs = [];
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'B', pollMs: 1000, ceilingMs: 3000, canDefer: true, policy: policy('defer'),
      log: (m) => logs.push(m), now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(r).toMatchObject({ ok: false, slot: null, timedOut: true, ceilingHit: true, deferred: true });
    expect(logs.join('')).toMatch(/admission-deferred/);
    expect(logs.join('')).toMatch(/onTimeout=defer \(tool\)/);
    expect(logs.join('')).not.toMatch(/proceeding unslotted/);
    expect(listWaiting(lockRoot)).toHaveLength(0);
  });

  it('a caller that cannot defer (no deferred handling yet) keeps WAITING past the ceiling and then gets a real slot', async () => {
    holdLive();
    let clock = T0; let polls = 0; const logs = [];
    const sleep = async (ms) => { clock += ms; polls += 1; if (polls === 8) releaseOwnedSlot({ lockRoot, cap: 1, owner: 'HOLDER' }); };
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'B', pollMs: 1000, ceilingMs: 3000, policy: policy('defer'),
      log: (m) => logs.push(m), now: () => clock, sleep });
    expect(r).toMatchObject({ ok: true, slot: 0 });
    expect(r.waitedMs).toBeGreaterThan(3000);
    expect(logs.join('')).not.toMatch(/proceeding unslotted/);
    expect(logs.join('')).toMatch(/still queued past the .* ceiling/);
  });

  it('onTimeout=run keeps the old fail-open, naming the setting\'s source', async () => {
    holdLive();
    let clock = T0; const logs = [];
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'B', pollMs: 1000, ceilingMs: 3000, canDefer: true, policy: policy('run'),
      log: (m) => logs.push(m), now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(r).toMatchObject({ ok: false, timedOut: true, ceilingHit: true });
    expect(r.deferred).toBeUndefined();
    expect(logs.join('')).toMatch(/proceeding unslotted.*onTimeout=run \(tool\)/s);
  });

  it('a provably dead holder at the ceiling is RECLAIMED — a real slot, not a deferral', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0), pid: 999999 });
    let clock = T0 + 10_000;
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'B', pollMs: 1000, ceilingMs: 0, canDefer: true, policy: policy('defer'),
      now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(r).toMatchObject({ ok: true, slot: 0 });
  });

  it('takes a demand-scaled fast slot when the resource service allows it, and release finds it', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'H0', nowMs: T0, nowIso: iso(T0), slots: [0] });
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'H1', nowMs: T0, nowIso: iso(T0), slots: [1] });
    const scaledPolicy = { settings: { ...ADMISSION_POLICY_STANDARD, cap: 1, fastSlots: 1,
      fastScale: { ...ADMISSION_POLICY_STANDARD.fastScale, maxSlots: 2, minShortWaiters: 1, minShortShare: 0.5 } }, sources: {}, invalid: [], ignored: [] };
    const snapshot = { sampledAt: iso(T0), freshUntil: iso(T0 + 30_000), cpu: { idlePct: 80 }, memory: { pressureLevel: 1 } };
    const r = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'B', kind: 'files', pollMs: 1000, ceilingMs: 60_000, canDefer: true,
      policy: scaledPolicy, readResourceSnapshot: () => snapshot, now: () => T0, sleep: async () => { throw new Error('must not wait'); } });
    expect(r).toMatchObject({ ok: true, slot: 2 });
    expect(releaseOwnedSlot({ lockRoot, cap: 1, owner: 'B', fastSlots: resolveSlotSpan(scaledPolicy.settings) - 1 })).toMatchObject({ released: true, slot: 2 });
  });
});

describe('runUnderAdmission + the CLI — a deferred admission does NOT run the command', () => {
  it('runUnderAdmission returns ADMISSION_DEFERRED_EXIT and never execs on a deferral', async () => {
    tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0, nowIso: iso(T0) });
    let clock = T0; const calls = []; const logs = [];
    const r = await runUnderAdmission({ lockRoot, cap: 1, owner: 'B', command: 'echo hi', ceilingMs: 3000,
      policy: { settings: { ...ADMISSION_POLICY_STANDARD }, sources: { onTimeout: 'standard' }, invalid: [], ignored: [] },
      exec: (cmd) => calls.push(cmd), log: (m) => logs.push(m), now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(ADMISSION_DEFERRED_EXIT).toBe(75);
    expect(r.exitCode).toBe(ADMISSION_DEFERRED_EXIT);
    expect(r.admission.deferred).toBe(true);
    expect(calls).toEqual([]);
    expect(logs.join('')).not.toMatch(/proceeding unslotted/);
  });

  it('the `run` CLI exits 75 without running the command when the queue times out behind a live holder', () => {
    const pool = join(lockRoot, '.lanes');
    const root = join(pool, '.admission', 'heavy');
    mkdirSync(root, { recursive: true });
    tryAcquireSlot({ lockRoot: root, cap: 1, owner: 'HOLDER', nowMs: Date.now(), nowIso: new Date().toISOString() }); // this live test process
    const r = spawnSync(process.execPath, [CLI, 'run', '--cap=1', '--ceiling-ms=1500', '--', process.execPath, '-e', 'process.stdout.write("ran")'],
      { cwd: lockRoot, env: cliEnv(pool, { WE_HEAVY_ADMISSION_FAST_SLOTS: '0' }), encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(75);
    expect(r.stdout).not.toMatch(/ran/);
    expect(r.stderr).toMatch(/admission-deferred/);
    expect(r.stderr).not.toMatch(/proceeding unslotted/);
  }, 30_000);

  it('the `acquire` CLI exits 75 on a deferral (it no longer reports success-to-proceed)', () => {
    const pool = join(lockRoot, '.lanes');
    const root = join(pool, '.admission', 'heavy');
    mkdirSync(root, { recursive: true });
    tryAcquireSlot({ lockRoot: root, cap: 1, owner: 'HOLDER', nowMs: Date.now(), nowIso: new Date().toISOString() });
    const r = spawnSync(process.execPath, [CLI, 'acquire', '--cap=1', '--ceiling-ms=1500', '--owner=B', '--json'],
      { cwd: lockRoot, env: cliEnv(pool, { WE_HEAVY_ADMISSION_FAST_SLOTS: '0' }), encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(75);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, deferred: true });
  }, 30_000);
});
