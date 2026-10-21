/**
 * @file scripts/conveyor/auto-round-grant-io.mjs
 * @description IO shell for the automated standing-ruling round grant (`auto-round-grant.mjs`). Called by the
 *   fix-dispatch daemon's notes half the moment it sees a `round-cap-exhausted` note, before the needs-you event.
 *
 *   TRUST (operator option B, 2026-10-20). No personal credential: the grant comment is posted by the automation
 *   (App) and counts ONLY because it cites the operator's recorded standing ruling and stays inside its bounds —
 *   re-verified by every reader that passes the `standingRuling` scope (`standing-ruling-io.mjs`). The comment
 *   body is the shared `buildRoundExtensionComment` record, with the ruling id and the judged head added.
 *
 *   IDEMPOTENT per (PR, head, cap episode) and CAPPED per PR under concurrency: one lock + ledger per PR under the
 *   coordination root (`withPrLedger`). The ledger is SEEDED, on first use, with every automation-posted grant
 *   record already on the PR (verified or not); used = max(verified on GitHub, every record now, seed + every
 *   reservation). A reservation is written BEFORE
 *   the post and never released — a failed or crashed run keeps its slot and the event stays for a person.
 *   The PR head is re-read right before the post; a moved head never gets the grant.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { readHumanSurfaceNetFiles } from '../lib/human-surface-net-diff.mjs';
import { REVIEW_SETTINGS_FILE } from '../lib/review-seat-settings.mjs';
import { platformPreference } from '../lib/policy-cascade.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import {
  buildRoundExtensionComment, commentCreatedAt, countGrantedRoundExtensions, countStandingRulingGrantRecords, MAX_TOTAL_ROUND_EXTENSIONS,
  ROUND_EXTENSION_MARKER, roundExtensionGrants, standingRulingGrantEpisodes,
} from './round-extension-mark.mjs';
import { isAutomationAuthored, isOperatorAuthored } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { ghApp, readStandingRuling, standingRulingScope, redact } from './standing-ruling-io.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import {
  AUTO_GRANT_ABSOLUTE_MAX, AUTO_GRANT_CHANNEL, autoGrantKey, autoGrantReason, capReachedReason,
  countAutoRoundGrants, decideAutoGrant, formatAutoRoundGrantSettings, resolveAutoRoundGrantSettings, screenAutoGrantNote,
} from './auto-round-grant.mjs';

export { redact };
export const firstLine = (e) => redact(String(e?.stderr || e?.message || e).trim().split('\n')[0]).slice(0, 300);

let loggedSettingsLine;
/** IO: the live settings (platform preference + review.json), source line logged once per distinct value. */
export function readAutoRoundGrantSettings({ readFile = readFileSync, log = (l) => process.stderr.write(`${l}\n`) } = {}) {
  let tool;
  try { tool = JSON.parse(String(readFile(REVIEW_SETTINGS_FILE, 'utf8'))); } catch { tool = undefined; }
  let platform;
  try { platform = platformPreference('review'); } catch { platform = undefined; }
  const settings = resolveAutoRoundGrantSettings({ platform, tool });
  const line = formatAutoRoundGrantSettings(settings);
  if (line !== loggedSettingsLine) { loggedSettingsLine = line; try { log(line); } catch { /* never fails a tick */ } }
  return settings;
}

/** The ledger directory: one operator-owned sidecar shared by every checkout. */
export function claimDir(env = process.env) { return join(resolveCoordinationRoot({ env }), 'auto-round-grant'); }

/**
 * Serialize every automatic grant for ONE PR across checkouts and daemons, and hand `fn` that PR's durable ledger
 * (`{ seeded, baseline, entries }`, `seeded: false` when it has never been written) plus `save(next)`.
 */
export function withPrLedger(slug, pr, fn, { dir = claimDir(), lock = withFileLock } = {}) {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, createHash('sha256').update(`${slug}#${pr}`).digest('hex').slice(0, 32));
  let entered = false;
  try {
    return lock(`${base}.lock`, () => { entered = true; return readLedgerAndRun(); });
  } catch (e) {
    // Only OUR acquisition timing out marks the PR busy, with how long the holder has held it (gone = just released).
    if (entered || !/^withFileLock: timed out/.test(String(e?.message))) throw e;
    let lockAgeMs = Infinity;
    try { lockAgeMs = Date.now() - statSync(`${base}.lock`).mtimeMs; } catch (s) { if (s?.code === 'ENOENT') lockAgeMs = 0; }
    throw Object.assign(e, { code: 'LEDGER_BUSY', lockAgeMs });
  }
  function readLedgerAndRun() {
    let ledger = { seeded: false, baseline: 0, entries: [] };
    try {
      const raw = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
      if (!Number.isInteger(raw?.baseline) || raw.baseline < 0 || !Array.isArray(raw?.entries)) throw new Error('malformed');
      ledger = { seeded: true, baseline: raw.baseline, entries: raw.entries };
    } catch (e) { if (e?.code !== 'ENOENT') throw new Error(`auto-round-grant ledger unreadable for ${slug}#${pr}`); }
    const save = (next) => writeJsonAtomic(`${base}.json`, { repo: slug, pr, baseline: next.baseline, entries: next.entries });
    return fn({ ...ledger, save });
  }
}

/** A busy PR lock defers a cap note only while its holder is plausibly still deciding; past this, the note alerts. */
export const LEDGER_BUSY_DEFER_MS = 5 * 60_000;

/** IO: the PR's state, head and comments (App identity). */
export function readPrThread(repo, pr, { gh = ghApp, readComments = readCompletePrComments } = {}) {
  const comments = readComments(pr, { repo, exec: (_file, args) => gh(args) });
  if (!Array.isArray(comments)) throw new Error('complete comments read returned no array');
  // Keep the expected-head check fresh even when reading a long thread takes several pages.
  const thread = JSON.parse(String(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,headRefOid'])));
  return { ...thread, comments };
}
/** IO: post one comment (App identity). */
export function postPrComment(repo, pr, body, { gh = ghApp } = {}) {
  gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body]);
}

/**
 * The hook. Returns null when the note is not one the ruling covers at all (no reads made), else one of:
 *   { action: 'granted', count, max, key }      — skip the needs-you event; the cap is raised
 *   { action: 'already-granted', key }          — skip it too: a stale note for a hit another worker's grant answered
 *   { action: 'deferred', why }                 — skip it this pass: another worker holds this PR's lock (young
 *                                                  hold only), or an operator grant landed after the note's snapshot
 *   { action: 'cap-reached', used, max, reason } — publish with this reason
 *   { action: 'skip', why }                      — publish unchanged
 *   { action: 'failed', why }                    — publish unchanged (reservation kept; a person decides)
 */
export function autoRoundGrant({ repo, note, pr }, {
  settings = readAutoRoundGrantSettings(), readRuling = readStandingRuling, readThread = readPrThread,
  readNet = readHumanSurfaceNetFiles, ledger = withPrLedger, post = postPrComment, scopeOf = standingRulingScope,
  now = () => new Date().toISOString(),
} = {}) {
  const screen = screenAutoGrantNote({ note, repo, pr, settings });
  if (!screen.ok) return screen.why === 'not a round-cap note' || screen.why === 'disabled' ? null : { action: 'skip', why: screen.why };
  const { slug } = screen;
  const head = pr.headRefOid;
  const ruling = readRuling(slug);
  if (!ruling) return { action: 'skip', why: 'no standing ruling recorded (open operator-authored ruling issue) for this repo' };
  const key = autoGrantKey({ repo: slug, note, head });
  const max = Math.min(settings.maxPerPr, ruling.maxPerPr, AUTO_GRANT_ABSOLUTE_MAX);
  // The git net read takes seconds and judges this pinned head only, so it runs outside the lock.
  const netRead = readNet({ repo: slug, number: note.prNumber, headRefOid: head }, { log: (l) => process.stderr.write(`${redact(l)}\n`) });
  /** Every trusted grant (manual + standing-ruling) on a thread, the ruling scope re-verified from GitHub. */
  const trustedTotal = ({ comments = [], headRefOid } = {}) => countGrantedRoundExtensions(comments, { repo: slug, pr: note.prNumber,
    standingRuling: scopeOf({ repo: slug, pr: { number: note.prNumber, headRefOid, comments }, ruling }) });
  try {
    return ledger(slug, note.prNumber, ({ seeded, baseline, entries: ledgerEntries, save }) => {
      let thread;
      try { thread = readThread(slug, note.prNumber); } catch (e) { return { action: 'skip', why: `thread unreadable: ${firstLine(e)}` }; }
      const comments = thread?.comments ?? [];
      // An operator grant that landed after this note's snapshot means the note judged a cap that is no longer
      // current: the next pass re-judges it on a snapshot that includes the grant (bounded: one pass). Both counts use
      // the same scope-free reader, so they never disagree about what the snapshot already credited.
      if (Array.isArray(pr?.comments) && countGrantedRoundExtensions(comments, { repo: slug, pr: note.prNumber })
        > countGrantedRoundExtensions(pr.comments, { repo: slug, pr: note.prNumber })) {
        return { action: 'deferred', why: 'an operator grant landed after this note was raised; the next pass re-judges the cap' };
      }
      let entries = ledgerEntries;
      const recordsNow = countStandingRulingGrantRecords(comments, { repo: slug, pr: note.prNumber });
      const { episodes, unrecoverable } = standingRulingGrantEpisodes(comments, { repo: slug, pr: note.prNumber });
      if (unrecoverable > 0) return { action: 'skip', why: `${unrecoverable} existing grant record(s) without a recoverable limit-hit key` };
      if (!seeded) {
        // Seed from the grants already on the PR, keyed by the limit hit each one answered, so a historical grant
        // for THIS hit blocks a second one. A record whose key cannot be recovered fails closed (no grant, no seed).
        entries = episodes.map((episode) => ({ key: episode, outcome: 'historical' }));
        save({ baseline: 0, entries });
      } else {
        // Comments can arrive outside this ledger. Retain every reservation AND newly observed episode.
        const known = new Set(entries.map((e) => e.key));
        const added = episodes.filter((episode) => !known.has(episode));
        if (added.length) {
          entries = [...entries, ...added.map((key) => ({ key, outcome: 'historical' }))];
          save({ baseline, entries });
        }
      }
      const seed = seeded ? baseline : 0;
      const scopeNow = () => scopeOf({ repo: slug, pr: { number: note.prNumber, headRefOid: thread?.headRefOid, comments }, ruling });
      if (entries.some((e) => e.key === key)) {
        // A stale note (another worker's snapshot) for a limit hit already answered by a grant the trusted reader
        // credits on the fresh thread is moot: never alert or park over it. A claim with no credited grant stays a skip.
        // The scope reads run only when a record for this hit is on the thread at all.
        const answered = episodes.includes(key) && roundExtensionGrants(comments, { repo: slug, pr: note.prNumber, standingRuling: scopeNow() })
          .some((g) => g.standingRuling && grantEpisode(comments[g.index]) === key);
        return answered ? { action: 'already-granted', key } : { action: 'skip', why: `already claimed: ${key}` };
      }
      const scope = scopeNow();
      const onGitHub = countAutoRoundGrants(comments, { repo: slug, pr: note.prNumber, standingRuling: scope });
      // Conservative: every automation grant record on the thread NOW (verified or not), the ledger (seeded from
      // historical grants) plus every reservation since, and the verified count — the largest wins.
      const used = Math.max(onGitHub, recordsNow, seed + entries.length);
      const verdict = decideAutoGrant({ netRead, used, max, state: thread?.state });
      if (verdict.action === 'skip') return verdict;
      if (verdict.action === 'cap-reached') return { ...verdict, reason: capReachedReason({ used, max, text: note.text }) };
      const before = countGrantedRoundExtensions(comments, { repo: slug, pr: note.prNumber, standingRuling: scope });
      if (before + Math.max(0, recordsNow - onGitHub) + ruling.by > MAX_TOTAL_ROUND_EXTENSIONS) {
        return { action: 'skip', why: `the ${MAX_TOTAL_ROUND_EXTENSIONS}-round extension ceiling leaves no room` };
      }
      if (thread?.headRefOid !== head) return { action: 'skip', why: `head moved (${String(thread?.headRefOid).slice(0, 12)} ≠ judged ${head.slice(0, 12)})` };
      const reserved = [...entries, { key, at: now(), outcome: 'reserved' }];
      save({ baseline: seed, entries: reserved }); // durable BEFORE the post: a crash from here on still holds this slot
      const finish = (outcome) => save({ baseline: seed, entries: reserved.map((e) => (e.key === key ? { ...e, ...outcome } : e)) });
      try {
        // Expected-head check right before the write: the judged head must still be the PR's head.
        const fresh = readThread(slug, note.prNumber);
        if (fresh?.headRefOid !== head || String(fresh?.state).toUpperCase() !== 'OPEN') {
          finish({ outcome: 'aborted', why: 'head moved or PR closed before the post' });
          return { action: 'skip', why: 'head moved or PR closed right before the post' };
        }
        const record = { repo: slug, pr: note.prNumber, by: ruling.by, actor: ruling.author, channel: AUTO_GRANT_CHANNEL,
          reason: autoGrantReason({ note, head, count: verdict.count, max, rulingId: ruling.id }), at: now(), standingRuling: ruling.id, head, episode: key };
        const body = buildRoundExtensionComment(record);
        const trustedBefore = trustedTotal(fresh);
        // Re-read head + state IMMEDIATELY before the post (the verification above is slow); refusal keeps the slot.
        const last = readThread(slug, note.prNumber);
        if (last?.headRefOid !== head || String(last?.state).toUpperCase() !== 'OPEN') {
          finish({ outcome: 'aborted', why: 'head moved or PR closed right before the post' });
          return { action: 'skip', why: 'head moved or PR closed right before the post' };
        }
        post(slug, note.prNumber, body);
        const after = readThread(slug, note.prNumber);
        // Proof: the thread's whole trusted total rose by exactly the grant (re-verified from GitHub), so a grant
        // that adds no effective round is never reported as granted.
        if ((after?.comments ?? []).filter((c) => c?.body === body).length !== 1
          || trustedTotal(after ?? {}) !== trustedBefore + ruling.by) {
          throw new Error('could not prove the posted grant raised the trusted round count');
        }
        finish({ outcome: 'granted' });
        return { action: 'granted', count: verdict.count, max, key };
      } catch (e) {
        const why = firstLine(e);
        finish({ outcome: 'failed', error: why });
        return { action: 'failed', why, key };
      }
    });
  } catch (e) {
    // Another worker holds this PR's lock: it is deciding this same PR right now, so this note waits for the next
    // pass (never alert or park over a grant that may be landing) — but only while the hold is young. A lock held
    // past LEDGER_BUSY_DEFER_MS (a hung holder, a reused pid) and an unreadable ledger never grant and alert as usual.
    if (e?.code === 'LEDGER_BUSY' && e.lockAgeMs < LEDGER_BUSY_DEFER_MS) return { action: 'deferred', why: `ledger: ${firstLine(e)}` };
    return { action: 'skip', why: `ledger: ${firstLine(e)}` };
  }
}

/** The limit-hit key a grant comment's record names, or null. */
function grantEpisode(comment) {
  const m = String(comment?.body ?? '').match(/^<!-- round-extension: (.+) -->$/m);
  try { return m ? JSON.parse(m[1])?.episode ?? null : null; } catch { return null; }
}

/** How long a PR may stay labelled at its round limit after an automatic grant before a person is told. */
export const STUCK_AFTER_GRANT_MS = 20 * 60_000;

/**
 * Never silently stuck: a PR still labelled `status:at-round-limit` well after an automatic grant on its CURRENT
 * head means some reader did not credit the grant (or the grant freed no round). Returns the needs-you reason, or
 * null. Cheap screen first (label + a cited grant for this head); only then the read-time scope.
 */
export function stuckAfterGrant({ repo, pr }, { scopeOf = standingRulingScope, now = Date.now, minAgeMs = STUCK_AFTER_GRANT_MS } = {}) {
  const labels = (pr?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
  const head = String(pr?.headRefOid ?? '');
  if (!labels.includes('status:at-round-limit') || !/^[0-9a-f]{40}$/.test(head)) return null;
  const slug = CONSTELLATION_REPOS[repo]?.slug ?? repo;
  const comments = pr?.comments ?? [];
  if (!standingRulingGrantEpisodes(comments, { repo: slug, pr: pr.number }).episodes.some((e) => e.includes(`@${head}:`))) return null;
  let scope = null;
  try { scope = scopeOf({ repo: slug, pr: { number: pr.number, headRefOid: head, comments } }); } catch { scope = null; }
  const mine = roundExtensionGrants(comments, { repo: slug, pr: pr.number, standingRuling: scope }).filter((g) => g.standingRuling && g.head === head);
  const at = mine.length ? Math.max(...mine.map((g) => Date.parse(g.at))) : NaN;
  // An uncredited grant (no scope / not trusted) is stuck by definition once it exists on the thread.
  // Uncredited fallback: ONLY automation-authored standing-ruling grant records for this repo + PR + current head,
  // timed by GitHub's createdAt (earliest), so no other commenter can restart the grace period.
  const postedAt = Number.isFinite(at) ? at : Math.min(...comments.filter((c) => {
    if (!isAutomationAuthored(c) || isOperatorAuthored(c) || !String(c?.body ?? '').startsWith(ROUND_EXTENSION_MARKER + '\n')) return false;
    const m = [...String(c.body).matchAll(/^<!-- round-extension: (.+) -->$/gm)];
    if (m.length !== 1) return false;
    try {
      const r = JSON.parse(m[0][1]);
      return !!r?.standingRuling && (CONSTELLATION_REPOS[r.repo]?.slug ?? r.repo) === slug && r.pr === Number(pr.number) && r.head === head;
    } catch { return false; }
  }).map((c) => Date.parse(commentCreatedAt(c))).filter(Number.isFinite), Infinity);
  if (!Number.isFinite(postedAt) || now() - postedAt < minAgeMs) return null;
  const minutes = Math.round((now() - postedAt) / 60_000);
  return `auto-grant did not free a round: still at the round limit ${minutes} min after it${mine.length ? '' : ' (grant not credited)'} — a person must check`;
}
