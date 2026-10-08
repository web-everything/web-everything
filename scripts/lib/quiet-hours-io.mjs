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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/**
 * Send the ONE held-alerts digest if quiet hours are over and something is held. The held file is renamed away
 * before reading, so two concurrent flushers cannot both send it. Returns what happened; never throws.
 */
export function flushDigest({ send, env = process.env, now = Date.now(), dryRun = false } = {}) {
  try {
    if (bypassed(env)) return { flushed: false, reason: 'bypassed' };
    const { settings, state } = quietContext({ env, now });
    if (state.quiet) return { flushed: false, reason: `still quiet (${state.reason})` };
    const { dir, held } = digestPaths(settings, { env });
    if (!existsSync(held)) return { flushed: false, reason: 'nothing held' };
    if (dryRun) return { flushed: false, reason: 'dry run' };
    const claimed = `${held}.flushing-${process.pid}-${now}`;
    try { renameSync(held, claimed); } catch { return { flushed: false, reason: 'another flusher claimed it' }; }
    const entries = [];
    for (const line of readFileSync(claimed, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* torn line — skip */ }
    }
    const plan = planDigest(entries, settings);
    if (!plan) { unlinkSync(claimed); return { flushed: false, reason: 'digest empty or disabled' }; }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const mdPath = join(dir, `digest-${stamp}.md`);
    writeFileSync(mdPath, plan.markdown);
    writeFileSync(join(dir, 'latest-digest.md'), plan.markdown);
    const sent = send ? send({ title: plan.title, body: plan.body }) : { ok: false, error: 'no sender' };
    if (sent?.ok === false) {
      // Delivery failed: put the entries back so the next flush retries.
      appendFileSync(held, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    unlinkSync(claimed);
    return { flushed: sent?.ok !== false, count: entries.length, mdPath, sent };
  } catch (e) {
    return { flushed: false, reason: `flush error: ${String(e?.message ?? e)}` };
  }
}

/**
 * The gate every desktop notification goes through. `send(notification)` does the real delivery and returns
 * `{ok}`. Returns the send result, or `{ok:true, suppressed:true, reason}` when held for the digest.
 */
export function gateAlert(notification, { send, env = process.env, now = Date.now() } = {}) {
  if (bypassed(env)) return send(notification);
  let decision;
  try {
    flushDigest({ send, env, now });
    const { settings, toggle } = quietContext({ env, now });
    decision = decideDelivery(notification, { now, settings, toggle });
    if (!decision.deliver) {
      const { dir, held } = digestPaths(settings, { env });
      mkdirSync(dir, { recursive: true });
      appendFileSync(held, JSON.stringify({ at: new Date(now).toISOString(), title: String(notification?.title ?? ''), body: String(notification?.body ?? ''), reason: decision.reason }) + '\n');
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
