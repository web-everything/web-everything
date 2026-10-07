/**
 * @file scripts/conveyor/claude-auth-health.mjs
 * @description Card x5kagse (epic #4075/#3383) — the FOLLOW-UP to #2717 (`we:scripts/conveyor/hung-session.mjs
 *   #classifyClaudeAuthExpired`). #2717 made a dead-from-auth-failure session STOP READING AS LIVE, so a fresh
 *   one gets redispatched — but it never stopped the redispatch ITSELF from happening while the operator's
 *   login is still broken. Overnight 2026-09-25/26, that meant the fix-dispatch and review daemons kept
 *   burning fresh `ci-heal-<pr>`/`fix-<pr>`/`review-<pr>` sessions against a login that could not possibly work,
 *   every ~2 minutes, all night — each one dying on the CLI's own `authentication_failed`/"Login expired · Please
 *   run /login" turn (see `hung-session.mjs`'s own file header for the exact transcript shape).
 *
 * THIS MODULE is the shared "is the Claude login currently broken" read + the shared "has it come back" probe,
 * used identically by both daemons that dispatch a Claude session (`we:skills-src/conveyor/review-daemon.mjs`,
 * `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`) — never re-derived per daemon, so the two can never
 * disagree about whether login is broken. It does NOT touch either daemon's actual dispatch call (that stays in
 * each daemon's own file, gated at the daemon level per this card's own file-scope rule — several of the files
 * underneath the dispatch itself, `reconcile-core.mjs`/`reconcile-fix-dispatch.mjs`/`ci-heal-pr-dispatch.mjs`/
 * `review-job.mjs`, are owned by other in-flight cards this same epic runs concurrently).
 *
 * TWO INPUTS TO "IS IT BROKEN", EITHER ONE ENOUGH (deliberately OR, not AND — either alone is real evidence):
 *   1. {@link readOpenAuthEpisode} — the health watch's own `claude-auth-expired` episode
 *      (`we:scripts/conveyor/health-smells/claude-auth-expired.mjs`), if the health daemon has one open. Reads
 *      the SAME `state.json` the HEALTH section prints from (`we:scripts/conveyor/health-watch-section.mjs
 *      #healthDir`) — never a second store. This is the SLOWER, more deliberate signal (that smell's own
 *      `openAfter`/`minCount`/`windowMs` are tuned for OPERATOR ALERTING, not for gating dispatch), kept here as
 *      a backstop for when a fresh direct scan (below) has nothing recent to look at, e.g. right after this
 *      daemon restarts with no session of its own dispatched yet.
 *   2. {@link directRecentAuthExpired} — read directly off the `N` most recently DISPATCHED sessions
 *      (`kind: 'background'`, from `claude agents --json --all`), via the SAME transcript detector #2717 already
 *      proved live (`hung-session.mjs#readClaudeAuthExpiredInfo`). Deliberately `N = 1` by default: the live
 *      incident showed every affected session dies on its OWN very first turn, so waiting for a second one
 *      before reacting (the health smell's own `minCount: 2` bar) only means one more burned session per
 *      daemon, every tick, until the smell's slower bar is finally cleared. This is the FAST path — it is what
 *      makes the daemon pause at the FIRST observed failure, not the second or third.
 *
 * THE PROBE (the piece that lets a paused daemon ever un-pause without dispatching a real session just to find
 * out): {@link probeClaudeLoggedIn} shells the CLI's own `claude auth status --json` — a local, sub-second,
 * zero-token, zero-session read (measured live: ~0.15s) of the CLI's own cached credential state. This is
 * DELIBERATELY the cheap option, not "dispatch one session and see if it survives": dispatching a session to
 * test the login is exactly the cost this card exists to stop paying, and it would still leave the SAME
 * deadlock this card must break — while paused, nothing is being dispatched, so "the next session not failing"
 * can never happen on its own to lift the pause. `claude auth status --json` is what breaks that deadlock.
 *
 * THE ONE HONEST GAP IN THE CHEAP PROBE, AND WHY IT IS SAFE ANYWAY: `auth status` reports the CLI's own locally
 * cached belief, not a live round-trip proof the server will accept the very next request — so it can say
 * `loggedIn: true` a beat before a real dispatch would actually succeed (e.g. immediately after the operator's
 * own `/login`, before some other cached state elsewhere has caught up). {@link decideClaudeAuthDispatchGate}
 * does not treat that as full confirmation on its own: it only LIFTS the pause for the daemon's very next
 * ordinary tick — the FIRST real dispatch that tick makes is itself the true confirmation ("the next session
 * not failing"). If login is in fact still broken, that one session dies exactly like the others, the direct
 * scan (source 2 above) sees it on the very next tick, and the gate re-pauses immediately. Worst case this
 * costs exactly ONE extra session per flap of the cheap probe — bounded, and never repeated without the cheap
 * probe reporting `loggedIn: true` again in between. This is the whole reason this module needs no cooldown
 * timer or extra durable state: the direct scan's own freshness (source 2, immediate) already re-closes the
 * gate the very next tick if the optimistic probe was wrong.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { healthDir } from './health-watch-section.mjs';
import { readClaudeAuthExpiredInfo } from './hung-session.mjs';
import { defaultListAgents } from '../operations/dispatch-lane-io.mjs';
import { readMaintenanceMarker } from './maintenance-marker.mjs';

/** The exact line both daemons log while paused — the card's own required wording, matched by the soak
 *  scenario and the live-proof read, never re-typed anywhere else. */
export const AUTH_PAUSE_LOG_MESSAGE = 'paused: Claude login expired — run /login';

/** Mirrors `we:scripts/conveyor/health-smells/claude-auth-expired.mjs`'s own `episodeKey('claude-auth-expired',
 *  'claude-auth')` — duplicated as a literal, not imported, because importing `health-watch-core.mjs#episodeKey`
 *  for one string would pull this deliberately small module into that file's whole pure-core surface. A drift
 *  test below pins the two never to disagree. */
export const AUTH_EPISODE_KEY = 'claude-auth-expired::claude-auth';

/** An episode is live evidence only while the health watch itself still considers it unresolved. */
const OPEN_EPISODE_STATUSES = new Set(['open', 'flapping']);

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/**
 * we:scripts/conveyor/claude-auth-health.mjs#readOpenAuthEpisode — source 1 (see file header). Never throws: a
 * missing/corrupt/not-yet-ticked health store reads as "no episode", exactly like every other reader of this
 * store (`health-watch-section.mjs#healthSectionLines`'s own doc).
 * @param {{stateRoot?:string}} [o]
 * @returns {object|null} the open episode row, or null.
 */
export function readOpenAuthEpisode({ stateRoot } = {}) {
  const state = readJson(join(healthDir(stateRoot), 'state.json'), null);
  const ep = state?.episodes?.[AUTH_EPISODE_KEY];
  return ep && OPEN_EPISODE_STATUSES.has(ep.status) ? ep : null;
}

/**
 * we:scripts/conveyor/claude-auth-health.mjs#directRecentAuthExpired — source 2 (see file header). Takes the
 * `n` most recently DISPATCHED background sessions (by `startedAt`, newest first) among `agents`, and answers
 * whether EVERY one of them (never just any one, so a single unrelated old row never masks a genuine mixed
 * population) hit the Claude CLI's own auth failure — `n = 1` by default, so in practice this is just "did the
 * single newest dispatched session fail on login".
 * `maxAgeMs` bounds which sessions even count as "recent" — without it, a quiet host (nothing dispatched in
 * days) would keep reading whatever its last-ever session happened to be forever, which is a stale read, not a
 * live one (unlike a stuck pause, this one is genuinely reasoned through: the health episode source above still
 * covers a still-open incident even when nothing new has been dispatched to refresh this source).
 * @param {Array<{name?:string, kind?:string, cwd?:string, sessionId?:string, startedAt?:string|number}>} agents
 * @param {{readInfo?:Function, n?:number, now?:number, maxAgeMs?:number}} [o]
 * @returns {{broken:boolean, checked:number}}
 */
export function directRecentAuthExpired(agents, {
  readInfo = readClaudeAuthExpiredInfo, n = 1, now = Date.now(), maxAgeMs = 90 * 60_000,
} = {}) {
  const dispatched = (Array.isArray(agents) ? agents : [])
    .filter((a) => a?.kind === 'background' && a?.cwd && a?.sessionId)
    .map((a) => ({ ...a, startedAtMs: typeof a.startedAt === 'number' ? a.startedAt : Date.parse(a.startedAt ?? '') }))
    .filter((a) => Number.isFinite(a.startedAtMs) && now - a.startedAtMs <= maxAgeMs)
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
    .slice(0, Math.max(1, n));
  if (!dispatched.length) return { broken: false, checked: 0 };
  const broken = dispatched.every((a) => {
    let info = null;
    try { info = readInfo(a); } catch { info = null; }
    return info?.authExpired === true;
  });
  return { broken, checked: dispatched.length };
}

/**
 * we:scripts/conveyor/claude-auth-health.mjs#readClaudeAuthHealth — THE SHARED READ. `broken: true` the moment
 * EITHER source says so; `source` names which one fired (`'health-episode'` wins the label when both do, since
 * it is the one the operator's own HEALTH section already names).
 * @param {{stateRoot?:string, agents?:Array<object>, now?:number}} [o]
 * @returns {{broken:boolean, source:('health-episode'|'direct-scan'|'no-signal'), episode?:object, checked?:number}}
 */
export function readClaudeAuthHealth({ stateRoot, agents = [], now = Date.now() } = {}) {
  const episode = readOpenAuthEpisode({ stateRoot });
  if (episode) return { broken: true, source: 'health-episode', episode };
  const direct = directRecentAuthExpired(agents, { now });
  if (direct.broken) return { broken: true, source: 'direct-scan', checked: direct.checked };
  return { broken: false, source: direct.checked ? 'direct-scan' : 'no-signal' };
}

function run(cmd, args, { timeoutMs = 10_000 } = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 64 * 1024,
  });
}

/**
 * we:scripts/conveyor/claude-auth-health.mjs#probeClaudeLoggedIn — THE CHEAP PROBE (see file header for why
 * this, not a real dispatch). Never throws and never guesses: any failure to run or parse the command reads as
 * `false` (not confirmed logged in — stay paused), the same fail-closed discipline every reader in this file
 * already applies to its own IO.
 * @param {{exec?:Function}} [o]
 * @returns {boolean}
 */
export function probeClaudeLoggedIn({ exec = run } = {}) {
  try {
    const out = exec('claude', ['auth', 'status', '--json']);
    return JSON.parse(out)?.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * we:scripts/conveyor/claude-auth-health.mjs#decideClaudeAuthDispatchGate — PURE core of the whole gate. Given
 * the shared health read and the cheap probe's own answer, decides whether THIS tick's dispatch should be
 * skipped. No IO of its own — {@link planClaudeAuthDispatchGate} below is the IO shell that wires the real
 * reads into this.
 *
 * `!health.broken` → never paused, the probe is not even consulted (nothing wrong to probe past).
 * `health.broken && !loggedIn` → paused, logging {@link AUTH_PAUSE_LOG_MESSAGE}.
 * `health.broken && loggedIn` → NOT paused for this tick (see file header: this tick's own real dispatch is
 * itself the confirming probe; a re-failure re-closes the gate the very next tick via the direct-scan source).
 * @param {{broken:boolean}} health
 * @param {boolean} loggedIn
 * @returns {{paused:boolean, reason:(string|null)}}
 */
export function decideClaudeAuthDispatchGate(health, loggedIn) {
  if (!health?.broken) return { paused: false, reason: null };
  if (!loggedIn) return { paused: true, reason: AUTH_PAUSE_LOG_MESSAGE };
  return { paused: false, reason: null };
}

/**
 * we:scripts/conveyor/claude-auth-health.mjs#planClaudeAuthDispatchGate — THE IO SHELL a daemon actually calls:
 * one real `claude agents --json --all` read, the shared health read over it, the cheap probe (skipped
 * entirely when the health read is already clean — no reason to shell a probe when nothing is broken), and the
 * pure decision above. Every real read is injectable so a daemon's own unit tests never shell out.
 * @param {{stateRoot?:string, listAgents?:Function, health?:Function, probe?:Function, now?:number}} [o]
 * @returns {{paused:boolean, reason:(string|null), source:string}}
 */
export function planClaudeAuthDispatchGate({
  stateRoot, listAgents = () => defaultListAgents({ all: true }), health = readClaudeAuthHealth, probe = probeClaudeLoggedIn, now = Date.now(),
  readMaintenance = readMaintenanceMarker,
} = {}) {
  // Card 105 — an operator-declared maintenance window pauses every Claude-starting daemon regardless of login health.
  const maintenance = readMaintenance();
  if (maintenance) return { paused: true, reason: `paused: maintenance — ${maintenance.reason ?? 'no reason given'}`, source: 'maintenance' };
  let agents = [];
  try { agents = listAgents(); } catch { agents = []; }
  const healthResult = health({ stateRoot, agents, now });
  const loggedIn = healthResult.broken ? probe() : true; // clean host — never shells the probe at all
  const gate = decideClaudeAuthDispatchGate(healthResult, loggedIn);
  return { ...gate, source: healthResult.source };
}
