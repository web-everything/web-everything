import { it, expect } from 'vitest';
import { probeOmissionEvidence } from '../../../conveyor/soak/fixtures/rebuild-set-aside-probe.mjs';
import { planStrictAdopt, adoptionDecisions } from '../plan.mjs';
import { readReadyCandidateStrict } from '../state.mjs';

it.each([false, true])('main-only omission collects full smoke despite cached=%s', async cached => {
  const result = await probeOmissionEvidence({ mainOnly: true, cached });
  expect(result).toMatchObject({ adopted: true, onTarget: true });
  expect(result.checks).toEqual([{ changedFiles: null, reuseCode: false, reuseRows: [] }]);
});

it.each(['exact', 'same-tree', 'superseded'])('deferred %s adoption retains omission history and audits the repaired tip', async match => {
  const result = await probeOmissionEvidence({ readyOnly: true, match });
  expect(result).toMatchObject({ adopted: true, onTarget: true, readyMatch: match, beforeAdopt: null,
    aside: { ref: 'lane/docs', reason: 'main-sync-conflict' }, held: true, applied: 0 });
  expect(result.audits).toBeGreaterThan(0);
});

it('main-only ready adoption carries complete smoke evidence', async () => {
  expect(await probeOmissionEvidence({ mainOnly: true, readyOnly: true, cached: true }))
    .toMatchObject({ adopted: true, onTarget: true, readyMatch: 'exact' });
});

it('failed deferred adoption does not persist set-aside evidence', async () => {
  expect(await probeOmissionEvidence({ readyOnly: true, failReset: true }))
    .toMatchObject({ adopted: false, unchanged: true, beforeAdopt: null, aside: null, reason: 'reset-failed' });
});

it.each([false, true])('fallback preserves an earlier omission (deferred=%s)', async readyOnly => {
  expect(await probeOmissionEvidence({ fallback: true, readyOnly })).toMatchObject({
    adopted: true, onTarget: true, aside: { ref: 'lane/docs' }, held: true, applied: 0,
  });
});

it('unknown adoption history requires full smoke even after a registration disappears', () => {
  const state = { adopted: { applied: [{ ref: 'lane/docs' }] } };
  expect(planStrictAdopt({ applied: [], decisions: [] }, { state })).toBe(true);
  expect(planStrictAdopt({ applied: [{ ref: 'lane/docs' }], decisions: [] }, { state })).toBe(false);
  expect(planStrictAdopt({ applied: [], decisions: [{ ref: 'lane/docs', action: 'remove' }] }, { state })).toBe(false);
});

it('current decisions override older omissions while main-only plans preserve them', () => {
  const previous = { decisions: [{ ref: 'lane/docs', setAside: { eligible: true } }] };
  expect(adoptionDecisions({ decisions: [] }, previous)).toEqual(previous.decisions);
  const current = { decisions: [{ ref: 'lane/docs', action: 'remove' }] };
  expect(adoptionDecisions(current, previous)).toEqual(current.decisions);
});

it.each([null, {}, [null], [{ ref: 'lane/docs', action: 'skip', reason: 'conflict', setAside: { eligible: true } }]].map(decisions => [decisions]))(
  'strict ready reader refuses malformed serialized decisions: %j', decisions => {
    const record = { prevHead: 'a'.repeat(40), tree: 'b'.repeat(40), passedAt: new Date().toISOString(), kind: 'candidate',
      adopt: { finalSha: 'c'.repeat(40), inputsKey: 'inputs', mainSha: 'c'.repeat(40), applied: [], decisions } };
    expect(() => readReadyCandidateStrict('/unused', {}, () => JSON.stringify(record))).toThrow('Invalid ready candidate');
    delete record.adopt.decisions;
    expect(readReadyCandidateStrict('/unused', {}, () => JSON.stringify(record)).adopt).not.toHaveProperty('decisions');
  },
);
