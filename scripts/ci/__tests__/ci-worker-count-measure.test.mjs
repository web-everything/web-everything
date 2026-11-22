// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const { jobs } = yaml.load(readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
// R1104 / PR #7202 Acceptance 2: independent of the workflow and urgent-verify mirror.
const ACCEPTED_CI_WORKER_DEFAULT = 2;

// Execute the workflow's actual shell, including bash's CI error policy. Proc metadata is
// redirected to fixtures; discovered memory.peak paths are read from the real filesystem.
function runStep(step, { start = '1000', now = '1123', memory = '4096', cpu = '4',
  membership = '0::/system.slice/actions.runner.service\n', mountRoot = '/',
  memoryPath = 'system.slice/actions.runner.service', mountType = 'cgroup2', metadata = true, mountinfoSuffix = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shard-resources-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const mount = join(dir, 'cgroup mount');
    const memoryDir = join(mount, memoryPath);
    mkdirSync(memoryDir, { recursive: true });
    if (memory !== 'unavailable') writeFileSync(join(memoryDir, 'memory.peak'), `${memory}\n`);
    const cgroupFile = join(dir, 'cgroup'), mountinfoFile = join(dir, 'mountinfo');
    if (metadata) {
      writeFileSync(cgroupFile, membership);
      const escaped = value => value.replace(/ /g, '\\040');
      writeFileSync(mountinfoFile, `29 23 0:26 ${escaped(mountRoot)} ${escaped(mount)} rw - ${mountType} cgroup rw\n${mountinfoSuffix}`);
    }
    const commands = {
      date: 'printf "%s\\n" "$TEST_NOW"',
      nproc: 'if [ "$TEST_CPU" = unavailable ]; then exit 1; fi\nprintf "%s\\n" "$TEST_CPU"',
      cat: 'case "$1" in\n/proc/self/cgroup) exec /bin/cat "$TEST_CGROUP_FILE" ;;\n/proc/self/mountinfo) exec /bin/cat "$TEST_MOUNTINFO_FILE" ;;\n*) exec /bin/cat "$@" ;;\nesac',
      cut: 'printf "9000\\n"',
    };
    for (const [name, body] of Object.entries(commands)) {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const summary = join(dir, 'summary'), envFile = join(dir, 'env');
    const execution = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
      cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, GITHUB_ENV: envFile,
        SHARD_START_SECONDS: start, TEST_NOW: now, TEST_CPU: cpu,
        TEST_CGROUP_FILE: cgroupFile, TEST_MOUNTINFO_FILE: mountinfoFile },
    });
    const read = name => existsSync(name) ? readFileSync(name, 'utf8') : '';
    return { status: execution.status, output: execution.stdout + execution.stderr,
      summary: read(summary), json: read(join(dir, 'shard-resources.json')), env: read(envFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CI worker count and shard measurements', () => {
  it('sets the test-shard worker override with an operator rollback', () => {
    expect(jobs['test-shard'].env.WE_VITEST_MAX_WORKERS).toBe("${{ vars.WE_VITEST_MAX_WORKERS || '" + ACCEPTED_CI_WORKER_DEFAULT + "' }}");
  });

  describe.each(['test-shard', 'soak-shard'])('%s', (name) => {
    const job = jobs[name];

    it('always measures resources without failing the shard', () => {
      const measure = job.steps.find((step) => step.name === 'Measure shard resources');
      expect(measure).toBeDefined();
      expect(measure.if).toContain('always()');
      expect(measure['continue-on-error']).toBe(true);
      expect(measure.run).toContain('nproc');
      expect(measure.run).toContain('/proc/self/cgroup');
      expect(measure.run).toContain('/proc/self/mountinfo');
      expect(measure.run).toContain('unavailable');
      expect(measure.run).toContain('GITHUB_STEP_SUMMARY');
      expect(measure.run).toContain('SHARD_START_SECONDS');
      expect(measure.run).toContain('wall_seconds');
      const upload = job.steps.at(-1);
      expect(job.steps.at(-2)).toBe(measure);
      expect(upload.uses).toBe('actions/upload-artifact@v4');
      expect(upload.if).toContain('always()');
      expect(upload['continue-on-error']).toBe(true);
      expect(upload.with.name).toBe(`shard-resources-${name.replace('-shard', '')}-` + '${{ matrix.shard }}');
      expect(upload.with.path).toBe(name === 'test-shard' ? 'web-everything/shard-resources.json' : 'shard-resources.json');
      expect(upload.with['if-no-files-found']).toBe('ignore');
      expect(measure.run).toContain(`> ${basename(upload.with.path)}`);
    });

    it('records a shard start before checkout or installation', () => {
      const start = job.steps[0];
      expect(start.name).toBe('Record shard start');
      expect(start['continue-on-error']).toBe(true);
      expect(start.if).toBe(name === 'test-shard' ? "${{ needs.changes.outputs.light != 'true' }}" : undefined);
      const r = runStep(start, { now: '1000' });
      expect(r.status, r.output).toBe(0);
      expect(r.env).toBe('SHARD_START_SECONDS=1000\n');
    });

    it('writes shard resource summary and JSON with measured values', () => {
      const r = runStep(job.steps.find(step => step.name === 'Measure shard resources'));
      expect(r.status, r.output).toBe(0);
      expect(JSON.parse(r.json)).toEqual({ nproc: 4, 'memory.peak': '4096', wall_seconds: 123 });
      expect(r.summary).toBe('nproc: 4\nmemory.peak: 4096\nwall time (seconds): 123\n');
    });

    it.each([
      ['host service cgroup', {}],
      ['subtree mount', { mountRoot: '/system.slice', memoryPath: 'actions.runner.service' }],
      ['mount root equals membership', { mountRoot: '/system.slice/actions.runner.service', memoryPath: '' }],
      ['namespace root', { membership: '0::/\n', memoryPath: '' }],
      ['escaped mount root', { membership: '0::/runner slice/service\n', mountRoot: '/runner slice', memoryPath: 'service' }],
      ['large mount inventory under pipefail', { mountinfoSuffix: '30 23 0:27 / /other rw - tmpfs tmpfs rw\n'.repeat(4096) }],
    ])('reads a real memory.peak file for %s with an escaped mount point', (_, options) => {
      const r = runStep(job.steps.find(step => step.name === 'Measure shard resources'), options);
      expect(r.status, r.output).toBe(0);
      expect(JSON.parse(r.json)['memory.peak']).toBe('4096');
    });

    it.each([
      ['missing proc metadata', { metadata: false }],
      ['cgroup v1', { membership: '5:memory:/service\n', mountType: 'cgroup' }],
      ['missing cgroup2 mount', { mountType: 'tmpfs' }],
      ['unrelated mount root', { mountRoot: '/different' }],
      ['mount root prefix collision', { mountRoot: '/system' }],
    ])('reports unavailable memory without losing telemetry for %s', (_, options) => {
      const r = runStep(job.steps.find(step => step.name === 'Measure shard resources'), options);
      expect(r.status, r.output).toBe(0);
      expect(JSON.parse(r.json)).toEqual({ nproc: 4, 'memory.peak': 'unavailable', wall_seconds: 123 });
    });

    it('records zero elapsed seconds when the start and measurement happen in the same second', () => {
      const r = runStep(job.steps.find(step => step.name === 'Measure shard resources'), { now: '1000' });
      expect(r.status, r.output).toBe(0);
      expect(JSON.parse(r.json).wall_seconds).toBe(0);
    });

    it.each(['unavailable', '', 'broken"json'])('emits valid JSON when memory.peak is %j', memory => {
      const r = runStep(job.steps.find(step => step.name === 'Measure shard resources'), { memory });
      expect(r.status, r.output).toBe(0);
      expect(JSON.parse(r.json)).toEqual({ nproc: 4, 'memory.peak': 'unavailable', wall_seconds: 123 });
      expect(r.summary).toContain('memory.peak: unavailable');
    });

    it.each(['unavailable', '', '08', 'bad"json'])('keeps measurements when nproc is %j', cpu => {
      const r = runStep(job.steps.find(step => step.name === 'Measure shard resources'), { cpu });
      expect(r.status, r.output).toBe(0);
      expect(JSON.parse(r.json)).toEqual({ nproc: null, 'memory.peak': '4096', wall_seconds: 123 });
    });

    it.each([
      ['', '1123'], ['bad', '1123'], ['1200', '1123'], ['1000', 'unavailable'],
      ['999999999999999999999', '1123'], ['1000', '999999999999999999999'],
    ])('keeps valid telemetry when elapsed time is unavailable (%j, %j)', (start, now) => {
      const r = runStep(job.steps.find(step => step.name === 'Measure shard resources'), { start, now });
      expect(r.status, r.output).toBe(0);
      expect(JSON.parse(r.json)).toEqual({ nproc: 4, 'memory.peak': '4096', wall_seconds: null });
    });

    it('keeps test, unit and soak run steps blocking', () => {
      expect(job['continue-on-error']).toBeUndefined();
      const runs = job.steps.filter((step) => /npm run test:/.test(step.run ?? ''));
      expect(runs.length).toBeGreaterThan(0);
      for (const step of runs) expect(step['continue-on-error']).toBeUndefined();
    });
  });

  describe('PR shards finish below 1050 seconds with no new failures', () => {
    const gateName = 'PR shards finish below 1050 seconds with no new failures';
    const gate = () => jobs.test.steps.find(step => step.name === gateName);
    const completedShards = (seconds = 1049) => jobs['test-shard'].strategy.matrix.shard.map(shard => ({
      name: `test-shard (${shard})`, run_id: 123, status: 'completed', conclusion: 'success',
      started_at: '2026-11-20T13:00:00Z', completed_at: new Date(Date.parse('2026-11-20T13:00:00Z') + seconds * 1000).toISOString(),
    }));
    async function runAcceptance(rows = completedShards(), total = rows.length) {
      const listJobsForWorkflowRun = vi.fn(async () => ({ data: { jobs: rows, total_count: total } }));
      const info = vi.fn();
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction('github', 'context', 'core', gate().with.script)(
        { rest: { actions: { listJobsForWorkflowRun } } },
        { repo: { owner: 'web-everything', repo: 'web-everything' }, runId: 123 }, { info });
      expect(listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
      expect(listJobsForWorkflowRun).toHaveBeenCalledWith({
        owner: 'web-everything', repo: 'web-everything', run_id: 123, filter: 'latest', per_page: 100,
      });
      return info;
    }

    it('keeps timing diagnostics advisory while test results still block the required aggregator', () => {
      const step = gate();
      expect(step).toBeDefined();
      expect(step.if).toBe("${{ always() && github.event_name == 'pull_request' && needs.changes.outputs.light != 'true' }}");
      expect(step.uses).toBe('actions/github-script@v7');
      expect(step['continue-on-error']).toBe(true);
      expect(jobs.test['continue-on-error']).toBeUndefined();
      expect(jobs.test.permissions).toEqual({ actions: 'read' });
      expect(jobs.test.needs).toContain('test-shard');
      const resultChecks = jobs.test.steps.filter(step => step.run);
      expect(resultChecks.length).toBeGreaterThan(0);
      expect(resultChecks.every(step => step['continue-on-error'] === undefined)).toBe(true);
    });

    it('accepts completed successful shards below the threshold, ignoring unrelated in-progress jobs', async () => {
      const info = await runAcceptance([...completedShards(), { name: 'test', status: 'in_progress' }]);
      expect(info).toHaveBeenCalledWith('PR shard long pole: 1049 seconds (must be below 1050)');
    });

    it.each([1050, 1051])('rejects a single completed shard at or above the threshold (%s)', async seconds => {
      const rows = completedShards();
      rows[4] = completedShards(seconds)[4];
      await expect(runAcceptance(rows)).rejects.toThrow('17.5-minute acceptance limit');
    });

    it.each(['failure', 'cancelled', 'skipped', 'timed_out', null])('rejects an unsuccessful or unknown conclusion %j', async conclusion => {
      const rows = completedShards();
      rows[0].conclusion = conclusion;
      await expect(runAcceptance(rows)).rejects.toThrow('Shard did not succeed in this run');
    });

    it.each([
      ['missing shard', rows => rows.pop()],
      ['duplicate shard', rows => { rows[0] = rows[1]; }],
      ['extra shard', rows => rows.push({ ...rows[0], name: 'test-shard (11)' })],
      ['missing start', rows => { delete rows[0].started_at; }],
      ['bad completion', rows => { rows[0].completed_at = 'invalid'; }],
      ['reversed time', rows => { rows[0].completed_at = '2026-11-20T12:00:00Z'; }],
    ])('fails closed on %s with an operator fallback', async (_, mutate) => {
      const rows = completedShards();
      mutate(rows);
      await expect(runAcceptance(rows)).rejects.toThrow('inspect completed jobs and wait for a fresh CI run');
    });

    it.each(['wrong run', 'incomplete job'])('fails closed on %s', async fault => {
      const rows = completedShards();
      if (fault === 'wrong run') rows[0].run_id = 456;
      else rows[0].status = 'in_progress';
      await expect(runAcceptance(rows)).rejects.toThrow('Shard did not succeed in this run');
    });

    it.each([null, 11, 101])('refuses incomplete or oversized API pages (%j)', async total => {
      const rows = completedShards();
      await expect(runAcceptance(rows, total)).rejects.toThrow('Incomplete shard timing evidence');
    });

    it('propagates an unreadable API result', async () => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await expect(new AsyncFunction('github', 'context', 'core', gate().with.script)(
        { rest: { actions: { listJobsForWorkflowRun: async () => { throw new Error('API unavailable'); } } } },
        { repo: {}, runId: 123 }, { info: vi.fn() })).rejects.toThrow('API unavailable');
    });
  });
});
