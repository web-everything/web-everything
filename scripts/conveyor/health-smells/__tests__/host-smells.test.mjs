/**
 * @file scripts/conveyor/health-smells/__tests__/host-smells.test.mjs
 * @description #4066 — seed smells 12 (lane pool growth / dirty lanes) and 14 (App token / REST rate limit),
 *   driven through the slice-1 core (`runHealthTick`), plus the ruling's inhibition leg end to end: an App-token
 *   episode and a high-load episode, each opened by its REAL smell from fixture probes, hold an otherwise
 *   dispatchable investigation (`planInvestigations`).
 */
import { describe, it, expect } from 'vitest';
import { runHealthTick, emptyHealthState, MINUTE, HOUR } from '../../health-watch-core.mjs';
import { planInvestigations, HOLD_RULES, INHIBITING_SMELLS } from '../../health-investigate-plan.mjs';
import lanePoolGrowth, { LANE_HARD_CAP } from '../lane-pool-growth.mjs';
import appToken from '../github-app-token.mjs';
import machineOverload from '../machine-overload.mjs';
import laneStarvation from '../lane-starvation.mjs';

const NOW = Date.parse('2026-09-29T12:00:00Z');

function ticks(smells, probesPerTick, { stepMs = 5 * MINUTE } = {}) {
  let state = emptyHealthState();
  let last;
  probesPerTick.forEach((probes, i) => {
    last = runHealthTick(state, probes, smells, NOW + i * stepMs);
    state = last.state;
  });
  return last;
}

const pool = (repo, health) => ({ repo, health, at: NOW - MINUTE });

describe('lane-pool-growth', () => {
  it('mirrors lane-pool.mjs ACQUIRE_HARD_MAX (90 / 30 / 30)', () => {
    expect(LANE_HARD_CAP).toEqual({ we: 90, frontierui: 30, 'plateau-app': 30 });
  });

  it('the live 2026-09-29 WE reading (90/90 lanes, 35 dirty unleased) opens after 3 samples, naming both reasons', () => {
    const probes = { lanePools: [pool('we', { total: 90, leased: 5, acquirable: 50, dirtyUnleased: 35 })] };
    expect(ticks([lanePoolGrowth], [probes, probes]).transitions).toEqual([]);
    const r = ticks([lanePoolGrowth], [probes, probes, probes]);
    expect(r.transitions.map((t) => t.key)).toEqual(['lane-pool-growth::lane-pool:we']);
    const ep = r.state.episodes['lane-pool-growth::lane-pool:we'];
    expect(ep.measure).toMatchObject({ capPct: 100, dirtyPct: 39 });
    expect(ep.summary).toContain('90/90 lanes');
    expect(ep.recommendation).toContain('trim --dry-run');
    expect(ep.recommendation).toContain('35 lanes are dirty');
  });

  it('a healthy pool (60/90, 5 dirty) never breaches; each threshold trips on its own', () => {
    const check = (h) => ticks([lanePoolGrowth], [{ lanePools: [pool('we', h)] }]).evaluations[0].results[0].breach;
    expect(check({ total: 60, leased: 5, acquirable: 50, dirtyUnleased: 5 })).toBe(false);
    expect(check({ total: 82, leased: 5, acquirable: 70, dirtyUnleased: 5 })).toBe(true); // > 81 = 90%
    expect(check({ total: 40, leased: 5, acquirable: 25, dirtyUnleased: 9 })).toBe(true); // 22.5% dirty
  });

  it('a host cap override in config.json (laneHardCap) replaces the mirrored default', () => {
    const r = runHealthTick(emptyHealthState(), { lanePools: [pool('we', { total: 90, dirtyUnleased: 0 })] }, [lanePoolGrowth], NOW, { config: { laneHardCap: { we: 200 } } });
    expect(r.evaluations[0].results[0]).toMatchObject({ breach: false, measure: { cap: 200 } });
  });
});

describe('github-app-token', () => {
  const fresh = { present: true, expiresAt: new Date(NOW + 40 * MINUTE).toISOString() };
  const okStatus = { applied: true, reason: 'ok', checkedAt: new Date(NOW - 2 * MINUTE).toISOString() };
  const rest = (remaining) => ({ limit: 5000, used: 5000 - remaining, remaining, reset: Math.floor((NOW + 20 * MINUTE) / 1000) });
  const res = (probes) => runHealthTick(emptyHealthState(), probes, [appToken], NOW).evaluations[0].results;

  it('a fresh token and a healthy bucket are clean', () => {
    expect(res({ appToken: fresh, appStatus: okStatus, restBudget: rest(4000) }).map((x) => [x.subject, x.breach])).toEqual([['app-token', false], ['rest-core', false]]);
  });

  it('an expired cache is "refresh failing" and opens on the first sample (high)', () => {
    const r = runHealthTick(emptyHealthState(), { appToken: { present: true, expiresAt: new Date(NOW - 5 * MINUTE).toISOString() }, appStatus: okStatus, restBudget: null }, [appToken], NOW);
    expect(r.transitions.map((t) => t.key)).toEqual(['github-app-token::app-token']);
    expect(r.state.episodes['github-app-token::app-token']).toMatchObject({ severity: 'high' });
    expect(r.state.episodes['github-app-token::app-token'].recommendation).toContain('cached token expired 5m ago');
  });

  it('a stale refresh stamp (> 30 min) breaches even before the token expires', () => {
    const stale = { ...okStatus, checkedAt: new Date(NOW - 45 * MINUTE).toISOString() };
    expect(res({ appToken: fresh, appStatus: stale, restBudget: null })[0]).toMatchObject({ subject: 'app-token', breach: true });
  });

  it('REST core below 10% breaches; no cache file (App not configured) yields no token subject', () => {
    const out = res({ appToken: { present: false }, appStatus: null, restBudget: rest(400) });
    expect(out.map((x) => [x.subject, x.breach])).toEqual([['rest-core', true]]);
    expect(out[0].measure.remainingFraction).toBe(0.08);
  });

  it('never carries the token itself — only the expiry', () => {
    const out = res({ appToken: { ...fresh, token: 'ghs_SHOULDNEVERAPPEAR000000000000' }, appStatus: okStatus, restBudget: null });
    expect(JSON.stringify(out)).not.toContain('ghs_');
  });
});

describe('inhibition — App-token and high-load episodes hold agent dispatch (4065 clause 2)', () => {
  // An investigate-action episode that WOULD be dispatched: lane starvation, opened by its real smell.
  const starving = { lanePools: [pool('we', { total: 90, leased: 90, acquirable: 0, dirtyUnleased: 0 })] };
  const smellsById = { [laneStarvation.id]: laneStarvation, [appToken.id]: appToken, [machineOverload.id]: machineOverload };
  const plan = (episodes) => planInvestigations({ episodes, smellsById, ledger: [], config: { investigateDispatch: true }, now: NOW + HOUR });
  // lane-starvation's own diagnosis must have run before it is a candidate.
  const diagnosed = (state) => Object.fromEntries(Object.entries(state.episodes).map(([k, e]) => [k, e.smell === 'lane-starvation' ? { ...e, diagnosis: { code: 0, output: '{}' } } : e]));
  // One real-shaped fix-dispatch-daemon tick that wanted a lane and was refused (the demand lane-starvation reads).
  const NO_LANE_TICK = 'fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 0, refused 1\n'
    + 'fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2901 — no acquirable lane in the pool\n';
  let size = 0;
  const logSample = () => { size += NO_LANE_TICK.length; return [{ name: 'fix-dispatch-daemon', mtimeMs: NOW, sizeBytes: size, text: NO_LANE_TICK, bootstrap: false }]; };
  const ticks = (smells, extra) => {
    let state = emptyHealthState();
    let last;
    for (let i = 0; i < 2; i += 1) {
      last = runHealthTick(state, { ...starving, daemonLogs: logSample(), ...extra }, smells, NOW + i * 5 * MINUTE);
      state = last.state;
    }
    return last;
  };

  it('baseline: with nothing inhibiting, lane-starvation is dispatched', () => {
    const r = ticks([laneStarvation, lanePoolGrowth], {});
    expect(r.state.episodes['lane-starvation::lane-pool:we'].status).toBe('open');
    expect(plan(diagnosed(r.state)).dispatch.map((d) => d.smell)).toEqual(['lane-starvation']);
  });

  it('an expired App token (github-app-token opened by its own evaluate) holds it as inhibited', () => {
    expect(INHIBITING_SMELLS.has('github-app-token')).toBe(true);
    const expired = { appToken: { present: true, expiresAt: new Date(NOW - MINUTE).toISOString() }, appStatus: null, restBudget: null };
    const r = ticks([laneStarvation, appToken], expired);
    expect(r.state.episodes['github-app-token::app-token'].status).toBe('open');
    const p = plan(diagnosed(r.state));
    expect(p.dispatch).toEqual([]);
    expect(p.held.find((h) => h.key === 'lane-starvation::lane-pool:we')).toMatchObject({ rule: HOLD_RULES.INHIBITED });
    expect(p.held[0].reason).toContain('github-app-token');
  });

  it('a REST bucket under 10% holds it too', () => {
    const drained = { appToken: { present: false }, appStatus: null, restBudget: { limit: 5000, remaining: 100, reset: null } };
    const r = ticks([laneStarvation, appToken], drained);
    expect(plan(diagnosed(r.state)).held[0]).toMatchObject({ rule: HOLD_RULES.INHIBITED });
  });

  it('high machine load (machine-overload opened by its own evaluate) holds it as inhibited', () => {
    const load = { machineLoad: { load1: 40, load5: 30, load15: 20, cpuCount: 8 }, processes: [{ pid: 10, ppid: 1, pcpu: 700, etime: '10:00', command: '/tmp/spawn-hog.sh' }] };
    const r = ticks([laneStarvation, machineOverload], load);
    expect(r.state.episodes['machine-overload::machine'].status).toBe('open');
    const p = plan(diagnosed(r.state));
    expect(p.dispatch).toEqual([]);
    expect(p.held.find((h) => h.key === 'lane-starvation::lane-pool:we').reason).toContain('machine-overload');
  });
});
