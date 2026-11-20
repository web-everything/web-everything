/** Shared agy provenance and backend quota holds. Init is CLI-reported identity, not server attestation. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const agyBackend = (model) => /^claude-|^(sonnet|opus)$/.test(model ?? '') ? 'anthropic' : /^gemini-/.test(model ?? '') ? 'google' : 'unknown';
export const agyEvidenceDir = () => process.env.ANTIGRAVITY_QUOTA_DIR || join(homedir(), '.antigravity-quota');
export function agyRunEvidence({ stdout = '', stderr = '', requestedModel, now = Date.now() } = {}) {
  const events = String(stdout).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const reported = events.find((e) => e?.event === 'init')?.init?.model;
  const servedModel = typeof reported === 'string' && reported ? reported : 'unknown';
  const terminal = events.filter((e) => e?.event === 'result').at(-1)?.result;
  // Never scan response/prompt/tool text: quoted quota prose is not an exhaustion signal.
  const error = [stderr, terminal?.error].filter(Boolean).join('\n');
  const exhausted = /RESOURCE_EXHAUSTED|Individual quota reached|quota (?:exceeded|exhausted)|usage limit|rate[ -]?limit|\b429\b/i.test(error);
  const reset = /Resets in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(error);
  const delay = reset ? (+reset[1] || 0) * 3600000 + (+reset[2] || 0) * 60000 + (+reset[3] || 0) * 1000 : 3600000;
  const mismatch = agyBackend(requestedModel) !== 'unknown' && agyBackend(servedModel) !== 'unknown' && agyBackend(requestedModel) !== agyBackend(servedModel);
  const canonical = (m) => String(m).replace(/-(?:high|medium|low|max)$/, '');
  const modelMismatch = /^(?:claude|gemini)-/.test(requestedModel ?? '') && servedModel !== 'unknown' && canonical(requestedModel) !== canonical(servedModel);
  return { requestedModel: requestedModel || 'default', servedModel, servedBackend: agyBackend(servedModel),
    modelEvidence: servedModel === 'unknown' ? 'unavailable' : 'agy-init',
    quotaState: exhausted ? 'exhausted' : 'unknown',
    quotaResetsAt: exhausted ? new Date(now + (delay || 3600000)).toISOString() : null,
    fallbackDecision: exhausted ? 'skip-quota-exhausted' : mismatch ? 'skip-backend-mismatch' : modelMismatch ? 'skip-model-mismatch' : 'none' };
}
export function readAgyHold(model, { dir = agyEvidenceDir(), now = Date.now() } = {}) {
  try {
    const health = JSON.parse(readFileSync(join(dir, 'binary', 'health.json'), 'utf8'));
    const at = typeof health?.at === 'string' ? Date.parse(health.at) : NaN;
    if (!['ok', 'dead'].includes(health?.state) || typeof health.version !== 'string'
      || typeof health.reason !== 'string' || !Number.isFinite(at) || at > now) throw Error('invalid health');
    // An interrupted upgrade or an unconfirmed kill never ages out: only a healthy smoke (or the operator) clears it.
    const unresolved = health.reason === 'upgrading' || health.reason === 'cleanup incomplete';
    if (health.state === 'dead' && (unresolved || now - at < 86400000))
      return { ...health, requestedModel: model || 'default', servedModel: 'unknown', servedBackend: 'unknown',
        modelEvidence: 'not-launched', fallbackDecision: 'skip-binary-dead' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { requestedModel: model || 'default', servedModel: 'unknown', servedBackend: 'unknown',
      modelEvidence: 'not-launched', fallbackDecision: 'skip-binary-dead', reason: 'binary health record is unreadable; inspect binary/health.json' };
  }
  const readRows = (folder) => {
    try {
      return readdirSync(folder).filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')));
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  // Default and unrecognized launches have no known backend before init.
  const backend = agyBackend(model);
  const backends = backend === 'unknown' ? ['anthropic', 'google', 'unknown'] : [backend];
  // Read the old global layout without rewriting it. Unattributed legacy holds remain global.
  const holds = readRows(dir).map((row) => ({ row,
    heldBackend: [row.servedModel, row.requestedModel].map(agyBackend).find((value) => value !== 'unknown') ?? 'unknown' }))
    .filter(({ row, heldBackend }) => row.quotaState === 'provider-unresponsive' || heldBackend === 'unknown' || backends.includes(heldBackend));
  for (const heldBackend of backends) {
    holds.push(...readRows(join(dir, heldBackend)).map((row) => ({ row, heldBackend })));
  }
  const hold = holds.filter(({ row }) => Date.parse(row.quotaResetsAt) > now)
    .sort((a, b) => Number(b.row.quotaState === 'provider-unresponsive') - Number(a.row.quotaState === 'provider-unresponsive')
      || Date.parse(b.row.quotaResetsAt) - Date.parse(a.row.quotaResetsAt))[0];
  if (!hold) return null;
  const { row, heldBackend } = hold;
  const heldModel = row.servedModel && row.servedModel !== 'unknown' ? row.servedModel : row.requestedModel || 'unknown';
  return { ...row, requestedModel: model || 'default', servedModel: 'unknown', servedBackend: 'unknown', modelEvidence: 'not-launched',
    fallbackDecision: row.quotaState === 'provider-unresponsive' ? 'skip-provider-unresponsive' : 'skip-quota-hold', heldBackend, heldModel };
}
export function saveAgyHold(evidence, { dir = agyEvidenceDir() } = {}) {
  if (!['exhausted', 'provider-unresponsive'].includes(evidence.quotaState)) return;
  const backend = evidence.servedBackend === 'unknown' ? agyBackend(evidence.requestedModel) : evidence.servedBackend;
  const folder = evidence.quotaState === 'provider-unresponsive' ? dir : join(dir, backend);
  mkdirSync(folder, { recursive: true });
  // Independent immutable observations: concurrent failures cannot shorten a previously observed hold.
  const file = join(folder, `${randomUUID()}.json`);
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(evidence));
  renameSync(temp, file);
}
export function agyEvidenceError(evidence) {
  const heldBy = evidence.heldBackend ? ` (held by ${evidence.heldBackend} model ${evidence.heldModel ?? 'unknown'})` : '';
  const window = evidence.quotaState === 'provider-unresponsive' ? `; provider-unresponsive: first-output window ${evidence.firstOutputMs} ms; cooldown ${evidence.cooldownMs} ms` : '';
  const error = new Error(`antigravity: ${evidence.fallbackDecision}; requested ${evidence.requestedModel}; reported ${evidence.servedModel}; quota reset ${evidence.quotaResetsAt ?? 'unknown'}${heldBy}${window}`);
  error.telemetry = evidence;
  return error;
}

/** Whitelist provenance at each record boundary; never persist prompts or arbitrary report keys. */
export function pickAgyEvidence(report = {}) {
  return Object.fromEntries(['requestedModel', 'servedModel', 'servedBackend', 'modelEvidence', 'quotaState', 'quotaResetsAt', 'fallbackDecision']
    .concat(['firstOutputMs', 'cooldownMs'])
    .filter((key) => ['firstOutputMs', 'cooldownMs'].includes(key) ? Number.isSafeInteger(report?.[key]) : typeof report?.[key] === 'string')
    .map((key) => [key, report[key]]));
}
export function parseAgyReportEvidence(text) {
  try { return pickAgyEvidence(JSON.parse(text)); } catch { return {}; }
}
