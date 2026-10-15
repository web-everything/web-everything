/**
 * The drain writes three facts: no-review head exemptions, carried-acceptance restamps,
 * and releases of its open holds. Additive and fail-soft: recording never throws or
 * changes a drain decision. Ledger clearance stays fail-closed on missing or unreadable evidence.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { reserve, releaseLockDir } from '../readiness/file-locks.mjs';
import { appendVerdict, buildLedgerEvent, buildVerdictRecord, DEFAULT_VERDICT_LEDGER_STORE, EVENT_TYPES, foldVerdictLedger,
  parseLedgerEvents, processWriterId, readLedgerEventsFromStore, resolveLedgerBoard, resolveLedgerStoreChoice, validateLedgerEvent,
  VERDICT_LEDGER_LEASE_MINUTES, VERDICT_LEDGER_STORES, verdictLedgerLockRoot, verdictLedgerPath } from './verdict-ledger.mjs';

export const DRAIN_FACTS_SOURCE = 'merge-ai-prs';
export const EXEMPT_BASIS = 'no escalation signal and no review label';
const slug = value => String(value ?? '').trim().toLowerCase();
const fullSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
const isVerdict = row => row.type === undefined || row.type === EVENT_TYPES.VERDICT;

export function drainReviewGateFact(gate) {
  return {
    reviewExempt: gate?.action === 'merge' && gate?.reason === 'no escalation signal — merge immediately',
    acceptedMerge: gate?.action === 'merge' && /^review:accepted\b/.test(gate?.reason ?? ''),
  };
}

// Separate planning from construction so the recorder can isolate each build/append failure.
function planRows({ verdicts, repo, events, now }, emit) {
  if (!Array.isArray(events)) throw new Error('ledger events are unreadable');
  const normalized = events.map(row => {
    const checked = validateLedgerEvent(row);
    if (!checked.valid) throw new Error(`ledger event is unreadable: ${checked.errors.join('; ')}`);
    return checked.record;
  });
  for (const v of verdicts) {
    const pr = Number(v?.num);
    if (slug(v.repo || repo) !== slug(repo) || !Number.isInteger(pr) || pr <= 0) continue;
    const rawHead = v.listedHeadSha || v.headSha;
    if (!fullSha(rawHead)) continue;
    const head = rawHead.toLowerCase();
    const mine = normalized.filter(e => e.pr === pr && slug(e.repo) === slug(repo));
    const folded = foldVerdictLedger(mine.filter(isVerdict)).get(pr);
    const common = { repo, pr, at: now, source: DRAIN_FACTS_SOURCE, declaredActor: 'drain' };
    const lastExempt = mine.filter(e => e.type === EVENT_TYPES.REVIEW_EXEMPT).at(-1);
    if (v.reviewGate?.reviewExempt === true && !folded?.current
      && lastExempt?.headSha !== head) {
      emit('exempt', buildLedgerEvent, { ...common, type: EVENT_TYPES.REVIEW_EXEMPT, headSha: head, basis: EXEMPT_BASIS });
    }
    const old = folded?.current?.coverage?.headSha;
    const coversHead = typeof old === 'string' && old.length >= 7 && head.startsWith(old.toLowerCase());
    if (v.reviewGate?.acceptedMerge === true && folded?.current && folded.clears === true && !coversHead) {
      emit('restamped', buildVerdictRecord, { ...common, verdict: 'restamped', headSha: head,
        reason: `drain carried the acceptance from ${old ? old.slice(0, 8) : 'no head'} to ${head.slice(0, 8)}: its review gate verified the accepted content still covers this head (no new review)` });
    }
    if (v.decision !== 'merge') continue;
    const last = new Map();
    for (const e of mine) if (e.holdSource === 'drain' && [EVENT_TYPES.HOLD, EVENT_TYPES.RELEASE].includes(e.type)) last.set(e.reasonCode, e);
    for (const [reasonCode, e] of last) if (e.type === EVENT_TYPES.HOLD) {
      emit('released', buildLedgerEvent, { ...common, type: EVENT_TYPES.RELEASE, reasonCode, holdSource: 'drain' });
    }
  }
}

export function planDrainLedgerFacts(options) {
  const rows = [];
  planRows(options, (_kind, build, fields) => rows.push(build(fields)));
  return rows;
}

const readHome = repo => {
  try { return parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
};

/** The store the drain's writes land in, resolved as `appendVerdict` resolves it. `dual` and `git` read git: a hold
 *  that missed git spills to home, and a release can reach git but not home, so a home read would hide the miss. */
export function drainLedgerReadStore(repo, env = process.env) {
  const { store, named } = resolveLedgerStoreChoice(undefined, env);
  if (store === 'home') return 'home';
  if (!named && store === DEFAULT_VERDICT_LEDGER_STORE && !resolveLedgerBoard(repo, {}, env)) return 'home';
  return VERDICT_LEDGER_STORES.includes(store) ? 'git' : store;
}

// Home can lag the shared store: a release that reached git but then missed home (a partial release) leaves home
// showing a hold git has released. So a read failure vouches only for home rows written after the latest good shared
// read of that repo by ANY drain on this machine (they all share the home ledger; the fast drain runs beside the
// resident one). That bound lives in a file beside the home ledger, recorded before the pass may write a release; a
// read whose bound could not be recorded counts as failed, so no release follows it. A release is planned only from a
// good read and written after it, so a hold written after the bound is newer than any release home could be missing.
// Before any bound exists, this process's start is the bound (an older process's release predates it).
const PROCESS_START_MS = Date.now();
const BOUND_LOCK_PATH = '<verdict-ledger:drain-read-bound>';

/** The file holding a repo's latest good shared-read start (ms), beside its home ledger (readers enumerate `.jsonl`). */
export function drainReadBoundPath(repo) {
  return verdictLedgerPath(repo).replace(/\.jsonl$/, '.drain-read-at');
}

/** The recorded bound, `-Infinity` when none exists yet. Throws when the file is unreadable or not a number. */
function readBound(repo) {
  let text;
  try { text = readFileSync(drainReadBoundPath(repo), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return -Infinity; throw error; }
  const ms = Number(text.trim());
  if (!Number.isFinite(ms)) throw new Error('drain read bound is not a number');
  return ms;
}

/** Raise the repo's bound to `startedAt` (never lower it: a slow read can finish after a later one). Under a lock,
 *  written by rename. Throws when the lock is held or the write fails; the caller then treats the read as failed. */
export function recordDrainReadBound(repo, startedAt) {
  const lockRoot = verdictLedgerLockRoot();
  mkdirSync(lockRoot, { recursive: true });
  const lock = reserve(lockRoot, BOUND_LOCK_PATH, processWriterId(), Date.now(), new Date().toISOString(),
    process.pid, 'unknown', VERDICT_LEDGER_LEASE_MINUTES);
  if (lock?.ok !== true) throw new Error(`drain read bound lock is held (${lock?.reason ?? 'unknown'})`);
  try {
    let prior;
    try { prior = readBound(repo); } catch { prior = -Infinity; } // a damaged file is replaced by this read's bound
    if (prior >= startedAt) return;
    const path = drainReadBoundPath(repo), tmp = `${path}.${process.pid}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${startedAt}\n`, 'utf8');
    renameSync(tmp, path);
  } finally { try { releaseLockDir(lockRoot, BOUND_LOCK_PATH); } catch { /* the short TTL reclaims it */ } }
}

/** The time after which home rows are trusted for `repo` when its shared read failed; `Infinity` (trust nothing)
 *  when the recorded bound cannot be read. */
export function drainHomeTrustedFrom(repo) {
  try { return Math.max(readBound(repo), PROCESS_START_MS); } catch { return Infinity; }
}

/** The home rows a failed shared read still vouches for: those strictly after `error.homeTrustedFrom` (a row in the
 *  same millisecond as the read may predate it, so it is not trusted; the cost is one extra hold). An error without
 *  a finite bound (a plain seam error, an unreadable bound) vouches for none, so the caller records its hold. */
export function homeRowsTrustedAfterReadFailure(rows, error) {
  const from = Number(error?.homeTrustedFrom);
  if (!Number.isFinite(from) || !Array.isArray(rows)) return [];
  return rows.filter(row => Date.parse(row?.at) > from);
}

/** Read each repo once, before the pass writes, and return a sync reader for the recorders' `read` seam. Keyed by the
 *  exact repo text the writes use (the git path and the store read are case-sensitive). A failed read throws from the
 *  reader: releases then write nothing, and `recordDrainHold` still records its hold (F4). The thrown error carries
 *  `homeTrustedFrom` (see {@link homeRowsTrustedAfterReadFailure}). A good shared read records its bound first
 *  ({@link recordDrainReadBound}); a home-store read needs none (its writes cannot miss home). */
export async function readDrainLedgerSnapshot(repos = [], { env = process.env, readStore = readLedgerEventsFromStore,
  clock = Date.now, recordBound = recordDrainReadBound } = {}) {
  const snapshot = new Map();
  const exact = repo => String(repo ?? '').trim();
  for (const repo of repos) {
    const key = exact(repo);
    if (!key || snapshot.has(key)) continue;
    const startedAt = clock();
    try {
      // Home keeps the whole-file read (the recorders filter by slug); the store read filters by the exact repo text.
      const store = drainLedgerReadStore(key, env);
      const read = store === 'home' ? { status: 'ok', rows: readHome(key) } : await readStore(key, { store, env });
      const ok = read?.status === 'ok' && Array.isArray(read.rows);
      if (ok && store !== 'home') recordBound(key, startedAt);
      snapshot.set(key, ok ? { rows: read.rows } : { error: `${read?.reason ?? 'unreadable'}: ${read?.error ?? 'no rows'}` });
    } catch (error) { snapshot.set(key, { error: String(error?.message ?? error).split('\n')[0] }); }
  }
  const failure = (repo, message) => Object.assign(new Error(message), { homeTrustedFrom: drainHomeTrustedFrom(exact(repo)) });
  return repo => {
    const entry = snapshot.get(exact(repo));
    if (!entry) throw failure(repo, `ledger not read for ${repo}`);
    if (entry.error) throw failure(repo, `ledger unreadable for ${repo}: ${entry.error}`);
    return entry.rows;
  };
}

export function recordDrainLedgerFacts(options = {}) {
  const result = { ok: true, appended: { exempt: 0, restamped: 0, released: 0 }, errors: [] };
  const failed = error => {
    result.ok = false;
    result.errors.push(String(error?.message ?? error).split('\n')[0]);
  };
  try {
    const { verdicts = [], localSlug = null, read = readHome, append = appendVerdict, now = () => new Date().toISOString() } = options;
    const groups = new Map();
    for (const v of verdicts) {
      const repo = String(v?.repo || localSlug || '').trim();
      if (!repo) continue;
      if (!groups.has(slug(repo))) groups.set(slug(repo), { repo, group: [] });
      groups.get(slug(repo)).group.push(v);
    }
    for (const { repo, group } of groups.values()) {
      try {
        let events;
        try { events = read(repo); }
        catch (error) { if (error?.code === 'ENOENT') events = []; else throw error; }
        planRows({ verdicts: group, repo, events, now: now() }, (kind, build, fields) => {
          try {
            const written = append(build(fields));
            if (written?.ok !== true || written.ledgerWriteMiss) throw new Error(written?.errors?.join('; ') || (written?.ledgerWriteMiss ? 'ledger write miss' : 'ledger append failed'));
            result.appended[kind]++;
          } catch (error) { failed(error); }
        });
      } catch (error) { failed(error); }
    }
  } catch (error) { failed(error); }
  return result;
}
