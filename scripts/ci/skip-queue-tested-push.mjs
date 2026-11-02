#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const MAX_RUNS_CHECKED = 20;
const isSha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/i.test(value);
const full = (reason) => ({ skip: false, reason: `${reason}; running full CI` });

/** Decide from injected evidence; unavailable evidence always retains full CI. */
export async function decideQueueTestedSkip({ event, ref, sha, pushTree, listMergeGroupRuns, getCommitTree } = {}) {
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

  for (const run of candidates) {
    if (run.head_sha.toLowerCase() === sha.toLowerCase()) {
      return { skip: true, matchedSha: run.head_sha, reason: 'push head already passed merge-group CI' };
    }
    let tree;
    try {
      tree = await getCommitTree(run.head_sha);
    } catch {
      return full('merge-group commit tree lookup failed');
    }
    if (!isSha(tree)) return full('invalid merge-group commit tree');
    if (tree.toLowerCase() === pushTree.toLowerCase()) {
      return { skip: true, matchedSha: run.head_sha, reason: 'push tree already passed merge-group CI' };
    }
  }
  return full(`tree differs from the newest ${candidates.length} successful runs (limit ${MAX_RUNS_CHECKED})`);
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
    }).trim();
    result = await decideQueueTestedSkip({
      ...values,
      pushTree: exec('git', ['rev-parse', `${values.sha}^{tree}`]),
      listMergeGroupRuns: () => JSON.parse(exec('gh', ['api',
        `repos/${values.repo}/actions/workflows/ci.yml/runs?event=merge_group&status=success&per_page=100`,
      ])).workflow_runs,
      getCommitTree: (sha) => exec('gh', ['api', `repos/${values.repo}/git/commits/${sha}`, '--jq', '.tree.sha']),
    });
  } catch {
    result = full('queue-tested evidence could not be read');
  }
  process.stdout.write(`queue_tested=${result.skip}\n`);
  process.stderr.write(`queue-tested: ${result.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
