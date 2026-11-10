/**
 * @file scripts/operations/heavy-queue-io.mjs
 * @description Card xb0iuxq (epic #4075, under #3383) — the IO shell for the `heavy-queue` operation. Every
 *   real read lives here, injectable exactly like `daemon-status-io.mjs`'s own shape:
 *
 *   1. `we:scripts/readiness/heavy-admission.mjs`'s own `admissionStatus` EXPORT — the module's exports, never a
 *      subprocess, per the card. That module already IS the single source of truth for who holds/waits on the
 *      pool; this file adds no second read of its lock files.
 *   2. `readLaneLease` (also re-exported by `heavy-admission.mjs`, not reimplemented) for each holder/waiter's
 *      OWN lane clone — the lease's `purpose`/`session` is the WHO the card asks for (e.g. `fix-2672`,
 *      `ci-heal-2636`, or a bare chat-session slug when no purpose was set).
 *   3. `ps -o command= -p <pid>` — the ONE new real read this operation needs, since neither a held slot's lock
 *      entry nor a waiting marker stores the command it is running/about to run (see `heavy-queue.mjs`'s own
 *      header for why the live pid's argv is the more truthful source anyway).
 *   4. `git -C <repo> merge-base --is-ancestor <sha> HEAD` — whether a repo's checked-out history already
 *      contains PR #2680 (the diff-driven default-gate cutover), memoized per repo path within one collection
 *      pass (several rows commonly share one repo).
 *
 * A repo that no longer exists, or a pid that has already exited, degrades to `null`/`false` rather than
 * throwing — a heavy-command holder/waiter can legitimately finish between the admission read and this
 * follow-up read, and a stale row should read as "unknown", never crash the whole report.
 */
import { join } from 'node:path';
import { readTailBytes } from './telemetry-summary-io.mjs';
import { execFileSync } from 'node:child_process';
import {
  admissionStatus, admissionLockRoot, resolveCap, readLaneLease, isRankableWaiter, resolveQueueBaseline, resolveFastSlots,
} from '../readiness/heavy-admission.mjs';
import { SELECTED_GATE_MERGE_SHA } from './heavy-queue.mjs';
import { redactCommandLine } from './command-redact.mjs';
import { probeForgeShare } from '../lib/forge-share.mjs';

/** The owner→repo derivation `heavy-admission.mjs#waiterRepo` already uses for a waiting marker with no
 *  explicit `repo` field — reused here (not reimplemented) for a HELD slot's owner, which never carries a
 *  `repo` field at all (`tryAcquireSlot`'s entries are `{owner, pid, heartbeatAt, meta}` only): `run`'s own
 *  owner is `<repo>#<pid>`, `verify-lane.mjs`'s is the bare repo path. */
export function repoFromOwner(owner) {
  return String(owner || '').replace(/#\d+$/, '');
}

/** Real `ps` read of a pid's full command line, or `null` when the pid is gone / unreadable / not an integer.
 *  Never throws — a vanished pid (the command finished between the admission read and this one) is exactly as
 *  legitimate as one that never existed.
 *
 *  SECURITY (#2692 independent review): argv is where credentials live on a dev host (`--token=…`, `curl -H
 *  'Authorization: Bearer …'`, a `postgres://user:pass@host` connection string, …), and this operation's
 *  `command` field is printed by `/queue`, returned by `--json`, and served by any HTTP adapter this operation
 *  is registered under — with no redaction step downstream of this function. `redactCommandLine` (the SAME
 *  gate `host-process-sample.mjs`'s telemetry already applies to this exact data class, #3383
 *  telemetry-granularity) is therefore applied HERE, at the one choke point every command string passes
 *  through, so a raw, unredacted command line is never even constructed — every caller downstream (the pure
 *  classifier, the JSON envelope, the skill's rendered table) only ever sees the masked form. */
export function readProcessCommand(pid, { exec = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = exec('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    const line = String(out).trim();
    return line ? redactCommandLine(line) : null;
  } catch { return null; }
}

/** Real `git merge-base --is-ancestor` check: does `repo`'s HEAD descend from `sha`? `false` on any failure
 *  (repo gone, not a git dir, unknown sha, detached with no such ancestry) — the conservative direction per
 *  `heavy-queue.mjs`'s own header (an unknown base reads as the OLD, unconditional-full-suite shape, which is
 *  the case this report exists to surface, never the quieter "assume modern"). */
export function gitIsAncestor(repo, sha, { exec = execFileSync } = {}) {
  if (!repo) return false;
  try {
    exec('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

/**
 * Build ONE raw row (held or waiting) — every field the pure `assessHeavyQueueRow` (`./heavy-queue.mjs`) needs,
 * already read; no classification happens here.
 * @returns {{owner:string, pid:number|null, repo:string|null, lane:string|null, lease:object|null,
 *   command:string|null, isSelectedBase:boolean|null, heartbeatAt?:string|null, requestedAt?:string|null}}
 */
function buildRawRow(entry, resolveRepo, { readCommand, isAncestorCached, readLease }) {
  const repo = resolveRepo(entry) || null;
  const lane = repo ? ((/lane-(\d+)/.exec(repo) || [])[1] ?? null) : null;
  const lease = repo ? readLease(repo) : null;
  const command = readCommand(entry.pid ?? null); // already redacted by `readProcessCommand`
  return {
    owner: entry.owner ?? null, pid: Number.isInteger(entry.pid) ? entry.pid : null, repo, lane, lease,
    command, isSelectedBase: repo ? isAncestorCached(repo) : null,
    heartbeatAt: entry.heartbeatAt ?? null, requestedAt: entry.requestedAt ?? null,
    // Card xkyw1x4 — the kind the admission code recorded (held slot `meta.kind`, waiting marker `kind`), if any.
    kind: entry.meta?.kind ?? entry.kind ?? null,
  };
}

/** Read the bounded diagnostic log; missing/torn/malformed records carry no count. */
function readRemoteFallbacks(lockRoot, nowMs) {
  const byReason = Object.create(null);
  let total = 0;
  try {
    for (const line of readTailBytes(join(lockRoot, 'remote-fallbacks.jsonl'), 1024 * 1024).split('\n')) {
      try {
        const row = JSON.parse(line), ts = Date.parse(row.ts);
        if (!Number.isFinite(ts) || ts < nowMs - 86400000 || ts > nowMs || typeof row.reason !== 'string' || !row.reason) continue;
        byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
        total++;
      } catch { /* skip malformed line */ }
    }
  } catch { /* no readable history yet */ }
  return {total, byReason};
}

/**
 * The real collector — the ONE function `run.mjs` binds to the `heavy-queue` operation's `collect` dep.
 * @param {{repo?:string, env?:NodeJS.ProcessEnv, now?:() => number, readAdmission?:Function,
 *   readCommand?:Function, isAncestor?:Function, readLease?:Function}} [o]
 */
export function collectHeavyQueue({
  repo = process.cwd(), env = process.env, now = () => Date.now(),
  readAdmission = admissionStatus, readCommand = readProcessCommand, isAncestor = gitIsAncestor,
  readLease = readLaneLease, isLiveWaiter = isRankableWaiter,
  // Card xkyw1x4 — the queue baseline behind "projected wait if you start now". `null` skips it (the report then
  // carries no `queueAdmission` section); a throw is swallowed the same way.
  readBaseline = resolveQueueBaseline,
} = {}) {
  const cap = resolveCap(env);
  const lockRoot = admissionLockRoot(repo, env);
  const nowMs = now();
  // Card xkyw1x4 — the fast-lane slots are added on top of the heavy cap, so the snapshot must include them.
  const status = readAdmission({ lockRoot, cap, nowMs, fastSlots: resolveFastSlots(env) });

  const ancestorCache = new Map();
  const isAncestorCached = (r) => {
    if (!ancestorCache.has(r)) ancestorCache.set(r, isAncestor(r, SELECTED_GATE_MERGE_SHA));
    return ancestorCache.get(r);
  };
  const seams = { readCommand, isAncestorCached, readLease };

  const held = status.held.map((h) => buildRawRow(h, (e) => repoFromOwner(e.owner), seams));
  // `live` uses the SAME rule the FCFS ranking uses, so a crashed/stale marker is still SHOWN but never
  // counted as a job ahead of a new arrival in the wait projection (PR #2692 review).
  const waiting = status.waiting.map((w) => ({
    ...buildRawRow(w, (e) => e.repo || repoFromOwner(e.owner), seams),
    live: isLiveWaiter(w, { nowMs }),
  }));

  let queue = null;
  if (typeof readBaseline === 'function') {
    try { queue = readBaseline({ lockRoot, cap, nowMs, env }); } catch { queue = null; }
  }

  return {
    observedAt: new Date(nowMs).toISOString(),
    cap: status.cap, fastSlots: status.fastSlots ?? 0, heldCount: status.heldCount, freeCount: status.freeCount, staleWaiting: status.staleWaiting,
    held, waiting, queue, remoteFallbacks: readRemoteFallbacks(lockRoot, nowMs),
    forgeShare: probeForgeShare({ lockRoot, now: nowMs }),
  };
}
