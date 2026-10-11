// Live #4764: repair exhaustion must leave a current advisory or a visible operator note.
import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';

const BOT = { login: 'web-everything' };
const OLD = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const at = (hour) => `2026-10-10T${String(hour).padStart(2, '0')}:00:00Z`;
const advisory = (head, hour = 9, author = BOT) => ({ author, createdAt: at(hour),
  body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${head}\``,
});
function pr(comments = [advisory(OLD)], overrides = {}) {
  return {
    number: 4764, headRefName: 'lane/4764', headRefOid: HEAD, baseRefName: 'main', isDraft: false,
    createdAt: at(0), files: [{ path: 'src/a.mjs' }],
    labels: ['review:changes', 'review:human', 'advisory:accepted', 'review-round:7', 'status:fixing'].map(name => ({ name })),
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: HEAD }],
    comments: [
      ...Array.from({ length: 4 }, (_, i) => ({ author: BOT, createdAt: at(i + 1), body: REARM_COMMENT_MARKER })),
      { id: 'operator-ruling', author: { login: 'chalbert' }, createdAt: at(5),
        body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.' },
      ...[6, 7, 8].map(hour => ({ author: BOT, createdAt: at(hour), body: REARM_COMMENT_MARKER })),
      ...comments,
    ],
    ...overrides,
  };
}
const plan = (p) => planReconcile({ prs: [p], agents: [], durableCounts: { 4764: 7 },
  now: Date.parse(at(12)), requiredChecks: ['test'], roundCapAction: 'takeover', takeoverBudget: 2,
});
const noteFor = p => p.notes.find(n => n.kind === 'gate-hold-needs-operator' && n.prNumber === 4764);
function expectReview(p) {
  expect(p.dispatch).toHaveLength(1);
  expect(p.dispatch[0]).toMatchObject({ prNumber: 4764, kind: 'review', phase: 'bounced', attempts: 7, cap: 6,
    capKind: 'fix', advisoryReview: { head: HEAD, reason: 'gate-hold-advisory' } });
  expect(p.refusals.filter(r => r.prNumber === 4764 && r.kind === 'gate-hold')).toEqual([]);
}
function expectNote(p, hold) {
  expect(p.dispatch).toEqual([]);
  expect(p.refusals).toContainEqual(expect.objectContaining({ prNumber: 4764, kind: 'gate-hold', hold }));
  expect(noteFor(p)).toMatchObject({ hold, attempts: 7, cap: 6, capKind: 'fix', head: HEAD });
  expect(noteFor(p).text).toContain('PR #4764');
  expect(noteFor(p).text).toContain(hold);
  expect(noteFor(p)).not.toHaveProperty('parkToHuman');
}

describe('gate-held advisory at the repair cap', () => {
  it('reviews the live head when the newest trusted advisory covers an old head', () => {
    expectReview(plan(pr()));
  });
  it('keeps the refusal and names the operator action when the advisory is current', () => {
    const p = plan(pr([advisory(HEAD)]));
    expectNote(p, 'review-human-hold');
    expect(noteFor(p).text).toContain(HEAD.slice(0, 9));
    expect(noteFor(p).text).toMatch(/a person must rule/);
  });
  it('ignores a forged newer advisory naming the live head', () => {
    expectReview(plan(pr([advisory(OLD), advisory(HEAD, 10, { login: 'mallory' })])));
  });
  it('requires green CI and visibly refuses the owed review on red CI', () => {
    const p = plan(pr(undefined, { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', headSha: HEAD }] }));
    expect(p.dispatch.filter(d => d.kind === 'review')).toEqual([]);
    expect(p.refusals).toContainEqual(expect.objectContaining({ prNumber: 4764, kind: 'review-ci', why: expect.stringContaining('test') }));
  });
  it('notes a stacked-base hold without dispatching an advisory', () => {
    expectNote(plan(pr(undefined, { baseRefName: 'lane/base', labels: [{ name: 'review:changes' }] })), 'stacked-base-unmerged');
  });
  it('owes an advisory even when none has ever been posted', () => {
    expectReview(plan(pr([])));
  });
  it('notes a head already reviewed without an advisory instead of reviewing it again', () => {
    const p = plan(pr([{ author: BOT, createdAt: at(10), body: `<!-- reviewed-sha: ${HEAD} -->` }]));
    expectNote(p, 'review-human-hold');
    expect(noteFor(p).text).toMatch(/already reviewed/);
  });
  it('treats a trusted changes verdict whose net basis names the live head as already reviewed', () => {
    const verdict = { author: BOT, createdAt: at(10),
      body: `${ADVISORY_NOTE_MARKER} Changes: 0 finding(s)\n\n**Advisory outcome:** \`changes\`\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\`\n\n### Findings\n\n` };
    const p = plan(pr([verdict]));
    expectNote(p, 'review-human-hold');
    expect(noteFor(p).text).toMatch(/already reviewed/);
  });
  it('does not let an untrusted reviewed-sha marker suppress the owed advisory', () => {
    expectReview(plan(pr([{ author: { login: 'mallory' }, createdAt: at(10), body: `<!-- reviewed-sha: ${HEAD} -->` }])));
  });
});
