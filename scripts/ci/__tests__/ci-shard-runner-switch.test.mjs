// @vitest-environment node
// #5027 — pins the Arm-runner experiment switch in ci.yml: ONLY `test-shard` reads `vars.WE_SHARD_RUNNER`
// (falling back to x86), every other job stays on `ubuntu-latest`, and the matrix stays single-axis so
// `strategy.job-total` remains the shard divisor.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobs = yaml.load(raw).jobs;

describe('ci.yml test-shard runner switch (#5027)', () => {
  it('test-shard uses the paid runner var ONLY for merge_group or a ci:priority PR, ubuntu-latest otherwise', () => {
    const expr = jobs['test-shard']['runs-on'];
    expect(expr).toBe(
      "${{ (github.event_name == 'merge_group' || contains(github.event.pull_request.labels.*.name, 'ci:priority')) && vars.WE_SHARD_RUNNER || 'ubuntu-latest' }}",
    );
    // Model the expression as GitHub evaluates it (a falsy var falls through to the fallback).
    const run = ({ event, labels = [], runner }) =>
      ((event === 'merge_group' || (event === 'pull_request' && labels.includes('ci:priority'))) && runner) || 'ubuntu-latest';
    // case 1: merge queue
    expect(run({ event: 'merge_group', runner: 'we-8core' })).toBe('we-8core');
    // case 2: prioritized PR
    expect(run({ event: 'pull_request', labels: ['ci:priority'], runner: 'we-8core' })).toBe('we-8core');
    // case 3: everything else
    expect(run({ event: 'pull_request', labels: ['other'], runner: 'we-8core' })).toBe('ubuntu-latest');
    expect(run({ event: 'push', runner: 'we-8core' })).toBe('ubuntu-latest');
    // var unset or empty
    expect(run({ event: 'merge_group', runner: '' })).toBe('ubuntu-latest');
    expect(run({ event: 'pull_request', labels: ['ci:priority'], runner: undefined })).toBe('ubuntu-latest');
  });

  it('exactly one job (test-shard) reads WE_SHARD_RUNNER', () => {
    const readers = Object.entries(jobs).filter(([, j]) => JSON.stringify(j['runs-on'] ?? '').includes('WE_SHARD_RUNNER')).map(([n]) => n);
    expect(readers).toEqual(['test-shard']);
    expect(raw.split('\n').filter((l) => /^ {4}runs-on: .*vars\.WE_SHARD_RUNNER/.test(l))).toHaveLength(1);
  });

  it('every other job stays on ubuntu-latest (the switch must not widen)', () => {
    for (const [name, j] of Object.entries(jobs)) {
      if (name === 'test-shard') continue;
      expect(j['runs-on'], `${name} must not follow the Arm switch`).toBe('ubuntu-latest');
    }
    for (const name of ['test', 'changes', 'daemon-soak-scope', 'soak-shard']) expect(jobs[name]).toBeDefined();
  });

  it('keeps the shard matrix single-dimension so strategy.job-total stays the divisor', () => {
    const matrix = jobs['test-shard'].strategy.matrix;
    expect(Object.keys(matrix)).toEqual(['shard']);
    expect(Array.isArray(matrix.shard)).toBe(true);
  });
});
