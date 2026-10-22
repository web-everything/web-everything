import { syncRedTeamStatusLabels } from '../lib/red-team-status-labels.mjs';
import { signalFixDispatch } from '../lib/fix-handoff.mjs';
/**
 * @file scripts/operations/red-team-gate-apply.mjs
 * @description THE IMPURE HALF of the red-team gate (card x1b8hlo). The pure half — the parser, the setting, the
 *   decision — is `we:scripts/lib/red-team-gate.mjs`; read its header first.
 *
 *   For one PR, on its LIVE head only:
 *     1. read the PR (head, labels, comments) and find the trusted red-team comment for that exact head; a comment on
 *        another head is stale and ignored;
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
import { readDrainQueueSafety, dequeueSentBack, sendBackReason } from '../lib/drain-queue-safety.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_OUTCOMES, gateRoundCap, gateRoundGrants, liveResultGateState, planRedTeamActions, readConfirmedBreaks, redTeamGateMarker, ruledEarlierBreaks,
} from '../lib/red-team-gate.mjs';
import { citedLinesFingerprint, formatRedTeamTimingLine, readRedTeamTiming, suppressPreviouslyRuled } from '../lib/red-team-timing.mjs';
import { cleanFindingFile, qualifyLocusRefs, sanitizeCardField } from '../lib/review-loop-policy.mjs';
import { IN_REPO_LOCUS } from '../lib/citation-check.mjs';
import { DEFAULT_ROUND_CAP } from '../lib/jury-core.mjs';
import { ACTOR_ENV } from '../lib/review-independence.mjs';
import { EVENT_TYPES, buildLedgerEvent } from '../lib/verdict-ledger.mjs';
import { spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';
import { readReviewRound, readReviewRoundAsOf } from './review-pr-io.mjs';
import { appendLedgerEvents } from './record-referral-ruling-io.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), '..', '..');
export const RED_TEAM_GATE_ACTOR = 'agent (red-team gate)';
export const RED_TEAM_GATE_CHANNEL = 'review daemon (redTeam.confirmedBreaks)';

const where = (f) => (f.file ? `\`${sanitizeCardField(f.file, 200)}${f.line ? `:${f.line}` : ''}\`` : '`(no file cited)`');
const findingLine = (f, i) => `${i + 1}. ${where(f)} — (${sanitizeCardField(f.category, 40)}, ${sanitizeCardField(f.impact ?? 'impact not stated', 40)}) `
  + `${sanitizeCardField(f.summary, 600)}${f.scenario ? `\n   - Scenario: ${sanitizeCardField(f.scenario, 1200)}` : ''}`
  + `${f.recheck ? `\n   - Claude's re-check: ${sanitizeCardField(f.recheck, 600)}` : ''}`;

/** The send-back write-up: the fix list. PURE. */
export function buildSendBackBody({ pr, head, findings }) {
  return [
    `**Post-accept red team — ${findings.length} confirmed break(s) sent back to the fixer.**`,
    '',
    `Claude's re-check confirmed these on head \`${String(head).slice(0, 12)}\` (#${pr}), and the setting \`redTeam.confirmedBreaks\` sends `
      + 'that class back (card x1b8hlo). Fix each one, then push; the new head is reviewed again.',
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
export function buildSendBackArgv({ repo, pr, bodyPath }) {
  return [String(pr), `--repo=${repo}`, '--to=changes', `--body-file=${bodyPath}`, `--actor=${RED_TEAM_GATE_ACTOR}`, `--channel=${RED_TEAM_GATE_CHANNEL}`];
}

/** The gate's own record for ONE action on the head. PURE. */
export function buildGateComment({ pr, head, outcome, plan, round, result = null, grantIds = null, cardResult = null, sendBackResult = null, cap = DEFAULT_ROUND_CAP, priorRuled = null }) {
  const lines = [redTeamGateMarker(pr, head, outcome, result, grantIds),`**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${String(head).slice(0, 12)}\`:`];
  if (plan.sendBack.length) {
    lines.push(outcome === GATE_OUTCOMES.ROUND_CAP
      ? `- ${plan.sendBack.length} confirmed break(s) NOT sent back: ${Number.isInteger(round) ? `review round ${round} has reached the round cap (${cap})` : 'the review round could not be read, which counts as the round cap'}. The operator rules on them (${plan.sendBack.map(f => `#${f.index}`).join(', ')}).`
      : `- ${plan.sendBack.length} confirmed break(s) sent back to the fixer (${plan.sendBack.map((f) => `#${f.index}`).join(', ')})${sendBackResult?.already ? ' — the PR was already under review:changes' : ''}.`);
  }
  if (plan.card.length) {
    lines.push(`- ${plan.card.length} finding(s) filed as a follow-up card (${plan.card.map((f) => `#${f.index}`).join(', ')})`
      + `${cardResult?.ok ? ` — landing job ${sanitizeCardField(cardResult.session ?? cardResult.handle ?? '', 120)}` : ` — FILING FAILED: ${sanitizeCardField(cardResult?.error ?? 'unknown', 300)}`}.`);
  }
  if (plan.advisory.length) lines.push(`- ${plan.advisory.length} finding(s) left advisory (${plan.advisory.map((f) => `#${f.index}`).join(', ')}).`);
  // Card 6212 — the PR was already under `review:changes` (a round-1 red team beside the panel's send-back): no
  // send-back comment of the gate's own was written, so the fix list rides on this record, where the fixer's context
  // pack stages it next to the review's findings. Below a blank line, so the action-line reader never sees it.
  if (outcome === GATE_OUTCOMES.SENT_BACK && sendBackResult?.already && plan.sendBack.length) {
    lines.push('', `Fix list — the red team's confirmed break(s) on this head, in the same round as the review's findings:`, ...plan.sendBack.map(findingLine));
  }
  if (outcome === GATE_OUTCOMES.PRIOR_RULING && Array.isArray(priorRuled) && priorRuled.length) {
    lines.push('', 'Not raised again (redTeam.timing=round1): each was already ruled on an earlier head, and the lines it cites are unchanged:',
      ...priorRuled.map(({ finding, rev }) => `- #${finding.index} ${where(finding)} — ruled on head \`${String(rev).slice(0, 12)}\``));
  }
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
    const { result: parsed, resultId, headReviewIndex, outcomes: recorded, sendBackOutcome, reopened } = liveResultGateState(view?.comments, pr, head, repo, standingRuling);
    if (!parsed) return { status: 'no-red-team-on-head', head };
    const setting = io.readSetting();
    let plan = planRedTeamActions(parsed, setting.value);
    // Card 6212 — REMEMBERED BREAKS (redTeam.timing=round1 only): a confirmed break already ruled on an earlier head,
    // whose cited lines are unchanged at this head, is not sent back or carded again. Recorded once (`prior-ruling`)
    // so the drain's disposition reader sees it released. Fail closed: any read that fails leaves the break in place.
    let timing = null;
    try { timing = io.readTiming?.() ?? null; } catch { timing = null; }
    if (timing?.round1 && (plan.sendBack.length || plan.card.length)) {
      let ruled = [];
      try { ruled = ruledEarlierBreaks({ comments: view?.comments, pr, head, setting: setting.value, repo, standingRuling }); } catch { ruled = []; }
      if (ruled.length) {
        const texts = new Map();
        const textAt = (sha, path) => {
          const key = `${sha}:${path}`;
          if (!texts.has(key)) { let t = null; try { t = io.readFileAt({ repo, sha, path }); } catch { t = null; } texts.set(key, typeof t === 'string' ? t : null); }
          return texts.get(key);
        };
        const fp = (f, sha) => citedLinesFingerprint({ file: f.file, line: f.line, text: f.file ? textAt(sha, f.file) : null });
        const suppressed = suppressPreviouslyRuled({ plan, fingerprintOf: (f) => fp(f, head),
          ruled: ruled.map(({ rev, finding }) => ({ rev, finding, fingerprint: fp(finding, rev) })) });
        if (suppressed.priorRuled.length) {
          plan = { sendBack: suppressed.sendBack, card: suppressed.card, advisory: suppressed.advisory };
          if (!dryRun && !recorded.has(GATE_OUTCOMES.PRIOR_RULING)) {
            try {
              io.postComment({ repo, pr, body: buildGateComment({ pr, head, outcome: GATE_OUTCOMES.PRIOR_RULING, result: resultId, round: null,
                plan: { sendBack: [], card: [], advisory: suppressed.priorRuled.map((x) => x.finding) }, priorRuled: suppressed.priorRuled }) });
            } catch (e) { return { status: 'prior-ruling-record-failed', head, plan, error: String(e?.message ?? e).slice(0, 200) }; }
          }
          io.log?.(`red-team gate: #${pr} ${suppressed.priorRuled.length} confirmed break(s) not raised again — ruled on an earlier head, cited lines unchanged (${formatRedTeamTimingLine(timing)})`);
        }
      }
    }
    if (!plan.sendBack.length && !plan.card.length) return { status: 'advisory-only', head, plan };
    // One record per ACTION (see the header): what is already recorded for this result is not repeated, what is not stays pending.
    const priorSend = sendBackOutcome;
    // A `round-cap` record is re-decided once for a grant its decision did not see (extend-rounds), including one
    // posted during the cap POST. The re-decision snapshots its grants so the same grant cannot reopen it twice.
    const sendPending = plan.sendBack.length > 0 && (!priorSend || reopened);
    const cardPending = plan.card.length > 0 && !recorded.has(GATE_OUTCOMES.CARD_QUEUED);
    if (!dryRun && priorSend === GATE_OUTCOMES.SENT_BACK && sendBackReason(view.labels)) io.dequeueSentBack({ repo, pr, reason: 'post-accept red team sent back to review:changes' });
    if (!sendPending && !cardPending) return { status: 'already-acted', head, outcome: priorSend ?? GATE_OUTCOMES.CARD_QUEUED, plan };
    const round = sendPending ? io.readRound({ repo, pr, head }) : null;
    // The operator's audited grants raise the cap with the same grant-time anchor fix dispatch uses. The anchor counts
    // this head like `readRound` does when the thread shows its review before the grant (thread order, not clocks).
    const grants = sendPending ? gateRoundGrants(view?.comments, pr, repo, standingRuling) : [];
    const effectiveCap = gateRoundCap({ cap, grants, roundAt: (at, g) => {
      const reviewed = Number.isInteger(headReviewIndex) && Number.isInteger(g?.index) && headReviewIndex < g.index;
      try { return io.readRoundAsOf?.({ repo, pr, at, head: reviewed ? head : null }) ?? null; } catch { return null; }
    } });
    // The round is the only bound on send-backs, so an unreadable one is the cap (the operator rules), never "round 1".
    const capped = sendPending && (!Number.isInteger(round) || round >= effectiveCap);
    const outcome = !plan.sendBack.length ? GATE_OUTCOMES.NOTHING_TO_SEND
      : !sendPending ? priorSend : capped ? GATE_OUTCOMES.ROUND_CAP : GATE_OUTCOMES.SENT_BACK;
    const labels = (view.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
    const sendBody = sendPending && !capped ? buildSendBackBody({ pr, head, findings: plan.sendBack }) : null;
    const cardInput = cardPending ? buildRedTeamCardInput({ repo, pr, head, findings: plan.card }) : null;
    if (dryRun) {
      return { status: 'dry-run', head, round, cap: sendPending ? effectiveCap : null, reopened, outcome, plan, wouldSendBack: sendPending && outcome === GATE_OUTCOMES.SENT_BACK, sendBody, cardInput, setting };
    }
    let sendBackResult = null;
    let marker = null;
    const record = (recordOutcome, recordPlan, extra = {}) => {
      try { io.postComment({ repo, pr, body: buildGateComment({ pr, head, outcome: recordOutcome, plan: recordPlan, round, result: resultId,
        grantIds: recordOutcome === GATE_OUTCOMES.ROUND_CAP || recordOutcome === GATE_OUTCOMES.SENT_BACK ? grants.map(g => g.id) : null,
        cap: effectiveCap, ...extra }) }); return 'posted'; }
      catch (e) { return `error: ${String(e?.message ?? e).slice(0, 200)}`; }
    };
    if (sendPending) {
      if (outcome === GATE_OUTCOMES.SENT_BACK) {
        if (labels.includes('review:changes')) {
          // Signalled only after the record below is posted: it carries the fix list the fixer's pack stages (card 6212).
          sendBackResult = { ok: true, already: true };
        }
        else {
          // The writer cannot pin a head for `--to=changes`: re-read it right before the write (see the header).
          const live = String(io.readHead({ repo, pr }) ?? '').toLowerCase();
          if (live !== head) return { status: 'head-moved', head, liveHead: live, plan };
          sendBackResult = io.sendBack({ repo, pr, head, body: sendBody });
          if (!sendBackResult?.ok) return { status: 'send-back-failed', head, round, plan, error: sendBackResult?.error ?? 'unknown' };
          try { await io.appendSendBackEvent({ repo, pr, head }); } catch (e) { io.log(`red-team gate: send-back of #${pr} applied but the ledger event missed: ${e.message}`); }
        }
      }
      if (outcome === GATE_OUTCOMES.SENT_BACK) io.dequeueSentBack({ repo, pr, reason: 'post-accept red team sent back to review:changes' });
      marker = record(outcome, { ...plan, card: [] }, { sendBackResult });
      // The label is written but its record is not: without it the operator queue never learns the fixer owns the break.
      // Retry-safe: the next run sees review:changes, takes the `already` path (no second label write) and records.
      if (marker !== 'posted') return { status: 'send-back-record-failed', head, round, outcome, plan, sendBack: sendBackResult, marker, error: marker };
      if (sendBackResult?.already) io.signalFix?.({ repo, pr, label: 'review:changes' });
    }
    let cardResult = null;
    let cardMarker = null;
    if (cardPending) {
      cardResult = io.fileCard(cardInput);
      // A card that was not filed records nothing: a permanent per-head record here would make the failure unretryable.
      if (!cardResult?.ok) return { status: 'card-failed', head, round, outcome, plan, sendBack: sendBackResult, card: cardResult, marker, error: cardResult?.error ?? 'unknown' };
      cardMarker = record(GATE_OUTCOMES.CARD_QUEUED, { sendBack: [], card: plan.card, advisory: sendPending ? [] : plan.advisory }, { cardResult });
      // The job is spawned but its record is not on the PR: the next run would queue a DUPLICATE card. Say so, loudly.
      if (cardMarker !== 'posted') return { status: 'card-record-failed', head, round, outcome, plan, sendBack: sendBackResult, card: cardResult, marker, cardMarker, error: cardMarker };
    }
    return { status: 'applied', head, round, outcome, plan, sendBack: sendBackResult, card: cardResult, marker, cardMarker };
  } catch (e) {
    return { status: 'error', reason: String(e?.message ?? e).slice(0, 500) };
  }
}

/** Statuses the CLI reports with a nonzero exit: every failure, including a record that could not be posted. */
export const GATE_FAILURE_STATUSES = Object.freeze(['error', 'send-back-failed', 'send-back-record-failed', 'card-failed', 'card-record-failed', 'prior-ruling-record-failed']);

/** The CLI exit code for a gate result: 1 on any failure status, else 0. PURE. */
export const gateExitCode = (r) => (GATE_FAILURE_STATUSES.includes(r?.status) ? 1 : 0);

/** One-line summary for a job log. PURE. */
export function renderGateSummary(r) {
  const p = r?.plan;
  const counts = p ? ` (send-back ${p.sendBack.length}, card ${p.card.length}, advisory ${p.advisory.length})` : '';
  return `red-team gate: ${r?.status ?? 'none'}${r?.outcome ? ` → ${r.outcome}` : ''}${counts}${r?.reason || r?.error ? ` — ${r.reason ?? r.error}` : ''}`;
}

export function createRedTeamGateIo({ env = process.env, root = REPO_ROOT } = {}) {
  const gh = (args, input) => {
    const r = spawnSync('gh', args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 300)}`);
    return String(r.stdout ?? '');
  };
  const safety = readDrainQueueSafety({ env, log: line => process.stderr.write(`${line}\n`) });
  return {
    syncStatusLabels: ({ repo, pr, head }) => head ? syncRedTeamStatusLabels({ repo, pr, head, env,
      log: line => process.stderr.write(`${line}\n`) }) : null,
    signalFix: signalFixDispatch,
    dequeueSentBack: args => safety.value.dequeueOnSendBack ? dequeueSentBack({ ...args, exec: (cmd, argv, opts) => execFileSync(cmd, argv, { ...opts, env }), log: line => process.stderr.write(`${line}\n`) }) : { dequeued: false },
    // The COMPLETE thread (paginated): a one-page read could miss the red-team comment or the gate's own record.
    readPr: ({ repo, pr }) => ({
      ...JSON.parse(gh(['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid,labels'])),
      comments: readCompletePrComments(Number(pr), { repo }),
    }),
    // Fresh per run on the App identity: a closed or edited ruling stops crediting automatic grants at the next run.
    readGrantScope: ({ repo, pr, head, comments }) => standingRulingScope({ repo, pr: { number: Number(pr), headRefOid: head, comments } }),
    readSetting: () => readConfirmedBreaks({ env }),
    // Card 6212 — `redTeam.timing`, and one file's text at one commit (the remembered-breaks check). A failed read is null.
    readTiming: () => readRedTeamTiming({ env }),
    readFileAt: ({ repo, sha, path }) => {
      if (!/^[0-9a-f]{40}$/.test(String(sha)) || !/^[\w@./-]+$/.test(String(path)) || String(path).split('/').includes('..')) return null;
      return gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${encodeURI(path)}?ref=${sha}`]);
    },
    readRound: ({ repo, pr, head }) => readReviewRound({ repo, pr, head }),
    readRoundAsOf: ({ repo, pr, at, head }) => readReviewRoundAsOf({ repo, pr, at, head }),
    // The live head, read fresh and alone (the PR view above can be minutes old by the time a slow step finishes).
    readHead: ({ repo, pr }) => String(JSON.parse(gh(['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid'])).headRefOid ?? ''),
    sendBack: ({ repo, pr, body }) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-gate-'));
      try {
        const path = join(dir, 'body.md');
        writeFileSync(path, body, 'utf8');
        const r = spawnSync(process.execPath, [join(root, 'scripts', 'review-set-label.mjs'), ...buildSendBackArgv({ repo, pr, bodyPath: path })],
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
    log: (line) => process.stderr.write(`${line}\n`),
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
