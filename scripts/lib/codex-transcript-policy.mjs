/** Policy and error handling stay loadable when the optional transcript inspector is absent. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../settings/codex-transcript-check.json');
const modeValue = value => ['warn', 'fail'].includes(value) ? value : undefined;
const text = value => value == null || !String(value).trim() ? undefined : String(value).trim();

export function resolveTranscriptCheckPolicy({ env = process.env, tool, platform, readFile = readFileSync } = {}) {
  let toolError;
  if (tool === undefined) {
    try { tool = JSON.parse(readFile(SETTINGS, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') toolError = error; }
  }
  let platformErrors = [];
  if (platform == null) {
    const result = readPlatformPreferences({ env, readFile });
    platform = result.prefs.transcriptCheck ?? {};
    platformErrors = result.errors;
  }
  const cap = text(env.WE_CODEX_TRANSCRIPT_TOKEN_CAP);
  const resolved = cascadePolicy('transcriptCheck', tool?.transcriptCheck, {
    standard: { mode: 'warn', tokenCap: 3000000 }, platform, env,
    envValues: { mode: text(env.WE_CODEX_TRANSCRIPT_CHECK_MODE), tokenCap: cap !== undefined && /^\d+$/.test(cap) ? Number(cap) : cap },
    valid: { mode: value => modeValue(value) !== undefined, tokenCap: value => Number.isSafeInteger(value) && value >= 0 },
  });
  if (toolError || platformErrors.length) {
    // A broken higher-priority layer can conceal fail. Only a readable higher
    // override can select warn; an unknown effective mode rejects the check.
    const mode = modeValue(text(env.WE_CODEX_TRANSCRIPT_CHECK_MODE))
      ?? (!toolError ? modeValue(tool?.transcriptCheck?.mode) : undefined) ?? 'fail';
    throw Object.assign(new Error('Transcript check policy unreadable: inspect settings and platform preferences'), { transcriptCheckMode: mode });
  }
  return { ...resolved.value, sources: resolved.sources };
}

export function transcriptCheckError({ error, policy, env = process.env, emit }) {
  const mode = policy?.mode ?? error?.transcriptCheckMode
    ?? modeValue(text(env.WE_CODEX_TRANSCRIPT_CHECK_MODE)) ?? 'fail';
  const message = String(error?.message ?? error);
  try { emit(`codex-transcript-check · warning: ${message.replace(/[\x00-\x1f\x7f]/g, ' ')}`); }
  catch { /* Preserve the original failure and mode when the output sink fails. */ }
  return { mode, error: message };
}
