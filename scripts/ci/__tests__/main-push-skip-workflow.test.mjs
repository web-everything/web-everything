// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { spawnSync } from 'node:child_process';
const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const wf = yaml.load(raw), jobs = wf.jobs;
const evaluate = (expr, values) => Function(...Object.keys(values), `return (${expr.replace(/\$\{\{|\}\}/g, '').replace(/steps\.main-skip/g, "steps['main-skip']")});`)(...Object.values(values));
it('every WE checkout pins the scheduled backstop to the run sha (all jobs test one commit)', () => {
  for (const [name, job] of Object.entries(jobs)) for (const step of job.steps ?? []) {
    if (!step.uses?.startsWith('actions/checkout@') || step.with?.repository) continue;
    expect(step.with?.ref, name).toBe("${{ github.event_name == 'schedule' && github.sha || '' }}");
  }
});
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
  const upload = jobs['queue-reuse-record']?.steps.find(s => s.with?.name?.startsWith('fui-sibling-'));
  expect(jobs['queue-reuse-record']?.if).toContain("github.event_name == 'merge_group'");
  expect(upload).toBeDefined();
  expect(jobs.changes.steps.some(s => s.uses?.startsWith('actions/create-github-app-token@') && s.with.owner === 'frontier-ui')).toBe(true);
});
it('only literal true in either skip or card detection lights CI; schedule/dispatch always full', () => {
  for (const skip of ['true', 'false', '', undefined, 'TRUE']) for (const card of ['true', 'false', '', undefined]) {
    const steps = { 'main-skip': { outputs: { skip } }, detect: { outputs: { light: card } } };
    expect(evaluate(jobs.changes.outputs.light, { steps })).toBe(skip === 'true' || card === 'true');
  }
});
it('the FUI record pins every active sibling checkout to the SHA recorded by changes', () => {
  expect(jobs.changes.outputs['fui-sha']).toBe('${{ steps.main-skip.outputs.fui-sha || steps.fui-tip.outputs.tip }}');
  for (const name of ['standards', 'test-shard', 'integration-part', 'smoke']) {
    const checkout = jobs[name].steps.find(s => s.with?.repository === 'frontier-ui/frontierui');
    expect(checkout.with.ref).toBe("${{ needs.changes.outputs.fui-sha || '' }}");
    expect([jobs[name].needs].flat()).toContain('changes');
  }
});

it('never uploads reusable queue evidence for a light run or missing unit execution (finding 1)', () => {
  const job = jobs['queue-reuse-record'];
  expect(job).toBeDefined();
  expect(job.needs).toEqual(expect.arrayContaining(['changes', 'test', 'smoke', 'daemon-soak']));
  for (const light of ['true', 'false', '']) for (const result of ['success', 'skipped', 'failure']) {
    const needs = { changes: { outputs: { light, 'fui-sha': 'b'.repeat(40) } },
      test: { result }, smoke: { result: 'success' }, 'daemon-soak': { result: 'success' } };
    const expr = job.if.replace(/needs\.([\w-]+)\.outputs\.([\w-]+)/g, (_, j, k) => `needs['${j}'].outputs['${k}']`)
      .replace(/needs\.([\w-]+)\.result/g, (_, j) => `needs['${j}'].result`);
    expect(evaluate(expr, { needs, github: { event_name: 'merge_group' } })).toBe(light !== 'true' && result === 'success');
  }
});

it('requires an unquarantined execution receipt from every unit, integration and soak leg (finding 2)', () => {
  for (const name of ['test-shard', 'integration-part', 'soak-shard']) {
    const step = jobs[name].steps.find(s => s.with?.name?.startsWith('quarantine-reuse-'));
    expect(step, name).toBeDefined();
    expect(step.with.path).toContain('quarantine-reuse');
  }
  const record = jobs['queue-reuse-record'];
  expect(record).toBeDefined();
  expect(record.steps.some(s => s.uses?.startsWith('actions/download-artifact@') && s.with?.pattern === 'quarantine-reuse-*')).toBe(true);
  const check = record.steps.find(s => s.name === 'Require unquarantined test executions');
  expect(check).toBeDefined();
  expect(record.steps.find(s => s.with?.name?.startsWith('fui-sibling-')).if).toBe("${{ steps.proof.outputs.eligible == 'true' }}");
  expect(JSON.parse(check.env.UNIT_SHARDS)).toEqual(jobs['test-shard'].strategy.matrix.shard);
  expect(JSON.parse(check.env.INTEGRATION_GROUPS)).toEqual(jobs['integration-part'].strategy.matrix.group);
  expect(JSON.parse(check.env.SOAK_SHARDS)).toEqual(jobs['soak-shard'].strategy.matrix.shard);
  const dir = mkdtempSync(join(tmpdir(), 'queue-receipts-'));
  try {
    const names = [['unit', 'UNIT_SHARDS'], ['integration', 'INTEGRATION_GROUPS'], ['soak', 'SOAK_SHARDS']]
      .flatMap(([suite, key]) => JSON.parse(check.env[key]).map(id => `quarantine-reuse-${suite}-${id}`));
    for (const name of names) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'quarantine-reuse'), 'unquarantined\n');
    }
    const output = join(dir, 'output');
    const run = () => {
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-c', check.run], { encoding: 'utf8',
        env: { ...process.env, ...check.env, RECEIPTS: dir, GITHUB_OUTPUT: output } });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(output, 'utf8');
    };
    expect(run()).toBe('eligible=true\n');
    for (const receipt of ['quarantined\n', '', 'unknown\n']) {
      writeFileSync(join(dir, names[0], 'quarantine-reuse'), receipt);
      expect(run()).toBe('eligible=false\n');
    }
    rmSync(join(dir, names[0], 'quarantine-reuse'));
    expect(run()).toBe('eligible=false\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['false', '', 'TRUE', 'garbage'])('reuse cannot bypass invalid soak scope %j (finding 5)', scope => {
  const step = jobs['daemon-soak'].steps.find(s => s.name === 'Gate on shard results');
  const values = { 'github.event_name': 'push', 'needs.changes.result': 'success', 'needs.changes.outputs.skip': 'true',
    'needs.daemon-soak-scope.result': 'success', 'needs.daemon-soak-scope.outputs.run': scope, 'needs.soak-shard.result': 'skipped' };
  const script = step.run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (!(expr in values)) throw Error(`Unmodelled expression: ${expr}`);
    return values[expr];
  });
  const run = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null' } });
  expect(run.status, run.stdout + run.stderr).toBe(1);
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
