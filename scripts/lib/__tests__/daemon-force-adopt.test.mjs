import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateForceAdopt, requestForceAdopt, readForceAdopt, recordForcedAdoption, abortForcedAdoption, readForceWatch,
  evaluateForceWatch, runForceWatchTick,
} from '../daemon-force-adopt.mjs';

const RULINGS = '## R508 — 2026-11-03\nOperator "Yes": adopt the build now even though smoke failed.\n\n## R509 — x\nother words\n';
const QUOTE = 'adopt the build now even though smoke failed';
let dir; let env; let root;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'force-adopt-'));
  root = join(dir, 'clone');
  env = { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_FORCE_ADOPT_HANDOFF: join(dir, 'handoff.md'), WE_FORCE_ADOPT_CORONER: join(dir, 'coroner.jsonl') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('validateForceAdopt', () => {
  it('refuses with no ruling id', () => {
    expect(validateForceAdopt({ daemon: 'review', quote: QUOTE, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'no-ruling' });
  });
  it('refuses a malformed ruling id', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: '508', quote: QUOTE, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'bad-ruling-id' });
  });
  it('refuses a ruling that is not in the rulings file', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R999', quote: QUOTE, rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'ruling-unknown' });
  });
  it('refuses a missing or short quote', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'no-quote' });
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: 'yes', rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'quote-too-short' });
  });
  it('refuses a quote that is not verbatim in THAT ruling (even if in another)', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: 'other words entirely here', rulingsText: RULINGS })).toMatchObject({ ok: false, reason: 'quote-not-in-ruling' });
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: 'other words', rulingsText: RULINGS })).toMatchObject({ ok: false });
  });
  it('accepts ruling + verbatim quote', () => {
    expect(validateForceAdopt({ daemon: 'review', ruling: 'R508', quote: QUOTE, rulingsText: RULINGS })).toEqual({ ok: true });
  });
});

describe('requestForceAdopt', () => {
  it('writes nothing without a ruling', () => {
    const r = requestForceAdopt({ root, env, daemon: 'review', quote: QUOTE, rulingsText: RULINGS });
    expect(r.ok).toBe(false);
    expect(readForceAdopt(root, env)).toBeNull();
  });
  it('writes a one-shot request with a ruling + quote', () => {
    const r = requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, rulingsText: RULINGS, now: () => 1000 });
    expect(r.ok).toBe(true);
    expect(readForceAdopt(root, env, () => 2000)).toMatchObject({ daemon: 'review', ruling: 'R508', quote: QUOTE });
  });
});

describe('request safety', () => {
  it('a dry run validates but never arms an adoption', () => {
    const r = requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, rulingsText: RULINGS, dryRun: true });
    expect(r.ok).toBe(true);
    expect(readForceAdopt(root, env)).toBeNull();
  });
  it('an expired request never fires', () => {
    requestForceAdopt({ root, env, daemon: 'review', ruling: 'R508', quote: QUOTE, rulingsText: RULINGS, now: () => 1000 });
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
  it('refuses when the handoff file cannot be written', async () => {
    writeFileSync(join(dir, 'blocker'), 'x');
    const r = await recordForcedAdoption({ ...args(), env: { ...env, WE_FORCE_ADOPT_HANDOFF: join(dir, 'blocker', 'x') }, emit: async () => true });
    expect(r.ok).toBe(false);
  });
  it('abort drops the watch and consumes the request', async () => {
    await recordForcedAdoption({ ...args(), emit: async () => true });
    await abortForcedAdoption({ root, env, request: { daemon: 'review', ruling: 'R508' }, sha: 'b'.repeat(40), emit: async () => {} });
    expect(readForceWatch(root, env)).toBeNull();
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
});
