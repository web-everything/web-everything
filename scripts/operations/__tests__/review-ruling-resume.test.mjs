/**
 * @file review-ruling-resume.test.mjs — card xq1xbsl. A ruling on an unchanged head RESUMES the paused review.
 *
 * Live 2026-10-08. #4361: the operator ruled at 12:09Z and a fresh full review started at 12:15Z, raising two new
 * referrals, so the PR went back to `advisory:ruling-needed` and never reached the operator. #4388: a ruling was
 * followed by round 2 at 12:20Z re-raising a finding the fixer had already fixed (the card's test plan names the test at
 * line 43; the referral cited :29 "no planned regression test"). Both are replayed here. Each test is RED on the code
 * before this card: there was no resume (a ruling always started a new panel), and no round scoping for referrals.
 */
import { describe, it, expect } from 'vitest';

import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { judgeOutcome } from '../cli-adapter.mjs';
import { rewindRunToStep } from '../engine.mjs';
import { REVIEW_EFFECTS, reviewPrOperation } from '../review-pr.mjs';
import { runReviewLoopOnce, defaultFindResumableRun } from '../review-loop-cli.mjs';
import {
  classifyReferralsByRound, findingIdentityTable, REFERRAL_DEMOTED_REASONS, referralFindingKey, normalizeFinding,
  mandatoryReferralReviewer, renderReferralRecord, openReferralHeads,
} from '../../lib/jury-core.mjs';
import { advanceWhileRunning, startRun } from '../engine.mjs';

const HEAD_1 = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const CARD = 'backlog/x29vm8a-the-card.md';

// ── #4388: the finding identity table, exactly as the reduce step reads it off the PR thread ─────────────────────────
const raised = { file: CARD, line: 29, summary: 'No planned regression test for the fix', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const recordFor = (head, original, rulings = []) => {
  const key = referralFindingKey('judge', original);
  const reviewer = mandatoryReferralReviewer(`run-${head[0]}`);
  return { version: 1, repo: 'o/n', pr: 4388, head, runId: `run-${head[0]}`, reviewer, authorBody: '', attempted: true,
    referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }],
    rulings: rulings.map((result, i) => ({ id: `r${i}`, key, reviewerId: reviewer.id, lens: reviewer.lens, result, rationale: 'x', evidence: ['e'] })) };
};
const identityOf = (...records) => findingIdentityTable(records).map(({ findingId, path, lens, normSummary, anchor, forms, heads, rulings }) => ({
  findingId, path, lens, normSummary, anchor, forms, heads, rulings: rulings.map(({ head, result }) => ({ head, result })) }));
const candidate = (original) => ({ seat: 'judge', original });

describe('classifyReferralsByRound — referrals follow the later-round scoping rule (#3999)', () => {
  it('a first sighting on a head with no referrals stays mandatory', () => {
    const out = classifyReferralsByRound([candidate(raised)], { identity: [], head: HEAD_1 });
    expect(out.kept).toHaveLength(1);
    expect(out.demoted).toHaveLength(0);
  });

  it('#4361 replay: a second panel on the SAME head cannot add referrals — new ones are card suggestions, repeats are covered', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['not-real']));
    const reworded = { ...raised, line: 43 };
    const brandNew = { file: 'scripts/lib/pre-pr-review.mjs', line: 9, summary: 'A guard is missing on the empty list', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const out = classifyReferralsByRound([candidate(reworded), candidate(brandNew)], { identity, head: HEAD_1, lens: 'simplicity' });
    expect(out.kept).toEqual([]);
    expect(out.covered.map((c) => c.original)).toEqual([reworded]);
    expect(out.demoted).toEqual([{ candidate: candidate(brandNew), reason: REFERRAL_DEMOTED_REASONS.LATER_ROUND_SAME_HEAD }]);
  });

  it('#4388 replay: a finding ruled block, re-raised after the fixer changed the cited lines, is matched by identity and not re-referred', () => {
    // A source file: the demotion needs positive evidence the cited lines changed (a line window on a source file, as
    // #3999 uses), which a backlog card cannot give. See the next describe for the cases that stay mandatory.
    const cited = { ...raised, file: 'scripts/lib/pre-pr-review.mjs' };
    const identity = identityOf(recordFor(HEAD_1, cited, ['block']));
    const reRaised = { ...cited, line: 43 };
    const latestFix = { priorHead: HEAD_1, head: HEAD_2, files: { [cited.file]: [43] } };
    const out = classifyReferralsByRound([candidate(reRaised)], { identity, head: HEAD_2, latestFix });
    expect(out.kept).toEqual([]);
    expect(out.demoted).toEqual([{ candidate: candidate(reRaised), reason: REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE }]);
  });

  it('a block-ruled finding re-raised on the SAME head is covered only: its gate lives in the thread record, not in a new referral', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['block']));
    const out = classifyReferralsByRound([candidate({ ...raised, line: 43 })], { identity, head: HEAD_1 });
    expect(out.covered).toHaveLength(1);
    expect(out.kept).toEqual([]);
    expect(out.demoted).toEqual([]);
  });

  it('a block-ruled finding re-raised when the fixer did NOT touch its file stays mandatory (the ignored-ruling path needs it)', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['block']));
    const latestFix = { priorHead: HEAD_1, head: HEAD_2, files: { 'src/other.mjs': [1] } };
    const out = classifyReferralsByRound([candidate(raised)], { identity, head: HEAD_2, latestFix });
    expect(out.kept).toHaveLength(1);
  });

  it('a push brings a genuinely new finding on a new head: mandatory (new referrals come only from a new push)', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['not-real']));
    const fresh = { file: 'src/z.mjs', line: 2, summary: 'Unrelated crash on empty input', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const out = classifyReferralsByRound([candidate(fresh)], { identity, head: HEAD_2, latestFix: { priorHead: HEAD_1, head: HEAD_2, files: { 'src/z.mjs': [2] } } });
    expect(out.kept).toHaveLength(1);
  });

  it('degrades to the old behaviour on an unreadable fix range or an empty table', () => {
    const identity = identityOf(recordFor(HEAD_1, raised, ['block']));
    expect(classifyReferralsByRound([candidate(raised)], { identity, head: HEAD_2, latestFix: { error: 'x' } }).kept).toHaveLength(1);
    expect(classifyReferralsByRound([candidate(raised)]).kept).toHaveLength(1);
  });
});

// ── the engine step that makes "resume" a real thing ─────────────────────────────────────────────────────────────────
const NET_PATHS = ['scripts/operations/review-pr.mjs'];
const stubReader = () => ({ pr, repo }) => ({
  state: 'OPEN', clearerId: undefined, createdAt: '',
  detail: { pr, repo, title: 'a parked PR', url: `https://example.invalid/${pr}`, labels: ['review:human'], humanRequired: true,
    reviewClass: 'human', disposition: { mode: 'converge', autoLand: false }, escalationReason: ['gate-self'],
    advisoryComment: null, humanComment: null, diffStat: NET_PATHS.map((p) => ({ path: p, additions: 1, deletions: 0 })) },
  headRefName: 'lane/thing', body: 'the PR description',
  net: { paths: NET_PATHS, base: 'abc123', rev: HEAD_1, scored: true },
  diff: { text: '--- a/x\n+++ b/x\n+one line\n', scored: true },
});
const setup = () => {
  const declaration = reviewPrOperation({ readPr: stubReader() });
  const registry = createRegistry();
  registry.register(declaration);
  return { declaration, registry };
};
const REFERRAL_ANSWER = { summary: 'one confirmed defect', findings: [{ summary: 'the guard is inverted', file: NET_PATHS[0], line: 3,
  disposition: 'blocker', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }] };

/** Sinks that record every effect; the referral sink reports `pending` until `ruled.value` flips, as the real one does off the thread. */
function sinksWith({ seen, ruled }) {
  const sinks = Object.fromEntries(Object.values(REVIEW_EFFECTS).map((t) => [t, async (payload) => { seen.push({ type: t, payload }); return { ok: true }; }]));
  sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS] = async (payload) => {
    seen.push({ type: REVIEW_EFFECTS.MANDATORY_REFERRALS, payload });
    return ruled.value ? { records: [], pending: [], blocked: [], pendingFindings: [] }
      : { records: [], pending: ['k1'], blocked: [], pendingFindings: [{ file: NET_PATHS[0], line: 3, seat: 'judgeAdvisory', summary: 'the guard is inverted' }] };
  };
  return sinks;
}

const argv = ['--pr=4361', '--repo=o/n'];

describe('rewindRunToStep', () => {
  it('keeps every finding before the step and drops the step and everything after it', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const seen = [];
    const parked = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled: { value: false } }),
      makeJudge: () => async () => judgeOutcome(REFERRAL_ANSWER, {}), mintRunId: () => 'r-1' });
    expect(parked.stopped).toBe('confirm');
    const run = store.read('r-1');
    const back = rewindRunToStep(run, { registry, step: 'mandatoryReferrals', at: '2026-10-08T12:10:00.000Z' });
    expect(back.pending).toBeNull();
    expect(back.findings.reduce).toEqual(run.findings.reduce);
    expect(back.findings.mandatoryReferrals).toBeUndefined();
    expect(back.findings.referralVerdict).toBeUndefined();
    expect(back.effects.every((e) => e.step !== 'mandatoryReferrals')).toBe(true);
    const stepAt = declaration.steps.find((x) => x.name === 'mandatoryReferrals').index;
    // The earlier steps' records survive the rewind (a drop-everything filter would also pass the lines above).
    expect(back.effects).toEqual(run.effects.filter((e) => e.step !== 'mandatoryReferrals' && e.stepIndex < stepAt));
    expect(back.stepTimings.some((t) => t.step === 'read')).toBe(true);
    expect(back.stepTimings.every((t) => t.stepIndex < stepAt)).toBe(true);
    expect(() => rewindRunToStep({ ...run, cursor: 0, pending: null }, { registry, step: 'mandatoryReferrals' })).toThrow(/has not reached/);
    expect(back.resumedAt).toBe('2026-10-08T12:10:00.000Z');
    expect(() => rewindRunToStep(run, { registry, step: 'nope' })).toThrow(/no step/);
  });
});

describe('runReviewLoopOnce — a ruling on an unchanged head resumes the paused review (replay of #4361)', () => {
  it('reuses the parked panel: no juror runs, same run id, the referral step re-reads the thread, and the verdict is the ruled one', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const seen = [];
    const ruled = { value: false };
    let judged = 0;
    const makeJudge = () => async () => { judged += 1; return judgeOutcome(REFERRAL_ANSWER, {}); };

    // 12:00Z - the first review parks on its mandatory referral.
    const first = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled }), makeJudge, mintRunId: () => 'r-1' });
    expect(first.run.verdict.pendingReferrals).toEqual(['k1']);
    const judgedByFirstReview = judged;
    expect(judgedByFirstReview).toBeGreaterThan(0);

    // 12:09Z - the operator rules. 12:15Z - the daemon starts the review again; the hold says run r-1 is the one to resume.
    ruled.value = true;
    const second = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen, ruled }),
      makeJudge, mintRunId: () => 'r-2-must-not-be-minted', findResumableRun: () => 'r-1', now: () => '2026-10-08T12:15:00.000Z' });

    expect(judged).toBe(judgedByFirstReview);                 // no fresh panel
    expect(second.run.id).toBe('r-1');                        // the same run, resumed
    expect(store.read('r-2-must-not-be-minted')).toBeFalsy();
    expect(second.run.resumedAt).toBe('2026-10-08T12:15:00.000Z');
    expect(second.run.verdict.pendingReferrals).toEqual([]);  // the ruling is reflected: nothing is owed any more
    expect(seen.filter((e) => e.type === REVIEW_EFFECTS.MANDATORY_REFERRALS)).toHaveLength(2);
  });

  it('without a resumable run it starts a fresh review exactly as before (new push, re-arm, send-back)', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    let judged = 0;
    const makeJudge = () => async () => { judged += 1; return judgeOutcome(REFERRAL_ANSWER, {}); };
    const ids = ['r-1', 'r-2'];
    const args = { declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }), makeJudge, mintRunId: () => ids.shift() };
    await runReviewLoopOnce(args);
    const after = judged;
    const again = await runReviewLoopOnce({ ...args, findResumableRun: () => null });
    expect(again.run.id).toBe('r-2');
    expect(judged).toBe(after * 2);
  });

  it('a resume id that no longer names a parked run falls back to a fresh review', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinksWith({ seen: [], ruled: { value: false } }),
      makeJudge: () => async () => judgeOutcome(REFERRAL_ANSWER, {}), mintRunId: () => 'r-fresh', findResumableRun: () => 'gone' });
    expect(out.run.id).toBe('r-fresh');
  });

  it('a store read that throws falls back to a fresh review', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const broken = { ...store, read: (id) => { if (id === 'r-1') throw new Error('corrupt'); return store.read(id); } };
    const out = await runReviewLoopOnce({ declaration, registry, argv, store: broken, sinks: sinksWith({ seen: [], ruled: { value: false } }),
      makeJudge: () => async () => judgeOutcome(REFERRAL_ANSWER, {}), mintRunId: () => 'r-fresh', findResumableRun: () => 'r-1' });
    expect(out.run.id).toBe('r-fresh');
  });

  it('WE_REVIEW_RESUME_PARKED=0 starts a fresh review even when a parked run is resumable', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const sinks = () => sinksWith({ seen: [], ruled: { value: false } });
    const makeJudge = () => async () => judgeOutcome(REFERRAL_ANSWER, {});
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => 'r-1' });
    const prior = process.env.WE_REVIEW_RESUME_PARKED;
    process.env.WE_REVIEW_RESUME_PARKED = '0';
    try {
      const out = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => 'r-2', findResumableRun: () => 'r-1' });
      expect(out.run.id).toBe('r-2');
    } finally {
      if (prior === undefined) delete process.env.WE_REVIEW_RESUME_PARKED; else process.env.WE_REVIEW_RESUME_PARKED = prior;
    }
  });

  it('only a run parked on a confirm step of THIS operation is resumed', async () => {
    const { declaration, registry } = setup();
    const store = createMemoryRunStore();
    const sinks = () => sinksWith({ seen: [], ruled: { value: false } });
    const makeJudge = () => async () => judgeOutcome(REFERRAL_ANSWER, {});
    await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => 'r-1' });
    const parked = store.read('r-1');
    store.write({ ...parked, id: 'r-other-op', op: 'some-other-op' });
    store.write({ ...parked, id: 'r-not-confirm', pending: { ...parked.pending, kind: 'judge' } });
    for (const [id, fresh] of [['r-other-op', 'f-1'], ['r-not-confirm', 'f-2']]) {
      const out = await runReviewLoopOnce({ declaration, registry, argv, store, sinks: sinks(), makeJudge, mintRunId: () => fresh, findResumableRun: () => id });
      expect(out.run.id).toBe(fresh);
    }
  });
});

// ── the reduce step reads the PR's own referral records, so a second panel on the same head cannot add referrals ──────
describe('review-pr reduce — a later panel on an unchanged head adds no mandatory referral (replay of #4361)', () => {
  const firstFinding = { file: NET_PATHS[0], line: 3, summary: 'the guard is inverted', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const newFinding = { file: NET_PATHS[0], line: 8, summary: 'a second, different defect', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const thread = [{ body: renderReferralRecord(recordFor(HEAD_1, firstFinding, ['not-real'])), createdAt: '2026-10-08T12:00:00Z', author: { login: 'web-everything' } }];
  const reduceWith = async (answerFindings, { comments = thread, rev = HEAD_1, latestFix, correctnessAdvisory = false } = {}) => {
    const base = stubReader();
    const declaration = reviewPrOperation({ correctnessAdvisory,
      readPr: (a) => ({ ...base(a), comments, ...(latestFix ? { latestFix } : {}), net: { ...base(a).net, rev } }) });
    const registry = createRegistry();
    registry.register(declaration);
    let run = advanceWhileRunning(startRun({ op: 'review-pr', id: 'r-reduce', input: { repo: 'o/n', pr: 4361 }, registry }), { registry });
    while (run.pending?.kind === 'judge') {
      run = advanceWhileRunning(run, { registry, resume: { value: { summary: 'looked', findings: answerFindings } } });
    }
    return run.findings.reduce;
  };

  it('the repeated finding is covered by identity (even reworded to another line) and leaves the verdict basis', async () => {
    const reduce = await reduceWith([{ ...firstFinding, line: 40, disposition: 'blocker' }]);
    expect(reduce.referrals).toEqual([]);
    expect(reduce.verdict).not.toBe('changes');
  });

  const demotedSame = (reduce) => reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.LATER_ROUND_SAME_HEAD && f.summary === newFinding.summary);

  // PR #4441 review round 1: the gate's own lenses are never silenced by the round rule (the existing #3999 rule keeps
  // them in every round too); only an advisory seat's later-round finding becomes a card suggestion.
  it('a finding first raised in this later round: an advisory seat sets it aside as a card suggestion, a mandatory seat still refers it', async () => {
    const reduce = await reduceWith([{ ...newFinding, disposition: 'blocker' }], { correctnessAdvisory: true });
    expect(reduce.referrals.map((r) => r.seat).sort()).toEqual(['judge', 'judgeSecurity']);
    expect(demotedSame(reduce).map((f) => f.category.split('/')[0])).toEqual(['codex-correctness']);
  });

  // PR #4441 review round 1 (correctness, partial persistence): a head whose referral round never finished is not "settled".
  it('a head whose earlier referral record was never attempted is not a settled round: the advisory seat keeps its finding as a referral', async () => {
    const unattempted = [{ ...thread[0], body: renderReferralRecord({ ...recordFor(HEAD_1, firstFinding), attempted: false }) }];
    const open = await reduceWith([{ ...newFinding, disposition: 'blocker' }], { comments: unattempted, correctnessAdvisory: true });
    expect(open.referrals.map((r) => r.seat).sort()).toEqual(['judge', 'judgeCorrectnessAdvisory', 'judgeSecurity']);
    expect(demotedSame(open)).toEqual([]);
    const attempted = [{ ...thread[0], body: renderReferralRecord({ ...recordFor(HEAD_1, firstFinding), attempted: true }) }];
    const settled = await reduceWith([{ ...newFinding, disposition: 'blocker' }], { comments: attempted, correctnessAdvisory: true });
    expect(demotedSame(settled)).toHaveLength(1);
  });

  // PR #4441 review round 1 (correctness + security): "the fixer touched the cited file" is not "the fixer fixed it".
  describe('a block-ruled finding re-raised after a fix push', () => {
    const blocked = [{ ...thread[0], body: renderReferralRecord(recordFor(HEAD_1, firstFinding, ['block'])) }];
    const latestFix = (lines) => ({ priorHead: HEAD_1, head: HEAD_2, files: { [NET_PATHS[0]]: lines } });
    const reRaised = [{ ...firstFinding, disposition: 'blocker' }];
    it('stays mandatory when the push touched the cited file far from the cited line (the ignored-ruling path needs the referral)', async () => {
      const reduce = await reduceWith(reRaised, { comments: blocked, rev: HEAD_2, latestFix: latestFix([200]) });
      expect(reduce.referrals).toHaveLength(2);
      expect(reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE)).toEqual([]);
    });
    it('is set aside as a card suggestion only when the push changed lines at the cited line', async () => {
      const reduce = await reduceWith(reRaised, { comments: blocked, rev: HEAD_2, latestFix: latestFix([3]) });
      expect(reduce.referrals).toEqual([]);
      expect(reduce.deferredAdvisory.filter((f) => f.deferred === REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE)).toHaveLength(2);
    });
  });
});

// ── PR #4441 review round 1: ONE shared "did the fixer address this finding" predicate, with the same care as #3999 ──
describe('classifyReferralsByRound — a block-ruled re-raise is demoted only on positive evidence the cited lines were fixed', () => {
  const SRC = 'scripts/lib/thing.mjs';
  const finding = (file, line = 100) => ({ file, line, summary: 'The guard on an empty list is missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' });
  const run = (file, latestFix, line = 100) => classifyReferralsByRound([candidate(finding(file, line))],
    { identity: identityOf(recordFor(HEAD_1, finding(file), ['block'])), head: HEAD_2, latestFix });
  const fix = (files, extra = {}) => ({ priorHead: HEAD_1, head: HEAD_2, files, ...extra });
  const demoted = (out) => out.demoted.map((d) => d.reason);

  it('demotes when a source file changed within LATER_ROUND_CHANGE_WINDOW of the cited line (edges included)', () => {
    for (const changed of [100, 97, 103]) expect(demoted(run(SRC, fix({ [SRC]: [changed] })))).toEqual([REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE]);
    for (const changed of [96, 104]) expect(run(SRC, fix({ [SRC]: [changed] })).kept).toHaveLength(1);
  });
  it.each([
    ['an edit far from the cited line', SRC, fix({ [SRC]: [5] })],
    ['a non-source file (no line meaning to scope on)', 'backlog/x29vm8a-the-card.md', fix({ 'backlog/x29vm8a-the-card.md': [100] })],
    ['an unknown changed-line set (null)', SRC, fix({ [SRC]: null })],
    ['an empty changed-line set', SRC, fix({ [SRC]: [] })],
    ['a fix range with no prior head', SRC, fix({ [SRC]: [100] }, { priorHead: null })],
    ['a malformed fix range (negative line)', SRC, fix({ [SRC]: [-1, 100] })],
    ['a malformed fix range (files is an array)', SRC, fix([SRC])],
    ['an unreadable fix range', SRC, fix({ [SRC]: [100] }, { error: 'git failed' })],
  ])('stays mandatory for %s', (_name, file, latestFix) => {
    const out = run(file, latestFix);
    expect(out.demoted).toEqual([]);
    expect(out.kept).toHaveLength(1);
  });
  it('stays mandatory when the re-raise cites no line at all', () => {
    const out = classifyReferralsByRound([candidate({ ...finding(SRC), line: undefined })],
      { identity: identityOf(recordFor(HEAD_1, finding(SRC), ['block'])), head: HEAD_2, latestFix: fix({ [SRC]: [100] }) });
    expect(out.kept).toHaveLength(1);
  });
  it('resolves an aliased citation (basename / repo prefix) to the touched path like #3999 does', () => {
    const out = classifyReferralsByRound([candidate({ ...finding('thing.mjs') })],
      { identity: identityOf(recordFor(HEAD_1, finding('thing.mjs'), ['block'])), head: HEAD_2, latestFix: fix({ [SRC]: [101] }) });
    expect(demoted(out)).toEqual([REFERRAL_DEMOTED_REASONS.FIXER_ADDRESSED_RERAISE]);
  });
});

describe('classifyReferralsByRound — the same-head round rule never silences a gate lens, and never fires on an unsettled head', () => {
  const brandNew = { file: 'scripts/lib/pre-pr-review.mjs', line: 9, summary: 'A guard is missing on the empty list', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const identity = identityOf(recordFor(HEAD_1, raised, ['not-real']));
  const run = (o) => classifyReferralsByRound([candidate(brandNew)], { identity, head: HEAD_1, ...o });

  it.each(['correctness', 'security'])('keeps a %s-lens finding first raised in a later round as a referral', (lens) => {
    const out = run({ lens });
    expect(out.kept).toEqual([candidate(brandNew)]);
    expect(out.demoted).toEqual([]);
  });
  it.each(['simplicity', 'codex-correctness'])('sets aside a %s-lens finding first raised in a later round', (lens) => {
    expect(run({ lens }).demoted.map((d) => d.reason)).toEqual([REFERRAL_DEMOTED_REASONS.LATER_ROUND_SAME_HEAD]);
  });
  it.each([undefined, '', 42])('treats a caller that names no usable lens (%j) as a gate lens: nothing is silenced', (lens) => {
    expect(run({ lens }).kept).toHaveLength(1);
  });
  it('keeps the advisory finding as a referral while the head still has a referral round that never finished', () => {
    expect(run({ lens: 'simplicity', openHeads: [HEAD_1] }).kept).toHaveLength(1);
    expect(run({ lens: 'simplicity', openHeads: [HEAD_2] }).demoted).toHaveLength(1);
  });
  it('a finding already referred on the head is covered whatever the lens or round state', () => {
    for (const o of [{ lens: 'security' }, { lens: 'simplicity', openHeads: [HEAD_1] }]) {
      const out = classifyReferralsByRound([candidate({ ...raised, line: 40 })], { identity, head: HEAD_1, ...o });
      expect(out.covered).toHaveLength(1);
      expect(out.kept).toEqual([]);
    }
  });
});

describe('classifyReferralsByRound — "covered" means an ACTIVE referral holds the finding (PR #4441 self-review)', () => {
  const seat = 'judgeAntigravityReview';
  const finding = { file: 'scripts/lib/thing.mjs', line: 11, summary: 'The guard on an empty list is missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const record = (dropped) => {
    const base = recordFor(HEAD_1, finding);
    const key = referralFindingKey(seat, finding);
    return { ...base, attempted: false, referrals: [{ key, seat, original: finding, finding: normalizeFinding(finding) }],
      ...(dropped ? { dropped: [{ key, reason: 'dropped: seat disabled by operator config' }] } : {}) };
  };
  it('a re-raise of a finding whose only referral was retired as dropped is kept, never lost to "covered"', () => {
    const identity = findingIdentityTable([record(true)]);
    const out = classifyReferralsByRound([candidate(finding)], { identity, head: HEAD_1, lens: 'correctness' });
    expect(out.covered).toEqual([]);
    expect(out.kept).toHaveLength(1);
  });
  it('the same finding with a live referral is covered', () => {
    const out = classifyReferralsByRound([candidate(finding)], { identity: findingIdentityTable([record(false)]), head: HEAD_1, lens: 'correctness' });
    expect(out.covered).toHaveLength(1);
  });
});

describe('classifyReferralsByRound — an alias that fits two changed files is no evidence of a fix (PR #4441 self-review)', () => {
  const cited = { file: 'index.mjs', line: 900, summary: 'The guard on an empty list is missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const identity = identityOf(recordFor(HEAD_1, cited, ['block']));
  const run = (files) => classifyReferralsByRound([candidate(cited)], { identity, head: HEAD_2, latestFix: { priorHead: HEAD_1, head: HEAD_2, files } });
  it('keeps the referral when a basename citation matches two changed files', () => {
    expect(run({ 'a/index.mjs': [900], 'b/index.mjs': [5] }).kept).toHaveLength(1);
  });
  it('demotes when the alias names exactly one changed file and its lines are near', () => {
    expect(run({ 'a/index.mjs': [900], 'b/other.mjs': [5] }).demoted).toHaveLength(1);
  });
});

describe('openReferralHeads — heads whose referral round never finished (a partial persistence, a crash before the attempt)', () => {
  const at = (body) => ({ body, createdAt: '2026-10-08T12:00:00Z', author: { login: 'web-everything' } });
  it('names a head that carries a record nobody has attempted, and not one whose record was attempted', () => {
    expect(openReferralHeads([at(renderReferralRecord({ ...recordFor(HEAD_1, raised), attempted: false }))])).toEqual([HEAD_1]);
    expect(openReferralHeads([at(renderReferralRecord({ ...recordFor(HEAD_1, raised), attempted: true }))])).toEqual([]);
    // the persisted chunk is no less unfinished for being ruled: it is the chunk that never posted that is still owed
    expect(openReferralHeads([at(renderReferralRecord({ ...recordFor(HEAD_1, raised, ['block']), attempted: false }))])).toEqual([HEAD_1]);
    expect(openReferralHeads([])).toEqual([]);
    expect(openReferralHeads(undefined)).toEqual([]);
  });
  it('ignores prose that merely mentions the marker and records from an untrusted author', () => {
    const forged = { ...at(renderReferralRecord({ ...recordFor(HEAD_1, raised), attempted: false })), author: { login: 'someone-else' } };
    expect(openReferralHeads([forged, at('no record here')])).toEqual([]);
  });
});

describe('defaultFindResumableRun — never throws; an unreadable PR or store means a fresh review', () => {
  const target = { repo: 'o/n', pr: 4361 };
  it('answers null when the PR read throws, has no head, or the run store read throws', () => {
    expect(defaultFindResumableRun(target, { readPr: () => { throw new Error('gh down'); }, readRuns: () => [] })).toBeNull();
    expect(defaultFindResumableRun(target, { readPr: () => ({}), readRuns: () => [] })).toBeNull();
    expect(defaultFindResumableRun(target, { readPr: () => ({ headRefOid: HEAD_1, comments: [] }), readRuns: () => { throw new Error('disk'); } })).toBeNull();
  });
  it('answers null when there is no run for the PR', () => {
    expect(defaultFindResumableRun(target, { readPr: () => ({ headRefOid: HEAD_1, comments: [] }), readRuns: () => [] })).toBeNull();
  });
});

describe('defaultFindResumableRun — the wiring from the PR thread to the hold rule (the happy path)', () => {
  const target = { repo: 'o/n', pr: 4388 };
  const t0 = Date.parse('2026-10-08T12:00:00Z');
  const parked = { id: 'review-pr-parked', repo: 'o/n', pr: 4388, head: HEAD_1, startedAt: t0, completedAt: t0 + 1000,
    parked: true, attempted: true, persistenceFailed: false, pending: ['k'], rulings: [] };
  const ruling = (at) => ({ body: renderReferralRecord(recordFor(HEAD_1, raised, ['not-real'])), createdAt: new Date(at).toISOString(), author: { login: 'web-everything' } });
  const find = (view, runs = [parked]) => defaultFindResumableRun(target, { readPr: () => view, readRuns: () => runs });

  it('answers the parked run id when the only thing since it began is a ruling on its head', () => {
    expect(find({ headRefOid: HEAD_1, comments: [ruling(t0 + 60_000)] })).toBe('review-pr-parked');
  });
  it('coerces the PR number the way the gh read supplies it (a string) and still finds the run', () => {
    expect(defaultFindResumableRun({ repo: 'o/n', pr: '4388' }, { readPr: () => ({ headRefOid: HEAD_1, comments: [ruling(t0 + 60_000)] }), readRuns: () => [parked] })).toBe('review-pr-parked');
  });
  it('answers null when no ruling has arrived, the head moved, or a re-arm came after the ruling', () => {
    expect(find({ headRefOid: HEAD_1, comments: [] })).toBeNull();
    expect(find({ headRefOid: HEAD_2, comments: [ruling(t0 + 60_000)] })).toBeNull();
    const rearm = { body: '🔁 review — changes requested', createdAt: new Date(t0 + 90_000).toISOString(), author: { login: 'web-everything' } };
    expect(find({ headRefOid: HEAD_1, comments: [ruling(t0 + 60_000), rearm] })).toBeNull();
  });
});
