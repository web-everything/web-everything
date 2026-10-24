/**
 * @file scripts/operations/record-red-team-ruling-io.mjs
 * @description Live reader and retry-safe card sink for cap-held operator rulings. IO is injectable.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveResultGateState, readConfirmedBreaks, readRedTeamDisposition, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { syncRedTeamStatusLabels } from '../lib/red-team-status-labels.mjs';
import { resolveCardRef } from './record-referral-ruling-io.mjs';
import { CARD_REF_RE, readCardAtPrHead, referralCardReadable } from '../lib/referral-card-readable.mjs';
import { trackingRefspec } from '../lib/git-transport-branch.mjs';
import { assertHumanOperator, isHumanOperatorComment, operatorBoundComments, operatorGhEnv, resolveOperatorIdentity } from '../lib/operator-identity.mjs';
import { createActionStore } from './action-store.mjs';
import { cardBatchStateDir } from './card-batch-io.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { defaultSpawnDetached } from './detached-dispatch.mjs';
import { preventionCardLandingLogPath, spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';
import { buildGateComment } from './red-team-gate-apply.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { CARD_PENDING_OUTCOME, conflictingPendingCardJobs, hasPendingCardIntent, OPERATOR_CARD_OUTCOME, RED_TEAM_RULING_CARD_EFFECT, buildRuleReasonComment, recordRedTeamRulingOperation, rulingCardResource, rulableBreaks } from './record-red-team-ruling.mjs';

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

const git = args => {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error('could not read the published backlog on origin/main');
  return String(r.stdout ?? '');
};

/** Unsuffixed references mean published on main, never the feature checkout. Each resolution (including
 * the final sink recheck) fetches afresh; failed refreshes cannot fall back to stale local evidence.
 * Open-PR cards require the explicit @pr<N> form and retain the shared PR-state/readability checks. */
const resolveCardDefault = (card, { runGit = git, readOnPr = readCardAtPrHead } = {}) => {
  let attempted = false, fetchError;
  const main = args => {
    if (!attempted) {
      attempted = true;
      try { runGit(['fetch', '--no-tags', '--quiet', 'origin', trackingRefspec('main')]); }
      catch (e) { fetchError = e; }
    }
    if (fetchError) throw fetchError;
    return runGit(args);
  };
  const listFiles = () => main(['ls-tree', '--name-only', 'origin/main:backlog']).split('\n')
    .filter(file => CARD_REF_RE.test(`we:backlog/${file}`) && !file.includes('@'));
  const readText = path => main(['show', `origin/main:backlog/${basename(path)}`]);
  const hasFrontmatter = text => /^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(text);
  const readable = ref => {
    if (!CARD_REF_RE.test(ref)) return false;
    if (/@pr\d+$/.test(ref)) return referralCardReadable(ref, REPO_ROOT, { readOnPr });
    try { return hasFrontmatter(readText(ref)); }
    catch {
      // Preserve references to provisional cards renumbered on landing, using only main's content.
      const born = /^we:backlog\/(x[a-z0-9]{6})-/.exec(ref)?.[1];
      if (!born) return false;
      try {
        return listFiles().some(file => {
          if (!/^\d+-/.test(file)) return false;
          const text = readText(file);
          return hasFrontmatter(text) && new RegExp(`^bornAs:[ \\t]*["']?${born}["']?[ \\t]*$`, 'm').test(text.split(/\r?\n---\r?\n/)[0]);
        });
      } catch { return false; }
    }
  };
  const result = resolveCardRef(card, { listFiles, readText, readable });
  if (result && !result.readable && !/@pr\d+$/.test(String(card).trim())) {
    result.reason += '; has it landed on main? cite it as we:backlog/<file>.md@pr<N> for a card on an open PR';
  }
  return result;
};

export function createRecordRedTeamRulingReader({ env = process.env, readThread = readLiveThread, readSetting = () => readConfirmedBreaks({ env }),
  readStandingRulingScope = standingRulingScope,
  runGit = git, readOnPr = readCardAtPrHead,
  resolveCard = card => resolveCardDefault(card, { runGit, readOnPr }),
  resolveIdentity = () => resolveOperatorIdentity({ env }), now = () => new Date().toISOString(),
  assertFresh = () => assertOperatorCliFresh(REPO_ROOT, { label: 'record-red-team-ruling', env }) } = {}) {
  return ({ repo, pr, card }) => {
    assertFresh();
    const thread = readThread({ repo, pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    return { head, labels: thread.labels ?? [], comments: thread.comments ?? [],
      standingRuling: readStandingRulingScope({ repo, pr: { ...thread, number: Number(pr), headRefOid: head } }),
      setting: readSetting().value, now: now(), identity: resolveIdentity(),
      card: card === undefined || card === '' ? null : resolveCard(card, { repo, pr, head }) };
  };
}

const CARD_KIND = 'red-team-ruling-card';
const transition = (actions, r, to, patch) => {
  const changed = actions.transition(r.resource, r.attempt, { token: r.ownerToken, rev: r.rev, from: r.state, to, patch });
  if (!changed.ok && changed.reason === 'stale-rev' && r.state === 'dispatching' && to === 'observed') {
    // Parent bookkeeping and child completion may both observe the same dispatch. Reuse only a
    // bound observation by the same owner; completion then uses its fresh revision for the terminal CAS.
    const fresh = actions.read(r.resource, r.attempt);
    if (fresh.ownerToken === r.ownerToken && fresh.rev > r.rev && bound(fresh, r.evidence)
      && fresh.handle === r.evidence.session && (fresh.state === 'observed' || completion(fresh, r.evidence))) return fresh;
  }
  if (!changed.ok) throw new Error(`card claim transition refused (${changed.reason}); inspect the shared coordination record before retrying`);
  return changed.record;
};
const bound = (r, p) => r.kind === CARD_KIND && r.evidence?.head === p.head
  && r.evidence?.jobKey === p.jobKey && r.evidence?.session === p.session
  && p.session === `red-team-ruling-card-${p.jobKey}`;
const landingRef = result => /^backlog\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(result?.rel ?? '') ? `we:${result.rel}` : undefined;
const completion = (r, p) => bound(r, p) && r.state === 'terminal' && r.outcome === 'settled'
  && r.evidence.card?.session === p.session && r.evidence.card?.ref === landingRef(r.evidence.result)
  && Number.isFinite(r.evidence?.at) && r.evidence.at >= 0 && cardLandingExists(r.evidence.result);

/** Spawn the landing job under a STABLE session, so the job (and its log) is identified by the ruling, not by a fresh random slug. */
const spawnStableCardJob = (input, session, binding) => {
  const logPath = preventionCardLandingLogPath(session);
  const r = spawnPreventionLandingJob(input, { sessionPrefix: 'red-team-ruling-card',
    spawnDetached: (argv, o) => defaultSpawnDetached([fileURLToPath(import.meta.url), '--land-card-receipt',
      JSON.stringify(binding),
      ...argv.slice(1).map((a) => (a.startsWith('--session=') ? `--session=${session}` : a))], { ...o, logPath }) });
  return r.ok ? { ...r, session } : r;
};

export function createRecordRedTeamRulingSinks({ env = process.env, readThread = readLiveThread,
  readStandingRulingScope = standingRulingScope,
  runGit = git, readOnPr = readCardAtPrHead,
  resolveCard = card => resolveCardDefault(card, { runGit, readOnPr }),
  resolveIdentity = () => resolveOperatorIdentity({ env }),
  coordinationRoot = resolveCoordinationRoot(), actions = createActionStore({ root: coordinationRoot }), fileCard = spawnStableCardJob,
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'], body, env),
  syncLabels = ({ repo, pr, head }) => syncRedTeamStatusLabels({ repo, pr, head, env }),
  warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  /** Right before any write: the poster, the head, the SAME result, and every selected break still rulable the same way
   *  the plan found it (the same `rulableBreaks` rule, so the cap and held-break checks apply here too). */
  const recheck = (p, noWrite = 'nothing written') => {
    assertHumanOperator(resolveIdentity(), p.actor);
    const thread = readThread({ repo: p.repo, pr: p.pr });
    const head = String(thread.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`PR #${p.pr}'s head moved to ${head} since the plan (${p.head}); ${noWrite} — re-run against the new head`);
    const comments = operatorBoundComments(thread.comments);
    const standingRuling = readStandingRulingScope({ repo: p.repo, pr: { ...thread, number: p.pr, headRefOid: head } });
    let now;
    try { now = rulableBreaks({ comments, repo: p.repo, labels: thread.labels, pr: p.pr, head, setting: p.setting, standingRuling }); }
    catch (e) { throw new Error(`${e.message}; ${noWrite}`); }
    if (now.state.resultId !== p.resultId) throw new Error(`the red-team result on the live head changed since the plan (${p.resultId} -> ${now.state.resultId}); ${noWrite} — re-run`);
    const rulable = now.rulable.map((f) => f.index);
    const gone = p.indices.filter((i) => !rulable.includes(i));
    if (gone.length) throw new Error(`break(s) ${gone.map((i) => `#${i}`).join(', ')} are no longer held for the operator / rulable (already ruled or carded); ${noWrite}`);
    return { comments, labels: thread.labels ?? [] };
  };
  /** After the write: same head, same result, the record WE wrote is in the thread as a human operator's comment, and
   *  the gate (reading that thread) no longer holds or sends back any selected break. */
  const proveReleased = (p, what, record) => {
    const after = readThread({ repo: p.repo, pr: p.pr });
    const head = String(after.headRefOid ?? '').toLowerCase();
    if (head !== p.head) throw new Error(`${what} was posted but PR #${p.pr}'s head moved to ${head}; the ruling binds to ${p.head} only — inspect and re-run on the new head`);
    const comments = operatorBoundComments(after.comments);
    const standingRuling = readStandingRulingScope({ repo: p.repo, pr: { ...after, number: p.pr, headRefOid: head } });
    if (liveResultGateState(comments, p.pr, head, p.repo, standingRuling).resultId !== p.resultId) throw new Error(`${what} was posted but the live red-team result changed; inspect the thread before retrying`);
    if (record && !comments.some((c) => String(c?.body ?? '').trim() === record.trim() && isHumanOperatorComment(c))) {
      throw new Error(`${what} is not in the read-back as a human operator's comment (altered, or posted as another account); inspect the thread before retrying`);
    }
    const d = readRedTeamDisposition({ comments, repo: p.repo, pr: p.pr, head, setting: p.setting, standingRuling });
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
        // Persist the reason before release: either failed POST leaves the break held and retryable.
        if (!/^we:backlog\/[A-Za-z0-9][A-Za-z0-9._-]*\.md(?:@pr[1-9]\d{0,8})?$/.test(p.cardRef)) throw new Error(`--card resolved to an unsafe reference ${JSON.stringify(p.cardRef)}; nothing written`);
        const record = operatorRecord(p, OPERATOR_CARD_OUTCOME, `- ${p.indices.length} finding(s) carded by the operator to \`${p.cardRef}\` ${indexList(p)}.`);
        post(p.repo, p.pr, reasonBody(p, `Carded to the existing card \`${p.cardRef}\`; no new card is filed.`));
        recheck(p, 'reason posted; no release record written'); // Re-read changes made while posting the reason.
        // The reason POST may outlive the card. Validate the exact planned reference at the release boundary.
        let card;
        try { card = resolveCard(p.cardRef, { repo: p.repo, pr: p.pr, head: p.head }); }
        catch { throw new Error(`--card ${p.cardRef} could not be re-read; reason posted; no release record written`); }
        if (!card?.readable || card.ref !== p.cardRef) {
          throw new Error(`--card ${p.cardRef} no longer resolves to the same readable backlog card (${card?.reason ?? 'unreadable'}); reason posted; no release record written`);
        }
        post(p.repo, p.pr, record);
        proveReleased(p, 'the operator-card record', record);
        return { ruling: 'card', head: p.head, indices: p.indices, card: { ref: p.cardRef }, labels: resync(p) };
      }
      const session = p.session, resource = rulingCardResource(p);
      const hasIntent = hasPendingCardIntent(comments, p);
      const rows = actions.attempts(resource), prior = rows.at(-1);
      // A legacy intent with no shared record is ambiguous: never automatically duplicate its child.
      if (hasIntent && !prior) throw new Error(`trusted pending intent has no shared claim; inspect the landing log for ${session}; recover the owed card and cite its readable --card reference`);
      const settled = rows.findLast(r => r.state === 'terminal' && r.outcome === 'settled');
      let claim = settled ? { ok: false, record: settled } : actions.claim({ resource, kind: CARD_KIND,
        owner: `record-red-team-ruling:${process.pid}`, evidence: { head: p.head, jobKey: p.jobKey, session } });
      // Completion can race the pre-read and claim, allocating an unused next attempt. Never dispatch it.
      if (claim.ok) {
        const finished = actions.attempts(resource).findLast(r => r.attempt !== claim.record.attempt && r.state === 'terminal' && r.outcome === 'settled');
        if (finished) {
          transition(actions, claim.record, 'terminal', { outcome: 'not-started' });
          claim = { ok: false, record: finished };
        }
      }
      let r = claim.record;
      if (!r || !bound(r, p)) throw new Error('card claim binding is unreadable; inspect the shared coordination record before retrying');
      const spawned = !claim.ok;
      if (claim.ok) {
        // Durable per-break reservations also exclude different, overlapping selections.
        const reserved = [];
        for (const index of [...p.indices].sort((a, b) => a - b)) {
          const key = rulingCardResource({ ...p, indices: [index] }, 'break');
          const held = actions.claim({ resource: key, kind: 'red-team-ruling-break', owner: r.owner,
            evidence: { jobKey: p.jobKey } });
          if (held.ok) reserved.push(held.record);
          else if (held.record?.kind !== 'red-team-ruling-break' || held.record?.evidence?.jobKey !== p.jobKey) {
            for (const owned of reserved) actions.release(owned.resource, owned.attempt, { token: owned.ownerToken, rev: owned.rev });
            actions.release(resource, r.attempt, { token: r.ownerToken, rev: r.rev });
            throw new Error('break(s) already belong to another card job; nothing written — retry its exact selection');
          }
        }
        // Fence BEFORE any side effect. Ambiguous spawn failures remain dispatching, never auto-reclaimed.
        r = transition(actions, r, 'dispatching', { dispatchingSince: Date.now() });
        try { if (!hasIntent) post(p.repo, p.pr, intentBody(p)); }
        catch (error) {
          // Even an ambiguously published intent cannot have started a child: fileCard has not run.
          transition(actions, r, 'terminal', { outcome: 'not-started' });
          throw error;
        }
        const card = fileCard(p.cardInput, session, { resource, attempt: r.attempt, ownerToken: r.ownerToken,
          jobKey: p.jobKey, head: p.head, session, coordinationRoot });
        if (!card?.ok) {
          transition(actions, r, 'terminal', { outcome: 'not-started' });
          throw new Error(`the follow-up card was not queued (${card?.error ?? 'unknown'}); retry the same ruling`);
        }
        if (!/^pid:[1-9]\d*$/.test(String(card.handle ?? ''))) throw new Error('the landing job reported no confirmed child start; inspect the landing log and recover with a readable --card reference');
        r = actions.read(resource, r.attempt); // The child may already have recorded completion.
        if (r.state === 'dispatching') r = transition(actions, r, 'observed', { handle: session,
          evidence: { ...r.evidence, card: { session, handle: card.handle } } });
      } else r = actions.read(resource, r.attempt);
      const card = { ok: true, session, reconciled: spawned,
        ...(completion(r, p) && r.evidence.card.ref ? { ref: r.evidence.card.ref } : {}) };
      if (!completion(r, p)) return { ruling: 'card', head: p.head, indices: p.indices, pending: true, released: false, card,
        message: `No validated card completion yet; retry later. If it persists, inspect the landing log for ${session}; recover the owed card and cite its readable --card reference. Do not remove the shared claim.` };
      // 4. Release only with positive child evidence that the card exists or is durably spooled.
      const record = buildGateComment({ pr: p.pr, head: p.head, outcome: OPERATOR_CARD_OUTCOME, round: null, result: p.resultId,
        plan: { sendBack: [], card: p.findings, advisory: [] }, cardResult: card });
      post(p.repo, p.pr, reasonBody(p, `Follow-up card queued through the prevention landing job (${session}); filing may be paused, in which case it is owed in the spool.`));
      recheck(p, 'card queued and reason posted; no release record written');
      // A receipt survives its backing card/spool. Re-read that evidence on every release attempt.
      const result = r.evidence.result, ref = landingRef(result);
      let readable = false;
      try {
        if (ref) {
          const exact = Number.isInteger(result.pr) && result.pr > 0 ? `${ref}@pr${result.pr}` : ref;
          const current = resolveCard(exact, { repo: p.repo, pr: p.pr, head: p.head });
          readable = current?.readable === true && current.ref === exact;
          if (!readable && result.step === 'held') {
            const id = /^backlog\/([^/-]+)-[^/]+\.md$/.exec(result.rel)?.[1];
            if (id) {
              const spool = JSON.parse(readFileSync(join(cardBatchStateDir(env), 'pending-prevention', `${id}.json`), 'utf8'));
              readable = spool.rel === result.rel && spool.cardId === id
                && /^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(spool.content ?? '');
            }
          }
        }
      } catch { readable = false; }
      if (!readable) throw new Error(`card completion evidence no longer resolves to a readable card or spool; no release record written — inspect the landing log for ${session}; recover the owed card and cite its readable --card reference`);
      post(p.repo, p.pr, record);
      proveReleased(p, 'the operator-card record', record);
      return { ruling: 'card', head: p.head, indices: p.indices, card, labels: resync(p) };
    },
  };
}

/** The `run.mjs` table entry: `{declaration, sinks}`. */
export function recordRedTeamRulingEntry() {
  return { declaration: recordRedTeamRulingOperation({ readRulingContext: createRecordRedTeamRulingReader() }),
    sinks: createRecordRedTeamRulingSinks() };
}

/** Accept only landing outcomes reached after filing/spooling or recording an existing card. */
const cardLandingExists = (result) => result?.ok === true && (
  (['held', 'batched', 'done'].includes(result.step) && /^backlog\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(result.rel ?? ''))
  || (['mentioned', 'done'].includes(result.step) && Number.isInteger(result.mentions) && result.mentions > 0));

/** Child-side receipt: a successful spawn never calls this writer in the parent. */
export async function runCardLandingWithReceipt(binding, argv, {
  actions = createActionStore({ root: binding.coordinationRoot ?? resolveCoordinationRoot() }),
  land = async (args) => (await import('./land-prevention-card.mjs')).runLandPreventionCardCli(args) } = {}) {
  const readBound = () => {
    const r = actions.read(binding.resource, binding.attempt);
    if (!bound(r, binding) || r.ownerToken !== binding.ownerToken || !['dispatching', 'observed'].includes(r.state)) {
      throw new Error('landing receipt does not match an active card claim');
    }
    return r;
  };
  readBound(); // Refuse an invalid receipt binding before filing anything.
  const landed = await land(argv);
  if (landed.code === 0 && cardLandingExists(landed.result)) {
    let r = readBound();
    if (r.state === 'dispatching') r = transition(actions, r, 'observed', { handle: binding.session });
    if (!completion(r, binding)) transition(actions, r, 'terminal', { outcome: 'settled',
      evidence: { ...r.evidence, card: { session: binding.session,
        ...(landingRef(landed.result) ? { ref: landingRef(landed.result) } : {}) }, result: landed.result, at: Date.now() } });
  }
  return landed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--land-card-receipt') {
  const { code } = await runCardLandingWithReceipt(JSON.parse(process.argv[3]), process.argv.slice(4));
  process.exitCode = code;
}
