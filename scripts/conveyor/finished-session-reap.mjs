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
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { pidAlive as defaultPidAlive } from '../lib/pid-alive.mjs';
import { dispatchScratchRoot } from '../operations/dispatch-lane-io.mjs';
import { FIXING_KIND, isLiveFixClaim, repoKeyOf } from './fix-procedure.mjs';
import { fixDispatchClaimRoot, fixDispatchResource } from './fix-claim-store.mjs';
import { lockDirFor, readLockEntry } from '../readiness/file-locks.mjs';
import { stopSessionWithRetry } from './session-reaper.mjs';

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
 * IO, STRICT: the PR's live fix claim, `null` ONLY when confirmed absent or expired. `readLiveFixClaim` maps an
 * unreadable or corrupt `lock.json` to `null` (absent), which would fail OPEN here; this throws instead, so the
 * caller holds. Absent = `lock.json` reports ENOENT; any other read error, or a file that does not parse, throws.
 */
export function readLiveFixClaimStrict({ repo, pr, nowMs = Date.now(), lockRoot = fixDispatchClaimRoot(), readFile = readFileSync, readEntry = readLockEntry }) {
  const resource = fixDispatchResource({ repo: repoKeyOf(repo), pr: Number(pr), kind: FIXING_KIND });
  try { readFile(join(lockDirFor(lockRoot, resource), 'lock.json'), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new Error(`claim lock unreadable: ${e?.code ?? String(e?.message ?? e).split('\n')[0]}`);
  }
  const entry = readEntry(lockRoot, resource);
  if (!entry) throw new Error('claim lock present but unparseable');
  return isLiveFixClaim(entry, nowMs) ? entry : null;
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
  if (liveClaim) return hold(`a live fix claim is held on this PR (${liveClaim.meta?.who ?? liveClaim.meta?.sessionId ?? 'unknown holder'})`);
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
  readClaim = ({ repo, pr }) => readLiveFixClaimStrict({ repo, pr, nowMs }),
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
  return (result?.rows ?? []).map((r) => `finished-session-reap: ${r.repo ?? '?'} PR #${r.prNumber ?? '?'} pid ${r.pid ?? '?'} (${r.handle ?? 'no handle'}, ${r.cwd ?? '?'}) — ${r.decision ?? '?'}${r.result ? ` → ${r.result}` : ''} (${r.reason ?? 'no reason'})`);
}
