// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { decideQueueTestedSkip, MAX_RUNS_CHECKED, INPUT_SETTLE_MS, SIBLING_REPO, SIBLING_BRANCH } from '../skip-queue-tested-push.mjs';

const sha = 'a'.repeat(40);
const pushTree = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);
const otherTree = 'd'.repeat(40);
const quarantineTip = 'f'.repeat(40);
const fuiTip = '9'.repeat(40);
const RUN_CREATED = '2026-10-31T12:00:00Z';
const NOW = Date.parse('2026-10-31T12:30:00Z');
const OLD_PUSH_TIME = '2026-10-30T12:00:00Z';
// GitHub's own record of the newest push to a ref (GET /repos/{repo}/activity): server time, not the writer's clock.
const push = (after, overrides = {}) => ({ activity_type: 'push', after, timestamp: OLD_PUSH_TIME, ...overrides });
const run = (head_sha = otherSha, overrides = {}) => ({
  head_sha, conclusion: 'success', created_at: RUN_CREATED, run_attempt: 1,
  run_started_at: overrides.created_at ?? RUN_CREATED,
  updated_at: overrides.created_at ?? RUN_CREATED, ...overrides,
});
// A quarantine entry that passes validateQuarantineList (scripts/lib/red-main-quarantine.mjs).
const entry = (overrides = {}) => ({
  test: 'scripts/x/__tests__/flaky.test.mjs', brokenSha: '1234567', owner: 'red-main-safety-net',
  reason: 'red on main', addedAt: 1, expiresAt: 2, ...overrides,
});
const quarantine = (list = { version: 1, entries: [], mode: 'stop' }, lastPush = push(quarantineTip)) => (
  { ok: true, list, tip: quarantineTip, lastPush });
const sibling = () => ({ ok: true, tip: fuiTip, lastPush: push(fuiTip) });
const input = (overrides = {}) => ({
  event: 'push', ref: 'refs/heads/main', sha, pushTree, now: NOW,
  listMergeGroupRuns: vi.fn().mockResolvedValue([run()]),
  getCommitTree: vi.fn().mockResolvedValue(otherTree),
  readQuarantineState: vi.fn().mockResolvedValue(quarantine()),
  readSiblingState: vi.fn().mockResolvedValue(sibling()),
  ...overrides,
});
const expectClosed = (result) => {
  expect(result.skip).toBe(false);
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim()).not.toBe('');
  expect(result.matchedSha).toBeUndefined();
};

// Spawn the shipped entry point; only fixture binaries are on PATH. Each stub records
// argv independently of its response, so a wrong API filter cannot silently pass.
// The run's created_at is in the past of the real clock, and every recorded push predates it by more
// than the settle margin, so the default fixture proves "the queue run read these same inputs".
const CLI_LIST = JSON.stringify({ version: 1, entries: [], mode: 'quarantine' });
const activity = (after, overrides = {}) => JSON.stringify([push(after, overrides)]);
function runCli({ args = {}, runs = JSON.stringify({ workflow_runs: [run()] }), tree = pushTree,
  gitTree = pushTree, fail = '', qTip = quarantineTip, qListed = 'quarantine.json', qList = CLI_LIST,
  qActivity = activity(quarantineTip), fuiBranch = 'main', fuiTipOut = fuiTip, fuiActivity = activity(fuiTip),
  hang = '', env = { GH_TOKEN: 'we-token', FUI_TOKEN: 'fui-token' } } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'queue-tested-cli-'));
  const callsFile = join(cwd, 'calls.jsonl');
  let completed = false;
  writeFileSync(callsFile, '');
  try {
    for (const command of ['git', 'gh']) {
      writeFileSync(join(cwd, command), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const command = ${JSON.stringify(command)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv: [command, ...args], token: process.env.GH_TOKEN ?? null, pid: process.pid }) + '\\n');
const url = args[1] ?? '';
const kind = command === 'gh'
  ? (url.includes('/actions/workflows/') ? 'runs' : url.includes('/git/commits/') ? 'tree'
    : url.startsWith('repos/${SIBLING_REPO}/activity') ? 'fui-activity' : url.includes('/activity') ? 'q-activity'
      : url.startsWith('repos/${SIBLING_REPO}/branches/') ? 'fui-tip' : url === 'repos/${SIBLING_REPO}' ? 'fui-branch' : 'unknown')
  : args[0] === 'rev-parse' ? (args[1] === '--verify' ? 'q-tip' : 'git') : \`q-\${args[0]}\`;
if (kind === ${JSON.stringify(fail)} || kind === 'unknown') process.exit(1);
if (kind === ${JSON.stringify(hang)}) {
  ${keepAliveScript({ maxLifetimeMs: 60_000, prelude: "process.on('SIGTERM', () => {});" })}
} else {
const responses = ${JSON.stringify({ git: gitTree, runs, tree, 'q-fetch': '', 'q-tip': qTip, 'q-ls-tree': qListed,
    'q-show': qList, 'q-activity': qActivity, 'fui-branch': fuiBranch, 'fui-tip': fuiTipOut, 'fui-activity': fuiActivity })};
process.stdout.write(responses[kind] + '\\n');
}
`, { mode: 0o755 });
    }
    const options = { event: 'push', ref: 'refs/heads/main', sha, repo: 'example/project', ...args };
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../skip-queue-tested-push.mjs', import.meta.url)),
      ...Object.entries(options).filter(([, value]) => value !== undefined)
        .map(([key, value]) => `--${key}=${value}`),
    ], { cwd, env: { PATH: cwd, ...env }, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const records = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    completed = true;
    return { ...result, calls: records.map(({ argv }) => argv), records };
  } finally {
    // Also clean up a hung fixture if a future timeout regression trips the outer CLI deadline.
    if (hang && !completed) {
      const records = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      const pid = records.at(-1)?.pid;
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped by the detector. */ } }
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

const quarantineCalls = (repo = 'example/project') => [
  ['git', 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', '+refs/heads/ops/quarantine:refs/remotes/origin/ops/quarantine'],
  ['git', 'rev-parse', '--verify', 'refs/remotes/origin/ops/quarantine^{commit}'],
  ['git', 'ls-tree', '--name-only', quarantineTip, '--', 'quarantine.json'],
  ['git', 'show', `${quarantineTip}:quarantine.json`],
  ['gh', 'api', `repos/${repo}/activity?ref=refs/heads/ops/quarantine&direction=desc&per_page=1`],
];
const siblingCalls = [
  ['gh', 'api', 'repos/frontier-ui/frontierui/branches/main', '--jq', '.commit.sha'],
  ['gh', 'api', 'repos/frontier-ui/frontierui/activity?ref=refs/heads/main&direction=desc&per_page=1'],
];

describe('queue-tested CLI adapter', () => {
  it('keeps full CI for an older equal-tree success followed by a failure on the push SHA', () => {
    const result = runCli({ runs: JSON.stringify({ workflow_runs: [
      run(otherSha), run(sha, { conclusion: 'failure', created_at: '2026-10-31T12:10:00Z' }),
    ] }) });
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('did not succeed');
  });

  it('keeps full CI when an older run fails on a later attempt after another success', () => {
    const result = runCli({ runs: JSON.stringify({ workflow_runs: [
      run(sha), run(sha, { conclusion: 'failure', created_at: '2026-10-30T12:00:00Z',
        run_attempt: 2, run_started_at: '2026-10-31T12:10:00Z', updated_at: '2026-10-31T12:20:00Z' }),
    ] }) });
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('did not succeed');
  });

  it('keeps full CI after the default branch switched away and back to main for an older unpinned queue run', () => {
    const current = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const previous = structuredClone(current);
    for (const job of Object.values(previous.jobs)) {
      for (const step of job.steps ?? []) {
        if (String(step.uses).startsWith('actions/checkout@') && step.with?.repository === SIBLING_REPO) {
          delete step.with.ref;
        }
      }
    }
    // Tree identifiers model otherwise identical trees whose workflow blobs differ only by the pins.
    // The old run checked out default=next; default is main again now, with no main push activity.
    const treeOf = (workflow) => createHash('sha1').update(yaml.dump(workflow)).digest('hex');
    const result = runCli({ gitTree: treeOf(current), tree: treeOf(previous), fuiBranch: 'main' });
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('tree differs');
    expect(result.stderr).toContain('running full CI');
  });

  it.each(['git', 'runs'])('kills a hung %s git/gh call at the subprocess timeout and fails closed to full CI', (hang) => {
    const started = Date.now();
    const result = runCli({ hang });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('running full CI');
    const child = result.records.at(-1);
    expect(child.argv[0]).toBe(hang === 'git' ? 'git' : 'gh');
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 45_000);

  it('CLI queries all merge_group runs (a newer failure must stay visible) from ci.yml and emits the matching-tree decision', () => {
    const result = runCli();
    expect(result.calls).toEqual([
      ['git', 'rev-parse', `${sha}^{tree}`],
      ['gh', 'api', 'repos/example/project/actions/workflows/ci.yml/runs?event=merge_group&per_page=100'],
      ['gh', 'api', `repos/example/project/git/commits/${otherSha}`, '--jq', '.tree.sha'],
      ...quarantineCalls(),
      ...siblingCalls,
    ]);
    expect(result.stdout).toBe('queue_tested=true\n');
    expect(result.stderr).toContain('push tree already passed merge-group CI');
  });

  it('uses the WE token for WE endpoints and the FUI token only for the sibling endpoints', () => {
    const { records } = runCli();
    const gh = records.filter(({ argv }) => argv[0] === 'gh');
    expect(gh.map(({ argv, token }) => [argv[2], token])).toEqual([
      [expect.stringContaining('repos/example/project/actions/'), 'we-token'],
      [expect.stringContaining('repos/example/project/git/commits/'), 'we-token'],
      [expect.stringContaining('repos/example/project/activity?'), 'we-token'],
      [expect.stringContaining('repos/frontier-ui/frontierui/branches/'), 'fui-token'],
      [expect.stringContaining('repos/frontier-ui/frontierui/activity?'), 'fui-token'],
    ]);
  });

  it('pins the sibling repository the workflow checks out', () => {
    expect(SIBLING_REPO).toBe('frontier-ui/frontierui');
    expect(SIBLING_BRANCH).toBe('main');
  });

  it.each(['next', 'Main', '../main', '', 'main'])('uses the pinned main branch regardless of the current default %j', (fuiBranch) => {
    const result = runCli({ fuiBranch, fail: 'fui-branch' });
    expect(result.stdout).toBe('queue_tested=true\n');
    expect(result.calls.filter((argv) => argv[2]?.startsWith(`repos/${SIBLING_REPO}`))).toEqual(siblingCalls);
  });

  it('uses the supplied repository for every WE endpoint', () => {
    const result = runCli({ args: { repo: 'another-owner/another-repo' } });
    expect(result.calls.slice(1)).toEqual([
      ['gh', 'api', 'repos/another-owner/another-repo/actions/workflows/ci.yml/runs?event=merge_group&per_page=100'],
      ['gh', 'api', `repos/another-owner/another-repo/git/commits/${otherSha}`, '--jq', '.tree.sha'],
      ...quarantineCalls('another-owner/another-repo'),
      ...siblingCalls,
    ]);
    expect(result.stdout).toBe('queue_tested=true\n');
  });

  it('emits an exact-head match without requesting its tree', () => {
    const result = runCli({ runs: JSON.stringify({ workflow_runs: [run(sha)] }) });
    expect(result.stdout).toBe('queue_tested=true\n');
    expect(result.calls).toEqual([
      ['git', 'rev-parse', `${sha}^{tree}`],
      ['gh', 'api', 'repos/example/project/actions/workflows/ci.yml/runs?event=merge_group&per_page=100'],
      ...quarantineCalls(),
      ...siblingCalls,
    ]);
  });

  it('treats a tip without a list file as an empty list and does not show it', () => {
    const result = runCli({ qListed: '' });
    expect(result.stdout).toBe('queue_tested=true\n');
    expect(result.calls).not.toContainEqual(quarantineCalls()[3]);
  });

  it('keeps full CI without a FUI token and makes no sibling call', () => {
    const result = runCli({ env: { GH_TOKEN: 'we-token' } });
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('frontierui');
    expect(result.calls.filter((argv) => argv[2]?.startsWith('repos/frontier-ui/'))).toEqual([]);
  });

  it('keeps full CI when the published list is in quarantine mode with an entry (red-team break, PR #6211)', () => {
    const result = runCli({ qList: JSON.stringify({ version: 1, mode: 'quarantine', entries: [entry()] }) });
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('quarantine mode has entries');
  });

  it.each([
    ['quarantine fetch error', { fail: 'q-fetch' }],
    ['quarantine tip error', { fail: 'q-tip' }],
    ['invalid quarantine tip', { qTip: 'not-a-sha' }],
    ['quarantine ls-tree error', { fail: 'q-ls-tree' }],
    ['quarantine show error', { fail: 'q-show' }],
    ['malformed quarantine JSON', { qList: '{' }],
    ['invalid quarantine list', { qList: JSON.stringify({ version: 2, entries: [] }) }],
    ['invalid quarantine entry', { qList: JSON.stringify({ version: 1, mode: 'stop', entries: [{ test: '../x' }] }) }],
    ['quarantine activity API error', { fail: 'q-activity' }],
    ['malformed quarantine activity JSON', { qActivity: '[' }],
    ['non-array quarantine activity', { qActivity: '{}' }],
    ['empty quarantine activity', { qActivity: '[]' }],
    ['quarantine pushed after the queue run', { qActivity: activity(quarantineTip, { timestamp: '2026-10-31T11:55:00Z' }) }],
    ['quarantine force-reset after the queue run', { qActivity: activity(quarantineTip, { activity_type: 'force_push', timestamp: '2026-10-31T12:05:00Z' }) }],
    ['quarantine moved between the fetch and the activity read', { qActivity: activity(otherSha) }],
    ['future quarantine push time', { qActivity: activity(quarantineTip, { timestamp: '2999-01-01T00:00:00Z' }) }],
    ['FUI tip API error', { fail: 'fui-tip' }],
    ['invalid FUI tip', { fuiTipOut: 'not-a-sha' }],
    ['FUI activity API error', { fail: 'fui-activity' }],
    ['empty FUI activity', { fuiActivity: '[]' }],
    ['FUI pushed after the queue run', { fuiActivity: activity(fuiTip, { timestamp: '2026-10-31T11:55:00Z' }) }],
    ['FUI moved between the tip and the activity read', { fuiActivity: activity(otherSha) }],
  ])('keeps full CI on %s', (_name, fixture) => {
    const result = runCli(fixture);
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('running full CI');
  });

  it.each([
    ['git tree lookup error', { fail: 'git' }],
    ['run listing API error', { fail: 'runs' }],
    ['commit tree API error', { fail: 'tree' }],
    ['malformed API JSON', { runs: '{' }],
    ['missing workflow_runs', { runs: '{}' }],
    ['non-array workflow_runs', { runs: '{"workflow_runs":null}' }],
    ['empty workflow_runs', { runs: '{"workflow_runs":[]}' }],
    ['unsuccessful matching head', { runs: JSON.stringify({ workflow_runs: [run(sha, { conclusion: 'failure' })] }) }],
    ['invalid push tree', { gitTree: 'bad-tree' }],
    ['invalid queue tree', { tree: 'bad-tree' }],
    ['different queue tree', { tree: otherTree }],
  ])('emits only queue_tested=false with a successful exit on %s', (_name, fixture) => {
    const result = runCli(fixture);
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('running full CI');
  });

  it.each([
    { repo: undefined }, { repo: 'missing-owner' }, { repo: 'owner/repo/extra' },
    { repo: 'owner/repo\n' }, { sha: undefined }, { sha: 'g'.repeat(40) },
    { sha: `${sha}\n` }, { unknown: 'option' },
  ])('rejects invalid CLI arguments %j before invoking either binary', (args) => {
    const result = runCli({ args });
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.stderr).toContain('running full CI');
    expect(result.calls).toEqual([]);
  });

  it.each([
    { event: 'pull_request' }, { event: 'merge_group' }, { event: 'schedule' },
    { event: 'workflow_dispatch' }, { ref: 'refs/heads/feature' },
  ])('does not query queue evidence for ineligible CLI context %j', (args) => {
    const result = runCli({ args });
    expect(result.stdout).toBe('queue_tested=false\n');
    expect(result.calls).toEqual([['git', 'rev-parse', `${sha}^{tree}`]]);
  });
});

// Red-team break on heads c43fca82, bc9b5fc2 and f14e1e3d: in quarantine mode a merge_group run excludes
// quarantined tests that a push to main would run, so its success is not proof that the full suite passed.
describe('quarantine evidence: the matched queue run must have excluded nothing', () => {
  const matchTree = (overrides = {}) => input({ getCommitTree: vi.fn().mockResolvedValue(pushTree), ...overrides });

  it.each([
    ['a live entry', entry({ expiresAt: NOW + 60_000 })],
    ['an expired entry (it may have been live when the queue ran)', entry()],
    ['a job-tagged entry', entry({ job: 'integration', expiresAt: NOW + 60_000 })],
    ['a soak-shard entry', entry({ job: 'soak-shard (3)', expiresAt: NOW + 60_000 })],
    ['a name-qualified entry', entry({ test: 'scripts/x/__tests__/flaky.test.mjs::one case', expiresAt: NOW + 60_000 })],
  ])('keeps full CI in quarantine mode with %s', async (_name, quarantined) => {
    for (const args of [
      matchTree({ readQuarantineState: vi.fn().mockResolvedValue(quarantine({ version: 1, mode: 'quarantine', entries: [quarantined] })) }),
      input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]),
        readQuarantineState: vi.fn().mockResolvedValue(quarantine({ version: 1, mode: 'quarantine', entries: [quarantined] })) }),
    ]) {
      const result = await decideQueueTestedSkip(args);
      expectClosed(result);
      expect(result.reason).toMatch(/quarantine mode has entries/);
      expect(args.readQuarantineState).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['quarantine mode with no entries', { version: 1, mode: 'quarantine', entries: [] }],
    ['stop mode with entries', { version: 1, mode: 'stop', entries: [entry({ expiresAt: NOW + 60_000 })] }],
    ['no mode stamp (stop) with entries', { version: 1, entries: [entry({ expiresAt: NOW + 60_000 })] }],
  ])('skips when the list proves nothing was excluded: %s', async (_name, list) => {
    const args = matchTree({ readQuarantineState: vi.fn().mockResolvedValue(quarantine(list)) });
    expect(await decideQueueTestedSkip(args)).toMatchObject({ skip: true, matchedSha: otherSha });
  });

  it.each([
    ['a read that throws', vi.fn().mockRejectedValue(new Error('fetch failed')), /read failed/],
    ['ok:false', vi.fn().mockResolvedValue({ ok: false, error: 'unreachable' }), /unreadable/],
    ['a missing state', vi.fn().mockResolvedValue(undefined), /unreadable/],
    ['a missing list', vi.fn().mockResolvedValue({ ok: true, tip: quarantineTip, lastPush: push(quarantineTip) }), /unreadable/],
    ['non-array entries', vi.fn().mockResolvedValue(quarantine({ version: 1, mode: 'stop', entries: null })), /entries unreadable/],
    ['an unknown mode', vi.fn().mockResolvedValue(quarantine({ version: 1, mode: 'skip-all', entries: [] })), /unknown quarantine mode/],
  ])('fails closed on %s', async (_name, readQuarantineState, reason) => {
    const result = await decideQueueTestedSkip(matchTree({ readQuarantineState }));
    expectClosed(result);
    expect(result.reason).toMatch(reason);
  });

  it('does not read the quarantine list when no run matches', async () => {
    const args = input();
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.readQuarantineState).not.toHaveBeenCalled();
    expect(args.readSiblingState).not.toHaveBeenCalled();
  });
});

// Self-review of 0120bee9: a commit date is the writer's clock, and a force-reset back to an old commit
// looks old. Every input the queue run read from OUTSIDE the tree (ops/quarantine, the frontierui sibling
// checked out at its pinned main tip) must be unchanged since before the run, by GitHub's push time.
describe.each([
  // Built directly (no default parameters), so an undefined lastPush stays undefined.
  ['ops/quarantine', 'readQuarantineState',
    (lastPush) => ({ ok: true, list: { version: 1, entries: [], mode: 'stop' }, tip: quarantineTip, lastPush }), quarantineTip],
  ['frontierui', 'readSiblingState', (lastPush) => ({ ok: true, tip: fuiTip, lastPush }), fuiTip],
])('external input %s must be unchanged since before the matched run', (name, reader, state, tip) => {
  const matchTree = (value) => input({ getCommitTree: vi.fn().mockResolvedValue(pushTree),
    [reader]: vi.fn().mockResolvedValue(value) });
  const at = (ms) => new Date(Date.parse(RUN_CREATED) - ms).toISOString();

  it('skips when GitHub recorded its newest push well before the run', async () => {
    expect(await decideQueueTestedSkip(matchTree(state(push(tip))))).toMatchObject({ skip: true });
  });

  it.each([
    ['no recorded push', undefined, /push activity unreadable/],
    ['a non-object push record', 'push', /push activity unreadable/],
    ['a branch deletion', push(tip, { activity_type: 'branch_deletion' }), /branch was deleted/],
    ['a push to another tip (moved between reads)', push(otherSha), /moved since its last recorded push/],
    ['a push record without a tip', push(undefined), /moved since its last recorded push/],
    ['an unparseable push time', push(tip, { timestamp: 'yesterday-ish' }), /push time unreadable/],
    ['a missing push time', push(tip, { timestamp: undefined }), /push time unreadable/],
    ['a future push time', push(tip, { timestamp: '2026-10-31T13:00:00Z' }), /push time is in the future/],
    ['a push after the run started', push(tip, { timestamp: '2026-10-31T12:05:00Z' }), /changed near or after/],
    // An old commit pushed (or force-reset onto the branch) recently: only the push time counts.
    ['a force-push of an old commit after the run started', push(tip, { activity_type: 'force_push', timestamp: '2026-10-31T12:05:00Z' }), /changed near or after/],
  ])('fails closed on %s', async (_name, lastPush, reason) => {
    const result = await decideQueueTestedSkip(matchTree(state(lastPush)));
    expectClosed(result);
    expect(result.reason).toMatch(reason);
    expect(result.reason).toContain(name);
  });

  it('fails closed on an unreadable tip', async () => {
    const value = { ...state(push(tip)), tip: 'not-a-sha' };
    const result = await decideQueueTestedSkip(matchTree(value));
    expectClosed(result);
    expect(result.reason).toContain(`${name} tip unreadable`);
  });

  it.each([
    ['a read that throws', () => vi.fn().mockRejectedValue(new Error('api down'))],
    ['ok:false', () => vi.fn().mockResolvedValue({ ok: false, error: 'no token' })],
    ['a missing state', () => vi.fn().mockResolvedValue(undefined)],
  ])('fails closed on %s', async (_name, make) => {
    const result = await decideQueueTestedSkip(input({ getCommitTree: vi.fn().mockResolvedValue(pushTree), [reader]: make() }));
    expectClosed(result);
    expect(result.reason).toContain(name);
  });

  it('pins the settle margin to both sides of its boundary', async () => {
    expect(INPUT_SETTLE_MS).toBe(10 * 60 * 1000);
    expect(await decideQueueTestedSkip(matchTree(state(push(tip, { timestamp: at(INPUT_SETTLE_MS) })))))
      .toMatchObject({ skip: true });
    expectClosed(await decideQueueTestedSkip(matchTree(state(push(tip, { timestamp: at(INPUT_SETTLE_MS - 1000) })))));
  });

  it("judges the push against the MATCHED run's created_at, not the newest run's", async () => {
    const newest = run('e'.repeat(40), { created_at: '2026-10-31T12:20:00Z' });
    const matched = run(otherSha, { created_at: '2026-10-31T12:02:00Z' });
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([newest, matched]),
      getCommitTree: vi.fn(async (head) => head === otherSha ? pushTree : otherTree),
      // Old enough for the newest run, but inside the margin for the matched one.
      [reader]: vi.fn().mockResolvedValue(state(push(tip, { timestamp: '2026-10-31T11:58:00Z' }))) });
    const result = await decideQueueTestedSkip(args);
    expectClosed(result);
    expect(result.reason).toMatch(/changed near or after/);
  });

  it.each(['failure', 'cancelled', 'timed_out'])('keeps full CI when a newer %s run exists on the matched SHA', async (conclusion) => {
    const older = run(sha, { created_at: '2026-10-31T12:02:00Z' });
    const newer = run(sha, { conclusion, created_at: '2026-10-31T12:10:00Z' });
    const result = await decideQueueTestedSkip(input({ listMergeGroupRuns: vi.fn().mockResolvedValue([older, newer]) }));
    expectClosed(result);
    expect(result.reason).toMatch(/did not succeed/);
  });

  it('also guards an exact-head match', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]),
      [reader]: vi.fn().mockResolvedValue(state(push(tip, { timestamp: '2026-10-31T12:05:00Z' }))) });
    expectClosed(await decideQueueTestedSkip(args));
  });
});

describe('decideQueueTestedSkip (pure function, no CLI or main export required)', () => {
  it.each(['failure', 'cancelled', 'timed_out', null])('vetoes a newer equal-tree %j on a different SHA', async (conclusion) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha), run(otherSha, { conclusion, created_at: '2026-10-31T12:10:00Z' }),
    ]), getCommitTree: vi.fn().mockResolvedValue(pushTree.toUpperCase()) });
    const result = await decideQueueTestedSkip(args);
    expectClosed(result);
    expect(result.reason).toContain('did not succeed');
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it.each([undefined, 'invalid'])('orders a failed rerun by updated_at when run_started_at is %j', async (run_started_at) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha), run(sha, { conclusion: 'failure', created_at: '2026-10-30T12:00:00Z',
        run_attempt: 2, run_started_at, updated_at: '2026-10-31T12:10:00Z' }),
    ]) });
    const result = await decideQueueTestedSkip(args);
    expectClosed(result);
    expect(result.reason).toContain('did not succeed');
  });

  it('uses the newest successful attempt, even if its run was created before a failure', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha, { created_at: '2026-10-31T11:00:00Z', run_attempt: 2,
        run_started_at: '2026-10-31T12:20:00Z' }),
      run(otherSha, { created_at: '2026-10-31T12:15:00Z' }),
      run(sha, { conclusion: 'failure', created_at: '2026-10-31T12:10:00Z',
        updated_at: '2026-10-31T12:25:00Z' }),
    ]), getCommitTree: vi.fn().mockResolvedValue(pushTree) });
    expect(await decideQueueTestedSkip(args)).toMatchObject({ skip: true, matchedSha: sha });
  });

  it('allows a newer failure on a different tree', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha), run(otherSha, { conclusion: 'failure', created_at: '2026-10-31T12:10:00Z' }),
    ]) });
    expect(await decideQueueTestedSkip(args)).toMatchObject({ skip: true, matchedSha: sha });
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it.each(['throw', 'invalid'])('fails closed when a newer failed run tree is unreadable (%s)', async (mode) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha), run(otherSha, { conclusion: 'failure', created_at: '2026-10-31T12:10:00Z' }),
    ]), getCommitTree: mode === 'throw' ? vi.fn().mockRejectedValue(new Error('unavailable'))
      : vi.fn().mockResolvedValue('bad') });
    expectClosed(await decideQueueTestedSkip(args));
  });

  it('fails closed when a failure has no readable latest attempt time', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha), run(sha, { conclusion: 'failure', run_started_at: undefined, updated_at: 'bad' }),
    ]) });
    expectClosed(await decideQueueTestedSkip(args));
  });

  it('exports the decision function and fixes the lookup bound at 20', () => {
    expect(decideQueueTestedSkip).toBeTypeOf('function');
    expect(MAX_RUNS_CHECKED).toBe(20);
  });

  it.each([40, 64])('accepts full %i-character hex SHAs and short-circuits an exact successful head without tree IO', async (length) => {
    const head = 'a1'.repeat(length / 2);
    const args = input({ sha: head, pushTree: 'b2'.repeat(length / 2),
      listMergeGroupRuns: vi.fn().mockResolvedValue([run(head)]) });
    const result = await decideQueueTestedSkip(args);
    expect(result).toMatchObject({ skip: true, matchedSha: head, reason: expect.any(String) });
    expect(result.reason.trim()).not.toBe('');
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([40, 64])('skips for an equal tree on a different successful %i-character head', async (length) => {
    const head = 'c3'.repeat(length / 2);
    const tree = 'b2'.repeat(length / 2);
    const args = input({ sha: 'a1'.repeat(length / 2), pushTree: tree,
      listMergeGroupRuns: vi.fn().mockResolvedValue([run(head)]),
      getCommitTree: vi.fn().mockResolvedValue(tree) });
    expect(await decideQueueTestedSkip(args)).toMatchObject({ skip: true, matchedSha: head, reason: expect.any(String) });
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(head);
  });

  it.each(['pull_request', 'merge_group', 'schedule', 'workflow_dispatch'])('fails closed for event %s even with an exact successful head', async (event) => {
    const args = input({ event, listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.listMergeGroupRuns).not.toHaveBeenCalled();
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each(['refs/heads/feature', 'refs/tags/main', 'main', ''])('fails closed for non-main ref %j', async (ref) => {
    const args = input({ ref, listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.listMergeGroupRuns).not.toHaveBeenCalled();
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  describe.each(['sha', 'pushTree'])('validates %s before using queue evidence', (field) => {
    it.each([undefined, null, 123, '', 'abc123', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(40), ` ${sha}`, `${sha}\n`])('fails closed for malformed value %j', async (value) => {
      const args = input({ [field]: value, listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]) });
      expectClosed(await decideQueueTestedSkip(args));
      expect(args.listMergeGroupRuns).not.toHaveBeenCalled();
      expect(args.getCommitTree).not.toHaveBeenCalled();
    });
  });

  it('fails closed when listing merge-group runs throws', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockRejectedValue(new Error('unavailable')) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { workflow_runs: [] }, 'success'])('fails closed for a non-array run listing %j', async (listing) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue(listing) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it('fails closed for an empty listing', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each(['failure', 'cancelled', null])('ignores %j conclusions even when their head matches', async (conclusion) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha, { conclusion })]),
      getCommitTree: vi.fn().mockResolvedValue(pushTree) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'not-a-date'])('ignores a successful exact head with invalid created_at %j', async (created_at) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha, { created_at })]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'abc123', 'g'.repeat(40), 'a'.repeat(41)])('ignores invalid run head_sha %j even if a tree lookup would match', async (head) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(head, { head_sha: head })]),
      getCommitTree: vi.fn().mockResolvedValue(pushTree) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it('continues past ignored records to a valid successful match', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha, { conclusion: 'failure' }), run(sha, { created_at: 'invalid' }), run('invalid'), run(),
    ]), getCommitTree: vi.fn().mockResolvedValue(pushTree) });
    expect(await decideQueueTestedSkip(args)).toMatchObject({ skip: true, matchedSha: otherSha });
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it('fails closed on tree lookup failure without trying a later candidate that would match', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(otherSha, { created_at: '2026-10-31T13:00:00Z' }), run('e'.repeat(40)),
    ]), getCommitTree: vi.fn().mockRejectedValueOnce(new Error('unreadable tree')).mockResolvedValue(pushTree) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it('reports tree differs when all successful trees differ', async () => {
    const args = input();
    const result = await decideQueueTestedSkip(args);
    expectClosed(result);
    expect(result.reason).toMatch(/tree differs/i);
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it('gives distinct diagnostic reasons for distinct fail-closed paths', async () => {
    const cases = [
      { event: 'schedule' }, { ref: 'refs/heads/feature' }, { sha: 'bad' }, { pushTree: 'bad' },
      { listMergeGroupRuns: vi.fn().mockRejectedValue(new Error('listing failed')) },
      { listMergeGroupRuns: vi.fn().mockResolvedValue({}) },
      { listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha, { conclusion: 'failure' })]) },
      { getCommitTree: vi.fn().mockRejectedValue(new Error('tree failed')) }, {},
      { getCommitTree: vi.fn().mockResolvedValue(pushTree),
        readQuarantineState: vi.fn().mockResolvedValue(quarantine({ version: 1, mode: 'quarantine', entries: [entry()] })) },
      { getCommitTree: vi.fn().mockResolvedValue(pushTree),
        readQuarantineState: vi.fn().mockResolvedValue(quarantine(undefined, push(quarantineTip, { timestamp: '2026-10-31T12:05:00Z' }))) },
      { getCommitTree: vi.fn().mockResolvedValue(pushTree),
        readSiblingState: vi.fn().mockResolvedValue({ ok: true, tip: fuiTip, lastPush: push(fuiTip, { timestamp: '2026-10-31T12:05:00Z' }) }) },
    ];
    const reasons = [];
    for (const overrides of cases) {
      const result = await decideQueueTestedSkip(input(overrides));
      expectClosed(result);
      reasons.push(result.reason);
    }
    expect(new Set(reasons).size).toBe(cases.length);
  });

  it.each(['head', 'tree'])('does not use a %s match ranked 21st; newest-first lookup is capped at 20 and falls back to a full run', async (match) => {
    const newest = Array.from({ length: 20 }, (_, index) => run((index + 1).toString(16).padStart(40, '0'), {
      created_at: new Date(Date.UTC(2026, 9, 31, 12, 0, 20 - index)).toISOString(),
    }));
    const oldest = run(match === 'head' ? sha : 'e'.repeat(40), { created_at: '2026-10-30T12:00:00Z' });
    // Deliberately oldest-first: slicing the API response before sorting must fail this test.
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([oldest, ...newest.toReversed()]),
      getCommitTree: vi.fn(async (head) => head === oldest.head_sha ? pushTree : otherTree) });
    const result = await decideQueueTestedSkip(args);
    expectClosed(result);
    expect(result.reason).toMatch(/tree differs/i);
    expect(args.getCommitTree).toHaveBeenCalledTimes(20);
    expect(args.getCommitTree.mock.calls.map(([head]) => head)).toEqual(newest.map(({ head_sha }) => head_sha));
    expect(args.getCommitTree).not.toHaveBeenCalledWith(oldest.head_sha);
  });
});
