/**
 * @file scripts/operations/record-red-team-ruling-io.mjs
 * @description The IMPURE half of `record-red-team-ruling` (see `./record-red-team-ruling.mjs`): the reader (live
 *   head, labels, the COMPLETE comment thread, the `redTeam.confirmedBreaks` setting) and the sinks (card, block,
 *   not-real). Every collaborator is injectable so the tests run with no network.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_OUTCOMES, readConfirmedBreaks, readRedTeamDisposition } from '../lib/red-team-gate.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';
import { EVENT_TYPES, buildLedgerEvent } from '../lib/verdict-ledger.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { buildGateComment } from './red-team-gate-apply.mjs';
import { appendLedgerEvents } from './record-referral-ruling-io.mjs';
import {
  OPERATOR_NOT_REAL_OUTCOME, RED_TEAM_RULING_BLOCK_EFFECT, RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT,
  buildRuleReasonComment, recordRedTeamRulingOperation,
} from './record-red-team-ruling.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gh = (args, input) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, input,
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
  now = () => new Date().toISOString(),
  assertFresh = () => assertOperatorCliFresh(REPO_ROOT, { label: 'record-red-team-ruling', env }) } = {}) {
  return ({ repo, pr }) => {
    assertFresh();
    const thread = readThread({ repo, pr });
    return { head: String(thread.headRefOid ?? '').toLowerCase(), labels: thread.labels ?? [], comments: thread.comments ?? [],
      setting: readSetting().value, now: now() };
  };
}

export function createRecordRedTeamRulingSinks({ env = process.env, root = REPO_ROOT, readThread = readLiveThread,
  fileCard = (input) => spawnPreventionLandingJob(input, { sessionPrefix: 'red-team-ruling-card' }),
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'], body),
  runSetLabel = execFileSync, appendEvents = appendLedgerEvents,
  warn = (m) => process.stderr.write(`${m}\n`), now = () => new Date().toISOString() } = {}) {
  /** Re-read right before writing: the head must be the planned one and every break still held. */
  const recheck = (p) => {
    const thread = readThread({ repo: p.repo, pr: p.pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`PR #${p.pr}'s head moved to ${head} since the plan (${p.head}); nothing written — re-run against the new head`);
    const held = readRedTeamDisposition({ comments: thread.comments, pr: p.pr, head, setting: p.setting }).held.map((f) => f.index);
    const gone = p.indices.filter((i) => !held.includes(i));
    if (gone.length) throw new Error(`break(s) ${gone.map((i) => `#${i}`).join(', ')} are no longer held for the operator (already ruled or carded); nothing written`);
    if (labelNames(thread.labels).includes('review:changes')) throw new Error('the PR moved to review:changes since the plan; nothing written');
  };
  const proveReleased = (p, what) => {
    const after = readThread({ repo: p.repo, pr: p.pr });
    const held = readRedTeamDisposition({ comments: after.comments, pr: p.pr, head: p.head, setting: p.setting }).held.map((f) => f.index);
    const still = p.indices.filter((i) => held.includes(i));
    if (still.length) throw new Error(`${what} was posted but the gate still holds break(s) ${still.map((i) => `#${i}`).join(', ')} `
      + '(untrusted author or altered body); inspect the thread before retrying');
    return after;
  };
  const reasonBody = (p, cardNote) => buildRuleReasonComment({ head: p.head, ruling: p.ruling, actor: p.actor, channel: p.channel,
    at: p.at, reason: p.reason, findings: p.findings, cardNote });
  return {
    [RED_TEAM_RULING_CARD_EFFECT]: (p) => {
      recheck(p);
      const card = fileCard(p.cardInput);
      if (!card?.ok) throw new Error(`the follow-up card was not queued (${card?.error ?? 'unknown'}); nothing was recorded, so a re-run retries`);
      const record = buildGateComment({ pr: p.pr, head: p.head, outcome: GATE_OUTCOMES.CARD_QUEUED, round: null, result: p.resultId,
        plan: { sendBack: [], card: p.findings, advisory: [] }, cardResult: card });
      try { post(p.repo, p.pr, record); } catch (e) {
        throw new Error(`the card landing job was spawned (${card.session ?? card.handle ?? 'job'}) but its gate record could not be posted (${e.message}); `
          + 'a re-run would queue a DUPLICATE card — post the record first or inspect the thread');
      }
      post(p.repo, p.pr, reasonBody(p, `Follow-up card queued through the prevention landing job (${card.session ?? card.handle ?? 'job'}); filing may be paused, in which case it is owed in the spool.`));
      proveReleased(p, 'the card-queued record');
      return { ruling: 'card', head: p.head, indices: p.indices, card: { session: card.session ?? card.handle ?? null } };
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
