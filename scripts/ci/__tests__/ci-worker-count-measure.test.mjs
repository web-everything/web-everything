import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const { jobs } = yaml.load(readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));

// Execute the workflow's actual shell, including the start step, with deterministic host readings.
function measureResources(job, { memory = '4096', cpu = '4', end = '145.90', start = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shard-resources-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const stubs = {
      nproc: cpu === null ? 'exit 1' : `printf '%s\\n' '${cpu}'`,
      cat: memory === null ? 'exit 1' : `printf '%s\\n' '${memory}'`,
      cut: 'printf "%s\\n" "${TEST_UPTIME%%.*}"',
    };
    Object.entries(stubs).forEach(([name, body]) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    });
    const envFile = join(root, 'env');
    const summary = join(root, 'summary');
    writeFileSync(envFile, '');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ENV: envFile, GITHUB_STEP_SUMMARY: summary };
    delete env.SHARD_START_SECONDS;
    const run = (script, extra) => {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    };
    if (start) {
      expect(job.steps[0].name).toBe('Start shard resource timer');
      run(job.steps[0].run, { TEST_UPTIME: '100.20' });
      const saved = readFileSync(envFile, 'utf8').trim().split('=');
      expect(saved).toEqual(['SHARD_START_SECONDS', '100']);
      env.SHARD_START_SECONDS = saved[1];
    }
    run(job.steps.find(step => step.name === 'Measure shard resources').run, { TEST_UPTIME: end });
    const artifact = job.steps.at(-1).with.path.replace(/^web-everything\//, '');
    return { json: JSON.parse(readFileSync(join(root, artifact), 'utf8')), summary: readFileSync(summary, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('CI worker count and shard measurements', () => {
  it('sets the test-shard worker override with an operator rollback', () => {
    expect(jobs['test-shard'].env.WE_VITEST_MAX_WORKERS).toBe("${{ vars.WE_VITEST_MAX_WORKERS || '4' }}");
  });

  describe.each(['test-shard', 'soak-shard'])('%s', (name) => {
    const job = jobs[name];

    it('always measures resources without failing the shard', () => {
      const timer = job.steps[0];
      expect(timer.name).toBe('Start shard resource timer');
      expect(timer['continue-on-error']).toBe(true);
      expect(timer.if).toBe(name === 'test-shard' ? "${{ needs.changes.outputs.light != 'true' }}" : undefined);
      const measure = job.steps.find((step) => step.name === 'Measure shard resources');
      expect(measure).toBeDefined();
      expect(measure.if).toContain('always()');
      expect(measure['continue-on-error']).toBe(true);
      expect(measure.run).toContain('nproc');
      expect(measure.run).toContain('/sys/fs/cgroup/memory.peak');
      expect(measure.run).toContain('unavailable');
      expect(measure.run).toContain('GITHUB_STEP_SUMMARY');
      expect(measure.run).toContain('/proc/uptime');
      const upload = job.steps.at(-1);
      expect(job.steps.at(-2)).toBe(measure);
      expect(upload.uses).toBe('actions/upload-artifact@v4');
      expect(upload.if).toContain('always()');
      expect(upload['continue-on-error']).toBe(true);
      expect(upload.with.name).toBe(`shard-resources-${name.replace('-shard', '')}-` + '${{ matrix.shard }}');
      expect(upload.with.path).toBe(name === 'test-shard' ? 'web-everything/shard-resources.json' : 'shard-resources.json');
      expect(upload.with['if-no-files-found']).toBe('ignore');
    });

    it('writes shard resource summary and JSON with measured values', () => {
      const result = measureResources(job);
      expect(result.json).toEqual({ nproc: 4, 'memory.peak': '4096', wall_seconds: 45 });
      expect(result.summary).toBe('nproc: 4\nmemory.peak: 4096\nwall time (seconds): 45\n');
    });

    it('emits valid JSON and a summary when memory.peak is unavailable', () => {
      const result = measureResources(job, { memory: null });
      expect(result.json).toEqual({ nproc: 4, 'memory.peak': 'unavailable', wall_seconds: 45 });
      expect(result.summary).toContain('memory.peak: unavailable\n');
    });

    it('keeps telemetry best effort when the CPU or start reading is unavailable', () => {
      expect(measureResources(job, { cpu: null, start: false }).json)
        .toEqual({ nproc: null, 'memory.peak': '4096', wall_seconds: null });
    });

    it('does not publish negative wall time or invalid memory readings', () => {
      expect(measureResources(job, { end: '99.9', memory: 'max' }).json)
        .toEqual({ nproc: 4, 'memory.peak': 'unavailable', wall_seconds: null });
    });

    it('keeps test, unit and soak run steps blocking', () => {
      expect(job['continue-on-error']).toBeUndefined();
      const runs = job.steps.filter((step) => /npm run test:/.test(step.run ?? ''));
      expect(runs.length).toBeGreaterThan(0);
      for (const step of runs) expect(step['continue-on-error']).toBeUndefined();
    });
  });
});

describe('PR shards finish below 1050 seconds with no new failures', () => {
  const step = () => jobs['worker-count-acceptance'].steps[0];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const shardJobs = () => ['test-shard', 'soak-shard'].flatMap(name => jobs[name].strategy.matrix.shard.map(shard => ({
    name: `${name} (${shard})`, status: 'completed', conclusion: 'success',
    started_at: '2026-11-20T12:00:00Z', completed_at: '2026-11-20T12:17:29Z',
  })));
  async function check(rows, soak = 'true') {
    const script = step().with.script.replaceAll('${{ needs.daemon-soak-scope.outputs.run }}', soak);
    const context = { repo: { owner: 'test', repo: 'repo' }, runId: 123 };
    const endpoint = Symbol('listJobsForWorkflowRun');
    const github = {
      rest: { actions: { listJobsForWorkflowRun: endpoint } },
      paginate: async (method, options) => {
        expect(method).toBe(endpoint);
        expect(options).toEqual({ owner: 'test', repo: 'repo', run_id: 123, filter: 'latest', per_page: 100 });
        return rows;
      },
    };
    return new AsyncFunction('github', 'context', 'core', script)(github, context, { info: () => {} });
  }

  it('runs a blocking acceptance check only for this experiment PR', () => {
    const job = jobs['worker-count-acceptance'];
    expect(job.if).toBe('${{ always() && github.event.pull_request.number == 7202 }}');
    expect(job.needs).toEqual(['test-shard', 'daemon-soak-scope', 'soak-shard']);
    expect(job.permissions).toEqual({ actions: 'read' });
    expect(job['continue-on-error']).toBeUndefined();
    expect(step().uses).toBe('actions/github-script@v7');
    expect(step()['continue-on-error']).toBeUndefined();
  });
  it('accepts all completed successful shards below the threshold', async () => {
    await expect(check(shardJobs())).resolves.toBeUndefined();
  });
  it.each(['failure', 'cancelled', 'skipped', 'timed_out', null])('rejects conclusion %j', async conclusion => {
    const rows = shardJobs(); rows[0].conclusion = conclusion;
    await expect(check(rows)).rejects.toThrow();
  });
  it.each(['2026-11-20T12:17:30Z', '2026-11-20T12:20:00Z', null, 'invalid', '2026-11-20T11:59:59Z'])
  ('rejects an excessive or unreadable duration ending %j', async completed_at => {
    const rows = shardJobs(); rows[0].completed_at = completed_at;
    await expect(check(rows)).rejects.toThrow();
  });
  it('rejects missing or duplicated shard evidence', async () => {
    await expect(check(shardJobs().slice(1))).rejects.toThrow();
    await expect(check([...shardJobs(), shardJobs()[0]])).rejects.toThrow();
    await expect(check([...shardJobs(), { ...shardJobs()[0], name: 'test-shard (11)' }])).rejects.toThrow();
  });
  it('rejects an unfinished shard even if its conclusion and timestamps look successful', async () => {
    const rows = shardJobs(); rows[0].status = 'in_progress';
    await expect(check(rows)).rejects.toThrow();
  });
  it('requires explicit scope evidence before omitting soak shards', async () => {
    const unit = shardJobs().filter(row => row.name.startsWith('test-shard'));
    await expect(check(unit, 'false')).resolves.toBeUndefined();
    await expect(check(unit, '')).rejects.toThrow();
    await expect(check(unit, 'true')).rejects.toThrow();
  });
  it('propagates an unavailable API instead of accepting missing evidence', async () => {
    const script = step().with.script.replaceAll('${{ needs.daemon-soak-scope.outputs.run }}', 'true');
    await expect(new AsyncFunction('github', 'context', 'core', script)({
      rest: { actions: {} }, paginate: async () => { throw new Error('unavailable'); },
    }, { repo: {}, runId: 123 }, {})).rejects.toThrow('unavailable');
  });
});
