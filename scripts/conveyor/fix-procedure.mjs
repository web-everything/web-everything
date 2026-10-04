#!/usr/bin/env node
/**
 * @file scripts/conveyor/fix-procedure.mjs
 * @description THE FIX PROCEDURE every fixer follows (operator-approved 2026-09-27): a durable per-PR FIX CLAIM
 *   taken with `fix-begin` and released with `fix-end`, so exactly one author repairs a PR at a time.
 *
 * LIVE INCIDENT (web-everything/web-everything PR #2811). The daemon fixer `fix-2811` was repairing the PR while an
 * orchestrator worker (not a daemon session) pushed two commits to the SAME lane ref. Nothing told either author
 * the other existed. The fixer saw a "concurrent author", saved its repair on a side branch, and posted a
 * TERMINAL stand-down ("a human clears the marker") whose reason text even named the wrong cause ("a genuine
 * same-line conflict with main"). No label showed it, and the reconcile planner then refused the PR forever.
 *
 * THE PROCEDURE.
 *   1. `fix-begin <pr> --who=<session|worker> --why=<…>` — take the claim, set `review-status:fixing`, and post
 *      a marker comment naming who and why. **The PR stays READY by default** — a normal repair loop (a review-
 *      findings fix, a ci-heal, a mechanical conflict repair, a mechanical rebase/CI-rerun) never touches the
 *      draft bit; the claim itself is the lock (refusal 2 below), so draft was never load-bearing for merge
 *      safety (`merge-ai-prs.mjs#decideReviewGate`/`acceptanceCoversHead` re-verifies the accepted sha against
 *      the LIVE head independently of any label). Draft is owed ONLY for `--draft --reason=scope-change` (a
 *      scope-change request reached the fixer mid-review) or `--draft --reason=withdrawn` (review finds the PR
 *      does not do what the card asked at all) — each converts the PR to draft (`gh pr ready --undo`, through
 *      the gh throttle) and applies its own `review-status:draft-scope-change` / `review-status:draft-withdrawn`
 *      label instead of `fixing`, mutually exclusive with it and with each other. Operator ruling 2026-09-27,
 *      codified in `we:docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal`.
 *   2. While the claim is live: the reconcile planner refuses every dispatch for the PR (review, advisory,
 *      fix, ci-heal, promote-draft — `reconcile-core.mjs` `fix-claimed`), a second `fix-begin` by anyone else
 *      is refused, and a PUSH to the PR's branch by anyone but the holder is refused ({@link pushRefusal} —
 *      wired into `pr-land.mjs`, the `push` helper below, and `guard-bash.mjs` for a raw `git push`).
 *   3. `fix-end <pr>` — after the push: release the claim and drop whichever label `fix-begin` applied
 *      (`fixing`, `draft-scope-change`, or `draft-withdrawn`). A claim that was NEVER drafted leaves the PR
 *      exactly as it was — ready — and owes nothing further; `fix-end` does not rely on the draft-first
 *      promotion for it. A claim that WAS drafted (scope-change/withdrawn) still leaves the PR draft: the
 *      draft-first promotion (`reconcile-core.mjs` `promote-draft`, run by the live fix daemon) marks it ready
 *      once required CI is green on the new head, and review re-runs from there.
 *   The claim is heartbeat-refreshed while the fixer lives (`fix-heartbeat`, and the fix daemon's own
 *   `refreshLiveFixDispatchClaims` sweep for a claim whose `who` names a live session). A crashed fixer's claim
 *   expires on its TTL. A withdrawn draft keeps its reason label and stays held until explicit release;
 *   expiry is not release. Scope-change drafts remain eligible for green-CI promotion, and red drafts
 *   remain eligible for CI healing. A claim that never drafted leaves a plain ready PR.
 *
 * THE CLAIM STORE IS REUSED, NOT REINVENTED. This is `fix-dispatch-claim.mjs`'s own `(repo, kind, pr)` store
 * (#2789) with `kind: 'fixing'`. The owner string is `fixer:<who>` — stable across the several short CLI calls
 * one fixer makes — and the entry is written with `pid: null` so a later call from the same fixer is a reentrant
 * re-acquire, never a foreign one.
 *
 * WHO IS "THE HOLDER" AT PUSH TIME. When `fix-begin` recorded a Claude session id (`CLAUDE_CODE_SESSION_ID`, the
 * same durable identity `lane-pool.mjs` stamps on a lease), the claim is BOUND to it: only that session id holds
 * it — for a push, a re-take, a heartbeat, or a release. `who` is printed on the PR thread, so knowing it proves
 * nothing and never rebinds a session-bound claim. A claim taken with NO session id (a non-Claude worker) is
 * bound to a random TOKEN that `fix-begin` mints and prints to its caller alone (only its hash is stored): the
 * holder is `who` (`WE_FIX_WHO`) PLUS that token (`WE_FIX_TOKEN`). Two workers passing the same conventional
 * `--who` are therefore still two authors. Anything else is "anyone else" and is refused.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { isLeaseExpired, readLockEntry, heartbeat, releaseLockDir, reserve } from '../readiness/file-locks.mjs';
import {
  fixDispatchClaimRoot, fixDispatchResource, listFixDispatchClaims, readFixDispatchClaim,
  fixDispatchSessionName, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES,
} from './fix-claim-store.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';

/** The claim-store `kind` a fix-procedure claim is filed under — distinct from the dispatcher's own `fix` /
 *  `ci-heal` spawn claims, so a dispatcher's claim and the fixer's own claim never share one slot. */
export const FIXING_KIND = 'fixing';

/** A fix claim not heartbeat-refreshed for this long is dead and may be reclaimed. Long enough to cover a slow
 *  gate run between two heartbeats; short enough that a crashed fixer frees the PR within one coffee. */
export const DEFAULT_FIX_CLAIM_TTL_MINUTES = 20;

export const FIXING_LABEL = 'review-status:fixing';
/** The visible label a TERMINAL stand-down applies (`stand-down.mjs`), removed again by the next `fix-begin`. */
export const STOOD_DOWN_LABEL = 'review-status:stood-down';

/** The two — and only two — reasons `fix-begin --draft` accepts (operator ruling 2026-09-27,
 *  `we:docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal`). Every other repair loop stays
 *  ready; see the `@file` header above. */
export const FIX_DRAFT_REASONS = Object.freeze(['scope-change', 'withdrawn']);

/** The label named at `fix-begin --draft --reason=<r>` time, one per {@link FIX_DRAFT_REASONS}. Mutually
 *  exclusive with {@link FIXING_LABEL} and with each other — `fix-begin` applies exactly one. */
export const FIX_DRAFT_LABEL = Object.freeze({
  'scope-change': 'review-status:draft-scope-change',
  withdrawn: 'review-status:draft-withdrawn',
});

/** Stable first lines of the two marker comments. Treat as fixed once shipped. */
export const FIX_BEGIN_MARKER = '🔒 conveyor fix-begin — fix claim held';
export const FIX_END_MARKER = '🔓 conveyor fix-end — fix claim released';
/**
 * Durable mark on a fix-end comment whose turn ended `blocked-on-infra` (its own completion record says so). The
 * fixer-escalation ladder (`we:scripts/lib/ruling-ledger.mjs#fixerReturnsAfter`) counts fix-ends on a sent-back
 * head as misses; an outage is not a miss (live 2026-10-04, PR #3890: verify never ran, ENOTDIR, fixed by #3902).
 * The count is read off the PR thread, so the mark has to live there too. Pinned equal to the ledger's prefix.
 */
export const FIX_END_INFRA_STALL_MARK = '<!-- fix-end-outcome: blocked-on-infra -->';

/** Normalize a repo slug or key to the claim store's repo KEY (`we`, `frontierui`, …). Throws on an unknown one. */
export function repoKeyOf(repo) {
  const key = repoKeyForSlug(repo == null || repo === '' ? 'we' : repo);
  if (!key) throw new Error(`fix-procedure: ${repo} is not a constellation repo`);
  return key;
}

/** The claim owner for one fixer identity. */
export function fixClaimOwner(who) {
  const w = String(who ?? '').trim();
  if (!w) throw new TypeError('fix-procedure: a fixer identity (--who) is required');
  return `fixer:${w}`;
}

/** Strip `refs/heads/` so a branch compares equal however it was spelled. */
export function normalizeBranch(ref) {
  return String(ref ?? '').trim().replace(/^refs\/heads\//, '');
}

/** Is this claim entry still live at `nowMs`? Honors the TTL the claim was written with. */
export function isLiveFixClaim(entry, nowMs = Date.now()) {
  if (!entry) return false;
  const ttl = Number(entry.meta?.ttlMinutes) > 0 ? Number(entry.meta.ttlMinutes) : DEFAULT_FIX_CLAIM_TTL_MINUTES;
  return !isLeaseExpired(entry, nowMs, ttl);
}

/** Read the LIVE fix claim for one PR, or `null` (absent or expired). */
export function readLiveFixClaim({ repo, pr, lockRoot = fixDispatchClaimRoot(), nowMs = Date.now() } = {}) {
  const entry = readFixDispatchClaim({ repo: repoKeyOf(repo), pr: Number(pr), kind: FIXING_KIND, lockRoot });
  return isLiveFixClaim(entry, nowMs) ? entry : null;
}

/**
 * Does the caller identity own this claim entry? A claim taken from a Claude session is BOUND to that session id:
 * only the same session id holds it, and a matching `who` alone does not. `who` is published on the PR thread
 * (`**Who:** \`fix-<pr>\``), so it is not a secret and must never be the only proof when a session id was
 * recorded. `who` alone is enough only for a claim taken with no session id (a non-Claude worker, `WE_FIX_WHO`).
 */
export function isClaimHolder(entry, { sessionId = null, who = null, token = null } = {}) {
  if (!entry) return false;
  const bound = entry.meta?.sessionId ?? null;
  if (bound) return Boolean(sessionId) && sessionId === bound;
  return Boolean(who) && Boolean(entry.meta?.who) && entry.meta.who === who && tokenMatches(entry, token);
}

/** A per-claim secret for a claim taken with NO session id. `who` is public (the PR thread prints it, and two
 *  workers may pass the same conventional name), so a session-less claim is bound to this token instead: only
 *  its SHA-256 is stored, and `fix-begin` hands the token to its caller alone (`WE_FIX_TOKEN`). */
export function mintFixToken() { return randomBytes(24).toString('hex'); }
export function hashFixToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }
/** Does `token` match the claim's stored hash? A claim written with no hash (none is, since the token shipped)
 *  needs none. Constant-time compare. */
function tokenMatches(entry, token) {
  const want = entry.meta?.tokenHash ?? null;
  if (!want) return true;
  if (!token) return false;
  const a = Buffer.from(hashFixToken(token), 'hex');
  const b = Buffer.from(String(want), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Owner check for a MUTATION of an existing claim (re-take, heartbeat, release): same `who` AND, when the claim
 *  is session-bound, the same session id — else, the token `fix-begin` minted. Returns `null` when the caller may
 *  mutate it, else the refusal reason. */
function mutationRefusal(entry, { who, sessionId, token }) {
  if (entry.owner !== fixClaimOwner(who)) return 'not-owner';
  const bound = entry.meta?.sessionId ?? null;
  if (bound) return bound === sessionId ? null : 'session-mismatch';
  return tokenMatches(entry, token) ? null : 'token-mismatch';
}

/**
 * Is a DISPATCHER's spawn claim (`fix` / `ci-heal`) still live for this PR under a session name other than
 * `who`? Such a claim means the daemon already launched a fixer for this PR — a second fixer must refuse.
 */
function liveForeignDispatch({ repo, pr, who, lockRoot, nowMs }) {
  for (const kind of ['fix', 'ci-heal']) {
    const entry = readFixDispatchClaim({ repo, pr, kind, lockRoot });
    if (!entry || isLeaseExpired(entry, nowMs, DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES)) continue;
    let name = null;
    try { name = fixDispatchSessionName({ repo, pr, kind }); } catch { name = null; }
    if (name && name !== who) return { kind, session: name, owner: entry.owner };
  }
  return null;
}

/**
 * Take (or re-take) the fix claim for one PR. Refuses when another fixer's claim is live, or when the daemon
 * already dispatched a different fixer session for this PR.
 * @returns {{ok:boolean, reason:string, heldBy?:string|null, entry?:object, resource:string}}
 */
export function acquireFixClaim({
  repo, pr, who, why = '', sessionId = null, token = null, branch = null, headSha = null, draft = false, reason = null,
  lockRoot = fixDispatchClaimRoot(), nowMs = Date.now(), ttlMinutes = DEFAULT_FIX_CLAIM_TTL_MINUTES, host = hostname(),
} = {}) {
  const repoKey = repoKeyOf(repo);
  const prNum = Number(pr);
  const owner = fixClaimOwner(who);
  const resource = fixDispatchResource({ repo: repoKey, pr: prNum, kind: FIXING_KIND });
  const foreign = liveForeignDispatch({ repo: repoKey, pr: prNum, who, lockRoot, nowMs });
  if (foreign) {
    return { ok: false, reason: 'dispatched-fixer', heldBy: foreign.session, dispatchKind: foreign.kind, resource };
  }
  const prior = readLockEntry(lockRoot, resource);
  const own = prior && prior.owner === owner && isLiveFixClaim(prior, nowMs);
  // A live claim is never re-bound to another caller that merely knows the (public) `who`: it needs the bound
  // session id, or — for a session-less claim — the token its `fix-begin` minted.
  const refused = own ? mutationRefusal(prior, { who, sessionId, token }) : null;
  if (refused) return { ok: false, reason: refused, heldBy: prior.owner, resource };
  const boundSession = own ? prior.meta?.sessionId ?? null : sessionId || null;
  const newToken = !own && !boundSession ? mintFixToken() : null;
  const nowIso = new Date(nowMs).toISOString();
  const meta = {
    repo: repoKey, pr: prNum, kind: FIXING_KIND, who: String(who), why: String(why ?? ''),
    sessionId: boundSession,
    tokenHash: own ? prior.meta?.tokenHash ?? null : (newToken ? hashFixToken(newToken) : null),
    branch: branch ? normalizeBranch(branch) : (own ? prior.meta?.branch ?? null : null),
    headSha: headSha ?? (own ? prior.meta?.headSha ?? null : null),
    claimedAt: own ? prior.meta?.claimedAt ?? nowIso : nowIso,
    // The CURRENT hold's draft state — always the latest `fix-begin` call's own values, never merged forward
    // from a prior reentrant hold: a fixer may discover a scope-change mid-hold and re-`fix-begin --draft` the
    // SAME claim, and the newer call's intent must win.
    draft: Boolean(draft), reason: draft ? (reason ?? null) : null,
    ttlMinutes, host,
  };
  const result = reserve(lockRoot, resource, owner, nowMs, nowIso, null, 'unknown', ttlMinutes, meta);
  if (!result.ok) return { ok: false, reason: result.reason, heldBy: result.heldBy, resource };
  return {
    ok: true, reason: own ? 'own' : result.reason, heldBy: owner, entry: readLockEntry(lockRoot, resource), resource,
    // The one place the token is ever returned: to the worker that took the claim. It exports it as WE_FIX_TOKEN.
    ...(newToken ? { token: newToken } : {}),
  };
}

/** Heartbeat-refresh the caller's own claim. */
export function heartbeatFixClaim({ repo, pr, who, sessionId = null, token = null, lockRoot = fixDispatchClaimRoot(), nowMs = Date.now() } = {}) {
  const repoKey = repoKeyOf(repo);
  const resource = fixDispatchResource({ repo: repoKey, pr: Number(pr), kind: FIXING_KIND });
  const current = readLockEntry(lockRoot, resource);
  if (!current) return { refreshed: false, reason: 'absent' };
  const refused = mutationRefusal(current, { who, sessionId, token });
  if (refused) return { refreshed: false, reason: refused, heldBy: current.owner };
  heartbeat(lockRoot, resource, current.owner, new Date(nowMs).toISOString(), null, current.meta);
  return { refreshed: true };
}

/** Release the caller's own claim. Never touches a claim someone else holds. */
export function releaseFixClaim({ repo, pr, who, sessionId = null, token = null, lockRoot = fixDispatchClaimRoot() } = {}) {
  const repoKey = repoKeyOf(repo);
  const resource = fixDispatchResource({ repo: repoKey, pr: Number(pr), kind: FIXING_KIND });
  const current = readLockEntry(lockRoot, resource);
  if (!current) return { released: false, reason: 'absent' };
  const refused = mutationRefusal(current, { who, sessionId, token });
  if (refused) return { released: false, reason: refused, heldBy: current.owner };
  releaseLockDir(lockRoot, resource);
  return { released: true, entry: current };
}

/** Every LIVE fix claim (optionally for one repo). */
export function listLiveFixClaims({ repo = null, lockRoot = fixDispatchClaimRoot(), nowMs = Date.now() } = {}) {
  const repoKey = repo == null ? null : repoKeyOf(repo);
  return listFixDispatchClaims(lockRoot)
    .filter((e) => e.meta?.kind === FIXING_KIND && (repoKey == null || e.meta.repo === repoKey))
    .filter((e) => isLiveFixClaim(e, nowMs));
}

/**
 * THE PUSH CHECK. Given a push to `branch` (in `repo`, when known), is it refused because someone ELSE holds a
 * live fix claim on the PR that branch belongs to? `repo == null` matches a claim in any repo (fail-closed: a
 * couple's WE and FUI halves share a lane name, so an unknown repo may over-deny, never under-deny).
 * @returns {null | {refused:true, pr:number, repo:string, holder:string, why:string, message:string}}
 */
export function pushRefusal({
  repo = null, branch, sessionId = null, who = null, token = null, lockRoot = fixDispatchClaimRoot(), nowMs = Date.now(),
} = {}) {
  const b = normalizeBranch(branch);
  if (!b) return null;
  let repoKey = null;
  try { repoKey = repo == null ? null : repoKeyOf(repo); } catch { repoKey = null; }
  const claims = listLiveFixClaims({ lockRoot, nowMs })
    .filter((e) => e.meta?.branch === b && (repoKey == null || e.meta.repo === repoKey));
  for (const entry of claims) {
    if (isClaimHolder(entry, { sessionId, who, token })) continue;
    const holder = entry.meta.who;
    // Draft is no longer a given (operator ruling 2026-09-27, draft-only-on-withdrawal): only say "the PR is
    // draft" when this held claim actually drafted it.
    const draftNote = entry.meta.draft ? ' (the PR is draft until then)' : '';
    return {
      refused: true, pr: entry.meta.pr, repo: entry.meta.repo, holder,
      why: entry.meta.why || '',
      message: `push to ${b} refused: ${holder} holds the fix claim on PR #${entry.meta.pr} (${entry.meta.repo})`
        + `${entry.meta.why ? ` — ${entry.meta.why}` : ''}. Only the claim holder may push while it is live. Wait `
        + `for its \`fix-end\`${draftNote}, or coordinate with ${holder}. `
        + 'See we:scripts/conveyor/fix-procedure.mjs.',
    };
  }
  return null;
}

/** The caller identity a push/claim check uses: the Claude session id, then the `WE_FIX_WHO` worker name. */
export function callerIdentity(env = process.env) {
  return { sessionId: env.CLAUDE_CODE_SESSION_ID || null, who: env.WE_FIX_WHO || null, token: env.WE_FIX_TOKEN || null };
}

/** Map a git remote URL to a constellation repo key, or `null`. Pure. */
export function repoKeyFromRemoteUrl(url) {
  const m = /github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? repoKeyForSlug(m[1]) : null;
}

/**
 * The push-claim check for a caller that already owns its OWN injected git `run(cmd,args,opts) ->
 * {status,stdout,stderr}` — the shared rebase/heal plumbing (`rebase-drop-content.mjs`, `rebase-drop-
 * manifest.mjs`, `nnn-collision-heal.mjs`) and `review-prep-io.mjs`'s push-only path all take one. Wiring
 * {@link pushRefusal} in HERE (once), rather than only at each of their callers, is what makes the invariant
 * hold "by construction" (#4293) — `rebaseDropManifest` alone has a second caller (`scripts/lane-resume.mjs`)
 * that a caller-side check would miss entirely. Derives the repo key off the SAME injected `run`, never a
 * subprocess of its own, so the three plumbing libs' "pure, injectable-run" test contract stays intact: a
 * scripted test `run` that doesn't stub `remote get-url` simply resolves no repo key, which degrades to
 * `pushRefusal`'s already-safe `repo:null` (any-repo, fail-closed) match — never a thrown error.
 * @param {{run:Function, cwd?:string, remote?:string, branch:string}} o
 * @returns {null | {refused:true, pr:number, repo:string, holder:string, why:string, message:string}}
 */
export function refuseHeldPush({ run, cwd, remote = 'origin', branch }) {
  let repo = null;
  try {
    const url = run('git', ['remote', 'get-url', remote], cwd ? { cwd } : {});
    if (url && Number(url.status) === 0) repo = repoKeyFromRemoteUrl(String(url.stdout || '').trim());
  } catch { repo = null; }
  return pushRefusal({ repo, branch, ...callerIdentity() });
}

/** The repo key a checkout PATH pushes to via `remote` (default `origin`), or `null` on any failure. `cwd` is a
 *  directory, never a `owner/name` slug — a slug is not a directory, so it always reads `null`. */
export function repoKeyForCheckout(cwd, { remote = 'origin', exec = execFileSync } = {}) {
  try {
    const url = exec('git', ['remote', 'get-url', remote], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return repoKeyFromRemoteUrl(url);
  } catch { return null; }
}

/**
 * Read the remote and refspecs of the first `git push` in a shell command. Pure. `null` when there is no push.
 * Options are skipped (`-o`/`--push-option`/`--receive-pack`/`--exec` take a separate value); `--repo=<r>` names
 * the remote. `all` is set for `--all` / `--mirror` (every branch). `dir` is the last `git -C <dir>` (quoted or
 * not), so the push is resolved in the checkout it actually runs in. Stops at the first shell separator.
 * @returns {null | {remote: ?string, refspecs: string[], all: boolean, dir: ?string}}
 */
export function parseGitPush(cmd) {
  const first = parseGitPushes(cmd)[0];
  if (!first) return null;
  const { before, retarget, ...push } = first; // eslint-disable-line no-unused-vars
  return push;
}

/** A `cd` anywhere before a push, including as the command's first word (`cd d && git push`). */
const CD_BEFORE = /(?:^|[;&|\n]\s*)cd(?:\s|$)/;

/**
 * Every `git push` in a shell command, in order (each read exactly as {@link parseGitPush} reads the first one,
 * with its own remote / refspecs / `-C <dir>`). Pure. `[]` when there is no push. `before` is the text that
 * precedes the push in the command — what {@link pushTargetUnreliable} inspects.
 * `retarget` is set when a `cd` precedes the push (anywhere, including as the command's first word) or `--git-dir` /
 * `--work-tree` is given: the push then runs in a repo the hook never resolved.
 * @returns {Array<{remote: ?string, refspecs: string[], all: boolean, dir: ?string, before: string, retarget: boolean}>}
 */
export function parseGitPushes(cmd, prefix = '') {
  const text = String(cmd ?? '');
  const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
  // Any git GLOBAL option may sit between `git` and `push` (`--no-pager`, `--git-dir=…`, `-C d`, `-c k=v`, …) — the
  // same spellings `guard-bash.mjs#canonicalGitOp` peels, so a push it recognises is always parsed here too.
  const GLOBAL = String.raw`(?:\s+(?:-[Cc]\s+${ARG}|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)(?:=${ARG}|\s+${ARG})|--?[A-Za-z][\w-]*(?:=${ARG})?))*`;
  const re = new RegExp(String.raw`\bgit\b(${GLOBAL})\s+push\b([^;&|\n]*)`, 'g');
  const unq = (t) => t.replace(/^['"]|['"]$/g, '');
  const VALUED = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
  const out = [];
  for (const m of text.matchAll(re)) {
    const dirs = [...m[1].matchAll(new RegExp(String.raw`-C\s+(${ARG})`, 'g'))].map((d) => unq(d[1]));
    const toks = m[2].trim().split(/\s+/).filter(Boolean).map(unq);
    let remote = null;
    let all = false;
    const pos = [];
    for (let i = 0; i < toks.length; i += 1) {
      const t = toks[i];
      if (t.startsWith('--repo=')) { remote = t.slice('--repo='.length) || null; continue; }
      if (VALUED.has(t)) { if (t === '--repo') remote = toks[i + 1] ?? null; i += 1; continue; }
      if (t === '--all' || t === '--mirror' || t === '--branches') { all = true; continue; }
      if (t.startsWith('-')) continue;
      pos.push(t);
    }
    if (!remote && pos.length) remote = pos.shift();
    const before = prefix ? `${prefix} ; ${text.slice(0, m.index)}` : text.slice(0, m.index);
    // `--git-dir` / `--work-tree` re-point git at another repo, exactly as a preceding `cd` does.
    out.push({ remote, refspecs: pos, all, dir: dirs.length ? dirs[dirs.length - 1] : null, before, retarget: /--(?:git-dir|work-tree)\b/.test(m[1]) || CD_BEFORE.test(before) });
  }
  return out;
}

/**
 * Is this push's implicit target unresolvable from the hook's point of view? The hook resolves targets BEFORE the
 * command runs, so a bare / `<remote>`-only / `HEAD` push that FOLLOWS a `git checkout` / `git switch` (or a `cd`
 * / `gh pr checkout` / `git worktree`, or `--git-dir`) updates a branch the hook never saw. Pure. An explicit ref is
 * always resolved exactly, so it is never unreliable.
 */
export function pushTargetUnreliable(push) {
  if (!push) return false;
  const implicit = !push.refspecs.length || push.refspecs.some((r) => /^(?:\+?[^:]*:)?(?:HEAD|@)$/.test(r) || /^\+?(?:HEAD|@)$/.test(r));
  if (!implicit) return false;
  const before = push.before ?? '';
  return Boolean(push.retarget) || CD_BEFORE.test(before)
    || /\bgit\b[^;&|\n]*\s(?:checkout|switch|worktree)\b/.test(before) || /\bgh\s+(?:pr\s+checkout|co)\b/.test(before);
}

/**
 * Where does this `git push` actually go? The repo KEY of the remote pushed to (never assumed `origin`), and every
 * branch it may update — including the IMPLICIT target of a bare `git push` / `git push <remote>` / `git push
 * <remote> HEAD`, which names no ref at all. Fail-closed: when the target is implicit, every candidate git could
 * pick (the `@{push}` ref, the upstream `merge` ref, the current branch's own name) is returned. `--all` /
 * `--mirror` / a glob refspec returns `*` (every branch). Resolved in the `git -C <dir>` checkout when given.
 * `null` when the command has no push. `exec` is injectable for tests.
 * @returns {null | {repoKey: ?string, branches: string[]}}
 */
export function resolvePushDestination(cmd, opts = {}) {
  const push = parseGitPush(cmd);
  return push ? resolveParsedPush(push, opts) : null;
}

/** Every push in the command resolved separately (each in its own `-C` checkout / remote), in order. */
export function resolvePushDestinations(cmd, opts = {}) {
  return parseGitPushes(cmd, opts.prefix).map((push) => {
    const dest = resolveParsedPush(push, opts);
    // A push that runs after a `cd` / with `--git-dir` lands in a repo we did not resolve: its repo key is unknown (null =
    // matched against every live claim), even when its refspec is explicit.
    return { ...dest, ...(push.retarget ? { repoKey: null } : {}), unreliable: pushTargetUnreliable(push) };
  });
}

function resolveParsedPush(push, { cwd: baseCwd = process.cwd(), exec = execFileSync } = {}) {
  const cwd = push.dir ? resolve(baseCwd, push.dir) : baseCwd;
  const git = (args) => {
    try { return String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }) ?? '').trim() || null; } catch { return null; }
  };
  let current;
  const currentBranch = () => (current === undefined ? (current = git(['symbolic-ref', '-q', '--short', 'HEAD'])) : current);
  let remote = push.remote;
  if (!remote) {
    const b = currentBranch();
    remote = (b && git(['config', '--get', `branch.${b}.pushRemote`])) || git(['config', '--get', 'remote.pushDefault'])
      || (b && git(['config', '--get', `branch.${b}.remote`])) || 'origin';
  }
  const repoKey = /[:/]/.test(remote) ? repoKeyFromRemoteUrl(remote) : repoKeyForCheckout(cwd, { remote, exec });
  // `configured` — the push names no refspec at all (bare / `<remote>`-only), so `remote.<name>.push` and
  // `push.default=matching` decide what is updated. An explicit `HEAD` refspec is never widened by either.
  const implicit = ({ configured = false } = {}) => {
    const b = currentBranch();
    const out = [];
    if (configured) {
      const cfgSpecs = (git(['config', '--get-all', `remote.${remote}.push`]) ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
      for (const spec of cfgSpecs) {
        const sp = spec.replace(/^\+/, '');
        if (sp.includes('*')) { out.push('*'); continue; }
        const dst = sp.includes(':') ? sp.slice(sp.indexOf(':') + 1) : sp;
        if (dst && dst !== 'HEAD' && dst !== '@') out.push(normalizeBranch(dst));
      }
      // `matching` updates every branch that exists on both sides — unknowable cheaply, so every branch.
      // …but only when no `remote.<name>.push` refspec is configured: that setting overrides `push.default`.
      if (!cfgSpecs.length && git(['config', '--get', 'push.default']) === 'matching') out.push('*');
    }
    if (b) out.push(b);
    const pushRef = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
    if (pushRef) out.push(pushRef.startsWith(`${remote}/`) ? pushRef.slice(remote.length + 1) : pushRef);
    const merge = b && git(['config', '--get', `branch.${b}.merge`]);
    if (merge) out.push(normalizeBranch(merge));
    return out;
  };
  const branches = [];
  if (push.all) branches.push('*');
  else if (!push.refspecs.length) branches.push(...implicit({ configured: true }));
  for (const spec of push.refspecs) {
    const s = spec.replace(/^\+/, '');
    if (s.includes('*')) { branches.push('*'); continue; }
    const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
    if (!dst || dst === 'HEAD' || dst === '@') branches.push(...implicit());
    else branches.push(normalizeBranch(dst));
  }
  return { repoKey, branches: [...new Set(branches)] };
}

// ── marker comments (pure) ────────────────────────────────────────────────────────────────────────────────────

export function buildFixBeginComment({
  who, why = '', branch = null, headSha = null, ttlMinutes = DEFAULT_FIX_CLAIM_TTL_MINUTES, draft = false, reason = null,
}) {
  const statusLine = draft
    ? `The PR is now **draft** (\`${reason}\`) — `
      + (reason === 'withdrawn'
        ? 'review found this PR does not do what the card asked at all.'
        : 'a scope-change request reached this fix mid-review.')
      + ' It stays draft until required CI is green on a new head (draft-first promotion), and review re-runs from there.'
    : 'The PR stays **ready for review** — a normal repair loop never drafts it; the fix claim itself is the '
      + 'lock, so no review/fix/ci-heal races it and no push from anyone else lands while it is live.';
  return [
    FIX_BEGIN_MARKER,
    '',
    `**Who:** \`${who}\``,
    `**Why:** ${why || '(not stated)'}`,
    branch ? `**Branch:** \`${branch}\`${headSha ? ` at \`${String(headSha).slice(0, 9)}\`` : ''}` : null,
    '',
    statusLine,
    '',
    `While this claim is live (${ttlMinutes}-minute TTL, heartbeat-refreshed while the fixer runs): no review or `
      + 'advisory is dispatched, no other fixer starts, and pushes to this branch by anyone but the holder are '
      + 'refused. See we:docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal.',
    `<!-- fix-claim who=${who} -->`,
  ].filter((l) => l !== null).join('\n');
}

export function buildFixEndComment({ who, headSha = null, draft = false, infraStall = false }) {
  const tail = draft
    ? 'The PR stays a draft; the fix daemon marks it ready once required CI is green, and review re-runs from there.'
    : 'The PR was never drafted for this claim — it stays ready; nothing further is owed here, and dispatch '
      + '(review/ci-heal) resumes normally on the next tick.';
  return [
    FIX_END_MARKER,
    '',
    `\`${who}\` released the fix claim${headSha ? ` at \`${String(headSha).slice(0, 9)}\`` : ''}. ${tail}`,
    ...(infraStall ? [
      '',
      'This turn ended **blocked on infrastructure** (its completion record says `blocked-on-infra`), not on the '
        + 'fix itself: it is retried after the infra cool-off and is **not** counted as a fixer miss on the '
        + 'escalation ladder.',
      FIX_END_INFRA_STALL_MARK,
    ] : []),
  ].join('\n');
}

/**
 * Did THIS fix turn end `blocked-on-infra`? Read off the session's own completion record (written by the fixer
 * right before `fix-end`, per `fix-agent-brief.md`). Only a `done` record of THIS session counts: a record from
 * another session id, or (with no session id to compare) one older than this claim, is a different turn. Pure.
 * @param {object|null} record  the completion record for `who`
 * @param {{sessionId?:string|null, claimedAt?:string|null}} o
 */
export function isInfraStallCompletion(record, { sessionId = null, claimedAt = null } = {}) {
  if (!record || record.status !== 'done' || record.outcome !== 'blocked-on-infra') return false;
  if (record.sessionId && sessionId) return record.sessionId === sessionId;
  if (record.sessionId && !sessionId) return false;
  const updated = Date.parse(record.updatedAt ?? '');
  const claimed = Date.parse(claimedAt ?? '');
  return Number.isFinite(updated) && (!Number.isFinite(claimed) || updated >= claimed);
}

const readCompletionDefault = async (who) => {
  const { tryReadCompletion } = await import('../operations/completion-store.mjs');
  return tryReadCompletion(String(who));
};

/**
 * The recovery hint appended to a fixer's prompt when a previous fixer saved its work on a side branch
 * (`stand-down.mjs --reason=concurrent-author --alt=<branch>`). Pure. Returns `prompt` unchanged with no alt.
 */
export function withAltBranchHint(prompt, alt) {
  if (!alt || !alt.branch) return prompt;
  return `${prompt}\n\n---\n\n## Saved repair to recover FIRST\n\n`
    + `A previous fixer of this PR stood down for a concurrent author and saved its repair on \`${alt.branch}\``
    + `${alt.sha ? ` (\`${String(alt.sha).slice(0, 9)}\`)` : ''}. Start from it — do not redo that work:\n\n`
    + '```bash\n'
    + `git fetch origin ${alt.branch}\n`
    + `git log --oneline HEAD..FETCH_HEAD   # what the saved repair adds on top of the current head\n`
    + 'git cherry-pick <the saved commits>   # or rebase them onto the current head; drop what the head already covers\n'
    + '```\n\n'
    + 'Keep only the parts the current head does not already cover, then continue the normal arc (gate, push, re-arm, `fix-end`).';
}

// ── IO shell ──────────────────────────────────────────────────────────────────────────────────────────────────

function ghDefault(args) {
  // Lazy import so the pure exports above stay free of the throttle's module graph for importers like guard-bash.
  return import('../lib/gh-throttle.mjs').then(({ runGhSync }) => runGhSync(args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: `fix-procedure:${args[1] ?? args[0]}` },
  }));
}

async function labelProviderDefault() {
  const { createGhProvider } = await import('../lib/review-label-provider.mjs');
  return createGhProvider();
}

/** Human-readable refusal, alongside the CLI JSON result. */
export function fixBeginRefusalMessage(result) {
  const message = `✗ fix-begin refused on PR #${result.pr}: ${result.reason} — held by ${result.heldBy ?? 'unknown'}`;
  return result.reason === 'dispatched-fixer'
    ? `${message} (daemon ${result.dispatchKind} dispatch claim; it frees on that session's stand-down/exit or its 10-minute TTL)`
    : message;
}

/**
 * `fix-begin`: claim → (draft, only for an explicit reason) → label → marker comment. Default (operator ruling
 * 2026-09-27, draft-only-on-withdrawal): NO draft — the PR stays ready, `review-status:fixing` is the visible
 * signal, and the claim itself is the lock. Pass `draft: true` with `reason: 'scope-change'|'withdrawn'` to also
 * convert the PR to draft with its own reason label; a failure to convert RELEASES the claim and fails (a claim
 * on a still-ready PR when a draft WAS requested would let review race the fix). `draft` requires a valid
 * `reason`, and `reason` requires `draft: true` — anything else is refused before any IO happens.
 */
export async function fixBegin({
  repo, pr, who, why = '', sessionId = callerIdentity().sessionId, token = callerIdentity().token, gh = ghDefault, labels = null,
  lockRoot = fixDispatchClaimRoot(), nowMs = Date.now(), ttlMinutes = DEFAULT_FIX_CLAIM_TTL_MINUTES,
  draft = false, reason = null,
} = {}) {
  const repoKey = repoKeyOf(repo);
  if (draft && !FIX_DRAFT_REASONS.includes(reason)) {
    return { ok: false, reason: 'draft-reason-required', pr: Number(pr), detail: `--draft needs --reason=${FIX_DRAFT_REASONS.join('|')}` };
  }
  if (!draft && reason != null) {
    return { ok: false, reason: 'reason-without-draft', pr: Number(pr), detail: '--reason is only valid with --draft' };
  }
  const slug = CONSTELLATION_REPOS[repoKey].slug;
  const view = JSON.parse(String(await gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'headRefName,headRefOid,isDraft,state,labels'])));
  if (view.state && view.state !== 'OPEN') return { ok: false, reason: 'not-open', pr: Number(pr) };
  const claim = acquireFixClaim({
    repo: repoKey, pr, who, why, sessionId, token, branch: view.headRefName, headSha: view.headRefOid, lockRoot, nowMs, ttlMinutes,
    draft, reason,
  });
  if (!claim.ok) return { ok: false, reason: claim.reason, heldBy: claim.heldBy, ...(claim.dispatchKind ? { dispatchKind: claim.dispatchKind } : {}), pr: Number(pr) };
  const heldToken = claim.token ?? token;
  const steps = [];
  try {
    if (draft && !view.isDraft) { await gh(['pr', 'ready', String(pr), '--repo', slug, '--undo']); steps.push('draft'); }
  } catch (e) {
    releaseFixClaim({ repo: repoKey, pr, who, sessionId, token: heldToken, lockRoot });
    return { ok: false, reason: 'draft-failed', detail: String(e?.message ?? e).split('\n')[0], pr: Number(pr) };
  }
  // Label + comment are the human-visible half: best-effort, reported, never a reason to drop the claim.
  const provider = labels ?? await labelProviderDefault();
  const wantLabel = draft ? FIX_DRAFT_LABEL[reason] : FIXING_LABEL;
  // Every OTHER label in this claim's family is stale the moment one is applied — mutually exclusive by design.
  const familyLabels = [FIXING_LABEL, ...Object.values(FIX_DRAFT_LABEL)].filter((l) => l !== wantLabel);
  try {
    provider.ensureLabel(slug, wantLabel, { color: 'c5def5', description: 'informative: a reviewer/fixer is currently working this PR, or stuck (auto-managed)' });
    const present = (view.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
    const toRemove = [STOOD_DOWN_LABEL, ...familyLabels].filter((l) => present.includes(l));
    provider.setLabels(slug, Number(pr), { add: wantLabel, remove: toRemove });
    steps.push('label');
  } catch (e) { steps.push(`label-failed: ${String(e?.message ?? e).split('\n')[0]}`); }
  if (claim.reason !== 'own') {
    try {
      provider.postComment(slug, Number(pr), buildFixBeginComment({ who, why, branch: view.headRefName, headSha: view.headRefOid, ttlMinutes, draft, reason }));
      steps.push('comment');
    } catch (e) { steps.push(`comment-failed: ${String(e?.message ?? e).split('\n')[0]}`); }
  }
  return {
    ok: true, pr: Number(pr), repo: repoKey, who, branch: view.headRefName, headSha: view.headRefOid,
    draft, reason: draft ? reason : null, reentrant: claim.reason === 'own', steps,
    // A session-less claim's token, returned to its caller only: export it as WE_FIX_TOKEN for push / fix-end.
    ...(claim.token ? { token: claim.token } : {}),
  };
}

/**
 * `fix-end`: release → drop whichever label `fix-begin` applied → marker comment. A claim that never drafted
 * the PR (the default, operator ruling 2026-09-27) leaves it exactly as it was — READY — and owes nothing
 * further: this does NOT rely on the draft-first promotion, because there was never a draft to promote out of.
 * A claim that DID draft the PR (`--draft --reason=scope-change|withdrawn`) is deliberately LEFT DRAFT — that
 * half still relies on the draft-first promotion (`reconcile-core.mjs` `promote-draft`) to mark it ready once
 * required CI is green. Unlike TTL expiry, this explicit action removes the withdrawal reason label,
 * lifting the promotion hold.
 */
export async function fixEnd({
  repo, pr, who, sessionId = callerIdentity().sessionId, token = callerIdentity().token, gh = ghDefault, labels = null, lockRoot = fixDispatchClaimRoot(),
  readCompletion = readCompletionDefault,
} = {}) {
  const repoKey = repoKeyOf(repo);
  const slug = CONSTELLATION_REPOS[repoKey].slug;
  const rel = releaseFixClaim({ repo: repoKey, pr, who, sessionId, token, lockRoot });
  if (!rel.released) return { ok: false, reason: rel.reason, heldBy: rel.heldBy ?? null, pr: Number(pr) };
  const wasDraft = Boolean(rel.entry?.meta?.draft);
  const draftReason = rel.entry?.meta?.reason ?? null;
  const heldLabel = wasDraft && FIX_DRAFT_LABEL[draftReason] ? FIX_DRAFT_LABEL[draftReason] : FIXING_LABEL;
  const steps = [];
  let headSha = null;
  try { headSha = JSON.parse(String(await gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'headRefOid']))).headRefOid ?? null; } catch { headSha = null; }
  let infraStall = false;
  try {
    infraStall = isInfraStallCompletion(await readCompletion(who), { sessionId, claimedAt: rel.entry?.meta?.claimedAt ?? null });
  } catch { infraStall = false; }
  const provider = labels ?? await labelProviderDefault();
  try { provider.setLabels(slug, Number(pr), { remove: [heldLabel] }); steps.push('unlabel'); } catch (e) { steps.push(`unlabel-failed: ${String(e?.message ?? e).split('\n')[0]}`); }
  try { provider.postComment(slug, Number(pr), buildFixEndComment({ who, headSha, draft: wasDraft, infraStall })); steps.push('comment'); } catch (e) { steps.push(`comment-failed: ${String(e?.message ?? e).split('\n')[0]}`); }
  return { ok: true, pr: Number(pr), repo: repoKey, who, headSha, draft: wasDraft, reason: draftReason, infraStall, steps };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (const a of rest) {
    if (a.startsWith('--')) { const eq = a.indexOf('='); if (eq === -1) flags[a.slice(2)] = true; else flags[a.slice(2, eq)] = a.slice(eq + 1); } else pos.push(a);
  }
  // Drained writes before every exit (check:standards `emit-then-exit`): a piped stdout must never be truncated.
  const { writeLineSync } = await import('../lib/write-all-sync.mjs');
  const out = (o, code = 0) => { writeLineSync(1, JSON.stringify(o)); process.exit(code); };
  const fail = (m) => { writeLineSync(2, `✗ fix-procedure: ${m}`); process.exit(1); };
  const USAGE = 'usage: fix-procedure.mjs <fix-begin|fix-end|fix-heartbeat|fix-status> <pr> --repo=<slug|key> [--who=<session|worker>] [--why=<text>]\n'
    + '                                    [fix-begin only] [--draft --reason=scope-change|withdrawn]\n'
    + '       fix-procedure.mjs push-check --branch=<lane/…> [--repo=…]\n'
    + '       fix-procedure.mjs push --branch=<lane/…> [--src=HEAD] [--remote=origin] [--repo=…]';
  const id = callerIdentity();
  const who = typeof flags.who === 'string' ? flags.who : (id.who || null);
  const repo = typeof flags.repo === 'string' ? flags.repo : 'we';
  try {
    if (cmd === 'fix-begin' || cmd === 'fix-end' || cmd === 'fix-heartbeat' || cmd === 'fix-status') {
      const pr = Number(pos[0]);
      if (!Number.isInteger(pr) || pr <= 0) fail(USAGE);
      // A PR number means nothing without its repo: defaulting to `we` claimed an unrelated WE PR for a
      // frontierui repair. So the repo is REQUIRED here — never guessed.
      if (typeof flags.repo !== 'string' || !flags.repo) fail(`${cmd} needs --repo=<slug|key> — a PR number is only unique within its repo`);
      if (cmd === 'fix-status') {
        const e = readLiveFixClaim({ repo, pr });
        out({
          pr, claimed: Boolean(e), who: e?.meta?.who ?? null, why: e?.meta?.why ?? null, branch: e?.meta?.branch ?? null,
          draft: e?.meta?.draft ?? false, draftReason: e?.meta?.reason ?? null, heartbeatAt: e?.heartbeatAt ?? null,
        });
      }
      if (!who) fail(`${cmd} needs --who=<session|worker> (or WE_FIX_WHO)`);
      if (cmd === 'fix-begin') {
        // Default: no draft — the PR stays ready (operator ruling 2026-09-27, draft-only-on-withdrawal).
        // `--draft` needs `--reason=scope-change|withdrawn`; `fixBegin` itself refuses any other combination.
        const draft = flags.draft === true || flags.draft === 'true';
        const draftReason = typeof flags.reason === 'string' ? flags.reason : null;
        const r = await fixBegin({ repo, pr, who, why: typeof flags.why === 'string' ? flags.why : '', draft, reason: draftReason });
        if (!r.ok) writeLineSync(2, fixBeginRefusalMessage(r));
        out(r, r.ok ? 0 : 3);
      }
      if (cmd === 'fix-end') { const r = await fixEnd({ repo, pr, who, sessionId: id.sessionId, token: id.token }); out(r, r.ok ? 0 : 3); }
      const r = heartbeatFixClaim({ repo, pr, who, sessionId: id.sessionId, token: id.token });
      out(r, r.refreshed ? 0 : 3);
    }
    if (cmd === 'push-check' || cmd === 'push') {
      const branch = normalizeBranch(flags.branch);
      if (!branch.startsWith('lane/')) fail('--branch=lane/<name> is required (only lane refs are pushable)');
      const remote = typeof flags.remote === 'string' ? flags.remote : 'origin';
      // The repo is the one this push actually goes to: `--repo`, else the URL of the `--remote` pushed to.
      const repoKey = typeof flags.repo === 'string' ? repoKeyOf(flags.repo) : repoKeyForCheckout(process.cwd(), { remote });
      const refusal = pushRefusal({ repo: repoKey, branch, sessionId: id.sessionId, who, token: id.token });
      if (refusal) { writeLineSync(2, `✗ ${refusal.message}`); out({ ok: false, ...refusal }, 3); }
      if (cmd === 'push-check') out({ ok: true, branch, repo: repoKey });
      const src = typeof flags.src === 'string' ? flags.src : 'HEAD';
      execFileSync('git', ['push', remote, `${src}:refs/heads/${branch}`], { stdio: ['ignore', 'inherit', 'inherit'] });
      out({ ok: true, pushed: true, branch, repo: repoKey });
    }
    fail(USAGE);
  } catch (e) {
    fail(String(e?.message ?? e).split('\n')[0]);
  }
}
