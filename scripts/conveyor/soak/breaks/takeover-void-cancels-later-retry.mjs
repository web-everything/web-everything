/**
 * @file breaks/takeover-void-cancels-later-retry.mjs — red-team finding on PR 4759 (card xx0055i). A void marker gives
 * back the takeover launch it FOLLOWED, but `takeoverMarkers` cancelled the latest start for the head anywhere on the
 * thread. Thread: start(07:00) → void(08:00) → changes verdict(09:00) → successful retry start(10:00) → the retry
 * pushes head B. The 10:00 start was removed and the failed 07:00 start kept, so `takeoverReviewGrant` anchored at
 * 07:00, counted the 09:00 verdict as spent, and refused B's review as `takeover-review-spent` (the PR parked to the
 * operator at 5/5 with green CI).
 *
 * FIX — `takeoverMarkers` walks the thread in order; a void cancels only an EARLIER start.
 *
 * SCENARIO: that thread through the tree's own production `takeoverReviewGrant`. RED = the grant is refused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const TAKEOVER = 'scripts/conveyor/fix-takeover.mjs';
const REVIEW = 'scripts/conveyor/takeover-review.mjs';
const BOT = { login: 'web-everything' };
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

export async function replay(root = REPO_ROOT) {
  if (!existsSync(join(root, REVIEW))) return { harness: false };
  const load = (rel) => import(pathToFileURL(join(root, rel)).href);
  const { takeoverMarkerBody, takeoverVoidMarkerBody } = await load(TAKEOVER);
  const { takeoverReviewGrant } = await load(REVIEW);
  const at = (t, body) => ({ author: BOT, createdAt: `2026-10-10T${t}:00Z`, body });
  const comments = [
    at('07:00', takeoverMarkerBody({ pr: 7, head: HEAD_A, attempts: 5, cap: 5 })),
    at('08:00', takeoverVoidMarkerBody({ pr: 7, head: HEAD_A })),
    at('09:00', `🔁 review — changes requested\n\nreviewed ${HEAD_A}`),
    at('10:00', takeoverMarkerBody({ pr: 7, head: HEAD_A, attempts: 5, cap: 5 })),
  ];
  const grant = takeoverReviewGrant({ pr: { headRefOid: HEAD_B, comments }, takeoverReviewAttempts: 1 });
  return { harness: true, grant };
}

export default {
  id: 'takeover-void-cancels-later-retry',
  title: 'a takeover void cancelled the later successful retry instead of the failed launch, so the retry head was refused its review',
  card: 'PR 4759 red-team finding (card xx0055i)',
  fixedBy: { sha: '0bbb7ee9e', where: 'lane/takeover-review-attempt', paths: [TAKEOVER] },
  fixPresent(root) { return readFileSync(join(root, TAKEOVER), 'utf8').includes('findLastIndex'); },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'takeover-review', detail: 'no takeover-review module' });
      else if (!report.grant.ok || report.grant.anchor !== '2026-10-10T10:00:00.000Z') {
        violations.push({ invariant: 'retry-head-reviewed', detail: `grant ${JSON.stringify(report.grant)}` });
      }
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
