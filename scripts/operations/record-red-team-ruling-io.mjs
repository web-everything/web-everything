/**
 * @file scripts/operations/record-red-team-ruling-io.mjs
 * @description Live reader and retry-safe card sink for cap-held operator rulings. IO is injectable.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveResultGateState, readConfirmedBreaks, readRedTeamDisposition, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { syncRedTeamStatusLabels } from '../lib/red-team-status-labels.mjs';
import { resolveCardRef } from './record-referral-ruling-io.mjs';
import { CARD_REF_RE, readCardAtPrHead, referralCardReadable } from '../lib/referral-card-readable.mjs';
import { trackingRefspec } from '../lib/git-transport-branch.mjs';
import { assertHumanOperator, isHumanOperatorComment, operatorBoundComments, operatorGhEnv, resolveOperatorIdentity } from '../lib/operator-identity.mjs';
import { automationStateRoot } from '../lib/automation-home.mjs';
import { defaultSpawnDetached } from './detached-dispatch.mjs';
import { preventionCardLandingLogPath, spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';
import { buildGateComment } from './red-team-gate-apply.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { CARD_PENDING_OUTCOME, conflictingPendingCardJobs, hasPendingCardIntent, OPERATOR_CARD_OUTCOME, RED_TEAM_RULING_CARD_EFFECT, buildRuleReasonComment, recordRedTeamRulingOperation, rulableBreaks } from './record-red-team-ruling.mjs';

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

/**
 * A local, atomic claim per card job, in numbered GENERATIONS (`<key>.<n>.claim`, each made with `wx`). Taking over an
 * expired claim means creating generation n+1, which only one caller can do. A validated `.spawned` receipt
 * proves only the child start; the child writes `.completed` after the card exists or is durably spooled.
 * Neither a PID nor the landing log alone permits release.
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
  const receipt = (key, suffix, expected) => {
    try {
      const saved = JSON.parse(readFileSync(join(dir, `${key}.${suffix}`), 'utf8'));
      if (!expected?.head || saved.head !== expected.head || saved.session !== expected.session
        || saved.session !== `red-team-ruling-card-${key}` || !Number.isFinite(saved.at) || saved.at < 0) return null;
      return saved;
    } catch { return null; } // Missing, unreadable, partial and legacy unbound receipts prove nothing.
  };
  return {
    hasClaim(key) {
      try { return latest(key).gen >= 0; }
      catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
    },
    claim(key) {
      mkdirSync(dir, { recursive: true });
      const cur = latest(key);
      if (cur.gen < 0 && make(key, 0)) return { created: true, gen: 0, at: nowMs() };
      const seen = latest(key);
      return { created: false, gen: seen.gen, at: seen.at };
    },
    /** Take over the claim observed at `gen`. Exactly one caller wins generation gen+1. */
    reclaim(key, gen) { return make(key, gen + 1); },
    /** Reserve the entire selection under one lock and in one file. Legacy per-break claims still bind.
     * A rejected selection writes nothing, so it cannot strand its otherwise unowned breaks. */
    claimBreak(breakKey, jobKey, breakKeys = [breakKey]) {
      mkdirSync(dir, { recursive: true });
      const lock = join(dir, 'break-selection.lock');
      try { mkdirSync(lock); }
      catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        throw new Error('break selection is locked; retry later. If it persists, verify no ruling invocation is running before removing break-selection.lock from the claims directory');
      }
      try {
        const keys = [...new Set(breakKeys)].sort();
        if (!keys.includes(breakKey)) throw new Error('break selection does not include the requested break; nothing claimed');
        // Read every owner before writing anything. Corrupt persisted evidence refuses the entire selection.
        for (const key of keys) {
          const f = join(dir, `${key}.break`);
          let text;
          try { text = readFileSync(f, 'utf8'); }
          catch (e) { if (e?.code === 'ENOENT') continue; throw e; }
          const owner = JSON.parse(text).jobKey;
          if (typeof owner !== 'string' || !owner) throw new Error('unreadable legacy break owner; inspect the claims directory before retrying');
          if (owner !== jobKey) return owner;
        }
        for (const name of readdirSync(dir).filter((f) => f.endsWith('.selection'))) {
          const saved = JSON.parse(readFileSync(join(dir, name), 'utf8'));
          if (typeof saved.jobKey !== 'string' || !saved.jobKey || name !== `${saved.jobKey}.selection` || !Array.isArray(saved.keys)
            || !saved.keys.length || saved.keys.some((k) => typeof k !== 'string' || !k)) {
            throw new Error('unreadable break selection; inspect the claims directory before retrying');
          }
          if (saved.jobKey !== jobKey && saved.keys.some((key) => keys.includes(key))) return saved.jobKey;
          if (saved.jobKey === jobKey && JSON.stringify(saved.keys) !== JSON.stringify(keys)) {
            throw new Error('card job already owns a different break selection; retry with its exact selection');
          }
        }
        const f = join(dir, `${jobKey}.selection`);
        try { writeFileSync(f, JSON.stringify({ jobKey, keys, at: nowMs() }), { flag: 'wx' }); }
        catch (e) { if (e?.code !== 'EEXIST') throw e; }
        return jobKey;
      } finally { rmSync(lock, { recursive: true }); }
    },
    spawned(key, expected) {
      const saved = receipt(key, 'spawned', expected);
      return !!saved && /^pid:[1-9]\d*$/.test(saved.handle);
    },
    completed(key, expected) {
      const saved = receipt(key, 'completed', expected);
      return !!saved && cardLandingExists(saved.result);
    },
    markCompleted(key, info) {
      mkdirSync(dir, { recursive: true });
      const temporary = join(dir, `${key}.completed.${process.pid}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify({ ...info, at: nowMs() }));
        renameSync(temporary, join(dir, `${key}.completed`));
      } finally { rmSync(temporary, { force: true }); }
    },
    attempted(key) { return existsSync(join(dir, `${key}.attempt`)); },
    /** Exclusive (`wx`): exactly one invocation ever holds a job's attempt; false when another already does. */
    markAttempt(key) {
      mkdirSync(dir, { recursive: true });
      try { writeFileSync(join(dir, `${key}.attempt`), JSON.stringify({ at: nowMs() }), { flag: 'wx' }); return true; }
      catch (e) { if (e?.code === 'EEXIST') return false; throw e; }
    },
    clearAttempt(key) { rmSync(join(dir, `${key}.attempt`), { force: true }); },
    markSpawned(key, info) { writeFileSync(join(dir, `${key}.spawned`), JSON.stringify({ ...info, at: nowMs() })); },
    now: nowMs,
  };
}

/** The claim key binding ONE break of one result to its card job. PURE. */
export const breakClaimKey = (p, index) => createHash('sha256').update(JSON.stringify(['break-v1', p.repo, Number(p.pr), p.head, p.resultId, Number(index)])).digest('hex').slice(0, 16);

/** How long a claim with no spawned job counts as another invocation still working. */
export const CLAIM_IN_PROGRESS_MS = 120_000;

/** Spawn the landing job under a STABLE session, so the job (and its log) is identified by the ruling, not by a fresh random slug. */
const spawnStableCardJob = (input, session, { jobKey, head }) => {
  const logPath = preventionCardLandingLogPath(session);
  const r = spawnPreventionLandingJob(input, { sessionPrefix: 'red-team-ruling-card',
    spawnDetached: (argv, o) => defaultSpawnDetached([fileURLToPath(import.meta.url), '--land-card-receipt',
      JSON.stringify({ jobKey, head, session }),
      ...argv.slice(1).map((a) => (a.startsWith('--session=') ? `--session=${session}` : a))], { ...o, logPath }) });
  return r.ok ? { ...r, session } : r;
};

export function createRecordRedTeamRulingSinks({ env = process.env, readThread = readLiveThread,
  readStandingRulingScope = standingRulingScope,
  runGit = git, readOnPr = readCardAtPrHead,
  resolveCard = card => resolveCardDefault(card, { runGit, readOnPr }),
  resolveIdentity = () => resolveOperatorIdentity({ env }),
  claims = createFileClaims(), fileCard = spawnStableCardJob,
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
      const session = p.session;
      // Observe the prior thread and local evidence BEFORE creating any claim or writing an intent.
      const hasIntent = hasPendingCardIntent(comments, p);
      if (hasIntent && !claims.hasClaim(p.jobKey) && !claims.attempted(p.jobKey)
        && !claims.spawned(p.jobKey, p) && !claims.completed(p.jobKey, p)) {
        throw new Error(`card job ${p.jobKey} already has a trusted pending intent but no local claim, attempt, spawn or completion evidence; nothing written. `
          + `Check the landing log for session ${session}; recover the owed card and re-run citing its readable --card reference`);
      }
      // 0. Each selected BREAK belongs to at most one card job (atomic, local): an overlapping concurrent selection loses.
      const breakKeys = p.indices.map((i) => breakClaimKey(p, i));
      const owners = p.indices.map((i, n) => ({ i, owner: claims.claimBreak(breakKeys[n], p.jobKey, breakKeys) })).filter((o) => o.owner !== p.jobKey);
      if (owners.length) {
        throw new Error(`break(s) ${owners.map((o) => `#${o.i}`).join(', ')} already belong to another card job (${[...new Set(owners.map((o) => o.owner || 'unreadable'))].join(', ')}); `
          + 'nothing written — re-run with that job\'s exact --break selection');
      }
      // 1. Serialize: one atomic claim per (PR, head, result, breaks); taking over an expired one is atomic too.
      const claim = claims.claim(p.jobKey);
      const completed = claims.completed(p.jobKey, p);
      const spawned = claims.spawned(p.jobKey, p) || completed;
      if (!claim.created && !spawned) {
        if (claims.now() - claim.at < CLAIM_IN_PROGRESS_MS) {
          throw new Error(`another invocation holds the claim for job ${p.jobKey} and has not spawned it yet; wait ${Math.round(CLAIM_IN_PROGRESS_MS / 1000)}s and re-run`);
        }
        if (!claims.reclaim(p.jobKey, claim.gen)) throw new Error(`another invocation just took over the claim for job ${p.jobKey}; re-run later`);
      }
      // 2. The bare intent marker, BEFORE the spawn (no action line, so the hold stands). Written once per job.
      if (!hasIntent) post(p.repo, p.pr, intentBody(p));
      // 3. Spawn exactly once: a job with a spawn receipt is reconciled, never spawned again.
      let card = { ok: true, session };
      if (!spawned) {
        // AT MOST ONCE: an attempt marker is written BEFORE the spawn and cleared only when the spawn reported that it
        // did not start. A marker with no receipt means a child MAY be running (a crash between the spawn and the
        // receipt), so a re-run refuses instead of spawning a second filing.
        if (claims.attempted(p.jobKey) || !claims.markAttempt(p.jobKey)) {
          throw new Error(`an earlier attempt of card job ${p.jobKey} may have started its landing job (no spawn receipt was recorded); nothing written. `
            + `Check the landing log for session ${session}; recover the owed card and cite its readable --card reference if the job failed`);
        }
        card = fileCard(p.cardInput, session, p);
        if (!card?.ok) {
          claims.clearAttempt(p.jobKey); // the spawn itself reported no child
          throw new Error(`the follow-up card was not queued (${card?.error ?? 'unknown'}); the intent is recorded and a re-run retries the same job`);
        }
        // The proof of a spawn is the child's confirmed start (a pid), recorded durably; the job's log file proves nothing.
        if (!/^pid:[1-9]\d*$/.test(String(card.handle ?? ''))) throw new Error('the landing job reported no confirmed child start; not recorded as spawned, and not retried automatically (a child may be running)');
        claims.markSpawned(p.jobKey, { head: p.head, session, handle: card.handle });
      }
      // A PID proves only a start: acquire/file-item can still fail before a card reaches the spool.
      // Keep the attempt/receipt intact so an exact retry observes completion without a second spawn.
      if (!claims.completed(p.jobKey, p)) {
        return { ruling: 'card', head: p.head, indices: p.indices, pending: true, released: false,
          card: { session, reconciled: spawned },
          message: `No card completion receipt yet; the break stays held. Re-run the exact ruling to check again. If it persists, inspect the landing log for session ${session}; if the job failed, recover the owed card and cite its readable --card reference. Keep the attempt marker to prevent duplicate automatic filings.` };
      }
      // 4. Release only with positive child evidence that the card exists or is durably spooled.
      const record = buildGateComment({ pr: p.pr, head: p.head, outcome: OPERATOR_CARD_OUTCOME, round: null, result: p.resultId,
        plan: { sendBack: [], card: p.findings, advisory: [] }, cardResult: card });
      post(p.repo, p.pr, reasonBody(p, `Follow-up card queued through the prevention landing job (${session}); filing may be paused, in which case it is owed in the spool.`));
      recheck(p, 'card queued and reason posted; no release record written');
      post(p.repo, p.pr, record);
      proveReleased(p, 'the operator-card record', record);
      return { ruling: 'card', head: p.head, indices: p.indices, card: { session, reconciled: spawned }, labels: resync(p) };
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
export async function runCardLandingWithReceipt(binding, argv, { claims = createFileClaims(),
  land = async (args) => (await import('./land-prevention-card.mjs')).runLandPreventionCardCli(args) } = {}) {
  const landed = await land(argv);
  if (landed.code === 0 && cardLandingExists(landed.result)) {
    claims.markCompleted(binding.jobKey, { head: binding.head, session: binding.session, result: landed.result });
  }
  return landed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--land-card-receipt') {
  const { code } = await runCardLandingWithReceipt(JSON.parse(process.argv[3]), process.argv.slice(4));
  process.exitCode = code;
}
