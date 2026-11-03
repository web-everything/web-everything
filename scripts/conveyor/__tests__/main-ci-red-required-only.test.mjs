import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeMainCiRuns } from '../main-ci-red-io.mjs';
import { mainRedState, classifyRun } from '../main-ci-red-core.mjs';

// R516: main health is judged by required checks only. A cancelled or failed non-gating job
// (continue-on-error, e.g. test-selection-measure) must never make main red.
const REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const SHA = '1b2aa007d0000000000000000000000000000000';
const run = { databaseId: 41701873905, headSha: SHA, status: 'completed', conclusion: 'failure', event: 'push',
  createdAt: '2026-11-03T19:17:00Z', updatedAt: '2026-11-03T20:00:00Z', attempt: 1 };
const job = (id, name, conclusion) => ({ id, name, conclusion, status: 'completed' });

function probe(jobsIn, { required = REQUIRED, runs = [run], source } = {}) {
  // A realistic run carries both required summary jobs; a case that wants one absent or failing names it itself.
  const jobs = [...jobsIn, ...(jobsIn.some((j) => j.name === 'daemon-soak') ? [] : [job(9, 'daemon-soak', 'success')])];
  const exec = (bin, argv) => {
    const url = argv.join(' ');
    if (argv[0] === 'run' && argv[1] === 'list') return JSON.stringify(runs);
    if (/actions\/runs\/\d+\/jobs/.test(url)) return JSON.stringify({ total_count: jobs.length, jobs });
    if (/annotations/.test(url)) return '[]';
    if (/actions\/jobs\/\d+\/logs/.test(url)) return '';
    if (/commits\/main/.test(url) && argv.includes('--jq')) return SHA;
    if (/check-runs/.test(url)) return JSON.stringify({ total_count: 0, check_runs: [] });
    return 'null';
  };
  return probeMainCiRuns({ exec, readRequired: () => ({ checks: required, ...(source ? { source } : {}) }) });
}

describe('main-red judges required checks only (R516)', () => {
  it('a cancelled non-gating job does not make main red', () => {
    const p = probe([job(1, 'test', 'success'), job(2, 'smoke', 'success'), job(3, 'test-selection-measure', 'cancelled')]);
    expect(mainRedState(p.runs, { tip: p.tip }).status).not.toBe('red');
  });
  it('a FAILED non-gating job (timed out) does not make main red', () => {
    const p = probe([job(1, 'test', 'success'), job(2, 'smoke', 'success'), job(3, 'test-selection-measure', 'timed_out')]);
    expect(classifyRun(p.runs[0])).not.toBe('red');
    expect(mainRedState(p.runs, { tip: p.tip }).status).not.toBe('red');
    expect(p.failing.jobs).toEqual([]);
  });
  it('a failed REQUIRED job still makes main red', () => {
    const p = probe([job(1, 'test', 'failure'), job(2, 'smoke', 'success'), job(3, 'test-selection-measure', 'timed_out')]);
    expect(mainRedState(p.runs, { tip: p.tip }).status).toBe('red');
    expect(p.failing.jobs).toEqual(['test', 'test-selection-measure']); // root-cause names stay
  });
  it('fails closed: an unreadable required set keeps every failed job gating', () => {
    const p = probe([job(1, 'test', 'success'), job(3, 'test-selection-measure', 'timed_out')], { required: [] });
    expect(mainRedState(p.runs, { tip: p.tip }).status).toBe('red');
  });
  it('a failed shard under a cancelled required summary stays red (positive proof needed)', () => {
    const p = probe([job(1, 'test', 'cancelled'), job(2, 'smoke', 'success'), job(3, 'test-shard (3)', 'failure')]);
    expect(mainRedState(p.runs, { tip: p.tip }).status).toBe('red');
  });
  it('an untrusted required list (fallback / stale-cache) filters nothing', () => {
    for (const source of ['fallback', 'stale-cache']) {
      const p = probe([job(1, 'test', 'success'), job(3, 'test-selection-measure', 'timed_out')], { source });
      expect(mainRedState(p.runs, { tip: p.tip }).status).toBe('red');
    }
  });
  it('an ABSENT required summary job is red, not proof (failed shard, no `test` job)', () => {
    const p = probe([job(2, 'smoke', 'success'), job(3, 'test-shard (3)', 'failure')]);
    expect(mainRedState(p.runs, { tip: p.tip }).status).toBe('red');
    expect(p.failing.jobs).toEqual(['test-shard (3)']);
  });
  it('a stale / fallback required list is never reread for the tip either', () => {
    const calls = [];
    const exec = (bin, argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'run') return JSON.stringify([run]);
      if (/\/jobs/.test(argv.join(' '))) return JSON.stringify({ total_count: 1, jobs: [job(3, 'test-shard (3)', 'failure')] });
      if (argv.includes('--jq')) return SHA;
      return JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] });
    };
    let reads = 0;
    const readRequired = () => { reads += 1; return { checks: ['test'], source: 'stale-cache' }; };
    const p = probeMainCiRuns({ exec, readRequired });
    expect(reads).toBe(1);
    expect(p.tip ?? null).toBeNull();
    expect(mainRedState(p.runs, { tip: p.tip }).status).toBe('red');
  });
  it('the shadow full-suite step does not mask its exit code, so the recorder runs only after a real success', () => {
    const yml = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const step = yml.slice(yml.indexOf('- name: Shadow full-suite run (json report)')).split('\n      - name:')[0];
    expect(step).toContain('timeout-minutes: 18');
    expect(step).not.toMatch(/\|\|\s*true/);
    const record = yml.slice(yml.indexOf('- name: Record false-green signal')).split('\n      - name:')[0];
    expect(record).toContain("steps.shadow_full.outcome == 'success'");
    expect(record).toContain("hashFiles('web-everything/vitest-full.json')"); // a red run still records; a crash or timeout leaves no report
  });
});
