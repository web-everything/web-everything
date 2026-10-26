/** Periodic terminal-PR recovery, pending-card drain and due-batch flush. */
import { DRAIN_HARD_DEADLINE_MS } from '../lib/tick-deadline.mjs';
import { drainCursorPath, readDrainCursor, writeDrainCursor } from '../lib/prevention-drain-cursor.mjs';
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

/** How much of the tick the inline drain may use before it stops STARTING cards (the tick watchdog is 180s). */
export const DRAIN_TICK_BUDGET_MS = 60_000;
/** The most a capped drain waits for a lane (also bounded by what is left of the drain budget). */
export const DRAIN_ACQUIRE_WAIT_MS = 30_000;

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
  dryRun = false, drainBudgetMs = DRAIN_TICK_BUDGET_MS, fileOwed = landPreventionCard, loadFilingSettings = loadPreventionBatchSettings,
} = {}) {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
  // The drain budget counts from the START of the health-watch tick: its own sample `now` when that is a recent one (the tick's
  // sweeps ran before this call), else now. Terminal-PR recovery is inside it either way.
  const tickStart = (Number.isFinite(now) && now <= clock() && clock() - now < 170_000) ? now : clock();
  // `now` is the cadence/flush sample; lease expiry must follow elapsed wall time during GitHub/Git IO.
  const results = [];
  let files;
  try { files = readdirSync(stateDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') files = []; else throw error; }
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
    } catch (error) { results.push({ statePath, action: 'error', reason: error.message }); }
    finally {
      try { if (lease && tokenOf(lockPath) === lease.token) rmSync(lockPath, { force: true }); }
      catch (error) { results.push({ statePath, action: 'error', reason: error.message }); }
    }
  }
  const pendingDir = join(stateDir, 'pending-prevention');
  // The tick drains INLINE but capped: it stops before STARTING a card once `drainBudgetMs` of the tick is spent or
  // `prevention.drainCardsPerTick` cards are started, and the cursor makes the next tick resume after the last card
  // handled (a failing card goes behind the others). Pending cards and owed filings take turns going first, so a
  // permanently busy spool cannot starve the owed filings (or the reverse).
  const cursorPath = drainCursorPath(stateDir);
  const deadlineAt = tickStart + drainBudgetMs;
  // Nothing the drain STARTS may run past this: every wait and subprocess in it is capped at the time left (tick-deadline.mjs).
  const hardDeadlineAt = tickStart + DRAIN_HARD_DEADLINE_MS;
  // ONE card allowance for the whole tick, shared by the spool drain and the owed filings (including a filing's nested drain).
  const counter = { left: 0 };
  const acquireWaitMs = () => Math.min(DRAIN_ACQUIRE_WAIT_MS, Math.max(0, deadlineAt - clock()));
  let drainDeferred = false;
  const perTick = () => { const n = loadFilingSettings().drainCardsPerTick; return Number.isSafeInteger(n) && n > 0 ? n : 1; };
  const drainPendingStep = async () => {
    // Operator ruling 2026-10-20 (restore base reach, keep the new bounds): the pending slice is eligible WHENEVER the spool is
    // non-empty, independent of slot recovery or owed work. The base drained the spool in every state where a filing ran;
    // gating it on a recovered/empty slot lost that once the nested drain was skipped. The per-tick cap, deadline and
    // round-robin below are what bound it now.
    // An owed-first deferral (no lane) ends the tick's drain; an exhausted allowance must not even acquire.
    if (drainDeferred || counter.left <= 0) return;
    try {
      if (readdirSync(pendingDir).some(name => name.endsWith('.json'))) {
        // Filing paused by the operator is a visible state, not a failure (matches the owed step below).
        if (loadFilingSettings().filingEnabled === false) {
          results.push({ action: 'paused', step: 'drain', reason: 'prevention filing paused by prevention.filingEnabled' });
        } else if (clock() < deadlineAt) {
          const result = await drain({ drainPending: true, session: `card-batch-reconcile-${randomUUID()}` }, {
            pendingDir, write: line => log(line.trimEnd()),
            batch: (input, options) => batch(input, { ...options, stateDir }),
            drainLimit: { counter, deadlineAt, hardDeadlineAt, now: clock, cursorPath, acquireWaitMs: acquireWaitMs(), acquireWait: acquireWaitMs },
          });
          if (!result.ok) throw new Error(result.reason ?? 'pending drain failed');
          // No lane in time: this tick's drain is over (the owed step would only wait for the same pool).
          if (result.deferred) drainDeferred = true;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') results.push({ action: 'error', step: 'drain', reason: error.message });
    }
  };
  const drainOwedStep = async () => {
    if (loadFilingSettings().filingEnabled === false || clock() >= deadlineAt || drainDeferred || counter.left <= 0) return;
    try {
      const owed = await reconcileOwedPrevention({ stateDir, deadlineAt, hardDeadlineAt, now: clock, cursorPath, counter,
        file: input => fileOwed(input, { owedClaimed: true, loadFilingSettings, pendingDir, skipPendingDrain: true,
          drainLimit: { deadlineAt, hardDeadlineAt, now: clock }, acquireWait: acquireWaitMs,
          batch: (card, options) => batch(card, { ...options, stateDir }), write: line => log(line.trimEnd()) }),
      });
      for (const result of owed) {
        if (result.deferred && result.step === 'acquire-deferred') drainDeferred = true;
        else if (result.deferred) results.push({ action: 'deferred', step: 'owed', reason: result.step });
        else if (!result.ok) results.push({ action: 'error', step: 'owed', reason: result.reason });
      }
    } catch (error) { results.push({ action: 'error', step: 'owed', reason: error.message }); }
  };
  if (!dryRun) {
    counter.left = perTick();
    // Who goes first alternates by the stored turn (held in memory when it cannot be persisted), so neither is starved.
    const owedFirst = readDrainCursor(cursorPath).next === 'owed';
    for (const step of owedFirst ? [drainOwedStep, drainPendingStep] : [drainPendingStep, drainOwedStep]) await step();
    writeDrainCursor(cursorPath, { next: owedFirst ? 'pending' : 'owed' });
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
