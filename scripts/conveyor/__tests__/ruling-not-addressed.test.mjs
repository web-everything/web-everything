import { describe, expect, it, vi } from 'vitest';
import { runReconcilePass, enrichPrsWithIgnoredRulings } from '../reconcile-pass.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { withRulingNotAddressed, postRulingNotice } from '../reconcile-fix-dispatch.mjs';
import { noteEpisodeKey, buildNoteComment, noteHeadline } from '../reconcile-note-comment.mjs';
import { FIX_END_MARKER } from '../fix-procedure.mjs';
import { renderRulingNotAddressed, RULING_NOT_ADDRESSED_MARKER } from '../../lib/ruling-ledger.mjs';
import { H1, H2, H3, repo, record, recordComment, ignoredRulingThread, iso } from './ruling-fixtures.mjs';

const basePr = (headRefOid, comments) => ({ number: 3794, state: 'OPEN', headRefName: 'lane/xcs4nce-policy', headRefOid,
  labels: [{ name: 'review:human' }, { name: 'advisory:changes' }], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments });
const plan = (headRefOid, comments) => {
  const [pr] = enrichPrsWithIgnoredRulings([basePr(headRefOid, comments)]);
  return planReconcile({ repo: 'we', prs: [pr], agents: [], now: Date.parse('2026-10-04T12:00:00Z'), requiredChecks: ['test'] });
};
const trusted = (body, min) => ({ body, createdAt: iso(min), author: { login: 'web-everything' } });

describe('ruling not addressed — the send-back', () => {
  it('goes straight to the fixer with the original ruling attached, and is not parked or re-reviewed', () => {
    const p = plan(H2, ignoredRulingThread());
    expect(p.dispatch.map((d) => [d.kind, d.mode])).toEqual([['fix', 'ruling-not-addressed']]);
    const d = p.dispatch[0];
    expect(d.rulingNotAddressed.matches[0].ruling).toMatch(/pointer files must be listed/);
    expect(d.why).toMatch(/did not satisfy the ruling/);
    expect(p.refusals).toEqual([]);
  });
  it('a clean new head is not affected (control: no ignored ruling, no send-back)', () => {
    const p = plan(H2, [recordComment(record({ head: H1, runId: 'run-1' }), 1)]);
    expect(p.dispatch.some((d) => d.mode === 'ruling-not-addressed')).toBe(false);
  });
  it('the second miss escalates to a needs-you note instead of a third round', () => {
    const comments = [...ignoredRulingThread(), recordComment(record({ head: H3, runId: 'run-3' }), 40)];
    const p = plan(H3, comments);
    expect(p.dispatch).toEqual([]);
    expect(p.refusals.map((r) => r.kind)).toEqual(['ruling-dispute']);
    const note = p.notes.find((n) => n.kind === 'ruling-dispute');
    expect(note).toMatchObject({ prNumber: 3794, head: H3, misses: 2 });
    expect(note.text).toMatch(/fixer and reviewer disagree/);
    expect(noteEpisodeKey(note)).toBe(`ruling-dispute:3794:${H3}`);
    expect(noteHeadline(note)).toMatch(/disagree/);
    expect(buildNoteComment(note)).toMatch(/conveyor-note-key: ruling-dispute:3794/);
  });
  it('a send-back that ended without a new head is a dispute too, but a notice alone (fixer not yet back) is not', () => {
    const thread = ignoredRulingThread();
    const notice = trusted(renderRulingNotAddressed({ head: H2, matches: [{ finding: { file: 'policy/pointer.md', line: 12, summary: 's' }, ruling: 'block: x', priorHead: H1, misses: 1 }] }), 21);
    expect(plan(H2, [...thread, notice]).dispatch.map((d) => d.mode)).toEqual(['ruling-not-addressed']);
    const ended = plan(H2, [...thread, notice, trusted(`${FIX_END_MARKER}\n`, 30)]);
    expect(ended.dispatch).toEqual([]);
    expect(ended.refusals[0].kind).toBe('ruling-dispute');
    expect(ended.notes.find((n) => n.kind === 'ruling-dispute').text).toMatch(/returned without a new head/);
  });
  it('is read off the real reconcile pass (enrichment wired in)', () => {
    const pr = basePr(H2, ignoredRulingThread());
    const out = runReconcilePass({ repo, now: Date.parse('2026-10-04T12:00:00Z'), readPrs: () => [pr], readAgents: () => [], enrich: (x) => x,
      enrichMainRed: (prs) => ({ prs }), enrichAlreadyLanded: (x) => x, enrichBaseRef: (x) => x, enrichSystemFix: (x) => x,
      enrichFixClaims: (x) => x, enrichTimeouts: (x) => x, enrichReferralHolds: (x) => x,
      resolveMainSha: () => null, readRequiredChecks: () => ({ checks: ['test'] }) });
    expect(out.dispatch.map((d) => d.mode)).toEqual(['ruling-not-addressed']);
  });
  it('enrichment never throws on a bad thread', () => {
    expect(enrichPrsWithIgnoredRulings([{ number: 1, comments: 'nope' }])[0].ignoredRulings).toBeNull();
  });
});

describe('ruling not addressed — what the fixer receives', () => {
  const ruling = plan(H2, ignoredRulingThread()).dispatch[0].rulingNotAddressed;
  it('puts the ruling and the note in front of the brief; other prompts are untouched', () => {
    const prompt = withRulingNotAddressed('BRIEF', ruling);
    expect(prompt.endsWith('BRIEF')).toBe(true);
    expect(prompt).toMatch(/Operator ruling, verbatim: block: pointer files must be listed/);
    expect(prompt).toMatch(/did not satisfy this/);
    expect(withRulingNotAddressed('BRIEF', null)).toBe('BRIEF');
  });
  it('posts the durable notice once per head', () => {
    const exec = vi.fn();
    expect(postRulingNotice({ repo, pr: 3794, ruling, exec })).toBe(true);
    const [bin, args] = exec.mock.calls[0];
    expect(bin).toBe('gh');
    expect(args.join(' ')).toContain(RULING_NOT_ADDRESSED_MARKER);
    expect(postRulingNotice({ repo, pr: 3794, ruling: { ...ruling, sentBack: true }, exec })).toBe(false);
    expect(postRulingNotice({ repo, pr: 3794, ruling: null, exec })).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
