/**
 * @file scripts/conveyor/finished-session-reap.mjs
 * @description Stop a fixer session that kept running after its fix claim was released.
 *
 * LIVE CASE 2026-10-21 13:24Z (#5758, #5729, #5485). Reconcile logged `released-claim-session-ignored` for live pids
 * under `.operations/dispatch/<uuid>`: the fixer posted `🔓 fix-end` at the PR's head and no new claim was taken, so
 * the pass rightly treats the pid as finished work (PR #5492). But nothing ever stopped those sessions, so they kept
 * holding CPU and their dispatch dirs.
 *
 * WHAT THIS DOES. For each `released-claim-session-ignored` note whose session has outlived the release by more than
 * `finishedSessionReap.afterMinutes` (default 10), stop it the same way every session reaper here does:
 * `claude stop <listing id>` through `we:scripts/conveyor/session-reaper.mjs#stopSessionWithRetry` (which ends AND
 * deregisters the job; a raw kill would leave it resumable). Never `pkill`, never a pid signal.
 *
 * NEVER WEAKENED. The note itself exists only when the claim-release liveness rule says so
 * (`reconcile-core.mjs#isReleasedClaimSession`: latest trusted fix marker is a fix-END at the current head, session
 * started before it, not a reviewer, not on a permission prompt). On top of that this holds (never stops) when:
 *   - the note has no fix-end time, no listing handle, or no pid;
 *   - its cwd is not inside the dispatch scratch root (`<workspace>/.operations/dispatch/<id>`) — a lane, a checkout
 *     or the operator's own session is never touched;
 *   - the local fix-claim store holds a LIVE claim on that PR, or cannot be read (fail closed);
 *   - the pid is no longer alive on a fresh probe (nothing to stop);
 *   - it has not yet outlived the release by `afterMinutes`.
 *
 * SETTING (policy cascade, source logged once per daemon): `finishedSessionReap` = `{ enabled, afterMinutes }`.
 * standard `{ enabled: true, afterMinutes: 10 }` → platform preference → `scripts/settings/finished-session-reap.json`
 * → env `WE_FINISHED_SESSION_REAP` (`0` = report only) / `WE_FINISHED_SESSION_REAP_MINUTES`.
 *
 * PURE core: {@link planFinishedSessionReap}. IO shell: {@link runFinishedSessionReap}.
 */
import { statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { pidAlive as defaultPidAlive } from '../lib/pid-alive.mjs';
import { dispatchScratchRoot } from '../operations/dispatch-lane-io.mjs';
import { FIXING_KIND, repoKeyOf } from './fix-procedure.mjs';
import { fixDispatchClaimRoot, fixDispatchResource } from './fix-claim-store.mjs';
import { lockDirFor, readLockEntry } from '../readiness/file-locks.mjs';
import { stopSessionWithRetry } from './session-reaper.mjs';
import { execFileSync } from 'node:child_process';
import { defaultListAgents } from '../operations/dispatch-lane-io.mjs';
import { isAwaitingPermission, startedAtMs } from './reconcile-core.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from './fix-procedure.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { parseSessionSlug } from './session-slug.mjs';

export const FINISHED_SESSION_REAP_POLICY = 'finishedSessionReap';
export const FINISHED_SESSION_NOTE_KIND = 'released-claim-session-ignored';
export const FINISHED_SESSION_REAP_STANDARD = Object.freeze({ enabled: true, afterMinutes: 10 });

const MINUTE = 60_000;

const validMinutes = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 24 * 60;
const validBool = (v) => typeof v === 'boolean';

function envMinutes(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : s; // a non-number reaches the validator and is named `invalid`
}
function envEnabled(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (s === '0' || s === 'false' || s === 'off') return false;
  if (s === '1' || s === 'true' || s === 'on') return true;
  return s;
}

/**
 * IO: the effective settings and where each leaf came from. Never throws.
 * @returns {{enabled:boolean, afterMs:number, afterMinutes:number, sources:Record<string,string>}}
 */
export function resolveFinishedSessionReapSettings({ env = process.env, file = null, log } = {}) {
  let tool;
  try { tool = (file ?? readSettings())?.[FINISHED_SESSION_REAP_POLICY]; } catch { tool = undefined; }
  const r = cascadePolicy(FINISHED_SESSION_REAP_POLICY, tool, {
    standard: { ...FINISHED_SESSION_REAP_STANDARD },
    envValues: { enabled: envEnabled(env?.WE_FINISHED_SESSION_REAP), afterMinutes: envMinutes(env?.WE_FINISHED_SESSION_REAP_MINUTES) },
    valid: { enabled: validBool, afterMinutes: validMinutes },
    env,
    ...(log ? { log } : {}),
  });
  const v = r.value ?? {};
  const afterMinutes = validMinutes(v.afterMinutes) ? v.afterMinutes : FINISHED_SESSION_REAP_STANDARD.afterMinutes;
  return { enabled: v.enabled !== false, afterMinutes, afterMs: afterMinutes * MINUTE, sources: r.sources ?? {} };
}

/**
 * IO, STRICT: is there ANY fix-claim lock on this PR? Returns `null` ONLY when the claim's lock DIR is confirmed absent
 * (ENOENT). A released claim's lock dir is removed (`fix-procedure.mjs#releaseFixClaim` → `releaseLockDir`), so a
 * finished session has none. Any lock that exists — live, expired, unparseable, odd timestamps, unreadable
 * heartbeat — is returned (or throws) and the caller HOLDS: lease interpretation is never trusted to prove
 * absence here (`readLiveFixClaim` maps corrupt/unreadable/expired-looking entries to `null`, which fails open).
 */
export function readLiveFixClaimStrict({ repo, pr, lockRoot = fixDispatchClaimRoot(), stat = statSync, readEntry = readLockEntry }) {
  const resource = fixDispatchResource({ repo: repoKeyOf(repo), pr: Number(pr), kind: FIXING_KIND });
  // The lock DIR, not lock.json: acquisition reserves the dir before writing the file, so a dir with no file yet is
  // a claim being taken right now (Codex audit round 3). Only a confirmed-absent dir means "no claim".
  try { stat(lockDirFor(lockRoot, resource)); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new Error(`claim lock unreadable: ${e?.code ?? String(e?.message ?? e).split('\n')[0]}`);
  }
  let entry = null;
  try { entry = readEntry(lockRoot, resource); } catch { entry = null; }
  if (!entry) throw new Error('claim lock dir present without a readable entry (being acquired, or unparseable)');
  return entry; // present at all = held for this purpose, expired or not
}

/** Is `cwd` a direct-or-deeper child of `root` (never `root` itself)? */
export function isUnderRoot(cwd, root) {
  if (!cwd || !root) return false;
  const c = resolve(String(cwd));
  const r = resolve(String(root));
  return c.startsWith(r + sep) && c.length > r.length + 1;
}

/**
 * PURE: reap or hold ONE note.
 * @param {{note:object, nowMs:number, afterMs:number, dispatchRoot:string,
 *   liveClaim:(object|null|undefined), claimReadError?:(string|null), pidAlive:(boolean|null)}} o
 *   `liveClaim` — the PR's live local fix claim (null = none). `claimReadError` set = unreadable (fail closed).
 * @returns {{decision:'reap'|'hold', reason:string}}
 */
export function planFinishedSessionReap({ note, nowMs, afterMs, dispatchRoot, liveClaim = null, claimReadError = null, pidAlive = null }) {
  const hold = (reason) => ({ decision: 'hold', reason });
  if (note?.kind !== FINISHED_SESSION_NOTE_KIND) return hold(`not a ${FINISHED_SESSION_NOTE_KIND} note`);
  if (!Number.isFinite(note.releasedAtMs)) return hold('no fix-end time on the note');
  if (!String(note.handle ?? '').trim()) return hold('no session handle in the listing');
  if (!Number.isInteger(note.pid)) return hold('no pid');
  if (!isUnderRoot(note.cwd, dispatchRoot)) return hold(`cwd ${note.cwd ?? '?'} is not a dispatch dir under ${dispatchRoot}`);
  if (claimReadError) return hold(`fix-claim store unreadable (${claimReadError}) — held`);
  if (liveClaim) return hold(`a fix claim lock exists on this PR (${liveClaim.meta?.who ?? liveClaim.meta?.sessionId ?? 'unknown holder'})`);
  if (pidAlive !== true) return hold(pidAlive === false ? 'pid already exited' : 'pid could not be probed');
  const ageMs = nowMs - note.releasedAtMs;
  if (!(ageMs >= afterMs)) return hold(`alive ${Math.max(0, Math.round(ageMs / MINUTE))}m after fix-end (< ${Math.round(afterMs / MINUTE)}m)`);
  return { decision: 'reap', reason: `alive ${Math.round(ageMs / MINUTE)}m after fix-end at ${String(note.head ?? '').slice(0, 9)}, no claim held` };
}

/**
 * IO: plan and (unless `dryRun` or disabled) stop every finished session in `notes`. Never throws.
 * @returns {{enabled:boolean, afterMinutes:number, rows:Array<object>}}
 */
export function runFinishedSessionReap({
  notes = [], nowMs = Date.now(), dryRun = false, env = process.env,
  settings = resolveFinishedSessionReapSettings({ env }),
  dispatchRoot = null,
  readClaim = ({ repo, pr }) => readLiveFixClaimStrict({ repo, pr }),
  probePid = (pid) => { try { return defaultPidAlive(pid); } catch { return null; } },
  stop = stopSessionWithRetry,
} = {}) {
  const rows = [];
  const mine = (Array.isArray(notes) ? notes : []).filter((n) => n?.kind === FINISHED_SESSION_NOTE_KIND);
  if (!mine.length) return { enabled: settings.enabled, afterMinutes: settings.afterMinutes, rows };
  let root = dispatchRoot;
  try { if (!root) root = dispatchScratchRoot({ env }); } catch { root = null; }
  const seen = new Set();
  for (const note of mine) {
    const key = `${note.repo ?? ''}#${note.prNumber}:${note.handle ?? note.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { repo: note.repo ?? null, prNumber: note.prNumber ?? null, pid: note.pid ?? null, handle: note.handle ?? null, cwd: note.cwd ?? null };
    rows.push(row);
    try {
      let liveClaim = null;
      let claimReadError = null;
      try { liveClaim = readClaim({ repo: note.repo, pr: note.prNumber }); } catch (e) { claimReadError = String(e?.message ?? e).split('\n')[0]; }
      const plan = planFinishedSessionReap({
        note, nowMs, afterMs: settings.afterMs, dispatchRoot: root, liveClaim, claimReadError,
        pidAlive: Number.isInteger(note.pid) ? probePid(note.pid) : null,
      });
      Object.assign(row, plan);
      if (plan.decision !== 'reap') continue;
      if (!settings.enabled) { row.result = 'report-only (finishedSessionReap.enabled=false)'; continue; }
      if (dryRun) { row.result = 'dry-run (would stop)'; continue; }
      const s = stop({ handle: note.handle });
      row.result = s?.alreadyGone ? 'already-gone' : 'stopped';
    } catch (e) {
      row.result = `stop-failed: ${String(e?.message ?? e).split('\n')[0]}`;
    }
  }
  return { enabled: settings.enabled, afterMinutes: settings.afterMinutes, rows };
}

/** One log line per finished session considered. */
export function formatFinishedSessionReapLines(result) {
  return (result?.rows ?? []).map((r) => `finished-session-reap${r.unbound ? ' (unbound)' : ''}: ${r.repo ?? '?'} PR #${r.prNumber ?? '?'} pid ${r.pid ?? '?'} (${r.handle ?? 'no handle'}, ${r.cwd ?? '?'}) — ${r.decision ?? '?'}${r.result ? ` → ${r.result}` : ''} (${r.reason ?? 'no reason'})`);
}

// ── UNBOUND finished sessions (live 2026-10-21 14:25Z) ─────────────────────────────────────────────────────────────
// The note path above only sees sessions reconcile still BINDS to an OPEN PR at its current head. Two survived it:
// pid 95540 (`fix-5492`, PR #5492 CLOSED) and pid 98331 (`fix-5729`, PR #5729 open, head moved past its lane so it no
// longer binds). This pass walks the session LISTING instead and reads the PR named by the session's own slug.
// Same safety rules: dispatch dir only, stop by listing id, any claim lock dir holds, plus ONE of
//   - the PR is CLOSED/MERGED for at least `afterMinutes`; or
//   - the PR's latest trusted fix marker is a fix-END posted after the session started, at least `afterMinutes` ago
//     (a later fix-begin = a claim is held again → hold; equal or unreadable timestamps → hold).

/** Session kinds that hold a fix claim (the only ones this reaps). Reviewers hold none and are never touched. */
export const UNBOUND_REAP_KINDS = Object.freeze(['fix', 'ci-heal']);
/** At most this many PR reads per tick (one `gh pr view` each). */
export const UNBOUND_MAX_PR_READS = 10;

/** PURE: does this listing row qualify for a PR read at all? */
export function unboundCandidate(agent, { dispatchRoot, parseSlug }) {
  if (!agent || !Number.isInteger(agent.pid) || !String(agent.id ?? '').trim()) return null;
  if (String(agent.state ?? '').toLowerCase() !== 'done') return null; // the listing itself says finished
  if (isAwaitingPermission(agent)) return null;
  if (!isUnderRoot(agent.cwd, dispatchRoot)) return null;
  let parsed = null;
  try { parsed = parseSlug(agent.name); } catch { parsed = null; }
  if (!parsed || parsed.itemKind || !UNBOUND_REAP_KINDS.includes(parsed.kind)) return null;
  const pr = Number(parsed.id);
  if (!Number.isInteger(pr) || pr <= 0 || !parsed.repo) return null;
  return { repo: parsed.repo, pr };
}

/**
 * PURE: reap or hold ONE unbound session, given its PR as `gh pr view --json state,closedAt,mergedAt,comments` reads it.
 * @returns {{decision:'reap'|'hold', reason:string}}
 */
export function planUnboundFinishedSession({ agent, pr, nowMs, afterMs, dispatchRoot, liveClaim = null, claimReadError = null, pidAlive = null }) {
  const hold = (reason) => ({ decision: 'hold', reason });
  if (!isUnderRoot(agent?.cwd, dispatchRoot)) return hold('not a dispatch dir');
  if (!String(agent?.id ?? '').trim()) return hold('no session handle in the listing');
  if (isAwaitingPermission(agent)) return hold('blocked on a permission prompt');
  if (!pr || typeof pr !== 'object') return hold('PR unreadable');
  if (claimReadError) return hold(`fix-claim store unreadable (${claimReadError}) — held`);
  if (liveClaim) return hold(`a fix claim lock exists on this PR (${liveClaim.meta?.who ?? liveClaim.meta?.sessionId ?? 'unknown holder'})`);
  if (pidAlive !== true) return hold(pidAlive === false ? 'pid already exited' : 'pid could not be probed');
  const minutes = (ms) => Math.max(0, Math.round(ms / MINUTE));
  const state = String(pr.state ?? '').toUpperCase();
  if (state === 'CLOSED' || state === 'MERGED') {
    const closedMs = Date.parse(pr.mergedAt || pr.closedAt || '');
    if (!Number.isFinite(closedMs)) return hold(`PR ${state} with no readable close time`);
    if (!(nowMs - closedMs >= afterMs)) return hold(`PR ${state} ${minutes(nowMs - closedMs)}m ago (< ${minutes(afterMs)}m)`);
    return { decision: 'reap', reason: `PR ${state} ${minutes(nowMs - closedMs)}m ago, no claim held` };
  }
  if (state !== 'OPEN') return hold(`PR state ${state || 'unknown'}`);
  const started = startedAtMs(agent.startedAt);
  if (!Number.isFinite(started)) return hold('session start time unreadable');
  const markers = (Array.isArray(pr.comments) ? pr.comments : [])
    .filter((c) => isTrustedMarkerAuthor(c) && typeof c?.body === 'string')
    .map((c) => ({ body: c.body.trimStart(), at: Date.parse(c.createdAt) }))
    .filter((m) => m.body.startsWith(FIX_BEGIN_MARKER) || m.body.startsWith(FIX_END_MARKER));
  if (!markers.length) return hold('no fix marker on the PR');
  if (markers.some((m) => !Number.isFinite(m.at))) return hold('a fix marker has an unreadable time');
  markers.sort((a, b) => a.at - b.at);
  const last = markers.at(-1);
  if (markers.length > 1 && markers.at(-2).at === last.at) return hold('ambiguous marker order');
  if (!last.body.startsWith(FIX_END_MARKER)) return hold('latest fix marker is a fix-begin (claim held)');
  if (!(started < last.at)) return hold('session started after the latest fix-end (new work)');
  if (!(nowMs - last.at >= afterMs)) return hold(`alive ${minutes(nowMs - last.at)}m after fix-end (< ${minutes(afterMs)}m)`);
  return { decision: 'reap', reason: `alive ${minutes(nowMs - last.at)}m after the PR's latest fix-end, no claim held` };
}

/** IO: read one PR for the unbound pass. Throws on any failure (the caller holds). */
export function defaultReadPrForReap({ repo, pr, exec = execFileSync }) {
  const slug = CONSTELLATION_REPOS[repo]?.slug ?? repo;
  const out = exec('gh', ['pr', 'view', String(pr), '--repo', slug, '--json', 'state,closedAt,mergedAt,comments'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL',
  });
  return JSON.parse(String(out));
}

/**
 * IO: the unbound pass. `skipPids` — pids the note path already judged this tick. Never throws.
 * @returns {{enabled:boolean, rows:Array<object>, error?:string}}
 */
export function runUnboundFinishedSessionReap({
  skipPids = new Set(), nowMs = Date.now(), dryRun = false, env = process.env,
  settings = resolveFinishedSessionReapSettings({ env }),
  dispatchRoot = null,
  listAgents = () => defaultListAgents({ all: true }),
  readPr = defaultReadPrForReap,
  readClaim = ({ repo, pr }) => readLiveFixClaimStrict({ repo, pr }),
  probePid = (pid) => { try { return defaultPidAlive(pid); } catch { return null; } },
  stop = stopSessionWithRetry,
  parseSlug = parseSessionSlug,
  maxPrReads = UNBOUND_MAX_PR_READS,
} = {}) {
  const rows = [];
  let root = dispatchRoot;
  try { if (!root) root = dispatchScratchRoot({ env }); } catch { root = null; }
  if (!root) return { enabled: settings.enabled, rows, error: 'dispatch root unresolved' };
  let agents;
  try { agents = listAgents(); } catch (e) { return { enabled: settings.enabled, rows, error: `listing failed: ${String(e?.message ?? e).split('\n')[0]}` }; }
  const prCache = new Map();
  let reads = 0;
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (skipPids.has(agent?.pid)) continue;
    const cand = unboundCandidate(agent, { dispatchRoot: root, parseSlug });
    if (!cand) continue;
    const alive = probePid(agent.pid);
    if (alive !== true) continue; // an exited listing row needs nothing (and costs no PR read)
    const row = { repo: cand.repo, prNumber: cand.pr, pid: agent.pid, handle: agent.id, cwd: agent.cwd, unbound: true };
    rows.push(row);
    try {
      const key = `${cand.repo}#${cand.pr}`;
      let pr = prCache.get(key);
      if (pr === undefined) {
        if (reads >= maxPrReads) { Object.assign(row, { decision: 'hold', reason: `PR read budget (${maxPrReads}/tick) spent` }); continue; }
        reads += 1;
        try { pr = readPr({ repo: cand.repo, pr: cand.pr }); } catch { pr = null; }
        prCache.set(key, pr);
      }
      let liveClaim = null;
      let claimReadError = null;
      try { liveClaim = readClaim({ repo: cand.repo, pr: cand.pr }); } catch (e) { claimReadError = String(e?.message ?? e).split('\n')[0]; }
      const plan = planUnboundFinishedSession({ agent, pr, nowMs, afterMs: settings.afterMs, dispatchRoot: root, liveClaim, claimReadError, pidAlive: alive });
      Object.assign(row, plan);
      if (plan.decision !== 'reap') continue;
      if (!settings.enabled) { row.result = 'report-only (finishedSessionReap.enabled=false)'; continue; }
      if (dryRun) { row.result = 'dry-run (would stop)'; continue; }
      const s = stop({ handle: agent.id });
      row.result = s?.alreadyGone ? 'already-gone' : 'stopped';
    } catch (e) {
      row.result = `stop-failed: ${String(e?.message ?? e).split('\n')[0]}`;
    }
  }
  return { enabled: settings.enabled, rows };
}
