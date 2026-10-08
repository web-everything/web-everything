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
/** The only reasons an ESCALATE payload may carry besides the default "hung again" (a second hang on the head after
 *  the automatic re-run). Each says WHY the check is stuck and what to look at; any other value is dropped, never
 *  echoed. Kept in step with `ESCALATION_REASONS` in `ci-queue-watch.mjs` (a test pins that they agree). */
const REASONS = {
  'cancel-refused': {
    summary: ({ repo, pr, check, inProgressMin, thresholdMin }) => `${repo}#${pr} check "${check}" hung (${inProgressMin} min in progress, threshold ${thresholdMin} min) and GitHub refused to cancel its run; the check stays hung.`,
    recommendation: ({ log }) => `GitHub refused to cancel the hung run, so it will wait for GitHub's own timeout: look at the run (${log}) and the App's actions permission, and fix the cause; do not re-run it by hand.`,
  },
  'force-cancel-refused': {
    summary: ({ repo, pr, check, inProgressMin, thresholdMin }) => `${repo}#${pr} check "${check}" was cancelled as hung (${inProgressMin} min since it started, threshold ${thresholdMin} min), the run kept running, and GitHub refused to force-cancel it; the check stays hung.`,
    recommendation: ({ log }) => `GitHub refused the force-cancel, so the run will wait for GitHub's own timeout: look at the run (${log}) and the App's actions permission, and fix the cause; do not re-run it by hand.`,
  },
  'cancel-did-not-take': {
    summary: ({ repo, pr, check, inProgressMin, thresholdMin }) => `${repo}#${pr} check "${check}" was cancelled and force-cancelled as hung (${inProgressMin} min since it started, threshold ${thresholdMin} min), but its run is still not complete; the check stays hung.`,
    recommendation: ({ log }) => `Neither the cancel nor the force-cancel ended the run, so only GitHub's own timeout will: look at the run (${log}) and tell GitHub support if it recurs; do not re-run it by hand.`,
  },
  'rerun-refused': {
    summary: ({ repo, pr, check, inProgressMin, thresholdMin }) => `${repo}#${pr} check "${check}" hung (${inProgressMin} min in progress, threshold ${thresholdMin} min) and GitHub refused to re-run it; the check stays hung.`,
    recommendation: ({ log }) => `GitHub refused to re-run the hung job or its run: look at the run (${log}) and the App's actions permission, and fix the cause; do not re-run it by hand.`,
  },
  'run-unreadable': {
    summary: ({ repo, pr, check, inProgressMin, thresholdMin }) => `${repo}#${pr} check "${check}" was cancelled as hung (${inProgressMin} min since it started, threshold ${thresholdMin} min) but its run could not be read back from GitHub, so the recovery is stuck.`,
    recommendation: ({ log }) => `GitHub permanently refuses to return the run, so the sweep can neither re-run nor clear it: look at the run (${log}) and the App's actions permission, and fix the cause; do not re-run it by hand.`,
  },
  'rerun-refused-after-cancel': {
    summary: ({ repo, pr, check, inProgressMin, thresholdMin }) => `${repo}#${pr} check "${check}" was cancelled as hung (${inProgressMin} min since it started, threshold ${thresholdMin} min) and its re-run was refused after it was cancelled; the check stays cancelled.`,
    recommendation: ({ log }) => `GitHub refused to re-run the cancelled run, so the required check stays cancelled and the PR stays blocked: look at the run (${log}) and the App's actions permission, and fix the cause; do not re-run it by hand.`,
  },
};

/** The reason ids this smell words — a test pins that they equal `ESCALATION_REASONS` in `ci-queue-watch.mjs`. */
export const KNOWN_REASONS = Object.freeze(Object.keys(REASONS));

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
    ...(typeof p.reason === 'string' && Object.hasOwn(REASONS, p.reason) ? { reason: p.reason } : {}),
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
        const text = reason ? REASONS[reason] : null;
        const view = { repo, pr, check, inProgressMin, thresholdMin, log };
        results.set(subject, {
          subject,
          breach: true,
          measure: { repo, pr, headSha, check, runId, jobId, inProgressMin, thresholdMin, reruns, ...(reason ? { reason } : {}), daemon: sample.name },
          summary: text
            ? text.summary(view)
            : `${repo}#${pr} check "${check}" hung again (${inProgressMin} min in progress, threshold ${thresholdMin} min) after ${reruns} automatic re-run(s).`,
          recommendation: text
            ? text.recommendation(view)
            : `The automatic re-run did not clear it, so this is not a one-off GitHub glitch: look at the job's own log (${log}) and fix the cause in the workflow or the product; do not re-run it by hand.`,
        });
      }
    }
    return [...results.values()];
  },
};
