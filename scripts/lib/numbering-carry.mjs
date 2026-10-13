/**
 * @file scripts/lib/numbering-carry.mjs
 * @description Carry acceptance only across mechanically proven drain numbering commits. A matching subject
 *   is necessary but insufficient: every change must be a backlog card rename, its optional bornAs stamp,
 *   or a whole-token id rewrite. The IO shell proves a bounded linear chain above the accepted head.
 *
 *   THE LIVE CASE (WE PR #5025): 8d3f2044f → e2e7e3f97 numbered xf74q20→#6053 and xztd0mv→#6054.
 *   Two backlog cards were renamed and stamped; one existing card and the renamed cards had references
 *   rewritten. The parent acceptance looked stale despite no author change. This proof permits callers
 *   to carry it forward without trusting the drain's subject alone. Duplicate drops never qualify.
 */
import { execFileSync } from 'node:child_process';
import { finishRecordedAcceptanceLabels } from './review-label-provider.mjs';
import { isKnownMachineBody, latestAcceptRecord, laterReviewHold } from './accept-carry-forward.mjs';
import {
  REVIEW_LABELS, buildStaleAcceptHealComment, buildReviewedShaMarker, buildReviewedDiffMarker,
  buildReviewedContributionMarker, buildClearedHumanMarker,
} from './review-escalation.mjs';

export const NUMBERING_SUBJECT_RE = /^drain: JIT-number (.+) at land \(#2288\)$/;
export const MAX_NUMBERING_COMMITS = 5;

/** PURE: parse exact, unique hash→number pairs; malformed subjects and duplicate drops return null. */
export function parseNumberingSubject(subject) {
  if (typeof subject !== 'string') return null;
  const match = NUMBERING_SUBJECT_RE.exec(subject);
  if (!match || match[0] !== subject) return null;
  const pairs = new Map();
  const numbers = new Set();
  for (const entry of match[1].split(', ')) {
    const pair = /^(x[0-9a-z]{6})→#(\d+)$/.exec(entry);
    if (!pair || pair[0] !== entry || pairs.has(pair[1]) || numbers.has(pair[2])) return null;
    pairs.set(pair[1], pair[2]);
    numbers.add(pair[2]);
  }
  return pairs.size ? pairs : null;
}

/** PURE: token-walk the original text, permitting each mapped token to stay unchanged or become its number. */
export function isMappedRewrite(before, after, map) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  let cursor = 0;
  const segments = before.split(/(\bx[0-9a-z]{6}\b)/g);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i % 2 === 0 || after.startsWith(segment, cursor)) {
      if (!after.startsWith(segment, cursor)) return false;
      cursor += segment.length;
    } else {
      if (!map.has(segment)) return false;
      const number = map.get(segment);
      if (typeof number !== 'string' || !after.startsWith(number, cursor)) return false;
      cursor += number.length;
    }
  }
  return cursor === after.length;
}

const refuse = (reason) => ({ ok: false, reason });
const swap = (text, map) => text.replace(/\bx[0-9a-z]{6}\b/g, (hash) => map.get(hash) ?? hash);

/**
 * PURE: verify one commit's entire diff, supplied as no-renames additions/deletions/modifications with blobs.
 * @param {{subject:string, parents:string[], changes:Array<{status:string,path:string,before?:string|null,after?:string|null}>,
 *   extraMap?:Map<string,string>}} o
 * @returns {{ok:true,pairs:Array<[string,string]>,renames:Array<{from:string,to:string}>}|{ok:false,reason:string}}
 */
export function checkNumberingCommit({ subject, parents, changes, extraMap = new Map() }) {
  if (!Array.isArray(parents) || parents.length !== 1) return refuse('numbering commit must have exactly one parent');
  const map = parseNumberingSubject(subject);
  if (!map) return refuse('subject is not an exact drain numbering subject with unique pairs');
  if (!Array.isArray(changes) || !changes.length) return refuse('numbering commit has no changes');
  const paths = new Set();
  for (const change of changes) {
    if (!['A', 'D', 'M'].includes(change.status)) return refuse(`unsupported change status ${change.status} at ${change.path}`);
    if (typeof change.path !== 'string' || paths.has(change.path)) return refuse(`invalid or repeated change path ${change.path}`);
    paths.add(change.path);
  }
  // Subject pairs win: main's reference aliases cannot change what this commit claims to number.
  const referenceMap = new Map([...extraMap, ...map]);
  const additions = new Map(changes.filter((c) => c.status === 'A').map((c) => [c.path, c]));
  const used = new Set();
  const renames = [];
  for (const deleted of changes.filter((c) => c.status === 'D')) {
    const target = swap(deleted.path, map);
    const added = additions.get(target);
    if (!added || target === deleted.path) return refuse(`deleted path ${deleted.path} has no added rename partner ${target}`);
    additions.delete(target);
    const card = /^backlog\/(x[0-9a-z]{6})-[^/]+\.md$/.exec(deleted.path);
    if (!card) return refuse(`rename ${deleted.path} is not a provisional backlog card`);
    const hash = card[1];
    if (!map.has(hash) || !added.path.startsWith(`backlog/${map.get(hash)}-`)) {
      return refuse(`rename ${deleted.path} does not use its subject number`);
    }
    if (used.has(hash)) return refuse(`subject hash ${hash} has more than one card rename`);
    const { before } = deleted;
    const { after } = added;
    if (typeof before !== 'string' || typeof after !== 'string') return refuse(`missing content blob for rename ${deleted.path}`);
    const prefix = `---\nbornAs: ${hash}\n`;
    const unstamped = after.startsWith(prefix) ? `---\n${after.slice(prefix.length)}` : null;
    const stampMatches = !/^bornAs:/m.test(before) && unstamped !== null && isMappedRewrite(before, unstamped, map);
    if (!isMappedRewrite(before, after, map) && !stampMatches) return refuse(`rename content is not an id rewrite at ${deleted.path}`);
    used.add(hash);
    renames.push({ from: deleted.path, to: added.path });
  }
  if (additions.size) return refuse(`added path ${additions.keys().next().value} has no deleted rename partner`);
  for (const change of changes.filter((c) => c.status === 'M')) {
    if (typeof change.before !== 'string' || typeof change.after !== 'string') return refuse(`missing content blob at ${change.path}`);
    if (change.before === change.after) return refuse(`modified path ${change.path} is unchanged`);
    if (!isMappedRewrite(change.before, change.after, referenceMap)) return refuse(`modification is not an id rewrite at ${change.path}`);
  }
  for (const hash of map.keys()) {
    if (!used.has(hash)) return refuse(`subject pair ${hash} renamed no backlog card`);
  }
  return { ok: true, pairs: [...map], renames };
}

/** IO: a missing commit gets one fetch and re-check, with every failure handled by the outer refusal boundary. */
function ensureReadable(git, sha) {
  try { git(['cat-file', '-e', `${sha}^{commit}`]); }
  catch {
    git(['fetch', '--no-tags', '-q', 'origin', sha]);
    git(['cat-file', '-e', `${sha}^{commit}`]);
  }
}

/** IO: main's bornAs aliases are optional reference evidence. Missing matches or a failed grep yield no aliases. */
function readExtraMap(git, mainRef) {
  const map = new Map();
  const ambiguous = new Set();
  let output;
  try { output = git(['grep', '-E', '^bornAs: x[0-9a-z]{6}$', mainRef, '--', 'backlog/']); }
  catch { return map; }
  const prefix = `${mainRef}:`;
  for (const line of output.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const match = /^backlog\/(\d+)-[^/]+\.md:bornAs: (x[0-9a-z]{6})$/.exec(line.slice(prefix.length));
    if (!match) continue;
    const [, number, hash] = match;
    if (map.has(hash) && map.get(hash) !== number) ambiguous.add(hash);
    map.set(hash, number);
  }
  for (const hash of ambiguous) map.delete(hash);
  return map;
}

/**
 * IO (read-only git proof, apart from fetching missing objects): verify every new commit is drain numbering
 * in a bounded linear chain on fromSha. No git error escapes this function; grep is optional evidence.
 * @param {{exec:Function,fromSha:string,toSha:string,mainRef?:string,cwd?:string}} o
 * @returns {{ok:true,commits:string[],pairs:Array<[string,string]>,reason:string}|{ok:false,reason:string}}
 */
export function proveNumberingOnlyMove({ exec, fromSha, toSha, mainRef = 'origin/main', cwd } = {}) {
  try {
    if (typeof exec !== 'function' || !fromSha || !toSha) return refuse('no git reader or head');
    if (fromSha === toSha) return refuse('no head move');
    const git = (args) => String(exec('git', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...(cwd === undefined ? {} : { cwd }),
    }) ?? '');
    ensureReadable(git, fromSha);
    ensureReadable(git, toSha);
    // rev-list prints full shas: compare the chain's first parent against the resolved accepted head, not its spelling.
    fromSha = git(['rev-parse', '--verify', `${fromSha}^{commit}`]).trim();
    const lines = git(['rev-list', '--topo-order', '--reverse', '--parents', toSha, `^${fromSha}`]).trim().split('\n').filter(Boolean);
    if (!lines.length) return refuse('no new numbering commits');
    if (lines.length > MAX_NUMBERING_COMMITS) return refuse(`${lines.length} commits exceed numbering limit ${MAX_NUMBERING_COMMITS}`);
    const extraMap = readExtraMap(git, mainRef);
    const commits = [];
    const pairs = [];
    let parent = fromSha;
    for (const line of lines) {
      const [sha, ...parents] = line.trim().split(/\s+/);
      if (parents.length !== 1 || parents[0] !== parent) return refuse(`commit ${sha.slice(0, 9)} is not a linear single-parent step on ${parent}`);
      const subject = git(['log', '-1', '--format=%s', sha]).replace(/\n$/, '');
      const raw = git(['diff', '--no-renames', '--name-status', '-z', parent, sha]);
      if (raw && !raw.endsWith('\0')) return refuse(`malformed name-status diff at ${sha.slice(0, 9)}`);
      const fields = raw ? raw.slice(0, -1).split('\0') : [];
      if (fields.length % 2) return refuse(`malformed name-status diff at ${sha.slice(0, 9)}`);
      const changes = [];
      for (let i = 0; i < fields.length; i += 2) {
        const [status, path] = fields.slice(i, i + 2);
        if (!['A', 'D', 'M'].includes(status)) return refuse(`unsupported change status ${status} at ${path}`);
        const change = { status, path };
        if (status !== 'A') change.before = git(['cat-file', 'blob', `${parent}:${path}`]);
        if (status !== 'D') change.after = git(['cat-file', 'blob', `${sha}:${path}`]);
        changes.push(change);
      }
      const result = checkNumberingCommit({ subject, parents, changes, extraMap });
      if (!result.ok) return refuse(`commit ${sha.slice(0, 9)}: ${result.reason}`);
      commits.push(sha);
      pairs.push(...result.pairs);
      parent = sha;
    }
    return { ok: true, commits, pairs, reason: `${commits.length} drain numbering commit(s) ${commits.map((sha) => sha.slice(0, 9)).join(', ')} `
      + `(${pairs.map(([hash, number]) => `${hash}→#${number}`).join(', ')}) — card renames and id rewrites only` };
  } catch (e) {
    return refuse(`numbering proof failed: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

export const NUMBERING_RESTAMP_MARKER = 'numbering-restamp';
const RESTAMP_MARKER_RE = /<!--\s*numbering-restamp:\s*from=([0-9a-f]{40})\s+to=([0-9a-f]{40})\s*-->/i;
/** PURE: the `from` sha of a numbering re-stamp record that names `head`, else null. */
function restampMarkerFrom(body, head) {
  const m = RESTAMP_MARKER_RE.exec(typeof body === 'string' ? body : '');
  return m && m[2].toLowerCase() === head ? m[1].toLowerCase() : null;
}
const staleHealHeadline = buildStaleAcceptHealComment({}).split('\n')[0];
const stalePark = /^\s*<!--\s*drain-park-reason\s*-->\s*\n⏸ \*\*Parked for review by the drain\*\*\s*\n\s*review:accepted /;
const staleReason = /^(?:is STALE|could NOT be re-verified this pass) —/;

/** PURE: head-move diagnostics cannot supersede the acceptance they describe. */
export function isNumberingTolerableLaterBody(body) {
  if (isKnownMachineBody(body)) return true;
  if (typeof body !== 'string') return false;
  const park = stalePark.exec(body);
  return (park !== null && staleReason.test(body.slice(park[0].length))) || body.trimStart().startsWith(staleHealHeadline);
}

/** PURE: nominate an existing acceptance, retaining every later human/formal hold. */
export function planNumberingRestamp({ labels, headSha, comments, reviews } = {}) {
  const names = new Set((Array.isArray(labels) ? labels : []).map((l) => typeof l === 'string' ? l : l?.name));
  if (!names.has(REVIEW_LABELS.pending)
    || [REVIEW_LABELS.human, REVIEW_LABELS.changes, REVIEW_LABELS.heldMechanical].some((l) => names.has(l))) {
    return { candidate: false, reason: 'labels do not permit numbering carry' };
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) return { candidate: false, reason: 'live head unknown' };
  const rec = latestAcceptRecord(comments);
  if (!rec) return { candidate: false, reason: 'no recorded acceptance' };
  const head = headSha.toLowerCase();
  // A numbering re-stamp whose label write failed after its record was posted: finish the labels only. The record is
  // the trusted re-stamp itself (its own marker names this head), so no proof or second comment is owed.
  const own = rec.sha === head ? restampMarkerFrom(comments[rec.index]?.body, head) : null;
  if (rec.sha === head && !own) return { candidate: false, reason: 'already bound' };
  if (rec.laterBodyDerivedHold) return { candidate: false, reason: 'later body-derived hold' };
  if (comments.slice(rec.index + 1).some((c) => !isNumberingTolerableLaterBody(c?.body))) {
    return { candidate: false, reason: 'later verdict or unknown comment stands' };
  }
  if (!Array.isArray(reviews)) return { candidate: false, reason: 'formal reviews unreadable', retryable: true };
  if (laterReviewHold(reviews, rec.at)) return { candidate: false, reason: 'formal review hold stands' };
  if (own) return { candidate: true, labelsOnly: true, from: own, to: head, human: rec.humanCleared, actor: rec.actor };
  return { candidate: true, from: rec.sha, to: head, human: rec.humanCleared, actor: rec.actor };
}

// Same allow-list as human-clearance-carry; local to avoid a circular dependency between the two carry tiers.
const sanitizeActor = (actor) => String(actor ?? '').replace(/[^\p{L}\p{N}._-]+/gu, ' ').trim().slice(0, 64) || 'the operator';

/** PURE: the existing restamp headline and markers keep all acceptance readers in agreement. */
export function buildNumberingRestampBody({ fromSha, toSha, human, actor, headDiffText, proofReason, writer }) {
  const name = sanitizeActor(actor);
  return [
    '📌 review — acceptance re-stamped after a rebase (no new review)', '',
    `Recorded by ${writer} via numbering-carry. The head moved from \`${fromSha.slice(0, 12)}\` to \`${toSha.slice(0, 12)}\` `
      + `only by the drain's own card-numbering commit(s): ${proofReason}. Each commit was verified mechanically `
      + '(backlog card renames to their assigned numbers, the bornAs stamp, and id-to-number rewrites; nothing else). '
      + `The acceptance recorded on \`${fromSha.slice(0, 12)}\``
      + (human ? ` — the human clearance by ${name} —` : '')
      + ' is carried unchanged; any other change still needs a fresh review.', '',
    buildReviewedShaMarker(toSha),
    ...(typeof headDiffText === 'string' && headDiffText.length
      ? [buildReviewedDiffMarker(headDiffText), buildReviewedContributionMarker(headDiffText)] : []),
    ...(human ? [buildClearedHumanMarker(name)] : []),
    `<!-- ${NUMBERING_RESTAMP_MARKER}: from=${fromSha} to=${toSha} -->`,
  ].filter((line) => line != null).join('\n');
}

const settledRestamps = new Set();
export function _resetNumberingRestampMemo() { settledRestamps.clear(); }
/** Has this PR head already reached a settled numbering re-stamp outcome in this process? (lets a sweep skip its live re-read) */
export function numberingRestampSettled(repo, pr, head) { return settledRestamps.has(`${repo}#${pr}@${head}`); }
const errorReason = (e) => String(e?.message ?? e).split('\n')[0];

/** IO: prove first, record before labels; only settled proof outcomes are memoized. */
export function restampAfterNumbering({ repo, pr, state, reviews, exec = execFileSync, cwd, provider,
  readNetDiff, dryRun = false, writer = 'review-daemon', prove = proveNumberingOnlyMove } = {}) {
  const key = `${repo}#${pr}@${state?.headRefOid}`;
  if (settledRestamps.has(key)) return null;
  const plan = planNumberingRestamp({ labels: state?.labels, headSha: state?.headRefOid, comments: state?.comments, reviews });
  if (!plan.candidate) return plan.retryable ? { action: 'retry', reason: plan.reason } : null;
  if (plan.labelsOnly) {
    if (dryRun) return { action: 'would-restamp', from: plan.from, to: plan.to, human: plan.human, actor: plan.actor, labelsOnly: true };
    try { finishRecordedAcceptanceLabels({ provider, repo, pr, currentLabels: state.labels }); }
    catch (e) { return { action: 'error', reason: errorReason(e), commentPosted: true }; }
    settledRestamps.add(key);
    return { action: 'restamped', from: plan.from, to: plan.to, human: plan.human, actor: plan.actor, labelsOnly: true,
      reason: 'labels finished for the numbering re-stamp already recorded on this head' };
  }
  const proof = prove({ exec, cwd, fromSha: plan.from, toSha: plan.to });
  if (!proof.ok) {
    settledRestamps.add(key);
    return { action: 'refused', reason: proof.reason };
  }
  let headDiffText;
  try { const net = readNetDiff?.(plan.to); if (net?.scored) headDiffText = net.text; } catch { /* proof suffices */ }
  const carried = { from: plan.from, to: plan.to, human: plan.human, actor: plan.actor };
  if (dryRun) return { action: 'would-restamp', ...carried };
  const body = buildNumberingRestampBody({ fromSha: plan.from, toSha: plan.to, ...carried,
    headDiffText, proofReason: proof.reason, writer });
  try { provider.postComment(repo, pr, body); }
  catch (e) { return { action: 'error', reason: errorReason(e) }; }
  try { finishRecordedAcceptanceLabels({ provider, repo, pr, currentLabels: state.labels }); }
  catch (e) { return { action: 'error', reason: errorReason(e), commentPosted: true }; }
  settledRestamps.add(key);
  return { action: 'restamped', ...carried, reason: proof.reason };
}
