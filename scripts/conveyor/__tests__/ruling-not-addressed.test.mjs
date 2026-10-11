import { readFileSync } from 'node:fs';
import { REPO_FIX_SETTINGS_PATH } from '../takeover-budget.mjs';
import { describe, expect, it, vi } from 'vitest';
import { runReconcilePass, enrichPrsWithIgnoredRulings } from '../reconcile-pass.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { withRulingNotAddressed, postRulingNotice } from '../reconcile-fix-dispatch.mjs';
import { noteEpisodeKey, buildNoteComment, noteHeadline } from '../reconcile-note-comment.mjs';
import { FIX_END_MARKER } from '../fix-procedure.mjs';
import { renderRulingNotAddressed, RULING_NOT_ADDRESSED_MARKER } from '../../lib/ruling-ledger.mjs';
import { H1, H2, H3, H4, repo, record, recordComment, ignoredRulingThread, iso } from './ruling-fixtures.mjs';

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
  it('the second miss goes to a stronger model with a failing test first, not a third round with the same fixer', () => {
    const comments = [...ignoredRulingThread(), recordComment(record({ head: H3, runId: 'run-3' }), 40)];
    const p = plan(H3, comments);
    expect(p.dispatch.map((d) => [d.kind, d.mode, d.rulingNotAddressed.rung.id])).toEqual([['fix', 'ruling-not-addressed', 'stronger-model']]);
    expect(p.dispatch[0].rulingNotAddressed.rung.instruction).toBe('test-first');
    expect(p.refusals).toEqual([]);
  });
  it('the third miss goes to the operator when no cross-provider fixer is available (the default), with the ladder trail', () => {
    const comments = [...ignoredRulingThread(), recordComment(record({ head: H3, runId: 'run-3' }), 40), recordComment(record({ head: H4, runId: 'run-4' }), 60)];
    const p = plan(H4, comments);
    expect(p.dispatch).toEqual([]);
    expect(p.refusals.map((r) => r.kind)).toEqual(['ruling-dispute']);
    const note = p.notes.find((n) => n.kind === 'ruling-dispute');
    expect(note).toMatchObject({ prNumber: 3794, head: H4, misses: 3, rung: 'human' });
    expect(note.text).toMatch(/fixer and reviewer disagree/);
    expect(note.text).toMatch(/Ladder so far: resend > stronger-model/);
    expect(noteEpisodeKey(note)).toBe(`ruling-dispute:3794:${H4}`);
    expect(noteHeadline(note)).toMatch(/disagree/);
    expect(buildNoteComment(note)).toMatch(/conveyor-note-key: ruling-dispute:3794/);
  });
  it('a fixer turn that ends on the sent-back head without a new push counts as another miss; a notice alone does not', () => {
    const thread = ignoredRulingThread();
    const notice = trusted(renderRulingNotAddressed({ head: H2, matches: [{ finding: { file: 'policy/pointer.md', line: 12, summary: 's' }, ruling: 'block: x', priorHead: H1, misses: 1 }] }), 21);
    expect(plan(H2, [...thread, notice]).dispatch.map((d) => d.rulingNotAddressed.rung.id)).toEqual(['resend']);
    const once = plan(H2, [...thread, notice, trusted(`${FIX_END_MARKER}\n`, 30)]);
    expect(once.dispatch.map((d) => d.rulingNotAddressed.rung.id)).toEqual(['stronger-model']);
    const twice = plan(H2, [...thread, notice, trusted(`${FIX_END_MARKER}\n`, 30), trusted(`${FIX_END_MARKER}\n`, 50)]);
    expect(twice.dispatch).toEqual([]);
    expect(twice.refusals[0].kind).toBe('ruling-dispute');
    expect(twice.notes.find((n) => n.kind === 'ruling-dispute').text).toMatch(/2 fixer turn\(s\) ended without a new head/);
  });
  it('a fix-end line from anyone but a trusted author does not count as a miss', () => {
    const thread = ignoredRulingThread();
    const notice = trusted(renderRulingNotAddressed({ head: H2, matches: [{ finding: { file: 'policy/pointer.md', line: 12, summary: 's' }, ruling: 'block: x', priorHead: H1, misses: 1 }] }), 21);
    const stranger = { body: `${FIX_END_MARKER}\n`, createdAt: iso(30), author: { login: 'stranger' } };
    const out = plan(H2, [...thread, notice, stranger, { ...stranger, createdAt: iso(50) }]);
    expect(out.dispatch.map((d) => d.rulingNotAddressed.rung.id)).toEqual(['resend']);
    expect(out.dispatch[0].rulingNotAddressed.returns).toBe(0);
    expect(out.refusals).toEqual([]);
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
    expect(postRulingNotice({ repo, pr: 3794, ruling: { ...ruling, noticedRungs: ['resend'] }, exec })).toBe(false);
    // a new ladder rung on the same head is announced again
    expect(postRulingNotice({ repo, pr: 3794, ruling: { ...ruling, noticedRungs: ['resend'], rung: { ...ruling.rung, id: 'stronger-model', at: 2 } }, exec })).toBe(true);
    expect(postRulingNotice({ repo, pr: 3794, ruling: null, exec })).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

// ── An operator ruling WITH A DIRECTION on the blocked-findings round cap (live: PR #4631 @f0f4943fb, 2026-10-10). Every
// open finding on the head was ruled `block` by the operator with one direction ("only the drain's own machine park
// marker counts; no inference from timing or events"), but the head had spent its rounds (6/5): the cap answered
// "a person must take it over" and nothing could act on the direction. The ruling now buys ONE directed takeover.
describe('operator ruling with a direction on the blocked-findings round cap (#4631 shape)', async () => {
  const { buildOperatorRulingComment } = await import('../../lib/jury-core.mjs');
  const { takeoverMarkerBody, takeoverVoidMarkerBody } = await import('../fix-takeover.mjs');
  const { withPlannedContext } = await import('../reconcile-fix-dispatch.mjs');
  const { loadFixerLadder } = await import('../fixer-ladder.mjs');
  const { resolveOperatorRulingExtraRounds } = await import('../reconcile-core.mjs');
  const { loadOperatorRulingExtraRounds } = await import('../reconcile-pass.mjs');
  const DIRECTION = 'operator 2026-10-10 ~11:55 ET: Ok — keep block WITH DIRECTION: carry-forward may lift a review:human hold ONLY when that hold carries the drain\'s own machine park marker (positive proof it was mechanical); any hold without that marker (incl. an operator\'s deliberate re-hold) is never removed. No inference from timing or event counts.';
  const ladder = loadFixerLadder({ override: null });
  const recA = record({ head: H4, runId: 'run-4', file: 'scripts/review-set-label.mjs', summary: 'An identical diff can erase a deliberately re-added human hold because carry-forward never proves that the hold was mechanical' });
  const recB = record({ head: H4, runId: 'run-4:referral-chunk:2', file: 'scripts/lib/accept-carry-forward.mjs', summary: 'Timing and event counts can misidentify an operator deliberate hold as the drain mechanical park' });
  const blocked = [recA, recB].map((r) => ({ key: r.referrals[0].key, findingId: null, finding: { file: r.referrals[0].original.file, line: 12, summary: r.referrals[0].original.summary } }));
  const rulingOn = (rec, { min = 80, head = H4, login = 'chalbert', actor = 'chalbert', reason = DIRECTION } = {}) => {
    const r = { version: 1, repo, pr: 3794, head, rulings: [{ runId: rec.runId, key: rec.referrals[0].key, result: 'block' }], actor, channel: 'claude-code-chat', reason, at: iso(min), clearerId: 'sess' };
    return { body: buildOperatorRulingComment(r), createdAt: iso(min), author: { login } };
  };
  const marker = (min, head = H4) => trusted(takeoverMarkerBody({ pr: 3794, head, attempts: 6, cap: 5, rung: { id: 'stronger-model' }, n: 1, budget: 1 }), min);
  const base = [recordComment(recA, 60), recordComment(recB, 61)];
  // The shipped `fix` settings turn the automatic takeover on (`roundCapAction: takeover`, a budget above 0); the pure core's own defaults are off.
  const TAKEOVER_ON = { roundCapAction: 'takeover', takeoverBudget: 2 };
  const planAt = (comments, extra = {}, prExtra = {}) => planReconcile({ repo: 'we', agents: [], now: Date.parse('2026-10-04T12:00:00Z'), requiredChecks: ['test'],
    fixerLadder: ladder, durableCounts: { 3794: 6 }, prs: [{ ...basePr(H4, comments), blockRuledReferrals: blocked, ...prExtra }], ...extra });
  const planOn = (comments, extra = {}, prExtra = {}) => planAt(comments, { ...TAKEOVER_ON, ...extra }, prExtra);

  it('before: with no operator ruling, the blocked-findings cap asks a person (cap-exhausted)', () => {
    const p = planAt(base);
    expect(p.dispatch).toEqual([]);
    expect(p.refusals.map((r) => r.kind)).toEqual(['cap-exhausted']);
  });

  it('after: the operator ruling grants ONE directed takeover on the stronger rung, its brief carrying the ruling verbatim', () => {
    const p = planOn([...base, rulingOn(recA, { min: 80 }), rulingOn(recB, { min: 81 })]);
    expect(p.refusals.map((r) => r.kind)).not.toContain('cap-exhausted');
    expect(p.dispatch.map((d) => [d.kind, d.mode])).toEqual([['fix', 'takeover']]);
    const d = p.dispatch[0];
    expect(d.takeover).toMatchObject({ attempts: 6, cap: 5, n: 1, budget: 1, rung: { id: 'stronger-model' }, route: { provider: 'claude' } });
    expect(d.operatorRulingRound).toMatchObject({ head: H4, used: 0, allowance: 1, setting: 'fix.operatorRulingExtraRounds', source: 'standard' });
    expect(d.why).toMatch(/fix\.operatorRulingExtraRounds=1 \(source: standard\)/);
    const brief = withPlannedContext('BRIEF', d);
    expect(brief).toContain(DIRECTION); // verbatim, once (the same direction on both rulings)
    expect(brief.split(DIRECTION).length).toBe(2);
    expect(brief).toContain('scripts/review-set-label.mjs');
    expect(brief).toContain('scripts/lib/accept-carry-forward.mjs');
    expect(brief.endsWith('BRIEF')).toBe(true);
  });

  it('only when EVERY blocked finding is covered by an operator ruling on this head', () => {
    expect(planAt([...base, rulingOn(recA)]).refusals.map((r) => r.kind)).toEqual(['cap-exhausted']);
    expect(planAt([...base, rulingOn(recA, { head: H3 }), rulingOn(recB, { head: H3 })]).refusals.map((r) => r.kind)).toEqual(['cap-exhausted']);
  });

  it('a forged ruling (not the operator\'s login) or an auto-policy block grants nothing', () => {
    expect(planAt([...base, rulingOn(recA, { login: 'stranger' }), rulingOn(recB, { login: 'stranger' })]).dispatch).toEqual([]);
    const auto = [rulingOn(recA, { actor: 'auto-policy', login: 'web-everything' }), rulingOn(recB, { actor: 'auto-policy', login: 'web-everything' })];
    expect(planAt([...base, ...auto]).dispatch).toEqual([]);
  });

  it('no loop: once the directed takeover started on this head, the same ruling grants nothing more', () => {
    const ruled = [...base, rulingOn(recA, { min: 80 }), rulingOn(recB, { min: 81 })];
    const p = planOn([...ruled, marker(90)]);
    expect(p.dispatch.some((d) => d.operatorRulingRound)).toBe(false);
    expect(p.dispatch).toEqual([]);
    // A takeover whose launch provably never started (void marker) did not spend the round.
    expect(planOn([...ruled, marker(90), trusted(takeoverVoidMarkerBody({ pr: 3794, head: H4 }), 95)]).dispatch.map((d) => d.operatorRulingRound?.used)).toEqual([0]);
    // A NEW ruling after the spent round is a new ruling: it grants its own round.
    expect(planOn([...ruled, marker(90), rulingOn(recA, { min: 100 }), rulingOn(recB, { min: 101 })]).dispatch.map((d) => d.operatorRulingRound?.used)).toEqual([0]);
  });

  it('a new head with the findings still blocked goes back to the operator (the ruling bound the old head)', () => {
    const p = planReconcile({ repo: 'we', agents: [], now: Date.parse('2026-10-04T12:00:00Z'), requiredChecks: ['test'], fixerLadder: ladder, durableCounts: { 3794: 7 },
      prs: [{ ...basePr('e'.repeat(40), [...base, rulingOn(recA), rulingOn(recB), marker(90)]), blockRuledReferrals: blocked }] });
    expect(p.dispatch).toEqual([]);
    expect(p.refusals.map((r) => r.kind)).toEqual(['cap-exhausted']);
  });

  it('below the cap the ordinary block-ruled fix runs (the grant is only past the cap)', () => {
    const p = planOn([...base, rulingOn(recA), rulingOn(recB)], {}, {});
    const under = planReconcile({ repo: 'we', agents: [], now: Date.parse('2026-10-04T12:00:00Z'), requiredChecks: ['test'], fixerLadder: ladder, durableCounts: { 3794: 2 },
      prs: [{ ...basePr(H4, [...base, rulingOn(recA), rulingOn(recB)]), blockRuledReferrals: blocked }] });
    expect(p.dispatch[0].mode).toBe('takeover');
    expect(under.dispatch.map((d) => d.mode)).toEqual(['block-ruled-referral']);
  });

  it('the allowance is a setting: 0 grants nothing; 2 grants a second round on the same ruling', () => {
    const ruled = [...base, rulingOn(recA), rulingOn(recB)];
    expect(planOn(ruled, { operatorRulingExtraRounds: { value: 0, source: 'env' } }).dispatch.some((d) => d.operatorRulingRound)).toBe(false);
    const two = planOn([...ruled, marker(90)], { operatorRulingExtraRounds: { value: 2, source: 'platform' } });
    expect(two.dispatch.map((d) => d.mode)).toEqual(['takeover']);
    expect(two.dispatch[0].operatorRulingRound).toMatchObject({ used: 1, allowance: 2, source: 'platform' });
    expect(two.dispatch[0].takeover).toMatchObject({ n: 2, budget: 2 });
  });

  it('fix.operatorRulingExtraRounds resolves standard → platform → tool (fix.json) → env, each file layer under its `fix` key', () => {
    const R = 'operatorRulingExtraRounds';
    expect(resolveOperatorRulingExtraRounds({})).toEqual({ value: 1, source: 'standard' });
    expect(resolveOperatorRulingExtraRounds({ platform: { fix: { [R]: 0 } } })).toEqual({ value: 0, source: 'platform' });
    expect(resolveOperatorRulingExtraRounds({ platform: { fix: { [R]: 0 } }, repo: { fix: { [R]: 3 } } })).toEqual({ value: 3, source: 'repo' });
    expect(resolveOperatorRulingExtraRounds({ repo: { fix: { [R]: 3 } }, env: { WE_FIX_OPERATOR_RULING_EXTRA_ROUNDS: '2' } })).toEqual({ value: 2, source: 'env' });
    // The repo file namespaces its settings under `fix`; a flat top-level key is not the documented shape and is not read.
    expect(resolveOperatorRulingExtraRounds({ repo: { [R]: 3 } })).toEqual({ value: 1, source: 'standard' });
    // A blank env var, a null key, an absent key and a different `fix` setting are "not present": they fall through.
    expect(resolveOperatorRulingExtraRounds({ platform: { fix: { [R]: 2 } }, repo: { fix: { [R]: null, takeoverBudget: 0 } }, env: { WE_FIX_OPERATOR_RULING_EXTRA_ROUNDS: '  ' } })).toEqual({ value: 2, source: 'platform' });
  });

  it('fails CLOSED: a present but invalid value turns the grant off instead of falling through to the standard', () => {
    const R = 'operatorRulingExtraRounds';
    for (const bad of ['off', 'none', '-1', '1.5', 'x', '100', false, [2], {}, -1, 1.5, true]) {
      expect(resolveOperatorRulingExtraRounds({ repo: { fix: { [R]: bad } } }), `repo ${JSON.stringify(bad)}`).toEqual({ value: 0, source: 'repo-invalid' });
      expect(resolveOperatorRulingExtraRounds({ platform: { fix: { [R]: bad } } }), `platform ${JSON.stringify(bad)}`).toEqual({ value: 0, source: 'platform-invalid' });
    }
    for (const bad of ['off', 'none', '-1', '1.5', '100', 'x']) {
      expect(resolveOperatorRulingExtraRounds({ env: { WE_FIX_OPERATOR_RULING_EXTRA_ROUNDS: bad } }), `env ${bad}`).toEqual({ value: 0, source: 'env-invalid' });
    }
    expect(resolveOperatorRulingExtraRounds({ env: { WE_FIX_OPERATOR_RULING_EXTRA_ROUNDS: '0' } })).toEqual({ value: 0, source: 'env' });
    // the highest PRESENT layer decides: an invalid env beats a valid repo value
    expect(resolveOperatorRulingExtraRounds({ repo: { fix: { [R]: 3 } }, env: { WE_FIX_OPERATOR_RULING_EXTRA_ROUNDS: 'x' } })).toEqual({ value: 0, source: 'env-invalid' });
  });

  it('the IO shell reads both files in their real `fix`-namespaced shape (the shipped scripts/settings/fix.json included)', () => {
    const R = 'operatorRulingExtraRounds';
    const files = (platform, repoFile) => (f) => JSON.stringify(/delivery-platform-preferences/.test(f) ? platform : repoFile);
    expect(loadOperatorRulingExtraRounds({ env: {}, read: files({ fix: { [R]: 2 } }, {}) })).toEqual({ value: 2, source: 'platform' });
    expect(loadOperatorRulingExtraRounds({ env: {}, read: files({ fix: { [R]: 2 } }, { $comment: 'c', fix: { roundCapAction: 'takeover', [R]: 0 } }) })).toEqual({ value: 0, source: 'repo' });
    expect(loadOperatorRulingExtraRounds({ env: {}, read: files({}, { fix: { [R]: 2 } }) })).toEqual({ value: 2, source: 'repo' });
    // an unreadable file is skipped (the standard), not a throw
    expect(loadOperatorRulingExtraRounds({ env: {}, read: () => { throw new Error('ENOENT'); } })).toEqual({ value: 1, source: 'standard' });
    // the real shipped fix.json goes through the same loader: it carries no such key, so the standard stands
    expect(loadOperatorRulingExtraRounds({ env: {}, read: (f) => (/delivery-platform-preferences/.test(f) ? '{}' : readFileSync(f, 'utf8')) })).toEqual({ value: 1, source: 'standard' });
    // and the same file with the key set (the shape the card documents) is honoured
    const shipped = JSON.parse(readFileSync(REPO_FIX_SETTINGS_PATH, 'utf8'));
    expect(loadOperatorRulingExtraRounds({ env: {}, read: files({}, { ...shipped, fix: { ...shipped.fix, [R]: 0 } }) })).toEqual({ value: 0, source: 'repo' });
  });

  it('the takeover kill switches stop the directed takeover too (roundCapAction=person, budget 0 or invalid)', () => {
    const ruled = [...base, rulingOn(recA), rulingOn(recB)];
    expect(planOn(ruled).dispatch.map((d) => d.operatorRulingRound?.used)).toEqual([0]);
    for (const off of [{ roundCapAction: 'person' }, { takeoverBudget: 0 }, { takeoverBudget: Number.NaN }]) {
      const p = planOn(ruled, off);
      expect(p.dispatch, JSON.stringify(off)).toEqual([]);
      expect(p.refusals.map((r) => r.kind), JSON.stringify(off)).toEqual(['cap-exhausted']);
    }
  });

  it('is wired through the real reconcile pass, which logs the setting\'s layer', () => {
    // One trusted re-arm = one spent round; WE_REVIEW_ROUND_CAP=1 puts the head at the cap (1/1).
    const pr = { ...basePr(H4, [trusted('🔧 conveyor fix — re-armed for re-review', 50), ...base, rulingOn(recA), rulingOn(recB)]) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pass = (loaders = {}) => runReconcilePass({ repo, now: Date.parse('2026-10-04T12:00:00Z'), readPrs: () => [pr], readAgents: () => [], enrich: (x) => x,
      enrichMainRed: (prs) => ({ prs }), enrichAlreadyLanded: (x) => x, enrichBaseRef: (x) => x, enrichSystemFix: (x) => x,
      enrichFixClaims: (x) => x, enrichTimeouts: (x) => x, enrichReferralHolds: (prs) => prs.map((p) => ({ ...p, blockRuledReferrals: blocked, referralHold: null })),
      enrichMechanicalRound: (x) => x, loadOperatorRulingRounds: () => ({ value: 1, source: 'env' }),
      loadFixSettings: () => ({ roundCapAction: 'takeover' }), loadTakeoverBudget: () => ({ value: 2, source: 'env' }), ...loaders,
      resolveMainSha: () => null, readRequiredChecks: () => ({ checks: ['test'] }), env: { WE_REVIEW_ROUND_CAP: '1' } });
    try {
      // The takeover off switches, read by the pass's own loaders, stop the directed grant (the wiring, not just the planner).
      for (const [name, loaders] of [['roundCapAction=person', { loadFixSettings: () => ({ roundCapAction: 'person' }) }],
        ['budget 0', { loadTakeoverBudget: () => ({ value: 0, source: 'env' }) }],
        ['budget invalid', { loadTakeoverBudget: () => ({ value: 0, source: 'env-invalid' }) }],
        ['unreadable fix settings', { loadFixSettings: () => { throw new Error('unreadable'); } }]]) {
        expect(pass(loaders).dispatch.some((x) => x.operatorRulingRound), name).toBe(false);
      }
      const out = pass();
      const d = out.dispatch.find((x) => x.operatorRulingRound);
      expect(d).toBeTruthy();
      expect(d.operatorRulingRound.source).toBe('env');
      expect(log.mock.calls.flat().join('\n')).toMatch(/operator-ruling-round: fix\.operatorRulingExtraRounds=1 \(source: env\)/);
    } finally { log.mockRestore(); }
  });
});
