#!/usr/bin/env node
import { resolvePinnedDiffBasis, stampDiffBasis, sameDiffBasis } from './lib/pinned-diff-basis.mjs';
/**
 * fetch-parked.mjs — dump a stable per-PR review bundle reviewers currently hand-assemble from scattered `gh`
 * calls (#2434, one of three drain fetch/state helpers under `scripts/`).
 *
 * WHY: when the drain parks a PR for review, a reviewer re-derives the same shape by hand — `gh pr view` for the
 * body/files/state/labels, `gh pr checks` (or the rollup) for green/red, `gh pr diff` for the change — across
 * one or several PR numbers. This is the ONE read-only tool that emits that bundle as a stable JSON array, so
 * the console / reviewer reads one shape, never re-invents the plumbing.
 *
 * Split mirrors the house idiom (`scripts/review-detail.mjs`, `scripts/push-if-green.mjs`): a PURE
 * `assembleParked({view, diff})` distills an already-parsed `gh pr view … --json` object plus the raw diff into
 * the contract; a thin impure CLI does the two `gh` calls per PR and prints. Green/red is single-sourced through
 * `classifyChecks` from `./pr-land.mjs` (the SAME truth pr-land waits for) — the rollup is first normalized to
 * the `gh pr checks` bucket shape classifyChecks reads (`rollupToCheckRows`). Review class reuses
 * `REVIEW_LABELS`/`hasReviewLabel` from `./lib/review-escalation.mjs`.
 *
 * Usage:
 *   node scripts/fetch-parked.mjs 472 471            # JSON array, one entry per PR (default — this is a data tool)
 *   node scripts/fetch-parked.mjs 12 --repo=~/workspace/frontierui   # run gh in another repo's checkout (couples span repos)
 *   node scripts/fetch-parked.mjs 472 --json         # explicit; identical to the default
 *
 * Flags:
 *   <num…>          one or more PR numbers (positional)
 *   --repo=<path>   filesystem checkout to run gh in (default: cwd) — PRs may live in WE/frontierui/plateau-app
 *   --json          emit the JSON array (default; the flag is accepted for symmetry with the other helpers)
 *
 * Tolerant of a missing PR: emits an `{number, error}` entry for it and continues the batch (never crashes).
 * Exit 0 always when at least one number was given; 2 on a usage error (no numbers).
 */
import { execFileSync } from 'node:child_process';
// #2901 — the NET two-tree diff basis. merge-ai-prs.mjs guards its CLI behind `if (IS_CLI)`, so importing
// this one function does not run the lander; the /review skill mandates the same import for the same reason.
import { computeNetDiffText, computeNetDiffPaths, verifyNetDiffPair, collapseRollupToLatestPerName } from './merge-ai-prs.mjs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyChecks } from './pr-land.mjs';
import { REVIEW_LABELS, hasReviewLabel } from './lib/review-escalation.mjs';
// #2908 / PR #1106 review F2 — the DETERMINISTIC parser of the body's `## Escalation reason` block. It already
// existed, unused by this module, while the convergence loop's fetch agent LLM-parsed the same bullets out of
// the same body by eye. Imported, never re-implemented: `review-detail.mjs` guards its CLI behind `IS_CLI`, so
// importing the pure parser does not run it (the same reason this file may import `merge-ai-prs.mjs`).
import { parseEscalationReason } from './review-detail.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';

/** Map a raw `gh` labels array (objects `{name}` or strings) to a plain name array. Pure, tolerant of absent. */
export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
}

/**
 * Normalize a `gh pr view --json statusCheckRollup` array into the `{name, bucket}` row shape `classifyChecks`
 * reads. Pure. WHY: `classifyChecks` was built for `gh pr checks --json …bucket` output (rows carry a `bucket`
 * ∈ pass|fail|pending|skipping|cancel); a rollup row is instead a GraphQL `CheckRun` (`status`/`conclusion`, no
 * `bucket`/`state`) or `StatusContext` (`state`), so feeding the raw rollup would misread every check as passed.
 * This maps each rollup row to gh's own bucket vocabulary so `classifyChecks` stays the single green/red truth.
 *
 * #2925 — COLLAPSED TO THE LATEST ENTRY PER CHECK NAME FIRST (`collapseRollupToLatestPerName`,
 * `we:scripts/merge-ai-prs.mjs`), same rule `latestRequiredCheck` uses. `classifyChecks` folds ALL rows with
 * `some(isFail)`, so without the collapse a superseded `CANCELLED` entry sitting beside a later `SUCCESS` for
 * the same name reads the whole PR as failed even though the check that finished is green. Tolerant of an
 * absent/odd rollup (→ []).
 * @param {Array<object>|null|undefined} rollup
 * @returns {Array<{name:string, bucket:string}>}
 */
export function rollupToCheckRows(rollup) {
  const rows = collapseRollupToLatestPerName(rollup);
  return rows.map((c) => {
    const name = String((c && (c.name || c.context)) || '');
    let bucket;
    if (c && c.status != null && String(c.status).toUpperCase() !== 'COMPLETED') {
      // A CheckRun still in flight (QUEUED / IN_PROGRESS / WAITING / PENDING / REQUESTED).
      bucket = 'pending';
    } else {
      const verdict = String((c && (c.conclusion || c.state)) || '').toUpperCase();
      switch (verdict) {
        case 'SUCCESS':
        case 'EXPECTED':
          bucket = 'pass'; break;
        case 'SKIPPED':
        case 'NEUTRAL':
          bucket = 'skipping'; break;
        case 'CANCELLED':
        case 'STALE':
          bucket = 'cancel'; break;
        case 'FAILURE':
        case 'ERROR':
        case 'TIMED_OUT':
        case 'ACTION_REQUIRED':
        case 'STARTUP_FAILURE':
          bucket = 'fail'; break;
        case 'PENDING':
        case '':
          bucket = 'pending'; break;
        default:
          bucket = 'fail'; // an unknown terminal conclusion is treated as red, never silently green
      }
    }
    return { name, bucket };
  });
}

/**
 * Filter normalized check rows to just the REQUIRED set (#2482). Pure. WHY: the `checks=` token must answer the
 * question a reviewer actually has — "would pr-land merge this?" — and pr-land gates on `gh pr checks --required`
 * (required checks only), NOT the full rollup. `requiredNames` is the required-check name list (from
 * `gh pr checks --required --json name`); when it is a NON-array (the required set couldn't be determined — a
 * transient gh error), we CANNOT honestly narrow, so we keep every row (the historical all-checks behaviour —
 * conservative, over-reports red, never under-reports). An EMPTY array means "this PR has zero required checks" →
 * filters to `[]` → `classifyChecks`' no-checks `passed` default.
 * @param {Array<{name:string, bucket:string}>} rows - `rollupToCheckRows` output
 * @param {string[]|null|undefined} requiredNames
 * @returns {Array<{name:string, bucket:string}>}
 */
export function filterToRequired(rows, requiredNames) {
  const list = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(requiredNames)) return list; // unknown required set → keep all checks (unchanged behaviour)
  const req = new Set(requiredNames.map(String));
  return list.filter((r) => req.has(String((r && r.name) || '')));
}

/**
 * Recover the check rows from a (possibly non-zero) `gh pr checks …` invocation (#2482). Pure. `gh pr checks`
 * exits NON-zero in two different situations that must be told apart:
 *   - checks still PENDING / a check FAILED — gh prints the JSON rows to stdout anyway → recover & classify them.
 *   - the PR has genuinely ZERO required checks — gh prints `no checks reported …` to stderr, no JSON → `[]`
 *     (which `classifyChecks` reads as the no-checks `passed` default, so a no-required-checks PR is green rather
 *     than a forever-pending wait — #2482 finding 3).
 * Anything else (a real gh / network error) is `unknown` — the caller keeps waiting / falls back to all-checks.
 * @param {{stdout?:string, stderr?:string, message?:string}} o
 * @returns {{rows:Array}|{unknown:true}}
 */
export function recoverCheckRows({ stdout, stderr, message } = {}) {
  const out = String(stdout || '').trim();
  if (out.startsWith('[')) {
    try { return { rows: JSON.parse(out) }; } catch { /* not valid JSON — fall through */ }
  }
  if (/no checks reported/i.test(`${stderr || ''}\n${message || ''}`)) return { rows: [] };
  return { unknown: true };
}

/**
 * Resolve a PR's REQUIRED-check name list via `gh pr checks --required --json name` (#2482). Impure only in the
 * injected `runGh` runner (so it is unit-testable with a stub); the interpretation is the pure `recoverCheckRows`.
 * Returns the name array (possibly `[]` for a no-required-checks PR), or `undefined` when the required set can't
 * be determined (a transient gh error) so the caller falls back to the historical all-checks display.
 * @param {(args:string[])=>string} runGh
 * @param {number|string} num
 * @returns {string[]|undefined}
 */
export function resolveRequiredNames(runGh, num) {
  const names = (rows) => (Array.isArray(rows) ? rows.map((r) => r && r.name).filter(Boolean) : undefined);
  try {
    return names(JSON.parse(runGh(['pr', 'checks', String(num), '--required', '--json', 'name'])));
  } catch (e) {
    const rec = recoverCheckRows({ stdout: e && e.stdout, stderr: e && e.stderr, message: e && e.message });
    return rec.rows ? names(rec.rows) : undefined;
  }
}

/** The review class a PR's labels put it in — reuses the ratified `REVIEW_LABELS` (never re-hardcodes the
 *  strings). Pure. `human` (a human must clear it) wins over `pending` (an independent review is owed). */
export function reviewClassFromLabels(labels) {
  if (hasReviewLabel(labels, REVIEW_LABELS.human)) return 'human';
  if (hasReviewLabel(labels, REVIEW_LABELS.pending)) return 'pending';
  return 'none';
}

/**
 * The PURE per-PR bundle assembler (#2434). Takes an already-parsed `gh pr view … --json` object and the raw
 * `gh pr diff` text, returns the stable contract reviewers read. Never throws on a missing field — an absent
 * rollup → `checks.status:'passed'` (classifyChecks' no-checks default), absent labels → `[]`, etc.
 * The `checks` token is over the REQUIRED set when `requiredNames` is supplied (so it matches what pr-land waits
 * for — #2482); with no `requiredNames` it degrades to the full rollup (the historical all-checks behaviour), and
 * `checksScope` records which (`'required'` vs `'all'`) so a consumer knows exactly what the token covers.
 * #2901 — `diffBasis` records WHICH diff the consumer is holding: `'net'` (the two-tree
 * `git diff <forkpoint> <head>`, what a reviewer must judge) or `'three-dot'` (`gh pr diff`, the degraded
 * fallback). A reviewer handed a three-dot diff sees files that sibling lanes already landed on `main` as though
 * this PR added them, and will faithfully report findings about code the PR does not contain — observed on
 * PR #1018, where a juror flagged an "unrelated #2457 re-scope" that is not in the diff at all. The basis must
 * therefore travel WITH the diff: a degraded basis that looks identical to a good one is how a confident,
 * well-argued, wrong finding reaches a PR author.
 * #2908 / PR #1106 review F2 — `escalationReason` is DETERMINISTICALLY PARSED here (`parseEscalationReason`),
 * not left to the consumer's eye. The parked-PR convergence loop's fetch agent used to read the
 * `## Escalation reason` bullets out of `body` itself, and since #2908 that list decides whether a machine may
 * push to the author's branch: `['size']` bands to `low` (editor ON) while `['size','blast-radius']` scores
 * 2 + 3 = 5 → `high` (editor OFF), so ONE dropped bullet flips the gate. PR #1018 — the PR the #2908 ruling is
 * built on — was parked with exactly those two reasons. An LLM re-reading prose the repo already has an exact
 * parser for is a fail-open with no signal, so the bundle carries the parsed list and the agent copies it.
 *
 * @param {{view: object, diff?: string, requiredNames?: string[]|null, diffBasis?: string}} o
 * @returns {{number:number, title:string, body:string, files:Array, state:string,
 *   checks:{status:string, reason:string}, checksScope:string, diff:string, diffBasis:string, labels:string[],
 *   reviewClass:string, escalationReason:string[], headRefName:string, mergeable:string}}
 */
export function assembleParked({ view, diff, requiredNames, diffBasis } = {}) {
  const v = view || {};
  const labels = labelNames(v.labels);
  const checkRows = filterToRequired(rollupToCheckRows(v.statusCheckRollup), requiredNames);
  return {
    number: Number(v.number) || 0,
    title: String(v.title || ''),
    body: typeof v.body === 'string' ? v.body : '',
    files: Array.isArray(v.files) ? v.files : [],
    state: String(v.state || ''),
    checks: classifyChecks(checkRows),
    checksScope: Array.isArray(requiredNames) ? 'required' : 'all',
    diff: typeof diff === 'string' ? diff : '',
    // Default to the DEGRADED label, never the good one: an unstated basis must not read as a net diff.
    diffBasis: diffBasis === 'net' ? 'net' : 'three-dot',
    labels,
    reviewClass: reviewClassFromLabels(labels),
    // #2908 / PR #1106 F2 — the drain's `## Escalation reason` bullets, parsed EXACTLY (see the note above).
    // `[]` when the PR carries no such block — which is a real state, not only a broken read:
    // `pr-land --park=review:pending` (#2622) labels at open and writes no block. Consumers must fail closed
    // on `[]` rather than read it as "no signals fired".
    //
    // KNOWN RESIDUAL, filed as `xx15niz`: the block itself is written ONCE (both writers guard on
    // `bodyHasEscalationReason`), so a later re-park that scores MORE reasons updates the drain's park comment
    // but not this block. Parsing it exactly cannot fix a stale list — observed on PR #1018, whose block lists
    // `blast-radius` alone while the drain's comment lists `blast-radius; size (602 ≥ 400 changed lines)`.
    escalationReason: parseEscalationReason(v.body),
    headRefName: String(v.headRefName || ''),
    // #2864 — the head commit this bundle's diff was read at, so the jury seated over it can RECORD which tree it
    // judged (`reviewedSha` on the roster-picked ledger event). Without it the ledger has no commit identity and a
    // clean fold written at head A reads as clean at head B. `''` when gh did not report one — an unknown tree must
    // read as unknown, never as some other commit.
    headSha: String(v.headRefOid || ''),
    mergeable: String(v.mergeable || ''),
  };
}

/**
 * PURE — do two git object names denote the same commit? Compares on the COMMON PREFIX (min 7), because `gh`
 * and `git rev-parse` legitimately spell the same commit at different lengths. Fail-closed on either side being
 * absent or non-hex: an unprovable identity must read as "different", never as "same".
 * @param {string} a @param {string} b @returns {boolean}
 */
export function sameCommit(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(x) || !/^[0-9a-f]{7,64}$/.test(y)) return false;
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/**
 * PURE — narrow a three-dot `gh pr view --json files` list down to the NET changed set, or REFUSE to.
 *
 * The file list is what a juror CITES, so it must come from the same basis as the diff. On PR #1018 the
 * three-dot list carried 29 entries against 18 real ones, and the phantom finding named one of the surplus.
 *
 * FAIL OPEN, and the rule is not obvious, so it is stated once here rather than re-derived at the call site:
 * we keep the scoped list only when the gh list CONTAINS every net path (`kept.length >= candidate.size`). If
 * it does not, the two sources disagree about encoding or scope and we cannot say which is right — so the
 * caller must keep the unfiltered list AND stop claiming a `net` basis. Presenting a SHORT list as
 * authoritative is the worse error: it tells a reviewer a real file is absent from the PR.
 *
 * @param {{ghFiles?: Array, netPaths?: string[]}} o
 * @returns {{files: Array, scoped: boolean}} `scoped:false` means the caller must degrade the basis too
 */
export function scopeFilesToNet({ ghFiles, netPaths } = {}) {
  const files = Array.isArray(ghFiles) ? ghFiles : [];
  const paths = (Array.isArray(netPaths) ? netPaths : []).map(String).filter(Boolean);
  if (!paths.length) return { files, scoped: false };
  const candidate = new Set(paths);
  const ghPaths = new Set(files.map((x) => String((x && (x.path || x.filename)) || '')));
  // SET containment, not a count comparison. `kept.length >= candidate.size` passed on duplicates: gh reporting
  // [a.ts, a.ts, c.md] against net [a.ts, b.ts] gave kept.length 2 >= size 2 and scoped away b.ts — presenting a
  // SHORT list as authoritative, the outcome this function's own contract calls the worse error. (Finding 8.)
  for (const p of candidate) if (!ghPaths.has(p)) return { files, scoped: false };
  return { files: files.filter((x) => candidate.has(String((x && (x.path || x.filename)) || ''))), scoped: true };
}

/**
 * The NET diff bundle for one PR head — text + plain path list + the basis label, resolved in ONE shot so the
 * three can never disagree. `exec(cmd, args, opts)` is injected, so this is unit-testable with a fake.
 *
 * PROVING THE REF IS CURRENT, not merely resolvable (PR #1031 review). Pinned `computeNetDiff*`
 * reads require a successful base fetch and matching fetched/tracking base tips. This wrapper
 * additionally proves the fetched head matches the API identity, before labelling evidence `net`:
 *   1. the fetch actually ran (its failure is caught, not swallowed), and
 *   2. `origin/<headRef>` now points at the head `gh` reported (`headRefOid`). Exit 0 is NOT enough: a clone
 *      with a narrowed refspec returns 0 from `git fetch origin lane/x` while never creating `origin/lane/x`.
 * With no `headRefOid` supplied the currency check cannot run, so the basis stays `three-dot` — an unprovable
 * claim is not made.
 *
 * `--end-of-options` guards every git call that puts a caller-supplied value in argv position. `headRef` comes
 * from the `gh` API and `git check-ref-format 'refs/heads/--output=/tmp/pwn'` exits 0, so a dash-leading ref is
 * a legal refname that git would otherwise parse as an option (`--upload-pack=<script>` executes).
 *
 * @param {{exec: Function, headRef?: string, headRefOid?: string}} o
 * @returns {{text: string, paths: string[], basis: 'net'|'three-dot'}}
 */
export function resolveNetDiff({ exec, headRef, headRefOid } = {}) {
  const degraded = { text: '', paths: [], basis: 'three-dot' };
  if (typeof exec !== 'function' || !headRef) return degraded;
  // EXPLICIT destination refspec, never the bare opportunistic `git fetch origin <ref>` — the form #2373 banned
  // in the sibling function. In a narrowed-refspec clone the bare form exits 0 WITHOUT creating
  // `refs/remotes/origin/<ref>`, so the currency proof below fails and every PR silently degrades to three-dot:
  // the feature is off with no signal. (PR #1039 review, finding 9.)
  try {
    exec('git', ['fetch', '--quiet', '--end-of-options', 'origin', `+${headRef}:refs/remotes/origin/${headRef}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return degraded; }
  // The ref must now BE the head gh reported. No oid to compare against → we cannot prove it, so we do not claim it.
  if (!/^[0-9a-f]{7,64}$/i.test(String(headRefOid || ''))) return degraded;
  let pinnedHead;
  try {
    // `--verify` is LOAD-BEARING, not decoration. Plain `git rev-parse --end-of-options <ref>` ECHOES the
    // guard as an output line — rev-parse prints back any argument it cannot interpret, unlike `fetch`/`diff`
    // which consume it. Observed on git 2.50.1:
    //     $ git rev-parse --end-of-options refs/remotes/origin/lane/x
    //     --end-of-options
    //     9cd54a9dca60c7902643d3cc6847378c331c2abf
    // so `at` came back as "--end-of-options\n9cd54a9d…", `sameCommit`'s `^[0-9a-f]{7,64}$` rejected it, and
    // this function returned `degraded` on EVERY real invocation — the whole net basis silently never engaged.
    // `--verify` demands exactly one revision and prints the bare sha; it also still refuses an option-shaped
    // ref (`fatal: Needed a single revision`), so the guard is not weakened. Proven by the real-git case in
    // fetch-parked.test.mjs, which runs this against an actual repo — a fake `exec` cannot catch this class,
    // because a fake encodes what git was ASSUMED to do.
    const at = String(exec('git', ['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${headRef}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(at) || !sameCommit(at, headRefOid)) return degraded;
    pinnedHead = at.toLowerCase();
  } catch { return degraded; }
  // THE DIFF IS TAKEN ON THE OID, NOT THE NAME (PR #1039 review, finding 1 — two lenses, one root cause).
  // Proving `refs/remotes/origin/<headRef>` and then diffing `origin/<headRef>` proves nothing about the diff:
  //   • DWIM. `resolveNetDiffBasis`'s candidate 1 is the SHORTHAND `origin/<rev>`, and git resolves refs/tags/
  //     and refs/heads/ BEFORE refs/remotes/. Reproduced on 2.50.1 with a tag literally named `origin/lane/y`:
  //     the proof site returned the head 93d417ae while the diff site returned the tag 02d9552b, and `net` was
  //     still claimed. `git clone` fetches tags by default and `git fetch origin <ref>` auto-follows them; the
  //     local-BRANCH variant resolves with no ambiguity warning at all.
  //   • TOCTOU. Previously each compute re-ran `resolveNetDiffBasis`, which re-fetches — so the proof is re-invalidated
  //     twice, after the fact. A head that moves mid-run (a rebase-drop force-push, a producer push landing
  //     mid-drain — both routine here) yields a `net`-labelled diff of commit B while `view.files` and the
  //     reviewed sha are commit A: verbatim the failure this function claims to eliminate.
  // Pin both ends once and share that basis: neither the head nor the fetched base
  // can move between the reads. `fetchExtraRefs` still carries the NAME for transport.
  const rev = pinnedHead;
  const basis = resolvePinnedDiffBasis({ exec, headSha: rev });
  const net = computeNetDiffText({ exec, basis });
  if (!net || !net.scored || net.revSha !== pinnedHead || typeof net.text !== 'string') return degraded;
  const list = computeNetDiffPaths({ exec, basis });
  if (!list || !list.scored || list.revSha !== pinnedHead) return degraded;
  try { verifyNetDiffPair({ exec, basis, text: net, paths: list }); }
  catch { return degraded; }
  // An EMPTY net diff is not a failure — it is this basis's most valuable signal: the branch is
  // content-identical to main. `scored` already separates "empty" from "could not resolve", so discarding it in
  // favour of the inflated three-dot diff would throw away the one case a reviewer most needs told about.
  // (Finding 10.)
  return { text: net.text, paths: list.paths, basis: 'net' };
}

// Allow importing the pure assembler without running the CLI (the test file + pr-state.mjs import this module).
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) runCli();

function runCli() {
  const args = process.argv.slice(2);
  const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
  const repoFlag = (args.find((a) => a.startsWith('--repo=')) || '').slice('--repo='.length);
  const cwd = repoFlag ? resolve(expandHome(repoFlag)) : process.cwd();
  const nums = args.filter((a) => /^\d+$/.test(a));

  if (nums.length === 0) {
    writeAllSync(1, `${JSON.stringify({ error: 'usage: fetch-parked <num…> [--repo=<path>] [--json]' })}\n`);
    process.exit(2);
  }

  const gh = (ghArgs) => execFileSync('gh', ghArgs, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = nums.map((num) => {
    try {
      const view = JSON.parse(gh([
        'pr', 'view', num, '--json',
        'number,title,body,files,state,statusCheckRollup,labels,headRefName,headRefOid,mergeable',
      ]));
      // #2901 — the NET two-tree diff vs CURRENT main, NOT `gh pr diff`'s three-dot merge-base diff. The
      // three-dot form lists a sibling-lane file that has since landed on main as if THIS PR added it, so a
      // reviewer grades work the PR never did. #2901 fixed this for the `/review` skill and did not touch this
      // module — which is what the converge loop reads — so the defect survived here and produced a phantom
      // finding on PR #1018 within hours. Same basis the drain's escalation SCORE uses (#2450/#2373/#2404), so
      // what a reviewer reads and what was scored cannot drift.
      const exec = (c, a, o) => execFileSync(c, a, { cwd, maxBuffer: 64 * 1024 * 1024, ...o });
      const net = resolveNetDiff({ exec, headRef: String(view.headRefName || ''), headRefOid: String(view.headRefOid || '') });
      // The diff and the file list ride ONE basis or neither does. `scopeFilesToNet` refusing to scope means the
      // two sources disagree, so the net TEXT is dropped too and the whole bundle falls back to three-dot —
      // rather than shipping a net diff beside an inflated three-dot list under a `three-dot` label. That mix is
      // how PR #1018's juror cited a sibling-lane file absent from the diff it was reading.
      const scoped = net.basis === 'net' ? scopeFilesToNet({ ghFiles: view.files, netPaths: net.paths }) : null;
      const useNet = Boolean(scoped && scoped.scoped);
      let diff = useNet ? net.text : '';
      const diffBasis = useNet ? 'net' : 'three-dot';
      // Fall back ONLY when the net basis could not be resolved or could not be trusted (a foreign clone without
      // the head ref, a failed/incomplete fetch, a diff failure, a file list that disagrees with gh's).
      // `diffBasis` then says so, so a consumer can tell a reviewer the list may be inflated.
      if (!diff) { try { diff = gh(['pr', 'diff', num]); } catch { diff = ''; } } // a diff hiccup must not drop the whole entry
      // Narrow the `checks=` token to the REQUIRED set so it matches what pr-land waits for (#2482); a gh hiccup
      // here yields `undefined` → assembleParked falls back to the all-checks display (never drops the entry).
      const requiredNames = resolveRequiredNames(gh, num);
      const scopedView = useNet ? { ...view, files: scoped.files } : view;
      return assembleParked({ view: scopedView, diff, requiredNames, diffBasis });
    } catch (e) {
      const msg = String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop() || 'gh pr view failed';
      return { number: Number(num) || 0, error: msg };
    }
  });

  writeAllSync(1, `${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}
