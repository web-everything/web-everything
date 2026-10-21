/**
 * @file scripts/operations/record-red-team-ruling-io.mjs
 * @description The IMPURE half of `record-red-team-ruling` (see `./record-red-team-ruling.mjs`): the reader (live
 *   head, labels, the COMPLETE comment thread, the `redTeam.confirmedBreaks` setting) and the sinks (card, block,
 *   not-real). Every collaborator is injectable so the tests run with no network.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_OUTCOMES, liveResultGateState, readConfirmedBreaks, readRedTeamDisposition, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { assertHumanOperator, operatorBoundComments, operatorGhEnv, resolveOperatorIdentity } from '../lib/operator-identity.mjs';
import { automationStateRoot } from '../lib/automation-home.mjs';
import { defaultSpawnDetached } from './detached-dispatch.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { preventionCardLandingLogPath, spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';
import { EVENT_TYPES, buildLedgerEvent } from '../lib/verdict-ledger.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { buildGateComment } from './red-team-gate-apply.mjs';
import { appendLedgerEvents } from './record-referral-ruling-io.mjs';
import {
  CARD_PENDING_OUTCOME, OPERATOR_CARD_OUTCOME, OPERATOR_NOT_REAL_OUTCOME, RED_TEAM_RULING_BLOCK_EFFECT, RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT,
  buildRuleReasonComment, recordRedTeamRulingOperation,
} from './record-red-team-ruling.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** `gh` under the OPERATOR channel: App tokens removed, so it runs as the operator's own login. */
const gh = (args, input, env = process.env) => {
  const r = spawnSync('gh', args, { env: operatorGhEnv(env), encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, input,
    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 300)}`);
  return String(r.stdout ?? '');
};
const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name));

/** The default thread reader: head + labels + the complete (paginated) comments. */
export const readLiveThread = ({ repo, pr }) => ({
  ...JSON.parse(gh(['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid,labels'])),
  comments: readCompletePrComments(Number(pr), { repo }),
});

export function createRecordRedTeamRulingReader({ env = process.env, readThread = readLiveThread, readSetting = () => readConfirmedBreaks({ env }),
  resolveIdentity = () => resolveOperatorIdentity({ env }), now = () => new Date().toISOString(),
  assertFresh = () => assertOperatorCliFresh(REPO_ROOT, { label: 'record-red-team-ruling', env }) } = {}) {
  return ({ repo, pr }) => {
    assertFresh();
    const thread = readThread({ repo, pr });
    return { head: String(thread.headRefOid ?? '').toLowerCase(), labels: thread.labels ?? [], comments: thread.comments ?? [],
      setting: readSetting().value, now: now(), identity: resolveIdentity() };
  };
}

/** A local, atomic claim per card job (a `wx` file): the serialization point GitHub comments cannot be. */
export function createFileClaims({ dir = join(automationStateRoot(), 'red-team-ruling-claims'), nowMs = Date.now } = {}) {
  return {
    claim(key) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${key}.json`);
      try { writeFileSync(path, JSON.stringify({ at: nowMs() }), { flag: 'wx' }); return { created: true, at: nowMs() }; }
      catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        let at = 0;
        try { at = Number(JSON.parse(readFileSync(path, 'utf8')).at) || 0; } catch { /* unreadable claim: treated as old */ }
        return { created: false, at };
      }
    },
    now: nowMs,
  };
}

/** How long a claim with no spawned job counts as another invocation still working. */
export const CLAIM_IN_PROGRESS_MS = 120_000;

/** Spawn the landing job under a STABLE session, so the job (and its log) is identified by the ruling, not by a fresh random slug. */
const spawnStableCardJob = (input, session) => {
  const logPath = preventionCardLandingLogPath(session);
  const r = spawnPreventionLandingJob(input, { sessionPrefix: 'red-team-ruling-card',
    spawnDetached: (argv, o) => defaultSpawnDetached(argv.map((a) => (a.startsWith('--session=') ? `--session=${session}` : a)), { ...o, logPath }) });
  return r.ok ? { ...r, session } : r;
};

export function createRecordRedTeamRulingSinks({ env = process.env, root = REPO_ROOT, readThread = readLiveThread,
  resolveIdentity = () => resolveOperatorIdentity({ env }), claims = createFileClaims(),
  fileCard = spawnStableCardJob,
  /** Was the stable job already spawned? Its log file is opened before the process starts. */
  jobSpawned = (session) => existsSync(preventionCardLandingLogPath(session)),
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'], body, env),
  runSetLabel = execFileSync, appendEvents = appendLedgerEvents,
  warn = (m) => process.stderr.write(`${m}\n`), now = () => new Date().toISOString() } = {}) {
  /** Right before any write: the poster, the head, the SAME result, still at the cap, every break still held, no review:changes. */
  const recheck = (p) => {
    assertHumanOperator(resolveIdentity(), p.actor);
    const thread = readThread({ repo: p.repo, pr: p.pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`PR #${p.pr}'s head moved to ${head} since the plan (${p.head}); nothing written — re-run against the new head`);
    const comments = operatorBoundComments(thread.comments);
    const state = liveResultGateState(comments, p.pr, head);
    if (state.resultId !== p.resultId) throw new Error(`the red-team result on the live head changed since the plan (${p.resultId} -> ${state.resultId}); nothing written — re-run`);
    if (!state.outcomes.has(GATE_OUTCOMES.ROUND_CAP)) throw new Error('the live result is no longer parked at the round cap; nothing written');
    const held = readRedTeamDisposition({ comments, pr: p.pr, head, setting: p.setting }).held.map((f) => f.index);
    const gone = p.indices.filter((i) => !held.includes(i));
    if (gone.length) throw new Error(`break(s) ${gone.map((i) => `#${i}`).join(', ')} are no longer held for the operator (already ruled or carded); nothing written`);
    if (labelNames(thread.labels).includes('review:changes')) throw new Error('the PR moved to review:changes since the plan; nothing written');
    return comments;
  };
  const proveReleased = (p, what) => {
    const after = readThread({ repo: p.repo, pr: p.pr });
    const held = readRedTeamDisposition({ comments: operatorBoundComments(after.comments), pr: p.pr, head: p.head, setting: p.setting }).held.map((f) => f.index);
    const still = p.indices.filter((i) => held.includes(i));
    if (still.length) throw new Error(`${what} was posted but the gate still holds break(s) ${still.map((i) => `#${i}`).join(', ')} `
      + '(not authored by the operator account, or an altered body); inspect the thread before retrying');
    return after;
  };
  const reasonBody = (p, cardNote) => buildRuleReasonComment({ head: p.head, ruling: p.ruling, actor: p.actor, channel: p.channel,
    at: p.at, reason: p.reason, findings: p.findings, cardNote });
  const intentBody = (p) => `${redTeamGateMarker(p.pr, p.head, CARD_PENDING_OUTCOME, p.resultId)}\n`
    + `Operator card ruling pending (job ${p.jobKey}, break(s) ${p.indices.map((i) => `#${i}`).join(', ')}); the break stays held until the card is queued and recorded.`;
  return {
    [RED_TEAM_RULING_CARD_EFFECT]: (p) => {
      const comments = recheck(p);
      const session = p.session;
      // 1. Serialize: one atomic local claim per (PR, head, result, breaks). A second run reconciles instead of re-spawning.
      const claim = claims.claim(p.jobKey);
      let spawned = jobSpawned(session);
      if (!claim.created && !spawned && claims.now() - claim.at < CLAIM_IN_PROGRESS_MS) {
        throw new Error(`another invocation holds the claim for job ${p.jobKey} and has not spawned it yet; wait ${Math.round(CLAIM_IN_PROGRESS_MS / 1000)}s and re-run`);
      }
      // 2. The bare intent marker, BEFORE the spawn (no action line, so the hold stands). Written once per job.
      const hasIntent = comments.some((c) => String(c?.body ?? '').includes(`outcome=${CARD_PENDING_OUTCOME} result=${p.resultId}`) && String(c?.body ?? '').includes(`job ${p.jobKey}`));
      if (!hasIntent) post(p.repo, p.pr, intentBody(p));
      // 3. Spawn exactly once: a job whose log already exists is reconciled, never spawned again.
      let card = { ok: true, session };
      if (!spawned) {
        card = fileCard(p.cardInput, session);
        if (!card?.ok) throw new Error(`the follow-up card was not queued (${card?.error ?? 'unknown'}); the intent is recorded and a re-run retries the same job`);
      }
      // 4. The release record, only now that the job is accepted. Its failure is retry-safe: the next run sees the spawned job.
      const record = buildGateComment({ pr: p.pr, head: p.head, outcome: OPERATOR_CARD_OUTCOME, round: null, result: p.resultId,
        plan: { sendBack: [], card: p.findings, advisory: [] }, cardResult: card });
      post(p.repo, p.pr, record);
      post(p.repo, p.pr, reasonBody(p, `Follow-up card queued through the prevention landing job (${session}); filing may be paused, in which case it is owed in the spool.`));
      proveReleased(p, 'the operator-card record');
      return { ruling: 'card', head: p.head, indices: p.indices, card: { session, reconciled: spawned } };
    },
    [RED_TEAM_RULING_NOT_REAL_EFFECT]: (p) => {
      recheck(p);
      const record = buildGateComment({ pr: p.pr, head: p.head, outcome: OPERATOR_NOT_REAL_OUTCOME, round: null, result: p.resultId,
        plan: { sendBack: [], card: [], advisory: p.findings } });
      post(p.repo, p.pr, record);
      post(p.repo, p.pr, reasonBody(p, 'Recorded as not real: the break stays advisory. This does not clear `review:human` or approve the PR.'));
      proveReleased(p, 'the not-real record');
      return { ruling: 'not-real', head: p.head, indices: p.indices };
    },
    [RED_TEAM_RULING_BLOCK_EFFECT]: async (p) => {
      recheck(p);
      const dir = mkdtempSync(join(tmpdir(), 'red-team-ruling-'));
      try {
        const path = join(dir, 'body.md');
        writeFileSync(path, p.sendBackBody, 'utf8');
        let stdout;
        try {
          stdout = await runSetLabel(process.execPath, [join(root, 'scripts/review-set-label.mjs'), String(p.pr), `--repo=${p.repo}`,
            '--to=changes', `--body-file=${path}`, `--actor=${p.actor}`, `--channel=${p.channel}`], { encoding: 'utf8', timeout: 120_000 });
        } catch (error) {
          let message;
          try { message = JSON.parse(String(error.stdout)).error; } catch { /* keep the process error */ }
          throw new Error(message || error.message);
        }
        const result = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).at(-1) ?? '{}');
        if (result.error || result.ok !== true) throw new Error(result.error || 'review-set-label did not confirm the send-back');
      } finally { rmSync(dir, { recursive: true, force: true }); }
      try {
        await appendEvents([buildLedgerEvent({ type: EVENT_TYPES.SEND_BACK, repo: p.repo, pr: p.pr, at: now(),
          source: 'record-red-team-ruling', declaredActor: p.actor, channel: p.channel, cause: 'block-ruling' })]);
      } catch (e) { warn(`ledger-write-miss: send-back of ${p.repo}#${p.pr} was applied but not recorded in the verdict ledger: ${String(e?.message ?? e)}`); }
      return { ruling: 'block', head: p.head, indices: p.indices, sentBack: true };
    },
  };
}

/** The `run.mjs` table entry: `{declaration, sinks}`. */
export function recordRedTeamRulingEntry() {
  return { declaration: recordRedTeamRulingOperation({ readRulingContext: createRecordRedTeamRulingReader() }),
    sinks: createRecordRedTeamRulingSinks() };
}
