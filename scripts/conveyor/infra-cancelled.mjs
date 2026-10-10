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

/**
 * Knob: a job that held a runner and RAN for at least this many minutes before it was cancelled is a HUNG job (it hit
 * its own `timeout-minutes`), not an infra casualty. An outage cancels a job early or never gives it a runner; a
 * deterministic hang cancels it at the full timeout every time, so a mechanical re-run only repeats it (PR #4235:
 * `soak-shard (1)` hung on one scenario for six 15-minute attempts while the required `daemon-soak` read "pending").
 * Env `WE_CI_HUNG_JOB_MINUTES`; `0` disables (every cancelled job stays infra).
 */
export const DEFAULT_HUNG_JOB_MINUTES = 10;
export function resolveHungJobMinutes(env = process.env) {
  const raw = env.WE_CI_HUNG_JOB_MINUTES;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_HUNG_JOB_MINUTES;
}

/** Did this cancelled job run on a runner for >= the hung-job threshold? */
export function isHungJob(job, { hungMinutes = resolveHungJobMinutes() } = {}) {
  if (!job || !hungMinutes || String(job.conclusion ?? '').toLowerCase() !== 'cancelled') return false;
  if (!job.runner_name && !job.runner_id) return false;
  const start = Date.parse(job.started_at ?? ''); const end = Date.parse(job.completed_at ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end - start >= hungMinutes * 60_000;
}

const INFRA_CONCLUSIONS = Object.freeze(['cancelled', 'startup_failure']);

/**
 * Is this Actions job record (`GET /actions/jobs/<id>`) an infra casualty rather than a real result? PURE.
 * True for conclusion cancelled / startup_failure, or a completed non-success job that never got a runner and
 * ran no step (no logs can exist for it).
 */
export function isInfraCancelledJob(job, opts) {
  if (!job || String(job.status ?? 'completed').toLowerCase() !== 'completed') return false;
  // A job that ran to its own timeout is a hang (a real failure with a log), not infra: it goes to ci-heal.
  if (isHungJob(job, opts)) return false;
  const conclusion = String(job.conclusion ?? '').toLowerCase();
  if (INFRA_CONCLUSIONS.includes(conclusion)) return true;
  if (['success', 'skipped', 'neutral'].includes(conclusion)) return false;
  const noRunner = !job.runner_name && !job.runner_id;
  return noRunner && Array.isArray(job.steps) && job.steps.length === 0;
}

/** The step of the CI aggregate jobs (`.github/workflows/ci.yml`) that fails closed when a `needs` dep did not succeed. */
export const AGGREGATE_GATE_STEP = 'Gate on shard results';
/** The CI aggregate jobs that carry that gate step: `test` (over `test-shard`) and `daemon-soak` (over `soak-shard`). */
export const AGGREGATE_GATE_JOBS = Object.freeze(['test', 'daemon-soak']);

const PASSING = Object.freeze(['success', 'skipped', 'neutral']);

/**
 * Is this failed job a DERIVED aggregate gate (`test` / `daemon-soak`) — red only because a `needs` dep (a cancelled
 * shard) did not succeed — rather than a real failure that merely carries such a name? PURE. Decided STRUCTURALLY,
 * never by name alone (a job name is workflow-author controlled): the job is one of {@link AGGREGATE_GATE_JOBS} AND
 * the only step that did not pass is the gate step itself. A job whose gate step passed and a LATER step
 * (check:standards, merge coverage…) failed, or that failed any step besides the gate, is real evidence.
 * @param {{name?:string, steps?:Array<{name?:string, conclusion?:string}>}} job a `GET /actions/jobs/<id>` record
 */
export function isAggregateGateFailure(job) {
  if (!AGGREGATE_GATE_JOBS.includes(job?.name) || !Array.isArray(job.steps) || !job.steps.length) return false;
  const notPassing = job.steps.filter((s) => !PASSING.includes(String(s?.conclusion ?? '').toLowerCase()));
  return notPassing.length === 1 && notPassing[0]?.name === AGGREGATE_GATE_STEP;
}

/**
 * Classify the failed required jobs of one head. PURE.
 * @param {Array<{run:number, job:number, attempt:number, infra:boolean, aggregateGate?:boolean}>} jobs
 * @returns {{kind:'none'|'infra-only'|'mixed'|'real', runs:Array<{run:number, job:number, attempt:number}>}}
 */
export function classifyInfraCancelled(jobs) {
  const all = Array.isArray(jobs) ? jobs : [];
  // Only the DERIVED aggregate gate failure mirrors its (cancelled) `needs` and is not independent real evidence.
  const list = all.some((j) => j.infra) ? all.filter((j) => j.infra || !j.aggregateGate) : all;
  if (!list.length) return { kind: 'none', runs: [] };
  const infra = list.filter((j) => j.infra);
  if (infra.length === 0) return { kind: 'real', runs: [] };
  const byRun = new Map();
  for (const j of infra) if (!byRun.has(j.run)) byRun.set(j.run, { run: j.run, job: j.job, attempt: j.attempt });
  return { kind: infra.length === list.length ? 'infra-only' : 'mixed', runs: [...byRun.values()] };
}

/**
 * Is a whole workflow run red ONLY because of infra? PURE. True when at least one job is infra-cancelled and every
 * other non-success job is the derived aggregate gate failure ({@link isAggregateGateFailure}, which only mirrors its
 * cancelled `needs`). Used so an outage-cancelled `main` run is never counted as "main is red". A real failure in a
 * job merely NAMED `test` keeps the run red.
 * @param {Array<{name?:string, status?:string, conclusion?:string, runner_name?:string, runner_id?:number, steps?:Array}>} jobs
 */
export function isInfraCancelledOnlyRun(jobs) {
  const bad = (Array.isArray(jobs) ? jobs : []).filter((j) => !PASSING.includes(String(j?.conclusion ?? '').toLowerCase()));
  const infra = bad.filter((j) => isInfraCancelledJob(j));
  if (!infra.length) return false;
  return bad.every((j) => isInfraCancelledJob(j) || isAggregateGateFailure(j));
}

/**
 * The run GitHub's branch protection actually judges, one per check name. PURE. LIVE 2026-10-09, PR #4651: a re-run of
 * an OLDER `soak-replay-gate` run (attempt 2, green) cancelled the NEWER run through its concurrency group. GitHub held
 * the PR `BLOCKED` on the cancelled run: it reads a check from its NEWEST check suite, not from the run that finished
 * last. So: highest `check_suite.id` wins, ties broken by highest check-run `id`. A row with no suite id ranks lowest.
 * @param {Array<{id?:number, name?:string, check_suite?:{id?:number}}>} checkRuns REST `commits/<sha>/check-runs` rows
 * @returns {Array<object>} one row per distinct name
 */
export function authoritativeCheckRuns(checkRuns) {
  const best = new Map();
  const rank = (c) => [Number(c?.check_suite?.id) || 0, Number(c?.id) || 0];
  for (const c of Array.isArray(checkRuns) ? checkRuns : []) {
    const prev = best.get(c?.name);
    const [s, i] = rank(c);
    const [ps, pi] = prev ? rank(prev) : [-1, -1];
    if (!prev || s > ps || (s === ps && i > pi)) best.set(c?.name, c);
  }
  return [...best.values()];
}

/** Resolve the `ciHeal.infraCancelled` mode for a repo key. Env: `WE_CI_HEAL_INFRA_CANCELLED[_<REPOKEY>]`. PURE. */
export function resolveInfraCancelledMode(repoKey, env = process.env) {
  const suffix = String(repoKey ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const raw = String((suffix && env[`WE_CI_HEAL_INFRA_CANCELLED_${suffix}`]) ?? env.WE_CI_HEAL_INFRA_CANCELLED ?? '').toLowerCase();
  return INFRA_CANCELLED_MODES.includes(raw) ? raw : DEFAULT_INFRA_CANCELLED_MODE;
}
