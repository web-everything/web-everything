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
 * THE RULE. `review:human` comes off only when ALL of these hold (any unreadable or malformed input → kept):
 *   1. WHO. The latest `review:human` label event is an ADD by a conveyor automation login (never the operator's
 *      login, never another account), and no hand add of `review:human` appears anywhere on the PR's timeline (the
 *      label mirror can restore a ledgered hand label under its own login): a hand label is never lifted.
 *   2. WHY. A trusted escalation record (`we:scripts/lib/human-escalation-marker.mjs`) posted BY THAT SAME LOGIN
 *      right after the add (5 s skew before, 300 s after: every clearable writer labels first, then records). Every
 *      escalation recorded from 180 s before the add on is of a kind the setting enables (only kinds with a clearing
 *      proof can be enabled), and is cleared:
 *        - referral kinds: the live head carries at least one trusted mandatory referral record, and the gate's own
 *          reader shows nothing pending, blocked or malformed on it (a moved head with no record of its own keeps it);
 *        - round-cap: an operator round-extension grant was posted after the latest round-cap record.
 *   3. NO OTHER HOLD. The live referral state is clean (always, whatever the kind); no `review:awaiting-advisory` is
 *      on the PR or was added since the escalation (the drain's and the hand-off's park shape); no
 *      `review:accepted` (lifting would expose it to the drain), no `review:held-mechanical`; no
 *      `advisory:ruling-needed`; no `red-team:blocked`; no open operator send-back; no human-surface re-park /
 *      mechanical hand-off marker for the live head.
 *   4. NO HUMAN-ONLY CHANGE. The net file set (fresh fetch vs origin/main) plus the PR body's disclosed deviation
 *      score humanRequired false (the shape rule); no human-only surface is touched (permission surfaces judged
 *      without hunks, so any touch keeps it); no decision card (`backlog/*.md` whose front matter parses to
 *      `kind: decision`) is in the net diff. The score and the surface check read the net diff TEXT (merge-base with
 *      origin/main → head), so hunk-judged triggers (a sandbox grant in any script, statute anchors, marked
 *      invariants) count; an unreadable diff, or any file with no diff section, keeps it.
 *   Every comment must be readable (an unreadable one could hold a later escalation record).
 * The apply path re-reads the labels, comments and timeline after the decision and re-plans (each plan reads the PR
 * state before and after the thread); only a second de-escalate verdict on the same head writes, and a head that
 * moved under the write (or a write whose outcome is unknown and the head cannot be re-read) gets `review:human`
 * straight back. Comments are read as JSON, so a missing body stays visible and holds. When lifted: `review:human` comes off, `review:pending` goes on unless
 * `review:changes` stands (a review of the live head is still owed), a durable comment records it, and the log line
 * is `review-human de-escalated {"pr":…,"head":…,"reason":…}`.
 *
 * SETTINGS (policy cascade, standard → platform `review.*` → `scripts/settings/review.json` → env, sources logged):
 *   humanDeescalateEnabled (boolean, standard true; kill switch env WE_REVIEW_HUMAN_DEESCALATE=off),
 *   humanDeescalateKinds (array, a subset of round-cap, referral-pending, referral-malformed,
 *   referral-ledger-sync-failed; env WE_REVIEW_HUMAN_DEESCALATE_KINDS, comma list), humanDeescalateInferLegacy
 *   (boolean, standard false; env WE_REVIEW_HUMAN_DEESCALATE_INFER_LEGACY) — read the pre-marker comment shapes too.
 *   Off by default: a pre-marker park comment was posted even by a park that wrote no label, so it cannot prove
 *   that it explains an add. Every comment's body and author must be readable.
 *
 * Usage: node scripts/conveyor/human-escalation-deescalate.mjs [--repo=<owner/name>] [--pr=<n>] [--apply] [--json]
 *   (report only without --apply). The review daemon's hold sweep runs it with apply.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { normOnOff, REVIEW_SETTINGS_FILE } from '../lib/review-seat-settings.mjs';
import { AUTOMATION_LOGINS, OPERATOR_LOGINS, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { HUMAN_ESCALATION_KINDS, REFERRAL_CLEARABLE_KINDS, CLEARABLE_ESCALATION_KINDS, readHumanEscalations } from '../lib/human-escalation-marker.mjs';
import { REVIEW_LABELS, hasReviewLabel, scoreEscalation, parseDeviationDisclosure, fileHunksResolver } from '../lib/review-escalation.mjs';
import { sensitiveSurfaceHits, resolveHumanReviewSurfaces, normalizeHumanSurfaces } from '../lib/human-review-surfaces.mjs';
import { openOperatorSendBacks } from '../lib/operator-send-backs.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { roundExtensionGrants } from './round-extension-mark.mjs';
import { readHumanSurfaceNetFiles } from '../lib/human-surface-net-diff.mjs';
import { defaultGitDirFor, gitExec } from '../operations/free-scope-io.mjs';
import { createGhProvider, parseJsonLines } from '../lib/review-label-provider.mjs';
import { execRead } from '../lib/proc-read.mjs';
import { defaultListPrs } from './advisory-label-sweep.mjs';
import { readLabelTimelineSync } from './pr-label-mirror.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';

export const DEESCALATE_KINDS_STANDARD = CLEARABLE_ESCALATION_KINDS;
const KNOWN = new Set(Object.values(HUMAN_ESCALATION_KINDS));
/**
 * Every clearable writer posts its record right AFTER its own label write, so only a record in
 * [add − clock skew, add + 300 s] explains the add. Escalations recorded from 180 s before the add on are all
 * counted (a writer that posts first, such as the card-extraction hold, must still be seen and hold).
 */
export const ATTRIBUTION_SKEW_MS = 5_000;
export const ATTRIBUTION_AFTER_MS = 300_000;
export const SINCE_BEFORE_MS = 180_000;
export const DEESCALATED_MARKER_RE = /<!-- we:human-deescalated pr=\d+ head=[0-9a-f]{40} kinds=[a-z0-9,-]+ -->/;
const PARK_MARKER_RE = /<!-- (?:human-surface-repark|mechanical-hold-handoff): ([0-9a-f]{40}) -->/gi;
/** Labels whose presence alone keeps the hold. */
const HOLDING_LABELS = Object.freeze([REVIEW_LABELS.accepted, REVIEW_LABELS.heldMechanical, REVIEW_LABELS.awaitingAdvisory,
  'advisory:ruling-needed', 'red-team:blocked']);

const errorText = e => String(e?.message ?? e).split('\n')[0];
const names = labels => (Array.isArray(labels) ? labels : []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const time = v => Date.parse(v ?? '');
const login = v => String(v ?? '').toLowerCase().replace(/\[bot\]$/, '');

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
    // Legacy inference is OFF by default: a pre-marker park comment was posted even by a park that wrote no label,
    // so it cannot prove it explains an add (audit round 5). Turn it on only to judge an old hold by hand.
    standard: { humanDeescalateEnabled: true, humanDeescalateKinds: [...DEESCALATE_KINDS_STANDARD], humanDeescalateInferLegacy: false },
    platform, env, log,
    envValues: { humanDeescalateEnabled: bool(env.WE_REVIEW_HUMAN_DEESCALATE), humanDeescalateKinds: kindsEnv,
      humanDeescalateInferLegacy: bool(env.WE_REVIEW_HUMAN_DEESCALATE_INFER_LEGACY) },
    valid: {
      humanDeescalateEnabled: v => typeof v === 'boolean',
      humanDeescalateInferLegacy: v => typeof v === 'boolean',
      // Only kinds with a clearing proof may be listed; any other entry refuses that whole layer.
      humanDeescalateKinds: v => Array.isArray(v) && v.every(k => CLEARABLE_ESCALATION_KINDS.includes(k)),
    },
  });
  const v = resolved.value ?? {};
  const kinds = Array.isArray(v.humanDeescalateKinds) ? v.humanDeescalateKinds.filter(k => CLEARABLE_ESCALATION_KINDS.includes(k)) : [];
  return { enabled: v.humanDeescalateEnabled === true, kinds, inferLegacy: v.humanDeescalateInferLegacy === true, sources: resolved.sources };
}

const keep = (reason, extra = {}) => ({ action: 'keep', reason, ...extra });

const isAutomationLogin = actor => typeof actor === 'string' && AUTOMATION_LOGINS.includes(actor.toLowerCase())
  && !OPERATOR_LOGINS.includes(login(actor));

/** A clean live referral state: readable, not malformed, nothing pending or blocked. Returns the reason it is not. */
function referralNotClean(referral) {
  if (!referral || !Array.isArray(referral.pending) || !Array.isArray(referral.blocked) || !Array.isArray(referral.records)) return 'referral state unreadable';
  if (referral.malformed) return 'a referral record is malformed';
  if (referral.pending.length) return `${referral.pending.length} referral hold(s) still pending`;
  if (referral.blocked.length) return `${referral.blocked.length} referral(s) blocked`;
  return null;
}

/** Is the escalation's own cause cleared now? */
function kindCleared(kind, esc, { comments, referral, repo, pr, head }) {
  if (REFERRAL_CLEARABLE_KINDS.includes(kind)) {
    const why = referralNotClean(referral);
    if (why) return why;
    // A head with no referral record of its own proves nothing (the records of an older head are skipped).
    if (!referral.records.some(r => r?.head === head)) return 'no mandatory referral record on the live head';
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
 *   decisionCards:{ok:boolean, files?:string[], reason?:string}, referral:object|null, settings:object, surfaces?:any,
 *   repo:string, scoreFiles?:Function}} o
 */
export function planHumanDeescalation({ pr, timeline, net, decisionCards, referral, settings, surfaces = 'narrow', repo,
  scoreFiles = (files, deviation, humanSurfaces, diffHunks) => scoreEscalation({ changedFiles: files, deviation, humanSurfaces, diffHunks }) } = {}) {
  const labels = names(pr?.labels);
  if (!hasReviewLabel(labels, REVIEW_LABELS.human)) return keep('no review:human');
  if (!settings?.enabled) return keep('de-escalation disabled (setting)');
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return keep('live head unreadable');
  const comments = pr?.comments;
  if (!Array.isArray(comments)) return keep('comments unreadable');
  // One unreadable comment could be the record of a later, non-clearable escalation: hold.
  if (!comments.every(c => c && typeof c === 'object' && typeof c.body === 'string'
    && typeof (c.author?.login ?? c.user?.login) === 'string' && (c.author?.login ?? c.user?.login))) return keep('a comment (body or author) is unreadable');
  if (typeof pr?.body !== 'string') return keep('PR body unreadable');
  const holding = HOLDING_LABELS.find(l => hasReviewLabel(labels, l));
  if (holding) return keep(`${holding} stands`);

  // 1. WHO put the label on.
  if (timeline?.status !== 'ok' || !Array.isArray(timeline.items)) return keep(`label timeline unreadable (${timeline?.reason ?? 'no read'})`);
  if (!timeline.items.every(i => i && typeof i.label === 'string' && ['added', 'removed'].includes(i.change) && Number.isFinite(time(i.createdAt))))
    return keep('label timeline has a malformed event');
  const last = timeline.items.filter(i => i.label === REVIEW_LABELS.human).at(-1);
  if (!last || last.change !== 'added') return keep('label timeline does not end in a review:human add');
  if (!isAutomationLogin(last.actor)) return keep(`review:human added by ${last.actor ?? 'an unknown actor'} (hand or unproven label)`);
  // A hand add ever on this PR may be the hold an automation write later restored (the label mirror re-adds a
  // ledgered hand label under its own login): never lift it.
  const handAdd = timeline.items.find(i => i.label === REVIEW_LABELS.human && i.change === 'added' && !isAutomationLogin(i.actor));
  if (handAdd) return keep(`review:human was hand-added by ${handAdd.actor ?? 'an unknown actor'} on this PR`);
  const addAt = time(last.createdAt);

  // 2. WHY it went on, and whether every recorded cause is cleared.
  const escalations = readHumanEscalations(comments, { inferLegacy: settings.inferLegacy === true });
  if (escalations.some(e => !Number.isFinite(time(e.createdAt)))) return keep('an escalation record has no readable time');
  const windowStart = addAt - SINCE_BEFORE_MS;
  // A record from an earlier label lifecycle (before the last removal) never explains this add.
  const lastLabel = timeline.items.lastIndexOf(last);
  const priorRemoval = timeline.items.slice(0, lastLabel).filter(i => i.label === REVIEW_LABELS.human && i.change === 'removed').at(-1);
  const explainFrom = Math.max(addAt - ATTRIBUTION_SKEW_MS, priorRemoval ? time(priorRemoval.createdAt) + 1 : -Infinity);
  const explains = e => { const t = time(e.createdAt);
    return e.added !== false && login(e.author) === login(last.actor) && t >= explainFrom && t <= addAt + ATTRIBUTION_AFTER_MS; };
  if (!escalations.some(explains)) return keep('no escalation record by the labelling login at the review:human add');
  const since = escalations.filter(e => time(e.createdAt) >= windowStart);
  const kinds = [...new Set(since.map(e => e.kind))];
  for (const kind of kinds) {
    if (!KNOWN.has(kind)) return keep(`unrecognised escalation record (${kind})`);
    if (!settings.kinds?.includes(kind) || !CLEARABLE_ESCALATION_KINDS.includes(kind)) return keep(`escalation kind ${kind} does not de-escalate (setting)`);
  }
  for (const kind of kinds) {
    const latest = since.filter(e => e.kind === kind).at(-1);
    const why = kindCleared(kind, latest, { comments, referral, repo, pr: pr.number, head });
    if (why) return keep(`${kind} not cleared: ${why}`);
  }

  // 3. No other hold.
  const referralWhy = referralNotClean(referral);
  if (referralWhy) return keep(referralWhy);
  if (timeline.items.some(i => i.label === REVIEW_LABELS.awaitingAdvisory && i.change === 'added' && time(i.createdAt) >= windowStart))
    return keep('review:awaiting-advisory was added since the escalation (a drain or hand-off park)');
  let sendBacks;
  try { sendBacks = openOperatorSendBacks({ ...pr, comments }); } catch (e) { return keep(`operator send-backs unreadable: ${errorText(e)}`); }
  if (!Array.isArray(sendBacks)) return keep('operator send-backs unreadable');
  if (sendBacks.length) return keep('an operator send-back is open');
  if (comments.some(c => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'
    && [...c.body.matchAll(PARK_MARKER_RE)].some(m => m[1].toLowerCase() === head))) return keep('a human-surface park marks the live head');

  // 4. No human-only change.
  if (!net?.ok || !Array.isArray(net.files) || !net.files.length || !net.files.every(f => typeof f === 'string' && f))
    return keep(`net file set unreadable (${net?.reason ?? 'no read'})`);
  let score;
  // The net diff TEXT too: permission surfaces (a sandbox grant in any script), statute anchors and marked invariants
  // are judged from the hunks, so file names alone cannot rule them out.
  if (typeof net.diffHunks !== 'string' || !net.diffHunks) return keep(`net diff text unreadable (${net.diffReason ?? 'no read'})`);
  let categories;
  try { categories = normalizeHumanSurfaces(surfaces).categories; } catch (e) { return keep(`human-surface setting unreadable: ${errorText(e)}`); }
  if (!Array.isArray(categories)) return keep('human-surface setting unreadable');
  try { score = scoreFiles(net.files, parseDeviationDisclosure(pr.body), surfaces, net.diffHunks); } catch (e) { return keep(`shape score failed: ${errorText(e)}`); }
  if (score?.humanRequired !== false) return keep(`net diff requires a human (${(score?.reasons ?? []).join('; ') || 'shape rule'})`);
  // Every net file must have a TEXT hunk: a binary section (git calls a file with a NUL binary, even a script),
  // a mode-only change or an empty add carries content no trigger could read.
  const hunksOf = fileHunksResolver(net.diffHunks);
  const opaque = net.files.filter(f => { const section = hunksOf(f);
    return typeof section !== 'string' || !/^@@ /m.test(section) || /^(?:Binary files .* differ|GIT binary patch)$/m.test(section); });
  if (opaque.length) return keep(`no readable text hunk for ${opaque.slice(0, 3).join(', ')}${opaque.length > 3 ? ', …' : ''}`);
  // A file the diff text has no section for (binary, mode-only, an unmatched spelling) was not judged: hold.
  if (!Array.isArray(score?.signals?.hunksUnavailable ?? []) || (score?.signals?.hunksUnavailable ?? []).length)
    return keep(`hunks unavailable for ${(score?.signals?.hunksUnavailable ?? ['?']).slice(0, 3).join(', ')}`);
  let hits;
  try { hits = sensitiveSurfaceHits(net.files, hunksOf, surfaces); } catch (e) { return keep(`human-surface check failed: ${errorText(e)}`); }
  if (!Array.isArray(hits)) return keep('human-surface check unreadable');
  if (hits.length) return keep(`human-only surface touched (${[...new Set(hits.map(h => h.category))].join(', ')})`);
  if (!decisionCards?.ok || !Array.isArray(decisionCards.files)) return keep(`decision-card read failed (${decisionCards?.reason ?? 'no read'})`);
  if (decisionCards.files.length) return keep(`decision card in the net diff (${decisionCards.files.join(', ')})`);

  return { action: 'deescalate', reason: `escalation cleared (${kinds.join(', ')}); net diff needs no human`, kinds, head };
}

/** IO. The net files that are decision cards at `head`, by their parsed front matter. Any read or parse failure → not ok. */
export function readDecisionCards({ repo, head, files }, { git = gitExec(), gitDirFor = defaultGitDirFor } = {}) {
  try {
    const cardFiles = files.filter(f => /^backlog\/.+\.md$/i.test(f));
    if (!cardFiles.length) return { ok: true, files: [] };
    const dir = gitDirFor(repo);
    if (!dir) return { ok: false, reason: 'no local checkout of this repo' };
    const cards = [];
    for (const file of cardFiles) {
      // A deleted card has no blob at the head: unreadable, so the hold stays.
      const text = String(git(dir, ['show', `${head}:${file}`]));
      if (!/^---\r?\n/.test(text)) return { ok: false, reason: `card front matter missing: ${file}` };
      // A fresh parse per file: gray-matter caches by content, and a cached result must not hide a parse error.
      const parsed = matter(text, { cache: false });
      const kind = parsed?.data?.kind;
      if (kind === undefined || kind === null) return { ok: false, reason: `card kind unreadable: ${file}` };
      if (String(kind).trim().toLowerCase() === 'decision') cards.push(file);
    }
    return { ok: true, files: cards };
  } catch (e) {
    return { ok: false, reason: `card read failed: ${errorText(e)}` };
  }
}

/**
 * IO. The whole net diff text of `head` against its merge-base with origin/main (fetched by the net file read just
 * before). Any failure → not ok (the hold stays).
 */
export function readNetDiffText({ repo, head }, { git = gitExec(), gitDirFor = defaultGitDirFor } = {}) {
  try {
    const dir = gitDirFor(repo);
    if (!dir) return { ok: false, reason: 'no local checkout of this repo' };
    const mergeBase = String(git(dir, ['merge-base', '--end-of-options', 'origin/main', head])).split('\n')[0].trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) return { ok: false, reason: 'no merge-base with origin/main' };
    const text = String(git(dir, ['diff', '--no-ext-diff', '--no-renames', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
      '--end-of-options', mergeBase, head]));
    return text ? { ok: true, text } : { ok: false, reason: 'empty net diff' };
  } catch (e) {
    return { ok: false, reason: `net diff failed: ${errorText(e)}` };
  }
}

/**
 * IO. The PR's complete comment thread as JSON lines, so a missing or non-string body stays visible (and holds)
 * instead of being flattened to an empty string. Throws on a read miss.
 */
export function readCommentsStrict(num, { repo, exec = execRead } = {}) {
  const out = exec('gh', ['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', `repos/${repo}/issues/${num}/comments`,
    '--jq', '.[] | {body, createdAt: .created_at, author: (if .user.login then {login: .user.login} else null end), id: .node_id}']);
  return parseJsonLines(out);
}

export function buildDeescalatedComment({ pr, head, kinds, reason }) {
  return ['✅ review:human lifted — the escalation that added it is cleared', '',
    `Recorded escalation(s): ${kinds.map(k => `\`${k}\``).join(', ')}. ${reason}.`,
    `Head \`${head.slice(0, 12)}\`. No hand label, no human-only surface, no decision card, no open operator ruling or block.`,
    'A review of this head is still owed (`review:pending` unless `review:changes` stands). Rule-required human review is untouched.',
    '', `<!-- we:human-deescalated pr=${Number(pr)} head=${head} kinds=${kinds.join(',')} -->`].join('\n');
}

/**
 * IO sweep, synchronous (it runs inside the review daemon's sync hold sweep). Report only unless `apply`.
 * Never throws; one PR's failure never stops the rest.
 * @returns {Array<object>}
 */
export function sweepHumanDeescalation({
  repo = null, prNumber = null, apply = false, env = process.env,
  listPrs = defaultListPrs, provider = createGhProvider(), readComments = readCommentsStrict, readDiff = readNetDiffText,
  readTimeline = o => readLabelTimelineSync({ ...o, strict: true }), readNetFiles = readHumanSurfaceNetFiles, readCards = readDecisionCards,
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
      const surfaces = resolveSurfaces();
      // One complete live read → one plan. Net files and cards are bound to the head and reused by the re-plan.
      let net = null, decisionCards = null;
      const planFromLive = () => {
        // The state is read before AND after the comments and timeline: a push or a label move during those reads
        // is caught by the second state read instead of judging a head the thread was not read for.
        const before = provider.readPrState(resolvedRepo, num);
        if (before?.state !== 'OPEN') return { state: before, plan: keep('not open') };
        const comments = readComments(num, { repo: resolvedRepo });
        const timeline = readTimeline({ repo: resolvedRepo, pr: num });
        const state = provider.readPrState(resolvedRepo, num);
        if (state?.state !== 'OPEN') return { state, plan: keep('not open') };
        const sortedNames = st => JSON.stringify(names(st?.labels).sort());
        if (state.headRefOid !== before.headRefOid || sortedNames(state) !== sortedNames(before) || state.body !== before.body)
          return { state, plan: keep('state moved during the read') };
        if (!net || net.head !== state.headRefOid) {
          net = { head: state.headRefOid, ...readNetFiles({ repo: resolvedRepo, number: num, headRefOid: state.headRefOid }) };
          if (net.ok) {
            const diff = readDiff({ repo: resolvedRepo, head: state.headRefOid });
            net = diff.ok ? { ...net, diffHunks: diff.text } : { ...net, diffReason: diff.reason };
          }
          decisionCards = net.ok && Array.isArray(net.files)
            ? readCards({ repo: resolvedRepo, head: state.headRefOid, files: net.files }) : { ok: false, reason: 'no net file set' };
        }
        const pr = { ...state, number: num, comments: Array.isArray(comments) ? comments : null };
        let referral = null;
        try { referral = pr.comments ? readReferral(pr, { repo: resolvedRepo, pr: num }) : null; } catch { referral = null; }
        return { state, plan: planHumanDeescalation({ pr, timeline, net, decisionCards, referral, settings, surfaces, repo: resolvedRepo }) };
      };
      const first = planFromLive();
      const entry = { num, head: first.state?.headRefOid ?? null, action: first.plan.action, reason: first.plan.reason };
      results.push(entry);
      if (first.plan.action !== 'deescalate') continue;
      if (!apply) { entry.action = 'would-deescalate'; continue; }
      // Re-read everything (labels, comments, timeline) and re-plan: a hand re-add, a new send-back or a moved head
      // between the first read and the write keeps the hold for the next pass.
      const second = planFromLive();
      if (second.plan.action !== 'deescalate' || second.state?.headRefOid !== first.state.headRefOid) {
        Object.assign(entry, { action: 'keep', reason: `state moved during the read (${second.plan.reason})` });
        continue;
      }
      const freshLabels = names(second.state.labels);
      const addPending = !(hasReviewLabel(freshLabels, REVIEW_LABELS.changes) || hasReviewLabel(freshLabels, REVIEW_LABELS.pending));
      let writeError = null;
      try { provider.setLabels(resolvedRepo, num, { ...(addPending ? { add: REVIEW_LABELS.pending } : {}), remove: [REVIEW_LABELS.human] }); }
      catch (e) { writeError = errorText(e); }
      // GitHub has no conditional label write, and a failed write may still have landed. Read once more, on every
      // path: a head that moved under the write is a diff nobody judged, so the hold goes straight back (an
      // unreadable re-read restores it too).
      let after = null;
      try { after = provider.readPrState(resolvedRepo, num); } catch { after = null; }
      if (after?.headRefOid !== second.state.headRefOid) {
        try {
          provider.setLabels(resolvedRepo, num, { add: REVIEW_LABELS.human,
            remove: addPending && hasReviewLabel(names(after?.labels), REVIEW_LABELS.pending) ? [REVIEW_LABELS.pending] : [] });
          Object.assign(entry, { action: 'keep', reason: 'head moved during the write (or could not be re-read); review:human restored' });
        } catch (e) {
          Object.assign(entry, { action: 'error', reason: `head moved during the write and the restore failed: ${errorText(e)}` });
        }
        continue;
      }
      if (hasReviewLabel(names(after.labels), REVIEW_LABELS.human)) {
        Object.assign(entry, { action: writeError ? 'error' : 'keep', reason: writeError ? `label write failed: ${writeError}` : 'review:human still present after the write' });
        continue;
      }
      entry.action = 'deescalated';
      log(`review-human de-escalated ${JSON.stringify({ pr: num, head: second.plan.head, reason: second.plan.reason })}`);
      try { provider.postComment(resolvedRepo, num, buildDeescalatedComment({ pr: num, head: second.plan.head, kinds: second.plan.kinds, reason: second.plan.reason })); }
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
