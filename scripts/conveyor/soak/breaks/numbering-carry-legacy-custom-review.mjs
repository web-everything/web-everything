/**
 * PR #5520 red team (review-referral-hold.mjs:127): a `review-pr` run written under a custom name BEFORE the
 * review-run namespace existed (`custom-live.json`) was skipped by both run readers, which find review runs by the
 * `review-pr-` name. Its unfinished live-head review then read as "no review run", and the numbering carry wrote an
 * acceptance over it. Exercise the daemon's real readers, guard and re-stamp writer on such a record, read from the
 * store on its own and after a migration brings one in past an earlier scan.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/review-referral-hold.mjs', 'scripts/operations/run-store.mjs'];

export default {
  id: 'numbering-carry-legacy-custom-review',
  title: 'numbering carry must refuse an unfinished live-head review stored under a pre-namespace custom name',
  card: 'PR #5520 red team of the #5505 numbering re-stamp',
  fixedBy: { sha: 'HEAD', where: 'lane/numbering-restamp-referral', paths: PATHS },
  fixPresent(root) {
    return readFileSync(join(root, PATHS[0]), 'utf8').includes('legacyReviewRunNames(dir, names')
      && readFileSync(join(root, PATHS[1]), 'utf8').includes('export function legacyReviewRunNames');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const carry = await load('scripts/lib/numbering-carry.mjs');
    const { assertMandatoryReferralsCleared } = await load('scripts/review-set-label.mjs');
    const { readReviewRunEvidence, readReviewRunHeads } = await load(PATHS[0]);
    const { newRunRecord, serializeRunRecord } = await load('scripts/operations/run-record.mjs');
    const { migrateLegacyRuns, writeRun } = await load(PATHS[1]);
    const jury = await load('scripts/lib/jury-core.mjs');
    const root = mkdtempSync(join(tmpdir(), 'soak-numbering-legacy-review-'));
    const violations = [];
    const repo = 'example/project', pr = 5505;
    const from = '7ae496bef00d2096959b5f6d20cfd0394b976898';
    const to = '440cd1c4c18c773d1669189862322e9d0153b7b7';
    const body = '<!-- authored-by-actor: author -->';
    const original = { summary: 'Older held finding', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const seat = 'judgeCorrectnessAdvisory', runId = 'review-pr-older';
    const older = jury.renderReferralRecord({ version: 1, repo, pr, head: 'a'.repeat(40), runId,
      authorBody: body, reviewer: jury.mandatoryReferralReviewer(runId), attempted: true, rulings: [],
      referrals: [{ seat, original, finding: jury.normalizeFinding(original), key: jury.referralFindingKey(seat, original) }] });
    const setting = { value: true, source: 'soak' };
    const review = (id, head, unfinished) => ({ ...newRunRecord({ id, op: 'review-pr' }),
      findings: { read: { repo, pr, netBasis: { rev: head } } },
      verdict: { verdict: unfinished ? 'needs-human' : 'accept', pendingReferrals: unfinished ? ['referral-persistence-failed'] : [] },
      stepTimings: [
        { step: 'read', stepIndex: 0, startedAt: '2026-10-17T12:00:00Z' },
        { step: 'advise', stepIndex: 1, startedAt: '2026-10-17T12:00:00Z',
          ...(unfinished ? {} : { finishedAt: '2026-10-17T12:01:00Z', durationMs: 60000 }) },
      ] });
    try {
      // `on-disk`: the legacy record sits in the store. `migrated`: a reader scanned the store first, then a clone's old
      // run folder is migrated in carrying the legacy record.
      for (const shape of ['on-disk', 'migrated']) {
        carry._resetNumberingRestampMemo();
        const dir = join(root, shape);
        const clone = join(root, `${shape}-clone`);
        mkdirSync(dir);
        mkdirSync(clone);
        writeRun(review('review-pr-7d7c3c1e-0b1f-4c39-9a51-000000000001', from, false), dir);
        // Written as the store wrote it before `writeRun` refused a review run outside `review-pr-`.
        const legacy = text => writeFileSync(join(shape === 'on-disk' ? dir : clone, 'custom-live.json'), text);
        legacy(serializeRunRecord(review('custom-live', to, true)));
        if (shape === 'migrated') {
          readReviewRunHeads({ dir });
          readReviewRunEvidence({ dir });
          migrateLegacyRuns(clone, dir);
        }
        const state = { state: 'OPEN', body, labels: ['review:pending'], headRefOid: to, comments: [
          { author: { login: 'web-everything' }, body: older },
          { id: 'accepted', author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${from} -->` },
        ] };
        const writes = [];
        const result = carry.restampAfterNumbering({ repo, pr, state, reviews: [], enabled: true, acceptCarry: 'on',
          numberingSetting: setting, referralEvidenceSetting: setting, netPatchSetting: { value: false, source: 'soak' },
          prove: () => ({ ok: true, reason: 'numbering-only move already proven' }),
          guardReferrals: (s, context) => assertMandatoryReferralsCleared(s, { ...context, env: {}, cardReadable: () => true,
            readRuns: () => readReviewRunEvidence({ dir }), readRunHeads: () => readReviewRunHeads({ dir }),
            readNetDiff: sha => ({ scored: true, text: `diff at ${sha}` }) }),
          readLiveState: () => ({ state, reviews: [] }),
          provider: {
            postComment: (_r, _p, text) => { writes.push('comment'); state.comments.push({ id: 'new', author: { login: 'chalbert' }, body: text }); },
            setLabels: () => writes.push('labels'), editComment: () => writes.push('withdraw'),
          } });
        log?.(`${shape}: ${result?.action}; writes=${JSON.stringify(writes)}`);
        if (result?.action !== 'retry' || writes.length) {
          violations.push({ invariant: 'legacy-review-never-overridden',
            detail: `${shape}: expected retry with no writes, got ${result?.action} with ${JSON.stringify(writes)}` });
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
