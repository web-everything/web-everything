#!/usr/bin/env node
/**
 * @file scripts/operations/card-batch-file.mjs
 * @description Put ONE freshly filed card into the rolling card-only batch PR instead of opening its own PR
 *   (operator go 2026-10-10; epic #4703, filing kind).
 *
 * A mechanical filer runs `file-item` in its lane as before, then calls {@link fileIntoBatch} with the card path
 * INSTEAD of `verify` + `open-pr`. The card is appended as one commit to the shared `lane/card-batch-filing-<n>`
 * ref by the existing coordinator (`./card-batch-io.mjs#admitCard`: per-kind lease, expected-head check,
 * fast-forward-only push, idempotent by key). A detached seal job (`./card-batch-seal-job.mjs`) then opens the
 * held draft PR or refreshes its body, and seals it when it reaches `cards.batchMaxCards`. The health-watch tick
 * seals it at `cards.batchMaxMinutes`. A card admitted after a seal starts the next batch.
 *
 * When it does NOT batch — `{batched:false, reason}` — the caller keeps its ordinary per-card PR path:
 *   - `batch` is `false` (an operator's `--batch=false`), or the actor is interactive;
 *   - `cards.batchFiling` is off (settings cascade: `we:scripts/lib/card-batch-settings.mjs`);
 *   - the card's priority is high/urgent and the policy's `highPriorityBypass` is on;
 *   - the coordinator refuses (lease held, head mismatch, ineligible change, duplicate card…) or throws.
 * Prevention results additionally expose `disabled:true` for policy opt-outs / non-card paths,
 * or `retryable:true` for coordinator refusals / errors: prevention callers spool the latter.
 * Ordinary filing callers retain their existing result shape and fallback behavior.
 *
 * CLI (for agents filing through the `file-item` skill):
 *   node scripts/operations/card-batch-file.mjs --lane=<lane> --card=backlog/<id>-<slug>.md \
 *     [--source-pr=<n>] [--source-head=<sha>] [--note=<text>] [--batch=false] [--actor=interactive] [--json]
 *   Exit 0 when batched; exit 3 when not batched (the caller then opens its own PR); exit 1 on a usage error.
 */
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admitCard, cardBatchStateDir, sealJobEnv } from './card-batch-io.mjs';
import { STEP_MIN_MS, budgetError, isBudgetError } from '../lib/tick-deadline.mjs';
import { bypassesBatch } from '../lib/card-batch-policy.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { effectiveCardBatchPolicy, formatCardBatchSettings, loadCardBatchSettings, formatPreventionBatchSettings, loadPreventionBatchSettings } from '../lib/card-batch-settings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NOT_BATCHED_EXIT = 3;
const INTERACTIVE_ACTORS = new Set(['interactive', 'operator', 'human']);
const RETRYABLE = new Set(['lease-held', 'ff-reject']);

/** `false`, `'false'`, `'0'`, `'no'` opt out; anything else (including absent) leaves batching to the settings. */
const optedOut = (batch) => batch === false || ['false', '0', 'no'].includes(String(batch ?? '').trim().toLowerCase());

/** PURE: should this filing join the batch? */
export function decideBatchFiling({ batch, actor = 'mechanical', priority, settings, policy, kind = 'filing', preventionSettings }) {
  const activeSettings = kind === 'prevention' ? preventionSettings : settings;
  const namespace = kind === 'prevention' ? 'prevention' : 'cards';
  if (optedOut(batch)) return { batch: false, reason: 'opt-out (--batch=false)' };
  if (INTERACTIVE_ACTORS.has(String(actor).toLowerCase())) return { batch: false, reason: `actor ${actor} files alone` };
  if (!activeSettings.batchFiling) return { batch: false, reason: `${namespace}.batchFiling is off (${activeSettings.sources?.batchFiling ?? 'standard'})` };
  if (bypassesBatch({ priority }, policy[kind])) return { batch: false, reason: `priority ${priority} bypasses the batch` };
  return { batch: true, reason: 'mechanical filing' };
}

/** PURE: the card id a batch member is keyed by — the `<id>` of `backlog/<id>-<slug>.md`. */
export function cardIdOf(cardPath) {
  const match = /^backlog\/([^/-]+)-[^/]+\.md$/.exec(String(cardPath ?? ''));
  return match ? match[1] : null;
}

const git = (cwd, args, timeout) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}) }).trim();

/** Start the detached seal worker: it opens/refreshes the batch PR and seals at the count limit. Never waits. */
export function launchSealJob(statePath, { spawn = spawnChild, open = openSync } = {}) {
  // The job's outcome goes to `<state>.seal.log`: a detached failure (live 2026-10-10: `unverified`) must be readable.
  let log = 'ignore';
  try { log = open(`${statePath}.seal.log`, 'a'); } catch { /* no log; the job still runs */ }
  const child = spawn(process.execPath, [join(ROOT, 'scripts/operations/card-batch-seal-job.mjs'), `--state=${statePath}`],
    { cwd: ROOT, detached: true, stdio: ['ignore', log, log], env: sealJobEnv() });
  if (typeof log === 'number') { try { closeSync(log); } catch { /* the child holds its own copy */ } }
  child.on?.('error', () => {}); // the health-watch tick relaunches a batch whose PR or seal is still owed
  child.unref?.();
}

/**
 * Admit one filed card. `laneDir` is the lane where `file-item` wrote it (committed or not — the coordinator reads
 * the working-tree bytes). Returns `{batched:true, batchRef, member, statePath}` or `{batched:false, reason}`.
 */
export async function fileIntoBatch({
  laneDir, cardPath, source = {}, batch, actor, priority, idemKey, kind = 'filing',
}, {
  settings = loadCardBatchSettings(), preventionSettings = loadPreventionBatchSettings(), admit = admitCard, launch = launchSealJob, stateDir = cardBatchStateDir(),
  baseSha, log = (line) => console.error(line), retries = 5, pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  // In-tick callers pass `deadline` ({left()}): the lease wait, the fetch and every git call in the admission are capped at the time
  // left, and a card the remaining time cannot cover is refused as retryable (the caller keeps it in the spool / owed).
  deadline,
} = {}) {
  log(kind === 'prevention' ? formatPreventionBatchSettings(preventionSettings) : formatCardBatchSettings(settings));
  const policy = effectiveCardBatchPolicy(settings, preventionSettings);
  const decision = decideBatchFiling({ batch, actor, priority, settings, preventionSettings, policy, kind });
  if (!decision.batch) return { batched: false, reason: decision.reason, ...(kind === 'prevention' ? { disabled: true } : {}) };
  const cardId = cardIdOf(cardPath);
  if (!cardId) return { batched: false, reason: `not a top-level backlog card: ${cardPath}`, ...(kind === 'prevention' ? { disabled: true } : {}) };
  // Checked before ANY git call (fetch / rev-parse included): an expired budget starts nothing.
  if (deadline && deadline.left() < STEP_MIN_MS.admit) return { batched: false, retryable: true, reason: 'tick budget exhausted before admission' };
  try {
    const repo = source.repo ?? CONSTELLATION_REPOS.we.slug;
    const base = baseSha ?? (() => {
      // In-tick each call is refused once the budget is gone (no fresh floor), capped at the time left, and killed with SIGKILL.
      const cap = (max) => { if (!deadline) return undefined; if (deadline.left() < 1_000) throw budgetError('git'); return Math.min(max, deadline.left()); };
      try { git(laneDir, ['fetch', '--no-tags', '-q', 'origin', 'main'], cap(30_000)); } catch (error) { if (isBudgetError(error)) throw error; /* else fall back to the lane's last fetch */ }
      return git(laneDir, ['rev-parse', 'origin/main^{commit}'], cap(Infinity));
    })();
    const input = {
      kind, cardPath, cardId, idemKey: idemKey ?? `card:${cardId}`, baseSha: base, laneDir,
      source: { repo, pr: source.pr ?? null, head: source.head ?? null, note: source.note ?? null },
    };
    // Concurrent filers serialize on the coordinator's lease. An admission or body refresh holds it for seconds,
    // so a contended filer tries again a bounded number of times. A long hold (a seal running verify) outlasts
    // these attempts, and the caller decides how to retain the refused card (prevention filers spool it).
    if (deadline && deadline.left() < STEP_MIN_MS.admit) return { batched: false, retryable: true, reason: 'tick budget exhausted before admission' };
    const admitOptions = { stateDir, policy, ...(deadline ? { deadline } : {}) };
    let result = await admit(input, admitOptions);
    for (let attempt = 1; attempt <= retries && result.action === 'refuse' && RETRYABLE.has(result.reason); attempt += 1) {
      // The lease wait is min(configured, time left): no further attempt once another one cannot fit.
      // The gap itself must fit too, so no sleep can run past the deadline however many retries are configured.
      if (deadline && deadline.left() < STEP_MIN_MS.admit + 2_000 * attempt + 1_000) break;
      await pause(2_000 * attempt);
      if (deadline && deadline.left() < STEP_MIN_MS.admit) break;
      result = await admit(input, admitOptions);
    }
    if (result.action === 'refuse') return { batched: false, reason: `coordinator refused: ${result.reason}`, ...(kind === 'prevention' ? { retryable: true } : {}) };
    const statePath = join(stateDir, `${repo.replaceAll('/', '-')}-${kind}.json`);
    launch(statePath);
    return { batched: true, batchRef: result.batchRef, member: result.member, statePath, deduped: result.action === 'dedupe' };
  } catch (error) {
    return { batched: false, ...(kind === 'prevention' ? { retryable: true } : {}), reason: `admission failed: ${String(error?.message || error).split('\n')[0]}${String(error?.stderr ?? '').trim() ? ` — ${String(error.stderr).trim().split('\n')[0]}` : ''}` };
  }
}

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) flags[match[1]] = match[2] ?? true;
  }
  return flags;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const flags = parseFlags(argv);
  if (!flags.lane || !flags.card) {
    console.error('usage: card-batch-file.mjs --lane=<lane dir> --card=backlog/<id>-<slug>.md [--batch=false] [--actor=interactive] [--json]');
    return { code: 1 };
  }
  const result = await fileIntoBatch({
    laneDir: resolve(String(flags.lane)), cardPath: String(flags.card), batch: flags.batch, actor: flags.actor,
    priority: flags.priority, idemKey: flags['idem-key'],
    source: { pr: flags['source-pr'] ?? null, head: flags['source-head'] ?? null, note: flags.note ?? null },
  }, deps);
  console.log(flags.json ? JSON.stringify(result) : result.batched
    ? `batched ${basename(String(flags.card))} into ${result.batchRef}${result.deduped ? ' (already a member)' : ''}`
    : `not batched (${result.reason}) — open the card's own PR`);
  return { code: result.batched ? 0 : NOT_BATCHED_EXIT, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(({ code }) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
