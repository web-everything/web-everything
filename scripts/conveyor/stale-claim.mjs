/**
 * @file scripts/conveyor/stale-claim.mjs
 * @description Stale fix-claim pass (#3383 prototype), PURE core. A fix / ci-heal / review dispatch claim keeps a PR
 *   out of the dispatcher while it is held. When the owning session is finished (done, stopped, dead, or idle past
 *   a threshold) AND nothing was pushed to the PR for `pushQuietMinutes`, the claim only blocks a fresh fixer. This
 *   core decides, per claim, whether to release it, then (act mode only) calls the injected release and rearm
 *   functions. Report mode (the default) only records what it WOULD release.
 *
 *   Safety rules, in order: an unknown owner listing never releases; an alive and active owner never releases; a push
 *   inside the quiet window never releases; a closed PR is left to the other reapers. No fs, gh, clock or spawn here:
 *   every effect is injected (see `stale-claim-io.mjs`).
 */

export const STALE_CLAIM_EVENT = 'stale-claim-released';
export const STALE_CLAIM_MODES = Object.freeze(['report', 'act']);
export const STALE_CLAIM_DEFAULTS = Object.freeze({ mode: 'report', pushQuietMinutes: 30, idleMinutes: 30 });
/** Claim kinds this pass inspects. `clear-claim` itself only accepts fix and ci-heal; a review claim is reported and
 *  its release is attempted through the same path (which refuses it, so it is logged `release-failed`). */
export const STALE_CLAIM_KINDS = Object.freeze(['fix', 'ci-heal', 'review']);
/** Owner states a release may follow from. */
export const RELEASABLE_OWNER_STATES = Object.freeze(['done', 'dead', 'idle-finished']);

const MIN = 60_000;
const finitePositive = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Setting precedence: env > platform preference > tool value > default. A bad mode falls back to `report`. */
export function resolveStaleClaimSettings({ tool, platform, env = process.env } = {}) {
  const pick = key => env?.[`WE_STALE_CLAIM_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`] ?? platform?.[key] ?? tool?.[key];
  const mode = STALE_CLAIM_MODES.includes(pick('mode')) ? pick('mode') : STALE_CLAIM_DEFAULTS.mode;
  return {
    mode,
    pushQuietMinutes: finitePositive(pick('pushQuietMinutes'), STALE_CLAIM_DEFAULTS.pushQuietMinutes),
    idleMinutes: finitePositive(pick('idleMinutes'), STALE_CLAIM_DEFAULTS.idleMinutes),
  };
}

/**
 * Classify the claim owner. `agents` is a `claude agents --json --all` listing (null/non-array = unknown).
 * States: unknown | active | idle-recent | idle-unknown | idle-finished | done | dead.
 * @returns {{state:string, agent:object|null, lastActivityMs:number|null}}
 */
export function classifyOwner({ claim, agents, pidAlive = () => false, activityMs = () => null, nowMs, idleMinutes, sessionNameFor = () => null }) {
  if (!Array.isArray(agents)) return { state: 'unknown', agent: null, lastActivityMs: null };
  const meta = claim.meta ?? {};
  const name = meta.who ?? sessionNameFor(claim);
  const agent = agents.find(a => a && ((meta.sessionId && a.sessionId === meta.sessionId) || (name && a.name === name))) ?? null;
  if (!agent) {
    // No listed session. A claim pid that is still alive is a live, unlisted owner: stay conservative.
    return { state: Number.isInteger(claim.pid) && pidAlive(claim.pid) ? 'active' : 'dead', agent: null, lastActivityMs: null };
  }
  if (['done', 'stopped', 'failed'].includes(agent.state)) return { state: 'done', agent, lastActivityMs: null };
  if (Number.isInteger(agent.pid) && !pidAlive(agent.pid)) return { state: 'dead', agent, lastActivityMs: null };
  if (agent.status !== 'idle') return { state: 'active', agent, lastActivityMs: null };
  const last = activityMs(agent);
  if (!Number.isFinite(last)) return { state: 'idle-unknown', agent, lastActivityMs: null };
  return { state: nowMs - last >= idleMinutes * MIN ? 'idle-finished' : 'idle-recent', agent, lastActivityMs: last };
}

/** Pure release decision for one claim. `push` is `{atMs, open}` or null (unknown). */
export function decideStaleClaim({ claim, owner, push, nowMs, settings }) {
  const kind = claim.meta?.kind;
  const pushAgeMs = push && Number.isFinite(push.atMs) ? Math.max(0, nowMs - push.atMs) : null;
  const base = { pushAgeMs };
  if (!STALE_CLAIM_KINDS.includes(kind)) return { ...base, action: 'keep', reason: 'kind-out-of-scope' };
  if (!RELEASABLE_OWNER_STATES.includes(owner.state)) return { ...base, action: 'keep', reason: `owner-${owner.state}` };
  if (!push) return { ...base, action: 'keep', reason: 'push-unknown' };
  if (push.open === false) return { ...base, action: 'keep', reason: 'pr-not-open' };
  if (pushAgeMs === null) return { ...base, action: 'keep', reason: 'push-unknown' };
  if (pushAgeMs < settings.pushQuietMinutes * MIN) return { ...base, action: 'keep', reason: 'recent-push' };
  return { ...base, action: 'release', reason: `owner-${owner.state}-no-push-${Math.floor(pushAgeMs / MIN)}min` };
}

const minutes = ms => (ms === null || ms === undefined ? null : Math.floor(ms / MIN));

/**
 * One pass over every claim. Deps (all injectable): `pidAlive(pid)`, `activityMs(agent)`, `sessionNameFor(claim)`,
 * `lastPush(claim)` -> `{atMs, open}|null`, `release(claim, ctx)` -> `{released, reason?}`, `rearm(claim, ctx)` ->
 * `{ok, reason?}`, `record(row)`, `emit(event)`. A dep that throws is contained to that claim.
 * @returns {Promise<{mode:string, rows:object[]}>}
 */
export async function runStalePass({ claims = [], agents, settings, nowMs, deps = {} }) {
  const { pidAlive, activityMs, sessionNameFor, lastPush = async () => null, release, rearm, record = () => {}, emit = () => {} } = deps;
  const rows = [];
  for (const claim of claims) {
    const meta = claim.meta ?? {};
    const owner = classifyOwner({ claim, agents, pidAlive, activityMs, nowMs, idleMinutes: settings.idleMinutes, sessionNameFor });
    let push = null;
    try { push = await lastPush(claim); } catch { push = null; }
    const decision = decideStaleClaim({ claim, owner, push, nowMs, settings });
    const claimedMs = Date.parse(meta.claimedAt ?? '');
    const row = {
      at: new Date(nowMs).toISOString(), mode: settings.mode, repo: meta.repo, pr: meta.pr, kind: meta.kind,
      owner: claim.owner ?? null, ownerName: owner.agent?.name ?? meta.who ?? null, ownerState: owner.state,
      reason: decision.reason, claimAgeMin: minutes(Number.isFinite(claimedMs) ? nowMs - claimedMs : null),
      pushAgeMin: minutes(decision.pushAgeMs), idleAgeMin: minutes(owner.lastActivityMs === null ? null : nowMs - owner.lastActivityMs),
      outcome: decision.action === 'release' ? 'would-release' : 'kept',
    };
    if (decision.action === 'release' && settings.mode === 'act') {
      try {
        const result = await release(claim, { reason: decision.reason });
        if (!result?.released) { row.outcome = 'release-failed'; row.detail = result?.reason ?? 'refused'; }
        else {
          const rearmed = await rearm(claim, { reason: decision.reason });
          row.outcome = rearmed?.ok ? 'released' : 'released-rearm-failed';
          if (!rearmed?.ok) row.detail = rearmed?.reason ?? 'rearm refused';
          // Typed event for every real release, including one whose rearm was a no-op or failed.
          await emit({ kind: STALE_CLAIM_EVENT, repo: meta.repo, pr: meta.pr, daemon: 'stale-claim',
            detail: { pr: meta.pr, kind: meta.kind, owner: row.owner, ownerState: row.ownerState, reason: row.reason,
              claimAgeMin: row.claimAgeMin, pushAgeMin: row.pushAgeMin, idleAgeMin: row.idleAgeMin, rearmed: Boolean(rearmed?.ok) } });
        }
      } catch (error) { row.outcome = 'release-failed'; row.detail = String(error?.message ?? error); }
    }
    try { await record(row); } catch { /* recording never interrupts the pass */ }
    rows.push(row);
  }
  return { mode: settings.mode, rows };
}
