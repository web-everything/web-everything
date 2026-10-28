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
import {
  mainCiRedSettings, mainRedState, findOwner, findOwnerPrs, isRedLongEnough, decideOwner, planCombinedFix, combineKey, buildCombineBrief, buildOwnerBrief, ownerSessionSlug, classifyRun,
  planPriority, admitMainFixDispatch, planMainCiRerun, FLAKE_RERUN_ROUNDS,
  mainCiRedSettingSource, assessOwnerProgress, planEscalation, planStalledRecovery,
} from './main-ci-red-core.mjs';
import { writeMainRedPriority, writeMainRedState } from '../lib/main-red-priority.mjs';

// Preserve the owner module's public reader API while sharing one read-only implementation.
import { DEFAULT_REPO_SLUG, probeMainCiRuns, readFixPrCi, readOpenPrsForOwner } from './main-ci-red-probe.mjs';
export {
  DEFAULT_REPO_SLUG, probeMainCiRuns, readFixPrCi, readOpenPrsForOwner,
  readJobLog, readChangedFiles, readRunJobs, readFailingTests, readMainTip,
} from './main-ci-red-probe.mjs';

/** Request only failed and cancelled jobs through the daemon's actions:write identity. */
export function rerunMainRun(runId, { exec = execFileSyncThrottled, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  const out = exec('gh', ['run', 'rerun', String(runId), '--failed', '--repo', repoSlug], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  if (isGhDeferred(out)) throw new Error('gh rerun deferred (low budget)');
  return out;
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

/**
 * The ci-heal owner session OPENS a repair PR, so it must play the worker App role. health-watch runs as the
 * read-only `observer`, so the session gets an explicit worker env on every identity channel (settings file,
 * spawn env, wrapper env) through the sink's `spawnEnv`. process.env is never mutated: concurrent health-watch
 * work and overlapping dispatches keep their own role.
 */
export const ownerSpawnEnv = (env = process.env) => ({ ...env, WE_GITHUB_APP_ROLE: 'worker' });

/** Start the owner session through the declared dispatch-lane sink. `sinkOptions` is a test seam; production passes none. */
export async function defaultDispatchOwner({ prompt, sessionSlug }, sinkOptions = {}) {
  const io = await import('../operations/dispatch-lane-io.mjs');
  const { DISPATCH_EFFECT } = await import('../operations/dispatch-lane.mjs');
  const { dispatchModesFromEnv } = await import('../operations/dispatch-provider-registry.mjs');
  const { routeAvailableCiHeal } = await import('../operations/ci-heal-pr-dispatch.mjs');
  const route = routeAvailableCiHeal({ scope: [], reason: 'main-red' });
  if (route?.outcome === 'refused') return { held: true, reason: route.refusal ?? 'route refused' };
  // A main fix has no PR: force the `claude --bg` brief path (the mechanical ci-heal wrapper needs a PR) and no probation worker.
  const sinks = io.createDispatchSinks({ root: io.REPO_ROOT, modes: { ...dispatchModesFromEnv(), 'ci-heal': 'agent' }, extraArgs: io.agentArgsFromEnv(), spawnEnv: ownerSpawnEnv(), ...sinkOptions });
  const out = await sinks[DISPATCH_EFFECT]({
    launchKind: 'ci-heal', prompt, sessionSlug, lane: null, scope: [], pr: null, reason: 'main-red', repo: 'we',
    probationWorker: null, routing: route ? { ...route, probationWorker: null } : null,
  });
  if (out?.held) return out;
  return { handle: out?.handle ?? null };
}

/**
 * ONE PASS per health tick: read main's CI, decide ownership, dispatch at most one owner, and return the
 * `mainCiRuns` probe value `{runs, failing, owner, decision, dispatched, priority}`. `dryRun` decides but never dispatches or
 * writes. Every seam is injectable for the replay tests.
 */
export async function probeAndOwnMainCi({
  dir, now = Date.now(), config = {}, dryRun = false, repoSlug = DEFAULT_REPO_SLUG, weRoot,
  readRuns = (o) => probeMainCiRuns(o), readPrs = () => readOpenPrsForOwner({ repoSlug }),
  listAgents = async () => (await import('../operations/dispatch-lane-io.mjs')).defaultListAgents(),
  gates = defaultGates, dispatch = defaultDispatchOwner, publishPriority = writeMainRedPriority,
  publishState = writeMainRedState,
  rerun = (runId) => rerunMainRun(runId, { repoSlug }),
  readPrCi = (pr) => readFixPrCi(pr, { repoSlug }),
} = {}) {
  const settings = mainCiRedSettings(config);
  const probe = readRuns({ repoSlug, settings, config });
  const ledgerPath = ledgerPathIn(dir);
  let reruns;
  const loadReruns = () => { reruns = readOwnerLedger(ledgerPath)._reruns ?? {}; };
  if (dryRun) loadReruns();
  else {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    withFileLock(`${ledgerPath}.lock`, loadReruns, { timeoutMs: 30_000 });
  }
  for (const run of probe.runs || []) {
    // Our flake and owner-stalled reruns are ledgered, but a person's manual re-run (or a run whose ledger entry is lost or
    // unreadable) shows only as attempt > 1. A ledgered run of another kind (the cancelled tip) was never a settled red, so it stays out.
    const kind = reruns[run.databaseId]?.kind;
    if (kind != null ? !['flake', 'owner-stalled'].includes(kind) : !(Number(run.attempt) > 1)) continue;
    // The rerun replaces the original verdict: while it runs the run stays red, and a rerun that finishes with no
    // verdict (cancelled / skipped / infra-only) must not erase the failure it was meant to settle.
    if (run.status !== 'completed') run.rerunPending = true;
    else run.rerunInconclusive = true;
  }
  const state = mainRedState(probe.runs, { tip: probe.tip });
  const base = { ...probe, owner: null, decision: null, dispatched: null, priority: null };
  const newest = [...(probe.runs || [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  let issued = false;
  // card 302: both recovery rules share the same once-per-run reservation.
  const requestRerun = async (plan) => {
    if (dryRun) return { ...plan, status: 'dry-run' };
    mkdirSync(dirname(ledgerPath), { recursive: true });
    let reserved = false;
    withFileLock(`${ledgerPath}.lock`, () => {
      const ledger = readOwnerLedger(ledgerPath);
      ledger._reruns ??= {};
      const prev = ledger._reruns[plan.runId];
      if (Object.hasOwn(ledger._reruns, plan.runId) && !(plan.retry && (prev?.rounds ?? 1) < FLAKE_RERUN_ROUNDS)) return;
      ledger._reruns[plan.runId] = { at: now, kind: plan.kind, sha: plan.sha, reason: plan.reason, status: 'requested', rounds: prev ? (prev.rounds ?? 1) + 1 : 1 };
      writeJsonAtomic(ledgerPath, ledger);
      reserved = true;
    }, { timeoutMs: 30_000 });
    let outcome = null;
    if (reserved) {
      let status = 'issued', error;
      try { await rerun(plan.runId); issued = true; }
      catch (e) { status = 'failed'; error = String(e?.message ?? e).split('\n')[0]; }
      withFileLock(`${ledgerPath}.lock`, () => {
        const ledger = readOwnerLedger(ledgerPath);
        ledger._reruns[plan.runId] = { ...ledger._reruns[plan.runId], status, ...(error !== undefined ? { error } : {}) };
        writeJsonAtomic(ledgerPath, ledger);
      }, { timeoutMs: 30_000 });
      outcome = { ...plan, status };
      if (issued && plan.kind !== 'owner-stalled') process.stderr.write(`main-ci-red: re-ran run ${plan.runId} (${plan.kind}: ${plan.reason}) on ${plan.sha.slice(0, 9)}\n`);
    }
    withFileLock(`${ledgerPath}.lock`, loadReruns, { timeoutMs: 30_000 });
    return outcome;
  };
  if (state.status !== 'green') {
    const plan = planMainCiRerun({ runs: probe.runs, tipSha: probe.tip?.sha ?? newest?.headSha, reruns, flake: probe.failing?.flake, settings });
    if (plan) {
      const outcome = await requestRerun(plan);
      if (outcome) base.rerun = outcome;
    }
  }
  const rerunPending = issued || (probe.runs || []).some((r) => r.rerunPending)
    || !!(newest && newest.status !== 'completed' && Object.hasOwn(reruns, newest.databaseId));
  // Main green: clear the owner-PR priority. Unknown: leave it to expire on its own TTL (never act on a blind read).
  if (state.status === 'pending') {
    if (!dryRun) { publishPriority(null); publishState(null); }
    return { ...base, decision: { owed: false, reason: 'main-tip-red-causes-passed' } };
  }
  if (state.status !== 'red') {
    if (state.status === 'green' && !dryRun) {
      publishPriority(null);
      publishState(null); // the builder's `main-red` freeze lifts

      // Mark the end of any red streak, so a later red window never inherits this window's owner.
      const path = ledgerPathIn(dir);
      mkdirSync(dirname(path), { recursive: true });
      withFileLock(`${path}.lock`, () => {
        const l = readOwnerLedger(path);
        l._greenSeenAt = now;
        for (const [id, entry] of Object.entries(l._reruns ?? {})) {
          if (now - entry.at > 7 * 24 * 60 * 60_000) delete l._reruns[id];
        }
        writeJsonAtomic(path, l);
      }, { timeoutMs: 30_000 });
    }
    return { ...base, decision: { owed: false, reason: state.status === 'green' ? 'main-green' : 'main-state-unknown' } };
  }
  // Main red past the threshold (the smell's own definition): publish it for the builder's `main-red` freeze.
  const mainRedRecord = settings.mainCiRedEnabled && isRedLongEnough(state, { now, thresholdMs: settings.mainCiRedThresholdMs })
    ? { red: true, firstRedSha: state.firstRed.sha, since: state.redSinceMs, latestRedSha: state.latestRed?.sha ?? null, setAt: now, expiresAt: now + settings.mainCiRedPriorityTtlMs }
    : null;
  if (!dryRun) publishState(mainRedRecord);
  base.mainRed = mainRedRecord;
  // Main red: every PR that fixes it (one per red cause) goes first in every queue, from the moment main is red.
  const prs = readPrs();
  const ownerPrs = prs === null ? [] : findOwnerPrs({ firstRed: state.firstRed, prs, settings });
  const priority = prs === null ? null : planPriority({ state, ownerPrs, now, settings });
  // card 302: read each owner PR's CI once, shared with the combine rule.
  const ciRead = new Map();
  const ownerCi = (pr) => {
    if (!ciRead.has(pr.number)) {
      try { ciRead.set(pr.number, readPrCi(pr)); }
      catch { ciRead.set(pr.number, { status: 'unknown' }); }
    }
    return ciRead.get(pr.number);
  };
  const withProgress = async (result) => {
    if (!result.owner || !(settings.mainCiRedOwnerStallMin > 0) || !settings.mainCiRedEnabled) return result;
    const ledger = readOwnerLedger(ledgerPath);
    const entry = Object.entries(ledger).find(([key, value]) => !key.startsWith('_') && value?.sessionSlug === result.owner.ref)?.[1];
    const firstRun = probe.runs.find((r) => r.databaseId === state.firstRed.runId);
    const progressState = { ...state, firstRed: { ...state.firstRed, attempt: firstRun?.attempt,
      rerunRequested: Object.hasOwn(reruns, state.firstRed.runId) } };
    const full = new Map((prs || []).map((pr) => [Number(pr.number), pr]));
    const progressPrs = prs === null ? null : ownerPrs.map((pr) => {
      const p = full.get(pr.number) ?? pr;
      return { ...pr, createdAt: p.createdAt, ci: ownerCi(p) };
    });
    const ownerStall = assessOwnerProgress({ state: progressState, owner: result.owner, ownerPrs: progressPrs,
      ledgerEntry: entry, now, rerunPending, settings });
    const escalation = planEscalation({ state, stall: ownerStall, now, settings });
    const failingRun = [...probe.runs].filter((r) => classifyRun(r) === 'red')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    let recovery = planStalledRecovery({ stall: ownerStall, failingRun, reruns, settings, now });
    if (recovery?.kind === 'rerun') {
      if (probe.runs.some((r) => r.status !== 'completed')) recovery = null;
      else recovery = await requestRerun({ ...recovery, kind: 'owner-stalled' });
      if (recovery) recovery = { ...recovery, kind: 'rerun' };
    }
    const sourceText = (keys) => keys.map((key) => `${key}=${settings[key]} (source ${mainCiRedSettingSource(config, key)})`).join(', ');
    if (escalation) process.stderr.write(`main-ci-red: owner ${result.owner.ref} stalled (${ownerStall.reason}), escalation ${escalation.n}; ${sourceText(['mainCiRedOwnerStallMin', 'mainCiRedOwnerPrDeadlineMin', 'mainCiRedEscalateAfterMin', 'mainCiRedEscalateEveryMin'])}\n`);
    if (recovery) process.stderr.write(`main-ci-red: owner ${result.owner.ref} recovery ${recovery.kind} ${recovery.runId ?? recovery.sha} (${recovery.status ?? 'proposed'}); ${sourceText(['mainCiRedOwnerStallMin', 'mainCiRedOwnerPrDeadlineMin', 'mainCiRedAutoRecover', 'mainCiRedAutoRecoverAfterMin'])}\n`);
    return { ...result, ownerStall, escalation, recovery };
  };
  // Several fix PRs (one per red cause) can deadlock — each failing CI on the other's cause (live 2026-10-08).
  let combine = null;
  if (priority && settings.mainCiRedCombineFixPrs && ownerPrs.length >= 2) {
    const full = new Map((prs || []).map((p) => [Number(p.number), p]));
    const fixPrs = ownerPrs.map((o) => { const p = full.get(o.number) ?? o; return { number: o.number, createdAt: p.createdAt, headRefName: p.headRefName ?? null, ci: ownerCi(p) }; });
    combine = planCombinedFix({ mainFailingJobs: probe.failing?.jobs ?? [], fixPrs, summaryJobs: settings.mainCiRedSummaryJobs });
    if (combine.owedElsewhere.length || combine.deadlock) priority.combine = combine;
  }
  if (prs !== null && !dryRun) publishPriority(priority);
  base.priority = priority;
  // One read of the dispatch gates per tick, shared by the combine session and the owner.
  let gateRead = null;
  const readGates = async () => (gateRead ??= await gates());
  // A deadlock gets ONE combine session (ledger key per PR set; never a second one, never while one is reserved), under
  // the SAME admission rule as the owner (F6): the kill switch, host load, and the fixer cap (main-red work may go past
  // a full cap only when `mainCiRedOwnerPriorityOverFixCap` is on). A refusal reserves nothing, so the next tick retries.
  let combineAdmit = { admit: false };
  if (combine?.deadlock && !rerunPending && !dryRun && settings.mainCiRedOwnerDispatch) {
    combineAdmit = admitMainFixDispatch({ ...(await readGates()), settings });
    if (!combineAdmit.admit) base.combineHeld = { reason: combineAdmit.reason, ...(combineAdmit.why ? { why: combineAdmit.why } : {}) };
  }
  if (combineAdmit.admit) {
    const path = ledgerPathIn(dir);
    mkdirSync(dirname(path), { recursive: true });
    const key = combineKey(combine.deadlock);
    let owed = false;
    withFileLock(`${path}.lock`, () => {
      const l = readOwnerLedger(path);
      // A reservation still `dispatching` after the priority TTL is a crash between reserve and settle (a live dispatch
      // settles within seconds): reclaim it, or the fix PRs stay held `main-fix-combining` with no combine session ever
      // coming. A `dispatched` entry (even with no handle — it may have started) is never reclaimed.
      const stale = l[key]?.status === 'dispatching' && now - (Number(l[key].at) || 0) >= settings.mainCiRedPriorityTtlMs;
      if (l[key] && !stale) return;
      l[key] = { at: now, status: 'dispatching', carrier: combine.deadlock.carrier };
      writeJsonAtomic(path, l);
      owed = true;
    }, { timeoutMs: 30_000 });
    if (owed) {
      const sessionSlug = `main-fix-combine-${combine.deadlock.carrier}`;
      let out;
      try { out = await dispatch({ prompt: buildCombineBrief({ deadlock: combine.deadlock, weRoot: weRoot ?? process.cwd(), repoSlug, firstRedSha: state.firstRed.sha }), sessionSlug, state }); }
      catch (e) { out = e?.notApplied ? { held: true } : { handle: null }; }
      withFileLock(`${path}.lock`, () => {
        const l = readOwnerLedger(path);
        if (out?.held) delete l[key]; else l[key] = { ...l[key], status: 'dispatched', sessionSlug, handle: out?.handle ?? null };
        writeJsonAtomic(path, l);
      }, { timeoutMs: 30_000 });
      if (!out?.held) base.combineDispatched = { sessionSlug, carrier: combine.deadlock.carrier };
    }
  }
  // Cheap verdicts first: no agent/gate read while main is not red long enough or dispatch is off.
  const pre = decideOwner({ state, now, settings, owner: null, prs: [], rerunPending });
  if (!pre.owed) {
    const owner = prs === null ? null : findOwner({ firstRed: state.firstRed, prs, ledger: readOwnerLedger(ledgerPathIn(dir)), settings, redShas: state.redShas });
    return withProgress({ ...base, owner, decision: pre });
  }
  let agents = [];
  try { agents = await listAgents(); } catch { agents = []; }
  const { killed, fixGate } = await readGates();
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
    const owner = findOwner({ firstRed: state.firstRed, prs: prs ?? [], agents, ledger, settings, redShas: state.redShas });
    const decision = decideOwner({ state, now, settings, owner, prs, killed, fixGate, rerunPending });
    result = { ...base, owner, decision };
    if (!decision.owed || dryRun) return;
    ledger[sha] = { at: now, sessionSlug, status: 'dispatching', latestRedSha: state.latestRed.sha };
    writeJsonAtomic(path, ledger);
  });
  if (!result.decision?.owed || dryRun) return withProgress(result);
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
  return withProgress({ ...result, owner: { kind: 'dispatched', ref: sessionSlug }, dispatched: { sessionSlug, handle: out?.handle ?? null } });
}
