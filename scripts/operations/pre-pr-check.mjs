/**
 * @file scripts/operations/pre-pr-check.mjs
 * @description The declared, read-only `pre-pr-check` operation: "is this lane's committed head gated by the pre-PR
 *   review (#4271), and what exactly do I run to get a receipt?". Agents kept opening risky PRs without the review
 *   because nothing told them, in one place, whether it applied and which commands to run; this answers both.
 *   It reads through the SAME `checkPrePrReview` that `open-pr` runs (one rule, never a second classifier), so the
 *   answer here is the answer `open-pr` will give for the same head. It never writes a receipt and never bypasses.
 *
 *   Run it on the COMMITTED head: `node scripts/operations/run.mjs pre-pr-check --checkout=<lane>`.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { prePrReviewCommands } from '../lib/pre-pr-commands.mjs';

export const PRE_PR_CHECK_OP = 'pre-pr-check';

/**
 * Pure: shape a `checkPrePrReview` decision (or the error its read threw) into the verdict. FAIL CLOSED: an error
 * reads as gated, never as "no review needed".
 * @param {{checkout: string, decision?: object, error?: string}} o
 */
export function assessPrePrCheck({ checkout, decision, error = '' }) {
  const commands = prePrReviewCommands(checkout);
  // FAIL CLOSED on a malformed decision too: no boolean `risk.gated` is an unreadable answer, never "not gated".
  if (error || !decision || typeof decision.risk?.gated !== 'boolean') {
    const summary = `GATED (check failed: ${error || 'no usable decision'})`;
    return { checkout, gated: true, needsReview: true, mode: 'unknown', why: 'check-error', reasons: [`the check itself failed: ${error || 'no usable decision'}`], commands, next: commands.text, summary, headline: `${summary} — run the review: ${commands.text}` };
  }
  const risk = decision.risk || {};
  const mode = decision.settings?.mode ?? 'unknown';
  const gated = mode === 'off' ? false : !!risk.gated;
  const haveReceipt = decision.why === 'receipt';
  const needsReview = gated && !haveReceipt;
  const reasons = risk.reasons || [];
  const summary = !gated
    ? `not gated (${decision.why}) — no pre-PR review needed; open-pr will not ask for a receipt`
    : haveReceipt
      ? 'gated, and a valid receipt exists for this head — open-pr will pass'
      : `GATED (${reasons.join('; ')}); no valid receipt (${decision.why})`;
  const headline = needsReview ? `${summary} — run the review: ${commands.text}` : summary;
  return {
    checkout, gated, needsReview, mode, why: decision.why, reasons,
    lines: risk.lines ?? null, subsystems: risk.subsystems ?? null, files: risk.files ?? null,
    commands, next: needsReview ? commands.text : '', summary, headline,
  };
}

/** @param {{check: (o: {checkout: string}) => object}} deps  `check` is the IO (see pre-pr-check-io.mjs). */
export function prePrCheckOperation({ check } = {}) {
  if (typeof check !== 'function') throw new TypeError('pre-pr-check needs a check reader');
  return op(PRE_PR_CHECK_OP, {
    input: { checkout: 'string' },
    verdictFrom: 'assess',
    read: compute({
      reads: ['input.checkout'],
      fn: ({ input }) => {
        try {
          const d = check({ checkout: input.checkout });
          // Keep the evidence, not the long advise message (it repeats the commands the verdict already carries).
          return { checkout: input.checkout, decision: { action: d.action, why: d.why, risk: d.risk, settings: { mode: d.settings?.mode } } };
        }
        catch (e) { return { checkout: input.checkout, error: String(e?.message ?? e).slice(0, 300) }; }
      },
    }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessPrePrCheck(findings.read) }),
  });
}

/**
 * THE COMMAND LINE'S OUTPUT. PURE. The first line is `pre-pr-check: gated` or `pre-pr-check: not gated`; when a
 * review is owed, the exact commands follow, one per line. Without `finish` the generic run summary would print
 * only "complete. 0 effect(s) applied.", which says nothing.
 */
export function finishPrePrCheckOutcome({ run, code, lines, json = false } = {}) {
  const v = run?.verdict;
  if (json || !v || typeof v.gated !== 'boolean') return { code, lines };
  const head = `pre-pr-check: ${v.gated ? 'gated' : 'not gated'} (mode ${v.mode}) — ${v.summary}`;
  if (!v.needsReview) return { code, lines: [head] };
  return {
    code,
    lines: [
      head, '', 'Run the pre-PR review BEFORE open-pr, on the committed head:',
      `  1. ${v.commands.init}`, `  2. ${v.commands.loop}`, `  3. ${v.commands.commit}`, `  4. ${v.commands.receipt}`,
      '', 'Then open-pr. (This check reads the committed HEAD; re-run it after committing.)',
    ],
  };
}
