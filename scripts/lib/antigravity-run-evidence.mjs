/** Shared agy provenance and model quota holds. Init is CLI-reported identity, not server attestation. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const agyBackend = (model) => /^claude-|^(sonnet|opus)$/.test(model ?? '') ? 'anthropic' : /^gemini-/.test(model ?? '') ? 'google' : 'unknown';
export const agyEvidenceDir = () => process.env.ANTIGRAVITY_QUOTA_DIR || join(homedir(), '.antigravity-quota');
// Only effort suffixes collapse; thinking remains a distinct allowance.
export const canonicalAgyModel = (model) => typeof model === 'string' && /^(?:claude|gemini|gpt)-(?=[a-z0-9.-]*\d)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(model.trim())
  ? model.trim().replace(/-(?:low|medium|high|xhigh|max)$/, '') : null;
export const AGY_HOLD_OBSERVATION = Symbol('agyHoldObservation');
export const agyProbeStatePath = (dir, model) => join(dir, 'probes', `${encodeURIComponent(canonicalAgyModel(model))}.json`);
export function agyRunEvidence({ stdout = '', stderr = '', requestedModel, now = Date.now() } = {}) {
  const events = String(stdout).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const reported = events.find((e) => e?.event === 'init')?.init?.model;
  const servedModel = typeof reported === 'string' && reported ? reported : 'unknown';
  const terminal = events.filter((e) => e?.event === 'result').at(-1)?.result;
  // Never scan response/prompt/tool text: quoted quota prose is not an exhaustion signal.
  const error = [stderr, terminal?.error].filter(Boolean).join('\n');
  const exhausted = /RESOURCE_EXHAUSTED|Individual quota reached|quota (?:exceeded|exhausted)|usage limit|rate[ -]?limit|\b429\b/i.test(error);
  // Validate only the first phrase, including the boundary of its entire duration token.
  const resetPhrase = /Resets in\s+([\s\S]*)/i.exec(error);
  const reset = resetPhrase && /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?=$|[\s.,;)"'])/i.exec(resetPhrase[1]);
  const quotaResetExplicit = !!reset && reset.slice(1).some((component) => component !== undefined);
  const delay = reset ? (+reset[1] || 0) * 3600000 + (+reset[2] || 0) * 60000 + (+reset[3] || 0) * 1000 : 3600000;
  const mismatch = agyBackend(requestedModel) !== 'unknown' && agyBackend(servedModel) !== 'unknown' && agyBackend(requestedModel) !== agyBackend(servedModel);
  const canonical = canonicalAgyModel;
  const modelMismatch = !!canonical(requestedModel) && servedModel !== 'unknown' && canonical(requestedModel) !== canonical(servedModel);
  return { requestedModel: requestedModel || 'default', servedModel, servedBackend: agyBackend(servedModel),
    modelEvidence: servedModel === 'unknown' ? 'unavailable' : 'agy-init',
    quotaState: exhausted ? 'exhausted' : 'unknown',
    quotaResetExplicit,
    quotaResetsAt: exhausted ? new Date(now + (delay || 3600000)).toISOString() : null,
    fallbackDecision: exhausted ? 'skip-quota-exhausted' : mismatch ? 'skip-backend-mismatch' : modelMismatch ? 'skip-model-mismatch' : 'none' };
}
export function readAgyHold(model, { dir = agyEvidenceDir(), now = Date.now() } = {}) {
  const isDefault = !model || model === 'default';
  const canonical = canonicalAgyModel(model);
  const rows = [];
  for (const backend of isDefault ? ['anthropic', 'google', 'unknown'] : [agyBackend(model)]) {
    const folder = join(dir, backend);
    let names;
    try { names = readdirSync(folder); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const path = join(folder, name);
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      const requested = canonicalAgyModel(entry.requestedModel);
      const served = canonicalAgyModel(entry.servedModel);
      const servedKnown = !!entry.servedModel && entry.servedModel !== 'unknown';
      // Aliases and conflicting identities cannot justify a model-specific scope or supersession.
      const observedModel = servedKnown ? served && (!requested || requested === served) ? served : null : requested;
      if (Date.parse(entry.quotaResetsAt) <= now || !Number.isFinite(Date.parse(entry.quotaResetsAt))) continue;
      if (isDefault ? entry.requestedModel && entry.requestedModel !== 'default' : canonical && observedModel && observedModel !== canonical) continue;
      // A probe can supersede only observations whose model it actually checked.
      if (observedModel) {
        let state;
        try { state = JSON.parse(readFileSync(agyProbeStatePath(dir, observedModel), 'utf8')); }
        catch { /* Unreadable probe state cannot authorize lifting a hold. */ }
        if (typeof state?.supersedesBefore === 'number' && statSync(path).mtimeMs <= state.supersedesBefore) continue;
      }
      rows.push(entry);
    }
  }
  const row = rows.sort((a, b) => Date.parse(b.quotaResetsAt) - Date.parse(a.quotaResetsAt))[0];
  if (!row) return null;
  const hold = { ...row, requestedModel: model || 'default', servedModel: 'unknown', servedBackend: 'unknown', modelEvidence: 'not-launched', fallbackDecision: 'skip-quota-hold' };
  // Keep the public telemetry shape while retaining the target of the original observation.
  Object.defineProperty(hold, AGY_HOLD_OBSERVATION, { value: row });
  return hold;
}

export function saveAgyHold(evidence, { dir = agyEvidenceDir() } = {}) {
  if (evidence.quotaState !== 'exhausted') return;
  const backend = evidence.servedBackend === 'unknown' ? agyBackend(evidence.requestedModel) : evidence.servedBackend;
  const folder = join(dir, backend);
  mkdirSync(folder, { recursive: true });
  // Independent immutable observations: concurrent failures cannot shorten a previously observed hold.
  const file = join(folder, `${randomUUID()}.json`);
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(evidence));
  renameSync(temp, file);
}
export function agyEvidenceError(evidence) {
  const error = new Error(`antigravity: ${evidence.fallbackDecision}; requested ${evidence.requestedModel}; reported ${evidence.servedModel}; quota reset ${evidence.quotaResetsAt ?? 'unknown'}`);
  error.telemetry = evidence;
  return error;
}

/** Whitelist provenance at each record boundary; never persist prompts or arbitrary report keys. */
export function pickAgyEvidence(report = {}) {
  return Object.fromEntries(['requestedModel', 'servedModel', 'servedBackend', 'modelEvidence', 'quotaState', 'quotaResetsAt', 'fallbackDecision']
    .filter((key) => typeof report?.[key] === 'string').map((key) => [key, report[key]]));
}
export function parseAgyReportEvidence(text) {
  try { return pickAgyEvidence(JSON.parse(text)); } catch { return {}; }
}
