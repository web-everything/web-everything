#!/usr/bin/env node
/**
 * @file R863 live-owner watchdog. Pure ownership/action rules and an injected, shadow-first IO shell.
 * Unknown evidence holds automation and names operator inspection as the fallback. Dispatchers own admission.
 */
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
export const LIVE_OWNER_DEFAULTS = Object.freeze({ intervalMinutes: 5, mode: 'shadow', actEnabled: false, progressMinutes: 20,
  ciMinutes: 60, stackMinutes: 120, redTeamMinutes: 120, reviewQueueMinutes: 20,
  noMergeMinutes: 30, overlayMinutes: 20, maxPrs: 100, maxActions: 3, tickBudgetMs: 30_000 });
export const RULE_CLASSES = Object.freeze(['dead-red-team', 'stale-label', 'overlay-not-adopted', 'no-merge',
  'evidence-unavailable', 'stalled-owner', 'conflict', 'owed-review', 'stale-check', 'operator-approval', 'heavy-mac-fallback']);
const millis = v => typeof v === 'number' ? v : Date.parse(v ?? '');
const age = (v, now) => Number.isFinite(millis(v)) && millis(v) <= now ? (now - millis(v)) / MINUTE : null;
const labelsOf = pr => (pr.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
const operator = pr => labelsOf(pr).some(l => ['review:human', 'needs-you', 'operator-approval'].includes(l));
const keyOf = pr => `${pr.repo}#${pr.number ?? pr.pr}`;
/** Decisions dedup over this window; the IO reads at least this far back from the decision log. */
export const DECISION_WINDOW_MS = HOUR;
/** Longest notify dedup window; the IO prunes smell state older than this. */
export const NOTIFY_MAX_WINDOW_MS = 24 * HOUR;
/** Most recent hook-gap records the self-audit reads; the IO tail-reads the append-only log down to this. */
export const MAX_HOOK_GAPS = 5000;
/** Child start-up (Node boot + imports) runs before its own budget clock; leave it this much of the kill timeout. */
export const CHILD_STARTUP_MARGIN_MS = 5000;
const recent = (r, now, window = DECISION_WINDOW_MS) => Number.isFinite(millis(r.ts ?? r.at)) && millis(r.ts ?? r.at) > now - window;
/** PURE. Explicit false (including a zombie) is dead; unknown probes never authorize a takeover. */
export function processLive(row) {
  if (row?.alive === false || /^Z/i.test(row?.stat ?? '') || /defunct/i.test(row?.command ?? '')) return false;
  return row?.alive === true ? true : null;
}

/** PURE. Evidence is head-bound by the reader; each external wait carries a finite deadline. */
export function classifyOwner(pr, evidence = {}, now = Date.now(), budgets = {}) {
  const b = { ...LIVE_OWNER_DEFAULTS, ...budgets };
  const out = (owner, detail, progressAgeMin = null, overBudget = false) => ({ owner, detail, progressAgeMin, overBudget });
  if (pr.isDraft) return out('none', 'draft');
  if (operator(pr)) return out('operator', 'operator-approval');
  if (evidence.complete !== true) return out('none', 'evidence-unavailable');
  let stalled = null;
  for (const claim of evidence.claims ?? []) {
    const live = processLive(claim), minutes = age(claim.activityMs, now);
    if (live === null || (live && minutes === null)) return out('none', 'evidence-unavailable');
    if (live && minutes <= b.progressMinutes) return out('live-process', claim.kind ?? 'claim', minutes);
    if (live) stalled = out('none', 'stalled-owner', minutes, true);
  }
  const wait = (detail, started, budget) => {
    const minutes = age(started, now);
    if (minutes === null) return out('none', 'evidence-unavailable');
    return minutes <= budget ? out('external-wait', `${detail}; deadline=${new Date(millis(started) + budget * MINUTE).toISOString()}`, minutes)
      : out('none', 'stalled-owner', minutes, true);
  };
  if (stalled) return stalled;
  if (evidence.stackedOn) return wait(`stacked-on-PR-${evidence.stackedOn}`, evidence.stackSince, b.stackMinutes);
  const running = (pr.statusCheckRollup ?? []).filter(c => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED'].includes(c.status ?? c.state));
  if (running.length) {
    const starts = running.map(c => millis(c.startedAt ?? c.createdAt));
    return wait('CI-running', Math.min(...starts), b.ciMinutes);
  }
  if (evidence.redTeam?.status === 'running' || evidence.redTeam?.state === 'running') {
    const live = processLive(evidence.redTeam);
    if (live === null) return out('none', 'evidence-unavailable');
    if (live) return wait('red-team-running', evidence.redTeam.startedAt ?? evidence.redTeam.createdAt ?? evidence.redTeam.at, b.redTeamMinutes);
  }
  if (evidence.reviewQueuedAt) return wait('review-queued', evidence.reviewQueuedAt, b.reviewQueueMinutes);
  return out('none', 'unowned');
}

/** PURE. One selected action per PR, across heads and action types; intent spends the hourly budget. */
export function planActions(classified, history = [], now = Date.now(), { mode = 'shadow' } = {}) {
  const actions = [], seen = new Set();
  for (const row of classified) {
    const pr = row.pr, e = row.evidence ?? {}, c = row.classification ?? row;
    const key = keyOf(pr), labels = labelsOf(pr);
    if (pr.isDraft || row.sweepHandled || seen.has(key)) continue;
    if (c.owner === 'operator') { actions.push({ pr, action: 'needs-you', reason: 'operator-approval', mode }); seen.add(key); continue; }
    // Activity age is not proof of death: escalate a stalled living owner without
    // clearing its label, reclaiming its claim, or launching a competing worker.
    if (c.detail === 'stalled-owner' && (e.claims ?? []).some(claim => processLive(claim) === true)) {
      actions.push({ pr, action: 'needs-you', reason: 'stalled-owner: living worker exceeded progress budget; operator must inspect before recovery', mode });
      seen.add(key); continue;
    }
    if (c.owner !== 'none' || c.detail === 'evidence-unavailable' || e.liveClaim === true || e.held === true) continue;
    if (history.some(r => `${r.repo}#${r.pr}` === key && ['would-do', 'intent', 'did'].includes(r.phase) && recent(r, now))) continue;
    let action;
    if ((pr.author?.login === 'app-bot' || pr.author === 'app-bot') && pr.files?.length === 1
      && (pr.files[0].path ?? pr.files[0]) === 'scripts/ci/test-timings.json') action = e.validatorAvailable ? 'validate-data-refresh' : 'needs-you';
    else if (pr.mergeable === 'CONFLICTING') action = 'fix-dispatch';
    else if (labels.includes('review:changes')) action = 'fix-dispatch';
    else if (e.stuckRequiredCheck || e.missingRequiredCheck) action = 'refresh-check';
    else if (e.redTeamOwed || ((e.redTeam?.status ?? e.redTeam?.state) === 'running' && processLive(e.redTeam) === false)) action = 'red-team-dispatch';
    else if (labels.includes('review:pending')) action = 'review-dispatch';
    else if (labels.includes('status:fixing')) action = 'clear-label';
    if (!action) continue;
    seen.add(key);
    actions.push({ pr, action, mode, reason: action === 'needs-you' ? 'validator missing' : c.detail,
      ...(action === 'clear-label' ? { label: 'status:fixing' } : {}) });
  }
  return actions;
}

/** PURE. Derive stable gap families from the hook's free-form source/action, retaining unknown families. */
export function selfAudit(gaps, ruleClasses = RULE_CLASSES) {
  const counts = Object.create(null);
  for (const gap of gaps) {
    const text = `${gap.eventSource ?? ''} ${gap.action ?? ''}`.toLowerCase();
    const patterns = [['dead-red-team', /dead.red.team|red.team.*(?:dead|defunct)/], ['stale-label', /stale.label|status:fixing/],
      ['overlay-not-adopted', /overlay|combined top|rebuild.*top/], ['no-merge', /no.merge|merge.*stall/],
      ['load-gate-hold', /load.gate|heavy.*hold/], ['evidence-unavailable', /evidence.*(?:unavailable|missing|unreadable)/],
      ['false-positive', /false.positive/]];
    const family = typeof gap.gapClass === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(gap.gapClass)
      ? gap.gapClass : patterns.find(([, re]) => re.test(text))?.[0] ?? 'unclassified';
    counts[family] = (counts[family] ?? 0) + 1;
  }
  const unruled = Object.keys(counts).filter(k => !ruleClasses.includes(k)).sort();
  return { counts, unruled, summary: unruled.length ? `live-owner self-audit: rules missing for ${unruled.map(k => `${k} (${counts[k]})`).join(', ')}` : 'live-owner self-audit: no unruled gap classes' };
}

/** PURE. Smell evidence is supplied by the existing registry/adoption and heavy-run readers. */
export function detectSmells({ prs = [], lastMergeAt, overlays = [], heavyFallback = false, feedEvents = [] }, now, budgets = {}) {
  const b = { ...LIVE_OWNER_DEFAULTS, ...budgets }, smells = [];
  if (age(lastMergeAt, now) >= b.noMergeMinutes && prs.some(p => !p.isDraft && p.mergeable === 'MERGEABLE'
    && p.mergeStateStatus === 'CLEAN' && p.ready === true && !operator(p))) smells.push({ key: 'NO-MERGE', reason: 'No merge to main while a clean, ready PR waits' });
  for (const o of overlays) if (o.registered === true && o.adopted === false && age(o.at, now) >= b.overlayMinutes)
    smells.push({ key: `OVERLAY-OVERDUE-STALE:${o.clone}:${o.ref}`, reason: `OVERLAY-OVERDUE-STALE: ${o.ref} awaits adoption` });
  if (heavyFallback && !feedEvents.some(e => /FORGE[- ]FALLBACK|HEAVY[- ]MAC[- ]FALLBACK/i.test(`${e.kind} ${e.reason}`)))
    smells.push({ key: 'HEAVY-MAC-FALLBACK', reason: 'Heavy Mac fallback detected by the existing heavy-run smell' });
  return smells;
}

/** Each run serializes history + intent + execution. Injected seams never fall through to host IO. */
export async function runLiveOwnerWatchPass({ now = Date.now(), env = process.env, mode, deps } = {}) {
  const io = deps ?? await (await import('./pr-live-owner-watch-io.mjs')).createLiveOwnerWatchIo({ env, now });
  const config = { ...LIVE_OWNER_DEFAULTS, ...io.config };
  mode = mode ?? (deps ? env.WE_LIVE_OWNER_WATCH_MODE : undefined) ?? config.mode;
  if (!['shadow', 'on'].includes(mode)) mode = 'shadow';
  const result = { considered: 0, byOwner: { 'live-process': 0, 'external-wait': 0, operator: 0, none: 0 }, actions: [], held: [], smells: [], selfAudit: null };
  let release;
  const started = Date.now(), inBudget = () => Date.now() - started < config.tickBudgetMs;
  const notify = async (key, reason, pr = {}, window = HOUR, details = {}) => {
    if (!(window <= NOTIFY_MAX_WINDOW_MS)) throw Error('notify window exceeds smell-state retention; operator inspection required');
    const state = await io.readSmellState();
    if (state[key] && recent({ ts: state[key] }, now, window)) return false;
    await io.emit({ at: new Date(now).toISOString(), repo: pr.repo ?? io.repo, pr: pr.number ?? 0,
      head: pr.headRefOid ?? '', kind: `live-owner-${key.split(':')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 40),
      reason: `${key}: ${reason}`, evidence: [reason], ...details });
    state[key] = new Date(now).toISOString();
    await io.writeSmellState(state);
    return true;
  };
  try {
    release = await io.acquireRun();
    const gaps = await io.readGaps();
    if (!Array.isArray(gaps) || gaps.length > MAX_HOOK_GAPS) throw Error('hook gaps incomplete or oversized; operator must inspect full input');
    result.selfAudit = selfAudit(gaps);
    // A tail-read log covers only its newest records: say so, so the summary never reads as the whole history.
    if (gaps.truncated === true) result.selfAudit.summary += ` (newest ${gaps.length} gap records only; operator may inspect the full hook-gap log)`;
    if (config.actEnabled !== true || result.selfAudit.unruled.length) await notify('SELF-AUDIT', result.selfAudit.summary, {}, NOTIFY_MAX_WINDOW_MS);
    const history = await io.readHistory(), sweep = await io.readSweepHistory();
    if (sweep.complete !== true) throw Error('stall-sweep audit incomplete');
    const prs = await io.listPRs();
    if (!Array.isArray(prs) || prs.length > config.maxPrs) throw Error('PR inventory incomplete or oversized; operator must inspect full inventory');
    const classified = [];
    for (const pr of prs) {
      if (pr.isDraft) continue;
      if (!inBudget()) { result.held.push({ pr: pr.number, reason: 'tick budget exhausted; operator inspection required' }); break; }
      const sweepHandled = sweep.records.some(r => `${r.repo}#${r.pr}` === keyOf(pr) && ['intent', 'did'].includes(r.phase) && recent(r, now));
      if (sweepHandled) { result.held.push({ pr: pr.number, reason: 'stall-sweep handled this hour' }); continue; }
      let evidence;
      try { evidence = await io.readEvidence(pr, prs); }
      catch { evidence = { complete: false }; }
      const classification = classifyOwner(pr, evidence, now, config);
      result.considered++; result.byOwner[classification.owner]++;
      classified.push({ pr, evidence, classification });
      if (classification.detail === 'evidence-unavailable') {
        result.held.push({ pr: pr.number, reason: 'evidence-unavailable; operator inspection required' });
        await notify(`evidence-unavailable:${keyOf(pr)}`, 'Ownership evidence unavailable; inspect before retry', pr);
      }
    }
    const planned = planActions(classified, history, now, { mode });
    if (config.actEnabled !== true) {
      // Report every ownerless head, even when an old decision spent the action budget.
      const wouldDo = planActions(classified, [], now, { mode });
      for (const { pr, classification: c } of classified) {
        if (c.owner !== 'none') continue;
        const action = wouldDo.find(a => keyOf(a.pr) === keyOf(pr))?.action ?? 'hold-for-operator';
        await notify(`no-live-owner:${keyOf(pr)}:${pr.headRefOid}`,
          `owner=${c.owner}; detail=${c.detail}; progressAgeMin=${c.progressAgeMin ?? 'unknown'}; would-do=${action}`,
          pr, HOUR, { kind: 'no-live-owner', ownerClass: c.owner, progressAgeMin: c.progressAgeMin, wouldDo: action });
      }
    }
    let spent = 0;
    for (const action of planned) {
      if (action.action === 'needs-you') { await notify(`${action.reason}:${keyOf(action.pr)}`, action.reason, action.pr); continue; }
      if (!inBudget() || spent >= config.maxActions) { result.held.push({ pr: action.pr.number, reason: 'pass budget; retry next pass' }); continue; }
      // This read is deliberately inside the critical section, immediately before the durable spend.
      const gate = config.actEnabled === true ? await io.checkAdmission(action.pr, action) : { ok: true };
      if (gate?.ok !== true) { result.held.push({ pr: action.pr.number, reason: gate?.reason ?? 'admission unknown; operator inspection required' }); continue; }
      const pr = action.pr;
      const record = { ts: new Date(now).toISOString(), et: new Date(now).toLocaleString('en-CA', { timeZone: 'America/New_York' }),
        repo: pr.repo, pr: pr.number, head: pr.headRefOid, ownerClass: 'none', action: action.action,
        phase: config.actEnabled !== true || mode === 'shadow' ? 'would-do' : 'intent', reason: action.reason };
      await io.appendDecision(record); spent++;
      result.actions.push(record);
      if (config.actEnabled !== true || mode === 'shadow') continue;
      try {
        const receipt = await io.execute(action);
        if (receipt?.ok !== true) throw Error(receipt?.reason ?? 'action completion unproven');
        const did = { ...record, phase: 'did' };
        await io.appendDecision(did); result.actions.push(did);
      } catch (e) {
        result.held.push({ pr: pr.number, reason: String(e.message) });
        await notify(`action-failed:${keyOf(pr)}`, 'Action refused or completion unknown; inspect intent before retry', pr);
        break;
      }
    }
    if (inBudget()) {
      const evidence = await io.readSystemEvidence(prs);
      for (const smell of detectSmells(evidence, now, config)) if (await notify(smell.key, smell.reason)) result.smells.push(smell);
    } else result.held.push({ reason: 'system evidence deferred by tick budget; inspect on next pass' });
  } catch (e) {
    result.held.push({ reason: `${e.message}; operator inspection required` });
    // An unavailable audit/lock never authorizes a dispatch. Feed failure is itself returned, not swallowed.
    try { await notify('evidence-unavailable', 'Watchdog evidence unavailable; inspect held result'); }
    catch (feedError) { result.held.push({ reason: `NEEDS-YOU unavailable: ${feedError.message}` }); }
  } finally { if (release) await release(); }
  return result;
}

/** Five-minute health probe. Production uses a bounded child, so a timed-out pass cannot keep running in this tick. */
export async function probeLiveOwnerWatch({ dir, now = Date.now(), config = {}, flags = {}, remainingMs = 30_000,
  runPass = runBoundedPass, readCache, writeCache } = {}) {
  if (!readCache || !writeCache) {
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    readCache ??= () => { try { return JSON.parse(readFileSync(join(dir, 'live-owner-watch.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
    writeCache ??= value => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'live-owner-watch.json'), JSON.stringify(value)); };
  }
  const cfg = { ...LIVE_OWNER_DEFAULTS, ...config.liveOwnerWatch };
  if (!Number.isFinite(cfg.intervalMinutes) || cfg.intervalMinutes <= 0 || !Number.isFinite(cfg.tickBudgetMs) || cfg.tickBudgetMs <= 0)
    return { error: 'invalid liveOwnerWatch interval/budget; operator inspection required' };
  let previous;
  try { previous = readCache(); } catch { return { error: 'liveOwnerWatch cache unreadable; operator inspection required' }; }
  const elapsed = now - millis(previous?.at);
  if (elapsed >= 0 && elapsed < cfg.intervalMinutes * MINUTE) return { ...previous, cached: true };
  if (flags['state-root'] || flags['logs-dir'] || flags['lock-root'] || flags['dry-run']) return { skipped: 'isolated health tick' };
  // Below this the child's start-up margin would leave it no usable budget: skip rather than launch a doomed pass.
  if (remainingMs < CHILD_STARTUP_MARGIN_MS + 1000) return { skipped: 'tick budget exhausted' };
  try {
    const result = await runPass({ now, config: cfg, timeoutMs: Math.min(remainingMs, cfg.tickBudgetMs) });
    const value = { at: new Date(now).toISOString(), result }; writeCache(value); return { ...value, cached: false };
  } catch (e) { return { error: e.message, cached: false }; }
}
/**
 * Child env for the bounded pass. Forward only the tick budget the parent's kill timeout enforces: policy
 * (mode, actEnabled) and thresholds resolve in the child's own cascade (settings file → platform → env), so
 * health defaults never override an explicit opt-in or a configured threshold. The child's budget clock starts
 * after Node boot and imports, so it gets the kill timeout minus a fixed start-up margin; the probe skips a
 * tick too short to leave one. This keeps the budget checks from running past the kill. It does NOT bound
 * the work after an intent record: an action admitted near the end of the budget can still be killed
 * between intent and did (acting is off by default; disclosed in docs/agent/testing.md).
 */
export function liveOwnerChildEnv({ now, timeoutMs, env = process.env }) {
  return { ...env, WE_LIVE_OWNER_WATCH_NOW: String(now),
    WE_LIVE_OWNER_WATCH_CONFIG: JSON.stringify({ tickBudgetMs: Math.max(1, Math.floor(timeoutMs - CHILD_STARTUP_MARGIN_MS)) }) };
}
/** Runs the pass in a child killed with SIGKILL at the timeout; the child's own gh/git/ps reads carry ≤5s timeouts. */
export function runBoundedPass({ now, timeoutMs, script = fileURLToPath(import.meta.url) }) {
  return new Promise((done, reject) => execFile(process.execPath, [script, '--json'], {
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: liveOwnerChildEnv({ now, timeoutMs }),
  }, (error, stdout) => { if (error) reject(error); else { try { done(JSON.parse(stdout)); } catch (e) { reject(e); } } }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveOwnerWatchPass({ now: Number(process.env.WE_LIVE_OWNER_WATCH_NOW) || Date.now(),
    ...(process.argv.includes('--dry-run') ? { mode: 'shadow' } : {}) }).then(result => {
    console.log(process.argv.includes('--json') ? JSON.stringify(result) : `${result.considered} PRs; ${result.actions.length} action records; ${result.held.length} held\n${result.selfAudit?.summary ?? 'self-audit unavailable'}`);
  }).catch(e => { console.error(String(e.message).replace(/[\p{Cc}\p{Cf}]/gu, ' ')); process.exitCode = 1; });
}
