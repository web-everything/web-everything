import type { ConformanceVector, ConformanceVectorSuite } from './schema.js';

// WE contract cases, not a time-track implementation. A downstream driver renders this fixture
// through its candidate adapter. Times use Scale Ruler's time type and one shared axisRef.
// readouts below come from rendered lane order, computed accessible names, assigned slots,
// axis coordinates relative to the shared ruler, and document.activeElement — never impl fields.
const render = {
  do: 'render',
  axis: { type: 'time', axisRef: 'shared-time' },
  today: '2026-11-22T10:00:00Z',
  lanes: [
    { id: 'zeta', name: 'Zeta' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'mu', name: 'Mu' },
  ].map((lane) => ({
    ...lane,
    items: [
      { id: `${lane.id}-before`, time: '2026-11-22T09:00:00Z', content: 'Earlier' },
      { id: `${lane.id}-today`, time: '2026-11-22T10:00:00Z', content: 'Today' },
      { id: `${lane.id}-after`, time: '2026-11-22T11:00:00Z', content: 'Later' },
    ],
  })),
};
const contract = '@webeverything/time-track';
const laneIds = ['zeta', 'alpha', 'mu'];
const itemTimes = Object.fromEntries(render.lanes.flatMap((lane) =>
  lane.items.map((item) => [item.id, item.time]),
));

function keyboardCase(name: string, from: string, key: string, to: string): ConformanceVector {
  return {
    id: `time-track/keyboard/${name}`, contract,
    description: 'readItemTimes reads every slotted item timestamp from the candidate, not the fixture, '
      + 'and records the id-to-time map under the named observation. Capture before and after the key; '
      + 'both maps must contain all nine original timestamps. Missing or unreadable timestamps fail.',
    steps: [
      render, { do: 'focusLane', lane: from },
      { do: 'readItemTimes', observation: 'itemTimesBefore' },
      { do: 'pressKey', key },
      { do: 'readItemTimes', observation: 'itemTimesAfter' },
    ],
    expect: {
      activeLane: to, laneOrder: laneIds,
      itemTimesBefore: itemTimes, itemTimesAfter: itemTimes,
      matchers: { laneOrder: 'deep-equal', itemTimesBefore: 'deep-equal', itemTimesAfter: 'deep-equal' },
    },
    observeVia: ['activeLane', 'laneOrder', 'itemTimesBefore', 'itemTimesAfter'],
  };
}

export const timeTrackSuite: ConformanceVectorSuite = {
  standard: 'time-track', contract,
  vectors: [
    {
      id: 'time-track/layout/given-lane-order', contract,
      steps: [render],
      expect: { laneOrder: laneIds, matchers: { laneOrder: 'deep-equal' } },
      observeVia: ['laneOrder'],
    },
    {
      id: 'time-track/axis/equal-times-align-across-all-lanes', contract,
      description: 'Read all nine item coordinates and all three today markers relative to the shared ruler. '
        + 'Every coordinate must be finite; for each timestamp, all three lanes must agree within one CSS pixel. '
        + 'Today items must also align with every today marker. Missing items or markers fail the assertion.',
      steps: [render],
      expect: { equalTimePositionsMatch: true, todayMarkersMatch: true },
      observeVia: ['equalTimePositionsMatch', 'todayMarkersMatch'],
    },
    ...([
      ['before', 'past'], ['today', 'forecast'], ['after', 'forecast'],
    ] as const).map(([when, slot]): ConformanceVector => ({
      id: `time-track/slots/${when}-${slot}`, contract,
      description: 'Read the actual assigned slot for this item in every lane; an absent item or slot fails.',
      steps: [render],
      expect: {
        itemSlots: Object.fromEntries(laneIds.map((id) => [`${id}-${when}`, slot])),
        matchers: { itemSlots: 'deep-equal' },
      },
      observeVia: ['itemSlots'],
    })),
    {
      id: 'time-track/a11y/named-focusable-lanes', contract,
      description: 'Compute each lane accessible name and focus each lane, recording whether it becomes activeElement.',
      steps: [render, { do: 'probeLaneFocusAndNames', lanes: laneIds }],
      expect: {
        laneNames: ['Zeta', 'Alpha', 'Mu'], focusableLanes: laneIds,
        matchers: { laneNames: 'deep-equal', focusableLanes: 'deep-equal' },
      },
      observeVia: ['laneNames', 'focusableLanes'],
    },
    keyboardCase('down-to-following-lane', 'zeta', 'ArrowDown', 'alpha'),
    keyboardCase('up-to-preceding-lane', 'mu', 'ArrowUp', 'alpha'),
    keyboardCase('up-at-first-retains-focus', 'zeta', 'ArrowUp', 'zeta'),
    keyboardCase('down-at-last-retains-focus', 'mu', 'ArrowDown', 'mu'),
  ],
};
