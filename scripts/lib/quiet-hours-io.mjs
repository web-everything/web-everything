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
 * Put a claimed queue file back on the held queue, byte for byte (not re-parsed, so a torn line is kept too),
 * then remove the claim. Never throws: if the restore itself fails the claim file stays, and the stale-claim
 * sweep at the next flush retries it.
 */
function restoreClaim(claimed, held) {
  try {
    const text = readFileSync(claimed, 'utf8');
    if (text) appendFileSync(held, `\n${text}${text.endsWith('\n') ? '' : '\n'}`); // leading \n: a torn tail on held must not glue onto the first restored line
  } catch { return false; }
  try { unlinkSync(claimed); } catch { try { writeFileSync(claimed, ''); } catch { /* restored already; a leftover claim is only a duplicate */ } }
  return true;
}

/**
 * A writer that opened the queue just before it was renamed away can land its line in the CLAIM after we read it
 * (`appendFileSync` opens, then writes). Before the claim is deleted, put anything beyond what was read back on the
 * queue, so that alert is held for the next digest instead of lost. Never throws.
 */
function requeueLateWrites(claimed, readText, held) {
  try {
    const now = readFileSync(claimed, 'utf8');
    if (now.length <= readText.length || !now.startsWith(readText)) return;
    const tail = now.slice(readText.length);
    if (tail.trim()) appendFileSync(held, `\n${tail}${tail.endsWith('\n') ? '' : '\n'}`);
  } catch { /* best-effort: the alert is only delayed or, at worst, lost as before */ }
}

let claimSeq = 0;

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
    try { restoreClaim(mine, held); } finally { activeClaims.delete(swept); }
  }
}

/**
 * Send the ONE held-alerts digest if quiet hours are over and something is held. The held file is renamed away
 * before reading, so two concurrent flushers cannot both send it. Anything that goes wrong between the claim and
 * a confirmed send (a throwing sender, a failed digest-file write, a returned `{ok:false}`) puts the entries back
 * on the queue; a flusher that dies outright leaves a claim the next flush recovers. Returns what happened; never throws.
 */
export function flushDigest({ send, env = process.env, now = Date.now(), dryRun = false } = {}) {
  let claimed = null;
  let held = null;
  let claimId = null;
  let confirmed = false; // the sender reported success — from here the entries must NOT be restored
  try {
    if (bypassed(env)) return { flushed: false, reason: 'bypassed' };
    const { settings, state } = quietContext({ env, now });
    if (state.quiet) return { flushed: false, reason: `still quiet (${state.reason})` };
    const { dir, held: heldPath } = digestPaths(settings, { env });
    held = heldPath;
    if (!dryRun) recoverStaleClaims(dir, held, now);
    if (!existsSync(held)) return { flushed: false, reason: 'nothing held' };
    if (dryRun) return { flushed: false, reason: 'dry run' };
    claimSeq += 1;
    const claim = `${held}.flushing-${process.pid}-${now}-${claimSeq}`; // unique per call: a rename must never overwrite a surviving claim
    try { renameSync(held, claim); } catch { return { flushed: false, reason: 'another flusher claimed it' }; }
    claimed = claim;
    claimId = basename(claim);
    activeClaims.add(claimId);
    const entries = [];
    const raw = readFileSync(claimed, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* torn line — skip */ }
    }
    // `digest.enabled=false` only stops NEW alerts being held (decideDelivery delivers them). Whatever was already
    // held is still owed to the operator, so it drains here, once, as a digest: never deleted, never stranded.
    const plan = planDigest(entries, { ...settings, digest: { ...settings.digest, enabled: true } });
    if (!plan) { requeueLateWrites(claimed, raw, held); unlinkSync(claimed); claimed = null; return { flushed: false, reason: 'digest empty' }; } // only torn/untitled lines: nothing sendable
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const mdPath = join(dir, `digest-${stamp}.md`);
    writeFileSync(mdPath, plan.markdown);
    writeFileSync(join(dir, 'latest-digest.md'), plan.markdown);
    const sent = send ? send({ title: plan.title, body: plan.body }) : { ok: false, error: 'no sender' };
    if (sent?.ok !== true) { // only an explicit success empties the queue: undefined/{}/null from a sloppy sender is NOT a confirmation
      // Delivery failed: put the claim's raw lines back (torn lines included) so the next flush retries.
      const requeued = restoreClaim(claimed, held);
      if (requeued) claimed = null;
      else throw new Error('could not re-queue the failed digest');
      return { flushed: false, count: entries.length, mdPath, sent };
    }
    confirmed = true; // the sender reported success — the entries must not be restored from here
    requeueLateWrites(claimed, raw, held);
    unlinkSync(claimed);
    claimed = null;
    return { flushed: true, count: entries.length, mdPath, sent };
  } catch (e) {
    if (claimed && held) {
      if (confirmed) {
        // Already sent: never restore, that would send twice. Empty the claim so a sweep finds nothing.
        try { writeFileSync(claimed, ''); } catch { /* nothing more to do */ }
      } else restoreClaim(claimed, held);
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
