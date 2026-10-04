/**
 * @file scripts/operations/pr-status.mjs
 * @description THE `pr-status` DECLARATION (#xewnork, under epic #3029) — for each open PR, did a check
 *   actually RUN on the head that is there now, what did it conclude, and does the review label agree?
 *
 * ── NOT THE SAME QUESTION AS `we:scripts/pr-status.mjs` ─────────────────────────────────────────────────────
 *
 * They share a basename because they share a SUBJECT (an open PR) and they answer to different failures. THIS
 * one asks whether the MACHINE ran: did a check execute on the head that is there now, and does the review
 * label agree — the question that caught #1510/#1511 sitting twelve hours with `total_count: 0`. The command
 * `we:scripts/pr-status.mjs` (`npm run pr-status`) asks who is WORKING on the PR and what is owed — the PEOPLE
 * and AGENTS question, which catches a PR sitting with no live worker. Neither subsumes the other and neither
 * should grow into the other; a reader who wants "is this diff moving" wants that file, not this one.
 *
 * ONE MEASURED SIDE EFFECT OF SHARING THE BASENAME, recorded HERE as well as there so a maintainer reading THIS
 * file is not left to re-discover it: the #2967 test-only-export scan matches imports and shelled files by
 * specifier BASENAME, and `npm run pr-status` shells `pr-status.mjs`, so once that command landed BOTH files
 * count as shelled and the scan stopped reporting this module's three-valued check-state export (the frozen
 * list of `green`/`red`/`pending`/`unchecked`, declared a few lines below) as test-only. That export is no more
 * wired than it was — the finding is HIDDEN, not fixed. The scan's own header calls basename merging a
 * deliberate one-way trade ("can only ever HIDE a finding, never invent one"), so this is that trade being
 * paid, not a new defect; if #2967's coverage of this module is wanted back, this note is why it went.
 *
 * AND THAT IS WHY THE EXPORT IS DESCRIBED HERE RATHER THAN NAMED. `findTestOnlyExports` treats ANY second
 * mention of an export's name in its own file as evidence it is wired — a JSDoc mention counts. Spelling the
 * identifier in this paragraph would therefore make the note a SECOND, permanent reason the scan stays quiet
 * about it, surviving even if the basename merge above were ever undone. A note explaining why coverage went
 * must not be the thing that keeps it gone.
 *
 * ── WHY A POLL, WHEN A SUBSCRIPTION EXISTS ──────────────────────────────────────────────────────────────────
 *
 * Subscribing to PR activity looks like the answer to "we lost time not noticing a PR was stuck", and it is
 * not the answer to THIS. A webhook stream delivers EVENTS. The failure it has to catch is the ABSENCE of
 * one: PRs #1510 and #1511 sat for twelve hours because CI never ran on their current heads at all —
 * `total_count: 0` check runs — and a watcher receiving nothing is indistinguishable from a watcher waiting
 * on a build. An event stream cannot, structurally, report that nothing happened.
 *
 * So the two are complements, not substitutes: a subscription is the right tool for "a human commented", and
 * only a poll that asserts PRESENCE catches a stall. This declares the poll.
 *
 * ── THE OUTCOME IS THREE-VALUED, AND THE THIRD VALUE IS THE POINT ───────────────────────────────────────────
 *
 *   · `green` / `red` — a check ran ON THIS HEAD and concluded.
 *   · `pending`       — a check is running on this head.
 *   · `unchecked`     — NO check run exists for this head.
 *
 * `unchecked` is `unrun` wearing a different hat, and it is the whole reason this file exists. Folded into
 * `pending` it reads as "still building" forever, which is exactly how twelve hours passed without anyone
 * looking. It is the same line `verify` draws between a check that failed and one that never ran, and the
 * same line `mutation-check` draws around a suite that could not execute: absence of evidence is never
 * evidence of absence.
 *
 * A HEAD-KEYED QUESTION, never a PR-keyed one. `gh`'s check list is keyed to a commit, so a PR whose head
 * moved after CI passed has GREEN CHECKS THAT BELONG TO A SUPERSEDED COMMIT. Both stalled PRs displayed
 * exactly that, and it is why `headSha` is reported beside every outcome rather than left implicit — a
 * verdict about another commit is not a verdict about this one.
 *
 * ── THE LABEL CROSS-CHECK ───────────────────────────────────────────────────────────────────────────────────
 *
 * The stall was not merely invisible, it was actively MISREPORTED: both PRs carried a `checking` label while
 * holding zero check runs. The label is a claim about the checks, so a label that disagrees with them is a
 * finding in its own right — and it is the signal a human actually reads. `disagreements` names those pairs
 * rather than leaving a reader to notice that two independently-correct-looking fields cannot both be true.
 *
 * BOTH STEPS ARE `compute` AND THERE IS NO SINK. Asking a PR's status is a READ. Nothing here may write, so
 * `./http-adapter.mjs` derives a GET-only, run-record-free surface — the path `suggest-next`, `gate-health`
 * and `verify` already take. The `gh` calls live in `./pr-status-io.mjs` and are injected, so every branch
 * below is reachable in a test with no network and no credential.
 *
 * PURE apart from that injected reader: no fs, no clock, no process, no network in this file.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
// #2925/#xkfv491, threaded here 2026-09-29 (LIVE DEADLOCK, PR #2878 — see `reduceCheckState`'s own header).
// Imported from its OWN dependency-free module, `../lib/rollup-collapse.mjs`, NEVER from `../merge-ai-prs.mjs`
// (where this same collapse also lives, re-exported) — this file is the declaring module of the `pr-reconcile`
// READ-ONLY operation (`we:scripts/operations/http-adapter.test.mjs#3036`), which must import nothing that can
// act, and `merge-ai-prs.mjs` imports `node:child_process`/`node:fs` writes/etc. throughout. See that lib
// module's own header for the full reasoning.
import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';

export const PR_STATUS_OP = 'pr-status';

/** The three-valued check state of ONE pull request. `unchecked` is NOT a flavour of `pending`. */
export const CHECK_STATES = Object.freeze(['green', 'red', 'pending', 'unchecked']);

/**
 * Conclusions GitHub reports that mean "this check did not block". `skipped` and `neutral` are not passes and
 * not failures; counting them as either would invent a verdict the check never gave.
 */
export const NON_BLOCKING_CONCLUSIONS = Object.freeze(['skipped', 'neutral']);

/**
 * Check names EXCLUDED from every CI-truth reduction in this file (and its siblings `we:scripts/progress-
 * board.mjs`'s `ciFailed` and `we:scripts/readiness/conveyor-state.mjs`'s `ciRollup`, which mirror this same
 * list) — checks whose job IS to report a review/merge-gate STATE, not the code's health. `review-gate`
 * (`we:.github/workflows/review-gate.yml` + `we:scripts/check-review-gate.mjs`) is BY DESIGN red for as long
 * as a PR carries an un-cleared review hold (`review:pending`/`review:changes`/`review:human`) — that is its
 * whole job, a required check enforcing the gate at the branch-protection layer. Folding it into a wholesale
 * "any check failed" scan creates a self-referential deadlock: the conveyor's own `classifyPr` needs CI to
 * read clean to ever reach its `needs-review` branch, but `review-gate` cannot turn green until a review
 * actually happens — so a review is never dispatched, discovered live 2026-09-05 holding all 10 open
 * `review:pending` PRs in `ci-red` forever (`test`/`smoke`/`test-shard` all green, only `review-gate` red).
 * See `x3hg6h2` for the full incident. `we:scripts/merge-ai-prs.mjs`'s `latestRequiredCheck` never had this
 * bug — it checks ONE named required check (`test` by default), never a wholesale scan, so the real
 * merge-landing gate was never affected; this list only matters to the wholesale "is anything red" readers.
 *
 * `soak-replay-gate` (`we:.github/workflows/soak-replay-gate.yml` + `we:scripts/soak-replay-gate-cli.mjs`,
 * PR #2775) joined this list for the SAME underlying reason, discovered the same way: it is NOT a required
 * status check (`gh api repos/<repo>/branches/main/protection --jq .required_status_checks.contexts` lists
 * only `test`/`smoke`/`daemon-soak`), yet a wholesale "any check failed" scan treated its red the same as a
 * real required-check failure. LIVE INCIDENT 2026-09-26, PR #2748 (web-everything/web-everything): every real
 * required check (`test`, `smoke`, `daemon-soak`) was green, `soak-replay-gate` was the ONLY red check (a
 * separate, genuine gap in that PR's own waiver — see that gate's own module for the fix to its parsing), and
 * `classifyPr` still read the PR as `ci-red` off that one advisory check, which kept a `ci-heal-2748` session
 * dispatched against a PR with nothing a ci-heal could fix — pure waste, and it blocked landing. The DEEPER
 * fix for "an advisory workflow can do this again" is {@link module:required-status-checks} (`we:scripts/lib/
 * required-status-checks.mjs`) — an optional, PREFERRED required-set (fetched from branch protection, cached)
 * that `we:scripts/progress-board.mjs#ciFailed`/`classifyPr` accept and use INSTEAD of this exclusion list
 * when a caller supplies it (`we:scripts/conveyor/reconcile-pass.mjs` does, on the real incident's path). This
 * list stays as the SHARED FALLBACK for every call site that never wires a required set through (this file's
 * own `reduceCheckState`, `we:scripts/readiness/conveyor-state.mjs#ciRollup`, `we:scripts/operator/dispatch.mjs
 * #healCi`) — adding `soak-replay-gate` here is what fixes THOSE immediately, with no rewiring needed.
 */
export const CI_TRUTH_EXCLUDED_CHECKS = Object.freeze(['review-gate', 'soak-replay-gate']);

/**
 * Conclusions that mean the check ran and did not succeed.
 *
 * `startup_failure` IS IN THE LIST and was missing from the first cut (PR #1521 juror). A check whose runner
 * failed to even start is a check that ran and failed — GitHub says so — but omitting it sent that case to
 * `unreadable`, which this file reports as `unchecked`. Getting it wrong in that direction is worse than it
 * sounds: `red` says "someone broke something, go look", `unchecked` says "nothing has been asked yet". A
 * broken workflow file produces `startup_failure` on every run, so the whole PR would have read as never
 * checked rather than as reliably failing.
 */
export const FAILING_CONCLUSIONS = Object.freeze([
  'failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure',
]);

/**
 * Reduce one PR's check runs to a single three-valued state. PURE.
 *
 * THE EMPTY LIST IS THE LOAD-BEARING CASE and it is checked FIRST, before anything else can turn it into a
 * softer answer. Zero check runs on the current head is `unchecked`: no check has been asked about this
 * commit, which is neither "passing" nor "about to pass". Every other branch below describes a check that
 * exists.
 *
 * ORDER AFTER THAT: pending outranks failure outranks success, because a caller acts on the worst thing that
 * is still true. A suite with one job still running is not green yet however many of its siblings passed.
 *
 * A run with NO conclusion and a non-completed status is in flight. A run that is `completed` with no
 * conclusion at all is not a pass — it is unreadable, and unreadable joins `unchecked` rather than `green`.
 *
 * `requiredChecks`, when supplied non-empty, REPLACES the {@link CI_TRUTH_EXCLUDED_CHECKS} exclusion with the
 * required-set inclusion this file's sibling `we:scripts/progress-board.mjs#ciFailed` documents in full —
 * only a check named in `requiredChecks` is considered here at all. Omitted, behaviour is unchanged.
 *
 * COLLAPSED TO THE LATEST RUN PER CHECK NAME FIRST (`collapseRollupToLatestPerName`, #2925/#xkfv491) — see
 * `we:scripts/progress-board.mjs#ciFailed`'s own header for the full live incident (PR #2878, chalbert/
 * web-everything) this closes: `runs` here is the SAME raw `pr.statusCheckRollup` `ciFailed` reads (both are
 * fed it by `we:scripts/conveyor/reconcile-core.mjs#planReconcile`, one call apart), so a required check that
 * reran more than once on one head (a `-gate`-shaped check retriggered by a label/edit event) left a stale
 * `FAILURE` run beside its own later `SUCCESS` rerun, and this reducer's flat `.filter()` counted BOTH —
 * reading `check.state: 'red'` off a check whose CURRENT run had already gone green.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string|null}>} runs - check runs FOR THE HEAD SHA
 * @param {string[]} [requiredChecks] - the repo's required status-check names; see above.
 * @returns {{state: string, why: string, counts: {total: number, succeeded: number, failed: number, running: number, nonBlocking: number, unreadable: number}}}
 */
export function reduceCheckState(runs = [], requiredChecks) {
  const required = Array.isArray(requiredChecks) && requiredChecks.length ? requiredChecks : null;
  const list = collapseRollupToLatestPerName(runs).filter((r) => {
    const name = String(r?.name ?? '');
    return required ? required.includes(name) : !CI_TRUTH_EXCLUDED_CHECKS.includes(name);
  });
  const counts = { total: list.length, succeeded: 0, failed: 0, running: 0, nonBlocking: 0, unreadable: 0 };

  const missing = required?.filter(name => !list.some(run => run.name === name)) ?? [];
  if (!list.length) {
    return {
      state: 'unchecked',
      why: (missing.length ? `missing required checks: ${missing.join(', ')}; ` : '') + 'no check run exists for this head — nothing has been asked about this commit, which is not the '
        + 'same as a check that is pending, and never satisfies a gate',
      counts,
    };
  }

  for (const r of list) {
    const status = String(r?.status ?? '').toLowerCase();
    const conclusion = String(r?.conclusion ?? '').toLowerCase();
    if (status !== 'completed') { counts.running += 1; continue; }
    if (NON_BLOCKING_CONCLUSIONS.includes(conclusion)) { counts.nonBlocking += 1; continue; }
    if (conclusion === 'success') { counts.succeeded += 1; continue; }
    if (FAILING_CONCLUSIONS.includes(conclusion)) { counts.failed += 1; continue; }
    // Completed, but the conclusion is empty or a value this table does not know. NOT a pass.
    counts.unreadable += 1;
  }

  if (counts.running) return { state: 'pending', why: `${counts.running} of ${counts.total} check(s) still running`, counts };
  if (counts.failed) return { state: 'red', why: `${counts.failed} of ${counts.total} check(s) concluded failing`, counts };
  if (missing.length) return { state: 'unchecked', why: `missing required checks: ${missing.join(', ')}`, counts };
  if (counts.unreadable) {
    return {
      state: 'unchecked',
      why: `${counts.unreadable} completed check(s) reported no readable conclusion — unreadable is not a pass`,
      counts,
    };
  }
  if (counts.succeeded) return { state: 'green', why: `all ${counts.succeeded} blocking check(s) succeeded`, counts };
  // Every run was skipped/neutral: something ran, but nothing was actually gated on.
  return {
    state: 'unchecked',
    why: `all ${counts.total} check(s) were skipped or neutral — no check actually gated this head`,
    counts,
  };
}

/**
 * Labels that CLAIM something about the checks, mapped to the states that claim is consistent with.
 *
 * DERIVED FROM THE LIVE DEFECT, not invented: `checking` beside zero check runs is precisely what both
 * stalled PRs displayed for twelve hours, and it is why the stall read as normal to everyone who looked. A
 * label is a claim, so a label whose claim its own checks contradict is a finding.
 *
 * `ready-to-merge` is the sharper half — it asserts the checks are DONE and green (#2199: it means "fully
 * checked, the drain may land", never "a local lint passed"). Carrying it over anything but `green` is the
 * dangerous direction, because the drain acts on it.
 */
export const LABEL_CLAIMS = Object.freeze({
  checking: Object.freeze(['pending', 'green', 'red']),
  'ready-to-merge': Object.freeze(['green']),
});

/**
 * Does this PR's label agree with what its checks actually say? PURE.
 *
 * Only labels in {@link LABEL_CLAIMS} are judged. A `review:*` label makes a claim about a REVIEW, not about
 * CI, and reporting it here would be this operation answering a question it does not own (#2644).
 *
 * @param {{labels: string[], state: string}} o
 * @returns {Array<{label: string, state: string, why: string}>}
 */
export function labelDisagreements({ labels = [], state } = {}) {
  const out = [];
  for (const label of Array.isArray(labels) ? labels : []) {
    const allowed = LABEL_CLAIMS[label];
    if (!allowed || allowed.includes(state)) continue;
    out.push({
      label,
      state,
      why: state === 'unchecked'
        ? `\`${label}\` claims something about checks that DO NOT EXIST for this head — this is the pair that `
          + 'makes a stalled PR look like a building one'
        : `\`${label}\` is only consistent with ${allowed.join('|')}, but the checks say \`${state}\``,
    });
  }
  return out;
}

/**
 * Shape the injected reader's result into the `read` finding, refusing a shape it cannot act on.
 *
 * REFUSES RATHER THAN REPORTING AN EMPTY LIST, the same call `verify.run` and `gate-health.history` make: a
 * broken reader and a repository with genuinely no open PRs otherwise produce the same "nothing to see"
 * verdict, and the first reads as the second. "No open PRs" is a real and useful answer; it must be one the
 * reader ASSERTED, not one a failure produced.
 *
 * `headSha` IS REQUIRED PER PR, because every outcome here is a claim about a specific commit. A PR whose
 * head the reader could not determine cannot be assessed at all, and guessing would produce exactly the
 * superseded-commit reading this operation exists to expose.
 */
export function shapeReadFinding(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.prs)) {
    throw new Error('pr-status.read: the injected reader must return `{ prs: [...] }` — an unreadable result is not "no open PRs"');
  }
  const prs = raw.prs.map((p, i) => {
    const number = Number(p?.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`pr-status.read: pr ${i} has no usable \`number\` — an unidentified PR cannot be reported on`);
    }
    const headSha = String(p?.headSha ?? '').trim();
    if (!headSha) {
      throw new Error(
        `pr-status.read: PR #${number} has no \`headSha\` — every state here is a claim about a specific `
        + 'commit, and a PR whose head is unknown cannot be assessed rather than assessed optimistically',
      );
    }
    return {
      number,
      headSha,
      title: String(p?.title ?? ''),
      labels: (Array.isArray(p?.labels) ? p.labels : []).map((l) => String(l)),
      mergeable: String(p?.mergeable ?? 'unknown'),
      checks: Array.isArray(p?.checks) ? p.checks : [],
    };
  });
  return { repo: String(raw.repo ?? ''), prs, truncated: raw.truncated === true };
}

/**
 * Reduce every PR to its state, and say plainly what a caller should look at. PURE.
 *
 * `blocking` ORDERS BY WHAT IS WORST-UNDERSTOOD FIRST, matching `verify.assess`: a PR nothing has checked
 * outranks one whose checks failed, because the failure is at least known and someone can act on it. A
 * silently unchecked PR is the one that costs twelve hours.
 */
export function assessPrs(finding) {
  const prs = finding.prs.map((pr) => {
    const check = reduceCheckState(pr.checks);
    return {
      ...pr,
      state: check.state,
      why: check.why,
      counts: check.counts,
      disagreements: labelDisagreements({ labels: pr.labels, state: check.state }),
    };
  });

  const by = (s) => prs.filter((p) => p.state === s);
  const unchecked = by('unchecked');
  const red = by('red');
  const disagreeing = prs.filter((p) => p.disagreements.length);

  return {
    repo: finding.repo,
    open: prs.length,
    green: by('green').length,
    pending: by('pending').length,
    red: red.length,
    unchecked: unchecked.length,
    prs,
    blocking: [
      ...unchecked.map((p) => ({ pr: p.number, why: 'unchecked', detail: `${p.headSha.slice(0, 8)} — ${p.why}` })),
      ...red.map((p) => ({ pr: p.number, why: 'red', detail: `${p.headSha.slice(0, 8)} — ${p.why}` })),
      ...disagreeing.map((p) => ({ pr: p.number, why: 'label-disagrees', detail: p.disagreements.map((d) => d.why).join('; ') })),
    ],
    // Stated rather than implied, for the same reason `verify` marks an empty suite: a repo with no open PRs
    // has told the caller something, and silence must not be mistaken for it.
    ...(prs.length === 0 ? { noOpenPrs: true } : {}),
    // AND THE SAME RULE APPLIED TO THIS OPERATION'S OWN LIMIT. A full listing may have been cut off, and a
    // report that quietly omits PR 201 is this operation committing the defect it exists to catch. `gh` does
    // not say whether more existed, so the honest answer is "I cannot tell", carried as a flag rather than
    // swallowed (PR #1521 juror).
    ...(finding.truncated ? { truncated: true } : {}),
  };
}

/**
 * Build the declaration. `readPrs` is injected — `./pr-status-io.mjs` supplies the real `gh` reader; tests
 * supply fixtures, which is what makes every branch above reachable with no network and no credential.
 */
export function prStatusOperation({ readPrs } = {}) {
  if (typeof readPrs !== 'function') {
    throw new TypeError('pr-status: needs a `readPrs()` reader — the io is injected so the declaration stays testable without gh');
  }

  return op(PR_STATUS_OP, {
    input: {
      repo: { type: 'string', required: true },
      // One PR, or every open one. REQUIRED to be explicit about which: defaulting to "all" would make a
      // caller asking about #1518 quietly pay for a repo-wide sweep.
      pr: { type: 'number', required: false, default: 0 },
    },
    verdictFrom: 'assess',

    read: compute({
      reads: ['input.repo', 'input.pr'],
      fn: (view) => shapeReadFinding(readPrs({ repo: view.input.repo, pr: view.input.pr })),
    }),

    assess: compute({
      reads: ['findings.read'],
      fn: (view) => assessPrs(view.findings.read),
    }),
  });
}
