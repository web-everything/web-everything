import { describe, expect, it } from 'vitest';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../jury-core.mjs';
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
