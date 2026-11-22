import { describe, expect, it } from 'vitest';
import { assertConformanceSuite, conformanceSuites, timeTrackSuite } from '../index.js';

const vector = (suffix: string) => {
  const found = timeTrackSuite.vectors.find((v) => v.id === `time-track/${suffix}`);
  expect(found, suffix).toBeDefined();
  return found!;
};

// Protect the shipped observable assertions. These validate the WE corpus; the downstream
// driver must execute it against FUI (or another candidate) to establish runtime conformance.
describe('Time Track Intent conformance cases', () => {
  it('registers a schema-valid suite for downstream drivers', () => {
    expect(conformanceSuites).toContain(timeTrackSuite);
    expect(() => assertConformanceSuite(timeTrackSuite)).not.toThrow();
  });

  it('asserts the given non-alphabetical lane order', () => {
    expect(vector('layout/given-lane-order').expect.laneOrder).toEqual(['zeta', 'alpha', 'mu']);
  });

  it('asserts equal-time item alignment and a shared today marker across lanes', () => {
    const v = vector('axis/equal-times-align-across-all-lanes');
    expect(v.expect).toEqual({ equalTimePositionsMatch: true, todayMarkersMatch: true });
    const fixture = v.steps[0];
    expect(fixture.axis).toEqual({ type: 'time', axisRef: 'shared-time' });
    expect(fixture.lanes).toHaveLength(3);
  });

  it.each([
    ['before', 'past'], ['today', 'forecast'], ['after', 'forecast'],
  ])('asserts %s items enter %s in every lane (equality belongs to forecast)', (when, slot) => {
    const v = vector(`slots/${when}-${slot}`);
    expect(v.expect.itemSlots).toEqual({
      [`zeta-${when}`]: slot, [`alpha-${when}`]: slot, [`mu-${when}`]: slot,
    });
    expect(v.expect.matchers).toEqual({ itemSlots: 'deep-equal' });
    const fixture = v.steps[0];
    const lanes = fixture.lanes as { items: { id: string; time: string }[] }[];
    for (const lane of lanes) {
      const item = lane.items.find((i) => i.id.endsWith(`-${when}`))!;
      const delta = Date.parse(item.time) - Date.parse(fixture.today as string);
      expect(Math.sign(delta)).toBe(when === 'before' ? -1 : when === 'today' ? 0 : 1);
    }
  });

  it('asserts accessible names and actual focusability for all lanes', () => {
    const v = vector('a11y/named-focusable-lanes');
    expect(v.expect.laneNames).toEqual(['Zeta', 'Alpha', 'Mu']);
    expect(v.expect.focusableLanes).toEqual(['zeta', 'alpha', 'mu']);
    expect(v.steps[1].do).toBe('probeLaneFocusAndNames');
  });

  it.each([
    ['down-to-following-lane', 'zeta', 'ArrowDown', 'alpha'],
    ['up-to-preceding-lane', 'mu', 'ArrowUp', 'alpha'],
    ['up-at-first-retains-focus', 'zeta', 'ArrowUp', 'zeta'],
    ['down-at-last-retains-focus', 'mu', 'ArrowDown', 'mu'],
  ])('asserts %s', (name, from, key, to) => {
    const v = vector(`keyboard/${name}`);
    expect(v.steps.slice(1)).toEqual([
      { do: 'focusLane', lane: from },
      { do: 'readItemTimes', observation: 'itemTimesBefore' },
      { do: 'pressKey', key },
      { do: 'readItemTimes', observation: 'itemTimesAfter' },
    ]);
    expect(v.expect.activeLane).toBe(to);
    expect(v.expect.laneOrder).toEqual(['zeta', 'alpha', 'mu']);
    expect(v.observeVia).toContain('activeLane');
    const originalTimes = Object.fromEntries(['zeta', 'alpha', 'mu'].flatMap((lane) => [
      [`${lane}-before`, '2026-11-22T09:00:00Z'],
      [`${lane}-today`, '2026-11-22T10:00:00Z'],
      [`${lane}-after`, '2026-11-22T11:00:00Z'],
    ]));
    for (const readout of ['itemTimesBefore', 'itemTimesAfter']) {
      expect(v.observeVia).toContain(readout);
      expect(v.expect.matchers?.[readout]).toBe('deep-equal');
      expect(v.expect[readout]).toEqual(originalTimes);
    }
  });

  it.each([
    'down-to-following-lane', 'up-to-preceding-lane',
    'up-at-first-retains-focus', 'down-at-last-retains-focus',
  ])('%s rejects a timestamp mutation even when focus and order are correct', (name) => {
    const v = vector(`keyboard/${name}`);
    // Exercise the vector's declared deep-equal assertions with candidate observations.
    // This checks the oracle's sensitivity, not a FUI implementation or runtime driver.
    const times = v.expect.itemTimesAfter as Record<string, string>;
    for (const id of Object.keys(times)) {
      const observed = {
        activeLane: v.expect.activeLane, laneOrder: v.expect.laneOrder,
        itemTimesBefore: { ...times },
        itemTimesAfter: { ...times, [id]: '2026-11-22T12:00:00Z' },
      };
      expect(observed.activeLane).toBe(v.expect.activeLane);
      expect(observed.laneOrder).toEqual(v.expect.laneOrder);
      expect(observed.itemTimesBefore).toEqual(v.expect.itemTimesBefore);
      expect(() => expect(observed.itemTimesAfter).toEqual(v.expect.itemTimesAfter)).toThrow();
    }
  });

  it('keyboard timestamp assertions reject missing or unreadable before/after evidence', () => {
    const v = vector('keyboard/down-to-following-lane');
    for (const readout of ['itemTimesBefore', 'itemTimesAfter']) {
      for (const missing of [undefined, null, {}]) {
        expect(() => expect(missing).toEqual(v.expect[readout])).toThrow();
      }
      const incomplete = { ...(v.expect[readout] as Record<string, string>) };
      delete incomplete['zeta-today'];
      expect(() => expect(incomplete).toEqual(v.expect[readout])).toThrow();
    }
  });
});
