#!/usr/bin/env node
/** Dispatch a bounded remote check. Only verify-lane remote may record its marker. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from './lib/gh-throttle.mjs';
import { MAX_REMOTE_WAIT_MS, remoteVerdict, selectRemoteVerifyRun } from './lib/remote-verify.mjs';
import { laneGitHardeningEnv, hardenLaneGitArgs } from './lib/lane-git-hardening.mjs';
import { cleanRouteText } from './lib/remote-route.mjs';

const usage = () => new Error('Usage: remote-test --ref <branch|SHA> --mode <lane-check|full|targeted> [--tests=<files> | --operation <name>]');
const safe = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && /^[A-Za-z0-9_./:@+-]+$/.test(value) && !value.startsWith('-');
// Keep identical to operationNamePattern in .github/workflows/remote-verify.yml.
const operationNamePattern = /^[a-z][a-z0-9-]*$/;
function validate(options) {
  if (!safe(options.ref) || !['lane-check', 'full', 'targeted'].includes(options.mode)) throw usage();
  const tests = options.tests ?? [];
  if (!Array.isArray(tests) || tests.length > 200 || tests.some(test => !safe(test))) throw usage();
  if (options.operation !== undefined && (!safe(options.operation) || !operationNamePattern.test(options.operation))) throw usage();
  if (options.mode === 'targeted' ? (tests.length > 0) === !!options.operation : tests.length > 0 || options.operation !== undefined) throw usage();
  return options;
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(ref|mode|tests|operation)(?:=(.*))?$/.exec(argv[i]);
    if (!match || Object.hasOwn(options, match[1])) throw usage();
    const value = match[2] ?? argv[++i];
    if (typeof value !== 'string' || !value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) throw usage();
    options[match[1]] = match[1] === 'tests' ? value.trim().split(/[,\s]+/).filter(Boolean) : value;
  }
  return validate(options);
}

export function buildDispatchArgs(options) {
  validate(options);
  return ['workflow', 'run', 'remote-verify.yml', '--ref', options.ref,
    '-f', `mode=${options.mode}`, '-f', `tests=${(options.tests ?? []).join(' ')}`, '-f', `operation=${options.operation ?? ''}`];
}

const validRunIds = ids => Array.isArray(ids) && ids.length <= 100
  && ids.every(id => Number.isSafeInteger(id) && id > 0);

function freshDispatchRun(run, { headSha, createdAfter, existingRunIds }) {
  if (!Number.isSafeInteger(run?.id) || run.id <= 0 || run.head_sha !== headSha
    || !Number.isFinite(Date.parse(run.created_at))) return false;
  const started = Date.parse(createdAfter);
  // Without a pre-dispatch snapshot, retain the strict timestamp-only contract.
  if (existingRunIds === undefined) return Date.parse(run.created_at) > started;
  return validRunIds(existingRunIds) && !existingRunIds.includes(run.id)
    && Date.parse(run.created_at) >= Math.floor(started / 1000) * 1000;
}

/** The workflow sets display_title from toJSON(inputs), not from logs or caller text. */
function matchesDispatchInputs(run, options) {
  const prefix = 'remote-verify ';
  if (typeof run?.display_title !== 'string' || !run.display_title.startsWith(prefix)) return false;
  try {
    const inputs = JSON.parse(run.display_title.slice(prefix.length));
    const expected = { ref: '', mode: options.mode, tests: (options.tests ?? []).join(' '), operation: options.operation ?? '' };
    return inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs)
      && Object.keys(inputs).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => inputs[key] === value);
  } catch { return false; }
}

export async function runRemoteTest(io) {
  let result = { exitCode: 2, recordMarker: false };
  try { validate(io); } catch {
    await io.print({ ...result, exitCode: 3, reason: usage().message });
    return 3;
  }
  try {
    if (io.timeoutMs !== undefined && (typeof io.timeoutMs !== 'number' || !Number.isFinite(io.timeoutMs) || io.timeoutMs < 0)) {
      throw new Error('Invalid remote timeout; use local verify');
    }
    const timeoutMs = io.timeoutMs === undefined ? MAX_REMOTE_WAIT_MS : Math.min(io.timeoutMs, MAX_REMOTE_WAIT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid remote timeout; use local verify');
    const receipt = await io.dispatch(buildDispatchArgs(io));
    if (!/^[a-f0-9]{40}$/i.test(receipt?.head_sha ?? '') || !Number.isFinite(Date.parse(receipt?.createdAfter))
      || (receipt.existingRunIds !== undefined && !validRunIds(receipt.existingRunIds))) {
      throw new Error('Incomplete dispatch receipt; use local verify');
    }
    const evidence = { createdAfter: receipt.createdAfter, headSha: receipt.head_sha,
      ...(receipt.existingRunIds === undefined ? {} : { existingRunIds: receipt.existingRunIds }) };
    const run = await io.findRun(evidence);
    if (!freshDispatchRun(run, evidence)) {
      throw new Error('Missing new exact-HEAD run; use local verify');
    }
    const finished = await io.wait({ runId: run.id, timeoutMs });
    const green = !finished?.timedOut && remoteVerdict(finished).state === 'green';
    result = { exitCode: green ? 0 : 2, recordMarker: green && io.mode !== 'targeted', runId: run.id,
      reason: green ? 'remote check passed' : 'remote failed or timed out; use local verify' };
  } catch {
    result.reason = 'remote unavailable or incomplete evidence; use local verify';
  }
  try { await io.print(result); } catch { return 2; }
  return result.exitCode;
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
const childOptions = { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };

/** Live GitHub IO always bypasses both finished-CI caching and the read memo. */
export function remoteIO(repo = process.cwd(), { env: parentEnv = process.env, execFile = execFileSync,
  execGh = execFileSyncThrottled } = {}) {
  const gitEnv = laneGitHardeningEnv(parentEnv);
  const git = args => execFile('git', hardenLaneGitArgs(args), { ...childOptions, cwd: repo, env: gitEnv }).trim();
  const origin = git(['remote', 'get-url', 'origin']);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
  if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) throw new Error('Unsupported origin');
  const slug = `${match[1]}/${match[2]}`;
  const env = { ...parentEnv, GH_REPO: slug, GH_HOST: 'github.com', WE_FINISHED_CI_CACHE: '0' };
  delete env.WE_GH_READ_MEMO_DIR;
  const gh = args => execGh('gh', args, { ...childOptions, cwd: repo, env, throttle: { env } });
  const api = path => JSON.parse(gh(['api', '--hostname', 'github.com', `repos/${slug}/${path}`]));
  const ready = () => {
    if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('working tree dirty');
    const sha = git(['rev-parse', 'HEAD']);
    const pushed = git(['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
      '-c', 'protocol.ext.allow=never', 'ls-remote', '--heads', 'origin']);
    const branch = pushed.split('\n').map(line => line.split(/\s+/)).find(([head, ref]) => head === sha && ref?.startsWith('refs/heads/'));
    if (!branch) throw new Error('HEAD not pushed');
    gh(['auth', 'status', '--hostname', 'github.com']);
    return { sha, ref: branch[1].slice('refs/heads/'.length) };
  };
  return { git, gh, api, ready };
}

export async function runRemoteCLI(options, { repo = process.cwd(), json = false, quietFailure = false,
  live, execFile = execFileSync, now = Date.now, pause = sleep } = {}) {
  validate(options);
  live ??= remoteIO(repo);
  let headSha;
  const fetchDispatchRuns = sha => {
    const data = live.api(`actions/workflows/remote-verify.yml/runs?event=workflow_dispatch&head_sha=${sha}&per_page=100`);
    if (!Array.isArray(data.workflow_runs) || data.total_count !== data.workflow_runs.length
      || !validRunIds(data.workflow_runs.map(run => run?.id))
      || data.workflow_runs.some(run => run.event !== 'workflow_dispatch' || run.head_sha !== sha
        || !Number.isFinite(Date.parse(run.created_at)))) throw new Error('Incomplete runs; use local verify');
    return data.workflow_runs;
  };
  return runRemoteTest({ ...options,
    dispatch: async args => {
      if (options.mode !== 'targeted') headSha = live.ready().sha;
      const commit = live.api(`commits/${encodeURIComponent(options.ref)}`);
      if (!/^[a-f0-9]{40}$/i.test(commit?.sha ?? '') || (headSha && headSha !== commit.sha)) throw new Error('Ref does not match pushed HEAD');
      headSha = commit.sha;
      // A complete pre-dispatch ID snapshot distinguishes old runs within the same second.
      const existingRunIds = fetchDispatchRuns(headSha).map(run => run.id);
      const createdAfter = new Date(now()).toISOString();
      live.gh(args);
      return { head_sha: headSha, createdAfter, existingRunIds };
    },
    findRun: async evidence => {
      const deadline = now() + 60000;
      do {
        const runs = fetchDispatchRuns(evidence.headSha);
        const run = selectRemoteVerifyRun(runs.filter(run => freshDispatchRun(run, evidence)
          && matchesDispatchInputs(run, options)), evidence.headSha);
        if (run) return run;
        if (now() >= deadline) return null;
        await pause(5000);
      } while (true);
    },
    wait: async ({ runId, timeoutMs }) => {
      const deadline = now() + timeoutMs;
      do {
        const run = live.api(`actions/runs/${runId}`);
        if (run.id !== runId || run.head_sha !== headSha || !matchesDispatchInputs(run, options)) throw new Error('Run changed or dispatch inputs unproven');
        if (['green', 'red', 'error'].includes(remoteVerdict(run).state)) return run;
        const remaining = deadline - now();
        if (remaining <= 0) return { timedOut: true };
        await pause(Math.min(5000, remaining));
      } while (true);
    },
    print: async result => {
      if (result.recordMarker) {
        if (live.ready().sha !== headSha) throw new Error('HEAD changed before marker import');
        // The importer independently rechecks the attempt, required job, clean tree and pushed HEAD.
        execFile(process.execPath, ['scripts/verify-lane.mjs', 'remote', ...(json ? ['--json'] : [])],
          { cwd: repo, stdio: 'inherit', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      } else if (quietFailure && result.exitCode !== 0) { /* caller runs the local gate and prints its result */ }
      else if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stderr.write(`${cleanRouteText(result.reason)}\n`);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch {
    process.stderr.write(`${usage().message}\n`);
    process.exit(3);
  }
  try { process.exitCode = await runRemoteCLI(options); } catch {
    process.stderr.write('Remote unavailable; use local verify.\n');
    process.exitCode = 2;
  }
}
