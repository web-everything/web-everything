/**
 * @file scripts/lib/advisor-trial.mjs
 * @description THE ADVISOR TRIAL (operator-approved 2026-10-08, we:backlog/x331b7u-advisor-trial.md). Adds the
 * Claude Code advisor (`--advisor <model>`, https://code.claude.com/docs/en/advisor) to a sampled share of
 * background Sonnet worker launches, so the coroner can compare rework with and without it.
 *
 * ONE SHARED HELPER for every worker spawn point: `dispatch-lane-io.mjs#buildAgentArgv` applies a decision made
 * here, and both `claude --bg` fix launch paths (`reconcile-fix-dispatch.mjs#dispatchFix`, and
 * `dispatch-lane-io.mjs`'s default agent provider) make that decision through {@link advisorForLaunch}. A future
 * detached fix wrapper calls the same two functions ({@link advisorForLaunch}, {@link advisorArgv} +
 * {@link withAdvisorBrief}) and gets the same sampling.
 *
 * THE WORKER MODEL IS NEVER CHANGED. The advisor is an extra flag only; `--model` stays whatever the routing
 * table decided (Sonnet for fix).
 *
 * SAMPLING IS DETERMINISTIC per run: the bucket is a sha256 of the run id (the dispatcher-minted session id), so
 * the same run id always lands in the same arm and the assignment can be recomputed later from the id alone.
 *
 * FAILS OFF. The advisor costs extra tokens, so a missing, unreadable or malformed settings file turns it OFF
 * (and says why in `error`), never on.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADVISOR_MODES = Object.freeze(['off', 'sample', 'on']);
export const BUILT_IN_ADVISOR_SETTINGS = Object.freeze({ mode: 'off', model: 'opus', sampleRate: 0.5, kinds: Object.freeze(['fix']) });

/** The one brief line a sampled worker gets (appended to its prompt). */
export const ADVISOR_BRIEF_LINE = 'If the same error or failing test repeats twice, consult the advisor before trying again; also consult it before declaring done.';

const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const rules = {
  mode: (v) => ADVISOR_MODES.includes(v),
  // A flag value: never something an argv parser could read as another flag, never Fable (operator rule: Fable is
  // never a worker-side model, and needs usage-credit consent besides).
  model: (v) => typeof v === 'string' && MODEL_RE.test(v) && !/fable/i.test(v),
  sampleRate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
  kinds: (v) => Array.isArray(v) && v.every((k) => typeof k === 'string' && k.trim()),
};

export function defaultAdvisorSettingsPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../advisor-trial-settings.json');
}

/** Merge `raw.advisor` over the built-ins. An invalid key is ignored and named, never trusted. PURE. */
export function resolveAdvisorSettings(raw = {}) {
  const block = raw && typeof raw === 'object' && raw.advisor && typeof raw.advisor === 'object' ? raw.advisor : {};
  const settings = { ...BUILT_IN_ADVISOR_SETTINGS, kinds: [...BUILT_IN_ADVISOR_SETTINGS.kinds] };
  const ignored = [];
  for (const [k, v] of Object.entries(block)) {
    if (Object.hasOwn(rules, k) && rules[k](v)) settings[k] = k === 'kinds' ? v.map((x) => x.trim()) : v;
    else ignored.push(k);
  }
  return { settings, ignored };
}

/**
 * Never throws. Missing / unreadable / not JSON / no valid `advisor.mode` / any ignored key => mode `off`, with
 * `error` naming why. `WE_ADVISOR_TRIAL_SETTINGS` names another file (tests, a one-off operator override).
 */
export function loadAdvisorSettings({ env = process.env, path = env.WE_ADVISOR_TRIAL_SETTINGS || defaultAdvisorSettingsPath(), read = readFileSync } = {}) {
  const off = (error) => ({ settings: { ...resolveAdvisorSettings({}).settings, mode: 'off' }, ignored: [], error });
  let parsed;
  try { parsed = JSON.parse(read(path, 'utf8')); } catch (e) {
    return off(`advisor settings unreadable or not JSON (${path}: ${e?.message || e}) — advisor off`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return off('advisor settings are not a JSON object — advisor off');
  const resolved = resolveAdvisorSettings(parsed);
  if (!ADVISOR_MODES.includes(parsed?.advisor?.mode) || resolved.ignored.length) {
    return off(`advisor settings invalid (mode ${JSON.stringify(parsed?.advisor?.mode)}, ignored keys: ${resolved.ignored.join(', ') || 'none'}) — advisor off`);
  }
  return { ...resolved, error: null };
}

/** The run's sampling bucket in [0, 1): the first 32 bits of sha256(runId). PURE, deterministic. */
export function sampleBucket(runId) {
  const hex = createHash('sha256').update(String(runId ?? '')).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

/**
 * THE DECISION for one launch. PURE. `on` is true only for a kind the settings list, and then: always in mode
 * `on`, never in mode `off`, and in mode `sample` when the run's bucket is below `sampleRate`.
 * A launch with no run id is never sampled (the arm could not be recomputed later).
 * @returns {{on:boolean, mode:string, model:string, sampleRate:number, bucket:number|null, kind:string, reason:string}}
 */
export function decideAdvisor({ runId, kind, settings = BUILT_IN_ADVISOR_SETTINGS }) {
  const k = String(kind ?? '');
  const base = { mode: settings.mode, model: settings.model, sampleRate: settings.sampleRate, kind: k };
  const id = String(runId ?? '').trim();
  const bucket = id ? sampleBucket(id) : null;
  if (!settings.kinds.includes(k)) return { ...base, on: false, bucket, reason: 'kind-not-in-trial' };
  if (settings.mode === 'off') return { ...base, on: false, bucket, reason: 'mode-off' };
  if (settings.mode === 'on') return { ...base, on: true, bucket, reason: 'mode-on' };
  if (bucket === null) return { ...base, on: false, bucket, reason: 'no-run-id' };
  return bucket < settings.sampleRate
    ? { ...base, on: true, bucket, reason: 'sampled-in' }
    : { ...base, on: false, bucket, reason: 'sampled-out' };
}

/** The CLI flags for a decision: `['--advisor', model]` when on, else `[]`. PURE. */
export function advisorArgv(decision) {
  if (!decision?.on) return [];
  if (!rules.model(decision.model)) throw new TypeError(`advisor-trial: refusing advisor model ${JSON.stringify(decision.model)}`);
  return ['--advisor', decision.model];
}

/** The prompt with {@link ADVISOR_BRIEF_LINE} appended when the advisor is on; unchanged otherwise. PURE. */
export function withAdvisorBrief(prompt, decision) {
  const text = String(prompt ?? '');
  if (!decision?.on) return text;
  return `${text.replace(/\s+$/, '')}\n\n${ADVISOR_BRIEF_LINE}\n`;
}

/** Load the settings and decide for one launch. Never throws (a settings fault means off). */
export function advisorForLaunch({ runId, kind, load = loadAdvisorSettings } = {}) {
  try {
    const { settings, error } = load();
    return { ...decideAdvisor({ runId, kind, settings }), ...(error ? { settingsError: error } : {}) };
  } catch (e) {
    const settings = { ...BUILT_IN_ADVISOR_SETTINGS, kinds: [...BUILT_IN_ADVISOR_SETTINGS.kinds], mode: 'off' };
    return { ...decideAdvisor({ runId, kind, settings }), settingsError: `advisor decision failed (${e?.message || e}) — advisor off` };
  }
}

/** One-line log text for a launch decision (the daemon log's evidence line). PURE. */
export function advisorLogLine({ decision, sessionSlug, runId, agentId = null }) {
  const b = decision?.bucket == null ? 'n/a' : decision.bucket.toFixed(4);
  return `advisor-trial: ${sessionSlug} run=${runId}${agentId ? ` agent=${agentId}` : ''} advisor=${decision?.on ? `on(${decision.model})` : 'off'} `
    + `reason=${decision?.reason} mode=${decision?.mode} bucket=${b} rate=${decision?.sampleRate}`;
}

// ── the per-run ledger (the metrics row) ──────────────────────────────────────────────────────────────────────

/** Next to the perf snapshot store (`perf-snapshot-io.mjs#defaultStore`). `WE_ADVISOR_TRIAL_LEDGER` overrides. */
export function advisorLedgerPath(env = process.env, home = homedir()) {
  if (env.WE_ADVISOR_TRIAL_LEDGER) return env.WE_ADVISOR_TRIAL_LEDGER;
  const store = env.WE_PERF_SNAPSHOT_STORE || join(home, 'workspace/.operations/metrics/perf/snapshots.jsonl');
  return join(dirname(store), 'advisor-trial.jsonl');
}

/** The ledger row for one launched run. PURE. */
export function advisorLedgerRow({ decision, runId, agentId = null, sessionSlug, repo = null, pr = null, item = null, at }) {
  return {
    schema: 1, at, runId: String(runId), agentId: agentId ?? null, sessionSlug: String(sessionSlug ?? ''),
    kind: decision.kind, repo, pr: pr == null ? null : Number(pr), item: item == null ? null : String(item),
    advisor: Boolean(decision.on), advisorModel: decision.on ? decision.model : null,
    mode: decision.mode, sampleRate: decision.sampleRate, bucket: decision.bucket, reason: decision.reason,
  };
}

/** Append one row. Never throws: a ledger fault must never fail a dispatch that already started. */
export function recordAdvisorRun(row, { path = advisorLedgerPath(), append = appendFileSync, mkdir = mkdirSync } = {}) {
  try {
    mkdir(dirname(path), { recursive: true });
    append(path, `${JSON.stringify(row)}\n`);
    return true;
  } catch { return false; }
}
