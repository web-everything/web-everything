/** R375: read-only shadow of a human hold whose sole cause was a referral.
 * Independent hold evidence must be supplied by a trusted persisted-state reader;
 * a referral comment alone cannot establish the absence of other hold causes.
 */
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL, URL } from 'node:url';
import { NEGOTIATION_ROUND_CAP, requiresMandatoryReferral } from '../lib/jury-core.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { appendDaemonEvent, daemonEventsPath } from '../lib/daemon-events.mjs';
import { resolveCascade, logCascadeSources, platformPreference } from '../lib/policy-cascade.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { defaultListPrComments } from './pr-comments-list.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { readReviewRunEvidence, decideReferralHold, decideSameHeadHold, verdictNeverLanded } from './review-referral-hold.mjs';
import { sharedRunsDir, tryReadRun } from '../operations/run-store.mjs';
import { resolve } from 'node:path';
import { defaultReadRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { feedPath, parseFeedLine, unacknowledged } from '../operations/needs-you-feed.mjs';

const SETTING = new URL('../settings/stale-referral-human-shadow.json', import.meta.url);
const SHA = /^[a-f0-9]{40}$/;
const isPlainObject = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Do not let normalization discard incomplete findings and imply that no referral is owed.
const isReadableFinding = value => isPlainObject(value)
  && typeof value.summary === 'string' && value.summary.trim().length > 0
  && typeof value.verdict === 'string' && typeof value.impactIfUnfixed === 'string'
  && (!Object.hasOwn(value, 'category') || typeof value.category === 'string')
  && (!Object.hasOwn(value, 'lens') || typeof value.lens === 'string')
  && (!Object.hasOwn(value, 'security') || typeof value.security === 'boolean');
// Keep the event name assembled separately from any operational command vocabulary.
const EVENT_KIND = ['would', 'clear', 'human', 'hold'].join('-');
const CAUSES = ['round-cap', 'block-ruling', 'requested-changes', 'red-team-blocked', 'draft',
  'merge-conflict', 'required-checks', 'escalation', 'needs-you', 'operator-ruling-needed',
  'no-verdict', 'same-head-hold', 'security-finding', 'mandatory-referral-finding', 'advisory-push'];
const KNOWN_LABELS = new Set(['review:human', 'review:changes', 'review:needed', 'review:accepted',
  'red-team:blocked', 'red-team:passed', 'needs-you', 'operator-ruling-needed', 'escalation',
  'advisory:changes', 'advisory:accept', 'advisory:needs-human', 'review:no-verdict', 'review:same-head-hold',
  // Benign status markers (not hold causes): a panel not yet run, a clean red team, the awaiting-review status.
  'status:awaiting-review', 'red-team:pending', 'red-team:clear']);

/** Pure cascade when layers are supplied; the standalone resolver reads only its tool setting. */
export function resolveStaleReferralHumanShadow({ env = process.env, tool, platform } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFileSync(SETTING, 'utf8')); }
    catch (error) {
      // A missing file uses the documented default; an unreadable configured file disables evaluation.
      tool = error.code === 'ENOENT' ? {} : { staleReferralHumanShadow: { enabled: false } };
    }
  }
  const raw = env.WE_STALE_REFERRAL_HUMAN_SHADOW;
  return resolveCascade({ standard: { enabled: true },
    platform: platform?.staleReferralHumanShadow ?? platform,
    tool: tool?.staleReferralHumanShadow,
    envValues: { enabled: raw === '0' ? false : raw === '1' ? true : undefined },
    valid: { enabled: value => typeof value === 'boolean' } });
}

const effective = options => options.settings ?? resolveStaleReferralHumanShadow(options);
const absentReader = name => () => { throw new Error(`${name} unavailable; operator must inspect the hold`); };

/** No writes, events, network, or implicit inference of persisted hold provenance. Readers may be async. */
export async function decideStaleReferralHumanHold(pr, options = {}) {
  const decision = { wouldClear: false, head: null, referral: null, why: '', checked: [] };
  const add = (cause, status, detail) => decision.checked.push({ cause, status, detail });
  const check = (cause, known, present, detail) => add(cause, !known ? 'unknown' : present ? 'present' : 'absent', detail);
  try {
    if (effective(options)?.value?.enabled !== true) { decision.why = 'shadow disabled'; return decision; }
    const repo = options.repo ?? pr?.repo;
    const head = SHA.test(pr?.headRefOid ?? '') ? pr.headRefOid : null;
    decision.head = head;
    check('head', !!head, false, head ? 'live head readable' : 'live head unavailable');
    const labels = Array.isArray(pr?.labels) ? pr.labels.map(l => typeof l === 'string' ? l : l?.name) : null;
    const labelsKnown = !!labels && labels.every(l => typeof l === 'string'
      && (KNOWN_LABELS.has(l) || /^review-round:\d+$/.test(l)));
    check('labels', labelsKnown, false, labelsKnown ? 'all labels recognized' : 'missing or unknown label; operator inspection required');
    const has = label => labels?.includes(label) === true;
    check('human-label', !!labels, !has('review:human'), has('review:human') ? 'human hold present' : 'no human hold to evaluate');
    check('subject', typeof repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repo)
      && Number.isInteger(pr?.number) && pr.number > 0, false, 'repository and PR identity required');

    const read = async (cause, reader) => {
      try { return await reader(pr, { repo, pr: pr?.number, cardReadable: options.cardReadable }); }
      catch (error) { add(cause, 'unknown', `${cause} unreadable: ${String(error?.message ?? error)}`); return null; }
    };
    const evidence = await read('hold-evidence', options.readHoldEvidence ?? absentReader('persisted hold evidence'));
    const required = await read('required-checks', options.readRequiredChecks ?? absentReader('required check names'));
    let live = null;
    if (Array.isArray(pr?.comments) && (pr.comments.length < 100 || pr.commentsComplete === true)
      && pr.comments.every(c => typeof c?.body === 'string')) {
      live = await read('referral-state', options.readReferralState ?? liveReferralState);
    }
    const liveKnown = !!live && typeof live.malformed === 'boolean' && !live.malformed
      && ['records', 'pending', 'blocked', 'operatorRulings', 'pendingReasons'].every(k => Array.isArray(live[k]))
      && !live.pendingReasons.some(r => /malformed|unavailable|wrong-subject/.test(r));
    check('referral-state', liveKnown, liveKnown && live.pending.length > 0,
      liveKnown ? (live.pending.length ? 'live referral still pending' : 'live referrals readable and none pending')
        : 'referral evidence missing or malformed; operator inspection required');
    check('block-ruling', liveKnown, liveKnown && live.blocked.length > 0,
      liveKnown ? (live.blocked.length ? 'live-head block ruling' : 'no live-head block ruling') : 'cannot read live-head rulings');
    const provenance = evidence?.cause === 'referral' && SHA.test(evidence?.head ?? '')
      && typeof evidence.runId === 'string' && typeof evidence.key === 'string';
    const record = provenance && liveKnown ? live.records.find(r => r.repo === repo && r.pr === pr.number
      && r.head === evidence.head && r.runId === evidence.runId
      && r.referrals?.some(f => f.key === evidence.key)) : null;
    check('referral-provenance', !!record, false, record ? 'persisted hold identifies a recorded referral'
      : 'no readable referral provenance; operator inspection required');
    if (record) {
      const f = record.referrals.find(f => f.key === evidence.key);
      decision.referral = `${record.runId}/${f.key}/${f.finding?.file ?? '?'}:${f.finding?.line ?? '?'}`;
      decision.why = record.head !== head ? 'head-moved-past' : 'ruled';
    }

    const roundLabels = (labels ?? []).filter(l => /^review-round:\d+$/.test(l)).map(l => Number(l.split(':')[1]));
    check('round-cap', Number.isInteger(evidence?.round) && evidence.round >= 0,
      Math.max(evidence?.round ?? 0, ...roundLabels) >= NEGOTIATION_ROUND_CAP, 'negotiation round compared with shared round cap');
    const reviewsKnown = Array.isArray(pr?.reviews) && pr.reviews.every(r =>
      ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(r?.state));
    check('requested-changes', has('review:changes') || reviewsKnown,
      has('review:changes') || pr?.reviews?.some(r => r.state === 'CHANGES_REQUESTED'), 'label and submitted reviews checked');
    check('red-team-blocked', labelsKnown, has('red-team:blocked'), 'red team label checked');
    check('draft', typeof pr?.isDraft === 'boolean', pr?.isDraft === true, 'draft status checked');
    check('merge-conflict', ['MERGEABLE', 'CONFLICTING'].includes(pr?.mergeable), pr?.mergeable === 'CONFLICTING', 'mergeability must be known');

    const rollup = pr?.statusCheckRollup;
    const requiredKnown = Array.isArray(required) && required.every(n => typeof n === 'string' && n.length > 0)
      && Array.isArray(rollup);
    let missing = !requiredKnown, checkPresent = false;
    if (requiredKnown) for (const name of required) {
      const matches = rollup.filter(c => (c?.name ?? c?.context) === name);
      if (!matches.length) { missing = true; continue; }
      for (const c of matches) {
        if (c.state !== undefined) {
          if (!['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'].includes(c.state)) missing = true;
          else if (c.state !== 'SUCCESS') checkPresent = true;
        } else if (['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'].includes(c.status)) checkPresent = true;
        else if (c.status !== 'COMPLETED' || typeof c.conclusion !== 'string') missing = true;
        else if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)) checkPresent = true;
      }
    }
    check('required-checks', !missing, checkPresent, missing ? 'required check policy or result missing; operator inspection required'
      : checkPresent ? 'required check failing or pending' : 'every required check successful');

    const bool = (cause, field, label) => check(cause, has(label) || typeof evidence?.[field] === 'boolean',
      has(label) || evidence?.[field] === true, `${field} persisted evidence and label checked`);
    bool('needs-you', 'needsYou', 'needs-you');
    bool('operator-ruling-needed', 'operatorRulingNeeded', 'operator-ruling-needed');
    bool('no-verdict', 'noVerdict', 'review:no-verdict');
    bool('same-head-hold', 'sameHeadHold', 'review:same-head-hold');
    const escalationsKnown = Array.isArray(evidence?.escalations) && evidence.escalations.every(e => SHA.test(e?.head ?? ''));
    check('escalation', has('escalation') || escalationsKnown,
      has('escalation') || evidence?.escalations?.some(e => e.head === head), 'live-head escalations checked');
    const findingsKnown = Array.isArray(evidence?.findings)
      && evidence.findings.every(f => isReadableFinding(f) && SHA.test(f.head ?? ''));
    const findings = findingsKnown ? evidence.findings.filter(f => f.head === head) : [];
    check('security-finding', findingsKnown, findings.some(f => f.lens === 'security' || f.security === true), 'independent live-head security findings checked');
    check('mandatory-referral-finding', findingsKnown, findings.some(requiresMandatoryReferral), 'independent live-head mandatory referral findings checked');
    check('advisory-push', has('advisory:changes') || findingsKnown,
      has('advisory:changes') || findings.some(f => f.advisory === true && f.requiresPush === true), 'advisory findings requiring a push checked');
    decision.wouldClear = decision.checked.every(c => c.status === 'absent');
    if (!decision.wouldClear) decision.why = decision.checked.find(c => c.status !== 'absent')?.detail ?? 'hold retained';
  } catch (error) {
    add('evaluation', 'unknown', `evaluation incomplete: ${String(error?.message ?? error)}; operator inspection required`);
    decision.why = 'evaluation incomplete';
  }
  // Even a failed reader leaves an explicit entry for every independent cause.
  if (decision.why !== 'shadow disabled') for (const cause of CAUSES) {
    if (!decision.checked.some(c => c.cause === cause)) add(cause, 'unknown', 'evidence unavailable; operator inspection required');
  }
  decision.wouldClear = decision.wouldClear && decision.checked.every(c => c.status === 'absent');
  return decision;
}

/** Read backwards with bounded memory. Long lines are retained only as a partial, unparsable row. */
async function lastEventLines(path) {
  let file;
  try {
    file = await open(path, 'r');
    let position = (await file.stat()).size;
    let tail = '';
    while (position > 0 && tail.split('\n').length <= 201) {
      const size = Math.min(position, 65536);
      position -= size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, position);
      if (bytesRead !== size) throw new Error('event log changed during read');
      tail = buffer.toString('utf8') + tail;
      if (tail.length > 4 * 1024 * 1024) throw new Error('event tail exceeds bound; operator inspection required');
    }
    if (position > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    return tail.replace(/\n$/, '').split('\n').slice(-200);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  finally { await file?.close(); }
}

/** Serialize local emitters so concurrent evaluations in one process also deduplicate. */
let eventQueue = Promise.resolve();
export function emitShadowEvent(decision, pr, options = {}) {
  const emit = async () => {
    try {
      if (effective(options)?.value?.enabled !== true || decision?.wouldClear !== true) return false;
      const repo = options.repo ?? pr?.repo;
      if (!repo || !pr?.number || !decision.head || !decision.referral) return false;
      const lines = await lastEventLines(daemonEventsPath(options));
      const duplicate = lines.some(line => {
        try {
          const event = JSON.parse(line);
          return event.kind === EVENT_KIND && event.repo === repo && event.pr === pr.number
            && event.detail?.head === decision.head && event.detail?.referral === decision.referral;
        } catch { return false; }
      });
      if (duplicate) return false;
      const { head, referral, why, checked } = decision;
      return await appendDaemonEvent({ kind: EVENT_KIND, repo, pr: pr.number,
        daemon: 'review', detail: { head, referral, why, checked } }, options);
    } catch { return false; }
  };
  const result = eventQueue.then(emit, emit);
  eventQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** CLI IO only: do not migrate runs or write the projection cache during a shadow read. */
function readShadowRuns() {
  const dir = process.env.OPERATION_RUNS_DIR?.trim()
    ? resolve(process.env.OPERATION_RUNS_DIR.trim()) : sharedRunsDir();
  return readReviewRunEvidence({ dir, persist: false, readRun: (id) => {
    const run = tryReadRun(id, dir);
    if (!run) throw new Error('durable review run unreadable; operator inspection required');
    return run;
  } });
}

function readShadowRun(id) {
  const dir = process.env.OPERATION_RUNS_DIR?.trim()
    ? resolve(process.env.OPERATION_RUNS_DIR.trim()) : sharedRunsDir();
  return tryReadRun(id, dir);
}

function readShadowAttention() {
  const path = feedPath();
  // The shared replay tolerates absent files and bad lines for display. Neither proves absence here.
  const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim());
  if (lines.some(line => !parseFeedLine(line))) throw new Error('needs-you feed incomplete; operator inspection required');
  return unacknowledged({ path });
}

/** Injectable production adapter, used by the CLI only. Missing sources leave fields omitted. */
export function createLiveShadowReaders({ repo, gh, readRuns = readShadowRuns, readRun = readShadowRun,
  readAttention = readShadowAttention, readRequired = defaultReadRequiredStatusChecks,
  referralHold = decideReferralHold, sameHeadHold = decideSameHeadHold,
  now = Date.now(), env = process.env } = {}) {
  const safely = async reader => { try { return await reader(); } catch { return undefined; } };
  // Share local scans and policy reads across the bounded PR list; never cache a fabricated empty result.
  let runsPromise, attentionPromise;
  const policies = new Map();
  return {
    readRequiredChecks: async pr => {
      if (typeof pr.baseRefName !== 'string' || !pr.baseRefName) return undefined;
      if (!policies.has(pr.baseRefName)) policies.set(pr.baseRefName, safely(() => readRequired({
        repo, branch: pr.baseRefName, gh: argv => JSON.stringify(gh(argv)),
      })));
      return policies.get(pr.baseRefName);
    },
    readHoldEvidence: async (pr, context = {}) => {
      const evidence = {};
      const labels = Array.isArray(pr.labels) ? pr.labels.map(l => typeof l === 'string' ? l : l?.name) : null;
      const labelsKnown = labels?.every(l => typeof l === 'string');
      const has = label => labels?.includes(label) === true;
      const rounds = labels?.filter(l => /^review-round:\d+$/.test(l)).map(l => Number(l.split(':')[1]));
      if (rounds?.length && rounds.every(Number.isSafeInteger)) evidence.round = Math.max(...rounds);
      const attention = await (attentionPromise ??= safely(readAttention));
      if (Array.isArray(attention) && attention.every(e => typeof e?.repo === 'string'
        && Number.isInteger(e.pr) && SHA.test(e.head ?? '') && typeof e.kind === 'string') && labelsKnown) {
        const items = attention.filter(e => e.repo === repo && e.pr === pr.number && e.head === pr.headRefOid);
        evidence.needsYou = has('needs-you') || items.some(e => e.kind === 'needs-you');
        evidence.operatorRulingNeeded = has('operator-ruling-needed') || items.some(e => e.kind === 'ruling-needed');
        evidence.escalations = items.filter(e => !['needs-you', 'ruling-needed'].includes(e.kind));
        if (has('escalation')) evidence.escalations.push({ head: pr.headRefOid });
      }
      const runs = await (runsPromise ??= safely(readRuns));
      if (!Array.isArray(runs)) return evidence;
      const history = runs.filter(r => r.repo === repo && r.pr === pr.number);
      const live = await safely(() => liveReferralState(pr, { ...context, repo, pr: pr.number }));
      const parked = history.filter(r => r.parked && r.attempted && !r.persistenceFailed)
        .sort((a, b) => b.completedAt - a.completedAt);
      // A comment identifies the finding only after independent durable evidence pins the parked run.
      const source = parked.find(r => live?.records?.some(record => record.runId === r.id
        && record.head === r.head && record.repo === repo && record.pr === pr.number
        && record.referrals.some(f => r.pending?.includes(f.key))));
      if (source) {
        const record = live.records.find(r => r.runId === source.id && r.head === source.head
          && r.repo === repo && r.pr === pr.number);
        Object.assign(evidence, { cause: 'referral', head: source.head, runId: source.id,
          key: record.referrals.find(f => source.pending.includes(f.key)).key });
      }
      if (labelsKnown && history.length) {
        const opts = { ...context, repo, now, env };
        const hold = await safely(() => referralHold(pr, runs, opts));
        const same = await safely(() => sameHeadHold(pr, runs, opts));
        // The production same-head guard yields to a released referral. Establish that release explicitly.
        const released = source?.head === pr.headRefOid && !live?.malformed && live?.pending?.length === 0
          && live?.pendingReasons?.length === 0 && hold === null;
        if (same !== undefined && hold !== undefined) evidence.sameHeadHold = !released && same !== null;
        const current = history.filter(r => r.head === pr.headRefOid)
          .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))[0];
        if (current) evidence.noVerdict = has('review:no-verdict') || verdictNeverLanded(pr, current, now);
      }
      const current = history.filter(r => r.head === pr.headRefOid)
        .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))[0];
      if (current && !current.incomplete) {
        const run = await safely(() => readRun(current.id));
        const read = run?.findings?.read;
        const final = run?.findings?.referralVerdict;
        if (run?.id === current.id && read?.repo === repo && Number(read.pr) === pr.number
          && read?.netBasis?.rev === pr.headRefOid && Array.isArray(final?.findings)
          && Array.isArray(final?.deferredAdvisory)
          && [...final.findings, ...final.deferredAdvisory].every(isReadableFinding)) {
          evidence.findings = [...final.findings, ...final.deferredAdvisory].map(f => ({ ...f,
            head: pr.headRefOid, ...(typeof f.category === 'string' && /^security(?:\/|$)/i.test(f.category)
              ? { security: true } : {}) }));
        }
      }
      return evidence;
    },
  };
}

/** Cursor-paged discovery uses the ordinary repository connection, never the search index.
 * Every page and selected PR view goes through the caller's shared tick budget.
 */
export function* readHumanHoldPrs({ repo, gh, selected }) {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$cursor:String) {
    repository(owner:$owner,name:$name) {
      pullRequests(first:100,states:OPEN,after:$cursor) {
        nodes { number labels(first:100) { nodes { name } pageInfo { hasNextPage } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  let cursor;
  const seen = new Set();
  for (;;) {
    const argv = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
    if (cursor) argv.push('-f', `cursor=${cursor}`);
    const response = gh(argv);
    const page = response?.data?.repository?.pullRequests;
    if (response?.errors || !Array.isArray(page?.nodes) || page.nodes.length > 100
      || typeof page.pageInfo?.hasNextPage !== 'boolean'
      || page.nodes.some(pr => !Number.isInteger(pr?.number) || pr.number <= 0
        || !Array.isArray(pr.labels?.nodes) || pr.labels.pageInfo?.hasNextPage !== false
        || pr.labels.nodes.some(label => typeof label?.name !== 'string'))) {
      throw new Error('PR list or labels unreadable; operator inspection required');
    }
    const next = page.pageInfo.endCursor;
    if (page.pageInfo.hasNextPage && (typeof next !== 'string' || !next || seen.has(next))) {
      throw new Error('PR pagination incomplete; operator must inspect remaining human holds');
    }
    for (const listed of page.nodes.filter(p => p.labels.nodes.some(label => label.name === 'review:human')
      && (!selected || selected.includes(p.number)))) {
      const pr = gh(['pr', 'view', String(listed.number), '--repo', repo, '--json',
        'number,headRefOid,baseRefName,labels,isDraft,mergeable,statusCheckRollup,body,createdAt,reviews']);
      if (pr?.number !== listed.number) throw new Error('PR view unreadable; operator inspection required');
      yield pr;
    }
    if (!page.pageInfo.hasNextPage) return;
    seen.add(next);
    cursor = next;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--live') || args.some(a => !/^(--live|--dry|--repo=[\w.-]+\/[\w.-]+|--pr=\d+(,\d+)*)$/.test(a))) {
    throw new Error('usage: stale-referral-human-shadow.mjs --live [--repo=owner/name] [--pr=N,N] [--dry]');
  }
  const repo = args.find(a => a.startsWith('--repo='))?.slice(7) ?? CONSTELLATION_REPOS.we.slug;
  const settings = resolveStaleReferralHumanShadow({ platform: platformPreference('staleReferralHumanShadow') });
  logCascadeSources('staleReferralHumanShadow', settings);
  if (!settings.value.enabled) return;
  const selected = args.find(a => a.startsWith('--pr='))?.slice(5).split(',').map(Number);
  let remainingCalls = 128;
  const gh = argv => {
    if (remainingCalls-- <= 0) throw new Error('GitHub read budget exhausted; operator inspection required');
    return JSON.parse(execFileSyncThrottled('gh', argv,
      { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
  };
  const readers = createLiveShadowReaders({ repo, gh });
  for (const pr of readHumanHoldPrs({ repo, gh, selected })) {
    try {
      pr.comments = defaultListPrComments({ number: pr.number, repo, gh, maxPages: 10 });
      pr.commentsComplete = true;
    } catch { pr.comments = undefined; }
    const decision = await decideStaleReferralHumanHold(pr, { repo, settings, ...readers });
    const reason = decision.wouldClear ? decision.why
      : decision.checked.find(c => c.status !== 'absent')?.detail ?? decision.why;
    console.log(`${pr.number} wouldClear=${decision.wouldClear} ${String(reason).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`);
    if (!args.includes('--dry')) await emitShadowEvent(decision, pr, { repo, settings });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')); process.exitCode = 1; });
}
