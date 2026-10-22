/** Synchronous, single-flight rechecks of observed per-model Antigravity quota holds. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, statSync, fstatSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readSettings } from './settings-files.mjs';
import { agyRunEvidence, readAgyHold, saveAgyHold, agyEvidenceDir, canonicalAgyModel, agyProbeStatePath, AGY_HOLD_OBSERVATION } from './antigravity-run-evidence.mjs';

export function resolveAgyReprobePolicy({ settings = readSettings(), env = process.env } = {}) {
  const file = settings?.agyQuotaReprobe;
  const source = {};
  const choose = (key, envKey, fallback, parse) => {
    for (const [raw, fromEnv, layer] of [[env[envKey], true, 'env'], [file?.[key], false, 'settings/agy-quota-reprobe.json']]) {
      const value = raw === undefined ? undefined : parse(raw, fromEnv);
      if (value !== undefined) {
        source[key] = layer;
        return value;
      }
    }
    source[key] = 'default';
    return fallback;
  };
  const enabled = choose('enabled', 'WE_AGY_REPROBE', true, (v, fromEnv) => fromEnv ? v === '1' ? true : v === '0' ? false : undefined : typeof v === 'boolean' ? v : undefined);
  const intervalMinutes = choose('intervalMinutes', 'WE_AGY_REPROBE_INTERVAL_MIN', 60, (v, fromEnv) => {
    const n = fromEnv && typeof v === 'string' && v.trim() ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
  });
  return { enabled, intervalMinutes, source };
}

const shortError = (value) => String(value ?? '').trim().slice(0, 500);
const sameModel = (model, evidence) => !!canonicalAgyModel(model)
  && canonicalAgyModel(evidence?.servedModel) === canonicalAgyModel(model)
  && !['skip-backend-mismatch', 'skip-model-mismatch'].includes(evidence?.fallbackDecision);
export function probeAgyModel(model, { spawnSyncFn = spawnSync, cli = 'agy', timeoutMs = 90000 } = {}) {
  if (!canonicalAgyModel(model)) return { outcome: 'error', evidence: agyRunEvidence({ requestedModel: model }), errorText: 'no concrete model', code: null };
  let run;
  try {
    run = spawnSyncFn(cli, ['--print', 'Reply with the single word OK.', '--model', model,
      '--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', '60s'],
    { encoding: 'utf8', timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  } catch (error) {
    return { outcome: 'error', evidence: agyRunEvidence({ requestedModel: model }), errorText: shortError(error?.message ?? String(error)), code: null };
  }
  const stdout = String(run.stdout ?? '');
  const stderr = String(run.stderr ?? '').trim();
  const evidence = agyRunEvidence({ stdout, stderr, requestedModel: model });
  let terminal, initCount = 0, resultSeen = false, invalidStream = false;
  for (const line of stdout.split('\n').filter((line) => line.trim())) {
    if (resultSeen) invalidStream = true;
    try {
      const event = JSON.parse(line);
      if (event?.event === 'init') initCount++;
      if (event?.event === 'result') {
        resultSeen = true;
        terminal = event.result;
      }
    } catch { invalidStream = true; }
  }
  const error = [stderr, terminal?.error, run.error?.message,
    invalidStream ? 'invalid stream: malformed JSON or output after terminal result' : ''].filter(Boolean).join('\n');
  const explicitReset = evidence.quotaResetExplicit;
  const outcome = initCount !== 1 || !sameModel(model, evidence) || run.error || run.signal || invalidStream ? 'error'
    : evidence.quotaState === 'exhausted' ? 'quota'
      : !stderr && run.status === 0 && evidence.fallbackDecision === 'none' && terminal && !terminal.error
        && (terminal.status === undefined || terminal.status === 'SUCCESS')
        && typeof terminal.response === 'string'
        && /^OK$/i.test(terminal.response.trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')) ? 'ok' : 'error';
  return { outcome, evidence, explicitReset, errorText: shortError(error || (outcome === 'error' ? `agy exited ${run.status ?? 'without status'}; ${terminal ? 'terminal result failed' : 'no terminal result'}` : '')), code: run.status ?? null };
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

function writeState(path, state) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, path);
}

export function readAgyHoldReprobing(model, { dir = agyEvidenceDir(), now = Date.now(), policy, probe = probeAgyModel, log = (line) => console.error(line), force = false, fsOps = { statSync, renameSync } } = {}) {
  const hold = readAgyHold(model, { dir, now });
  const emit = (line) => { try { log(line); } catch {} };
  try {
    if (!hold) return hold;
    if (model && model !== 'default' && !canonicalAgyModel(model)) return hold;
    policy ??= resolveAgyReprobePolicy();
    if (!policy.enabled) return hold;
    const observed = hold[AGY_HOLD_OBSERVATION];
    const target = canonicalAgyModel(observed.servedModel) ? observed.servedModel
      : canonicalAgyModel(observed.requestedModel) ? observed.requestedModel : null;
    if (!target) return hold;
    const path = agyProbeStatePath(dir, target);
    const lock = path.replace(/\.json$/, '.lock');
    const throttled = (state) => !force && Number.isFinite(state.lastProbeAt) && now - state.lastProbeAt < policy.intervalMinutes * 60000;
    if (throttled(readState(path))) return hold;
    mkdirSync(dirname(path), { recursive: true });
    // Retain the inode so a slow probe cannot remove a successor's lock after stale recovery.
    let fd;
    try { fd = openSync(lock, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (now - fsOps.statSync(lock).mtimeMs <= 10 * 60000) return hold;
      const stale = `${lock}.${randomUUID()}.stale`;
      fsOps.renameSync(lock, stale);
      const wasStale = now - statSync(stale).mtimeMs > 10 * 60000;
      unlinkSync(stale);
      if (!wasStale) return hold;
      try { fd = openSync(lock, 'wx'); } catch (err) { if (err.code === 'EEXIST') return hold; throw err; }
    }
    const identity = fstatSync(fd).ino;
    try {
      const previous = readState(path);
      if (throttled(previous)) return hold;
      const freshClaim = (state) => state.claim && now - state.claim.startedAt <= 10 * 60000;
      if (freshClaim(previous) || statSync(lock).ino !== identity) return hold;
      const token = randomUUID();
      writeState(path, { ...previous, claim: { token, startedAt: now } });
      if (readState(path).claim?.token !== token || statSync(lock).ino !== identity) return hold;
      const result = { ...probe(target) };
      if (readState(path).claim?.token !== token) return hold;
      if (!sameModel(target, result.evidence)) {
        result.outcome = 'error';
        result.errorText = 'probe model identity mismatch or unknown';
      }
      const state = { ...previous, claim: undefined, lastProbeAt: now, outcome: result.outcome, quotaResetsAt: result.evidence?.quotaResetsAt ?? null,
        errorText: shortError(result.errorText), probedModel: target };
      let reason = result.errorText || result.outcome;
      if (result.outcome === 'ok') {
        state.supersedesBefore = now;
        reason = `probe succeeded (${result.evidence?.servedModel ?? 'unknown'})`;
      } else if (result.outcome === 'quota' && result.explicitReset) {
        // The concrete probe must retain the original default-launch scope.
        const replacement = !observed.requestedModel || observed.requestedModel === 'default'
          ? { ...result.evidence, requestedModel: 'default' } : result.evidence;
        saveAgyHold(replacement, { dir });
        state.supersedesBefore = now - 1;
        reason = `quota reset ${result.evidence.quotaResetsAt}`;
      }
      writeState(path, state);
      emit(`agy quota hold ${result.outcome === 'ok' ? 'lifted' : 'kept'} for ${target}: ${reason} at ${new Date(now).toISOString()}; interval ${policy.intervalMinutes}m (source ${JSON.stringify(policy.source)})`);
      return readAgyHold(model, { dir, now });
    } finally {
      closeSync(fd);
      try { if (statSync(lock).ino === identity) unlinkSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  } catch (error) {
    emit(`agy quota hold kept for ${model || 'default'}: ${shortError(error?.message ?? String(error))}`);
    return hold;
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const model = args.find((a) => a.startsWith('--model='))?.slice(8);
  if (!['probe', 'status'].includes(command) || !canonicalAgyModel(model)) throw new Error('usage: agy-quota-hold.mjs <probe|status> --model=<model> [--force]');
  const dir = agyEvidenceDir();
  console.log(JSON.stringify({ before: readAgyHold(model, { dir }) }));
  const after = command === 'probe' ? readAgyHoldReprobing(model, { dir, force: args.includes('--force') }) : readAgyHold(model, { dir });
  const observed = after?.[AGY_HOLD_OBSERVATION];
  const target = canonicalAgyModel(observed?.servedModel) ? observed.servedModel : model;
  console.log(JSON.stringify({ after, probeState: readState(agyProbeStatePath(dir, target)) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
