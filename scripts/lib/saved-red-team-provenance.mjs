/** Review-job attestations bind persisted evidence, including private fields, to a completed review. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { listRunIds, readRun, sharedRunsDir } from '../operations/run-store.mjs';
import { isCompletedReviewPr, isParkedAtConfirm } from '../operations/review-pr-completion.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const savedRedTeamHash = rows => createHash('sha256')
  .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(rows))))).digest('hex');
export const savedRedTeamRunsDir = env => env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env);
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const matchesSavedRedTeamHead = (row, { repo, pr, head }) => sameRepo(row?.repo, repo)
  && Number(row?.pr) === Number(pr) && row?.rev === head
  && row?.dispatchKind === 'review-seat' && row?.seat === 'red-team' && row?.status === 'ok';

export function verifySavedRedTeamProvenance({ repo, pr, head, path, records, index, env, runsDir = savedRedTeamRunsDir(env) }) {
  let reason = 'no completed matching review-pr run reference';
  try {
    for (const id of listRunIds(runsDir).filter(id => id.startsWith('review-pr-'))) {
      const run = readRun(id, runsDir);
      if (run.op !== 'review-pr' || !sameRepo(run.input?.repo, repo) || Number(run.input?.pr) !== Number(pr)
        || run.findings?.read?.netBasis?.rev !== head) continue;
      if (!isCompletedReviewPr(run) && !isParkedAtConfirm(run)) { reason = 'review-pr run incomplete'; continue; }
      const proof = run.findings?.savedRedTeamResult;
      if (proof?.writer !== 'review-job') { reason = 'missing review-job provenance writer'; continue; }
      if (!Array.isArray(proof.references) || !proof.references.length) { reason = 'missing result reference'; continue; }
      if (!proof.references.some(ref => ref?.path === path && ref.index === index)) continue;
      if (!/^[a-f0-9]{64}$/.test(proof.sha256 ?? '')) { reason = 'missing or invalid result hash'; continue; }
      if (proof.references.some(ref => typeof ref?.path !== 'string' || resolve(ref.path) !== resolve(path)
        || !Number.isSafeInteger(ref.index) || ref.index < 0
        || !matchesSavedRedTeamHead(records[ref.index], { repo, pr, head }))) {
        reason = 'invalid result references'; continue;
      }
      if (savedRedTeamHash(proof.references.map(ref => records[ref.index])) !== proof.sha256) {
        reason = 'result hash mismatch'; continue;
      }
      return null;
    }
  } catch { return 'review-pr provenance unreadable'; }
  return reason;
}
