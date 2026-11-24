import { expect, it } from 'vitest';
import smell from '../zero-success-alarm.mjs';
import { runHealthTick } from '../../health-watch-core.mjs';
import { zeroSuccessVerdicts, parseLoopTicks } from '../../health-loop-ticks.mjs';

const minute = 60_000;
const now = Date.parse('2026-11-24T12:00:00Z');
const tick = (ageMin, o = {}) => ({ at: now - ageMin * minute, loop: 'prepare', attempted: 230, succeeded: 0, failed: 230, error: 'spawn ENOENT', ...o });
const failing = (n = 7, step = 10) => Array.from({ length: n }, (_, i) => tick(i * step));
const run = (records, prev = null, t = now) => runHealthTick(prev, { loopTicks: { records } }, [smell], t);

it('raises one alarm after an hour of ticks with zero successes', () => {
  const r = run(failing());
  const eps = Object.values(r.state.episodes);
  expect(eps).toHaveLength(1);
  expect(eps[0]).toMatchObject({ smell: 'zero-success-alarm', subject: 'prepare', status: 'open' });
  const v = zeroSuccessVerdicts(failing(), { now })[0];
  expect(v).toMatchObject({ breach: true, dominantError: 'spawn ENOENT' });
});

it('one success, or fewer than the minimum ticks, raises nothing', () => {
  const withSuccess = [...failing(), tick(25, { succeeded: 1, failed: 229 })];
  expect(Object.keys(run(withSuccess).state.episodes)).toHaveLength(0);
  expect(Object.keys(run(failing(2, 30)).state.episodes)).toHaveLength(0);
});

it('idle ticks with nothing to do are not failures', () => {
  const idle = failing().map((t) => ({ ...t, attempted: 0, failed: 0 }));
  expect(Object.keys(run(idle).state.episodes)).toHaveLength(0);
});

it('the same loop raises one alarm, not one per tick, and clears on the first success', () => {
  const first = run(failing());
  const later = run([...failing(), tick(-10)], first.state, now + 10 * minute);
  expect(Object.keys(later.state.episodes)).toHaveLength(1);
  const stillFailing = run([tick(-20)], later.state, now + 20 * minute);
  expect(Object.values(stillFailing.state.episodes).some((e) => e.status === 'open')).toBe(true);
  const healed = run([tick(-20, { succeeded: 5, failed: 0 })], later.state, now + 20 * minute);
  expect(Object.values(healed.state.episodes).every((e) => e.status !== 'open')).toBe(true);
});

it('is read-only: it never mutates its input records', () => {
  const records = failing();
  const copy = JSON.parse(JSON.stringify(records));
  run(records);
  expect(records).toEqual(copy);
});

it('parses JSON lines and skips junk', () => {
  const text = [JSON.stringify({ at: new Date(now).toISOString(), loop: 'drain-catchup', failed: 1 }), 'garbage', '{bad'].join('\n');
  expect(parseLoopTicks(text)).toHaveLength(1);
});

import { parsePrepareTicks, parseDrainCatchupTicks } from '../../health-loop-ticks.mjs';

const prepLine = (ageMin, o = {}) => JSON.stringify({ at: new Date(now - ageMin * minute).toISOString(), timings: {},
  prepare: { launched: [], failures: Array.from({ length: 230 }, (_, i) => ({ num: String(4000 + i), stage: 'retirement', reason: 'prepare PR listing call budget exhausted (96 of 128)' })), ...o } });
const drainLine = (ageMin, exit, outcome, tail = 'no JSON result') => `[drain-daemon] ${new Date(now - ageMin * minute).toISOString()} enqueue-on-event: catch-up #7395 fast drain exit ${exit}, 2597B stderr, class=unknown in 4s — ${tail} [outcome=${outcome}]`;
const feed = (text, parse, t = now) => runHealthTick(null, { loopTicks: { records: parse(text) } }, [smell], t);

it('live replay: the prepare window (many failures, no launches) raises exactly one alarm', () => {
  const text = Array.from({ length: 8 }, (_, i) => prepLine(i * 10)).join('\n');
  const r = feed(text, parsePrepareTicks);
  expect(Object.values(r.state.episodes)).toHaveLength(1);
  expect(Object.values(r.state.episodes)[0].subject).toBe('prepare');
});

it('live replay: drain catch-up exit-1 run raises one alarm; the same log with a verdict inside raises none', () => {
  const bad = Array.from({ length: 8 }, (_, i) => drainLine(i * 10, 1, 'error')).join('\n');
  expect(Object.values(feed(bad, parseDrainCatchupTicks).state.episodes)).toHaveLength(1);
  const healthy = `${bad}\n${drainLine(20, 0, 'not-enqueued', 'not enqueued: red-team-pending')}`;
  expect(Object.keys(feed(healthy, parseDrainCatchupTicks).state.episodes)).toHaveLength(0);
});

it('a healthy prepare loop (launches) and idle ticks raise nothing', () => {
  const ok = Array.from({ length: 8 }, (_, i) => prepLine(i * 10, { launched: [{ num: '1' }], failures: [] })).join('\n');
  const idle = Array.from({ length: 8 }, (_, i) => prepLine(i * 10, { failures: [] })).join('\n');
  expect(Object.keys(feed(ok, parsePrepareTicks).state.episodes)).toHaveLength(0);
  expect(parsePrepareTicks(idle)).toHaveLength(0);
});

it('counts whole-tick failures (tick-failed) as prepare failures and raises one alarm', () => {
  const text = Array.from({ length: 8 }, (_, i) => JSON.stringify({ at: new Date(now - i * 10 * minute).toISOString(), event: 'tick-failed', timings: {} })).join('\n');
  expect(parsePrepareTicks(text)).toHaveLength(8);
  const r = feed(text, parsePrepareTicks);
  expect(Object.values(r.state.episodes)).toHaveLength(1);
  expect(Object.values(r.state.episodes)[0].subject).toBe('prepare');
});

it('counts the drain catch handler "could not finish (class=...)" lines as failures', () => {
  const line = (ageMin) => `[drain-daemon] ${new Date(now - ageMin * minute).toISOString()} enqueue-on-event: catch-up #7395 — could not finish (class=unknown)`;
  const text = Array.from({ length: 8 }, (_, i) => line(i * 10)).join('\n');
  expect(parseDrainCatchupTicks(text)[0]).toMatchObject({ failed: 1, error: 'could not finish (class=unknown)' });
  const r = feed(text, parseDrainCatchupTicks);
  expect(Object.values(r.state.episodes)).toHaveLength(1);
});

it('parses logger-timestamp-prefixed prepare lines (production format) as failures', () => {
  const stamp = (ageMin) => new Date(now - ageMin * minute).toISOString();
  const failed = Array.from({ length: 4 }, (_, i) => `${stamp(i * 20)} ${JSON.stringify({ at: stamp(i * 20), event: 'tick-failed', timings: { loop: 'build' } })}`);
  const parsed = parsePrepareTicks(failed.join('\n'));
  expect(parsed).toHaveLength(4);
  expect(parsed.every((p) => p.failed === 1 && p.error === 'tick-failed')).toBe(true);
  const withFailures = `﻿${stamp(5)} ${prepLine(5)}`;
  expect(parsePrepareTicks(withFailures)[0].failed).toBe(230);
  expect(Object.values(feed(failed.join('\n'), parsePrepareTicks, now).state.episodes)).toHaveLength(1);
});
