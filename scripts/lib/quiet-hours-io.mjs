/**
 * @file scripts/lib/quiet-hours-io.mjs
 * @description The quietHours knob (card xmvc6oc) — the IO shell around the pure `we:scripts/lib/quiet-hours.mjs`.
 *
 *   Reads the settings file (`we:scripts/quiet-hours-settings.json`, or `WE_QUIET_HOURS_SETTINGS`), the operator
 *   toggle file, and owns the digest queue (`<digestDir>/held.jsonl`). Every notify path routes through
 *   {@link gateAlert}: deliver now, or append to the digest. Any error inside the gate DELIVERS the alert — the
 *   gate may delay an alert, it must never lose one.
 *
 *   `WE_QUIET_HOURS=off` bypasses the gate entirely (deliver everything, flush nothing).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnderTest } from './under-test.mjs';
import { decideDelivery, isQuiet, mergeSettings, planDigest, sweepSkip } from './quiet-hours.mjs';

export const SETTINGS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../quiet-hours-settings.json');

/** Off switch: `WE_QUIET_HOURS=off`, and inside vitest unless `WE_QUIET_HOURS=on` (tests, per the shared `isUnderTest`, never touch the real digest). */
export const bypassed = (env) => env.WE_QUIET_HOURS === 'off' || (isUnderTest(env) && env.WE_QUIET_HOURS !== 'on');

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
  return { dir, held: join(dir, 'held.jsonl') };
};

/** Everything needed to decide, read once. */
export function quietContext({ env = process.env, now = Date.now() } = {}) {
  const settings = loadQuietSettings({ env });
  const toggle = readToggle(settings, { env });
  return { settings, toggle, now, state: isQuiet(now, settings, toggle) };
}

/** A claim (`held.jsonl.flushing-<pid>-<claimedAtMs>-<seq>`) older than this MAY belong to a flusher that crashed. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** ...but one whose owner process is still alive is only taken after this much longer (hung, or the pid was reused). */
export const LIVE_OWNER_CLAIM_MS = 2 * 60 * 60_000;
const CLAIM_PREFIX = 'held.jsonl.flushing-';

/** Claims this process holds right now (a re-entrant flush must not sweep the outer call's claim). */
const activeClaims = new Set();

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * A retired claim (`held.jsonl.retired-<pid>-<atMs>-<seq>-<consumedBytes>`) is a claim whose flush is over. It is NOT
 * deleted: a writer that opened the queue before it was renamed away keeps a handle on this very file and may write
 * its line into it at any later moment (`appendFileSync` opens, then writes), so no read-then-delete can be safe.
 * Instead the file waits {@link RETIRED_GRACE_MS}; the next flush then puts everything past `consumedBytes` back on
 * the queue and deletes it. The prefix differs from the claim prefix on purpose: a retired file must never be taken
 * for a crashed flusher's claim (its entries were already sent or restored, and would go out twice).
 */
export const RETIRED_GRACE_MS = 2 * 60_000;
const RETIRED_PREFIX = 'held.jsonl.retired-';

let claimSeq = 0;

/** Rename a finished claim to its retired name. `consumedBytes` = how much of it was already sent or restored. Never throws. */
function retireClaim(claimed, consumedBytes, now) {
  claimSeq += 1;
  try { renameSync(claimed, join(dirname(claimed), `${RETIRED_PREFIX}${process.pid}-${now}-${claimSeq}-${consumedBytes}`)); return true; } catch { return false; }
}

/**
 * Put a claimed queue file back on the held queue, byte for byte (not re-parsed, so a torn line is kept too),
 * then retire the claim (so a line a straggling writer adds to it afterwards is still re-queued later). Never throws:
 * if the restore itself fails the claim file stays, and the stale-claim sweep at the next flush retries it.
 */
function restoreClaim(claimed, held, now) {
  let consumed = 0;
  try {
    const buf = readFileSync(claimed);
    consumed = buf.length;
    const text = buf.toString('utf8');
    if (text) appendFileSync(held, `\n${text}${text.endsWith('\n') ? '' : '\n'}`); // leading \n: a torn tail on held must not glue onto the first restored line
  } catch { return false; }
  if (retireClaim(claimed, consumed, now)) return true;
  try { unlinkSync(claimed); } catch { try { writeFileSync(claimed, ''); } catch { /* restored already; a leftover claim is only a duplicate */ } }
  return true;
}

/** A claim whose entries were sent (or are unsendable): retire it, or delete it when it cannot be renamed. Never throws. */
function endClaim(claimed, consumedBytes, now) {
  if (retireClaim(claimed, consumedBytes, now)) return;
  try { unlinkSync(claimed); } catch { try { writeFileSync(claimed, ''); } catch { /* a leftover claim is only a duplicate */ } }
}

/**
 * Re-queue what straggling writers added to retired claims once they are past the grace period, then delete them.
 * Each file is taken by an atomic rename to a fresh retired name first, so two sweepers cannot both re-queue it.
 * Never throws.
 */
function sweepRetired(dir, held, now) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(RETIRED_PREFIX)) continue;
    const m = /^(\d+)-(\d+)-(\d+)-(\d+)$/.exec(name.slice(RETIRED_PREFIX.length));
    if (!m) continue;
    const consumed = Number(m[4]);
    if (Math.abs(now - Number(m[2])) <= RETIRED_GRACE_MS) continue; // a future stamp (clock skew) is swept like an old one
    claimSeq += 1;
    const mine = join(dir, `${RETIRED_PREFIX}${process.pid}-${now}-${claimSeq}-${consumed}`);
    try { renameSync(join(dir, name), mine); } catch { continue; }
    try {
      const tail = readFileSync(mine).subarray(consumed).toString('utf8');
      if (tail.trim()) appendFileSync(held, `\n${tail}${tail.endsWith('\n') ? '' : '\n'}`);
      try { unlinkSync(mine); } catch { writeFileSync(mine, ''); } // appended already: never leave the tail to be appended again
    } catch { /* it stays under a fresh stamp and is retried after the next grace period (at worst one duplicate line) */ }
  }
}

/**
 * Recover claims left behind by a flusher that died after renaming the queue away. A young claim may belong to
 * a live flusher, so only claims older than {@link STALE_CLAIM_MS} (by the timestamp in the name — the queue
 * file's own mtime is the last ALERT time, not the claim time) are taken. Each is renamed to a unique name
 * first, so two sweepers cannot both restore the same claim. Never throws.
 */
function recoverStaleClaims(dir, held, now) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
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
    // Take it under a NEW name stamped with this sweep (our pid, `now`). The rename is atomic, so only one sweeper wins;
    // and the new stamp makes the claim young again, so a second sweeper cannot take it while we are still restoring it
    // (with the old stamp it would look hours old and, being "owned" by a live pid past the hard limit, be taken, and
    // its entries restored and sent twice). A crash mid-restore just leaves a claim that goes stale again in 10 minutes.
    claimSeq += 1;
    const swept = `${CLAIM_PREFIX}${process.pid}-${now}-${claimSeq}`;
    const mine = join(dir, swept);
    try { renameSync(join(dir, name), mine); } catch { continue; }
    activeClaims.add(swept);
    try { restoreClaim(mine, held, now); } finally { activeClaims.delete(swept); }
  }
}

/**
 * Send the ONE held-alerts digest if quiet hours are over and something is held. The held file is renamed away
 * before reading, so two concurrent flushers cannot both send it. Anything that goes wrong between the claim and
 * a confirmed send (a throwing sender, a failed digest-file write, a returned `{ok:false}`) puts the entries back
 * on the queue; a flusher that dies outright leaves a claim the next flush recovers. Returns what happened; never throws.
 */
export function flushDigest({ send, env = process.env, now = Date.now(), dryRun = false, beforeSend } = {}) {
  let claimed = null;
  let held = null;
  let claimId = null;
  let consumed = 0; // bytes of the claim that were read (and so sent or restored); anything past it arrived late
  let confirmed = false; // the sender reported success — from here the entries must NOT be restored
  try {
    if (bypassed(env)) return { flushed: false, reason: 'bypassed' };
    const { settings, state } = quietContext({ env, now });
    if (state.quiet) return { flushed: false, reason: `still quiet (${state.reason})` };
    const { dir, held: heldPath } = digestPaths(settings, { env });
    held = heldPath;
    if (!dryRun) { recoverStaleClaims(dir, held, now); sweepRetired(dir, held, now); }
    if (!existsSync(held)) return { flushed: false, reason: 'nothing held' };
    if (dryRun) return { flushed: false, reason: 'dry run' };
    claimSeq += 1;
    const claim = `${held}.flushing-${process.pid}-${now}-${claimSeq}`; // unique per call: a rename must never overwrite a surviving claim
    try { renameSync(held, claim); } catch { return { flushed: false, reason: 'another flusher claimed it' }; }
    claimed = claim;
    claimId = basename(claim);
    activeClaims.add(claimId);
    const entries = [];
    const buf = readFileSync(claimed);
    consumed = buf.length;
    const raw = buf.toString('utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* torn line — skip */ }
    }
    // `digest.enabled=false` only stops NEW alerts being held (decideDelivery delivers them). Whatever was already
    // held is still owed to the operator, so it drains here, once, as a digest: never deleted, never stranded.
    const plan = planDigest(entries, { ...settings, digest: { ...settings.digest, enabled: true } });
    if (!plan) { endClaim(claimed, consumed, now); claimed = null; return { flushed: false, reason: 'digest empty' }; } // only torn/untitled lines: nothing sendable
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const mdPath = join(dir, `digest-${stamp}.md`);
    writeFileSync(mdPath, plan.markdown);
    writeFileSync(join(dir, 'latest-digest.md'), plan.markdown);
    beforeSend?.(claimed); // test seam: lets a test play the part of a sweeper that takes the claim while this flusher is stuck
    // A flusher that hung past the live-owner limit has had its claim restored by a sweeper; sending now would deliver the
    // same entries twice (the restored copy goes out in the next digest). The claim is no longer ours: leave it.
    if (!existsSync(claimed)) { claimed = null; return { flushed: false, reason: 'claim taken by a sweeper' }; }
    const sent = send ? send({ title: plan.title, body: plan.body }) : { ok: false, error: 'no sender' };
    if (sent?.ok !== true) { // only an explicit success empties the queue: undefined/{}/null from a sloppy sender is NOT a confirmation
      // Delivery failed: put the claim's raw lines back (torn lines included) so the next flush retries.
      const requeued = restoreClaim(claimed, held, now);
      if (requeued) claimed = null;
      else throw new Error('could not re-queue the failed digest');
      return { flushed: false, count: entries.length, mdPath, sent };
    }
    confirmed = true; // the sender reported success — the entries must not be restored from here
    endClaim(claimed, consumed, now);
    claimed = null;
    return { flushed: true, count: entries.length, mdPath, sent };
  } catch (e) {
    if (claimed && held) {
      if (confirmed) {
        // Already sent: never restore, that would send twice. Retire the claim (or, failing that, empty it) so a sweep finds nothing to restore.
        if (!retireClaim(claimed, consumed, now)) { try { writeFileSync(claimed, ''); } catch { /* nothing more to do */ } }
      } else restoreClaim(claimed, held, now);
    }
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
export function gateAlert(notification, { send, sendDigest, env = process.env, now = Date.now() } = {}) {
  if (bypassed(env)) return send(notification);
  let decision;
  try {
    if (sendDigest) flushDigest({ send: sendDigest, env, now });
    const { settings, toggle } = quietContext({ env, now });
    decision = decideDelivery(notification, { now, settings, toggle });
    if (!decision.deliver) {
      const { dir, held } = digestPaths(settings, { env });
      mkdirSync(dir, { recursive: true });
      // Leading \n: if a writer died mid-line, the torn tail must not swallow this alert (the reader skips blank lines).
      appendFileSync(held, '\n' + JSON.stringify({ at: new Date(now).toISOString(), title: String(notification?.title ?? ''), body: String(notification?.body ?? ''), reason: decision.reason }) + '\n');
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
