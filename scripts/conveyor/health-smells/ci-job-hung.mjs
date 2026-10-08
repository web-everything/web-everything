/**
 * ci-job-hung — we:backlog/xncfkf2. On 2026-10-08, PR #4450's required `daemon-soak` job sat
 * in_progress for 90+ minutes with nothing noticing. `ci-queue-watch.mjs#sweepHungJobs` now
 * cancels/re-runs a hung check once per PR/head/check and emits ESCALATE on every sweep of a
 * SECOND hang on the same head after that automatic re-run, or of a recovery GitHub refused after
 * the cancel. This smell is the [high] escalation: inspect the job's own log and fix the cause
 * rather than spending another manual re-run.
 */
import { repoKeyForSlug, ghRepoSlug } from '../../lib/constellation-repos.mjs';

const MARKER = 'ci-job-hung: ESCALATE ';
const CHECK_NAME_MAX = 100;
/** The only recovery reason an ESCALATE payload may carry besides the default "hung again": the cancel landed but
 *  GitHub then refused the re-run, so the check stays cancelled. Any other value is dropped, never echoed. */
const REFUSED_AFTER_CANCEL = 'rerun-refused-after-cancel';

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/** A job name is chosen by the PR author, so it is shown but never trusted: NFKC-folded, control / format /
 *  line-separator characters (CR, LF, U+2028/9, bidi and zero-width marks) collapsed to a space, backticks and
 *  double quotes neutralised, length capped. Returns '' for nothing usable. */
function cleanCheckName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/`/g, "'").replace(/"/g, "'").replace(/[[\]<>@]/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .slice(0, CHECK_NAME_MAX).trim();
}

/** The payload `sweepHungJobs` really writes, or null. A daemon log may echo text an attacker chose, and the
 *  alert built from it is read by operators and the health responder — so anything off-shape is dropped, and the
 *  repo / ids that end up in the recommendation link are rebuilt from validated values only. */
function validateEscalation(p) {
  if (typeof p.repo !== 'string' || !repoKeyForSlug(p.repo)) return null;
  const check = cleanCheckName(p.check);
  if (!check || !isId(p.pr) || !isId(p.runId) || !isId(p.jobId)) return null;
  if (typeof p.headSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(p.headSha)) return null;
  if (!isCount(p.inProgressMin) || !isCount(p.thresholdMin) || !isCount(p.reruns)) return null;
  const { pr, headSha, runId, jobId, inProgressMin, thresholdMin, reruns } = p;
  return {
    repo: ghRepoSlug(p.repo), pr, headSha, check, runId, jobId, inProgressMin, thresholdMin, reruns,
    ...(p.reason === REFUSED_AFTER_CANCEL ? { reason: p.reason } : {}),
  };
}

/** Parse escalation payload objects from daemon lines, ignoring prefixes, malformed JSON and off-shape payloads. */
export function parseEscalations(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const start = line.indexOf(MARKER);
    if (start === -1) continue;
    try {
      const payload = JSON.parse(line.slice(start + MARKER.length));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const valid = validateEscalation(payload);
      if (valid) out.push(valid);
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
        const { repo, pr, headSha, check, runId, jobId, inProgressMin, thresholdMin, reruns, reason } = payload;
        const subject = `${repo}#${pr}:${check}`;
        const log = `https://github.com/${repo}/actions/runs/${runId}/job/${jobId}`;
        const refused = reason === REFUSED_AFTER_CANCEL;
        results.set(subject, {
          subject,
          breach: true,
          measure: { repo, pr, headSha, check, runId, jobId, inProgressMin, thresholdMin, reruns, ...(refused ? { reason } : {}), daemon: sample.name },
          summary: refused
            ? `${repo}#${pr} check "${check}" was cancelled as hung (${inProgressMin} min since it started, threshold ${thresholdMin} min) and its re-run was refused after it was cancelled; the check stays cancelled.`
            : `${repo}#${pr} check "${check}" hung again (${inProgressMin} min in progress, threshold ${thresholdMin} min) after ${reruns} automatic re-run(s).`,
          recommendation: refused
            ? `GitHub refused to re-run the cancelled run, so the required check stays cancelled and the PR stays blocked: look at the run (${log}) and the App's actions permission, and fix the cause; do not re-run it by hand.`
            : `The automatic re-run did not clear it, so this is not a one-off GitHub glitch: look at the job's own log (${log}) and fix the cause in the workflow or the product; do not re-run it by hand.`,
        });
      }
    }
    return [...results.values()];
  },
};
