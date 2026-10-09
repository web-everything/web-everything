/**
 * @file scripts/lib/quiet-hours-io.mjs
 * @description The quietHours knob (card xmvc6oc) — the IO shell around the pure `we:scripts/lib/quiet-hours.mjs`.
 *
 *   Reads the settings file (`we:scripts/quiet-hours-settings.json`, or `WE_QUIET_HOURS_SETTINGS`), the operator
 *   toggle file, and owns the digest queue. Every notify path routes through {@link gateAlert}: deliver now, or hold
 *   for the digest. Any error inside the gate DELIVERS the alert — the gate may delay an alert, it must never lose one.
 *
 *   THE QUEUE IS ONE FILE PER HELD ALERT (`<digestDir>/queue/<id>.json`). A writer stages its alert in
 *   `<digestDir>/tmp/` and commits it with ONE rename into `queue/`. Nobody appends to a shared file, so no writer
 *   holds a handle that a flush could rename or delete under it: a rename is resolved by path at the instant it runs,
 *   so the alert lands either in the queue a flusher is about to claim (and is sent with it) or in a fresh queue (and
 *   is sent by the next digest). A single shared file cannot give that: a writer that opened it before a flush can
 *   write into it after any cleanup, however late.
 *
 *   A flusher claims the whole queue with ONE rename (`queue/` → `claim-<pid>-<ms>-<seq>/`), so two flushers never
 *   send the same alert. If anything fails before a confirmed send, each entry is renamed back into `queue/`; a
 *   per-file rename moves an entry at most once, so two recoveries cannot both restore it. A confirmed claim is renamed
 *   to `sent-…` before it is deleted, so no sweeper ever restores it.
 *
 *   Delivery is AT LEAST ONCE: a flusher killed between a confirmed send and that rename leaves a claim the next flush
 *   restores and sends again (one duplicate digest). Nothing here ever deletes an alert that was not sent.
 *
 *   `WE_QUIET_HOURS=off` turns the gate off (every alert is delivered at once) and still drains what was held before.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnderTest } from './under-test.mjs';
import { decideDelivery, isQuiet, mergeSettings, planDigest, sweepSkip } from './quiet-hours.mjs';

export const SETTINGS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../quiet-hours-settings.json');

/** The operator's off switch: deliver everything now (what was already held still drains). */
const offSwitch = (env) => env.WE_QUIET_HOURS === 'off';
/** Inside vitest, unless `WE_QUIET_HOURS=on` (tests, per the shared `isUnderTest`, never touch the real digest). */
const testBypassed = (env) => isUnderTest(env) && env.WE_QUIET_HOURS !== 'on';
/** The gate is off: the off switch, or a test. */
export const bypassed = (env) => offSwitch(env) || testBypassed(env);

export const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Settings merged over defaults; a missing or torn file yields the defaults. */
export function loadQuietSettings({ env = process.env } = {}) {
  return mergeSettings(readJson(env.WE_QUIET_HOURS_SETTINGS || SETTINGS_PATH));
}

/** The operator toggle (`{"on":bool,"until":iso|null}`), or null when absent/torn (= no override). */
export function readToggle(settings, { env = process.env } = {}) {
  return readJson(expandHome(env.WE_QUIET_MODE_FILE || settings.toggleFile));
}

export const digestPaths = (settings, { env = process.env } = {}) => {
  const dir = expandHome(env.WE_QUIET_DIGEST_DIR || settings.digestDir);
  return { dir, queue: join(dir, 'queue'), tmp: join(dir, 'tmp') };
};

/** Everything needed to decide, read once. */
export function quietContext({ env = process.env, now = Date.now() } = {}) {
  const settings = loadQuietSettings({ env });
  const toggle = readToggle(settings, { env });
  return { settings, toggle, now, state: isQuiet(now, settings, toggle) };
}

/** A claim (`claim-<pid>-<claimedAtMs>-<seq>`) older than this MAY belong to a flusher that crashed. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** ...but one whose owner process is still alive is only taken after this much longer (hung, or the pid was reused). */
export const LIVE_OWNER_CLAIM_MS = 2 * 60 * 60_000;
/** A staged entry (`tmp/<ms>-…`) this old belongs to a writer that died before committing it (its caller was never told "held"). */
export const STALE_STAGED_MS = 24 * 60 * 60_000;
const CLAIM_PREFIX = 'claim-';
const SENT_PREFIX = 'sent-';

/** Claims this process holds right now (a re-entrant flush must not sweep the outer call's claim). */
const activeClaims = new Set();

let seq = 0;
/** A name no other writer or flusher can pick: time first, so a directory listing sorts in arrival order. */
function uniqueId(now) {
  seq += 1;
  return `${String(Math.trunc(Number(now) || 0)).padStart(15, '0')}-${process.pid}-${seq}-${randomBytes(4).toString('hex')}`;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * Rename `src` into the queue as `name`. The queue directory may be claimed (renamed away) by a flusher at any moment,
 * including between our mkdir and our rename: that is ENOENT on the target, so make the queue again and retry. Throws
 * when `src` itself is gone or the retries run out.
 */
function moveIntoQueue(src, queue, name) {
  for (let attempt = 0; ; attempt += 1) {
    mkdirSync(queue, { recursive: true });
    try { renameSync(src, join(queue, name)); return; } catch (e) {
      if (e?.code !== 'ENOENT' || attempt >= 4 || !existsSync(src)) throw e;
    }
  }
}

/** Stage, then commit one held alert. Throws on any failure (the gate then delivers it instead). */
function commitEntry(paths, entry, now, beforeCommit) {
  mkdirSync(paths.tmp, { recursive: true });
  const name = `${uniqueId(now)}.json`;
  const staged = join(paths.tmp, name);
  writeFileSync(staged, `${JSON.stringify(entry)}\n`);
  try {
    beforeCommit?.(); // test seam: the writer is descheduled here while flushes run
    moveIntoQueue(staged, paths.queue, name);
  } catch (e) {
    try { unlinkSync(staged); } catch { /* already gone */ }
    throw e;
  }
}

/** Has anything been committed to the queue? */
function hasEntries(queue) {
  try { return readdirSync(queue).length > 0; } catch { return false; }
}

/** The entries of a claim, oldest first. A file that cannot be READ throws (the claim is restored); one that is not JSON is skipped. */
function readEntries(claimDir) {
  const entries = [];
  for (const f of readdirSync(claimDir).sort()) {
    const text = readFileSync(join(claimDir, f), 'utf8');
    try { entries.push(JSON.parse(text)); } catch { /* not an alert — skip */ }
  }
  return entries;
}

/** Move every entry of a claim back into the queue, then remove the claim. Never throws; false = some entries are still in the claim. */
function restoreClaim(claimDir, queue) {
  try {
    for (const f of readdirSync(claimDir)) moveIntoQueue(join(claimDir, f), queue, f);
  } catch { return false; }
  try { rmdirSync(claimDir); } catch { /* an empty claim left behind is restored (as nothing) by the next sweep */ }
  return true;
}

/** A claim whose entries were sent (or are not alerts): mark it sent, then delete it. Never throws. */
function endClaim(claimDir, paths, now) {
  let target = claimDir;
  try { const sent = join(paths.dir, `${SENT_PREFIX}${uniqueId(now)}`); renameSync(claimDir, sent); target = sent; } catch { /* delete in place */ }
  // A leftover `sent-*` is removed by the next sweep; a leftover claim (both steps failed) is at worst one duplicate digest.
  try { rmSync(target, { recursive: true, force: true }); } catch { /* see above */ }
}

/**
 * Recover claims left behind by a flusher that died after claiming the queue. A young claim may belong to a live
 * flusher, so only claims older than {@link STALE_CLAIM_MS} (by the stamp in the name) are taken. Each is renamed
 * to a fresh name first, so only one sweeper takes it. Never throws.
 */
function recoverStaleClaims(paths, now) {
  let names = [];
  try { names = readdirSync(paths.dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(CLAIM_PREFIX)) continue;
    const m = /^(\d+)-(\d+)/.exec(name.slice(CLAIM_PREFIX.length));
    const claimedAt = Number(m?.[2]);
    // A timestamp from the future (clock skew, garbage) is as stale as an old one: it would otherwise never be swept.
    if (!Number.isFinite(claimedAt) || Math.abs(now - claimedAt) <= STALE_CLAIM_MS) continue;
    if (activeClaims.has(name)) continue;
    // Taking a claim from a flusher that is still alive would send its entries twice (it sends, we restore and send
    // again). The owner is the pid in the name. Our own pid is never "another live process": a claim of ours that is
    // not active is a failed restore.
    const owner = Number(m[1]);
    if (owner !== process.pid && Math.abs(now - claimedAt) <= LIVE_OWNER_CLAIM_MS && pidAlive(owner)) continue;
    // Take it under a NEW name stamped with this sweep (our pid, `now`). The rename is atomic, so only one sweeper wins,
    // and the new stamp makes the claim young again, so a second sweeper cannot take it while we are still restoring it.
    // Even if two did, each entry is moved back by its own rename, so it can be restored only once.
    seq += 1;
    const swept = `${CLAIM_PREFIX}${process.pid}-${now}-${seq}`;
    const mine = join(paths.dir, swept);
    try { renameSync(join(paths.dir, name), mine); } catch { continue; }
    activeClaims.add(swept);
    try { restoreClaim(mine, paths.queue); } finally { activeClaims.delete(swept); }
  }
}

/** Remove what is safe to remove: `sent-*` claims, and entries staged by a writer that died long ago. Never throws. */
function sweepLeftovers(paths, now) {
  try {
    for (const name of readdirSync(paths.dir)) {
      if (name.startsWith(SENT_PREFIX)) { try { rmSync(join(paths.dir, name), { recursive: true, force: true }); } catch { /* next time */ } }
    }
  } catch { /* no digest dir yet */ }
  try {
    for (const name of readdirSync(paths.tmp)) {
      // A writer this late finds its staged file gone, fails its commit, and so delivers the alert itself.
      const at = Number(/^(\d+)-/.exec(name)?.[1]);
      if (Number.isFinite(at) && Math.abs(now - at) > STALE_STAGED_MS) { try { unlinkSync(join(paths.tmp, name)); } catch { /* next time */ } }
    }
  } catch { /* no tmp dir */ }
}

/**
 * Send the ONE held-alerts digest if quiet hours are over (or switched off) and something is held. The queue is
 * claimed by one rename before reading, so two concurrent flushers cannot both send it. Anything that goes wrong
 * between the claim and a confirmed send (a throwing sender, a failed digest-file write, a returned `{ok:false}`)
 * puts the entries back on the queue; a flusher that dies outright leaves a claim the next flush recovers. Returns
 * what happened; never throws.
 */
export function flushDigest({ send, env = process.env, now = Date.now(), dryRun = false, beforeSend } = {}) {
  let claimDir = null;
  let claimId = null;
  let paths = null;
  let confirmed = false; // the sender reported success — from here the entries must NOT be restored
  try {
    if (testBypassed(env)) return { flushed: false, reason: 'bypassed' };
    const { settings, state } = quietContext({ env, now });
    if (state.quiet && !offSwitch(env)) return { flushed: false, reason: `still quiet (${state.reason})` };
    paths = digestPaths(settings, { env });
    if (!dryRun) { recoverStaleClaims(paths, now); sweepLeftovers(paths, now); }
    if (!hasEntries(paths.queue)) return { flushed: false, reason: 'nothing held' };
    if (dryRun) return { flushed: false, reason: 'dry run' };
    seq += 1;
    const claim = join(paths.dir, `${CLAIM_PREFIX}${process.pid}-${now}-${seq}`); // unique per call
    try { renameSync(paths.queue, claim); } catch { return { flushed: false, reason: 'another flusher claimed it' }; }
    claimDir = claim;
    claimId = basename(claim);
    activeClaims.add(claimId);
    const entries = readEntries(claimDir);
    // `digest.enabled=false` only stops NEW alerts being held (decideDelivery delivers them). Whatever was already
    // held is still owed to the operator, so it drains here, once, as a digest: never deleted, never stranded.
    const plan = planDigest(entries, { ...settings, digest: { ...settings.digest, enabled: true } });
    if (!plan) { endClaim(claimDir, paths, now); claimDir = null; return { flushed: false, reason: 'digest empty' }; } // no file in it is an alert
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const mdPath = join(paths.dir, `digest-${stamp}.md`);
    writeFileSync(mdPath, plan.markdown);
    writeFileSync(join(paths.dir, 'latest-digest.md'), plan.markdown);
    beforeSend?.(claimDir); // test seam: lets a test play the part of a sweeper that takes the claim while this flusher is stuck
    // A flusher that hung past the live-owner limit has had its claim restored by a sweeper; sending now would deliver the
    // same entries twice (the restored copy goes out in the next digest). The claim is no longer ours: leave it.
    if (!existsSync(claimDir)) { claimDir = null; return { flushed: false, reason: 'claim taken by a sweeper' }; }
    const sent = send ? send({ title: plan.title, body: plan.body }) : { ok: false, error: 'no sender' };
    if (sent?.ok !== true) { // only an explicit success empties the queue: undefined/{}/null from a sloppy sender is NOT a confirmation
      if (!restoreClaim(claimDir, paths.queue)) throw new Error('could not re-queue the failed digest');
      claimDir = null;
      return { flushed: false, count: entries.length, mdPath, sent };
    }
    confirmed = true;
    endClaim(claimDir, paths, now);
    claimDir = null;
    return { flushed: true, count: entries.length, mdPath, sent };
  } catch (e) {
    // Already sent: never restore (that would send twice). Otherwise put the entries back; if even that fails, the
    // claim stays and the stale-claim sweep restores it later (this process: after STALE_CLAIM_MS; another: once we exit).
    if (claimDir) { if (confirmed) endClaim(claimDir, paths, now); else restoreClaim(claimDir, paths.queue); }
    return { flushed: false, reason: `flush error: ${String(e?.message ?? e)}` };
  } finally {
    if (claimId) activeClaims.delete(claimId);
  }
}

/**
 * The gate every desktop notification goes through. `send(notification)` does the real delivery and returns
 * `{ok}`. Returns the send result, or `{ok:true, suppressed:true, reason}` when held for the digest.
 *
 * `sendDigest` is the sender used to flush the held digest on the way through, and MUST report `ok:true` only once
 * delivery really happened: the queue is emptied on that confirmation. A fire-and-forget `send` (acknowledges
 * before the OS call has run) is therefore not used for it; without a `sendDigest` this call does not flush (the
 * periodic `flushDigest` callers do).
 */
export function gateAlert(notification, { send, sendDigest, env = process.env, now = Date.now(), beforeCommit } = {}) {
  if (bypassed(env)) {
    // The off switch delivers every new alert at once; what was held before it was flipped is still owed, so drain it.
    if (offSwitch(env) && sendDigest) { try { flushDigest({ send: sendDigest, env, now }); } catch { /* best-effort */ } }
    return send(notification);
  }
  try {
    if (sendDigest) flushDigest({ send: sendDigest, env, now });
    const { settings, toggle } = quietContext({ env, now });
    const decision = decideDelivery(notification, { now, settings, toggle });
    if (!decision.deliver) {
      const entry = { at: new Date(now).toISOString(), title: String(notification?.title ?? ''), body: String(notification?.body ?? ''), reason: decision.reason };
      commitEntry(digestPaths(settings, { env }), entry, now, beforeCommit);
      return { ok: true, suppressed: true, reason: decision.reason };
    }
  } catch { /* the gate must never lose an alert — deliver */ }
  return send(notification);
}

/** Should this sweep job skip now? Never throws (an error means: run). */
export function sweepSkipNow(job, { env = process.env, now = Date.now() } = {}) {
  try {
    if (bypassed(env)) return { skip: false, reason: 'bypassed' };
    const { settings, toggle } = quietContext({ env, now });
    return sweepSkip(job, { now, settings, toggle });
  } catch (e) { return { skip: false, reason: `quiet check failed: ${String(e?.message ?? e)}` }; }
}
