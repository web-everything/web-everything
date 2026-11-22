/** Bounded recovery of a repair that never acquired a live session. The ordinary planner remains
 * authoritative for park/stand-down/cap admission. Only the fix dispatch pass enables this writer. */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { handoffHome } from '../lib/handoff-path.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { publishAttention, appendLines } from '../operations/needs-you-feed.mjs';
import { fixDispatchClaimRoot, fixDispatchResource } from './fix-claim-store.mjs';
import { lockDirFor, parseLockEntry } from '../readiness/file-locks.mjs';
import { isClaimSessionLive, releaseFixDispatchClaim, readPrHead } from './fix-dispatch-claim.mjs';
import { planClaudeAuthDispatchGate } from './claude-auth-health.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';

const WINDOW_MS = 30 * 60_000;
const MAX_HEAD_READS = 8;
const exactHead = value => typeof value === 'string' && /^[a-fA-F0-9]{40}(?![\s\S])/.test(value);
const repair = row => row.kind === 'fix' || row.kind === 'ci-heal';

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

export function recoverOwedFixes(input, {
  plan, readHead = readPrHead, readClaims = readRecoveryClaims,
  transact = recoveryTransaction, releaseClaim = releaseFixDispatchClaim,
  publish = publishAttention, appendUpdate = appendRecoveryUpdate,
  authGate = planClaudeAuthDispatchGate, kinds = ['fix', 'ci-heal'],
} = {}) {
  const empty = { dispatch: [], refusals: [], notes: [] };
  const refuse = (out, prNumber, why) => {
    out.dispatch = out.dispatch.filter(row => row.prNumber !== prNumber || !repair(row));
    out.refusals.push({ kind: 'owed-fix-no-fixer', prNumber, why });
  };
  // Missing/partial liveness must never be converted to an empty successful listing.
  if (!Array.isArray(input.agents) || Object.hasOwn(input.agents, 'incomplete')
    || !Array.isArray(input.prs) || !Number.isFinite(input.now)) {
    return { ...empty, refusals: [{ kind: 'owed-fix-evidence-unknown', why: 'liveness unreadable; repair the session inventory before retrying' }] };
  }
  try {
    if (authGate({ listAgents: () => input.agents, now: input.now })?.paused !== false) throw new Error('auth paused or unknown; restore login before retrying');
  } catch {
    return { ...empty, refusals: [{ kind: 'owed-fix-auth-paused', why: 'auth paused or unknown; restore login before retrying' }] };
  }
  const out = plan(input);
  // A draft can produce promote-draft rather than a repair row; operator parks hold that too.
  const operatorParked = pr => pr.state !== 'OPEN' || pr.isDraft || (pr.referralHold
    && pr.referralHold.kind !== 'same-head' && pr.referralHoldAutoResolve?.outcome !== 'send-back');
  for (const pr of input.prs.filter(operatorParked)) {
    out.dispatch = out.dispatch.filter(row => row.prNumber !== pr.number);
    out.refusals.push({ kind: 'owed-fix-operator-park', prNumber: pr.number, why: 'operator park; waiting for operator release' });
  }
  // Re-run the SAME policy with only the claim hold removed. This does not bypass any other refusal.
  const eligible = plan({ ...input, prs: input.prs.map(pr => ({ ...pr, fixClaim: null })),
    shadowDeps: { mode: 'off', appendLine: () => {}, readLocals: () => undefined } });
  let headReads = 0;
  const checkHead = (identity, head) => {
    if (++headReads > MAX_HEAD_READS) throw new Error('live-head budget exhausted; retry next tick, operator may inspect PR now');
    if (readHead(identity) !== head) throw new Error('head moved or unreadable; refresh PR evidence');
  };
  for (const row of eligible.dispatch.filter(row => kinds.includes(row.kind) && repair(row))) {
    const pr = input.prs.find(pr => pr.number === row.prNumber);
    const identity = { repo: input.repo, pr: row.prNumber };
    const head = row.headRefOid;
    try {
      // An operator draft/park is never undone by elapsed time, even for a block-ruling row.
      if (operatorParked(pr)) throw new Error('operator park; waiting for operator release');
      if (!exactHead(head)) throw new Error('exact 40-hex head required; refresh PR evidence');
      const claims = readClaims(identity);
      if (!Array.isArray(claims) || claims.length > 3) throw new Error('claim inventory unknown; inspect claim store');
      if (pr.fixClaim && !claims.some(claim => claim.meta?.kind === 'fixing')) throw new Error('fix claim record absent; refresh claim evidence');
      for (const claim of claims) {
        if (!claim.owner || claim.meta?.repo !== input.repo || claim.meta?.pr !== row.prNumber
          || !['fixing', 'fix', 'ci-heal'].includes(claim.meta.kind) || claim.meta.headSha !== head
          || !Number.isFinite(Date.parse(claim.meta.claimedAt))) throw new Error('claim identity/head/age unknown; inspect claim store');
      }
      const live = ['fix', 'ci-heal'].some(kind => isClaimSessionLive({ ...identity, kind, agentsAll: input.agents }))
        || claims.some(claim => isClaimSessionLive({ ...identity, kind: claim.meta.kind,
          name: claim.meta.who || null, agentsAll: input.agents })
          || input.agents.some(agent => claim.meta.sessionId && [agent.id, agent.sessionId].includes(claim.meta.sessionId)
            && !['done', 'stopped', 'failed'].includes(agent.state)));
      if (live) throw new Error('live fixer session; waiting for its completion');
      const key = `${input.repo}:${row.prNumber}:${head}`;
      const allow = transact(key, (stored, save) => {
        const state = { ...stored };
        if (state.since === undefined) {
          state.since = Math.min(input.now, ...claims.map(claim => Date.parse(claim.meta.claimedAt)));
          save(state);
        }
        // A recent dispatch may still be crossing the session-listing lag. An older owed episode
        // never authorizes releasing a newly acquired claim before its own full grace expires.
        if (claims.some(claim => input.now - Date.parse(claim.meta.claimedAt) < WINDOW_MS)) return false;
        if (state.retryAt !== undefined && input.now - state.retryAt < WINDOW_MS) return false;
        if (state.retryAt === undefined && input.now - state.since < WINDOW_MS) return !pr.fixClaim;
        if (state.attention && state.update) return false;
        // One tick shares this small live-head budget. Deferred entries explicitly retry next tick.
        checkHead(identity, head);
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
          if (releaseClaim({ ...identity, kind: claim.meta.kind, owner: claim.owner })?.released !== true) {
            throw new Error('claim release failed; inspect claim store');
          }
        }
        checkHead(identity, head);
        return true;
      });
      if (!allow) { refuse(out, row.prNumber, 'owed fix recovery waiting or escalated; inspect needs-you feed'); continue; }
      // A real stale fixer claim withheld the normal row; restore only the admitted, exact-head row.
      if (pr.fixClaim) {
        out.refusals = out.refusals.filter(refusal => refusal.prNumber !== row.prNumber || refusal.kind !== 'fix-claimed');
        out.dispatch.push(row);
      }
    } catch (error) { refuse(out, row.prNumber, String(error.message)); }
  }
  return out;
}
