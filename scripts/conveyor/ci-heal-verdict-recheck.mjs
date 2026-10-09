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
 * `review-gate` whose LATEST run on this head completed failing contradicts it. Two uses:
 *   - {@link contradictingChecks}: the daemon voids a contradicted verdict (a void comment, see
 *     `ci-heal-escalation-mark.mjs#CI_HEAL_VERDICT_VOID_MARKER`); the ordinary ci-heal path (caps included) resumes.
 *   - {@link unsettledRequiredChecks}: the escalation CLI refuses to record `not-a-ci-break` while a required check is
 *     still pending, missing, or red — the verdict can only be true once they have all finished green.
 *
 * Reuses the repo's own readers: `collapseRollupToLatestPerName` (latest run per check name), the shared
 * `FAILING_CONCLUSIONS` table, and `withoutImpliedRequiredChecks` (a required `integration` implied by `test`).
 * Declared setting `ci-heal-verdict-settings.json` (env `WE_CI_HEAL_RECHECK_NOT_CI_BREAK` beats the file);
 * missing, malformed or `off` = the behaviour before this card. PURE apart from the settings file read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';
import { withoutImpliedRequiredChecks } from '../lib/required-check-implication.mjs';
import { FAILING_CONCLUSIONS } from '../operations/pr-status.mjs';

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
export function resolveCiHealVerdictSettings(env = process.env, { path = ciHealVerdictSettingsPath(), read = readFileSync } = {}) {
  let file = {};
  try { file = JSON.parse(read(path, 'utf8'))?.ciHealVerdict ?? {}; } catch { file = {}; }
  return { recheckNotCiBreak: parseSwitch(env?.[CI_HEAL_VERDICT_ENV]) ?? parseSwitch(file.recheckNotCiBreak) ?? false };
}

const sameSha = (a, b) => {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * The required checks (minus `review-gate`) on this head, split by their LATEST run. PURE.
 * An empty/unknown required set returns nothing at all: with no list to judge against, nothing is claimed.
 * @returns {{red: string[], pending: string[], missing: string[], green: string[]}}
 */
export function requiredCheckStates({ rollup, requiredChecks }) {
  const out = { red: [], pending: [], missing: [], green: [] };
  const latest = collapseRollupToLatestPerName(rollup);
  const required = withoutImpliedRequiredChecks(Array.isArray(requiredChecks) ? requiredChecks : [], latest)
    .filter((name) => name !== REVIEW_GATE_CHECK);
  for (const name of required) {
    const run = latest.find((r) => (r?.name ?? r?.context) === name);
    if (!run) { out.missing.push(name); continue; }
    // A CheckRun carries status + conclusion; a legacy StatusContext carries only `state`.
    const isRun = run.status != null;
    if (isRun && String(run.status).toLowerCase() !== 'completed') { out.pending.push(name); continue; }
    const conclusion = String((isRun ? run.conclusion : run.state) ?? '').toLowerCase();
    if (FAILING_CONCLUSIONS.includes(conclusion) || conclusion === 'error') out.red.push(name);
    else if (conclusion === 'success') out.green.push(name);
    else if (conclusion === 'pending' || conclusion === 'expected') out.pending.push(name);
    else out.green.push(name); // skipped/neutral: not red, and not what a not-a-ci-break verdict is about
  }
  return out;
}

/**
 * The required checks that contradict a `not-a-ci-break` verdict on THIS head: names whose latest run completed
 * failing. `[]` when the escalation is not `not-a-ci-break`, names another head, or nothing is red. PURE.
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
