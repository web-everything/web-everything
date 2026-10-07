/**
 * pr-merge-gate.mjs — the ONE place a `gh pr merge` to `main` may originate (#2290).
 *
 * INVARIANT: the drain is the SOLE writer to `main`. Every route that used to merge inline — `/pr`
 * (`pr-land.mjs`), `/finish` (`lane-resume.mjs`), `/merge` + `/drain` (`merge-ai-prs.mjs`) — now shells out
 * through THIS module, and only `caller === 'drain'` is allowed to actually merge. `/pr` and `/finish` instead
 * enqueue (label `ready-to-merge`) and trigger a single-couple drain pass, so a single serialized writer is the
 * only place that can safely assign the next NNN (the prerequisite for JIT numbering).
 *
 * BREAK-GLASS: an emergency unbreak-main can bypass the gate with `WE_MERGE_BREAK_GLASS=1` — a documented,
 * off-the-normal-path admin override that writes a LOUD audit line to stderr every time it is used, so a
 * non-drain merge is never silent.
 */
import { execFileSync } from 'node:child_process';

/** The `gh pr merge` method flag (default `--merge` = the --no-ff history the drain wants). Pure. */
export function mergeMethodFlag(method) {
  switch (method) {
    case 'squash': return '--squash';
    case 'rebase': return '--rebase';
    case 'merge':
    default: return '--merge';
  }
}

/** Build the `gh pr merge` argv the gate shells — mirrors the merge-ai-prs inline call exactly:
 *  `pr merge <n> [--repo <slug>] --<method> [--delete-branch] [--match-head-commit <sha>]`. `repo` null → the cwd
 *  repo (no --repo). `deleteBranch` defaults to true; false omits --delete-branch, leaving default argv
 *  byte-identical. `matchHeadCommit` null/empty → the flag is omitted (byte-identical to before this option
 *  existed — every pre-existing caller/test is unaffected). Pure.
 *
 * xvzc4v4 (merge-safety review, bug 1) — `--match-head-commit` is `gh`'s own guard against merging a commit
 * OTHER than the one just reviewed: the merge decision (labels, CI, mergeability) is read once at a pass's
 * START, but the actual `gh pr merge` call can run minutes later at the end of a serial cascade. A push, or a
 * `review:changes` a reviewer adds, in that window was previously invisible — the merge landed whatever head
 * happened to be live at merge time, not the one the decision was actually made about. Passing the head SHA
 * this same pass just re-confirmed makes `gh` itself refuse the merge (a real, server-side race check) if the
 * PR's head moved again between that re-confirmation and this exact call.
 */
export function buildGateMergeArgs({ pr, repo = null, method = 'merge', matchHeadCommit = null, deleteBranch = true }) {
  return ['pr', 'merge', String(pr), ...(repo ? ['--repo', repo] : []), mergeMethodFlag(method), ...(deleteBranch ? ['--delete-branch'] : []),
    ...(matchHeadCommit ? ['--match-head-commit', String(matchHeadCommit)] : [])];
}

/** Preserve the branch when any stacked PR failed to retarget. Pure. */
export function decideDeleteBranch({ retarget } = {}) {
  return !(retarget && Array.isArray(retarget.failed) && retarget.failed.length > 0);
}

/** Is the emergency break-glass override armed? (`WE_MERGE_BREAK_GLASS=1`.) */
function breakGlassArmed(env = process.env) {
  return env && env.WE_MERGE_BREAK_GLASS === '1';
}

/**
 * #2324 — every PR that lands must carry a non-empty description: PR #206 merged with an EMPTY body even
 * though `we:skills-src/pr/SKILL.md` already says a `--body-file` is required and `pr-land.mjs` never drops
 * a body — the rule existed as skill prose, never as an enforced gate. Shared here (not duplicated in
 * `pr-land.mjs` and `merge-ai-prs.mjs`) so BOTH land paths — the producer (`pr-land.mjs`, gates before
 * labelling) and the label lander (`merge-ai-prs.mjs`'s `classifyPr`, gates before merging) — refuse the
 * same class of bodyless PR the same way. Pure: true iff `body` has non-whitespace content.
 */
export function hasNonEmptyBody(body) {
  return typeof body === 'string' && body.trim().length > 0;
}

// ── Anti-test-gaming gate (#2440, slice C of epic #2410) ─────────────────────────────────────────────────
// The convergence loop lands a couple on a GREEN required check. A peer could manufacture that green by
// GAMING the tests rather than fixing the code: delete a failing test, `.skip`/`.only` it away, or shrink the
// case set so the surviving suite no longer covers the bug. Those are DETERMINISTIC, diff-visible tamper forms
// — this gate scans the PR's net diff for them and REFUSES the auto-land (the drain parks the couple
// `review:human`, so a human clears a genuine test removal rather than a script guessing intent).
//
// SCOPE (honest): this catches only what a DIFF proves — a removed/skipped/deleted test. True line-coverage %
// needs a coverage artifact the drain does not have, so "coverage drops" is enforced here in its diff-visible
// proxy (test cases / files removed net). The JUDGMENT half — does a logic fix carry a test that FAILS on the
// pre-change behaviour, is an edited assertion subtly weakened — is not script-decidable; it is the independent
// validator's explicit mandate (`buildValidatorMandate` in `review-core.mjs`), not this gate.

/** A test file: a `__tests__/` dir member, or a `*.test.*` / `*.spec.*` module (the repo's test convention). Pure. */
export function isTestPath(path) {
  return /(^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(String(path || ''));
}

// A `.skip`/`.only` (or an `xit(`/`xdescribe(`/`fit(`/`fdescribe(`) marker — the two ways a test is disabled or
// narrowed-to so a failing sibling never runs. Anchored to the real test callees so it can't false-positive on
// ordinary code: `.skip`/`.only` count only on `it`/`test`/`describe` (never a variable named `context`/`suite`),
// and the bare Jasmine-style globals must be an invocation NOT preceded by a `.` or word char — so `model.fit(`,
// `fitAffineCost(`, and `object-fit` never match. `.todo` is deliberately NOT here: it marks an unwritten test,
// it does not hide a failing one. After `skip`/`only` we accept any of three tails so the parameterized and
// line-wrapped forms can't slip past (#2669): the plain `(` CALL (`it.skip('…')`); a `.each` chain
// (`it.skip.each([…])(…)` / `it.only.each\`…\``), which the old `\(`-only anchor let bypass the gate; and
// end-of-line (`it.skip` with its `(` wrapped to the next line — the diff is scanned per-line so the `(` isn't
// on this one). `skipSomething(` / `.only` mid-identifier still can't match (the tail must be `(`, `.each`, or EOL).
const SKIP_FOCUS_MARKER_RE = /\b(?:it|test|describe)\s*\.\s*(?:skip|only)\s*(?:\.\s*each\b|\(|$)|(?<![.\w])(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/;
// A test-case opener with a string title — `it('…'`, `test("…"` — used to COUNT cases so a net removal is
// detectable. The string-title requirement keeps a bare identifier named `test` from counting, and the leading
// `(?<![.\w])` (not preceded by a `.` or word char) keeps the `.test('literal')` METHOD-CALL form — an
// `expect(RE.test('sample')).toBe(true)` assertion in a `*.test.mjs` file — from counting as a case opener, so
// consolidating such assertions can't net a phantom removal that mis-parks the couple (#2669).
const TEST_CASE_OPENER_RE = /(?<![.\w])(?:it|test)\s*(?:\.\s*\w+\s*)?\(\s*['"`]/;

/**
 * Parse a unified `git diff` into per-file added/removed CONTENT lines + a `deleted` flag. Pure. Only the diff
 * BODY matters here (not exact line numbers), so this is intentionally minimal: it keys files off the
 * `diff --git a/… b/…` header, notes `deleted file mode`, and buckets `+`/`-` content lines (skipping the
 * `+++`/`---` file headers and `@@` hunk markers). Good enough to detect test tampering; not a general patch lib.
 * @param {string} diffText
 * @returns {Array<{path:string|null, deleted:boolean, added:string[], removed:string[]}>}
 */
export function parseUnifiedDiff(diffText) {
  const files = [];
  let cur = null;
  for (const raw of String(diffText || '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : null, deleted: false, added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('deleted file mode')) { cur.deleted = true; continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@')) continue; // headers/hunk markers, not content
    if (raw.startsWith('+')) cur.added.push(raw.slice(1));
    else if (raw.startsWith('-')) cur.removed.push(raw.slice(1));
  }
  return files;
}

/**
 * Scan a PR's net diff for DETERMINISTIC test-gaming — the tamper forms a diff proves. Pure. For each TEST file
 * in the diff it flags:
 *   - `test-file-removed`  — the whole test file was deleted.
 *   - `test-skipped`       — a `.skip`/`.only` (or `xit`/`fit`/…) marker was ADDED (a live test disabled/narrowed).
 *   - `tests-removed`      — net test CASES removed (removed `it(`/`test(` openers exceed added ones).
 * Returns `{ tampered, findings, reasons }`, mirroring the manifest-tamper shape the drain's land loop already
 * consumes, so wiring it is a drop-in park. A clean diff (no test file, or only ADDED tests) → `tampered:false`.
 * @param {{diffText?:string}} o  the two-tree net diff TEXT (`computeNetDiffText`, merge-ai-prs.mjs).
 * @returns {{tampered:boolean, findings:Array<{path:string,kind:string,detail:string}>, reasons:string[]}}
 */
export function scanTestTampering({ diffText = '' } = {}) {
  const findings = [];
  for (const f of parseUnifiedDiff(diffText)) {
    if (!f.path || !isTestPath(f.path)) continue;
    if (f.deleted) {
      findings.push({ path: f.path, kind: 'test-file-removed', detail: 'a test file was deleted' });
      continue; // a delete has no surviving markers/cases to also flag
    }
    const skipAdds = f.added.filter((l) => SKIP_FOCUS_MARKER_RE.test(l)).length;
    if (skipAdds) findings.push({ path: f.path, kind: 'test-skipped', detail: `${skipAdds} skip/only marker(s) added` });
    const removedCases = f.removed.filter((l) => TEST_CASE_OPENER_RE.test(l)).length;
    const addedCases = f.added.filter((l) => TEST_CASE_OPENER_RE.test(l)).length;
    if (removedCases > addedCases) findings.push({ path: f.path, kind: 'tests-removed', detail: `net ${removedCases - addedCases} test case(s) removed` });
  }
  const reasons = findings.map((x) => `${x.kind}: ${x.path} (${x.detail})`);
  return { tampered: findings.length > 0, findings, reasons };
}

/**
 * Is this PR's test-gaming signal (at least partly) INHERITED from an already-escalated stacked base, rather
 * than genuinely new to this PR? Live shape (web-everything/web-everything#2766/#2767, 2026-09-26): #2767 is opened
 * on top of #2766's own branch; #2766 rewrites its "property 4" tests (legitimately, per its own PR), and
 * because #2767 is stacked on it, `scanTestTampering` sees that SAME diff as part of #2767's own net diff too
 * and trips the identical `tests-removed` finding — a human reviewing #2767 cold has no way to know the
 * finding is #2766's, not #2767's own.
 *
 * PURE, and deliberately LABEL-AGNOSTIC — this module never imports `review-escalation.mjs`'s label helpers
 * (see the file header: it is the ONE place a `gh pr merge` may originate, kept free of that concern), so the
 * caller decides `baseAlreadyEscalated` itself (e.g. `hasReviewLabel(basePr.labels, REVIEW_LABELS.human)`) and
 * hands it in as a plain boolean.
 * @param {{findings?: Array<{path: string}>, baseFiles?: string[]|null, baseAlreadyEscalated?: boolean}} o -
 *   `findings` is THIS PR's own `scanTestTampering(...).findings`; `baseFiles` is the stacked base PR's own
 *   changed-file set (best-effort — whatever the caller already fetched this pass, never a new `gh` call
 *   here); `baseAlreadyEscalated` is whether the base PR is ITSELF already carrying `review:human`.
 * @returns {{sharedPaths: string[]}|null} the finding paths this PR shares with the base's own changed files,
 *   or `null` when there is no stacked-and-already-escalated base, or none of this PR's findings trace to it
 */
export function describeStackedTestGamingOrigin({ findings = [], baseFiles = null, baseAlreadyEscalated = false } = {}) {
  if (!baseAlreadyEscalated || !Array.isArray(baseFiles) || !baseFiles.length) return null;
  const baseSet = new Set(baseFiles);
  const sharedPaths = [...new Set(
    (Array.isArray(findings) ? findings : []).map((f) => f && f.path).filter((p) => p && baseSet.has(p)),
  )];
  return sharedPaths.length ? { sharedPaths } : null;
}

/**
 * Assert this caller MAY write to main, WITHOUT shelling a merge (used by non-gh write-to-main intents such as
 * pr-land's `--fallback-git` local `git merge`). `caller === 'drain'` always passes. Any other route THROWS
 * unless break-glass is armed — in which case it passes and emits the loud audit line. Returns
 * `{ breakGlass:boolean }`.
 * @param {{caller:string, pr?:(number|string|null), repo?:(string|null), env?:object, log?:{write:Function}}} o
 */
export function assertMayMerge({ caller, pr = null, repo = null, env = process.env, log = process.stderr } = {}) {
  if (caller === 'drain') return { breakGlass: false };
  if (!breakGlassArmed(env)) {
    throw new Error(
      `pr-merge-gate: only the drain may merge to main (route ${caller} is not the drain). ` +
      `Enqueue + trigger a drain pass instead. Break-glass: WE_MERGE_BREAK_GLASS=1 (logged).`,
    );
  }
  log.write(`pr-merge-gate: BREAK-GLASS merge by route=${caller} pr=${pr} repo=${repo || 'cwd'} — off the normal path\n`);
  return { breakGlass: true };
}

/**
 * The SOLE `gh pr merge` shell-out. Asserts the caller is the drain (or break-glass), then runs
 * `gh pr merge …`. Returns whatever `exec` returns (the merge-ai-prs inline call ignored the result and relied
 * on a throw for failure — preserved: the default `exec` is `execFileSync`, which throws on a non-zero gh exit).
 * `exec` is injectable so the gate is unit-testable without shelling gh.
 * @param {{pr:(number|string), repo?:(string|null), method?:string, matchHeadCommit?:(string|null), deleteBranch?:boolean, caller:string,
 *          exec?:Function, env?:object, log?:{write:Function}}} o
 */
export function mergePr({ pr, repo = null, method = 'merge', matchHeadCommit = null, deleteBranch = true, caller, exec = execFileSync, env = process.env, log = process.stderr } = {}) {
  assertMayMerge({ caller, pr, repo, env, log });
  return exec('gh', buildGateMergeArgs({ pr, repo, method, matchHeadCommit, deleteBranch }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── #3383 — retarget a stacked PR BEFORE its base branch is deleted ────────────────────────────────────
//
// `mergePr` above defaults to merging with `--delete-branch` (also true if the repo has auto-delete-on-merge
// enabled). Left alone, a merge that deletes `headRef` orphans any OPEN PR whose OWN base is `headRef`
// (a PR stacked on top of the one landing now) — and GitHub's behaviour on a deleted base is to CLOSE
// that PR, never to retarget it. The #2578 incident: an approved, unmerged, entirely unrelated PR
// (`lane/x3ecgta-…`, based on `lane/3681-…`) was silently killed the instant `lane/3681-…`'s own PR
// (#2549) merged and its branch was deleted. The fix is to do the retarget FIRST, while the base branch
// still exists to retarget FROM — GitHub refuses both `pr edit --base` and reopen once a PR is closed by
// a vanished base (verified live during #2578's recovery), so this must run strictly before the merge.

/** The `gh pr list` argv that finds every OPEN PR stacked on `headRef` (i.e. its base). Scoped by
 *  `--base`, so this is a narrow, cheap listing — never a full-repo open-PR fan-out. Pure. */
export function buildStackedPrListArgs({ repo = null, headRef }) {
  return ['pr', 'list', '--state', 'open', '--base', String(headRef), ...(repo ? ['--repo', repo] : []), '--json', 'number,baseRefName'];
}

/** The `gh pr edit --base` argv that retargets ONE stacked PR onto `base` (the repo's default branch).
 *  Pure. */
export function buildRetargetArgs({ pr, repo = null, base }) {
  return ['pr', 'edit', String(pr), ...(repo ? ['--repo', repo] : []), '--base', String(base)];
}

/**
 * Retarget every OPEN PR based on `headRef` onto `defaultBranch`, BEFORE `headRef` is deleted by the merge
 * that is about to happen. Best-effort throughout, by design: a `gh` miss here (listing or an individual
 * edit) must never block the merge itself — the merge landing is the invariant that matters, and a missed
 * retarget is still recoverable by hand (or the #3383 recovery sweep for a PR GitHub already closed),
 * while a merge blocked on this side-effect is not. `exec` is injectable so this is unit-testable without
 * shelling `gh`.
 * @param {{repo?:(string|null), headRef:string, defaultBranch:string, exec?:Function, onRetarget?:Function, onFailed?:Function}} o
 * @returns {{retargeted:number[], failed:number[]}}
 */
export function retargetStackedPrs({ repo = null, headRef, defaultBranch, exec = execFileSync, onRetarget = () => {}, onFailed = () => {} } = {}) {
  const retargeted = [];
  const failed = [];
  let stacked;
  try {
    const out = exec('gh', buildStackedPrListArgs({ repo, headRef }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    stacked = JSON.parse(String(out || '[]').trim() || '[]');
  } catch { return { retargeted, failed }; } // listing miss — nothing to safely act on, never blocks the merge
  if (!Array.isArray(stacked)) return { retargeted, failed };
  for (const s of stacked) {
    const num = s && s.number;
    if (num == null) continue;
    try {
      exec('gh', buildRetargetArgs({ pr: num, repo, base: defaultBranch }), { stdio: ['ignore', 'ignore', 'pipe'] });
      retargeted.push(num);
      onRetarget(num);
    } catch {
      failed.push(num);
      onFailed(num);
    }
  }
  return { retargeted, failed };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// LEDGER GATE (plan slice I1 of #verdict-ledger-pr-state-store). PURE. NOT CALLED BY THE LIVE MERGE PATH.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The accepted `mergeGate.reviewAuthority` values. Mirrors `PLATFORM_MERGE_GATE_DEFAULTS` in config/platformDefaults.ts (a test pins it). */
export const REVIEW_AUTHORITIES = Object.freeze(['labels', 'both', 'ledger']);
export const DEFAULT_REVIEW_AUTHORITY = 'labels';

/**
 * Would the ledger let this PR merge? Pure; never throws.
 *   - `labels`: today's behaviour EXACTLY. The ledger is not consulted (not even if unreadable); the label answer stands.
 *   - `both`:   clears only when the labels AND the ledger clear. Strictly tighter than `labels`.
 *   - `ledger`: the label input is dropped (a loosening; the statute gates moving the setting here).
 *   - any other value is treated as `both` (the stricter reading), never as `ledger`.
 * An unreadable ledger (`folded` / `derived` null, `folded.unreadable`, or a `ledger-unreadable` hold) DEFERS
 * with a reason; unreadable is a hold, never "empty".
 *
 * @param {object} o
 * @param {object|null} o.folded The PR's folded ledger entry (`foldVerdictLedger(...).get(pr)`), or null/`{unreadable:true}`.
 * @param {object|null} o.derived `derivePrState(...)` output ({clears, holds}), or null.
 * @param {{sha?:string}|string|null} [o.head] The live head; a bearing verdict covering a different sha does not clear.
 * @param {boolean} o.labelsClear What the label gate says today.
 * @param {string} [o.authority] `mergeGate.reviewAuthority`.
 * @returns {{clear:boolean, defer:boolean, authority:string, reason:string}}
 */
export function decideLedgerGate({ folded = null, derived = null, head = null, labelsClear = false, authority = DEFAULT_REVIEW_AUTHORITY } = {}) {
  if (authority === 'labels') {
    return { clear: labelsClear === true, defer: false, authority, reason: labelsClear === true ? 'labels clear (ledger not consulted)' : 'labels hold' };
  }
  const mode = authority === 'ledger' ? 'ledger' : 'both';
  const ledger = ledgerVerdict({ folded, derived, head });
  if (ledger.defer) return { clear: false, defer: true, authority: mode, reason: ledger.reason };
  if (mode === 'both' && labelsClear !== true) return { clear: false, defer: false, authority: mode, reason: 'labels hold' };
  return { clear: ledger.clear, defer: false, authority: mode, reason: ledger.reason };
}

function ledgerVerdict({ folded, derived, head }) {
  const unreadable = !folded || !derived || folded.unreadable === true || derived.unreadable === true
    || (derived.holds ?? []).some(h => h?.code === 'ledger-unreadable');
  if (unreadable) return { clear: false, defer: true, reason: 'ledger-unreadable: deferring, an unreadable ledger is a hold' };
  const holds = derived.holds ?? [];
  if (holds.length) return { clear: false, defer: false, reason: `ledger holds: ${holds.map(h => h?.code ?? 'unknown').join(', ')}` };
  if (folded.clears !== true || derived.clears !== true) return { clear: false, defer: false, reason: 'ledger does not clear' };
  const sha = typeof head === 'string' ? head : head?.sha;
  const covered = folded.current?.coverage?.headSha;
  if (sha && covered && sha !== covered) return { clear: false, defer: false, reason: `ledger clearance covers ${covered}, head is ${sha}` };
  return { clear: true, defer: false, reason: 'ledger clears' };
}
