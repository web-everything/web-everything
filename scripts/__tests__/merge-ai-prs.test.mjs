/**
 * @file scripts/__tests__/merge-ai-prs.test.mjs
 * @description The drain's graduatedTo RESOLUTION BASIS surface (#2447). (The original monolithic file of this
 *   name was split into the `merge-ai-prs-*.test.mjs` siblings; this one covers only the #2447 slice.) A
 *   backlog-only PR that resolves its item via `graduatedTo` must lead its durable park/skip comment with the
 *   "no code change — deliverable already landed" banner, while every other PR's comment — and the dedupe keyed
 *   on its text — stays byte-identical. Also the non-default-base hold (#3674, ruled #3805 Fork 2 (a)): a PR whose
 *   base is not the repo's default branch is skipped with `base is not <default> (<base>)`.
 */
import { describe, it, expect } from 'vitest';
import { withResolutionBasis, buildDrainReasonComment, hasDrainReasonComment, buildDrainVerdicts, classifyPr, isRebaseDropCandidate } from '../merge-ai-prs.mjs';
import { buildManifest } from '../readiness/lane-manifest.mjs';
import { deriveResolutionBasis, graduatedToFromBody } from '../lib/review-render.mjs';

describe('withResolutionBasis — the drain park/skip comment (#2447)', () => {
  const reason = 'branch is BEHIND main — rebase needed';

  it('leads the comment with the banner for a backlog-only graduatedTo resolve', () => {
    // Mirrors the drain's own derivation inputs: the body note extracted at verdict-build, the PR's file set.
    const basis = deriveResolutionBasis({
      bodyGraduatedTo: graduatedToFromBody('Resolves #2403.\n\ngraduatedTo: 6b5874f7\n'),
      changedFiles: ['backlog/2403-review-disposition.md'],
    });
    const comment = buildDrainReasonComment('skip', withResolutionBasis(reason, basis), null);
    expect(comment).toContain('`graduatedTo: 6b5874f7` — no code change — deliverable already landed in `6b5874f7`');
    expect(comment.indexOf('Resolution basis')).toBeLessThan(comment.indexOf(reason));
    expect(hasDrainReasonComment([{ body: comment }], 'skip', withResolutionBasis(reason, basis), null)).toBe(true);
  });

  it('returns the reason UNCHANGED for a code resolve, a missing basis, or an empty reason', () => {
    const codeBasis = deriveResolutionBasis({ bodyGraduatedTo: '6b5874f7', changedFiles: ['backlog/2403-x.md', 'scripts/x.mjs'] });
    expect(codeBasis).toBe(null);
    expect(withResolutionBasis(reason, codeBasis)).toBe(reason);
    expect(withResolutionBasis(reason, undefined)).toBe(reason);
    expect(withResolutionBasis('', { graduatedTo: '6b5874f7', ref: '6b5874f7' })).toBe('');
    expect(withResolutionBasis(null, { graduatedTo: '6b5874f7', ref: '6b5874f7' })).toBe(null);
  });
});

describe('buildDrainVerdicts — carries the graduatedTo sources the escalation pass derives the basis from (#2447)', () => {
  const green = [{ name: 'test', conclusion: 'SUCCESS' }];
  const ghPr = (number, body) => ({ number, title: 't', body, headRefName: `lane/${number}-x`, statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [{ name: 'ready-to-merge' }] });
  const verdictFor = (pr, manifest) => buildDrainVerdicts({ prsByRepo: new Map([[null, [pr]]]), readOf: () => ({ commits: [{ oid: 'abc' }], manifest }), repos: [null] })[0];

  it('attaches the manifest graduatedTo and the body note, which derive the banner for a backlog-only diff', () => {
    const manifest = buildManifest({ item: 2403, repos: [{ repo: 'we', ref: 'lane/2403-x' }], graduatedTo: '6b5874f7' });
    const v = verdictFor(ghPr(421, 'Dedup-resolve.\n\ngraduatedTo: b54f49a8\n'), manifest);
    expect(v.manifestGraduatedTo).toBe('6b5874f7');
    expect(v.bodyGraduatedTo).toBe('b54f49a8');
    // the escalation pass's exact derivation call, over a backlog-only file set — the manifest wins
    const basis = deriveResolutionBasis({ manifest: { graduatedTo: v.manifestGraduatedTo }, bodyGraduatedTo: v.bodyGraduatedTo, changedFiles: ['backlog/2403-x.md'], crossRepo: v.crossRepo });
    expect(basis).toMatchObject({ ref: '6b5874f7', source: 'manifest' });
  });

  it('a plain PR carries null sources', () => {
    const v = verdictFor(ghPr(422, 'what changed and why'), null);
    expect(v.manifestGraduatedTo).toBe(null);
    expect(v.bodyGraduatedTo).toBe(null);
  });
});

describe('classifyPr — base is not the default branch: held with a named reason (#3674)', () => {
  const green = [{ name: 'test', conclusion: 'SUCCESS' }];
  const ghPr = (number, baseRefName, extra = {}) => ({ number, title: 't', body: 'what changed and why', headRefName: `lane/${number}-x`, baseRefName, statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [{ name: 'ready-to-merge' }], ...extra });
  // The drain's real wiring: runCli resolves each repo's default branch and threads it as `defaultBranchOf`.
  const verdictFor = (pr, defaultBranchOf) => buildDrainVerdicts({ prsByRepo: new Map([[null, [pr]]]), readOf: () => ({ commits: [{ oid: 'abc' }], manifest: null }), repos: [null], defaultBranchOf })[0];

  it('base is not main (lane/mechanical-dispatcher): skipped with the exact reason, even with `test` green', () => {
    const v = verdictFor(ghPr(2198, 'lane/mechanical-dispatcher'), () => 'main');
    expect(v.testGreen).toBe(true);
    expect(v.decision).toBe('skip');
    expect(v.reason).toBe('base is not main (lane/mechanical-dispatcher)');
    expect(v.reviewHeld).toBe(false);
  });

  it('base is not <default>: the arm sits ahead of the required-check arm (a red `test` still names the base)', () => {
    const v = classifyPr(ghPr(2156, 'lane/mechanical-dispatcher', { statusCheckRollup: [] }), { defaultBranch: 'main' });
    expect(v.testGreen).toBe(false);
    expect(v.reason).toBe('base is not main (lane/mechanical-dispatcher)');
  });

  it('base is not <default> compares against the INJECTED default branch, never a literal main', () => {
    const onTrunk = verdictFor(ghPr(10, 'trunk'), () => 'trunk');
    expect(onTrunk.decision).toBe('merge');
    const onMain = verdictFor(ghPr(11, 'main'), () => 'trunk');
    expect(onMain.decision).toBe('skip');
    expect(onMain.reason).toBe('base is not trunk (main)');
  });

  it('base is not <default>: a PR on the default branch is unaffected; an unresolved default still holds a lane/* base', () => {
    const onDefault = verdictFor(ghPr(12, 'main'), () => 'main');
    expect(onDefault.decision).toBe('merge');
    expect(onDefault.reason).toBe(classifyPr(ghPr(12, 'main')).reason);
    // stack.reviewWhileBaseOpen (2026-10-10): a stacked lane PR now runs CI, so its `test` can be green. A failed
    // default-branch read must not let it land into its lane base: a lane/* base is held fail-closed.
    const stacked = verdictFor(ghPr(13, 'lane/mechanical-dispatcher'), () => null);
    expect(stacked.decision).toBe('skip');
    expect(stacked.reason).toBe('base is not the default branch (lane/mechanical-dispatcher)');
  });

  it('base is not <default>: the held PR is never a rebase-drop candidate (the rebase pass would re-flip it to merge)', () => {
    const behind = ghPr(14, 'lane/mechanical-dispatcher', { mergeStateStatus: 'BEHIND' });
    const v = verdictFor(behind, () => 'main');
    expect(v.reason).toBe('base is not main (lane/mechanical-dispatcher)');
    expect(isRebaseDropCandidate(v)).toBe(false);
    expect(isRebaseDropCandidate(verdictFor(ghPr(15, 'main', { mergeStateStatus: 'BEHIND' }), () => 'main'))).toBe(true);
  });
});
