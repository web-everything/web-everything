/**
 * @file scripts/lib/fix-push-policy.mjs
 * @description The fixer push policy `fix.pushBeforeGate` resolved through the policy cascade (agent-memory 151
 *   "policy cascade = team practice"; operator go 2026-10-10 ~10:05 ET).
 *
 *   `pushBeforeGate: true`  — after the fixer commits and marks its verify wait, the harness pushes that commit to
 *                             the PR branch at once (normal push, never force), so CI starts while the local gate
 *                             runs. The fix CLAIM stays held until the local gate is green for the pushed head, so
 *                             review, ci-heal, draft promotion and the drain all keep treating the PR as not ready.
 *   `pushBeforeGate: false` — today's behaviour exactly: the harness pushes only after a green local gate.
 *
 *   Cascade, lowest to highest — each layer only answers when it holds a VALID boolean:
 *     1. standard  — Ship Evermore's default, `true` (operator ruling 2026-10-10: the extra red CI runs, ~8% of
 *                    rounds, are acceptable while CI is mostly on open-source runners).
 *     2. platform  — Platform Forever team preference: `we:scripts/lib/delivery-platform-preferences.json`, key
 *                    `fix.pushBeforeGate` (the file the merge-delivery policy declares its strategies in).
 *     3. tool      — Longshore project override: the `fix.pushBeforeGate` leaf of the declared settings files
 *                    (`we:scripts/settings/*.json`, merged by settings-files.mjs).
 *     4. env       — `WE_FIX_PUSH_BEFORE_GATE` (`true|false|on|off|1|0`), an operator's one-off override.
 *
 *   `source` names the layer that set the effective value; the fix daemon logs it once per change.
 *   PURE except {@link loadFixPushPolicy} (reads the two files; never throws).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings-files.mjs';

export const FIX_PUSH_BEFORE_GATE_ENV = 'WE_FIX_PUSH_BEFORE_GATE';
/** Ship Evermore's declared default. */
export const STANDARD_FIX_PUSH_POLICY = Object.freeze({ pushBeforeGate: true });
export const FIX_PUSH_PLATFORM_PREFERENCES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'delivery-platform-preferences.json');

/** A boolean, or a recognised on/off spelling; anything else is null (the layer does not answer). Pure. */
export function parsePushBeforeGate(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(s)) return true;
  if (['false', 'off', '0', 'no'].includes(s)) return false;
  return null;
}

/**
 * Resolve the policy. Pure.
 * @param {{platform?:object|null, tool?:object|null, env?:object}} layers  `platform`/`tool` are whole files' `fix` blocks
 * @returns {{pushBeforeGate:boolean, source:'standard'|'platform'|'tool'|'env', invalid:string[]}}
 */
export function resolveFixPushPolicy({ platform = null, tool = null, env = {} } = {}) {
  let value = STANDARD_FIX_PUSH_POLICY.pushBeforeGate;
  let source = 'standard';
  const invalid = [];
  const layers = [['platform', platform?.pushBeforeGate], ['tool', tool?.pushBeforeGate], ['env', env?.[FIX_PUSH_BEFORE_GATE_ENV]]];
  for (const [name, raw] of layers) {
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = parsePushBeforeGate(raw);
    if (parsed === null) { invalid.push(`${name}.pushBeforeGate=${JSON.stringify(raw)}`); continue; }
    value = parsed;
    source = name;
  }
  return { pushBeforeGate: value, source, invalid };
}

/** One log line naming the effective value and the layer that set it. Pure. */
export function formatFixPushPolicyLine(policy) {
  const bad = policy?.invalid?.length ? `; ignored invalid ${policy.invalid.join(', ')}` : '';
  return `fix-push-policy: pushBeforeGate=${policy?.pushBeforeGate} (${policy?.source ?? 'standard'})${bad}`;
}

/** Read the platform + tool layers and resolve. Never throws. */
export function loadFixPushPolicy({ env = process.env, platformPath = FIX_PUSH_PLATFORM_PREFERENCES_PATH, readTool = () => readSettings() } = {}) {
  let platform = null;
  try { platform = JSON.parse(readFileSync(platformPath, 'utf8'))?.fix ?? null; } catch { platform = null; }
  let tool = null;
  try { tool = readTool()?.fix ?? null; } catch { tool = null; }
  return resolveFixPushPolicy({ platform, tool, env });
}

// ── fix.selfReviewParallel (card xloi1c0; operator go 2026-10-10 ~11:40 ET) ─────────────────────────────────────
// `selfReviewParallel: true`  — the fixer commits, requests verify and marks FIRST, then runs its step-5 self-review
//                              concurrently with the verify gate (and the push-before-gate early push). A must-fix is a
//                              new commit pushed under the same claim. The harness withholds the green resume, and
//                              `fix-end` refuses a hand-back release, until verify is green AND the self-review returned.
// `selfReviewParallel: false` — today's flow: the self-review runs to completion BEFORE the commit / verify request.
// Same four layers and the same file locations as `pushBeforeGate` above; only the key and the env name differ.

export const FIX_SELF_REVIEW_PARALLEL_ENV = 'WE_FIX_SELF_REVIEW_PARALLEL';
/** Ship Evermore's declared default (the study: 2.0 min median blocked wait in 65% of fix rounds). */
export const STANDARD_SELF_REVIEW_POLICY = Object.freeze({ selfReviewParallel: true });

/**
 * Resolve `fix.selfReviewParallel`. Pure.
 * @returns {{selfReviewParallel:boolean, source:'standard'|'platform'|'tool'|'env', invalid:string[]}}
 */
export function resolveSelfReviewPolicy({ platform = null, tool = null, env = {} } = {}) {
  let value = STANDARD_SELF_REVIEW_POLICY.selfReviewParallel;
  let source = 'standard';
  const invalid = [];
  const layers = [['platform', platform?.selfReviewParallel], ['tool', tool?.selfReviewParallel], ['env', env?.[FIX_SELF_REVIEW_PARALLEL_ENV]]];
  for (const [name, raw] of layers) {
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = parsePushBeforeGate(raw);
    if (parsed === null) { invalid.push(`${name}.selfReviewParallel=${JSON.stringify(raw)}`); continue; }
    value = parsed;
    source = name;
  }
  return { selfReviewParallel: value, source, invalid };
}

/** One log line naming the effective value and the layer that set it. Pure. */
export function formatSelfReviewPolicyLine(policy) {
  const bad = policy?.invalid?.length ? `; ignored invalid ${policy.invalid.join(', ')}` : '';
  return `fix-self-review-policy: selfReviewParallel=${policy?.selfReviewParallel} (${policy?.source ?? 'standard'})${bad}`;
}

/** Read the platform + tool layers and resolve `fix.selfReviewParallel`. Never throws. */
export function loadSelfReviewPolicy({ env = process.env, platformPath = FIX_PUSH_PLATFORM_PREFERENCES_PATH, readTool = () => readSettings() } = {}) {
  let platform = null;
  try { platform = JSON.parse(readFileSync(platformPath, 'utf8'))?.fix ?? null; } catch { platform = null; }
  let tool = null;
  try { tool = readTool()?.fix ?? null; } catch { tool = null; }
  return resolveSelfReviewPolicy({ platform, tool, env });
}
