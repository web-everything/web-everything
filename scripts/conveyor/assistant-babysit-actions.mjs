/** Pure shadow decisions. Command arrays are display data, never executed here. */
import { classifyPr, human, live } from './assistant-babysit-rules.mjs';

export const actionKey = (action) => `${action.repo}#${action.pr}@${action.head}:${action.type}`;

export function decideActions(snapshot, report, ctx = {}) {
  const { repo, number: pr, headSha: head, labels = [] } = snapshot;
  const { why = {}, minutes, done = {} } = ctx;
  const actions = [];
  const escalations = [];
  const logLine = typeof why.fixLogLine === 'string' ? why.fixLogLine : '';
  const add = (type, argv, reason) => actions.push({ type, repo, pr, head, argv, reason });
  if (!snapshot.isDraft && !human(labels)) {
    const fixer = (snapshot.claims ?? []).some((claim) => ['fix', 'fixing', 'ci-heal'].includes(claim.kind) && live(claim, snapshot.nowMs));
    const refusal = `${logLine} ${typeof why.waitingFor === 'string' ? why.waitingFor : ''}`;
    const { owed } = classifyPr(snapshot);
    if (owed.some((kind) => ['review-changes', 'red-team-blocked', 'sent-back'].includes(kind)) && !fixer
      && Number.isFinite(minutes) && minutes >= 20 && why.owner === 'fix daemon' && /refus|skip|cap/i.test(refusal)
      && !/scope-overlap|priority-shadow|serializ|waiting \d|retrying next pass|in progress|queued|take-?over/i.test(refusal)) {
      add('rearm', ['node', 'scripts/operations/run.mjs', 'rearm', `--pr=${pr}`, `--repo=${repo}`], 'fix work refused or skipped');
    }
    if (snapshot.mergeable !== 'CONFLICTING' && (snapshot.mergeStateStatus === 'BEHIND'
      || report?.rule === 'sticky-label' || (snapshot.ciFailing && /main.{0,40}red|failing on main|behind main/i.test(logLine)))) {
      add('update-branch', ['gh', 'api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/update-branch`], report?.rule === 'sticky-label' ? 'a new head clears per-head escalations' : 'branch behind main');
    }
    const failed = snapshot.failedChecks;
    if (snapshot.ciFailing && Array.isArray(failed) && failed.length && failed.every((check) =>
      ['TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(check.conclusion) && /^\d+$/.test(String(check.runId ?? '')))) {
      add('rerun-failed', ['gh', 'run', 'rerun', String(failed[0].runId), '--failed', `--repo=${repo}`], 'failed checks classified as infrastructure failures');
    }
  }
  if (!snapshot.isDraft && !human(labels) && snapshot.mergeable === 'CONFLICTING') {
    escalations.push({ type: 'escalate', repo, pr, head, reason: 'conflict: branch cannot be updated automatically',
      files: snapshot.conflictFiles ?? [], logLine, ...(snapshot.conflictNote ? { note: snapshot.conflictNote } : {}) });
  }
  const recorded = actions.some((action) => done instanceof Set ? done.has(actionKey(action)) : Object.hasOwn(done, actionKey(action)));
  if (!escalations.length && (!actions.length || recorded) && ['sticky-label', 'no-worker', 'human-wait', 'gate-red-stalled', 'stale-claim'].includes(report?.rule)) {
    escalations.push({ type: 'escalate', repo, pr, head, reason: recorded ? 'action already recorded for this head; condition persists' : report.reason, logLine });
  }
  return { actions: actions.filter((action) => done instanceof Set ? !done.has(actionKey(action)) : !Object.hasOwn(done, actionKey(action))), escalations };
}
