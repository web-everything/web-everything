/**
 * @file scripts/lib/red-main-hold.mjs
 * @description The "contain" third of the red-main safety net (detect → own → CONTAIN). While main's CI is red, the
 *   drain lands ONLY the P0 main-fix PR(s); every other PR of the local repo is held with skip reason
 *   `red-main-hold`. Without this, PRs kept landing on a red main and pushed the fix PR into merge conflict
 *   (2026-10-08 #4532, 2026-10-09 #4617).
 *
 *   Signal (any one is enough):
 *     - the safety net's published `main-ci-red-state.json` (health watch, card xu1nixv; removed when main is green,
 *       expires on its own TTL) — so the hold LIFTS AUTOMATICALLY when main's CI is green again;
 *     - the safety net's published `main-red-priority.json` (implies red);
 *     - the manual stop-the-line marker (red-main-remediation.mjs freeze), which stays until `unfreeze`.
 *   Fix PRs = the priority record's `prs` — the SAME recognition #4527 uses (`main-ci-red-core.mjs#findOwnerPrs`),
 *   read from its published output, never re-derived here.
 *
 *   It only ADDS a hold: an allowed fix PR still passes every merge gate the drain applies. PURE except
 *   {@link resolveRedMainHoldSetting} (reads the settings file).
 *
 *   Setting `redMainHold` (`on` | `off`, built-in `on`), policy cascade (card x5wnfcg, we:scripts/lib/policy-cascade.mjs):
 *   standard default (built-in `on`) → platform preference `redMainHold` → tool override
 *   (`we:scripts/settings/red-main-hold.json`) → env `WE_DRAIN_RED_MAIN_HOLD`. `off` = before this card (a manual freeze stops the whole line; a published red
 *   alone holds nothing).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from './policy-cascade.mjs';

export const RED_MAIN_HOLD_REASON = 'red-main-hold';
export const RED_MAIN_HOLD_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'red-main-hold.json');

const norm = (v) => { const x = String(v ?? '').trim().toLowerCase(); return x === 'on' || x === 'off' ? x : null; };

/** env `WE_DRAIN_RED_MAIN_HOLD` > settings file `redMainHold` > built-in `on`. Unknown values fall through. */
export function resolveRedMainHoldSetting({ env = process.env, file = RED_MAIN_HOLD_SETTINGS_FILE } = {}) {
  return resolveScalar('redMainHold', norm, 'on', env?.WE_DRAIN_RED_MAIN_HOLD, { env, file });
}

/** One scalar through the shared policy cascade (we:scripts/lib/policy-cascade.mjs): built-in → platform preference
 *  `<key>` → settings file `<key>` → env. Same `{value, source}` shape as before (`settings` = the tool file layer,
 *  `platform` = the team preference); logs the source once per process. */
function resolveScalar(key, normalize, builtIn, envRaw, { env, file }) {
  let tool;
  try { tool = JSON.parse(readFileSync(file, 'utf8'))?.[key]; } catch { /* built-in */ }
  const fromEnv = normalize(envRaw);
  const c = cascadePolicy(key, tool, { env, standard: builtIn, envValues: { '': fromEnv ?? undefined }, valid: (v) => normalize(v) !== null });
  if (fromEnv) return { value: fromEnv, source: 'env' };
  const layer = c.sources[''];
  if (layer === 'tool') return { value: normalize(c.value), source: 'settings' };
  if (layer === 'platform') return { value: normalize(c.value), source: 'platform' };
  return { value: builtIn, source: 'default' };
}

/**
 * Containment mode while main is red (card x5wnfcg cascade): `stop` (built-in; only the main-fix PR lands) or
 * `quarantine` (we:scripts/lib/red-main-quarantine.mjs — known failing tests skipped, others keep landing; OFF until
 * its red-team review). env `WE_DRAIN_RED_MAIN_MODE` > settings `redMainMode` > `stop`.
 */
export function resolveRedMainMode({ env = process.env, file = RED_MAIN_HOLD_SETTINGS_FILE } = {}) {
  const m = (v) => { const x = String(v ?? '').trim().toLowerCase(); return x === 'stop' || x === 'quarantine' ? x : null; };
  return resolveScalar('redMainMode', m, 'stop', env?.WE_DRAIN_RED_MAIN_MODE, { env, file });
}

const live = (r, now) => !!r && Number.isFinite(r.expiresAt) && now < r.expiresAt;

/**
 * Is main red right now, and which PRs own the fix? PURE.
 * @param {{mainRedState?:object|null, priority?:object|null, manualFreeze?:object|null, now:number, repo?:string}} o
 * @returns {{red:boolean, sources:string[], fixPrs:number[], firstRedSha:string|null, since:number|null}}
 */
export function redMainSignal({ mainRedState = null, priority = null, manualFreeze = null, now, repo = 'we' } = {}) {
  const sources = [];
  if (mainRedState && mainRedState.red === true && live(mainRedState, now)) sources.push('published');
  const pri = priority && live(priority, now) && (priority.repo ?? repo) === repo && Number.isInteger(priority.pr) ? priority : null;
  if (pri && !sources.length) sources.push('priority');
  if (manualFreeze) sources.push('manual');
  const fixPrs = pri ? [...new Set((Array.isArray(pri.prs) ? pri.prs : [pri.pr]).map(Number).filter(Number.isInteger))] : [];
  return {
    red: sources.length > 0,
    sources,
    fixPrs,
    firstRedSha: mainRedState?.firstRedSha ?? pri?.firstRedSha ?? manualFreeze?.mergeSha ?? null,
    since: Number.isFinite(mainRedState?.since) ? mainRedState.since : null,
  };
}

/** The stable (pass-to-pass identical) hold reason, so the drain's "reason changed" comment fires once. PURE. */
export function redMainHoldReason(signal) {
  const since = Number.isFinite(signal.since) ? ` since ${new Date(signal.since).toISOString()}` : '';
  const sha = signal.firstRedSha ? ` (first red ${String(signal.firstRedSha).slice(0, 9)})` : '';
  const fix = signal.fixPrs.length ? `only the main-fix PR ${signal.fixPrs.map((n) => `#${n}`).join(', ')} lands` : 'nothing lands (no main-fix PR published yet)';
  return `${RED_MAIN_HOLD_REASON}: main is red${since}${sha} [${signal.sources.join('+')}] — ${fix} until main is green`;
}

/**
 * Per-PR decision. PURE. A PUBLISHED red holds only local-repo PRs (a red WE main does not block another repo's
 * main; a couple's impl half defers through the existing couple join when its WE carrier is held). A MANUAL freeze
 * is the operator's stop-the-line, so it holds EVERY repo's PRs (as it did before the hold existed). The fix-PR
 * exemption is for the local repo only: the published fix PR numbers are WE numbers, never another repo's.
 * @returns {{hold:boolean, reason?:string, fix?:boolean}}
 */
export function decideRedMainHold({ num, isLocal = true, signal, setting = 'on' }) {
  if (setting !== 'on' || !signal?.red) return { hold: false };
  if (!isLocal && !signal.sources?.includes('manual')) return { hold: false };
  if (isLocal && signal.fixPrs.includes(Number(num))) return { hold: false, fix: true };
  return { hold: true, reason: redMainHoldReason(signal) };
}

/**
 * Replay helper: the decision for every PR in a drain window. PURE.
 * @param {Array<{num:number, at:number, isLocal?:boolean}>} prs  each PR's would-be land time
 * @param {(at:number)=>object} signalAt  the red signal at that time
 */
export function replayRedMainHold(prs, signalAt, { setting = 'on' } = {}) {
  return prs.map((p) => ({ num: p.num, ...decideRedMainHold({ num: p.num, isLocal: p.isLocal !== false, signal: signalAt(p.at), setting }) }));
}
