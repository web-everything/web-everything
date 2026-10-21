/**
 * PR #5520 review regression on the #5505 numbering-carry shape: a parked or pending
 * live-head review without a referral record must not be replaced by prior-head evidence.
 * Exercise persisted operation runs through the daemon's real evidence reader, guard,
 * and re-stamp writer, including a run persisted between the two acceptance writes.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/lib/numbering-carry.mjs', 'scripts/review-set-label.mjs', 'scripts/conveyor/review-referral-hold.mjs'];

export default {
  id: 'numbering-carry-unfinished-live-review',
  title: 'numbering carry must refuse an unfinished live-head review without a referral record',
  card: '6271; PR #5520 review of the #5505 numbering re-stamp',
  fixedBy: { sha: 'HEAD', where: 'lane/numbering-restamp-referral', paths: PATHS },
  fixPresent(root) {
    return readFileSync(join(root, PATHS[0]), 'utf8').includes("e?.code !== 'MANDATORY_REFERRAL_NO_REVIEW_RUN'")
      && readFileSync(join(root, PATHS[1]), 'utf8').includes('readRunHeads().some(mine)')
      && readFileSync(join(root, PATHS[1]), 'utf8').includes('!last.custom');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const carry = await load(PATHS[0]);
    const { assertMandatoryReferralsCleared } = await load(PATHS[1]);
    // `readReviewRunHeads` is absent before the PR #5520 red-team fix; the guard then falls back to its default.
    const { readReviewRunEvidence, readReviewRunHeads } = await load(PATHS[2]);
    const { newRunRecord } = await load('scripts/operations/run-record.mjs');
    const { writeRun } = await load('scripts/operations/run-store.mjs');
    const jury = await load('scripts/lib/jury-core.mjs');
    const root = mkdtempSync(join(tmpdir(), 'soak-numbering-live-review-'));
    const violations = [];
    const repo = 'example/project', pr = 5505;
    const from = '7ae496bef00d2096959b5f6d20cfd0394b976898';
    const to = '440cd1c4c18c773d1669189862322e9d0153b7b7';
    const body = '<!-- authored-by-actor: author -->';
    const original = { summary: 'Older held finding', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const seat = 'judgeCorrectnessAdvisory', runId = 'review-pr-older';
    // Run ids shaped as `newRunId('review-pr')` mints them (+ a final digit).
    const MINTED = 'review-pr-7d7c3c1e-0b1f-4c39-9a51-00000000000';
    const older = jury.renderReferralRecord({ version: 1, repo, pr, head: 'a'.repeat(40), runId,
      authorBody: body, reviewer: jury.mandatoryReferralReviewer(runId), attempted: true, rulings: [],
      referrals: [{ seat, original, finding: jury.normalizeFinding(original), key: jury.referralFindingKey(seat, original) }] });
    const setting = { value: true, source: 'soak' };
    try {
      // `unfinished` (PR #5520 red team): the live run failed to persist its referrals and never finished `advise`,
      // so the run-evidence projection drops it; it still reviewed the live head.
      // `custom-id` (PR #5520 operator send-back): a live run that completed clean under a chosen `--run-id`. Only the
      // id `newRunId` mints counts as a clean review, so it must hold exactly like a run that never finished.
      for (const [status, arriveAt] of [['none', 0], ['parked', 0], ['pending', 0], ['parked', 1], ['pending', 2],
        ['unfinished', 0], ['unfinished', 1], ['unfinished', 2], ['custom-id', 0], ['custom-id', 1], ['custom-id', 2]]) {
        carry._resetNumberingRestampMemo();
        const dir = join(root, `${status}-${arriveAt}`);
        mkdirSync(dir);
        const persistRun = (head, live = false) => {
          const id = !live ? `${MINTED}1` : status === 'custom-id' ? 'review-pr-live' : `${MINTED}2`;
          const unfinished = live && status === 'unfinished';
          const clean = live && status === 'custom-id';
          writeRun({ ...newRunRecord({ id, op: 'review-pr' }),
            findings: { read: { repo, pr, netBasis: { rev: head } } },
            verdict: { verdict: live && !clean && status !== 'pending' ? 'needs-human' : 'accept',
              pendingReferrals: unfinished ? ['referral-persistence-failed'] : live && !clean ? ['finding'] : [] },
            stepTimings: [
              { step: 'read', stepIndex: 0, startedAt: '2026-10-17T12:00:00Z' },
              { step: 'advise', stepIndex: 1, startedAt: '2026-10-17T12:00:00Z',
                ...(unfinished ? {} : { finishedAt: '2026-10-17T12:01:00Z', durationMs: 60000 }) },
            ] }, dir);
        };
        persistRun(from);
        if (status !== 'none' && !arriveAt) persistRun(to, true);
        const state = { state: 'OPEN', body, labels: ['review:pending'], headRefOid: to, comments: [
          { author: { login: 'web-everything' }, body: older },
          { id: 'accepted', author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${from} -->` },
        ] };
        const writes = [];
        let reads = 0;
        const result = carry.restampAfterNumbering({ repo, pr, state, reviews: [], enabled: true, acceptCarry: 'on',
          numberingSetting: setting, referralEvidenceSetting: setting, netPatchSetting: { value: false, source: 'soak' },
          prove: () => ({ ok: true, reason: 'numbering-only move already proven' }),
          guardReferrals: (s, context) => assertMandatoryReferralsCleared(s, { ...context, env: {}, cardReadable: () => true,
            readRuns: () => readReviewRunEvidence({ dir }),
            ...(readReviewRunHeads ? { readRunHeads: () => readReviewRunHeads({ dir }) } : {}),
            readNetDiff: sha => ({ scored: true, text: `diff at ${sha}` }) }),
          readLiveState: () => {
            if (++reads === arriveAt) persistRun(to, true);
            return { state, reviews: [] };
          },
          provider: {
            postComment: (_r, _p, text) => { writes.push('comment'); state.comments.push({ id: 'new', author: { login: 'chalbert' }, body: text }); },
            setLabels: () => writes.push('labels'), editComment: () => writes.push('withdraw'),
          } });
        const expected = status === 'none' ? ['comment', 'labels'] : arriveAt === 2 ? ['comment', 'withdraw'] : [];
        const expectedAction = status === 'none' ? 'restamped' : 'retry';
        log?.(`${status}/${arriveAt}: ${result?.action}; writes=${JSON.stringify(writes)}`);
        if (result?.action !== expectedAction || JSON.stringify(writes) !== JSON.stringify(expected)) {
          violations.push({ invariant: 'unfinished-review-never-overridden',
            detail: `${status}/${arriveAt}: expected ${expectedAction} with ${JSON.stringify(expected)}, got ${result?.action} with ${JSON.stringify(writes)}` });
        }
      }
      return { violations };
    } finally {
      carry._resetNumberingRestampMemo();
      rmSync(root, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
