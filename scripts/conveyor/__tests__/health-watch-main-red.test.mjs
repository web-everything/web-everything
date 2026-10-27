import { describe, expect, it, vi } from 'vitest';
import { mainRedState } from '../main-ci-red-core.mjs';
import { diffFeed, parseFeedLine } from '../../operations/needs-you-feed.mjs';
import {
  mainRedAlertSettings, planMainRedAlert, runMainRedAlert,
} from '../health-watch-main-red.mjs';

const MINUTE = 60_000;
const SINCE = '2026-10-26T12:00:00.000Z';
const START = Date.parse(SINCE);
const RED_SHA = 'a'.repeat(40);
const GREEN_SHA = 'b'.repeat(40);
const TIP_SHA = 'c'.repeat(40);
const run = (headSha, conclusion, createdAt, databaseId) => ({
  headSha, databaseId, status: 'completed', conclusion, createdAt,
  updatedAt: new Date(Date.parse(createdAt) + MINUTE).toISOString(),
});
const redRuns = () => [
  run(RED_SHA, 'failure', SINCE, 2),
  run(GREEN_SHA, 'success', '2026-10-26T11:50:00.000Z', 1),
];
const greenRuns = () => [
  ...redRuns(), run(TIP_SHA, 'success', '2026-10-26T12:25:00.000Z', 3),
];
const details = () => ({
  failingJobs: ['test-shard (3)', 'test'],
  firstFailingTest: 'routing.test.mjs > rejects invalid routes',
  blockedReadyPrs: 4,
  fixPrs: [4522, 4510],
});
const input = (overrides = {}) => ({
  runs: redRuns(), readOk: true, now: START + 30 * MINUTE, prev: {},
  settings: mainRedAlertSettings({}), details: details(), ...overrides,
});
const plan = (overrides = {}) => planMainRedAlert(input(overrides));
const kinds = (result) => result.items.map((item) => item.kind);
const passingTip = () => ({
  sha: TIP_SHA, runStatus: 'completed', requiredChecks: ['test'], checksTotal: 1,
  checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }],
});

describe('planMainRedAlert — recovery requires affirmative conclusions on every tip check', () => {
  describe.each(['workflow-SHA', 'tip-required-checks'])('%s recovery', (via) => {
    const recoveryInput = (check) => ({
      runs: via === 'workflow-SHA' ? greenRuns() : redRuns(),
      tip: {
        ...passingTip(),
        // Keep the workflow-SHA case independent of required-check recovery.
        requiredChecks: via === 'workflow-SHA' ? ['not-on-page'] : ['test'],
        checksTotal: 2,
        checkRuns: [...passingTip().checkRuns, { id: 2, name: 'smoke', ...check }],
      },
    });

    it.each([
      ['completed', 'cancelled'],
      ['completed', 'skipped'],
      ['completed', 'timed_out'],
      ['completed', null],
      ['queued', 'success'],
      ['in_progress', 'neutral'],
    ])('fails closed once for a %s tip check with conclusion %j, preserving the outstanding alert', (status, conclusion) => {
      const observation = recoveryInput({ status, conclusion });
      const state = mainRedState(observation.runs, { tip: observation.tip });
      expect(state.status).toBe('green');
      if (via === 'tip-required-checks') expect(state.via).toBe(via);
      else {
        expect(state.via).not.toBe('tip-required-checks');
        expect(state.latestGreen.sha).toBe(observation.tip.sha);
      }

      const red = plan();
      const unknown = plan({ ...observation, prev: red.next });
      expect.soft(kinds(unknown)).toEqual(['main-status-unknown']);
      expect.soft(unknown.next.fingerprint).toBe(red.next.fingerprint);
      expect.soft(unknown.next.fingerprintParts).toEqual(red.next.fingerprintParts);
      expect.soft(unknown.next.unknownEmitted).toBe(true);

      const repeated = plan({ ...observation, prev: unknown.next, now: START + 31 * MINUTE });
      expect.soft(repeated.items).toEqual([]);
      expect.soft(repeated.next.fingerprint).toBe(red.next.fingerprint);
      expect.soft(repeated.next.fingerprintParts).toEqual(red.next.fingerprintParts);
      expect.soft(repeated.next.unknownEmitted).toBe(true);

      const recovered = plan({
        ...recoveryInput({ status: 'completed', conclusion: 'neutral' }), prev: repeated.next,
      });
      expect.soft(kinds(recovered)).toEqual(['main-green']);
      expect.soft(recovered.next.fingerprint).toBeNull();
      expect.soft(recovered.next.unknownEmitted).toBe(false);
    });

    it.each([
      ['missing', undefined],
      ['larger than the returned page', 2],
      ['smaller than the returned page', 0],
      ['a string instead of a number', '1'],
    ])('fails closed once when checksTotal is %s, preserving the outstanding alert', (_name, checksTotal) => {
      const observation = {
        runs: via === 'workflow-SHA' ? greenRuns() : redRuns(),
        tip: {
          ...passingTip(),
          requiredChecks: via === 'workflow-SHA' ? ['not-on-page'] : ['test'],
          checksTotal,
        },
      };
      if (checksTotal === undefined) delete observation.tip.checksTotal;
      const state = mainRedState(observation.runs, { tip: observation.tip });
      expect(state.status).toBe('green');
      if (via === 'tip-required-checks') expect(state.via).toBe(via);
      else {
        expect(state.via).not.toBe('tip-required-checks');
        expect(state.latestGreen.sha).toBe(observation.tip.sha);
      }

      const red = plan();
      const unknown = plan({ ...observation, prev: red.next });
      expect.soft(kinds(unknown)).toEqual(['main-status-unknown']);
      expect.soft(unknown.next.fingerprint).toBe(red.next.fingerprint);
      expect.soft(unknown.next.fingerprintParts).toEqual(red.next.fingerprintParts);
      expect.soft(unknown.next.unknownEmitted).toBe(true);

      const repeated = plan({ ...observation, prev: unknown.next, now: START + 31 * MINUTE });
      expect.soft(repeated.items).toEqual([]);
      expect.soft(repeated.next.fingerprint).toBe(red.next.fingerprint);
      expect.soft(repeated.next.fingerprintParts).toEqual(red.next.fingerprintParts);
      expect.soft(repeated.next.unknownEmitted).toBe(true);
    });

    it.each(['success', 'neutral'])('clears only when every tip check is completed with success or neutral (%s)', (conclusion) => {
      const observation = recoveryInput({ status: 'completed', conclusion });
      const recovered = plan({ ...observation, prev: plan().next });
      expect(kinds(recovered)).toEqual(['main-green']);
      expect(recovered.next.fingerprint).toBeNull();
      expect(recovered.next.unknownEmitted).toBe(false);
    });
  });
});

describe('runMainRedAlert — feed deduplication after publish succeeds and state persistence fails', () => {
  it.each([
    ['main-status-unknown', 'empty persisted state'],
    ['main-status-unknown', 'outstanding red alert'],
    ['main-status-unknown', 'legacy alert without seq'],
    ['main-red', 'empty persisted state'],
    ['main-red', 'changed alert details'],
    ['main-green', 'outstanding red alert'],
  ])('replays the same %s head from %s at a later tick without a duplicate feed event', async (kind, scenario) => {
    const initial = scenario === 'empty persisted state' ? {} : plan({ prev: { seq: 40 } }).next;
    if (scenario === 'legacy alert without seq') delete initial.seq;
    const oldState = structuredClone(initial);
    let persisted = structuredClone(initial);
    let openKeys = [];
    const events = [];
    const feedBatches = [];
    let tickNow = START + 30 * MINUTE;
    const writeError = new Error('simulated state write failure after successful publish');
    const readState = vi.fn(async () => structuredClone(persisted));
    const writeState = vi.fn()
      .mockRejectedValueOnce(writeError)
      .mockImplementation(async (_dir, next) => { persisted = structuredClone(next); });
    const publish = vi.fn(async (item) => {
      const feed = diffFeed(openKeys, [item], tickNow, { incomplete: true });
      openKeys = feed.openKeys;
      feedBatches.push(feed.lines);
      events.push(...feed.lines.map(parseFeedLine));
    });
    const args = {
      dir: 'unused-injected-state', readState, writeState, publish,
      probe: kind === 'main-status-unknown' ? null : kind === 'main-green'
        ? { runs: greenRuns(), tip: passingTip() } : { runs: redRuns() },
      readDetails: vi.fn(async () => scenario === 'changed alert details'
        ? { ...details(), failingJobs: ['smoke'] } : details()),
    };

    await expect(runMainRedAlert({ ...args, now: tickNow })).rejects.toBe(writeError);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual(oldState);
    expect(feedBatches[0]).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual([kind]);

    tickNow += MINUTE;
    const retried = await runMainRedAlert({ ...args, now: tickNow });
    expect(readState.mock.results).toHaveLength(2);
    expect(await readState.mock.results[1].value).toEqual(oldState);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(kinds(retried)).toEqual([kind]);
    const [firstItem, replayedItem] = publish.mock.calls.map(([item]) => item);
    expect.soft(replayedItem.head).toBe(firstItem.head);
    expect.soft(firstItem.head).not.toContain(String(START + 30 * MINUTE));
    expect.soft(replayedItem.head).not.toContain(String(tickNow));
    expect.soft(feedBatches[1]).toEqual([]);
    expect.soft(events.map((event) => event.kind)).toEqual([kind]);
    expect.soft(openKeys).toHaveLength(1);
    expect(persisted).toEqual(retried.next);
    expect(persisted.seq).toBe((oldState.seq ?? 0) + 1);

    tickNow += MINUTE;
    const quiet = await runMainRedAlert({ ...args, now: tickNow });
    expect(quiet.items).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(writeState).toHaveBeenCalledTimes(3);
  });
});

describe('planMainRedAlert — proven tip recovery regressions', () => {
  const successfulChecks = (count) => Array.from({ length: count }, (_, index) => ({
    id: index + 1, name: `check-${index + 1}`, status: 'completed', conclusion: 'success',
  }));

  it.each([100, 101])('fails closed once after an alert for %i successful checks with only matching-SHA recovery proof', (count) => {
    // No required check appears in this possibly truncated page, so only the workflow SHA matches.
    const tip = { ...passingTip(), checksTotal: count, checkRuns: successfulChecks(count) };
    const state = mainRedState(greenRuns(), { tip });
    expect(state.status).toBe('green');
    expect(state.via).not.toBe('tip-required-checks');
    expect(state.latestGreen.sha).toBe(tip.sha);
    expect(tip.checkRuns).toHaveLength(count);

    const red = plan();
    expect(kinds(red)).toEqual(['main-red']);
    const unknown = plan({ prev: red.next, runs: greenRuns(), tip });
    expect.soft(kinds(unknown)).toEqual(['main-status-unknown']);
    expect.soft(unknown.next.fingerprint).toBe(red.next.fingerprint);
    expect.soft(unknown.next.fingerprintParts).toEqual(red.next.fingerprintParts);
    expect.soft(unknown.next.unknownEmitted).toBe(true);

    const repeated = plan({ prev: unknown.next, runs: greenRuns(), tip });
    expect.soft(repeated.items).toEqual([]);
    expect.soft(repeated.next.fingerprint).toBe(red.next.fingerprint);
    expect.soft(repeated.next.unknownEmitted).toBe(true);
  });

  it.each([1, 99])('clears an alert for %i successful checks with matching-SHA recovery proof below the page limit', (count) => {
    const tip = { ...passingTip(), checksTotal: count, checkRuns: successfulChecks(count) };
    const state = mainRedState(greenRuns(), { tip });
    expect(state.status).toBe('green');
    expect(state.via).not.toBe('tip-required-checks');
    expect(state.latestGreen.sha).toBe(tip.sha);

    const green = plan({ prev: plan().next, runs: greenRuns(), tip });
    expect(kinds(green)).toEqual(['main-green']);
    expect(green.next.fingerprint).toBeNull();
    expect(green.next.unknownEmitted).toBe(false);
  });

  it.each([1, 99])('clears an alert via tip-required-checks with %i successful checks (a complete page)', (count) => {
    const tip = { ...passingTip(), requiredChecks: ['check-1'], checksTotal: count, checkRuns: successfulChecks(count) };
    const state = mainRedState(redRuns(), { tip });
    expect(state.status).toBe('green');
    expect(state.via).toBe('tip-required-checks');

    const green = plan({ prev: plan().next, runs: redRuns(), tip });
    expect(kinds(green)).toEqual(['main-green']);
    expect(green.next.fingerprint).toBeNull();
    expect(green.next.unknownEmitted).toBe(false);
  });

  it.each([100, 101])('fails closed once after an alert for %i checks even via tip-required-checks', (count) => {
    const tip = { ...passingTip(), requiredChecks: ['check-1'], checksTotal: count, checkRuns: successfulChecks(count) };
    const state = mainRedState(redRuns(), { tip });
    expect(state.status).toBe('green');
    expect(state.via).toBe('tip-required-checks');
    expect(tip.checkRuns).toHaveLength(count);

    const red = plan();
    expect(kinds(red)).toEqual(['main-red']);
    const unknown = plan({ prev: red.next, runs: redRuns(), tip });
    expect.soft(kinds(unknown)).toEqual(['main-status-unknown']);
    expect.soft(unknown.next.fingerprint).toBe(red.next.fingerprint);
    expect.soft(unknown.next.fingerprintParts).toEqual(red.next.fingerprintParts);
    expect.soft(unknown.next.unknownEmitted).toBe(true);

    const repeated = plan({ prev: unknown.next, runs: redRuns(), tip });
    expect.soft(repeated.items).toEqual([]);
    expect.soft(repeated.next.fingerprint).toBe(red.next.fingerprint);
    expect.soft(repeated.next.unknownEmitted).toBe(true);
  });

  it.each([1, 99])('clears an alert for %i checks below the page limit via tip-required-checks', (count) => {
    const tip = { ...passingTip(), requiredChecks: ['check-1'], checksTotal: count, checkRuns: successfulChecks(count) };
    const state = mainRedState(redRuns(), { tip });
    expect(state.status).toBe('green');
    expect(state.via).toBe('tip-required-checks');
    expect(tip.checkRuns).toHaveLength(count);

    const red = plan();
    expect(kinds(red)).toEqual(['main-red']);
    const green = plan({ prev: red.next, runs: redRuns(), tip });
    expect(kinds(green)).toEqual(['main-green']);
    expect(green.next.fingerprint).toBeNull();
    expect(green.next.unknownEmitted).toBe(false);
    expect(plan({ prev: green.next, runs: redRuns(), tip }).items).toEqual([]);
  });

  it.each([
    ['queued required check', { ...passingTip(), runStatus: 'in_progress',
      checkRuns: [{ id: 1, name: 'test', status: 'queued', conclusion: null }],
    }],
    ['in-progress required check', { ...passingTip(), runStatus: 'in_progress',
      checkRuns: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }],
    }],
    ['pending non-required check without required-check success', { ...passingTip(), checksTotal: 2, checkRuns: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'neutral' },
      { id: 2, name: 'smoke', status: 'in_progress', conclusion: null },
    ] }],
    ['unreadable requiredChecks', { ...passingTip(), requiredChecks: null }],
    ['missing requiredChecks', { ...passingTip(), requiredChecks: undefined }],
    ['malformed requiredChecks', { ...passingTip(), requiredChecks: 'test' }],
    ['historical green SHA with completed non-red tip checks', {
      ...passingTip(), sha: 'd'.repeat(40),
      checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'neutral' }],
    }],
  ])('fails closed once after an alert for %s, then clears only on proven recovery', (_name, tip) => {
    const red = plan();
    // Historical workflow success is still reported, but the tip has not proved success.
    const state = mainRedState(greenRuns(), { tip });
    expect(state.status).toBe('green');
    expect(state.via).not.toBe('tip-required-checks');

    const unknown = plan({ prev: red.next, runs: greenRuns(), tip });
    expect.soft(kinds(unknown)).toEqual(['main-status-unknown']);
    expect.soft(unknown.next.fingerprint).toBe(red.next.fingerprint);
    expect.soft(unknown.next.fingerprintParts).toEqual(red.next.fingerprintParts);
    expect.soft(unknown.next.unknownEmitted).toBe(true);
    const repeated = plan({ prev: unknown.next, runs: greenRuns(), tip });
    expect.soft(repeated.items).toEqual([]);
    expect.soft(repeated.next.fingerprint).toBe(red.next.fingerprint);
    expect.soft(repeated.next.unknownEmitted).toBe(true);

    const recovered = plan({ prev: repeated.next, runs: greenRuns(), tip: passingTip() });
    expect.soft(kinds(recovered)).toEqual(['main-green']);
    expect.soft(recovered.next.unknownEmitted).toBe(false);
    expect.soft(plan({ prev: recovered.next, runs: greenRuns(), tip: passingTip() }).items).toEqual([]);
  });

  it('allows a matching latest green SHA with every tip check completed and non-red', () => {
    const tip = { ...passingTip(), checksTotal: 2, checkRuns: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'neutral' },
      { id: 2, name: 'smoke', status: 'completed', conclusion: 'success' },
    ] };
    const state = mainRedState(greenRuns(), { tip });
    expect(state.via).not.toBe('tip-required-checks');
    expect(state.latestGreen.sha).toBe(tip.sha);
    const green = plan({ prev: plan().next, runs: greenRuns(), tip });
    expect(kinds(green)).toEqual(['main-green']);
    expect(green.next.fingerprint).toBeNull();
  });
});

describe('planMainRedAlert — durable feed transition regressions', () => {
  it('emits all three A -> B -> A red events through real diffFeed with accumulated openKeys', () => {
    const first = plan();
    const changed = plan({ prev: first.next, details: { ...details(), failingJobs: ['smoke'] } });
    const returned = plan({ prev: changed.next });
    const transitions = [first, changed, returned];
    let openKeys = [];
    const events = [];
    for (const transition of transitions) {
      expect(kinds(transition)).toEqual(['main-red']);
      // publishAttention retains every key: a later event cannot rely on old keys being cleared.
      const feed = diffFeed(openKeys, transition.items, START + 30 * MINUTE, { incomplete: true });
      openKeys = feed.openKeys;
      events.push(...feed.lines.map(parseFeedLine));
    }
    expect.soft(events.map((event) => event.kind)).toEqual(['main-red', 'main-red', 'main-red']);
    expect.soft(events.map((event) => event.failingJobs)).toEqual([
      [...details().failingJobs].sort(), ['smoke'], [...details().failingJobs].sort(),
    ]);
    expect.soft(openKeys).toHaveLength(3);
    expect.soft(returned.next.fingerprint).toBe(first.next.fingerprint);
    expect.soft(new Set(transitions.map((result) => result.items[0].head)).size).toBe(3);
    for (const [index, result] of transitions.entries()) {
      expect.soft(result.next.seq).toBe(index + 1);
      expect.soft(result.items[0].head).toContain(result.next.fingerprint);
      expect.soft(result.items[0].head).toContain(String(index + 1));
    }
  });

  it('persists and increments seq per emitted red, unknown and green item, preserving it on quiet ticks', () => {
    const red = plan({ prev: { seq: 40 } });
    const quietRed = plan({ prev: red.next });
    const unknown = plan({ prev: quietRed.next, readOk: false });
    const quietUnknown = plan({ prev: unknown.next, readOk: false });
    const recoveredRed = plan({ prev: quietUnknown.next });
    const secondUnknown = plan({ prev: recoveredRed.next, readOk: false });
    const green = plan({ prev: secondUnknown.next, runs: greenRuns(), tip: passingTip() });
    const quietGreen = plan({ prev: green.next, runs: greenRuns(), tip: passingTip() });
    const secondRed = plan({ prev: quietGreen.next });
    const secondGreen = plan({ prev: secondRed.next, runs: greenRuns(), tip: passingTip() });
    const emitted = [red, unknown, secondUnknown, green, secondRed, secondGreen];
    expect(emitted.map(kinds)).toEqual([
      ['main-red'], ['main-status-unknown'], ['main-status-unknown'],
      ['main-green'], ['main-red'], ['main-green'],
    ]);
    // Deliberately reuse the same tick and red fingerprint: seq must distinguish repeated episodes.
    expect.soft(new Set(emitted.flatMap((result) => result.items.map((item) => item.head))).size).toBe(6);
    for (const [index, result] of emitted.entries()) {
      expect.soft(result.next.seq).toBe(41 + index);
      expect.soft(result.items[0].head).toContain(String(41 + index));
    }
    for (const [quiet, prior] of [
      [quietRed, red], [quietUnknown, unknown], [recoveredRed, unknown], [quietGreen, green],
    ]) {
      expect.soft(quiet.items).toEqual([]);
      expect.soft(quiet.next.seq).toBe(prior.next.seq);
    }
  });
});

describe('mainRedAlertSettings', () => {
  it('defaults to twenty minutes with omitted or empty config', () => {
    expect(mainRedAlertSettings().mainRedAlertAfterMin).toBe(20);
    expect(mainRedAlertSettings({}).mainRedAlertAfterMin).toBe(20);
  });

  it('accepts the configured mainRedAlertAfterMin', () => {
    expect(mainRedAlertSettings({ mainRedAlertAfterMin: 7 }).mainRedAlertAfterMin).toBe(7);
  });
});

describe('planMainRedAlert — red window and attention payload', () => {
  it('suppresses red younger than the default threshold', () => {
    expect(plan({ now: START + 19 * MINUTE + 59_999 }).items).toEqual([]);
  });

  it('emits exactly one main-red with the first red time, SHA and supplied details', () => {
    const result = plan();
    expect(result.items).toHaveLength(1);
    const [item] = result.items;
    expect(item).toMatchObject({
      kind: 'main-red', repo: 'web-everything/web-everything', pr: 0,
      since: SINCE, firstRedSha: RED_SHA,
      firstFailingTest: details().firstFailingTest, blockedReadyPrs: 4,
    });
    expect([...item.failingJobs].sort()).toEqual(details().failingJobs.sort());
    expect([...item.fixPrs].sort((a, b) => a - b)).toEqual([4510, 4522]);
    expect(typeof item.head).toBe('string');
    expect(item.head.length).toBeGreaterThan(0);
    expect(item.head).toContain(result.next.fingerprint);
    expect(typeof item.reason).toBe('string');
    expect(item.reason.length).toBeGreaterThan(0);
    expect(item.reason.length).toBeLessThanOrEqual(100);
  });

  it('uses the configured threshold to delay alerts', () => {
    const settings = mainRedAlertSettings({ mainRedAlertAfterMin: 45 });
    expect(plan({ settings }).items).toEqual([]);
    expect(kinds(plan({ settings, now: START + 46 * MINUTE }))).toEqual(['main-red']);
  });

  it('uses a lower configured threshold to alert earlier', () => {
    expect(kinds(plan({ settings: mainRedAlertSettings({ mainRedAlertAfterMin: 5 }),
      now: START + 6 * MINUTE }))).toEqual(['main-red']);
  });

  it('uses the earliest red in the window even when a newer red run exists', () => {
    const runs = [run(TIP_SHA, 'failure', '2026-10-26T12:28:00.000Z', 3), ...redRuns()];
    const state = mainRedState(runs);
    expect(state.status).toBe('red');
    expect(plan({ runs }).items[0]).toMatchObject({
      since: new Date(state.redSinceMs).toISOString(), firstRedSha: state.firstRed.sha,
    });
  });

  it('honors successful tip checks that clear older completed red runs', () => {
    const prev = plan().next;
    const tip = passingTip();
    expect(mainRedState(redRuns(), { tip }).status).toBe('green');
    expect(kinds(plan({ tip, prev }))).toEqual(['main-green']);
  });

  it.each([undefined, null, {}, {
    failingJobs: null, firstFailingTest: null, blockedReadyPrs: null, fixPrs: null,
  }])('alerts with absent or null detail fields (%j)', (missing) => {
    const result = plan({ details: missing });
    expect(kinds(result)).toEqual(['main-red']);
    expect(result.items[0]).toMatchObject({
      failingJobs: [], firstFailingTest: null, fixPrs: [],
    });
    expect(result.items[0].since).toBe(SINCE);
    expect(result.items[0].head).toContain(result.next.fingerprint);
  });

  it('keeps the reason within 100 characters for long detail strings', () => {
    const result = plan({ details: { ...details(),
      failingJobs: ['job '.repeat(100)], firstFailingTest: 'test '.repeat(100),
    } });
    expect(kinds(result)).toEqual(['main-red']);
    expect(result.items[0].reason.length).toBeLessThanOrEqual(100);
  });
});

describe('planMainRedAlert — fingerprint and recovery', () => {
  it.each([
    ['unavailable details', null],
    ['omitted details', undefined],
    ['missing detail fields', {}],
    ['unavailable failing jobs', { ...details(), failingJobs: null }],
    ['unavailable failing test', { ...details(), firstFailingTest: null }],
    ['unavailable fix PRs', { ...details(), fixPrs: null }],
    ['all detail reads unavailable', {
      failingJobs: null, firstFailingTest: null, blockedReadyPrs: null, fixPrs: null,
    }],
  ])('carries forward fingerprint parts through %s and identical recovery', (_name, unavailable) => {
    const first = plan();
    const failedRead = plan({ prev: first.next, details: unavailable, now: START + 31 * MINUTE });
    const recovered = plan({ prev: failedRead.next, now: START + 32 * MINUTE });

    expect.soft(failedRead.items).toEqual([]);
    expect.soft(failedRead.next.fingerprint).toBe(first.next.fingerprint);
    expect.soft(recovered.items).toEqual([]);
    expect.soft(recovered.next.fingerprint).toBe(first.next.fingerprint);
  });

  it('carries forward only unavailable parts while fingerprinting a proven detail change', () => {
    const first = plan();
    const changed = { ...details(), failingJobs: ['smoke'] };
    const expected = plan({ prev: first.next, details: changed });
    const partial = plan({ prev: first.next, details: { ...changed, fixPrs: null } });

    expect(kinds(partial)).toEqual(['main-red']);
    expect.soft(partial.next.fingerprint).toBe(expected.next.fingerprint);
    expect.soft(partial.items[0].fixPrs).toEqual(expected.items[0].fixPrs);
    expect.soft(plan({ prev: partial.next, details: changed }).items).toEqual([]);
  });

  it('gives separate green episodes distinct feed keys containing their red since-timestamps', () => {
    const firstRed = plan();
    const firstGreen = plan({ prev: firstRed.next, runs: greenRuns(), tip: passingTip() });
    const secondSince = '2026-10-26T13:00:00.000Z';
    const secondRed = plan({ prev: firstGreen.next, now: START + 90 * MINUTE,
      runs: [run(RED_SHA, 'failure', secondSince, 4), ...greenRuns()],
    });
    const secondGreen = plan({ prev: secondRed.next, runs: greenRuns(), tip: passingTip(),
      now: START + 91 * MINUTE,
    });
    expect(kinds(firstRed)).toEqual(['main-red']);
    expect(kinds(secondRed)).toEqual(['main-red']);
    expect(kinds(firstGreen)).toEqual(['main-green']);
    expect(kinds(secondGreen)).toEqual(['main-green']);
    const [first] = firstGreen.items;
    const [second] = secondGreen.items;
    expect.soft(first.head).toContain(SINCE);
    expect.soft(second.head).toContain(secondSince);
    const key = (item) => `${item.repo}#${item.pr}@${item.head}:${item.kind}`;
    expect(key(second)).not.toBe(key(first));
    expect(plan({ prev: secondGreen.next, runs: greenRuns(), tip: passingTip() }).items).toEqual([]);
  });

  it('deduplicates identical red state on later ticks using persisted next', () => {
    const first = plan();
    const second = plan({ prev: first.next, now: START + 60 * MINUTE });
    expect(second.items).toEqual([]);
    expect(second.next.fingerprint).toBe(first.next.fingerprint);
  });

  it('ignores ordering of failing jobs and fix PRs in the fingerprint', () => {
    const first = plan();
    const reordered = plan({ prev: first.next, details: {
      ...details(), failingJobs: details().failingJobs.reverse(), fixPrs: details().fixPrs.reverse(),
    } });
    expect(reordered.items).toEqual([]);
    expect(reordered.next.fingerprint).toBe(first.next.fingerprint);
  });

  it.each([
    ['a new failing test', { firstFailingTest: 'store.test.mjs > saves state' }],
    ['changed failing jobs', { failingJobs: ['smoke'] }],
    ['a fix PR opened', { fixPrs: [4510, 4522, 4530] }],
    ['a fix PR merged', { fixPrs: [4510] }],
    ['the last fix PR merged', { fixPrs: [] }],
  ])('emits a fresh main-red for %s', (_name, changed) => {
    const first = plan();
    const updatedDetails = { ...details(), ...changed };
    const second = plan({ prev: first.next, details: updatedDetails });
    expect(kinds(second)).toEqual(['main-red']);
    expect(second.next.fingerprint).not.toBe(first.next.fingerprint);
    expect(second.items[0].head).toContain(second.next.fingerprint);
    expect(plan({ prev: second.next, details: updatedDetails }).items).toEqual([]);
  });

  it('includes firstRedSha in the fingerprint', () => {
    const first = plan();
    const second = plan({ prev: first.next,
      runs: redRuns().map((r) => r.headSha === RED_SHA ? { ...r, headSha: TIP_SHA } : r),
    });
    expect(kinds(second)).toEqual(['main-red']);
    expect(second.next.fingerprint).not.toBe(first.next.fingerprint);
  });

  it('does not re-alert for a blocked-ready count change alone', () => {
    const first = plan();
    const second = plan({ prev: first.next, details: { ...details(), blockedReadyPrs: 9 } });
    expect(second.items).toEqual([]);
    expect(second.next.fingerprint).toBe(first.next.fingerprint);
  });

  it('emits one green clear after an alert, then allows the same red fingerprint again', () => {
    const red = plan();
    const green = plan({ runs: greenRuns(), tip: passingTip(), prev: red.next });
    expect(kinds(green)).toEqual(['main-green']);
    const stillGreen = plan({ runs: greenRuns(), tip: passingTip(), prev: green.next });
    expect(stillGreen.items).toEqual([]);
    expect(kinds(plan({ prev: stillGreen.next }))).toEqual(['main-red']);
  });

  it('does not emit green without a prior red alert, including a short red episode', () => {
    expect(plan({ runs: greenRuns(), tip: passingTip() }).items).toEqual([]);
    const shortRed = plan({ now: START + MINUTE });
    expect(plan({ runs: greenRuns(), tip: passingTip(), prev: shortRed.next }).items).toEqual([]);
  });
});

describe('planMainRedAlert — fail closed on unknown main status', () => {
  it.each([
    ['null tip', null],
    ['unreadable tip', undefined],
    ['unreadable tip checks', { ...passingTip(), checkRuns: null }],
    ['missing tip checks', { ...passingTip(), checksTotal: 0, checkRuns: [] }],
    ['red required check on the tip', { ...passingTip(),
      checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }],
    }],
    ['red non-required check on the tip', { ...passingTip(), checksTotal: 2, checkRuns: [
      ...passingTip().checkRuns,
      { id: 2, name: 'smoke', status: 'completed', conclusion: 'failure' },
    ] }],
  ])('never clears an emitted red on old green runs with %s; reports unknown once', (_name, tip) => {
    const red = plan();
    const unknown = plan({ prev: red.next, runs: greenRuns(), tip, now: START + 31 * MINUTE });
    expect.soft(kinds(unknown)).toEqual(['main-status-unknown']);
    expect.soft(unknown.next.fingerprint).toBe(red.next.fingerprint);
    expect.soft(unknown.next.unknownEmitted).toBeTruthy();
    const repeated = plan({ prev: unknown.next, runs: greenRuns(), tip, now: START + 32 * MINUTE });
    expect.soft(repeated.items).toEqual([]);
    expect.soft(repeated.next.fingerprint).toBe(red.next.fingerprint);

    const provenGreen = plan({ prev: repeated.next, runs: greenRuns(), tip: passingTip(),
      now: START + 33 * MINUTE,
    });
    expect.soft(kinds(provenGreen)).toEqual(['main-green']);
    expect.soft(provenGreen.next.unknownEmitted).toBeFalsy();
  });

  it('keys unknown episodes by persisted sequence and suppresses repeats only within each episode', () => {
    const firstNow = START + 31 * MINUTE;
    const secondNow = START + 34 * MINUTE;
    const red = plan();
    const first = plan({ prev: red.next, readOk: false, now: firstNow });
    const repeated = plan({ prev: first.next, readOk: false, now: firstNow + MINUTE });
    expect(repeated.items).toEqual([]);
    const recovered = plan({ prev: repeated.next, now: START + 33 * MINUTE });
    expect(recovered.items).toEqual([]);
    const second = plan({ prev: recovered.next, readOk: false, now: secondNow });
    expect(kinds(first)).toEqual(['main-status-unknown']);
    expect(kinds(second)).toEqual(['main-status-unknown']);
    expect.soft(first.items[0].head).toBe(`main-status-unknown:${red.next.seq + 1}`);
    expect.soft(second.items[0].head).toBe(`main-status-unknown:${recovered.next.seq + 1}`);
    expect.soft(plan({ prev: red.next, readOk: false, now: secondNow }).items[0].head)
      .toBe(first.items[0].head);
    const key = (item) => `${item.repo}#${item.pr}@${item.head}:${item.kind}`;
    expect.soft(key(second.items[0])).not.toBe(key(first.items[0]));
    expect(plan({ prev: second.next, readOk: false, now: secondNow + MINUTE }).items).toEqual([]);
  });

  it.each([
    ['failed read despite green runs', { runs: greenRuns(), readOk: false }],
    ['missing runs', { runs: undefined }],
    ['null runs', { runs: null }],
    ['no finished runs', { runs: [] }],
    ['only an in-progress run', { runs: [{ ...redRuns()[0], status: 'in_progress' }] }],
  ])('emits one unknown item and never clears for %s', (_name, overrides) => {
    const alerted = plan();
    const unknown = plan({ ...overrides, prev: alerted.next });
    expect(kinds(unknown)).toEqual(['main-status-unknown']);
    expect(unknown.next.unknownEmitted).toBeTruthy();
    const repeated = plan({ ...overrides, prev: unknown.next });
    expect(repeated.items).toEqual([]);
    expect(repeated.next.unknownEmitted).toBeTruthy();
  });

  it('resets unknown suppression after a successful read', () => {
    const unknown = plan({ readOk: false });
    const recovered = plan({ prev: unknown.next, now: START + MINUTE });
    expect(recovered.items).toEqual([]);
    expect(recovered.next.unknownEmitted).toBeFalsy();
    expect(kinds(plan({ prev: recovered.next, readOk: false }))).toEqual(['main-status-unknown']);
  });

  it('preserves an outstanding red alert through unknown until green is actually observed', () => {
    const red = plan();
    const unknown = plan({ prev: red.next, readOk: false, runs: greenRuns() });
    const recovered = plan({ prev: unknown.next, runs: greenRuns(), tip: passingTip() });
    expect(kinds(recovered)).toEqual(['main-green']);
    expect(recovered.next.unknownEmitted).toBeFalsy();
    expect(plan({ prev: recovered.next, runs: greenRuns(), tip: passingTip() }).items).toEqual([]);
  });
});

// All state, detail reads and publications are injected: no real files or network.
const wrapperInput = (overrides = {}) => ({
  probe: { runs: redRuns() }, dir: 'fake-health-state', now: START + 30 * MINUTE,
  config: {}, publish: vi.fn(), readDetails: vi.fn().mockResolvedValue(details()),
  readState: vi.fn().mockResolvedValue({}), writeState: vi.fn(), ...overrides,
});
const expectPersisted = (writeState, next) => {
  expect(writeState).toHaveBeenCalledTimes(1);
  // Permit the state IO adapter to also receive dir; the saved next must be exact.
  expect(writeState.mock.calls[0]).toContainEqual(next);
};

describe('runMainRedAlert — injected IO', () => {
  it('reads details and prior state, publishes each planned item and persists next', async () => {
    const args = wrapperInput();
    const expected = plan();
    await runMainRedAlert(args);
    expect(args.readDetails).toHaveBeenCalledTimes(1);
    expect(args.readState).toHaveBeenCalledTimes(1);
    expect(args.publish.mock.calls).toEqual(expected.items.map((item) => [item]));
    expectPersisted(args.writeState, expected.next);
  });

  it('uses persisted fingerprint to suppress publishing but still saves next', async () => {
    const prev = plan().next;
    const args = wrapperInput({ readState: vi.fn().mockResolvedValue(prev) });
    await runMainRedAlert(args);
    expect(args.publish).not.toHaveBeenCalled();
    expectPersisted(args.writeState, plan({ prev }).next);
  });

  it('passes config through so a higher threshold suppresses the alert', async () => {
    const config = { mainRedAlertAfterMin: 45 };
    const args = wrapperInput({ config });
    await runMainRedAlert(args);
    expect(args.publish).not.toHaveBeenCalled();
    expectPersisted(args.writeState, plan({ settings: mainRedAlertSettings(config) }).next);
  });

  it('passes probe tip facts through to publish and persist a green clear', async () => {
    const prev = plan().next;
    const tip = passingTip();
    const args = wrapperInput({ probe: { runs: redRuns(), tip },
      readState: vi.fn().mockResolvedValue(prev) });
    await runMainRedAlert(args);
    expect(args.publish).toHaveBeenCalledTimes(1);
    expect(args.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'main-green' }));
    expectPersisted(args.writeState, plan({ prev, tip }).next);
  });

  it('still alerts with null details when the injected detail reader throws', async () => {
    const args = wrapperInput({ readDetails: vi.fn().mockRejectedValue(new Error('details unavailable')) });
    const expected = plan({ details: null });
    await runMainRedAlert(args);
    expect(args.readDetails).toHaveBeenCalledTimes(1);
    expect(args.publish.mock.calls).toEqual(expected.items.map((item) => [item]));
    expectPersisted(args.writeState, expected.next);
  });

  it.each([
    ['null probe', null],
    ['undefined probe', undefined],
    ['probe error despite green runs', { runs: greenRuns(), error: 'probe unavailable' }],
  ])('fails closed once for %s and persists suppression across ticks', async (_name, probe) => {
    const prev = plan().next;
    const expected = plan({ prev, readOk: false });
    const args = wrapperInput({ probe, readState: vi.fn().mockResolvedValue(prev) });
    await runMainRedAlert(args);
    expect(args.publish).toHaveBeenCalledTimes(1);
    expect(args.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'main-status-unknown' }));
    expectPersisted(args.writeState, expected.next);

    const repeated = wrapperInput({ probe, readState: vi.fn().mockResolvedValue(expected.next) });
    await runMainRedAlert(repeated);
    expect(repeated.publish).not.toHaveBeenCalled();
    expectPersisted(repeated.writeState, plan({ prev: expected.next, readOk: false }).next);
  });
});
