// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { spawnSync } from 'node:child_process';
const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const wf = yaml.load(raw), jobs = wf.jobs;
const evaluate = (expr, values) => Function(...Object.keys(values), `return (${expr.replace(/\$\{\{|\}\}/g, '').replace(/steps\.main-skip/g, "steps['main-skip']")});`)(...Object.values(values));
it('hourly main backstop has a distinct concurrency group and cannot cancel or be cancelled by main pushes', () => {
  expect(wf.on.schedule).toEqual([{ cron: '23 * * * *' }]);
  const github = event => ({ event_name: event, ref: 'refs/heads/main' });
  const render = event => wf.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, e) => evaluate(e, { github: github(event) }));
  expect(render('schedule')).not.toBe(render('push'));
  for (const event of ['schedule', 'push']) expect(evaluate(wf.concurrency['cancel-in-progress'], { github: github(event) })).toBe(false);
  expect(jobs['daemon-soak-scope'].if).toContain("github.event_name == 'schedule'");
  expect(jobs['daemon-soak'].if).toContain("github.event_name == 'schedule'");
});
it('skip step runs only for a push to main, with App-authenticated FUI recording on merge_group', () => {
  const step = jobs.changes.steps.find(s => s.id === 'main-skip'); expect(step).toBeDefined();
  for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group']) for (const ref of ['refs/heads/main', 'refs/heads/other'])
    expect(evaluate(step.if, { github: { event_name: event, ref } })).toBe(event === 'push' && ref === 'refs/heads/main');
  const upload = jobs.changes.steps.find(s => s.with?.name?.startsWith('fui-sibling-'));
  expect(upload?.if).toContain("github.event_name == 'merge_group'");
  expect(jobs.changes.steps.some(s => s.uses?.startsWith('actions/create-github-app-token@') && s.with.owner === 'frontier-ui')).toBe(true);
});
it('only literal true in either skip or card detection lights CI; schedule/dispatch always full', () => {
  for (const skip of ['true', 'false', '', undefined, 'TRUE']) for (const card of ['true', 'false', '', undefined]) {
    const steps = { 'main-skip': { outputs: { skip } }, detect: { outputs: { light: card } } };
    expect(evaluate(jobs.changes.outputs.light, { steps })).toBe(skip === 'true' || card === 'true');
  }
});
it('the FUI record pins every active sibling checkout to the SHA recorded by changes', () => {
  expect(jobs.changes.outputs['fui-sha']).toBe('${{ steps.fui-tip.outputs.tip }}');
  for (const name of ['standards', 'test-shard', 'integration-part', 'smoke']) {
    const checkout = jobs[name].steps.find(s => s.with?.repository === 'frontier-ui/frontierui');
    expect(checkout.with.ref).toBe("${{ needs.changes.outputs.fui-sha || '' }}");
    expect([jobs[name].needs].flat()).toContain('changes');
  }
});
it('required jobs remain real jobs; test logs the queue id through the skip reason', () => {
  for (const name of ['test', 'smoke', 'daemon-soak']) { expect(jobs[name]).toBeDefined(); expect(jobs[name].if || '').not.toMatch(/outputs\.(light|skip)/); }
  expect(jobs.changes.outputs['skip-reason']).toContain('main-skip.outputs.reason');
  expect(jobs.test.steps.some(s => s.env?.MAIN_SKIP_REASON === '${{ needs.changes.outputs.skip-reason }}' && s.run?.includes('$MAIN_SKIP_REASON'))).toBe(true);
});

it('the actual test gate prints the queue run id from its skip reason', () => {
  const step = jobs.test.steps.find(s => s.name === 'Gate on shard results');
  const values = { 'needs.changes.outputs.light': 'true' };
  for (const name of jobs.test.needs) values[`needs.${name}.result`] = 'success';
  const script = step.run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    if (!(expression in values)) throw Error(`Unmodelled expression: ${expression}`);
    return values[expression];
  });
  const run = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8',
    env: { ...process.env, MAIN_SKIP_REASON: 'exact SHA passed queue run 100; FUI sibling unchanged' } });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain('queue run 100');
});
