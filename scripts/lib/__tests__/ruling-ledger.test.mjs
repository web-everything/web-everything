import { describe, expect, it } from 'vitest';
import { REFERRAL_CARRY_REASON, buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../jury-core.mjs';
import {
  rulingNeeded, ignoredRulings, claimSimilarity, sameFinding, hasSentBack, renderRulingNotAddressed,
  fixerRulingBrief, RULING_NOT_ADDRESSED_MARKER,
} from '../ruling-ledger.mjs';

const repo = 'web-everything/web-everything';
const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40), H3 = 'c'.repeat(40);
const t = (n) => new Date(Date.parse('2026-10-03T08:00:00Z') + n * 60_000).toISOString();
const finding = (summary, file = 'policy/pointer.md') => ({ summary, file, line: 12, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' });
const SUMMARY = 'policy pointer files are missing from the standards manifest so the gate cannot see them';

function record({ head, runId, summary = SUMMARY, file, rulings = [] }) {
  const original = finding(summary, file);
  const key = referralFindingKey('judge', original);
  const reviewer = mandatoryReferralReviewer(runId);
  return { version: 1, repo, pr: 3794, head, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->',
    attempted: true, referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }],
    rulings: rulings.map((r, i) => ({ id: `r${i}`, key, reviewerId: reviewer.id, lens: reviewer.lens,
      result: r.result, rationale: r.rationale ?? 'no', evidence: ['e'], ...(r.card ? { card: r.card } : {}),
      ...(r.supersedes ? { supersedes: r.supersedes } : {}) })) };
}
const comment = (rec, n, login = 'web-everything') => ({ body: renderReferralRecord(rec), createdAt: t(n), author: { login } });
const block = { result: 'block', rationale: 'pointer files must be listed; do not ship without them' };

describe('rulingNeeded', () => {
  it('uses the live operator ruling for attempted findings', () => {
    const r = record({ head: H1, runId: 'run-operator' });
    const body = buildOperatorRulingComment({ version: 1, repo, pr: r.pr, head: H1,
      actor: 'chalbert', channel: 'test', reason: 'not a defect', at: t(6), clearerId: '',
      rulings: [{ runId: r.runId, key: r.referrals[0].key, result: 'not-real' }] });
    expect(rulingNeeded({ headRefOid: H1, comments: [comment(r, 5),
      { body, author: { login: 'chalbert' } }] })).toBeNull();
  });
  it('lists pending findings of the current head with file and summary, and when it began', () => {
    const need = rulingNeeded({ headRefOid: H1, comments: [comment(record({ head: H1, runId: 'run-1' }), 5)] });
    expect(need.head).toBe(H1);
    expect(need.findings).toHaveLength(1);
    expect(need.findings[0]).toMatchObject({ file: 'policy/pointer.md', summary: SUMMARY });
    expect(need.since).toBe(Date.parse(t(5)));
  });
  it('clears once every finding has a ruling (last snapshot wins)', () => {
    const comments = [comment(record({ head: H1, runId: 'run-1' }), 5),
      comment(record({ head: H1, runId: 'run-1', rulings: [block] }), 9)];
    expect(rulingNeeded({ headRefOid: H1, comments })).toBeNull();
  });
  it('a record on an earlier head asks nothing of a new head', () => {
    expect(rulingNeeded({ headRefOid: H2, comments: [comment(record({ head: H1, runId: 'run-1' }), 5)] })).toBeNull();
  });
  it('ignores an unattempted record and a record from an untrusted author', () => {
    const unattempted = { ...record({ head: H1, runId: 'run-1' }), attempted: false };
    expect(rulingNeeded({ headRefOid: H1, comments: [comment(unattempted, 1)] })).toBeNull();
    expect(rulingNeeded({ headRefOid: H1, comments: [comment(record({ head: H1, runId: 'run-1' }), 1, 'stranger')] })).toBeNull();
  });
  it('is null without a usable head', () => {
    expect(rulingNeeded({ headRefOid: '', comments: [comment(record({ head: H1, runId: 'r' }), 1)] })).toBeNull();
  });
});

describe('ignoredRulings', () => {
  const history = [
    comment(record({ head: H1, runId: 'run-1' }), 1),
    comment(record({ head: H1, runId: 'run-1', rulings: [block] }), 3),
  ];
  it('flags a block-ruled finding that came back on a new head, carrying the original ruling', () => {
    const comments = [...history, comment(record({ head: H2, runId: 'run-2' }), 20)];
    const ig = ignoredRulings({ headRefOid: H2, comments });
    expect(ig.misses).toBe(1);
    expect(ig.escalate).toBe(false);
    expect(ig.matches[0].ruling).toMatch(/pointer files must be listed/);
    expect(ig.matches[0].priorHead).toBe(H1);
  });
  it('matches a reworded claim on the same file, and a drifted line', () => {
    const reworded = 'the policy pointer files are still missing from the standards manifest, so the gate cannot see them';
    const comments = [...history, comment(record({ head: H2, runId: 'run-2', summary: reworded }), 20)];
    expect(ignoredRulings({ headRefOid: H2, comments })?.matches).toHaveLength(1);
  });
  it('does not match a different file or an unrelated claim', () => {
    const other = [...history, comment(record({ head: H2, runId: 'run-2', file: 'other/file.md' }), 20)];
    expect(ignoredRulings({ headRefOid: H2, comments: other })).toBeNull();
    const unrelated = [...history, comment(record({ head: H2, runId: 'run-2', summary: 'button colour contrast is too low in dark theme' }), 20)];
    expect(ignoredRulings({ headRefOid: H2, comments: unrelated })).toBeNull();
  });
  // plateau-app #202, 2026-10-04: a reviewer block on head 1 was overruled by the operator's not-real on head 2;
  // the finding coming back on head 3 is not an ignored ruling, and must not raise advisory:ruling-needed.
  it('is quiet when a later structured operator ruling overruled the earlier block', () => {
    const r2 = record({ head: H2, runId: 'run-2' });
    const overrule = buildOperatorRulingComment({ version: 1, repo, pr: r2.pr, head: H2, actor: 'chalbert',
      channel: 'test', reason: 'fixed', at: t(12), clearerId: '',
      rulings: [{ runId: r2.runId, key: r2.referrals[0].key, result: 'not-real' }] });
    const comments = [...history, comment(r2, 10), { body: overrule, author: { login: 'chalbert' }, createdAt: t(12) },
      comment(record({ head: H3, runId: 'run-3' }), 20)];
    expect(ignoredRulings({ headRefOid: H3, comments })).toBeNull();
  });
  describe('what an operator overrule does NOT overrule', () => {
    const opNotReal = (rec, n) => ({ author: { login: 'chalbert' }, createdAt: t(n),
      body: buildOperatorRulingComment({ version: 1, repo, pr: rec.pr, head: rec.head, actor: 'chalbert', channel: 'test',
        reason: 'not a defect', at: t(n), clearerId: '', rulings: [{ runId: rec.runId, key: rec.referrals[0].key, result: 'not-real' }] }) });
    it('a reviewer block recorded AFTER the operator overrule stands (ordering)', () => {
      const r1 = record({ head: H1, runId: 'run-1' });
      const r2 = record({ head: H2, runId: 'run-2' });
      const comments = [comment(r1, 1), comment(record({ head: H1, runId: 'run-1', rulings: [block] }), 3), opNotReal(r1, 4),
        comment(r2, 10), comment(record({ head: H2, runId: 'run-2', rulings: [block] }), 12),
        comment(record({ head: H3, runId: 'run-3' }), 20)];
      const ig = ignoredRulings({ headRefOid: H3, comments });
      expect(ig?.matches).toHaveLength(1);
      expect(ig.matches[0].priorHead).toBe(H2);
    });
    it('a short operator not-real on a different same-file finding leaves the longer block standing (match gate)', () => {
      const unrelated = record({ head: H1, runId: 'run-0', summary: 'standards manifest missing' });
      const comments = [...history, comment(unrelated, 2), opNotReal(unrelated, 4), comment(record({ head: H2, runId: 'run-2' }), 20)];
      expect(ignoredRulings({ headRefOid: H2, comments })?.matches).toHaveLength(1);
    });
    it('a reworded operator overrule of the SAME finding still overrules it', () => {
      const reworded = record({ head: H1, runId: 'run-0', summary: 'the policy pointer files are still missing from the standards manifest, so the gate cannot see them' });
      const comments = [...history, comment(reworded, 2), opNotReal(reworded, 4), comment(record({ head: H2, runId: 'run-2' }), 20)];
      expect(ignoredRulings({ headRefOid: H2, comments })).toBeNull();
    });
  });
  // {reviewer block on an earlier head} x {what settles the finding on THIS head}.
  describe('a finding the operator settled on this head is never an ignored ruling', () => {
    const opComment = (rec, head, result, n) => ({ author: { login: 'chalbert' }, createdAt: t(n),
      body: buildOperatorRulingComment({ version: 1, repo, pr: rec.pr, head, actor: 'chalbert', channel: 'test',
        reason: 'settled', at: t(n), clearerId: '', rulings: [{ runId: rec.runId, key: rec.referrals[0].key, result }] }) });
    const r1 = () => record({ head: H1, runId: 'run-1' });
    const carriedOn = (rec) => ({ ...rec, carried: [{ key: rec.referrals[0].key, reason: REFERRAL_CARRY_REASON,
      from: { head: H1, runId: 'run-1', key: rec.referrals[0].key }, result: 'not-real' }] });
    it('is flagged when nothing settled it (control)', () => {
      const r2 = record({ head: H2, runId: 'run-2' });
      expect(ignoredRulings({ headRefOid: H2, comments: [...history, comment(r2, 10)] })?.matches).toHaveLength(1);
    });
    it.each(['not-real', 'block'])('is quiet after the operator ruled %s on this head', (result) => {
      const r2 = record({ head: H2, runId: 'run-2' });
      expect(ignoredRulings({ headRefOid: H2, comments: [...history, comment(r2, 10), opComment(r2, H2, result, 11)] })).toBeNull();
    });
    it('is quiet for a finding carried forward from an operator ruling still in the thread', () => {
      const r2 = carriedOn(record({ head: H2, runId: 'run-2' }));
      // The operator's backing ruling sits BEFORE the reviewer block in the thread, so it does not overrule that
      // block: only the carried skip can settle the finding here.
      const [first, blockRecord] = history;
      expect(ignoredRulings({ headRefOid: H2, comments: [first, opComment(r1(), H1, 'not-real', 2), blockRecord, comment(r2, 10)] })).toBeNull();
    });
    it('is flagged when the carried finding\'s operator backing is gone', () => {
      const r2 = carriedOn(record({ head: H2, runId: 'run-2' }));
      expect(ignoredRulings({ headRefOid: H2, comments: [...history, comment(r2, 10)] })?.matches).toHaveLength(1);
    });
  });
  it('is quiet when the earlier ruling was not block (card / not-real)', () => {
    const rulingCard = [comment(record({ head: H1, runId: 'run-1' }), 1),
      comment(record({ head: H1, runId: 'run-1', rulings: [{ result: 'not-real' }] }), 3),
      comment(record({ head: H2, runId: 'run-2' }), 20)];
    expect(ignoredRulings({ headRefOid: H2, comments: rulingCard })).toBeNull();
  });
  it('does not resurrect a block superseded in a later snapshot', () => {
    const withdrawn = [comment(record({ head: H1, runId: 'run-1' }), 1),
      comment(record({ head: H1, runId: 'run-1', rulings: [block] }), 3),
      comment(record({ head: H1, runId: 'run-1', rulings: [block, { result: 'not-real', supersedes: 'r0' }] }), 5)];
    const comments = [...withdrawn, comment(record({ head: H2, runId: 'run-2' }), 20)];
    expect(ignoredRulings({ headRefOid: H2, comments })).toBeNull();
    // control: the same thread without the superseding snapshot still flags the miss
    expect(ignoredRulings({ headRefOid: H2, comments: [...history, comment(record({ head: H2, runId: 'run-2' }), 20)] })?.misses).toBe(1);
  });
  it('keeps the blocks of two runs on one head that reuse the same ruling id', () => {
    const other = 'the widget focus ring is dropped when the host page sets a custom outline colour';
    const comments = [...history,
      comment(record({ head: H1, runId: 'run-1b', summary: other, file: 'widget/focus.md' }), 2),
      comment(record({ head: H1, runId: 'run-1b', summary: other, file: 'widget/focus.md', rulings: [block] }), 4),
      comment(record({ head: H2, runId: 'run-2' }), 20),
      comment(record({ head: H2, runId: 'run-2b', summary: other, file: 'widget/focus.md' }), 21)];
    expect(ignoredRulings({ headRefOid: H2, comments }).matches.map((m) => m.finding.file).sort()).toEqual(['policy/pointer.md', 'widget/focus.md']);
  });
  it('a fresh re-ruling restarts the miss count: it is measured from the latest block, not the first', () => {
    const comments = [...history,
      comment(record({ head: H2, runId: 'run-2' }), 20),
      comment(record({ head: H2, runId: 'run-2', rulings: [block] }), 22),
      comment(record({ head: H3, runId: 'run-3' }), 40)];
    const ig = ignoredRulings({ headRefOid: H3, comments });
    expect(ig.misses).toBe(1);
    expect(ig.escalate).toBe(false);
  });
  it('is quiet once the new head already has its own ruling', () => {
    const comments = [...history, comment(record({ head: H2, runId: 'run-2' }), 20),
      comment(record({ head: H2, runId: 'run-2', rulings: [block] }), 22)];
    expect(ignoredRulings({ headRefOid: H2, comments })).toBeNull();
  });
  it('counts the second miss, and asks the operator at the ladder\'s own threshold (default 3: resend, stronger model, then a person)', () => {
    const comments = [...history, comment(record({ head: H2, runId: 'run-2' }), 20), comment(record({ head: H3, runId: 'run-3' }), 40)];
    const ig = ignoredRulings({ headRefOid: H3, comments });
    expect(ig.misses).toBe(2);
    expect(ig.escalate).toBe(false);
    expect(ignoredRulings({ headRefOid: H3, comments }, { humanAt: 2 }).escalate).toBe(true);
  });
  it('knows when the head was already sent back', () => {
    const comments = [...history, comment(record({ head: H2, runId: 'run-2' }), 20)];
    const ig = ignoredRulings({ headRefOid: H2, comments });
    expect(ig.sentBack).toBe(false);
    const notice = { body: renderRulingNotAddressed(ig), createdAt: t(21), author: { login: 'web-everything' } };
    expect(ignoredRulings({ headRefOid: H2, comments: [...comments, notice] }).sentBack).toBe(true);
    expect(hasSentBack([{ ...notice, author: { login: 'stranger' } }], H2)).toBe(false);
    expect(hasSentBack([notice], H3)).toBe(false);
  });
  it('renders the ruling into both the comment and the fixer brief', () => {
    const ig = ignoredRulings({ headRefOid: H2, comments: [...history, comment(record({ head: H2, runId: 'run-2' }), 20)] });
    const body = renderRulingNotAddressed(ig);
    expect(body.startsWith(RULING_NOT_ADDRESSED_MARKER)).toBe(true);
    expect(body).toMatch(/policy\/pointer\.md:12/);
    expect(fixerRulingBrief(ig)).toMatch(/Operator ruling, verbatim: block: pointer files must be listed/);
    expect(fixerRulingBrief(ig)).toMatch(/did not satisfy/);
  });
});

describe('similarity', () => {
  it('scores identical text 1 and disjoint text 0', () => {
    expect(claimSimilarity('abc def ghi', 'abc def ghi')).toBe(1);
    expect(claimSimilarity('abc def ghi', 'xyz uvw rst')).toBe(0);
  });
  it('needs a file on both sides', () => {
    expect(sameFinding({ file: null, summary: SUMMARY }, { file: 'a', summary: SUMMARY })).toBe(false);
    expect(sameFinding({ file: './a', summary: SUMMARY }, { file: 'a', summary: SUMMARY })).toBe(true);
  });
});
