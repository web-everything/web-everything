// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planObsoleteRunCancels, resolveCancelObsoleteRunsSettings, formatCancelObsoleteRunsSettings, cancelObsoleteQueueRuns } from '../merge-queue-obsolete-runs.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { readDeclaredSettings } from '../settings-files.mjs';

const nowMs = Date.parse('2026-10-13T12:00:00Z');
const branch = 'gh-readonly-queue/main/pr-42-abc';
const run = (overrides = {}) => ({ id: 42, name: 'CI', event: 'merge_group', status: 'in_progress', head_branch: branch, head_sha: 'abc', created_at: new Date(nowMs - 60000).toISOString(), ...overrides });
const settings = { cancelObsoleteRuns: 'on', minAgeSeconds: 30, sources: { cancelObsoleteRuns: 'repo', minAgeSeconds: 'standard' }, invalid: [] };
const plan = (runs, liveRefs = {}) => planObsoleteRunCancels({ runs, liveRefs, nowMs, settings });

describe('obsolete run planner', () => {
  it('cancels deleted refs, sorted by run id', () => {
    expect(plan([run({ id: 50 }), run()])).toEqual({ cancel: [42, 50].map(id => ({ id, name: 'CI', headBranch: branch, reason: 'ref-deleted' })), keep: [] });
  });
  it('cancels a rebuilt ref whose sha differs', () => {
    expect(plan([run()], new Map([[branch, 'def']])).cancel[0].reason).toBe('ref-rebuilt');
  });
  it('keeps a live ref with the same sha for both ref representations', () => {
    for (const refs of [{ [branch]: 'abc' }, new Map([[branch, 'abc']])]) {
      expect(plan([run()], refs)).toEqual({ cancel: [], keep: [{ id: 42, reason: 'live-ref' }] });
    }
  });
  it('ignores completed, non-merge_group and non-queue runs', () => {
    expect(plan([run({ status: 'completed' }), run({ event: 'push' }), run({ head_branch: 'main' })])).toEqual({ cancel: [], keep: [] });
  });
  it('keeps young runs even if the ref is missing or rebuilt; cancels at the age boundary', () => {
    const young = run({ created_at: new Date(nowMs - 29999).toISOString() });
    for (const refs of [{}, { [branch]: 'def' }]) expect(plan([young], refs).keep).toEqual([{ id: 42, reason: 'too-young' }]);
    expect(plan([run({ created_at: new Date(nowMs - 30000).toISOString() })]).cancel).toHaveLength(1);
  });
  it('keeps an unparseable age rather than cancelling without age evidence', () => {
    expect(plan([run({ created_at: 'bad' })]).cancel).toEqual([]);
  });
});

describe('obsolete run settings', () => {
  const resolve = (options = {}) => resolveCancelObsoleteRunsSettings({ env: {}, settings: {}, platform: {}, ...options });
  it('resolves env > repo > platform > standard independently for both keys', () => {
    const repo = { mergeQueue: { cancelObsoleteRuns: 'off', cancelObsoleteRunsMinAgeSeconds: 20 } };
    const platform = { mergeQueue: { cancelObsoleteRuns: 'on', cancelObsoleteRunsMinAgeSeconds: 10 } };
    const env = { WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS: 'on', WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS_MIN_AGE_SECONDS: '0' };
    for (const [options, value, age, source] of [
      [{ env, settings: repo, platform }, 'on', 0, 'env'],
      [{ settings: repo, platform }, 'off', 20, 'repo'],
      [{ platform }, 'on', 10, 'platform'],
      [{}, 'on', 30, 'standard'],
    ]) expect(resolve(options)).toEqual({ cancelObsoleteRuns: value, minAgeSeconds: age, sources: { cancelObsoleteRuns: source, minAgeSeconds: source }, invalid: [] });
    expect(resolve({ env: { WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS: 'on' }, settings: repo }).sources).toEqual({ cancelObsoleteRuns: 'env', minAgeSeconds: 'repo' });
  });
  it('reports invalid values and lets lower layers answer', () => {
    const s = resolve({ env: { WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS: 'yes', WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS_MIN_AGE_SECONDS: '-1' }, settings: { mergeQueue: { cancelObsoleteRuns: false, cancelObsoleteRunsMinAgeSeconds: 1.5 } }, platform: { mergeQueue: { cancelObsoleteRuns: 'off', cancelObsoleteRunsMinAgeSeconds: 5 } } });
    expect(s.cancelObsoleteRuns).toBe('off');
    expect(s.minAgeSeconds).toBe(5);
    expect(s.sources).toEqual({ cancelObsoleteRuns: 'platform', minAgeSeconds: 'platform' });
    expect(s.invalid).toEqual(['env.mergeQueue.cancelObsoleteRuns', 'repo.mergeQueue.cancelObsoleteRuns', 'env.mergeQueue.cancelObsoleteRunsMinAgeSeconds', 'repo.mergeQueue.cancelObsoleteRunsMinAgeSeconds']);
    expect(formatCancelObsoleteRunsSettings(s)).toContain('ignored invalid: env.mergeQueue.cancelObsoleteRuns');
  });
  it.each(['', '1.5', 'Infinity', '1e2', '0x10', null, true])('rejects malformed minimum ages: %s', value => {
    expect(resolve({ env: { WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS_MIN_AGE_SECONDS: value } }).invalid).toContain('env.mergeQueue.cancelObsoleteRunsMinAgeSeconds');
  });
  it.each(['VITEST', 'WE_UNDER_TEST'])('isolates live repo settings under %s', key => {
    expect(resolveCancelObsoleteRunsSettings({ env: { [key]: '1' }, platform: {} }).sources.cancelObsoleteRuns).toBe('standard');
  });
  it('formats settings with sources and gives each leaf exactly one declared owner', () => {
    expect(formatCancelObsoleteRunsSettings(settings)).toBe('merge-queue: cancelObsoleteRuns=on (repo), minAgeSeconds=30 (standard)');
    const declared = readDeclaredSettings();
    for (const key of ['cancelObsoleteRuns', 'cancelObsoleteRunsMinAgeSeconds']) {
      expect(declared.owners[`mergeQueue.${key}`]).toBe('settings/merge-queue-obsolete-runs.json');
      expect(declared.duplicates.some(d => d.path === `mergeQueue.${key}`)).toBe(false);
    }
  });
});

function io({ dryRun = false, failRead, failCancel = false, refs = [], resolved = settings, inProgress = [run()], queued = [], progressResponse } = {}) {
  const calls = [], logs = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('POST')) { if (failCancel && args.at(-1).includes('/42/')) throw new Error('HTTP 409'); return ''; }
    if (args.some(a => a.includes(failRead || 'NEVER'))) throw new Error('read failed');
    if (args.some(a => a.includes('status=in_progress'))) return progressResponse ?? JSON.stringify([{ workflow_runs: inProgress }]);
    if (args.some(a => a.includes('status=queued'))) return JSON.stringify([{ workflow_runs: queued }]);
    return typeof refs === 'string' ? refs : JSON.stringify([refs]);
  };
  const result = cancelObsoleteQueueRuns({ repo: 'owner/repo', exec, nowMs, settings: resolved, dryRun, log: line => logs.push(line) });
  return { result, calls, logs };
}

describe('obsolete run IO', () => {
  it('reads both run statuses before paginated refs, then posts cancellation', () => {
    const { calls, result, logs } = io();
    expect(calls[0]).toContain('repos/owner/repo/actions/runs?event=merge_group&status=in_progress&per_page=100');
    expect(calls[1]).toContain('repos/owner/repo/actions/runs?event=merge_group&status=queued&per_page=100');
    expect(calls[2]).toContain('repos/owner/repo/git/matching-refs/heads/gh-readonly-queue/');
    expect(calls[2]).toContain('--paginate');
    expect(calls[3]).toEqual(['gh', 'api', '-X', 'POST', 'repos/owner/repo/actions/runs/42/cancel']);
    expect(result).toMatchObject({ considered: 1, cancelled: [{ id: 42 }], failed: [], kept: 0, dryRun: false });
    expect(logs).toContain(`✂ cancelled merge_group run 42 "CI" on ${branch} (ref-deleted)`);
    expect(logs).toContain(formatCancelObsoleteRunsSettings(settings));
  });
  it('keeps live refs and reads queued runs', () => {
    expect(io({ inProgress: [], queued: [run({ status: 'queued' })], refs: [{ ref: `refs/heads/${branch}`, object: { sha: 'abc' } }] }).result).toMatchObject({ considered: 1, cancelled: [], kept: 1 });
  });
  it('handles all pages and cancels duplicate run ids only once', () => {
    const progressResponse = JSON.stringify([{ workflow_runs: [run()] }, { workflow_runs: [run({ id: 43 })] }]);
    const { result, calls } = io({ progressResponse, queued: [run({ status: 'queued' })] });
    expect(result.considered).toBe(2);
    expect(calls.filter(c => c.includes('POST'))).toHaveLength(2);
  });
  it('accepts single-page responses as well as slurped pages', () => {
    const { result } = io({ progressResponse: JSON.stringify({ workflow_runs: [run()] }), refs: JSON.stringify([{ ref: `refs/heads/${branch}`, object: { sha: 'abc' } }]) });
    expect(result).toMatchObject({ considered: 1, cancelled: [], kept: 1 });
  });
  it.each(['status=in_progress', 'status=queued', 'matching-refs'])('cancels nothing after a %s read failure', failRead => {
    const { result, calls } = io({ failRead });
    expect(result.error).toContain('read failed');
    expect(calls.some(c => c.includes('POST'))).toBe(false);
  });
  it.each(['bad json', '{}', '[{}]'])('fails safe on malformed ref responses: %s', refs => {
    const { result, calls } = io({ refs });
    expect(result.error).toBeTruthy();
    expect(calls.some(c => c.includes('POST'))).toBe(false);
  });
  it('counts cancellation failure without throwing', () => {
    const { result, logs } = io({ failCancel: true });
    expect(result.cancelled).toEqual([]);
    expect(result.failed).toEqual([expect.objectContaining({ id: 42, error: 'HTTP 409' })]);
    expect(logs.some(l => l.includes('⚠') && l.includes('409'))).toBe(true);
  });
  it('continues cancelling later runs after one cancellation fails', () => {
    const { result } = io({ failCancel: true, inProgress: [run(), run({ id: 43 })] });
    expect(result.failed.map(r => r.id)).toEqual([42]);
    expect(result.cancelled.map(r => r.id)).toEqual([43]);
  });
  it('dry run logs its plan without any POST', () => {
    const { result, calls, logs } = io({ dryRun: true });
    expect(calls.some(c => c.includes('POST'))).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(logs.some(l => l.includes('would cancel merge_group run 42'))).toBe(true);
  });
  it('off performs no IO', () => {
    const { calls, result } = io({ resolved: { ...settings, cancelObsoleteRuns: 'off' } });
    expect(calls).toEqual([]);
    expect(result).toEqual({ off: true });
  });
});

describe('obsolete run CLI', () => {
  it('previews by default, applies only with --apply, and keeps --json stdout parseable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-obsolete-runs-'));
    const callsPath = join(dir, 'calls.jsonl');
    const fixture = run({ created_at: '2020-01-01T00:00:00Z' });
    const cli = fileURLToPath(new URL('../../merge-queue-cancel-obsolete.mjs', import.meta.url));
    try {
      writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node\nconst { appendFileSync } = require('node:fs');\nconst args = process.argv.slice(2);\nappendFileSync(process.env.WE_OBSOLETE_TEST_CALLS, JSON.stringify(args) + '\\n');\nif (args.includes('POST')) process.exit(0);\nprocess.stdout.write(JSON.stringify(args.some(a => a.includes('status=in_progress')) ? [{ workflow_runs: ${JSON.stringify([fixture])} }] : args.some(a => a.includes('status=queued')) ? [{ workflow_runs: [] }] : [[]]));\n`, { mode: 0o755 });
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, WE_UNDER_TEST: '1', WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS: 'on', WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS_MIN_AGE_SECONDS: '30', WE_OBSOLETE_TEST_CALLS: callsPath };
      const preview = execFileSync(process.execPath, [cli, '--repo=owner/repo'], { env, encoding: 'utf8' });
      expect(preview).toContain('would cancel merge_group run 42');
      expect(preview).toContain('cancelObsoleteRuns=on (env)');
      expect(readFileSync(callsPath, 'utf8')).not.toContain('POST');
      writeFileSync(callsPath, '');
      const applied = execFileSync(process.execPath, [cli, '--repo=owner/repo', '--apply', '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(JSON.parse(applied).cancelled.map(r => r.id)).toEqual([42]);
      const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.filter(args => args.includes('POST'))).toEqual([['api', '-X', 'POST', 'repos/owner/repo/actions/runs/42/cancel']]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('drain obsolete run hook', () => {
  it('runs once at the start of every queue pass, including empty state and dry runs; skips direct mode', () => {
    for (const strategy of ['drain-direct', 'github-merge-queue']) {
      const calls = [];
      const exec = () => { throw new Error('unexpected gh'); };
      const log = { write() {} };
      const drain = createDrainMergeStrategy({ localSlug: 'owner/repo', exec, log, dryRun: true, resolved: { policy: { strategy }, note: null }, cancelObsoleteRuns: options => calls.push(options), readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
      for (let i = 0; i < 2; i++) drain.collectQueueMerged({ merged: [], landedThisPass: new Set() });
      expect(calls).toEqual(strategy === 'drain-direct' ? [] : Array(2).fill({ repo: 'owner/repo', exec, dryRun: true, log }));
    }
  });
  it('logs hook exceptions and still continues the pass', () => {
    const logs = [];
    const drain = createDrainMergeStrategy({ resolved: { policy: { strategy: 'github-merge-queue' }, note: null }, log: { write: l => logs.push(l) }, cancelObsoleteRuns: () => { throw new Error('oops'); }, readFile: () => '{"pending":[],"followedUp":[]}' });
    expect(drain.collectQueueMerged({ merged: [], landedThisPass: new Set() })).toEqual([]);
    expect(logs.some(l => l.includes('⚠') && l.includes('oops'))).toBe(true);
  });
});
