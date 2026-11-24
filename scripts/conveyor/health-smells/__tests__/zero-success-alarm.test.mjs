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
  const healed = run([tick(0, { succeeded: 5, failed: 0 })], later.state, now + 20 * minute);
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
