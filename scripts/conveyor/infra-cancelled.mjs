/**
 * Infra-cancelled CI classifier (GitHub Actions outage 2026-10-05, 15:11-17:55 ET).
 *
 * A required check whose job was cancelled, never started (`startup_failure`), or never got a runner has NO log
 * and no step, so it carries no evidence about the PR's own code. The conveyor used to read the job log anyway,
 * the read 404'd, and the PR was refused (`timeout-retry-ineligible`) forever. This module is PURE: it only
 * classifies. Nothing here changes what counts as green or red anywhere else (`merge-ai-prs`, `pr-status`,
 * reconcile still count CANCELLED as red) — it only decides WHO re-triggers CI for a PR whose only red is infra.
 *
 * Setting `ciHeal.infraCancelled` (declared in `config/platformDefaults.ts`, mirrored here because .mjs cannot
 * import .ts; `config/__tests__` + the unit test pin the two together):
 *   `rerun` (default) — re-run the cancelled runs mechanically (`rerun-failed-jobs`), capped per head, then ci-heal.
 *   `heal`            — never re-run mechanically; always ci-heal.
 */

export const INFRA_CANCELLED_MODES = Object.freeze(['rerun', 'heal']);
export const DEFAULT_INFRA_CANCELLED_MODE = 'rerun';
/** Max confirmed re-run requests per PR head before falling back to ci-heal. */
export const DEFAULT_INFRA_CANCELLED_MAX_RERUNS = 6;

const INFRA_CONCLUSIONS = Object.freeze(['cancelled', 'startup_failure']);

/**
 * Is this Actions job record (`GET /actions/jobs/<id>`) an infra casualty rather than a real result? PURE.
 * True for conclusion cancelled / startup_failure, or a completed non-success job that never got a runner and
 * ran no step (no logs can exist for it).
 */
export function isInfraCancelledJob(job) {
  if (!job || String(job.status ?? 'completed').toLowerCase() !== 'completed') return false;
  const conclusion = String(job.conclusion ?? '').toLowerCase();
  if (INFRA_CONCLUSIONS.includes(conclusion)) return true;
  if (['success', 'skipped', 'neutral'].includes(conclusion)) return false;
  const noRunner = !job.runner_name && !job.runner_id;
  return noRunner && Array.isArray(job.steps) && job.steps.length === 0;
}

/**
 * Classify the failed required jobs of one head. PURE.
 * @param {Array<{run:number, job:number, attempt:number, infra:boolean}>} jobs
 * @returns {{kind:'none'|'infra-only'|'mixed'|'real', runs:Array<{run:number, job:number, attempt:number}>}}
 */
export function classifyInfraCancelled(jobs) {
  const all = Array.isArray(jobs) ? jobs : [];
  // The aggregate `test` job only mirrors its (cancelled) `needs`: it is not independent real evidence.
  const list = all.some((j) => j.infra) ? all.filter((j) => j.infra || j.name !== 'test') : all;
  if (!list.length) return { kind: 'none', runs: [] };
  const infra = list.filter((j) => j.infra);
  if (infra.length === 0) return { kind: 'real', runs: [] };
  const byRun = new Map();
  for (const j of infra) if (!byRun.has(j.run)) byRun.set(j.run, { run: j.run, job: j.job, attempt: j.attempt });
  return { kind: infra.length === list.length ? 'infra-only' : 'mixed', runs: [...byRun.values()] };
}

/**
 * Is a whole workflow run red ONLY because of infra? PURE. True when at least one job is infra-cancelled and every
 * other non-success job is the derived aggregate (`test`, which only mirrors its cancelled `needs`). Used so an
 * outage-cancelled `main` run is never counted as "main is red".
 * @param {Array<{name?:string, status?:string, conclusion?:string, runner_name?:string, runner_id?:number, steps?:Array}>} jobs
 */
export function isInfraCancelledOnlyRun(jobs) {
  const bad = (Array.isArray(jobs) ? jobs : []).filter((j) => !['success', 'skipped', 'neutral'].includes(String(j?.conclusion ?? '').toLowerCase()));
  const infra = bad.filter((j) => isInfraCancelledJob(j));
  if (!infra.length) return false;
  return bad.every((j) => isInfraCancelledJob(j) || j?.name === 'test');
}

/** Resolve the `ciHeal.infraCancelled` mode for a repo key. Env: `WE_CI_HEAL_INFRA_CANCELLED[_<REPOKEY>]`. PURE. */
export function resolveInfraCancelledMode(repoKey, env = process.env) {
  const suffix = String(repoKey ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const raw = String((suffix && env[`WE_CI_HEAL_INFRA_CANCELLED_${suffix}`]) ?? env.WE_CI_HEAL_INFRA_CANCELLED ?? '').toLowerCase();
  return INFRA_CANCELLED_MODES.includes(raw) ? raw : DEFAULT_INFRA_CANCELLED_MODE;
}
