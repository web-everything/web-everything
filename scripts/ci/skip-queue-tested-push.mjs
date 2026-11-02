#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
// Dependency-free modules only: the `changes` job runs this before any `npm ci`.
import { QUARANTINE_BRANCH, QUARANTINE_LIST_PATH, validateQuarantineList } from '../lib/red-main-quarantine.mjs';

const trackingRefspec = (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

export const MAX_RUNS_CHECKED = 20;
/** The quarantine list must predate the matched queue run by this much (tolerates committer clock skew). */
export const QUARANTINE_SETTLE_MS = 10 * 60 * 1000;
/** Each git/gh call is bounded; the workflow step adds its own overall timeout-minutes. */
const CALL_TIMEOUT_MS = 30_000;
const isSha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/i.test(value);
const full = (reason) => ({ skip: false, reason: `${reason}; running full CI` });

/**
 * A merge_group run's success proves the full suite only if it excluded no quarantined test
 * (scripts/ci/quarantine-skip.mjs excludes entries on merge_group, never on a push to main).
 * Proof: the list now is readable, either not in quarantine mode or empty (every entry counts:
 * expired, job-tagged and name-qualified ones too), and its tip predates the run's creation by
 * QUARANTINE_SETTLE_MS, so the run read this same list. Returns null when proven, else the reason.
 */
async function quarantineUnproven(readQuarantineState, run, now) {
  let state;
  try {
    state = await readQuarantineState();
  } catch {
    return 'quarantine list read failed';
  }
  if (state?.ok !== true || !state.list || typeof state.list !== 'object') return 'quarantine list unreadable';
  const { mode, entries } = state.list;
  if (!Array.isArray(entries)) return 'quarantine list entries unreadable';
  if (mode !== undefined && mode !== 'stop' && mode !== 'quarantine') return 'unknown quarantine mode';
  if (mode === 'quarantine' && entries.length > 0) {
    return 'quarantine mode has entries, so the merge-group run may have excluded tests';
  }
  const listTime = typeof state.committedAt === 'string' ? Date.parse(state.committedAt) : NaN;
  if (!Number.isFinite(listTime)) return 'quarantine list commit time unreadable';
  if (!Number.isFinite(now) || listTime > now) return 'quarantine list commit time is in the future';
  if (listTime > Date.parse(run.created_at) - QUARANTINE_SETTLE_MS) {
    return 'quarantine list changed near or after the merge-group run';
  }
  return null;
}

/** Decide from injected evidence; unavailable evidence always retains full CI. */
export async function decideQueueTestedSkip({
  event, ref, sha, pushTree, listMergeGroupRuns, getCommitTree, readQuarantineState, now = Date.now(),
} = {}) {
  if (event !== 'push') return full('only push events qualify');
  if (ref !== 'refs/heads/main') return full('only the main branch qualifies');
  if (!isSha(sha)) return full('invalid push SHA');
  if (!isSha(pushTree)) return full('invalid push tree');

  let runs;
  try {
    runs = await listMergeGroupRuns();
  } catch {
    return full('merge-group run listing failed');
  }
  if (!Array.isArray(runs)) return full('merge-group run listing is not an array');
  const candidates = runs.filter((run) => run?.conclusion === 'success' && isSha(run.head_sha)
    && typeof run.created_at === 'string' && Number.isFinite(Date.parse(run.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_RUNS_CHECKED);
  if (!candidates.length) return full('no valid successful merge-group runs');

  const accept = async (run, reason) => {
    const unproven = await quarantineUnproven(readQuarantineState, run, now);
    return unproven ? full(unproven) : { skip: true, matchedSha: run.head_sha, reason };
  };
  for (const run of candidates) {
    if (run.head_sha.toLowerCase() === sha.toLowerCase()) {
      return accept(run, 'push head already passed merge-group CI');
    }
    let tree;
    try {
      tree = await getCommitTree(run.head_sha);
    } catch {
      return full('merge-group commit tree lookup failed');
    }
    if (!isSha(tree)) return full('invalid merge-group commit tree');
    if (tree.toLowerCase() === pushTree.toLowerCase()) {
      return accept(run, 'push tree already passed merge-group CI');
    }
  }
  return full(`tree differs from the newest ${candidates.length} successful runs (limit ${MAX_RUNS_CHECKED})`);
}

/** Read the published list and its tip time from one fetched commit (same transport as quarantine-skip). */
function readQuarantineAt(exec) {
  exec('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', trackingRefspec(QUARANTINE_BRANCH)]);
  const tip = exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${QUARANTINE_BRANCH}^{commit}`]);
  if (!isSha(tip)) return { ok: false, error: 'invalid quarantine tip' };
  const committedAt = exec('git', ['log', '-1', '--format=%cI', tip]);
  const listed = exec('git', ['ls-tree', '--name-only', tip, '--', QUARANTINE_LIST_PATH]);
  const list = listed ? JSON.parse(exec('git', ['show', `${tip}:${QUARANTINE_LIST_PATH}`])) : { version: 1, entries: [] };
  const valid = validateQuarantineList(list);
  return valid.ok ? { ok: true, list, committedAt } : { ok: false, error: valid.errors.join('; ') };
}

async function main() {
  let result;
  try {
    const { values } = parseArgs({ options: Object.fromEntries(
      ['event', 'ref', 'sha', 'repo'].map((name) => [name, { type: 'string' }]),
    ) });
    if (typeof values.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)
      || values.repo.includes('\n')) throw new Error('invalid repository');
    if (!isSha(values.sha)) throw new Error('invalid push SHA');
    const exec = (command, args) => execFileSync(command, args, {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CALL_TIMEOUT_MS, killSignal: 'SIGKILL',
    }).trim();
    result = await decideQueueTestedSkip({
      ...values,
      pushTree: exec('git', ['rev-parse', `${values.sha}^{tree}`]),
      listMergeGroupRuns: () => JSON.parse(exec('gh', ['api',
        `repos/${values.repo}/actions/workflows/ci.yml/runs?event=merge_group&status=success&per_page=100`,
      ])).workflow_runs,
      getCommitTree: (sha) => exec('gh', ['api', `repos/${values.repo}/git/commits/${sha}`, '--jq', '.tree.sha']),
      readQuarantineState: () => readQuarantineAt(exec),
    });
  } catch {
    result = full('queue-tested evidence could not be read');
  }
  process.stdout.write(`queue_tested=${result.skip}\n`);
  process.stderr.write(`queue-tested: ${result.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
