/**
 * @file scripts/lib/lane-history.mjs
 * @description The LANE HISTORY LEDGER (#3383, epic #3383): "we need to be able to trace every lane back to
 *   the session/card/PR that used it, and know its status." Today a lane's lease marker (`.lane-lease`)
 *   records only the CURRENT holder — `release` deletes it outright, so the instant a lane is handed back the
 *   pool forgets who was ever in it. This module is the missing durable trail: one JSON line per
 *   acquire/adopt/release/reap event, appended to `<lane>/.git/lane-history.jsonl`.
 *
 * WHY INSIDE `.git`: never tracked (git ignores its own `.git/` dir by construction), so it is never dirty,
 * never committed, never conflicts with a reset — `acquire`'s `checkout -B` + `clean -fd` cannot touch it
 * because `clean -fd` never descends into `.git/`. It survives every reset/refresh a lane goes through, which
 * is the whole point: a lane's WORKING TREE is ephemeral (reset to origin on every acquire), but its HISTORY
 * must outlive that.
 *
 * WHY A SEPARATE MODULE, NOT INLINE IN `lane-pool.mjs`: another worker owns `lane-pool.mjs` for PR #2606
 * (acquire growth, wait-vs-scan) concurrently with this card. Everything DECIDABLE lives here, pure and
 * unit-tested directly; `lane-pool.mjs` gets only the narrow call-out at each of its four existing mutation
 * points (`cmdAcquire`, `cmdAdopt`, `cmdRelease`, `reapDeadLeasesInPool`) — see that file's own `appendLaneHistory`
 * call sites.
 *
 * KEPT SMALL (explicit operator instruction): `appendLaneHistory` trims the file to the last
 * {@link MAX_HISTORY_LINES} lines on every write, so a lane cycling through hundreds of sessions over months
 * never grows an unbounded ledger — the RECENT trail (who holds it now, who held it last, its last few hops)
 * is what `whois` actually needs; ancient history is not worth keeping forever.
 *
 * #4370 — the FORENSIC counterpart lives at the bottom of this file: the per-POOL lane lifecycle audit journal
 * (`<poolDir>/.lane-journal.jsonl`, never trimmed, rotated by size), which records every lease write/delete AND
 * every reset/clean/reclaim/litter deletion with its actor, reason and before-state. See its own section header.
 */
import {
  existsSync, appendFileSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync, openSync, readSync, closeSync,
} from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { planLitterCleanup } from './lane-litter.mjs';
import { laneGitHardeningEnv } from './lane-git-hardening.mjs';

/** The ledger's filename, inside `<lane>/.git/`. */
export const LANE_HISTORY_FILENAME = 'lane-history.jsonl';

/** How many of the most recent lines survive a trim. See file header — "keep it small". */
export const MAX_HISTORY_LINES = 500;

/** The ledger's absolute path for a given lane directory. */
export function laneHistoryPath(dir) {
  return join(dir, '.git', LANE_HISTORY_FILENAME);
}

/**
 * PURE: the PR number a history line should record, best-effort, from whatever the caller has on hand.
 * Order (per #3383's own spec): an explicit `pr` wins; else a `--session=review-<pr>`/`fix-<pr>` naming
 * convention (the SAME dispatcher-session grammar `conveyor/lease-reaper.mjs#itemNumFromSession` already
 * parses for item ids — this reads the same shape for a PR-scoped session name) tried against `session` then
 * `holder`; otherwise unknown (`null` — never guessed further, a wrong PR number is worse than none).
 */
export function inferPrNumber({ pr, session, holder } = {}) {
  if (pr !== undefined && pr !== null && String(pr).trim() !== '') {
    const n = Number(pr);
    if (Number.isInteger(n) && n > 0) return n;
  }
  for (const candidate of [session, holder]) {
    if (!candidate) continue;
    const m = String(candidate).match(/\b(?:review|fix)-(\d+)\b/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * PURE: shape one ledger line from an acquire/adopt/release/reap call's own fields. Every field beyond
 * `event`/`ts` is OMITTED when unknown (rather than written `null`) so a `grep`/`jq` read of the ledger never
 * has to distinguish "recorded absent" from "not asked for" — the file only ever states what it actually knows.
 *
 * @param {object} p
 * @param {string} p.event - 'acquire' | 'reserve' | 'adopt' | 'release' | 'reap'
 * @param {number} [p.nowMs]
 * @param {string} [p.session] - the leasing session slug (`defaultSession()` in lane-pool.mjs)
 * @param {string} [p.ownerSession] - the durable `CLAUDE_CODE_SESSION_ID`, when known
 * @param {string} [p.workerSession] - the declared OCCUPANT session (`adopt`'s `workerSession`)
 * @param {string} [p.purpose]
 * @param {string|number} [p.item] - card id(s), comma-joined if plural
 * @param {string} [p.holder] - the minted per-holder slug (#2997)
 * @param {string|number} [p.pr] - an explicit PR number, when the caller already knows it
 * @param {string} [p.reason] - reap's classification reason (e.g. 'pr-merged', 'ttl-stale')
 */
export function laneHistoryEntry({
  event, nowMs = Date.now(), session, ownerSession, workerSession, purpose, item, holder, pr, reason,
} = {}) {
  if (!event) throw new Error('laneHistoryEntry needs an `event` name');
  const entry = { ts: new Date(nowMs).toISOString(), event };
  if (session) entry.session = session;
  if (ownerSession) entry.ownerSession = ownerSession;
  if (workerSession) entry.workerSession = workerSession;
  if (purpose) entry.purpose = purpose;
  if (item !== undefined && item !== null && String(item).trim() !== '') entry.item = String(item);
  if (holder) entry.holder = holder;
  const prNumber = inferPrNumber({ pr, session, holder });
  if (prNumber) entry.pr = prNumber;
  if (reason) entry.reason = reason;
  return entry;
}

/**
 * Trim a ledger file in place to its last `maxLines` lines. Best-effort — a trim failure is silently
 * swallowed (the append itself already landed; losing the trim only means the file stays a little larger).
 */
function trimLaneHistory(file, maxLines = MAX_HISTORY_LINES) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= maxLines) return;
    writeFileSync(file, `${lines.slice(lines.length - maxLines).join('\n')}\n`, 'utf8');
  } catch { /* best-effort trim */ }
}

/**
 * IO: append one ledger line for `dir` (a lane clone). NEVER throws — a bookkeeping-write hiccup must not fail
 * the real acquire/adopt/release/reap call it rides on. No-ops (returns false) when `dir` is not a git
 * checkout at all (defensive — every real caller only ever passes a lane dir).
 * @returns {boolean} whether the line was written.
 */
export function appendLaneHistory(dir, entry) {
  try {
    const gitDir = join(dir, '.git');
    if (!existsSync(gitDir)) return false;
    const file = laneHistoryPath(dir);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    trimLaneHistory(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * IO: read every ledger line for `dir`, oldest first. Tolerant of a corrupt/partial trailing line (e.g. a
 * crash mid-append) — a bad line is skipped, never thrown, so one damaged line can't blind `whois` to every
 * other event in the file. Returns `[]` when the ledger doesn't exist yet (a lane never touched by history-
 * aware code, or a fresh clone).
 */
export function readLaneHistory(dir) {
  const file = laneHistoryPath(dir);
  if (!existsSync(file)) return [];
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
  }
  return out;
}

/** PURE: the most recent entry in an (oldest-first) entries array, or `null`. */
export function lastLaneHistoryEntry(entries) {
  return entries.length ? entries[entries.length - 1] : null;
}

// ── the per-POOL lifecycle AUDIT JOURNAL (#4370) ─────────────────────────────────────────────────────────
//
// The ledger above answers "who held this lane" and is deliberately small (trimmed, lives in the lane's own
// `.git`). It cannot answer the forensic question #4370 was filed for — "who reset lane-18's tree at 16:49,
// why, and was there unpushed work in it" — because (a) it only records acquire/adopt/release/reap, never a
// reset, a clean, a litter deletion or a reclaim, (b) it carries no ACTOR (a daemon name, a pid, a parent pid),
// (c) it records no BEFORE-state (HEAD, dirty count, commits ahead), and (d) it is trimmed and lives inside the
// very tree a re-clone destroys.
//
// The journal is the other half: ONE append-only JSONL per pool, at `<poolDir>/.lane-journal.jsonl` — next to
// the lanes, never inside one (`pool-leftovers.mjs` never touches a pool dot-entry), so no lane reset or
// re-clone can erase it. It is ROTATED BY SIZE (renamed aside, never deleted) and never trimmed to N lines.
// Every mutation point calls {@link journalLaneEvent} with the lane dir, the action and a before-snapshot;
// `we:scripts/check-standards-rules.mjs#findUnjournaledLaneMutations` keeps new mutation points honest.

/** The journal's filename, directly inside a pool dir. A dot-entry on purpose (pool bookkeeping). */
export const LANE_JOURNAL_FILENAME = '.lane-journal.jsonl';

/** Rotate (rename aside) once the live journal reaches this many bytes. Rotated files are never deleted. */
export const LANE_JOURNAL_MAX_BYTES = 32 * 1024 * 1024;

/** Env var a daemon sets on the `lane-pool.mjs` child it spawns, so the journal names the DAEMON, not the CLI. */
export const LANE_JOURNAL_ACTOR_ENV = 'LANE_JOURNAL_ACTOR';

/**
 * Actions that change (or delete from) a lane's working tree. A destructive action on a lane with unpushed
 * work is the loud case — the `lane-destructive-unpushed` health smell reads exactly this set.
 */
export const DESTRUCTIVE_LANE_ACTIONS = Object.freeze(new Set([
  'acquire-reset', 'refresh-reset', 'reclaim-reset', 'salvage-reset', 'litter-delete',
]));

/**
 * PURE: did this journal entry destroy unpushed work without saving it first? A destructive action whose
 * before-state had unpushed work and no salvage bundle. The `lane-destructive-unpushed` smell's predicate.
 */
export function isUnsalvagedDestructiveUnpushed(entry) {
  if (!entry || !DESTRUCTIVE_LANE_ACTIONS.has(entry.action) || entry.salvagedTo) return false;
  // Litter cleanup only removes allowlisted untracked files; an unchanged HEAD loses no commits.
  if (entry.action === 'litter-delete' && entry.headBefore && entry.headBefore === entry.headAfter) return false;
  // An explicit `unpushed: false` is the caller's stronger proof (e.g. a reclaim whose reproof says the work is
  // preserved elsewhere); leftover dirty files / patch-equivalent commits in the snapshot must not override it.
  if (entry.unpushed === false) return false;
  const dirty = entry.workDirtyBefore ?? entry.dirtyBefore;
  if (dirty > 0) return true;
  if (entry.headBefore && entry.headBefore === entry.headAfter) return false;
  if (entry.remoteReachableNow === true) return false;
  if (Number.isFinite(entry.unpushedCommitsBefore)) return entry.unpushedCommitsBefore > 0;
  // Old journals / failed probes remain conservative. Ahead of ONE upstream is not proof of loss.
  return entry.unpushed === true;
}

/** A rotated journal: `.lane-journal.<UTC stamp>.jsonl` — the stamp sorts lexically in time order. */
const ROTATED_JOURNAL_RE = /^\.lane-journal\.(\d{8}T\d{6}(?:\d{3})?Z)\.jsonl$/;

/** The live journal's absolute path for a pool dir. */
export function laneJournalPath(poolDir) {
  return join(poolDir, LANE_JOURNAL_FILENAME);
}

/** PURE: `{ poolDir, lane }` for a lane dir (`<poolDir>/lane-N`), or `null` when `dir` is not shaped like one. */
export function laneOfDir(dir) {
  const m = /^lane-(\d+)$/.exec(basename(String(dir || '')));
  return m ? { poolDir: dirname(dir), lane: Number(m[1]) } : null;
}

/**
 * PURE: WHO is acting — the thing the 2026-09-28 investigation could not recover (`release Mac:40984` named a
 * host:pid, never "lease-reaper"). `name` is the daemon a spawning parent declared via
 * {@link LANE_JOURNAL_ACTOR_ENV}, else this script's own name; `script` is the script plus its subcommand;
 * `session` is the durable Claude session id when one is in the env.
 */
export function journalActor({ env = {}, argv = [], pid = null, ppid = null, host = null } = {}) {
  const scriptBase = argv[1] ? basename(String(argv[1])).replace(/\.m?js$/, '') : null;
  const sub = argv[2] && !String(argv[2]).startsWith('-') ? String(argv[2]) : null;
  const script = scriptBase ? (sub ? `${scriptBase} ${sub}` : scriptBase) : null;
  const declared = typeof env[LANE_JOURNAL_ACTOR_ENV] === 'string' && env[LANE_JOURNAL_ACTOR_ENV].trim()
    ? env[LANE_JOURNAL_ACTOR_ENV].trim() : null;
  const actor = { name: declared || scriptBase || 'unknown' };
  if (script) actor.script = script;
  if (env.CLAUDE_CODE_SESSION_ID) actor.session = env.CLAUDE_CODE_SESSION_ID;
  if (Number.isInteger(pid)) actor.pid = pid;
  if (Number.isInteger(ppid)) actor.ppid = ppid;
  if (host) actor.host = host;
  return actor;
}

/** The actor for THIS process. */
export function currentJournalActor() {
  return journalActor({ env: process.env, argv: process.argv, pid: process.pid, ppid: process.ppid, host: hostname() });
}

/**
 * PURE: shape one journal line. `before` is a {@link laneStateSnapshot} taken BEFORE the mutation; `headAfter`
 * is HEAD once it ran (equal to `before.head` for a lease-only event). `unpushed` defaults to the snapshot's
 * own answer; a caller holding a stronger proof (reclaim's preservation re-check) passes it explicitly.
 * Unknown fields are omitted, never written `null` (same rule as {@link laneHistoryEntry}).
 */
export function laneJournalEntry({
  nowMs = Date.now(), lane, action, actor, reason, before = null, headAfter, unpushed, ...extra
} = {}) {
  if (!action) throw new Error('laneJournalEntry needs an `action`');
  const entry = { ts: new Date(nowMs).toISOString(), lane: Number.isInteger(lane) ? lane : null, action };
  entry.actor = actor || { name: 'unknown' };
  if (reason) entry.reason = String(reason);
  if (before?.head) entry.headBefore = before.head;
  const after = headAfter !== undefined ? headAfter : before?.head;
  if (after) entry.headAfter = after;
  if (Number.isFinite(before?.dirty)) entry.dirtyBefore = before.dirty;
  if (Number.isFinite(before?.workDirty)) entry.workDirtyBefore = before.workDirty;
  if (Number.isFinite(before?.ahead)) entry.aheadBefore = before.ahead;
  if (Number.isFinite(before?.unpushedCommits)) entry.unpushedCommitsBefore = before.unpushedCommits;
  const unpushedValue = typeof unpushed === 'boolean' ? unpushed : before?.unpushed;
  if (typeof unpushedValue === 'boolean') entry.unpushed = unpushedValue;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
    entry[k] = v;
  }
  return entry;
}

/**
 * PURE — #4370 fork 3: may a destructive action run on this lane right now? Nothing unpushed ⇒ yes. Unpushed
 * work ⇒ only when the owner is PROVABLY gone (no live owner session, no live process in the lane, quiet
 * period passed — `lane-salvage.mjs#laneLivenessGate`'s answer), or when a human typed the explicit override.
 * Either unpushed path is `loud` (logged + journalled as such); a refusal is always loud.
 * @param {{unpushed:boolean, ownerGone?:boolean|null, override?:boolean, ownerReason?:string}} p
 * @returns {{allowed:boolean, loud:boolean, reason:string}}
 */
export function destructiveActionVerdict({ unpushed, ownerGone = null, override = false, ownerReason = '' } = {}) {
  if (unpushed !== true && unpushed !== false) {
    return { allowed: false, loud: true, reason: 'unpushed state unknown — never destroy blind' };
  }
  if (!unpushed) return { allowed: true, loud: false, reason: 'no unpushed work' };
  if (override) return { allowed: true, loud: true, reason: 'unpushed work destroyed under an explicit operator override' };
  if (ownerGone === true) return { allowed: true, loud: true, reason: `unpushed work, owner proven gone${ownerReason ? ` (${ownerReason})` : ''}` };
  return {
    allowed: false, loud: true,
    reason: `REFUSED — unpushed work and the owner is not proven gone${ownerReason ? ` (${ownerReason})` : ''}`,
  };
}

// Every snapshot read runs in a lane whose `.git/config` is agent-writable: `status` would run a lane-set
// `core.fsmonitor` (PR #5775), so it carries the lane hardening pins (scripts/lib/lane-git-hardening.mjs).
const snapshotGit = (dir, args) => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: laneGitHardeningEnv({ ...process.env, GIT_OPTIONAL_LOCKS: '0' }) }).trimEnd();
  } catch { return null; }
};

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** IO: read a ref's sha straight from the git dir (loose ref, then `packed-refs`); null when it is not there. */
function readRefFromGitDir(commonDir, ref) {
  const loose = join(commonDir, ref);
  if (existsSync(loose)) {
    const sha = readFileSync(loose, 'utf8').trim();
    return SHA_RE.test(sha) ? sha : null;
  }
  const packed = join(commonDir, 'packed-refs');
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, 'utf8').split('\n')) {
    const [sha, name] = line.trim().split(' ');
    if (name === ref && SHA_RE.test(sha)) return sha;
  }
  return null;
}

/**
 * IO: the lane's HEAD sha — read from `.git` on disk (no git spawn: every acquire journals HEAD before and after
 * its reset, and acquire is git-spawn-budgeted), falling back to `git rev-parse HEAD` for any shape it does not
 * recognise. null when neither works. Never throws.
 */
export function laneHead(dir) {
  try {
    let gitDir = join(dir, '.git');
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) throw new Error('unrecognised .git file');
      gitDir = resolve(dir, m[1].trim());
    }
    const commonFile = join(gitDir, 'commondir');
    const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
    const headRaw = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (SHA_RE.test(headRaw)) return headRaw;
    const ref = /^ref:\s*(refs\/\S+)$/.exec(headRaw)?.[1];
    const sha = ref ? readRefFromGitDir(commonDir, ref) : null;
    if (sha) return sha;
  } catch { /* fall through to git */ }
  return snapshotGit(dir, ['rev-parse', 'HEAD']);
}

/**
 * IO: the lane's state right now. `workDirty` excludes allowlisted untracked litter from `dirty`. `ahead` is commits
 * past `branchRef`; `unpushedCommits` is commits on NO remote ref at all (a pushed `lane/*` branch counts as
 * pushed); `unpushed` is either of those or any dirty file. Every field is `null` when its read failed — the
 * journal then says "unknown", never a guessed zero. Never throws.
 */
export function laneStateSnapshot(dir, branchRef = 'origin/main') {
  const head = laneHead(dir);
  const porcelain = snapshotGit(dir, ['status', '--porcelain']);
  const dirty = porcelain === null ? null : porcelain.split('\n').filter(Boolean).length;
  const workDirty = porcelain === null ? null : planLitterCleanup(porcelain).leaveDirty.length;
  // `origin/x` is spelled out as `refs/remotes/origin/x`: a stray LOCAL branch/tag named `origin/x` would
  // otherwise win the short-name lookup and hide unpushed commits from the shortcut below.
  const remoteRef = branchRef.startsWith('origin/') ? `refs/remotes/${branchRef}` : null;
  const aheadRaw = snapshotGit(dir, ['rev-list', '--count', `${remoteRef || branchRef}..HEAD`]);
  const ahead = aheadRaw === null ? null : Number(aheadRaw) || 0;
  // Nothing past a REMOTE ref means nothing unpushed — skip the second rev-list (acquire's git-spawn budget,
  // `lane-pool-ahead-provably-pushed-single-spawn.test.mjs` / `lane-pool-acquire-free-list.test.mjs`).
  const unpushedRaw = ahead === 0 && remoteRef
    ? '0'
    : snapshotGit(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
  const unpushedCommits = unpushedRaw === null ? null : Number(unpushedRaw) || 0;
  const unpushed = dirty === null || unpushedCommits === null ? null : dirty > 0 || unpushedCommits > 0;
  return { head, dirty, workDirty, ahead, unpushedCommits, unpushed };
}

/**
 * IO: reconcile a past alert with present remote reachability. This is recovery evidence, NOT a claim
 * that the ref existed at reset time. Never rewrite the journal's at-time commit count; failed reads
 * leave its conservative verdict intact. No fetch, reset, or other repository mutation.
 */
export function reconcileLaneJournalEntry(dir, entry) {
  if (!isUnsalvagedDestructiveUnpushed(entry) || !SHA_RE.test(entry.headBefore || '')) return entry;
  // A pushed commit cannot recover discarded file edits; avoid a subprocess that cannot clear the alert.
  if ((entry.workDirtyBefore ?? entry.dirtyBefore) > 0) return entry;
  const refs = snapshotGit(dir, ['for-each-ref', `--contains=${entry.headBefore}`, '--format=%(refname)', 'refs/remotes/']);
  return refs ? { ...entry, remoteReachableNow: true } : entry;
}

/** IO: rename the live journal aside once it is over the size cap. Best-effort. */
function rotateLaneJournal(file, maxBytes, nowMs) {
  try {
    if (statSync(file).size < maxBytes) return;
    const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace('.', '');
    renameSync(file, join(dirname(file), `.lane-journal.${stamp}.jsonl`));
  } catch { /* best-effort — an over-size journal is still a journal */ }
}

/** IO: append one already-shaped entry to a pool's journal. Never throws; returns whether it landed. */
export function appendLaneJournal(poolDir, entry, { maxBytes = LANE_JOURNAL_MAX_BYTES, nowMs = Date.now() } = {}) {
  try {
    if (!existsSync(poolDir)) return false;
    const file = laneJournalPath(poolDir);
    if (existsSync(file)) rotateLaneJournal(file, maxBytes, nowMs);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * IO — THE helper every lane mutation point calls (#4370 fork 2). Records `action` on lane dir `dir` in its
 * pool's journal, stamped with this process's actor. NEVER throws: a bookkeeping hiccup must not fail the real
 * reset/release it rides on. A `loud` entry is also echoed to stderr, so a daemon's own log carries it.
 * @param {string} dir - the lane clone (`<poolDir>/lane-N`)
 * @param {object} fields - {@link laneJournalEntry}'s fields minus `lane`/`actor` (derived here)
 * @returns {boolean}
 */
export function journalLaneEvent(dir, fields = {}, {
  actor = currentJournalActor(), nowMs = Date.now(), maxBytes, unlessRepeat = false,
} = {}) {
  try {
    const where = laneOfDir(dir);
    if (!where) return false;
    const entry = laneJournalEntry({ ...fields, nowMs, lane: where.lane, actor });
    if (unlessRepeat) {
      const previous = readLaneJournalTail(where.poolDir, { maxBytes: 256 * 1024 }).filter((e) => e?.lane === where.lane).at(-1);
      if (isRepeatJournalEntry(previous, entry)) return false;
    }
    if (entry.loud) {
      process.stderr.write(`${entry.ts} ⚠ lane-${where.lane}: ${entry.action} by ${entry.actor.name}${entry.actor.pid ? ` (pid ${entry.actor.pid})` : ''} — ${entry.reason || 'no reason given'}\n`);
    }
    return appendLaneJournal(where.poolDir, entry, { nowMs, ...(maxBytes ? { maxBytes } : {}) });
  } catch {
    return false;
  }
}

/**
 * PURE: is `entry` a no-news repeat of `previous` — same action, reason and lane state? Lets a caller that
 * re-evaluates the same lane every tick (a periodic reclaim refusal) journal the FIRST refusal and every change,
 * never the same line 700 times a day.
 */
export function isRepeatJournalEntry(previous, entry) {
  if (!previous || !entry) return false;
  return ['action', 'reason', 'headBefore', 'dirtyBefore', 'aheadBefore', 'unpushed'].every((k) => previous[k] === entry[k]);
}

/** IO: every journal file for a pool, oldest first (rotated files by stamp, then the live one). */
function laneJournalFiles(poolDir) {
  let names = [];
  try { names = readdirSync(poolDir); } catch { return []; }
  const rotated = names.filter((n) => ROTATED_JOURNAL_RE.test(n)).sort();
  const files = rotated.map((n) => join(poolDir, n));
  if (names.includes(LANE_JOURNAL_FILENAME)) files.push(laneJournalPath(poolDir));
  return files;
}

/**
 * IO: read a pool's journal, oldest first, across rotations; `lane` filters to one lane. A corrupt line is
 * skipped, never thrown (same tolerance as {@link readLaneHistory}).
 */
export function readLaneJournal(poolDir, { lane = null } = {}) {
  const out = [];
  for (const file of laneJournalFiles(poolDir)) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (lane !== null && entry?.lane !== Number(lane)) continue;
      out.push(entry);
    }
  }
  return out;
}

/**
 * IO: the TAIL of a pool's live journal (last `maxBytes`) — what a per-tick health probe reads, never the whole
 * rotated history. A torn first line is skipped.
 */
export function readLaneJournalTail(poolDir, { maxBytes = 1024 * 1024 } = {}) {
  const file = laneJournalPath(poolDir);
  try {
    const size = statSync(file).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    const out = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn first line */ }
    }
    return out;
  } catch {
    return [];
  }
}
