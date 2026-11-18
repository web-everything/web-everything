import { describe, it, expect } from 'vitest';
import { resolveCheckRows } from '../check-row-resolver.mjs';

const failed = { workflowName: 'CI', name: 'test', status: 'completed', conclusion: 'failure', startedAt: '2026-10-28T01:00:00Z' };
const passed = { ...failed, conclusion: 'success', startedAt: '2026-10-28T02:00:00Z' };

describe('fail-closed workflow/check attempt resolver', () => {
  it.each(['startedAt', 'started_at'])('orders attempts by %s regardless of ids and input order', field => {
    const old = Object.freeze({ ...failed, startedAt: undefined, [field]: failed.startedAt, id: 999 });
    const fresh = Object.freeze({ ...passed, startedAt: undefined, [field]: passed.startedAt, id: 1 });
    for (const rows of [[old, fresh], [fresh, old]]) expect(resolveCheckRows(Object.freeze(rows))).toEqual([fresh]);
  });
  it.each([undefined, 'invalid', failed.startedAt])('prefers failure for missing, invalid or tied timestamps (%s)', startedAt => {
    const success = { ...passed, startedAt };
    for (const rows of [[failed, success], [success, failed]]) expect(resolveCheckRows(rows)).toEqual([failed]);
  });
  it('prefers failure across the whole group when any timestamp is missing', () => {
    expect(resolveCheckRows([failed, passed, { ...passed, startedAt: undefined }])).toEqual([failed]);
  });
  it('keeps the latest pending attempt pending', () => {
    const pending = { ...passed, status: 'in_progress', conclusion: null };
    expect(resolveCheckRows([failed, pending])).toEqual([pending]);
  });
  it('an undated pending row blocks a dated success', () => {
    const pending = { ...passed, startedAt: undefined, status: 'queued', conclusion: null };
    for (const rows of [[passed, pending], [pending, passed]]) expect(resolveCheckRows(rows)).toEqual([pending]);
  });
  it.each([
    [{ workflowName: 'CI' }, { workflowName: 'security' }],
    [{ workflow: 'CI' }, { workflow: 'security' }],
    [{ checkSuite: { workflowRun: { workflow: { name: 'CI' } } } }, { checkSuite: { workflowRun: { workflow: { name: 'security' } } } }],
  ])('never collapses distinct workflows (%j)', (a, b) => {
    expect(resolveCheckRows([{ ...failed, workflowName: undefined, ...a }, { ...passed, workflowName: undefined, ...b }])).toHaveLength(2);
  });
  it('keeps names exact, including legacy contexts', () => {
    expect(resolveCheckRows([failed, { context: 'TEST', state: 'success' }])).toHaveLength(2);
    const legacyFailure = { context: 'test', state: 'failure' };
    expect(resolveCheckRows([legacyFailure, { context: 'test', state: 'success' }])).toEqual([legacyFailure]);
  });
  it('treats empty and absent workflow information as one group per name', () => {
    expect(resolveCheckRows([{ ...failed, workflowName: undefined }, { ...passed, workflowName: '' }]))
      .toEqual([{ ...failed, workflowName: undefined }]);
  });
  it.each([undefined, null, ''])('workflow %j is ambiguous despite timestamps and run ids', workflowName => {
    const red = { ...failed, workflowName, id: 1, run_id: 1 };
    const green = { ...passed, workflowName, id: 999, run_id: 999 };
    const pending = { ...green, status: 'in_progress', conclusion: null };
    for (const rows of [[red, pending, green], [green, pending, red]]) expect(resolveCheckRows(rows)).toEqual([red]);
    for (const rows of [[green, pending], [pending, green]]) expect(resolveCheckRows(rows)).toEqual([pending]);
  });
  it.each(['completedAt', 'completed_at'])('ignores %s when a start time is missing', field => {
    const old = { ...failed, startedAt: undefined, [field]: '2026-10-28T01:00:00Z' };
    for (const rows of [[old, passed], [passed, old]]) expect(resolveCheckRows(rows)).toEqual([old]);
    const pending = { ...passed, status: 'in_progress', conclusion: null };
    const success = { ...old, conclusion: 'success', [field]: '2026-10-28T03:00:00Z' };
    for (const rows of [[success, pending], [pending, success]]) expect(resolveCheckRows(rows)).toEqual([pending]);
  });
  it('uses starts despite an older success completing after the newer pending attempt starts', () => {
    const success = { ...failed, conclusion: 'success', completedAt: '2026-10-28T03:00:00Z' };
    const pending = { ...passed, status: 'in_progress', conclusion: null };
    for (const rows of [[success, pending], [pending, success]]) expect(resolveCheckRows(rows)).toEqual([pending]);
  });
  it.each([undefined, 'StatusContext'])('keeps legacy evidence (%s) separate in both failure directions', __typename => {
    for (const conclusion of ['failure', 'success']) {
      const check = { ...failed, __typename: 'CheckRun', conclusion };
      const legacy = { context: 'test', __typename, workflowName: 'CI', state: conclusion === 'failure' ? 'success' : 'failure', startedAt: passed.startedAt };
      for (const rows of [[check, legacy], [legacy, check]]) expect(resolveCheckRows(rows)).toEqual(rows);
    }
  });
});
