/**
 * IO/cascade half of Codex task routing. The pure codex-model-routing module is copied
 * into routing-policy child snapshots and must have no module dependencies.
 */
import { resolveCascade, platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import {
  CODEX_EFFORT_MAP, CODEX_MODEL_CATALOGUE, CODEX_TASK_KINDS, CODEX_MODEL_BY_TASK_DEFAULT,
  CODEX_USAGE_BUCKETS, assertCodexModel, resolveCodexEffort, classifyCodexTask,
  codexModelSupportsEffort, logCodexRoute,
} from './codex-model-routing.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validModel = value => {
  try { return Object.hasOwn(CODEX_MODEL_CATALOGUE, assertCodexModel(value)); } catch { return false; }
};
const validEffort = value => typeof value === 'string' && Object.hasOwn(CODEX_EFFORT_MAP, value);

/** Resolve codex.modelByTask per leaf through the shared cascade, then apply caller pins and validate the pair.
 * `tool` and `platform` are optional kind → { model, effort } blocks (also useful as deterministic IO seams).
 */
export function resolveCodexTaskRoute({
  kind, size, epic, decision, care, mandatoryLens, model, effort,
  env = process.env, tool = readSettings().codex?.modelByTask,
  platform = platformPreference('codexModelByTask', { env }), log,
} = {}) {
  kind = classifyCodexTask({ kind, size, epic, decision, care, mandatoryLens });
  const invalid = [];
  let envBlock;
  if (env?.WE_CODEX_MODEL_BY_TASK !== undefined) {
    try {
      envBlock = JSON.parse(env.WE_CODEX_MODEL_BY_TASK);
      if (!isObject(envBlock)) throw new TypeError('expected JSON object');
    } catch {
      invalid.push('env WE_CODEX_MODEL_BY_TASK (invalid JSON object)');
      envBlock = undefined;
    }
  }
  // resolveCascade validates top-level leaves. Project each kind into its two scalar leaves so
  // a partial env block cannot replace a whole pair, nor can a bad effort discard a valid model.
  const block = (layer, name) => {
    if (layer == null) return {};
    if (!isObject(layer)) { invalid.push(`${name} (invalid task map)`); return {}; }
    for (const key of Object.keys(layer)) if (!CODEX_TASK_KINDS.includes(key)) invalid.push(`${name}.${key} (invalid kind)`);
    const pair = layer[kind];
    if (pair === undefined) return {};
    if (!isObject(pair)) { invalid.push(`${name}.${kind} (invalid pair)`); return {}; }
    return Object.fromEntries(Object.entries(pair).filter(([key, value]) => {
      const valid = key === 'model' ? validModel(value) : key === 'effort' ? validEffort(value) : false;
      if (!valid) invalid.push(`${name}.${kind}.${key}=${JSON.stringify(value)}`);
      return valid;
    }).map(([key, value]) => [key, key === 'model' ? assertCodexModel(value) : value]));
  };
  const resolved = resolveCascade({
    standard: CODEX_MODEL_BY_TASK_DEFAULT[kind], platform: block(platform, 'platform'),
    tool: block(tool, 'tool'), envValues: block(envBlock, 'env'),
    valid: { model: validModel, effort: validEffort },
  });
  resolved.invalid.push(...invalid);
  logCascadeSources(`codex.modelByTask.${kind}`, resolved, { env, log: log === false ? () => {} : log });
  const sources = { ...resolved.sources };
  if (model !== undefined) { model = assertCodexModel(model); sources.model = 'explicit'; }
  else model = resolved.value.model;
  if (effort !== undefined) { effort = resolveCodexEffort({ effort }); sources.effort = 'explicit'; }
  else effort = resolved.value.effort;
  if (!codexModelSupportsEffort(model, effort)) {
    throw new TypeError(`Codex model ${model} does not support effort ${effort}; supported levels: ${CODEX_MODEL_CATALOGUE[model].join('|')}`);
  }
  const route = { kind, model, effort, sources, bucket: Object.hasOwn(CODEX_USAGE_BUCKETS, model) ? CODEX_USAGE_BUCKETS[model] : null };
  if (log !== false) {
    if (invalid.length) {
      try { (log ?? (l => console.error(l)))(`codex-route · invalid: ${invalid.join(', ')}`); } catch { /* best-effort */ }
    }
    logCodexRoute(route, { log });
  }
  return route;
}
