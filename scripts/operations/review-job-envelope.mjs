/**
 * @file scripts/operations/review-job-envelope.mjs
 * @description ITEM 117 S3b — the review JOB's completion record becomes the v2 envelope.
 *
 * The review daemon's default dispatch is a deterministic detached node job (`review-job.mjs`), not a Claude
 * session: it already is a run-to-completion worker with its own pid and hard timeout (the D7 FINAL pattern), and
 * its jurors are already schema-enforced (`judge-spawn.mjs`). What it lacked was the envelope: it wrote v1 records
 * through `completion-cli report`. This module writes them as v2 instead:
 *
 *  - `started` (D5: the launcher writes it) carries the job's own `pid`, `timeoutMs` and `deadlineAt`;
 *  - `done` carries a worker result BUILT from the classified loop outcome and CHECKED by the same validator every
 *    worker result goes through (`settleWorkerResult`), plus the router's `action`;
 *  - the v1 words (`outcome`, `verdict`, `label`, `runId`) are written exactly as before, so every reader (the lane
 *    deferral count, the lane cool-off, `markSelfReportedDone`, `completion-cli show`) is unchanged.
 *
 * Launcher `node-job`: no model, no prose, a result derived by code. It never routes to a product-fix draft on its own
 * (no `tooling-defect` / `permission-wall` kind is produced here), so no draft sink is wired.
 */
import { finishEnvelopeRecord, newEnvelopeRecord } from './completion-record.mjs';
import { resolveCompletionsDir, tryReadCompletion, withCompletionLock, writeCompletion } from './completion-store.mjs';
import { routeWorkerResult, settleWorkerResult } from './worker-result-router.mjs';

export const REVIEW_JOB_LAUNCHER = 'node-job';

/** The review job's own outcome words -> worker-result outcome / blocker kind. Anything unknown fails closed (blocked). */
const DONE_OUTCOMES = new Set(['parked', 'auto-cleared', 'bounced']);

/**
 * PURE — the worker result for one classified review-job round. `parked` / `auto-cleared` / `bounced` are finished
 * reviews (`done`); `deferred-no-lane` and `blocked-on-infra` are a retryable infra blocker (the job's own cool-off
 * and deferral count already pace the retry); any other word is a blocker too, never success.
 * @param {{outcome: string, verdict?: string|null, loopOutcome?: string|null, runId?: string|null, label?: string|null}} classified
 * @param {{pr?: number|string, repo?: string}} [ctx]
 */
export function reviewJobResult(classified, { pr = null, repo = null } = {}) {
  const word = String(classified?.outcome ?? 'blocked-on-infra');
  const where = `${repo ?? '?'}#${pr ?? '?'}`;
  const label = classified?.label ? String(classified.label) : '';
  if (DONE_OUTCOMES.has(word)) {
    return {
      v: 1, outcome: 'done',
      summary: `review ${where}: ${word} (verdict ${classified?.verdict ?? '-'}, loop ${classified?.loopOutcome ?? '-'}, run ${classified?.runId ?? '-'})`.slice(0, 280),
      blocker: null, findingsAddressed: [], filesTouched: [], learning: null,
    };
  }
  return {
    v: 1, outcome: 'blocked', summary: `review ${where}: ${word}`.slice(0, 280),
    blocker: {
      kind: 'infra-transient', component: word === 'deferred-no-lane' ? 'review-job lane pool' : 'review-job review-loop',
      evidence: { text: (label || word).slice(0, 2000), refs: classified?.runId ? [String(classified.runId)] : [] },
      proposedFix: null, ruling: null, deniedCommand: null, retryable: true,
    },
    findingsAddressed: [], filesTouched: [], learning: null,
  };
}

/**
 * Write the job's v2 `started` record (replacing whatever an earlier round left). Returns the record written.
 * @param {{session: string, pr: number|string, pid?: number, timeoutMs?: number, dir?: string, now?: () => string}} o
 */
export function writeReviewJobStarted({ session, pr, pid = process.pid, timeoutMs = null, dir = resolveCompletionsDir(), now } = {}) {
  const rec = newEnvelopeRecord({ session, role: 'review', launcher: REVIEW_JOB_LAUNCHER, pr, pid, timeoutMs, ...(now ? { now } : {}) });
  withCompletionLock(session, () => writeCompletion(rec, dir), { dir });
  return rec;
}

/**
 * Write the job's v2 `done` record: the checked result, the routed action, and the v1 words unchanged.
 * @param {{session: string, pr: number|string, repo?: string, classified: object, pid?: number, timeoutMs?: number, dir?: string, now?: () => string}} o
 */
export function writeReviewJobDone({ session, pr, repo = null, classified, pid = process.pid, timeoutMs = null, dir = resolveCompletionsDir(), now } = {}) {
  const clock = now ?? (() => new Date().toISOString());
  return withCompletionLock(session, () => {
    let started = null;
    try { started = tryReadCompletion(session, dir); } catch { started = null; }
    if (!started || started.v !== 2 || started.status !== 'started') {
      started = newEnvelopeRecord({ session, role: 'review', launcher: REVIEW_JOB_LAUNCHER, pr, pid, timeoutMs, now: clock });
    }
    const settled = settleWorkerResult({ role: 'review', launcher: REVIEW_JOB_LAUNCHER, value: reviewJobResult(classified, { pr, repo }) });
    const action = routeWorkerResult(settled.result, { role: 'review', launcher: REVIEW_JOB_LAUNCHER, session, pr: pr == null ? null : String(pr) });
    const fin = finishEnvelopeRecord(started, {
      result: settled.result, parse: settled.parse, action, outcome: String(classified?.outcome ?? 'blocked-on-infra'), reroute: settled.reroute,
      source: 'worker-result',
    }, clock);
    const rec = {
      ...fin,
      verdict: classified?.loopOutcome ?? null,
      runId: classified?.runId ?? null,
      label: classified?.label ? String(classified.label).slice(0, 500) : null,
    };
    writeCompletion(rec, dir);
    return rec;
  }, { dir });
}
