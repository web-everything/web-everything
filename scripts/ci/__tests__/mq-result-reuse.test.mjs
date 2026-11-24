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
const run = (over = {}) => ({ id: 7, head_sha: SHA, event: 'merge_group', status: 'completed', conclusion: 'success', ...over });

const go = (runs, jobs, extra = {}) =>
  decide({ listQueueRuns: async () => runs, listRunJobs: async () => jobs, sha: SHA, event: 'push', quarantineClear: async () => true, ...extra });
const fakeFetch = (runs, body) => async (url) => ({ ok: true, json: async () => (String(url).includes('/jobs') ? body : { workflow_runs: runs }) });
const without = (name) => fullJobs().filter((j) => j.name !== name);

describe('mq-result-reuse (forge.merge-queue: reuse only for the exact same sha, full run)', () => {
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
  it.each(['active', 'expired', 'empty', 'unreadable'])('reads %s quarantine through the real IO adapter and predicate', async kind => {
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
        if (args[0] === 'ls-tree') return 'quarantine.json';
        if (args[0] === 'show') return readFileSync(join(dir, 'quarantine.json'), 'utf8');
        throw new Error(`unexpected transport command ${args[0]}`);
      } });
      expect(clear).toBe(['empty', 'expired'].includes(kind));
      expect(calls[0]).toContain('+refs/heads/ops/quarantine:refs/remotes/origin/ops/quarantine');
      if (kind !== 'unreadable') expect(calls.at(-1)).toEqual(['show', 'origin/ops/quarantine:quarantine.json']);
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
      ? "${{ steps.covered.outputs.full == 'true' || steps.nocov.outputs.full == 'true' }}"
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
