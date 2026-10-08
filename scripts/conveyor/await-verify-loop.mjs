#!/usr/bin/env node
/**
 * @file scripts/conveyor/await-verify-loop.mjs
 * @description The core implementation around the fixer slot rules (we:scripts/conveyor/fixer-slot-rules.mjs, R1–R5;
 *   we:backlog/xn025gx, operator rulings P1/P2 2026-10-08). It turns local files into plain facts, asks the rules, and
 *   acts. Nothing here decides policy.
 *
 * WHY A SEPARATE PROCESS. The fix daemon's tick is mostly synchronous child-process work and takes 5–28 min, so a timer
 * in the same process would starve. Measured 2026-10-08: commit→push median ~15 min while verify took 2–9 min. The daemon
 * spawns this file as its own child (`--parent-pid`); it exits when the parent is gone or the loop setting is off.
 *
 * ONE CYCLE (also what the fix tick runs when the loop is off or not alive, R4):
 *   1. the verify-verdict pass (we:scripts/conveyor/await-verify-pass.mjs — unchanged; it alone decides and makes the push
 *      of the exact verified sha, with its claim, ref and PR guards). With `parkedReleasesSlot` on it runs in two phases:
 *      push + record the owed wake-up without waking, then wake only the resumes R3 admits.
 *   2. release-on-completion (R5) for every fix/ci-heal claim whose session wrote its `done` completion record.
 *   A cross-process lock keeps two cycles (loop + tick, or two loop copies across a restart) from acting at once.
 *
 * Temporary by design: the event-driven executor (`verify-finished` / `worker-finished`, design-event-daemons E2/E3)
 * replaces the loop; the rules module moves with it unchanged.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { resolveFixDispatchMaxConcurrent, isPidAlive } from '../lib/dispatch-throttle.mjs';
import { reserve, releaseLockDirIf, readLockEntry } from '../readiness/file-locks.mjs';
import { listStoredAwaitVerify, resolveAwaitVerifyTtlMs } from './await-verify.mjs';
import { listFixDispatchClaims, fixDispatchSessionName, fixDispatchResource, fixDispatchClaimRoot } from './fix-claim-store.mjs';
import { releaseFixDispatchClaim } from './fix-dispatch-claim.mjs';
import { tryReadCompletion } from '../operations/completion-store.mjs';
import {
  resolveFixerSlotSettings, fixSlotState, slotCountedItems, admitResumes, awaitPassRunner, releaseOnCompletion,
} from './fixer-slot-rules.mjs';

const SELF = fileURLToPath(import.meta.url);
const SLOT_KINDS = new Set(['fix', 'ci-heal']);
const repoKeyOrNull = (slug) => { try { return repoKeyForSlug(slug) ?? null; } catch { return null; } };
const ms = (iso) => Date.parse(String(iso ?? ''));

// ── facts ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The verify-wait record that speaks for this claim's session, or null. Bound by repo, PR, kind and session name
 *  (or the claim's session id when it has one). Pure. */
export function waitRecordForClaim(claim, records) {
  const m = claim?.meta ?? {};
  if (!SLOT_KINDS.has(m.kind)) return null;
  let name = null;
  try { name = fixDispatchSessionName({ repo: m.repo, pr: m.pr, kind: m.kind }); } catch { name = null; }
  return (Array.isArray(records) ? records : []).map((e) => e?.record ?? e).find((r) => r
    && r.pr === m.pr && r.kind === m.kind && repoKeyOrNull(r.repo) === m.repo
    && ((m.sessionId && r.sessionId === m.sessionId) || (name && r.who === name))) ?? null;
}

/** R1 facts for one claim's session. Pure. */
export function waitFacts(record) {
  return record ? { requestedAtMs: ms(record.requestedAt), verdictDecided: Boolean(record.pendingResume?.kind) } : null;
}

/** Fix/ci-heal claims tagged with their R1 state. Pure. */
export function claimStates(claims, records, { nowMs, ttlMs }) {
  return (Array.isArray(claims) ? claims : []).filter((c) => SLOT_KINDS.has(c?.meta?.kind))
    .map((c) => ({ item: c, state: fixSlotState({ wait: waitFacts(waitRecordForClaim(c, records)), nowMs, ttlMs }) }));
}

/**
 * R2 applied to the fix throttle's claim list: the claims a length-counting cap should see. Off → unchanged.
 * Non-slot claims (e.g. `fixing`) never count and are dropped. Pure.
 */
export function slotCountedFixClaims(claims, { records, settings, cap, nowMs, ttlMs }) {
  if (!settings?.parkedReleasesSlot) return claims;
  return slotCountedItems({ items: claimStates(claims, records, { nowMs, ttlMs }), cap, parkedReleasesSlot: true, parkedCapFactor: settings.parkedCapFactor });
}

/** The real reader for the daemon's throttle: live claims + the await store, counted by R2. Fails open to the raw list. */
export function defaultSlotCountedFixClaims({
  env = process.env, nowMs = Date.now(), listClaims = () => listFixDispatchClaims(undefined, { liveOnly: true }), readRecords = () => listStoredAwaitVerify(),
} = {}) {
  const claims = listClaims();
  try {
    const settings = resolveFixerSlotSettings({ env });
    if (!settings.parkedReleasesSlot) return claims;
    return slotCountedFixClaims(claims, {
      records: readRecords(), settings, cap: resolveFixDispatchMaxConcurrent({ env }), nowMs, ttlMs: resolveAwaitVerifyTtlMs(env),
    });
  } catch { return claims; }
}

// ── the cycle ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The verify-verdict pass, R3-gated. Off → one pass exactly as today. On → phase A pushes and records the owed wake-up
 * without waking anyone; phase B wakes only the admitted resumes (oldest first). Deferred ones keep their pending
 * resume on disk and their reserved slot (R2). Every effect is the pass's own (injectable `runPass`, `io`).
 */
export async function runSlotAwareAwaitPass({ io, runPass, allowResume, settings, claims, nowMs, ttlMs, cap }) {
  if (!settings.parkedReleasesSlot || !allowResume) return runPass({ io, allowResume, nowMs, ttlMs });
  const a = await runPass({ io, allowResume: false, nowMs, ttlMs });
  const records = io.listRecords();
  const owedFix = records.filter(({ record: r }) => r?.pendingResume?.kind && SLOT_KINDS.has(r.kind));
  const activeCount = claimStates(claims, records, { nowMs, ttlMs }).filter((x) => x.state === 'active').length;
  const { admit, defer } = admitResumes({
    owed: owedFix.map(({ key, record }) => ({ key, requestedAtMs: ms(record.requestedAt) })), activeCount, cap, parkedReleasesSlot: true,
  });
  const deferred = new Set(defer);
  const wake = records.filter(({ key, record }) => record?.pendingResume?.kind && !deferred.has(key));
  const wakeKeys = new Set(wake.map((e) => e.key));
  const b = wake.length
    ? await runPass({ io: { ...io, listRecords: () => io.listRecords().filter((e) => wakeKeys.has(e.key)), listSalvage: undefined }, allowResume: true, nowMs, ttlMs })
    : { rows: [] };
  // Phase A answers `resume-paused` (allowResume:false) for every record it would have woken; that word is not shown.
  // A record pushed in phase A keeps its push row, with the phase-B wake (or the deferral) appended to its result.
  const pushedA = (r) => (r.result && r.result !== 'resume-paused' ? `${r.result}; ` : '');
  const rows = (a.rows ?? []).filter((r) => !wakeKeys.has(r.key) && !deferred.has(r.key));
  for (const r of a.rows ?? []) {
    if (deferred.has(r.key)) rows.push({ ...r, action: 'resume', reason: 'fix-slot-full', result: `${pushedA(r)}resume-deferred (fix slot full, ${activeCount} working ≥ cap ${cap})` });
  }
  for (const r of b.rows ?? []) {
    const before = (a.rows ?? []).find((x) => x.key === r.key && pushedA(x));
    rows.push(before ? { ...r, action: before.action, reason: before.reason, result: `${pushedA(before)}${r.result}` } : r);
  }
  return { rows, admitted: admit, deferred: defer };
}

/**
 * R5 sweep: release every fix/ci-heal claim whose session's completion record says done. Owner- and claimedAt-checked
 * against a fresh read, so a claim re-taken meanwhile is never released.
 */
export function runCompletionReleaseSweep({ claims, records, readCompletion, release, readClaim, woken = {}, enabled = true }) {
  const rows = [];
  for (const c of Array.isArray(claims) ? claims : []) {
    const m = c?.meta ?? {};
    if (!SLOT_KINDS.has(m.kind) || m.borrowed) continue;
    let session = null;
    try { session = fixDispatchSessionName({ repo: m.repo, pr: m.pr, kind: m.kind }); } catch { continue; }
    let rec = null;
    try { rec = readCompletion(session); } catch { rec = null; }
    const d = releaseOnCompletion({
      enabled,
      claim: { claimedAtMs: ms(m.claimedAt), sessionId: m.sessionId ?? null },
      completion: rec ? { status: rec.status, updatedAtMs: ms(rec.updatedAt), sessionId: rec.sessionId ?? null } : null,
      awaitingVerify: Boolean(waitRecordForClaim(c, records)),
      lastWokenAtMs: Number.isFinite(ms(woken?.[session])) ? ms(woken[session]) : null,
    });
    if (!d.release) continue;
    const cur = readClaim(m);
    if (!cur || cur.owner !== c.owner || cur.meta?.claimedAt !== m.claimedAt) continue;
    const r = release({ repo: m.repo, pr: m.pr, kind: m.kind, owner: c.owner });
    if (r?.released) rows.push({ repo: m.repo, pr: m.pr, kind: m.kind, session, doneAt: rec.updatedAt });
  }
  return rows;
}

/**
 * The wake journal R5 reads: session name → the latest time the session was parked or woken. A woken record is cleared
 * from the await store, so without this a `done` written before a red wake would look final.
 * Two stamps, so a crash between the wake and the journal write loses nothing: BEFORE the pass, every parked session
 * is stamped with its wait's `requestedAt` (any wake comes after it, and a done from before parking is then too old);
 * AFTER the pass, every woken session is stamped with the wake time. Entries older than a day drop. Pure.
 * @param {object} prev  the journal now
 * @param {{rows?:object[]|null, recordsByKey:Map<string,object>, nowMs:number}} o  `rows` absent = the pre-pass stamp
 */
export function nextWokenJournal(prev, { rows = null, recordsByKey, nowMs }) {
  const out = {};
  const later = (who, iso) => { if (who && Number.isFinite(ms(iso)) && !(ms(out[who]) >= ms(iso))) out[who] = iso; };
  for (const [who, at] of Object.entries(prev && typeof prev === 'object' ? prev : {})) if (nowMs - ms(at) < 24 * 3_600_000) out[who] = at;
  if (!rows) {
    for (const record of recordsByKey?.values() ?? []) later(record?.who, record?.requestedAt);
    return out;
  }
  for (const r of rows) {
    if (/(^|; )resumed:/.test(String(r.result ?? ''))) later(recordsByKey?.get(r.key)?.who, new Date(nowMs).toISOString());
  }
  return out;
}

/**
 * Keep the loop child running for the daemon (R4): start it, restart it at most once per `minGapMs` if it dies, never
 * restart one that exited 0 on purpose (setting turned off), and stop it by its own PID. Spawn errors are logged,
 * never thrown (an unhandled child 'error' event would crash the daemon).
 */
export function superviseAwaitVerifyLoop({ spawnLoop = () => spawnAwaitVerifyLoop(), log = console, setTimer = setTimeout, now = Date.now, minGapMs = 60_000 } = {}) {
  let child = null;
  let stopped = false;
  let lastStart = 0;
  const start = () => {
    if (stopped) return null;
    lastStart = now();
    try { child = spawnLoop(); } catch (e) { child = null; log.error(`reconcile-fix-dispatch-daemon: await-verify loop spawn failed: ${String(e?.message ?? e)}`); }
    const mine = child;
    mine?.on?.('error', (e) => log.error(`reconcile-fix-dispatch-daemon: await-verify loop error: ${String(e?.message ?? e)}`));
    mine?.on?.('exit', (code) => {
      if (child === mine) child = null;
      if (stopped || code === 0) return;
      log.error(`reconcile-fix-dispatch-daemon: await-verify loop exited (${code}); the tick runs the pass until it is back`);
      const t = setTimer(start, Math.max(0, minGapMs - (now() - lastStart)));
      t?.unref?.();
    });
    return mine;
  };
  const stop = () => { stopped = true; try { child?.kill?.('SIGTERM'); } catch { /* already gone */ } };
  return { start, stop, current: () => child };
}
export const wokenJournalPath = (env = process.env) => join(resolveCoordinationRoot({ env }), 'await-verify-woken.json');
/** `{}` when the file does not exist yet, null when it exists but cannot be read or parsed. */
const readJson = (path) => {
  try { const v = JSON.parse(readFileSync(path, 'utf8')); return v && typeof v === 'object' ? v : null; } catch (e) { return e?.code === 'ENOENT' ? {} : null; }
};
const writeJsonAtomic = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(value)}\n`);
  renameSync(`${path}.${process.pid}.tmp`, path);
};

/** How recent a claim's heartbeat must be to count as a working session in the loop (> the longest tick gap seen, 30 min). */
export const WORKING_CLAIM_WINDOW_MINUTES = 60;
export const CYCLE_LOCK_RESOURCE = 'await-verify-cycle';
export const cycleLockRoot = (env = process.env) => join(resolveCoordinationRoot({ env }), 'await-verify-cycle-lock');
export const loopHeartbeatPath = (env = process.env) => join(resolveCoordinationRoot({ env }), 'await-verify-loop.json');

/** Run `fn` under the cross-process cycle lock; null when another cycle holds it. A dead holder is reclaimed at once. */
export async function withCycleLock(fn, { env = process.env, pid = process.pid, nowMs = Date.now() } = {}) {
  const root = cycleLockRoot(env);
  const owner = `${hostname()}:${pid}`;
  mkdirSync(root, { recursive: true });
  const got = reserve(root, CYCLE_LOCK_RESOURCE, owner, nowMs, new Date(nowMs).toISOString(), pid,
    (entry) => (Number.isInteger(entry?.pid) ? (isPidAlive(entry.pid) ? 'alive' : 'dead') : 'unknown'), 20);
  if (!got.ok) return null;
  try { return await fn(); } finally {
    const mine = readLockEntry(root, CYCLE_LOCK_RESOURCE);
    if (mine?.owner === owner) releaseLockDirIf(root, CYCLE_LOCK_RESOURCE, mine);
  }
}

/** The real cycle: verdict pass (R3-gated) + completion release (R5), under the lock. Never throws. */
export async function runAwaitVerifyCycleDefault({
  allowResume, env = process.env, settings = resolveFixerSlotSettings({ env }), passModule = null,
} = {}) {
  try {
    const out = await withCycleLock(async () => {
      const pass = passModule ?? await import('./await-verify-pass.mjs');
      const nowMs = Date.now();
      const ttlMs = resolveAwaitVerifyTtlMs(env);
      // The claim TTL (10 min) is refreshed only once per fix tick, and ticks run 7–30 min apart, so between ticks a working
      // session's claim reads "expired". Count working sessions over a window longer than any tick gap instead.
      const claims = listFixDispatchClaims(undefined, { liveOnly: true, leaseMinutes: WORKING_CLAIM_WINDOW_MINUTES });
      let resumeOk = allowResume;
      if (resumeOk === undefined) {
        // The tick passes its own auth gate; the loop asks only when there is a wait to act on.
        resumeOk = true;
        if (listStoredAwaitVerify().length) {
          const { planClaudeAuthDispatchGate } = await import('./claude-auth-health.mjs');
          try { resumeOk = !planClaudeAuthDispatchGate().paused; } catch { resumeOk = true; }
        }
      }
      const io = await pass.defaultAwaitVerifyIo();
      const recordsByKey = new Map(io.listRecords().map(({ key, record }) => [key, record]));
      // R5 needs the wake times: an unreadable journal, or one this cycle could not update, skips the release sweep
      // (fail closed — the claim then waits for the tick's own settled-claim sweep, as today).
      const journalPath = wokenJournalPath(env);
      const prevWoken = readJson(journalPath);
      let journalOk = prevWoken !== null;
      const stamped = nextWokenJournal(prevWoken ?? {}, { recordsByKey, nowMs });
      if (journalOk && JSON.stringify(stamped) !== JSON.stringify(prevWoken)) { try { writeJsonAtomic(journalPath, stamped); } catch { journalOk = false; } }
      const verdicts = await runSlotAwareAwaitPass({
        io, runPass: pass.runAwaitVerifyPass, allowResume: resumeOk, settings, claims, nowMs, ttlMs, cap: resolveFixDispatchMaxConcurrent({ env }),
      });
      const woken = nextWokenJournal(stamped, { rows: verdicts.rows, recordsByKey, nowMs: Date.now() });
      if (journalOk && JSON.stringify(woken) !== JSON.stringify(stamped)) { try { writeJsonAtomic(journalPath, woken); } catch { journalOk = false; } }
      let released = [];
      if (settings.releaseOnCompletion && journalOk) {
        released = runCompletionReleaseSweep({
          claims: listFixDispatchClaims(undefined, { liveOnly: true, leaseMinutes: 24 * 60 }), records: listStoredAwaitVerify(), readCompletion: tryReadCompletion,
          release: releaseFixDispatchClaim, woken,
          readClaim: (m) => readLockEntry(fixDispatchClaimRoot(), fixDispatchResource({ repo: m.repo, pr: m.pr, kind: m.kind })),
        });
      }
      const finished = new Map();
      for (const r of verdicts.rows ?? []) {
        const lane = recordsByKey.get(r.key)?.lane;
        if (!/pushed/.test(String(r.result ?? '')) || !lane) continue;
        try { finished.set(r.key, io.readMarker(lane)?.finishedAt ?? null); } catch { /* lag is diagnostics only */ }
      }
      return { ...verdicts, rows: annotatePushLag(verdicts.rows, finished, Date.now()), released };
    }, { env });
    return out ?? { rows: [], released: [], busy: true };
  } catch (error) {
    return { rows: [{ action: 'error', result: `error: ${String(error?.message ?? error).split('\n')[0]}` }], released: [] };
  }
}

/**
 * Add the push lag to every pushed row: how long after the verify gate finished the harness pushed. This is the number
 * the slice exists to shrink (2026-10-08 baseline: 12–19 min after verify ended). Pure.
 * @param {object[]} rows  pass rows
 * @param {Map<string,string|null>} finishedByKey  record key → the verify marker's `finishedAt`
 */
export function annotatePushLag(rows, finishedByKey, nowMs) {
  return (rows ?? []).map((r) => {
    const fin = ms(finishedByKey?.get(r.key));
    if (!/(^|; )pushed\b/.test(String(r.result ?? '')) || !Number.isFinite(fin)) return r;
    return { ...r, result: `${r.result} — pushed ${Math.max(0, Math.round((nowMs - fin) / 1000))}s after verify finished`, pushLagMs: Math.max(0, nowMs - fin) };
  });
}

/** One log line per released claim (R5). */
export function formatReleaseLines(result) {
  return (result?.released ?? []).map((r) => `released completed claim ${r.kind}-${r.pr} (${r.repo}) — completion record done at ${r.doneAt}`);
}

// ── the tick's entry (R4) ─────────────────────────────────────────────────────────────────────────────────────

export function readLoopHeartbeat({ env = process.env, read = readFileSync } = {}) {
  try { const h = JSON.parse(read(loopHeartbeatPath(env), 'utf8')); return h && typeof h === 'object' ? h : null; } catch { return null; }
}

/**
 * What the fix tick calls in place of the verdict pass. Every setting off → the unchanged pass (today). Otherwise R4
 * picks the runner: the tick skips when the loop is alive, and runs the same cycle itself when it is not.
 */
export async function runTickAwaitVerify({
  allowResume, env = process.env, nowMs = Date.now(), settings = resolveFixerSlotSettings({ env }),
  legacyPass, cycle = runAwaitVerifyCycleDefault, heartbeat = () => readLoopHeartbeat({ env }), alive = isPidAlive,
}) {
  if (!settings.awaitVerifyLoopSeconds && !settings.parkedReleasesSlot && !settings.releaseOnCompletion) return legacyPass({ allowResume });
  const hb = heartbeat();
  const r = awaitPassRunner({ loopSeconds: settings.awaitVerifyLoopSeconds, loopHeartbeatAtMs: hb && alive(hb.pid) ? ms(hb.at) : null, nowMs });
  if (r.runner === 'loop') return { rows: [], released: [], runner: 'loop' };
  return { ...(await cycle({ allowResume, env, settings })), runner: 'tick', runnerReason: r.reason };
}

// ── the daemon's child ────────────────────────────────────────────────────────────────────────────────────────

/** Start the loop as a child of the fix daemon when the setting is on; null otherwise. stdout/stderr go to the daemon's log. */
export function spawnAwaitVerifyLoop({ env = process.env, spawnFn = nodeSpawn, parentPid = process.pid, settings = resolveFixerSlotSettings({ env }) } = {}) {
  if (!(settings.awaitVerifyLoopSeconds > 0)) return null;
  return spawnFn(process.execPath, [SELF, `--parent-pid=${parentPid}`], { stdio: ['ignore', 'inherit', 'inherit'], env });
}

/** A cycle that threw before doing anything (the one top-level error row). Pure. */
export const cycleFailed = (result) => Boolean(result?.busy) || (result?.rows ?? []).some((r) => r?.action === 'error' && r.key === undefined);

const stamp = (line) => `${new Date().toISOString()} reconcile-fix-dispatch-daemon: ${line}\n`;

async function main(argv = process.argv.slice(2)) {
  const parentPid = Number((argv.find((a) => a.startsWith('--parent-pid=')) ?? '').split('=')[1]);
  const { formatAwaitVerifyLines } = await import('./await-verify-pass.mjs');
  const write = (line) => process.stderr.write(stamp(line));
  const sleep = (t) => new Promise((r) => { setTimeout(r, t); });
  let seconds = resolveFixerSlotSettings().awaitVerifyLoopSeconds;
  write(`await-verify-loop: started pid ${process.pid} (parent ${parentPid || 'none'}), every ${seconds}s`);
  let lastDeferred = '';
  for (;;) {
    const settings = resolveFixerSlotSettings();
    seconds = settings.awaitVerifyLoopSeconds;
    if (!(seconds > 0)) { write('await-verify-loop: setting off — exiting'); return; }
    if (Number.isInteger(parentPid) && parentPid > 0 && !isPidAlive(parentPid)) { write('await-verify-loop: parent gone — exiting'); return; }
    const t0 = Date.now();
    const result = await runAwaitVerifyCycleDefault({ settings });
    // The heartbeat says "a cycle completed", not just "the process is up": a cycle that fails, or cannot get the cycle
    // lock, every time lets it go stale, and the tick then runs the pass itself (R4 fallback).
    if (!cycleFailed(result)) {
      try { writeJsonAtomic(loopHeartbeatPath(), { pid: process.pid, parentPid, at: new Date().toISOString(), seconds }); } catch { /* stale → tick fallback */ }
    }
    const lines = formatAwaitVerifyLines(result).filter((l) => !/awaiting a verdict$/.test(l));
    const deferredLines = lines.filter((l) => l.includes('resume-deferred'));
    const key = deferredLines.join('\n');
    for (const l of lines) if (!deferredLines.includes(l) || key !== lastDeferred) write(`${l} [loop ${Date.now() - t0}ms]`);
    lastDeferred = key;
    for (const l of formatReleaseLines(result)) write(l);
    await sleep(seconds * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { process.stderr.write(stamp(`await-verify-loop: fatal: ${String(e?.message ?? e)}`)); process.exit(1); });
}
