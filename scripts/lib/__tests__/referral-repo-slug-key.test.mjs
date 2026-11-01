/** #6170: a ruling recorded under a repo's old owner must rule the finding a record names under the new one, and nothing else. */
import { describe, it, expect } from 'vitest';
import { readOperatorRulings, readReferralRecords, buildOperatorRulingComment, renderReferralRecord, mandatoryReferralState, mandatoryReferralReviewer,
  validateReferralRecord, referralFindingKey, normalizeFinding } from '../jury-core.mjs';
import { canonicalRepoSlug } from '../repo-slug.mjs';

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

describe('canonicalRepoSlug', () => {
  it('follows the listed rename, lower-cases, and leaves every other slug as itself', () => {
    expect(canonicalRepoSlug(OLD_REPO)).toBe(NEW_REPO);
    expect(canonicalRepoSlug('Chalbert/Web-Everything')).toBe(NEW_REPO);
    expect(canonicalRepoSlug('someone/else')).toBe('someone/else');
    expect(canonicalRepoSlug(undefined)).toBeUndefined();
  });
});

describe('operator ruling repo spelling (#6170)', () => {
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
});
