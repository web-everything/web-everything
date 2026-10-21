import { describe, expect, it, vi } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { planCiHealSpawns } from '../tick-core.mjs';
import { enrichPrsWithTimeoutEvidence } from '../reconcile-pass.mjs';
import { runReconcilePromoteDraftDispatch } from '../../operations/promote-draft-pr-dispatch.mjs';
import { needsPersonRow } from '../../operations/operator-queue-needs-person.mjs';
import * as promotion from '../../operations/promote-draft-pr-dispatch.mjs';
import { itemsFromReport } from '../../operations/needs-you-feed.mjs';
import { normalizeDiffFingerprint } from '../../lib/review-escalation.mjs';
import { ciHealOwed } from '../ci-heal-rule.mjs';
import { buildCiHealComment } from '../ci-heal-mark.mjs';

const repo = 'web-everything/web-everything';
const head = '21f58993f4e7' + 'a'.repeat(28);
const oldHead = '5e84be1afebe' + 'b'.repeat(28);
const labels = (...names) => names.map(name => ({ name }));
const check = conclusion => ({ name: 'test', status: 'COMPLETED', conclusion,
  headSha: head, completedAt: '2026-10-18T18:00:00Z' });
const pr = (number, overrides = {}) => ({ number, state: 'OPEN', isDraft: false,
  headRefName: 'lane/cards-delivery-modes', headRefOid: head, mergeStateStatus: 'CLEAN',
  labels: [], comments: [], statusCheckRollup: [], ...overrides });
const plan = (p, overrides = {}) => planReconcile({ prs: [p], requiredChecks: ['test'],
  reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-10-18T20:00:00Z'), ...overrides });
const promote = (p, overrides = {}) => runReconcilePromoteDraftDispatch({ repo,
  checkStaleness: () => ({ fresh: true, behind: 0 }), reconcile: () => p,
  readPrLabels: () => { throw new Error('labels fixture required'); },
  provider: { ready: () => { throw new Error('must stay draft'); } }, ...overrides });

describe('PR sweep: named singleton owners', () => {
  it('#5649: a red label with no rollup failure cannot dispatch either healer', () => {
    const p = pr(5649, { labels: labels('status:ci-red') });
    expect(plan(p).dispatch.filter(d => d.kind === 'ci-heal')).toEqual([]);
    expect(planCiHealSpawns({ prs: [{ ...p, prNumber: p.number, num: 'cards', ci: 'none' }],
      launchedNums: ['cards'], retryCap: 3, availableLanes: [27] }).spawns).toEqual([]);
  });

  it.each(['green', 'pending'])('#5649: live %s checks override the old red label in both planners', state => {
    const p = pr(5649, { labels: labels('status:ci-red'), statusCheckRollup: [check(state === 'green' ? 'SUCCESS' : null)] });
    if (state === 'pending') p.statusCheckRollup[0].status = 'IN_PROGRESS';
    expect(plan(p).dispatch.filter(d => d.kind === 'ci-heal')).toEqual([]);
    expect(planCiHealSpawns({ prs: [{ ...p, prNumber: 5649, num: 'cards', ci: state === 'green' ? 'pass' : 'pending' }],
      launchedNums: ['cards'], retryCap: 3, availableLanes: [27] }).spawns).toEqual([]);
  });

  it('CI-heal is not owed with 3/3 attempts spent or without red CI', () => {
    const p = pr(5649, { labels: labels('status:ci-red', 'review:human'), statusCheckRollup: [check('FAILURE')] });
    const capped = planCiHealSpawns({ prs: [{ ...p, prNumber: 5649, num: 'cards', ci: 'fail' }],
      launchedNums: ['cards'], ciHealAttempts: { 5649: 3 }, retryCap: 3, availableLanes: [27] });
    expect(capped.spawns).toEqual([]);
    expect(capped.notes).toEqual([expect.objectContaining({ kind: 'ci-heal-exhausted', attempts: 3 })]);
    const exhausted = plan({ ...p, comments: Array.from({ length: 3 }, () => ({
      author: { login: 'web-everything' }, body: buildCiHealComment({ headSha: head, reason: 'red-ci' }),
    })) });
    expect(exhausted.dispatch).toEqual([]);
    expect(exhausted.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 3, cap: 3 }));
    expect(plan(pr(5649)).dispatch).toEqual([]);
    expect(ciHealOwed({ labels: p.labels, ci: 'unchecked', attempts: 0, cap: 3 })).toBe(false);
    expect(ciHealOwed({ labels: p.labels, ci: 'unchecked', attempts: 3, cap: 3 })).toBe(false);
    expect(ciHealOwed({ labels: [], ci: 'unchecked', attempts: 0, cap: 3 })).toBe(false);
  });

  it('#5675: missing-check-origin falls through to CI-heal, with an explicit owner on the refusal', () => {
    const [p] = enrichPrsWithTimeoutEvidence([pr(5675, { mergeStateStatus: 'UNSTABLE',
      labels: labels('review:pending'), statusCheckRollup: [check('FAILURE')] })],
    { repo, enabled: true, readBudget: () => ({ confirmed: 0 }), read: () => { throw new Error('no run origin'); } });
    expect(p.timeoutRetry).toEqual({ eligible: false, reason: 'missing-check-origin' });
    const result = plan(p);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: 5675 })]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'timeout-retry-ineligible', owner: 'ci-heal' }));
  });

  it('#5647: withdrawn draft appears in NEEDS YOU with the exact release command; never auto-promotes', () => {
    const p = pr(5647, { isDraft: true, labels: labels('review:pending', 'review-status:draft-withdrawn'),
      statusCheckRollup: [check('SUCCESS')] });
    const row = needsPersonRow(repo, p);
    expect(row).toMatchObject({ number: 5647, kind: 'draft-withdrawn', commands: {
      releaseDraft: `gh pr edit 5647 --repo=${repo} --remove-label review-status:draft-withdrawn`,
    } });
    const ready = vi.fn();
    expect(promote(plan(p), { provider: { ready } }).dispatched).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
  });

  it('#5647: the open-only listing omits state; the attention feed retains the release command', () => {
    const { state, ...listed } = pr(5647, { isDraft: true, labels: labels('review-status:draft-withdrawn') });
    const row = needsPersonRow(repo, listed);
    expect(row).not.toBeNull();
    expect(itemsFromReport({ needsPerson: [row] })[0]).toMatchObject({
      command: `gh pr edit 5647 --repo=${repo} --remove-label review-status:draft-withdrawn`,
    });
    expect(needsPersonRow(repo, { ...listed, state: 'CLOSED' })).toBeNull();
  });

  it('#5664: green ready-to-merge agent PR without review labels is handed to independent review', () => {
    const p = pr(5664, { labels: labels('ready-to-merge'), statusCheckRollup: [check('SUCCESS')],
      commits: [{ messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }] });
    const result = plan(p);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'restore-review-label', variant: 'stuck' })]);
    const addLabel = vi.fn(), removeLabel = vi.fn();
    promote(result, { readPrLabels: () => p.labels, addLabel, removeLabel });
    expect(addLabel).toHaveBeenCalledWith(expect.objectContaining({ label: 'review:pending' }));
    expect(removeLabel).toHaveBeenCalledWith(expect.objectContaining({ label: 'ready-to-merge' }));
    expect(plan({ ...p, labels: labels('review:pending') }).dispatch).toEqual([
      expect.objectContaining({ kind: 'review', prNumber: 5664 }),
    ]);
  });

  it('#5628: moved head invalidates an old accept through guarded re-arm, then owes re-review', () => {
    const p = pr(5628, { labels: labels('ready-to-merge', 'review:accepted'), statusCheckRollup: [check('SUCCESS')],
      comments: [{ author: { login: 'web-everything' }, createdAt: '2026-10-18T18:00:00Z',
        body: `✅ review — accepted\n\n<!-- reviewed-sha: ${oldHead} -->` }] });
    const result = plan(p);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'restore-review-label', variant: 'stale-accept', headRefOid: head })]);
    const rearmReview = vi.fn(() => ({ ok: true }));
    promote(result, { rearmReview });
    expect(rearmReview).toHaveBeenCalledWith({ repoSlug: repo, prNumber: 5628, headSha: head });
    expect(plan({ ...p, labels: labels('review:pending') }).dispatch).toEqual([
      expect.objectContaining({ kind: 'review', prNumber: 5628 }),
    ]);
  });

  it('#5771: a PROVED-covered stale accept (pr@head key) skips the stale-accept row and gets its normal rows, attempts/cap included; any other head re-holds', () => {
    const p = pr(5771, { labels: labels('ready-to-merge', 'review:accepted'), statusCheckRollup: [check('SUCCESS')],
      comments: [{ author: { login: 'web-everything' }, createdAt: '2026-10-18T18:00:00Z',
        body: `✅ review — accepted\n\n<!-- reviewed-sha: ${oldHead} -->` }] });
    expect(plan(p).dispatch).toEqual([expect.objectContaining({ variant: 'stale-accept' })]);
    const released = plan(p, { staleAcceptReleased: [`5771@${head.toLowerCase()}`] });
    expect(released.dispatch.some(d => d.variant === 'stale-accept')).toBe(false);
    const row = [...released.refusals, ...released.dispatch].find(d => d.prNumber === 5771);
    expect(row, JSON.stringify(released)).toBeDefined();
    expect(Number.isInteger(row.attempts) && Number.isInteger(row.cap) && row.cap > 0).toBe(true);
    // Bound to the proved head: a key for another head (or another PR) changes nothing.
    for (const key of [`5771@${oldHead}`, `5772@${head}`, '5771']) {
      expect(plan(p, { staleAcceptReleased: [key] }).dispatch).toEqual([expect.objectContaining({ variant: 'stale-accept' })]);
    }
  });

  it.each(['same-head', 'human'])('#5628: preserves %s acceptances', mode => {
    const p = pr(5628, { labels: labels('review:accepted'), statusCheckRollup: [check('SUCCESS')],
      comments: [{ author: { login: 'web-everything' },
        body: `✅ review — accepted\n\n<!-- reviewed-sha: ${mode === 'same-head' ? head : oldHead} -->`
          + (mode === 'human' ? '\n<!-- cleared-human: operator -->' : '')
          + (mode === 'fingerprint-unreadable' ? `\n<!-- reviewed-diff: ${'c'.repeat(64)} -->` : '') }] });
    expect(plan(p).dispatch).toEqual([]);
  });

  it.each(['changed', 'unchanged', 'unreadable'])('#5628: fingerprinted acceptance is checked at the writer (%s diff)', mode => {
    const before = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+reviewed\n';
    const after = before.replace('+reviewed', '+unreviewed');
    const p = pr(5628, { labels: labels('review:accepted'), statusCheckRollup: [check('SUCCESS')],
      comments: [{ author: { login: 'web-everything' }, body: `✅ review — accepted\n\n<!-- reviewed-sha: ${oldHead} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(before)} -->` }] });
    expect(plan(p).dispatch).toEqual([expect.objectContaining({ variant: 'stale-accept' })]);
    const rearm = vi.fn(() => ({ ok: true }));
    const result = promotion.defaultRearmStaleAcceptance({ repoSlug: repo, prNumber: 5628, headSha: head,
      readPr: () => p, rearm, readReviews: () => [], readNetDiff: () => mode === 'unreadable' ? { scored: false }
        : { scored: true, rev: head, text: mode === 'unchanged' ? before : after } });
    expect(result.ok).toBe(mode === 'changed');
    expect(rearm).toHaveBeenCalledTimes(mode === 'changed' ? 1 : 0);
  });

  it('#5628: the write half refuses a new head or a new acceptance and reports a failed re-arm', () => {
    const stale = pr(5628, { labels: labels('review:accepted'), comments: [{ author: { login: 'web-everything' },
      body: `✅ review — accepted\n\n<!-- reviewed-sha: ${oldHead} -->` }] });
    const rearm = vi.fn(() => ({ ok: true }));
    const args = { repoSlug: repo, prNumber: 5628, headSha: head, rearm };
    expect(promotion.defaultRearmStaleAcceptance({ ...args, readPr: () => ({ ...stale, headRefOid: oldHead }) }).ok).toBe(false);
    expect(promotion.defaultRearmStaleAcceptance({ ...args, readPr: () => ({ ...stale, comments: [{ author: { login: 'web-everything' },
      body: `✅ review — accepted\n\n<!-- reviewed-sha: ${head} -->` }] }) }).ok).toBe(false);
    expect(rearm).not.toHaveBeenCalled();
    expect(promotion.defaultRearmStaleAcceptance({ ...args, readPr: () => stale })).toEqual({ ok: true });
    expect(rearm).toHaveBeenCalledWith(expect.objectContaining({ pr: 5628, repo, onlyIfAccepted: true }));
    const result = promote({ dispatch: [{ kind: 'restore-review-label', variant: 'stale-accept', prNumber: 5628, headRefOid: head }] },
      { rearmReview: () => ({ ok: false, reason: 'new verdict arrived' }) });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'stale-accept-rearm-refused' }));
  });
});
