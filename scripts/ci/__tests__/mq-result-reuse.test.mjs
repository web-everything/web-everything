// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { decide, githubReads, main, quarantineClear, EXPECTED_MATRIX_JOBS, REQUIRED_JOBS } from '../mq-result-reuse.mjs';
import { activeEntries, addEntries } from '../../lib/red-main-quarantine.mjs';

const SHA = 'a'.repeat(40);
const RECEIPT = 'Full test run (no quarantine exclusions)';
const required = ['changes', 'standards', 'coverage-merge', 'host-paths', 'integration', 'test', 'smoke', 'daemon-soak'];
const matrix = [
  ...Array.from({ length: 10 }, (_, i) => `test-shard (${i + 1})`),
  ...['scan-chain', 'sim-scenarios', 'lane-pool-a', 'lane-pool-b', 'parallel'].map(g => `integration-part (${g})`),
  ...Array.from({ length: 8 }, (_, i) => `soak-shard (${i + 1})`),
];
const ok = (name) => ({ name, conclusion: 'success', steps: [{ name: RECEIPT, conclusion: 'success' }] });
const fullJobs = () => [...matrix, ...required].map(ok);
const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const run = (over = {}) => ({ id: 7, workflow_id: 382175354, head_sha: SHA, event: 'merge_group', status: 'completed', conclusion: 'success', ...over });

const go = (runs, jobs, extra = {}) =>
  decide({ listQueueRuns: async () => runs, listRunJobs: async () => jobs, sha: SHA, event: 'push', quarantineClear: async () => true, ...extra });
// Repository endpoint confirmed by review's live probe (run 45531076311, workflow_id 382175354).
// The ruleset-pinned workflow ID does NOT resolve under actions/workflows/<id>/runs.
const runsUrl = `https://api.github.com/repos/o/r/actions/runs?event=merge_group&head_sha=${SHA}&per_page=100&page=1`;
const jobsUrl = 'https://api.github.com/repos/o/r/actions/runs/7/jobs?filter=latest&per_page=100&page=1';
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const fakeFetch = (runs, body) => async (url) => {
  if (url === runsUrl) return response({ workflow_runs: runs, total_count: runs.length });
  if (/^https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\/7\/jobs\?filter=latest&per_page=100&page=\d+$/.test(url)) return response(body);
  return response({ message: 'Not Found' }, 404);
};
const without = (name) => fullJobs().filter((j) => j.name !== name);

describe('mq-result-reuse (forge.merge-queue: reuse only for the exact same sha, full run)', () => {
  it('uses the recorded repository runs endpoint and filters the queue workflow identity', async () => {
    const reads = githubReads({ repo: 'o/r', token: 't', fetchImpl: fakeFetch([
      run(), run({ id: 99, workflow_id: 305968843, conclusion: 'failure' }),
    ], { jobs: fullJobs(), total_count: fullJobs().length }) });
    expect(await decide({ ...reads, sha: SHA, event: 'push', quarantineClear: async () => true })).toMatchObject({ reuse: true, runId: 7 });
    const unrelated = githubReads({ repo: 'o/r', token: 't', fetchImpl: fakeFetch([run({ workflow_id: 1 })], {}) });
    expect(await unrelated.listQueueRuns(SHA)).toEqual([]);
  });
  it.each(['runs', 'jobs'])('HTTP errors from either provider endpoint refuse an otherwise reusable run: %s', async endpoint => {
    const good = fakeFetch([run()], { jobs: fullJobs(), total_count: fullJobs().length });
    const fetchImpl = async url => url === (endpoint === 'runs' ? runsUrl : jobsUrl)
      // Valid-looking bodies make removing the HTTP guard a discriminating mutation.
      ? response(endpoint === 'runs' ? { workflow_runs: [run()], total_count: 1 } : { jobs: fullJobs(), total_count: fullJobs().length }, 503)
      : good(url);
    const reads = githubReads({ repo: 'o/r', token: 't', fetchImpl });
    expect(await decide({ ...reads, sha: SHA, event: 'push', quarantineClear: async () => true }))
      .toEqual({ reuse: false, why: 'error: GitHub API 503' });
  });
  it('includes a newer failed queue run on a later repository page', async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => run({ id: i + 10, workflow_id: 1 })), [run(), run({ id: 9, conclusion: 'failure' })]];
    const fetchImpl = async url => {
      if (url.includes('/jobs?')) return response({ jobs: fullJobs(), total_count: fullJobs().length });
      const page = Number(new URL(url).searchParams.get('page'));
      return response({ workflow_runs: pages[page - 1] ?? [], total_count: 102 });
    };
    const reads = githubReads({ repo: 'o/r', token: 't', fetchImpl });
    expect(await decide({ ...reads, sha: SHA, event: 'push', quarantineClear: async () => true }))
      .toEqual({ reuse: false, why: 'run completed/failure' });
  });
  it.each([{}, { workflow_runs: [run()] }, { workflow_runs: [], total_count: 1 }, { workflow_runs: [run()], total_count: 1001 },
    { workflow_runs: [run(), run()], total_count: 2 }, { workflow_runs: [run({ id: null })], total_count: 1 },
  ])('refuses incomplete or oversized repository runs evidence: %j', async body => {
    const reads = githubReads({ repo: 'o/r', token: 't', fetchImpl: async () => response(body) });
    await expect(reads.listQueueRuns(SHA)).rejects.toThrow(/runs listing/);
  });
  it('executes the checkout-only reuse script and dynamic quarantine imports without external packages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-no-packages-'));
    try {
      const loader = join(dir, 'no-packages.mjs');
      writeFileSync(loader, `export async function resolve(specifier, context, next) {
        if (!specifier.startsWith('node:') && !specifier.startsWith('file:') && !specifier.startsWith('.') && !specifier.startsWith('/'))
          throw new Error('checkout-only job cannot import package: ' + specifier);
        const result = await next(specifier, context);
        if (result.url.includes('/node_modules/')) throw new Error('checkout-only job cannot load node_modules');
        return result;
      }`);
      const script = `import { main } from ${JSON.stringify(new URL('../mq-result-reuse.mjs', import.meta.url).href)};
        await main({ env: ${JSON.stringify({ GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: join(dir, 'output') })},
          fetchImpl: async url => ({ ok: true, json: async () => url.includes('/jobs?')
            ? ${JSON.stringify({ jobs: fullJobs(), total_count: fullJobs().length })}
            : ${JSON.stringify({ workflow_runs: [run()], total_count: 1 })} }),
          quarantineOptions: { run: args => {
            if (args[0] === 'fetch') return '';
            if (args[0] === 'ls-tree') return 'quarantine.json';
            if (args[0] === 'show') return '{"version":1,"entries":[]}';
            throw new Error('unexpected git operation: ' + args[0]);
          } }
        });`;
      const result = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(dir, 'output'), 'utf8'), result.stdout).toBe('reuse=true\n');
      expect(result.stdout).toContain(`REUSING merge-queue run 7 for ${SHA}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['summary', 'first-output'])('CLI catch writes a final reuse=false after %s write failure', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-catch-'));
    try {
      const preload = join(dir, 'preload.mjs');
      writeFileSync(preload, `import fs from 'node:fs'; import child from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
        globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('/jobs?')
          ? ${JSON.stringify({ jobs: fullJobs(), total_count: fullJobs().length })}
          : ${JSON.stringify({ workflow_runs: [run()], total_count: 1 })} });
        child.execFileSync = (command, args) => {
          if (command !== 'git') throw new Error('unexpected command');
          if (args[0] === 'fetch') return '';
          if (args[0] === 'ls-tree') return 'quarantine.json';
          if (args[0] === 'show') return '{"version":1,"entries":[]}';
          throw new Error('unexpected git operation: ' + args[0]);
        };
        const append = fs.appendFileSync; let first = true;
        fs.appendFileSync = (...args) => {
          if (${JSON.stringify(kind)} === 'first-output' && first) { first = false; throw new Error('first output refused'); }
          return append(...args);
        }; syncBuiltinESMExports();`);
      const output = join(dir, 'output');
      const result = spawnSync(process.execPath, ['--import', preload, new URL('../mq-result-reuse.mjs', import.meta.url).pathname], {
        cwd: dir, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, GITHUB_EVENT_NAME: kind === 'summary' ? 'push' : 'pull_request', GITHUB_SHA: SHA,
          GITHUB_REPOSITORY: 'o/r', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: dir },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('full run (error:');
      if (kind === 'summary') expect(result.stdout).toContain('REUSING merge-queue run 7');
      expect(readFileSync(output, 'utf8').trim().split('\n').at(-1)).toBe('reuse=false');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reuses an identical full successful merge-queue run', async () => {
    const v = await go([run()], fullJobs());
    expect(v.reuse).toBe(true);
    expect(v.runId).toBe(7);
  });
  it('runs fully for a different sha', async () => {
    expect((await go([run({ head_sha: 'b'.repeat(40) })], fullJobs())).reuse).toBe(false);
  });
  it('runs fully for a partial MQ run: any missing or skipped shard or aggregate job', async () => {
    for (const name of [...matrix, ...required]) {
      expect((await go([run()], without(name))).reuse, name).toBe(false);
      const skipped = fullJobs().map((j) => (j.name === name ? { ...j, conclusion: 'skipped' } : j));
      expect((await go([run()], skipped)).reuse, `${name} skipped`).toBe(false);
      const failed = fullJobs().map((j) => (j.name === name ? { ...j, conclusion: 'failure' } : j));
      expect((await go([run()], failed)).reuse, `${name} failed`).toBe(false);
    }
  });
  it('runs fully for a failed or unfinished MQ run', async () => {
    expect((await go([run({ conclusion: 'failure' })], fullJobs())).reuse).toBe(false);
    expect((await go([run({ status: 'in_progress', conclusion: null })], fullJobs())).reuse).toBe(false);
  });
  it('a newer failed run for the same sha beats an older success', async () => {
    expect((await go([run({ id: 7 }), run({ id: 9, conclusion: 'failure' })], fullJobs())).reuse).toBe(false);
  });
  it('runs fully with an incomplete jobs listing', async () => {
    const reads = (body) => githubReads({ repo: 'o/r', token: 't', fetchImpl: fakeFetch([run()], body) });
    for (const body of [{ jobs: fullJobs(), total_count: 999 }, {}, { jobs: fullJobs() }]) {
      const r = reads(body);
      expect((await decide({ ...r, sha: SHA, event: 'push', quarantineClear: async () => true })).reuse).toBe(false);
    }
    const good = reads({ jobs: fullJobs(), total_count: fullJobs().length });
    expect((await decide({ ...good, sha: SHA, event: 'push', quarantineClear: async () => true })).reuse).toBe(true);
  });
  it('runs fully when a red-main quarantine is active or unreadable', async () => {
    expect((await go([run()], fullJobs(), { quarantineClear: async () => false })).reuse).toBe(false);
  });
  it('runs fully with no MQ run, a non-merge_group run, a non-push event, or an API error', async () => {
    expect((await go([], fullJobs())).reuse).toBe(false);
    expect((await go([run({ event: 'push' })], fullJobs())).reuse).toBe(false);
    expect((await go([run()], fullJobs(), { event: 'pull_request' })).reuse).toBe(false);
    const boom = async () => {
      throw new Error('GitHub API 500');
    };
    expect((await decide({ listQueueRuns: boom, listRunJobs: boom, sha: SHA, event: 'push' })).reuse).toBe(false);
  });
  it('pins every required job independently and matches complete workflow matrix expansions', () => {
    expect(REQUIRED_JOBS).toEqual(required);
    expect(Object.keys(workflow.jobs).sort()).toEqual([...required, 'daemon-soak-scope', 'visual', 'test-shard', 'integration-part', 'soak-shard'].sort());
    for (const name of required) {
      expect(workflow.jobs).toHaveProperty(name);
      expect(workflow.jobs[name].name, name).toBeUndefined();
    }
    const expanded = Object.entries(workflow.jobs).flatMap(([name, job]) => {
      if (!job.strategy?.matrix) return [];
      expect(job.name, name).toBeUndefined();
      const { include = [], exclude = [], ...dimensions } = job.strategy.matrix;
      expect(exclude).toEqual([]);
      const axes = Object.entries(dimensions);
      const combinations = axes.reduce((rows, [key, values]) => rows.flatMap(row => values.map(value => ({ ...row, [key]: value }))), [{}]);
      // Current include rows only attach metadata to an existing combination; a new combination requires review.
      for (const entry of include) expect(combinations.some(row => axes.every(([key]) => row[key] === entry[key]))).toBe(true);
      return combinations.map(row => `${name} (${axes.map(([key]) => row[key]).join(', ')})`);
    });
    expect([...EXPECTED_MATRIX_JOBS].sort()).toEqual(expanded.sort());
    expect(EXPECTED_MATRIX_JOBS).toEqual(matrix);
  });
  it('runs fully with no quarantineClear on an otherwise perfect run', async () => {
    const v = await decide({ listQueueRuns: async () => [run()], listRunJobs: async () => fullJobs(), sha: SHA, event: 'push' });
    expect(v).toMatchObject({ reuse: false, why: 'red-main quarantine active or unreadable' });
  });
  it('runs fully if a quarantine guard throws', async () => {
    expect((await go([run()], fullJobs(), { quarantineClear: async () => { throw new Error('unreadable'); } })).reuse).toBe(false);
  });
  it('runs fully when quarantine expires after the queue run, including entries removed since the run', async () => {
    const now = 2000;
    for (const entries of [[{ expiresAt: 1500 }], []]) {
      const clear = async () => activeEntries({ entries }, { now }).length === 0;
      // The old queue jobs succeeded while skipping tests, so they have no full-test receipt.
      const jobs = fullJobs().map(({ steps, ...job }) => job);
      expect((await go([run()], jobs, { quarantineClear: clear })).reuse).toBe(false);
    }
  });
  it('requires a successful full-test receipt in every matrix job', async () => {
    for (const name of matrix) {
      for (const steps of [undefined, [], [{ name: RECEIPT, conclusion: 'skipped' }], [{ name: RECEIPT, conclusion: 'failure' }]]) {
        const jobs = fullJobs().map(j => j.name === name ? { ...j, steps } : j);
        expect((await go([run()], jobs)).reuse, name).toBe(false);
      }
    }
  });
  it.each([
    ['unreadable', { ok: false, list: { entries: [] } }, false],
    ['active', { ok: true, list: { entries: [{ expiresAt: 2001 }] } }, false],
    ['clear', { ok: true, list: { entries: [] } }, true],
    ['expired', { ok: true, list: { entries: [{ expiresAt: 1999 }] } }, true],
  ])('the real quarantine predicate handles %s evidence', async (_label, got, expected) => {
    let options;
    expect(await quarantineClear({ readQuarantine: o => { options = o; return got; }, now: 2000, board: '/fixture' })).toBe(expected);
    expect(options).toEqual({ board: '/fixture' });
  });
  it('pins workflow light/reuse outputs and the soak-shard reuse condition', () => {
    expect(workflow.jobs.changes.outputs.light).toBe("${{ steps.reuse.outputs.reuse == 'true' && 'true' || steps.detect.outputs.light }}");
    expect(workflow.jobs.changes.outputs.reuse).toBe('${{ steps.reuse.outputs.reuse }}');
    expect(workflow.jobs['soak-shard'].if).toContain("needs.changes.outputs.reuse != 'true'");
  });
  it.each(['active', 'expired', 'empty', 'unreadable', 'absent', 'malformed', 'invalid'])('reads %s quarantine through the real IO adapter and predicate', async kind => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-quarantine-'));
    const list = addEntries(null, { tests: ['scripts/a.test.mjs'], brokenSha: SHA, owner: 'fixture', reason: 'fixture', actor: 'operator', now: 1000, ttlMs: 1000 }).list;
    writeFileSync(join(dir, 'quarantine.json'), JSON.stringify(kind === 'empty' ? { version: 1, entries: [] } : list));
    const calls = [];
    try {
      const clear = await quarantineClear({ board: dir, now: kind === 'expired' ? 3000 : 1500, run: (args, options) => {
        calls.push(args);
        expect(options.cwd).toBe(dir);
        if (args[0] === 'fetch') {
          if (kind === 'unreadable') throw new Error('unreadable quarantine');
          return '';
        }
        if (args[0] === 'ls-tree') return kind === 'absent' ? '' : 'quarantine.json';
        if (args[0] === 'show') return kind === 'malformed' ? '{' : kind === 'invalid' ? '{"version":2,"entries":[]}' : readFileSync(join(dir, 'quarantine.json'), 'utf8');
        throw new Error(`unexpected transport command ${args[0]}`);
      } });
      expect(clear).toBe(['empty', 'expired', 'absent'].includes(kind));
      expect(calls[0]).toContain('+refs/heads/ops/quarantine:refs/remotes/origin/ops/quarantine');
      if (!['unreadable', 'absent'].includes(kind)) expect(calls.at(-1)).toEqual(['show', 'origin/ops/quarantine:quarantine.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['test-shard', 'Unit suite shard', 'covered'],
    ['test-shard', 'Unit suite no-coverage group', 'nocov'],
    ['integration-part', 'Real-git integration suite', 'suite'],
    ['soak-shard', 'Soak shard', 'suite'],
  ])('%s/%s receipts reflect actual runner arguments and success', async (job, prefix, id) => {
    const steps = workflow.jobs[job].steps;
    const step = steps.find(s => s.name?.startsWith(prefix));
    expect(steps.filter(s => s.name === RECEIPT)).toHaveLength(1);
    const receipt = steps.find(s => s.name === RECEIPT);
    expect(receipt).toMatchObject({ run: 'echo "All assigned tests ran without quarantine exclusions"' });
    expect(receipt.if).toBe(job === 'test-shard'
      ? "${{ needs.changes.outputs.light != 'true' && (steps.covered.outputs.full == 'true' || steps.nocov.outputs.full == 'true') }}"
      : "${{ steps.suite.outputs.full == 'true' }}");
    expect(receipt['continue-on-error']).toBeUndefined();
    expect(step.id).toBe(id);
    expect(step['continue-on-error']).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'mq-receipt-'));
    try {
      const bin = join(dir, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'node'), '#!/bin/bash\ncase "$1" in *shard-assign*) echo scripts/a.test.mjs ;; *) printf "%s" "$EXCLUSIONS" ;; esac\n');
      writeFileSync(join(bin, 'npm'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$ARGV_FILE"\nexit "$TEST_STATUS"\n');
      chmodSync(join(bin, 'node'), 0o755); chmodSync(join(bin, 'npm'), 0o755);
      const script = step.run.replaceAll('${{ matrix.shard }}', '1').replaceAll('${{ matrix.group }}', 'parallel').replaceAll('${{ strategy.job-total }}', '8');
      for (const exclusions of ['', '--exclude=scripts/a.test.mjs', '--exclude=scripts/a.test.mjs --quarantined=scripts/a.test.mjs']) {
        for (const status of [0, 1]) {
          const output = join(dir, 'output'), argv = join(dir, 'argv'); writeFileSync(output, '');
          const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', env: {
            ...process.env, PATH: `${bin}:${process.env.PATH}`, EXCLUSIONS: exclusions, TEST_STATUS: String(status), GITHUB_OUTPUT: output, ARGV_FILE: argv,
          } });
          expect(result.status, result.stderr).toBe(status);
          expect(readFileSync(output, 'utf8')).toBe(exclusions === '' && status === 0 ? 'full=true\n' : '');
          const actual = readFileSync(argv, 'utf8');
          for (const arg of exclusions.split(' ').filter(Boolean)) expect(actual).toContain(`${arg}\n`);
          // Replay the real step's output as the receipt conclusion consumed by the reuse decision.
          const receiptSucceeded = readFileSync(output, 'utf8') === 'full=true\n';
          const name = job === 'integration-part' ? 'integration-part (parallel)' : `${job} (1)`;
          const jobs = fullJobs().map(j => j.name === name ? { ...j, steps: [{ name: RECEIPT, conclusion: receiptSucceeded ? 'success' : 'skipped' }] } : j);
          expect((await go([run()], jobs)).reuse).toBe(exclusions === '' && status === 0);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([true, false])('CLI writes reuse=%s and the corresponding summary through real provider wiring', async reuse => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-reuse-cli-'));
    try {
      const output = join(dir, 'output'), summary = join(dir, 'summary');
      await main({
        env: { GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
        fetchImpl: fakeFetch([run()], { jobs: fullJobs(), total_count: fullJobs().length }),
        quarantineOptions: { readQuarantine: () => ({ ok: reuse, list: { entries: [] } }) },
      });
      expect(readFileSync(output, 'utf8')).toBe(`reuse=${reuse}\n`);
      const line = readFileSync(summary, 'utf8');
      expect(line).toContain(reuse ? `REUSING merge-queue run 7 for ${SHA}` : 'full run (red-main quarantine active or unreadable)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
