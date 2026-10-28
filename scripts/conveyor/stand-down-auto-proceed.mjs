/** R123 pure CI stand-down classifier. Contract: we:scripts/conveyor/stand-down-auto-proceed.md. */
import { standDownComments, standDownHead, isStandDownSuperseded, isLoadFlakeStandDown } from './stand-down.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { buildOperatorAnswer, isOperatorAnswerStandDownSuperseded } from './stand-down-answer-core.mjs';
import { isAdvisoryMechanismStandDownSuperseded } from './advisory-fix-mark.mjs';
import { fixLoopRedMainLapse } from './fix-loop-ledger.mjs';
import { classifyMainDefect, DEFAULT_PR_SCOPED_CHECKS } from './main-red-recovery.mjs';
import { fenceUntrusted, FENCED_DATA_RULE } from '../lib/mandate-fence.mjs';

const ciReason = c => /\n<!-- stand-down reason=(gate-red|fix-loop-exhausted)(?: head=[a-f0-9]{7,40})? -->$/i.test(c?.body ?? '');
const hold = why => ({ action: 'hold', why });
const appIdentity = r => Number.isSafeInteger(r?.app?.id) && r.app.id > 0 ? `id:${r.app.id}` : null;
// Check suites distinguish independent workflows with the same app/name. Different suites may be
// independent runs or reruns; without workflow lineage, retain the operator hold in either case.
const checkIdentity = r => appIdentity(r) && Number.isSafeInteger(r?.check_suite?.id) && r.check_suite.id > 0
  ? `${appIdentity(r)}:suite:${r.check_suite.id}` : null;

/** Null means unknown policy; other-app runs never supply evidence, including SUCCESS. */
export function boundAutoProceedRuns(runs, requiredChecks, requiredCheckBindings) {
  if (!Array.isArray(requiredCheckBindings) || !requiredCheckBindings.length
    || requiredCheckBindings.some(c => typeof c?.context !== 'string' || !c.context
      || !Number.isSafeInteger(c.integration_id) || c.integration_id < 1)
    || new Set(requiredCheckBindings.map(c => c.context)).size !== requiredCheckBindings.length
    || !Array.isArray(requiredChecks)
    || requiredChecks.some(name => !requiredCheckBindings.some(c => c.context === name))) return null;
  const ids = new Map(requiredCheckBindings.map(c => [c.context, c.integration_id]));
  return runs.filter(r => requiredChecks.includes(r.name) && r.app?.id === ids.get(r.name));
}

/** Restore only same-head red-main annotations: R123 records their release durably instead. */
export function autoProceedStandDowns(pr) {
  if (!Array.isArray(pr?.comments)) return [];
  const comments = pr.comments.map(c => c?.standDownLapsed && standDownHead(c.body) === pr.headRefOid && ciReason(c)
    ? { ...c, standDownLapsed: undefined } : c);
  // Match the answer reader's terminal-or-legacy-hold set: newest-wins answers can end either.
  return comments.filter((c, i) => (standDownComments([c]).length > 0
    || (isTrustedMarkerAuthor(c) && isLoadFlakeStandDown(c))) && !isStandDownSuperseded(comments, i)
    && !isAdvisoryMechanismStandDownSuperseded(comments, i) && !isOperatorAnswerStandDownSuperseded(comments, i));
}

/** Cheap eligibility filter before IO; never reads checks for judgment-only holds. */
export function hasAutoProceedCandidate(pr) {
  const pending = autoProceedStandDowns(pr);
  return pending.length > 0 && pending.every(c => !isLoadFlakeStandDown(c) && ciReason(c) && standDownHead(c.body) === pr.headRefOid);
}

/** Evidence is a complete REST filter=all check-run feed fetched for `checks.head`, never a rollup. */
export function classifyStandDownAutoProceed({ pr, requiredChecks, requiredCheckBindings, checks, redMainContext,
  prScopedChecks = DEFAULT_PR_SCOPED_CHECKS } = {}) {
  if (!/^[a-f0-9]{40}$/i.test(pr?.headRefOid ?? '') || !Array.isArray(pr?.comments)) return hold('operator answer required: missing head/thread');
  if (pr.comments.length > 2000) return hold('operator answer required: thread exceeds 2000 comments');
  const pending = autoProceedStandDowns(pr);
  if (!pending.length) return hold('no unresolved terminal stand-down');
  // Answers are newest-wins. Never let an automatic answer to CI silently answer a human question too.
  if (pending.some(c => isLoadFlakeStandDown(c) || !ciReason(c) || standDownHead(c.body) !== pr.headRefOid)) return hold('operator answer required: non-CI or unbound stand-down');
  if (pending.some(c => !/^[\w=-]+$/.test(String(c.id ?? ''))
    || !Number.isFinite(Date.parse(c.createdAt)))) return hold('operator answer required: missing stand-down identity/time');
  const target = pending.at(-1);
  if (!Array.isArray(requiredChecks) || !requiredChecks.length || requiredChecks.some(n => typeof n !== 'string' || !n)) return hold('operator answer required: unknown required checks');
  if (checks?.head !== pr.headRefOid || checks?.complete !== true || !Array.isArray(checks.runs)) return hold('operator answer required: incomplete exact-head checks');
  if (checks.runs.length > 1000) return hold('operator answer required: check evidence exceeds 1000 runs');
  if (checks.runs.some(r => !Number.isSafeInteger(r?.id) || r.id < 1 || typeof r.name !== 'string'
    || r.head_sha !== pr.headRefOid) || new Set(checks.runs.map(r => r.id)).size !== checks.runs.length) return hold('operator answer required: invalid check evidence');
  const runs = boundAutoProceedRuns(checks.runs, requiredChecks, requiredCheckBindings);
  if (runs === null) return hold('operator answer required: unreadable required-check integration policy');
  const requiredRuns = requiredChecks.map(name => runs.filter(r => r.name === name));
  if (requiredRuns.some(history => history.some(r => checkIdentity(r) === null)
    || new Set(history.map(checkIdentity)).size > 1)) return hold('operator answer required: ambiguous check identity');
  // App/suite/name is not a job identity. Only collapse a complete history when the
  // Actions job reader proves one same-name job per attempt of a single workflow run.
  if (requiredRuns.some(history => history.length > 1 && (
    history.some(r => !Number.isSafeInteger(r.actions?.runId) || r.actions.runId < 1
      || !Number.isSafeInteger(r.actions?.attempt) || r.actions.attempt < 1)
    || new Set(history.map(r => r.actions?.runId)).size !== 1
    || new Set(history.map(r => r.actions?.attempt)).size !== history.length
  ))) return hold('operator answer required: ambiguous rerun lineage');
  const latest = requiredRuns.map(history => [...history].sort((a, b) => b.actions?.attempt - a.actions?.attempt)[0]);
  const conclusion = r => String(r?.conclusion ?? '').toUpperCase();
  if (latest.some(r => !r || String(r.status).toUpperCase() !== 'COMPLETED'
    || !Number.isFinite(Date.parse(r.completed_at)) || !['SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED'].includes(conclusion(r)))) return hold('operator answer required: missing, pending or unknown required check');
  const failures = latest.filter(r => conclusion(r) === 'FAILURE');
  const redMain = redMainContext?.config && Array.isArray(redMainContext.rows)
    && fixLoopRedMainLapse({ ...redMainContext, pr: pr.number, head: pr.headRefOid }) === true;
  // A budget discount alone is insufficient: every currently failed required check must independently
  // be attributed by the existing main classifier. PR-scoped failures always hold.
  if (failures.some(r => !redMain || !classifyMainDefect({ requiredCheckCompletedAt: r.completed_at,
    failingCheckName: r.name, mainRedWindows: redMainContext.config.redMainWindows, prScopedChecks }).mainDefect)) return hold('operator answer required: genuine required-check FAILURE');
  const reruns = latest.filter(r => conclusion(r) === 'SUCCESS' && Date.parse(r.completed_at) > Date.parse(target.createdAt)
    && runs.some(old => old.name === r.name && checkIdentity(old) === checkIdentity(r)
      && old.actions?.runId === r.actions?.runId && old.actions?.attempt < r.actions?.attempt
      && conclusion(old) === 'FAILURE'
      && Date.parse(old.completed_at) <= Date.parse(target.createdAt)));
  const kind = failures.length ? 'c' : reruns.length ? 'a'
    : latest.some(r => ['CANCELLED', 'SKIPPED'].includes(conclusion(r))
      && Date.parse(r.completed_at) > Date.parse(target.createdAt)) ? 'b' : redMain ? 'c' : null;
  if (!kind) return hold('operator answer required: no recovered CI evidence');
  const labels = { a: 'passed a later rerun on the same head', b: 'cancelled/skipped rather than failed', c: 'main\'s own CI was red; fixLoopRedMainLapse confirms the park no longer holds' };
  const details = JSON.stringify({ checks: runs.filter(r => requiredChecks.includes(r.name))
    .map(r => ({ check: r.name, appId: r.app.id, runId: r.id, suiteId: r.check_suite.id, actions: r.actions,
      conclusion: conclusion(r), completedAt: r.completed_at })),
  ...(kind === 'c' ? { mainWindows: redMainContext.config.redMainWindows,
    ledger: redMainContext.rows.filter(r => r.pr === pr.number && r.head === pr.headRefOid).map(r => ({ kind: r.kind, at: r.at })) } : {}) });
  const reason = `AUTO-PROCEED R123 (${kind}): ${labels[kind]}. Head ${pr.headRefOid.slice(0, 7)}.\n\n${FENCED_DATA_RULE}\n${fenceUntrusted('material', details)}\n\nContinue through normal review and CI gates.`;
  const body = buildOperatorAnswer({ standDownId: String(target.id), actor: 'auto-R123', channel: 'auto (R123)', reason });
  if (body.length > 60000) return hold('operator answer required: evidence exceeds comment size bound');
  return { action: 'auto-proceed', kind, standDownId: String(target.id), body };
}
