/**
 * Read and append operator review precedents so jurors can learn from past rulings.
 * Storage is review-precedents/<repo-slug>.jsonl on the ops/review-requests git branch.
 * Three promises: unreadable is never empty; each append is computed against the tip
 * it races; exhaustion is loud and carries every attempt's error.
 * Capture writes DRAFTS only. Promotion is a separate operator/orchestrator step.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPushRef, readFromTransportBranch, stageOnTransportBranch } from './git-transport-branch.mjs';
import { readSettings } from './settings-files.mjs';
import {
  parsePrecedentLog, precedentEventId, foldPrecedents, foldCitations,
  resolvePrecedentSettings, formatPrecedentSettings, captureFromComment,
  scopeHintsFromBody, draftRecordFromCapture, validatePrecedent, extractCitations, citationEvent, citationCommentKey,
  currentCommentCitations, citationRetractions, citationSupersedes, readEvent, latestReadAt, clampFutureStamps,
} from './review-precedents.mjs';
import { resolveOperationRoute } from './dispatch-routing-policy-io.mjs';
import { claudeSpawnAlias } from './dispatch-routing-policy.mjs';
import { fenceUntrusted, FENCED_DATA_RULE } from './mandate-fence.mjs';
import { OPERATOR_LOGINS, AUTOMATION_LOGINS } from './marker-authorship.mjs';
import { parseOperatorRulingComment } from './jury-core.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';

export const PRECEDENT_TRANSPORT_BRANCH = 'ops/review-requests';
export const PRECEDENT_PUSH_REF = 'refs/heads/ops/review-requests';
export const PRECEDENT_DIR = 'review-precedents';
// Resolve a filesystem path so Vite does not rewrite the seed URL as a browser asset.
const seedsPath = join(dirname(fileURLToPath(import.meta.url)), '../review-precedents.seeds.json');
const trustedSeeds = JSON.parse(readFileSync(seedsPath, 'utf8')).precedents;
const trust = { operatorLogins: OPERATOR_LOGINS, trustedSeeds };

export function precedentGitPath(repo) {
  const slug = String(repo ?? '').trim().replace(/[/\\\s\x00-\x1f]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${PRECEDENT_DIR}/${slug}.jsonl`;
}

export function readPrecedentLog({ board, repo, branch = PRECEDENT_TRANSPORT_BRANCH, run } = {}) {
  try {
    const path = precedentGitPath(repo);
    const files = readFromTransportBranch({ board, branch, paths: [path], run });
    return { status: 'ok', ...parsePrecedentLog(files[path] ?? '', trust) };
  } catch (error) {
    return { status: 'unreadable', reason: 'transport-read-failed', error: String(error?.message ?? error) };
  }
}

export class PrecedentAppendExhaustedError extends Error {
  constructor({ repo, attempts, errors }) {
    super(`review-precedents: append to ${repo} FAILED after ${attempts} attempts; last error: ${errors.at(-1)?.message ?? 'unknown'}`);
    this.name = 'PrecedentAppendExhaustedError';
    this.repo = repo;
    this.attempts = attempts;
    this.errors = errors;
  }
}

const FUTURE_STAMP_SKEW_MS = 10 * 60 * 1000;
const defaultSleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function appendPrecedentEvents({
  board, repo, events, branch = PRECEDENT_TRANSPORT_BRANCH, attempts = 5,
  sleep = defaultSleep, onRetry, stage = stageOnTransportBranch, citationSnapshot, now = Date.now, ...seams
} = {}) {
  assertPushRef(branch, PRECEDENT_PUSH_REF);
  // citationSnapshot: { pr, at } marks `events` as EVERY citation one PR's complete thread yields now (it may be
  // empty), so stored comments missing from it are withdrawn against the tip this append races. With
  // { pr, at, info } (the PR read) the events are derived on each tip instead, so a comment keeps the head the tip
  // recorded for it even when another backfill appended between this one's log read and its append.
  if (citationSnapshot !== undefined && (!Number.isSafeInteger(citationSnapshot?.pr) || citationSnapshot.pr < 1
    || typeof citationSnapshot.at !== 'string' || !Number.isFinite(Date.parse(citationSnapshot.at))
    || (citationSnapshot.info !== undefined && (typeof citationSnapshot.info !== 'object' || citationSnapshot.info === null)))) {
    throw new TypeError('citationSnapshot must be { pr, at, info? } with a timed at');
  }
  const deriveFrom = citationSnapshot?.info;
  const derive = stored => recordCitationsFromComments({ repo, pr: citationSnapshot.pr, info: deriveFrom, at: citationSnapshot.at, stored });
  if (deriveFrom && events !== undefined) throw new TypeError('a citation snapshot with info derives its own events');
  if (deriveFrom) derive([]); // A bad PR read fails here, once, not on every retry.
  else if (!Array.isArray(events) || (!events.length && !citationSnapshot)) throw new TypeError('events must be a non-empty array');
  if (citationSnapshot && !deriveFrom && events.some(event => event?.kind !== 'citation' || event.repo !== repo || event.pr !== citationSnapshot.pr)) {
    throw new TypeError('a citation snapshot holds only that PR\'s citation events');
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new TypeError('attempts must be a positive integer');
  const lines = (deriveFrom ? [] : events).map(event => {
    try {
      const line = JSON.stringify(event);
      const parsed = parsePrecedentLog(line, trust);
      if (parsed.malformed || parsed.events.length !== 1) throw new Error('malformed event');
      return line;
    } catch (cause) { throw new TypeError('invalid precedent event', { cause }); }
  });
  const parsedEvents = lines.map(line => JSON.parse(line));
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let rows = 0, duplicates = 0, stale = false;
      stage({
        ...seams,
        board, branch, message: `review-precedents: append ${repo}`,
        files: [{ path: precedentGitPath(repo), content: ({ existing }) => {
          const base = existing ?? '';
          const raw = parsePrecedentLog(base, trust).events;
          // Check staleness and withdrawals on a view where stamps ahead of this host's clock (a skewed writer) read
          // as the epoch, or one bad clock would refuse every honest read and pin its rows until that time passes.
          const stored = clampFutureStamps(raw, now() + FUTURE_STAMP_SKEW_MS);
          // A snapshot whose read began before the newest read mark on this tip is stale as a whole: the newer read
          // may have stored nothing (every row unchanged), so no row-level rank could tell its rows are older.
          const readAt = citationSnapshot ? Date.parse(citationSnapshot.at) : NaN;
          const lastRead = citationSnapshot ? latestReadAt(stored, { repo, pr: citationSnapshot.pr }) : -Infinity;
          const snapshotEvents = deriveFrom ? derive(stored) : parsedEvents;
          stale = readAt < lastRead;
          if (stale) { rows = 0; duplicates = snapshotEvents.length; return base; }
          const seen = new Set(raw.map(precedentEventId));
          // Compare a backfilled comment against its CURRENT row only: an edit reverted to an earlier verdict must
          // be stored again, or the stale middle edit stays current. A row that would not become current (a stale
          // read landing after a newer read's row or withdrawal) is dropped, so it can never restore that row.
          const current = currentCommentCitations(stored);
          const withdrawn = citationSnapshot
            ? citationRetractions(stored, snapshotEvents, { repo, pr: citationSnapshot.pr, at: citationSnapshot.at }) : [];
          const fresh = [...snapshotEvents, ...withdrawn].filter(ev => {
            const key = citationCommentKey(ev), id = precedentEventId(ev), prior = key ? current.get(key) : null;
            if (key ? prior && (precedentEventId(prior) === id || !citationSupersedes(ev, prior)) : seen.has(id)) return false;
            seen.add(id);
            if (key) current.set(key, ev);
            return true;
          }).map(ev => JSON.stringify(ev));
          rows = fresh.length;
          duplicates = Math.max(0, snapshotEvents.length + withdrawn.length - rows);
          // The read mark is not a counted row; it is written whenever this read is the newest, changed or not.
          const out = readAt > lastRead ? [...fresh, JSON.stringify(readEvent({ repo, pr: citationSnapshot.pr, at: citationSnapshot.at }))] : fresh;
          return out.length ? `${base}${base && !base.endsWith('\n') ? '\n' : ''}${out.join('\n')}\n` : base;
        } }],
        allowRef: PRECEDENT_PUSH_REF,
      });
      return stale ? { status: 'stale-snapshot', attempts: attempt, rows: 0, duplicates }
        : { status: 'appended', attempts: attempt, rows, duplicates };
    } catch (error) {
      errors.push(error);
      if (attempt < attempts) {
        onRetry?.({ attempt, error });
        sleep(Math.min(100 * 2 ** (attempt - 1), 1600) + Math.floor(Math.random() * 50));
      }
    }
  }
  throw new PrecedentAppendExhaustedError({ repo, attempts, errors });
}

const loggedSettings = new Set();
export function loadPrecedentSettings({ env = process.env, settings = readSettings(), log = line => process.stderr.write(`${line}\n`) } = {}) {
  const resolved = resolvePrecedentSettings({ file: settings, env });
  const line = formatPrecedentSettings(resolved);
  if (!loggedSettings.has(line)) { loggedSettings.add(line); log(line); }
  return resolved;
}

export function readPrecedents({ board, repo, run } = {}) {
  const result = readPrecedentLog({ board, repo, run });
  if (result.status !== 'ok') return result;
  return { status: 'ok', precedents: foldPrecedents(result.events, trust), citations: foldCitations(result.events), malformed: result.malformed };
}

const defaultExec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
/**
 * One PR's head, files and its COMPLETE comment thread. The thread comes from the paginated full-thread reader
 * (`readCompletePrComments`, we:scripts/conveyor/pr-comments-complete.mjs), never `gh pr view --json` with the
 * thread field, which returns one page: a decision past comment 100 would be missed. A failed read throws.
 */
const defaultReadComments = (pr, repo) => readCompletePrComments(pr, { repo });
export function readPrInfo({ repo, pr, exec = defaultExec, readComments = defaultReadComments }) {
  const info = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,title,body,headRefOid,state,files']));
  return { ...info, comments: readComments(pr, repo) };
}

const defaultRoute = () => resolveOperationRoute({ operation: 'precedent-draft', taskType: 'summarize', available: ['claude'] });
export function draftPatternWithModel(capture, { spawn = spawnSync, route = defaultRoute } = {}) {
  try {
    const selected = typeof route === 'function' ? route() : route;
    if (selected?.provider !== 'claude' || !selected.model) return null;
    const alias = claudeSpawnAlias(selected.model);
    const prompt = `Write ONE sentence (at most 300 characters) stating the reusable review rule implied by the operator's decision. Phrase it as a general rule, with no PR numbers. Return only that sentence.\n\n${FENCED_DATA_RULE}\n\n${fenceUntrusted('decision', `${capture.operatorWords ?? ''}\n\n${capture.body ?? ''}`)}`;
    const result = spawn('claude', ['-p', '--model', alias, '--tools', '', '--output-format', 'text'], { input: prompt, encoding: 'utf8', timeout: 90000 });
    if (result.error || result.status !== 0) return null;
    const line = String(result.stdout ?? '').split(/\r\n|[\r\n\u2028\u2029\u0085\v\f]/u).find(value => value.trim());
    if (!line || line.trim().length > 400) return null;
    const folded = line.replace(/[\r\n\u2028\u2029\u0085\v\f]+/gu, ' ').replace(/`/g, "'").trim();
    return folded.length > 300 ? `${folded.slice(0, 299)}…` : folded;
  } catch { return null; }
}

export async function capturePrecedents({ repo, pr, info, existing = new Map(), draft = async () => null, now, capturedBy = 'capture' }) {
  const drafts = [], skipped = [], invalid = [];
  const seen = new Set(existing.keys());
  for (const comment of info.comments ?? []) {
    for (const raw of captureFromComment(comment, { operatorLogins: OPERATOR_LOGINS, automationLogins: AUTOMATION_LOGINS, parseRuling: parseOperatorRulingComment })) {
      const capture = { ...raw, head: raw.head || info.headRefOid,
        date: raw.date || (now instanceof Date ? now.toISOString() : String(now ?? '')).slice(0, 10) };
      const options = { repo, pr, scope: scopeHintsFromBody(capture.body), capturedBy };
      const initial = draftRecordFromCapture(capture, options);
      if (seen.has(initial.id)) { skipped.push(initial.id); continue; }
      const record = draftRecordFromCapture(capture, { ...options, pattern: await draft(capture) });
      const validation = validatePrecedent(record);
      if (!validation.ok) { invalid.push({ id: record.id, errors: validation.errors }); continue; }
      seen.add(record.id);
      drafts.push(record);
    }
  }
  return { drafts, skipped, invalid };
}

export function recordCitationsFromComments({ repo, pr, info, at, stored = [] }) {
  const events = [];
  // The head a comment was first recorded on, per [comment, seat]. The PR head moves on every push, so a comment
  // whose head is derived from it must keep its recorded head, or a re-backfill would move it to a head it never
  // reviewed and withdraw the right one.
  const recordedHead = new Map();
  for (const ev of currentCommentCitations(stored).values()) {
    if (ev.repo !== repo || ev.pr !== pr) continue;
    try { recordedHead.set(JSON.stringify([JSON.parse(ev.source)[0], ev.seat]), ev.head); } catch { /* unsourced */ }
  }
  for (const comment of info.comments ?? []) {
    if (!AUTOMATION_LOGINS.includes(String(comment.author?.login ?? '').toLowerCase())) continue;
    const body = typeof comment.body === 'string' ? comment.body : '';
    const verdict = body.startsWith('✅ review — accepted') ? 'accept'
      : body.startsWith('🔁 review — changes requested') ? 'changes'
        : /^(?:ADVISORY REVIEW\b|\*\*⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT\.\*\*)/.test(body) ? 'advisory' : null;
    if (!verdict) continue;
    const ids = extractCitations(body);
    if (!ids.length) continue;
    const seat = verdict === 'advisory' ? 'advisory' : 'panel';
    const source = comment.id ?? comment.url ?? comment.createdAt;
    // One spelling per head, so a short or upper-case reviewed-sha folds into the same seat as the full one.
    const reviewed = /reviewed-sha:\s*([0-9a-f]{7,40})\b/i.exec(body)?.[1]?.toLowerCase();
    const recorded = source == null ? undefined : recordedHead.get(JSON.stringify([source, seat]));
    const prHead = String(info.headRefOid ?? '').toLowerCase();
    const head = reviewed ? [recorded, prHead].find(full => full?.toLowerCase().startsWith(reviewed)) ?? reviewed
      : recorded ?? info.headRefOid;
    events.push(citationEvent({ repo, pr, head, ids, seat, verdict, at,
      // [comment, authored, revised]: the fold orders by authored time, so an edit never makes old evidence newest.
      source: source == null ? '' : JSON.stringify([source, comment.createdAt ?? '', comment.updatedAt ?? comment.createdAt ?? '']) }));
  }
  return events;
}
