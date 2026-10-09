/**
 * @file scripts/lib/daemon-clone-registry.mjs
 * @description #xpt9fvd — the shared "is this path a DAEMON clone?" test both `guard-lane.mjs` (PreToolUse
 *   Edit/Write/NotebookEdit) and `guard-bash.mjs` (shell writes) need, so a resident daemon's OWN dedicated
 *   checkout gets the SAME #2123/#2749 protection a constellation PRIMARY checkout already has.
 *
 * WHY A DAEMON CLONE IS A THIRD KIND OF CHECKOUT, NOT A LANE AND NOT A PRIMARY. It is not a PRIMARY_REPOS
 * entry (`guard-lane.mjs`) — it lives at its own sibling path, never inside `webeverything/`. And it is not an
 * ordinary POOL LANE either, even though one of them (the WE drain's own clone) happens to sit under
 * `.lanes/` — `we:scripts/lib/daemon-rebuild.mjs` owns that clone exclusively (git resets/merges it every
 * rebuild tick, outside any lane lease), so the existing "inside `.lanes/` ⇒ freely writable" shortcut must
 * NOT swallow it. A hand-edit or hand-copy INSIDE a daemon clone goes over the daemon's own next rebuild
 * invisibly (no PR, no review) and — worse — a dirty clone BLOCKS that rebuild entirely (the rebuild's own
 * live-smoke gate refuses to run over an unexpected local diff) until a person notices and reverts it by
 * hand. Caught + reverted three times on 2026-09-26 (canary files, a ci-heal completion edit, earlier work)
 * before this guard existed.
 *
 * SEED + DERIVED, NOT SEED-ONLY. `DAEMON_CLONE_SEED` below names the daemon clones live TODAY (found from
 * their actual `~/Library/LaunchAgents/com.we.*.plist` / `com.plateau.drain-daemon.plist`
 * `WorkingDirectory`/`ProgramArguments`, not guessed) so the guard works from a fresh checkout with no state
 * on disk yet. But a NEW daemon clone that starts using the sanctioned overlay CLI
 * (`we:scripts/daemon-overlay.mjs add --clone=<path>`) is picked up AUTOMATICALLY, no code change required:
 * every clone that has ever taken an overlay leaves its OWN resolved root in its own
 * `~/.claude/daemon-overlays/<hash>.json`'s `clone` field (`we:scripts/lib/daemon-overlays.mjs#writeOverlays`
 * — the exact registry this module reads), so the union of (seed ∪ every `.clone` on disk) is the live list.
 * Both sources are plain path strings read via a couple of small, synchronous fs calls — no subprocess, same
 * fail-OPEN shape every other read these two guards do on every Edit/Write/Bash call already has.
 *
 * DELIBERATELY NOT SCANNED: launchd's own plists. They ARE the ultimate source of truth (used BY HAND to
 * derive the seed list below) but reading them needs a subprocess (`plutil`/binary-plist parsing) — exactly
 * the slow, environment-dependent I/O a PreToolUse hook that runs on every tool call must avoid. A launchd job
 * whose clone never registers an overlay is caught by the seed list until it does; see the card for the
 * residual this leaves (a hand-added daemon that never calls the overlay CLI stays unprotected until either
 * the seed list or the daemon's own first overlay catches up).
 */

import { readdirSync, readFileSync, realpathSync, unlinkSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const SEP = path.sep;

/**
 * Daemon-clone directory names, siblings of the constellation workspace root (the same parent
 * `guard-lane.mjs#workspaceRootOf` derives `PRIMARY_REPOS` against) — except the drain's own clone, which is
 * nested under `.lanes/` (see this file's header). Discovered 2026-09-26 from the live launchd registration:
 *   - `wev-fix-daemon`       — com.we.fix-dispatch-daemon (its OWN clone since 2026-10-07: sharing
 *                              `wev-review-daemon` made the two daemons' self-sync rebuilds starve each other
 *                              on the one clone lock; see skills-src/conveyor/launchd/com.we.fix-dispatch-daemon.plist.example)
 *   - `wev-review-daemon`    — com.we.review-daemon, lease-reaper,
 *                              lane-pool-health-watch-{we,frontierui,plateau-app}, parked-pr-conflict-watch-*
 *   - `wev-merge-daemon`     — com.we.conveyor-pass-daemon.merge-orphan-sweep
 *   - `wev-health-watch`     — com.we.health-watch
 *   - `wev-host-sampler`     — com.webeverything.host-sampler, com.webeverything.claude-otel-collector
 *   - `plateau-drain-daemon` — com.plateau.drain-daemon
 *   - `.lanes/we-drain-daemon/lane-1` — the WE drain's own dedicated clone (docs/agent/platform-decisions.md
 *     #resident-daemon-reload-lifecycle) — NOT a pool lane: never leased/refreshed like one, rebuilt the same
 *     way every other daemon clone is.
 *   - `.lanes/we-drain-daemon/code` — the WE drain's CODE clone (the checkout the drain daemon runs its scripts
 *     from, the drain lib's `weCodeClone`). Missing from this list until 2026-10-09, so the overlay CLI's prune
 *     read it as "under the lane pool" and deleted every overlay registered on it (#4717/#4715 never loaded).
 */
export const DAEMON_CLONE_SEED = [
  'wev-review-daemon',
  'wev-fix-daemon',
  'wev-merge-daemon',
  'wev-health-watch',
  'wev-health-responder',
  'wev-host-sampler',
  'plateau-drain-daemon',
  `.lanes${SEP}we-drain-daemon${SEP}lane-1`,
  `.lanes${SEP}we-drain-daemon${SEP}code`,
];

/**
 * PURE: is `real` a POOL LANE (or inside one)? A pool lane is ONLY a numbered lane directly inside a pool repo
 * dir — `<workspace>/.lanes/<repo>/lane-<N>` (same `lane-\d+` shape `lane-pool-scan.mjs#laneIndicesIn` uses).
 * Being anywhere under `.lanes/` is NOT enough: daemon clones (`we-drain-daemon/code`) and other non-pool
 * checkouts live there too. Seed roots are checked BEFORE this, so the seeded `we-drain-daemon/lane-1` wins.
 * @param {string} real  resolved path
 * @param {string} workspace
 * @returns {boolean}
 */
export function isPoolLaneRealpath(real, workspace) {
  if (!real) return false;
  const pool = path.join(realpathOrResolve(workspace), '.lanes');
  const rel = path.relative(pool, String(real));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(SEP);
  return parts.length >= 2 && /^lane-\d+$/.test(parts[1]);
}

function realpathOrResolve(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

function overlayDirOf(env = process.env) {
  return (typeof env?.WE_DAEMON_OVERLAY_DIR === 'string' && env.WE_DAEMON_OVERLAY_DIR.trim())
    || path.join(homedir(), '.claude', 'daemon-overlays');
}

function seedRoots(workspace) {
  return DAEMON_CLONE_SEED.map((rel) => realpathOrResolve(path.join(workspace, rel)));
}

/**
 * THE ONE PREDICATE (item 116). Does an overlay-state record make its `.clone` a daemon clone? Only when it is
 * a known daemon clone (a seed root) OR it carries a non-empty overlay list — AND it is not a numbered POOL LANE
 * (`<workspace>/.lanes/<repo>/lane-<N>`, see `isPoolLaneRealpath`; seed roots excepted). Other dirs under `.lanes/`
 * (the drain's clones) are not pool lanes. A stale record
 * (empty list, or a pool lane such as one leaked by an old overlay `add`) therefore NEVER protects its path,
 * so `guard-lane` cannot lock an ordinary leased lane out of its own edits.
 * PURE. Returns `{live:true}` or `{live:false, reason}`.
 * @param {{clone?:unknown, overlays?:unknown}|null} record  parsed state file
 * @param {string} workspace
 * @returns {{live:boolean, reason?:string}}
 */
export function classifyOverlayRecord(record, workspace) {
  if (!record || typeof record.clone !== 'string' || !record.clone) return { live: false, reason: 'no clone path' };
  const real = realpathOrResolve(record.clone);
  if (isDaemonCloneRealpath(real, seedRoots(workspace))) return { live: true };
  if (isPoolLaneRealpath(real, workspace)) return { live: false, reason: `path is a numbered lane in the lane pool (${path.join(realpathOrResolve(workspace), '.lanes')}/<repo>/lane-<N>); a pool lane is never a daemon clone` };
  if (!Array.isArray(record.overlays) || record.overlays.length === 0) return { live: false, reason: 'empty overlay list and not a known daemon clone' };
  return { live: true };
}

function readRecords(env) {
  const dir = overlayDirOf(env);
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue; // skips the sibling `.events.jsonl` audit trail too
    try {
      const file = path.join(dir, name);
      out.push({ file, record: JSON.parse(readFileSync(file, 'utf8')) });
    } catch { /* corrupt/partial file — skip it, fail-open */ }
  }
  return out;
}

/** Clones recorded by LIVE overlay-state records only (see `classifyOverlayRecord`). Fail-open, additive. */
function overlayRegisteredClones(workspace, env = process.env) {
  return readRecords(env)
    .filter(({ record }) => classifyOverlayRecord(record, workspace).live)
    .map(({ record }) => record.clone);
}

/**
 * Self-heal: drop every stale overlay-state record (the `.json`; the `.events.jsonl` audit trail is kept and
 * gets a `stale-record-dropped` line carrying the reason). Called by the overlay CLI. Never throws.
 * @returns {Array<{file:string, clone:string, reason:string}>} what was dropped
 */
export function pruneStaleOverlayRecords(workspace, { env = process.env, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const dropped = [];
  for (const { file, record } of readRecords(env)) {
    const c = classifyOverlayRecord(record, workspace);
    if (c.live) continue;
    try {
      unlinkSync(file);
      const entry = { file, clone: record?.clone ?? null, reason: c.reason };
      dropped.push(entry);
      try { appendFileSync(file.replace(/\.json$/, '.events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event: 'stale-record-dropped', clone: entry.clone, reason: entry.reason }) + '\n'); } catch { /* audit best-effort */ }
      log(`daemon-overlay: dropped stale record ${path.basename(file)} (${entry.clone}): ${entry.reason}`);
    } catch { /* fail-open */ }
  }
  return dropped;
}

/**
 * The full daemon-clone registry: seed roots (resolved against `workspace`) UNION every clone the overlay
 * state directory has ever recorded, each realpath'd (or plain-resolved if not yet materialized) and deduped.
 * Cheap and synchronous — a readdir plus a handful of small JSON reads, paid once per guard invocation.
 * @param {string} workspace  the shared parent dir every constellation checkout + `.lanes/` sits under
 * @param {{env?: NodeJS.ProcessEnv}} [o]
 * @returns {string[]} deduped, realpath'd (or resolved) daemon clone roots
 */
export function daemonCloneRoots(workspace, { env = process.env } = {}) {
  const seeded = DAEMON_CLONE_SEED.map((rel) => path.join(workspace, rel));
  const discovered = overlayRegisteredClones(workspace, env);
  const all = seeded.concat(discovered).map(realpathOrResolve);
  return Array.from(new Set(all));
}

/**
 * PURE: is `real` (an already-resolved real/absolute path) inside any daemon clone root? Mirrors
 * `guard-lane.mjs`'s primary-prefix test (`(real + SEP).startsWith(root + SEP)`, or exact equality).
 * @param {string} real
 * @param {string[]} roots
 * @returns {boolean}
 */
export function isDaemonCloneRealpath(real, roots) {
  if (!real) return false;
  const r = String(real);
  return (roots || []).some((root) => root && (r === root || (r + SEP).startsWith(root.endsWith(SEP) ? root : root + SEP)));
}
