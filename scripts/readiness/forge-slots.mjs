#!/usr/bin/env node
import {readFileSync, existsSync, realpathSync} from 'node:fs';
import {hostname} from 'node:os';
import {fileURLToPath} from 'node:url';

// The same builtin-only reader is shipped beside the flat Forge deployment.
const { readOperatorOverrides } = await import(existsSync(new URL('../lib/operator-override-reader.mjs', import.meta.url))
  ? '../lib/operator-override-reader.mjs' : './operator-override-reader.mjs');

function checked(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 128) throw new Error(label + ' must be 1..128');
  return value;
}
export function resolveForgeSlots(settings, {env = {}, host = ''} = {}) {
  const name = (env.FORGE_HOST ?? host).split('.')[0];
  const key = `forgeSlots.${name}`;
  const override = readOperatorOverrides().values[key];
  if (env.FORGE_EXEC_SLOTS !== undefined) {
    if (!/^[1-9][0-9]*$/.test(env.FORGE_EXEC_SLOTS)) throw new Error('FORGE_EXEC_SLOTS must be 1..128');
    checked(Number(env.FORGE_EXEC_SLOTS), 'FORGE_EXEC_SLOTS');
  }
  let lower = Number(env.FORGE_EXEC_SLOTS);
  if (env.FORGE_EXEC_SLOTS === undefined) {
    const config = settings?.forgeSlots;
    if (!config || !config.hosts || typeof config.hosts !== 'object' || Array.isArray(config.hosts)) {
      throw new Error('Missing forgeSlots default/hosts settings');
    }
    checked(config.default, 'forgeSlots.default');
    for (const [name, value] of Object.entries(config.hosts)) checked(value, 'forgeSlots.hosts.' + name);
    lower = Object.hasOwn(config.hosts, name) ? config.hosts[name] : config.default;
  }
  if (override !== undefined) {
    if (env.WE_POLICY_CASCADE_LOG === '1') console.error(`policy-cascade · ${key}: value=${override} (operator-db)`);
    return override;
  }
  return lower;
}

const cliPath = (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if(process.argv[1] && cliPath === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const beside = new URL('./forge-slots.json', import.meta.url);
    const path = existsSync(beside) ? beside : new URL('../settings/forge-slots.json', import.meta.url);
    let settings = null;
    // Validate the selected lower input before applying operator capacity.
    if (process.env.FORGE_EXEC_SLOTS === undefined) {
      try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch { /* resolver refuses missing or malformed settings */ }
    }
    console.log(resolveForgeSlots(settings, {env: process.env, host: hostname()}));
  } catch (error) {
    console.error('forge-slots: ' + String(error.message).replace(/[\x00-\x1f\x7f]/g, ' '));
    process.exitCode = 1;
  }
}
