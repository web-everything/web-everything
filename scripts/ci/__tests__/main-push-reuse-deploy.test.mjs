// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const workflows = new URL('../../../.github/workflows/', import.meta.url);
const load = name => yaml.load(readFileSync(new URL(name, workflows), 'utf8'));
const deploy = load('deploy.yml').jobs.deploy;
const marker = load('ci.yml').jobs['main-execution'];
const event = (conclusion = 'failure') => ({ event_name: 'workflow_run', repository: 'fixture/repo', event: {
  workflow_run: { id: 12, run_attempt: 1, head_sha: 'a'.repeat(40), conclusion, event: 'push', head_repository: { full_name: 'fixture/repo' } },
} });
const admitted = github => Function('github', `return (${deploy.if})`)(github);
const page = () => ({ total_count: 4, jobs: ['main-execution', 'test', 'smoke', 'unit (1)'].map(name => ({ name,
  status: 'completed', conclusion: name === 'main-execution' ? 'failure' : name === 'unit (1)' ? 'skipped' : 'success', run_attempt: 1 })) });

async function verify(data = page(), payload = event().event) {
  const step = deploy.steps.find(step => step.name === 'Verify reused CI failure');
  expect(step, 'failed CI must be verified before any checkout or secret-bearing build').toBeDefined();
  const errors = [];
  const calls = [];
  await new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', step.with.script)(
    { rest: { actions: { listJobsForWorkflowRunAttempt: async args => {
      calls.push(args); if (data instanceof Error) throw data; return { data };
    } } } },
    { repo: { owner: 'fixture', repo: 'repo' }, payload }, { setFailed: message => errors.push(message) });
  return { errors, calls };
}

it('a reused push conclusion wakes deploy and passes its reuse proof', async () => {
  const result = spawnSync('bash', ['-c', marker.steps[0].run], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(admitted(event(result.status === 0 ? 'success' : 'failure'))).toBe(true);
  expect(await verify()).toMatchObject({ errors: [], calls: [{ run_id: 12, attempt_number: 1, per_page: 100 }] });
});
it('keeps the trusted push boundary and exact-SHA ancestry/checks gate before checkout', () => {
  expect(admitted(event('success'))).toBe(true);
  for (const source of ['pull_request', 'merge_group', 'schedule']) {
    const input = event(); input.event.workflow_run.event = source;
    expect(admitted(input)).toBe(false);
  }
  const fork = event(); fork.event.workflow_run.head_repository.full_name = 'fork/repo';
  expect(admitted(fork)).toBe(false);
  expect(admitted(event('cancelled'))).toBe(false);
  const proof = deploy.steps.findIndex(step => step.name === 'Verify reused CI failure');
  const checkout = deploy.steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
  expect(proof).toBeGreaterThanOrEqual(0);
  expect(proof).toBeLessThan(checkout);
  expect(deploy.steps[proof].if).toContain("github.event.workflow_run.conclusion == 'failure'");
  expect(deploy.steps[proof]['continue-on-error']).not.toBe(true);
  expect(deploy.permissions.actions).toBe('read');
  expect(deploy.env.DEPLOY_SHA).toContain('github.event.workflow_run.head_sha');
  const gate = deploy.steps.findIndex(step => step.name === 'Refuse an unverified SHA');
  expect(gate).toBeLessThan(checkout);
  expect(deploy.steps[gate].run).toContain('compare/main...$DEPLOY_SHA');
  expect(deploy.steps[gate].run).toContain('"$checks_ok" = "true"');
});
it.each([
  ['another failure', data => { data.jobs[1].conclusion = 'failure'; }],
  ['missing marker', data => { data.jobs.shift(); data.total_count--; }],
  ['duplicate marker', data => { data.jobs.push(data.jobs[0]); data.total_count++; }],
  ['cancelled job', data => { data.jobs[1].conclusion = 'cancelled'; }],
  ['unfinished job', data => { data.jobs[1].status = 'in_progress'; }],
  ['truncated page', data => { data.total_count++; }],
  ['wrong attempt', data => { data.jobs[1].run_attempt = 2; }],
  ['unknown attempt', data => { delete data.jobs[1].run_attempt; }],
  ['missing job inventory', data => { delete data.jobs; }],
  ['empty page', data => { data.jobs = []; data.total_count = 0; }],
])('refuses deploy with %s', async (_, change) => {
  const data = page(); change(data);
  expect((await verify(data)).errors).not.toEqual([]);
});
it('refuses a rerun without reusing its earlier marker', async () => {
  const payload = event().event; payload.workflow_run.run_attempt = 2;
  expect((await verify(page(), payload)).errors).not.toEqual([]);
});
it('unreadable job evidence fails the pre-checkout step', async () => {
  await expect(verify(new Error('jobs unavailable'))).rejects.toThrow('jobs unavailable');
});
it('inventories every CI workflow_run consumer when CI intentionally fails on reuse', () => {
  expect(marker.steps[0].run).toContain('exit 1');
  const consumers = readdirSync(workflows).filter(name => /\.ya?ml$/.test(name))
    .filter(name => load(name).on?.workflow_run?.workflows?.includes('CI')).sort();
  // Each consumer must have an explicit reuse policy and its own contract test.
  expect(consumers).toEqual(['ci-timings-refresh.yml', 'deploy.yml']);
  expect(load('ci-timings-refresh.yml').jobs.refresh.if).toContain("conclusion == 'success'");
});
