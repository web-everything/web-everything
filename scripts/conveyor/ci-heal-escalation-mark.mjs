/**
 * ci-heal-escalation-mark.mjs — post the durable ESCALATION comment a ci-heal (or fix) agent leaves when it
 * stops instead of guessing (we:backlog/heal-wait-for-rerun, landing-freeze fix, 2026-09-27). This is the
 * escalation-half sibling of `ci-heal-mark.mjs` (#2666) and `stand-down.mjs` (#3296): NEITHER of those covers
 * this population. `ci-heal-mark.mjs` only ever fires on a COMPLETED heal (a re-push happened); `stand-down.mjs`
 * is `fix`-only and PERMANENTLY terminal (no decay, no re-arm — a human must clear the marker by hand). A
 * ci-heal escalation needs a THIRD shape: terminal for THIS HEAD only, auto-re-arming the instant a new push
 * changes it — the same head reaching the SAME dead end on a re-dispatch is pure waste, but a fixed head
 * deserves a fresh look.
 *
 * LIVE INCIDENT this closes, web-everything/web-everything#2783: three separate ci-heal sessions dispatched across
 * one evening, each ending "escalated (needs human — not a CI break)" for the identical reason on the
 * identical head — because the brief's escalation exit wrote NOTHING durable (a bare one-line RETURN to the
 * calling session, never a PR comment), so every reconcile tick that followed re-read the PR as plain `ci-red`
 * with nothing live working it and dispatched a FOURTH heal to re-ask the same already-answered question. Each
 * one a wasted Opus/Sonnet session.
 *
 * THE HEAD-SCOPED KEY IS THE WHOLE POINT. Unlike `ci-heal-mark.mjs`'s attempt count (which only ever grows) and
 * `stand-down.mjs`'s marker (which only a human ever clears), this marker carries the `headRefOid` it was
 * posted against, and {@link latestCiHealEscalationForHead} only ever matches THAT exact head. A mechanical
 * rebase or a fresh push moves the head, the old escalation comment stops matching, and the very next
 * reconcile tick plans a heal again — no human intervention required, no stale record to clean up.
 *
 * OUTCOME IS THREE-VALUED (we:backlog/heal-wait-for-rerun, Fork 2; `not-a-ci-break` added we:backlog/
 * fix-review-ciheal-deadlock, LIVE DEADLOCK 2026-09-28/29, PR #2878 web-everything/web-everything):
 *   · `needs-human` — a genuine judgment call the agent could not safely make (the diff itself looks wrong, a
 *     real conflict, the lane ref is gone).
 *   · `waiting-on-system-fix` — the red is caused by the TOOLING/GATE ITSELF (an advisory check misbehaving, a
 *     false-red bug in the pipeline) and a system-level fix for it is ALREADY OPEN (e.g. #2784 for the
 *     soak-replay-gate false red) — this PR did nothing wrong and owes NOTHING further until that fix lands or
 *     its own head changes, so it must never be miscounted as "the operator must judge this" the way a real
 *     `needs-human` is.
 *   · `not-a-ci-break` — every required check is green on this exact head; the ONLY red is a review-gate-shaped
 *     check reflecting an un-cleared review hold (`review:pending`/`review:human`/`review:changes`) — by
 *     design, not a defect. This PR did nothing wrong EITHER, but unlike `waiting-on-system-fix` there is no
 *     system fix to wait on: it is owed its ORDINARY REVIEW, right now. LIVE DEADLOCK this closes: PR #2878 got
 *     this exact finding written as prose under `needs-human` ("not a CI break — the only red check is
 *     review-gate…") — `we:scripts/conveyor/reconcile-core.mjs#planReconcile`'s escalation refusal reads
 *     `needs-human` as a terminal, review-blocking dead end (the correct behaviour for a REAL `needs-human`), so
 *     the review daemon stood down every tick, and ci-heal (correctly) refused to re-heal a PR with nothing
 *     left to heal — a deadlock neither side could see, because the reason lived only in unstructured prose
 *     neither side parsed. A `not-a-ci-break` escalation reads instead as "dispatch the review this PR was
 *     always owed, in parallel with refusing another heal" (see that function's own header for the exact fold).
 *
 * NO PARALLEL STATE STORE (#2612 invariant, matching every sibling marker in this directory): the record lives
 * on the PR's own comment thread, read back by {@link latestCiHealEscalationForHead}, exactly as
 * `countCiHealComments` / `countStandDownComments` already work. The one local file this CLI may write — a
 * `ci-heal-owed.mjs` record when a GitHub budget block refuses the post (#4352) — is a pending-write note, never
 * read by any decision: it only makes sure the PR-thread record eventually exists.
 */
import { resolve } from 'node:path';
import { collectCiAuthDiagnosis, renderCiAuthDiagnosis } from './ci-auth-diagnosis.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { isBudgetRefusal, postPrComment, recordOwedWrite, resolveOwedRepo } from './ci-heal-owed.mjs';

/**
 * we:scripts/conveyor/ci-heal-escalation-mark.mjs#CI_HEAL_ESCALATION_MARKER — the stable FIRST LINE of the
 * durable escalation comment. Single-sourced; treat it as fixed — changing it orphans every open PR's existing
 * escalation record, and each would read as never-escalated again, re-opening the exact re-dispatch loop this
 * file exists to close.
 */
export const CI_HEAL_ESCALATION_MARKER = '🚦 conveyor CI-heal — escalated';

/** The three outcomes a ci-heal escalation can carry — see the file header for what distinguishes them. */
export const CI_HEAL_ESCALATION_OUTCOMES = Object.freeze(['needs-human', 'waiting-on-system-fix', 'not-a-ci-break']);

/**
 * we:scripts/conveyor/ci-heal-escalation-mark.mjs#buildCiHealEscalationComment — the durable comment body a
 * ci-heal escalation posts. Its FIRST line MUST be {@link CI_HEAL_ESCALATION_MARKER}; every field after it is a
 * `key: value` line so {@link parseCiHealEscalations} can read it back with no ambiguity. Pure.
 * @param {{headSha:string, outcome:'needs-human'|'waiting-on-system-fix'|'not-a-ci-break', reason?:string, systemFixRef?:(number|string|null), authDiagnosis?:object}} o
 * @returns {string}
 */
export function buildCiHealEscalationComment({ headSha, outcome, reason = '', systemFixRef = null, authDiagnosis = null } = {}) {
  if (!headSha || typeof headSha !== 'string') throw new TypeError('ci-heal-escalation-mark: headSha is required');
  if (!CI_HEAL_ESCALATION_OUTCOMES.includes(outcome)) {
    throw new TypeError(`ci-heal-escalation-mark: outcome must be one of ${CI_HEAL_ESCALATION_OUTCOMES.join('|')}, got ${JSON.stringify(outcome)}`);
  }
  const lines = [
    CI_HEAL_ESCALATION_MARKER,
    '',
    `outcome: ${outcome}`,
    `head: ${headSha.trim().toLowerCase()}`,
  ];
  if (outcome === 'waiting-on-system-fix') {
    if (!systemFixRef) throw new TypeError('ci-heal-escalation-mark: waiting-on-system-fix requires systemFixRef');
    lines.push(`system-fix: #${String(systemFixRef).replace(/^#/, '')}`);
  }
  if (reason) lines.push(`reason: ${reason}`);
  lines.push('');
  lines.push(
    outcome === 'waiting-on-system-fix'
      ? 'This required check is red because of the tooling/gate itself, not this PR\'s own code — a system-level ' +
        'fix is already open for it. Nothing further is owed here until that fix lands or this PR\'s own head ' +
        'changes; re-dispatching a heal against this exact head would only repeat the same finding.'
      : outcome === 'not-a-ci-break'
        ? 'Every required check is green on this exact head — the only red is the review gate itself, held by ' +
          'the review label (this is BY DESIGN, not a defect). This PR did nothing wrong and owes NO further ' +
          'ci-heal; it is owed its ordinary review, dispatched normally alongside this escalation.'
        : 'A ci-heal agent stopped here rather than guess — this needs a human judgment call, not another repair ' +
          'attempt. A person clears this by pushing a new commit (which re-arms auto-heal) or taking the PR over.',
  );
  if (authDiagnosis) lines.push('', renderCiAuthDiagnosis(authDiagnosis));
  return lines.join('\n');
}

/**
 * we:scripts/conveyor/ci-heal-escalation-mark.mjs#parseCiHealEscalations — every trusted escalation comment on
 * a PR, normalized to `{ headSha, outcome, reason, systemFixRef, createdAt }`, in the order `comments` was
 * given. Pure, and the ONE place the leading-line + field-parsing rule is written. A comment matches only when
 * the marker is its LEADING line (mirrors every sibling marker in this directory) AND {@link
 * isTrustedMarkerAuthor} — WE's PRs are public, so an untrusted login must never be able to forge "already
 * escalated" onto a PR and suppress its own real ci-heal.
 * @param {Array<{body?:string, createdAt?:string}|string>|null|undefined} comments
 * @returns {Array<{headSha:string, outcome:string, reason:string, systemFixRef:(string|null), createdAt:(string|null)}>}
 */
export function parseCiHealEscalations(comments) {
  if (!Array.isArray(comments)) return [];
  const out = [];
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !body.trimStart().startsWith(CI_HEAL_ESCALATION_MARKER)) continue;
    if (!isTrustedMarkerAuthor(c)) continue;
    const outcome = (/^outcome:\s*(\S+)/m.exec(body) || [])[1] ?? null;
    const headSha = (/^head:\s*(\S+)/m.exec(body) || [])[1] ?? null;
    const systemFixRef = (/^system-fix:\s*#?(\d+)/m.exec(body) || [])[1] ?? null;
    const reason = (/^reason:\s*(.+)$/m.exec(body) || [])[1] ?? '';
    if (!outcome || !headSha) continue; // malformed/foreign — never half-parse a marker into a false match
    out.push({
      headSha: headSha.toLowerCase(), outcome, reason, systemFixRef,
      createdAt: typeof c === 'object' && c ? (c.createdAt ?? null) : null,
    });
  }
  return out;
}

// The old acquire-null branch asserted absence without checking origin. These exact legacy
// records are not evidence of a human decision; retry through the corrected verifier.
export function isUnverifiedLaneEscalation(e) {
  return e?.outcome === 'needs-human' && /^lane ref gone — .+ no longer resolves$/.test(e.reason);
}

/**
 * we:scripts/conveyor/ci-heal-escalation-mark.mjs#latestCiHealEscalationForHead — is THIS EXACT head already
 * escalated? Pure. The head-scoping is what makes this auto-re-arm: a new push changes `pr.headRefOid`, no
 * escalation comment carries THAT sha yet, and this returns `null` — the very next tick plans a fresh heal.
 * When more than one escalation matches (a re-dispatch loop that ran before this fix existed, or a repeat
 * escalation on a since-abandoned rebase-then-revert), the LAST one in `comments` order wins — the most recent
 * word on this exact head.
 * @param {Array<object>|null|undefined} comments
 * @param {string|null|undefined} headSha
 * @returns {{headSha:string, outcome:string, reason:string, systemFixRef:(string|null), createdAt:(string|null)}|null}
 */
export function latestCiHealEscalationForHead(comments, headSha) {
  const sha = typeof headSha === 'string' ? headSha.trim().toLowerCase() : '';
  if (!sha) return null;
  const matches = parseCiHealEscalations(comments).filter((e) => e.headSha === sha && !isUnverifiedLaneEscalation(e));
  return matches.length ? matches[matches.length - 1] : null;
}

/** Recorded attribution is evidence only, never permission to ignore a required check.
 * Legacy #3239 records the check and card-only diagnosis in prose. Match that narrow
 * shape; arbitrary needs-human reasons (including conflicts) remain terminal.
 * A successful refresh supersedes this through the existing head-scoped mechanism.
 */
export function mainBreakEscalationForHead(comments, headSha, failingCheckName) {
  const escalation = latestCiHealEscalationForHead(comments, headSha);
  if (!escalation || !failingCheckName || escalation.outcome !== 'needs-human') return null;
  // #3241 records the main reproduction directly, rather than naming a shard.
  // Only the test aggregate is attributed by this legacy test-file diagnosis.
  if (failingCheckName === 'test' && /^red is main's own break: \S+\.test\.[cm]?[jt]s .+ fails on main [0-9a-f]{7,40} too; PR only edits one backlog card, already up to date with main$/.test(escalation.reason)) return escalation;
  const recordedCheck = /^required (.+?) red on unrelated /.exec(escalation.reason)?.[1];
  // CI's required `test` aggregate includes the matrix shards; the legacy reason
  // spells `test-shard 4`, while GitHub calls the job `test-shard (4)`.
  const shard = /^test-shard (\d+)$/.exec(recordedCheck || '')?.[1];
  if (recordedCheck !== failingCheckName &&
      !(shard && (failingCheckName === 'test' || failingCheckName === `test-shard (${shard})`))) return null;
  if (!/; PR diff is (?:one backlog card|backlog-only|card-only); reproduces after rebase onto main(?:;|$)/.test(escalation.reason)) return null;
  return escalation;
}

/**
 * we:scripts/conveyor/ci-heal-escalation-mark.mjs#postOrOweCiHealEscalation — post the escalation comment; on a
 * BUDGET refusal, record it owed for `ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch`'s next-tick flush
 * instead of dropping it (#4352). The escalation already carries its head (`--head` is required), so the owed
 * record's dedupe key is exactly what {@link latestCiHealEscalationForHead} matches on. Any non-budget failure,
 * or a repo outside the constellation, still throws.
 * @returns {{commented:true}|{commented:false, owed:object}}
 */
export function postOrOweCiHealEscalation({ pr, body, headSha, repo, post = postPrComment, owe = recordOwedWrite }) {
  try {
    post({ pr, repo: repo?.slug, body });
    return { commented: true };
  } catch (e) {
    if (!isBudgetRefusal(e) || !headSha || !repo) throw e;
    const owed = owe({ repo: repo.key, slug: repo.slug, pr, kind: 'ci-heal-escalation', headSha, body });
    return { commented: false, owed };
  }
}

/** Shared CLI composition seam: enrichment failure must never suppress an escalation. */
export function composeCiHealEscalation(flags, { collect = collectCiAuthDiagnosis } = {}) {
  const original = { headSha: flags.head, outcome: flags.outcome,
    reason: typeof flags.reason === 'string' ? flags.reason : '', systemFixRef: flags['system-fix'] ?? null };
  const body = buildCiHealEscalationComment(original);
  if (flags.run === undefined && flags.attempt === undefined) return body;
  try {
    const authDiagnosis = collect({ repo: flags.repo, runId: flags.run, attempt: flags.attempt, headSha: flags.head });
    if (!authDiagnosis || typeof authDiagnosis !== 'object') throw new TypeError('invalid diagnostic');
    return buildCiHealEscalationComment({ ...original, authDiagnosis });
  } catch {
    return buildCiHealEscalationComment({ ...original,
      authDiagnosis: { status: 'unavailable', detail: 'CI authentication enrichment unavailable.' } });
  }
}

// ── IO SHELL (runs only as a CLI — the pure exports above stay side-effect-free on import) ────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positionals.push(a);
  }
  const fail = (m) => {
    process.stderr.write(`✗ ${m}\n`);
    process.exit(1);
  };
  const pr = Number(positionals[0]);
  if (!Number.isInteger(pr) || pr <= 0) {
    fail('usage: ci-heal-escalation-mark.mjs <pr> --head=<sha> --outcome=needs-human|waiting-on-system-fix|not-a-ci-break '
      + '[--reason="<text>"] [--system-fix=<n>] [--repo=<owner/name>] [--run=<id> --attempt=<n>]');
  }
  if (typeof flags.head !== 'string' || !flags.head) fail('--head=<sha> is required');
  let body;
  try {
    body = composeCiHealEscalation(flags);
  } catch (e) {
    fail(String(e.message || e));
  }
  const repo = typeof flags.repo === 'string' ? flags.repo : undefined;
  let posted;
  try {
    posted = postOrOweCiHealEscalation({
      pr, body, headSha: flags.head, repo: resolveOwedRepo({ repoFlag: repo }),
      post: ({ pr: n, body: b }) => postPrComment({ pr: n, repo, body: b }),
    });
  } catch (e) {
    fail(`could not post CI-heal escalation comment on PR #${pr}: ${String(e.message || e).split('\n')[0]}`);
  }
  if (!posted.commented) {
    process.stderr.write(`⚠ CI-heal escalation on PR #${pr} refused by the GitHub budget — recorded owed (head ${flags.head}); the next ci-heal-pr-dispatch tick posts it\n`);
  }
  // Replace a stale `review-status:fixing`/`review-status:fix-stalled` label IMMEDIATELY — this session is about
  // to exit, and waiting for the next scheduled `review-status-tag.mjs` tick (still driven by a LIVE-agent read
  // that, this instant, still sees this very process as "working") would leave the PR reading "still being
  // fixed" for however long that tick is away. See the file header's "clear/replace the fixing label as soon as
  // the session reports any terminal outcome" requirement.
  try {
    // Dynamic import breaks the review-status-tag → reconcile-core cycle (coroner #36).
    const { applyReviewStatus } = await import('./review-status-tag.mjs');
    const provider = createGhProvider();
    // No `--repo` given (a repo-less invocation, `gh` inferring from cwd elsewhere in this script) — resolve
    // the SAME way, via `gh repo view`, never a hardcoded constellation repo (this file, like every other
    // conveyor primitive, is not WE-only).
    const targetRepo = repo || provider.currentRepo();
    const current = provider.readLabels(targetRepo, pr);
    applyReviewStatus({ pr, repo: targetRepo, state: flags.outcome === 'needs-human' ? 'needs-human' : null, provider, currentLabels: current });
  } catch {
    // Cosmetic only (review-status-tag.mjs's own docblock: "nothing reads this label back to decide anything") —
    // a failed clear here is never worth failing the escalation itself over; the next scheduled tick still
    // self-corrects it once this process is gone.
  }
  process.stdout.write(JSON.stringify({ ok: true, pr, escalated: true, ...(posted.owed ? { owed: true } : {}), outcome: flags.outcome }) + '\n');
}
