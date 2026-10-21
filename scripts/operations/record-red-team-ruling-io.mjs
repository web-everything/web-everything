/**
 * @file scripts/operations/record-red-team-ruling-io.mjs
 * @description The IMPURE half of `record-red-team-ruling` (see `./record-red-team-ruling.mjs`): the reader (live
 *   head, labels, the COMPLETE comment thread, the `redTeam.confirmedBreaks` setting) and the sinks (card, block,
 *   not-real). Every collaborator is injectable so the tests run with no network.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveResultGateState, readConfirmedBreaks, readOperatorRulings, readRedTeamDisposition, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { syncRedTeamStatusLabels } from '../lib/red-team-status-labels.mjs';
import { openPrHeadBacklog, resolveCardRef } from './record-referral-ruling-io.mjs';
import { assertHumanOperator, isHumanOperatorComment, operatorBoundComments, operatorGhEnv, resolveOperatorIdentity } from '../lib/operator-identity.mjs';
import { automationStateRoot } from '../lib/automation-home.mjs';
import { defaultSpawnDetached } from './detached-dispatch.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { preventionCardLandingLogPath, spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';
import { EVENT_TYPES, buildLedgerEvent } from '../lib/verdict-ledger.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { buildGateComment } from './red-team-gate-apply.mjs';
import { appendLedgerEvents } from './record-referral-ruling-io.mjs';
import {
  CARD_PENDING_OUTCOME, OPERATOR_BLOCK_OUTCOME, OPERATOR_CARD_OUTCOME, OPERATOR_NOT_REAL_OUTCOME, RED_TEAM_RULING_BLOCK_EFFECT, RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT,
  buildRuleReasonComment, conflictingPendingCardJobs, recordRedTeamRulingOperation, rulableBreaks,
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

/** The `redTeam.operatorRulings` scope, logged with its source on stderr (policy-cascade line). */
const readScopeLogged = (env) => readOperatorRulings({ env, log: (m) => process.stderr.write(`${m}\n`) });

/** `--card` resolved exactly as `record-referral-ruling` resolves it (main, else `@pr<N>` on the ruled PR's head). */
const resolveCardDefault = (card, { repo, pr, head }) => {
  let opened;
  const prHead = { list: () => (opened ??= openPrHeadBacklog({ repo, pr, head })).list(), read: (f) => (opened ??= openPrHeadBacklog({ repo, pr, head })).read(f) };
  return resolveCardRef(card, { pr, prHead });
};

export function createRecordRedTeamRulingReader({ env = process.env, readThread = readLiveThread, readSetting = () => readConfirmedBreaks({ env }),
  readScope = () => readScopeLogged(env), resolveCard = resolveCardDefault,
  resolveIdentity = () => resolveOperatorIdentity({ env }), now = () => new Date().toISOString(),
  assertFresh = () => assertOperatorCliFresh(REPO_ROOT, { label: 'record-red-team-ruling', env }) } = {}) {
  return ({ repo, pr, card }) => {
    assertFresh();
    const thread = readThread({ repo, pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    const scope = readScope();
    return { head, labels: thread.labels ?? [], comments: thread.comments ?? [],
      setting: readSetting().value, scope: { value: scope.value, sources: scope.sources ?? {} }, now: now(), identity: resolveIdentity(),
      card: card === undefined || card === '' ? null : resolveCard(card, { repo, pr, head }) };
  };
}

/**
 * A local, atomic claim per card job, in numbered GENERATIONS (`<key>.<n>.claim`, each made with `wx`). Taking over an
 * expired claim means creating generation n+1, which only one caller can do. The spawn PROOF is a separate receipt
 * (`<key>.spawned`) written only after the child's start was confirmed (a pid), never the landing job's log file
 * (that is opened before the spawn, so it proves nothing).
 */
export function createFileClaims({ dir = join(automationStateRoot(), 'red-team-ruling-claims'), nowMs = Date.now } = {}) {
  const latest = (key) => {
    let gen = -1, at = 0;
    for (const f of readdirSync(dir)) {
      const m = f.startsWith(`${key}.`) ? /\.(\d+)\.claim$/.exec(f) : null;
      if (m && Number(m[1]) > gen) { gen = Number(m[1]); try { at = Number(JSON.parse(readFileSync(join(dir, f), 'utf8')).at) || 0; } catch { at = 0; } }
    }
    return { gen, at };
  };
  const make = (key, gen) => {
    try { writeFileSync(join(dir, `${key}.${gen}.claim`), JSON.stringify({ at: nowMs() }), { flag: 'wx' }); return true; }
    catch (e) { if (e?.code === 'EEXIST') return false; throw e; }
  };
  return {
    claim(key) {
      mkdirSync(dir, { recursive: true });
      const cur = latest(key);
      if (cur.gen < 0 && make(key, 0)) return { created: true, gen: 0, at: nowMs() };
      const seen = latest(key);
      return { created: false, gen: seen.gen, at: seen.at };
    },
    /** Take over the claim observed at `gen`. Exactly one caller wins generation gen+1. */
    reclaim(key, gen) { return make(key, gen + 1); },
    /** Bind one BREAK to one card job, atomically (`wx`): the first job to claim a break owns it for good, so two
     *  concurrent invocations with overlapping selections can never both file it. Returns the owning job key. */
    claimBreak(breakKey, jobKey) {
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `${breakKey}.break`);
      try { writeFileSync(f, JSON.stringify({ jobKey, at: nowMs() }), { flag: 'wx' }); return jobKey; }
      catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        try { return String(JSON.parse(readFileSync(f, 'utf8')).jobKey ?? ''); } catch { return ''; }
      }
    },
    spawned(key) { return existsSync(join(dir, `${key}.spawned`)); },
    markSpawned(key, info) { writeFileSync(join(dir, `${key}.spawned`), JSON.stringify({ ...info, at: nowMs() })); },
    now: nowMs,
  };
}

/** The claim key binding ONE break of one result to its card job. PURE. */
export const breakClaimKey = (p, index) => createHash('sha256').update(JSON.stringify(['break-v1', p.repo, Number(p.pr), p.head, p.resultId, Number(index)])).digest('hex').slice(0, 16);

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
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'], body, env),
  runSetLabel = execFileSync, appendEvents = appendLedgerEvents,
  syncLabels = ({ repo, pr, head }) => syncRedTeamStatusLabels({ repo, pr, head, env }),
  warn = (m) => process.stderr.write(`${m}\n`), now = () => new Date().toISOString() } = {}) {
  /** Right before any write: the poster, the head, the SAME result, and every selected break still rulable the same way
   *  the plan found it (the same `rulableBreaks` rule, so the kill switch and the state checks apply here too). */
  const recheck = (p) => {
    assertHumanOperator(resolveIdentity(), p.actor);
    const thread = readThread({ repo: p.repo, pr: p.pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`PR #${p.pr}'s head moved to ${head} since the plan (${p.head}); nothing written — re-run against the new head`);
    const comments = operatorBoundComments(thread.comments);
    let now;
    try { now = rulableBreaks({ comments, labels: thread.labels, pr: p.pr, head, setting: p.setting, scope: p.scope, ruling: p.ruling, citesCard: Boolean(p.cardRef) }); }
    catch (e) { throw new Error(`${e.message}; nothing written`); }
    if (now.state.resultId !== p.resultId) throw new Error(`the red-team result on the live head changed since the plan (${p.resultId} -> ${now.state.resultId}); nothing written — re-run`);
    const rulable = now.rulable.map((f) => f.index);
    const gone = p.indices.filter((i) => !rulable.includes(i));
    if (gone.length) throw new Error(`break(s) ${gone.map((i) => `#${i}`).join(', ')} are no longer held for the operator / rulable (already ruled or carded); nothing written`);
    return { comments, labels: thread.labels ?? [] };
  };
  const disposition = (p, comments) => readRedTeamDisposition({ comments: operatorBoundComments(comments), pr: p.pr, head: p.head, setting: p.setting, operatorRulings: p.scope });
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
  /** After a block: same head and result, our record is in the thread, and the gate now holds or sends back EVERY selected break. */
  const proveHeld = (p, record) => {
    const after = readThread({ repo: p.repo, pr: p.pr });
    const head = String(after.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`the operator-block record was posted but PR #${p.pr}'s head moved to ${head}; inspect the thread`);
    const comments = operatorBoundComments(after.comments);
    if (liveResultGateState(comments, p.pr, head).resultId !== p.resultId) throw new Error('the operator-block record was posted but the live red-team result changed; inspect the thread');
    if (!comments.some((c) => String(c?.body ?? '').trim() === record.trim() && isHumanOperatorComment(c))) {
      throw new Error("the operator-block record is not in the read-back as a human operator's comment; inspect the thread before retrying");
    }
    const d = disposition(p, after.comments);
    const free = p.indices.filter((i) => !d.held.some((f) => f.index === i) && !d.sendBack.some((f) => f.index === i));
    if (free.length) throw new Error(`the operator-block record was posted but the gate does not hold break(s) ${free.map((i) => `#${i}`).join(', ')}; inspect the thread`);
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
  const intentBody = (p) => `${redTeamGateMarker(p.pr, p.head, CARD_PENDING_OUTCOME, p.resultId)}\n`
    + `Operator card ruling pending (job ${p.jobKey}, break(s) ${p.indices.map((i) => `#${i}`).join(', ')}); the break stays held until the card is queued and recorded.`;
  return {
    [RED_TEAM_RULING_CARD_EFFECT]: (p) => {
      const { comments } = recheck(p);
      if (!p.cardRef) {
        const pending = conflictingPendingCardJobs(comments, p);
        if (pending.length) throw new Error(`a different card job (${pending.map((j) => j.jobKey).join(', ')}) is already pending for an overlapping break; nothing written — re-run with that exact selection`);
      }
      if (p.cardRef) {
        // An EXISTING card: one release record citing it, then the reason. Nothing is filed.
        if (!/^we:backlog\/[A-Za-z0-9][A-Za-z0-9._-]*\.md(?:@pr[1-9]\d{0,8})?$/.test(p.cardRef)) throw new Error(`--card resolved to an unsafe reference ${JSON.stringify(p.cardRef)}; nothing written`);
        const record = operatorRecord(p, OPERATOR_CARD_OUTCOME, `- ${p.indices.length} finding(s) carded by the operator to \`${p.cardRef}\` ${indexList(p)}.`);
        post(p.repo, p.pr, record);
        post(p.repo, p.pr, reasonBody(p, `Carded to the existing card \`${p.cardRef}\`; no new card is filed.`));
        proveReleased(p, 'the operator-card record', record);
        return { ruling: 'card', head: p.head, indices: p.indices, card: { ref: p.cardRef }, labels: resync(p) };
      }
      const session = p.session;
      // 0. Each selected BREAK belongs to at most one card job (atomic, local): an overlapping concurrent selection loses.
      const owners = p.indices.map((i) => ({ i, owner: claims.claimBreak(breakClaimKey(p, i), p.jobKey) })).filter((o) => o.owner !== p.jobKey);
      if (owners.length) {
        throw new Error(`break(s) ${owners.map((o) => `#${o.i}`).join(', ')} already belong to another card job (${[...new Set(owners.map((o) => o.owner || 'unreadable'))].join(', ')}); `
          + 'nothing written — re-run with that job\'s exact --break selection');
      }
      // 1. Serialize: one atomic claim per (PR, head, result, breaks); taking over an expired one is atomic too.
      const claim = claims.claim(p.jobKey);
      const spawned = claims.spawned(p.jobKey);
      if (!claim.created && !spawned) {
        if (claims.now() - claim.at < CLAIM_IN_PROGRESS_MS) {
          throw new Error(`another invocation holds the claim for job ${p.jobKey} and has not spawned it yet; wait ${Math.round(CLAIM_IN_PROGRESS_MS / 1000)}s and re-run`);
        }
        if (!claims.reclaim(p.jobKey, claim.gen)) throw new Error(`another invocation just took over the claim for job ${p.jobKey}; re-run later`);
      }
      // 2. The bare intent marker, BEFORE the spawn (no action line, so the hold stands). Written once per job.
      const hasIntent = comments.some((c) => String(c?.body ?? '').includes(`outcome=${CARD_PENDING_OUTCOME} result=${p.resultId}`) && String(c?.body ?? '').includes(`job ${p.jobKey}`));
      if (!hasIntent) post(p.repo, p.pr, intentBody(p));
      // 3. Spawn exactly once: a job whose log already exists is reconciled, never spawned again.
      let card = { ok: true, session };
      if (!spawned) {
        card = fileCard(p.cardInput, session);
        if (!card?.ok) throw new Error(`the follow-up card was not queued (${card?.error ?? 'unknown'}); the intent is recorded and a re-run retries the same job`);
        // The proof of a spawn is the child's confirmed start (a pid), recorded durably; the job's log file proves nothing.
        if (!/^pid:\d+$/.test(String(card.handle ?? ''))) throw new Error('the landing job reported no confirmed child start; not recorded as spawned, a re-run retries');
        claims.markSpawned(p.jobKey, { session, handle: card.handle });
      }
      // 4. The release record, only now that the job is accepted. Its failure is retry-safe: the next run sees the spawned job.
      const record = buildGateComment({ pr: p.pr, head: p.head, outcome: OPERATOR_CARD_OUTCOME, round: null, result: p.resultId,
        plan: { sendBack: [], card: p.findings, advisory: [] }, cardResult: card });
      post(p.repo, p.pr, record);
      post(p.repo, p.pr, reasonBody(p, `Follow-up card queued through the prevention landing job (${session}); filing may be paused, in which case it is owed in the spool.`));
      proveReleased(p, 'the operator-card record', record);
      return { ruling: 'card', head: p.head, indices: p.indices, card: { session, reconciled: spawned }, labels: resync(p) };
    },
    [RED_TEAM_RULING_NOT_REAL_EFFECT]: (p) => {
      recheck(p);
      const record = buildGateComment({ pr: p.pr, head: p.head, outcome: OPERATOR_NOT_REAL_OUTCOME, round: null, result: p.resultId,
        plan: { sendBack: [], card: [], advisory: p.findings } });
      post(p.repo, p.pr, record);
      post(p.repo, p.pr, reasonBody(p, 'Recorded as not real: the break stays advisory. This does not clear `review:human` or approve the PR.'));
      proveReleased(p, 'the not-real record', record);
      return { ruling: 'not-real', head: p.head, indices: p.indices, cause: p.cause ?? null, labels: resync(p) };
    },
    [RED_TEAM_RULING_BLOCK_EFFECT]: async (p) => {
      const { labels } = recheck(p);
      // The hold first (adding a hold is always safe): the send-back line re-holds a break an earlier ruling released.
      const record = operatorRecord(p, OPERATOR_BLOCK_OUTCOME, `- ${p.indices.length} confirmed break(s) sent back to the fixer ${indexList(p)}.`);
      post(p.repo, p.pr, record);
      post(p.repo, p.pr, reasonBody(p, 'Blocked: the break(s) go back to the fixer.'));
      proveHeld(p, record);
      if (labelNames(labels).includes('review:changes')) {
        return { ruling: 'block', head: p.head, indices: p.indices, sentBack: true, alreadyUnderChanges: true, labels: resync(p) };
      }
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
      return { ruling: 'block', head: p.head, indices: p.indices, sentBack: true, labels: resync(p) };
    },
  };
}

/** The `run.mjs` table entry: `{declaration, sinks}`. */
export function recordRedTeamRulingEntry() {
  return { declaration: recordRedTeamRulingOperation({ readRulingContext: createRecordRedTeamRulingReader() }),
    sinks: createRecordRedTeamRulingSinks() };
}
