/**
 * ci-job-hung — we:backlog/xncfkf2. On 2026-10-08, PR #4450's required `daemon-soak` job sat
 * in_progress for 90+ minutes with nothing noticing. `ci-queue-watch.mjs#sweepHungJobs` now
 * cancels/re-runs a hung check once per PR/head/check and emits ESCALATE on every sweep of a
 * SECOND hang on the same head after that automatic re-run. This smell is the [high] escalation:
 * inspect the job's own log and fix the cause rather than spending another manual re-run.
 */
const MARKER = 'ci-job-hung: ESCALATE ';

/** Parse escalation payload objects from daemon lines, ignoring prefixes and malformed JSON. */
export function parseEscalations(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const start = line.indexOf(MARKER);
    if (start === -1) continue;
    try {
      const payload = JSON.parse(line.slice(start + MARKER.length));
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) out.push(payload);
    } catch { /* A malformed log line must not interrupt the health tick. */ }
  }
  return out;
}

export default {
  id: 'ci-job-hung',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['daemonLogs'],
  openAfter: 1,
  closeAfter: 3,
  severity: 'high',
  action: 'alert',
  recommendationHint: 'A CI job hung again after its automatic re-run; inspect its own log and fix the cause in the workflow or the product; do not re-run it by hand.',
  evaluate({ daemonLogs } = {}) {
    const results = new Map();
    for (const sample of daemonLogs || []) {
      for (const payload of parseEscalations(sample.text)) {
        const { repo, pr, headSha, check, runId, jobId, inProgressMin, thresholdMin, reruns } = payload;
        const subject = `${repo}#${pr}:${check}`;
        results.set(subject, {
          subject,
          breach: true,
          measure: { repo, pr, headSha, check, runId, jobId, inProgressMin, thresholdMin, reruns, daemon: sample.name },
          summary: `${repo}#${pr} check "${check}" hung again (${inProgressMin} min in progress, threshold ${thresholdMin} min) after ${reruns} automatic re-run(s).`,
          recommendation: `The automatic re-run did not clear it, so this is not a one-off GitHub glitch: look at the job's own log (https://github.com/${repo}/actions/runs/${runId}/job/${jobId}) and fix the cause in the workflow or the product; do not re-run it by hand.`,
        });
      }
    }
    return [...results.values()];
  },
};
