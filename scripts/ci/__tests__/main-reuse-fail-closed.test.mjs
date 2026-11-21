// @vitest-environment node
// Operator send-back on PR #7224 (canonical audit, 02f9f70e): a skipped re-test must never mask a red
// main or let an untested revision deploy. One named test per finding; every unknown fails closed.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { mainRedState } from '../../conveyor/main-ci-red-core.mjs';
import { probeMainCiRuns, readMainTip } from '../../conveyor/main-ci-red-probe.mjs';
import { REUSED_MARKER_STEP, withoutReusedMainPushes } from '../../lib/main-ci-reuse-runs.mjs';
import { mqSameHeadGuard } from '../../lib/drain-queue-safety.mjs';
import { recordQuarantineReuse, validQuarantineReceipt } from '../quarantine-skip.mjs';

const workflows = new URL('../../../.github/workflows/', import.meta.url);
const load = name => yaml.load(readFileSync(new URL(name, workflows), 'utf8'));
const ci = load('ci.yml').jobs, deploy = load('deploy.yml').jobs.deploy;
const evaluate = (expr, values) => Function(...Object.keys(values), `return (${expr.replace(/\$\{\{|\}\}/g, '')
  .replace(/needs\.([\w-]+)\.outputs\.([\w-]+)/g, (_, j, k) => `needs['${j}'].outputs['${k}']`)
  .replace(/needs\.([\w-]+)\.result/g, (_, j) => `needs['${j}'].result`)
  .replace(/!cancelled\(\)/g, 'true').replace(/always\(\)/g, 'true')});`)(...Object.values(values));
const head = 'a'.repeat(40), old = 'b'.repeat(40);

describe('F1 ci.yml:93 — required checks never report success for a reused push', () => {
  const github = (event_name, ref = 'refs/heads/main') => ({ event_name, ref });
  const needs = skip => ({ changes: { result: 'success', outputs: { skip, light: skip } } });
  it.each(['test', 'smoke', 'daemon-soak'])('%s is skipped (not successful) on a reused main push', name => {
    expect(evaluate(ci[name].if, { github: github('push'), needs: needs('true') })).toBe(false);
    for (const [event, skip] of [['push', 'false'], ['push', ''], ['merge_group', 'true'], ['pull_request', ''], ['schedule', '']])
      expect(evaluate(ci[name].if, { github: github(event), needs: needs(skip) }), `${event}/${skip}`).toBe(true);
    // A failed changes job leaves skip empty: the job still runs and fails closed.
    expect(evaluate(ci[name].if, { github: github('push'), needs: { changes: { result: 'failure', outputs: {} } } })).toBe(true);
  });
});

describe('F5 main-ci-red-core.mjs:339 — only a successful marker bound to the required checks\' run proves fresh execution', () => {
  const marker = ci['main-execution'];
  const runMarker = env => {
    const results = marker.steps.map(step => {
      const active = evaluate(step.if ?? 'true', { needs: {
        changes: { result: env.CHANGES_RESULT, outputs: { skip: env.SKIP, light: env.LIGHT } } } });
      if (!active) return { name: step.name, conclusion: 'skipped' };
      const r = spawnSync('bash', ['-e', '-c', step.run], { encoding: 'utf8', env: { ...process.env, ...step.env && Object.fromEntries(
        Object.keys(step.env).map(key => [key, env[key] ?? ''])) } });
      return { name: step.name, conclusion: r.status === 0 ? 'success' : 'failure' };
    });
    return results;
  };
  const full = { CHANGES_RESULT: 'success', SKIP: 'false', LIGHT: 'false', TEST_RESULT: 'success', SMOKE_RESULT: 'success', SOAK_RESULT: 'success' };
  it('runs on every main push, succeeds only after full fresh execution, and fails a named step on reuse', () => {
    expect(evaluate(marker.if, { github: { event_name: 'push', ref: 'refs/heads/main' } })).toBe(true);
    for (const event of ['merge_group', 'pull_request', 'schedule'])
      expect(evaluate(marker.if, { github: { event_name: event, ref: 'refs/heads/main' } })).toBe(false);
    expect(marker.needs).toEqual(expect.arrayContaining(['changes', 'test', 'smoke', 'daemon-soak']));
    expect(runMarker(full).map(s => s.conclusion)).toEqual(['skipped', 'success']);
    expect(runMarker({ ...full, SKIP: 'true', LIGHT: 'true', TEST_RESULT: 'skipped', SMOKE_RESULT: 'skipped', SOAK_RESULT: 'skipped' }))
      .toEqual([{ name: REUSED_MARKER_STEP, conclusion: 'failure' }, { name: expect.any(String), conclusion: 'skipped' }]);
    for (const change of [{ LIGHT: 'true' }, { TEST_RESULT: 'skipped' }, { SMOKE_RESULT: 'failure' }, { SOAK_RESULT: 'cancelled' },
      { CHANGES_RESULT: 'failure', SKIP: '' }])
      expect(runMarker({ ...full, ...change }).at(-1).conclusion, JSON.stringify(change)).toBe('failure');
  });
  const tip = (markerCheck, suites = {}) => ({ sha: head, runStatus: 'completed', requiredChecks: ['test', 'smoke'], checkRuns: [
    { id: 5, name: 'test', status: 'completed', conclusion: 'success', suiteId: suites.test ?? 9 },
    { id: 6, name: 'smoke', status: 'completed', conclusion: 'success', suiteId: suites.smoke ?? 9 },
    ...(markerCheck ? [{ id: 7, name: 'main-execution', status: 'completed', suiteId: 9, ...markerCheck }] : []),
  ] });
  const runs = [{ databaseId: 1, headSha: old, event: 'push', status: 'completed', conclusion: 'failure', createdAt: '2026-11-21T10:00:00Z' }];
  it.each([
    ['skipped marker (merge-group and light runs skip it)', { conclusion: 'skipped' }],
    ['no marker', null],
    ['failed marker', { conclusion: 'failure' }],
    ['marker from another run', { conclusion: 'success', suiteId: 8 }],
    ['marker without a suite id', { conclusion: 'success', suiteId: undefined }],
  ])('%s cannot certify green summaries', (_, markerCheck) => {
    expect(mainRedState(runs, { tip: tip(markerCheck) })).toMatchObject({ status: 'red' });
  });
  it('required checks from different runs cannot share one marker', () => {
    expect(mainRedState(runs, { tip: tip({ conclusion: 'success' }, { smoke: 8 }) })).toMatchObject({ status: 'red' });
  });
  it('a successful marker in the same run as every required check certifies the tip', () => {
    expect(mainRedState(runs, { tip: tip({ conclusion: 'success' }) })).toMatchObject({ status: 'green', via: 'tip-required-checks' });
  });
  it('the tip reader carries each check run\'s suite id', () => {
    const t = readMainTip({ repoSlug: 'fixture/repo', requiredChecks: ['test'], exec: (_, args) => args.includes('--jq') ? head
      : JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', check_suite: { id: 77 } }] }) });
    expect(t.checkRuns).toEqual([{ id: 1, name: 'test', status: 'completed', conclusion: 'success', suiteId: 77 }]);
  });
});

const reusedPage = () => ({ total_count: 2, jobs: [
  { name: 'main-execution', status: 'completed', conclusion: 'failure', run_attempt: 1, steps: [
    { name: REUSED_MARKER_STEP, status: 'completed', conclusion: 'failure' },
    { name: 'Fresh full main execution', status: 'completed', conclusion: 'skipped' }] },
  { name: 'test', status: 'completed', conclusion: 'skipped', run_attempt: 1 },
] });
const failedRun = (extra = {}) => ({ databaseId: 3, headSha: head, event: 'push', status: 'completed', conclusion: 'failure',
  attempt: 1, createdAt: '2026-11-21T10:00:00Z', ...extra });
const classify = (run, page) => withoutReusedMainPushes([run], { repo: 'fixture/repo', exec: () => JSON.stringify(page) });

describe('F6 main-ci-reuse-runs.mjs:9 — unknown attempt evidence never removes a failure', () => {
  it('removes a proven attempt-one reuse', () => expect(classify(failedRun(), reusedPage())).toEqual([]));
  it.each([['missing', undefined], ['null', null], ['string 1', '1'], ['second', 2]])('retains a run whose attempt is %s', (_, attempt) => {
    const page = reusedPage();
    expect(classify(failedRun({ attempt }), page)).toHaveLength(attempt === '1' ? 0 : 1);
  });
  it.each([['missing', undefined], ['null', null], ['second', 2]])('retains a run with a job whose run_attempt is %s', (_, value) => {
    const page = reusedPage(); page.jobs[1].run_attempt = value;
    expect(classify(failedRun(), page)).toHaveLength(1);
  });
  it.each([
    ['the fresh-execution step failed instead', page => { page.jobs[0].steps = [{ name: 'Fresh full main execution', conclusion: 'failure' }]; }],
    ['no steps were read', page => { delete page.jobs[0].steps; }],
    ['the reuse step did not fail', page => { page.jobs[0].steps[0].conclusion = 'success'; }],
  ])('retains a marker failure when %s', (_, change) => {
    const page = reusedPage(); change(page);
    expect(classify(failedRun(), page)).toHaveLength(1);
  });
});

describe('F2 ci.yml:208 — quarantine receipts bind sha, run, attempt and execution time', () => {
  const env = { GITHUB_EVENT_NAME: 'merge_group', GITHUB_SHA: head, GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'test-shard' };
  const write = (out, extra = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-'));
    try { recordQuarantineReuse(out, { ...env, RUNNER_TEMP: root, ...extra }); return readFileSync(join(root, 'quarantine-reuse'), 'utf8'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  };
  it('the producer records the execution identity', () => {
    const receipt = JSON.parse(write({ reuseSafe: true }));
    expect(receipt).toMatchObject({ v: 1, decision: 'unquarantined', sha: head, run_id: 500, run_attempt: 2, job: 'test-shard' });
    expect(Number.isFinite(Date.parse(receipt.executed_at))).toBe(true);
    expect(JSON.parse(write({ reuseSafe: false })).decision).toBe('unknown-or-quarantined');
  });
  it('the shared validator accepts only the same sha, run and attempt', () => {
    const good = write({ reuseSafe: true });
    const want = { sha: head, runId: 500, attempt: 2 };
    expect(validQuarantineReceipt(good, want)).toBe(true);
    for (const other of [{ sha: old }, { runId: 501 }, { attempt: 1 }, { attempt: undefined }])
      expect(validQuarantineReceipt(good, { ...want, ...other }), JSON.stringify(other)).toBe(false);
    for (const bad of ['unquarantined\n', write({ reuseSafe: false }), write({ reuseSafe: true }, { GITHUB_RUN_ATTEMPT: '1' }),
      write({ reuseSafe: true }, { GITHUB_SHA: old }), '{"v":1}', ''])
      expect(validQuarantineReceipt(bad, want), bad).toBe(false);
  });
  it('the queue record step refuses receipts from an earlier attempt or another commit (producer output fed to the consumer)', () => {
    const check = ci['queue-reuse-record'].steps.find(s => s.name === 'Require unquarantined test executions');
    const dir = mkdtempSync(join(tmpdir(), 'queue-receipts-'));
    try {
      const names = [['unit', 'UNIT_SHARDS'], ['integration', 'INTEGRATION_GROUPS'], ['soak', 'SOAK_SHARDS']]
        .flatMap(([suite, key]) => JSON.parse(check.env[key]).map(id => `quarantine-reuse-${suite}-${id}`));
      const fill = (override = {}) => names.forEach((name, i) => {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, 'quarantine-reuse'), write({ reuseSafe: true }, i === 0 ? override : {}));
      });
      const output = join(dir, 'output');
      const run = () => {
        writeFileSync(output, '');
        const r = spawnSync('bash', ['-e', '-c', check.run], { encoding: 'utf8', env: { ...process.env, ...check.env, RECEIPTS: dir,
          GITHUB_OUTPUT: output, GITHUB_SHA: head, GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '2' } });
        expect(r.status, r.stderr).toBe(0);
        return readFileSync(output, 'utf8');
      };
      fill(); expect(run()).toBe('eligible=true\n');
      for (const override of [{ GITHUB_RUN_ATTEMPT: '1' }, { GITHUB_SHA: old }, { GITHUB_RUN_ID: '499' }]) {
        fill(override); expect(run(), JSON.stringify(override)).toBe('eligible=false\n');
      }
      fill(); writeFileSync(join(dir, names[0], 'quarantine-reuse'), 'unquarantined\n');
      expect(run()).toBe('eligible=false\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('F3/F4 main-ci-red-probe.mjs:111/122 — the probe inventory is main-only and window-bounded', () => {
  const row = (id, sha, conclusion, event = 'push', extra = {}) => ({ databaseId: id, headSha: sha, event, status: 'completed',
    conclusion, attempt: 1, createdAt: new Date(Date.parse('2026-11-21T10:00:00Z') + id * 60_000).toISOString(), ...extra });
  const probe = (rows, mainHead = head) => probeMainCiRuns({ repoSlug: 'fixture/repo', config: { mainCiRedFlakeRerun: false },
    readRequired: () => ({ checks: ['test'] }), exec: (_, args) => {
      if (args[0] === 'run') return JSON.stringify(rows);
      if (args[1] === 'repos/fixture/repo/git/ref/heads/main' && mainHead) return JSON.stringify({ object: { sha: mainHead } });
      throw Error('fixture: evidence unavailable');
    } });
  it('a fork pull_request run on a branch named main cannot override a real failure', () => {
    const { runs } = probe([row(1, old, 'success'), row(2, head, 'failure'), row(3, 'c'.repeat(40), 'success', 'pull_request')]);
    expect(runs.map(r => r.databaseId).sort()).toEqual([1, 2]);
    expect(mainRedState(runs)).toMatchObject({ status: 'red', latestRed: { runId: 2 } });
  });
  it.each([undefined, '', 42])('an unreadable event %s makes the inventory unknown', event => {
    expect(() => probe([row(1, head, 'success', 'push', { event })])).toThrow(/event/);
  });
  it('a later backstop success for an older SHA cannot clear a failure on newer main', () => {
    const { runs } = probe([row(1, old, 'success'), row(2, head, 'failure'), row(3, old, 'success', 'schedule')]);
    expect(mainRedState(runs)).toMatchObject({ status: 'red', latestRed: { runId: 2 } });
  });
  it('a backstop success for the current head, or inside its own window, still recovers red', () => {
    expect(mainRedState(probe([row(1, old, 'success'), row(2, head, 'failure'), row(3, head, 'success', 'schedule')]).runs).status).toBe('green');
    // Unknown head: only the window can admit it; an older SHA whose window was crossed stays out.
    expect(mainRedState(probe([row(1, old, 'failure'), row(2, old, 'success', 'schedule')], null).runs).status).toBe('green');
    expect(mainRedState(probe([row(1, old, 'success'), row(2, head, 'failure'), row(3, old, 'success', 'schedule')], null).runs).status).toBe('red');
  });
  it('a backstop failure is always kept as red evidence', () => {
    expect(mainRedState(probe([row(1, head, 'success'), row(2, old, 'failure', 'schedule')]).runs).status).toBe('red');
  });
});

describe('F7 drain-queue-safety.mjs:1045 — an intervening scheduled failure is never discarded', () => {
  const repo = 'fixture/drain', pr = 6215, mergeCommit = 'd'.repeat(40);
  const now = Date.parse('2026-11-01T14:00:00Z');
  const run = (id, conclusion, created_at, sha, event = 'push', status = 'completed') => ({ id, conclusion, created_at,
    updated_at: created_at, status, path: '.github/workflows/ci.yml', head_branch: 'main', event, head_sha: sha });
  function guard(runs, mainHead) {
    const exec = (command, args) => {
      if (args.some(arg => arg.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
      if (args.some(arg => arg.includes('timelineItems'))) return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
        nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-01T13:45:00Z',
          beforeCommit: { oid: mergeCommit, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } }], pageInfo: { hasPreviousPage: false } } } } } });
      if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
      const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
      if (endpoint === `repos/${repo}/git/ref/heads/main`) return JSON.stringify({ object: { sha: mainHead } });
      if (endpoint?.startsWith(`repos/${repo}/commits/${mergeCommit}/check-runs?`)) return JSON.stringify({ total_count: 1, check_runs: [{
        id: 21, name: 'build-linux', status: 'completed', conclusion: 'failure', output: { title: 'Runner disconnected', summary: '' } }] });
      if (endpoint?.startsWith(`repos/${repo}/actions/workflows/ci.yml/runs?`)) {
        const query = new URLSearchParams(endpoint.split('?')[1]);
        let selected = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
        if (query.get('status')) selected = selected.filter(r => r.status === query.get('status'));
        const before = query.get('created');
        if (before?.startsWith('<')) selected = selected.filter(r => Date.parse(r.created_at) < Date.parse(before.slice(1)));
        return JSON.stringify({ total_count: selected.length, workflow_runs: selected });
      }
      throw new Error(`unexpected ${endpoint ?? args.join(' ')}`);
    };
    vi.useFakeTimers(); vi.setSystemTime(now);
    try { return mqSameHeadGuard({ repo, pr, head, exec, log: () => {}, quarantine: { readList: null } }); }
    finally { vi.useRealTimers(); }
  }
  it('a pending current push cannot fall back past a scheduled failure to an earlier push success', () => {
    const runs = [run(101, 'success', '2026-11-01T13:50:00Z', old), run(102, 'failure', '2026-11-01T13:52:00Z', old, 'schedule'),
      run(103, null, '2026-11-01T13:55:00Z', head, 'push', 'in_progress')];
    expect(guard(runs, head).hold).toBe(true);
  });
  it('without the scheduled failure the same evidence still authorizes the retry', () => {
    const runs = [run(101, 'success', '2026-11-01T13:50:00Z', old), run(103, null, '2026-11-01T13:55:00Z', head, 'push', 'in_progress')];
    expect(guard(runs, head).hold).toBe(false);
  });
});

describe('F8/F9 deploy.yml:161/202 — deploy rechecks daemon-soak and builds the certified FUI revision', () => {
  const gate = deploy.steps.find(s => s.name === 'Refuse an unverified SHA');
  const runGate = (checkRuns, extraEnv = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-gate-'));
    try {
      const bin = join(dir, 'gh');
      // Fake gh: the endpoint decides the payload; the last argument is the --jq program.
      writeFileSync(bin, `#!/usr/bin/env bash
case "$*" in
  *compare*) echo identical ;;
  *check-runs*) jq -c "\${@: -1}" "${join(dir, 'checks.json')}" ;;
esac
`, { mode: 0o755 });
      writeFileSync(join(dir, 'checks.json'), JSON.stringify({ check_runs: checkRuns }));
      const script = gate.run.replace(/\$\{\{ github\.repository \}\}/g, 'fixture/repo');
      return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        DEPLOY_SHA: head, BREAK_GLASS: 'false', ...extraEnv } }).status;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const c = (name, conclusion, started_at, suite = 1) => ({ name, conclusion, started_at, check_suite: { id: suite } });
  const green = ['test', 'smoke', 'daemon-soak'].map(name => c(name, 'success', '2026-11-21T10:00:00Z'));
  it('requires daemon-soak alongside test and smoke', () => {
    expect(runGate(green)).toBe(0);
    expect(runGate(green.filter(x => x.name !== 'daemon-soak'))).not.toBe(0);
    expect(runGate([...green, c('daemon-soak', 'failure', '2026-11-21T11:00:00Z', 2)])).not.toBe(0);
  });
  it('reuse admission binds to the certified queue run and refuses a newer soak failure on the SHA', () => {
    const reused = ['test', 'smoke', 'daemon-soak'].map(name => c(name, 'skipped', '2026-11-21T12:00:00Z', 3));
    expect(runGate([...green, ...reused], { QUEUE_SUITE: '1' })).toBe(0);
    expect(runGate([...green, ...reused], { QUEUE_SUITE: '4' })).not.toBe(0);
    expect(runGate([...green, ...reused, c('daemon-soak', 'failure', '2026-11-21T13:00:00Z', 5)], { QUEUE_SUITE: '1' })).not.toBe(0);
    // A failed-run admission that named no certified queue run never falls back to the plain path.
    expect(runGate(green, { RUN_CONCLUSION: 'failure' })).not.toBe(0);
    expect(runGate([...green, ...reused])).not.toBe(0);
  });
  it('FUI is checked out at the revision CI certified, resolved before any secret-bearing step', () => {
    const fui = deploy.steps.find(s => s.name === 'Checkout FUI (sibling)');
    expect(fui.with.ref).toBe('${{ steps.certified-fui.outputs.sha }}');
    const resolve = deploy.steps.findIndex(s => s.id === 'certified-fui');
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeLessThan(deploy.steps.findIndex(s => s.uses?.startsWith('actions/create-github-app-token@')));
  });
  const resolveFui = async (artifacts, payload = { workflow_run: { id: 12, head_sha: head } }, breakGlass = '') => {
    const step = deploy.steps.find(s => s.id === 'certified-fui');
    const outputs = {}, errors = [];
    process.env.DEPLOY_SHA = head; process.env.BREAK_GLASS = breakGlass;
    await new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', step.with.script)(
      { rest: { actions: {
        listWorkflowRunArtifacts: async () => ({ data: { total_count: artifacts.length, artifacts } }),
        listWorkflowRuns: async () => ({ data: { total_count: 1, workflow_runs: [{ id: 12, head_sha: head, event: 'push', status: 'completed', path: '.github/workflows/ci.yml' }] } }),
      } } },
      { repo: { owner: 'fixture', repo: 'repo' }, payload, eventName: payload.workflow_run ? 'workflow_run' : 'workflow_dispatch' },
      { setOutput: (k, v) => { outputs[k] = v; }, setFailed: m => errors.push(m), warning: () => {} });
    return { outputs, errors };
  };
  const art = (name, expired = false) => ({ id: 1, name, expired });
  it('resolves exactly one unexpired certified FUI record, else fails closed', async () => {
    expect(await resolveFui([art(`fui-sibling-${old}`), art('timing-unit-1')])).toEqual({ outputs: { sha: old }, errors: [] });
    for (const artifacts of [[], [art(`fui-sibling-${old}`, true)], [art(`fui-sibling-${old}`), art(`fui-sibling-${'c'.repeat(40)}`)], [art('fui-sibling-nothex')]])
      expect((await resolveFui(artifacts)).errors, JSON.stringify(artifacts)).toHaveLength(1);
    expect((await resolveFui([art(`fui-sibling-${old}`)], {})).outputs).toEqual({ sha: old });
  });
  it('CI records the FUI revision it tested on every main push', () => {
    const steps = ci.changes.steps;
    const tip = steps.find(s => s.id === 'fui-tip');
    expect(evaluate(tip.if, { github: { event_name: 'push', ref: 'refs/heads/main' } })).toBe(true);
    const upload = steps.find(s => s.with?.name?.startsWith?.('fui-sibling-'));
    const steps_ = { 'main-skip': { outputs: { skip: 'false', 'fui-sha': '' } }, 'fui-tip': { outputs: { tip: old } } };
    const expr = upload.if.replace(/steps\.([\w-]+)\.outputs\.([\w-]+)/g, (_, s, k) => `steps['${s}'].outputs['${k}']`);
    expect(evaluate(expr, { github: { event_name: 'push', ref: 'refs/heads/main' }, steps: steps_ })).toBe(true);
    steps_['fui-tip'].outputs.tip = '';
    expect(evaluate(expr, { github: { event_name: 'push', ref: 'refs/heads/main' }, steps: steps_ })).toBe(false);
  });
});

it('F10 daemon-rebuild-auto-rebase.test.mjs:21 — no file-wide timeout widening', () => {
  const source = readFileSync(new URL('../../lib/__tests__/daemon-rebuild-auto-rebase.test.mjs', import.meta.url), 'utf8');
  expect(source).not.toMatch(/vi\.setConfig\(\s*\{\s*testTimeout/);
});
