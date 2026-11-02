/** #6170: a ruling recorded under a repo's old owner must rule the finding a record names under the new one, and nothing else. */
import { describe, it, expect } from 'vitest';
import { readOperatorRulings, readReferralRecords, buildOperatorRulingComment, renderReferralRecord, mandatoryReferralState, mandatoryReferralReviewer,
  validateReferralRecord, referralFindingKey, normalizeFinding, findSameHeadSiblingRuling, judgeSameGapPairs, REFERRAL_CARRY_REASON } from '../jury-core.mjs';
import { canonicalRepoSlug } from '../repo-slug.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewPrSinks } from '../../operations/review-pr-io.mjs';
import { REVIEW_EFFECTS } from '../../operations/review-pr.mjs';

const HEAD = '21da276841fe341adf3431649b4f7d41830aad09';
const NEW_REPO = 'web-everything/web-everything', OLD_REPO = 'chalbert/web-everything';
const CARD = 'we:backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md@pr6170';
const original = { file: 'backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md', line: 34,
  summary: 'The unreadable-file guarantee has no named planned regression.', verdict: 'CONFIRMED', impactIfUnfixed: 'broken', category: 'correctness' };
const post = (body, login) => ({ body, author: { login } });
const world = ({ rulingRepo = OLD_REPO, rulingKey, runId = 'review-pr-ddbf3105-8ecb-4f6e-b25e-fb5173fa3a1c', head = HEAD, pr = 6170 } = {}) => {
  const referral = { key: referralFindingKey('judge', original), seat: 'judge', original, finding: normalizeFinding(original) };
  const rec = { version: 1, repo: NEW_REPO, pr: 6170, head: HEAD, runId, attempted: true,
    authorBody: '<!-- authored-by-actor: author -->', referrals: [referral], rulings: [] };
  rec.reviewer = mandatoryReferralReviewer(runId);
  expect(validateReferralRecord(rec)).toBe(true);
  const ruling = buildOperatorRulingComment({ version: 1, repo: rulingRepo, pr, head, actor: 'chalbert', channel: 'claude-code-session',
    reason: 'R342', at: '2026-11-01T19:39:00.583Z', clearerId: 'x',
    rulings: [{ runId, key: rulingKey ?? referral.key, result: 'card', card: CARD }] });
  return { referral, comments: [post(renderReferralRecord(rec), 'web-everything'), post(ruling, 'chalbert')] };
};
const state = (comments, repo) => mandatoryReferralState(comments, { head: HEAD, repo, pr: 6170, body: '<!-- authored-by-actor: author -->', cardReadable: () => true });

const siblings = (result = 'card') => {
  const { comments } = world({ runId: 'review-pr-A' });
  const source = readReferralRecords(comments).records[0];
  const makeRecord = (seat, runId) => ({ ...source, runId, reviewer: mandatoryReferralReviewer(runId),
    referrals: [{ ...source.referrals[0], seat, key: referralFindingKey(seat, original) }] });
  const target = makeRecord('redTeam', 'review-pr-B');
  const third = makeRecord('judgeCorrectness', 'review-pr-C');
  const ruling = (record, value, over = {}) => post(buildOperatorRulingComment({ version: 1, repo: OLD_REPO,
    pr: record.pr, head: record.head, actor: 'chalbert', channel: 'test', reason: 'checked',
    at: '2026-11-01T20:00:00Z', clearerId: 'x', ...over,
    rulings: [{ runId: record.runId, key: record.referrals[0].key, result: value,
      ...(value === 'card' ? { card: CARD } : {}) }] }), 'chalbert');
  const records = [source, target, third];
  const recordComments = records.map(r => post(renderReferralRecord(r), 'web-everything'));
  const clearance = ruling(source, result);
  const carry = { key: target.referrals[0].key, reason: REFERRAL_CARRY_REASON,
    from: { head: HEAD, runId: source.runId, key: source.referrals[0].key }, result,
    ...(result === 'card' ? { card: CARD } : {}) };
  const context = comments => ({ head: HEAD, repo: NEW_REPO, pr: source.pr, records,
    operatorRulings: readOperatorRulings(comments).rulings });
  return { source, target, third, ruling, recordComments, clearance, carry, context };
};

describe('canonicalRepoSlug', () => {
  it('follows the listed rename, lower-cases, and leaves every other slug as itself', () => {
    expect(canonicalRepoSlug(OLD_REPO)).toBe(NEW_REPO);
    expect(canonicalRepoSlug('Chalbert/Web-Everything')).toBe(NEW_REPO);
    expect(canonicalRepoSlug('someone/else')).toBe('someone/else');
    expect(canonicalRepoSlug(undefined)).toBeUndefined();
  });
});

describe('operator ruling repo spelling (#6170)', () => {
  it('the production sink retains the hold instead of persisting a carry over the later old-owner block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-slug-sibling-'));
    try {
      const w = siblings();
      const live = { headRefOid: HEAD, body: w.source.authorBody, labels: [],
        comments: [...w.recordComments, w.clearance, w.ruling(w.target, 'block')] };
      const provider = {
        readPrState: () => { live.comments.forEach((c, i) => { c.id ??= String(i); }); return structuredClone(live); },
        editComment: (id, body) => { live.comments.find(c => c.id === id).body = body; },
        postComment: (_repo, _pr, body) => live.comments.push(post(body, 'web-everything')),
        setLabels: () => {},
      };
      const sinks = createReviewPrSinks({ root, env: {}, labelProvider: provider, cardReadable: () => true,
        readChangedLines: () => { throw new Error('no cross-head comparison expected'); },
        referralJudge: () => { throw new Error('no new reviewer decision'); },
        sameGapJudge: () => { throw new Error('identical findings need no judge'); },
        mirrorReferral: () => {}, appendLedgerRow: () => ({ ok: true }), out: () => {} });
      const result = await sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS]({ referrals: [], read: {
        repo: NEW_REPO, pr: w.source.pr, netBasis: { rev: HEAD }, body: live.body } }, { runId: 'sink-run' });
      const saved = readReferralRecords(live.comments).records.find(r => r.runId === w.target.runId);
      expect.soft(saved.carried ?? []).toEqual([]);
      expect.soft(result.pending).toContain(w.target.referrals[0].key);
      expect.soft(state(live.comments, NEW_REPO).pending).toContain(w.target.referrals[0].key);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['card', 'not-real'])('a hidden block prevents a sibling %s carry and withdraws a persisted carry', result => {
    const w = siblings(result);
    for (const blocked of [w.target, w.third]) {
      for (const repo of [OLD_REPO, 'Chalbert/Web-Everything']) {
        const block = w.ruling(blocked, 'block', { repo });
        for (const rulings of [[w.clearance, block], [block, w.clearance]]) {
          const comments = [...w.recordComments, ...rulings];
          expect.soft(findSameHeadSiblingRuling(w.target.referrals[0], w.context(comments))).toBeNull();
          const saved = post(renderReferralRecord({ ...w.target, carried: [w.carry] }), 'web-everything');
          expect.soft(state([...comments, saved], NEW_REPO).pending).toContain(w.target.referrals[0].key);
        }
      }
    }
  });
  it('a hidden block on an unrelated readable finding does not veto the sibling carry', () => {
    const w = siblings();
    const unrelated = { ...original, summary: 'An unrelated defect in the writer.' };
    w.third.referrals = [{ seat: 'judgeCorrectness', original: unrelated, finding: normalizeFinding(unrelated),
      key: referralFindingKey('judgeCorrectness', unrelated) }];
    const records = [w.source, w.target, w.third].map(r => post(renderReferralRecord(r), 'web-everything'));
    const comments = [...records, w.clearance, w.ruling(w.third, 'block')];
    expect(findSameHeadSiblingRuling(w.target.referrals[0], w.context(comments))).toMatchObject({ result: 'card' });
  });
  it('an unreadable hidden block subject cannot expose an older sibling clearance', () => {
    const w = siblings();
    const missing = { ...w.third, runId: 'missing-run' };
    const comments = [...w.recordComments, w.clearance, w.ruling(missing, 'block')];
    expect(findSameHeadSiblingRuling(w.target.referrals[0], w.context(comments))).toBeNull();
  });
  it('a hidden block on a judged paraphrase also vetoes the sibling carry', async () => {
    const w = siblings();
    const paraphrase = { ...original, summary: 'No named regression proves the unreadable-file guarantee.' };
    w.third.referrals = [{ seat: 'judgeCorrectness', original: paraphrase, finding: normalizeFinding(paraphrase),
      key: referralFindingKey('judgeCorrectness', paraphrase) }];
    const comments = [...w.recordComments, w.clearance, w.ruling(w.third, 'block')];
    const context = w.context(comments);
    expect(findSameHeadSiblingRuling(w.target.referrals[0], context)).toMatchObject({ result: 'card' });
    const judged = await judgeSameGapPairs([w.third.referrals[0].finding, w.target.referrals[0].finding], {
      judge: async () => ({ pairs: [{ id: 0, sameGap: true, confidence: 0.95, reason: 'same missing regression' }] }),
    });
    expect(findSameHeadSiblingRuling(w.target.referrals[0], { ...context, sameGapDecisions: judged.decisions })).toBeNull();
  });
  it.each(['card', 'not-real'])('a current-owner policy block still allows a later adopted sibling %s clearance', result => {
    const w = siblings(result);
    const block = w.ruling(w.third, 'block', { repo: NEW_REPO, actor: 'auto-policy' });
    const comments = [...w.recordComments, block, w.clearance];
    expect(findSameHeadSiblingRuling(w.target.referrals[0], w.context(comments))).toMatchObject({ result });
    expect(findSameHeadSiblingRuling(w.target.referrals[0], w.context([...w.recordComments, w.clearance, block]))).toBeNull();
  });
  it.each([
    ['another repo', { repo: 'someone/else' }],
    ['another head', { head: 'a'.repeat(40) }],
    ['another PR', { pr: 6171 }],
  ])('a hidden block for %s cannot veto a sibling carry', (_name, over) => {
    const w = siblings();
    const comments = [...w.recordComments, w.clearance, w.ruling(w.target, 'block', over)];
    expect(findSameHeadSiblingRuling(w.target.referrals[0], w.context(comments))).toMatchObject({ result: 'card' });
  });
  it('a card ruling under the old owner clears the finding (live repo spelled as the record)', () => {
    const { comments } = world();
    for (const repo of [NEW_REPO]) {
      const s = state(comments, repo);
      expect(s.pending).toEqual([]);
      expect(s.operatorRulings).toHaveLength(1);
    }
  });
  it('a ruling under the new spelling keeps working', () => {
    expect(state(world({ rulingRepo: NEW_REPO }).comments, NEW_REPO).pending).toEqual([]);
  });
  it('a ruling on a different finding key still leaves this finding pending', () => {
    const { comments, referral } = world({ rulingKey: '["judge","backlog/other.md",1,"another finding"]' });
    expect(state(comments, NEW_REPO).pending).toContain(referral.key);
  });
  it('a ruling for another run, another PR or another repo never rules it', () => {
    const { referral } = world();
    expect(state(world({ runId: 'review-pr-other' }).comments.slice(1).concat(world().comments.slice(0, 1)), NEW_REPO).pending).toContain(referral.key);
    expect(state(world({ rulingRepo: 'someone/else' }).comments, NEW_REPO).pending).toContain(referral.key);
  });
  it('a ruling takes the spelling of the record it rules on; an unmatched ruling keeps its own', () => {
    const { comments } = world();
    expect(readReferralRecords(comments).records.map(r => r.repo)).toEqual([NEW_REPO]);
    expect(readOperatorRulings(comments).rulings.map(r => r.repo)).toEqual([NEW_REPO]);
    const other = world({ runId: 'review-pr-other' }).comments[1];
    expect(readOperatorRulings([comments[0], other]).rulings.map(r => r.repo)).toEqual([OLD_REPO]);
  });
  it('records spelled the old way with rulings spelled the old way still match, as before', () => {
    const { comments } = world({ rulingRepo: OLD_REPO });
    const rec = readReferralRecords(comments).records[0];
    const old = { ...rec, repo: OLD_REPO };
    const c = [post(renderReferralRecord(old), 'web-everything'), comments[1]];
    expect(mandatoryReferralState(c, { head: HEAD, repo: OLD_REPO, pr: 6170, body: rec.authorBody, cardReadable: () => true }).pending).toEqual([]);
  });
  it('an alias-equal record of the same run that does not name the ruled finding never takes the ruling', () => {
    const { comments } = world();
    const rec = readReferralRecords(comments).records[0];
    const o2 = { ...original, line: 99, summary: 'A different unrelated finding on the same run.' };
    const unrelated = { ...rec, referrals: [{ key: referralFindingKey('judge', o2), seat: 'judge', original: o2, finding: normalizeFinding(o2) }] };
    expect(readOperatorRulings([post(renderReferralRecord(unrelated), 'web-everything'), comments[1]]).rulings.map(r => r.repo)).toEqual([OLD_REPO]);
  });
  it('two records naming the finding under different spellings are ambiguous: the ruling keeps its own', () => {
    const { comments } = world();
    const rec = readReferralRecords(comments).records[0];
    const both = [comments[0], post(renderReferralRecord({ ...rec, repo: OLD_REPO }), 'web-everything'), comments[1]];
    expect(readOperatorRulings(both).rulings.map(r => r.repo)).toEqual([OLD_REPO]);
  });
  it('a block ruling never adopts the record spelling, so a mismatch can only ever hold, never hide, a block', () => {
    const { referral } = world();
    const run = 'review-pr-ddbf3105-8ecb-4f6e-b25e-fb5173fa3a1c';
    const block = buildOperatorRulingComment({ version: 1, repo: OLD_REPO, pr: 6170, head: HEAD, actor: 'chalbert', channel: 'c',
      reason: 'r', at: '2026-11-01T19:39:00.583Z', clearerId: 'x', rulings: [{ runId: run, key: referral.key, result: 'block' }] });
    const { comments } = world();
    expect(readOperatorRulings([comments[0], post(block, 'chalbert')]).rulings.map(r => r.repo)).toEqual([OLD_REPO]);
  });
  it('an old-owner card beside an old-owner block on the same finding stays unadopted, so the block is never bypassed', () => {
    const { referral, comments } = world();
    const run = 'review-pr-ddbf3105-8ecb-4f6e-b25e-fb5173fa3a1c';
    const block = buildOperatorRulingComment({ version: 1, repo: OLD_REPO, pr: 6170, head: HEAD, actor: 'chalbert', channel: 'c',
      reason: 'r', at: '2026-11-01T19:45:00.000Z', clearerId: 'x', rulings: [{ runId: run, key: referral.key, result: 'block' }] });
    const c = [...comments, post(block, 'chalbert')];
    expect(readOperatorRulings(c).rulings.map(r => r.repo)).toEqual([OLD_REPO, OLD_REPO]);
    expect(state(c, NEW_REPO).pending).toContain(referral.key);
  });
  it.each(['card', 'not-real'])('an old-owner %s overrides an earlier current-owner policy block', result => {
    const { referral, comments } = world();
    const rec = readReferralRecords(comments).records[0];
    const ruling = (repo, actor, value) => post(buildOperatorRulingComment({ version: 1, repo, pr: rec.pr, head: rec.head,
      actor, channel: 'c', reason: 'r', at: '2026-11-01T19:39:00.583Z', clearerId: 'x',
      rulings: [{ runId: rec.runId, key: referral.key, result: value, ...(value === 'card' ? { card: CARD } : {}) }] }), 'chalbert');
    const block = ruling(NEW_REPO, 'auto-policy', 'block');
    expect(state([comments[0], block], NEW_REPO).blocked).toContain(referral.key);
    for (const repo of [NEW_REPO, OLD_REPO]) {
      const override = ruling(repo, 'chalbert', result);
      expect(state([comments[0], block, override], NEW_REPO))
        .toMatchObject({ pending: [], blocked: [] });
      expect(state([comments[0], override, block], NEW_REPO).blocked).toContain(referral.key);
    }
  });
  it.each([OLD_REPO, 'Chalbert/Web-Everything'])('a hidden %s block still vetoes adoption beside a visible block', repo => {
    const { referral, comments } = world();
    const rec = readReferralRecords(comments).records[0];
    const block = repo => post(buildOperatorRulingComment({ version: 1, repo, pr: rec.pr, head: rec.head, actor: 'chalbert',
      channel: 'c', reason: 'r', at: '2026-11-01T19:39:00.583Z', clearerId: 'x',
      rulings: [{ runId: rec.runId, key: referral.key, result: 'block' }] }), 'chalbert');
    for (const blocks of [[block(repo), block(NEW_REPO)], [block(NEW_REPO), block(repo)]]) {
      const s = state([comments[0], ...blocks, comments[1]], NEW_REPO);
      expect(s.operatorRulings.at(-1).repo).toBe(OLD_REPO);
      expect(s.blocked).toContain(referral.key);
    }
  });
  it.each([
    ['another repo', { repo: 'someone/else' }],
    ['another head', { head: 'a'.repeat(40) }],
    ['another PR', { pr: 6171 }],
    ['another run', { runId: 'review-pr-other' }],
    ['another finding', { key: '["judge","other.mjs",1,"another finding"]' }],
  ])('a block for %s cannot prevent repo spelling adoption', (_name, overrides) => {
    const { referral, comments } = world();
    const rec = readReferralRecords(comments).records[0];
    const { repo = OLD_REPO, pr = rec.pr, head = rec.head, runId = rec.runId, key = referral.key } = overrides;
    const block = post(buildOperatorRulingComment({ version: 1, repo, pr, head, actor: 'chalbert', channel: 'c',
      reason: 'r', at: '2026-11-01T19:39:00.583Z', clearerId: 'x', rulings: [{ runId, key, result: 'block' }] }), 'chalbert');
    expect(state([comments[0], block, comments[1]], NEW_REPO)).toMatchObject({ pending: [], blocked: [] });
  });
});
