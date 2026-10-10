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
 * So a card is never lost: every non-admission falls back to the path that already works.
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
import { admitCard, cardBatchStateDir } from './card-batch-io.mjs';
import { bypassesBatch } from '../lib/card-batch-policy.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { effectiveCardBatchPolicy, formatCardBatchSettings, loadCardBatchSettings } from '../lib/card-batch-settings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NOT_BATCHED_EXIT = 3;
const INTERACTIVE_ACTORS = new Set(['interactive', 'operator', 'human']);
const RETRYABLE = new Set(['lease-held', 'ff-reject']);

/** `false`, `'false'`, `'0'`, `'no'` opt out; anything else (including absent) leaves batching to the settings. */
const optedOut = (batch) => batch === false || ['false', '0', 'no'].includes(String(batch ?? '').trim().toLowerCase());

/** PURE: should this filing join the batch? */
export function decideBatchFiling({ batch, actor = 'mechanical', priority, settings, policy }) {
  if (optedOut(batch)) return { batch: false, reason: 'opt-out (--batch=false)' };
  if (INTERACTIVE_ACTORS.has(String(actor).toLowerCase())) return { batch: false, reason: `actor ${actor} files alone` };
  if (!settings.batchFiling) return { batch: false, reason: `cards.batchFiling is off (${settings.sources?.batchFiling ?? 'standard'})` };
  if (bypassesBatch({ priority }, policy.filing)) return { batch: false, reason: `priority ${priority} bypasses the batch` };
  return { batch: true, reason: 'mechanical filing' };
}

/** PURE: the card id a batch member is keyed by — the `<id>` of `backlog/<id>-<slug>.md`. */
export function cardIdOf(cardPath) {
  const match = /^backlog\/([^/-]+)-[^/]+\.md$/.exec(String(cardPath ?? ''));
  return match ? match[1] : null;
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).trim();

/** Start the detached seal worker: it opens/refreshes the batch PR and seals at the count limit. Never waits. */
export function launchSealJob(statePath, { spawn = spawnChild, open = openSync } = {}) {
  // The job's outcome goes to `<state>.seal.log`: a detached failure (live 2026-10-10: `unverified`) must be readable.
  let log = 'ignore';
  try { log = open(`${statePath}.seal.log`, 'a'); } catch { /* no log; the job still runs */ }
  const child = spawn(process.execPath, [join(ROOT, 'scripts/operations/card-batch-seal-job.mjs'), `--state=${statePath}`],
    { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
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
  settings = loadCardBatchSettings(), admit = admitCard, launch = launchSealJob, stateDir = cardBatchStateDir(),
  baseSha, log = (line) => console.error(line), retries = 5, pause = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  log(formatCardBatchSettings(settings));
  const policy = effectiveCardBatchPolicy(settings);
  const decision = decideBatchFiling({ batch, actor, priority, settings, policy });
  if (!decision.batch) return { batched: false, reason: decision.reason };
  const cardId = cardIdOf(cardPath);
  if (!cardId) return { batched: false, reason: `not a top-level backlog card: ${cardPath}` };
  try {
    const repo = source.repo ?? CONSTELLATION_REPOS.we.slug;
    const base = baseSha ?? (() => {
      try { git(laneDir, ['fetch', '--no-tags', '-q', 'origin', 'main']); } catch { /* fall back to the lane's last fetch */ }
      return git(laneDir, ['rev-parse', 'origin/main^{commit}']);
    })();
    const input = {
      kind, cardPath, cardId, idemKey: idemKey ?? `card:${cardId}`, baseSha: base, laneDir,
      source: { repo, pr: source.pr ?? null, head: source.head ?? null, note: source.note ?? null },
    };
    // Concurrent filers serialize on the coordinator's lease. An admission or body refresh holds it for seconds,
    // so a contended filer tries again a bounded number of times. A long hold (a seal running verify) outlasts
    // these attempts, and the card then takes its own PR, so it is never lost.
    let result = await admit(input, { stateDir, policy });
    for (let attempt = 1; attempt <= retries && result.action === 'refuse' && RETRYABLE.has(result.reason); attempt += 1) {
      await pause(2_000 * attempt);
      result = await admit(input, { stateDir, policy });
    }
    if (result.action === 'refuse') return { batched: false, reason: `coordinator refused: ${result.reason}` };
    const statePath = join(stateDir, `${repo.replaceAll('/', '-')}-${kind}.json`);
    launch(statePath);
    return { batched: true, batchRef: result.batchRef, member: result.member, statePath, deduped: result.action === 'dedupe' };
  } catch (error) {
    return { batched: false, reason: `admission failed: ${String(error?.message || error).split('\n')[0]}` };
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
