#!/usr/bin/env node
/**
 * @file scripts/ci/runner-fallback.mjs
 * @description Detect stalled paid CI shards and switch forward to the fallback runner.
 * Dry-run guarantees no GitHub mutation, no feed append. The shared gh-throttle
 * wrapper is required repo-wide; its own slot/budget bookkeeping and call logs
 * are outside this guarantee.
 * Pure decisions are separate from bounded, injected GitHub IO. Defaults to dry-run;
 * --apply sets the variable before cancelling and rerunning affected runs. Never restores
 * the paid runner. Incomplete discovery requires operator inspection, never a partial repair.
 *
 * Usage: node scripts/ci/runner-fallback.mjs --repo=owner/repo [--apply] [--json]
 * Offline: --input=jobs.json --runner-var=label [--now=ISO] (dry-run only).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleepDefault } from 'node:timers/promises';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { checkedFeedPath, sanitizeForFeed } from '../operations/needs-you-feed.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';

export const RUNNER_FALLBACK_POLICY = Object.freeze({ queuedMinutes: 10, fallbackRunner: 'ubuntu-latest' });
const CANCEL_BOUNDS = Object.freeze({ cancelPollAttempts: 6, cancelPollIntervalMs: 1000 });
const READ_BOUNDS = Object.freeze({ completedLookbackMinutes: 120, maxRuns: 40, maxJobs: 100, maxCalls: 160, maxAttemptsPerCall: 5 });
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const runnerLabel = value => typeof value === 'string' && /^ubuntu-(?:latest|\d{2}\.04)(?:-arm)?$/.test(value);
// Match needs-you-feed field bounds; sanitize every nested string before publication.
const FEED_LIMITS = Object.freeze({ repo: 200, head: 128, kind: 40, was: 40, reason: 100, title: 200, pick: 512, command: 512 });
const clean = (value, max = 512) => sanitizeForFeed(value ?? '', max).replace(/\|\s*pick:/gi, ' pick:');
const complete = (body, rows) => Array.isArray(rows) && Number.isSafeInteger(body?.total_count)
  && body.total_count >= 0 && body.total_count === rows.length;
const epoch = value => typeof value === 'string' && value ? Date.parse(value) : NaN;

/** Resolve every leaf independently; invalid overrides retain the lower valid layer. */
export function resolveRunnerFallbackSettings({ env = process.env, platform, tool, log } = {}) {
  const envValues = {};
  for (const [key, name] of Object.entries({ queuedMinutes: 'QUEUED_MINUTES', fallbackRunner: 'RUNNER',
    completedLookbackMinutes: 'COMPLETED_LOOKBACK_MINUTES', maxRuns: 'MAX_RUNS', maxJobs: 'MAX_JOBS', maxCalls: 'MAX_CALLS', maxAttemptsPerCall: 'MAX_ATTEMPTS_PER_CALL',
    cancelPollAttempts: 'CANCEL_POLL_ATTEMPTS', cancelPollIntervalMs: 'CANCEL_POLL_INTERVAL_MS' })) {
    const raw = env[`WE_RUNNER_FALLBACK_${name}`];
    if (raw !== undefined) envValues[key] = key === 'fallbackRunner' ? raw : /^\d+$/.test(raw) ? Number(raw) : NaN;
  }
  const result = cascadePolicy('runnerFallback', tool, {
    standard: { ...RUNNER_FALLBACK_POLICY, ...READ_BOUNDS, ...CANCEL_BOUNDS }, platform, env, envValues, log,
    valid: { queuedMinutes: positiveInteger, fallbackRunner: runnerLabel,
      completedLookbackMinutes: positiveInteger, maxRuns: positiveInteger, maxJobs: positiveInteger, maxCalls: positiveInteger, maxAttemptsPerCall: positiveInteger,
      cancelPollAttempts: positiveInteger, cancelPollIntervalMs: positiveInteger },
  });
  return { ...result.value, sources: result.sources };
}

/** Pure: only stalled shard evidence can request a fallback. */
export function decideRunnerFallback({ jobs = [], runnerVar, settings = RUNNER_FALLBACK_POLICY, now = Date.now() }) {
  const idle = reason => ({ decision: 'no-action', reason, stuck: [], runIds: [] });
  if (!runnerVar || runnerVar === settings.fallbackRunner) return idle('Runner already uses the fallback or is unset');
  if (!Array.isArray(jobs) || !Number.isFinite(now) || !positiveInteger(settings.queuedMinutes)
    || !runnerLabel(settings.fallbackRunner)) return idle('Unreadable decision evidence');
  // Validate the entire discovered run set before interpreting any positive evidence.
  for (const j of jobs) {
    const created = epoch(Object.hasOwn(j ?? {}, 'createdAt') ? j.createdAt : j?.created_at);
    const started = Object.hasOwn(j ?? {}, 'startedAt') ? j.startedAt : j?.started_at;
    if (!Array.isArray(j?.labels) || !j.labels.length || j.labels.some(label => typeof label !== 'string' || !label.trim())
      || !['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(j.status)
      || !Number.isFinite(created) || created > now
      || (started !== null && (!Number.isFinite(epoch(started)) || epoch(started) > now))
      || (j.status === 'in_progress' && started === null)) return idle('Unreadable job evidence; inspect CI manually');
  }
  const matching = jobs.filter(j => Array.isArray(j?.labels) && j.labels.includes(runnerVar));
  const window = settings.queuedMinutes * 60000;
  if (matching.some(j => j.status === 'in_progress'
    || epoch(j.startedAt ?? j.started_at) >= now - window)) return idle('Runner saturation or a recent start explains the queue');
  const stuck = [];
  for (const j of matching) {
    if (j.status !== 'queued' || !/^test-shard \(\d+\)$/.test(j.name)) continue;
    const created = epoch(Object.hasOwn(j, 'createdAt') ? j.createdAt : j.created_at);
    const runId = Number(j.runId ?? j.run_id), jobId = Number(j.jobId ?? j.id);
    if (!Number.isFinite(created) || created > now || !positiveInteger(runId) || !positiveInteger(jobId)) {
      return idle('Unreadable queued job evidence; inspect CI manually');
    }
    if (now - created >= window) stuck.push({ runId, jobId, name: j.name, queuedMinutes: (now - created) / 60000 });
  }
  if (!stuck.length) return idle('No stalled paid shards');
  return { decision: 'fallback', reason: `Paid shards queued beyond ${settings.queuedMinutes} minutes; switch to ${settings.fallbackRunner}`,
    stuck, runIds: [...new Set(stuck.map(j => j.runId))].sort((a, b) => a - b), setVariableTo: settings.fallbackRunner };
}

/**
 * Report only: missing group or visibility evidence is explicitly unreadable.
 * Blocked/unreadable preflight never vetoes fallback: only stuck-job evidence decides,
 * and a blocked group can be exactly why the shards stall.
 */
export function evaluatePreflight({ runnerVar, repoVisibility, runnerGroup, settings = RUNNER_FALLBACK_POLICY }) {
  if (runnerLabel(runnerVar)) return { status: 'ok', reason: 'Standard hosted label; no org runner group preflight required' };
  if (!runnerVar || runnerVar === settings.fallbackRunner) return { status: 'ok', reason: 'Default or fallback runner' };
  if (!['public', 'private', 'internal'].includes(repoVisibility) || !runnerGroup?.name
    || typeof runnerGroup.allows_public_repositories !== 'boolean') return { status: 'unreadable', reason: 'Unreadable repository or runner group evidence; inspect runner configuration' };
  if (repoVisibility === 'public' && !runnerGroup.allows_public_repositories) {
    return { status: 'blocked', reason: `Runner group ${clean(runnerGroup.name, 200)} prohibits public repositories` };
  }
  return { status: 'ok', reason: 'Runner group permits repository visibility' };
}

/** Existing needs-you text envelope with an at-first JSON suffix; controls remain inert. */
export function formatFeedLine(event) {
  const safe = JSON.parse(JSON.stringify({ at: event.at, ...event }, (key, value) =>
    typeof value === 'string' ? clean(value, FEED_LIMITS[key] ?? 512) : value));
  return `NEEDS-YOU ${safe.repo}#${safe.pr} ${safe.kind}: ${safe.reason} | pick: ${safe.pick} ${JSON.stringify(safe)}`;
}

/** Translate the injectable CLI vocabulary to single, real REST requests in production. */
function restExec(cmd, args, { charge, maxAttemptsPerCall, ...options }) {
  const flag = key => args[args.indexOf(key) + 1];
  const repo = flag('--repo');
  let request = args;
  if (args[0] === 'run' && args[1] === 'list') {
    request = ['api', `repos/${repo}/actions/workflows/ci.yml/runs?status=${flag('--status')}&per_page=${flag('--limit')}`];
  } else if (args[0] === 'variable' && args[1] === 'set') {
    request = ['api', '--method', 'PATCH', `repos/${repo}/actions/variables/WE_SHARD_RUNNER`, '-f', 'name=WE_SHARD_RUNNER', '-f', `value=${flag('--body')}`];
  } else if (args[0] === 'run' && ['cancel', 'rerun'].includes(args[1])) {
    request = ['api', '--method', 'POST', `repos/${repo}/actions/runs/${args[2]}/${args[1]}`];
  }
  return execFileSyncThrottled(cmd, request, { ...options, throttle: {
    maxAttempts: maxAttemptsPerCall,
    // Charge actual attempts, including any retry/auth fallback inside the shared helper.
    // The custom executor also disables cached run-job proofs and read memoization.
    exec: (argv, childOptions) => { charge(); return execFileSync(cmd, argv, childOptions); },
  } });
}

/** IO: bounded discovery, then variable -> all cancels -> all reruns, with no reverse switch. */
export async function runRunnerFallback(options = {}) {
  const { repo, exec = restExec, env = process.env, now = Date.now(), apply = false,
    log = console.error, sleep = sleepDefault, readFeed = readFileSync } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('A valid owner/repo is required');
  const settings = resolveRunnerFallbackSettings({ env, platform: options.platform, tool: options.settings, log });
  let feedPath = options.feedPath || env.WE_NEEDS_YOU_FEED
    || join(env.HOME || homedir(), 'workspace', '.operations', 'handoff', 'needs-you-events.jsonl');
  let calls = 0;
  const charge = () => {
    if (++calls > settings.maxCalls) throw new Error('GitHub call bound exceeded; inspect CI manually or raise maxCalls');
  };
  const call = async args => {
    let attempts = 0;
    const chargeAttempt = () => {
      // Also cap auth/JSON/probe retries that can bypass throttle.maxAttempts.
      if (++attempts > settings.maxAttemptsPerCall) throw new Error('GitHub per-call attempt bound exceeded; inspect CI manually');
      charge();
    };
    // Simple injected executors cost one attempt; retrying executors charge each
    // additional attempt through the same callback used by the production wrapper.
    if (exec !== restExec) chargeAttempt();
    return exec('gh', args, { encoding: 'utf8', shell: false, maxBuffer: 4 * 1024 * 1024, timeout: 30000,
      charge: chargeAttempt,
      maxAttemptsPerCall: settings.maxAttemptsPerCall });
  };
  const json = async args => JSON.parse(String(await call(args)));
  const api = endpoint => json(['api', endpoint]);
  const notice = (reason, runIds = [], kind = 'runner-fallback', details = {}) => {
    log(clean(reason));
    if (!apply) return;
    const line = formatFeedLine({ at: new Date(now).toISOString(), repo, pr: runIds[0] ?? 0,
      kind, reason, pick: 'inspect CI and runner group configuration', runIds, ...details });
    let old = '';
    try { old = readFeed(feedPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const suffix = line.slice(line.indexOf(' {"at":'));
    // Ignore event time when deduplicating identical alerts, without a separate state write.
    const identity = suffix.slice(suffix.indexOf(',"repo":'));
    if (old.split('\n').some(previous => previous.endsWith(identity))) return;
    mkdirSync(dirname(feedPath), { recursive: true });
    appendFileSync(feedPath, `${old && !old.endsWith('\n') ? '\n' : ''}${line}\n`);
  };
  // Publication is best-effort reporting: never re-enter repair error handling
  // or discard landed mutation outcomes because the feed is unavailable.
  const publishNotice = (...args) => {
    try { notice(...args); return {}; }
    catch (error) {
      const feedError = `Runner fallback feed publication failed: ${clean(error.message)}; inspect CI manually`;
      log(clean(feedError));
      return { feedError };
    }
  };
  const emptyPlan = () => ({ setVariable: null, cancel: [], rerun: [] });
  let preflight, decision, discoveryComplete = false, planned = emptyPlan();
  try {
    feedPath = checkedFeedPath(feedPath);
    const offline = Object.hasOwn(options, 'jobs');
    const runnerVar = Object.hasOwn(options, 'runnerVar') ? options.runnerVar
      : options.readRunnerVar ? await options.readRunnerVar()
        : (await api(`repos/${repo}/actions/variables/WE_SHARD_RUNNER`)).value;
    if (typeof runnerVar !== 'string' && runnerVar != null) throw new Error('Unreadable runner variable');
    let repoVisibility = options.repoVisibility, runnerGroup = options.runnerGroup;
    if (!offline && runnerVar && runnerVar !== settings.fallbackRunner && !runnerLabel(runnerVar)) {
      if (!Object.hasOwn(options, 'repoVisibility')) {
        try { repoVisibility = (await api(`repos/${repo}`)).visibility; }
        catch (error) {
          preflight = { status: 'unreadable', reason: `Unreadable repository visibility: ${clean(error.message)}; inspect runner configuration` };
        }
      }
      if (!Object.hasOwn(options, 'runnerGroup')) {
        let incompleteLookup = false;
        try {
          const org = repo.split('/')[0];
          const hosted = await api(`orgs/${org}/actions/hosted-runners?per_page=100`);
          if (!complete(hosted, hosted.runners)) {
            incompleteLookup = true;
            throw new Error('Incomplete hosted runner lookup');
          }
          const runner = hosted.runners.find(r => r.name === runnerVar);
          if (!positiveInteger(runner?.runner_group_id)) throw new Error('Runner group unresolved');
          const groups = await api(`orgs/${org}/actions/runner-groups?per_page=100`);
          if (!complete(groups, groups.runner_groups)) {
            incompleteLookup = true;
            throw new Error('Incomplete runner group lookup');
          }
          runnerGroup = groups.runner_groups.find(g => g.id === runner.runner_group_id);
          if (!runnerGroup) throw new Error('Runner group unresolved');
        } catch (error) {
          if (incompleteLookup) throw new Error(`Unreadable runner group discovery: ${clean(error.message)}`);
          // Incomplete lists retain the fail-closed discovery bound. Resolution
          // failures are report-only and must not prevent stuck-job discovery.
          preflight = { status: 'unreadable', reason: `Unreadable runner group discovery: ${clean(error.message)}; inspect runner configuration` };
        }
      }
    }
    preflight ??= evaluatePreflight({ runnerVar, repoVisibility, runnerGroup, settings });
    let jobs = options.jobs;
    if (!offline) {
      const runs = new Map();
      // Active runs are age-independent. Completed reruns can have old creation
      // dates: inspect the latest page, then select by activity on the client.
      const limit = Math.min(settings.maxRuns, 100);
      const cutoff = now - settings.completedLookbackMinutes * 60000;
      for (const status of ['queued', 'in_progress', 'completed']) {
        const response = await json(['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--status', status,
          '--limit', String(limit), '--json', status === 'completed' ? 'databaseId,status,updatedAt,startedAt' : 'databaseId,status']);
        let list = response.workflow_runs;
        if (status === 'completed') {
          if (!Array.isArray(list) || !Number.isSafeInteger(response.total_count)
            || response.total_count < 0 || list.length !== Math.min(response.total_count, limit)) {
            throw new Error('Unreadable completed run page; inspect CI manually or raise maxRuns');
          }
          const activity = run => {
            const times = [run?.updated_at ?? run?.updatedAt, run?.run_started_at ?? run?.startedAt]
              .filter(value => value != null).map(epoch);
            if (!times.length || times.some(time => !Number.isFinite(time) || time > now)) {
              throw new Error('Unreadable completed run activity; inspect CI manually');
            }
            return Math.max(...times);
          };
          const recent = list.map(run => activity(run) >= cutoff);
          if (list.length === limit && recent.at(-1)) {
            throw new Error('Run read bound reached with recent completed activity; inspect CI manually or raise maxRuns');
          }
          list = list.filter((_, index) => recent[index]);
        } else if (!complete(response, list) || list.length >= limit) {
          throw new Error('Run read bound reached or unreadable runs; inspect CI manually or raise maxRuns');
        }
        for (const run of list) {
          const id = Number(run.databaseId ?? run.id);
          if (!positiveInteger(id)) throw new Error('Unreadable run ID');
          runs.set(id, run);
        }
      }
      if (runs.size > settings.maxRuns) throw new Error('Run bound exceeded; inspect CI manually or raise maxRuns');
      jobs = [];
      for (const id of runs.keys()) {
        const body = await api(`repos/${repo}/actions/runs/${id}/jobs?per_page=${Math.min(settings.maxJobs, 100)}`);
        if (!complete(body, body.jobs) || body.jobs.length >= 100
          || jobs.length + body.jobs.length > settings.maxJobs) throw new Error('Job read bound reached; inspect CI manually or raise maxJobs');
        jobs.push(...body.jobs.map(j => ({ ...j, run_id: id })));
      }
    }
    discoveryComplete = true;
    decision = decideRunnerFallback({ jobs, runnerVar, settings, now });
    if (decision.decision === 'fallback') planned = { setVariable: { name: 'WE_SHARD_RUNNER', value: decision.setVariableTo },
      cancel: decision.runIds, rerun: decision.runIds };
    if (!apply || decision.decision !== 'fallback') {
      const publication = preflight.status !== 'ok'
        ? publishNotice(preflight.reason, decision.runIds, 'runner-preflight') : {};
      return { preflight, ...decision, planned, ...publication };
    }
    // Reserve every attempt of worst-case polling and mutations before the first write.
    const repairCalls = 1 + decision.runIds.length * (2 + settings.cancelPollAttempts);
    if (calls + repairCalls * settings.maxAttemptsPerCall > settings.maxCalls) throw new Error('Repair exceeds call bound; inspect CI manually or raise maxCalls');
    await call(['variable', 'set', 'WE_SHARD_RUNNER', '--body', decision.setVariableTo, '--repo', repo]);
    const cancelFailures = new Set();
    for (const id of decision.runIds) {
      try { await call(['run', 'cancel', String(id), '--repo', repo]); }
      catch { cancelFailures.add(id); }
    }
    // A rejected cancellation may mean the run finished naturally. Check its
    // status too, and never let that rejection strand cancelled siblings.
    const rerunResults = [];
    for (const id of decision.runIds) {
      const cancellation = cancelFailures.has(id) ? { cancelFailed: true } : {};
      let completed = false;
      try {
        for (let attempt = 0; attempt < settings.cancelPollAttempts; attempt++) {
          if (attempt > 0) await sleep(settings.cancelPollIntervalMs);
          const run = await api(`repos/${repo}/actions/runs/${id}`);
          if (run?.status === 'completed') { completed = true; break; }
        }
      } catch {
        // Unreadable status cannot authorize a rerun, but siblings still recover.
        rerunResults.push({ runId: id, ...cancellation, pollFailed: true, rerunSkipped: 'cancel-not-completed' });
        continue;
      }
      if (!completed) {
        rerunResults.push({ runId: id, ...cancellation, rerunSkipped: 'cancel-not-completed' });
        continue;
      }
      try {
        await call(['run', 'rerun', String(id), '--repo', repo]);
        rerunResults.push({ runId: id, ...cancellation, rerun: true });
      } catch {
        // Do not retry an uncertain mutation or abandon already cancelled siblings.
        rerunResults.push({ runId: id, ...cancellation, rerunFailed: true });
      }
    }
    const skipped = rerunResults.filter(run => run.rerunSkipped).map(run => run.runId);
    const pollFailures = rerunResults.filter(run => run.pollFailed).map(run => run.runId);
    const rerunFailures = rerunResults.filter(run => run.rerunFailed).map(run => run.runId);
    // Lead with actionable failures so the bounded feed reason retains the diagnosis.
    // Full per-run outcomes remain in the structured rerunResults.
    const failures = [
      cancelFailures.size ? `Cancellation requests rejected for runs ${[...cancelFailures].join(', ')}; inspect CI manually` : '',
      pollFailures.length ? `Polling failed for runs ${pollFailures.join(', ')}; inspect CI manually` : '',
      rerunFailures.length ? `Rerun requests failed for runs ${rerunFailures.join(', ')}; inspect CI manually` : '',
      skipped.length ? 'cancel-not-completed; inspect CI manually' : ''].filter(Boolean);
    const reason = [...failures, decision.reason, preflight.status !== 'ok' ? preflight.reason : '']
      .filter(Boolean).join('; ');
    const publication = publishNotice(reason, decision.runIds, 'runner-fallback', { rerunResults, preflight });
    return { preflight, ...decision, reason, planned, applied: true, rerunResults, ...publication };
  } catch (error) {
    const reason = `Runner fallback incomplete: ${clean(error.message)}; inspect CI manually`;
    // Incomplete discovery authorizes no writes, including feed writes.
    const publication = discoveryComplete ? publishNotice(reason, decision?.runIds) : {};
    if (!discoveryComplete) log(clean(reason));
    return { preflight, decision: 'no-action', planned, error: reason, applied: false, ...publication };
  }
}

/** CLI: offline evidence cannot authorize mutations; dry-run is the default. */
export async function main(argv = process.argv.slice(2), io = {}) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${clean(argv[i])}`);
      const [key, ...parts] = argv[i].slice(2).split('=');
      flags[key] = parts.length ? parts.join('=') : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
    if (flags.apply && flags.input) throw new Error('--apply cannot be combined with --input');
    if (flags.apply && flags['dry-run']) throw new Error('--apply conflicts with --dry-run');
    const options = { ...io, repo: flags.repo ?? io.repo, apply: flags.apply === true,
      ...(flags.now ? { now: Date.parse(flags.now) } : {}) };
    if (flags.input) {
      options.jobs = JSON.parse(readFileSync(flags.input, 'utf8'));
      if (!Array.isArray(options.jobs)) throw new Error('--input must contain a jobs array');
      if (typeof flags['runner-var'] !== 'string') throw new Error('--input requires --runner-var');
      options.runnerVar = flags['runner-var'];
      options.repoVisibility = flags['repo-visibility'];
      options.runnerGroup = { name: 'offline', allows_public_repositories:
        flags['group-allows-public'] === 'true' ? true : flags['group-allows-public'] === 'false' ? false : undefined };
    }
    if (!Number.isFinite(options.now ?? Date.now())) throw new Error('Invalid --now timestamp');
    const result = await runRunnerFallback(options);
    process.stdout.write(`${flags.json ? JSON.stringify(result) : clean(JSON.stringify(result, null, 2))}\n`);
    return result.error ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${clean(error.message)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
