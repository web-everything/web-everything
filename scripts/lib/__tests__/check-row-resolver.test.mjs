import { describe, it, expect } from 'vitest';
import { resolveCheckRows } from '../check-row-resolver.mjs';

const failed = { name: 'test', status: 'completed', conclusion: 'failure', startedAt: '2026-10-28T01:00:00Z' };
const passed = { ...failed, conclusion: 'success', startedAt: '2026-10-28T02:00:00Z' };

describe('fail-closed workflow/check attempt resolver', () => {
  it.each(['startedAt', 'started_at', 'completedAt', 'completed_at'])('orders attempts by %s regardless of ids and input order', field => {
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
    expect(resolveCheckRows([{ ...failed, ...a }, { ...passed, ...b }])).toHaveLength(2);
  });
  it('keeps names exact, including legacy contexts', () => {
    expect(resolveCheckRows([failed, { context: 'TEST', state: 'success' }])).toHaveLength(2);
    const legacyFailure = { context: 'test', state: 'failure' };
    expect(resolveCheckRows([legacyFailure, { context: 'test', state: 'success' }])).toEqual([legacyFailure]);
  });
  it('treats empty and absent workflow information as one group per name', () => {
    expect(resolveCheckRows([failed, { ...passed, workflowName: '' }])).toEqual([{ ...passed, workflowName: '' }]);
  });
});
