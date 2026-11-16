/** Complete read-and-verify boundary for review-gate publication. Unknown evidence holds. */
import { runGhSync } from './gh-throttle.mjs';
import { REVIEW_HOLD_LABELS } from './review-labels.mjs';

const NO = reason => Object.freeze({ publish: false, reason });
const positive = n => Number.isSafeInteger(n) && n > 0;
const strings = a => Array.isArray(a) && a.every(s => typeof s === 'string' && s.length > 0);
const sorted = a => [...new Set(a)].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameRepo = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const PREFIX = 'review-gate-verdict/v1 ';
// CI-mode import closure. The optional manual --pr reader is not loaded in CI.
const GATE_PATHS = ['scripts/check-review-gate.mjs', 'scripts/lib/review-labels.mjs', 'scripts/lib/write-all-sync.mjs'];

/** Omitted changedFiles uses the complete PR files API list; an explicit list must match it. */
export async function decidePublish(input, io) {
  try {
    const { repo, pr, head, liveLabels, changedFiles } = input;
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/.test(repo)
      || !positive(pr) || typeof head !== 'string' || !/^[a-fA-F0-9]{40}(?![\s\S])/.test(head)
      || !strings(liveLabels) || (changedFiles !== undefined && !strings(changedFiles))) return NO('invalid-input');
    const pullMatches = pull => pull?.state === 'open' && pull.head?.sha === head
      && sameRepo(pull.base?.repo?.full_name, repo) && Array.isArray(pull.labels)
      && pull.labels.every(l => typeof l?.name === 'string' && l.name.length > 0)
      && equal(sorted(pull.labels.map(l => l.name)), sorted(liveLabels));
    const pull = await io.getPull();
    if (!pullMatches(pull)) return NO('pull-binding-mismatch');
    const labels = sorted(pull.labels.map(l => l.name));
    const files = await io.listPullFiles();
    if (!Number.isSafeInteger(pull.changed_files) || pull.changed_files < 0 || pull.changed_files >= 3000
      || !Array.isArray(files) || files.length !== pull.changed_files
      || files.some(f => typeof f?.filename !== 'string' || !f.filename
        || (f.previous_filename !== undefined && (typeof f.previous_filename !== 'string' || !f.previous_filename)))) return NO('files-incomplete');
    const paths = sorted(files.flatMap(f => [f.filename, ...(f.previous_filename === undefined ? [] : [f.previous_filename])]));
    if (changedFiles !== undefined && !equal(paths, sorted(changedFiles))) return NO('caller-files-differ');
    if (paths.some(p => p.startsWith('.github/') || GATE_PATHS.includes(p))) return NO('gate-file-edit');
    // Validate all rows before filtering, including unrelated workflows and repositories.
    const select = data => {
      if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0
        || !Array.isArray(data.workflow_runs) || data.workflow_runs.length !== data.total_count) return null;
      const rows = data.workflow_runs;
      if (rows.some(r => !positive(r?.id) || !positive(r.run_number) || !positive(r.run_attempt)
        || typeof r.created_at !== 'string' || !Number.isFinite(Date.parse(r.created_at))
        || !['event', 'path', 'head_sha', 'status'].every(k => typeof r[k] === 'string')
        || typeof r.repository?.full_name !== 'string' || !Array.isArray(r.pull_requests)
        || r.pull_requests.some(p => !positive(p?.number))) || new Set(rows.map(r => r.id)).size !== rows.length) return null;
      const candidates = rows.filter(r => r.event === 'pull_request' && r.path === '.github/workflows/review-gate.yml'
        && r.head_sha === head && sameRepo(r.repository.full_name, repo) && r.pull_requests.some(p => p.number === pr))
        .sort((a, b) => a.run_number - b.run_number);
      if (candidates.some((r, i) => i > 0 && (r.run_number === candidates[i - 1].run_number
        || Date.parse(r.created_at) < Date.parse(candidates[i - 1].created_at)))) return null;
      return candidates.at(-1) ?? null;
    };
    const run = select(await io.listGateRuns());
    if (!run) return NO('no-valid-run');
    if (run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion)) return NO('latest-incomplete');
    // Snapshot primitives: a mutable IO response must not alter the race comparison.
    const identity = r => [r.id, r.run_attempt, r.status, r.conclusion];
    const selected = identity(run);
    const jobs = await io.listAttemptJobs(run.id, run.run_attempt);
    if (jobs?.total_count !== 1 || !Array.isArray(jobs.jobs) || jobs.jobs.length !== 1) return NO('jobs-incomplete');
    const job = jobs.jobs[0];
    if (!positive(job?.id) || job.name !== 'review-gate' || job.run_id !== run.id || job.run_attempt !== run.run_attempt
      || job.head_sha !== head || job.status !== 'completed' || job.conclusion !== run.conclusion) return NO('job-binding-mismatch');
    if (!Array.isArray(job.steps) || job.steps.filter(s => s?.name === 'review-gate verdict').length !== 1
      || job.steps.some(s => s?.status !== 'completed' || s.conclusion !==
        (run.conclusion === 'failure' && s.name === 'review-gate verdict' ? 'failure' : 'success'))) return NO('steps-unproven');
    const log = await io.getJobLog(job.id);
    if (typeof log !== 'string' || Buffer.byteLength(log) > 1024 * 1024) return NO('log-unreadable-or-oversized');
    const lines = log.split(/\r?\n/).map(l => l.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /, '')).filter(l => l.startsWith(PREFIX));
    if (lines.length !== 1) return NO('marker-count');
    const marker = JSON.parse(lines[0].slice(PREFIX.length));
    const keys = ['v', 'repo', 'pr', 'head', 'runId', 'runAttempt', 'event', 'labels', 'verdict', 'holdLabels'];
    if (!marker || !equal(Object.keys(marker).sort(), keys.sort()) || marker.v !== 1 || !sameRepo(marker.repo, repo)
      || marker.pr !== pr || marker.head !== head || marker.runId !== run.id || marker.runAttempt !== run.run_attempt
      || marker.event !== 'pull_request' || !equal(marker.labels, labels)) return NO('marker-binding-mismatch');
    const holds = labels.filter(l => REVIEW_HOLD_LABELS.includes(l));
    const verdict = holds.length ? 'hold' : 'clear';
    if (!equal(marker.holdLabels, holds) || marker.verdict !== verdict
      || run.conclusion !== (holds.length ? 'failure' : 'success')) return NO('marker-verdict-mismatch');
    if (!pullMatches(await io.getPull())) return NO('pull-changed');
    const latest = select(await io.listGateRuns());
    if (!latest || !equal(selected, identity(latest))) return NO('latest-run-changed');
    return Object.freeze({ publish: true, reason: holds.length ? 'verified-hold' : 'verified-clear' });
  } catch { return NO('unreadable-evidence'); }
}

/** GET-only transport. Pagination preserves counts so the decision checks completeness. */
export function createGhPublishIo({ repo, pr, head }, { runGh = runGhSync } = {}) {
  // Both subprocess routing and the throttle's optional read memo must see fresh-read policy.
  const env = { ...process.env, WE_GH_READ_MEMO_DIR: '' };
  const read = (path, flags = []) => runGh(['api', ...flags, path], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env, throttle: { env },
  });
  const json = (path, flags) => JSON.parse(read(path, flags));
  const paged = (path, key) => {
    const pages = json(path, ['--paginate', '--slurp']);
    if (!Array.isArray(pages) || !pages.length || pages.some(p => !Array.isArray(p?.[key])
      || !Number.isSafeInteger(p.total_count) || p.total_count !== pages[0].total_count)) return null;
    return { total_count: pages[0].total_count, [key]: pages.flatMap(p => p[key]) };
  };
  const base = `repos/${repo}`;
  return {
    getPull: () => json(`${base}/pulls/${pr}`),
    listPullFiles: () => {
      const pages = json(`${base}/pulls/${pr}/files?per_page=100`, ['--paginate', '--slurp']);
      return Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : null;
    },
    listGateRuns: () => paged(`${base}/actions/workflows/review-gate.yml/runs?event=pull_request&head_sha=${head}&per_page=100`, 'workflow_runs'),
    listAttemptJobs: (id, attempt) => json(`${base}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`),
    getJobLog: id => read(`${base}/actions/jobs/${id}/logs`),
  };
}
