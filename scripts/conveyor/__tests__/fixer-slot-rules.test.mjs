/**
 * Replay fixtures for the fixer slot rules (we:scripts/conveyor/fixer-slot-rules.mjs, we:backlog/xn025gx): plain facts in,
 * decision out. Facts are taken from the 2026-10-08 fixer audit where one exists.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveFixerSlotSettings, FIXER_SLOT_SETTINGS_BUILT_IN, fixSlotState, fixSlotCount, slotCountedItems, admitResumes,
  awaitPassRunner, releaseOnCompletion,
} from '../fixer-slot-rules.mjs';

const MIN = 60_000;
const T = Date.parse('2026-10-08T19:41:31Z');
const TTL = 150 * MIN;

describe('settings — the built-in is today, the file declares the ruling, env wins', () => {
  it('no file, no env → every feature off (today)', () => {
    expect(resolveFixerSlotSettings({ env: {}, file: null })).toEqual({ ...FIXER_SLOT_SETTINGS_BUILT_IN });
    expect(FIXER_SLOT_SETTINGS_BUILT_IN).toMatchObject({ awaitVerifyLoopSeconds: 0, parkedReleasesSlot: false, releaseOnCompletion: false });
  });
  it('file values apply; invalid ones fall to the built-in, never to on', () => {
    const file = { fixDispatch: { awaitVerifyLoopSeconds: 15, parkedReleasesSlot: 'on', parkedCapFactor: 2, releaseOnCompletion: 'on' } };
    expect(resolveFixerSlotSettings({ env: {}, file })).toEqual({ awaitVerifyLoopSeconds: 15, parkedReleasesSlot: true, parkedCapFactor: 2, releaseOnCompletion: true });
    const bad = { fixDispatch: { awaitVerifyLoopSeconds: -3, parkedReleasesSlot: 'yes', parkedCapFactor: 0.5, releaseOnCompletion: 1 } };
    expect(resolveFixerSlotSettings({ env: {}, file: bad })).toEqual({ ...FIXER_SLOT_SETTINGS_BUILT_IN });
  });
  it('env overrides the file (off switch without a deploy); the loop never runs under the floor', () => {
    const file = { fixDispatch: { awaitVerifyLoopSeconds: 15, parkedReleasesSlot: 'on', releaseOnCompletion: 'on' } };
    const env = { WE_AWAIT_VERIFY_LOOP_SECONDS: '0', WE_FIX_PARKED_RELEASES_SLOT: 'off', WE_FIX_RELEASE_ON_COMPLETION: 'off' };
    expect(resolveFixerSlotSettings({ env, file })).toEqual({ ...FIXER_SLOT_SETTINGS_BUILT_IN });
    expect(resolveFixerSlotSettings({ env: { WE_AWAIT_VERIFY_LOOP_SECONDS: '1' }, file: null }).awaitVerifyLoopSeconds).toBe(5);
  });
});

describe('R1 fix-slot-state', () => {
  const at = (ageMin, verdictDecided = false) => ({ requestedAtMs: T - ageMin * MIN, verdictDecided });
  it.each([
    ['no verify wait recorded', null, 'active'],
    ['waiting on verify, verdict not in', at(5), 'parked'],
    ['verdict in (pushed or red), wake-up owed', at(5, true), 'resume-owed'],
    ['wait older than the TTL is not trusted', at(151), 'active'],
    ['wait from the future is not trusted', at(-10), 'active'],
  ])('%s → %s', (_name, wait, want) => {
    expect(fixSlotState({ wait, nowMs: T, ttlMs: TTL })).toBe(want);
  });
});

describe('R2 fix-slot-count', () => {
  it('off: every live session counts — the 19:41 audit tick read "7 live ≥ cap 6"', () => {
    const states = ['active', 'active', 'parked', 'parked', 'parked', 'active', 'active'];
    expect(fixSlotCount({ states, cap: 6, parkedReleasesSlot: false })).toBe(7);
  });
  it('on: parked sessions give their slot back, so the same tick admits 2 of the 3 refused fixes (4484, 4478, 4433); R5 frees the third', () => {
    const states = ['active', 'active', 'parked', 'parked', 'parked', 'active', 'active'];
    const n = fixSlotCount({ states, cap: 6, parkedReleasesSlot: true, parkedCapFactor: 2 });
    expect(n).toBe(4);
    expect(6 - n).toBe(2); // 2 new admissions now; a third once a finished claim is released (R5)
  });
  it('on: an owed resume keeps its slot (resumes first — no new dispatch can take it)', () => {
    expect(fixSlotCount({ states: ['active', 'resume-owed', 'resume-owed', 'parked'], cap: 3, parkedReleasesSlot: true })).toBe(3);
  });
  it('on: parked sessions are capped at factor × cap in total', () => {
    const states = [...Array(2).fill('active'), ...Array(10).fill('parked')];
    // total 12 = 2 × cap 6: full, nothing new
    expect(fixSlotCount({ states, cap: 6, parkedReleasesSlot: true, parkedCapFactor: 2 })).toBe(6);
    expect(fixSlotCount({ states: states.slice(1), cap: 6, parkedReleasesSlot: true, parkedCapFactor: 2 })).toBe(5);
  });
  it('slotCountedItems presents exactly that many items, working ones first', () => {
    const items = [{ state: 'parked', item: 'p1' }, { state: 'active', item: 'a1' }, { state: 'resume-owed', item: 'r1' }, { state: 'parked', item: 'p2' }];
    expect(slotCountedItems({ items, cap: 2, parkedReleasesSlot: true, parkedCapFactor: 2 })).toEqual(['a1', 'r1']);
    expect(slotCountedItems({ items, cap: 2, parkedReleasesSlot: false })).toEqual(['a1', 'r1', 'p1', 'p2']);
    expect(slotCountedItems({ items, cap: 1, parkedReleasesSlot: true, parkedCapFactor: 2 })).toEqual(['a1', 'r1', 'p1']);
  });
});

describe('R3 resume-admission', () => {
  const owed = [{ key: 'b', requestedAtMs: T - 2 * MIN }, { key: 'a', requestedAtMs: T - 9 * MIN }, { key: 'c', requestedAtMs: T - 1 * MIN }];
  it('off: every owed resume wakes (today)', () => {
    expect(admitResumes({ owed, activeCount: 99, cap: 6, parkedReleasesSlot: false })).toEqual({ admit: ['a', 'b', 'c'], defer: [] });
  });
  it('on: oldest wait first, while working + woken < cap', () => {
    expect(admitResumes({ owed, activeCount: 4, cap: 6, parkedReleasesSlot: true })).toEqual({ admit: ['a', 'b'], defer: ['c'] });
    expect(admitResumes({ owed, activeCount: 6, cap: 6, parkedReleasesSlot: true })).toEqual({ admit: [], defer: ['a', 'b', 'c'] });
  });
});

describe('R4 push-wake-cadence', () => {
  it.each([
    ['loop off', { loopSeconds: 0, loopHeartbeatAtMs: T }, 'tick', 'loop-off'],
    ['loop on, heartbeat fresh', { loopSeconds: 15, loopHeartbeatAtMs: T - 20_000 }, 'loop', 'loop-alive'],
    ['loop on, heartbeat stale', { loopSeconds: 15, loopHeartbeatAtMs: T - 3 * MIN }, 'tick', 'loop-not-alive'],
    ['loop on, no heartbeat', { loopSeconds: 15, loopHeartbeatAtMs: null }, 'tick', 'loop-not-alive'],
  ])('%s → %s', (_n, facts, runner, reason) => {
    expect(awaitPassRunner({ ...facts, nowMs: T })).toEqual({ runner, reason });
  });
});

describe('R5 release-on-completion — the audit\'s finished-but-holding sessions', () => {
  const claim = { claimedAtMs: Date.parse('2026-10-08T19:28:00Z'), sessionId: null };
  const done = (iso, over = {}) => ({ status: 'done', updatedAtMs: Date.parse(iso), sessionId: 's-4481', ...over });
  it('fix-4481 finished 19:43 (claim held to 19:55) → release at once', () => {
    expect(releaseOnCompletion({ enabled: true, claim, completion: done('2026-10-08T19:43:00Z'), awaitingVerify: false })).toEqual({ release: true, reason: 'completion-done' });
  });
  it.each([
    ['setting off (today)', { enabled: false }, 'off'],
    ['no record yet', { completion: null }, 'no-completion-record'],
    ['session still running (started)', { completion: { ...done('2026-10-08T19:43:00Z'), status: 'started' } }, 'completion-started'],
    ['a previous round\'s record', { completion: done('2026-10-08T19:10:00Z') }, 'record-older-than-claim'],
    ['another session wrote it', { claim: { ...claim, sessionId: 's-other' }, completion: done('2026-10-08T19:43:00Z') }, 'other-session'],
    ['still parked on verify', { completion: done('2026-10-08T19:43:00Z'), awaitingVerify: true }, 'still-awaiting-verify'],
    ['claim time unknown', { claim: { claimedAtMs: NaN, sessionId: null } }, 'unknown-times'],
    ['record time unknown', { completion: { ...done('2026-10-08T19:43:00Z'), updatedAtMs: NaN } }, 'unknown-times'],
    ['woken (e.g. to repair a red) after it reported done', { lastWokenAtMs: Date.parse('2026-10-08T19:50:00Z') }, 'record-older-than-last-wake'],
  ])('%s → keep (%s)', (_n, over, reason) => {
    const facts = { enabled: true, claim, completion: done('2026-10-08T19:43:00Z'), awaitingVerify: false, ...over };
    expect(releaseOnCompletion(facts)).toEqual({ release: false, reason });
  });
});
