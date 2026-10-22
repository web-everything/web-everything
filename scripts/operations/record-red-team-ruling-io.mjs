/**
 * @file scripts/operations/record-red-team-ruling-io.mjs
 * @description Live reader and existing-card sink for cap-held operator rulings. IO is injectable.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveResultGateState, readConfirmedBreaks, readRedTeamDisposition, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { syncRedTeamStatusLabels } from '../lib/red-team-status-labels.mjs';
import { openPrHeadBacklog, resolveCardRef } from './record-referral-ruling-io.mjs';
import { assertHumanOperator, isHumanOperatorComment, operatorBoundComments, operatorGhEnv, resolveOperatorIdentity } from '../lib/operator-identity.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { OPERATOR_CARD_OUTCOME, RED_TEAM_RULING_CARD_EFFECT, buildRuleReasonComment, recordRedTeamRulingOperation, rulableBreaks } from './record-red-team-ruling.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** `gh` under the OPERATOR channel: App tokens removed, so it runs as the operator's own login. */
const gh = (args, input, env = process.env) => {
  const r = spawnSync('gh', args, { env: operatorGhEnv(env), encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, input,
    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 300)}`);
  return String(r.stdout ?? '');
};

/** The default thread reader: head + labels + the complete (paginated) comments. */
export const readLiveThread = ({ repo, pr }) => ({
  ...JSON.parse(gh(['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid,labels'])),
  comments: readCompletePrComments(Number(pr), { repo }),
});

/** `--card` resolved exactly as `record-referral-ruling` resolves it (main, else `@pr<N>` on the ruled PR's head). */
const resolveCardDefault = (card, { repo, pr, head }) => {
  let opened;
  const prHead = { list: () => (opened ??= openPrHeadBacklog({ repo, pr, head })).list(), read: (f) => (opened ??= openPrHeadBacklog({ repo, pr, head })).read(f) };
  return resolveCardRef(card, { pr, prHead });
};

export function createRecordRedTeamRulingReader({ env = process.env, readThread = readLiveThread, readSetting = () => readConfirmedBreaks({ env }),
  resolveCard = resolveCardDefault,
  resolveIdentity = () => resolveOperatorIdentity({ env }), now = () => new Date().toISOString(),
  assertFresh = () => assertOperatorCliFresh(REPO_ROOT, { label: 'record-red-team-ruling', env }) } = {}) {
  return ({ repo, pr, card }) => {
    assertFresh();
    const thread = readThread({ repo, pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    return { head, labels: thread.labels ?? [], comments: thread.comments ?? [],
      setting: readSetting().value, now: now(), identity: resolveIdentity(),
      card: card === undefined || card === '' ? null : resolveCard(card, { repo, pr, head }) };
  };
}

export function createRecordRedTeamRulingSinks({ env = process.env, readThread = readLiveThread,
  resolveIdentity = () => resolveOperatorIdentity({ env }),
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'], body, env),
  syncLabels = ({ repo, pr, head }) => syncRedTeamStatusLabels({ repo, pr, head, env }),
  warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  /** Right before any write: the poster, the head, the SAME result, and every selected break still rulable the same way
   *  the plan found it (the same `rulableBreaks` rule, so the cap and held-break checks apply here too). */
  const recheck = (p) => {
    assertHumanOperator(resolveIdentity(), p.actor);
    const thread = readThread({ repo: p.repo, pr: p.pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`PR #${p.pr}'s head moved to ${head} since the plan (${p.head}); nothing written — re-run against the new head`);
    const comments = operatorBoundComments(thread.comments);
    let now;
    try { now = rulableBreaks({ comments, labels: thread.labels, pr: p.pr, head, setting: p.setting }); }
    catch (e) { throw new Error(`${e.message}; nothing written`); }
    if (now.state.resultId !== p.resultId) throw new Error(`the red-team result on the live head changed since the plan (${p.resultId} -> ${now.state.resultId}); nothing written — re-run`);
    const rulable = now.rulable.map((f) => f.index);
    const gone = p.indices.filter((i) => !rulable.includes(i));
    if (gone.length) throw new Error(`break(s) ${gone.map((i) => `#${i}`).join(', ')} are no longer held for the operator / rulable (already ruled or carded); nothing written`);
    return { comments, labels: thread.labels ?? [] };
  };
  const disposition = (p, comments) => readRedTeamDisposition({ comments: operatorBoundComments(comments), pr: p.pr, head: p.head, setting: p.setting });
  /** After the write: same head, same result, the record WE wrote is in the thread as a human operator's comment, and
   *  the gate (reading that thread) no longer holds or sends back any selected break. */
  const proveReleased = (p, what, record) => {
    const after = readThread({ repo: p.repo, pr: p.pr });
    const head = String(after.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`${what} was posted but PR #${p.pr}'s head moved to ${head}; the ruling binds to ${p.head} only — inspect and re-run on the new head`);
    const comments = operatorBoundComments(after.comments);
    if (liveResultGateState(comments, p.pr, head).resultId !== p.resultId) throw new Error(`${what} was posted but the live red-team result changed; inspect the thread before retrying`);
    if (record && !comments.some((c) => String(c?.body ?? '').trim() === record.trim() && isHumanOperatorComment(c))) {
      throw new Error(`${what} is not in the read-back as a human operator's comment (altered, or posted as another account); inspect the thread before retrying`);
    }
    const d = disposition(p, after.comments);
    const still = p.indices.filter((i) => d.held.some((f) => f.index === i) || d.sendBack.some((f) => f.index === i));
    if (still.length) throw new Error(`${what} was posted but the gate still holds break(s) ${still.map((i) => `#${i}`).join(', ')} `
      + '(not authored by the operator account, or an altered body); inspect the thread before retrying');
    return after;
  };
  /** The derived `red-team:*` label follows the disposition; a failed sync is reported, never fatal (the record is what counts). */
  const resync = (p) => {
    try { return syncLabels({ repo: p.repo, pr: p.pr, head: p.head }); }
    catch (e) { warn(`red-team-status-label-miss: ${p.repo}#${p.pr}: ${String(e?.message ?? e)}`); return null; }
  };
  const reasonBody = (p, cardNote) => buildRuleReasonComment({ head: p.head, ruling: p.ruling, actor: p.actor, channel: p.channel,
    at: p.at, reason: p.reason, findings: p.findings, cardNote, cause: p.cause ?? null });
  const operatorRecord = (p, outcome, line) => `${redTeamGateMarker(p.pr, p.head, outcome, p.resultId)}\n`
    + `**Red-team gate** operator ruling (\`record-red-team-ruling\`) on head \`${p.head.slice(0, 12)}\`:\n${line}`;
  const indexList = (p) => `(${p.indices.map((i) => `#${i}`).join(', ')})`;
  return {
    [RED_TEAM_RULING_CARD_EFFECT]: (p) => {
      recheck(p);
      // An EXISTING card: one release record citing it, then the reason. Nothing is filed.
      if (!/^we:backlog\/[A-Za-z0-9][A-Za-z0-9._-]*\.md(?:@pr[1-9]\d{0,8})?$/.test(p.cardRef)) throw new Error(`--card resolved to an unsafe reference ${JSON.stringify(p.cardRef)}; nothing written`);
      const record = operatorRecord(p, OPERATOR_CARD_OUTCOME, `- ${p.indices.length} finding(s) carded by the operator to \`${p.cardRef}\` ${indexList(p)}.`);
      post(p.repo, p.pr, record);
      post(p.repo, p.pr, reasonBody(p, `Carded to the existing card \`${p.cardRef}\`; no new card is filed.`));
      proveReleased(p, 'the operator-card record', record);
      return { ruling: 'card', head: p.head, indices: p.indices, card: { ref: p.cardRef }, labels: resync(p) };
    },
  };
}

/** The `run.mjs` table entry: `{declaration, sinks}`. */
export function recordRedTeamRulingEntry() {
  return { declaration: recordRedTeamRulingOperation({ readRulingContext: createRecordRedTeamRulingReader() }),
    sinks: createRecordRedTeamRulingSinks() };
}
