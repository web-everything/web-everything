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
 * Reuses the shared required-check evidence contract, including head-bound integration implication.
 * Declared setting `ci-heal-verdict-settings.json` (env `WE_CI_HEAL_RECHECK_NOT_CI_BREAK` beats the file);
 * missing, malformed or `off` = the behaviour before this card. PURE apart from the settings file read.
 */
import { PLATFORM_PREFERENCES_PATH } from '../lib/merge-delivery-policy.mjs';
import { resolveHumanGateRemovalSetting } from '../lib/merge-gate-hold-class.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRequiredChecks } from '../lib/check-state-predicate.mjs';
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
export function ciGreenForEscalation(options) {
  const { requiredChecks } = options;
  if (!Array.isArray(requiredChecks) || !requiredChecks.length) return false;
  return ['pass', 'held'].includes(checkEvidence(options).state);
}

export const sameSha = (a, b) => {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

const gateNames = [REVIEW_GATE_CHECK, 'merge-gate'];
/** Compatibility export: preserve every rollup row; metadata never selects evidence. */
export function latestRollupAttempts(rollup) {
  return Array.isArray(rollup) ? [...rollup] : [];
}

/** Bind rollup evidence to its read head; never infer a head or roster from rows. */
function checkEvidence({ rollup, requiredChecks, headSha, rowsHead = headSha, rowsComplete = false, rosterSource = 'live', holds }) {
  const rows = Array.isArray(rollup) ? rollup : [];
  const roster = Array.isArray(requiredChecks) ? [...requiredChecks] : [];
  // Observed CodeQL and review gates participate even outside branch protection.
  for (const name of [...gateNames, CODEQL_CHECK_NAME]) {
    if (rows.some(row => (row?.name ?? row?.context) === name) && !roster.includes(name)) roster.push(name);
  }
  // A capped rollup can hide failures even when every required name is present.
  return resolveRequiredChecks({ rows: rollup, rowsHead, rowsComplete, head: headSha, requiredNames: roster,
    rosterSource: Array.isArray(requiredChecks) && requiredChecks.length ? rosterSource : 'unavailable', holds });
}

/** Required CI blockers; held evidence is review work, never a passing check. */
export function requiredCheckStates(options) {
  const result = checkEvidence(options), out = { red: [], pending: [], missing: [], green: [] };
  for (const name of new Set([...(Array.isArray(options.requiredChecks) ? options.requiredChecks : []), ...Object.keys(result.perName)])) {
    const r = result.perName[name];
    if (!r) continue;
    if (r.state === 'held') continue;
    // Gates outside the roster contribute failures, but their pending state is review work.
    if (gateNames.includes(name) && !options.requiredChecks?.includes(name) && r.state === 'pending') continue;
    out[r.state === 'pass' ? 'green' : r.state === 'unknown' || r.reasons.includes('missing') ? 'missing'
      : r.state === 'pending' ? 'pending' : 'red'].push(name);
  }
  // Unknown evidence blocks admission without inventing a failed check.
  if (result.state === 'unknown') out.missing.push('check-evidence');
  return out;
}

/** Only a fully resolved review hold prevents CI-heal escalation. */
export function gateOnlyRedStates(options) {
  const result = checkEvidence(options);
  const red = Object.entries(result.perName).filter(([, r]) => ['held', 'fail'].includes(r.state)).map(([name]) => name);
  return { gateOnlyRed: result.state === 'held', red, waitingOnReview: result.state === 'held' };
}

/**
 * The required checks that contradict a `not-a-ci-break` verdict on THIS head: names with any failing row. `[]` when the escalation is not `not-a-ci-break`, names another head, or nothing is red. PURE.
 * @param {{escalation:{outcome?:string, headSha?:string}|null, headSha:string, rollup:Array<object>, requiredChecks:string[]}} o
 * @returns {string[]}
 */
export function contradictingChecks({ escalation, headSha, rollup, requiredChecks, rowsComplete = false }) {
  if (escalation?.outcome !== 'not-a-ci-break' || !sameSha(escalation.headSha, headSha)) return [];
  const result = checkEvidence({ rollup, requiredChecks, headSha, rowsComplete });
  // An incomplete snapshot can still contain an observed failure, but absence
  // of proof (including malformed or foreign-head rows) never voids a verdict.
  return Object.entries(result.perName).filter(([, r]) => r.state === 'fail').map(([name]) => name);
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
export function unsettledRequiredChecks(options) {
  const s = requiredCheckStates(options);
  return { pending: s.pending, missing: s.missing, red: s.red };
}
