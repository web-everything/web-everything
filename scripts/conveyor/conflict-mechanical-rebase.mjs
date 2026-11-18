/** Mechanical conflict refreshes have their own cap, independent of the agent fix queue.
 * Real code conflicts remain owned by the existing conflict fixer/escalation path. */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { REPO_ROOT } from '../operations/dispatch-lane-io.mjs';
import { handoffHome } from '../operations/handoff-home.mjs';
import { resolveLanePoolRepoPath } from './lane-pool-health-watch.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { defaultReadOpenPrs, defaultReadMainTip, refreshOntoMain, defaultReadIsCrossRepository,
  sameRepoRefusal, reconcileAcceptanceAfterRebase, defaultPostRebaseComment } from './ci-red-recovery-watch.mjs';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** standard → platform → tool → environment; malformed/oversized caps disable this pass.
 * The cascade logs the effective value and source. Existing fix dispatch remains the fallback. */
export function resolveConflictRebaseSettings({ env = process.env, file = readSettings(), platform } = {}) {
  const cap = v => v === undefined ? undefined
    : ((typeof v === 'number' || typeof v === 'string') && /^\d+$/.test(String(v))
      && Number(v) <= 100 ? Number(v) : 0);
  return cascadePolicy('fix', { conflictRebasePerPass: cap(file?.fix?.conflictRebasePerPass) }, {
    standard: { conflictRebasePerPass: 3 },
    platform: { conflictRebasePerPass: cap((platform ?? platformPreference('fix', { env }))?.conflictRebasePerPass) },
    env, envValues: { conflictRebasePerPass: cap(env.WE_CONFLICT_REBASE_PER_PASS) },
  });
}

/** Unknown same-repo evidence is excluded; the apply boundary verifies it again by PR number. */
export function buildConflictRebaseCandidates(prs, { defaultBranch = 'main' } = {}) {
  return (Array.isArray(prs) ? prs : []).filter(pr => pr?.state === 'OPEN'
    && pr.isCrossRepository === false && pr.baseRefName === defaultBranch
    && Number.isInteger(pr.number) && pr.number > 0 && typeof pr.headRefName === 'string' && pr.headRefName
    && (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'
      || pr.labels?.some(label => (label?.name ?? label) === 'merge-status:conflicting')));
}

/** Separate per-repo ledger. Corrupt/unreadable state refuses work rather than forgetting attempts.
 * Claim uses the shared atomic file lock, so overlapping ticks cannot attempt the same key twice. */
export function createConflictRebaseLedger({ repo, path, env = process.env } = {}) {
  let memory = {};
  const file = path ?? ((env.VITEST || env.WE_UNDER_TEST) ? null
    : join(handoffHome(), `conflict-rebase.${encodeURIComponent(repo)}.json`));
  const read = () => {
    if (!file) return memory;
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  };
  const write = state => { if (file) writeJsonAtomic(file, state); else memory = state; };
  const locked = fn => {
    if (!file) return fn();
    mkdirSync(dirname(file), { recursive: true });
    return withFileLock(`${file}.lock`, fn, { timeoutMs: 1000 });
  };
  return { read, write, claim: (key, at) => locked(() => claimAttempt({ read, write }, key, at)) };
}

function claimAttempt(ledger, key, at) {
  const stored = ledger.read();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)
    || Object.entries(stored).some(([k, ts]) => !/^\d+@[a-f0-9]{40}$/i.test(k) || !Number.isFinite(ts))) {
    throw new Error('invalid conflict rebase ledger; repair ledger or use existing fix dispatch');
  }
  const state = Object.fromEntries(Object.entries(stored).filter(([, ts]) => at - ts <= TTL_MS));
  if (Object.hasOwn(state, key)) return false;
  state[key] = at;
  ledger.write(state); // durable BEFORE refresh, including crashes, skips and errors
  return true;
}

export function sweepMechanicalConflictRebases({ repo, apply = false, defaultBranch = 'main',
  readOpenPrs = defaultReadOpenPrs, readMainTip = defaultReadMainTip, refresh = refreshOntoMain,
  ledger = createConflictRebaseLedger({ repo }), maxPerPass = resolveConflictRebaseSettings().value.conflictRebasePerPass,
  now = Date.now, checkClaim = pushRefusal, readIsCrossRepository = defaultReadIsCrossRepository,
  reconcileAcceptance = reconcileAcceptanceAfterRebase, postComment = defaultPostRebaseComment,
} = {}) {
  const dispatch = [], applied = [], refusals = [];
  const result = { dispatch, applied, refusals };
  if (!Number.isInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 100) return result;
  const candidates = buildConflictRebaseCandidates(readOpenPrs({ repo, extraFields:
    ['state', 'baseRefName', 'isCrossRepository', 'mergeable', 'mergeStateStatus', 'labels'] }), { defaultBranch });
  if (!candidates.length) return result;
  const mainSha = readMainTip({ repo, defaultBranch })?.sha;
  if (!/^[a-f0-9]{40}$/i.test(mainSha ?? '')) {
    refusals.push({ kind: 'conflict-rebase-evidence-unreadable', why: 'main tip unreadable; existing fix path retains ownership' });
    return result;
  }
  const root = resolveLanePoolRepoPath(repo) ?? REPO_ROOT;
  let attempts = 0;
  for (const pr of candidates) {
    if (attempts >= maxPerPass) break;
    const row = { prNumber: pr.number, headRefName: pr.headRefName, headSha: pr.headRefOid };
    if (!apply) { dispatch.push(row); continue; }
    const held = checkClaim({ repo, branch: pr.headRefName });
    const guard = held || sameRepoRefusal(pr.number, { repo, readIsCrossRepository });
    if (guard) { refusals.push({ ...row, kind: 'conflict-rebase-guard', why: guard.message ?? guard.error }); continue; }
    try {
      if (!(ledger.claim ? ledger.claim(`${pr.number}@${mainSha}`, now())
        : claimAttempt(ledger, `${pr.number}@${mainSha}`, now()))) continue;
    } catch (e) {
      refusals.push({ ...row, kind: 'conflict-rebase-ledger-unreadable', why: `${e.message}; existing fix path retains ownership` });
      break;
    }
    let refreshed;
    try { refreshed = refresh(pr.headRefName, { repo, root, base: `origin/${defaultBranch}`, prNumber: pr.number, readIsCrossRepository }); }
    catch (e) { refreshed = { ok: false, action: 'error', error: e.message }; }
    if (!refreshed.deferred) attempts += 1;
    const action = { ...row, ...refreshed };
    applied.push(action);
    if (refreshed.ok && refreshed.action === 'rebased' && refreshed.newCommit) {
      action.acceptance = reconcileAcceptance({ repo, root, prNumber: pr.number, newHead: refreshed.newCommit });
    }
    if (!refreshed.ok) refusals.push({ ...row, kind: 'conflict-rebase-not-mechanical', why: refreshed.error ?? refreshed.action });
    try { postComment(pr.number, { repo, ...row, ...refreshed }); }
    catch (e) { refusals.push({ ...row, kind: 'conflict-rebase-comment-failed', why: e.message }); }
  }
  return result;
}
