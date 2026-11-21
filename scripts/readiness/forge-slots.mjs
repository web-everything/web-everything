#!/usr/bin/env node
import {readFileSync, existsSync, realpathSync} from 'node:fs';
import {hostname} from 'node:os';
import {fileURLToPath} from 'node:url';

function checked(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 128) throw new Error(label + ' must be 1..128');
  return value;
}
export function resolveForgeSlots(settings, {env = {}, host = ''} = {}) {
  if (env.FORGE_EXEC_SLOTS !== undefined) {
    if (!/^[1-9][0-9]*$/.test(env.FORGE_EXEC_SLOTS)) throw new Error('FORGE_EXEC_SLOTS must be 1..128');
    return checked(Number(env.FORGE_EXEC_SLOTS), 'FORGE_EXEC_SLOTS');
  }
  const config = settings?.forgeSlots;
  if (!config || !config.hosts || typeof config.hosts !== 'object' || Array.isArray(config.hosts)) {
    throw new Error('Missing forgeSlots default/hosts settings');
  }
  checked(config.default, 'forgeSlots.default');
  for (const [name, value] of Object.entries(config.hosts)) checked(value, 'forgeSlots.hosts.' + name);
  const name = (env.FORGE_HOST ?? host).split('.')[0];
  return Object.hasOwn(config.hosts, name) ? config.hosts[name] : config.default;
}

/** Overlay the operator layer's per-host sizes (policy-cascade platform preference `forgeSlots`) on the repo settings. */
export function mergeOperatorHosts(settings, operator) {
  if (operator === undefined || operator === null) return settings;
  if (typeof operator !== 'object' || Array.isArray(operator)) throw new Error('forgeSlots operator hosts must be an object');
  const hosts = operator.hosts;
  if (hosts === undefined) return settings;
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) throw new Error('forgeSlots operator hosts must be an object');
  return {...settings, forgeSlots: {...settings?.forgeSlots, hosts: {...settings?.forgeSlots?.hosts, ...hosts}}};
}

async function operatorLayer() {
  let cascade;
  try { cascade = await import('../lib/policy-cascade.mjs'); } catch { return undefined; } // flat Forge deployment: no cascade module
  const {prefs, errors} = cascade.readPlatformPreferences({warn: () => {}});
  if (errors.length) throw new Error('operator layer unreadable');
  return prefs.forgeSlots;
}

const cliPath = (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if(process.argv[1] && cliPath === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const beside = new URL('./forge-slots.json', import.meta.url);
    const path = existsSync(beside) ? beside : new URL('../settings/forge-slots.json', import.meta.url);
    const base = process.env.FORGE_EXEC_SLOTS === undefined ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const settings = base ? mergeOperatorHosts(base, await operatorLayer()) : null;
    console.log(resolveForgeSlots(settings, {env: process.env, host: hostname()}));
  } catch (error) {
    console.error('forge-slots: ' + String(error.message).replace(/[\x00-\x1f\x7f]/g, ' '));
    process.exitCode = 1;
  }
}
