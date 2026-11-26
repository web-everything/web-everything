/** Pure record-effect retry classification, shared without the referral/operation import graph. */
// These argument checks run in the CLI entry point before runReviewLabelCli can mutate anything.
// Exported so a test can require one real-CLI no-write case per pattern: each one licenses a replay.
// ANCHORED to the start of the CLI's own error text (optionally behind the sink's own UNKNOWN wrapper), so a
// post-write `gh` stderr line that merely CONTAINS one of these phrases never licenses a replay.
const BODY_FILE_ANCHOR = '^(?:review-set-label\\.mjs (?:failed|reported an error) and its outcome is UNKNOWN: )?';
export const BODY_FILE_REFUSALS = Object.freeze([
  new RegExp(`${BODY_FILE_ANCHOR}--body-file=[^\\r\\n]+ is unreadable \\(`),
  new RegExp(`${BODY_FILE_ANCHOR}--body-file=[^\\r\\n]+ is empty — pass the verdict write-up`),
  new RegExp(`${BODY_FILE_ANCHOR}--body-file must live under the repo root or a temp dir \\(got `),
]);
export const isBodyFileRefusal = text => typeof text === 'string' && BODY_FILE_REFUSALS.some(p => p.test(text));

/** Saved retry evidence must prove both counters; never coerce corrupt state into a fresh budget. */
export function ciHeldRecordRetryCountersValid(evidence) {
  return [evidence?.attempts, evidence?.resumeAttempts].every(n => Number.isSafeInteger(n) && n >= 0);
}

/** The same flags exposed by reviewRunEvidence; an unreadable effect cannot prove a retry. */
export function reviewRecordRetryEvidence(run) {
  let retryableRecordEffect = false;
  let ciHeldRecordRetry;
  try {
    if (run.pending?.kind === 'effect' && run.pending.step === 'record' && Array.isArray(run.effects)) {
      const outstanding = run.effects.filter(e => !['applied', 'declared'].includes(e?.status));
      retryableRecordEffect = !run.resumeOf && outstanding.length > 0 && outstanding.every(e => e?.type === 'review.label-swap'
        && e.status === 'pending' && e.unknownAttempts === 0 && isBodyFileRefusal(e.error));
      if (outstanding.length > 0 && outstanding.every(e => e?.type === 'review.label-swap'
        && e.status === 'failed' && (run.ciHeldRecord === true
          || typeof e.error === 'string' && /CI still pending on reviewed head/.test(e.error)))) {
        const resumeAttempts = Object.hasOwn(run, 'recordEffectResumeAttempts') ? run.recordEffectResumeAttempts : 0;
        ciHeldRecordRetry = { attempts: outstanding.every(e => ciHeldRecordRetryCountersValid({
          attempts: e.unknownAttempts, resumeAttempts,
        })) ? Math.max(...outstanding.map(e => e.unknownAttempts)) : null, resumeAttempts };
      }
    }
  } catch { /* Unreadable effects cannot prove a safe record retry. */ }
  return { retryableRecordEffect, ...(ciHeldRecordRetry ? { ciHeldRecordRetry } : {}) };
}
