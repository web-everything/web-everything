import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeReadyCandidate, readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, chmodSync, readdirSync as nodeFsReaddir } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateForceAdopt, requestForceAdopt, readForceAdopt, recordForcedAdoption, abortForcedAdoption, readForceWatch,
  evaluateForceWatch, runForceWatchTick, forceRequestFor, forceBlockedReason, abortForcedWatch, dropReadyCandidate, forcedWatchStatus, carryForceWatch, declareForceCarry,
} from '../daemon-force-adopt.mjs';
import { matchReadyCandidate } from '../daemon-rebuild/adopt.mjs';
import { cloneKeyOf } from '../daemon-last-good.mjs';

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
  it('refuses a daemon name carrying a newline or control character (bad-daemon): it would forge handoff lines', () => {
    for (const daemon of ['review\n- FORCE-ADOPT forged', 'review\r', 'rev\u2028iew', 'rev\u0000iew']) {
      expect(validateForceAdopt({ daemon, ruling: 'R508', quote: QUOTE, sha: SHA, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'bad-daemon' });
    }
    expect(readForceAdopt(root, env)).toBeNull();
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
  it.each([['corrupt JSON', (p) => writeFileSync(p, '{not json')], ['unreadable file', (p) => { writeFileSync(p, '{}'); chmodSync(p, 0o000); }]])(
    'fails closed (watch-unreadable) when the watch file exists but is not readable: %s', async (_n, damage) => {
      await recordForcedAdoption({ ...args(), emit: async () => true });
      const p = join(env.WE_DAEMON_STATE_DIR, nodeFsReaddir(env.WE_DAEMON_STATE_DIR).find((n) => n.endsWith('.force-watch.json')));
      damage(p);
      try {
        const r = await recordForcedAdoption({ ...args(), sha: 'c'.repeat(40), lastGood: { head: 'b'.repeat(40) }, emit: async () => true });
        expect(r).toMatchObject({ ok: false, reason: 'watch-unreadable' });
      } finally { chmodSync(p, 0o600); }
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

describe('a watch opened by this tick: health is checked now, counting starts next tick', () => {
  const rec = () => recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'b'.repeat(40),
    lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => {} });
  const startedMs = () => Date.parse(readForceWatch(root, env).startedAt);
  it('an unhealthy build is rolled back on the adoption tick itself (nothing may be left to a watcher that cannot start)', async () => {
    await rec();
    let rolled = null;
    const r = await runForceWatchTick({ root, env, notBefore: startedMs() - 1, currentHead: () => 'b'.repeat(40), probe: async () => ({ healthy: false }),
      rollback: async (lg) => { rolled = lg; return { ok: true }; }, emit: async () => {} });
    expect(r).toMatchObject({ action: 'rollback', reason: 'health-failed' });
    expect(rolled.head).toBe('a'.repeat(40));
    expect(readForceWatch(root, env)).toBeNull();
  });
  it('a healthy build is left uncounted: same ticksLeft, still adopted-pending, no completion', async () => {
    await rec();
    const before = readForceWatch(root, env).ticksLeft;
    const r = await runForceWatchTick({ root, env, notBefore: startedMs() - 1, currentHead: () => 'b'.repeat(40), probe: async () => ({ healthy: true }),
      rollback: async () => { throw new Error('no'); }, emit: async () => {} });
    expect(r.action).toBe('none');
    expect(readForceWatch(root, env).ticksLeft).toBe(before);
  });
});

describe('carryForceWatch: a successor adopted without its own smoke inherits the open watch', () => {
  const rec = () => recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: 'b'.repeat(40),
    lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => {} });
  it('moves the watch onto the successor, keeping last-good and ticks left; the next tick probes the successor instead of superseding', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    const events = [];
    expect(await carryForceWatch({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40), emit: async (e) => { events.push(e.kind); } })).toBe(true);
    expect(readForceWatch(root, env)).toMatchObject({ sha: 'd'.repeat(40), ticksLeft: 4, lastGood: { head: 'a'.repeat(40) } });
    expect(events).toEqual(['force-adopt-watch-carried']);
    let rolled = null;
    const r = await runForceWatchTick({ root, env, currentHead: 'd'.repeat(40), probe: async () => ({ healthy: false }), rollback: async (lg, o) => { rolled = { lg, o }; return { ok: true }; }, emit: async () => {} });
    expect(r).toMatchObject({ action: 'rollback' });
    expect(rolled.lg.head).toBe('a'.repeat(40));
    expect(rolled.o.sha).toBe('d'.repeat(40));
  });
  it('an owed-rollback marker moves with the watch, so the revert stays owed on the successor', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: false }), rollback: async () => ({ ok: false }), emit: async () => {} });
    expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed' });
    expect(await carryForceWatch({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) })).toBe(true);
    expect(readForceWatch(root, env)).toMatchObject({ sha: 'd'.repeat(40), rollbackPending: 'health-failed' });
  });
  it('a tick that reads HEAD on the successor BEFORE the carry runs (declared intent) rebinds instead of closing the watch as superseded', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    expect(declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) })).toBe(true);
    const events = [];
    const r = await runForceWatchTick({ root, env, currentHead: () => 'd'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async (e) => { events.push(e.kind); } });
    expect(r).toMatchObject({ action: 'continue', ticksLeft: 3 });
    expect(events).not.toContain('force-adopt-watch-superseded');
    const w = readForceWatch(root, env);
    expect(w).toMatchObject({ sha: 'd'.repeat(40), lastGood: { head: 'a'.repeat(40) } });
    expect(w.carryTo).toBeUndefined();
    expect(await carryForceWatch({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) })).toBe(true); // the late carry is a no-op, not a failure
  });
  it('a successor adopted WHILE the health probe runs (intent declared, HEAD moved) keeps the watch: rebound onto it, never closed as superseded', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    let head = 'b'.repeat(40);
    const events = [];
    const r = await runForceWatchTick({ root, env, currentHead: () => head, rollback: async () => ({ ok: true }), emit: async (e) => { events.push(e.kind); },
      probe: async () => { declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) }); head = 'd'.repeat(40); return { healthy: true }; } });
    expect(r.action).not.toBe('superseded');
    expect(events).not.toContain('force-adopt-watch-superseded');
    const w = readForceWatch(root, env);
    expect(w).toMatchObject({ sha: 'd'.repeat(40), ticksLeft: 4, lastGood: { head: 'a'.repeat(40) } }); // not counted down: the probe judged the old head
    expect(w.carryTo).toBeUndefined();
    expect(await carryForceWatch({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) })).toBe(true); // the adopter's own late carry is a no-op
  });
  it('an owed rollback survives a successor adopted during the probe: the rebound watch still owes the revert', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    let head = 'b'.repeat(40);
    // Two overlapping ticks on the same build: the first records an owed rollback while the second's probe is still running.
    await runForceWatchTick({ root, env, currentHead: () => head, rollback: async () => ({ ok: true }), emit: async () => {},
      probe: async () => {
        await runForceWatchTick({ root, env, currentHead: () => head, probe: async () => ({ healthy: false }), rollback: async () => ({ ok: false }), emit: async () => {} });
        declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) });
        head = 'd'.repeat(40);
        return { healthy: true };
      } });
    expect(readForceWatch(root, env)).toMatchObject({ sha: 'd'.repeat(40), rollbackPending: 'health-failed' });
  });
  it('a successor adopted WHILE the rollback waits for the clone lock (rollback reports superseded onto the declared successor) keeps the watch on it', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    const events = [];
    const r = await runForceWatchTick({ root, env, currentHead: () => 'b'.repeat(40), probe: async () => ({ healthy: false }), emit: async (e) => { events.push(e.kind); },
      rollback: async () => { declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) }); return { superseded: true, head: 'd'.repeat(40) }; } });
    expect(r.action).not.toBe('superseded');
    expect(events).not.toContain('force-adopt-watch-superseded');
    const w = readForceWatch(root, env);
    expect(w).toMatchObject({ sha: 'd'.repeat(40), lastGood: { head: 'a'.repeat(40) } });
    expect(w.carryTo).toBeUndefined();
  });
  it('a head that is NOT the declared successor still closes the watch as superseded after the probe', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    let head = 'b'.repeat(40);
    const r = await runForceWatchTick({ root, env, currentHead: () => head, rollback: async () => ({ ok: true }), emit: async () => {},
      probe: async () => { declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) }); head = 'e'.repeat(40); return { healthy: true }; } });
    expect(r.action).toBe('superseded');
    expect(readForceWatch(root, env)).toBeNull();
  });
  it('a declared intent does not make an unrelated head look carried, and a withdrawn intent is gone', async () => {
    await rec();
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} });
    declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) });
    expect((await runForceWatchTick({ root, env, currentHead: () => 'e'.repeat(40), probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} })).action).toBe('superseded');
    await rec();
    declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) });
    declareForceCarry({ root, env, fromSha: 'b'.repeat(40), toSha: null });
    expect(readForceWatch(root, env).carryTo).toBeUndefined();
  });
  it('a carry that cannot be saved is reported in the handoff file, never silent', async () => {
    await rec();
    chmodSync(env.WE_DAEMON_STATE_DIR, 0o500);
    try { expect(await carryForceWatch({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) })).toBe(false); } finally { chmodSync(env.WE_DAEMON_STATE_DIR, 0o700); }
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/force-adopt-watch-carry-failed b{40} -> d{40}/);
    expect(readForceWatch(root, env)).toMatchObject({ sha: 'b'.repeat(40) });
  });
  it('does nothing for a watch of another build, no watch, or the same sha', async () => {
    expect(await carryForceWatch({ root, env, fromSha: 'b'.repeat(40), toSha: 'd'.repeat(40) })).toBe(false);
    await rec();
    expect(await carryForceWatch({ root, env, fromSha: 'c'.repeat(40), toSha: 'd'.repeat(40) })).toBe(false);
    expect(await carryForceWatch({ root, env, fromSha: 'b'.repeat(40), toSha: 'b'.repeat(40) })).toBe(false);
    expect(readForceWatch(root, env)).toMatchObject({ sha: 'b'.repeat(40) });
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
  it('a healthy probe that resolves after a concurrent tick recorded a failed rollback does not erase the owed rollback', async () => {
    await setup();
    const healthy = async () => ({ healthy: true });
    for (let i = 0; i < 4; i++) await runForceWatchTick({ root, env, probe: healthy, rollback: async () => ({ ok: true }), emit: async () => {} });
    expect(readForceWatch(root, env).ticksLeft).toBe(1); // the next healthy tick would end the watch
    let release; const gate = new Promise((r) => { release = r; });
    const firstRollback = vi.fn(async () => ({ ok: true }));
    const first = runForceWatchTick({ root, env, probe: async () => { await gate; return { healthy: true }; }, rollback: firstRollback, emit: async () => {} });
    const second = await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ ok: false }), emit: async () => {} });
    expect(second.action).toBe('rollback-failed');
    expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed' });
    release();
    // the stale healthy result must not end the watch: the owed rollback is honoured by this tick
    expect(await first).toMatchObject({ action: 'rollback', reason: 'health-failed' });
    expect(firstRollback).toHaveBeenCalledTimes(1);
    expect(readForceWatch(root, env)).toBeNull(); // cleared by the successful rollback, not by a countdown
  });
  it('a tick whose probe resolves after another tick closed the watch neither counts down nor re-creates it', async () => {
    await setup();
    let release; const gate = new Promise((r) => { release = r; });
    const first = runForceWatchTick({ root, env, probe: async () => { await gate; return { healthy: true }; }, rollback: async () => ({ ok: true }), emit: async () => {} });
    expect((await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ ok: true }), emit: async () => {} })).action).toBe('rollback');
    expect(readForceWatch(root, env)).toBeNull();
    release();
    expect(await first).toEqual({ action: 'none' });
    expect(readForceWatch(root, env)).toBeNull(); // the stale 'continue' write did not resurrect the closed watch
  });
  it('a build superseded while a HEALTHY probe ran is not counted down and never logged as passed', async () => {
    await setup();
    const events = [];
    let reads = 0;
    const currentHead = () => (++reads === 1 ? 'b'.repeat(40) : 'c'.repeat(40)); // the watched build before the probe, a sibling\'s build after
    const r = await runForceWatchTick({ root, env, currentHead, probe: async () => ({ healthy: true }), rollback: vi.fn(), emit: async (e) => { events.push(e); } });
    expect(r).toEqual({ action: 'superseded' });
    expect(readForceWatch(root, env)).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['force-adopt-watch-superseded']);
  });
  it('a watch another tick closed during the rollback is neither resurrected with an owed marker nor reported again', async () => {
    await setup();
    const events = [];
    const rollback = async () => {
      // while this rollback is in flight, a second tick completes its own rollback and closes the watch
      await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ ok: true }), emit: async () => {} });
      return { ok: false };
    };
    const r = await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback, emit: async (e) => { events.push(e); } });
    expect(r).toEqual({ action: 'none' });
    expect(readForceWatch(root, env)).toBeNull(); // the failed result did not write rollbackPending back
    expect(events).toEqual([]);
  });
  it('a rollback that reports a superseding build closes the watch without reverting and without logging ROLLED BACK', async () => {
    await setup();
    const events = [];
    const r = await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ superseded: true, head: 'c'.repeat(40) }), emit: async (e) => { events.push(e); } });
    expect(r).toEqual({ action: 'superseded' });
    expect(readForceWatch(root, env)).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['force-adopt-watch-superseded']);
    expect(existsSync(env.WE_FORCE_ADOPT_HANDOFF) ? readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8') : '').not.toMatch(/ROLLED BACK/);
  });
  it('a superseded rollback also drops the never-adopted forced ready record, so no later lock holder adopts it unwatched', async () => {
    await setup();
    expect(writeReadyCandidate(root, { adopt: { finalSha: 'b'.repeat(40) }, prevHead: 'a'.repeat(40), forced: true }, env)).toBe(true);
    const r = await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ superseded: true, head: 'c'.repeat(40) }), emit: async () => {} });
    expect(r).toEqual({ action: 'superseded' });
    expect(readReadyCandidate(root, env)).toBeNull();
  });
  it('a superseded rollback leaves a ready record for a DIFFERENT build alone', async () => {
    await setup();
    writeReadyCandidate(root, { adopt: { finalSha: 'd'.repeat(40) }, prevHead: 'a'.repeat(40) }, env);
    await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ superseded: true, head: 'c'.repeat(40) }), emit: async () => {} });
    expect(readReadyCandidate(root, env)).not.toBeNull();
  });
  it('forceBlockedReason names every refusal: open watch, unreadable watch, unsaved rollback; otherwise null', async () => {
    expect(forceBlockedReason(root, env)).toBeNull();
    await setup();
    expect(forceBlockedReason(root, env)).toBe('watch-already-open');
    const f = join(env.WE_DAEMON_STATE_DIR, nodeFsReaddir(env.WE_DAEMON_STATE_DIR).find((n) => n.endsWith('.force-watch.json')));
    writeFileSync(f, '{corrupt');
    expect(forceBlockedReason(root, env)).toBe('watch-unreadable');
    rmSync(f, { force: true });
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
  const lose = () => rmSync(join(env.WE_DAEMON_STATE_DIR, nodeFsReaddir(env.WE_DAEMON_STATE_DIR).find((n) => n.endsWith('.force-watch.json'))), { force: true }); // watch file removed without clearWatch
  const failRollbackUnsaved = async () => {
    chmodSync(env.WE_DAEMON_STATE_DIR, 0o500);
    try { await runForceWatchTick({ root, env, probe: async () => ({ healthy: false }), rollback: async () => ({ ok: false }), emit: async () => {} }); } finally { chmodSync(env.WE_DAEMON_STATE_DIR, 0o700); }
  };
  it('a rollback obligation that could not be saved fails closed: no new force-adopt until the rollback is done, then the next build starts clean', async () => {
    await setup();
    await failRollbackUnsaved();
    lose();
    const force = (sha) => recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha, lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => {}, now: () => 1 });
    expect(forceBlockedReason(root, env)).toBe('rollback-owed');
    expect(await force('c'.repeat(40))).toMatchObject({ ok: false, reason: 'rollback-owed' }); // refused: the unsaved obligation is still owed
    expect(readForceWatch(root, env)).toBeNull();
    // the obligation lives on in memory and is paid by the next tick even though the watch file is gone
    const rollback = vi.fn(async () => ({ ok: true }));
    expect(await runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback, emit: async () => {} })).toMatchObject({ action: 'rollback', reason: 'health-failed' });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect((await force('c'.repeat(40))).ok).toBe(true); // settled: the next force is accepted and starts clean
    const clean = vi.fn(async () => ({ ok: true }));
    expect((await runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback: clean, emit: async () => {} })).action).toBe('continue');
    expect(clean).not.toHaveBeenCalled();
  });
  it('an unsaved obligation is persisted on a later tick and then stops blocking on the in-memory copy', async () => {
    await setup();
    await failRollbackUnsaved();
    const rollback = vi.fn(async () => ({ ok: false }));
    expect((await runForceWatchTick({ root, env, probe: async () => ({ healthy: true }), rollback, emit: async () => {} })).action).toBe('rollback-failed');
    expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed' }); // now durable on disk
  });
  it('the rollback is told which build is under watch, so it can refuse to revert a newer one', async () => {
    await setup();
    const rollback = vi.fn(async () => ({ ok: true }));
    await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: false }), rollback, emit: async () => {} });
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ head: 'a'.repeat(40) }), { sha: 'b'.repeat(40) });
  });
  describe('an unreadable HEAD is a failure, never "no head supplied"', () => {
    const unreadable = () => null; // a currentHead FUNCTION that cannot read git
    it('never counts the watch down or completes it, and owes a rollback instead', async () => {
      await setup();
      const rollback = vi.fn(async () => ({ ok: false }));
      const probe = vi.fn(async () => ({ healthy: true }));
      for (let i = 0; i < 8; i++) {
        const r = await runForceWatchTick({ root, env, currentHead: unreadable, probe, rollback, emit: async () => {} });
        expect(r).toMatchObject({ action: 'rollback-failed', reason: 'head-unreadable' });
      }
      expect(readForceWatch(root, env)).toMatchObject({ ticksLeft: 5, rollbackPending: 'head-unreadable' });
      expect(rollback).toHaveBeenCalledTimes(8);
    });
    it('a head that becomes unreadable only AFTER the probe is also a failure', async () => {
      await setup();
      let reads = 0;
      const currentHead = () => (++reads === 1 ? 'b'.repeat(40) : null);
      const rollback = vi.fn(async () => ({ ok: false }));
      const r = await runForceWatchTick({ root, env, currentHead, probe: async () => ({ healthy: true }), rollback, emit: async () => {} });
      expect(r).toMatchObject({ action: 'rollback-failed', reason: 'head-unreadable' });
      expect(readForceWatch(root, env).ticksLeft).toBe(5);
    });
    it('a thrown head read is the same failure', async () => {
      await setup();
      const r = await runForceWatchTick({ root, env, currentHead: () => { throw new Error('git gone'); }, probe: async () => ({ healthy: true }), rollback: async () => ({ ok: false }), emit: async () => {} });
      expect(r).toMatchObject({ action: 'rollback-failed', reason: 'head-unreadable' });
    });
  });
  const watchFilePath = () => join(env.WE_DAEMON_STATE_DIR, nodeFsReaddir(env.WE_DAEMON_STATE_DIR).find((n) => n.endsWith('.force-watch.json')));
  const patchWatch = (patch) => writeFileSync(watchFilePath(), JSON.stringify({ ...JSON.parse(readFileSync(watchFilePath(), 'utf8')), ...patch }));
  describe('overlapping ticks never erase an owed rollback', () => {
    it('a healthy tick that would COMPLETE the watch cannot clear it while a failing rollback is in flight', async () => {
      await setup();
      patchWatch({ ticksLeft: 1 }); // a healthy tick now would finish the watch and delete it
      const head = 'b'.repeat(40);
      let release; const gate = new Promise((r) => { release = r; });
      let entered; const inRollback = new Promise((r) => { entered = r; });
      const tickA = runForceWatchTick({ root, env, currentHead: head, probe: async () => ({ healthy: false }),
        rollback: async () => { entered(); await gate; return { ok: false }; }, emit: async () => {} });
      await inRollback;
      // the obligation is durable BEFORE the rollback returns
      expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed', ticksLeft: 1 });
      const rollbackB = vi.fn(async () => ({ ok: false }));
      const b = await runForceWatchTick({ root, env, currentHead: head, probe: async () => ({ healthy: true }), rollback: rollbackB, emit: async () => {} });
      expect(b.action).toBe('rollback-failed'); // not 'done' / 'continue'
      expect(rollbackB).toHaveBeenCalledTimes(1);
      expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed', ticksLeft: 1 });
      release();
      expect((await tickA).action).toBe('rollback-failed');
      expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed', ticksLeft: 1 }); // the obligation survived both
    });
    it('the marker is cleared only when the rollback succeeds', async () => {
      await setup();
      let seenDuring = null;
      const r = await runForceWatchTick({ root, env, currentHead: 'b'.repeat(40), probe: async () => ({ healthy: false }),
        rollback: async () => { seenDuring = readForceWatch(root, env)?.rollbackPending ?? null; return { ok: true }; }, emit: async () => {} });
      expect(seenDuring).toBe('health-failed');
      expect(r.action).toBe('rollback');
      expect(readForceWatch(root, env)).toBeNull();
    });
  });
  describe('a transient unreadable HEAD before the forced build ever ran is a retry, never a supersede', () => {
    const sha = 'b'.repeat(40); const lastGood = 'a'.repeat(40);
    const withReady = async () => { await setup(); patchWatch({ startedAt: new Date().toISOString() }); expect(writeReadyCandidate(root, { adopt: { finalSha: sha }, prevHead: lastGood, forced: true }, env)).toBe(true); };
    const tick = (currentHead, extra = {}) => runForceWatchTick({ root, env, currentHead, probe: async () => ({ healthy: true }), rollback: extra.rollback ?? (async () => ({ ok: true })), emit: async () => {}, ...extra });
    it('keeps the watch and the ready record, writes no marker and never calls the rollback', async () => {
      await withReady();
      const rollback = vi.fn(async () => ({ ok: true })); // HEAD===lastGood would read as "already reverted"
      expect((await tick(() => null, { rollback })).action).toBe('waiting');
      expect(rollback).not.toHaveBeenCalled();
      expect(readForceWatch(root, env)).toMatchObject({ ticksLeft: 5 });
      expect(readForceWatch(root, env).rollbackPending).toBeUndefined();
      expect(readReadyCandidate(root, env)).not.toBeNull();
      expect(forceBlockedReason(root, env)).toBe('watch-already-open'); // and no unsaved in-memory obligation either
    });
    it('the next readable tick (still on last-good) keeps waiting: not superseded, ready record kept', async () => {
      await withReady();
      await tick(() => null);
      expect((await tick(lastGood)).action).toBe('waiting');
      expect(readForceWatch(root, env)).not.toBeNull();
      expect(readReadyCandidate(root, env)).not.toBeNull();
    });
    it('a stale head-unreadable marker from a build that never ran is dropped, not turned into a supersede', async () => {
      await withReady();
      patchWatch({ rollbackPending: 'head-unreadable' });
      expect((await tick(lastGood)).action).toBe('waiting');
      expect(readForceWatch(root, env)).not.toBeNull();
      expect(readForceWatch(root, env).rollbackPending).toBeUndefined();
      expect(readReadyCandidate(root, env)).not.toBeNull();
    });
    it('is bounded: a HEAD that stays unreadable past the TTL expires the watch and drops the never-adopted ready record', async () => {
      await withReady();
      const startedAt = Date.parse(readForceWatch(root, env).startedAt);
      const events = [];
      const r = await tick(() => null, { now: () => startedAt + 3 * 3600_000, emit: async (e) => { events.push(e); } });
      expect(r.action).toBe('expired');
      expect(readForceWatch(root, env)).toBeNull();
      expect(readReadyCandidate(root, env)).toBeNull();
      expect(events.map((e) => e.kind)).toContain('force-adopt-watch-expired');
    });
    it('once the build has been adopted (no ready record left), an unreadable HEAD still owes a rollback', async () => {
      await setup();
      const rollback = vi.fn(async () => ({ ok: false }));
      expect(await tick(() => null, { rollback })).toMatchObject({ action: 'rollback-failed', reason: 'head-unreadable' });
      expect(rollback).toHaveBeenCalledTimes(1);
    });
  });
  it('abortForcedWatch never closes a watch that owes a rollback', async () => {
    await setup();
    patchWatch({ rollbackPending: 'health-failed' }); // adoptedSeen unset: only the marker says the build ran
    expect(await abortForcedWatch({ root, env, sha: 'b'.repeat(40), reason: 'x', emit: async () => {} })).toBe(false);
    expect(readForceWatch(root, env)).toMatchObject({ rollbackPending: 'health-failed' });
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

describe('forceRequestFor (the one sha matcher)', () => {
  const arm = (sha) => requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, sha, rulingsText: RULINGS });
  it('returns the request only for exactly its sha, case-insensitively', () => {
    arm(SHA.toUpperCase()); // stored lower-cased
    expect(forceRequestFor(root, env, SHA)).toMatchObject({ ruling: 'R508', sha: SHA });
    expect(forceRequestFor(root, env, SHA.toUpperCase())).not.toBeNull();
    expect(forceRequestFor(root, env, 'c'.repeat(40))).toBeNull();
  });
  it('fails closed: no request, an expired one, an old record with no sha or a malformed sha, and an empty target never match', () => {
    expect(forceRequestFor(root, env, SHA)).toBeNull();
    arm(SHA);
    expect(forceRequestFor(root, env, SHA, () => Date.now() + 3 * 3600_000)).toBeNull(); // past the TTL
    for (const sha of [undefined, '', null, SHA.slice(1), ` ${SHA}`]) {
      expect(forceRequestFor(root, env, sha)).toBeNull();
    }
    writeFileSync(join(env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(root)}.force-adopt.json`), JSON.stringify({ daemon: 'review', ruling: 'R508', quote: QUOTE, expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    expect(forceRequestFor(root, env, SHA)).toBeNull(); // old record, no sha
    expect(forceRequestFor(root, env, undefined)).toBeNull();
  });
});

describe('abortForcedWatch', () => {
  const open = () => recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: SHA, lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => true, now: () => 1 });
  it('closes the watch opened for a discarded forced build and logs it as NOT adopted (reason sanitized)', async () => {
    await open();
    const events = [];
    expect(await abortForcedWatch({ root, env, sha: SHA, reason: 'superseded-omits-live-overlay: lane/x\nforged', emit: async (e) => { events.push(e); } })).toBe(true);
    expect(readForceWatch(root, env)).toBeNull();
    const lines = readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // the adoption line + exactly one NOT-adopted line: the newline in the reason cannot forge another
    expect(lines[1]).toMatch(/NOT adopted b{40} \(superseded-omits-live-overlay: lane\/x\?forged\); watch closed/);
    expect(events[0]).toMatchObject({ kind: 'force-adopt-aborted' });
    expect(readFileSync(env.WE_FORCE_ADOPT_CORONER, 'utf8')).toMatch(/force-adopt-aborted/);
  });
  it('leaves a watch for another sha, a build that already ran as head, or no watch alone', async () => {
    expect(await abortForcedWatch({ root, env, sha: SHA, reason: 'x', emit: async () => {} })).toBe(false); // no watch
    await open();
    expect(await abortForcedWatch({ root, env, sha: 'c'.repeat(40), reason: 'x', emit: async () => {} })).toBe(false);
    await runForceWatchTick({ root, env, currentHead: SHA, probe: async () => ({ healthy: true }), rollback: async () => ({ ok: true }), emit: async () => {} }); // adoptedSeen
    expect(await abortForcedWatch({ root, env, sha: SHA, reason: 'x', emit: async () => {} })).toBe(false);
    expect(readForceWatch(root, env)).not.toBeNull();
  });
});

describe('dropReadyCandidate (every ready-record clear goes through it)', () => {
  const ready = (extra = {}) => ({ kind: 'candidate', prevHead: 'p', tree: 'T', passedAt: new Date().toISOString(), adopt: { finalSha: SHA, inputsKey: 'k', mainSha: 'm', applied: [] }, ...extra });
  const open = () => recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: SHA, lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => true, now: () => 1 });
  it('a forced record that will never be adopted takes its watch with it', async () => {
    await open();
    writeReadyCandidate(root, ready({ forced: true }), env);
    await dropReadyCandidate({ root, env, reason: 'clone-recloned', emit: async () => {} });
    expect(readReadyCandidate(root, env)).toBeNull();
    expect(readForceWatch(root, env)).toBeNull();
    expect(readFileSync(env.WE_FORCE_ADOPT_HANDOFF, 'utf8')).toMatch(/NOT adopted b{40} \(clone-recloned\); watch closed/);
  });
  it('keepSha (the build that is head) and non-forced records leave the watch alone', async () => {
    await open();
    writeReadyCandidate(root, ready({ forced: true }), env);
    await dropReadyCandidate({ root, env, keepSha: SHA, reason: 'up-to-date', emit: async () => {} });
    expect(readReadyCandidate(root, env)).toBeNull();
    expect(readForceWatch(root, env)).not.toBeNull();
    writeReadyCandidate(root, ready(), env); // an ordinary record
    await dropReadyCandidate({ root, env, reason: 'up-to-date', emit: async () => {} });
    expect(readReadyCandidate(root, env)).toBeNull();
    expect(readForceWatch(root, env)).not.toBeNull();
    await dropReadyCandidate({ root, env, reason: 'up-to-date', emit: async () => {} }); // nothing recorded: a no-op
  });
});

describe('matchReadyCandidate: a forced record is pinned to its sha', () => {
  const ready = (extra = {}) => ({ kind: 'candidate', prevHead: 'p', tree: 'T', passedAt: new Date(0).toISOString(), adopt: { finalSha: SHA, inputsKey: 'k', mainSha: 'm', applied: [] }, ...extra });
  const match = (r, planSha, extra = {}) => matchReadyCandidate({
    ready: r, plan: { finalSha: planSha, inputsKey: 'k2', mainSha: 'm2', applied: [] }, prevHead: 'p', treeOf: () => 'T', stillWanted: () => true,
    verifyBuilt: () => true, liveApplied: [], nowMs: 1000, maxAgeMs: 10_000, ...extra,
  });
  const watchOk = { forcedWatch: () => 'ok' };
  it('an ordinary record is still substituted by a same-tree successor (unchanged)', () => {
    expect(match(ready(), 'd'.repeat(40))).toMatchObject({ match: 'same-tree' });
  });
  it('a forced record is adopted only for its exact sha: no same-tree or superseding substitution', () => {
    expect(match(ready({ forced: true }), SHA, watchOk)).toMatchObject({ match: 'exact' });
    expect(match(ready({ forced: true }), 'd'.repeat(40), watchOk)).toEqual({ adopt: null, reason: 'forced-sha-pinned' });
  });
  it.each([['missing'], ['unreadable'], ['owed']])('a forced record whose rollback watch is %s is NOT adoptable (fail closed)', (status) => {
    const seen = [];
    expect(match(ready({ forced: true }), SHA, { forcedWatch: (sha) => { seen.push(sha); return status; } })).toEqual({ adopt: null, reason: `forced-watch-${status}` });
    expect(seen).toEqual([SHA]); // asked about exactly the build the record would adopt
  });
  it('a forced record is not adoptable when no watch status is supplied at all (unknown is not "ok")', () => {
    expect(match(ready({ forced: true }), SHA)).toEqual({ adopt: null, reason: 'forced-watch-missing' });
  });
  it('an ordinary (non-forced) record never asks about a watch', () => {
    const forcedWatch = vi.fn(() => 'missing');
    expect(match(ready(), SHA, { forcedWatch })).toMatchObject({ match: 'exact' });
    expect(forcedWatch).not.toHaveBeenCalled();
  });
});

describe('forcedWatchStatus: the one reader of "is this forced build still watched?"', () => {
  const setup = () => recordForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508', quote: QUOTE }, sha: SHA,
    lastGood: { head: 'a'.repeat(40) }, smoke: { verdict: 'code', failed: [] }, emit: async () => {}, now: () => 1 });
  const watchFile = () => join(env.WE_DAEMON_STATE_DIR, nodeFsReaddir(env.WE_DAEMON_STATE_DIR).find((n) => n.endsWith('.force-watch.json')));
  it('missing: no watch file, or a watch for another build', async () => {
    expect(forcedWatchStatus(root, env, SHA)).toBe('missing');
    await setup();
    expect(forcedWatchStatus(root, env, 'c'.repeat(40))).toBe('missing');
  });
  it('ok: an intact watch for exactly this build', async () => {
    await setup();
    expect(forcedWatchStatus(root, env, SHA)).toBe('ok');
  });
  it('unreadable: the file exists but cannot be parsed (never "missing")', async () => {
    await setup();
    writeFileSync(watchFile(), '{corrupt');
    expect(forcedWatchStatus(root, env, SHA)).toBe('unreadable');
  });
  it('owed: the watch carries a rollback obligation', async () => {
    await setup();
    await runForceWatchTick({ root, env, currentHead: SHA, probe: async () => ({ healthy: false }), rollback: async () => ({ ok: false }), emit: async () => {} });
    expect(forcedWatchStatus(root, env, SHA)).toBe('owed');
  });
});
