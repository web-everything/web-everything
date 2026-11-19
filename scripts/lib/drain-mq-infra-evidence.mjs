/** Positive Actions evidence for a single same-head infrastructure re-enqueue. */
import { inspectMqReruns, mqActionsJob } from './drain-mq-flake-rerun.mjs';
import yaml from 'js-yaml';

const passing = new Set(['success', 'neutral', 'skipped']);
const cancelled = new Set(['cancelled', 'timed_out']);
const runnerLoss = /\blost communication\b|\b(?:self-hosted[ \t]+)?runner[ \t]+(?:(?:has|was|is)[ \t]+)?(?:disconnected|went away|lost connection|stopped responding|failed to (?:start|connect))\b/i;
const timeout = /\b(?:job|execution|operation) (?:has )?(?:exceeded|timed out)|\bexceeded (?:the )?(?:maximum execution time|time limit)|\bjob was canceled because it exceeded\b/i;
const intrinsicFailure = /assert|expected|\bexpect\(|\btests?\b|✗|×|\bFAIL\b|process completed with exit code [1-9]\d*/i;
const summarySteps = new Map([['test', 'Gate on shard results'], ['coverage-merge', 'Require successful shards']]);
const local = name => typeof name === 'string' ? name.split(' / ').at(-1) : name;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const outputText = check => [check.output?.title, check.output?.summary, check.output?.text]
  .filter(value => typeof value === 'string').join('\n');
const infraText = text => runnerLoss.test(text) || timeout.test(text);

/** `undefined` leaves unrelated evidence on its existing path; a declined candidate never falls back.
 * Every read spends the caller's shared tick budget. No log/annotation pagination or unbounded scan.
 */
export function readMqInfraJobs({ checks, repo, commit, removedAt, aggregateJobs, readJson, readLog }) {
  const failed = checks.filter(check => !passing.has(check.conclusion));
  // A merge-gate HOLD has its own whole-log/freeze proof and still requires main green.
  if (failed.some(check => local(check.name) === 'merge-gate' && check.conclusion === 'failure')) return undefined;
  const decline = why => ({ logReason: `${why}; operator must inspect failed jobs and enqueue manually` });
  const candidate = failed.some(check => cancelled.has(check.conclusion) || infraText(outputText(check))
    || !aggregateJobs.includes(local(check.name)) && check.output?.annotations_count > 0);
  let workflow;
  const durationTimeout = job => {
    if (!cancelled.has(job.conclusion) || job.steps.some(step => step.conclusion === 'failure')) return false;
    const start = stamp(job?.started_at), end = stamp(job?.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
    if (!workflow) {
      // Actions jobs expose timestamps, not timeout-minutes. Read the exact tested workflow,
      // never the checkout's current configuration or an assumed default timeout.
      const file = readJson(`contents/.github/workflows/ci.yml?ref=${commit}`);
      if (file?.type !== 'file' || file.encoding !== 'base64' || !Number.isSafeInteger(file.size)
        || file.size < 1 || file.size > 128 * 1024 || typeof file.content !== 'string'
        || file.content.length > 180 * 1024) throw new Error('workflow timeout evidence exceeds 128-KiB limit or is incomplete');
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.length !== file.size) throw new Error('workflow timeout evidence incomplete');
      workflow = yaml.safeLoad(bytes.toString('utf8'), { schema: yaml.JSON_SCHEMA });
      if (!workflow?.jobs || typeof workflow.jobs !== 'object') throw new Error('workflow timeout evidence incomplete');
    }
    const matches = Object.entries(workflow.jobs).filter(([key, config]) => config && typeof config === 'object'
      && (key === local(job.name) || config.name === local(job.name)));
    const minutes = matches.length === 1 ? matches[0][1]['timeout-minutes'] : null;
    return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 && end - start >= minutes * 60_000;
  };
  if (!candidate) return undefined;
  if (failed.length > 10) return decline('failed-job count exceeds 10-job limit');
  if (checks.some(check => check.status !== 'completed')) return decline('job evidence unreadable or incomplete');
  // Reuse the attempt validator, including its strict before-removal boundary and failed-rerun veto.
  const attempts = inspectMqReruns({ checks: checks.map(check => passing.has(check.conclusion)
    ? check : { ...check, conclusion: 'failure' }), repo, commit, removedAt });
  if (attempts.reason || attempts.confirmed !== true && attempts.candidates.length !== failed.length)
    return decline(attempts.reason || 'job attempt evidence unreadable or incomplete');
  try {
    const runs = new Map(), intrinsicRuns = new Set(), derivedRuns = new Set();
    const infraNames = [], derivedNames = [];
    for (const check of failed) {
      const identity = mqActionsJob(check, repo);
      const job = readJson(`actions/jobs/${identity.id}`);
      if (!runs.has(identity.run)) runs.set(identity.run, readJson(`actions/runs/${identity.run}`));
      const run = runs.get(identity.run);
      const start = stamp(job?.started_at), end = stamp(job?.completed_at);
      if (run?.id !== Number(identity.run) || run.path !== '.github/workflows/ci.yml'
        || run.event !== 'merge_group' || run.head_sha !== commit || run.status !== 'completed'
        || !['failure', 'cancelled', 'timed_out'].includes(run.conclusion)
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
        // GitHub may finalize the workflow after ejecting the PR. Job/check completion
        // must precede removal; the run must be complete when read, on the same attempt.
        || !Number.isFinite(stamp(run.updated_at)) || stamp(run.updated_at) < end
        || job?.id !== identity.id || job.run_id !== run.id || job.run_attempt !== run.run_attempt
        || job.head_sha !== commit || local(job.name) !== local(check.name) || job.status !== 'completed'
        || !(job.conclusion === check.conclusion || cancelled.has(job.conclusion) && cancelled.has(check.conclusion))
        || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end >= removedAt
        || !Array.isArray(job.steps) || !job.steps.length
        || job.steps.some(step => typeof step?.name !== 'string' || step.status !== 'completed'
          || ![...passing, 'failure', ...cancelled].includes(step.conclusion)))
        return decline('job/run evidence unreadable, mismatched or incomplete');
      const gate = aggregateJobs.includes(local(check.name)) ? summarySteps.get(local(check.name)) : undefined;
      if (job.conclusion === 'failure' && gate
        && job.steps.filter(step => step.name === gate).length === 1
        && job.steps.filter(step => step.conclusion === 'failure').length === 1
        && job.steps.every(step => passing.has(step.conclusion) || step.name === gate && step.conclusion === 'failure')) {
        derivedNames.push(check.name);
        derivedRuns.add(run.id);
        continue;
      }
      if (intrinsicFailure.test(outputText(check))) return decline('non-infrastructure failed job');
      let annotationText = '';
      const count = check.output?.annotations_count ?? 0;
      if (!Number.isSafeInteger(count) || count < 0 || count > 100)
        return decline('annotation evidence exceeds 100-entry limit or is incomplete');
      if (count) {
        const annotations = readJson(`check-runs/${check.id}/annotations?per_page=100`);
        if (!Array.isArray(annotations) || annotations.length !== count
          || annotations.some(annotation => typeof annotation?.message !== 'string'))
          return decline('annotation evidence unreadable or incomplete');
        annotationText = annotations.map(annotation => annotation.message).join('\n');
      }
      const text = `${outputText(check)}\n${annotationText}`;
      if (intrinsicFailure.test(text)) return decline('non-infrastructure failed job');
      const needsText = !cancelled.has(job.conclusion) || job.steps.some(step => step.conclusion === 'failure');
      if (needsText) {
        // Failure conclusions/steps require positive text and a whole bounded log; elapsed time cannot suffice.
        const log = readLog(`actions/jobs/${identity.id}/logs`);
        if (typeof log !== 'string' || !log.trim() || Buffer.byteLength(log) >= 4 * 1024 * 1024)
          return decline('job log evidence unreadable or incomplete');
        if (intrinsicFailure.test(log) || !(infraText(text) || infraText(log)))
          return decline('non-infrastructure failed job');
      } else if (!(infraText(text) || job.steps.some(step => cancelled.has(step.conclusion)) || durationTimeout(job))) {
        return decline('non-infrastructure failed job');
      }
      infraNames.push(check.name);
      intrinsicRuns.add(run.id);
    }
    if (!infraNames.length || [...derivedRuns].some(run => !intrinsicRuns.has(run)))
      return decline('derived aggregate has no infrastructure job in the same run');
    const safe = name => name.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
    return { infra: 'infra-jobs', infraNames: infraNames.map(safe), derivedNames: derivedNames.map(safe) };
  } catch (error) {
    return decline(error?.message?.startsWith('workflow timeout evidence') ? error.message
      : 'job/run evidence unreadable or incomplete (shared API budget may be exhausted)');
  }
}
