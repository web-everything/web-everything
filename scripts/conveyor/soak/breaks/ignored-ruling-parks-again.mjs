/**
 * @file breaks/ignored-ruling-parks-again.mjs — live break 2026-10-03/04, PR #3794, card xcs4nce (policy pointer
 * files). The operator had ruled that finding `block` on 2026-10-03. The fixer pushed a new head that did not
 * address it; the re-review reported the SAME confirmed finding, and the review parked again to wait for the same
 * human to repeat the same ruling. Nothing noticed the ruling was ignored (#3833 and #3771 showed the same shape).
 *
 * FIX: the reconcile pass reads earlier block rulings off the thread. A matching finding on a new head (same file,
 * same or similar claim) goes STRAIGHT back to a fixer with the original ruling text attached and a note that the
 * last fix did not satisfy it. After 2 misses it escalates as a fixer-versus-reviewer disagreement (a needs-you
 * note), never a third round.
 *
 * SCENARIO: three heads. H1 ruled block; H2 repeats the finding (miss 1); H3 repeats it again (miss 2). RED = H2
 * parks again / is re-reviewed instead of a fix with the ruling, or H3 is sent to a fixer a second time, or no
 * escalation note appears. The hold evidence is the real `decideReferralHold` (what parked the live PR).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const imp = (rel) => import(pathToFileURL(join(src, rel)).href);
const jury = await imp('scripts/lib/jury-core.mjs');
const core = await imp('scripts/conveyor/reconcile-core.mjs');
const pass = await imp('scripts/conveyor/reconcile-pass.mjs');
const hold = await imp('scripts/conveyor/review-referral-hold.mjs');
const repo = 'owner/name';
const H = ['a', 'b', 'c'].map((c) => c.repeat(40));
const at = Date.parse('2026-10-04T03:50:00Z');
const original = { summary: 'policy pointer files are missing from the standards manifest so the gate cannot see them', file: 'policy/pointer.md', line: 12, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const key = jury.referralFindingKey('judge', original);
const mk = (head, runId, rulings = []) => { const reviewer = jury.mandatoryReferralReviewer(runId);
  return { version: 1, repo, pr: 3794, head, runId, reviewer, authorBody: '<!-- authored-by-actor: a -->', attempted: true,
    referrals: [{ key, seat: 'judge', original, finding: jury.normalizeFinding(original) }],
    rulings: rulings.map((r, i) => ({ id: 'r' + i, key, reviewerId: reviewer.id, lens: reviewer.lens, result: r, rationale: 'pointer files must be listed; do not ship without them', evidence: ['e'] })) }; };
const c = (rec, min) => ({ body: jury.renderReferralRecord(rec), createdAt: new Date(at + min * 60000).toISOString(), author: { login: 'web-everything' } });
const evidence = (head, min) => ({ id: 'review-pr-' + head[0], repo, pr: 3794, head, startedAt: at + min * 60000, completedAt: at + min * 60000 + 300000,
  parked: true, pending: [key], attempted: true, persistenceFailed: false, count: 1, rulings: [] });
const thread = (n) => [c(mk(H[0], 'run-1'), 1), c(mk(H[0], 'run-1', ['block']), 3), ...(n > 1 ? [c(mk(H[1], 'run-2'), 20)] : []), ...(n > 2 ? [c(mk(H[2], 'run-3'), 40)] : [])];
const plan = (headIdx, comments, minutes) => {
  let pr = { number: 3794, state: 'OPEN', headRefName: 'lane/xcs4nce', headRefOid: H[headIdx], labels: [{ name: 'review:human' }, { name: 'advisory:changes' }],
    mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments };
  if (pass.enrichPrsWithIgnoredRulings) [pr] = pass.enrichPrsWithIgnoredRulings([pr]);
  pr = { ...pr, referralHold: hold.decideReferralHold(pr, [evidence(H[headIdx], minutes)], { repo, now: at + (minutes + 10) * 60000 }) };
  return core.planReconcile({ prs: [pr], agents: [], now: at + (minutes + 10) * 60000, requiredChecks: ['gate'] });
};
import { readFileSync } from 'node:fs';
const fx = JSON.parse(readFileSync(join(src, 'scripts/conveyor/soak/fixtures/pr-3794-live-thread.json'), 'utf8'));
const liveHeads = {};
for (const cm of fx.comments) for (const r of jury.readReferralRecords([cm], {}).records) liveHeads[r.head.slice(0, 9)] = r.head;
const livePlan = (head, upto) => { let pr = { number: 3794, state: 'OPEN', headRefName: 'lane/prepare-main-protection', headRefOid: head,
    labels: [{ name: 'review:human' }, { name: 'advisory:changes' }], mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments: fx.comments.filter((cm) => cm._liveIndex <= upto) };
  if (pass.enrichPrsWithIgnoredRulings) [pr] = pass.enrichPrsWithIgnoredRulings([pr]);
  return core.planReconcile({ prs: [pr], agents: [], now: Date.parse('2026-10-04T06:00:00Z'), requiredChecks: ['gate'] }); };
const l1 = livePlan(liveHeads.dd32bfb5c, 43);
const l2 = livePlan(liveHeads['13f5a7354'], 51);
const l3 = livePlan(liveHeads['13f5a7354'], 52);
const p2 = plan(1, thread(2), 20);
const p3 = plan(2, thread(3), 40);
const out = {
  h2: p2.dispatch.map((d) => [d.kind, d.mode ?? null]), h2Refusals: p2.refusals.map((r) => r.kind),
  h2Ruling: p2.dispatch[0]?.rulingNotAddressed?.matches?.[0]?.ruling ?? null,
  h3: p3.dispatch.map((d) => [d.kind, d.mode ?? null]), h3Refusals: p3.refusals.map((r) => r.kind), h3Notes: p3.notes.map((n) => n.kind),
  h3Rung: p3.dispatch[0]?.rulingNotAddressed?.rung?.id ?? null,
  live1: l1.dispatch.map((d) => [d.kind, d.mode ?? null]), live1Ruling: l1.dispatch[0]?.rulingNotAddressed?.matches?.[0]?.ruling ?? null,
  live2: l2.dispatch.map((d) => [d.kind, d.mode ?? null]), live2Notes: l2.notes.map((n) => n.kind), live2Rung: l2.dispatch[0]?.rulingNotAddressed?.rung?.id ?? null,
  live3: l3.dispatch.map((d) => [d.kind, d.mode ?? null]), live3Notes: l3.notes.map((n) => n.kind),
};
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: 'ignored-ruling-parks-again',
  title: 'a finding the operator already ruled block comes back on a new head and the review just parks again instead of going back to the fixer',
  card: 'operator order 2026-10-04 ~08:15 ET; live incident PR #3794 (card xcs4nce, policy pointer files; also #3833, #3771)',
  fixedBy: { sha: 'b01658095e2513f2b0ca7f5923b08ce0723f851c,9262954bee52086a168380dd4445d3170d1d7e7b,c144900a6da7ebb005f1e5d83adb73f84e16aa27,4a33d462c910fbbd29444b1600ff5b1d717570d7,3aeccaa0bf05f4ae5d2c565866f46b587787da8a', where: 'lane/fix-ruling-needed-surface', paths: [
    'scripts/conveyor/fixer-ladder.mjs',
    'scripts/conveyor/health-responder-core.mjs',
    'scripts/conveyor/health-smells-notify-list.mjs',
    'scripts/conveyor/health-smells/ruling-needed-waiting.mjs',
    'scripts/conveyor/health-watch-core.mjs',
    'scripts/conveyor/health-watch.mjs',
    'scripts/conveyor/reconcile-core.mjs',
    'scripts/conveyor/reconcile-fix-dispatch.mjs',
    'scripts/conveyor/reconcile-note-comment.mjs',
    'scripts/conveyor/reconcile-pass.mjs',
    'scripts/conveyor/review-hold-reconcile.mjs',
    'scripts/conveyor/review-referral-hold.mjs',
    'scripts/conveyor/ruling-needed-sweep.mjs',
    'scripts/lib/dispatch-routing-policy.json',
    'scripts/lib/fixer-escalation-policy.mjs',
    'scripts/lib/ruling-ledger.mjs',
    'scripts/operations/operator-notify.mjs',
    'scripts/operations/operator-queue.mjs',
    'skills-src/conveyor/review-daemon.mjs',
  ] },
  fixPresent(root) { return existsSync(join(root, 'scripts/lib/ruling-ledger.mjs')); },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-ignored-ruling-'));
    const violations = [];
    try {
      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot } }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail: `the scenario child crashed: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ')}` });
        return { violations };
      }
      log?.(JSON.stringify(out));
      const sentBack = out.h2.length === 1 && out.h2[0][0] === 'fix' && out.h2[0][1] === 'ruling-not-addressed';
      if (!sentBack) violations.push({ invariant: 'sent-straight-back', detail: `miss 1 must dispatch one fix (ruling-not-addressed); got dispatch=${JSON.stringify(out.h2)} refusals=${out.h2Refusals.join(',') || 'none'} (parked again = the live defect)` });
      if (sentBack && !/pointer files must be listed/.test(out.h2Ruling ?? '')) violations.push({ invariant: 'ruling-attached', detail: 'the original ruling text is not attached to the send-back' });
      // Miss 2 is the NEXT rung of the fixer-escalation ladder (a stronger model), never a plain park and never the same
      // fixer for a third time. (The ladder's later rungs have their own break: fixer-ladder-skips-stronger-model.)
      if (out.h3.length !== 1 || out.h3[0][1] !== 'ruling-not-addressed' || out.h3Rung !== 'stronger-model') {
        violations.push({ invariant: 'second-miss-escalates', detail: `miss 2 must go to the stronger-model rung; got dispatch=${JSON.stringify(out.h3)} rung=${out.h3Rung} refusals=${out.h3Refusals.join(',') || 'none'} notes=${out.h3Notes.join(',') || 'none'}` });
      }
      // The live thread itself (PR #3794): the operator's own "ruling: block" comment, replayed head by head.
      const liveFirst = out.live1.length === 1 && out.live1[0][0] === 'fix' && out.live1[0][1] === 'ruling-not-addressed' && /ruling: block/.test(out.live1Ruling ?? '');
      if (!liveFirst) violations.push({ invariant: 'live-first-miss-sent-back', detail: `PR #3794's first head after the operator's 01:19Z block ruling must go back to a fixer with that ruling; got dispatch=${JSON.stringify(out.live1)}` });
      if (out.live2.length !== 1 || out.live2Rung !== 'stronger-model') {
        violations.push({ invariant: 'live-second-miss-escalates', detail: `PR #3794's second head must go to the stronger-model rung; got dispatch=${JSON.stringify(out.live2)} rung=${out.live2Rung} notes=${out.live2Notes.join(',') || 'none'}` });
      }
      if (out.live3.some((d) => d[1] === 'ruling-not-addressed') || out.live3Notes.includes('ruling-dispute')) {
        violations.push({ invariant: 'live-fresh-ruling-clears', detail: `after the operator's 12:11Z re-ruling nothing may be sent back or escalated; got dispatch=${JSON.stringify(out.live3)} notes=${out.live3Notes.join(',') || 'none'}` });
      }
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
