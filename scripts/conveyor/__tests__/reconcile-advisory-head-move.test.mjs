import { describe, expect, it } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';

import { buildReviewedShaMarker, buildClearedHumanMarker } from '../../lib/review-escalation.mjs';

const OLD = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const author = { login: 'web-everything' };
const advisory = (head = OLD, body = `Net basis: \`${'c'.repeat(40)}..${head}\` — 1 net changed file(s) vs current main`) => ({
  author, createdAt: '2026-11-20T10:00:00Z', body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** accept\n\nLooks fine.\n\n---\n\n${body}` });
const own = (oid, extra = {}) => ({ oid, messageHeadline: 'fix: the thing', messageBody: '', authors: [{ login: 'chalbert' }], ...extra });
const mainMerge = oid => own(oid, { messageHeadline: "Merge branch 'main' into lane/x" });
const pr = (extra = {}) => ({ number: 7230, state: 'OPEN', headRefName: 'lane/x', headRefOid: HEAD,
  labels: ['review:human'], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  commits: [own(OLD), mainMerge(HEAD)], comments: [advisory()], ...extra });
const run = (extra = {}) => planReconcile({
  prs: [{ ...pr(extra), labels: pr(extra).labels.map(name => ({ name })) }], agents: [],
  requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-11-20T12:00:00Z') });
const reviews = result => result.dispatch.filter(d => d.kind === 'review' && d.advisoryReview?.reason === 'head-moved-advisory');

describe('review:human advisory re-run on a moved head', () => {
  it('review:human head moved by main merge owes one advisory on the live head', () => {
    const rows = reviews(run());
    expect(rows).toHaveLength(1);
    expect(rows[0].advisoryReview).toMatchObject({ head: HEAD, reason: 'head-moved-advisory' });
  });
  it('a conveyor recovery commit also owes one advisory on the live head', () => {
    const rec = own(HEAD, { messageHeadline: 'ci: recover missing PR checks', messageBody: `Conveyor-Missing-Run-Recovery: ${OLD}` });
    expect(reviews(run({ commits: [own(OLD), rec] }))).toHaveLength(1);
  });
  it('the advisory already covers the head: no row', () => {
    expect(reviews(run({ comments: [advisory(HEAD)] }))).toHaveLength(0);
  });
  it('a human clearance on the exact head: no row', () => {
    const clearance = { author, createdAt: '2026-11-20T11:00:00Z',
      body: `✅ review — \`review:human\` cleared via the sanctioned path\n\nCleared by chalbert via \`review-set-label.mjs --to=clear-human\`\n\n${buildReviewedShaMarker(HEAD)}\n${buildClearedHumanMarker('chalbert')}` };
    expect(reviews(run({ comments: [advisory(), clearance] }))).toHaveLength(0);
  });
  it('a non-merge author commit takes the normal path, not the head-moved advisory', () => {
    expect(reviews(run({ commits: [own(OLD), own(HEAD)] }))).toHaveLength(0);
  });
  it('an unreadable advisory dispatches nothing', () => {
    const result = run({ comments: [{ author, createdAt: '2026-11-20T10:00:00Z', body: `${ADVISORY_NOTE_MARKER}\n\nno basis recorded` }] });
    expect(reviews(result)).toHaveLength(0);
  });
  it('no advisory at all: no head-moved row', () => {
    expect(reviews(run({ comments: [] }))).toHaveLength(0);
  });
});
