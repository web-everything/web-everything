import { expect, it } from 'vitest';
import { planLabelInputRows } from '../../conveyor/pr-label-mirror.mjs';
import { buildLedgerEvent, buildVerdictRecord } from '../verdict-ledger.mjs';
import { derivePrState } from '../pr-state.mjs';

const repo = 'example/repo', pr = 1, head = 'a'.repeat(40), next = 'b'.repeat(40);
const before = '2026-10-17T12:00:00.000Z', heldAt = '2026-10-17T12:01:00.000Z', after = '2026-10-17T12:02:00.000Z';
const row = (verdict, headSha, at = before, extra = {}) => buildVerdictRecord({ repo, pr, verdict, headSha, at, source: 'test', ...extra });
const input = events => planLabelInputRows({ repo, pr, events, headSha: next, now: after, selfLogin: 'mirror-bot',
  liveLabels: ['review:human'], items: [{ label: 'review:human', actor: 'operator', change: 'added', createdAt: heldAt }] });
const facts = { repo, pr, head: { sha: next }, now: after, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [] };

for (const carryRule of ['numbering-only', 'tree-identical', 'identical-net-patch']) it(`mirror records a manual hold between acceptance and ${carryRule} carry`, () => {
  const events = [row('accepted', head), row('carried', next, after, { fromHead: head, carryRule })];
  const inputs = input(events);
  expect(inputs).toHaveLength(1);
  expect(derivePrState([...events, ...inputs], facts).holds.map(h => h.code)).toContain('label-input:review:human');
});

for (const kind of ['restamped', 'accepted']) it(`mirror cannot discard a manual human hold because of a later ${kind}`, () => {
  expect(input([row('accepted', head), row(kind, next, after)])).toHaveLength(1);
});

it('mirror recognizes a real human answer after the hold followed by an equivalent carry', () => {
  const events = [row('accepted', head), row('clear-human', head, '2026-10-17T12:01:30.000Z'),
    row('carried', next, after, { fromHead: head, carryRule: 'tree-identical', state: 'clear-human', carryHuman: true })];
  expect(input(events)).toEqual([]);
});

it('mirror retains a manual hold when a substantive move expired its human approval', () => {
  const approval = buildLedgerEvent({ repo, pr, at: '2026-10-17T12:01:30.000Z', source: 'test', type: 'approval', approval: 'clear-human' });
  const events = [row('accepted', head), approval, row('head-moved', next, after, { fromHead: head }), row('accepted', next, after)];
  const inputs = input(events);
  expect(inputs).toHaveLength(1);
  expect(derivePrState([...events, ...inputs], facts).holds.map(h => h.code)).toContain('label-input:review:human');
});
