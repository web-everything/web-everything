#!/usr/bin/env node
/**
 * @file scripts/conveyor/human-escalation-deescalate.mjs
 * @description Lift an ESCALATION-added `review:human` once its recorded cause is cleared and nothing else needs a
 *   human. Never touches a hand-added or rule-required `review:human`.
 *
 * LIVE CASE (2026-10-21): #5502, #5762, #5768, #5805 waited on an operator clearance their net diff never needed
 * (`review-core-cli.mjs shape` → humanRequired false). Each got `review:human` from an escalation — a mandatory
 * referral waiting on a ruling (#5502, #5805), a mandatory ruling ledger write miss (#5762, #5768) — and kept it
 * after the ruling landed, because no writer recorded why the label went on and no pass ever took it off.
 *
 * THE RULE. `review:human` comes off only when ALL of these hold (any unreadable input → kept, fail closed):
 *   1. The latest `review:human` label event is an ADD by the conveyor's automation login (never the operator's
 *      login, never another account): a hand label is never lifted.
 *   2. A trusted escalation record (`we:scripts/lib/human-escalation-marker.mjs`) sits at that add, and every
 *      escalation recorded since then is of a kind the setting lets de-escalate, and each one is cleared:
 *        - referral kinds: the live head has no pending and no blocked mandatory referral (the gate's own reader);
 *        - round-cap: an operator round-extension grant was posted after the latest round-cap record.
 *   3. No `review:awaiting-advisory` was added beside it (the drain's and the hand-off's park shape, not an escalation).
 *   4. Nothing else needs a human: the net file set (fresh fetch vs origin/main) scores humanRequired false; no
 *      human-only surface is touched (permission surfaces included, judged without hunks, so any touch keeps it); no
 *      decision card (`backlog/*.md` with `kind: decision`) is in the net diff; no `advisory:ruling-needed`; no
 *      `red-team:blocked`; no blocked referral; no open operator send-back; no human-surface re-park / mechanical
 *      hand-off marker for the live head.
 * When lifted: `review:human` is removed, `review:pending` is added when no other review label stands (a review of the
 * live head is still owed), a durable comment records it, and the log line is
 * `review-human de-escalated {"pr":…,"head":…,"reason":…}`.
 *
 * SETTINGS (policy cascade, standard → platform `review.*` → `scripts/settings/review.json` → env, sources logged):
 *   humanDeescalateEnabled (boolean, standard true; kill switch env WE_REVIEW_HUMAN_DEESCALATE=off),
 *   humanDeescalateKinds (array, standard: round-cap + the four referral kinds; env WE_REVIEW_HUMAN_DEESCALATE_KINDS),
 *   humanDeescalateInferLegacy (boolean, standard true; env WE_REVIEW_HUMAN_DEESCALATE_INFER_LEGACY) — read the
 *   pre-marker comment shapes so the holds already standing (the live case) are judged too.
 *
 * Usage: node scripts/conveyor/human-escalation-deescalate.mjs [--repo=<owner/name>] [--pr=<n>] [--apply] [--json]
 *   (report only without --apply). The review daemon's hold sweep runs it with apply.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { normOnOff, REVIEW_SETTINGS_FILE } from '../lib/review-seat-settings.mjs';
import { AUTOMATION_LOGINS, OPERATOR_LOGINS, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { HUMAN_ESCALATION_KINDS, REFERRAL_ESCALATION_KINDS, readHumanEscalations } from '../lib/human-escalation-marker.mjs';
import { REVIEW_LABELS, hasReviewLabel, scoreEscalation } from '../lib/review-escalation.mjs';
import { sensitiveSurfaceHits, resolveHumanReviewSurfaces } from '../lib/human-review-surfaces.mjs';
import { openOperatorSendBacks } from '../lib/operator-send-backs.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { roundExtensionGrants } from './round-extension-mark.mjs';
import { readHumanSurfaceNetFiles } from '../lib/human-surface-net-diff.mjs';
import { defaultGitDirFor, gitExec } from '../operations/free-scope-io.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { defaultListPrs } from './advisory-label-sweep.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { readLabelTimelineSync } from './pr-label-mirror.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';

export const DEESCALATE_KINDS_STANDARD = Object.freeze([HUMAN_ESCALATION_KINDS.ROUND_CAP, ...REFERRAL_ESCALATION_KINDS]);
const KNOWN = new Set(Object.values(HUMAN_ESCALATION_KINDS));
/** A marker is posted right after its label write; a legacy referral record comes just before the park. */
export const ATTRIBUTION_BEFORE_MS = 180_000;
export const ATTRIBUTION_AFTER_MS = 300_000;
/** The drain / hand-off parks add `review:awaiting-advisory` with the human hold; an escalation park never does. */
const ADVISORY_PAIR_MS = 120_000;
export const DEESCALATED_MARKER_RE = /<!-- we:human-deescalated pr=\d+ head=[0-9a-f]{40} kinds=[a-z0-9,-]+ -->/;
const PARK_MARKER_RE = /<!-- (?:human-surface-repark|mechanical-hold-handoff): ([0-9a-f]{40}) -->/gi;

const errorText = e => String(e?.message ?? e).split('\n')[0];
const names = labels => (Array.isArray(labels) ? labels : []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const time = v => Date.parse(v ?? '');

/** The cascade-resolved settings; each source is logged once per process by the cascade. */
export function resolveDeescalateSettings({ env = process.env, readFile = readFileSync, platform, log } = {}) {
  let tool = {};
  try {
    const file = JSON.parse(String(readFile(REVIEW_SETTINGS_FILE, 'utf8')));
    tool = { humanDeescalateEnabled: file?.humanDeescalateEnabled, humanDeescalateKinds: file?.humanDeescalateKinds,
      humanDeescalateInferLegacy: file?.humanDeescalateInferLegacy };
  } catch { /* absent layer */ }
  const bool = v => (normOnOff(v) === null ? undefined : normOnOff(v) === 'on');
  const kindsEnv = typeof env.WE_REVIEW_HUMAN_DEESCALATE_KINDS === 'string'
    ? env.WE_REVIEW_HUMAN_DEESCALATE_KINDS.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const resolved = cascadePolicy('review', tool, {
    standard: { humanDeescalateEnabled: true, humanDeescalateKinds: [...DEESCALATE_KINDS_STANDARD], humanDeescalateInferLegacy: true },
    platform, env, log,
    envValues: { humanDeescalateEnabled: bool(env.WE_REVIEW_HUMAN_DEESCALATE), humanDeescalateKinds: kindsEnv,
      humanDeescalateInferLegacy: bool(env.WE_REVIEW_HUMAN_DEESCALATE_INFER_LEGACY) },
    valid: {
      humanDeescalateEnabled: v => typeof v === 'boolean',
      humanDeescalateInferLegacy: v => typeof v === 'boolean',
      // Only the kinds that have a clearing proof may be listed; any other entry refuses the whole layer.
      humanDeescalateKinds: v => Array.isArray(v) && v.every(k => DEESCALATE_KINDS_STANDARD.includes(k)),
    },
  });
  const v = resolved.value ?? {};
  return { enabled: v.humanDeescalateEnabled === true, kinds: Array.isArray(v.humanDeescalateKinds) ? v.humanDeescalateKinds : [],
    inferLegacy: v.humanDeescalateInferLegacy === true, sources: resolved.sources };
}

const keep = (reason, extra = {}) => ({ action: 'keep', reason, ...extra });

const isAutomationLogin = login => typeof login === 'string' && AUTOMATION_LOGINS.includes(login.toLowerCase())
  && !OPERATOR_LOGINS.includes(login.toLowerCase().replace(/\[bot\]$/, ''));

/** Is the escalation's own cause cleared now? `facts.referral` is the live-head referral state (or null). */
function kindCleared(kind, esc, { comments, referral, repo, pr }) {
  if (REFERRAL_ESCALATION_KINDS.includes(kind)) {
    if (!referral || !Array.isArray(referral.pending) || !Array.isArray(referral.blocked)) return 'referral state unreadable';
    if (referral.pending.length) return `${referral.pending.length} referral(s) still pending`;
    if (referral.blocked.length) return `${referral.blocked.length} referral(s) blocked`;
    return null;
  }
  if (kind === HUMAN_ESCALATION_KINDS.ROUND_CAP) {
    // Operator grants only (standingRuling null): an automatic grant needs its scope verified, which this pass does not do.
    const grants = roundExtensionGrants(comments, { repo, pr, standingRuling: null });
    return grants.some(g => g.index > esc.index) ? null : 'no round grant after the round-cap escalation';
  }
  return `kind ${kind} has no clearing proof`;
}

/**
 * PURE. Decide one PR. Inputs are the live read; a missing or malformed one keeps the hold.
 * @param {{pr:{number:number, headRefOid:string, labels:Array, comments:Array, body?:string, createdAt?:string},
 *   timeline:{status:string, items?:Array}, net:{ok:boolean, files?:string[], reason?:string},
 *   decisionCards:{ok:boolean, files?:string[], reason?:string}, referral:object|null, settings:object, surfaces?:string,
 *   repo:string}} o
 */
export function planHumanDeescalation({ pr, timeline, net, decisionCards, referral, settings, surfaces = 'narrow', repo,
  scoreFiles = files => scoreEscalation({ changedFiles: files }) } = {}) {
  const labels = names(pr?.labels);
  if (!hasReviewLabel(labels, REVIEW_LABELS.human)) return keep('no review:human');
  if (!settings?.enabled) return keep('de-escalation disabled (setting)');
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return keep('live head unreadable');
  const comments = pr?.comments;
  if (!Array.isArray(comments)) return keep('comments unreadable');

  // 1. Who put the label on.
  if (timeline?.status !== 'ok' || !Array.isArray(timeline.items)) return keep(`label timeline unreadable (${timeline?.reason ?? 'no read'})`);
  const humanEvents = timeline.items.filter(i => i?.label === REVIEW_LABELS.human);
  const last = humanEvents.at(-1);
  if (!last || last.change !== 'added') return keep('label timeline does not end in a review:human add');
  if (!isAutomationLogin(last.actor)) return keep(`review:human added by ${last.actor ?? 'an unknown actor'} (hand or unproven label)`);
  const addAt = time(last.createdAt);
  if (!Number.isFinite(addAt)) return keep('review:human add time unreadable');
  if (timeline.items.some(i => i?.label === REVIEW_LABELS.awaitingAdvisory && i.change === 'added'
    && Math.abs(time(i.createdAt) - addAt) <= ADVISORY_PAIR_MS)) return keep('added beside review:awaiting-advisory (a drain or hand-off park)');

  // 2. Why it went on, and whether every recorded cause is cleared.
  const escalations = readHumanEscalations(comments, { inferLegacy: settings.inferLegacy === true });
  const inWindow = e => { const t = time(e.createdAt); return Number.isFinite(t) && t >= addAt - ATTRIBUTION_BEFORE_MS
    && t <= addAt + (e.recordOnly ? 0 : ATTRIBUTION_AFTER_MS); };
  if (!escalations.some(inWindow)) return keep('no recorded escalation reason at the review:human add');
  const since = escalations.filter(e => { const t = time(e.createdAt); return !Number.isFinite(t) || t >= addAt - ATTRIBUTION_BEFORE_MS; });
  const kinds = [...new Set(since.map(e => e.kind))];
  for (const kind of kinds) {
    if (!KNOWN.has(kind)) return keep(`unrecognised escalation record (${kind})`);
    if (!settings.kinds?.includes(kind)) return keep(`escalation kind ${kind} does not de-escalate (setting)`);
  }
  for (const kind of kinds) {
    const latest = since.filter(e => e.kind === kind).at(-1);
    const why = kindCleared(kind, latest, { comments, referral, repo, pr: pr.number });
    if (why) return keep(`${kind} not cleared: ${why}`);
  }

  // 3. No other reason needs a human.
  if (hasReviewLabel(labels, 'advisory:ruling-needed')) return keep('advisory:ruling-needed stands');
  // The red-team gate's own hold: a confirmed break at the round cap waits on the operator's ruling.
  if (hasReviewLabel(labels, 'red-team:blocked')) return keep('red-team:blocked stands (an operator ruling is owed)');
  if (!referral || !Array.isArray(referral.blocked)) return keep('referral state unreadable');
  if (referral.blocked.length) return keep('a referral is ruled block');
  let sendBacks;
  try { sendBacks = openOperatorSendBacks({ ...pr, comments }); } catch (e) { return keep(`operator send-backs unreadable: ${errorText(e)}`); }
  if (!Array.isArray(sendBacks)) return keep('operator send-backs unreadable');
  if (sendBacks.length) return keep('an operator send-back is open');
  if (comments.some(c => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'
    && [...c.body.matchAll(PARK_MARKER_RE)].some(m => m[1].toLowerCase() === head))) return keep('a human-surface park marks the live head');
  if (!net?.ok || !Array.isArray(net.files) || !net.files.length || !net.files.every(f => typeof f === 'string' && f))
    return keep(`net file set unreadable (${net?.reason ?? 'no read'})`);
  let score;
  try { score = scoreFiles(net.files); } catch (e) { return keep(`shape score failed: ${errorText(e)}`); }
  if (score?.humanRequired !== false) return keep(`net diff requires a human (${(score?.reasons ?? []).join('; ') || 'shape rule'})`);
  let hits;
  try { hits = sensitiveSurfaceHits(net.files, () => undefined, surfaces); } catch (e) { return keep(`human-surface check failed: ${errorText(e)}`); }
  if (!Array.isArray(hits)) return keep('human-surface check unreadable');
  if (hits.length) return keep(`human-only surface touched (${[...new Set(hits.map(h => h.category))].join(', ')})`);
  if (!decisionCards?.ok || !Array.isArray(decisionCards.files)) return keep(`decision-card read failed (${decisionCards?.reason ?? 'no read'})`);
  if (decisionCards.files.length) return keep(`decision card in the net diff (${decisionCards.files.join(', ')})`);

  return { action: 'deescalate', reason: `escalation cleared (${kinds.join(', ')}); net diff needs no human`, kinds, head, careLevel: score.careLevel };
}

/** IO. The net files that are decision cards at `head`. Any read failure → not ok (the hold stays). */
export function readDecisionCards({ repo, head, files }, { git = gitExec(), gitDirFor = defaultGitDirFor } = {}) {
  try {
    const dir = gitDirFor(repo);
    if (!dir) return { ok: false, reason: 'no local checkout of this repo' };
    const cards = [];
    for (const file of files.filter(f => /^backlog\/[^/]+\.md$/.test(f))) {
      const text = String(git(dir, ['show', `${head}:${file}`]));
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!front) return { ok: false, reason: `card front matter unreadable: ${file}` };
      if (/^kind:\s*['"]?decision['"]?\s*$/m.test(front[1])) cards.push(file);
    }
    return { ok: true, files: cards };
  } catch (e) {
    return { ok: false, reason: `card read failed: ${errorText(e)}` };
  }
}

export function buildDeescalatedComment({ pr, head, kinds, reason }) {
  return ['✅ review:human lifted — the escalation that added it is cleared', '',
    `Recorded escalation(s): ${kinds.map(k => `\`${k}\``).join(', ')}. ${reason}.`,
    `Head \`${head.slice(0, 12)}\`. No hand label, no human-only surface, no decision card, no open operator ruling or block.`,
    'A review of this head is still owed (`review:pending` unless another review label stands). Rule-required human review is untouched.',
    '', `<!-- we:human-deescalated pr=${Number(pr)} head=${head} kinds=${kinds.join(',')} -->`].join('\n');
}

/**
 * IO sweep, synchronous (it runs inside the review daemon's sync hold sweep). Report only unless `apply`.
 * Never throws; one PR's failure never stops the rest.
 * @returns {Array<object>}
 */
export function sweepHumanDeescalation({
  repo = null, prNumber = null, apply = false, env = process.env,
  listPrs = defaultListPrs, provider = createGhProvider(), readComments = readCompletePrComments,
  readTimeline = readLabelTimelineSync, readNetFiles = readHumanSurfaceNetFiles, readCards = readDecisionCards,
  resolveSurfaces = resolveHumanReviewSurfaces, readReferral = liveReferralState,
  settings = resolveDeescalateSettings({ env }), log = line => writeLineSync(2, line),
} = {}) {
  const results = [];
  if (!settings.enabled) return [{ num: 0, action: 'keep', reason: 'de-escalation disabled (setting)', sources: settings.sources }];
  let resolvedRepo = repo;
  let prs;
  try { prs = listPrs({ repo }) ?? []; } catch (e) { return [{ num: 0, action: 'error', reason: `listing failed: ${errorText(e)}` }]; }
  for (const listed of prs) {
    if (prNumber != null && Number(listed?.number) !== Number(prNumber)) continue;
    if (!hasReviewLabel(names(listed?.labels), REVIEW_LABELS.human)) continue;
    const num = listed.number;
    try {
      resolvedRepo ??= provider.currentRepo();
      const state = provider.readPrState(resolvedRepo, num);
      if (state?.state !== 'OPEN') { results.push({ num, action: 'keep', reason: 'not open' }); continue; }
      const comments = readComments(num, { repo: resolvedRepo });
      const timeline = readTimeline({ repo: resolvedRepo, pr: num });
      const net = readNetFiles({ repo: resolvedRepo, number: num, headRefOid: state.headRefOid });
      const decisionCards = net?.ok && Array.isArray(net.files)
        ? readCards({ repo: resolvedRepo, head: state.headRefOid, files: net.files }) : { ok: false, reason: 'no net file set' };
      const pr = { ...state, number: num, comments: Array.isArray(comments) ? comments : null };
      let referral = null;
      try { referral = pr.comments ? readReferral(pr, { repo: resolvedRepo, pr: num }) : null; } catch { referral = null; }
      const plan = planHumanDeescalation({ pr, timeline, net, decisionCards, referral, settings, surfaces: resolveSurfaces(), repo: resolvedRepo });
      const entry = { num, head: state.headRefOid, action: plan.action, reason: plan.reason };
      results.push(entry);
      if (plan.action !== 'deescalate') continue;
      if (!apply) { entry.action = 'would-deescalate'; continue; }
      // Re-read right before the write: a moved head or a new label decision keeps the hold for the next pass.
      const fresh = provider.readPrState(resolvedRepo, num);
      const freshLabels = names(fresh?.labels);
      if (fresh?.headRefOid !== state.headRefOid || !hasReviewLabel(freshLabels, REVIEW_LABELS.human)
        || JSON.stringify([...freshLabels].sort()) !== JSON.stringify([...names(state.labels)].sort())) {
        Object.assign(entry, { action: 'keep', reason: 'state moved during the read' });
        continue;
      }
      const otherReview = [REVIEW_LABELS.pending, REVIEW_LABELS.changes, REVIEW_LABELS.accepted, REVIEW_LABELS.heldMechanical]
        .some(l => hasReviewLabel(freshLabels, l));
      provider.setLabels(resolvedRepo, num, { ...(otherReview ? {} : { add: REVIEW_LABELS.pending }), remove: [REVIEW_LABELS.human] });
      entry.action = 'deescalated';
      log(`review-human de-escalated ${JSON.stringify({ pr: num, head: state.headRefOid, reason: plan.reason })}`);
      try { provider.postComment(resolvedRepo, num, buildDeescalatedComment({ pr: num, head: state.headRefOid, kinds: plan.kinds, reason: plan.reason })); }
      catch (e) { entry.commentError = errorText(e); }
    } catch (e) {
      results.push({ num, action: 'error', reason: errorText(e) });
    }
  }
  return results;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = name => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  try {
    const rows = sweepHumanDeescalation({ repo: flag('repo'), prNumber: flag('pr'), apply: argv.includes('--apply') });
    writeAllSync(1, argv.includes('--json') ? `${JSON.stringify(rows)}\n`
      : `${rows.map(r => `#${r.num} ${r.action}: ${r.reason}`).join('\n') || 'no review:human PRs'}\n`);
  } catch (e) {
    writeLineSync(2, `error: ${errorText(e)}`);
    process.exitCode = 1;
  }
}
