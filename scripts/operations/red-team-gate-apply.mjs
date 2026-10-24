import { syncRedTeamStatusLabels } from '../lib/red-team-status-labels.mjs';
import { signalFixDispatch } from '../lib/fix-handoff.mjs';
/**
 * @file scripts/operations/red-team-gate-apply.mjs
 * @description THE IMPURE HALF of the red-team gate (card x1b8hlo). The pure half — the parser, the setting, the
 *   decision — is `we:scripts/lib/red-team-gate.mjs`; read its header first.
 *
 *   For one PR, on its live head or a proven numbering ancestor:
 *     1. read the PR (head, labels, comments) and find the trusted red-team comment for that exact head; a comment on
 *        another head is stale unless only drain numbering commits separate it from the live head;
 *     2. plan the actions under `redTeam.confirmedBreaks`;
 *     3. `send-back` findings: the PR goes to `review:changes` with those findings as the fix list, through the
 *        sanctioned writer (`review-set-label.mjs --to=changes`, which also writes the verdict-ledger row), plus a
 *        `send-back` ledger event. The writer CANNOT pin a head for `--to=changes` (it refuses `--expect-head`), so
 *        the gate re-reads the live head right before the write and refuses (`head-moved`) when it differs. That
 *        narrows the race, it does not close it: a push between that read and the label write can still bounce the
 *        new head (a head-pinned `--to=changes` in the writer is filed as its own card). BOUNDED by the review round
 *        cap: at round ≥ the cap, or when the round cannot be read, the gate does not send back; it records
 *        `round-cap` and the PR is the operator's;
 *     4. `card` findings: ONE follow-up card through the shared detached landing job (the same seam the review loop's
 *        round cards and prevention cards use — never `file-item` in this checkout, which is a daemon clone);
 *     5. ONE gate marker comment per ACTION per result records what was done (`sent-back` / `round-cap` after the
 *        send-back step, `card-queued` after the landing job was spawned) and names the result it decided
 *        (`result=`, `we:scripts/lib/red-team-gate.mjs#redTeamResultId`), so a later run never repeats a finished
 *        action, an action that FAILED stays retryable (`card-failed`), and the operator queue knows the state. A
 *        record that cannot be posted is a visible status (`send-back-record-failed` / `card-record-failed`, exit 1,
 *        error carried into the review-job summary), never a silent `applied`; the retry records without repeating. Two
 *        gate runs for one PR at once are not serialized here (review-job runs one review per PR at a time).
 *   It never accepts, never removes `review:human`, never edits a label by hand.
 *
 *   Called by `review-job.mjs` right after the red team ran (the review daemon owns the decision), and by its CLI:
 *     node scripts/operations/red-team-gate-apply.mjs --pr=<n> --repo=<owner/repo> [--dry-run]
 */
import { readSavedRedTeamGateResult } from '../lib/drain-saved-red-team.mjs';
import { readDrainRedTeamEvidence } from '../lib/drain-red-team-evidence.mjs';
import { readDrainQueueSafety, dequeueSentBack, sendBackReason } from '../lib/drain-queue-safety.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_OUTCOMES, gateRoundCap, gateRoundGrants, liveResultGateState, planRedTeamActions, readConfirmedBreaks, redTeamGateMarker, withholdUnpublishableFindings,
} from '../lib/red-team-gate.mjs';
import { cleanFindingFile, qualifyLocusRefs, sanitizeCardField } from '../lib/review-loop-policy.mjs';
import { IN_REPO_LOCUS } from '../lib/citation-check.mjs';
import { DEFAULT_ROUND_CAP } from '../lib/jury-core.mjs';
import { ACTOR_ENV } from '../lib/review-independence.mjs';
import { EVENT_TYPES, buildLedgerEvent } from '../lib/verdict-ledger.mjs';
import { spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';
import { readReviewRound, readReviewRoundAsOf } from './review-pr-io.mjs';
import { appendLedgerEvents } from './record-referral-ruling-io.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { publishAttention } from './needs-you-feed.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), '..', '..');
export const RED_TEAM_GATE_ACTOR = 'agent (red-team gate)';
export const RED_TEAM_GATE_CHANNEL = 'review daemon (redTeam.confirmedBreaks)';

const where = (f) => (f.file ? `\`${sanitizeCardField(f.file, 200)}${f.line ? `:${f.line}` : ''}\`` : '`(no file cited)`');
const findingLine = (f, i) => `${i + 1}. ${where(f)} — (${sanitizeCardField(f.category, 40)}, ${sanitizeCardField(f.impact ?? 'impact not stated', 40)}) `
  + `${sanitizeCardField(f.summary, 600)}${f.scenario ? `\n   - Scenario: ${sanitizeCardField(f.scenario, 1200)}` : ''}`
  + `${f.recheck ? `\n   - Claude's re-check: ${sanitizeCardField(f.recheck, 600)}` : ''}`;

const MAX_NUMBERING_HOPS = 5;
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const cardPath = value => typeof value === 'string' && /^backlog\/[^/]+\.md$/.test(value)
  && !/[\x00-\x1f\x7f\\]/.test(value);

/**
 * PURE: nearest-first candidate SHAs across at most five first-parent numbering commits.
 * Rows are complete GitHub commit responses. Unknown/incomplete evidence refuses the entire proof.
 * A non-numbering commit terminates the chain; its parents are never candidates.
 */
export function proveNumberingAncestors(head, commits) {
  if (!sha(head) || !Array.isArray(commits) || commits.length > MAX_NUMBERING_HOPS) return [];
  const ancestors = [];
  let current = head;
  for (const row of commits) {
    if (row?.sha !== current || typeof row?.commit?.message !== 'string') return [];
    if (!row.commit.message.split('\n')[0].startsWith('drain: JIT-number ')) break;
    // Refuse merges and possibly truncated API file lists (one page holds 100 files).
    if (!Array.isArray(row.parents) || row.parents.length !== 1 || !sha(row.parents[0]?.sha)
      || !Array.isArray(row.files) || !row.files.length || row.files.length >= 100) return [];
    if (!row.files.every(f => cardPath(f?.filename)
      && (f.previous_filename === undefined || cardPath(f.previous_filename)))) break;
    current = row.parents[0].sha;
    if (current === head || ancestors.includes(current)) return [];
    ancestors.push(current);
  }
  return ancestors;
}

/** The send-back write-up: the fix list. PURE. */
export function buildSendBackBody({ pr, head, viaAncestor, findings }) {
  return [
    `**Post-accept red team — ${findings.length} confirmed break(s) sent back to the fixer.**`,
    '',
    `Claude's re-check confirmed these on head \`${String(viaAncestor ?? head).slice(0, 12)}\` (#${pr}), and the setting \`redTeam.confirmedBreaks\` sends `
      + 'that class back (card x1b8hlo). Fix each one, then push; the new head is reviewed again.',
    ...(viaAncestor ? [`This result on \`${viaAncestor}\` applies to the renumbered live head \`${head}\`.`, ''] : []),
    '',
    ...findings.map(findingLine),
  ].join('\n');
}

/** The `file-item` input for ONE follow-up card carrying every carded finding. PURE. */
export function buildRedTeamCardInput({ repo, pr, head, findings }) {
  const files = [...new Set(findings.map(cleanFindingFile).filter(Boolean))];
  const digest = `Filed mechanically by the red-team gate: the post-accept red team on ${repo}#${pr} (reviewed head \`${head}\`) `
    + 'found these, Claude\'s re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up '
    + 'card instead of blocking the PR:\n\n' + findings.map(findingLine).join('\n');
  return {
    title: `Red-team follow-ups from ${repo}#${pr} (head ${String(head).slice(0, 9)})`,
    kind: 'story', size: '2',
    digest: qualifyLocusRefs(digest, files),
    scope: files.map((f) => `${IN_REPO_LOCUS}${f}`).join(','),
    parent: '', queue: 'true',
  };
}

/**
 * The argv (after the script path) the sender gives `review-set-label.mjs`. PURE, and exported so a test can feed the
 * EXACT argv to the writer's own parser: `--to=changes` refuses `--expect-head`, and a sender that added it returned
 * `send-back-failed` for every real break (review of PR #4762).
 */
export function buildSendBackArgv({ repo, pr, bodyPath, head }) {
  return [String(pr), `--repo=${repo}`, '--to=changes', `--body-file=${bodyPath}`, `--actor=${RED_TEAM_GATE_ACTOR}`, `--channel=${RED_TEAM_GATE_CHANNEL}`,
    ...(head ? [`--judged-head=${head}`] : [])];
}

/** The gate's own record for ONE action on the head. PURE. */
export function buildGateComment({ pr, head, outcome, plan, round, result = null, grantIds = null, cardResult = null, sendBackResult = null, cap = DEFAULT_ROUND_CAP }) {
  const lines = [redTeamGateMarker(pr, head, outcome, result, grantIds),`**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${String(head).slice(0, 12)}\`:`];
  if (plan.sendBack.length) {
    lines.push(outcome === GATE_OUTCOMES.ROUND_CAP
      ? `- ${plan.sendBack.length} confirmed break(s) NOT sent back: ${Number.isInteger(round) ? `review round ${round} has reached the round cap (${cap})` : 'the review round could not be read, which counts as the round cap'}. The operator rules on them (${plan.sendBack.map(f => `#${f.index}`).join(', ')}).`
      : `- ${plan.sendBack.length} confirmed break(s) sent back to the fixer (${plan.sendBack.map((f) => `#${f.index}`).join(', ')})${sendBackResult?.already ? ' — the PR was already under review:changes' : ''}.`);
  }
  if (plan.card.length) {
    const paused = cardResult?.step === 'paused' && cardResult?.skipped === true;
    lines.push(`- ${plan.card.length} finding(s) ${paused ? 'recorded, owed' : 'filed'} as a follow-up card (${plan.card.map((f) => `#${f.index}`).join(', ')})`
      + `${paused ? ' — filing paused; will file on resume' : cardResult?.ok ? ` — landing job ${sanitizeCardField(cardResult.session ?? cardResult.handle ?? '', 120)}` : ` — FILING FAILED: ${sanitizeCardField(cardResult?.error ?? 'unknown', 300)}`}.`);
  }
  if (plan.advisory.length) lines.push(`- ${plan.advisory.length} finding(s) left advisory (${plan.advisory.map((f) => `#${f.index}`).join(', ')}).`);
  return lines.join('\n');
}

/**
 * Apply the gate to one PR. Never throws: every failure is a status. `dryRun` writes nothing and says what it would do.
 * @param {{repo:string, pr:number, dryRun?:boolean, cap?:number}} o
 * @param {ReturnType<typeof createRedTeamGateIo>} io
 */
export async function applyRedTeamGate(input = {}, io = createRedTeamGateIo()) {
  const result = await applyRedTeamGateInner(input, io);
  if (!input.dryRun) {
    try { io.syncStatusLabels?.({ ...input, head: result.head }); }
    catch (e) { io.log?.(`red-team status labels: ${e.message}`); }
  }
  return result;
}

async function applyRedTeamGateInner({ repo, pr, dryRun = false, cap = DEFAULT_ROUND_CAP } = {}, io = createRedTeamGateIo()) {
  try {
    const view = io.readPr({ repo, pr });
    const head = String(view?.headRefOid ?? '').toLowerCase();
    // The verified standing-ruling scope, so an automatic grant counts here exactly as fix dispatch counts it (PR #5758).
    // An unreadable scope credits no automatic grant (fail closed); operator grants still count.
    let standingRuling = null;
    try { standingRuling = io.readGrantScope?.({ repo, pr, head, comments: view?.comments }) ?? null; } catch { standingRuling = null; }
    // The live head's latest result, and only the records that decide THAT result (an earlier same-head result's
    // records never dedup a newer one, PR #5482).
    let resultHead = head;
    const stateFor = resultHead => {
      const posted = liveResultGateState(view?.comments, pr, resultHead, repo, standingRuling);
      const saved = posted.result ? null : io.readSavedResult?.({ repo, pr, head: resultHead });
      return { state: saved ? liveResultGateState(view?.comments, pr, resultHead, repo, standingRuling, saved) : posted,
        saved: Boolean(saved) };
    };
    let { state, saved } = stateFor(head);
    if (!state.result) {
      let ancestors = [];
      try { ancestors = await io.numberingAncestors?.({ repo, pr, head }) ?? []; } catch { /* no proof */ }
      if (!Array.isArray(ancestors) || ancestors.length > MAX_NUMBERING_HOPS || !ancestors.every(sha)) ancestors = [];
      for (const ancestor of ancestors) {
        const candidate = stateFor(ancestor);
        if (candidate.state.result) { state = candidate.state; saved = candidate.saved; resultHead = ancestor; break; }
      }
    }
    const ancestry = resultHead === head ? {} : { viaAncestor: resultHead };
    const { result, resultId, headReviewIndex, outcomes: recorded, sendBackOutcome, reopened } = state;
    if (!result) return { status: 'no-red-team-on-head', head };
    // Keep the raw result id for dedup, but never publish scrub-failing saved fields or compositions.
    const parsed = saved ? { ...result, findings: withholdUnpublishableFindings(result.findings, [
      buildSendBackBody({ pr, head, ...ancestry, findings: result.findings }),
      ...Object.values(buildRedTeamCardInput({ repo, pr, head: resultHead, findings: result.findings })),
    ]) } : result;
    const setting = io.readSetting();
    const plan = planRedTeamActions(parsed, setting.value);
    if (!plan.sendBack.length && !plan.card.length) return { status: 'advisory-only', head, ...ancestry, plan };
    // One record per ACTION (see the header): what is already recorded for this result is not repeated, what is not stays pending.
    const priorSend = sendBackOutcome;
    // A `round-cap` record is re-decided once for a grant its decision did not see (extend-rounds), including one
    // posted during the cap POST. The re-decision snapshots its grants so the same grant cannot reopen it twice.
    const sendPending = plan.sendBack.length > 0 && (!priorSend || reopened);
    const cardPending = plan.card.length > 0 && !recorded.has(GATE_OUTCOMES.CARD_QUEUED);
    if (!dryRun && priorSend === GATE_OUTCOMES.SENT_BACK && sendBackReason(view.labels)) io.dequeueSentBack({ repo, pr, reason: 'post-accept red team sent back to review:changes' });
    if (!sendPending && !cardPending) return { status: 'already-acted', head, ...ancestry, outcome: priorSend ?? GATE_OUTCOMES.CARD_QUEUED, plan };
    const round = sendPending ? io.readRound({ repo, pr, head: resultHead }) : null;
    // The operator's audited grants raise the cap with the same grant-time anchor fix dispatch uses. The anchor counts
    // this head like `readRound` does when the thread shows its review before the grant (thread order, not clocks).
    const grants = sendPending ? gateRoundGrants(view?.comments, pr, repo, standingRuling) : [];
    const effectiveCap = gateRoundCap({ cap, grants, roundAt: (at, g) => {
      const reviewed = Number.isInteger(headReviewIndex) && Number.isInteger(g?.index) && headReviewIndex < g.index;
      try { return io.readRoundAsOf?.({ repo, pr, at, head: reviewed ? resultHead : null }) ?? null; } catch { return null; }
    } });
    // The round is the only bound on send-backs, so an unreadable one is the cap (the operator rules), never "round 1".
    const capped = sendPending && (!Number.isInteger(round) || round >= effectiveCap);
    const outcome = !plan.sendBack.length ? GATE_OUTCOMES.NOTHING_TO_SEND
      : !sendPending ? priorSend : capped ? GATE_OUTCOMES.ROUND_CAP : GATE_OUTCOMES.SENT_BACK;
    const labels = (view.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
    const sendBody = sendPending && !capped ? buildSendBackBody({ pr, head, ...ancestry, findings: plan.sendBack }) : null;
    const cardInput = cardPending ? buildRedTeamCardInput({ repo, pr, head: resultHead, findings: plan.card }) : null;
    if (dryRun) {
      return { status: 'dry-run', head, ...ancestry, round, cap: sendPending ? effectiveCap : null, reopened, outcome, plan, wouldSendBack: sendPending && outcome === GATE_OUTCOMES.SENT_BACK, sendBody, cardInput, setting };
    }
    let sendBackResult = null;
    let marker = null;
    const record = (recordOutcome, recordPlan, extra = {}) => {
      try { io.postComment({ repo, pr, body: buildGateComment({ pr, head: resultHead, outcome: recordOutcome, plan: recordPlan, round, result: resultId,
        grantIds: recordOutcome === GATE_OUTCOMES.ROUND_CAP || recordOutcome === GATE_OUTCOMES.SENT_BACK ? grants.map(g => g.id) : null,
        cap: effectiveCap, ...extra }) }); return 'posted'; }
      catch (e) { return `error: ${String(e?.message ?? e).slice(0, 200)}`; }
    };
    if (sendPending) {
      if (outcome === GATE_OUTCOMES.SENT_BACK) {
        if (labels.includes('review:changes')) {
          sendBackResult = { ok: true, already: true };
          io.signalFix?.({ repo, pr, label: 'review:changes' });
        }
        else {
          // The writer cannot pin a head for `--to=changes`: re-read it right before the write (see the header).
          const live = String(io.readHead({ repo, pr }) ?? '').toLowerCase();
          if (live !== head) return { status: 'head-moved', head, ...ancestry, liveHead: live, plan };
          sendBackResult = io.sendBack({ repo, pr, head, body: sendBody });
          if (!sendBackResult?.ok) return { status: 'send-back-failed', head, ...ancestry, round, plan, error: sendBackResult?.error ?? 'unknown' };
          try { await io.appendSendBackEvent({ repo, pr, head }); } catch (e) { io.log(`red-team gate: send-back of #${pr} applied but the ledger event missed: ${e.message}`); }
        }
      }
      if (outcome === GATE_OUTCOMES.SENT_BACK) io.dequeueSentBack({ repo, pr, reason: 'post-accept red team sent back to review:changes' });
      marker = record(outcome, { ...plan, card: [] }, { sendBackResult });
      if (marker === 'posted' && outcome === GATE_OUTCOMES.ROUND_CAP) {
        try {
          await io.publishNeedsYou?.({ pr, repo, head, kind: 'at-round-limit', outcome, result: resultId,
            reason: `outcome=round-cap: ${plan.sendBack.length} unsent confirmed break(s); result=${resultId}`, title: '' });
        } catch (e) { io.log?.(`red-team gate: needs-you publication failed for #${pr}: ${e.message}`); }
      }
      // The label is written but its record is not: without it the operator queue never learns the fixer owns the break.
      // Retry-safe: the next run sees review:changes, takes the `already` path (no second label write) and records.
      if (marker !== 'posted') return { status: 'send-back-record-failed', head, ...ancestry, round, outcome, plan, sendBack: sendBackResult, marker, error: marker };
    }
    let cardResult = null;
    let cardMarker = null;
    if (cardPending) {
      cardResult = io.fileCard(cardInput);
      // A card that was not filed records nothing: a permanent per-head record here would make the failure unretryable.
      if (!cardResult?.ok && !(cardResult?.step === 'paused' && cardResult?.skipped === true)) return { status: 'card-failed', head, ...ancestry, round, outcome, plan, sendBack: sendBackResult, card: cardResult, marker, error: cardResult?.error ?? 'unknown' };
      cardMarker = record(GATE_OUTCOMES.CARD_QUEUED, { sendBack: [], card: plan.card, advisory: sendPending ? [] : plan.advisory }, { cardResult });
      // The job is spawned but its record is not on the PR: the next run would queue a DUPLICATE card. Say so, loudly.
      if (cardMarker !== 'posted') return { status: 'card-record-failed', head, ...ancestry, round, outcome, plan, sendBack: sendBackResult, card: cardResult, marker, cardMarker, error: cardMarker };
    }
    return { status: 'applied', head, ...ancestry, round, outcome, plan, sendBack: sendBackResult, card: cardResult, marker, cardMarker };
  } catch (e) {
    return { status: 'error', reason: String(e?.message ?? e).slice(0, 500) };
  }
}

/** Statuses the CLI reports with a nonzero exit: every failure, including a record that could not be posted. */
export const GATE_FAILURE_STATUSES = Object.freeze(['error', 'send-back-failed', 'send-back-record-failed', 'card-failed', 'card-record-failed']);

/** The CLI exit code for a gate result: 1 on any failure status, else 0. PURE. */
export const gateExitCode = (r) => (GATE_FAILURE_STATUSES.includes(r?.status) ? 1 : 0);

/** One-line summary for a job log. PURE. */
export function renderGateSummary(r) {
  const p = r?.plan;
  const counts = p ? ` (send-back ${p.sendBack.length}, card ${p.card.length}, advisory ${p.advisory.length})` : '';
  return `red-team gate: ${r?.status ?? 'none'}${r?.outcome ? ` → ${r.outcome}` : ''}${counts}${r?.viaAncestor ? ` — result ${r.viaAncestor} applies to renumbered live head ${r.head}` : ''}${r?.reason || r?.error ? ` — ${r.reason ?? r.error}` : ''}`;
}

export function createRedTeamGateIo({ env = process.env, root = REPO_ROOT, readCommit = null,
  readEvidence = readDrainRedTeamEvidence, syncLabels = syncRedTeamStatusLabels,
  log = line => process.stderr.write(`${line}\n`) } = {}) {
  const gh = (args, input) => {
    const r = spawnSync('gh', args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 300)}`);
    return String(r.stdout ?? '');
  };
  const safety = readDrainQueueSafety({ env, log: line => process.stderr.write(`${line}\n`) });
  return {
    publishNeedsYou: isUnderTest(env) || isUnderTest(process.env) ? () => {} : item => publishAttention(item),
    syncStatusLabels: ({ repo, pr, head }) => head ? syncLabels({ repo, pr, head, env,
      evidence: readEvidence({ repo, pr, head, env }),
      log: line => process.stderr.write(`${line}\n`) }) : null,
    signalFix: signalFixDispatch,
    dequeueSentBack: args => safety.value.dequeueOnSendBack ? dequeueSentBack({ ...args, exec: (cmd, argv, opts) => execFileSync(cmd, argv, { ...opts, env }), log: line => process.stderr.write(`${line}\n`) }) : { dequeued: false },
    // The COMPLETE thread (paginated): a one-page read could miss the red-team comment or the gate's own record.
    readPr: ({ repo, pr }) => ({
      ...JSON.parse(gh(['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid,labels'])),
      comments: readCompletePrComments(Number(pr), { repo }),
    }),
    numberingAncestors: ({ repo, head }) => {
      try {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !sha(head)) return [];
        const commits = [];
        let current = head;
        // At most five calls, each with a complete, bounded file list. No local clone is owned here.
        for (let hop = 0; hop < MAX_NUMBERING_HOPS; hop++) {
          const row = readCommit ? readCommit({ repo, head: current }) : JSON.parse(runGhSync(
            ['api', `repos/${repo}/commits/${current}?per_page=100&page=1`],
            { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
          ));
          // A full page might omit files. Refuse rather than trust an incomplete proof.
          if (Array.isArray(row?.files) && row.files.length >= 100) {
            log('red-team gate: numbering proof file limit reached; request a fresh live-head review.');
            return [];
          }
          commits.push(row);
          const ancestors = proveNumberingAncestors(head, commits);
          if (ancestors.length !== commits.length) return ancestors;
          current = ancestors.at(-1);
        }
        log('red-team gate: numbering ancestry limited to five hops; older results require a fresh live-head review.');
        return proveNumberingAncestors(head, commits);
      } catch { return []; }
    },
    // Fresh per run on the App identity: a closed or edited ruling stops crediting automatic grants at the next run.
    readGrantScope: ({ repo, pr, head, comments }) => standingRulingScope({ repo, pr: { number: Number(pr), headRefOid: head, comments } }),
    readSetting: () => readConfirmedBreaks({ env }),
    readSavedResult: args => readSavedRedTeamGateResult({ ...args, env }),
    readRound: ({ repo, pr, head }) => readReviewRound({ repo, pr, head }),
    readRoundAsOf: ({ repo, pr, at, head }) => readReviewRoundAsOf({ repo, pr, at, head }),
    // The live head, read fresh and alone (the PR view above can be minutes old by the time a slow step finishes).
    readHead: ({ repo, pr }) => String(JSON.parse(gh(['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid'])).headRefOid ?? ''),
    sendBack: ({ repo, pr, head, body }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-gate-'));
      try {
        const path = join(dir, 'body.md');
        writeFileSync(path, body, 'utf8');
        const r = spawnSync(process.execPath, [join(root, 'scripts', 'review-set-label.mjs'), ...buildSendBackArgv({ repo, pr, head, bodyPath: path })],
          { cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...env, [ACTOR_ENV]: `red-team-gate-${randomUUID()}` } });
        if (r.status === 0) return { ok: true };
        return { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop() };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    appendSendBackEvent: ({ repo, pr }) => appendLedgerEvents([buildLedgerEvent({
      type: EVENT_TYPES.SEND_BACK, repo, pr, at: new Date().toISOString(), source: 'red-team-gate',
      declaredActor: RED_TEAM_GATE_ACTOR, channel: RED_TEAM_GATE_CHANNEL, cause: 'changes',
    })]),
    fileCard: (input) => spawnPreventionLandingJob(input, { sessionPrefix: 'red-team-card' }),
    postComment: ({ repo, pr, body }) => gh(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'], body),
    log,
  };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) ?? '').slice(n.length + 3) || undefined;
  if (!flag('pr') || !flag('repo')) {
    process.stderr.write('usage: red-team-gate-apply.mjs --pr=<n> --repo=<owner/repo> [--dry-run]\n');
    process.exitCode = 2;
  } else {
    applyRedTeamGate({ repo: flag('repo'), pr: Number(flag('pr')), dryRun: argv.includes('--dry-run') }).then((r) => {
      process.stderr.write(`${renderGateSummary(r)}\n`);
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exitCode = gateExitCode(r);
    });
  }
}
