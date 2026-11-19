/** PR #7103's supplied job facts; check-run conclusion/removal time are explicit scenario inputs. */
export const repo = 'chalbert/web-everything';
export const head = 'c1f2b695540f266880d13a2113475c2d4cd92012';
export const commit = '6955b8c7f78d9d3a679d2992ab5a2fdd8f3d77b3';
const started = '2026-11-18T01:10:34Z';
const completed = '2026-11-18T01:30:37Z';
const removal = () => ({ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
  createdAt: '2026-11-18T01:30:39Z', beforeCommit: { oid: commit, parents: { nodes: [{ oid: 'a'.repeat(40) }, { oid: head }] } } });
export const added = () => ({ __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-18T01:00:00Z' });
const step = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });

export function infraFixture(guard, { checkConclusion = 'timed_out' } = {}) {
  const check = (id, name, job, conclusion) => ({ id, name, head_sha: commit, status: 'completed', conclusion,
    started_at: started, completed_at: completed, output: { title: '', summary: '', annotations_count: 0 },
    details_url: `https://github.com/${repo}/actions/runs/44434828048/job/${job}` });
  const f = {
    events: [added(), removal()], calls: [], lines: [], live: { headRefOid: head, mergeStateStatus: 'CLEAN' },
    checks: [check(1, 'integration', 135261064381, checkConclusion), check(2, 'test', 135269693446, 'failure')],
    jobs: {}, runs: {}, logs: {}, annotations: [], workflow: 'jobs:\n  integration:\n    timeout-minutes: 20\n',
  };
  const job = (id, name, conclusion, steps) => ({ id, name, head_sha: commit, run_id: 44434828048,
    run_attempt: 1, status: 'completed', conclusion, started_at: started, completed_at: completed, steps });
  f.jobs[135261064381] = job(135261064381, 'integration', 'cancelled',
    [step('Set up job'), step('Real-git integration suite'), step('Complete job')]);
  f.jobs[135269693446] = job(135269693446, 'test', 'failure',
    [step('Set up job'), step('Gate on shard results', 'failure'), step('Complete job')]);
  f.runs[44434828048] = { id: 44434828048, run_attempt: 1, head_sha: commit, status: 'completed', conclusion: 'failure',
    event: 'merge_group', path: '.github/workflows/ci.yml', updated_at: completed };
  f.exec = (command, args) => {
    f.calls.push([command, args]);
    if (command !== 'gh') throw new Error('unexpected non-GitHub IO');
    if (args.some(arg => arg.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: {
      pullRequest: { headRefOid: head, isInMergeQueue: false } } } });
    if (args.some(arg => arg.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: {
      timelineItems: { nodes: f.events, pageInfo: { hasPreviousPage: f.truncatedTimeline ?? false } } } } } });
    if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify(f.live);
    const path = args[1]?.replace(`repos/${repo}/`, '');
    if (path?.startsWith(`commits/${commit}/check-runs?`)) {
      if (f.checkError) throw new Error('check-runs unavailable');
      return JSON.stringify({ total_count: f.checkTotal ?? f.checks.length, check_runs: f.checks });
    }
    const jobPath = /^actions\/jobs\/(\d+)(\/logs)?$/.exec(path ?? '');
    if (jobPath) {
      const value = jobPath[2] ? f.logs[jobPath[1]] : f.jobs[jobPath[1]];
      if (value === undefined) throw new Error('job unavailable');
      return jobPath[2] ? value : JSON.stringify(value);
    }
    const run = /^actions\/runs\/(\d+)$/.exec(path ?? '');
    if (run) {
      if (!f.runs[run[1]]) throw new Error('run unavailable');
      return JSON.stringify(f.runs[run[1]]);
    }
    if (path?.startsWith('check-runs/')) return JSON.stringify(f.annotations);
    if (path === `contents/.github/workflows/ci.yml?ref=${commit}`) return JSON.stringify({ type: 'file', encoding: 'base64',
      size: Buffer.byteLength(f.workflow), content: Buffer.from(f.workflow).toString('base64') });
    // A deliberately red main demonstrates the legacy decline and must never authorize the new route.
    if (path?.startsWith('actions/workflows/ci.yml/runs?')) return JSON.stringify({ total_count: 1,
      workflow_runs: [{ id: 9, run_attempt: 1, path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
        status: 'completed', conclusion: 'failure', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:30:00Z' }] });
    throw new Error(`unexpected fixture IO: ${JSON.stringify(args)}`);
  };
  f.guard = () => guard({ repo, pr: 7103, head, exec: f.exec, log: line => f.lines.push(line),
    now: Date.parse('2026-11-18T02:00:00Z'), quarantine: { readList: null } });
  f.secondFailure = () => f.events.push(added(), removal());
  return f;
}
