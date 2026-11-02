/** R375: read-only shadow of a human hold whose sole cause was a referral.
 * Independent hold evidence must be supplied by a trusted persisted-state reader;
 * a referral comment alone cannot establish the absence of other hold causes.
 */
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL, URL } from 'node:url';
import { NEGOTIATION_ROUND_CAP } from '../lib/jury-core.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { appendDaemonEvent, daemonEventsPath } from '../lib/daemon-events.mjs';
import { resolveCascade, logCascadeSources, platformPreference } from '../lib/policy-cascade.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { defaultListPrComments } from './pr-comments-list.mjs';

const SETTING = new URL('../settings/stale-referral-human-shadow.json', import.meta.url);
const SHA = /^[a-f0-9]{40}$/;
// Keep the event name assembled separately from any operational command vocabulary.
const EVENT_KIND = ['would', 'clear', 'human', 'hold'].join('-');
const CAUSES = ['round-cap', 'block-ruling', 'requested-changes', 'red-team-blocked', 'draft',
  'merge-conflict', 'required-checks', 'escalation', 'needs-you', 'operator-ruling-needed',
  'no-verdict', 'same-head-hold', 'security-finding', 'mandatory-referral-finding', 'advisory-push'];
const KNOWN_LABELS = new Set(['review:human', 'review:changes', 'review:needed', 'review:accepted',
  'red-team:blocked', 'red-team:passed', 'needs-you', 'operator-ruling-needed', 'escalation',
  'advisory:changes', 'advisory:accept', 'advisory:needs-human', 'review:no-verdict', 'review:same-head-hold']);

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
    const findingsKnown = Array.isArray(evidence?.findings) && evidence.findings.every(f => SHA.test(f?.head ?? ''));
    const findings = findingsKnown ? evidence.findings.filter(f => f.head === head) : [];
    check('security-finding', findingsKnown, findings.some(f => f.lens === 'security' || f.security === true), 'independent live-head security findings checked');
    check('mandatory-referral-finding', findingsKnown, findings.some(f => f.mandatoryReferral === true), 'independent live-head mandatory referral findings checked');
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

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--live') || args.some(a => !/^(--live|--dry|--repo=[\w.-]+\/[\w.-]+|--pr=\d+(,\d+)*)$/.test(a))) {
    throw new Error('usage: stale-referral-human-shadow.mjs --live [--repo=owner/name] [--pr=N,N] [--dry]');
  }
  const repo = args.find(a => a.startsWith('--repo='))?.slice(7) ?? 'web-everything/web-everything';
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
  const prs = gh(['pr', 'list', '--state', 'open', '--label', 'review:human',
    '--repo', repo, '--limit', '100', '--json', 'number,headRefOid,labels,comments,isDraft,mergeable,statusCheckRollup,body,createdAt,reviews'],
  );
  if (!Array.isArray(prs)) throw new Error('PR list unreadable');
  if (prs.length === 100) console.error('PR list capped at 100; operator must inspect remaining human holds');
  for (const pr of prs.filter(p => !selected || selected.includes(p.number))) {
    if (pr.comments?.length >= 100) {
      try {
        pr.comments = defaultListPrComments({ number: pr.number, repo, gh, maxPages: 10 });
        pr.commentsComplete = true;
      } catch { pr.comments = undefined; }
    }
    // List comments are not complete evidence. Without independent provenance readers the
    // standalone probe deliberately reports unknown, rather than guessing a referral-only hold.
    const decision = await decideStaleReferralHumanHold(pr, { repo, settings });
    const reason = decision.wouldClear ? decision.why
      : decision.checked.find(c => c.status !== 'absent')?.detail ?? decision.why;
    console.log(`${pr.number} wouldClear=${decision.wouldClear} ${String(reason).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`);
    if (!args.includes('--dry')) await emitShadowEvent(decision, pr, { repo, settings });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error?.message ?? error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')); process.exitCode = 1; });
}
