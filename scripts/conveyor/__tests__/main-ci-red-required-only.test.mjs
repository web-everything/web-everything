import { describe, it, expect } from 'vitest';
import { probeMainCiRuns } from '../main-ci-red-io.mjs';
import { mainRedState, classifyRun } from '../main-ci-red-core.mjs';

// R516: main health is judged by required checks only. A cancelled or failed non-gating job
// (continue-on-error, e.g. test-selection-measure) must never make main red.
const REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const SHA = '1b2aa007d0000000000000000000000000000000';
const run = { databaseId: 41701873905, headSha: SHA, status: 'completed', conclusion: 'failure', event: 'push',
  createdAt: '2026-11-03T19:17:00Z', updatedAt: '2026-11-03T20:00:00Z', attempt: 1 };
const job = (id, name, conclusion) => ({ id, name, conclusion, status: 'completed' });

function probe(jobs, { required = REQUIRED, runs = [run] } = {}) {
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
  return probeMainCiRuns({ exec, readRequired: () => ({ checks: required }) });
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
});
