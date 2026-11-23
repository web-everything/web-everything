/** Bounded recovery of a repair that never acquired a live session. The ordinary planner remains
 * authoritative for park/stand-down/cap admission. Only the fix and CI-heal dispatch consumers enable this
 * writer, AFTER their reconcile call returns (whatever wrapper produced the plan: the daemon's pass plan cache,
 * the routed CI-heal lambda, or the bare pass), from the planner facts `runReconcilePass` attaches as
 * `owedFixRecovery`. A recovery admission is given back when the consumer never attempted the launch
 * (capacity, no lane, a filter, a thrown pass): see {@link createOwedFixRecoveryLedger}. */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { handoffHome } from '../lib/handoff-path.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { publishAttention, appendLines } from '../operations/needs-you-feed.mjs';
import { fixDispatchClaimRoot, fixDispatchResource, fixDispatchSessionName,
  DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES } from './fix-claim-store.mjs';
import { lockDirFor, parseLockEntry, isLeaseExpired } from '../readiness/file-locks.mjs';
import { isClaimSessionLive, releaseFixDispatchClaim } from './fix-dispatch-claim.mjs';
import { makeAwaitingVerifyResolver } from './await-verify.mjs';
import { isClaimRunnerDead } from '../lib/dispatch-throttle.mjs';
import { planClaudeAuthDispatchGate } from './claude-auth-health.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { planReconcile } from './reconcile-core.mjs';

const WINDOW_MS = 30 * 60_000;
const MAX_HEAD_READS = 8;
const exactHead = value => typeof value === 'string' && /^[a-fA-F0-9]{40}(?![\s\S])/.test(value);
const repair = row => row.kind === 'fix' || row.kind === 'ci-heal';
const labelNames = labels => Array.isArray(labels)
  ? labels.map(label => typeof label === 'string' ? label : label?.name).sort() : null;

/** One live read of the facts a recovery restore relies on. `null` on any failure (callers refuse). */
export function readLivePrFacts({ repo, pr }) {
  try {
    const data = JSON.parse(execFileSyncThrottled('gh', [
      'pr', 'view', String(pr), '--repo', ghRepoSlug(repo), '--json', 'headRefOid,state,isDraft,labels',
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }));
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

/** Unlike the tolerant inventory reader, unreadable and partial claim records refuse recovery. */
export function readRecoveryClaims({ repo, pr }, { root = fixDispatchClaimRoot() } = {}) {
  const claims = [];
  for (const kind of ['fixing', 'fix', 'ci-heal']) {
    const dir = lockDirFor(root, fixDispatchResource({ repo, pr, kind }));
    let raw;
    try {
      if (statSync(join(dir, 'lock.json')).size > 64 * 1024) throw new Error('oversized claim; inspect claim store');
      raw = readFileSync(join(dir, 'lock.json'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A directory with no readable record is not an absent claim.
      try { statSync(dir); } catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
      throw new Error('claim record missing; inspect claim store');
    }
    const entry = parseLockEntry(raw);
    if (!entry?.owner || entry.meta?.repo !== repo || entry.meta?.pr !== pr || entry.meta?.kind !== kind) {
      throw new Error('invalid claim; inspect claim store');
    }
    claims.push(entry);
  }
  return claims;
}

export function recoveryTransaction(key, fn, { root = resolveCoordinationRoot() } = {}) {
  const dir = join(root, 'owed-fix-recovery');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  return withFileLock(`${path}.lock`, () => {
    let state = {};
    try {
      if (statSync(path).size > 64 * 1024) throw new Error('oversized recovery state; inspect sidecar');
      state = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || (state.since !== undefined && !Number.isFinite(state.since))
      || (state.retryAt !== undefined && !Number.isFinite(state.retryAt))
      || (state.attention !== undefined && typeof state.attention !== 'boolean')
      || (state.update !== undefined && typeof state.update !== 'boolean')) throw new Error('invalid recovery state; inspect sidecar');
    return fn(state, next => writeJsonAtomic(path, next));
  });
}

export function appendRecoveryUpdate(item, { path = join(handoffHome(), 'updates', 'stream.jsonl') } = {}) {
  appendLines(path, [JSON.stringify(item)]);
  return true;
}

/**
 * Pass-local record of which recovery admissions turned into a launch attempt. A recovery admission reserves
 * state (`since` for the initial attempt, `retryAt` for the one recovery) BEFORE the consumer's own capacity
 * admission runs; if the consumer never attempts the launch for that PR — fix cap, host load, queue cap, no lane,
 * a deadline/yield deferral, a scope filter, an early return or a thrown pass — `settle()` restores the exact
 * prior state, so a capacity deferral never consumes the allowance. Keyed on "launch attempted", never on a list
 * of refusal kinds. An attempted launch that failed keeps the reservation, so a launcher that always throws still
 * escalates. The restore is a compare-and-swap: a state another pass changed since this admission is kept.
 */
export function createOwedFixRecoveryLedger({ transact = recoveryTransaction, log = line => console.error(line) } = {}) {
  const admissions = [];
  const attempted = new Set();
  return {
    admit(admission) { admissions.push(admission); },
    /** Call immediately BEFORE a launch (or a resume) is attempted for this PR. */
    attempting(pr) { attempted.add(Number(pr)); },
    /** Call when that attempt provably started nothing (a declined resume, a claim held elsewhere). */
    notLaunched(pr) { attempted.delete(Number(pr)); },
    settle() {
      const restored = [];
      for (const admission of admissions.splice(0)) {
        if (attempted.has(admission.prNumber)) continue;
        try {
          const done = transact(admission.key, (current, save) => {
            if (JSON.stringify(current) !== JSON.stringify(admission.after)) return false;
            save(admission.before);
            return true;
          });
          if (done) restored.push(admission.prNumber);
          log(`owed-fix-recovery: PR #${admission.prNumber} launch not attempted; ${done
            ? 'recovery allowance restored' : 'state changed by another pass, allowance kept'}`);
        } catch (error) {
          log(`owed-fix-recovery: PR #${admission.prNumber} allowance restore failed (${String(error?.message ?? error).split('\n')[0]}); it escalates at its next window`);
        }
      }
      return restored;
    },
  };
}

/** A consumer's effective recovery IO: an explicit value (`null` = off) wins; omitted means on with the default
 *  live IO, except under a test runner or inside the daemon live smoke's stubbed-dispatch child (it always sets
 *  `WE_SMOKE_DRYRUN_ONLY`, see we:scripts/lib/daemon-live-smoke.mjs#checkDispatchDryRun): there that IO would
 *  write real recovery state and release real claims for launches that never happen. */
export function resolveOwedFixRecoveryIo(value, underTest, env = process.env) {
  if (value === null) return null;
  if (value !== undefined) return value;
  return underTest || env?.WE_SMOKE_DRYRUN_ONLY !== undefined ? null : {};
}

/**
 * Run recovery for one dispatch consumer over the plan its reconcile call returned (mutated IN PLACE, so a
 * wrapper that captured `plan.dispatch` — the routed CI-heal lambda — sees restored rows). `input` is the planner
 * input of the pass that produced the plan (`we:scripts/conveyor/reconcile-pass.mjs#owedFixRecoveryInput`); a
 * plan without one (an injected test planner, an evicted token) keeps ordinary planning and says so.
 */
export function applyOwedFixRecovery(plan, { kinds, input, io = {}, ledger = null, log = line => console.error(line) }) {
  if (!input || typeof input !== 'object') {
    log(`owed-fix-recovery: kinds=${kinds.join(',')} skipped — no planner input for this plan; ordinary planning only`);
    return plan;
  }
  if (!plan || !Array.isArray(plan.dispatch) || !Array.isArray(plan.refusals)) return plan;
  return recoverOwedFixes(input, { ...io, kinds, base: plan, ledger });
}

export function recoverOwedFixes(input, {
  plan = planReconcile, base = null, ledger = null, readLive = readLivePrFacts, readClaims = readRecoveryClaims,
  transact = recoveryTransaction, releaseClaim = releaseFixDispatchClaim,
  publish = publishAttention, appendUpdate = appendRecoveryUpdate,
  authGate = planClaudeAuthDispatchGate, runnerDead = isClaimRunnerDead,
  awaitingVerifyFor = makeAwaitingVerifyResolver({ now: () => input.now }), kinds = ['fix', 'ci-heal'],
} = {}) {
  const owned = row => kinds.includes(row.kind) && repair(row);
  // In place: `base` may be the consumer's own plan, whose dispatch array a wrapper already captured.
  const drop = (out, keep) => {
    const kept = out.dispatch.filter(keep);
    out.dispatch.splice(0, out.dispatch.length, ...kept);
  };
  const refuse = (out, refused, why) => {
    drop(out, row => row.prNumber !== refused.prNumber || row.kind !== refused.kind);
    out.refusals.push({ kind: 'owed-fix-no-fixer', prNumber: refused.prNumber, why });
  };
  const refuseAll = (kind, why) => {
    if (!base) return { dispatch: [], refusals: [{ kind, why }], notes: [] };
    drop(base, row => !owned(row));
    base.refusals.push({ kind, why });
    return base;
  };
  // Missing/partial liveness must never be converted to an empty successful listing.
  if (!Array.isArray(input.agents) || Object.hasOwn(input.agents, 'incomplete')
    || !Array.isArray(input.prs) || !Number.isFinite(input.now)) {
    return refuseAll('owed-fix-evidence-unknown', 'liveness unreadable; repair the session inventory before retrying');
  }
  const out = base ?? plan(input);
  // Only a recovery launch needs the extra positive login probe. Ordinary dispatch keeps its
  // consumer's auth policy, and an auth outage must not silence a due needs-you escalation.
  let recoveryAuthAllowed;
  const checkRecoveryAuth = () => {
    if (recoveryAuthAllowed === undefined) {
      try {
        recoveryAuthAllowed = authGate({ listAgents: () => input.agents, now: input.now, requireLogin: true })?.paused === false;
      } catch { recoveryAuthAllowed = false; }
    }
    if (!recoveryAuthAllowed) throw new Error('auth paused or unknown; restore login before retrying');
  };
  // Park only an existing recovery episode. The planner intentionally emits ordinary CI-heal
  // rows for red drafts; a recovery-only gate must not veto those or another consumer's rows.
  // A draft can replace an already observed repair with promote-draft: retain that episode's hold.
  const operatorParked = pr => (pr.state != null && pr.state !== 'OPEN') || pr.isDraft || (pr.referralHold
    && pr.referralHold.kind !== 'same-head' && pr.referralHoldAutoResolve?.outcome !== 'send-back');
  for (const pr of input.prs.filter(operatorParked)) {
    for (const row of out.dispatch.filter(row => row.prNumber === pr.number && (owned(row) || row.kind === 'promote-draft'))) {
      try {
        const rowKinds = owned(row) ? [row.kind] : kinds;
        const recovering = pr.fixClaim || rowKinds.some(kind => transact(`${input.repo}:${pr.number}:${row.headRefOid}:${kind}`,
          state => state.since !== undefined || state.retryAt !== undefined));
        if (!recovering) continue;
        drop(out, entry => entry !== row);
        out.refusals.push({ kind: 'owed-fix-operator-park', prNumber: pr.number, why: 'operator park; waiting for operator release' });
      } catch (error) { refuse(out, row, String(error.message)); }
    }
  }
  // Re-run the SAME policy with only the claim hold removed. This does not bypass any other refusal. With no claim
  // to remove, the consumer's own plan already is that policy (and, from the pass cache, already freshness-filtered).
  const eligible = base && !input.prs.some(pr => pr.fixClaim)
    ? { dispatch: out.dispatch.map(row => ({ ...row })) }
    : plan({ ...input, prs: input.prs.map(pr => ({ ...pr, fixClaim: null })) });
  let headReads = 0;
  // Reserve every live read a path needs BEFORE it writes state, so a budget deferral never consumes an allowance.
  const reserveReads = n => {
    if (headReads + n > MAX_HEAD_READS) throw new Error('live-head budget exhausted; retry next tick, operator may inspect PR now');
  };
  // The planner facts may come from a cached plan: re-verify head, open/draft state and labels live before acting.
  const checkLive = (identity, head, pr) => {
    reserveReads(1);
    headReads += 1;
    const facts = readLive(identity);
    if (!facts || typeof facts !== 'object' || facts.headRefOid !== head) throw new Error('head moved or unreadable; refresh PR evidence');
    if (facts.state !== 'OPEN' || facts.isDraft !== false) throw new Error('PR closed or drafted since plan; refresh PR evidence');
    const planned = labelNames(pr.labels), live = labelNames(facts.labels);
    if (!planned || !live || [...planned, ...live].some(name => typeof name !== 'string')
      || JSON.stringify(planned) !== JSON.stringify(live)) throw new Error('PR labels changed since plan; refresh PR evidence');
  };
  // Act only on PRs the consumer's own plan still offers (an owned row) or withholds for a fixer claim. A caller
  // that narrowed the plan (one PR, or the pass cache's stale/touched filter) must never get rows back from the
  // wider planner input.
  const offered = new Set([...(base ? out.dispatch.filter(owned) : eligible.dispatch.filter(owned)).map(row => row.prNumber),
    ...out.refusals.filter(refusal => refusal.kind === 'fix-claimed').map(refusal => refusal.prNumber)]);
  for (const row of eligible.dispatch.filter(row => owned(row) && offered.has(row.prNumber))) {
    const pr = input.prs.find(pr => pr.number === row.prNumber);
    // Existing episodes were held above. Leave ordinary parked rows entirely to the planner,
    // without recording an initial recovery reservation or probing live open/non-draft facts.
    if (pr && operatorParked(pr)) continue;
    const identity = { repo: input.repo, pr: row.prNumber };
    const head = row.headRefOid;
    let admission = null;
    try {
      if (!pr) throw new Error('PR facts absent from plan; refresh PR evidence');
      if (!exactHead(head)) throw new Error('exact 40-hex head required; refresh PR evidence');
      const claims = readClaims(identity);
      if (!Array.isArray(claims) || claims.length > 3) throw new Error('claim inventory unknown; inspect claim store');
      if (pr.fixClaim && !claims.some(claim => claim.meta?.kind === 'fixing')) throw new Error('fix claim record absent; refresh claim evidence');
      for (const claim of claims) {
        if (!claim.owner || claim.meta?.repo !== input.repo || claim.meta?.pr !== row.prNumber
          || !['fixing', 'fix', 'ci-heal'].includes(claim.meta.kind) || claim.meta.headSha !== head
          || !Number.isFinite(Date.parse(claim.meta.claimedAt))) throw new Error('claim identity/head/age unknown; inspect claim store');
      }
      for (const claim of claims) {
        if (!Number.isFinite(Date.parse(claim.heartbeatAt))
          || !isLeaseExpired(claim, input.now, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES)) {
          throw new Error('claim heartbeat fresh or unknown; wait for the claim sweep or inspect claim store');
        }
        if (claim.meta.runnerPid != null && runnerDead(claim) !== true) {
          throw new Error('claim runner alive or unknown; wait for its completion');
        }
        const name = claim.meta.who || fixDispatchSessionName({ ...identity, kind: claim.meta.kind });
        const sessions = input.agents.filter(agent => agent.name === name
          || (claim.meta.sessionId && [agent.id, agent.sessionId].includes(claim.meta.sessionId)));
        // Also consult persisted verification by session/name when the listing has lost the row.
        const holder = { name, sessionId: claim.meta.sessionId, cwd: claim.meta.cwd ?? '' };
        if ([holder, ...sessions].some(session => awaitingVerifyFor(session, { pr: row.prNumber })?.awaiting === true)) {
          throw new Error('claim awaiting verification; wait for verification to finish');
        }
        // The shared refresh sweep owns observed idleness, transcript/subagent activity and policy.
        // Recovery never substitutes claim age for that observation window, even for hung idle rows.
        if (claim.meta.idleHead || sessions.some(session => session.state === 'idle')) {
          throw new Error('claim idle observation protected; wait for the claim sweep or inspect idle-release policy');
        }
      }
      const live = ['fix', 'ci-heal'].some(kind => isClaimSessionLive({ ...identity, kind, agentsAll: input.agents }))
        || claims.some(claim => isClaimSessionLive({ ...identity, kind: claim.meta.kind,
          name: claim.meta.who || null, agentsAll: input.agents })
          || input.agents.some(agent => claim.meta.sessionId && [agent.id, agent.sessionId].includes(claim.meta.sessionId)
            && !['done', 'stopped', 'failed'].includes(agent.state)));
      if (live) throw new Error('live fixer session; waiting for its completion');
      const key = `${input.repo}:${row.prNumber}:${head}:${row.kind}`;
      const allow = transact(key, (stored, save) => {
        const before = structuredClone(stored);
        const state = { ...stored };
        // Recorded so the ledger can give the allowance back if the consumer never attempts this launch.
        const admit = () => { admission = { key, prNumber: row.prNumber, before, after: structuredClone(state) }; return true; };
        const firstObservation = state.since === undefined;
        if (firstObservation) {
          // A deferred head probe must leave the initial attempt available next tick.
          if (!pr.fixClaim && claims.length === 0) checkLive(identity, head, pr);
          state.since = Math.min(input.now, ...claims.map(claim => Date.parse(claim.meta.claimedAt)));
          save(state);
        }
        // A recent dispatch may still be crossing the session-listing lag. An older owed episode
        // never authorizes releasing a newly acquired claim before its own full grace expires.
        if (claims.some(claim => input.now - Date.parse(claim.meta.claimedAt) < WINDOW_MS)) return false;
        if (state.retryAt !== undefined && input.now - state.retryAt < WINDOW_MS) return false;
        if (state.retryAt === undefined && input.now - state.since < WINDOW_MS) {
          // Persisted since already reserves the initial attempt, including legacy episodes.
          if (!firstObservation || pr.fixClaim || claims.length) return false;
          return admit();
        }
        if (state.attention && state.update) return false;
        // One tick shares this small live-head budget. Deferred entries explicitly retry next tick; the
        // recovery path reserves both of its reads up front so the budget can never strand a reservation.
        if (state.retryAt === undefined) {
          checkRecoveryAuth();
          reserveReads(2);
        }
        checkLive(identity, head, pr);
        if (state.retryAt !== undefined) {
          const item = { repo: ghRepoSlug(input.repo), pr: row.prNumber, head, kind: 'needs-you',
            reason: 'owed fix: no live fixer 30 min after the one recovery dispatch; inspect dispatch logs and claim store' };
          if (!state.attention) {
            const result = publish(item);
            if (result !== true && !Array.isArray(result?.lines)) throw new Error('needs-you publication failed; retry next tick');
            state.attention = true; save(state);
          }
          if (!state.update) {
            if (appendUpdate({ at: new Date(input.now).toISOString(), ...item }) !== true) throw new Error('update append failed; retry next tick');
            state.update = true; save(state);
          }
          return false;
        }
        // Reserve the single recovery BEFORE releasing anything; concurrent passes cannot both dispatch.
        // A failed release consumes the reservation and escalates rather than opening an unbounded retry.
        state.retryAt = input.now; save(state);
        if (JSON.stringify(readClaims(identity)) !== JSON.stringify(claims)) throw new Error('claim changed; inspect holder before retrying');
        for (const claim of claims) {
          if (releaseClaim({ ...identity, kind: claim.meta.kind, owner: claim.owner, expected: claim })?.released !== true) {
            throw new Error('claim release failed; inspect claim store');
          }
        }
        checkLive(identity, head, pr);
        return admit();
      });
      if (!allow) { refuse(out, row, 'owed fix recovery waiting or escalated; inspect needs-you feed'); continue; }
      if (admission) ledger?.admit(admission);
      // A real stale fixer claim withheld the normal row; restore only the admitted, exact-head row.
      if (pr.fixClaim) {
        const kept = out.refusals.filter(refusal => refusal.prNumber !== row.prNumber || refusal.kind !== 'fix-claimed');
        out.refusals.splice(0, out.refusals.length, ...kept);
        if (!out.dispatch.some(entry => entry.prNumber === row.prNumber && entry.kind === row.kind)) out.dispatch.push(row);
      }
    } catch (error) { refuse(out, row, String(error.message)); }
  }
  return out;
}
