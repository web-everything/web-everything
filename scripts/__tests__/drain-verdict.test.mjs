// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { SCHEMA, LOCAL_ONLY, build, verify, auditWorkflow } from '../lib/drain-verdict.mjs';
import { DRAIN_GATES } from '../lib/merge-gate-inventory.mjs';
import { resultToVerdictInputs, runCli } from '../drain-classify-only.mjs';
import { buildSkipReasons } from '../lib/drain-skip-reasons.mjs';

const computedAt = '2026-11-09T12:00:00.000Z';
const now = Date.parse(computedAt);
const headSha = 'a'.repeat(40), mainSha = 'b'.repeat(40), movedSha = 'c'.repeat(40);
const provenance = { runId: '123456', event: 'schedule', ref: 'refs/heads/main', workflow: 'drain-verdict' };
const ctx = { pr: 7, repo: 'o/r', mainSha, computedAt, provenance };
const inputs = () => ({ ...structuredClone(ctx), headSha, decision: 'enqueue' });
const live = () => ({ repo: ctx.repo, pr: ctx.pr, headSha, mainSha, provenance: { ...provenance } });
const valid = () => ({ schema: 'drain-verdict/2', ...inputs(),
  localOnly: { 'red-main-freeze': 'unknown', 'card-group': 'unknown',
    'manifest-baseline': 'unknown', 'couple-whole': 'unknown', 'test-gaming-scan': 'unknown' } });
const refuse = (v, lookup = live(), opts = {}) => {
  const result = verify(v, lookup, { now, ...opts });
  expect(result).toEqual({ ok: false, reason: expect.any(String) });
  expect(result.reason.trim()).not.toBe('');
};
const row = { num: 7, repo: 'o/r', headSha };
const base = () => ({ ok: true, dryRun: true, heldCoupleMembers: 0, toMerge: [], skipped: [], parked: [], skipReasons: [] });
// The real dry-run shape for one ready PR: the drain lands nothing in --dry-run (merged is empty), so the REAL
// producer (buildSkipReasons) emits a `ready-not-reached` accounting row for the candidate. Verdict repo is null
// for the drain's own repo, exactly as the live `--this-repo` JSON shows.
const readyDryRun = (num = 7, extra = {}) => ({ ...base(),
  toMerge: [{ ...row, num }],
  skipReasons: buildSkipReasons({ verdicts: [{ num, repo: null, decision: 'merge', headSha }], merged: [] }), ...extra });

describe('T1: strict v2 shape and forged verdict refusals', () => {
  it('builds exactly the v2 contract and verifies a valid verdict', () => {
    expect(SCHEMA).toBe('drain-verdict/2');
    expect(LOCAL_ONLY).toEqual(['red-main-freeze', 'card-group', 'manifest-baseline', 'couple-whole', 'test-gaming-scan']);
    expect(build(inputs())).toEqual(valid());
    expect(build({ ...inputs(), localOnly: { 'red-main-freeze': 'pass', 'card-group': 'fail' } }))
      .toEqual(valid());
    expect(verify(valid(), live(), { now })).toEqual({ ok: true });
    expect(verify({ ...valid(), decision: 'local' }, live(), { now })).toEqual({ ok: true });
  });

  it('keeps every inventory local-only gate as a drain-side re-check', () => {
    for (const gate of DRAIN_GATES.filter(gate => gate.input === 'local-only')) {
      expect(LOCAL_ONLY).toContain(gate.id);
    }
  });

  it.each(['manifest-baseline', 'couple-whole', 'test-gaming-scan'])('build always marks %s unknown despite a supplied pass', id => {
    expect(build({ ...inputs(), localOnly: { ...valid().localOnly, [id]: 'pass' } })).toEqual(valid());
  });

  it.each(['manifest-baseline', 'couple-whole', 'test-gaming-scan'])('verify refuses a %s pass claim', id => {
    const v = valid(); v.localOnly[id] = 'pass'; refuse(v);
  });

  it.each(['manifest-baseline', 'couple-whole', 'test-gaming-scan'])('verify refuses missing %s', id => {
    const v = valid(); delete v.localOnly[id]; refuse(v);
  });

  const mutants = [
    ['extra top-level key', v => { v.actions = []; }],
    ['extra localOnly key', v => { v.localOnly.result = 'unknown'; }],
    ['extra provenance key', v => { v.provenance.actor = 'trusted'; }],
    ['localOnly pass claim', v => { v.localOnly['red-main-freeze'] = 'pass'; }],
    ['wrong localOnly id', v => { delete v.localOnly['card-group']; v.localOnly.other = 'unknown'; }],
    ['hold decision', v => { v.decision = 'hold'; }],
    ['wrong schema', v => { v.schema = 'drain-verdict/1'; }],
    ...['repo', 'pr', 'headSha', 'mainSha'].map(key => [`foreign ${key}`, v => {
      v[key] = key === 'pr' ? 8 : key.endsWith('Sha') ? movedSha : 'foreign/repo';
    }]),
    ['foreign runId', v => { v.provenance.runId = '999'; }],
    ['foreign workflow', v => { v.provenance.workflow = 'other'; }],
    ['pull_request provenance', v => { v.provenance.event = 'pull_request'; }],
    ['feature ref', v => { v.provenance.ref = 'refs/heads/feature'; }],
    ...['top', 'localOnly', 'provenance'].map(level => [`own __proto__ key at ${level}`, v => {
      Object.defineProperty(level === 'top' ? v : v[level], '__proto__', {
        value: { polluted: true }, enumerable: true, configurable: true,
      });
    }]),
    ...Object.keys(valid()).map(key => [`missing ${key}`, v => { delete v[key]; }]),
    ...['localOnly', 'provenance'].flatMap(level => Object.keys(valid()[level])
      .map(key => [`missing ${level}.${key}`, v => { delete v[level][key]; }])),
  ];
  it.each(mutants)('refuses %s', (_name, mutate) => {
    const v = valid(); mutate(v); refuse(v);
  });
  it.each([null, undefined, 'verdict', 7, [], [valid()]])('refuses non-record %j', value => refuse(value));
  it.each(['localOnly', 'provenance'])('refuses malformed nested %s', key => {
    for (const value of [null, [], 'unknown']) refuse({ ...valid(), [key]: value });
  });
  it.each(['event', 'ref'])('refuses forbidden %s even when live agrees', key => {
    const v = valid(), lookup = live();
    v.provenance[key] = lookup.provenance[key] = key === 'event' ? 'pull_request' : 'refs/heads/feature';
    refuse(v, lookup);
  });
  it('accepts workflow_dispatch provenance when live agrees', () => {
    const v = valid(), lookup = live();
    v.provenance.event = lookup.provenance.event = 'workflow_dispatch';
    expect(verify(v, lookup, { now })).toEqual({ ok: true });
  });
  it.each([
    ['null', () => null], ['array', () => []],
    ...Object.keys(inputs()).map(key => [`missing ${key}`, () => {
      const value = inputs(); delete value[key]; return value;
    }]),
    ['invalid PR', () => ({ ...inputs(), pr: 0 })],
    ['null head', () => ({ ...inputs(), headSha: null })],
    ['hold', () => ({ ...inputs(), decision: 'hold' })],
    ['bad timestamp', () => ({ ...inputs(), computedAt: 'yesterday' })],
    ['bad provenance', () => ({ ...inputs(), provenance: null })],
  ])('build throws TypeError for %s', (_name, value) => expect(() => build(value())).toThrow(TypeError));
});

describe('T2: freshness and live SHA binding', () => {
  it('accepts exactly the default max age', () => {
    expect(verify(valid(), live(), { now: now + 10 * 60_000 })).toEqual({ ok: true });
  });
  it('refuses just over ten minutes', () => refuse(valid(), live(), { now: now + 600_001 }));
  it('honors a custom maxAgeMinutes, including its boundary', () => {
    expect(verify(valid(), live(), { now: now + 120_000, maxAgeMinutes: 2 })).toEqual({ ok: true });
    refuse(valid(), live(), { now: now + 120_001, maxAgeMinutes: 2 });
  });
  it.each([
    ['future', new Date(now + 1).toISOString()], ['garbage', 'garbage'],
    ['parseable non-ISO', 'November 9, 2026 12:00:00 GMT'], ['numeric timestamp', now],
  ])('refuses %s computedAt', (_name, value) => refuse({ ...valid(), computedAt: value }));
  it.each(['mainSha', 'headSha'])('refuses moved live %s', key => refuse(valid(), { ...live(), [key]: movedSha }));
});

describe('T3: result mapping preserves local fallback', () => {
  it.each([
    ['coupleHeld flag', { coupleHeld: true }],
    ['coupleHeld rows', { coupleHeld: [{ ...row, role: 'carrier', reason: 'partner held' }] }],
    ['heldCoupleMembers count', { heldCoupleMembers: 1 }],
    ['unknown heldCoupleMembers count', { heldCoupleMembers: null }],
    ['coupleSplit rows', { coupleSplit: [row] }],
    ['couple field', { couple: {} }],
    ['couples field', { couples: [] }],
    ['target coupleHeld', { toMerge: [{ ...row, coupleHeld: true }] }],
    ['target coupleCarrier', { toMerge: [{ ...row, coupleCarrier: 'we#8' }] }],
    ['target couples', { toMerge: [{ ...row, couples: [8] }] }],
    ['nested target couple', { toMerge: [{ ...row, mergeGateInputs: { couple: { refs: [8] } } }] }],
    ['mixed-case couple key', { toMerge: [{ ...row, COUPLE: false }] }],
    ['skip-reason couple metadata', { skipReasons: [{ ...row, coupleDeferReason: 'held' }] }],
  ])('refuses enqueue for %s with an explicit local drain fallback', (_name, signal) => {
    expect(() => resultToVerdictInputs({ ...base(), toMerge: [row], ...signal }, ctx)).toThrow(/local drain/);
  });

  it.each([
    ['enqueue', 'toMerge', { ...base(), toMerge: [row] }],
    ['local', 'skipped', { ...base(), skipped: [{ ...row, reason: 'not ready' }] }],
    ['local', 'parked', { ...base(), parked: [{ ...row, reasons: ['agent-reviewable'] }] }],
    ['local', 'hold', { ...base(), skipped: [{ ...row, reason: 'review hold: awaiting review' }] }],
    ['local', 'humanRequired', { ...base(), parked: [{ ...row, humanRequired: true, reasons: ['workflow hold'] }] }],
    ['local', 'checks pending', { ...base(), skipped: [{ ...row, reason: 'checks pending' }],
      skipReasons: [{ ...row, kind: 'checks-pending', reason: 'checks pending' }] }],
  ])('maps %s for %s and round-trips through build/verify', (decision, _name, result) => {
    const mapped = resultToVerdictInputs(result, structuredClone(ctx));
    expect(mapped).toMatchObject({ ...ctx, headSha, decision });
    expect(verify(build(mapped), live(), { now })).toEqual({ ok: true });
  });
  it.each([
    ['failed result', { ...base(), ok: false }], ['not dry-run', { ...base(), dryRun: false }],
    ['failed repo', { ...base(), failedRepos: [{ repo: 'o/r' }] }],
    ...['toMerge', 'skipped', 'parked', 'skipReasons'].map(key => {
      const value = { ...base(), toMerge: [row] }; delete value[key]; return [`missing ${key}`, value];
    }),
    ['null headSha', { ...base(), toMerge: [{ ...row, headSha: null }] }],
    ['contradictory rows', { ...base(), toMerge: [row], skipped: [row] }],
    ['ambiguous headSha', { ...base(), skipped: [row], parked: [{ ...row, headSha: movedSha }] }],
    ['deferred candidate', { ...base(), toMerge: [row], deferred: [{ ...row, reason: 'blocked-by' }] }],
    ['skip-reasoned candidate', { ...base(), toMerge: [row], skipReasons: [{ ...row, kind: 'blocked-by', reason: 'blocked-by #1' }] }],
    ['target absent', base()], ['other target', { ...base(), toMerge: [{ ...row, num: 8 }] }],
  ])('refuses %s with an explicit local drain fallback', (_name, result) => {
    expect(() => resultToVerdictInputs(result, ctx)).toThrow(/local drain/);
  });
});

describe('T3b: the dry-run ready-not-reached accounting row is not an admission hold', () => {
  const merge = (num, more = {}) => ({ num, repo: null, decision: 'merge', headSha, ...more });
  it('pins the real producer: a lone ready candidate with an empty merged set gets ready-not-reached / unaccounted', () => {
    expect(readyDryRun().skipReasons).toEqual([
      { num: 7, repo: null, kind: 'ready-not-reached', reason: expect.any(String), source: 'unaccounted' }]);
  });
  it.each([['the drain-repo null', null], ['a slug', 'o/r']])('exact repro maps to enqueue (verdict repo %s)', (_n, repo) => {
    const result = { ...base(), toMerge: [row], skipReasons: buildSkipReasons({ verdicts: [merge(7, { repo })], merged: [] }) };
    expect(result.skipReasons.map(r => r.kind)).toEqual(['ready-not-reached']);
    const mapped = resultToVerdictInputs(result, structuredClone(ctx));
    expect(mapped).toMatchObject({ ...ctx, headSha, decision: 'enqueue' });
    expect(verify(build(mapped), live(), { now })).toEqual({ ok: true });
  });
  it('another PR\'s hold row does not hold the target', () => {
    const skipReasons = buildSkipReasons({ verdicts: [merge(7), merge(8)], deferred: [{ num: 8, repo: null, waitOn: ['#1'] }] });
    expect(resultToVerdictInputs({ ...base(), toMerge: [row], skipReasons }, ctx).decision).toBe('enqueue');
  });
  it.each([
    ['partner-pending (real couple partner)', () => ({ skipReasons: buildSkipReasons({
      verdicts: [merge(7, { item: '4242' }), merge(8, { item: '4242' })], merged: [] }) }), 'partner-pending'],
    ['deferred (real blocked-by row plus the deferred list)', () => {
      const deferred = [{ num: 7, repo: null, waitOn: ['#1'] }];
      return { deferred, skipReasons: buildSkipReasons({ verdicts: [merge(7)], deferred }) };
    }, 'blocked-by'],
    ['blocked-by row alone (no deferred list)', () => ({ skipReasons: buildSkipReasons({
      verdicts: [merge(7)], deferred: [{ num: 7, repo: null, waitOn: ['#1'] }] }) }), 'blocked-by'],
    ['batching-deferred (real enqueue hold)', () => ({ skipReasons: buildSkipReasons({ verdicts: [merge(7)],
      enqueueOutcomes: [{ num: 7, repo: null, outcome: 'not-enqueued', reason: 'admission deferred' }] }) }), 'batching-deferred'],
    ['red-main-hold (real enqueue hold kind)', () => ({ skipReasons: buildSkipReasons({ verdicts: [merge(7)],
      enqueueOutcomes: [{ num: 7, repo: null, outcome: 'not-enqueued', kind: 'red-main-hold', reason: 'red-main-hold: main is red' }] }) }), 'red-main-hold'],
    ['red-main-hold (hand-built row)', () => ({ skipReasons: [{ ...row, kind: 'red-main-hold', reason: 'red-main-hold', source: 'skipped' }] }), 'red-main-hold'],
    ['ready-not-reached from another source', () => ({ skipReasons: [{ ...row, kind: 'ready-not-reached', reason: 'x', source: 'skipped' }] }), 'ready-not-reached'],
    ['an unknown kind', () => ({ skipReasons: [{ ...row, kind: 'brand-new-hold', reason: 'x', source: 'unaccounted' }] }), 'brand-new-hold'],
    ['an accounting row plus a hold for the same target under the slug key', () => ({ skipReasons: [
      ...readyDryRun().skipReasons, { ...row, kind: 'blocked-by', reason: 'blocked-by #1', source: 'deferred' }] }), 'blocked-by'],
  ])('still refuses %s with the local drain fallback', (_name, extra, kind) => {
    const result = { ...base(), toMerge: [row], ...extra() };
    expect(result.skipReasons.some(r => r.kind === kind)).toBe(true);
    expect(() => resultToVerdictInputs(result, ctx)).toThrow(/run the local drain/);
  });
});

// Always mutate the shipped workflow, never a synthetic replacement for missing evidence.
const workflowText = () => readFileSync(new URL('../../.github/workflows/drain-verdict.yml', import.meta.url), 'utf8');
const mutateWorkflow = mutate => {
  const doc = yaml.safeLoad(workflowText()); mutate(doc); return yaml.safeDump(doc);
};
const jobs = doc => Object.values(doc.jobs);
const checkouts = doc => jobs(doc).flatMap(job => job.steps || []).filter(step => /^actions\/checkout@/.test(step.uses || ''));
const rejectedWorkflow = text => {
  const result = auditWorkflow(text);
  expect(result).toMatchObject({ ok: false, problems: expect.any(Array) });
  expect(result.problems.length).toBeGreaterThan(0);
  for (const problem of result.problems) expect(problem).toEqual(expect.any(String));
};

describe('T4: audit the real read-only workflow and permission mutants', () => {
  it('accepts the shipped workflow', () => {
    const text = workflowText(), doc = yaml.safeLoad(text);
    expect(checkouts(doc).length).toBeGreaterThan(0);
    expect(auditWorkflow(text)).toEqual({ ok: true, problems: [] });
  });
  it.each(['contents', 'pull-requests', 'checks', 'statuses', 'id-token'])('refuses top-level %s: write', permission => {
    rejectedWorkflow(mutateWorkflow(doc => { doc.permissions = { ...doc.permissions, [permission]: 'write' }; }));
  });
  it('grants the token read access to checks and statuses (the required-check read needs both)', () => {
    expect(yaml.safeLoad(workflowText()).permissions).toEqual(
      { contents: 'read', 'pull-requests': 'read', checks: 'read', statuses: 'read' });
  });
  it.each(['checks', 'statuses'])('refuses a workflow that drops %s: read', permission => {
    rejectedWorkflow(mutateWorkflow(doc => { delete doc.permissions[permission]; }));
  });
  it.each(['contents', 'pull-requests', 'id-token', 'checks', 'packages', 'statuses', 'issues', 'deployments'])
    ('refuses job-level %s: write', permission => {
      rejectedWorkflow(mutateWorkflow(doc => { jobs(doc)[0].permissions = { [permission]: 'write' }; }));
    });
  it.each([
    ['top-level write-all', doc => { doc.permissions = 'write-all'; }],
    ['job write-all', doc => { jobs(doc)[0].permissions = 'write-all'; }],
    ['missing permissions', doc => { delete doc.permissions; }],
    ['credential persistence omitted', doc => { for (const step of checkouts(doc)) { step.with ||= {}; delete step.with['persist-credentials']; } }],
    ['credential persistence true', doc => { for (const step of checkouts(doc)) step.with = { ...step.with, 'persist-credentials': true }; }],
    ['github-script with BOT_PAT token', doc => { jobs(doc)[0].steps.push({ uses: 'actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea', with: { 'github-token': '${{ vars.BOT_PAT }}' } }); }],
    ['upload-artifact with token-like input', doc => { for (const step of jobs(doc)[0].steps) if (/upload-artifact/.test(step.uses ?? '')) step.with['api-key'] = 'x'; }],
    ['upload-artifact tolerates empty uploads', doc => { for (const step of jobs(doc)[0].steps) if (/upload-artifact/.test(step.uses ?? '')) step.with['if-no-files-found'] = 'warn'; }],
    ['upload-artifact error on empty schedule', doc => { for (const step of jobs(doc)[0].steps) if (/upload-artifact/.test(step.uses ?? '')) step.with['if-no-files-found'] = 'error'; }],
    ['continue-on-error on job', doc => { jobs(doc)[0]['continue-on-error'] = true; }],
    ['continue-on-error on classify step', doc => { for (const step of jobs(doc)[0].steps) if (step.run?.includes('drain-classify-only')) step['continue-on-error'] = true; }],
    ['continue-on-error expression', doc => { jobs(doc)[0]['continue-on-error'] = '${{ true }}'; }],
    ['job disabled', doc => { jobs(doc)[0].if = 'false'; }],
    ['extra conditional step', doc => { jobs(doc)[0].steps.push({ if: 'false', run: 'echo failed=1; exit "${failed:-0}"' }); }],
    ['defaults.run.shell at top level', doc => { doc.defaults = { run: { shell: 'bash -c "$0; exit 0"' } }; }],
    ['defaults on job', doc => { jobs(doc)[0].defaults = { run: { shell: 'sh' } }; }],
    ['step shell override', doc => { for (const st of jobs(doc)[0].steps) if (/drain-classify-only/.test(st.run ?? '')) st.shell = 'bash {0} || true'; }],
    ['arbitrary pinned action', doc => { jobs(doc)[0].steps.push({ uses: 'someone/arbitrary-action@' + 'a'.repeat(40) }); }],
    ['other pinned checkout sha', doc => { for (const st of checkouts(doc)) st.uses = 'actions/checkout@' + 'b'.repeat(40); }],
    ['NODE_OPTIONS on classify step', doc => { for (const st of jobs(doc)[0].steps) if (/drain-classify-only/.test(st.run ?? '')) st.env.NODE_OPTIONS = '--import ./evil.mjs'; }],
    ['NODE_OPTIONS at top level', doc => { doc.env.NODE_OPTIONS = '--require x'; }],
    ['NODE_OPTIONS on job', doc => { jobs(doc)[0].env = { NODE_OPTIONS: '--import x' }; }],
    ['NODE_PATH on install step', doc => { for (const st of jobs(doc)[0].steps) if (/npm ci/.test(st.run ?? '')) st.env = { NODE_PATH: 'x' }; }],
    ['GH_TOKEN from a var', doc => { doc.env.GH_TOKEN = '${{ vars.BOT_PAT }}'; }],
    ['job container image', doc => { jobs(doc)[0].container = { image: 'attacker/classifier:latest' }; }],
    ['job services', doc => { jobs(doc)[0].services = { x: { image: 'y' } }; }],
    ['upload path package.json', doc => { for (const st of jobs(doc)[0].steps) if (/upload-artifact/.test(st.uses ?? '')) st.with.path = 'package.json'; }],
    ['unknown top-level key', doc => { doc.run_name = 'x'; }],
    ['runs-on self-hosted', doc => { jobs(doc)[0]['runs-on'] = 'self-hosted'; }],
    ['foreign repository checkout', doc => { for (const step of checkouts(doc)) step.with = { ...step.with, repository: 'attacker/foreign-code' }; }],
    ['checkout with extra token', doc => { for (const step of checkouts(doc)) step.with = { ...step.with, token: 'x' }; }],
    ['checkout with path', doc => { for (const step of checkouts(doc)) step.with = { ...step.with, path: 'x' }; }],
    ['feature checkout', doc => { for (const step of checkouts(doc)) step.with = { ...step.with, ref: 'feature' }; }],
    ['unpinned action', doc => { jobs(doc)[0].steps.push({ uses: 'actions/upload-artifact@v4' }); }],
    ['short SHA action', doc => { jobs(doc)[0].steps.push({ uses: 'actions/upload-artifact@abcdef0' }); }],
    ['App token action', doc => { jobs(doc)[0].steps.push({ uses: `actions/create-github-app-token@${'d'.repeat(40)}` }); }],
    ...['pull_request', 'pull_request_target', 'push'].map(event => [`${event} trigger`, doc => { doc.on = { ...doc.on, [event]: {} }; }]),
    ...['EXTRA_TOKEN', 'APP_PRIVATE_KEY'].flatMap(name => [
      [`literal ${name}`, doc => { doc.env = { ...doc.env, [name]: 'credential' }; }],
      [`job ${name} expression`, doc => { jobs(doc)[0].env = { [name]: '${{ vars.CREDENTIAL }}' }; }],
      [`step ${name}`, doc => { jobs(doc)[0].steps.push({ run: 'true', env: { [name]: 'credential' } }); }],
    ]),
  ])('refuses %s', (_name, mutate) => rejectedWorkflow(mutateWorkflow(mutate)));
  it.each(['${{ secrets.GITHUB_TOKEN }}', '${{ secrets.APP_KEY }}', "${{ secrets['APP_KEY'] }}"])
    ('refuses secret reference %s', reference => {
      rejectedWorkflow(mutateWorkflow(doc => { doc.env = { ...doc.env, GITHUB_TOKEN: reference }; }));
    });
  it('scans raw text for secrets references too', () => rejectedWorkflow(`${workflowText()}\n# secrets.GITHUB_TOKEN\n`));
});

const argv = ['--only=7', '--verdict-out=verdict.json', '--repo=o/r'];
// Variables the runner sets for every `run:` step (plus common image vars): none is a credential.
// Fixture root is a neutral stand-in (no literal host-local path, per the host-path ratchet); only the
// variable NAMES matter to the credential check, never these values.
const RT = '/srv/runner';
const RUNNER_STEP_ENV = Object.freeze({
  CI: 'true', HOME: RT, PATH: '/usr/bin:/bin',
  GITHUB_PATH: `${RT}/work/_temp/_runner_file_commands/add_path_x`, GITHUB_ENV: `${RT}/work/_temp/set_env_x`,
  GITHUB_OUTPUT: `${RT}/work/_temp/set_output_x`, GITHUB_STEP_SUMMARY: `${RT}/work/_temp/step_summary_x`,
  GITHUB_STATE: `${RT}/work/_temp/save_state_x`, GITHUB_EVENT_PATH: `${RT}/work/_temp/_github_workflow/event.json`,
  GITHUB_WORKSPACE: `${RT}/work/r/r`, GITHUB_ACTION_PATH: '', GITHUB_API_URL: 'https://api.github.com',
  RUNNER_TEMP: `${RT}/work/_temp`, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', RUNNER_NAME: 'GitHub Actions 1',
  RUNNER_TOOL_CACHE: '/opt/hostedtoolcache', RUNNER_WORKSPACE: `${RT}/work/r`, RUNNER_ENVIRONMENT: 'github-hosted',
  SELENIUM_JAR_PATH: '/usr/share/java/selenium-server.jar', SWIFT_PATH: '/usr/share/swift/usr/bin',
});
function ioFor() {
  return {
    env: { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule',
      GITHUB_RUN_ID: provenance.runId, GITHUB_REPOSITORY: ctx.repo, GITHUB_TOKEN: 'read-only-fixture' },
    now: () => now,
    execFileSync: vi.fn((cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'origin/main') return mainSha + '\n';
      if (cmd === 'gh' && args[0] === 'repo') return ctx.repo + '\n';
      if (cmd === process.execPath && args.some(arg => /(?:^|\/)merge-ai-prs\.mjs$/.test(arg)))
        return JSON.stringify(readyDryRun());
      throw new Error(`Unexpected injected command: ${cmd} ${args.join(' ')}`);
    }),
    writeFileSync: vi.fn(),
  };
}

describe('T5: CLI refuses unsafe environments and arguments before exec', () => {
  it.each([
    ['outside Actions', env => { env.GITHUB_ACTIONS = 'false'; }],
    ['missing Actions', env => { delete env.GITHUB_ACTIONS; }],
    ['feature ref', env => { env.GITHUB_REF = 'refs/heads/feature'; }],
    ...['pull_request', 'pull_request_target', 'push', ''].map(event => [`event ${event}`, env => { env.GITHUB_EVENT_NAME = event; }]),
    ['missing run ID', env => { delete env.GITHUB_RUN_ID; }],
    ['empty run ID', env => { env.GITHUB_RUN_ID = ''; }],
    ...['APP_PRIVATE_KEY', 'MY_APP_ID', 'SOME_SECRET', 'BOT_PAT', 'GH_TOKEN', 'EXTRA_TOKEN', 'private_key', 'app_id', 'secret', 'bot_pat',
      'PAT', 'GH_PAT2', 'ORG_PAT_RW', 'pat_bot', 'GH_PATTOKEN', 'BOT_PATS', 'BOT_PAT-RW']
      .map(name => [`credential ${name}`, env => { env[name] = 'foreign-credential'; }]),
    ['empty forbidden credential still present', env => { env.APP_PRIVATE_KEY = ''; }],
  ])('refuses %s before any process or write', async (_name, mutate) => {
    const io = ioFor(); mutate(io.env);
    await expect(async () => runCli(argv, io)).rejects.toThrow();
    expect(io.execFileSync).not.toHaveBeenCalled();
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });
  it.each([
    [], ['--verdict-out=x'], ['--only=7'],
    ...['0', '-1', 'no', '1.5', '7x', ''].map(value => [`--only=${value}`, '--verdict-out=x']),
    ['--only=7', '--verdict-out='], [...argv, '--only=8'], [...argv, '--verdict-out=other'],
    [...argv, '--repo=other/repo'], [...argv, '--unknown'], [...argv, '--classify-only'],
    ['--only=7', '--verdict-out=x', '--repo=invalid'],
  ])('refuses bad/repeated/unknown argv %j before exec', async (...args) => {
    const io = ioFor();
    await expect(async () => runCli(args, io)).rejects.toThrow();
    expect(io.execFileSync).not.toHaveBeenCalled();
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });
  it.each(['schedule', 'workflow_dispatch'])('writes a verifiable verdict for %s without a guard preload', async event => {
    const io = ioFor(); io.env.GITHUB_EVENT_NAME = event;
    // The sole permitted token alias must not be mistaken for an extra credential.
    io.env.GH_TOKEN = io.env.GITHUB_TOKEN;
    await runCli(argv, io);
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
    const [path, bytes] = io.writeFileSync.mock.calls[0];
    expect(path).toBe('verdict.json');
    const verdict = JSON.parse(String(bytes));
    expect(verdict).toEqual({ ...valid(), provenance: { ...provenance, event } });
    expect(verify(verdict, { ...live(), provenance: { ...provenance, event } }, { now })).toEqual({ ok: true });
    const children = io.execFileSync.mock.calls.filter(([cmd]) => cmd === process.execPath);
    expect(children).toHaveLength(1);
    const [, args, options] = children[0];
    expect(args).toEqual(expect.arrayContaining(['--only=7', '--dry-run', '--json']));
    expect(args.some(arg => arg === '--import' || arg.startsWith('--import='))).toBe(false);
    expect(options.env).not.toHaveProperty('DRAIN_CLASSIFY_ONLY');
    expect(options.env.NODE_OPTIONS || '').not.toMatch(/--import|drain-classify-guard/);
  });
  it('accepts a real runner step environment (GITHUB_PATH and other *_PATH files are not PATs)', async () => {
    const io = ioFor(); Object.assign(io.env, RUNNER_STEP_ENV);
    await runCli(argv, io);
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
  });
  it('refuses when origin/main moves during the dry-run (main changed) and writes nothing', () => {
    const io = ioFor(), inner = io.execFileSync;
    let reads = 0;
    io.execFileSync = vi.fn((cmd, args, opts) => {
      if (cmd === 'git' && args[1] === 'origin/main') return `${reads++ ? movedSha : mainSha}\n`;
      return inner(cmd, args, opts);
    });
    expect(() => runCli(argv, io)).toThrow(/main changed; run the local drain/);
    expect(reads).toBe(2);
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });
  it('resolves the optional repo from the injected environment', async () => {
    const io = ioFor();
    await runCli(argv.slice(0, 2), io);
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(io.writeFileSync.mock.calls[0][1])).repo).toBe(ctx.repo);
  });
});

describe('T5b: review-escalation pass is kept on in the real drain call', () => {
  it('passes --label=ready-to-merge and never relaxes escalation', () => {
    const io = ioFor();
    runCli(argv, io);
    const call = io.execFileSync.mock.calls.find(([cmd, a]) => cmd === process.execPath && a.some(x => /merge-ai-prs\.mjs$/.test(x)));
    expect(call[1]).toContain('--label=ready-to-merge');
    expect(call[1].some(x => /no-review-escalation/.test(x))).toBe(false);
  });
  it('the real drain enables REVIEW_ESCALATION only for a label-scoped run (omitting the label would skip it)', () => {
    const src = readFileSync(new URL('../merge-ai-prs.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/const REVIEW_ESCALATION = label && !escalationRelief\.passWide;/);
  });
});

describe('T5c: the spawned drain reads with the workflow token on a fresh runner (no App credentials)', () => {
  // merge-ai-prs.mjs is a large module (several seconds to load): import it once, outside the per-test timeout.
  // A dynamic import keeps the rest of this file runnable on a tree where the export is missing.
  let isCiReadonlyDryRun, ensureFreshGithubAppEnv;
  beforeAll(async () => {
    ({ isCiReadonlyDryRun } = await import('../merge-ai-prs.mjs'));
    ({ ensureFreshGithubAppEnv } = await import('../lib/github-app-auth-env.mjs'));
  }, 120_000);
  // The child call exactly as runCli spawns it: its argv and its env (a real runner step env, no App vars, no cache).
  const childCall = (extraEnv = {}) => {
    const io = ioFor(); Object.assign(io.env, RUNNER_STEP_ENV, extraEnv);
    runCli(argv, io);
    const [cmd, args, opts] = io.execFileSync.mock.calls.find(([c, a]) => c === process.execPath && a.some(x => /merge-ai-prs\.mjs$/.test(x)));
    return { childArgv: [cmd, ...args], env: { ...opts.env } };
  };
  // Every IO seam injected: no real token cache, status file, key or shim install is touched.
  const authFor = async (env, daemon) => {
    const installShim = vi.fn(async () => ({ ok: true }));
    const result = await ensureFreshGithubAppEnv({ env, daemon, installShim, perOwner: true, caller: 'drain',
      cachePath: '/nonexistent-fixture/token.json', statusPath: '/nonexistent-fixture/status.json',
      readCache: () => null, writeCache: vi.fn(), writeStatus: vi.fn(),
      mint: vi.fn(async () => { throw new Error('mint must not run'); }),
      policy: { auth: 'app', personalExceptions: {}, source: { auth: 'default' } },
      identity: { roles: {}, callerRoles: {}, anyConfigured: false },
      log: { log() {}, info() {}, warn() {}, error() {} } });
    return { result, installShim };
  };

  it('the real child argv and env classify as a CI read-only dry-run', async () => {
    const { childArgv, env } = childCall();
    expect(isCiReadonlyDryRun(env, childArgv)).toBe(true);
  });

  it('so no gh refusal shim is installed and the inherited GITHUB_TOKEN stays the credential', async () => {
    const { childArgv, env } = childCall();
    const { result, installShim } = await authFor(env, !isCiReadonlyDryRun(env, childArgv));
    expect(installShim).not.toHaveBeenCalled();
    expect(result).toMatchObject({ applied: false, reason: 'not-configured' });
    expect(env.WE_GH_DAEMON_CALLER).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe('read-only-fixture');
  });

  it('a daemon-marked environment still gets the refusal shim (the exemption stays CI-only)', async () => {
    const { childArgv, env } = childCall({ XPC_SERVICE_NAME: 'com.we.drain' });
    expect(isCiReadonlyDryRun(env, childArgv)).toBe(false);
    const { installShim } = await authFor(env, !isCiReadonlyDryRun(env, childArgv));
    expect(installShim).toHaveBeenCalledTimes(1);
  });

  it('every drain auth call in merge-ai-prs routes through the CI read-only exemption', () => {
    const src = readFileSync(new URL('../merge-ai-prs.mjs', import.meta.url), 'utf8');
    // Every call, whatever its argument shape (an options variable would bypass an object-literal match).
    const calls = src.split('\n').filter(line => /ensureFreshGithubAppEnv\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call).toMatch(/ensureFreshGithubAppEnv\(\{[^}]*daemon: !isCiReadonlyDryRun\(process\.env, process\.argv\) \}\)/);
  });
});

import { runBatch } from '../drain-classify-only.mjs';

describe('T6: --batch owns the loop, the counting and the exit code', () => {
  const batchArgv = ['--batch', '--verdict-dir=verdicts'];
  const READY = [{ name: 'ready-to-merge' }];
  // The plain open-PR listing as gh returns it: rows with number + labels (`prs` are labelled ready-to-merge).
  const listing = (prs, extra = []) => JSON.stringify([...prs.map(number => ({ number, labels: READY })), ...extra]);
  function batchIo({ prs = [7, 8], raw, failPr = null, event = 'schedule', requested, dryRunFor = readyDryRun } = {}) {
    const io = ioFor();
    io.env.GITHUB_EVENT_NAME = event;
    if (requested !== undefined) io.env.REQUESTED_PR = requested;
    io.mkdirSync = vi.fn();
    const inner = io.execFileSync;
    io.execFileSync = vi.fn((cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'pr') return raw ?? listing(prs);
      if (cmd === process.execPath && failPr && args.includes(`--only=${failPr}`)) throw new Error('boom');
      if (cmd === process.execPath) {
        const n = args.find(a => a.startsWith('--only=')).slice(7);
        return JSON.stringify(dryRunFor(Number(n)));
      }
      return inner(cmd, args, opts);
    });
    return io;
  }
  it('schedule: writes one verdict per PR and succeeds', () => {
    const io = batchIo();
    const out = runBatch(batchArgv, io);
    expect(out).toMatchObject({ written: 2, failed: 0 });
    expect(io.writeFileSync.mock.calls.map(c => c[0])).toEqual(['verdicts/pr-7.json', 'verdicts/pr-8.json']);
  });
  it('send-back repro: one uncoupled ready PR #7 with the real ready-not-reached row writes enqueue (written=1, failed=0)', () => {
    const io = batchIo({ prs: [7] });
    expect(runBatch(batchArgv, io)).toEqual({ written: 1, failed: 0 });
    const child = io.execFileSync.mock.results.find((_r, i) => io.execFileSync.mock.calls[i][0] === process.execPath);
    expect(JSON.parse(child.value).skipReasons).toEqual([expect.objectContaining({ num: 7, kind: 'ready-not-reached', source: 'unaccounted' })]);
    expect(JSON.parse(String(io.writeFileSync.mock.calls[0][1])).decision).toBe('enqueue');
  });
  it('a couple partner-pending row still fails the PR to the local drain (written=0, failed=1)', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const io = batchIo({ prs: [7], dryRunFor: num => readyDryRun(num, { skipReasons: buildSkipReasons({ verdicts: [
        { num, repo: null, item: '4242', decision: 'merge', headSha }, { num: num + 1, repo: null, item: '4242', decision: 'merge', headSha }] }) }) });
      expect(runBatch(batchArgv, io)).toEqual({ written: 0, failed: 1 });
      expect(io.writeFileSync).not.toHaveBeenCalled();
      expect(stderr.mock.calls.map(c => String(c[0])).join('')).toMatch(/#7: .*run the local drain/);
    } finally { stderr.mockRestore(); }
  });
  it('the real CLI process exits 1 when the batch has a failure, and 0 for an empty scheduled batch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-verdict-exit-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
      const script = fileURLToPath(new URL('../drain-classify-only.mjs', import.meta.url));
      // A clean env: nothing inherited from the session, so assertSafeEnv passes and the batch result decides.
      const env = event => ({ PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: event, GITHUB_RUN_ID: '1', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'read-only-fixture', REQUESTED_PR: 'abc' });
      const run = event => spawnSync(process.execPath, [script, '--batch', '--verdict-dir=verdicts'],
        { cwd: dir, encoding: 'utf8', timeout: 60_000, env: env(event) });
      const failed = run('workflow_dispatch');
      expect(failed.stderr).toMatch(/#abc: invalid PR number/);
      expect(failed.status).toBe(1);
      const empty = run('schedule');
      expect(empty.stderr).toBe('');
      expect(empty.status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('one failing PR still attempts the others, then reports failure', () => {
    const io = batchIo({ failPr: 7 });
    const out = runBatch(batchArgv, io);
    expect(out).toMatchObject({ written: 1, failed: 1 });
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
  });
  it('schedule: no labeled open PRs is a successful no-op', () => {
    const io = batchIo({ prs: [], raw: listing([], [{ number: 5, labels: [{ name: 'review:pending' }] }]) });
    expect(runBatch(batchArgv, io)).toEqual({ written: 0, failed: 0 });
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(io.mkdirSync).not.toHaveBeenCalled();
    expect(io.execFileSync).toHaveBeenCalledTimes(1);
  });
  it('schedule: lists open PRs plainly (never a search-backed label filter) and filters client-side', () => {
    const io = batchIo({ raw: listing([7], [{ number: 5, labels: [] }, { number: 6, labels: ['ready-to-merge'] }]) });
    expect(runBatch(batchArgv, io)).toMatchObject({ written: 2, failed: 0 });
    expect(io.execFileSync.mock.calls[0].slice(0, 2)).toEqual(['gh', [
      'pr', 'list', '--repo', io.env.GITHUB_REPOSITORY, '--state', 'open', '--limit', '500', '--json', 'number,labels',
    ]]);
    expect(io.writeFileSync.mock.calls.map(c => c[0])).toEqual(['verdicts/pr-7.json', 'verdicts/pr-6.json']);
  });
  it('schedule: classifies at most 10 labelled PRs per run', () => {
    const io = batchIo({ prs: Array.from({ length: 12 }, (_, i) => i + 1) });
    expect(runBatch(batchArgv, io)).toMatchObject({ written: 10, failed: 0 });
  });
  it.each([
    ['a possibly-truncated listing (at the list limit)', () => listing(Array.from({ length: 500 }, (_, i) => i + 1))],
    ['invalid JSON', () => 'not json'],
    ['a non-array listing', () => '{"number":7}'],
  ])('schedule: %s fails closed before any classification', (_name, raw) => {
    const io = batchIo({ raw: raw() });
    expect(runBatch(batchArgv, io)).toEqual({ written: 0, failed: 1 });
    expect(io.writeFileSync).not.toHaveBeenCalled();
    expect(io.execFileSync).toHaveBeenCalledTimes(1);
  });
  it('dispatch: absent requested PR remains a failure', () => {
    expect(runBatch(batchArgv, batchIo({ event: 'workflow_dispatch' }))).toEqual({ written: 0, failed: 1 });
  });
  it('schedule: unreadable PR list remains a failure', () => {
    const io = batchIo();
    io.execFileSync.mockImplementation(() => { throw new Error('unreadable'); });
    expect(runBatch(batchArgv, io)).toEqual({ written: 0, failed: 1 });
    expect(io.writeFileSync).not.toHaveBeenCalled();
  });
  it('all failing is a failure', () => {
    const io = batchIo({ prs: [7], failPr: 7 });
    expect(runBatch(batchArgv, io)).toMatchObject({ written: 0, failed: 1 });
  });
  it('dispatch classifies only the requested PR', () => {
    const io = batchIo({ event: 'workflow_dispatch', requested: '9' });
    expect(runBatch(batchArgv, io)).toMatchObject({ written: 1, failed: 0 });
    expect(io.writeFileSync.mock.calls[0][0]).toBe('verdicts/pr-9.json');
    expect(io.execFileSync.mock.calls.some(c => c[0] === 'gh' && c[1][0] === 'pr')).toBe(false);
  });
  it.each(['', 'abc', '0', '9; rm -rf /', '1 2'])('dispatch refuses bad requested PR %j', requested => {
    expect(runBatch(batchArgv, batchIo({ event: 'workflow_dispatch', requested }))).toMatchObject({ written: 0, failed: 1 });
  });
  it.each(['9; echo', '-1', 'x', '0'])('schedule ignores non-numeric PR list entry %j as a failure', bad => {
    expect(runBatch(batchArgv, batchIo({ prs: [bad] }))).toMatchObject({ written: 0, failed: 1 });
  });
  it('accepts a real runner step environment, as the workflow invokes it', () => {
    const io = batchIo(); Object.assign(io.env, RUNNER_STEP_ENV);
    expect(runBatch(batchArgv, io)).toMatchObject({ written: 2, failed: 0 });
  });
  it('refuses unsafe env before any process', () => {
    const io = batchIo(); io.env.GITHUB_REF = 'refs/heads/feature';
    expect(() => runBatch(batchArgv, io)).toThrow();
    expect(io.execFileSync).not.toHaveBeenCalled();
  });
  it.each([[['--batch']], [['--batch', '--verdict-dir=a', '--verdict-dir=b']], [['--batch', '--only=7', '--verdict-dir=a']], [['--verdict-dir=a']]])
  ('refuses bad batch args %j', args => {
    expect(() => runBatch(args, batchIo())).toThrow();
  });
});

describe('T6b: workflow pins the exact command', () => {
  const CMD = 'node scripts/drain-classify-only.mjs --batch --verdict-dir=verdicts';
  const classify = doc => jobs(doc)[0].steps.find(st => /drain-classify-only/.test(st.run ?? ''));
  it('real workflow ignores missing artifacts for an empty scheduled batch', () => {
    const upload = jobs(yaml.safeLoad(workflowText()))[0].steps.find(st => /upload-artifact/.test(st.uses ?? ''));
    expect(upload.with['if-no-files-found']).toBe('ignore');
  });
  it('real workflow runs exactly the batch command', () => {
    expect(classify(yaml.safeLoad(workflowText())).run.trim()).toBe(CMD);
  });
  it.each([
    ['|| true', c => `${c} || true`], ['appended line', c => `${c}\necho ok`], ['semicolon', c => `${c}; true`],
    ['&&', c => `${c} && true`], ['altered flag', c => c.replace('--batch', '--batch --x')], ['altered command', c => c.replace('drain-classify-only', 'other')],
    ['pipe', c => `${c} | cat`], ['subshell', c => `${c} $(id)`],
  ])('rejects %s', (_n, change) => rejectedWorkflow(mutateWorkflow(doc => { const st = classify(doc); st.run = change(st.run.trim()); })));
  it('rejects a continue-on-error step and an if guard on the step', () => {
    rejectedWorkflow(mutateWorkflow(doc => { classify(doc)['continue-on-error'] = true; }));
    rejectedWorkflow(mutateWorkflow(doc => { classify(doc).if = 'false'; }));
  });
  it('rejects a second run step', () => rejectedWorkflow(mutateWorkflow(doc => { jobs(doc)[0].steps.push({ run: 'true' }); })));
});
