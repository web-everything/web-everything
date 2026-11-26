/** Shared main-CI evidence: preserve the merge gate's push-only reader and infrastructure proof. */
import { execFileSync } from 'node:child_process';
import { MAIN_CI_RED_DEFAULTS, classifyRun } from '../conveyor/main-ci-red-core.mjs';
import { markInfraOnlyRuns } from './main-ci-infra-runs.mjs';
/** Enough main runs to find the last green behind a short red streak. */
const MAIN_CI_RUNS = 30;
const firstLine = e => String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);

export function settledAt(runs) {
  const times = (Array.isArray(runs) ? runs : []).filter(r => String(r?.status).toLowerCase() === 'completed' && classifyRun(r) !== 'ignore')
    .map(r => Date.parse(r.updatedAt ?? '')).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export function readMainCiRuns({ repo, defaultBranch = 'main', exec = execFileSync, workflow = MAIN_CI_RED_DEFAULTS.mainCiRedWorkflow }) {
  const source = `${workflow}@${defaultBranch}`;
  let runs;
  try {
    // `--event push`: only runs OF main's own commits. A fork PR whose head branch is also named `main` makes ci.yml
    // runs with headBranch `main` (from the fork's own, editable workflow file); counting those would let a green
    // fork run hide a red main.
    runs = JSON.parse(exec('gh', ['run', 'list', '--repo', repo, '--workflow', workflow, '--branch', defaultBranch, '--event', 'push', '--limit', String(MAIN_CI_RUNS),
      '--json', 'databaseId,conclusion,status,createdAt,updatedAt,headSha,event,attempt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }) || 'null');
  } catch (e) { return { source, error: `main CI unreadable: ${firstLine(e)}` }; }
  if (Array.isArray(runs)) {
    runs = runs.filter((r) => r?.event == null || r.event === 'push'); // belt and braces if a gh version ignores --event
    // A RE-RUN puts a finished run back in progress, and an in-progress run is ignored, so the run before it (maybe
    // green) would speak for a commit whose verdict is being redone. Undecided → hold.
    const rerun = runs.find((r) => String(r?.status ?? '').toLowerCase() !== 'completed' && Number(r?.attempt) > 1);
    if (rerun) return { source, runs, error: `main CI run ${rerun.databaseId ?? '?'} is being re-run (attempt ${Number(rerun.attempt)}) — verdict pending` };
  }
  if (Array.isArray(runs)) {
    try { markInfraOnlyRuns(runs, { repo, exec }); } catch { /* unreadable job evidence stays red */ }
  }
  return { source, runs, settledAt: settledAt(runs) };
}
