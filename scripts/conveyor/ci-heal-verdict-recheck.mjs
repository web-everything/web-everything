/**
 * @file scripts/conveyor/ci-heal-verdict-recheck.mjs — card x9zznl9. Is a `not-a-ci-break` ci-heal verdict still true?
 *
 * Live 2026-10-09, PR #4535 (head 8443f3b68): ci-heal ran while CI was still running and recorded
 * `outcome: not-a-ci-break` at 02:29:18Z ("no required check is red (passing or still running)"). At 02:29:43Z the
 * required `test` check completed FAILED. `ci-heal-escalation-mark.mjs#latestCiHealEscalationForHead` is head-scoped,
 * so with no new push the stale verdict made `reconcile-core.mjs` refuse every heal on that head (`ci-heal-escalated`)
 * for hours, and the notes half told the operator it "needs your decision".
 *
 * `not-a-ci-break` means "every required check is green; only the review gate is red". A required check other than
 * `review-gate` with any failing row on this head contradicts it. Two uses:
 *   - {@link contradictingChecks}: the daemon voids a contradicted verdict (a void comment, see
 *     `ci-heal-escalation-mark.mjs#CI_HEAL_VERDICT_VOID_MARKER`); the ordinary ci-heal path (caps included) resumes.
 *   - {@link unsettledRequiredChecks}: the escalation CLI refuses to record `not-a-ci-break` while a required check is
 *     still pending, missing, or red — the verdict can only be true once they have all finished green.
 *
 * Reuses the shared check-state predicate, and `withoutImpliedRequiredChecks` (a required `integration` implied by `test`).
 * Declared setting `ci-heal-verdict-settings.json` (env `WE_CI_HEAL_RECHECK_NOT_CI_BREAK` beats the file);
 * missing, malformed or `off` = the behaviour before this card. PURE apart from the settings file read.
 */
import { PLATFORM_PREFERENCES_PATH } from '../lib/merge-delivery-policy.mjs';
import { resolveHumanGateRemovalSetting } from '../lib/merge-gate-hold-class.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutImpliedRequiredChecks } from '../lib/required-check-implication.mjs';
import { classifyCheck, summarize } from '../lib/check-state-predicate.mjs';
import { CODEQL_CHECK_NAME } from '../lib/codeql-gate.mjs';

export const CI_HEAL_VERDICT_ENV = 'WE_CI_HEAL_RECHECK_NOT_CI_BREAK';
export const ciHealVerdictSettingsPath = () => join(dirname(fileURLToPath(import.meta.url)), 'ci-heal-verdict-settings.json');

/** The check a `not-a-ci-break` verdict is ABOUT: it is allowed to be red. */
export const REVIEW_GATE_CHECK = 'review-gate';

const parseSwitch = (raw) => {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(on|true|1|yes)$/.test(s)) return true;
  if (/^(off|false|0|no)$/.test(s)) return false;
  return null;
};

/** `{ recheckNotCiBreak }` in force. Env beats the file; missing or malformed = off (today). */
export function resolveCiHealVerdictSettings(env = process.env, options = {}) {
  const { path = ciHealVerdictSettingsPath(), read = readFileSync } = options;
  let file = {};
  try { file = JSON.parse(read(path, 'utf8'))?.ciHealVerdict ?? {}; } catch { file = {}; }
  const resolved = resolveVoidNeedsHumanWhenCiGreen(env, options);
  return {
    recheckNotCiBreak: parseSwitch(env?.[CI_HEAL_VERDICT_ENV]) ?? parseSwitch(file.recheckNotCiBreak) ?? false,
    voidNeedsHumanWhenCiGreen: resolved.value, voidNeedsHumanSource: resolved.source,
    voidNeedsHumanIgnored: resolved.ignored,
  };
}

/** Standard → platform preferences → repo → env. Any invalid layer disables retirement. */
export function resolveVoidNeedsHumanWhenCiGreen(env = process.env, {
  path = ciHealVerdictSettingsPath(), platformPath = PLATFORM_PREFERENCES_PATH, read = readFileSync,
} = {}) {
  const documents = {}, errors = [];
  for (const [layer, filePath] of [['platform', platformPath], ['repo', path]]) {
    try { documents[layer] = JSON.parse(read(filePath, 'utf8')); }
    catch (error) {
      // Only the optional platform file may be absent. A missing declared repo file is an error.
      if (layer !== 'platform' || error?.code !== 'ENOENT') errors.push({ source: layer, reason: String(error?.message ?? error).split('\n')[0] });
    }
  }
  const result = resolveHumanGateRemovalSetting({ ...documents, env, errors,
    blockName: 'ciHealVerdict', key: 'voidNeedsHumanWhenCiGreen', envKey: 'WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN' });
  return { value: result.value === 'on', source: result.source, ignored: result.ignored };
}

/** No known required set means no evidence that CI is green. Pure. */
export function ciGreenForEscalation({ rollup, requiredChecks }) {
  if (!Array.isArray(requiredChecks) || !requiredChecks.length) return false;
  const { red, pending, missing } = requiredCheckStates({ rollup, requiredChecks });
  return !red.length && !pending.length && !missing.length;
}

export const sameSha = (a, b) => {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

const gateNames = [REVIEW_GATE_CHECK, 'merge-gate'];
const lowerState = state => String(state ?? '').toLowerCase();
const normalizeRollupCheck = row => {
  const check = { ...row, name: row?.name || row?.context };
  if (row?.status == null && row?.state != null) {
    if (['pending', 'expected'].includes(lowerState(row.state))) check.status = 'pending';
    else check.conclusion = row.state;
  }
  return check;
};

/** Compatibility export: preserve every rollup row; metadata never selects evidence. */
export function latestRollupAttempts(rollup) {
  return Array.isArray(rollup) ? [...rollup] : [];
}

/** Adapt GraphQL rollups and legacy statuses without replacing the shared state policy. */
function checkEvidence(rollup, requiredChecks) {
  const checks = (Array.isArray(rollup) ? rollup : []).map(normalizeRollupCheck);
  // Only the shared merge-gate hold classifier's annotation proves a review hold.
  // A job/setup failure (or unreadable verdict) must remain ordinary CI evidence.
  const holdGateNames = [REVIEW_GATE_CHECK];
  const mergeGates = checks.filter(row => row.name === 'merge-gate');
  if (mergeGates.length && mergeGates.every(row =>
    classifyCheck({ ...row, required: true }) === 'green' || row.mergeGateReviewHold)) {
    holdGateNames.push('merge-gate');
  }
  const roster = withoutImpliedRequiredChecks(Array.isArray(requiredChecks) ? requiredChecks : [], checks)
    .filter(name => !holdGateNames.includes(name));
  // CodeQL evidence is never excused by a drain setting or an optional roster.
  if (checks.some(row => row.name === CODEQL_CHECK_NAME) && !roster.includes(CODEQL_CHECK_NAME)) {
    roster.push(CODEQL_CHECK_NAME);
  }
  return { checks, roster, holdGateNames };
}

/**
 * The required checks (minus review-gate and proven merge-gate review holds), judged across every row. PURE.
 * An empty/unknown required set judges only observed CodeQL evidence.
 * @returns {{red: string[], pending: string[], missing: string[], green: string[]}}
 */
export function requiredCheckStates({ rollup, requiredChecks }) {
  const out = { red: [], pending: [], missing: [], green: [] };
  const { checks, roster } = checkEvidence(rollup, requiredChecks);
  const { redSet, pendingSet } = summarize(checks, { requiredNames: roster });
  const observed = new Set(checks.map(row => row.name));
  for (const name of roster) {
    if (!observed.has(name)) out.missing.push(name);
    else if (redSet.has(name)) out.red.push(name);
    else if (pendingSet.has(name)) out.pending.push(name);
    else out.green.push(name);
  }
  return out;
}

/** Include gates and CodeQL evidence, even outside the required roster. */
export function gateOnlyRedStates({ rollup, requiredChecks }) {
  const { checks, roster, holdGateNames } = checkEvidence(rollup, requiredChecks);
  const requiredNames = [...roster, ...gateNames];
  const { gateOnlyRed, redSet } = summarize(checks, { requiredNames, holdGateNames });
  return { gateOnlyRed, red: [...redSet] };
}

/**
 * The required checks that contradict a `not-a-ci-break` verdict on THIS head: names with any failing row. `[]` when the escalation is not `not-a-ci-break`, names another head, or nothing is red. PURE.
 * @param {{escalation:{outcome?:string, headSha?:string}|null, headSha:string, rollup:Array<object>, requiredChecks:string[]}} o
 * @returns {string[]}
 */
export function contradictingChecks({ escalation, headSha, rollup, requiredChecks }) {
  if (escalation?.outcome !== 'not-a-ci-break' || !sameSha(escalation.headSha, headSha)) return [];
  return requiredCheckStates({ rollup, requiredChecks }).red;
}

/** {@link contradictingChecks} as a yes/no. PURE. */
export function notCiBreakContradicted(o) {
  return contradictingChecks(o).length > 0;
}

/**
 * Prevention at the source: the required checks (minus `review-gate`) that keep a `not-a-ci-break` verdict from being
 * recordable yet — still running, not started, or red. `[]` means they all finished green. PURE.
 * @returns {{pending: string[], missing: string[], red: string[]}}
 */
export function unsettledRequiredChecks({ rollup, requiredChecks }) {
  const s = requiredCheckStates({ rollup, requiredChecks });
  return { pending: s.pending, missing: s.missing, red: s.red };
}
