/**
 * @file scripts/conveyor/main-ci-red-io.mjs
 * @description Card xu1nixv — the IO shell for "a red main gets an owner". The rules are pure and live in
 *   we:scripts/conveyor/main-ci-red-core.mjs; this file reads GitHub, reads/writes the owner ledger, and starts the
 *   one owner through the declared dispatch-lane sink (`dispatch-lane-io.mjs#createDispatchSinks`, launch kind
 *   `ci-heal`, forced onto the `claude --bg` brief path because a main fix has no PR for the mechanical wrapper).
 *
 * Called once per health-watch tick ({@link probeAndOwnMainCi}); its result is the `mainCiRuns` probe the
 * `main-ci-red` smell reads, so the episode report shows main's state AND its owner.
 *
 * ONE OWNER PER BROKEN COMMIT. The ledger `<healthDir>/main-red-owners.json` (`{ "<first red sha>": {at,
 * sessionSlug, handle} }`) is read, decided on and written inside one file lock, so two ticks (or two health-watch
 * processes) never send two fixers for the same commit. An entry is written only after the sink started a session.
 *
 * UNKNOWN NEVER ACTS. A failed or throttled runs read throws (the tick records a probe error, the smell is skipped,
 * no dispatch). An unreadable or possibly-truncated open-PR read makes ownership unknown: no dispatch.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import {
  mainCiRedSettings, mainRedState, findOwner, decideOwner, buildOwnerBrief, ownerSessionSlug, classifyRun,
} from './main-ci-red-core.mjs';

/** Main's repo: the WE entry of the constellation registry (never a hand-typed slug). */
export const DEFAULT_REPO_SLUG = CONSTELLATION_REPOS.we.slug;
const OPEN_PR_LIMIT = 300;
const MAX_JOB_READS = 4;

function ghJson(exec, argv) {
  const out = exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  if (isGhDeferred(out)) throw new Error('gh read deferred (low budget)');
  return JSON.parse(String(out || 'null'));
}

/** Failing jobs of one run: `{complete, jobs:[{id,name,conclusion}]}`; a job that was only cancelled is not failing. */
export function readRunJobs(runId, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  const page = ghJson(exec, ['api', `repos/${repoSlug}/actions/runs/${runId}/jobs?per_page=100`]);
  const jobs = Array.isArray(page?.jobs) ? page.jobs : [];
  const complete = Number.isInteger(page?.total_count) && page.total_count === jobs.length;
  return { complete, failed: jobs.filter((j) => ['failure', 'timed_out'].includes(String(j.conclusion))).map((j) => ({ id: j.id, name: j.name })) };
}

/** Failing test titles from one job's check-run annotations (CI output — untrusted text, quoted later). */
export function readFailingTests(jobId, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  const rows = ghJson(exec, ['api', `repos/${repoSlug}/check-runs/${jobId}/annotations?per_page=50`]);
  return (Array.isArray(rows) ? rows : [])
    .filter((a) => a?.annotation_level === 'failure' && a.path && a.path !== '.github')
    .map((a) => String(a.title || a.path).slice(0, 300));
}

/**
 * Main's CI workflow runs (by WORKFLOW, never across all workflows — card xfrjlsi), with recent failures checked for
 * "only cancelled / no runner" (`infraOnly`, not a code failure), plus the failing jobs and tests of the latest real
 * red run. Throws on an unreadable runs read (= unknown).
 */
export function probeMainCiRuns({ exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG, settings = mainCiRedSettings() } = {}) {
  const runs = ghJson(exec, ['run', 'list', '--repo', repoSlug, '--workflow', settings.mainCiRedWorkflow, '--branch', settings.mainCiRedBranch,
    '--limit', String(settings.mainCiRedRunLimit), '--json', 'databaseId,conclusion,status,createdAt,updatedAt,headSha,event,workflowName']);
  if (!Array.isArray(runs)) throw new Error('main CI runs read returned no list');
  const sorted = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const failing = { jobs: [], tests: [] };
  let reads = 0;
  for (const r of sorted) {
    const v = classifyRun(r);
    if (v === 'green') break; // only the current red window matters
    if (v !== 'red' || reads >= MAX_JOB_READS) continue;
    reads += 1;
    let jobs = null;
    try { jobs = readRunJobs(r.databaseId, { exec, repoSlug }); } catch { jobs = null; }
    if (jobs && jobs.complete && jobs.failed.length === 0) { r.infraOnly = true; continue; }
    if (jobs && !failing.jobs.length) {
      failing.jobs = jobs.failed.map((j) => j.name);
      for (const j of jobs.failed.slice(0, 2)) {
        try { failing.tests.push(...readFailingTests(j.id, { exec, repoSlug })); } catch { /* jobs alone still name the failure */ }
      }
      failing.runId = r.databaseId;
    }
  }
  return { runs: sorted, failing };
}

/** Open PRs for the owner check, or `null` when unreadable or possibly cut off (= ownership unknown). */
export function readOpenPrsForOwner({ exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  try {
    const rows = ghJson(exec, ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,body,headRefName,createdAt,state']);
    if (!Array.isArray(rows) || rows.length >= OPEN_PR_LIMIT) return null;
    return rows;
  } catch { return null; }
}

export function ledgerPathIn(dir) { return join(dir, 'main-red-owners.json'); }
export function readOwnerLedger(path) {
  try { const v = JSON.parse(readFileSync(path, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/** The default fixer gate: the fix-dispatch kill switch and the shared fix/ci-heal throttle (cap + host load). */
async function defaultGates() {
  const { fixDispatchKilled } = await import('./fix-loop-ledger.mjs');
  const { createDispatchThrottle } = await import('../lib/dispatch-throttle.mjs');
  const { listFixDispatchClaims } = await import('./fix-claim-store.mjs');
  let killed = false;
  try { killed = fixDispatchKilled(); } catch { killed = false; }
  let fixGate = null;
  try { fixGate = createDispatchThrottle({ listClaims: () => listFixDispatchClaims(undefined, { liveOnly: true }) }).tryAdmit('ci-heal'); } catch { fixGate = null; }
  return { killed, fixGate };
}

/** Start the owner session through the declared dispatch-lane sink. */
export async function defaultDispatchOwner({ prompt, sessionSlug }) {
  const io = await import('../operations/dispatch-lane-io.mjs');
  const { DISPATCH_EFFECT } = await import('../operations/dispatch-lane.mjs');
  const { dispatchModesFromEnv } = await import('../operations/dispatch-provider-registry.mjs');
  const { routeAvailableCiHeal } = await import('../operations/ci-heal-pr-dispatch.mjs');
  const route = routeAvailableCiHeal({ scope: [], reason: 'main-red' });
  if (route?.outcome === 'refused') return { held: true, reason: route.refusal ?? 'route refused' };
  // A main fix has no PR: force the `claude --bg` brief path (the mechanical ci-heal wrapper needs a PR) and no probation worker.
  const sinks = io.createDispatchSinks({ root: io.REPO_ROOT, modes: { ...dispatchModesFromEnv(), 'ci-heal': 'agent' }, extraArgs: io.agentArgsFromEnv() });
  const out = await sinks[DISPATCH_EFFECT]({
    launchKind: 'ci-heal', prompt, sessionSlug, lane: null, scope: [], pr: null, reason: 'main-red', repo: 'we',
    probationWorker: null, routing: route ? { ...route, probationWorker: null } : null,
  });
  if (out?.held) return out;
  return { handle: out?.handle ?? null };
}

/**
 * ONE PASS per health tick: read main's CI, decide ownership, dispatch at most one owner, and return the
 * `mainCiRuns` probe value `{runs, failing, owner, decision, dispatched}`. `dryRun` decides but never dispatches or
 * writes. Every seam is injectable for the replay tests.
 */
export async function probeAndOwnMainCi({
  dir, now = Date.now(), config = {}, dryRun = false, repoSlug = DEFAULT_REPO_SLUG, weRoot,
  readRuns = (o) => probeMainCiRuns(o), readPrs = () => readOpenPrsForOwner({ repoSlug }),
  listAgents = async () => (await import('../operations/dispatch-lane-io.mjs')).defaultListAgents(),
  gates = defaultGates, dispatch = defaultDispatchOwner,
} = {}) {
  const settings = mainCiRedSettings(config);
  const probe = readRuns({ repoSlug, settings });
  const state = mainRedState(probe.runs);
  const base = { ...probe, owner: null, decision: null, dispatched: null };
  if (state.status !== 'red') return { ...base, decision: { owed: false, reason: state.status === 'green' ? 'main-green' : 'main-state-unknown' } };
  // Cheap verdicts first: no PR/agent read while main is not red long enough or dispatch is off.
  const pre = decideOwner({ state, now, settings, owner: null, prs: [] });
  if (!pre.owed) return { ...base, decision: pre };
  const prs = readPrs();
  let agents = [];
  try { agents = await listAgents(); } catch { agents = []; }
  const { killed, fixGate } = await gates();
  const path = ledgerPathIn(dir);
  mkdirSync(dirname(path), { recursive: true });
  const sha = state.firstRed.sha;
  const sessionSlug = ownerSessionSlug(sha);
  const lock = (fn) => (dryRun ? fn() : withFileLock(`${path}.lock`, fn, { timeoutMs: 30_000 }));
  // Phase 1 (under the lock): read → decide → RESERVE. A concurrent tick then sees the reservation as the owner
  // and stands down. The lock is synchronous, so the (async) dispatch runs after it, against the reservation.
  let result = base;
  lock(() => {
    const ledger = readOwnerLedger(path);
    const owner = findOwner({ firstRed: state.firstRed, prs: prs ?? [], agents, ledger, settings });
    const decision = decideOwner({ state, now, settings, owner, prs, killed, fixGate });
    result = { ...base, owner, decision };
    if (!decision.owed || dryRun) return;
    ledger[sha] = { at: now, sessionSlug, status: 'dispatching', latestRedSha: state.latestRed.sha };
    writeJsonAtomic(path, ledger);
  });
  if (!result.decision?.owed || dryRun) return result;
  // Phase 2: dispatch, then settle the reservation. A crash here leaves the reservation (never a second owner).
  const prompt = buildOwnerBrief({ state, failing: probe.failing, weRoot: weRoot ?? process.cwd(), repoSlug, settings });
  let out;
  try { out = await dispatch({ prompt, sessionSlug, state }); } catch (e) {
    const why = String(e?.message || e).split('\n')[0];
    // `notApplied` = provably nothing started (retry is safe); anything else may have started a session: keep it as owner.
    out = e?.notApplied ? { held: true, reason: `dispatch not started: ${why}` } : { handle: null, unknown: why };
  }
  lock(() => {
    const ledger = readOwnerLedger(path);
    // A refused launch started nothing: drop the reservation so the next tick may try again.
    if (out?.held) delete ledger[sha];
    else ledger[sha] = { at: now, sessionSlug, status: out?.unknown ? 'dispatch-unknown' : 'dispatched', handle: out?.handle ?? null, latestRedSha: state.latestRed.sha, ...(out?.unknown ? { error: out.unknown } : {}) };
    writeJsonAtomic(path, ledger);
  });
  if (out?.held) return { ...result, owner: null, decision: { owed: true, reason: 'dispatch-held', why: out.reason } };
  return { ...result, owner: { kind: 'dispatched', ref: sessionSlug }, dispatched: { sessionSlug, handle: out?.handle ?? null } };
}
