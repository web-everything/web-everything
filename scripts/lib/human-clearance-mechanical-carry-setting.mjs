/** R711 — the drain record is optional evidence; unchanged reviewed diffs remain the default. */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';

const SETTINGS_FILE = new URL('../settings/human-clearance-carry.json', import.meta.url);
const ENV_KEY = 'WE_HUMAN_CLEARANCE_MECHANICAL_CARRY';
const valid = value => value === 'refuse' || value === 'trust-drain-record';
let logged;

/** Resolve standard → platform → tool → env. Invalid/unreadable evidence fails closed to refuse. */
export function resolveMechanicalCarrySetting({ env = process.env, file = SETTINGS_FILE, readFile = readFileSync, tool, log = s => process.stderr.write(s) } = {}) {
  let result;
  try {
    let unreadableTool = false;
    if (tool === undefined) {
      try { tool = JSON.parse(String(readFile(file, 'utf8')))?.humanClearance; }
      catch (e) { if (e?.code !== 'ENOENT') unreadableTool = true; }
    }
    const resolved = cascadePolicy('humanClearance', tool && { mechanicalCarry: tool.mechanicalCarry }, {
      standard: { mechanicalCarry: 'refuse' }, env,
      envValues: { mechanicalCarry: env?.[ENV_KEY] },
      valid: { mechanicalCarry: valid },
      log: () => {},
    });
    const source = resolved.sources.mechanicalCarry;
    const rank = { standard: 0, platform: 1, tool: 2, env: 3 };
    const invalidLayers = resolved.invalid.filter(s => /^(platform|tool|env)\.mechanicalCarry=/.test(s)).map(s => s.split('.')[0]);
    if (unreadableTool) invalidLayers.push('tool');
    if (env != null && Object.hasOwn(env, ENV_KEY) && !valid(env[ENV_KEY])) invalidLayers.push('env');
    const invalidLayer = invalidLayers.sort((a, b) => rank[b] - rank[a]).find(layer => rank[layer] >= rank[source]);
    result = invalidLayer || !valid(resolved.value?.mechanicalCarry)
      ? { value: 'refuse', source: `fail-closed (${invalidLayer ?? 'invalid'} mechanicalCarry)` }
      : { value: resolved.value.mechanicalCarry, source };
  } catch { result = { value: 'refuse', source: 'fail-closed (unreadable mechanicalCarry)' }; }
  const key = `${result.value}:${result.source}`;
  if (logged !== key) {
    logged = key;
    log(`policy · humanClearance.mechanicalCarry=${result.value} (${result.source})\n`);
  }
  return result;
}
