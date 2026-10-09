/**
 * @file scripts/lib/cost-admission.mjs
 * @description Card x60i0ie — COST-CLASS ADMISSION: the one pure rule every dispatching daemon shares for "may this
 *   job START now", split by what the job costs the Mac.
 *
 *   The Mac is the limit, not the model budget (2026-10-08: 12 cores, load 21–31, CPU idle at fix launch p50 41%,
 *   min 5%; heavy test slots mostly free). Jobs fall in two classes:
 *   - HEAVY — runs tests or builds locally (build, fix, ci-heal, investigate, a review that runs tools). Heavy work
 *     keeps every cap and CPU guard it has today. This rule never loosens a heavy gate.
 *   - LIGHT — talks to a model and edits a card, no local test run (the prepare family, task-agreement refresh,
 *     design/prep passes, tool-free review jurors, coroner samples). Light work is admitted whenever the token
 *     budget allows, even when the heavy caps are full, under its OWN cap and a gentle CPU floor.
 *
 *   PURE: plain facts in, a decision out. No clock, no fs, no host read (the IO half is `cost-admission-facts.mjs`).
 *
 *   SETTINGS (declared; env wins, then `we:scripts/dispatch-settings.json#costAdmission`, then the built-in):
 *   - mode                      (env WE_COST_ADMISSION)              `off` | `on`. Built-in `off` = TODAY'S BEHAVIOUR:
 *                                                                    every caller keeps its existing gates unchanged.
 *   - lightMaxConcurrent        (env WE_LIGHT_MAX_CONCURRENT)        light jobs in flight at once (default 6).
 *   - lightCpuIdleMinPct        (env WE_MIN_CPU_IDLE_PCT_LIGHT)      the gentle CPU floor for a light launch (default 5).
 *   - claudeDailyUsdBudget      (env WE_CLAUDE_DAILY_USD_BUDGET)     Claude spend (USD, ET day, from the OTel
 *                                                                    collector) after which light work stops.
 *                                                                    `off`/unset = no budget limit.
 *   - lightOpenPrFreeze         (env WE_LIGHT_OPEN_PR_FREEZE)        `skip` (default) | `honour` — whether the build
 *                                                                    daemon's open-PR-count landing freeze also holds
 *                                                                    light work. The kill switch and the global freeze
 *                                                                    label ALWAYS hold light work.
 */

/** Job kind → hardware cost class. An unknown kind is HEAVY: the safe default never loosens a gate. */
export const JOB_COST_CLASS = Object.freeze({
  build: 'heavy',
  fix: 'heavy',
  'ci-heal': 'heavy',
  investigate: 'heavy', // an investigator may reproduce a bug by running tests
  'health-investigate': 'heavy',
  review: 'heavy', // a review job may run tools; only the tool-free juror seat is light
  prepare: 'light',
  'prepare-scope': 'light',
  'prepare-decision': 'light',
  'prepare-item': 'light', // card-only diff: verify-lane skips the local gate (`card-only-skip`)
  'task-agreement': 'light',
  design: 'light',
  'prep-pass': 'light',
  'review-juror': 'light',
  'coroner-sample': 'light',
});

export const COST_CLASSES = Object.freeze(['heavy', 'light']);

/** @returns {'heavy'|'light'} */
export function jobCostClass(kind) {
  return Object.hasOwn(JOB_COST_CLASS, kind) ? JOB_COST_CLASS[kind] : 'heavy';
}

export const COST_ADMISSION_BUILT_IN = Object.freeze({
  mode: 'off',
  lightMaxConcurrent: 6,
  lightCpuIdleMinPct: 5,
  claudeDailyUsdBudget: null,
  lightOpenPrFreeze: 'skip',
});

export const COST_ADMISSION_ENV = Object.freeze({
  mode: 'WE_COST_ADMISSION',
  lightMaxConcurrent: 'WE_LIGHT_MAX_CONCURRENT',
  lightCpuIdleMinPct: 'WE_MIN_CPU_IDLE_PCT_LIGHT',
  claudeDailyUsdBudget: 'WE_CLAUDE_DAILY_USD_BUDGET',
  lightOpenPrFreeze: 'WE_LIGHT_OPEN_PR_FREEZE',
});

const VALIDATE = {
  mode: (v) => (['on', 'off'].includes(String(v).trim().toLowerCase()) ? String(v).trim().toLowerCase() : undefined),
  lightMaxConcurrent: (v) => { const n = Number(v); return String(v).trim() !== '' && Number.isInteger(n) && n >= 0 ? n : undefined; },
  lightCpuIdleMinPct: (v) => { const n = Number(v); return String(v).trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined; },
  claudeDailyUsdBudget: (v) => {
    if (v === null || /^off$/i.test(String(v).trim())) return null;
    const n = Number(v);
    return String(v).trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
  },
  lightOpenPrFreeze: (v) => (['skip', 'honour'].includes(String(v).trim().toLowerCase()) ? String(v).trim().toLowerCase() : undefined),
};

/**
 * Resolve every setting: a valid env value wins, then a valid `file.costAdmission.<key>`, then the built-in. An
 * invalid value falls to the next source, never to `on`. Pure (the caller reads the file). Never throws.
 * @param {{env?:object, file?:object|null}} [o]
 */
export function resolveCostAdmissionSettings({ env = {}, file = null } = {}) {
  const block = file && typeof file === 'object' && file.costAdmission && typeof file.costAdmission === 'object' ? file.costAdmission : {};
  const out = {};
  for (const key of Object.keys(COST_ADMISSION_BUILT_IN)) {
    const e = env?.[COST_ADMISSION_ENV[key]];
    const fromEnv = e === undefined || e === '' ? undefined : VALIDATE[key](e);
    const fromFile = Object.hasOwn(block, key) ? VALIDATE[key](block[key]) : undefined;
    out[key] = fromEnv !== undefined ? fromEnv : fromFile !== undefined ? fromFile : COST_ADMISSION_BUILT_IN[key];
  }
  return Object.freeze(out);
}

/** Is the light rule live? (`off` = every caller runs today's gates, unchanged.) */
export const costAdmissionOn = (settings) => settings?.mode === 'on';

/** Does `kind` run under the LIGHT rule this tick? Only when the mode is on AND the kind is light. */
export function usesLightRule(kind, settings) {
  return costAdmissionOn(settings) && jobCostClass(kind) === 'light';
}

/** The concurrency cap for a light kind: the light cap when the rule is on, else the caller's legacy cap. */
export function lightCapFor(kind, settings, legacyCap) {
  return usesLightRule(kind, settings) ? settings.lightMaxConcurrent : legacyCap;
}

/**
 * Does a landing freeze hold a launch of `kind`? `freezeKinds` names WHY the queue is frozen (`kill-switch`,
 * `open-prs`, `label` — `build-dispatch-policy.mjs#planBuildDispatch`). A light job skips ONLY an open-PR-count
 * freeze, and only when `lightOpenPrFreeze` is `skip`; a kill switch or a freeze label holds everything.
 * @param {{frozen:boolean, kinds?:string[]}} freeze
 */
export function freezeHolds(kind, freeze, settings) {
  if (!freeze?.frozen) return false;
  if (!usesLightRule(kind, settings) || settings.lightOpenPrFreeze !== 'skip') return true;
  const kinds = Array.isArray(freeze.kinds) ? freeze.kinds : null;
  // No reason list (an older policy shape) is not proof the freeze is open-PR-only: hold, like today.
  if (!kinds || kinds.length === 0) return true;
  return kinds.some((k) => k !== 'open-prs');
}

/**
 * Has the token budget run out? `claudeUsdToday` is Claude spend for the ET day; `null` (unreadable) never
 * refuses — a missing meter must not stop work the operator asked to run (fails open, like every load read).
 */
export function tokenBudgetExhausted({ claudeUsdToday = null } = {}, settings) {
  const budget = settings?.claudeDailyUsdBudget;
  if (!Number.isFinite(budget) || !Number.isFinite(claudeUsdToday)) return false;
  return claudeUsdToday >= budget;
}

/**
 * THE RULE. May a NEW `kind` job start now?
 *
 * - mode `off`, or a HEAVY kind → `legacy` exactly (the caller's existing gate decision, e.g. `hostLoadGate`'s
 *   result). Heavy work stays under its caps and CPU guard; nothing about it changes.
 * - a LIGHT kind with mode `on` → its own gates, in order: token budget, light cap, light CPU floor, free memory.
 *   The heavy caps and the heavy CPU floor do NOT apply.
 *
 * @param {{
 *   kind: string,
 *   settings: object,                       // resolveCostAdmissionSettings()
 *   facts?: { cpuIdlePct?:number|null, memFreePct?:number|null, minMemFreePct?:number,
 *             lightInFlight?:number, claudeUsdToday?:number|null },
 *   legacy?: { admit:boolean, why?:string } // today's decision for this launch; only read on the legacy path
 * }} o
 * @returns {{ admit:boolean, costClass:'heavy'|'light', rule:'legacy'|'light', reason:string, why?:string }}
 */
export function admitLaunch({ kind, settings, facts = {}, legacy = { admit: true } } = {}) {
  const costClass = jobCostClass(kind);
  if (!usesLightRule(kind, settings)) {
    const admit = legacy?.admit !== false;
    return { admit, costClass, rule: 'legacy', reason: admit ? 'admitted' : (legacy?.kind || 'refused'), ...(legacy?.why ? { why: legacy.why } : {}) };
  }
  const base = { costClass, rule: 'light' };
  if (tokenBudgetExhausted(facts, settings)) {
    return { ...base, admit: false, reason: 'token-budget',
      why: `Claude spend $${facts.claudeUsdToday.toFixed(2)} today >= budget $${settings.claudeDailyUsdBudget} (WE_CLAUDE_DAILY_USD_BUDGET); light ${kind} deferred` };
  }
  const inFlight = Number(facts.lightInFlight) || 0;
  if (inFlight >= settings.lightMaxConcurrent) {
    return { ...base, admit: false, reason: 'light-cap',
      why: `${inFlight} light job(s) in flight >= light cap ${settings.lightMaxConcurrent} (WE_LIGHT_MAX_CONCURRENT); ${kind} deferred` };
  }
  if (Number.isFinite(facts.cpuIdlePct) && facts.cpuIdlePct < settings.lightCpuIdleMinPct) {
    return { ...base, admit: false, reason: 'light-cpu-floor',
      why: `cpu idle ${facts.cpuIdlePct.toFixed(1)}% < light floor ${settings.lightCpuIdleMinPct}% (WE_MIN_CPU_IDLE_PCT_LIGHT); ${kind} deferred` };
  }
  if (Number.isFinite(facts.memFreePct) && Number.isFinite(facts.minMemFreePct) && facts.memFreePct < facts.minMemFreePct) {
    return { ...base, admit: false, reason: 'mem-free',
      why: `${facts.memFreePct}% memory free < ${facts.minMemFreePct}% (WE_MIN_MEM_FREE_PCT); light ${kind} deferred` };
  }
  return { ...base, admit: true, reason: 'admitted',
    why: `light ${kind} admitted: ${inFlight}/${settings.lightMaxConcurrent} in flight${Number.isFinite(facts.cpuIdlePct) ? `, cpu idle ${facts.cpuIdlePct.toFixed(1)}% >= ${settings.lightCpuIdleMinPct}%` : ''}` };
}

/**
 * The one report line per tick: heavy vs light admitted/refused and why, plus the facts that decided.
 * @param {Array<{costClass:'heavy'|'light', admit:boolean, reason:string}>} decisions
 * @param {{settings:object, facts?:{cpuIdlePct?:number|null, claudeUsdToday?:number|null}}} ctx
 */
export function summarizeCostAdmission(decisions = [], { settings, facts = {} } = {}) {
  const tally = { heavy: { admitted: 0, refused: {} }, light: { admitted: 0, refused: {} } };
  for (const d of Array.isArray(decisions) ? decisions : []) {
    const t = tally[d?.costClass === 'light' ? 'light' : 'heavy'];
    if (d.admit) t.admitted += 1; else t.refused[d.reason || 'refused'] = (t.refused[d.reason || 'refused'] || 0) + 1;
  }
  const part = (name) => {
    const t = tally[name];
    const refused = Object.values(t.refused).reduce((a, b) => a + b, 0);
    const why = Object.entries(t.refused).map(([r, n]) => `${r} ${n}`).join(', ');
    return `${name} ${t.admitted} admitted / ${refused} refused${why ? ` (${why})` : ''}`;
  };
  const cpu = Number.isFinite(facts.cpuIdlePct) ? `cpu idle ${facts.cpuIdlePct.toFixed(1)}%` : 'cpu idle ?';
  const budget = Number.isFinite(settings?.claudeDailyUsdBudget) ? `$${settings.claudeDailyUsdBudget}` : 'no budget';
  const spend = Number.isFinite(facts.claudeUsdToday) ? `claude $${facts.claudeUsdToday.toFixed(0)} today (${budget})` : `claude spend ? (${budget})`;
  const mode = costAdmissionOn(settings)
    ? `on, light cap ${settings.lightMaxConcurrent}, light floor ${settings.lightCpuIdleMinPct}%`
    : 'off';
  return { tally, line: `cost-admission ${mode} · ${part('heavy')} · ${part('light')} · ${cpu} · ${spend}` };
}
