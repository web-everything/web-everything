import { it, expect } from 'vitest';
import { planBuildDispatch } from '../build-dispatch-policy.mjs';
import { normNum } from '../queue-store.mjs';
const row = (id, executor) => ({ num: `slot-${id}`, executor, scope: [], source: 'builder slot test', borrowedFix: true });
const candidates = [{ num: '101', executor: 'claude', scope: ['we:a'] }, { num: '102', executor: 'codex', scope: ['we:b'] }];
it('preserves slot IDs and holds each executor pool at its existing cap', () => {
  expect(normNum('slot-ab12')).toBeTruthy();
  const r = planBuildDispatch({ candidates, inFlight: [row('ab12', 'claude'), ...Array.from({ length: 4 }, (_, i) => row(`cd${i}`, 'codex'))] });
  expect(r.dispatch).toEqual([]);
  expect(r.slotsByClass).toEqual({ claude: 0, external: 0 });
  expect(r.hold.map(h => h.rule)).toEqual(['cap', 'cap']);
});
it('dispatches both pools when the kill switch omits slot rows', () => {
  expect(planBuildDispatch({ candidates, inFlight: [] }).dispatch.map(r => r.num)).toEqual(['101', '102']);
});
