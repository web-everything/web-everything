/** Mechanical conflict refreshes have a per-pass cap and share the durable conflict-fix ceiling.
 * Real code conflicts remain owned by the existing conflict fixer/escalation path. */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettingsChecked } from '../lib/settings-files.mjs';
import { rebaseDropManifest, gitRunner } from '../lib/rebase-drop-manifest.mjs';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { REPO_ROOT } from '../operations/dispatch-lane-io.mjs';
import { handoffHome } from '../operations/handoff-home.mjs';
import { resolveLanePoolRepoPath } from './lane-pool-health-watch.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { CONFLICT_FIX_ABSOLUTE_CEILING, countUnresolvedStandDowns, concurrentAuthorPauseState } from './reconcile-core.mjs';
import { standDownHeadChangeAt, concurrentAuthorPauses } from './stand-down.mjs';
import { loadFlakeHoldState } from './load-flake-hold.mjs';
import { answerDisposition, latestOperatorAnswer } from './stand-down-answer-core.mjs';
import { LIST_COMMENTS_PAGE_SIZE } from './pr-comments-complete.mjs';
import { defaultReadOpenPrs, defaultReadMainTip, refreshOntoMain, defaultReadIsCrossRepository,
  sameRepoRefusal, reconcileAcceptanceAfterRebase, defaultPostRebaseComment } from './ci-red-recovery-watch.mjs';

import { countConflictFixComments, CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

export function defaultReadConflictRebasePr(prNumber, { repo, exec = execFileSyncThrottled } = {}) {
  try {
    return JSON.parse(exec('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json',
      'number,state,comments,headRefOid,headRefName,baseRefName,labels,mergeable,mergeStateStatus,isCrossRepository'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    }));
  } catch { return null; }
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** standard → platform → tool → environment; malformed/oversized caps disable this pass.
 * The cascade logs the effective value and source. Existing fix dispatch remains the fallback. */
export function resolveConflictRebaseSettings({ env = process.env, file, platform,
  readSettings = readSettingsChecked,
} = {}) {
  const checked = file === undefined ? readSettings() : { value: file, taint: [] };
  file = checked.value;
  const raw = file?.fix?.conflictRebasePerPass;
  const validCap = v => (typeof v === 'number' || typeof v === 'string')
    && /^\d+$/.test(String(v)) && Number(v) <= 100;
  const cap = v => v === undefined ? undefined : validCap(v) ? Number(v) : 0;
  const disabled = checked.taint.length > 0
    || (Object.hasOwn(file?.fix ?? {}, 'conflictRebasePerPass') && !validCap(raw));
  return cascadePolicy('fix', { conflictRebasePerPass: disabled ? 0 : cap(raw) }, {
    standard: { conflictRebasePerPass: 3 },
    platform: { conflictRebasePerPass: cap((platform ?? platformPreference('fix', { env }))?.conflictRebasePerPass) },
    env, envValues: { conflictRebasePerPass: disabled ? undefined : cap(env.WE_CONFLICT_REBASE_PER_PASS) },
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

function holdWhy(pr, now) {
  const commentsReadable = Array.isArray(pr.comments) && pr.comments.length < LIST_COMMENTS_PAGE_SIZE
    && pr.comments.every(c => typeof c?.body === 'string' && typeof c?.author?.login === 'string');
  const pause = commentsReadable ? concurrentAuthorPauseState({ ...pr, now: now() }) : null;
  const loadHold = commentsReadable ? loadFlakeHoldState({ ...pr, now: now() }) : null;
  const disposition = commentsReadable ? answerDisposition(latestOperatorAnswer(pr.comments)) : null;
  const invalidPauseTime = commentsReadable && concurrentAuthorPauses(pr.comments)
    .some(p => !Number.isFinite(Date.parse(p.createdAt ?? '')));
  return !commentsReadable ? 'comments unreadable or possibly truncated; operator must inspect the full thread before rebasing'
    : disposition != null ? `operator disposition ${disposition} does not authorize repair; follow the operator ruling`
    : loadHold?.live ? `fix reserved on ${loadHold.hold.alt.branch}; wait for load-flake alternate-branch verification`
    : invalidPauseTime ? 'concurrent author pause timestamp unreadable; operator must inspect the thread before rebasing'
    : countUnresolvedStandDowns(pr.comments, { headRefOid: pr.headRefOid, headChangedAt: standDownHeadChangeAt(pr) }) > 0
      ? 'unanswered stand-down; record an explicit operator answer with stand-down-answer.mjs'
      : pause?.held ? pause.why : null;
}

export function sweepMechanicalConflictRebases({ repo, apply = false, defaultBranch = 'main',
  readOpenPrs = defaultReadOpenPrs, readPr = defaultReadConflictRebasePr, readMainTip = defaultReadMainTip,
  run = gitRunner, refresh = (laneRef, options) => refreshOntoMain(laneRef, {
    ...options, rebase: args => rebaseDropManifest({ ...args, strict: true, run }),
  }),
  ledger = createConflictRebaseLedger({ repo }), maxPerPass = resolveConflictRebaseSettings().value.conflictRebasePerPass,
  now = Date.now, checkClaim = pushRefusal, readIsCrossRepository = defaultReadIsCrossRepository,
  reconcileAcceptance = reconcileAcceptanceAfterRebase, postComment = defaultPostRebaseComment,
} = {}) {
  const dispatch = [], applied = [], refusals = [];
  const result = { dispatch, applied, refusals };
  if (!Number.isInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 100) return result;
  const candidates = buildConflictRebaseCandidates(readOpenPrs({ repo, extraFields:
    ['state', 'baseRefName', 'isCrossRepository', 'mergeable', 'mergeStateStatus', 'labels', 'comments'] }), { defaultBranch });
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
    const why = holdWhy(pr, now);
    if (why) { refusals.push({ ...row, kind: 'conflict-rebase-held', why }); continue; }
    if (countConflictFixComments(pr.comments) >= CONFLICT_FIX_ABSOLUTE_CEILING) {
      refusals.push({ ...row, kind: 'conflict-rebase-ceiling', why: 'absolute conflict-fix ceiling reached; existing escalation retains human takeover' }); continue;
    }
    if (!apply) { dispatch.push(row); continue; }
    const held = checkClaim({ repo, branch: pr.headRefName });
    const guard = held || sameRepoRefusal(pr.number, { repo, readIsCrossRepository });
    if (guard) { refusals.push({ ...row, kind: 'conflict-rebase-guard', why: guard.message ?? guard.error }); continue; }
    try {
      const fetched = run('git', ['fetch', 'origin', defaultBranch], { cwd: root });
      const local = fetched.status === 0
        ? run('git', ['rev-parse', `origin/${defaultBranch}`], { cwd: root }) : null;
      if (local?.status !== 0 || String(local.stdout ?? '').trim() !== mainSha) {
        throw new Error('local main does not match live main');
      }
    } catch {
      refusals.push({ ...row, kind: 'conflict-rebase-stale-main',
        why: 'main fetch/verification failed; existing fix path retains ownership' });
      break;
    }
    let fresh;
    try { fresh = readPr(pr.number, { repo }); } catch { fresh = null; }
    if (!fresh || fresh.number !== pr.number || fresh.headRefOid !== pr.headRefOid
      || !/^[a-f0-9]{40}$/i.test(fresh.headRefOid ?? '') || fresh.headRefName !== pr.headRefName
      || !Array.isArray(fresh.labels) || fresh.mergeable !== 'CONFLICTING'
      || !buildConflictRebaseCandidates([fresh], { defaultBranch }).length) {
      refusals.push({ ...row, kind: 'conflict-rebase-held', why: 'fresh PR evidence changed or unreadable; existing fix path retains ownership' }); continue;
    }
    const freshWhy = holdWhy(fresh, now);
    const freshGuard = checkClaim({ repo, branch: fresh.headRefName })
      || sameRepoRefusal(fresh.number, { repo, readIsCrossRepository });
    if (freshWhy || freshGuard) {
      refusals.push({ ...row, kind: 'conflict-rebase-held', why: freshWhy ?? freshGuard.message ?? freshGuard.error }); continue;
    }
    if (countConflictFixComments(fresh.comments) >= CONFLICT_FIX_ABSOLUTE_CEILING) {
      refusals.push({ ...row, kind: 'conflict-rebase-ceiling', why: 'absolute conflict-fix ceiling reached; existing escalation retains human takeover' }); continue;
    }
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
    try { postComment(pr.number, { repo, ...row, ...refreshed, commentMarker: CONFLICT_FIX_COMMENT_MARKER }); }
    catch (e) { refusals.push({ ...row, kind: 'conflict-rebase-comment-failed', why: e.message }); }
  }
  return result;
}
