/** Periodic terminal-PR recovery, pending-card drain and due-batch flush. */
import { reconcileOwedPrevention } from '../lib/prevention-filing-owed.mjs';
import { loadPreventionBatchSettings } from '../lib/card-batch-settings.mjs';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireLease, cardBatchStateDir, defaultGh, retireTerminalBatch, tokenOf } from './card-batch-io.mjs';
import { sealDueBatches } from './card-batch-seal-io.mjs';
import { landPreventionCard } from './land-prevention-card.mjs';
import { fileIntoBatch } from './card-batch-file.mjs';
import { CARD_BATCH_KINDS } from '../lib/card-batch-policy.mjs';
import { readSettings } from '../lib/settings-files.mjs';

export function resolveReconcileIntervalMin({ read = readSettings } = {}) {
  try {
    const value = read()?.cardBatch?.reconcileIntervalMin;
    return Number.isSafeInteger(value) && value > 0 ? value : 5;
  } catch { return 5; }
}

/** Only active top-level state slots are reconciled. Each slot fails independently. */
export async function reconcileCardBatches({
  stateDir = cardBatchStateDir(), gh = defaultGh, now = Date.now(), clock = Date.now,
  log = line => process.stderr.write(`${line}\n`), remote = 'origin', laneDir,
  leaseMs = 60_000, owner = `reconcile:${process.pid}:${randomUUID()}`,
  seal = sealDueBatches, drain = landPreventionCard, batch = fileIntoBatch,
  dryRun = false, fileOwed = landPreventionCard, loadFilingSettings = loadPreventionBatchSettings,
} = {}) {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
  // `now` is the cadence/flush sample; lease expiry must follow elapsed wall time during GitHub/Git IO.
  const results = [];
  let files;
  try { files = readdirSync(stateDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') files = []; else throw error; }
  let drainNeeded = false;
  if (basename(resolve(stateDir)) === 'sealed') return results;
  for (const file of files.filter(file => file.isFile() && file.name.endsWith('.json'))) {
    const statePath = join(stateDir, file.name);
    const lockPath = `${statePath}.lock`;
    let lease;
    try {
      if (!dryRun) {
        lease = acquireLease(lockPath, owner, clock(), leaseMs);
        if (!lease) { results.push({ statePath, action: 'refuse', reason: 'lease-held' }); continue; }
      }
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!state.batchRef || !state.sealedAt) drainNeeded = true;
      if (!state.batchRef || !state.sealedAt || !state.pr) continue;
      if (dryRun) { results.push({ statePath, action: 'dry-run' }); continue; }
      const kind = state.kind ?? CARD_BATCH_KINDS.find(kind => file.name.endsWith(`-${kind}.json`));
      const repo = state.repo ?? state.members?.[0]?.source?.repo;
      if (!CARD_BATCH_KINDS.includes(kind) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')
        || file.name !== `${repo.replaceAll('/', '-')}-${kind}.json`) throw new Error('invalid batch identity');
      const result = await retireTerminalBatch(state, { kind, source: { repo }, laneDir }, {
        statePath, stateDir, remote, gh, log,
        held: () => tokenOf(lockPath) === lease.token && clock() < lease.expiresAt,
      });
      results.push({ statePath, ...result });
      if (result.action === 'retired') drainNeeded = true;
    } catch (error) { results.push({ statePath, action: 'error', reason: error.message }); }
    finally {
      try { if (lease && tokenOf(lockPath) === lease.token) rmSync(lockPath, { force: true }); }
      catch (error) { results.push({ statePath, action: 'error', reason: error.message }); }
    }
  }
  const pendingDir = join(stateDir, 'pending-prevention');
  // An empty state directory is also an open slot: recover a spool even before its first admission.
  if (!dryRun && (drainNeeded || !files.some(file => file.isFile() && file.name.endsWith('.json')))) {
    try {
      if (readdirSync(pendingDir).some(name => name.endsWith('.json'))) {
        const result = await drain({ drainPending: true, session: `card-batch-reconcile-${randomUUID()}` }, {
          pendingDir, write: line => log(line.trimEnd()),
          batch: (input, options) => batch(input, { ...options, stateDir }),
        });
        if (!result.ok) throw new Error(result.reason ?? 'pending drain failed');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') results.push({ action: 'error', step: 'drain', reason: error.message });
    }
  }
  if (!dryRun && loadFilingSettings().filingEnabled !== false) {
    try {
      const owed = await reconcileOwedPrevention({ stateDir,
        file: input => fileOwed(input, { owedClaimed: true, loadFilingSettings, pendingDir,
          batch: (card, options) => batch(card, { ...options, stateDir }), write: line => log(line.trimEnd()) }),
      });
      for (const result of owed) if (!result.ok) results.push({ action: 'error', step: 'owed', reason: result.reason });
    } catch (error) { results.push({ action: 'error', step: 'owed', reason: error.message }); }
  }
  if (!dryRun) {
    try { await seal({ stateDir, now }); }
    catch (error) { results.push({ action: 'error', step: 'seal', reason: error.message }); }
  }
  return results;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const results = await reconcileCardBatches({ ...deps, dryRun: argv.includes('--dry-run') });
  if (argv.includes('--json')) console.log(JSON.stringify(results));
  else for (const result of results) console.log(`${result.statePath ?? result.step}: ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
  return results.some(result => result.action === 'error') ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
