/**
 * @file The `ledgerBinding` policy (#5492 rebuild): every knob of the head-binding work, resolved through the shared
 * cascade (standard → platform → repo `scripts/settings/ledger-binding.json` → env) and logged with value and source
 * by `cascadePolicy` (once per process, inside a daemon). An invalid layer is ignored and the layer below answers.
 *
 * - renderOpenQuestions (bool, standard on): review-pr shows its jurors the PR's open ledger questions at the reviewed
 *   head. Off: no section, and no `seenKeys` (the review's rows then answer nothing under the binding rule).
 * - writeSeen (bool, standard on): review-pr stamps `seenKeys` = exactly the questions it rendered.
 * - shadowPassBudgetMs / shadowMaxRows / shadowMaxBytes / shadowMaxCarries (positive integers): the drain binding
 *   shadow's per-pass fold budget and per-PR fold caps (standard 2000 / 2000 / 1000000 / 8).
 */
import { resolveCascade, logCascadeSources, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export const LEDGER_BINDING_STANDARD = Object.freeze({
  renderOpenQuestions: true, writeSeen: true,
  shadowPassBudgetMs: 2000, shadowMaxRows: 2000, shadowMaxBytes: 1_000_000, shadowMaxCarries: 8,
});
const ENV = Object.freeze({
  renderOpenQuestions: 'WE_LEDGER_BINDING_RENDER_OPEN_QUESTIONS', writeSeen: 'WE_LEDGER_BINDING_WRITE_SEEN',
  shadowPassBudgetMs: 'WE_LEDGER_BINDING_SHADOW_PASS_BUDGET_MS', shadowMaxRows: 'WE_LEDGER_BINDING_SHADOW_MAX_ROWS',
  shadowMaxBytes: 'WE_LEDGER_BINDING_SHADOW_MAX_BYTES', shadowMaxCarries: 'WE_LEDGER_BINDING_SHADOW_MAX_CARRIES',
});
const bool = (v) => typeof v === 'boolean';
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const parseEnv = (key, raw) => {
  if (raw === undefined || raw === '') return undefined;
  if (bool(LEDGER_BINDING_STANDARD[key])) return /^(true|1|on)$/i.test(raw) ? true : /^(false|0|off)$/i.test(raw) ? false : raw;
  return /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : raw;
};

/** @returns {{value: typeof LEDGER_BINDING_STANDARD, sources: object, invalid: string[]}} Never throws. */
export function readLedgerBindingSettings({ env = process.env, tool, platform, log } = {}) {
  try {
    // Every layer is checked WHOLE before resolution: a wrong-typed value (an object where a switch or cap belongs) is
    // dropped and listed, so the layer below it answers; the logged line is the final effective value and source.
    const invalid = [];
    const clean = (layer, name) => (layer && typeof layer === 'object' && !Array.isArray(layer)
      ? Object.fromEntries(Object.entries(layer).filter(([k, v]) => {
        const ok = !Object.hasOwn(LEDGER_BINDING_STANDARD, k) || (bool(LEDGER_BINDING_STANDARD[k]) ? bool : posInt)(v);
        if (!ok) invalid.push(`${name}.ledgerBinding.${k}`);
        return ok;
      })) : layer);
    const repoLayer = clean(tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().ledgerBinding), 'repo');
    let plat = platform;
    if (plat === undefined) { try { plat = platformPreference('ledgerBinding', { env }); } catch { plat = undefined; } }
    // Resolve WITHOUT logging (no dedupe-cache side effect), then log the final effective line exactly once below.
    const r = resolveCascade({
      tool: repoLayer, platform: clean(plat, 'platform') ?? {}, standard: { ...LEDGER_BINDING_STANDARD },
      valid: Object.fromEntries(Object.entries(LEDGER_BINDING_STANDARD).map(([k, v]) => [k, bool(v) ? bool : posInt])),
      envValues: Object.fromEntries(Object.entries(ENV).map(([k, name]) => [k, parseEnv(k, env?.[name])])),
    });
    const value = { ...r.value }, sources = { ...r.sources };
    for (const [k, std] of Object.entries(LEDGER_BINDING_STANDARD)) { // backstop: never a wrong-typed effective value
      if (!(bool(std) ? bool : posInt)(value[k])) { invalid.push(`ledgerBinding.${k}`); value[k] = std; sources[k] = 'standard'; }
    }
    for (const k of Object.keys(sources)) if (!Object.hasOwn(LEDGER_BINDING_STANDARD, k)) delete sources[k];
    const resolved = { ...r, value, sources, invalid: [...invalid, ...(r.invalid ?? [])] };
    logCascadeSources('ledgerBinding', resolved, { env, ...(log ? { log } : {}) });
    return resolved;
  } catch (e) {
    try { (log ?? ((l) => console.error(l)))(`policy-cascade · ledgerBinding: settings unreadable (${String(e?.message ?? e).slice(0, 80)}); standard values in force`); } catch { /* never */ }
    return { value: { ...LEDGER_BINDING_STANDARD }, sources: Object.fromEntries(Object.keys(LEDGER_BINDING_STANDARD).map((k) => [k, 'standard'])), invalid: ['ledgerBinding: settings unreadable'] };
  }
}
