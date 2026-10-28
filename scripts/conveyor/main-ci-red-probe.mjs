/**
 * @file scripts/conveyor/main-ci-red-probe.mjs
 * @description Read-only main CI evidence, shared by the operator queue and main-red owner.
 * Keep owner dispatch and ledger writes in main-ci-red-io.mjs so read-only callers do not
 * inherit the dispatch graph in their import closure.
 */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import {
  mainCiRedSettings, mainRedState, classifyRun, hexSha, parseVitestFailures,
  classifyFlakeRun, findMergeGroupFlakeEvidence, mainCiRedSettingSource,
} from './main-ci-red-core.mjs';

/** Main's repo: the WE entry of the constellation registry (never a hand-typed slug). */
export const DEFAULT_REPO_SLUG = CONSTELLATION_REPOS.we.slug;
const OPEN_PR_LIMIT = 300;
const MAX_JOB_READS = 4;
/** How many extra job reads the first-red-run check may spend stepping past infra-only runs at the front of the window. */
const MAX_FIRST_RED_READS = 8;

function ghJson(exec, argv) {
  const out = exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  if (isGhDeferred(out)) throw new Error('gh read deferred (low budget)');
  return JSON.parse(String(out || 'null'));
}

/** Read raw Actions log text, refusing a deferred GitHub read. */
export function readJobLog(jobId, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  const out = exec('gh', ['api', `repos/${repoSlug}/actions/jobs/${jobId}/logs`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  if (isGhDeferred(out)) throw new Error('gh log read deferred (low budget)');
  return String(out ?? '');
}

/** Read the compare's changed paths; both refs must be hex commit IDs. */
export function readChangedFiles(base, head, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  if (!hexSha(base) || !hexSha(head)) throw new Error('invalid compare sha');
  const files = ghJson(exec, ['api', `repos/${repoSlug}/compare/${base}...${head}`, '--jq', '[.files[].filename]']);
  if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) throw new Error('compare returned no file list');
  return files;
}

/**
 * Jobs of one run: `{complete, failed:[{id,name}], passed:[name]}`. A job that was only cancelled is not failing; and
 * only a job whose conclusion is `success` is in `passed` — skipped, cancelled, neutral and not-yet-finished jobs are
 * neither (review round 1, F5: they are not evidence that anything was fixed).
 */
export function readRunJobs(runId, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  const page = ghJson(exec, ['api', `repos/${repoSlug}/actions/runs/${runId}/jobs?per_page=100`]);
  const jobs = Array.isArray(page?.jobs) ? page.jobs : [];
  const complete = Number.isInteger(page?.total_count) && page.total_count === jobs.length;
  return {
    complete,
    count: jobs.length,
    failed: jobs.filter((j) => ['failure', 'timed_out'].includes(String(j.conclusion))).map((j) => ({ id: j.id, name: j.name })),
    passed: jobs.filter((j) => String(j.conclusion) === 'success').map((j) => String(j.name)),
  };
}

/** Failing test titles from one job's check-run annotations (CI output — untrusted text, quoted later). */
export function readFailingTests(jobId, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  const rows = ghJson(exec, ['api', `repos/${repoSlug}/check-runs/${jobId}/annotations?per_page=50`]);
  return (Array.isArray(rows) ? rows : [])
    .filter((a) => a?.annotation_level === 'failure' && a.path && a.path !== '.github')
    .map((a) => String(a.title || a.path).slice(0, 300));
}

/** Read the current main commit and its checks best-effort; any unreadable fact leaves the runs-only rule in charge. */
export function readMainTip({ exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG, settings = mainCiRedSettings(), runs = [], requiredChecks,
  readRequired = getRequiredStatusChecks } = {}) {
  try {
    // --jq .sha emits plain text, so quote that result for the guarded JSON reader.
    const sha = ghJson((bin, argv, opts) => {
      const out = exec(bin, argv, opts);
      return isGhDeferred(out) ? out : JSON.stringify(String(out).trim());
    }, ['api', `repos/${repoSlug}/commits/${settings.mainCiRedBranch}`, '--jq', '.sha']);
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;
    const checksOf = (commit) => {
      const page = ghJson(exec, ['api', `repos/${repoSlug}/commits/${commit}/check-runs?per_page=100`]);
      if (!Array.isArray(page?.check_runs)) throw new Error('main check-runs read returned no list');
      return page.check_runs.map(({ id, name, status, conclusion }) => ({ id, name, status, conclusion }));
    };
    const checks = requiredChecks ?? readRequired({ repo: repoSlug }).checks;
    if (!Array.isArray(checks) || !checks.length) return null;
    const newest = [...runs].filter((r) => r.headSha === sha).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const tip = { sha, runStatus: newest?.status ?? null, checkRuns: checksOf(sha), requiredChecks: checks };
    const state = mainRedState(runs);
    if (state.status === 'red' && state.latestRed.sha !== sha) tip.redCheckRuns = checksOf(state.latestRed.sha);
    return tip;
  } catch { return null; }
}

/**
 * Main's CI workflow runs (by WORKFLOW, never across all workflows — card xfrjlsi), with recent failures checked for
 * "only cancelled / no runner" (`infraOnly`, not a code failure), plus the failing jobs and tests of the latest real
 * red run. Throws on an unreadable runs read (= unknown).
 */
export function probeMainCiRuns({ exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG, config = {}, settings = mainCiRedSettings(config), readRequired = getRequiredStatusChecks } = {}) {
  const list = (limit) => ghJson(exec, ['run', 'list', '--repo', repoSlug, '--workflow', settings.mainCiRedWorkflow, '--branch', settings.mainCiRedBranch,
    '--limit', String(limit), '--json', 'databaseId,conclusion,status,createdAt,updatedAt,headSha,event,workflowName,attempt']);
  let runs = list(settings.mainCiRedRunLimit);
  if (!Array.isArray(runs)) throw new Error('main CI runs read returned no list');
  // No green run in a full first page: read deeper once, so the FIRST red commit (the dedupe key) is the real one.
  if (runs.length >= settings.mainCiRedRunLimit && !runs.some((r) => classifyRun(r) === 'green') && settings.mainCiRedRunLimitMax > settings.mainCiRedRunLimit) {
    const deeper = list(settings.mainCiRedRunLimitMax);
    if (Array.isArray(deeper)) runs = deeper;
  }
  const sorted = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const failing = { jobs: [], tests: [] };
  // One job read per run, however many passes below look at it. `null` = unreadable (stays red: never promoted on a blind read).
  const jobsRead = new Map();
  const jobsOf = (r) => {
    if (!jobsRead.has(r.databaseId)) {
      let jobs = null;
      try { jobs = readRunJobs(r.databaseId, { exec, repoSlug }); } catch { jobs = null; }
      jobsRead.set(r.databaseId, jobs);
    }
    return jobsRead.get(r.databaseId);
  };
  // A failure whose job list is complete, NON-EMPTY and holds no failed job (only cancelled / never ran) is infra, not
  // code. An empty list is not infra: a `startup_failure` run (a broken workflow file) has zero jobs and IS the defect.
  const markInfraOnly = (r, jobs) => { if (jobs && jobs.complete && jobs.count > 0 && jobs.failed.length === 0) { r.infraOnly = true; return true; } return false; };
  let failingRun = null;
  let reads = 0;
  for (const r of sorted) {
    const v = classifyRun(r);
    if (v === 'green') break; // only the current red window matters
    if (v !== 'red' || reads >= MAX_JOB_READS) continue;
    reads += 1;
    const jobs = jobsOf(r);
    if (markInfraOnly(r, jobs)) continue;
    if (jobs && !failingRun) {
      failingRun = r;
      failing.jobs = jobs.failed.map((j) => j.name);
      for (const j of jobs.failed.slice(0, 2)) {
        try { failing.tests.push(...readFailingTests(j.id, { exec, repoSlug })); } catch { /* jobs alone still name the failure */ }
      }
      failing.runId = r.databaseId;
    }
  }
  // Review round 1 (F2): the failing-job read above covers the NEWEST red runs, but `mainRedState` names the OLDEST red
  // run after the last green one as the first red commit (the owner ledger key, the episode subject, the brief). If that
  // run — or the next ones — failed only through cancelled jobs / runner loss it is not a code failure: check the
  // candidate itself, step forward past every infra-only one, and stop at the first run that is genuinely red (or whose
  // jobs cannot be read — that stays red, never promoted on a blind read). Bounded by MAX_FIRST_RED_READS.
  for (let i = 0; i < MAX_FIRST_RED_READS; i += 1) {
    const st = mainRedState(sorted);
    if (st.status !== 'red') break;
    const candidate = sorted.find((r) => r.databaseId === st.firstRed.runId);
    if (!candidate || jobsRead.has(candidate.databaseId)) break; // already inspected: genuine, or unreadable
    if (!markInfraOnly(candidate, jobsOf(candidate))) break;
  }
  const tip = readMainTip({ exec, repoSlug, settings, runs: sorted, readRequired });
  if (settings.mainCiRedFlakeRerun && failingRun) {
    // Rerun evidence is best-effort: unreadable logs/diffs never poison the primary runs probe.
    failing.failures = null;
    try {
      const jobs = jobsOf(failingRun).failed.filter((j) => !settings.mainCiRedSummaryJobs.includes(j.name)).slice(0, 2);
      failing.failures = jobs.flatMap((j) => parseVitestFailures(readJobLog(j.id, { exec, repoSlug })));
    } catch { failing.failures = null; }
    const previous = sorted.slice(sorted.indexOf(failingRun) + 1).find((r) => r.status === 'completed' && classifyRun(r) !== 'ignore');
    failing.prevRunGreen = !!previous && classifyRun(previous) === 'green';
    const classify = () => classifyFlakeRun({ run: failingRun, failedJobs: failing.jobs, failures: failing.failures,
      prevRunGreen: failing.prevRunGreen, changedFiles: failing.changedFiles, groupEvidence: failing.groupEvidence, settings });
    if (!classify().eligible && failing.prevRunGreen && settings.mainCiRedRerunUnrelatedChange) {
      try { failing.changedFiles = readChangedFiles(previous.headSha, failingRun.headSha, { exec, repoSlug }); }
      catch { failing.changedFiles = null; }
    }
    // card 303: one list read and at most two complete job reads; evidence never clears main red.
    failing.groupEvidence = null;
    if (settings.mainCiRedMergeGroupFlakeEvidence && settings.mainCiRedMergeGroupRunLimit > 0 && tip?.sha) {
      try {
        const groupRuns = ghJson(exec, ['run', 'list', '--repo', repoSlug, '--workflow', settings.mainCiRedWorkflow,
          '--event', 'merge_group', '--limit', String(settings.mainCiRedMergeGroupRunLimit), '--json',
          'databaseId,conclusion,status,createdAt,updatedAt,headBranch,headSha,event,attempt']);
        let groupReads = 0;
        failing.groupEvidence = findMergeGroupFlakeEvidence({ groupRuns, tipSha: tip.sha, failedJobs: failing.jobs, settings,
          jobsOf: (runId) => {
            if (groupReads >= 2) return null;
            groupReads += 1;
            return readRunJobs(runId, { exec, repoSlug });
          } });
      } catch { failing.groupEvidence = null; }
      if (failing.groupEvidence) {
        const e = failing.groupEvidence;
        process.stderr.write(`main-ci-red: flake evidence — merge-group run ${e.runId} (${e.headBranch}) passed ${e.coveredJobs.join(', ')} on main tip ${tip.sha.slice(0, 9)} (setting mainCiRedMergeGroupFlakeEvidence=${settings.mainCiRedMergeGroupFlakeEvidence}, source ${mainCiRedSettingSource(config, 'mainCiRedMergeGroupFlakeEvidence')})\n`);
      }
    }
    failing.flake = { runId: failingRun.databaseId, sha: failingRun.headSha, ...classify(), groupEvidence: failing.groupEvidence };
  }
  return { runs: sorted, failing, ...(tip ? { tip } : {}) };
}

/**
 * One fix PR's CI for the combine rule: its latest FINISHED ci.yml run on the PR head, with a complete job list.
 * `{status:'green'|'red'|'inconclusive'|'pending'|'missing'|'unknown', failedJobs}` — completed runs without a verdict
 * are inconclusive; a successful lookup with no current-head runs is missing. Neither proves CI is in flight
 * or proves any job fixes to the combine rule. Unreadable responses remain unknown.
 */
export function readFixPrCi(pr, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG, settings = mainCiRedSettings() } = {}) {
  try {
    // Filter before the server's limit: other heads must not crowd this head's runs out of the sample.
    const runs = ghJson(exec, ['run', 'list', '--repo', repoSlug, '--workflow', settings.mainCiRedWorkflow, '--branch', String(pr.headRefName),
      ...(pr.headRefOid ? ['--commit', String(pr.headRefOid)] : []),
      '--limit', '5', '--json', 'databaseId,conclusion,status,createdAt,updatedAt,headSha']);
    if (!Array.isArray(runs)) return { status: 'unknown', failedJobs: [] };
    const headRuns = runs.filter((r) => !pr.headRefOid || r.headSha === pr.headRefOid);
    if (!headRuns.length) return { status: 'missing', failedJobs: [], completedAt: null };
    const done = headRuns.filter((r) => r.status === 'completed')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    // card 302: a newer in-flight run supersedes the finished verdict for progress.
    const pending = headRuns.some((r) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(r.status)
      && (!done || Date.parse(r.createdAt) >= Date.parse(done.createdAt)));
    const progress = { completedAt: done?.updatedAt ?? null, ...(pending ? { pending: true } : {}) };
    if (pending) return { status: 'pending', failedJobs: [], ...progress };
    if (!done) return { status: 'unknown', failedJobs: [], ...progress };
    if (classifyRun(done) === 'ignore') return { status: 'inconclusive', failedJobs: [], ...progress };
    if (classifyRun(done) === 'green') {
      // A green run can still have skipped jobs, so read the jobs: only the ones that SUCCEEDED prove a fix (F5). An
      // unreadable job list leaves the PR green with no proof — it can then fix nothing, but it is not "unknown".
      let passedJobs = [];
      try { passedJobs = readRunJobs(done.databaseId, { exec, repoSlug }).passed; } catch { passedJobs = []; }
      return { status: 'green', failedJobs: [], passedJobs, ...progress };
    }
    let jobs;
    try { jobs = readRunJobs(done.databaseId, { exec, repoSlug }); }
    catch { return { status: 'unknown', failedJobs: [], ...progress }; }
    return jobs.complete ? { status: 'red', failedJobs: jobs.failed.map((j) => j.name), passedJobs: jobs.passed, ...progress } : { status: 'unknown', failedJobs: [], ...progress };
  } catch { return { status: 'unknown', failedJobs: [] }; }
}

/** Open PRs for the owner check, or `null` when unreadable or possibly cut off (= ownership unknown). */
export function readOpenPrsForOwner({ exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  try {
    const rows = ghJson(exec, ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,body,headRefName,headRefOid,createdAt,state,author,labels']);
    if (!Array.isArray(rows) || rows.length >= OPEN_PR_LIMIT) return null;
    return rows;
  } catch { return null; }
}

