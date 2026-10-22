/** Read-only direct-launch preferences; these settings do not select or gate a launcher. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readSettings } from './settings-files.mjs';

export const DIRECT_LAUNCH_PROVIDERS = Object.freeze(['codex', 'antigravity-gemini', 'claude']);
export const GEMINI_MODES = Object.freeze(['trial', 'open']);

const platformPreferences = () => {
  try { return JSON.parse(readFileSync(new URL('./delivery-platform-preferences.json', import.meta.url), 'utf8')); }
  catch { return {}; }
};

const positiveInteger = raw => {
  if (typeof raw !== 'number' && !(typeof raw === 'string' && /^[0-9]+$/.test(raw))) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 16 ? value : null;
};

/** Defaults → platform → declared repo settings → environment; invalid values leave the lower layer intact. */
export function resolveDirectLaunchSetting({ kind = 'build', env = process.env, platform = platformPreferences(), repo = readSettings() } = {}) {
  let provider = { value: 'codex', source: 'default' };
  let mode = { value: 'trial', source: 'default' };
  let maxConcurrent = { value: 1, source: 'default' };
  const envKind = String(kind).toUpperCase().replace(/-/g, '_');
  for (const [source, settings] of [
    ['platform', platform?.directLaunch],
    ['repo', repo?.directLaunch],
    ['env', { [kind]: { provider: env?.[`WE_DIRECT_LAUNCH_${envKind}_PROVIDER`] }, gemini: {
      mode: env?.WE_DIRECT_LAUNCH_GEMINI_MODE, maxConcurrent: env?.WE_DIRECT_LAUNCH_GEMINI_MAX_CONCURRENT,
    } }],
  ]) {
    if (DIRECT_LAUNCH_PROVIDERS.includes(settings?.[kind]?.provider)) provider = { value: settings[kind].provider, source };
    if (GEMINI_MODES.includes(settings?.gemini?.mode)) mode = { value: settings.gemini.mode, source };
    const max = positiveInteger(settings?.gemini?.maxConcurrent);
    if (max !== null) maxConcurrent = { value: max, source };
  }
  return { kind, provider, gemini: { mode, maxConcurrent } };
}

export const formatDirectLaunchLog = ({ kind, provider, reason, source }) =>
  `direct launch ${kind}: provider ${provider} (${reason}, source ${source})`;

/** Report the preference and its provenance without changing the caller's routing decision. */
export function directLaunchLogLine(options = {}) {
  const { kind, provider, gemini } = resolveDirectLaunchSetting(options);
  let reason = provider.source === 'default' ? 'preference built-in default' : `preference directLaunch.${kind}.provider`;
  if (provider.value === 'antigravity-gemini') reason += `, gemini mode ${gemini.mode.value} max ${gemini.maxConcurrent.value}`;
  return formatDirectLaunchLog({ kind, provider: provider.value, reason, source: provider.source });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kind = process.argv.slice(2).find(arg => arg.startsWith('--kind='))?.slice('--kind='.length);
  for (const entry of kind ? [kind] : ['build', 'fix', 'prepare-item', 'ci-heal']) {
    console.log(directLaunchLogLine({ kind: entry }));
  }
}
