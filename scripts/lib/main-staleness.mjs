/**
 * main-staleness.mjs — the fetch-first staleness guard (#2204) for any CLI that READS local backlog/git state
 * to make a decision (the readiness ranker behind `/batch`, `/next`, `/ready`). The LANDING scripts already
 * fetch; the read side did not, so a local checkout behind `origin/main` — seen 2026-07-03 at 126 commits
 * behind — makes the ranker pick/order against WRONG item state (missing items, resolved-looking-open,
 * clobbered-looking ids). This guard fetches first and either fast-forwards a clean checkout or warns loudly.
 *
 * Non-destructive + fail-soft: the fetch is best-effort (a network miss → `{ offline:true }`, never a hard
 * fail); the auto-ff is `--ff-only --autostash` (advance main, autostash-preserve any dirty edits, never
 * force/rebase) and runs on any NON-DIVERGED tree, dirty or clean — `--autostash` exists precisely to carry a
 * dirty tree across a fast-forward, so gating it on a clean tree (the old `!dirty` guard) blocked the very case
 * autostash solves and left the ranker reading STALE. Only a DIVERGED tree (local ahead) is warned, never
 * touched; and if the autostash-ff itself fails (e.g. a stash-pop conflict) it falls back to a warn.
 *
 * The pure classifier (`classifyStaleness`) is unit-tested separately from the git IO (`checkMainStaleness`
 * takes an injected `run` so it needs no real repo).
 */

import { spawnSync } from 'node:child_process';
import { realpathSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastGoodForClone, rebuildGraceForClone } from './daemon-last-good.mjs';

/** Default git runner — spawnSync (returns non-zero without throwing). */
export function gitRun(args, opts = {}) {
  // A synchronous preflight must not leave Git's detached maintenance writing the checkout.
  const r = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Classify a local-vs-origin comparison into an action. Pure.
 *   { fresh:true }                 — up to date (behind 0).
 *   { action:'auto-ff' }           — behind, NOT diverged (dirty or clean) → safe to autostash fast-forward.
 *   { action:'warn', warning }     — behind AND diverged (local ahead), or autoFf off → read may be stale; warn, don't touch.
 *
 * `cleanOnly` (#3474) is the stricter gate for a DISPATCH chokepoint that must never touch a tree it does not
 * own: auto-ff ONLY when the tree is clean (nothing for `--autostash` to carry) AND `HEAD` is on `base`
 * (`onBase`, default true so a caller that has not measured it is unchanged). Every other behind case warns,
 * with a machine-readable `reason`: `diverged` | `dirty` | `not-on-base` | `not-auto-syncing`.
 * @param {{behind:number, ahead:number, dirty:boolean, autoFf:boolean, base?:string, cleanOnly?:boolean, onBase?:boolean}} o
 */
export function classifyStaleness({ behind, ahead, dirty, autoFf, base = 'main', cleanOnly = false, onBase = true }) {
  if (!behind || behind <= 0) return { fresh: true, behind: 0, ahead };
  // Auto-ff any non-diverged tree, dirty included: the pull is `--ff-only --autostash`, which stashes a dirty
  // tree, fast-forwards, and pops it back. Only a diverged tree (local commits ahead) can't ff — warn there.
  const diverged = !!ahead && ahead > 0;
  if (autoFf && !diverged && (!cleanOnly || (!dirty && onBase))) return { action: 'auto-ff', behind, ahead: 0, dirty };
  const why = diverged ? `diverged (${ahead} local commit(s))` : 'not auto-syncing';
  const reason = diverged ? 'diverged' : !autoFf ? 'not-auto-syncing' : dirty ? 'dirty' : 'not-on-base';
  return {
    action: 'warn', reason, behind, ahead, dirty,
    warning: `local ${base} is ${behind} commit(s) behind origin/${base} (${why}) — ranking/selection may be STALE. `
      + `Sync (git pull --ff-only --autostash) or work in a fresh clone off origin/${base}.`,
  };
}

/**
 * Fetch origin/<base>, compare to local <base>, and either fast-forward (clean) or return a warning. Fail-soft.
 *
 * `cleanOnly` (#3474) switches the sync to the dispatch-safe form: fast-forward ONLY a clean tree whose `HEAD` is
 * on `base`, via a plain `git merge --ff-only origin/<base>` (the fetch already ran) — never `pull --autostash`,
 * which would stash and pop a dirty tree the caller does not expect mutated. Diverged, dirty-and-behind, or
 * off-`base` all return the warn with a `reason`; the sync is not attempted.
 * @param {{base?:string, autoFf?:boolean, cleanOnly?:boolean, run?:typeof gitRun}} o
 * @returns {{offline?:true}|{fresh:true,behind:0}|{synced:true,behind:number}|{action:'warn',reason?:string,behind,ahead,dirty,warning:string}}
 */
export function checkMainStaleness({ base = 'main', autoFf = true, cleanOnly = false, run = gitRun } = {}) {
  const fetched = run(['fetch', 'origin', base, '--quiet']);
  if (fetched.status !== 0) return { offline: true };
  const rev = (a) => { const r = run(['rev-parse', a]); return r.status === 0 ? r.stdout.trim() : null; };
  const local = rev(base);
  const origin = rev(`origin/${base}`);
  if (!local || !origin) return { offline: true };
  if (local === origin) return { fresh: true, behind: 0 };
  const count = (range) => { const r = run(['rev-list', '--count', range]); return r.status === 0 ? Number(r.stdout.trim()) || 0 : 0; };
  const behind = count(`${base}..origin/${base}`);
  const ahead = count(`origin/${base}..${base}`);
  const st = run(['status', '--porcelain']);
  const dirty = !!(st.stdout && st.stdout.trim());
  let onBase = true;
  if (cleanOnly) {
    const head = run(['symbolic-ref', '--short', 'HEAD']);
    onBase = head.status === 0 && head.stdout.trim() === base;
  }
  const cls = classifyStaleness({ behind, ahead, dirty, autoFf, base, cleanOnly, onBase });
  if (cls.action === 'auto-ff') {
    const synced = cleanOnly ? run(['merge', '--ff-only', `origin/${base}`]) : run(['pull', '--ff-only', '--autostash']);
    // `from`/`to` (xgqz204): the SHAs the fast-forward moved between, so a caller can tell which files changed
    // under its own feet (see `selfFastForwardAction`).
    if (synced.status === 0) return { synced: true, behind, from: local, to: origin };
    return {
      action: 'warn', reason: 'ff-failed', behind, ahead, dirty,
      warning: `local ${base} is ${behind} behind origin/${base} and the auto fast-forward failed — sync by hand.`,
      ...(cleanOnly && synced.stderr.trim() ? { detail: synced.stderr.trim() } : {}),
    };
  }
  return cls;
}

// ── #3875 — the throwing dispatch-chokepoint guard, extracted from we:scripts/operations/review-dispatch.mjs
//    (#3439/#3474/#3637) so a caller that is NOT review-dispatch (a future daemon split out of
//    we:skills-src/conveyor/runner.mjs — epic #3383, see #3860) can self-check its own checkout's freshness
//    without importing the whole review-dispatch module just for this one guard. `review-dispatch.mjs` keeps
//    re-exporting `assertMainNotStale` from here — its own two existing callers (`dispatchReview` and
//    we:scripts/conveyor/reconcile-fix-dispatch.mjs) are UNCHANGED, byte-identical default behavior (same
//    `label`, same thrown wording), verified against their own existing tests.

/** The reason-specific tail of the #3474 refusal: why the automatic fast-forward was NOT (or could not be) done,
 *  and what to do about it. Falls back to today's generic remedy when the check gave no `reason` (a stub, or an
 *  older checker). */
export function staleRemedy(st, base) {
  const fresh = `or retry from a fresh clone of origin/${base}.`;
  switch (st.reason) {
    case 'diverged':
      return `It is also DIVERGED (${st.ahead} local commit(s) ahead of origin/${base}), so it cannot fast-forward — `
        + `rebase or merge origin/${base} into it by hand, ${fresh}`;
    case 'dirty':
      return `It has uncommitted changes, so the automatic fast-forward was NOT attempted over them — commit or stash `
        + `them, then sync (git pull --ff-only), ${fresh}`;
    case 'not-on-base':
      return `HEAD is not on ${base}, so the automatic fast-forward was not attempted — check out ${base} and sync `
        + `(git pull --ff-only), ${fresh}`;
    case 'ff-failed':
      return `The automatic fast-forward (git merge --ff-only origin/${base}) failed${st.detail ? ` (${st.detail})` : ''} — `
        + `sync by hand (git pull --ff-only), ${fresh}`;
    default:
      return `Sync (git pull --ff-only) ${fresh}`;
  }
}

/** The stable substring embedded in {@link assertMainNotStale}'s own thrown refusal message — the ONE marker a
 *  downstream caller that only ever sees the error's flattened first-line string (e.g. a `forEachRepo`
 *  per-repo `{repo, error}` capture, which keeps `String(e.message).split('\n')[0]` and discards the Error
 *  object itself, or any `.code` it might have carried) can match on to recognize "this specific tick failure
 *  IS the stale-main refusal", as opposed to any other tick failure (a `gh` outage, a rate limit, a genuine
 *  bug) that lands in the exact same `refusals`/`failed` bucket. Used at BOTH the throw site below and by
 *  {@link isStaleMainRefusalMessage}, so a future wording change can never silently break detection — there is
 *  only one place this string is written. (#3383 bug 1 — the fix-dispatch and review daemons need this to
 *  react to a mid-tick stale refusal immediately instead of wasting the rest of the tick.) */
export const STALE_MAIN_REFUSAL_MARKER = 'STALE code from this checkout';

/** Does this tick-failure message look like {@link assertMainNotStale}'s own refusal? See
 *  {@link STALE_MAIN_REFUSAL_MARKER}. Accepts anything falsy/non-string as "no" (a null/undefined `why`/
 *  `error` field is common on the non-error branches of the same shape). */
export function isStaleMainRefusalMessage(message) {
  return typeof message === 'string' && message.includes(STALE_MAIN_REFUSAL_MARKER);
}

/**
 * #4044 — PURE: is `path` code a checkout's import path can load (so a change to it can make a running
 * checkout stale)? JS/TS modules and JSON (config/data read by name), never tests. Shared by the dispatch
 * staleness guard below and `daemon-self-sync.mjs`'s restart gate fallback.
 * @param {string} path
 */
export function isCodePath(path) {
  const p = String(path || '');
  return /\.(mjs|cjs|js|ts|json)$/.test(p) && !/(^|\/)__tests__\//.test(p) && !/\.test\.[mc]?[jt]s$/.test(p);
}

/** Env knob: `0` reverts {@link behindFiles} to the old merge-base diff (`git diff HEAD...origin/<base>`). */
export const STALE_GUARD_MISSING_COMMITS_ENV = 'WE_STALE_GUARD_MISSING_COMMITS';

/** Files touched by the commits this checkout is MISSING from `origin/<base>` (`HEAD..origin/<base>`), or
 *  `null` on any git failure (callers fail closed).
 *
 *  Live 2026-10-04 (`wev-review-daemon`, PRs #3923/#3924): a daemon clone is `origin/main` plus overlay MERGE
 *  commits, so it has several merge bases with `origin/main`, and `git diff HEAD...origin/main` silently picks
 *  ONE (the plain-main base). Every file an overlay already brought in and that later landed on main
 *  (`reconcile-core.mjs` via an overlay PR) then counted as "behind" — and as on the review path — so the guard
 *  refused for code the clone already runs. Listing the missing commits instead is exact: commits reachable from
 *  HEAD (the overlay branches' own commits) are excluded. `--cc` keeps a clean merge commit out (its changes are
 *  its own commits, listed separately) but still names any file a merge RESOLVED differently from its parents. */
export function behindFiles(root, base = 'main', run = gitRun, env = process.env) {
  const opts = { cwd: root, timeout: 60_000, killSignal: 'SIGKILL' };
  const r = env?.[STALE_GUARD_MISSING_COMMITS_ENV] === '0'
    ? run(['diff', '--name-only', `HEAD...origin/${base}`], opts)
    : run(['log', '--cc', '--name-only', '--format=', `HEAD..origin/${base}`], opts);
  if (r.status !== 0) return null;
  return [...new Set(String(r.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean))];
}

/** Does the working tree differ from HEAD in a way that changes what runs — any TRACKED change, or an untracked
 *  code file (see {@link isCodePath})? Untracked non-code files (a `backlog/*.md` card a job wrote) do not.
 *  `true` on any git failure (fail closed). */
export function codeDirty(root, run = gitRun) {
  const r = run(['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  if (r.status !== 0) return true;
  return String(r.stdout ?? '').split('\n').filter(Boolean).some((line) => {
    if (!line.startsWith('?? ')) return true;
    return isCodePath(line.slice(3).trim().replace(/^"|"$/g, ''));
  });
}

/**
 * ASSERT the calling checkout is not behind `origin/<base>` — refuse LOUDLY rather than silently act on stale
 * code from this checkout's own import path (#3439). A checkout that is merely BEHIND (no local commits ahead)
 * with a CLEAN working tree and `HEAD` on `base` is fast-forwarded with zero conflict and zero judgment
 * (`git merge --ff-only origin/<base>`, via {@link checkMainStaleness}'s `cleanOnly` mode) and the caller
 * proceeds; every other behind case (DIVERGED, DIRTY-and-behind, off-`base`, or the merge itself failing)
 * throws, naming which case it is. A fetch failure (offline) stays fail-soft — we cannot tell if it's stale,
 * so we do not block on it (matches this file's own philosophy throughout).
 * @param {string} root
 * @param {(root: string) => ReturnType<typeof checkMainStaleness>} [checkStaleness] - injectable, defaults to
 *   a real `checkMainStaleness` scoped (via `run`'s `cwd`) to `root`.
 * @param {{base?: string, label?: string, dispatchPath?: ((path: string) => boolean)|null}} [o] - `base` is the
 *   delivery target to measure staleness against (default `main`); `label` prefixes the thrown/logged message so
 *   each caller reads as itself (default `review-dispatch`, this function's original and still most common
 *   caller). `dispatchPath` (#4387) narrows a MANAGED clone's refusal to the files this dispatch actually runs:
 *   when set, a managed clone behind only in files it rejects dispatches and logs the tolerated lag. Unset (the
 *   default) keeps the #4044 rule — any code file behind refuses.
 */
export function assertMainNotStale(root, checkStaleness, {
  base = 'main', label = 'review-dispatch', dispatchPath = null,
  listBehindFiles = (r) => behindFiles(r, base),
  // xgqz204 — the self-fast-forward seams (see `selfFastForwardAction`). All default to the real process.
  codeRoot = THIS_CODE_ROOT, armed = selfSyncState.armed, reexeced = selfSyncState.reexeced,
  reexec = reexecSelf, changedFiles = (r, from, to) => changedFilesBetween(r, from, to),
  // x5wbsbc — the last-known-good read (see `daemon-last-good.mjs`); injectable for tests.
  lastGood = (r, dirty) => lastGoodForClone({ root: r, headSha: readHeadSha(r), dirty }),
  // The bounded rebuild-in-progress grace (see `daemon-last-good.mjs#decideRebuildGrace`); injectable for tests.
  rebuildGrace = (r) => rebuildGraceForClone({ root: r }),
  treeDirtyForCode = (r) => codeDirty(r),
  write = (s) => process.stderr.write(s),
} = {}) {
  // #4044 Module E — a MANAGED clone (`process.env.WE_DAEMON_MANAGED_CLONE === '1'`, set by
  // `daemon-self-sync.mjs#withSelfSync` at wrapper construction) is rebuilt fresh from `origin/main` (+ its
  // overlay list) by `daemon-rebuild.mjs`, gated behind a live smoke check, every tick — a dispatch chokepoint
  // fast-forwarding it BY ITSELF would pull in un-smoked (possibly rejected) code straight past that gate. So a
  // managed clone never auto-ffs here: it refuses with the stale marker instead, exactly like a diverged/dirty
  // checkout always has, which `hasStaleRefusal` turns into an immediate GATED rebuild (never a raw merge).
  const managedClone = process.env.WE_DAEMON_MANAGED_CLONE === '1';
  const check = checkStaleness ?? ((r) => checkMainStaleness({
    base, autoFf: !managedClone, cleanOnly: true, run: (args) => gitRun(args, { cwd: r }),
  }));
  let st = check(root);
  let behindMemo;
  const behindList = () => (behindMemo === undefined ? (behindMemo = listBehindFiles(root)) : behindMemo);
  // #4044 (live 2026-09-25): the drain lands a commit every few minutes, most touching only `backlog/*.md`, and
  // the fix daemon refused WHOLE repos whenever its managed clone was a few such commits behind. This guard
  // exists so a dispatch never runs STALE CODE from this checkout's import path — commits that change no code
  // file cannot make it stale. So a managed clone behind ONLY in non-code files is fresh enough to dispatch;
  // the next tick-start rebuild still brings it current. Unknown diff ⇒ the refusal stands (fail closed).
  if (st && st.action === 'warn' && managedClone) {
    const files = behindList();
    if (Array.isArray(files) && files.length > 0 && !files.some(isCodePath)) {
      process.stderr.write(`${label}: the managed clone is ${st.behind} commit(s) behind origin/${base} in non-code files only (${files.length} file(s)) — not stale for dispatch (#4044).\n`);
      st = { fresh: true, behind: st.behind, behindNonCodeOnly: true, files: files.length };
    } else if (Array.isArray(files) && files.length > 0 && typeof dispatchPath === 'function'
      && !files.some((f) => isCodePath(f) && dispatchPath(f))) {
      // #4387 (live 2026-09-28): the drain lands about a PR a minute and a rebuild takes minutes, so the review
      // daemon sat 4-18 commits behind and logged 970 refusals in one evening — for commits that never touched
      // the code a review dispatch runs. Only a behind file on the caller's own dispatch path can make it stale.
      const codeFiles = files.filter(isCodePath);
      const code = codeFiles.length;
      // Name what was tolerated (first 5), so the log shows exactly which lag a dispatch ran through.
      const named = codeFiles.slice(0, 5).join(', ') + (code > 5 ? `, +${code - 5} more` : '');
      write(`${label}: the managed clone is ${st.behind} commit(s) behind origin/${base} (${code} code file(s), none on `
        + `this dispatch's code path: ${named || 'none'}) — tolerating the lag and dispatching (#4387).\n`);
      st = { fresh: true, behind: st.behind, behindOffDispatchPath: true, files: files.length, codeFiles: code, toleratedFiles: codeFiles };
    }
  }
  // x5wbsbc (epic #4075) — FALLBACK TO THE LAST WORKING BUILD, NEVER BLOCK DELIVERY (operator ruling 2026-09-26).
  // A managed clone that is still behind here is being HELD by its gated rebuild (a rejected smoke, a smoke in
  // flight, a broken smoke harness). When its HEAD is exactly the last build a live smoke passed
  // (`state.adopted.head`) and its tree is clean, that build is known to work: dispatch from it instead of
  // refusing. Past the max age (default 24 h, `WE_DAEMON_LAST_GOOD_MAX_AGE_MS`) it ALERTS on every dispatch but
  // still dispatches; the health watch's `daemon-held-on-last-good` sign notifies the operator after 15 min.
  if (st && st.action === 'warn' && managedClone) {
    let lg = null;
    // Live 2026-10-04: untracked backlog/*.md cards a review job left in the clone made `st.dirty` true, so the
    // last-good fallback never applied while the rebuild was held. Only a TRACKED change or an untracked CODE
    // file makes the tree differ from the verified build; an unreadable status stays dirty (fail closed).
    let dirty = !!st.dirty;
    if (dirty) { try { dirty = treeDirtyForCode(root); } catch { dirty = true; } }
    try { lg = lastGood(root, dirty); } catch { lg = null; }
    if (lg && lg.onLastGood) {
      const heldWhy = lg.held ? ` held since ${lg.heldSince} (${lg.held.reason ?? '?'}${lg.held.failed ? `: ${lg.held.failed}` : ''})` : '';
      write(`${label}: the managed clone is ${st.behind} commit(s) behind origin/${base} but runs its LAST-KNOWN-GOOD `
        + `build ${String(lg.lastGood).slice(0, 12)}${heldWhy} — dispatching from it, not refusing (x5wbsbc).\n`);
      if (lg.overAge) {
        write(`${label}: ALERT — the clone has been held on its last-good build for ${Math.round(lg.ageMs / 3_600_000)}h, `
          + `past the max age — still dispatching; fix what the rebuild's alerts name (x5wbsbc).\n`);
      }
      st = {
        fresh: true, behind: st.behind, onLastGood: true, lastGood: lg.lastGood, heldSince: lg.heldSince,
        heldReason: lg.held?.reason ?? null, overAge: lg.overAge,
      };
    }
  }
  // Live 2026-10-04 (PRs #3923/#3924): a managed clone behind ON its dispatch path while its own rebuild is
  // running (a smoke that takes many minutes on a loaded host) refused every review until the build landed. A
  // BOUNDED grace covers that window: a live build lease, and a last adoption no older than
  // `WE_STALE_GUARD_REBUILD_GRACE_MS` (default 60 min, 0 = off). Only for a caller that names its dispatch path
  // and only with a KNOWN behind-file list — an unknown diff still refuses.
  if (st && st.action === 'warn' && managedClone && typeof dispatchPath === 'function') {
    const files = behindList();
    let g = null;
    if (Array.isArray(files) && files.length > 0) { try { g = rebuildGrace(root); } catch { g = null; } }
    if (g && g.grace) {
      const onPath = files.filter((f) => isCodePath(f) && dispatchPath(f));
      const named = onPath.slice(0, 5).join(', ') + (onPath.length > 5 ? `, +${onPath.length - 5} more` : '');
      write(`${label}: the managed clone is ${st.behind} commit(s) behind origin/${base} ON this dispatch's code path `
        + `(${named}), but its rebuild${g.target ? ` to ${String(g.target).slice(0, 12)}` : ''} is in progress `
        + `(${Math.round((g.sinceAdoptMs ?? 0) / 60_000)} min since the last adoption, within the grace) — dispatching.\n`);
      st = { fresh: true, behind: st.behind, rebuildGrace: true, onPathFiles: onPath, buildTarget: g.target ?? null };
    }
  }
  if (st && st.synced) {
    process.stderr.write(`${label}: fast-forwarded the dispatching checkout ${st.behind} commit(s) to origin/${base} (#3474) before dispatching.\n`);
    // xgqz204 — the fast-forward just rewrote the files THIS process may already have loaded. Proceeding would
    // run the pre-fast-forward code in memory (live 2026-09-25: a 47-commit FF brought in #2674's job-mode
    // default, and the already-loaded review-dispatch still started a `claude --bg` session).
    const sameCheckout = isSameCheckout(root, codeRoot);
    const files = sameCheckout ? changedFiles(root, st.from, st.to) : [];
    const codeChanged = Array.isArray(files) ? files.some(isCodePath) : null;
    const action = selfFastForwardAction({ sameCheckout, codeChanged, armed, reexeced });
    if (action === 'reexec') {
      reexec({ label, st });
      return { ...st, reexeced: true }; // only reached when `reexec` is injected (the real one exits)
    }
    if (action === 'refuse') {
      throw new Error(
        `${label}: fast-forwarded the dispatching checkout ${st.behind} commit(s) to origin/${base}, but this process `
        + `had already loaded the pre-fast-forward code, so it would run ${STALE_MAIN_REFUSAL_MARKER}'s own import path `
        + '(the old copy in memory) — refusing to dispatch (xgqz204). '
        + (reexeced
          ? 'It already re-executed itself once and the checkout moved again underneath it; re-run it.'
          : 'This caller cannot re-execute itself (it did not call armSelfReexecOnFastForward); re-run it — the checkout is now current.'),
      );
    }
  }
  if (st && st.action === 'warn') {
    throw new Error(
      `${label}: the dispatching checkout is ${st.behind} commit(s) behind origin/${base} — refusing to `
      + `dispatch a review that would run ${STALE_MAIN_REFUSAL_MARKER}'s own import path (#3439). `
      + (managedClone
        // A daemon-managed clone is never fixed by hand (#4044): only its gated rebuild may move it, and when
        // the rebuild is holding it back it records why in its alerts log (`clone-held-stale`).
        ? `This is a DAEMON-MANAGED clone: only its gated rebuild moves it (never rebase/merge by hand). If this `
          + `persists, the rebuild is holding it — see the clone's \`clone-held-stale\` alert in `
          + `~/.claude/daemon-self-sync-state/<cloneKey>.alerts.jsonl for the reason and next retry.`
        : staleRemedy(st, base)),
    );
  }
  return st;
}

/** The refusal marker of {@link assertOperatorCliFresh}: operator CLIs run from a stale checkout. */
export const OPERATOR_CLI_STALE_MARKER = 'run from an up-to-date lane';

/**
 * Item 113 — an OPERATOR CLI (`review-set-label.mjs`, `record-referral-ruling`) judges a PR with the code of
 * the checkout it runs from. Run from a checkout far behind `origin/main` it can refuse on a bug main already
 * fixed (live 2026-10-07, #4222: the primary checkout at 025a05a93 did not know `bornAs` card resolution) and
 * give a misleading verdict. Unlike a dispatcher it never moves the checkout (it may be someone's primary
 * clone): it refuses, via the shared {@link assertMainNotStale} chokepoint, whenever the commits it is missing
 * from `origin/<base>` touch a file this code can load ({@link isCodePath}). Backlog-only lag is tolerated.
 * Offline (fetch fails) or a root that is not a git checkout stays fail-soft, like the rest of this file.
 * @param {string} root the checkout the CLI's own code was loaded from
 * @param {{label?: string, base?: string, run?: typeof gitRun, listBehindFiles?: (root: string) => (string[]|null)}} [o]
 */
export function assertOperatorCliFresh(root, { label = 'operator-cli', base = 'main', run = gitRun,
  listBehindFiles = (r) => behindFiles(r, base, run), env = process.env,
  skipUnderVitest = !!process.env.VITEST } = {}) {
  // A daemon-managed clone is kept current by its own gated rebuild (#4044); a unit test run drives the CLI from
  // whatever checkout CI built and injects its own seams. Neither is an operator running from a stale clone.
  if (env?.WE_DAEMON_MANAGED_CLONE === '1' || skipUnderVitest) return { skipped: true };
  let last = null;
  const check = (r) => {
    const cwd = { cwd: r, timeout: 60_000, killSignal: 'SIGKILL' };
    if (run(['fetch', 'origin', base, '--quiet'], cwd).status !== 0) return (last = { offline: true });
    const count = run(['rev-list', '--count', `HEAD..origin/${base}`], cwd);
    const behind = count.status === 0 ? Number(count.stdout.trim()) || 0 : 0;
    if (!behind) return (last = { fresh: true, behind: 0 });
    const files = listBehindFiles(r);
    // Unknown diff fails closed; a diff with no code file is not stale for this CLI.
    if (Array.isArray(files) && !files.some(isCodePath)) return (last = { fresh: true, behind, behindNonCodeOnly: true });
    return (last = { action: 'warn', reason: 'not-auto-syncing', behind, ahead: 0, dirty: false });
  };
  try {
    return assertMainNotStale(root, check, { base, label });
  } catch (e) {
    if (!isStaleMainRefusalMessage(e?.message)) throw e;
    throw new Error(`${label}: this checkout is ${last?.behind ?? 'several'} commit(s) behind origin/${base} in code it `
      + `runs (${STALE_MAIN_REFUSAL_MARKER}) — its verdict could be wrong on a bug main already fixed, so it refuses: `
      + `${OPERATOR_CLI_STALE_MARKER} (a fresh lane on origin/${base}: \`node scripts/lane-pool.mjs acquire\`). `
      + 'Nothing was changed.');
  }
}

// ── xgqz204 — A DISPATCHER THAT FAST-FORWARDS ITS OWN CHECKOUT MUST NOT KEEP RUNNING ITS OLD CODE ─────────────
// `assertMainNotStale` fast-forwards the checkout the dispatch runs from (#3474). When that checkout is the one
// this very process loaded its modules from, the FF changes the files on disk but not the code in memory: node
// has already imported the old version. Live 2026-09-25 (review-dispatch --pr=2678): a 47-commit FF brought in
// PR #2674's job-mode default, and the already-loaded pre-#2674 CLI still started a `claude --bg` SESSION.
//
// The fix: a one-shot CLI calls `armSelfReexecOnFastForward()` at the top of its CLI block. After an FF that
// changed a code file in its own checkout, the chokepoint RE-EXECUTES the same command (same node flags, argv,
// cwd, env) with `WE_SELF_SYNC_REEXECED=1` set, waits for it, and exits with its status — so the fresh process
// loads the new code from the start. The re-exec happens before any dispatch side effect: every caller runs
// `assertMainNotStale` as its first effectful step. The env guard stops a loop: a re-executed process that
// sees the checkout move AGAIN refuses instead of re-executing a second time. A caller that is NOT armed (a
// long-running daemon calling a dispatcher in-process — re-running it would start a second daemon) refuses
// with a clear message instead of proceeding. An FF that touched only non-code files, or that moved a checkout
// other than the one this code was loaded from, leaves the in-memory code current, so it proceeds as before.

/** The env var a re-executed process carries (see {@link armSelfReexecOnFastForward}). */
export const SELF_SYNC_REEXEC_ENV = 'WE_SELF_SYNC_REEXECED';

/** The checkout this module (and so every script importing it from the same tree) was loaded from. */
export const THIS_CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const selfSyncState = { armed: false, reexeced: false };

/**
 * Called ONCE at the top of a one-shot dispatcher CLI's entry block: allows {@link assertMainNotStale} to
 * re-execute this process after a self-fast-forward. Reads and REMOVES the loop-guard env var, so a process this
 * one later spawns does not inherit "already re-executed". Never call it from a long-running daemon.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{armed: true, reexeced: boolean}}
 */
export function armSelfReexecOnFastForward(env = process.env) {
  selfSyncState.armed = true;
  selfSyncState.reexeced = env?.[SELF_SYNC_REEXEC_ENV] === '1';
  if (env) delete env[SELF_SYNC_REEXEC_ENV];
  return { armed: true, reexeced: selfSyncState.reexeced };
}

/** Do two paths name the same checkout (symlinks resolved)? Never throws. */
export function isSameCheckout(a, b) {
  const real = (p) => { try { return realpathSync(String(p)); } catch { return resolve(String(p)); } };
  if (!a || !b) return false;
  return real(a) === real(b);
}

/**
 * PURE — what to do after a SUCCESSFUL fast-forward of `root`.
 *   'proceed' — the FF did not touch the code this process runs: another checkout, or only non-code files.
 *   'reexec'  — it did, and this is an armed CLI that has not re-executed yet.
 *   'refuse'  — it did, and re-executing is not possible (unarmed caller) or already happened once.
 * `codeChanged: null` (the diff could not be read) counts as changed — fail closed.
 * @param {{sameCheckout: boolean, codeChanged: boolean|null, armed: boolean, reexeced: boolean}} o
 * @returns {'proceed'|'reexec'|'refuse'}
 */
export function selfFastForwardAction({ sameCheckout, codeChanged, armed, reexeced }) {
  if (!sameCheckout || codeChanged === false) return 'proceed';
  return armed && !reexeced ? 'reexec' : 'refuse';
}

/** `git rev-parse HEAD` in `root`, or `null` (never throws). */
export function readHeadSha(root, run = gitRun) {
  const r = run(['rev-parse', 'HEAD'], { cwd: root, timeout: 30_000, killSignal: 'SIGKILL' });
  const out = String(r.stdout ?? '').trim();
  return r.status === 0 && out ? out : null;
}

/** Files that differ between two commits, or `null` when unknown (a missing SHA, or git failed). */
export function changedFilesBetween(root, from, to, run = gitRun) {
  if (!from || !to) return null;
  const r = run(['diff', '--name-only', String(from), String(to)], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) return null;
  return String(r.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
}

/**
 * Re-run the current command (same node flags, script, argv, cwd, env + the loop guard) in a fresh process,
 * wait for it, and exit with its status. Its stdio is inherited, so the caller's stdout/stderr read as if the
 * first process had run the new code itself. Throws (never proceeds) when the child cannot be started.
 */
export function reexecSelf({
  label = 'dispatch', st = {}, spawn = spawnSync, exit = (code) => process.exit(code),
  argv = process.argv, execArgv = process.execArgv, env = process.env, cwd = process.cwd(),
  write = (s) => { try { writeSync(2, s); } catch { /* stderr closed — nothing to report to */ } },
} = {}) {
  const span = st.from && st.to ? ` ${String(st.from).slice(0, 9)}..${String(st.to).slice(0, 9)}` : '';
  write(`${label}: re-executing so the fast-forwarded code runs (${st.behind ?? '?'} commit(s)${span}), `
    + `not the pre-fast-forward copy already in memory (xgqz204).\n`);
  const r = spawn(process.execPath, [...execArgv, ...argv.slice(1)], {
    stdio: 'inherit', cwd, env: { ...env, [SELF_SYNC_REEXEC_ENV]: '1' },
  });
  if (r?.error) {
    throw new Error(`${label}: fast-forwarded its own checkout but could not re-execute itself (${r.error.message}) — `
      + `refusing to dispatch on the pre-fast-forward code in memory (xgqz204); re-run it.`);
  }
  exit(Number.isInteger(r?.status) ? r.status : 1);
}
