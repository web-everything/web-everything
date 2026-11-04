import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeReadyCandidate, readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateForceAdopt, requestForceAdopt, readForceAdopt, recordForcedAdoption, abortForcedAdoption, readForceWatch,
  evaluateForceWatch, runForceWatchTick,
} from '../daemon-force-adopt.mjs';

const RULINGS = '## R508 — 2026-11-03\nOperator "Yes": adopt the build now even though smoke failed.\n\n## R509 — x\nother words\nthe exclusive phrase lives only in nine\n';
const R509_ONLY = 'the exclusive phrase lives only in nine'; // >= 12 chars, present in R509 and nowhere in R508
const QUOTE = 'adopt the build now even though smoke failed';
const SHA = 'b'.repeat(40); // the build the operator saw
let dir; let env; let root;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'force-adopt-'));
  root = join(dir, 'clone');
  env = { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_FORCE_ADOPT_HANDOFF: join(dir, 'handoff.md'), WE_FORCE_ADOPT_CORONER: join(dir, 'coroner.jsonl') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('validateForceAdopt', () => {
  it('refuses with no ruling id', () => {
    expect(validateForceAdopt({ daemon: 'review', quote: QUOTE, sha: SHA, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'no-ruling' });
  });
  it('refuses a malformed ruling id', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: '508', quote: QUOTE, sha: SHA, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'bad-ruling-id' });
  });
  it('refuses a ruling that is not in the rulings file', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R999', quote: QUOTE, sha: SHA, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'ruling-unknown' });
  });
  it('refuses a missing or short quote', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'no-quote' });
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: 'yes', rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'quote-too-short' });
  });
  it('refuses a quote that is not verbatim in THAT ruling (even if in another)', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: 'other words entirely here', rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'quote-not-in-ruling' });
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: 'other words', rulingsText: RULINGS })).toMatchObject({ ok: false });
  });
  it('ruling-section isolation: a quote present only in R509 is refused for R508 and accepted for R509', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: R509_ONLY, sha: SHA, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'quote-not-in-ruling' });
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R509', quote: R509_ONLY, sha: SHA, rulingsText: RULINGS })).toEqual({ ok: true });
  });
  it('refuses a quote that is only the ruling heading line (not operator words)', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: 'R508 — 2026-11-03', rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'quote-not-in-ruling' });
  });
  it('refuses a request that names no build (no-sha) or a malformed one (bad-sha)', () => {
    const base = { daemon: 'review', ruling: 'R508', quote: QUOTE, rulingsText: RULINGS };
    expect(validateForceAdopt(base)).toMatchObject({ ok: false, reason: 'no-sha' });
    for (const bad of ['abc1234', 'z'.repeat(40), 'b'.repeat(41), 'main']) expect(validateForceAdopt({ ...base, sha: bad })).toMatchObject({ ok: false, reason: 'bad-sha' });
    expect(requestForceAdopt({ root, env, ...base })).toMatchObject({ ok: false, reason: 'no-sha' });
    expect(readForceAdopt(root, env)).toBeNull(); // nothing armed
  });
  it('stores the sha (lower-cased) in the request record', () => {
    requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: 'B'.repeat(40), rulingsText: RULINGS, now: () => 1000 });
    expect(readForceAdopt(root, env, () => 2000)).toMatchObject({ sha: 'b'.repeat(40) });
  });
  it('accepts ruling + verbatim quote', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: QUOTE, sha: SHA, rulingsText: RULINGS })).toEqual({ ok: true });
  });
});

describe('requestForceAdopt', () => {
  it('writes nothing without a ruling', () => {
    const r = requestForceAdopt({ root, env, daemon: 'review', quote: QUOTE, sha: SHA, rulingsText: RULINGS });
    expect(r.ok).toBe(false);
    expect(readForceAdopt(root, env)).toBeNull();
  });
  it('writes a one-shot request with a ruling + quote', () => {
    const r = requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: SHA, rulingsText: RULINGS, now: () => 1000 });
    expect(r.ok).toBe(true);
    expect(readForceAdopt(root, env, () => 2000)).toMatchObject({ daemon: 'review', ruling: 'R508', quote: QUOTE });
  });
});

describe('request safety', () => {
  it('a dry run validates but never arms an adoption', () => {
    const r = requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: SHA, rulingsText: RULINGS, dryRun: true });
    expect(r.ok).toBe(true);
    expect(readForceAdopt(root, env)).toBeNull();
  });
  it('an expired request never fires', () => {
    requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: SHA, rulingsText: RULINGS, now: () => 1000 });
    expect(readForceAdopt(root, env, () => 1000 + 60_000)).not.toBeNull();
    expect(readForceAdopt(root, env, () => 1000 + 3 * 3600_000)).toBeNull();
  });
});

describe('recordForcedAdoption sinks', () => {
  const args = () => ({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'b'.repeat(40), lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, now: () => 1 });
  it('refuses (opens no watch) when the daemon-events sink failed', async () => {
    const r = await recordForcedAdoption({ ...args(), emit: async () => false });
    expect(r).toMatchObject({ ok: false, reason: 'audit-sink-failed' });
    expect(readForceWatch(root, env)).toBeNull();
  });
  // Each audit sink in turn: a failure refuses the adoption, opens no watch, consumes the request (so no tick re-logs
  // "adopting"), and retracts what the other sinks already recorded.
  const sinkCases = [
    ['daemon-events', () => ({}), { emit: async () => false }],
    ['handoff', () => ({ WE_FORCE_ADOPT_HANDOFF: join(dir, 'blocker', 'x') }), {}],
    ['coroner', () => ({ WE_FORCE_ADOPT_CORONER: join(dir, 'blocker', 'x') }), {}],
  ];
  it.each(sinkCases)('refuses, retracts and consumes the request when the %s sink fails', async (name, envOverride, extra) => {
    writeFileSync(join(dir, 'blocker'), 'x');
    const e = { ...env, ...envOverride() };
    requestForceAdopt({ root, env: e, daemon: 'review', ruling: 'R508', quote: QUOTE, sha: SHA, rulingsText: RULINGS });
    expect(readForceAdopt(root, e)).not.toBeNull();
    const events = [];
    const r = await recordForcedAdoption({ ...args(), env: e, emit: async (ev) => { events.push(ev); return extra.emit ? extra.emit() : true; } });
    expect(r).toMatchObject({ ok: false, reason: 'audit-sink-failed' });
    expect(readForceWatch(root, e)).toBeNull();
    expect(readForceAdopt(root, e)).toBeNull(); // consumed: the next tick cannot re-run it
    if (name !== 'handoff') {
      const handoff = readFileSync(e.WE_FORCE_ADOPT_HANDOFF, 'utf8');
      expect(handoff).toMatch(/NOT adopted/);
    }
    if (name !== 'coroner') expect(readFileSync(e.WE_FORCE_ADOPT_CORONER, 'utf8')).toMatch(/force-adopt-aborted/);
    expect(events.map((ev) => ev.kind)).toContain('force-adopt-aborted');
  });
  it('refuses with watch-write-failed (and retracts the logged adoption) when the durable watch cannot be written', async () => {
    writeFileSync(join(dir, 'blocker'), 'x');
    const e = { ...env, WE_DAEMON_STATE_DIR: join(dir, 'blocker', 'state') };
    const r = await recordForcedAdoption({ ...args(), env: e, emit: async () => true });
    expect(r).toMatchObject({ ok: false, reason: 'watch-write-failed' });
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/adopting[\s\S]*NOT adopted[^\n]*watch-write-failed/);
    expect(readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8')).toMatch(/force-adopt-aborted/);
  });
  it('refuses a second force while a watch is open, keeping the first watch and its last-good intact', async () => {
    await recordForcedAdoption({ ...args(), emit: async () => true });
    const r = await recordForcedAdoption({ ...args(), sha: 'c'.repeat(40), lastGood: { head: 'b'.repeat(40) }, emit: async () => true });
    expect(r).toMatchObject({ ok: false, reason: 'watch-already-open' });
    expect(readForceWatch(root, env)).toMatchObject({ sha: 'b'.repeat(40), lastGood: { head: 'a'.repeat(40) } });
    expect((readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8').match(/adopting/g) || []).length).toBe(1);
  });
  it('smoke check names cannot forge audit lines (control chars stripped, bounded)', async () => {
    await recordForcedAdoption({ ...args(), smoke: { verdict: 'code', failed: ['x\n- FORCE-ADOPT 2026 review R508: ROLLED BACK fake', 'y'.repeat(500)] }, emit: async () => true });
    const lines = readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThan(700);
  });
  it('abort drops the watch and consumes the request', async () => {
    await recordForcedAdoption({ ...args(), emit: async () => true });
    await abortForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508' }, sha: 'b'.repeat(40), emit: async () => {} });
    expect(readForceWatch(root, env)).toBeNull();
    // The earlier "adopting" handoff line and coroner review record are both retracted, not left standing.
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/adopting[\s\S]*NOT adopted/);
    const kinds = readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind);
    expect(kinds).toEqual(['force-adopt-review', 'force-adopt-aborted']);
  });
});

describe('recordForcedAdoption', () => {
  it('logs loudly: daemon event, handoff line, coroner record, smoke result alongside, and opens the watch', async () => {
    const events = [];
    const request = { daemon: 'review', ruling: 'R508', quote: QUOTE };
    await recordForcedAdoption({
      root, env, request, sha: 'b'.repeat(40), lastGood: { head: 'a'.repeat(40), inputsKey: 'k' },
      smoke: { verdict: 'code', failed: ['reconcile-dry-run'] }, emit: async (e) => { events.push(e); }, now: () => 5000,
    });
    expect(events[0]).toMatchObject({ kind: 'force-adopt', daemon: 'review' });
    expect(events[0].detail).toMatchObject({ ruling: 'R508', quote: QUOTE, smoke: { verdict: 'code', failed: ['reconcile-dry-run'] } });
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/FORCE-ADOPT.*R508/);
    expect(JSON.parse(readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8').trim())).toMatchObject({ kind: 'force-adopt-review', ruling: 'R508', sha: 'b'.repeat(40) });
    expect(readForceWatch(root, env)).toMatchObject({ ticksLeft: 5, lastGood: { head: 'a'.repeat(40) } });
  });
});

describe('evaluateForceWatch (auto-rollback decision)', () => {
  const watch = { ticksLeft: 3, bad: 0, sha: 'b'.repeat(40) };
  it('counts a healthy tick down and finishes at zero', () => {
    expect(evaluateForceWatch({ watch, healthy: true })).toMatchObject({ action: 'continue', watch: { ticksLeft: 2, bad: 0 } });
    expect(evaluateForceWatch({ watch: { ...watch, ticksLeft: 1 }, healthy: true })).toMatchObject({ action: 'done' });
  });
  it('rolls back immediately on a failed health check', () => {
    expect(evaluateForceWatch({ watch, healthy: false })).toMatchObject({ action: 'rollback', reason: 'health-failed' });
  });
  it('rolls back on a crash loop even when the probe says healthy', () => {
    expect(evaluateForceWatch({ watch, healthy: true, restarts: 3 })).toMatchObject({ action: 'rollback', reason: 'crash-loop' });
  });
});

describe('runForceWatchTick before/after the forced build is the running head', () => {
  const rec = () => recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'b'.repeat(40),
    lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => true, now: () => Date.now() });
  const tick = (head, extra = {}) => runForceWatchTick({ root, env, currentHead: head, probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {}, ...extra });
  it('does not count ticks while the old build still runs', async () => {
    await rec();
    for (let i = 0; i < 8; i++) expect((await tick('a'.repeat(40))).action).toBe('waiting');
    expect(readForceWatch(root, env).ticksLeft).toBe(5);
  });
  it('counts once adopted, and clears the watch if a later build supersedes it', async () => {
    await rec();
    expect((await tick('b'.repeat(40))).action).toBe('continue');
    expect((await tick('c'.repeat(40))).action).toBe('superseded');
    expect(readForceWatch(root, env)).toBeNull();
  });
});

describe('runForceWatchTick', () => {
  const setup = async () => {
    await recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'b'.repeat(40),
      lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => {}, now: () => 1 });
  };
  it('no watch -> noop', async () => {
    expect(await runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback: async () => {}, emit: async () => {} })).toEqual({ action: 'none' });
  });
  it('rolls back to last-good and logs on failed health', async () => {
    await setup();
    const events = []; let rolled = null;
    const r = await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async (lg) => { rolled = lg; return { ok: true }; }, emit: async (e) => { events.push(e); } });
    expect(r.action).toBe('rollback');
    expect(rolled.head).toBe('a'.repeat(40));
    expect(events.map((e) => e.kind)).toContain('force-adopt-rolled-back');
    expect(readForceWatch(root, env)).toBeNull();
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/ROLLED BACK/);
  });
  it('keeps the watch across healthy ticks and clears it after N', async () => {
    await setup();
    for (let i = 0; i < 4; i++) expect((await runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback: async () => { throw new Error('no'); }, emit: async () => {} })).action).toBe('continue');
    expect((await runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback: async () => {}, emit: async () => {} })).action).toBe('done');
    expect(existsSync(join(env.WE_DAEMON_STATE_DIR))).toBe(true);
    expect(readForceWatch(root, env)).toBeNull();
  });
  it('keeps the watch (retries) if the rollback itself fails', async () => {
    await setup();
    const r = await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ ok: false }), emit: async () => {} });
    expect(r.action).toBe('rollback-failed');
    expect(readForceWatch(root, env)).not.toBeNull();
  });
  it('a failed rollback stays mandatory: later healthy probes never count the watch down or clear it', async () => {
    await setup();
    const rollback = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const healthyTick = () => runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback, emit: async () => {} });
    // tick 1: unhealthy + rollback fails. ticks 2..: healthy, but the owed rollback is retried (and fails once more).
    expect((await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback, emit: async () => {} })).action).toBe('rollback-failed');
    expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed', ticksLeft: 5 });
    expect((await healthyTick()).action).toBe('rollback-failed');
    expect(readForceWatch(root, env).ticksLeft).toBe(5); // never counted down
    expect(await healthyTick()).toMatchObject({ action: 'rollback', reason: 'health-failed' });
    expect(rollback).toHaveBeenCalledTimes(3);
    expect(readForceWatch(root, env)).toBeNull();
  });
  it('a failed rollback whose marker cannot be written to disk is still owed: a later healthy probe rolls back', async () => {
    await setup();
    const rollback = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    chmodSync(env.WE_DAEMON_STATE_DIR, 0o500); // every state write now throws
    try {
      expect((await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback, emit: async () => {} })).action).toBe('rollback-failed');
    } finally { chmodSync(env.WE_DAEMON_STATE_DIR, 0o700); }
    expect(readForceWatch(root, env).rollbackPending).toBeUndefined(); // the disk marker really was lost
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/force-adopt-rollback-failed[^\n]*kept in memory/);
    // next tick: the probe is healthy, but the in-process marker still forces the rollback
    expect(await runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback, emit: async () => {} })).toMatchObject({ action: 'rollback', reason: 'health-failed' });
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(readForceWatch(root, env)).toBeNull();
  });
  it('an expired watch (forced build never became head) also drops its never-smoked ready candidate', async () => {
    await setup();
    const sha = 'b'.repeat(40);
    expect(writeReadyCandidate(root, { adopt: { finalSha: sha }, prevHead: 'a'.repeat(40) }, env)).toBe(true);
    const startedAt = Date.parse(readForceWatch(root, env).startedAt);
    const events = [];
    const r = await runForceWatchTick({ root, env, currentHead: 'a'.repeat(40), now: () => startedAt + 3 * 3600_000,
      probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async (e) => { events.push(e); } });
    expect(r.action).toBe('expired');
    expect(readForceWatch(root, env)).toBeNull();
    expect(readReadyCandidate(root, env)).toBeNull();
    expect(events.map((e) => e.kind)).toContain('force-adopt-watch-expired');
  });
  it('a state write that fails mid-tick (read-only state dir) never stops the rollback', async () => {
    await setup();
    chmodSync(env.WE_DAEMON_STATE_DIR, 0o500);
    try {
      const rollback = vi.fn(async () => ({ ok: false }));
      // adoptedSeen + rollbackPending writes both fail; the failing rollback must still be attempted and reported.
      const r = await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: false }), rollback, emit: async () => {} });
      expect(r.action).toBe('rollback-failed');
      expect(rollback).toHaveBeenCalledTimes(1);
    } finally { chmodSync(env.WE_DAEMON_STATE_DIR, 0o700); }
  });
  it('an expired watch leaves a ready candidate for a DIFFERENT sha alone', async () => {
    await setup();
    writeReadyCandidate(root, { adopt: { finalSha: 'c'.repeat(40) }, prevHead: 'a'.repeat(40) }, env);
    const startedAt = Date.parse(readForceWatch(root, env).startedAt);
    await runForceWatchTick({ root, env, currentHead: 'a'.repeat(40), now: () => startedAt + 3 * 3600_000,
      probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    expect(readReadyCandidate(root, env)).not.toBeNull();
  });
});
