/** #3383 — Operator inspection, settlement and audited overrides never delete attempts. */
import { it, expect, beforeEach, mock, spyOn } from 'bun:test';
const defaults = ((fn) => fn())(() => ({ listAgents: mock(() => []), findEffect: mock(() => ({ found: false })), postconditionHolds: mock(() => true) }));
mock.module('../../../../scripts/operations/action-ground-truth.mjs', () => ({ defaultGroundTruth: () => defaults }));
import { actionCli } from '../../../../scripts/operations/action-cli.mjs';
import { createActionStore } from '../../../../scripts/operations/action-store.mjs';
import { actionResource, ABSENCE_GRACE_MS } from '../../../../scripts/operations/action-record.mjs';
import { guardedDispatch } from '../../../../scripts/operations/action-dispatch.mjs';
let actions, clock, lines;
const resource = actionResource('we', { type: 'pr', id: 77 });
const now = () => clock;
const cli = (argv, extra = {}) => actionCli(argv, { actions, now, write: (s) => lines.push(s), ...extra });
const dispatch = (effect = () => 'review-pr-123') => guardedDispatch({ resource, kind: 'review', owner: 'driver', actions, now, effect });
const resolveArgs = (outcome = 'settled') => ['resolve', `--resource=${resource}`, '--attempt=1', `--outcome=${outcome}`, '--reason=verified by operator'];
beforeEach(() => {
  mock.clearAllMocks(); defaults.postconditionHolds.mockReturnValue(true);
  clock = 1_000; lines = []; actions = createActionStore({ now });
});
it('lists every attempt as JSON; --open excludes terminal attempts', async () => {
  dispatch(() => ({ notStarted: true })); dispatch();
  expect(await cli(['list', '--json'])).toBe(0);
  expect(JSON.parse(lines.pop()).map((r) => r.attempt)).toEqual([1, 2]);
  expect(await cli(['list', '--json', '--open'])).toBe(0);
  expect(JSON.parse(lines.pop()).map((r) => r.attempt)).toEqual([2]);
  expect(await cli(['list'])).toBe(0);
  expect(lines.join('\n')).toContain(`${resource} attempt=1 terminal not-started`);
  expect(lines.join('\n')).toContain('attempt=2 observed');
});
it('settle uses default ports and prints each result, retaining all records', async () => {
  dispatch();
  expect(await cli(['settle', '--json'])).toBe(0);
  expect(JSON.parse(lines.pop())).toMatchObject([{ ok: true, record: { state: 'terminal', outcome: 'settled' } }]);
  expect(defaults.postconditionHolds).toHaveBeenCalledTimes(1);
  expect(actions.list()).toHaveLength(1);
  expect(await cli(['settle'])).toBe(0);
});
it('settle reconciles expired dispatching with default absence readers', async () => {
  dispatch(() => null); clock += ABSENCE_GRACE_MS + 1;
  expect(await cli(['settle'])).toBe(0);
  expect(lines.join('\n')).toContain('terminal abandoned-absent');
  expect(defaults.listAgents).toHaveBeenCalled();
});
it('settle exits nonzero and reports held when the postcondition cannot be read', async () => {
  dispatch();
  defaults.postconditionHolds.mockImplementationOnce(() => { throw new Error('offline'); });
  expect(await cli(['settle'])).toBe(1);
  expect(lines[0]).toContain('held:indeterminate');
  expect(actions.read(resource, 1).state).toBe('observed');
});
it.each(['intent', 'dispatching', 'observed'])('resolve audits either supported outcome from %s using its token and revision', async (state) => {
  for (const outcome of ['settled', 'abandoned-absent']) {
    const record = actions.claim({ resource, kind: 'review', owner: 'driver', evidence: { sessionSlug: 'review-77' } }).record;
    if (state !== 'intent') actions.transition(resource, record.attempt, { token: record.ownerToken, from: 'intent', to: 'dispatching', patch: { dispatchingSince: now() } });
    if (state === 'observed') actions.transition(resource, record.attempt, { token: record.ownerToken, from: 'dispatching', to: 'observed', patch: { handle: 'review-pr-123' } });
    const transition = spyOn(actions, 'transition');
    const args = resolveArgs(outcome).map((arg) => arg === '--attempt=1' ? `--attempt=${record.attempt}` : arg);
    expect(await cli(args)).toBe(0);
    expect(transition).toHaveBeenLastCalledWith(resource, record.attempt, expect.objectContaining({ token: record.ownerToken, from: state, rev: actions.read(resource, record.attempt).rev - 1 }));
    expect(actions.read(resource, record.attempt)).toMatchObject({ state: 'terminal', outcome, evidence: {
      sessionSlug: 'review-77', operatorResolved: { reason: 'verified by operator', at: clock },
    } });
    transition.mockRestore();
  }
  expect(actions.attempts(resource)).toHaveLength(2);
});
it('refuses an already terminal record without modifying it', async () => {
  dispatch(() => ({ notStarted: true }));
  const original = actions.read(resource, 1);
  expect(await cli(resolveArgs())).toBe(1);
  expect(lines[0]).toContain('already-terminal');
  expect(actions.read(resource, 1)).toEqual(original);
});
it.each([
  ['--outcome=unknown'], ['--outcome=not-started'], ['--reason='], ['--attempt=0'], ['--attempt=1.2'],
  ['--attempt=999'], ['--resource=missing'], ['--reason'],
])('refuses malformed or nonexistent resolution %j', async (flag) => {
  dispatch(); const original = actions.read(resource, 1);
  const key = flag.split('=')[0];
  const args = resolveArgs().map((s) => s.split('=')[0] === key ? flag : s);
  expect(await cli(args)).toBe(1);
  expect(actions.read(resource, 1)).toEqual(original);
});
it.each([[], ['unknown'], ['list', '--oops'], ['list', '--json=false'], ['settle', '--open'], ['resolve'], ['list', '--json', '--json']])('rejects invalid commands/flags %j', async (...args) => {
  expect(await cli(args)).toBe(1);
});
it('a concurrent owner update fences an operator override', async () => {
  dispatch(); const transition = actions.transition;
  const raced = { ...actions, transition: (...args) => {
    const current = actions.read(resource, 1);
    actions.heartbeat(resource, 1, current.ownerToken);
    return transition(...args);
  } };
  expect(await cli(resolveArgs(), { actions: raced })).toBe(1);
  expect(lines[0]).toContain('stale-rev');
  expect(actions.read(resource, 1).state).toBe('observed');
});
it('list and settle return failure when the store is unreadable', async () => {
  const broken = { list: () => { throw new Error('corrupt record'); } };
  expect(await cli(['list'], { actions: broken })).toBe(1);
  expect(await cli(['settle'], { actions: broken })).toBe(1);
  expect(lines).toEqual(['error: corrupt record', 'error: corrupt record']);
});
