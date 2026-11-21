// @vitest-environment node
import { expect, it } from 'vitest';
import { probeMainCiRuns } from '../../conveyor/main-ci-red-probe.mjs';
import { mainRedState } from '../../conveyor/main-ci-red-core.mjs';
import { planMainRedAlert } from '../../conveyor/health-watch-main-red.mjs';

const row = (id, conclusion = 'failure', sha = String(id).repeat(40).slice(0, 40)) => ({ databaseId: id,
  headSha: sha, event: 'push', status: 'completed', conclusion, attempt: 1,
  createdAt: new Date(1_790_000_000_000 + id * 60_000).toISOString() });
const jobs = () => ({ total_count: 2, jobs: [
  { name: 'main-execution', status: 'completed', conclusion: 'failure', run_attempt: 1 },
  { name: 'test', status: 'completed', conclusion: 'success', run_attempt: 1 },
] });
function probe(rows, pages) {
  const reads = [];
  const result = probeMainCiRuns({ repoSlug: 'fixture/repo', config: { mainCiRedFlakeRerun: false },
    readRequired: () => ({ checks: ['test'] }), exec: (_, args) => {
      if (args[0] === 'run') return JSON.stringify(rows);
      reads.push(args[1]);
      const match = /\/runs\/(\d+)\/attempts\/1\/jobs\?per_page=100$/.exec(args[1]);
      if (match && pages[match[1]]) return JSON.stringify(pages[match[1]]);
      throw Error('fixture: evidence unavailable');
    } });
  return { ...result, reads };
}
it.each(['no tip', 'pending tip', 'reused tip'])('ignores every proven reused push with %s', mode => {
  const result = probe([row(1, 'success'), row(3), row(2)], { 2: jobs(), 3: jobs() });
  const tip = mode === 'no tip' ? undefined : { sha: row(3).headSha, runStatus: 'completed', requiredChecks: ['test'],
    checkRuns: [{ id: 1, name: 'test', status: mode === 'pending tip' ? 'in_progress' : 'completed', conclusion: 'success' }] };
  expect(mainRedState(result.runs, { tip })).toMatchObject({ status: 'green', latestGreen: { runId: 1 } });
  expect(result.failing.jobs).toEqual([]);
  expect(planMainRedAlert({ ...result, tip, now: 1_790_010_000_000 }).items).toEqual([]);
  expect(result.reads.filter(path => path.includes('/attempts/1/jobs'))).toHaveLength(2);
});
it('preserves the real red window between reused pushes', () => {
  const result = probe([row(4), row(3), row(2), row(1, 'success')], { 2: jobs(), 4: jobs() });
  expect(mainRedState(result.runs)).toMatchObject({ status: 'red', firstRed: { runId: 3 }, latestRed: { runId: 3 } });
});
it('reuse proof never covers a different failing run on the same SHA, even with green tip summaries', () => {
  const sha = 'a'.repeat(40);
  const result = probe([row(3, 'failure', sha), row(2, 'failure', sha), row(1, 'success')], { 3: jobs() });
  const tip = { sha, runStatus: 'completed', requiredChecks: ['test'], checkRuns: [
    { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'main-execution', status: 'completed', conclusion: 'failure' },
  ] };
  expect(mainRedState(result.runs, { tip })).toMatchObject({ status: 'red', latestRed: { runId: 2 } });
});
it('only reused runs leaves execution unknown', () => {
  expect(mainRedState(probe([row(3), row(2)], { 2: jobs(), 3: jobs() }).runs).status).toBe('unknown');
});
it.each([
  ['another failed job', page => { page.jobs[1].conclusion = 'failure'; }],
  ['truncated page', page => { page.total_count++; }],
  ['wrong attempt', page => { page.jobs[0].run_attempt = 2; }],
  ['cancelled job', page => { page.jobs[1].conclusion = 'cancelled'; }],
  ['missing marker', page => { page.jobs[0].name = 'build'; }],
])('retains a historical failure with %s', (_, change) => {
  const page = jobs(); change(page);
  const result = probe([row(3), row(2), row(1, 'success')], { 2: page, 3: jobs() });
  expect(mainRedState(result.runs)).toMatchObject({ status: 'red', latestRed: { runId: 2 } });
});
it('retains scheduled failures and reruns', () => {
  for (const extra of [{ event: 'schedule' }, { attempt: 2 }]) {
    const result = probe([{ ...row(2), ...extra }, row(1, 'success')], { 2: jobs() });
    expect(mainRedState(result.runs).status).toBe('red');
  }
});
it('bounds historical reuse proof reads at thirty and leaves unproven failures red', () => {
  const rows = Array.from({ length: 31 }, (_, index) => row(index + 1));
  const result = probe(rows, Object.fromEntries(rows.map(run => [run.databaseId, jobs()])));
  expect(result.reads.filter(path => path.includes('/attempts/1/jobs'))).toHaveLength(30);
  expect(mainRedState(result.runs).status).toBe('red');
});
