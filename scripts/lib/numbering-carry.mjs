/**
 * @file scripts/lib/numbering-carry.mjs
 * @description Carry acceptance only across mechanically proven drain numbering commits. A matching subject
 *   is necessary but insufficient: every change must be a backlog card rename, its optional bornAs stamp,
 *   or a whole-token id rewrite that leaves every existing `bornAs:` line untouched. The IO shell proves a bounded
 *   linear chain above the accepted head, and the writer re-reads the PR before each write.
 *
 *   THE LIVE CASE (WE PR #5025): 8d3f2044f → e2e7e3f97 numbered xf74q20→#6053 and xztd0mv→#6054.
 *   Two backlog cards were renamed and stamped; one existing card and the renamed cards had references
 *   rewritten. The parent acceptance looked stale despite no author change. This proof permits callers
 *   to carry it forward without trusting the drain's subject alone. Duplicate drops never qualify.
 */
import { proveIdenticalNetPatch, resolveIdenticalNetPatchSetting, logIdenticalNetPatchSetting } from './identical-net-patch.mjs';
import { readSettings } from './settings-files.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { execFileSync } from 'node:child_process';
import { BORN_AS_RE } from '../backlog/id.mjs';
import { finishRecordedAcceptanceLabels } from './review-label-provider.mjs';
import { isKnownMachineBody, latestAcceptRecord, laterReviewHold, resolveAcceptCarryForward } from './accept-carry-forward.mjs';
import { resolveHumanClearanceCarrySetting } from './human-clearance-carry.mjs';
import {
  REVIEW_LABELS, buildStaleAcceptHealComment, buildReviewedShaMarker, buildReviewedDiffMarker,
  buildReviewedContributionMarker, buildClearedHumanMarker,
} from './review-escalation.mjs';

/** Resolve the numbering-specific human policy through standard → platform → tool → env. */
export function resolveNumberingHumanClearanceSetting({ env = process.env, platform, tool = readSettings()?.review } = {}) {
  const raw = env?.WE_REVIEW_CARRY_HUMAN_CLEARANCE_ACROSS_NUMBERING;
  const parsed = ['true', 'on', '1'].includes(raw) ? true : ['false', 'off', '0'].includes(raw) ? false : raw;
  const key = 'carryHumanClearanceAcrossNumbering';
  const preference = platform === undefined ? platformPreference('review', { env }) : platform;
  const resolved = cascadePolicy('review', tool && { [key]: tool[key] }, {
    standard: { [key]: true }, platform: { [key]: preference?.[key] }, env,
    envValues: { [key]: parsed }, valid: v => typeof v === 'boolean',
  });
  return { value: resolved.value[key], source: resolved.sources[key] };
}

/** Carry referral evidence only after the exact numbering move has been proven. */
export function resolveNumberingCarryReferralEvidenceSetting({ env = process.env, platform, tool = readSettings()?.review } = {}) {
  const key = 'numberingCarryReferralEvidence';
  const raw = env?.WE_REVIEW_NUMBERING_CARRY_REFERRAL_EVIDENCE;
  const parsed = raw === undefined ? undefined : /^(true|on|1)$/i.test(raw) ? true : /^(false|off|0)$/i.test(raw) ? false : raw;
  const preference = platform === undefined ? platformPreference('review', { env }) : platform;
  const resolved = cascadePolicy('review', tool && { [key]: tool[key] }, {
    standard: { [key]: true }, platform: { [key]: preference?.[key] }, env,
    envValues: { [key]: parsed }, valid: v => typeof v === 'boolean',
  });
  return { value: resolved.value[key], source: resolved.sources[key] };
}
const loggedReferralEvidenceSettings = new Set();
function logNumberingCarryReferralEvidenceSetting(setting) {
  const key = `${setting.value}:${setting.source}`;
  if (loggedReferralEvidenceSettings.has(key)) return;
  loggedReferralEvidenceSettings.add(key);
  process.stderr.write(`policy · review.numberingCarryReferralEvidence=${setting.value} (${setting.source})\n`);
}

export const NUMBERING_SUBJECT_RE = /^drain: JIT-number (.+) at land \(#2288\)$/;
export const MAX_NUMBERING_COMMITS = 5;
export const MAX_NUMBERING_FILES = 256;
export const MAX_NUMBERING_BLOB_BYTES = 1024 * 1024;
export const MAX_NUMBERING_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5000;
const canonicalNumber = (number) => number.replace(/^0+(?=\d)/, '');

/** PURE: parse exact, unique hash→number pairs; malformed subjects and duplicate drops return null. */
export function parseNumberingSubject(subject) {
  if (typeof subject !== 'string') return null;
  const match = NUMBERING_SUBJECT_RE.exec(subject);
  if (!match || match[0] !== subject) return null;
  const pairs = new Map();
  const numbers = new Set();
  for (const entry of match[1].split(', ')) {
    const pair = /^(x[0-9a-z]{6})→#(\d+)$/.exec(entry);
    if (!pair || pair[0] !== entry || pairs.has(pair[1]) || numbers.has(canonicalNumber(pair[2]))) return null;
    pairs.set(pair[1], pair[2]);
    numbers.add(canonicalNumber(pair[2]));
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

/**
 * PURE: the drain's own rewrite rule (applyLedger): line by line, every mapped token may become its number EXCEPT on
 * a `bornAs: <hash>` line, which is a card's birth identity and must survive byte for byte. Numbers never contain a
 * newline, so a genuine rewrite keeps the line count.
 */
export function isLedgerRewrite(before, after, map) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length !== afterLines.length) return false;
  return beforeLines.every((line, i) => (BORN_AS_RE.test(line) ? line === afterLines[i] : isMappedRewrite(line, afterLines[i], map)));
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
  if (changes.length > MAX_NUMBERING_FILES) return refuse(`changed files exceed numbering file limit ${MAX_NUMBERING_FILES}`);
  const paths = new Set();
  for (const change of changes) {
    if (!['A', 'D', 'M'].includes(change.status)) return refuse(`unsupported change status ${change.status} at ${change.path}`);
    if (typeof change.path !== 'string' || paths.has(change.path)) return refuse(`invalid or repeated change path ${change.path}`);
    if (!/^backlog\/(?:[^/]+\/)*[^/]+\.md$/.test(change.path)
      || change.path.split('/').some((part) => part === '.' || part === '..')) return refuse(`id rewrite is outside backlog markdown at ${change.path}`);
    if (change.status === 'M' && change.beforeMode !== change.afterMode) return refuse(`file mode changed at ${change.path}`);
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
    if (deleted.beforeMode !== added.afterMode) return refuse(`rename file mode changed at ${deleted.path}`);
    if (typeof before !== 'string' || typeof after !== 'string') return refuse(`missing content blob for rename ${deleted.path}`);
    const prefix = `---\nbornAs: ${hash}\n`;
    const unstamped = after.startsWith(prefix) ? `---\n${after.slice(prefix.length)}` : null;
    const stampMatches = !/^bornAs:/m.test(before) && unstamped !== null && isLedgerRewrite(before, unstamped, referenceMap);
    if (!isLedgerRewrite(before, after, referenceMap) && !stampMatches) {
      return refuse(`rename content is not an id rewrite with every bornAs line kept at ${deleted.path}`);
    }
    used.add(hash);
    renames.push({ from: deleted.path, to: added.path });
  }
  if (additions.size) return refuse(`added path ${additions.keys().next().value} has no deleted rename partner`);
  for (const change of changes.filter((c) => c.status === 'M')) {
    if (typeof change.before !== 'string' || typeof change.after !== 'string') return refuse(`missing content blob at ${change.path}`);
    if (change.before === change.after) return refuse(`modified path ${change.path} is unchanged`);
    if (!isLedgerRewrite(change.before, change.after, referenceMap)) {
      return refuse(`modification is not an id rewrite with every bornAs line kept at ${change.path}`);
    }
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

/** IO: main's bornAs aliases are optional evidence; failed reads must not settle a refusal that needs them. */
function readExtraMap(git, mainRef) {
  const map = new Map();
  const ambiguous = new Set();
  let output;
  try { output = git(['grep', '-E', '^bornAs: x[0-9a-z]{6}$', mainRef, '--', 'backlog/']); }
  catch (e) { if (e?.status !== 1) map.readFailed = true; return map; }
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

/** IO: inventory filenames only; an unreadable tree is never evidence of an unused number. */
function readExistingNumbers(git, ref) {
  const output = git(['ls-tree', '-r', '--name-only', '-z', ref, '--', 'backlog/']);
  if (output && !output.endsWith('\0')) throw Error(`malformed backlog inventory at ${ref}`);
  const numbers = new Set();
  for (const path of output.split('\0')) {
    const match = /^backlog\/(\d+)-[^/]+\.md$/.exec(path);
    if (match) numbers.add(canonicalNumber(match[1]));
  }
  return numbers;
}

/**
 * IO (read-only git proof, apart from fetching missing objects): verify every new commit is drain numbering
 * in a bounded linear chain on fromSha. No git error escapes this function; grep is optional evidence.
 * @param {{exec:Function,fromSha:string,toSha:string,mainRef?:string,cwd?:string}} o
 * @returns {{ok:true,commits:string[],pairs:Array<[string,string]>,reason:string}|{ok:false,reason:string,retryable?:boolean}}
 */
export function proveNumberingOnlyMove({ exec, fromSha, toSha, mainRef = 'origin/main', cwd } = {}) {
  try {
    if (typeof exec !== 'function' || !fromSha || !toSha) return refuse('no git reader or head');
    if (fromSha === toSha) return refuse('no head move');
    // Fatal decoding makes string equality lossless for valid UTF-8. Preserve a BOM:
    // dropping it would itself conceal a non-numbering byte change.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const gitBytes = (args, maxBuffer = MAX_GIT_OUTPUT_BYTES) => {
      const output = exec('git', args, {
        encoding: null, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer, timeout: GIT_TIMEOUT_MS,
        ...(cwd === undefined ? {} : { cwd }),
      }) ?? Buffer.alloc(0);
      if (!Buffer.isBuffer(output)) throw Error('git reader must return raw bytes');
      if (output.length > maxBuffer) throw Error('git output exceeds byte limit');
      return output;
    };
    const git = (args, maxBuffer) => decoder.decode(gitBytes(args, maxBuffer));
    // Blob content is compared as text only once its text re-encodes to the exact bytes git stored, so no decoding
    // step (a dropped BOM, a replaced byte, a normalisation) can make two different byte sequences compare equal.
    const blobText = (object) => {
      const bytes = gitBytes(['cat-file', 'blob', object], MAX_NUMBERING_BLOB_BYTES);
      const text = decoder.decode(bytes);
      if (!Buffer.from(text, 'utf8').equals(bytes)) throw Object.assign(Error('blob text does not round-trip to its bytes'), { code: 'NUMBERING_BYTES_NOT_EXACT' });
      return text;
    };
    ensureReadable(git, fromSha);
    ensureReadable(git, toSha);
    // rev-list prints full shas: compare the chain's first parent against the resolved accepted head, not its spelling.
    fromSha = git(['rev-parse', '--verify', `${fromSha}^{commit}`]).trim();
    const lines = git(['rev-list', `--max-count=${MAX_NUMBERING_COMMITS + 1}`, '--topo-order', '--reverse', '--parents', toSha, `^${fromSha}`]).trim().split('\n').filter(Boolean);
    if (!lines.length) return refuse('no new numbering commits');
    if (lines.length > MAX_NUMBERING_COMMITS) return refuse(`${lines.length} commits exceed numbering limit ${MAX_NUMBERING_COMMITS}`);
    // Preflight the WHOLE chain before reading any content (including main aliases).
    const steps = [];
    let parent = fromSha;
    for (const line of lines) {
      const [sha, ...parents] = line.trim().split(/\s+/);
      if (parents.length !== 1 || parents[0] !== parent) return refuse(`commit ${sha.slice(0, 9)} is not a linear single-parent step on ${parent}`);
      const subject = git(['log', '-1', '--format=%s', sha]).replace(/\n$/, '');
      const map = parseNumberingSubject(subject);
      if (!map) return refuse(`commit ${sha.slice(0, 9)}: subject is not an exact drain numbering subject with unique pairs`);
      steps.push({ sha, parents, subject, map });
      parent = sha;
    }
    const existingNumbers = readExistingNumbers(git, fromSha);
    for (const number of readExistingNumbers(git, mainRef)) existingNumbers.add(number);
    for (const step of steps) {
      for (const number of step.map.values()) {
        const canonical = canonicalNumber(number);
        if (existingNumbers.has(canonical)) return refuse(`target number ${number} already exists in backlog`);
        existingNumbers.add(canonical);
      }
    }
    const extraMap = readExtraMap(git, mainRef);
    const commits = [];
    const pairs = [];
    let totalBytes = 0;
    parent = fromSha;
    for (const { sha, parents, subject } of steps) {
      // Plumbing, not porcelain `git diff`: no diff config (diff.ignoreSubmodules, a .gitmodules ignore, diff.relative)
      // may drop an entry — a hidden gitlink would never reach the mode allow-list below.
      const raw = git(['diff-tree', '-r', '--no-renames', '--raw', '--no-abbrev', '-z', '--ignore-submodules=none', parent, sha]);
      if (raw && !raw.endsWith('\0')) return refuse(`malformed name-status diff at ${sha.slice(0, 9)}`);
      const fields = raw ? raw.slice(0, -1).split('\0') : [];
      if (fields.length % 2) return refuse(`malformed name-status diff at ${sha.slice(0, 9)}`);
      if (fields.length / 2 > MAX_NUMBERING_FILES) return refuse(`changed files exceed numbering file limit ${MAX_NUMBERING_FILES}`);
      const changes = [];
      for (let i = 0; i < fields.length; i += 2) {
        const [metadata, path] = fields.slice(i, i + 2);
        const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/.exec(metadata);
        if (!match) return refuse(`malformed raw diff at ${sha.slice(0, 9)}`);
        const [, beforeMode, afterMode, beforeOid, afterOid, status] = match;
        if (!['A', 'D', 'M'].includes(status)) return refuse(`unsupported change status ${status} at ${path}`);
        if ((status !== 'A' && !['100644', '100755'].includes(beforeMode))
          || (status !== 'D' && !['100644', '100755'].includes(afterMode))) return refuse(`unsupported file mode at ${path}`);
        const change = { status, path, beforeMode, afterMode, beforeOid, afterOid };
        changes.push(change);
      }
      for (const change of changes) {
        for (const side of ['before', 'after']) {
          if ((side === 'before' && change.status === 'A') || (side === 'after' && change.status === 'D')) continue;
          // By the object id the diff named, never `<rev>:<path>`: git's path lookup can fold a path onto a different
          // entry (core.precomposeunicode maps an NFD name onto its NFC twin), so a path read may return another blob.
          const object = change[`${side}Oid`];
          if (/^0{40}$/.test(object)) return refuse(`missing blob id at ${change.path}`);
          if (git(['cat-file', '-t', object]).trim() !== 'blob') return refuse(`object at ${change.path} is not a blob`);
          const sizeText = git(['cat-file', '-s', object]).trim();
          if (!/^\d+$/.test(sizeText)) return refuse(`invalid blob size at ${change.path}`);
          const size = Number(sizeText);
          if (!Number.isSafeInteger(size) || size > MAX_NUMBERING_BLOB_BYTES || totalBytes + size > MAX_NUMBERING_TOTAL_BYTES) {
            return refuse(`blob byte limit exceeded at ${change.path}`);
          }
          totalBytes += size;
          change[side] = blobText(object);
        }
      }
      const result = checkNumberingCommit({ subject, parents, changes, extraMap });
      if (!result.ok) return { ...refuse(`commit ${sha.slice(0, 9)}: ${result.reason}`), ...(extraMap.readFailed ? { retryable: true } : {}) };
      commits.push(sha);
      pairs.push(...result.pairs);
      parent = sha;
    }
    return { ok: true, commits, pairs, reason: `${commits.length} drain numbering commit(s) ${commits.map((sha) => sha.slice(0, 9)).join(', ')} `
      + `(${pairs.map(([hash, number]) => `${hash}→#${number}`).join(', ')}) — card renames and id rewrites only` };
  } catch (e) {
    if (e?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return refuse('numbering proof contains invalid UTF-8');
    if (e?.code === 'NUMBERING_BYTES_NOT_EXACT') return refuse('numbering proof blob text does not match its exact bytes');
    return { ...refuse(`numbering proof failed: ${String(e?.message ?? e).split('\n')[0]}`), retryable: true };
  }
}

export const NUMBERING_RESTAMP_MARKER = 'numbering-restamp';
const RESTAMP_HEADLINE = '📌 review — acceptance re-stamped after a rebase (no new review)';
const RESTAMP_MARKER_LINE_RE = /^<!-- numbering-restamp: from=([0-9a-f]{40}) to=([0-9a-f]{40}) -->$/i;
/**
 * PURE: `{from, to, rec}` when `c` is a trusted numbering re-stamp record, else null. Only the exact shape the writer
 * emits counts — the headline as the first line and the marker as the last — so a quoted or juror-written marker
 * inside another trusted comment is never mistaken for one.
 */
function restampRecord(c) {
  const lines = (typeof c?.body === 'string' ? c.body.trimEnd().split(/\r?\n/) : []).map((l) => l.trimEnd());
  const m = lines[0] === RESTAMP_HEADLINE ? RESTAMP_MARKER_LINE_RE.exec(lines[lines.length - 1]) : null;
  const rec = m ? latestAcceptRecord([c]) : null;
  return rec && rec.sha === m[2].toLowerCase() ? { from: m[1].toLowerCase(), to: rec.sha, rec } : null;
}
const sameClearance = (a, b) => Boolean(a.humanCleared) === Boolean(b.humanCleared)
  && (!a.humanCleared || sanitizeActor(a.actor) === sanitizeActor(b.actor));
const sourceKey = (comments, c, at) => (c?.id != null ? `id:${c.id}` : `at:${at ?? ''}#${comments.indexOf(c)}`);

/**
 * PURE: the thread with every numbering re-stamp record that does not carry exactly the acceptance before it dropped.
 * A record counts only when the acceptance before it names its `from` sha with the same clearance and nothing but
 * tolerable bodies stand between them; anything else (a newer acceptance or a hold posted in the gap before our
 * record) makes it no acceptance at all, on this head and every later one. `carried` maps each kept record to the
 * acceptance it carried, and `rootAt` maps each kept acceptance to the time of the review that started its chain.
 */
function validatedThread(comments) {
  const view = [];
  const carried = new Map();
  const rootAt = new Map();
  // Records dropped here still read as acceptances to every other reader, so they are owed a withdrawal.
  const dropped = [];
  for (const c of comments) {
    const r = restampRecord(c);
    if (r) {
      const prior = latestAcceptRecord(view);
      if (!prior || prior.sha !== r.from || prior.laterBodyDerivedHold || !sameClearance(prior, r.rec)
        || view.slice(prior.index + 1).some((x) => !isNumberingTolerableLaterBody(x?.body))) { dropped.push(c); continue; }
      carried.set(c, { comment: view[prior.index], at: prior.at });
      // `has`, not `??`: an unknown (null) root time must stay unknown, which counts every formal review.
      rootAt.set(c, rootAt.has(view[prior.index]) ? rootAt.get(view[prior.index]) : prior.at);
    }
    view.push(c);
  }
  return { view, carried, rootAt, dropped };
}

export const NUMBERING_WITHDRAWN_MARKER = 'numbering-restamp-withdrawn';
const WITHDRAWN_HEADLINE = '🚫 review — numbering re-stamp withdrawn (no acceptance)';
const WITHDRAWN_MARKER_LINE_RE = /^<!-- numbering-restamp-withdrawn: from=([0-9a-f]{40}) to=([0-9a-f]{40}) -->$/;
const WITHDRAWN_WRITER_RE = /^Recorded by ([A-Za-z0-9._-]{1,64}) via numbering-carry\. /;

/**
 * PURE: the inert body a withdrawn re-stamp record is edited into. It carries none of the acceptance markers
 * (`reviewed-sha`, `reviewed-diff`, `reviewed-contribution`, `cleared-human`, the re-stamp marker), so every
 * acceptance reader — `latestAcceptRecord`, `readDrainAcceptance` and the drain reconcile — finds no acceptance in it.
 */
export function buildNumberingWithdrawnBody({ fromSha, toSha, writer }) {
  return [
    WITHDRAWN_HEADLINE, '',
    `Recorded by ${writer} via numbering-carry. A hold or a newer acceptance reached this PR while the numbering `
      + `re-stamp of \`${fromSha.slice(0, 12)}\` → \`${toSha.slice(0, 12)}\` was being written, so that re-stamp is `
      + 'withdrawn: it carries no acceptance. A fresh review of the head is owed.', '',
    `<!-- ${NUMBERING_WITHDRAWN_MARKER}: from=${fromSha} to=${toSha} -->`,
  ].join('\n');
}

/** PURE: only the exact body the writer emits counts as a withdrawal notice, so it can never carry an objection. */
function isWithdrawnNotice(body) {
  // Line endings as `restampRecord` reads them: a notice read back with CRLF is still the same notice.
  const text = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trimEnd() : '';
  const lines = text.split('\n');
  const m = lines[0] === WITHDRAWN_HEADLINE ? WITHDRAWN_MARKER_LINE_RE.exec(lines[lines.length - 1]) : null;
  const writer = m ? WITHDRAWN_WRITER_RE.exec(lines[2] ?? '') : null;
  return Boolean(writer) && text === buildNumberingWithdrawnBody({ fromSha: m[1], toSha: m[2], writer: writer[1] });
}
const staleHealHeadline = buildStaleAcceptHealComment({}).split('\n')[0];
const stalePark = /^\s*<!--\s*drain-park-reason\s*-->\s*\n⏸ \*\*Parked for review by the drain\*\*\s*\n\s*review:accepted /;
const staleReason = /^(?:is STALE|could NOT be re-verified this pass) —/;

/** PURE: head-move diagnostics cannot supersede the acceptance they describe. */
export function isNumberingTolerableLaterBody(body) {
  if (isKnownMachineBody(body)) return true;
  if (typeof body !== 'string') return false;
  // A withdrawal is not itself a hold: whatever caused it still stands on the thread and is judged on its own.
  if (isWithdrawnNotice(body)) return true;
  const park = stalePark.exec(body);
  return (park !== null && staleReason.test(body.slice(park[0].length))) || body.trimStart().startsWith(staleHealHeadline);
}

/** PURE: nominate an existing acceptance, retaining every later human/formal hold. */
/**
 * PURE: the re-stamp records other acceptance readers still honour although the planner does not — each one written
 * over a hold that stood BEFORE it (where the "what came after the record" readers cannot see it):
 *   - a record the thread validation drops (a hold, or a newer acceptance, posted in the gap before it);
 *   - a carried record a formal review hides from those readers: submitted after the review that started its chain
 *     but before the record itself (the record re-dates the acceptance, so a reader timing from it misses the review).
 * A hold posted AFTER a record is never a reason to withdraw it: any author can post one, and the readers see it.
 * `reviews` unread (not an array) checks the thread only.
 */
export function strandedNumberingRecords(comments, reviews = undefined) {
  return strandedFrom(validatedThread(Array.isArray(comments) ? comments : []), reviews);
}
/**
 * PURE: every numbering re-stamp record on the thread, kept or not. A comment listing has no formal reviews, so a
 * record it validates may still be stranded by a review only a live read shows: each one is a reason to read live.
 */
export function listedNumberingRecords(comments) {
  return (Array.isArray(comments) ? comments : []).filter((c) => restampRecord(c));
}
const commentAt = (c) => (typeof c?.createdAt === 'string' ? c.createdAt : (typeof c?.created_at === 'string' ? c.created_at : null));
function strandedFrom({ carried, rootAt, dropped }, reviews) {
  const hidden = Array.isArray(reviews)
    ? [...carried.keys()].filter((c) => laterReviewHold(reviews, rootAt.get(c)) && !laterReviewHold(reviews, commentAt(c))) : [];
  return [...dropped, ...hidden];
}

export function planNumberingRestamp({ labels, headSha, comments, reviews } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  // A re-stamp record is judged against the acceptance it carried, never trusted as an acceptance on its own.
  const thread = validatedThread(list);
  const { view, carried, rootAt } = thread;
  // `stranded` rides on every outcome, whatever the labels say: those records are owed a withdrawal regardless.
  const stranded = strandedFrom(thread, reviews);
  const out = (plan) => (stranded.length ? { ...plan, stranded } : plan);
  const names = new Set((Array.isArray(labels) ? labels : []).map((l) => typeof l === 'string' ? l : l?.name));
  // `hold`: after our own post, any label state but pending-only (a verdict swap, a human park, another writer's
  // labels) means the record must not stand on its own.
  if (!names.has(REVIEW_LABELS.pending)
    || [REVIEW_LABELS.human, REVIEW_LABELS.changes, REVIEW_LABELS.heldMechanical].some((l) => names.has(l))) {
    return out({ candidate: false, reason: 'labels do not permit numbering carry', hold: true });
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) return out({ candidate: false, reason: 'live head unknown' });
  const head = headSha.toLowerCase();
  const rec = latestAcceptRecord(view);
  if (!rec) return out({ candidate: false, reason: 'no recorded acceptance' });
  const src = view[rec.index];
  // A numbering re-stamp whose label write failed after its record was posted: finish the labels only. The record was
  // validated against the acceptance it carried, so no proof or second comment is owed.
  const labelsOnly = rec.sha === head && carried.has(src);
  if (rec.sha === head && !labelsOnly) return out({ candidate: false, reason: 'already bound' });
  const held = (reason) => out({ candidate: false, reason, hold: true });
  if (rec.laterBodyDerivedHold) return held('later body-derived hold');
  if (view.slice(rec.index + 1).some((c) => !isNumberingTolerableLaterBody(c?.body))) {
    return held('later verdict or unknown comment stands');
  }
  if (!Array.isArray(reviews)) return out({ candidate: false, reason: 'formal reviews unreadable', retryable: true });
  // From the review that started the chain: a re-stamp re-dates the record without being a review.
  if (laterReviewHold(reviews, rootAt.has(src) ? rootAt.get(src) : rec.at)) return held('formal review hold stands');
  // The acceptance comment this plan carries: a newer record on the same sha is a different acceptance.
  if (labelsOnly) {
    const { comment, at } = carried.get(src);
    return out({ candidate: true, labelsOnly: true, from: restampRecord(src).from, to: head, human: rec.humanCleared,
      actor: rec.actor, source: sourceKey(list, comment, at) });
  }
  return out({ candidate: true, from: rec.sha, to: head, human: rec.humanCleared, actor: rec.actor, source: sourceKey(list, src, rec.at) });
}

// Same allow-list as human-clearance-carry; local to avoid a circular dependency between the two carry tiers.
// Cut by code point before trimming, so sanitizing an already-sanitized name returns it unchanged.
const sanitizeActor = (actor) => Array.from(String(actor ?? '').replace(/[^\p{L}\p{N}._-]+/gu, ' ')).slice(0, 64).join('').trim()
  || 'the operator';

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
/**
 * Re-stamp records whose withdrawal was started and not finished, by PR (`repo#pr` → comment node ids). A hold the
 * thread cannot show (a label swap) leaves nothing to re-derive the withdrawal from, so a failed edit is remembered
 * here and every later pass finishes it. Process-local, like the settled memo.
 */
const owedWithdrawals = new Map();
export function _resetNumberingRestampMemo() { settledRestamps.clear(); owedWithdrawals.clear(); }
/** Is a numbering re-stamp withdrawal still owed on this PR? `repo` null matches the PR number in any repository. */
export function numberingWithdrawalOwed(repo, pr) {
  const tail = `#${pr}`;
  return [...owedWithdrawals].some(([k, ids]) => ids.size > 0 && (repo == null ? k.endsWith(tail) : k === `${repo}${tail}`));
}
/** Has this PR head already reached a settled numbering re-stamp outcome in this process? (lets a sweep skip its live re-read) */
export function numberingRestampSettled(repo, pr, head) { return settledRestamps.has(`${repo}#${pr}@${head}`); }
const errorReason = (e) => String(e?.message ?? e).split('\n')[0];

// Numbering carries missing review evidence from the accepted head, never a live-head
// referral hold or read failure. Only the guard's explicit no-review-run code is
// satisfied by the proven move and the prior head's independently checked clearance;
// an unfinished live-head run shares the prose refusal but can never be overridden.
function guardNumberingReferrals({ state, plan, proven, guardReferrals, repo, pr }) {
  if (!proven) return guardReferrals(state, { repo, pr });
  guardReferrals({ ...state, headRefOid: plan.from }, { repo, pr });
  try { return guardReferrals(state, { repo, pr }); }
  catch (e) {
    if (e?.code !== 'MANDATORY_REFERRAL_NO_REVIEW_RUN') throw e;
  }
}

/**
 * IO: re-read the PR and re-plan right before a write, so a hold, head move or label change that arrived while the
 * proof ran wins over the plan it was given. Returns the fresh state, or the result to return without writing.
 * Nothing here is memoized: a held or unreadable head is planned again on the next pass.
 */
function replanBeforeWrite({ readLiveState, expected, guardReferrals, proveReferralMove, repo, pr }) {
  if (typeof readLiveState !== 'function') return { result: { action: 'retry', reason: 'no live re-read before the write' } };
  let live;
  try { live = readLiveState(); }
  catch (e) { return { result: { action: 'retry', reason: `live re-read failed: ${errorReason(e)}` } }; }
  const state = live?.state;
  if (!state || !Array.isArray(state.comments) || !Array.isArray(state.labels)) {
    return { result: { action: 'retry', reason: 'live re-read returned no complete thread' } };
  }
  const plan = planNumberingRestamp({ labels: state.labels, headSha: state.headRefOid, comments: state.comments, reviews: live.reviews });
  // `comments`, `stranded` and `hold` let a caller that already posted withdraw what the fresh plan does not honour.
  const seen = { comments: state.comments, stranded: plan.stranded ?? [] };
  if (!plan.candidate) {
    return { ...seen, hold: Boolean(plan.hold), result: { action: plan.retryable ? 'retry' : 'held', reason: `live re-read: ${plan.reason}` } };
  }
  // The write uses the first plan's clearance, so the fresh one must match it: the same human flag, the same actor (as
  // written into the record) and the same source acceptance comment. Any change aborts unsettled.
  const clearedBy = (p) => (p.human ? sanitizeActor(p.actor) : null);
  if (plan.from !== expected.from || plan.to !== expected.to || Boolean(plan.labelsOnly) !== Boolean(expected.labelsOnly)
    || Boolean(plan.human) !== Boolean(expected.human) || clearedBy(plan) !== clearedBy(expected) || plan.source !== expected.source) {
    return { ...seen, hold: true, result: { action: 'retry', reason: 'live re-read: the acceptance plan changed' } };
  }
  // A referral hold, or an unreadable referral record, is never proof the acceptance still stands.
  try {
    const proof = proveReferralMove?.(plan);
    guardNumberingReferrals({ state, plan, proven: proof?.ok, guardReferrals, repo, pr });
    // Clearance cannot replace the numbering proof this pass relied on. Abort even
    // when the live-head guard clears; a later pass can establish a fresh proof.
    if (proveReferralMove && !proof?.ok) {
      return { ...seen, hold: true, result: { action: 'retry', reason: `live numbering proof failed: ${proof?.reason ?? 'unreadable proof'}` } };
    }
  }
  catch (e) { return { ...seen, hold: true, result: { action: 'retry', reason: errorReason(e) } }; }
  return { state };
}

/** IO: edit each stranded re-stamp record into the inert withdrawal notice. Throws on the first failed edit. */
export const MAX_WITHDRAWALS_PER_PASS = 10;
function withdrawRecords({ provider, repo, pr, records, writer }) {
  const done = new Set();
  const owedKey = `${repo}#${pr}`;
  // Owed from the moment the withdrawal is decided until its edit lands: a failure (or a crash) leaves it owed.
  const owed = owedWithdrawals.get(owedKey) ?? new Set();
  for (const c of records) if (restampRecord(c) && typeof c.id === 'string' && c.id) owed.add(c.id);
  if (owed.size) owedWithdrawals.set(owedKey, owed);
  for (const c of records) {
    const r = restampRecord(c);
    if (!r || done.has(c.id)) continue;
    // Bounded per pass: any remainder is still stranded, so the next pass withdraws it.
    if (done.size >= MAX_WITHDRAWALS_PER_PASS) break;
    if (typeof c.id !== 'string' || !c.id) throw Error('re-stamp record has no comment id');
    if (typeof provider?.editComment !== 'function') throw Error('provider cannot edit a comment');
    provider.editComment(repo, c.id, buildNumberingWithdrawnBody({ fromSha: r.from, toSha: r.to, writer }), { pr });
    done.add(c.id);
    owed.delete(c.id);
    if (!owed.size) owedWithdrawals.delete(owedKey);
  }
  return done.size;
}

/** PURE-ish: the owed records still standing on this thread; an owed id that is no longer a record is forgiven. */
function owedRecordsOn({ repo, pr, comments }) {
  const key = `${repo}#${pr}`;
  const owed = owedWithdrawals.get(key);
  if (!owed || !Array.isArray(comments)) return [];
  const standing = comments.filter((c) => owed.has(c?.id) && restampRecord(c));
  // Forgiven: edited into the notice (by anyone), or gone from the thread the caller just read.
  const kept = new Set(standing.map((c) => c.id));
  for (const id of [...owed]) if (!kept.has(id)) owed.delete(id);
  if (!owed.size) owedWithdrawals.delete(key);
  return standing;
}

/**
 * The referral guard is supplied by the writer (`review-set-label.mjs#assertMandatoryReferralsCleared`), not imported:
 * that module imports the drain (`merge-ai-prs.mjs`), which imports this file through human-clearance-carry, so an
 * import here would close a cycle and load the whole label writer into every drain run. Without one, nothing is
 * written: the pass retries.
 */
function refuseWithoutReferralGuard() { throw Error('no mandatory-referral guard supplied'); }

/** IO: prove first, re-read before every write, record before labels; only settled proof outcomes are memoized. */
export function restampAfterNumbering({ repo, pr, state, reviews, exec = execFileSync, cwd, provider,
  readNetDiff, readLiveState, dryRun = false, writer = 'review-daemon', prove = proveNumberingOnlyMove,
  numberingSetting = resolveNumberingHumanClearanceSetting(), netPatchSetting = resolveIdenticalNetPatchSetting(),
  enabled = resolveHumanClearanceCarrySetting().value, acceptCarry = resolveAcceptCarryForward().value,
  guardReferrals = refuseWithoutReferralGuard, referralEvidenceSetting = resolveNumberingCarryReferralEvidenceSetting() } = {}) {
  const key = `${repo}#${pr}@${state?.headRefOid}`;
  const plan = planNumberingRestamp({ labels: state?.labels, headSha: state?.headRefOid, comments: state?.comments, reviews });
  // A record an earlier pass left on the thread (its withdrawal failed, or the process died after the post) is
  // withdrawn first, whatever the labels, the carry switch or the settled memo say: switching the carry off must
  // never leave its records standing. The next pass plans from the thread as it then stands.
  // A withdrawal an earlier pass started and could not finish is owed too, even when the hold that caused it (a label
  // swap) cannot be re-derived from the thread now.
  const owedNow = owedRecordsOn({ repo, pr, comments: state?.comments });
  const toWithdraw = [...(plan.stranded ?? []), ...owedNow.filter((c) => !plan.stranded?.includes(c))];
  if (toWithdraw.length) {
    if (dryRun) return { action: 'would-withdraw', withdrawn: toWithdraw.length, reason: plan.reason ?? 'stranded re-stamp record' };
    let withdrawn;
    try { withdrawn = withdrawRecords({ provider, repo, pr, records: toWithdraw, writer }); }
    catch (e) { return { action: 'error', reason: `withdrawal failed: ${errorReason(e)}` }; }
    return { action: 'withdrawn', withdrawn, reason: 're-stamp record(s) that carry no standing acceptance withdrawn' };
  }
  if (!enabled || acceptCarry !== 'on') return null;
  if (settledRestamps.has(key)) return null;
  if (!plan.candidate) return plan.retryable ? { action: 'retry', reason: plan.reason } : null;
  if (plan.human && !numberingSetting.value && !netPatchSetting.value) return null;
  logNumberingCarryReferralEvidenceSetting(referralEvidenceSetting);
  const numberingOff = plan.human && !numberingSetting.value;
  const proveMove = (p) => {
    if (numberingOff) return { ok: false, reason: 'numbering carry disabled' };
    try { return prove({ exec, cwd, fromSha: p.from, toSha: p.to }); }
    catch (e) { return { ok: false, retryable: true, reason: errorReason(e) }; }
  };
  // An identical-net-patch fallback is not numbering evidence. Only the numbering proof
  // permits checking the accepted prior head; every other path keeps the current-head guard.
  const numberingProof = referralEvidenceSetting.value ? proveMove(plan) : null;
  try { guardNumberingReferrals({ state, plan, proven: numberingProof?.ok, guardReferrals, repo, pr }); }
  catch (e) { return { action: 'retry', reason: errorReason(e) }; }
  const recheck = (labelsOnly) => replanBeforeWrite({ readLiveState, guardReferrals,
    proveReferralMove: numberingProof?.ok ? proveMove : undefined, repo, pr,
    expected: { from: plan.from, to: plan.to, labelsOnly, human: plan.human, actor: plan.actor, source: plan.source } });
  // A check that does not confirm the write withdraws every record the fresh plan finds stranded and — only for the
  // record THIS pass just posted (`own`) — any hold: one that landed between the pre-write check and the post sits
  // before the record, where other readers read it as superseded. An older record is never withdrawn for a hold
  // posted after it (any author can post one, and every reader sees it).
  const withdrawAfter = (check, own = null) => {
    const records = [...check.stranded ?? [], ...(own && check.hold && Array.isArray(check.comments) ? check.comments.filter(own) : [])];
    if (!records.length) return { ...check.result, commentPosted: true };
    try { return { ...check.result, commentPosted: true, withdrawn: withdrawRecords({ provider, repo, pr, records, writer }) }; }
    catch (e) { return { action: 'error', reason: `withdrawal failed: ${errorReason(e)}`, commentPosted: true }; }
  };
  const isRecordOf = (from, to) => (c) => { const r = restampRecord(c); return Boolean(r) && r.from === from && r.to === to; };
  if (plan.labelsOnly) {
    if (dryRun) return { action: 'would-restamp', from: plan.from, to: plan.to, human: plan.human, actor: plan.actor, labelsOnly: true };
    const live = recheck(true);
    if (!live.state) return withdrawAfter(live);
    try { finishRecordedAcceptanceLabels({ provider, repo, pr, currentLabels: live.state.labels }); }
    catch (e) { return { action: 'error', reason: errorReason(e), commentPosted: true }; }
    settledRestamps.add(key);
    return { action: 'restamped', from: plan.from, to: plan.to, human: plan.human, actor: plan.actor, labelsOnly: true,
      reason: 'labels finished for the numbering re-stamp already recorded on this head' };
  }
  const netSetting = netPatchSetting;
  logIdenticalNetPatchSetting(netSetting);
  // A disabled numbering proof is a setting, not a verdict: its refusal is never memoized, so switching it on takes effect.
  let proof = numberingProof ?? (numberingOff ? { ok: false, reason: 'numbering carry disabled' } : prove({ exec, cwd, fromSha: plan.from, toSha: plan.to }));
  if (!proof.ok && netSetting.value) {
    // An alternative proof cannot settle a head the first proof could not read: either retryable miss stays retryable.
    const net = proveIdenticalNetPatch({ exec, cwd, fromSha: plan.from, toSha: plan.to });
    proof = net.ok ? net : { ...net, retryable: Boolean(proof.retryable || net.retryable), reason: `${proof.reason}; net patch: ${net.reason}` };
  }
  if (!proof.ok) {
    if (!proof.retryable && !numberingOff) settledRestamps.add(key);
    return { action: proof.retryable ? 'retry' : 'refused', reason: proof.reason };
  }
  let headDiffText;
  try { const net = readNetDiff?.(plan.to); if (net?.scored) headDiffText = net.text; } catch { /* proof suffices */ }
  const carried = { from: plan.from, to: plan.to, human: plan.human, actor: plan.actor };
  if (dryRun) return { action: 'would-restamp', ...carried };
  const body = buildNumberingRestampBody({ fromSha: plan.from, toSha: plan.to, ...carried,
    headDiffText, proofReason: proof.reason, writer });
  // The proof and diff read are slow: a hold posted meanwhile would sit BEFORE the new record and read as superseded.
  const before = recheck(false);
  if (!before.state) return before.result;
  try { provider.postComment(repo, pr, body); }
  catch (e) { return { action: 'error', reason: errorReason(e) }; }
  // The record is now on the thread; a hold posted after it still keeps review:pending, and any hold found now
  // (including one that landed between the check above and the post) withdraws the record.
  const after = recheck(true);
  if (!after.state) return withdrawAfter(after, isRecordOf(plan.from, plan.to));
  try { finishRecordedAcceptanceLabels({ provider, repo, pr, currentLabels: after.state.labels }); }
  catch (e) { return { action: 'error', reason: errorReason(e), commentPosted: true }; }
  settledRestamps.add(key);
  return { action: 'restamped', ...carried, reason: proof.reason };
}
