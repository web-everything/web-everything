// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ghThrottle from '../../lib/gh-throttle.mjs';
import { resetCascadeLogForTest, resolveCascade } from '../../lib/policy-cascade.mjs';
import {
  RUNNER_FALLBACK_POLICY, resolveRunnerFallbackSettings, decideRunnerFallback,
  evaluatePreflight, formatFeedLine, runRunnerFallback, main,
} from '../runner-fallback.mjs';

// A missed injection must fail locally, never spawn gh (including through gh-throttle).
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal();
  const forbidden = () => { throw new Error('Uninjected subprocess in runner-fallback test'); };
  return { ...original, exec: forbidden, execSync: forbidden, execFile: forbidden,
    execFileSync: forbidden, spawn: forbidden, spawnSync: forbidden, fork: forbidden };
});

const REPO = 'owner/public-repo';
const NOW_ISO = '2026-10-24T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);
const SETTINGS = Object.freeze({ queuedMinutes: 10, fallbackRunner: 'ubuntu-latest' });
const GROUP = Object.freeze({ name: 'larger-runners', allows_public_repositories: true });
const dirs = [];
let savedExitCode;

beforeEach(() => {
  resetCascadeLogForTest();
  savedExitCode = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-fallback-'));
  dirs.push(dir);
  return dir;
}
const ago = minutes => new Date(NOW - minutes * 60000).toISOString();
function job(overrides = {}) {
  return { runId: 101, jobId: 1001, name: 'test-shard (1)', status: 'queued',
    labels: ['we-8core'], createdAt: ago(11), startedAt: null, runnerName: null, ...overrides };
}
function decide(jobs, overrides = {}) {
  return decideRunnerFallback({ jobs, runnerVar: 'we-8core', settings: SETTINGS, now: NOW, ...overrides });
}
function preflight(overrides = {}) {
  return evaluatePreflight({ runnerVar: 'we-8core', repoVisibility: 'public',
    runnerGroup: GROUP, settings: SETTINGS, ...overrides });
}
const planned = (runIds = [101], value = 'ubuntu-latest') => ({
  setVariable: { name: 'WE_SHARD_RUNNER', value }, cancel: runIds, rerun: runIds,
});

// Same suffix boundary as operations/needs-you-feed.mjs#parseFeedLine: braces in
// the human reason must not be mistaken for the event JSON, whose first key is at.
function parseEvent(line) {
  expect(line).toMatch(/^NEEDS-YOU owner\/public-repo#\d+ [\w-]+: .+/);
  const start = line.lastIndexOf(' {"at":');
  expect(start).toBeGreaterThan(0);
  const event = JSON.parse(line.slice(start + 1));
  expect(event).toMatchObject({ at: NOW_ISO, repo: REPO });
  return event;
}
function feedLines(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean) : [];
}
function snapshot(dir) {
  return readdirSync(dir, { recursive: true }).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]);
}

// IO fixtures inject the var reader and preflight evidence. Only job discovery
// uses gh reads. Mutations use the repo's exec(cmd, argv, options) convention.
function harness({ jobs = [job()], runnerVar = 'we-8core', runnerGroup = GROUP,
  repoVisibility = 'public', failVariableSet = false, cancelStatuses = ['completed'], failCancelRunIds = [] } = {}) {
  const dir = temp();
  const feedPath = join(dir, 'events.jsonl');
  const mutations = [];
  const pollCounts = new Map();
  const completed = new Set();
  const sleep = vi.fn(async () => {});
  const exec = vi.fn((cmd, args, options = {}) => {
    expect(cmd).toBe('gh');
    expect(Array.isArray(args)).toBe(true);
    expect(args.every(arg => typeof arg === 'string')).toBe(true);
    expect(options.shell).not.toBe(true);
    if (args[0] === 'variable' && args[1] === 'set') {
      mutations.push([...args]);
      if (failVariableSet) throw new Error('variable-set denied by fixture');
      return '';
    }
    if (args[0] === 'run' && ['cancel', 'rerun'].includes(args[1])) {
      if (args[1] === 'rerun' && !completed.has(Number(args[2]))) {
        throw new Error('Fixture rejects rerun before cancellation completed');
      }
      mutations.push([...args]);
      if (args[1] === 'cancel' && failCancelRunIds.includes(Number(args[2]))) {
        throw new Error('Fixture rejects cancellation');
      }
      return '';
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const workflow_runs = args[args.indexOf('--status') + 1] === 'queued'
        ? [...new Set(jobs.map(j => j.runId ?? j.run_id))].map(databaseId => ({ databaseId, status: 'queued' })) : [];
      return JSON.stringify({ total_count: workflow_runs.length, workflow_runs });
    }
    if (args[0] === 'api') {
      const statusRun = /\/actions\/runs\/(\d+)$/.exec(args[1]);
      if (statusRun) {
        const id = Number(statusRun[1]);
        const count = pollCounts.get(id) ?? 0;
        pollCounts.set(id, count + 1);
        const status = cancelStatuses[Math.min(count, cancelStatuses.length - 1)];
        if (status === 'completed') completed.add(id);
        return JSON.stringify({ status });
      }
      const endpoint = args.find(arg => /\/actions\/runs\/\d+\/jobs(?:\?|$)/.test(arg));
      if (endpoint) {
        const runId = Number(/\/runs\/(\d+)\/jobs/.exec(endpoint)[1]);
        const rows = jobs.filter(j => (j.runId ?? j.run_id) === runId).map(j => ({
          id: j.jobId, run_id: j.runId, name: j.name, status: j.status, labels: j.labels,
          created_at: j.createdAt, started_at: j.startedAt, runner_name: j.runnerName,
        }));
        return JSON.stringify({ total_count: rows.length, jobs: rows });
      }
    }
    throw new Error(`Unexpected gh argv: ${JSON.stringify(args)}`);
  });
  const log = vi.fn();
  const options = { repo: REPO, exec, sleep, now: NOW, feedPath, settings: SETTINGS,
    readRunnerVar: vi.fn(() => runnerVar), repoVisibility, runnerGroup, log,
    env: {}, platform: null };
  return { dir, feedPath, exec, sleep, mutations, pollCounts, log, options };
}

describe('runner fallback policy cascade', () => {
  it('exports the standard defaults and resolves them with standard provenance', () => {
    expect(RUNNER_FALLBACK_POLICY).toEqual(SETTINGS);
    expect(resolveRunnerFallbackSettings({ env: {}, platform: null, log: vi.fn() }))
      .toMatchObject({ ...SETTINGS, sources: { queuedMinutes: 'standard', fallbackRunner: 'standard' } });
  });

  it('honours platform preferences independently for each leaf', () => {
    expect(resolveRunnerFallbackSettings({ env: {}, platform: { queuedMinutes: 7 }, log: vi.fn() }))
      .toMatchObject({ queuedMinutes: 7, fallbackRunner: 'ubuntu-latest',
        sources: { queuedMinutes: 'platform', fallbackRunner: 'standard' } });
  });

  it('resolves the tool layer above platform and below environment', () => {
    // `tool` is the injected settings block; no host settings file is read.
    const platform = { queuedMinutes: 7, fallbackRunner: 'ubuntu-22.04' };
    const tool = { queuedMinutes: 6, fallbackRunner: 'ubuntu-24.04' };
    const env = { WE_RUNNER_FALLBACK_RUNNER: 'ubuntu-26.04' };
    const expected = resolveCascade({ standard: SETTINGS, platform, tool,
      envValues: { fallbackRunner: 'ubuntu-26.04' } });
    expect(resolveRunnerFallbackSettings({ env, platform, tool, log: vi.fn() }))
      .toMatchObject({ ...expected.value, sources: expected.sources });
  });

  it('honours both named environment overrides above platform preferences', () => {
    const result = resolveRunnerFallbackSettings({
      env: { WE_RUNNER_FALLBACK_QUEUED_MINUTES: '3', WE_RUNNER_FALLBACK_RUNNER: 'ubuntu-24.04' },
      platform: { queuedMinutes: 8, fallbackRunner: 'ubuntu-22.04' }, log: vi.fn(),
    });
    expect(result).toMatchObject({ queuedMinutes: 3, fallbackRunner: 'ubuntu-24.04',
      sources: { queuedMinutes: 'env', fallbackRunner: 'env' } });
  });

  it.each(['0', '-1', '1.5', 'garbage', '3minutes', 'Infinity'])
  ('reports invalid env queuedMinutes=%s and retains the valid lower platform layer', value => {
    const log = vi.fn();
    const result = resolveRunnerFallbackSettings({
      env: { WE_POLICY_CASCADE_LOG: '1', WE_RUNNER_FALLBACK_QUEUED_MINUTES: value },
      platform: { queuedMinutes: 7 }, log,
    });
    expect(result).toMatchObject({ queuedMinutes: 7, sources: { queuedMinutes: 'platform' } });
    expect(log.mock.calls.flat().join('\n')).toMatch(/invalid.*queuedMinutes|queuedMinutes.*invalid/i);
  });

  it.each([0, -2, 1.5])('reports invalid platform queuedMinutes=%s and retains the standard', queuedMinutes => {
    const log = vi.fn();
    const result = resolveRunnerFallbackSettings({ env: { WE_POLICY_CASCADE_LOG: '1' },
      platform: { queuedMinutes }, log });
    expect(result).toMatchObject({ queuedMinutes: 10, sources: { queuedMinutes: 'standard' } });
    expect(log.mock.calls.flat().join('\n')).toMatch(/invalid.*queuedMinutes|queuedMinutes.*invalid/i);
  });

  it.each(['', '   '])('reports an empty env runner %j and retains the platform runner', fallbackRunner => {
    const log = vi.fn();
    const result = resolveRunnerFallbackSettings({
      env: { WE_POLICY_CASCADE_LOG: '1', WE_RUNNER_FALLBACK_RUNNER: fallbackRunner },
      platform: { fallbackRunner: 'ubuntu-24.04' }, log,
    });
    expect(result).toMatchObject({ fallbackRunner: 'ubuntu-24.04', sources: { fallbackRunner: 'platform' } });
    expect(log.mock.calls.flat().join('\n')).toMatch(/invalid.*fallbackRunner|fallbackRunner.*invalid/i);
  });

  it.each(['we-8core', 'windows-latest', 'macos-latest', 'ubuntu-8core'])(
    'rejects paid or non-Linux fallbackRunner=%s in every override layer and reports it', fallbackRunner => {
      for (const layer of ['platform', 'tool', 'env']) {
        const log = vi.fn();
        const result = resolveRunnerFallbackSettings({
          env: { WE_POLICY_CASCADE_LOG: '1', ...(layer === 'env' ? { WE_RUNNER_FALLBACK_RUNNER: fallbackRunner } : {}) },
          platform: { fallbackRunner: 'ubuntu-22.04' },
          ...(layer === 'platform' ? { platform: { fallbackRunner } } : {}),
          ...(layer === 'tool' ? { tool: { fallbackRunner } } : {}), log,
        });
        expect(result).toMatchObject(layer === 'platform'
          ? { fallbackRunner: 'ubuntu-latest', sources: { fallbackRunner: 'standard' } }
          : { fallbackRunner: 'ubuntu-22.04', sources: { fallbackRunner: 'platform' } });
        expect(log.mock.calls.flat().join('\n')).toContain(`invalid: ${layer}.fallbackRunner="${fallbackRunner}"`);
      }
    });

  it('reports an empty platform runner and retains the standard runner', () => {
    const log = vi.fn();
    const result = resolveRunnerFallbackSettings({ env: { WE_POLICY_CASCADE_LOG: '1' },
      platform: { fallbackRunner: '' }, log });
    expect(result).toMatchObject({ fallbackRunner: 'ubuntu-latest', sources: { fallbackRunner: 'standard' } });
    expect(log.mock.calls.flat().join('\n')).toMatch(/invalid.*fallbackRunner|fallbackRunner.*invalid/i);
  });

  it('logs effective values and sources once for the same resolved settings', () => {
    const log = vi.fn();
    const options = { env: { WE_POLICY_CASCADE_LOG: '1' }, platform: { queuedMinutes: 4 }, log };
    resolveRunnerFallbackSettings(options);
    resolveRunnerFallbackSettings(options);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/queuedMinutes=4 \(platform\)/);
    expect(log.mock.calls[0][0]).toMatch(/fallbackRunner="ubuntu-latest" \(standard\)/);
  });

  it('resolves cancellation polling leaves through every policy layer and logs provenance', () => {
    const log = vi.fn();
    const result = resolveRunnerFallbackSettings({
      env: { WE_POLICY_CASCADE_LOG: '1', WE_RUNNER_FALLBACK_CANCEL_POLL_ATTEMPTS: '3' },
      platform: { cancelPollAttempts: 8, cancelPollIntervalMs: 50 },
      tool: { cancelPollAttempts: 5, cancelPollIntervalMs: 25 }, log,
    });
    expect(result).toMatchObject({ cancelPollAttempts: 3, cancelPollIntervalMs: 25,
      sources: { cancelPollAttempts: 'env', cancelPollIntervalMs: 'tool' } });
    expect(log.mock.calls.flat().join('\n')).toMatch(/cancelPollAttempts=3 \(env\)/);
    expect(log.mock.calls.flat().join('\n')).toMatch(/cancelPollIntervalMs=25 \(tool\)/);
    expect(resolveRunnerFallbackSettings({ env: {}, platform: null, log: vi.fn() }))
      .toMatchObject({ cancelPollAttempts: 6, cancelPollIntervalMs: 1000,
        sources: { cancelPollAttempts: 'standard', cancelPollIntervalMs: 'standard' } });
  });

  it.each(['0', '-1', '1.5', 'garbage', 'Infinity', '9007199254740992'])(
    'invalid cancellation polling bounds %s retain lower valid policy leaves', raw => {
      expect(resolveRunnerFallbackSettings({
        env: { WE_RUNNER_FALLBACK_CANCEL_POLL_ATTEMPTS: raw, WE_RUNNER_FALLBACK_CANCEL_POLL_INTERVAL_MS: raw },
        platform: { cancelPollAttempts: 4, cancelPollIntervalMs: 20 }, log: vi.fn(),
      })).toMatchObject({ cancelPollAttempts: 4, cancelPollIntervalMs: 20,
        sources: { cancelPollAttempts: 'platform', cancelPollIntervalMs: 'platform' } });
    });

  it('resolves the named maxAttemptsPerCall reservation leaf with provenance and rejects invalid overrides', () => {
    const log = vi.fn();
    expect(resolveRunnerFallbackSettings({ env: { WE_POLICY_CASCADE_LOG: '1',
      WE_RUNNER_FALLBACK_MAX_ATTEMPTS_PER_CALL: '3' },
    platform: { maxAttemptsPerCall: 8 }, tool: { maxAttemptsPerCall: 4 }, log }))
      .toMatchObject({ maxAttemptsPerCall: 3, sources: { maxAttemptsPerCall: 'env' } });
    expect(log.mock.calls.flat().join('\n')).toContain('maxAttemptsPerCall=3 (env)');
    expect(resolveRunnerFallbackSettings({ env: {}, platform: null, log: vi.fn() }))
      .toMatchObject({ maxAttemptsPerCall: 5, sources: { maxAttemptsPerCall: 'standard' } });
    for (const value of ['0', '-1', '1.5', 'invalid', '9007199254740992']) {
      expect(resolveRunnerFallbackSettings({ env: { WE_RUNNER_FALLBACK_MAX_ATTEMPTS_PER_CALL: value },
        platform: { maxAttemptsPerCall: 2 }, log: vi.fn() }))
        .toMatchObject({ maxAttemptsPerCall: 2, sources: { maxAttemptsPerCall: 'platform' } });
    }
  });

  it('resolves the completed lookback through every cascade layer and logs its provenance', () => {
    for (const [platform, tool, env, value, source] of [
      [null, undefined, {}, 120, 'standard'],
      [{ completedLookbackMinutes: 90 }, undefined, {}, 90, 'platform'],
      [{ completedLookbackMinutes: 90 }, { completedLookbackMinutes: 60 }, {}, 60, 'tool'],
      [{ completedLookbackMinutes: 90 }, { completedLookbackMinutes: 60 },
        { WE_RUNNER_FALLBACK_COMPLETED_LOOKBACK_MINUTES: '30' }, 30, 'env'],
    ]) {
      const log = vi.fn();
      expect(resolveRunnerFallbackSettings({ platform, tool, env: { ...env, WE_POLICY_CASCADE_LOG: '1' }, log }))
        .toMatchObject({ completedLookbackMinutes: value, sources: { completedLookbackMinutes: source } });
      expect(log.mock.calls.flat().join('\n')).toContain(`completedLookbackMinutes=${value} (${source})`);
    }
  });

  it.each(['0', '-1', '1.5', 'bad', 'Infinity'])(
    'rejects invalid completed lookback %s and retains the lower valid layer', raw => {
      const log = vi.fn();
      expect(resolveRunnerFallbackSettings({ platform: { completedLookbackMinutes: 90 },
        env: { WE_RUNNER_FALLBACK_COMPLETED_LOOKBACK_MINUTES: raw, WE_POLICY_CASCADE_LOG: '1' }, log }))
        .toMatchObject({ completedLookbackMinutes: 90, sources: { completedLookbackMinutes: 'platform' } });
      expect(log.mock.calls.flat().join('\n')).toMatch(/invalid.*completedLookbackMinutes/);
    });

  it('keeps the only literal threshold and default runner inside the policy defaults object', () => {
    const source = readFileSync(new URL('../runner-fallback.mjs', import.meta.url), 'utf8');
    expect(source.match(/\b10\b/g)).toHaveLength(1);
    expect(source.match(/(['"`])ubuntu-latest\1/g)).toHaveLength(1);
    const declaration = source.slice(source.indexOf('export const RUNNER_FALLBACK_POLICY'));
    const defaults = /\{[^{}]*\}/.exec(declaration)?.[0];
    expect(defaults).toMatch(/queuedMinutes\s*:\s*10\b/);
    expect(defaults).toMatch(/fallbackRunner\s*:\s*(['"`])ubuntu-latest\1/);
  });
});

describe('decideRunnerFallback (pure)', () => {
  it('takes no action when there are no jobs', () => {
    expect(decide([])).toMatchObject({ decision: 'no-action', stuck: [], runIds: [] });
  });

  it('falls back for an eleven-minute queued paid shard and identifies its evidence', () => {
    expect(decide([job()])).toMatchObject({ decision: 'fallback', reason: expect.any(String),
      stuck: [{ runId: 101, jobId: 1001, name: 'test-shard (1)', queuedMinutes: 11 }],
      setVariableTo: 'ubuntu-latest', runIds: [101] });
  });

  it('deduplicates and numerically sorts stuck run IDs', () => {
    expect(decide([job({ runId: 20 }), job({ runId: 3, jobId: 1002 }),
      job({ runId: 20, jobId: 1003 }), job({ runId: 11, jobId: 1004 })]).runIds).toEqual([3, 11, 20]);
  });

  it('does not fall back for a nine-minute queue', () => {
    expect(decide([job({ createdAt: ago(9) })]).decision).toBe('no-action');
  });

  it('recognizes an in-progress job on the same label as saturation', () => {
    const result = decide([job(), job({ jobId: 1002, status: 'in_progress', startedAt: ago(20) })]);
    expect(result.decision).toBe('no-action');
    expect(result.reason).toMatch(/saturat/i);
  });

  it('does not fall back when a job on the same label started within the window', () => {
    const result = decide([job(), job({ jobId: 1002, status: 'completed', startedAt: ago(2) })]);
    expect(result.decision).toBe('no-action');
  });

  it('allows fallback when the only completed job started before the window', () => {
    expect(decide([job(), job({ jobId: 1002, status: 'completed', startedAt: ago(20) })]).decision).toBe('fallback');
  });

  it('does not mistake work on another label for paid-runner saturation', () => {
    expect(decide([job(), job({ jobId: 1002, labels: ['other-runner'],
      status: 'in_progress', startedAt: ago(1) })]).decision).toBe('fallback');
  });

  it('never loops or flips back to paid when already using the fallback', () => {
    expect(decide([job({ labels: ['ubuntu-latest'] })], { runnerVar: 'ubuntu-latest' }).decision).toBe('no-action');
  });

  it.each(['', undefined, null])('takes no action with an empty or unset runner var %j', runnerVar => {
    expect(decide([job()], { runnerVar }).decision).toBe('no-action');
  });

  it('honours a custom three-minute threshold and custom fallback runner', () => {
    expect(decide([job({ createdAt: ago(4) })], {
      settings: { queuedMinutes: 3, fallbackRunner: 'ubuntu-24.04' },
    })).toMatchObject({ decision: 'fallback', setVariableTo: 'ubuntu-24.04', runIds: [101] });
  });

  it('honours the custom threshold on the no-action path', () => {
    expect(decide([job({ createdAt: ago(2) })], {
      settings: { queuedMinutes: 3, fallbackRunner: 'ubuntu-24.04' },
    }).decision).toBe('no-action');
  });

  it('does not loop when already using a custom fallback', () => {
    expect(decide([job({ labels: ['ubuntu-24.04'] })], { runnerVar: 'ubuntu-24.04',
      settings: { queuedMinutes: 3, fallbackRunner: 'ubuntu-24.04' } }).decision).toBe('no-action');
  });

  it('ignores long queues on other labels', () => {
    expect(decide([job({ labels: ['other-runner'], createdAt: ago(90) })]).decision).toBe('no-action');
  });

  it('ignores long queues for non-shard jobs', () => {
    expect(decide([job({ name: 'build', createdAt: ago(90) })]).decision).toBe('no-action');
  });

  it('accepts REST snake_case job IDs and timestamps', () => {
    expect(decide([{ run_id: 101, id: 1001, name: 'test-shard (1)', status: 'queued',
      labels: ['we-8core'], created_at: ago(11), started_at: null, runner_name: null }]))
      .toMatchObject({ decision: 'fallback', runIds: [101],
        stuck: [{ runId: 101, jobId: 1001, name: 'test-shard (1)', queuedMinutes: 11 }] });
  });

  it.each([undefined, null, '', 'not-a-date'])('fails closed without crashing on unreadable createdAt=%j', createdAt => {
    const result = decide([job({ createdAt })]);
    expect(result).toMatchObject({ decision: 'no-action', stuck: [], runIds: [] });
    expect(result.reason).toMatch(/unreadable/i);
  });

  it('fails closed on unreadable timestamps even beside valid stuck evidence', () => {
    const result = decide([job({ jobId: 1002, runId: 202, createdAt: 'garbage' }), job()]);
    expect(result).toMatchObject({ decision: 'no-action', runIds: [], stuck: [] });
    expect(result.reason).toMatch(/unreadable/i);
  });

  it.each([
    { labels: undefined }, { labels: null }, { labels: [] }, { labels: [null] },
    { status: undefined }, { status: 'unknown' }, { createdAt: undefined },
    { startedAt: undefined }, { startedAt: 'garbage' },
    { status: 'in_progress', labels: undefined, startedAt: ago(1) },
    { status: 'in_progress', startedAt: null },
    { status: 'in_progress', startedAt: 'garbage' },
    { labels: ['other-runner'], createdAt: 'garbage' },
  ])('fails closed on unreadable sibling evidence %j beside a valid stuck job', evidence => {
    for (const jobs of [[job(), job({ jobId: 1002, ...evidence })],
      [job({ jobId: 1002, ...evidence }), job()]]) {
      const result = decide(jobs);
      expect(result).toMatchObject({ decision: 'no-action', stuck: [], runIds: [] });
      expect(result.reason).toMatch(/unreadable/i);
    }
  });

  it('refuses paid fallback settings even when the pure decision bypasses the cascade', () => {
    expect(decide([job()], { settings: { ...SETTINGS, fallbackRunner: 'we-8core' } }).decision).toBe('no-action');
  });

  it('does not mutate the supplied jobs or settings', () => {
    const jobs = [Object.freeze({ ...job(), labels: Object.freeze(['we-8core']) })];
    Object.freeze(jobs);
    const before = JSON.stringify(jobs);
    decide(jobs);
    expect(JSON.stringify(jobs)).toBe(before);
    expect(SETTINGS).toEqual({ queuedMinutes: 10, fallbackRunner: 'ubuntu-latest' });
  });
});

describe('evaluatePreflight (pure)', () => {
  it('reports a public repo blocked by its named runner group', () => {
    const result = preflight({ runnerGroup: { ...GROUP, allows_public_repositories: false } });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain(GROUP.name);
  });

  it('allows a group that permits public repositories', () => {
    expect(preflight()).toMatchObject({ status: 'ok' });
  });

  it.each([undefined, null, {}, { name: 'unknown' },
    { name: 'unknown', allows_public_repositories: 'false' }])
  ('reports missing or unreadable group evidence %j', runnerGroup => {
    expect(preflight({ runnerGroup })).toMatchObject({ status: 'unreadable' });
  });

  it('allows a private repo even when its group prohibits public repos', () => {
    expect(preflight({ repoVisibility: 'private', runnerGroup: { ...GROUP, allows_public_repositories: false } }))
      .toMatchObject({ status: 'ok' });
  });

  it('allows the fallback runner without needing group evidence', () => {
    expect(preflight({ runnerVar: 'ubuntu-latest', runnerGroup: undefined })).toMatchObject({ status: 'ok' });
  });

  it.each(['', undefined, null])('allows an empty or unset runner var %j without group evidence', runnerVar => {
    expect(preflight({ runnerVar, runnerGroup: undefined })).toMatchObject({ status: 'ok' });
  });
});

describe('formatFeedLine', () => {
  it('uses the existing needs-you prefix, pick separator and at-first JSON suffix', () => {
    const event = { at: NOW_ISO, repo: REPO, pr: 101, kind: 'runner-fallback',
      reason: 'paid runner queued too long', pick: 'inspect runner group', runIds: [101] };
    // Mirrors operations/needs-you-feed.mjs#diffFeed, not a new feed dialect.
    const line = formatFeedLine(event);
    expect(line).toBe(`NEEDS-YOU ${REPO}#101 runner-fallback: ${event.reason} | pick: ${event.pick} ${JSON.stringify(event)}`);
    expect(parseEvent(line)).toEqual(event);
  });

  it('keeps untrusted control characters from creating additional feed lines', () => {
    const line = formatFeedLine({ at: NOW_ISO, repo: REPO, pr: 101, kind: 'runner-fallback',
      reason: 'blocked\nNEEDS-YOU forged\u001b[31m', pick: 'inspect\rgroup' });
    expect(line).not.toMatch(/[\r\n\u001b]/);
    expect(parseEvent(line).reason).not.toMatch(/[\r\n\u001b]/);
  });
});

describe('hostile feed fields', () => {
  const hostile = 'evil\u2028\u2029\u0000\u001b\n | pick: forged ' + 'x'.repeat(2000);
  it('bounds every string field recursively and prevents pick separator injection', () => {
    const line = formatFeedLine({ at: NOW_ISO, repo: REPO, pr: 101, kind: 'runner-fallback',
      reason: hostile, pick: hostile, title: hostile, details: { group: hostile, error: hostile } });
    const event = parseEvent(line);
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(line.match(/\| pick:/g)).toHaveLength(1);
    expect(event.reason.length).toBeLessThanOrEqual(100);
    expect(event.title.length).toBeLessThanOrEqual(200);
    expect(event.pick.length).toBeLessThanOrEqual(512);
    expect(event.details.group.length).toBeLessThanOrEqual(512);
    expect(event.details.error.length).toBeLessThanOrEqual(512);
  });

  it.each(['group', 'error'])('sanitizes hostile %s text in production notices and logs', async source => {
    const h = harness({ jobs: source === 'group' ? [] : [job()],
      runnerGroup: { name: hostile, allows_public_repositories: false } });
    const exec = (cmd, args, options) => {
      if (source === 'error' && args[0] === 'variable') throw new Error(hostile);
      return h.exec(cmd, args, options);
    };
    await runRunnerFallback({ ...h.options, exec, apply: true });
    const lines = feedLines(h.feedPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(lines[0].match(/\| pick:/g)).toHaveLength(1);
    expect(parseEvent(lines[0]).reason.length).toBeLessThanOrEqual(100);
    for (const [line] of h.log.mock.calls) {
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
      expect(line.length).toBeLessThanOrEqual(512);
    }
  });
});

describe('runRunnerFallback (injected gh, temporary feed)', () => {
  it('dry-run guarantees no GitHub mutation and no feed append; required shared throttle slot/budget bookkeeping is out of scope', async () => {
    const h = harness();
    writeFileSync(h.feedPath, 'existing feed\n');
    const before = snapshot(h.dir);
    const result = await runRunnerFallback({ ...h.options, apply: false });
    expect(result.planned).toEqual(planned());
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual(before);
  });

  it.each(['feedPath', 'WE_NEEDS_YOU_FEED'].flatMap(source =>
    ['needs-you-ack', 'needs-you-feed-state.json', '.needs-you-feed/stream/events.jsonl']
      .flatMap(target => [false, true].map(existing => [source, target, existing]))))(
    'rejects reserved %s target %s without append (existing=%s) and reports it', async (source, target, existing) => {
      const h = harness();
      const path = join(h.dir, target);
      if (existing) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'metadata sentinel\n');
      }
      const options = { ...h.options, apply: true };
      if (source === 'feedPath') options.feedPath = path;
      else { delete options.feedPath; options.env = { WE_NEEDS_YOU_FEED: path }; }
      const result = await runRunnerFallback(options);
      expect(result).toMatchObject({ decision: 'no-action', applied: false,
        planned: { setVariable: null, cancel: [], rerun: [] } });
      expect(result.error).toMatch(/feed path is reserved.*inspect CI/i);
      expect(h.log.mock.calls.flat().join('\n')).toMatch(/feed path is reserved/);
      expect(h.exec).not.toHaveBeenCalled();
      expect(h.mutations).toEqual([]);
      expect(existsSync(path)).toBe(existing);
      if (existing) expect(readFileSync(path, 'utf8')).toBe('metadata sentinel\n');
      expect(existsSync(h.feedPath)).toBe(false);
    });

  it.each([120, 60])('150 old completed runs outside the %s minute activity window do not abort fallback', async lookback => {
    const h = harness();
    const oldRuns = Array.from({ length: 150 }, (_, i) => ({ id: 200 + i, created_at: ago(1440), updated_at: ago(lookback + 1) }));
    const exec = vi.fn((cmd, args, options) => {
      if (args[0] === 'run' && args[1] === 'list' && args.includes('completed')) {
        expect(args).not.toContain('--created');
        return JSON.stringify({ total_count: oldRuns.length, workflow_runs: oldRuns.slice(0, 40) });
      }
      return h.exec(cmd, args, options);
    });
    const result = await runRunnerFallback({ ...h.options, exec, apply: true,
      settings: { ...SETTINGS, completedLookbackMinutes: lookback } });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ decision: 'fallback', applied: true, rerunResults: [{ runId: 101, rerun: true }] });
    expect(h.mutations.map(args => args[1])).toEqual(['set', 'cancel', 'rerun']);
    expect(feedLines(h.feedPath)).toHaveLength(1);
    expect(exec.mock.calls.filter(([, args]) => args[1]?.includes('/jobs?'))).toHaveLength(1);
  });

  it.each([40, 41])('full completed page with oldest activity in-window fails closed with operator escalation (total=%s)', async total_count => {
    const h = harness();
    const exec = vi.fn((cmd, args, options) => {
      if (args[0] === 'run' && args[1] === 'list' && args.includes('completed')) {
        expect(args).not.toContain('--created');
        return JSON.stringify({ total_count, workflow_runs: Array.from({ length: 40 }, (_, i) =>
          ({ id: 200 + i, created_at: ago(1440), updated_at: ago(1) })) });
      }
      return h.exec(cmd, args, options);
    });
    const result = await runRunnerFallback({ ...h.options, exec, apply: true });
    expect(result).toMatchObject({ decision: 'no-action', applied: false,
      planned: { setVariable: null, cancel: [], rerun: [] } });
    expect(result.error).toMatch(/Run read bound.*inspect CI manually or raise maxRuns/);
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it.each([
    { updated_at: undefined },
    { updated_at: 'unreadable' },
    { updated_at: ago(-1) },
    { updated_at: ago(1), run_started_at: 'unreadable' },
  ])('unreadable completed activity fails closed with no writes: %j', async activity => {
    const h = harness();
    const exec = vi.fn((cmd, args, options) => {
      if (args[0] === 'run' && args.includes('completed')) {
        return JSON.stringify({ total_count: 1, workflow_runs: [{ id: 202, ...activity }] });
      }
      return h.exec(cmd, args, options);
    });
    const result = await runRunnerFallback({ ...h.options, exec, apply: true });
    expect(result).toMatchObject({ decision: 'no-action', applied: false });
    expect(result.error).toMatch(/incomplete.*Unreadable completed run activity.*inspect CI/i);
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it('production REST translation reads the latest completed page without a creation filter', async () => {
    const h = harness({ jobs: [] });
    const gh = vi.spyOn(ghThrottle, 'execFileSyncThrottled').mockImplementation((cmd, args, options) => {
      expect(cmd).toBe('gh');
      expect(options.throttle.exec).toEqual(expect.any(Function));
      return JSON.stringify({ total_count: 0, workflow_runs: [] });
    });
    const options = { ...h.options };
    delete options.exec;
    const result = await runRunnerFallback(options);
    expect(result.error).toBeUndefined();
    expect(gh.mock.calls.map(([, args]) => args)).toEqual([
      ['api', `repos/${REPO}/actions/workflows/ci.yml/runs?status=queued&per_page=40`],
      ['api', `repos/${REPO}/actions/workflows/ci.yml/runs?status=in_progress&per_page=40`],
      ['api', `repos/${REPO}/actions/workflows/ci.yml/runs?status=completed&per_page=40`],
    ]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it.each([true, false])('repository visibility lookup failure is report-only and discovery continues (stuck=%s)', async stuck => {
    const h = harness({ jobs: stuck ? [job()] : [] });
    const exec = vi.fn((cmd, args, options) => {
      if (args[0] === 'api' && args[1] === `repos/${REPO}`) throw new Error('Visibility lookup denied');
      return h.exec(cmd, args, options);
    });
    const options = { ...h.options, exec, apply: true };
    delete options.repoVisibility;
    const result = await runRunnerFallback(options);
    expect(result.error).toBeUndefined();
    expect(result.preflight).toMatchObject({ status: 'unreadable',
      reason: expect.stringMatching(/repository visibility.*Visibility lookup denied.*inspect runner configuration/) });
    expect(result.decision).toBe(stuck ? 'fallback' : 'no-action');
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === 'list')).toHaveLength(3);
    expect(h.mutations.map(args => args[1])).toEqual(stuck ? ['set', 'cancel', 'rerun'] : []);
    expect(feedLines(h.feedPath)).toHaveLength(1);
    const event = parseEvent(feedLines(h.feedPath)[0]);
    if (stuck) expect(event.preflight).toEqual(result.preflight);
    else expect(event.kind).toBe('runner-preflight');
  });

  it.each([
    [3, { updated_at: ago(1) }],
    [30, { updated_at: ago(1) }],
    [1440, { updated_at: ago(1) }],
    [1440, { updated_at: ago(1440), run_started_at: ago(2) }],
    [1440, { run_started_at: ago(2) }],
  ])('discovers a completed ci.yml run created %s minutes ago by its recent paid job activity (%j)', async (createdMinutes, activity) => {
    const h = harness();
    const exec = vi.fn((cmd, args, options) => {
      if (args[0] === 'run' && args[1] === 'list' && args.includes('completed')) {
        expect(args).toEqual(['run', 'list', '--repo', REPO, '--workflow', 'ci.yml',
          '--status', 'completed', '--limit', '40', '--json', 'databaseId,status,updatedAt,startedAt']);
        return JSON.stringify({ total_count: 1, workflow_runs: [{ id: 202, status: 'completed', created_at: ago(createdMinutes), ...activity }] });
      }
      if (args[0] === 'api' && args[1].includes('/runs/202/jobs')) {
        return JSON.stringify({ total_count: 1, jobs: [job({ runId: 202, jobId: 2001,
          status: 'completed', createdAt: ago(createdMinutes), startedAt: ago(2) })] });
      }
      return h.exec(cmd, args, options);
    });
    const result = await runRunnerFallback({ ...h.options, exec, apply: true });
    expect(result).toMatchObject({ decision: 'no-action', planned: { setVariable: null, cancel: [], rerun: [] } });
    expect(result.reason).toMatch(/recent start/i);
    expect(exec.mock.calls.some(([, args]) => args[1]?.includes('/runs/202/jobs'))).toBe(true);
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it.each(['ubuntu-latest', 'ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-24.04-arm'])(
    'standard hosted label %s skips org runner-group preflight and continues discovery', async runnerVar => {
      const h = harness({ runnerVar, jobs: [] });
      const options = { ...h.options };
      delete options.repoVisibility;
      delete options.runnerGroup;
      const result = await runRunnerFallback(options);
      expect(result).toMatchObject({ decision: 'no-action', preflight: {
        status: 'ok', reason: expect.stringMatching(/standard hosted label/i) } });
      expect(result.error).toBeUndefined();
      expect(h.exec.mock.calls.map(([, args]) => args[0])).toEqual(['run', 'run', 'run']);
      expect(h.mutations).toEqual([]);
    });

  // Each row passes one runner list; Vitest otherwise spreads the list into arguments.
  it.each([[], [{ name: 'we-8core' }]].map(runners => [runners]))(
    'unresolved non-standard runner label reports unreadable preflight and continues stuck-job discovery (%j)', async runners => {
      const h = harness();
      const exec = vi.fn((cmd, args, options) => args[1]?.includes('/hosted-runners')
        ? JSON.stringify({ total_count: runners.length, runners }) : h.exec(cmd, args, options));
      const options = { ...h.options, exec, apply: true };
      delete options.runnerGroup;
      const result = await runRunnerFallback(options);
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ decision: 'fallback', applied: true, preflight: { status: 'unreadable' },
        rerunResults: [{ runId: 101, rerun: true }] });
      expect(result.preflight.reason).toMatch(/Runner group unresolved/);
      expect(h.mutations.map(args => args[1])).toEqual(['set', 'cancel', 'rerun']);
      expect(feedLines(h.feedPath)).toHaveLength(1);
      expect(parseEvent(feedLines(h.feedPath)[0]).preflight.status).toBe('unreadable');
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === 'list')).toHaveLength(3);
      expect(exec.mock.calls.some(([, args]) => args[1]?.includes('/runner-groups'))).toBe(false);
    });

  it.each([[], [{ name: 'we-8core' }]].map(runners => [runners]))(
    'unresolved non-standard runner label without stuck jobs reports unreadable preflight without fallback (%j)', async runners => {
      const h = harness({ jobs: [] });
      const exec = vi.fn((cmd, args, options) => args[1]?.includes('/hosted-runners')
        ? JSON.stringify({ total_count: runners.length, runners }) : h.exec(cmd, args, options));
      const options = { ...h.options, exec, apply: true };
      delete options.runnerGroup;
      const result = await runRunnerFallback(options);
      expect(result).toMatchObject({ decision: 'no-action', preflight: { status: 'unreadable' },
        planned: { setVariable: null, cancel: [], rerun: [] } });
      expect(result.error).toBeUndefined();
      expect(result.preflight.reason).toMatch(/Runner group unresolved/);
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === 'list')).toHaveLength(3);
      expect(h.mutations).toEqual([]);
      const lines = feedLines(h.feedPath);
      expect(lines).toHaveLength(1);
      expect(parseEvent(lines[0]).kind).toBe('runner-preflight');
    });

  it.each(['hosted-runners', 'runner-groups'].flatMap(read => [true, false].map(stuck => [read, stuck])))(
    'throwing %s resolution reports unreadable preflight and continues discovery (stuck=%s)', async (read, stuck) => {
      const h = harness({ jobs: stuck ? [job()] : [] });
      const exec = vi.fn((cmd, args, options) => {
        if (args[0] === 'api' && args[1].includes(`/${read}?`)) throw new Error('Runner lookup denied');
        if (args[0] === 'api' && args[1].includes('/hosted-runners?')) {
          return JSON.stringify({ total_count: 1, runners: [{ name: 'we-8core', runner_group_id: 7 }] });
        }
        return h.exec(cmd, args, options);
      });
      const options = { ...h.options, exec, apply: true };
      delete options.runnerGroup;
      const result = await runRunnerFallback(options);
      expect(result.error).toBeUndefined();
      expect(result.preflight).toMatchObject({ status: 'unreadable',
        reason: expect.stringMatching(/Runner lookup denied.*inspect runner configuration/) });
      expect(result.decision).toBe(stuck ? 'fallback' : 'no-action');
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === 'list')).toHaveLength(3);
      expect(h.mutations.map(args => args[1])).toEqual(stuck ? ['set', 'cancel', 'rerun'] : []);
      expect(feedLines(h.feedPath)).toHaveLength(1);
      const event = parseEvent(feedLines(h.feedPath)[0]);
      if (stuck) expect(event.preflight).toEqual(result.preflight);
      else expect(event.kind).toBe('runner-preflight');
    });

  it.each([
    ['blocked', { ...GROUP, allows_public_repositories: false }],
    ['unreadable', null],
  ])('preflight is REPORT only: stuck jobs still fall back with %s preflight, both reported in one feed line', async (status, runnerGroup) => {
    const h = harness({ runnerGroup });
    const result = await runRunnerFallback({ ...h.options, apply: true });
    expect(result).toMatchObject({ decision: 'fallback', applied: true, preflight: { status },
      rerunResults: [{ runId: 101, rerun: true }] });
    expect(h.mutations.map(args => args[1])).toEqual(['set', 'cancel', 'rerun']);
    const lines = feedLines(h.feedPath);
    expect(lines).toHaveLength(1);
    const event = parseEvent(lines[0]);
    expect(event.kind).toBe('runner-fallback');
    expect(event.reason).toMatch(/Paid shards queued/);
    expect(event.preflight).toEqual(result.preflight);
    expect(event.preflight.reason).toMatch(status === 'blocked' ? /prohibits public/ : /unreadable/i);
  });

  it.each([15, 16])('reserves all throttle retries before cancel so reruns cannot starve (maxCalls=%s)', async maxCalls => {
    const h = harness({ cancelStatuses: ['queued', 'completed'] });
    let attempts = 0;
    const exec = vi.fn((cmd, args, options) => {
      // The executor retries a real injected failure on each repair call;
      // discovery succeeds immediately. Only the successful attempt reaches gh.
      const repair = !(args[0] === 'run' && args[1] === 'list') && !args[1]?.includes('/jobs?');
      expect(options.maxAttemptsPerCall).toBe(2);
      for (let attempt = 0; attempt < options.maxAttemptsPerCall; attempt++) {
        if (attempt > 0) options.charge(); // first attempt is already charged
        attempts++;
        try {
          if (repair && attempt === 0) throw new Error('Injected rate limit');
          return h.exec(cmd, args, options);
        } catch (error) {
          if (error.message !== 'Injected rate limit' || attempt + 1 === options.maxAttemptsPerCall) throw error;
        }
      }
      throw new Error('Unreachable retry exhaustion');
    });
    const result = await runRunnerFallback({ ...h.options, exec, apply: true,
      settings: { ...SETTINGS, maxCalls, maxAttemptsPerCall: 2, cancelPollAttempts: 3 } });
    if (maxCalls === 15) {
      expect(result).toMatchObject({ decision: 'no-action', applied: false });
      expect(result.error).toMatch(/Repair exceeds call bound.*inspect CI/i);
      expect(h.mutations).toEqual([]);
      expect(attempts).toBe(4);
    } else {
      expect(result).toMatchObject({ applied: true, rerunResults: [{ runId: 101, rerun: true }] });
      expect(h.mutations.map(args => args[1])).toEqual(['set', 'cancel', 'rerun']);
      expect(h.pollCounts.get(101)).toBe(2);
      expect(attempts).toBe(14);
    }
  });

  it('caps excessive retry attempts per call so a rejected cancel cannot spend the reserved rerun budget', async () => {
    const h = harness();
    let cancelAttempts = 0;
    const exec = vi.fn((cmd, args, options) => {
      if (args[0] === 'run' && args[1] === 'cancel') {
        cancelAttempts++;
        options.charge();
        cancelAttempts++;
        options.charge(); // third attempt is refused before any GitHub execution
        throw new Error('Unreachable third cancellation attempt');
      }
      return h.exec(cmd, args, options);
    });
    const result = await runRunnerFallback({ ...h.options, exec, apply: true,
      settings: { ...SETTINGS, maxCalls: 12, maxAttemptsPerCall: 2, cancelPollAttempts: 1 } });
    expect(cancelAttempts).toBe(2);
    expect(result).toMatchObject({ applied: true,
      rerunResults: [{ runId: 101, cancelFailed: true, rerun: true }] });
    expect(result.error).toBeUndefined();
    expect(h.mutations.map(args => args[1])).toEqual(['set', 'rerun']);
    expect(h.pollCounts.get(101)).toBe(1);
    expect(feedLines(h.feedPath)).toHaveLength(1);
  });

  it.each(['runs', 'jobs', 'hosted-runners', 'runner-groups'].flatMap(read =>
    [undefined, null, '1', 1.5, -1, 0, 2].map(total_count => [read, total_count])))(
    'incomplete %s total_count=%j refuses every mutation and feed append', async (read, total_count) => {
      const h = harness();
      const exec = vi.fn((cmd, args, options) => {
        if (args[0] === 'api' && args[1].includes('/hosted-runners')) {
          return JSON.stringify({ total_count: read === 'hosted-runners' ? total_count : 1,
            runners: [{ name: 'we-8core', runner_group_id: 7 }] });
        }
        if (args[0] === 'api' && args[1].includes('/runner-groups')) {
          return JSON.stringify({ total_count: read === 'runner-groups' ? total_count : 1,
            runner_groups: [{ id: 7, ...GROUP }] });
        }
        const response = JSON.parse(h.exec(cmd, args, options));
        if ((read === 'runs' && args[0] === 'run')
          || (read === 'jobs' && args[1]?.includes('/jobs?'))) response.total_count = total_count;
        return JSON.stringify(response);
      });
      const options = { ...h.options, exec, apply: true };
      if (['hosted-runners', 'runner-groups'].includes(read)) delete options.runnerGroup;
      const result = await runRunnerFallback(options);
      expect(result).toMatchObject({ decision: 'no-action', applied: false,
        planned: { setVariable: null, cancel: [], rerun: [] } });
      expect(result.error).toMatch(/incomplete/i);
      expect(result.error).toMatch(/inspect CI/i);
      expect(h.mutations).toEqual([]);
      expect(snapshot(h.dir)).toEqual([]);
    });

  it.each([
    ['maxRuns', { maxRuns: 1 }, [job()]],
    ['maxJobs', { maxJobs: 1 }, [job(), job({ jobId: 1002 })]],
  ])('oversized discovery at %s refuses mutation and directs the operator to inspect CI', async (_leaf, bounds, jobs) => {
    const h = harness({ jobs });
    const result = await runRunnerFallback({ ...h.options, apply: true, settings: { ...SETTINGS, ...bounds } });
    expect(result).toMatchObject({ decision: 'no-action', applied: false });
    expect(result.error).toMatch(/bound.*inspect CI/i);
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it('unreadable running sibling next to a valid stuck job authorizes no mutation or feed append', async () => {
    const h = harness({ jobs: [job(), job({ runId: 202, jobId: 2001, status: 'in_progress', labels: undefined })] });
    const result = await runRunnerFallback({ ...h.options, apply: true });
    expect(result).toMatchObject({ decision: 'no-action', reason: expect.stringMatching(/unreadable/i) });
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it('default invocation without --apply makes zero PATCH, cancel, rerun or feed writes', async () => {
    const h = harness();
    writeFileSync(h.feedPath, 'existing feed\n');
    const before = snapshot(h.dir);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main([`--repo=${REPO}`, '--json'], h.options)).toBe(0);
    expect(JSON.parse(stdout.mock.calls.map(([s]) => s).join('')).planned).toEqual(planned());
    expect(h.mutations).toEqual([]);
    expect(h.exec.mock.calls.some(([, args]) => args.includes('PATCH'))).toBe(false);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(snapshot(h.dir)).toEqual(before);
  });

  it('delayed cancellation polls through injected exec and sleep before rerun is accepted', async () => {
    const h = harness({ cancelStatuses: ['queued', 'in_progress', 'completed'] });
    const result = await runRunnerFallback({ ...h.options, apply: true,
      settings: { ...SETTINGS, cancelPollAttempts: 4, cancelPollIntervalMs: 7 } });
    expect(result).toMatchObject({ applied: true, rerunResults: [{ runId: 101, rerun: true }] });
    expect(h.pollCounts.get(101)).toBe(3);
    expect(h.sleep.mock.calls).toEqual([[7], [7]]);
    expect(h.mutations.map(args => args.slice(0, 3))).toEqual([
      ['variable', 'set', 'WE_SHARD_RUNNER'], ['run', 'cancel', '101'], ['run', 'rerun', '101'],
    ]);
    expect(feedLines(h.feedPath)).toHaveLength(1);
  });

  it('never-completes cancellation stops at the bound and reports cancel-not-completed in one feed line', async () => {
    const h = harness({ cancelStatuses: ['in_progress'] });
    const result = await runRunnerFallback({ ...h.options, apply: true,
      settings: { ...SETTINGS, cancelPollAttempts: 3, cancelPollIntervalMs: 7 } });
    const rerunResults = [{ runId: 101, rerunSkipped: 'cancel-not-completed' }];
    expect(result).toMatchObject({ applied: true, rerunResults });
    expect(h.pollCounts.get(101)).toBe(3);
    expect(h.sleep.mock.calls).toEqual([[7], [7]]);
    expect(h.mutations.map(args => args.slice(0, 3))).toEqual([
      ['variable', 'set', 'WE_SHARD_RUNNER'], ['run', 'cancel', '101'],
    ]);
    expect(feedLines(h.feedPath)).toHaveLength(1);
    const event = parseEvent(feedLines(h.feedPath)[0]);
    expect(event.rerunResults).toEqual(rerunResults);
    expect(event.reason).toMatch(/cancel-not-completed.*inspect CI/i);
  });

  it('a timed-out cancellation skips only that run and still reruns a completed sibling', async () => {
    const h = harness({ jobs: [job(), job({ runId: 202, jobId: 2001 })] });
    const exec = vi.fn((cmd, args, options) => args[0] === 'api'
      && args[1] === `repos/${REPO}/actions/runs/101`
      ? JSON.stringify({ status: 'in_progress' }) : h.exec(cmd, args, options));
    const result = await runRunnerFallback({ ...h.options, exec, apply: true,
      settings: { ...SETTINGS, cancelPollAttempts: 2, cancelPollIntervalMs: 7 } });
    const rerunResults = [
      { runId: 101, rerunSkipped: 'cancel-not-completed' }, { runId: 202, rerun: true },
    ];
    expect(result).toMatchObject({ applied: true, rerunResults });
    expect(h.mutations.map(args => args.slice(0, 3))).toEqual([
      ['variable', 'set', 'WE_SHARD_RUNNER'], ['run', 'cancel', '101'], ['run', 'cancel', '202'],
      ['run', 'rerun', '202'],
    ]);
    expect(feedLines(h.feedPath)).toHaveLength(1);
    expect(parseEvent(feedLines(h.feedPath)[0]).rerunResults).toEqual(rerunResults);
  });

  it.each([101, 202, 303])(
    'rejected sibling cancellation at run %s still reruns previously cancelled runs and completed siblings', async failedId => {
      const runIds = [101, 202, 303];
      const h = harness({ jobs: runIds.map((runId, index) => job({ runId, jobId: 1001 + index })),
        failCancelRunIds: [failedId], cancelStatuses: ['in_progress', 'completed'] });
      const result = await runRunnerFallback({ ...h.options, apply: true,
        settings: { ...SETTINGS, cancelPollAttempts: 2, cancelPollIntervalMs: 7 } });
      const rerunResults = runIds.map(runId => ({ runId,
        ...(runId === failedId ? { cancelFailed: true } : {}), rerun: true }));
      expect(result).toMatchObject({ applied: true, rerunResults });
      expect(h.mutations.map(args => args.slice(0, 3))).toEqual([
        ['variable', 'set', 'WE_SHARD_RUNNER'],
        ...runIds.map(id => ['run', 'cancel', String(id)]),
        ...runIds.map(id => ['run', 'rerun', String(id)]),
      ]);
      for (const id of runIds) expect(h.pollCounts.get(id)).toBe(2);
      expect(h.sleep.mock.calls).toEqual([[7], [7], [7]]);
      expect(feedLines(h.feedPath)).toHaveLength(1);
      expect(parseEvent(feedLines(h.feedPath)[0]).rerunResults).toEqual(rerunResults);
    });

  it('rejected cancellation that never completes skips only that run and recovers cancelled siblings', async () => {
    const h = harness({ jobs: [job(), job({ runId: 202, jobId: 2001 }), job({ runId: 303, jobId: 3001 })],
      failCancelRunIds: [202] });
    const exec = vi.fn((cmd, args, options) => args[0] === 'api'
      && args[1] === `repos/${REPO}/actions/runs/202`
      ? JSON.stringify({ status: 'in_progress' }) : h.exec(cmd, args, options));
    const result = await runRunnerFallback({ ...h.options, exec, apply: true,
      settings: { ...SETTINGS, cancelPollAttempts: 2, cancelPollIntervalMs: 7 } });
    const rerunResults = [
      { runId: 101, rerun: true },
      { runId: 202, cancelFailed: true, rerunSkipped: 'cancel-not-completed' },
      { runId: 303, rerun: true },
    ];
    expect(result).toMatchObject({ applied: true, rerunResults });
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'api'
      && args[1] === `repos/${REPO}/actions/runs/202`)).toHaveLength(2);
    expect(h.sleep.mock.calls).toEqual([[7]]);
    expect(h.mutations.filter(args => args[1] === 'rerun').map(args => args[2])).toEqual(['101', '303']);
    expect(feedLines(h.feedPath)).toHaveLength(1);
    const event = parseEvent(feedLines(h.feedPath)[0]);
    expect(event.rerunResults).toEqual(rerunResults);
    expect(event.reason).toMatch(/Cancellation requests rejected for runs 202.*inspect CI/i);
    expect(event.reason).toContain('cancel-not-completed');
  });

  it.each([101, 202, 303])(
    'polling failure at run %s skips its rerun and still permits completed siblings to rerun', async failedId => {
      const runIds = [101, 202, 303];
      const h = harness({ jobs: runIds.map((runId, index) => job({ runId, jobId: 1001 + index })) });
      const exec = vi.fn((cmd, args, options) => {
        if (args[0] === 'api' && args[1] === `repos/${REPO}/actions/runs/${failedId}`) {
          throw new Error('Injected polling failure');
        }
        return h.exec(cmd, args, options);
      });
      const result = await runRunnerFallback({ ...h.options, exec, apply: true });
      const rerunResults = runIds.map(runId => runId === failedId
        ? { runId, pollFailed: true, rerunSkipped: 'cancel-not-completed' } : { runId, rerun: true });
      expect(result).toMatchObject({ applied: true, rerunResults });
      expect(h.mutations.filter(args => args[1] === 'cancel').map(args => args[2]))
        .toEqual(runIds.map(String));
      expect(h.mutations.filter(args => args[1] === 'rerun').map(args => args[2]))
        .toEqual(runIds.filter(id => id !== failedId).map(String));
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'api'
        && args[1] === `repos/${REPO}/actions/runs/${failedId}`)).toHaveLength(1);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(feedLines(h.feedPath)).toHaveLength(1);
      const event = parseEvent(feedLines(h.feedPath)[0]);
      expect(event.rerunResults).toEqual(rerunResults);
      expect(event.reason).toContain(`Polling failed for runs ${failedId}; inspect CI manually`);
    });

  it.each([101, 202, 303])(
    'rerun rejection at run %s is recorded once and still permits completed siblings to rerun', async failedId => {
      const runIds = [101, 202, 303];
      const h = harness({ jobs: runIds.map((runId, index) => job({ runId, jobId: 1001 + index })) });
      const exec = vi.fn((cmd, args, options) => {
        if (args[0] === 'run' && args[1] === 'rerun' && args[2] === String(failedId)) {
          throw new Error('Injected rerun rejection');
        }
        return h.exec(cmd, args, options);
      });
      const result = await runRunnerFallback({ ...h.options, exec, apply: true });
      const rerunResults = runIds.map(runId => runId === failedId
        ? { runId, rerunFailed: true } : { runId, rerun: true });
      expect(result).toMatchObject({ applied: true, rerunResults });
      expect(h.mutations.filter(args => args[1] === 'cancel').map(args => args[2]))
        .toEqual(runIds.map(String));
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === 'rerun')
        .map(([, args]) => args[2])).toEqual(runIds.map(String));
      expect(h.mutations.filter(args => args[1] === 'rerun').map(args => args[2]))
        .toEqual(runIds.filter(id => id !== failedId).map(String));
      for (const id of runIds) expect(h.pollCounts.get(id)).toBe(1);
      expect(h.sleep).not.toHaveBeenCalled();
      expect(feedLines(h.feedPath)).toHaveLength(1);
      const event = parseEvent(feedLines(h.feedPath)[0]);
      expect(event.rerunResults).toEqual(rerunResults);
      expect(event.reason).toContain(`Rerun requests failed for runs ${failedId}; inspect CI manually`);
    });

  it('unknown cancellation status fails closed at the polling bound', async () => {
    const h = harness({ cancelStatuses: [undefined] });
    const result = await runRunnerFallback({ ...h.options, apply: true,
      settings: { ...SETTINGS, cancelPollAttempts: 2, cancelPollIntervalMs: 1 } });
    expect(result.rerunResults).toEqual([{ runId: 101, rerunSkipped: 'cancel-not-completed' }]);
    expect(h.pollCounts.get(101)).toBe(2);
    expect(h.sleep.mock.calls).toEqual([[1]]);
    expect(h.mutations.some(args => args[1] === 'rerun')).toBe(false);
  });

  it('polling reservation refuses repair before any mutation when the call budget is too small', async () => {
    const h = harness();
    const result = await runRunnerFallback({ ...h.options, apply: true,
      settings: { ...SETTINGS, maxCalls: 8, cancelPollAttempts: 4 } });
    expect(result).toMatchObject({ applied: false });
    expect(result.error).toMatch(/Repair exceeds call bound.*inspect CI/i);
    expect(h.mutations).toEqual([]);
    expect(h.pollCounts.size).toBe(0);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it.each([['run', 1], ['job', 3]])(
    'truncated %s discovery at the call cap prevents every mutation and reports incomplete', async (_phase, maxCalls) => {
      const h = harness();
      const before = snapshot(h.dir);
      const result = await runRunnerFallback({ ...h.options, apply: true, settings: { ...SETTINGS, maxCalls } });
      expect(result).toMatchObject({ applied: false, decision: 'no-action' });
      expect(result.error).toMatch(/incomplete.*call bound.*inspect CI/i);
      expect(h.exec).toHaveBeenCalledTimes(maxCalls);
      expect(h.mutations).toEqual([]);
      expect(snapshot(h.dir)).toEqual(before);
    });

  it('apply sets the variable before cancelling all stuck runs and then rerunning all of them', async () => {
    const h = harness({ jobs: [job({ runId: 202 }), job(), job({ jobId: 1002 })] });
    await runRunnerFallback({ ...h.options, apply: true });
    expect(h.mutations.map(args => args.slice(0, 3))).toEqual([
      ['variable', 'set', 'WE_SHARD_RUNNER'], ['run', 'cancel', '101'], ['run', 'cancel', '202'],
      ['run', 'rerun', '101'], ['run', 'rerun', '202'],
    ]);
    const set = h.mutations[0];
    expect(set).toEqual(expect.arrayContaining(['--body', 'ubuntu-latest']));
    for (const args of h.mutations) expect(args).toEqual(expect.arrayContaining(['--repo', REPO]));
  });

  it('apply appends exactly one parseable needs-you line and preserves the existing feed', async () => {
    const h = harness();
    writeFileSync(h.feedPath, 'existing feed\n');
    await runRunnerFallback({ ...h.options, apply: true });
    const lines = feedLines(h.feedPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('existing feed');
    const event = parseEvent(lines[1]);
    expect(event.kind).toMatch(/runner.*fallback|fallback.*runner/);
    expect(event.reason).toEqual(expect.any(String));
    expect(lines[1]).toContain('ubuntu-latest');
  });

  it('feed publication failure after landed mutations preserves outcomes and attempts publication only once', async () => {
    const h = harness();
    mkdirSync(h.feedPath);
    const read = vi.fn((...args) => readFileSync(...args));
    const result = await runRunnerFallback({ ...h.options, apply: true, readFeed: read });
    expect(result).toMatchObject({ decision: 'fallback', applied: true, planned: planned(),
      rerunResults: [{ runId: 101, rerun: true }], feedError: expect.stringMatching(/feed.*inspect CI/i) });
    expect(h.mutations.map(args => args.slice(0, 3))).toEqual([
      ['variable', 'set', 'WE_SHARD_RUNNER'], ['run', 'cancel', '101'], ['run', 'rerun', '101'],
    ]);
    expect(read.mock.calls.filter(([path]) => path === h.feedPath)).toHaveLength(1);
    expect(h.log.mock.calls.flat().join('\n')).toContain(result.feedError);
  });

  it('a failed variable set aborts before cancellation or rerun and reports the failure', async () => {
    const h = harness({ failVariableSet: true });
    await runRunnerFallback({ ...h.options, apply: true });
    expect(h.mutations.map(args => args.slice(0, 3))).toEqual([['variable', 'set', 'WE_SHARD_RUNNER']]);
    expect(h.log.mock.calls.flat().join('\n')).toContain('variable-set denied by fixture');
  });

  it('a blocked preflight appends one needs-you line even without stuck jobs', async () => {
    const h = harness({ jobs: [], runnerGroup: { ...GROUP, allows_public_repositories: false } });
    await runRunnerFallback({ ...h.options, apply: true });
    const lines = feedLines(h.feedPath);
    expect(lines).toHaveLength(1);
    expect(parseEvent(lines[0]).reason).toContain(GROUP.name);
    expect(h.mutations).toEqual([]);
  });

  it('deduplicates the same blocked preflight across two invocations', async () => {
    const h = harness({ jobs: [], runnerGroup: { ...GROUP, allows_public_repositories: false } });
    await runRunnerFallback({ ...h.options, apply: true });
    await runRunnerFallback({ ...h.options, apply: true });
    expect(feedLines(h.feedPath)).toHaveLength(1);
    expect(parseEvent(feedLines(h.feedPath)[0]).reason).toContain(GROUP.name);
  });

  it('a blocked preflight in dry-run appends no feed and makes no mutations', async () => {
    const h = harness({ jobs: [], runnerGroup: { ...GROUP, allows_public_repositories: false } });
    await runRunnerFallback({ ...h.options, apply: false });
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it('reports unreadable preflight evidence without using it alone to trigger fallback', async () => {
    const h = harness({ jobs: [], runnerGroup: null });
    const result = await runRunnerFallback({ ...h.options, apply: true });
    expect(JSON.stringify(result) + h.log.mock.calls.flat().join('\n')).toMatch(/unreadable/i);
    expect(h.mutations).toEqual([]);
  });

  it('no-action appends nothing and makes no mutations', async () => {
    const h = harness({ jobs: [job({ createdAt: ago(9) })] });
    await runRunnerFallback({ ...h.options, apply: true });
    expect(h.mutations).toEqual([]);
    expect(snapshot(h.dir)).toEqual([]);
  });

  it('all gh calls use the injected executor with argv arrays and no shell', async () => {
    const h = harness();
    await runRunnerFallback({ ...h.options, apply: true });
    expect(h.exec).toHaveBeenCalled();
    for (const [cmd, args, options] of h.exec.mock.calls) {
      expect(cmd).toBe('gh');
      expect(Array.isArray(args)).toBe(true);
      expect(options?.shell).not.toBe(true);
    }
  });
});

describe('main offline simulation', () => {
  async function simulate(flags) {
    const h = harness();
    const input = join(h.dir, 'jobs.json');
    writeFileSync(input, JSON.stringify([job()]));
    const before = snapshot(h.dir);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`Unexpected process.exit(${code})`); });
    const exec = vi.fn(() => { throw new Error('Offline simulation must not invoke gh'); });
    const readRunnerVar = vi.fn(() => { throw new Error('Offline runner var must come from argv'); });
    const result = await main([`--repo=${REPO}`, `--input=${input}`, '--runner-var=we-8core',
      `--now=${NOW_ISO}`, '--repo-visibility=public', '--group-allows-public=false', '--json', ...flags],
    { ...h.options, exec, readRunnerVar });
    // main may return an exit status or set process.exitCode; neither needs a child process.
    const code = typeof result === 'number' ? result : process.exitCode;
    return { h, before, code, exec, readRunnerVar, exit,
      stdout: stdout.mock.calls.map(([s]) => String(s)).join(''),
      stderr: stderr.mock.calls.map(([s]) => String(s)).join('') };
  }

  it('defaults to dry-run and prints the exact simulated planned fallback with exit zero', async () => {
    const s = await simulate([]);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.stdout).planned).toEqual(planned());
    expect(s.exec).not.toHaveBeenCalled();
    expect(s.readRunnerVar).not.toHaveBeenCalled();
    expect(snapshot(s.h.dir)).toEqual(s.before);
  });

  it('accepts explicit --dry-run for an offline simulation without any writes', async () => {
    const s = await simulate(['--dry-run']);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.stdout).planned).toEqual(planned());
    expect(s.exec).not.toHaveBeenCalled();
    expect(snapshot(s.h.dir)).toEqual(s.before);
  });

  it('refuses --apply with --input with exit two before any gh calls or writes', async () => {
    const s = await simulate(['--apply']);
    expect(s.code).toBe(2);
    expect(s.stderr + s.stdout).toMatch(/apply.*input|input.*apply/i);
    expect(s.exec).not.toHaveBeenCalled();
    expect(s.readRunnerVar).not.toHaveBeenCalled();
    expect(snapshot(s.h.dir)).toEqual(s.before);
  });
});
