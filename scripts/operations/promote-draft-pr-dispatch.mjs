#!/usr/bin/env node
/**
 * @file promote-draft-pr-dispatch.mjs
 * @description Draft-first PRs (operator-approved 2026-09-27) — the ONE mechanical pass that acts on
 *   `scripts/conveyor/reconcile-core.mjs`'s new `kind:'promote-draft'` plan entries: a draft PR (opened by
 *   `scripts/pr-land.mjs --park`'s new draft-by-default open) whose required checks are ALL green. The
 *   effect is a single `gh pr ready <pr>` (`scripts/lib/draft-promote-provider.mjs`) — no agent, no lane, no
 *   brief. This is deliberately the SIMPLEST dispatcher in this family (contrast
 *   `scripts/operations/ci-heal-pr-dispatch.mjs`'s lane/claim/brief machinery): nothing here spawns a
 *   session, so there is no claim to race, no lane to pop, no capability profile to gate on.
 *
 * WHAT UN-DRAFTING ACTUALLY DOES: it does not itself dispatch a review. `gh pr ready` only flips GitHub's own
 * draft bit; the review daemon's OWN next tick reads `pr.isDraft: false` off the SAME PR and, since its
 * `review:*` label was already applied at open (`pr-land.mjs --park`'s existing behavior, unchanged), reaches
 * `scripts/conveyor/reconcile-core.mjs#dispatchReviewRow` and dispatches normally — the same review-owed path
 * every non-draft PR already takes. This file's whole job is removing the ONE thing standing between a
 * green-CI draft and that ordinary path.
 *
 * MIRRORS `we:scripts/operations/ci-heal-pr-dispatch.mjs`'s own shape (`runReconcile<X>Dispatch` reading the
 * SAME `runReconcilePass` plan, filtering its own `kind`, and being the reconcile daemon's OWN durable pass) —
 * never a second reconciliation of its own.
 *
 * TWO CALLERS, DELIBERATELY (draft-first PRs follow-up, operator-approved 2026-09-27): this was originally
 * wired ONLY into `skills-src/conveyor/runner.mjs` (the headless conveyor runner, calling this CLI on every
 * tick right alongside `ci-heal-pr-dispatch.mjs`) — but that runner has NO LIVE SINGLETON LEASE on this host
 * today (confirmed by a separate trial worker the same day this shipped). `skills-src/conveyor/
 * reconcile-fix-dispatch-daemon.mjs#runPromoteDraftDispatchAllRepos` now ALSO calls
 * {@link runReconcilePromoteDraftDispatch} directly (in-process, not via this CLI) from that daemon's own
 * tick — the ONE daemon confirmed live — mirroring that file's own `hungCi`/`mainRedRebase`/`missingRun`
 * precedent exactly. Both callers are safe to keep: `gh pr ready` is idempotent server-side (a PR already
 * non-draft is a silent no-op), so whichever caller's tick reaches a given PR first simply wins.
 *
 * STALE-GREEN RE-VERIFICATION (live incident, web-everything/web-everything PR #2811, 2026-09-27): the `entries` this
 * pass promotes come from `runReconcilePass`'s ONE PR snapshot for the whole tick — `entry.check` (folded into
 * `withPhase.check` by `planReconcile`) is whatever `statusCheckRollup` looked like at THAT read, seconds to
 * minutes before this loop actually calls `provider.ready`. #2811 measured the gap directly: the plan read this
 * draft as green, a required check FAILED 18:48:06Z (while `main`'s own CI was independently red), and this pass
 * still called `gh pr ready` at 18:48:24Z — 18 SECONDS AFTER the failure the very same tick's review-daemon log
 * had already recorded. A snapshot is a claim about the past; promoting is an action in the present, and nothing
 * between the two ever asked whether the claim still held. So every entry is re-verified here, for the EXACT
 * head sha (never the PR number — a PR's checks can belong to a superseded commit, `we:scripts/operations/
 * pr-status.mjs`'s own header), immediately before the one write this file makes: every required check must be
 * `completed`+`success` for that sha RIGHT NOW, no `pending`, no failure. A stale-green entry is refused
 * (`kind:'stale-check-refused'`) rather than promoted — the draft stays draft and the SAME plan entry recurs
 * next tick, exactly like every other refusal in this family self-heals with no retry loop of its own.
 *
 * CWD-INFERRED-REPO FIX (we:backlog/x4ua3v8, live incident 2026-09-28): the default `provider` used to be
 * `createDraftPromoteProvider({ cwd: root })` with NO repo threaded through — `we:scripts/lib/
 * draft-promote-provider.mjs`'s `gh pr ready <pr>` then relied on `gh` inferring the repo from `root`'s git
 * remote. `root` is this dispatching checkout's OWN cwd (always the WE checkout the daemon runs from,
 * `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runPromoteDraftDispatchAllRepos` loops every
 * constellation repo via `we:scripts/lib/for-each-repo.mjs` from the SAME process) — so every non-WE PR
 * number silently resolved against `web-everything/web-everything` instead. Confirmed live:
 * `plateauapp/plateau-app#187` refused ("Command failed: gh pr ready 187") until promoted by hand. Fixed by
 * threading this function's own already-resolved `repoSlug` through to the provider as an explicit `--repo`
 * — `undefined` for the WE-default path (byte-identical to before), the real slug otherwise.
 */
import { repoKeyForSlug, CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { armSelfReexecOnFastForward, assertMainNotStale, isCodePath } from '../lib/main-staleness.mjs';
import { closureHits, collectImportClosure } from '../lib/import-closure.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDraftPromoteProvider } from '../lib/draft-promote-provider.mjs';
import { runReconcilePass } from '../conveyor/reconcile-pass.mjs';
import { readPrsFromFile } from '../conveyor/open-pr-fetch.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { checksArgv, parseJsonLines } from './pr-status-io.mjs';
import { reduceCheckState } from './pr-status.mjs';
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { applyReviewStatus } from '../conveyor/review-status-tag.mjs';
import { CLOSE_SUPERSEDED_MARKER } from '../conveyor/stand-down-answer-core.mjs';
import { isGithubStacked, stackReviewWhileBaseOpen } from '../lib/stack-review-while-open.mjs';

const THIS_CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let promoteClosureMemo;

/** The static import closure of THIS file in the running tree (memoized), or `null` if unreadable. This is the
 *  complete set of code a promote pass can run; a managed clone that is behind `origin/main` only in files
 *  outside it is not stale FOR PROMOTION. */
export function promoteCodeClosure() {
  if (promoteClosureMemo === undefined) {
    promoteClosureMemo = collectImportClosure({ root: THIS_CODE_ROOT, entries: ['scripts/operations/promote-draft-pr-dispatch.mjs'] });
  }
  return promoteClosureMemo;
}

/** Is `path` (repo-relative) on the promote code path? `closure` is injectable; an unknown or incomplete
 *  closure fails closed — every code file counts as on the path (the plain #4044 rule). */
export function isPromoteCodePath(path, { closure = promoteCodeClosure() } = {}) {
  const p = String(path || '');
  if (!p) return false;
  if (!closure || !closure.complete) return isCodePath(p);
  return closureHits({ closure, changedFiles: [p] }).length > 0;
}

/**
 * THE FRESH RE-READ (#2811). Asks GitHub's own commit-statuses endpoint for `sha`'s check runs RIGHT NOW —
 * bypassing whatever `statusCheckRollup` the reconcile snapshot carried — and reduces them with the SAME
 * `reduceCheckState`/`getRequiredStatusChecks` truth every other CI-truth reader in this family uses (never a
 * re-derived notion of "green"). Injectable so a test asserts the refusal with no `gh` on PATH.
 * @param {{repoSlug:string, sha:string, runGh?:Function, getRequiredChecks?:Function}} o
 * @returns {{state:string, why:string, counts:object}}
 */
export function defaultReadHeadCheckState({
  repoSlug, sha, runGh = runGhSync, getRequiredChecks = getRequiredStatusChecks,
} = {}) {
  const requiredChecks = getRequiredChecks({ repo: repoSlug }).checks;
  const raw = runGh(checksArgv({ repo: repoSlug, sha }), {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-status-checks', repo: repoSlug },
  });
  return reduceCheckState(parseJsonLines(raw), requiredChecks);
}

function validatePrLabels(labels) {
  if (!Array.isArray(labels) || labels.some(label => {
    const name = typeof label === 'string' ? label : label?.name;
    return typeof name !== 'string' || name.trim().length === 0;
  })) throw new Error('PR labels must be an array of label names or {name} records');
  return labels;
}

/** Fresh withdrawal state, scoped to the target PR and repository; fail closed on unreadable data. */
export function defaultReadPrLabels({ repoSlug, prNumber, runGh = runGhSync } = {}) {
  const raw = runGh(['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'labels'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-labels', repo: repoSlug },
  });
  const envelope = JSON.parse(raw);
  return validatePrLabels(envelope?.labels);
}

/** #3902 — strip `ready-to-merge` when the STUCK restore variant applies a review hold. */
export function defaultRemoveLabel({ repoSlug, prNumber, label, runGh = runGhSync } = {}) {
  runGh(['pr', 'edit', String(prNumber), '--repo', repoSlug, '--remove-label', label], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-label-remove', repo: repoSlug },
  });
}

/** The one label write of the restore-review-label half. */
export function defaultAddLabel({ repoSlug, prNumber, label, runGh = runGhSync } = {}) {
  runGh(['pr', 'edit', String(prNumber), '--repo', repoSlug, '--add-label', label], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-label-add', repo: repoSlug },
  });
}

/** #3850 — the marker on the conveyor's own superseded-close comment (defined with the answer reader that checks it). */
export { CLOSE_SUPERSEDED_MARKER };

/** #3850 — the comment the close carries: who ruled it, verbatim. Pure. */
export function closeSupersededComment(answer = {}) {
  const quote = String(answer.reason ?? '').replace(/<!--/g, '&lt;!--').split('\n').map((l) => `> ${l}`).join('\n');
  return `${CLOSE_SUPERSEDED_MARKER}\n## Closed as superseded — operator disposition\n\nRuled by @${answer.actor ?? 'operator'} via ${answer.channel ?? 'unknown'} (\`close-superseded\`), executed mechanically by the conveyor. No files were changed and no fix agent was dispatched.\n\n${quote}`;
}

/** `gh pr view --json files` returns at most this many entries, silently. */
export const PR_FILES_JSON_CAP = 100;

/** #3850 — close a PR with the superseded comment (one `gh pr close --comment` write). */
export function defaultClosePr({ repoSlug, prNumber, comment, runGh = runGhSync } = {}) {
  runGh(['pr', 'close', String(prNumber), '--repo', repoSlug, '--comment', comment], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-close', repo: repoSlug },
  });
}

/**
 * #3850 — the PR's backlog cards that ALREADY exist on the default branch. Closing the PR discards a card the PR
 * itself introduced; a card that is on main would stay open and needs a backlog edit (there is no sanctioned
 * "superseded" status in `backlog.mjs`), so the executor refuses rather than closing half the ruling. Only the PR's
 * OWN cards ({@link ownedCards}) that main does not already show `resolved` count (live #4734). Fails closed: any
 * read error throws and the caller refuses.
 */
export function defaultReadCardsOnMain({ repoSlug, prNumber, base = 'main', runGh = runGhSync } = {}) {
  const view = JSON.parse(runGh(['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'files,headRefName,title'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-files', repo: repoSlug },
  }));
  // `--json files` is capped at 100 entries and does not error when it truncates: a list at the cap may be missing
  // the very card that is already on main, so it is unreadable, not "no card" (fail closed → the caller refuses).
  if ((view?.files ?? []).length >= PR_FILES_JSON_CAP) {
    throw new Error(`pr files list is at the ${PR_FILES_JSON_CAP}-entry gh cap — cannot prove no card is already on ${base}`);
  }
  const cards = ownedCards((view?.files ?? []).map((f) => f?.path).filter((p) => /^backlog\/[^/]+\.md$/.test(String(p))), view);
  const onMain = [];
  for (const path of cards) {
    let text;
    try {
      text = String(runGh(['api', `repos/${repoSlug}/contents/${path}?ref=${base}`, '-H', 'Accept: application/vnd.github.raw'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'contents', repo: repoSlug },
      }) ?? '');
    } catch (e) {
      if (!/404|Not Found/i.test(String(e?.stderr ?? e?.message ?? e))) throw e;
      continue;
    }
    // Live #4734 (2026-10-10): a card already RESOLVED on main needs no backlog edit — closing the PR strands
    // nothing. Only a card main still shows as live work blocks the close. Unreadable status → blocks (fail closed).
    if (cardStatus(text) !== 'resolved') onMain.push(path);
  }
  return onMain;
}

/** The `status:` field of a backlog card's frontmatter, or null. */
function cardStatus(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))?.[1] ?? '';
  return /^status:\s*['"]?([\w-]+)/m.exec(front)?.[1] ?? null;
}

/**
 * The PR's OWN item cards: those whose number the head branch (`lane/<NNN>-…`) or the title (`WE #<NNN>`) names.
 * Live #4734: a long-lived lane that merged other lanes shows their cards in its diff (26 of them); those cards
 * landed on main through their own PRs, and closing this one does not strand them. When the PR names no card
 * number, every card counts as its own (fail closed — the pre-#4734 behaviour).
 * @param {string[]} cards - `backlog/<file>.md` paths from the PR's file list.
 * @param {{headRefName?: string, title?: string}} view
 * @returns {string[]}
 */
export function ownedCards(cards, view = {}) {
  const ids = new Set();
  const branch = /^lane\/(\d+)-/.exec(String(view?.headRefName ?? ''))?.[1];
  if (branch) ids.add(Number(branch));
  for (const m of String(view?.title ?? '').matchAll(/\bWE #(\d+)\b/g)) ids.add(Number(m[1]));
  if (!ids.size) return cards;
  return cards.filter((p) => ids.has(Number(/^backlog\/(\d+)-/.exec(p)?.[1])));
}

/**
 * Run ONE pass: reconcile, filter `kind:'promote-draft'`, call `gh pr ready` on each. Repo-agnostic, same
 * `--repo`/`--prs-file` contract as `ci-heal-pr-dispatch.mjs`'s own `runReconcileCiHealDispatch`.
 * @param {object} [o]
 * @param {string|null} [o.repo] - a constellation repo slug, or `null` for WE (mirrors every sibling dispatcher).
 * @param {Function} [o.reconcile] - injectable, defaults to the real `runReconcilePass`.
 * @param {string} [o.prsFile] - when given, `reconcile` reads this tick's shared PR listing instead of a fresh `gh pr list`.
 * @param {object} [o.provider] - injectable `gh` seam (`createDraftPromoteProvider`'s shape); a test passes a
 *   fake. Omitted, the real default is constructed AFTER `repoSlug` resolves (see the file header's
 *   CWD-INFERRED-REPO FIX note) so it is threaded an explicit `--repo` for every non-WE dispatch.
 * @param {Function} [o.readPrLabels] - fresh target PR labels; accepts string names or {name} records.
 * @param {Function} [o.checkStaleness] - threaded straight to `assertMainNotStale`, mirroring every sibling dispatcher's own seam.
 * @returns {{dispatched:Array<{pr:number, kind:'promote-draft'}>, refusals:Array<{pr:number, kind:string, why:string}>, reconcileRefusals:number, reconcileRefusalDetails:Array<object>}}
 *   `dispatched` (not `promoted` — RENAMED, epic #4075/#3383 follow-up) so this shape matches every sibling
 *   `runReconcile<X>Dispatch`'s own `{dispatched, refusals, reconcileRefusalDetails}` contract byte-for-byte:
 *   `skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`'s `runXAllRepos` wrappers all read `result.dispatched`
 *   off whatever tick they wrap (see e.g. `runReconcileCiHealDispatchAllRepos`) — a differently-named field
 *   here would have silently produced an empty `dispatched` array for the daemon composing this pass in.
 */
export function runReconcilePromoteDraftDispatch({
  root = process.cwd(),
  repo = null,
  reconcile = runReconcilePass,
  prsFile,
  provider,
  checkStaleness,
  // #2811 — the fresh per-sha re-read, injectable so a test can pin the exact race (plan says green, a fresh
  // read says red/pending) with no `gh` on PATH. Defaults to the real `gh api commits/<sha>/check-runs` read.
  readHeadCheckState = defaultReadHeadCheckState,
  readPrLabels = defaultReadPrLabels,
  // #3902 — strips `ready-to-merge` when the STUCK restore variant applies its review hold.
  removeLabel = defaultRemoveLabel,
  // #2811/#2821 follow-up — clear the now-stale `review-status:awaiting-ci` / `review-status:awaiting-base` label the INSTANT a draft promotes,
  // never waiting on a different daemon's tick to notice `isDraft` flipped (mirrors `applyReviewStatus`'s own
  // "the daemon that changes the state applies its own tag right at the moment" convention, `review-status-
  // tag.mjs`'s own docblock). Best-effort: a failed clear never fails the promotion itself, and the periodic
  // `tagReviewStatus` sweep still corrects it on its own next pass either way.
  clearAwaitingCi = applyReviewStatus,
  // `restore-review-label` (PR #3830 incident): the one write for an open, green, label-less lane PR.
  // Idempotent (`gh pr edit --add-label`); re-reads labels first so a label another actor just set wins.
  addLabel = defaultAddLabel,
  // #3850 — the close-superseded disposition's two IO seams (a test injects both).
  closePr = defaultClosePr,
  readCardsOnMain = defaultReadCardsOnMain,
  // `stack.reviewWhileBaseOpen` (operator go 2026-10-10): a GitHub-stacked draft (base = another lane branch) is
  // promoted on its OWN green checks while its base is open. Off, it is refused here and waits for its base to land.
  reviewWhileBaseOpen = undefined,
} = {}) {
  const repoKey = repo == null ? 'we' : repoKeyForSlug(repo);
  if (repoKey === null) throw new Error(`promote-draft-pr-dispatch: --repo ${repo} is not a constellation repo`);
  // #x1rr9rh (multi-repo slice 2) — guards THIS dispatching checkout's own import path, same as every sibling
  // mechanical pass (`ci-heal-pr-dispatch.mjs`, `reconcile-fix-dispatch.mjs`) — never the target repo.
  // LIVE INCIDENT 2026-10-03: PR #3806 (the fix for main's red CI) sat green-but-draft for 15+ minutes because
  // the daemon clone was 2 commits behind (held off `origin/main` by a slow smoke, tree dirty so no last-good
  // fallback) and this guard threw for the WHOLE pass. The two commits touched no file this pass imports, so a
  // managed clone behind only in files off `isPromoteCodePath` is fresh enough to promote (#4387's rule; the
  // write is `gh pr ready` after a fresh per-sha re-check, never agent code).
  assertMainNotStale(root, checkStaleness, { label: 'promote-draft', dispatchPath: isPromoteCodePath });
  const repoSlug = CONSTELLATION_REPOS[repoKey].slug;
  // #4285-cwd-repo (we:backlog/x4ua3v8) — explicit `--repo` for every non-WE dispatch; `undefined` for WE
  // keeps the WE-default path byte-identical to before this fix (still relies on `cwd` inference there, same
  // as `createGhLandProvider`'s own documented-safe convention for a same-repo cwd).
  const ghProvider = provider ?? createDraftPromoteProvider({
    cwd: root, repo: repoKey === 'we' ? undefined : repoSlug,
  });
  const reconciled = reconcile({ repo, ...(prsFile ? { readPrs: () => readPrsFromFile(prsFile) } : {}) });
  const entries = (reconciled.dispatch ?? []).filter((entry) => entry.kind === 'promote-draft');
  const dispatched = [];
  const refusals = [];
  // Every open draft the plan did NOT promote says why, once per tick (the log used to carry nothing for a draft
  // the promote half skipped). The reconcile `draft` refusal carries the check state it read.
  for (const r of (reconciled.refusals ?? [])) {
    if (r?.kind !== 'draft' || r.check === 'green') continue;
    refusals.push({
      pr: r.prNumber, kind: 'draft-not-promoted',
      why: `draft left as is: its required checks read ${r.check ?? 'unknown'}, not green, in this tick's plan — nothing to promote yet`,
    });
  }
  let stackPolicy;
  for (const entry of entries) {
    const sha = entry.headRefOid;
    const stacked = isGithubStacked(entry);
    if (stacked && !(stackPolicy ??= reviewWhileBaseOpen ?? stackReviewWhileBaseOpen())) {
      refusals.push({
        pr: entry.prNumber, kind: 'stacked-awaiting-base', headSha: sha,
        why: `stacked on ${entry.baseRefName} — stack.reviewWhileBaseOpen is off, so it is promoted once its base lands and the drain retargets it`,
      });
      continue;
    }
    // #2811 — re-verify EVERY required check for the EXACT head sha immediately before the one write this file
    // makes. The plan's own `withPhase.check === 'green'` (see `reconcile-core.mjs`'s `promote-draft` branch) is
    // already stale by the time control reaches here — this is the second, authoritative read.
    let fresh;
    try {
      fresh = readHeadCheckState({ repoSlug, sha });
    } catch (e) {
      refusals.push({
        pr: entry.prNumber, kind: 'stale-check-unreadable', headSha: sha,
        why: `could not re-verify required checks for ${sha} before promoting — refusing rather than acting on `
          + `the reconcile plan's own (by-now-stale) read: ${String((e && e.message) || e).split('\n')[0]}`,
      });
      continue;
    }
    if (fresh.state !== 'green') {
      refusals.push({
        pr: entry.prNumber, kind: 'stale-check-refused', headSha: sha, checkState: fresh.state,
        why: `the reconcile plan read this draft's required checks as green, but a fresh re-read of head ${sha} `
          + `immediately before promoting shows ${fresh.state} (${fresh.why}) — refusing to promote on a `
          + 'stale-green read (#2811); the same entry is re-planned next tick once the checks genuinely settle',
      });
      continue;
    }
    // Final read closes the stale-plan gap; GitHub does not offer an atomic label-check/ready write.
    let labels;
    try {
      labels = validatePrLabels(readPrLabels({ repoSlug, prNumber: entry.prNumber }));
    } catch (e) {
      refusals.push({
        pr: entry.prNumber, kind: 'draft-state-unreadable', headSha: sha,
        why: `could not read withdrawal state before promoting: ${String(e?.message ?? e).split('\n')[0]}`,
      });
      continue;
    }
    if (labels.some(label => (typeof label === 'string' ? label : label.name) === 'review-status:draft-withdrawn')) {
      refusals.push({
        pr: entry.prNumber, kind: 'draft-withdrawn', headSha: sha,
        why: 'draft PR is withdrawn — explicit release is required before promotion',
      });
      continue;
    }
    try {
      ghProvider.ready(entry.prNumber);
      dispatched.push({ pr: entry.prNumber, kind: 'promote-draft', ...(stacked ? { stackedOn: entry.baseRefName } : {}) });
      try {
        clearAwaitingCi({ pr: entry.prNumber, repo: repoSlug, state: null });
      } catch {
        // Best-effort (see the param's own doc) — the periodic review-status sweep still corrects this.
      }
    } catch (e) {
      // Best-effort, same as every other label/state write in this family (`pr-land.mjs`'s own `applyLabel`):
      // a `gh` hiccup here never throws the whole pass — the PR stays draft and this same plan entry recurs
      // next tick, so a transient failure self-heals within one tick interval rather than needing a retry loop.
      refusals.push({ pr: entry.prNumber, kind: 'ready-failed', why: String((e && e.message) || e).split('\n')[0] });
    }
  }
  // ── restore-review-label half: green, open, label-less lane PRs get `review:pending` (see reconcile-core).
  for (const entry of (reconciled.dispatch ?? []).filter((e) => e.kind === 'restore-review-label')) {
    let labels;
    try {
      labels = validatePrLabels(readPrLabels({ repoSlug, prNumber: entry.prNumber }))
        .map(l => (typeof l === 'string' ? l : l.name));
    } catch (e) {
      refusals.push({ pr: entry.prNumber, kind: 'label-state-unreadable', why: String(e?.message ?? e).split('\n')[0] });
      continue;
    }
    // #3902 — the STUCK variant is planned FOR a `ready-to-merge` PR, so only a review label stops it there.
    const stuck = entry.variant === 'stuck';
    if (labels.some(l => l.startsWith('review:') || (!stuck && l === 'ready-to-merge'))) {
      refusals.push({ pr: entry.prNumber, kind: 'label-already-set', why: 'a review/landing label appeared since the plan was read' });
      continue;
    }
    try {
      addLabel({ repoSlug, prNumber: entry.prNumber, label: entry.label ?? 'review:pending' });
      // A review hold and the `ready-to-merge` go-ahead are contradictory (#2832): strip it, best-effort — the
      // drain's merge gate re-checks the hold either way.
      if (stuck && labels.includes('ready-to-merge')) {
        try { removeLabel({ repoSlug, prNumber: entry.prNumber, label: 'ready-to-merge' }); } catch { /* best-effort */ }
      }
      dispatched.push({ pr: entry.prNumber, kind: 'restore-review-label', label: entry.label ?? 'review:pending' });
    } catch (e) {
      refusals.push({ pr: entry.prNumber, kind: 'label-failed', why: String((e && e.message) || e).split('\n')[0] });
    }
  }
  // ── close-superseded half (#3850): an operator disposition, executed mechanically — never a fixer.
  for (const entry of (reconciled.dispatch ?? []).filter((e) => e.kind === 'close-superseded')) {
    let onMain;
    try { onMain = readCardsOnMain({ repoSlug, prNumber: entry.prNumber }); } catch (e) {
      refusals.push({ pr: entry.prNumber, kind: 'close-unreadable', why: String(e?.message ?? e).split('\n')[0] });
      continue;
    }
    if (onMain.length) {
      refusals.push({ pr: entry.prNumber, kind: 'close-card-on-main', why: `card(s) already on main (${onMain.join(', ')}) need a backlog edit before the PR closes` });
      continue;
    }
    try {
      closePr({ repoSlug, prNumber: entry.prNumber, comment: closeSupersededComment(entry.operatorAnswer) });
      dispatched.push({ pr: entry.prNumber, kind: 'close-superseded' });
    } catch (e) {
      refusals.push({ pr: entry.prNumber, kind: 'close-failed', why: String((e && e.message) || e).split('\n')[0] });
    }
  }
  return { dispatched, refusals, reconcileRefusals: reconciled.refusals?.length ?? 0, reconcileRefusalDetails: reconciled.refusals };
}

const IS_CLI = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (IS_CLI) {
  // Same self-heal as every sibling CLI in this family — re-execute rather than dispatch on old code if this
  // checkout was fast-forwarded underneath a long-lived runner.
  armSelfReexecOnFastForward();
  const flags = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  try {
    const result = runReconcilePromoteDraftDispatch({
      repo: typeof flags.repo === 'string' ? flags.repo : null,
      prsFile: flags['prs-file'],
    });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const lines = [`promote-draft-pr-dispatch — ${result.dispatched.length} promoted, ${result.refusals.length} refusal(s)`];
      // Name what was actually done: a close-superseded entry once printed "promoted … to ready-for-review" (live #4734).
      const done = { 'close-superseded': 'closed PR #%s as superseded (operator disposition)', 'restore-review-label': 'restored the review label on PR #%s' };
      for (const p of result.dispatched) lines.push(`  → ${(done[p.kind] ?? (p.stackedOn ? `promoted stacked PR #%s to ready-for-review while its base ${p.stackedOn} is open (own required checks green)` : 'promoted PR #%s to ready-for-review (required checks green)')).replace('%s', p.pr)}`);
      for (const r of result.refusals) lines.push(`  ✗ ${r.kind} PR #${r.pr} — ${r.why}`);
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } catch (e) {
    process.stderr.write(`✗ promote-draft-pr-dispatch failed: ${String((e && e.message) || e).split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}
