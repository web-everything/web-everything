#!/usr/bin/env node
/**
 * @file scripts/conveyor/duplicate-pr-watch.mjs
 * @description THE DUPLICATE-PR WATCH (`#xs19sz9`) — a standing, mechanical pass that catches TWO OR MORE
 *   open PRs delivering the SAME backlog item number and raises a visible, non-blocking finding on each one,
 *   without ever picking which one to keep.
 *
 * WHY THIS EXISTS. Live incident, 2026-09-05: the in-flight BUILD guard (`bookkeeping.buildGuards`) was
 * session-ephemeral — wiped by a restart or lost across ticks — so a build whose delivery agent was genuinely
 * still alive read, from ground truth alone, exactly like a never-dispatched item, and the tick loop launched a
 * SECOND independent delivery agent at it. That produced a QUADRUPLE-PR storm on item #3478 (PRs #1933/#1935/
 * #1937/#1939) and double-PR pairs on #3230 (#1928/#1931), #2819 (#1936/#1940), and #3481 (#1929/#1930) — eight
 * PRs total, all real, all mergeable, all silently sitting in the open-PR list with nothing anywhere noticing
 * they duplicated each other. The root cause (the lost in-flight guard) is fixed separately (PR #1946, "a
 * durable floor for the in-flight build guard"), but that fix prevents FUTURE re-dispatches — it does nothing
 * to notice a duplicate pair that slips through some other way (a manual re-dispatch, a retried build whose
 * predecessor's PR never got closed, two independent sessions racing the same item). Nothing anywhere watches
 * THIS axis: `we:scripts/conveyor/parked-pr-conflict-watch.mjs` (#xw0odtv) watches for a PR drifting into a
 * merge conflict against `main`, not for a sibling PR building the same item; `we:scripts/conveyor/
 * branch-drift.mjs` (#3464) watches one named long-lived branch; `we:scripts/conveyor/reconcile-fix-dispatch.mjs`
 * (#3438) dispatches a fix for an ALREADY-bounced PR, it never decides a PR needs bouncing in the first place.
 *
 * WHY A MANUALLY-INVESTIGATED CLOSE PROVED THIS MUST STAY DETECT-ONLY. Resolving the four live incident groups
 * by hand (reading real diffs, not file/line counts) found three clean-superset cases — safe to close the
 * losers — and ONE case (#2819, PRs #1936/#1940) that was NOT a superset at all: both PRs touch the same
 * functions with genuinely different, non-overlapping detection logic, and the correct outcome is a human/agent
 * MERGING the good parts of both, not picking a winner. A script cannot tell those two cases apart without
 * reading the actual diff content — exactly the judgment `we:docs/agent/platform-decisions.md` (the "alert,
 * don't auto-resolve content decisions" line `#xw0odtv` itself established for merge conflicts) refuses to
 * automate. So this pass's job is the one mechanically-safe half: notice the duplicate, say so, on EVERY PR in
 * the group — never close one, never guess which is better.
 *
 * HOW "delivers the same item" IS DECIDED — REUSED, NOT REINVENTED. `we:scripts/lib/open-pr-items.mjs#deliveredItemNumsFromPr`
 * already answers "which backlog item id(s) does this PR's ref/title claim to DELIVER" for the readiness
 * ranker's own exclusion list, with eight rounds of hard-won false-positive guards (annotation PRs, batch-chain
 * trailing segments, date-shaped refs, "does not resolve #NNN" disclaimers, all-markdown diffs, "no code
 * changes" blanket disclaimers — see that file's own docstring). Re-deriving any of that here would silently
 * diverge from the readiness ranker's own notion of "delivers" the first time either file changes. This pass
 * imports the function directly and groups by its output.
 *
 * GENUINE SLICE vs. DUPLICATE — ALREADY DISAMBIGUATED BY THE ID ITSELF, NO EXTRA CARVE-OUT NEEDED.
 * `we:docs/agent/backlog-workflow.md`'s own sizing convention ("Splitting a large story") gives every
 * legitimately-different slice of an epic its OWN item number (`parent: "NNN"` links the slice back to the
 * epic it rolls under) — two PRs building two different slices of the same epic therefore deliver two
 * DIFFERENT item numbers and never land in the same group here. The one other shape considered — a single item
 * intentionally delivered across MULTIPLE PRs over time (`we:backlog/3443-*.md`'s own "covers the whole ongoing
 * effort, not one PR" framing) — is, by that same card's own Done-when text, a SEQUENTIAL relay (each increment
 * "is its own small PR... landed... never a bulk merge"), not two PRs concurrently open at once. So under this
 * repo's own conventions there is no legitimate reason for 2+ OPEN PRs to ever deliver the identical item
 * number at the same time — any occurrence this pass finds is, by construction, exactly the class it exists to
 * catch. Over-firing on a hypothetical legitimate exception costs one reviewer's attention (the same asymmetry
 * `we:scripts/lib/review-escalation.mjs` names throughout); under-firing lets a real duplicate storm sit
 * invisible, which is the incident this pass was born from.
 *
 * HOW THE FINDING IS RAISED — REUSED, NOT A THIRD MECHANISM. `we:scripts/conveyor/reconcile-finding.mjs`
 * (landed the same night as this pass) is already the shim for "a mechanical/reconciliation pass found this PR
 * conflicts with a decision made elsewhere in the repo" — precisely this pass's shape (the "decision made
 * elsewhere" being "another open PR already claims this item"). Posting through it means the finding rides the
 * SAME `review:changes` bounce every other reconciliation finding does, routes into the same fix→re-review
 * cycle (`we:scripts/conveyor/reconcile-fix-dispatch.mjs`), and can never itself clear a hold or land anything
 * (`review:changes` never emits `review:accepted`) — no new label, no new comment scheme, no new drain rule.
 * This file shells `node we:scripts/conveyor/reconcile-finding.mjs <pr> --body-file=<tmp file>` per finding
 * (never imports `runReconcileFindingCli` in-process — that function's shared harness calls `process.exit()` on
 * completion, which would kill this pass after its FIRST finding in a multi-PR sweep), mirroring the
 * subprocess-per-pass composition `we:skills-src/conveyor/runner.mjs#makeCliMechanicalPasses` already uses for
 * every sibling pass.
 *
 * DEDUP — THE FINDING'S OWN EFFECT IS THE DURABLE MARKER, NO SEPARATE STORE (mirrors `#xw0odtv`'s own
 * "the label's presence IS the state" contract, #2612 "no parallel state store" ruling). Reusing an EXISTING
 * label as that marker, rather than minting a new one, is required here — `reconcile-finding.mjs` posts through
 * the ratified `review:changes` label, and inventing a second `dup-pr:flagged`-shaped label beside it would be
 * exactly the "new label or new comment scheme" `reconcile-finding.mjs`'s own docstring already argued against.
 * So: a PR that ALREADY carries `review:changes` is skipped — whether this pass's own prior sweep put it there
 * or a genuine human/agent review did, the PR is already parked and will not silently merge, so re-posting the
 * same finding every tick would only spam a comment with no new information. UNLIKE `#xw0odtv`'s conflict
 * label, this is NOT self-clearing: `reconcile-finding.mjs`'s own docstring is explicit that a sequencing
 * finding "has no single mechanically-correct resolution" and clearing it is a human/agent judgment call, never
 * this file's to make — so once flagged, a PR stays flagged until a human/agent explicitly clears
 * `review:changes` (accepts it, or fixes and re-arms), exactly like every other reconciliation finding.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors `we:scripts/conveyor/parked-pr-conflict-watch.mjs`):
 *   • {@link groupPrsByDeliveredItem}, {@link planDuplicateFindings}, and {@link buildDuplicateFindingBody} are
 *     PURE — no fs/git/gh/clock/process.
 *   • The IO shell ({@link defaultListOpenPrs}, {@link defaultPostFinding}, {@link watchDuplicatePrs}, the CLI)
 *     owns every `gh`/subprocess call.
 *
 * THE CADENCE. Wired into `we:skills-src/conveyor/runner.mjs#makeCliMechanicalPasses`, beside the
 * `we:scripts/conveyor/parked-pr-conflict-watch.mjs` line — the same "piggyback on a pass the headless runner
 * already ticks" shape both `#3464` and `#xw0odtv` used, so a duplicate-PR pair is checked every tick with no
 * new cron/daemon.
 */
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';

import { deliveredItemNumsFromPr } from '../lib/open-pr-items.mjs';
import { REVIEW_LABELS } from '../lib/review-escalation.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { scopePrsToQueue } from './queue-scope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo root, resolved from this file's own location — same derivation as
 *  `we:scripts/operations/dispatch-lane-io.mjs#REPO_ROOT`. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** How many open PRs one `gh pr list` call reads per repo — generous relative to any repo's live open count,
 *  matching `we:scripts/conveyor/parked-pr-conflict-watch.mjs#PR_LIST_LIMIT`. */
export const PR_LIST_LIMIT = 200;

/** The name of THIS pass, threaded into `reconcile-finding.mjs --agent=` so the durable comment's attribution
 *  line names which mechanical pass raised it (`defaultReconcileActor`'s `agent` fold-in). */
export const AGENT_NAME = 'duplicate-pr-watch';

// ── PURE CORE (no fs / git / gh / clock / process — every input is injected) ───────────────────────────────

/**
 * Read one label list (either `{name}` objects or bare strings, matching `gh --json labels`'s own shape) for a
 * given label name. Pure. Mirrors the same tolerant shape `we:scripts/conveyor/parked-pr-conflict-watch.mjs
 * #planConflictLabelChange` reads inline; factored out here since this file checks it from two call sites.
 * @param {Array<{name?:string}|string>} labels
 * @param {string} name
 * @returns {boolean}
 */
export function hasLabelNamed(labels, name) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean)
    .includes(name);
}

/**
 * Group open PRs by every backlog item number each one DELIVERS (`deliveredItemNumsFromPr`, reused verbatim —
 * see file header). Pure. A PR that delivers no id (a hand-branched PR, an annotation PR, an all-markdown PR —
 * every guard `deliveredItemNumsFromPr` already applies) contributes to no group and can never be flagged.
 * @param {Array<{number:number, headRefName?:string, title?:string, body?:string, files?:Array<{path?:string}|string>}>} prs
 * @returns {Map<string, number[]>} item id (zero-padded) → the open PR numbers that deliver it, in list order
 */
export function groupPrsByDeliveredItem(prs) {
  const byItem = new Map();
  for (const pr of Array.isArray(prs) ? prs : []) {
    const changedFiles = Array.isArray(pr?.files) ? pr.files : null;
    const nums = deliveredItemNumsFromPr(pr?.headRefName, pr?.title, { body: pr?.body, changedFiles });
    for (const n of nums) {
      if (!byItem.has(n)) byItem.set(n, []);
      byItem.get(n).push(pr.number);
    }
  }
  return byItem;
}

/**
 * THE WHOLE DECISION: which open PRs need a duplicate finding posted, and what each one's finding should say.
 * Pure. For every item id delivered by 2+ open PRs, EVERY PR in that group is a target (no keeper is chosen —
 * see file header) UNLESS it already carries `review:changes` (the dedup check — see file header). A PR that
 * duplicates on more than one item id at once (a batch PR whose trailing item collides with another PR, while
 * an earlier segment of the same batch also collides elsewhere) gets exactly ONE combined finding, not one
 * finding per collision.
 * @param {Array<{number:number, headRefName?:string, title?:string, body?:string, labels?:Array,
 *   files?:Array}>} prs
 * @returns {Array<{pr:number, duplicates:Array<{itemNum:string, siblings:number[]}>}>}
 */
export function planDuplicateFindings(prs) {
  const list = Array.isArray(prs) ? prs : [];
  const byItem = groupPrsByDeliveredItem(list);
  const byNumber = new Map(list.map((pr) => [pr.number, pr]));
  const dupsByPr = new Map(); // prNumber -> [{itemNum, siblings}]
  for (const [itemNum, prNums] of byItem) {
    if (prNums.length < 2) continue;
    for (const prNum of prNums) {
      const siblings = prNums.filter((n) => n !== prNum);
      if (!dupsByPr.has(prNum)) dupsByPr.set(prNum, []);
      dupsByPr.get(prNum).push({ itemNum, siblings });
    }
  }
  const results = [];
  for (const [prNum, duplicates] of dupsByPr) {
    const pr = byNumber.get(prNum);
    if (!pr) continue; // defensive — every prNum here came from `list` itself
    if (hasLabelNamed(pr.labels, REVIEW_LABELS.changes)) continue; // already flagged/held — dedup (see header)
    results.push({ pr: prNum, duplicates });
  }
  // Deterministic order (ascending PR number) — a test/log reader should never see tick-to-tick reordering of
  // an unchanged input driven only by Map insertion order.
  results.sort((a, b) => a.pr - b.pr);
  return results;
}

/**
 * The finding write-up handed to `reconcile-finding.mjs --body-file=`. Pure string builder. Names every
 * colliding item id and its sibling PR number(s), states the mechanical cause class (without asserting THIS
 * specific incident's root cause is still live — that fix is a separate, already-tracked PR), and is explicit
 * that this finding picks no winner.
 * @param {{pr:number, duplicates:Array<{itemNum:string, siblings:number[]}>}} plan
 * @returns {string}
 */
export function buildDuplicateFindingBody({ pr, duplicates } = {}) {
  const lines = [
    `**Duplicate open PR detected for backlog item${duplicates.length > 1 ? 's' : ''} `
      + `${duplicates.map((d) => `#${d.itemNum}`).join(', ')}.**`,
    '',
  ];
  for (const { itemNum, siblings } of duplicates) {
    const siblingList = siblings.map((n) => `#${n}`).join(', ');
    lines.push(`- Item **#${itemNum}**: this PR (#${pr}) and ${siblings.length > 1 ? 'PRs' : 'PR'} `
      + `${siblingList} both appear to deliver it, and both are currently open.`);
  }
  lines.push(
    '',
    'Two or more concurrently open PRs delivering the same backlog item is not this repo\'s normal shape — a '
      + 'legitimately different slice of the same epic gets its own item number (`parent:` links it back), and '
      + 'a genuinely multi-PR item lands its increments sequentially, one at a time, never with two competing '
      + 'PRs open at once. The most common real cause is a dispatch bug (an in-flight build guard losing track '
      + 'of a still-running build and re-dispatching a second agent at the same item) rather than intentional '
      + 'parallel work.',
    '',
    'This finding does **not** say which PR should be kept — that needs an actual read of each PR\'s real diff '
      + '(a size/file-count comparison is not sufficient: one past instance of this exact incident turned out to '
      + 'need the two PRs merged together, not one picked over the other, because each had unique, '
      + 'non-overlapping value). A human or reconciliation agent should read the diffs, then either close the '
      + 'redundant PR(s) with a comment pointing at the keeper, or reconcile them into one PR if neither is a '
      + 'clean superset of the other.',
  );
  return lines.join('\n');
}

// ── IO SHELL (gh / subprocess only past this point — the CLI, gated on the main-module check) ──────────────

/**
 * The open-PR discovery query. `exec` is injectable so the argv is assertable with no `gh` on PATH. Requests
 * `files` (not just `changedFiles`, a bare count) because `deliveredItemNumsFromPr`'s guard 7 (an all-markdown
 * diff can never be a real delivery) needs each path, not a number.
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultListOpenPrs({ exec = execFileSyncThrottled, repo = null } = {}) {
  // #gh-graphql-budget — read the host-shared open-PR snapshot (one right-sized list per repo per TTL for the
  // whole fleet) instead of a private `gh pr list`; null = not applicable (tests, cwd repo) → the direct read below.
  if (exec === execFileSyncThrottled) { const shared = readSharedOpenPrs({ repo, fields: 'number,headRefName,title,body,labels,files' }); if (shared) return shared; }
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,headRefName,title,body,labels,files'];
  if (repo) argv.push('--repo', repo);
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Post ONE finding via `we:scripts/conveyor/reconcile-finding.mjs`, out of process (see file header for why
 * this is never an in-process `runReconcileFindingCli` call). Writes the body to a fresh temp file under
 * `os.tmpdir()` — one of `reconcile-finding.mjs`'s own allowed `--body-file` roots
 * (`we:scripts/review-set-label.mjs#bodyFileRoots`) — and always removes it afterward, success or failure.
 * @param {{repo?:string|null, pr:number, body:string, root?:string, exec?:Function, writeFile?:Function,
 *   removeFile?:Function, tmpDir?:string}} o
 */
export function defaultPostFinding({
  repo = null, pr, body, root = REPO_ROOT, exec = execFileSync,
  writeFile = writeFileSync, removeFile = unlinkSync, tmpDir = tmpdir(),
} = {}) {
  const file = join(tmpDir, `duplicate-pr-finding-${pr}-${randomUUID()}.md`);
  writeFile(file, body, 'utf8');
  try {
    const argv = [join(root, 'scripts', 'conveyor', 'reconcile-finding.mjs'), String(pr),
      `--body-file=${file}`, `--agent=${AGENT_NAME}`];
    if (repo) argv.push(`--repo=${repo}`);
    // #x5n4zn3 — was bare (no timeout).
    exec('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  } finally {
    try { removeFile(file); } catch { /* best-effort cleanup — a leftover temp file is not this pass's failure */ }
  }
}

/**
 * THE IO SHELL. Lists open PRs, plans every duplicate finding ({@link planDuplicateFindings}), posts each one,
 * and reports what happened. Never throws on a per-PR write failure — one bad `reconcile-finding.mjs` call must
 * not stop the sweep from posting the rest (mirrors `we:scripts/conveyor/parked-pr-conflict-watch.mjs`'s own
 * best-effort contract).
 * `queueScope` (epic #3383) — see {@link ./queue-scope.mjs}. DEFAULT OFF ⇒ `scopePrsToQueue` is the IDENTITY
 * function and this sweep stays repo-wide. Note what scoping means for THIS pass specifically: the duplicate
 * GROUPING is computed over the narrowed list, so a scoped checkout reports duplicates only among the PRs its
 * own queue names — which is the honest answer for a scoped instance (it has no business posting a finding on
 * a pair of PRs that are not its work), and is why the filter sits before `planDuplicateFindings`, not after.
 * @param {{repo?:string|null, listPrs?:Function, postFinding?:Function, dryRun?:boolean, queueScope?:object}} [o]
 * @returns {Array<{pr:number, itemNums:string[], posted:boolean, error?:string}>}
 */
export function watchDuplicatePrs({
  repo = null, listPrs = defaultListOpenPrs, postFinding = defaultPostFinding, dryRun = false, queueScope = {},
} = {}) {
  const prs = scopePrsToQueue(listPrs({ repo }), { label: 'duplicate-pr-watch', ...queueScope });
  const plans = planDuplicateFindings(prs);
  const results = [];
  for (const plan of plans) {
    const itemNums = plan.duplicates.map((d) => d.itemNum);
    const entry = { pr: plan.pr, itemNums, posted: false };
    if (dryRun) { results.push(entry); continue; }
    try {
      const body = buildDuplicateFindingBody(plan);
      postFinding({ repo, pr: plan.pr, body });
      entry.posted = true;
    } catch (e) {
      entry.error = String((e && e.message) || e).split('\n')[0];
    }
    results.push(entry);
  }
  return results;
}

/** Repeatable CLI entry so argv contracts can reuse the loaded watcher graph. */
export function runDuplicatePrWatchCli(argv = process.argv.slice(2)) {
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const verb = argv.find((a) => !a.startsWith('--')) || 'sweep';
  const repo = flag('repo') || null;
  const dryRun = argv.includes('--dry-run');
  const prsFile = flag('prs-file');
  if (verb !== 'sweep') {
    writeLineSync(2, `usage: duplicate-pr-watch.mjs sweep [--repo=<owner/name>] [--dry-run] [--prs-file=<path>]`);
    process.exitCode = 2;
  } else {
    try {
      const results = watchDuplicatePrs({
        repo, dryRun, ...(prsFile ? { listPrs: () => readPrsFromFile(prsFile) } : {}),
      });
      for (const r of results) {
        const verb2 = dryRun ? 'would flag' : r.error ? 'FAILED to flag' : 'flagged';
        writeLineSync(2, `  ⚠ PR #${r.pr}: ${verb2} as a duplicate of item(s) ${r.itemNums.map((n) => `#${n}`).join(', ')}${r.error ? ` (${r.error})` : ''}`);
      }
      writeAllSync(1, `${JSON.stringify({ checked: true, flagged: results.length, results })}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) runDuplicatePrWatchCli();
