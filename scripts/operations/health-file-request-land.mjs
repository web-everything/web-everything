#!/usr/bin/env node
/**
 * @file scripts/operations/health-file-request-land.mjs
 * @description #4079 (health daemon slice 5, ruling #4065 clause 5) — THE LANE-BOUND LANDING PASS for a
 *   filing request the health tick planned (`scripts/conveyor/health-file-request.mjs#planFileRequests`).
 *   Leases its OWN lane, runs `file-item.mjs --queue=false` in it, verifies, opens a PR, then releases the
 *   lane — the health daemon's own resident clone is NEVER touched: every write below happens inside the
 *   freshly-acquired lane path this pass gets back from `lane-pool.mjs acquire`, never in `process.cwd()` or
 *   any ambient checkout.
 *
 * SHAPE — a PLAIN MODULE with injected IO plus a CLI block, NOT the declarative `op()` engine
 * (`scripts/operations/registry.mjs`). This mirrors the repo's own established precedent for "acquire a lane,
 * then run an imperative subprocess sequence with retries, synchronously, holding a lease": `poc-land.mjs`,
 * `scripts/conveyor/review-job.mjs`, `scripts/conveyor/review-dispatch.mjs`, `scripts/conveyor/probation-heal-run.mjs`,
 * and `scripts/conveyor/dispatch-abort.mjs` are five same-shaped instances, each citing the others for the same
 * reasoning: `op()`'s `effect` step is built for "declare ONE mutation, apply it once, replay-safe" or "start a
 * detached process and hand back a pollable handle" (`dispatch-lane.mjs`'s own `dispatch: true` pattern) — never
 * for a synchronous multi-stage acquire→run→commit→verify→open-pr→release arc with a held claim and bounded
 * retries. This is still "a lane-bound declared operation" in the spec's own sense: it is invoked as ONE
 * declared command (`node scripts/operations/health-file-request-land.mjs`), it is just not built on `op()`.
 *
 * IDEMPOTENCY / CRASH RECOVERY. Every ledger entry gets a STABLE `ref` (`refFor(episodeId)`) the moment it is
 * planned — fixed for the entry's whole life, never re-derived per attempt. That means:
 *   - `entry.pr` set → this request is DONE; a repeat call is a no-op (never repeats `file-item`/`open-pr`).
 *   - `entry.card` set but no `pr` → the card already exists — see `nextLandingStage`, which routes this
 *     attempt straight to `land-existing-card` (skip `file-item`/commit, go straight to verify/open-pr).
 *   - `entry.ref` is always the SAME string, so a retried `open-pr` targets the SAME PR — same-`--ref`
 *     idempotency is `we:scripts/pr-land.mjs`'s own guarantee (`open-pr` declares over it; see that file's own
 *     header for the mechanism), not something re-derived or re-asserted here.
 * EACH LANE IS EPHEMERAL AND STARTS FROM `main`, so `entry.card` set is not enough on its own: a fresh
 * `acquire` (no `--base`) resets to `origin/main`, which does NOT carry a previous attempt's local commit — a
 * lane released after `file-item`+commit but before a successful `open-pr` push loses that commit outright.
 * That is why the `file-and-land` stage, immediately after committing the card, PUSHES it to `entry.ref` on
 * `origin` (`git push --force origin HEAD:refs/heads/<ref>`) BEFORE running verify/open-pr — the durable
 * handoff point is that push succeeding, not the local commit. `landOne` only reports `card`/`cardFile` back
 * (even on a later failure) once that push has actually happened; a failure before it (e.g. `file-item`
 * itself failing) reports no card, so the next attempt correctly re-runs `file-item` instead of skipping it
 * for a card nothing durable backs. A `land-existing-card` retry then acquires its lane with `--base=entry.ref`
 * (`lane-pool.mjs acquire --base=<ref>` — resets to that ref's own pushed tip, not `origin/main`), so the
 * card is present in the fresh lane without ever re-running `file-item`.
 * A short-lived, lock-protected CLAIM (`health-file-request.mjs#claimForLanding`/`patchLedgerEntry`) makes two
 * concurrent invocations of this pass never land the SAME entry twice; a claim older than
 * `ATTEMPT_TIMEOUT_MS` is presumed abandoned (a crashed process) and reclaimable. This is a bounded, documented
 * mitigation, not a proof of exactly-once landing across every possible crash window — the residual gap (a
 * crash strictly between the durable push above and this attempt's OWN claim/patch write) is named as a
 * known, accepted, low-probability risk (the daily cap of 3 keeps the blast radius small) rather than solved
 * with heavier machinery this slice does not need.
 *
 * GATES RE-CHECKED AT LANDING TIME, not only at planning time (`fileDispatch` must still read `true`; no
 * `lane-starvation` episode may be open) — planning and landing can run minutes apart, and state can change
 * in between. FAILS CLOSED on an unreadable `state.json`: a missing/corrupt state file refuses to land
 * (`landingGateReason` below) rather than silently defaulting to "no episodes, nothing is starved" — the
 * opposite default would let filing proceed during exactly the lane-starvation window the gate exists to
 * catch, the one time `state.json` itself is most likely to be in a bad way (a killed tick mid-write).
 *
 * Usage:
 *   node scripts/operations/health-file-request-land.mjs [--state-root=DIR] [--json] [--dry-run] [--max=N]
 */
import { machinePrTitle } from './machine-pr-title.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readLedgerStrict, claimForLanding, patchLedgerEntry, spliceFilingSection, laneStarvationOpen,
} from '../conveyor/health-file-request.mjs';
import { healthDir } from '../conveyor/health-watch-section.mjs';
import { resolveChildTimeoutMs, resolveLaneAcquireTimeoutMs } from '../lib/bounded-child.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
// `--mode=label-on-green` BLOCKS until the required `test` CI check settles (often several minutes) — see
// `we:skills-src/conveyor/delivery-agent-brief.md` step 8's own note on this exact flag. 10 minutes, the same
// generous ceiling that brief gives a foreground caller of it, not the generic 5-minute child default.
const OPEN_PR_TIMEOUT_MS = 10 * 60 * 1000;

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE: which stage a claimed entry needs next. `entry.pr` is never true here — `claimForLanding` already
 *  refuses to claim an already-landed entry, so a caller only ever sees `file-and-land` or `land-existing-card`. */
export function nextLandingStage(entry) {
  return entry?.card ? 'land-existing-card' : 'file-and-land';
}

/** PURE: the global (not per-entry) gates re-checked immediately before landing anything this pass. */
export function landingGateReason(config, episodes) {
  if (config?.fileDispatch !== true) return 'filing dispatch is off (config `fileDispatch`)';
  if (laneStarvationOpen(episodes)) return 'a lane-starvation episode is open';
  return null;
}

function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }

/**
 * FAILS CLOSED on `state.json` (unlike the general-purpose `readJson` above, which is fine defaulting for
 * `config.json` — an unreadable config there already resolves to `fileDispatch: false`, i.e. gated, so THAT
 * fallback fails closed too, just via a different route). A missing/corrupt `state.json` must NOT resolve to
 * "no episodes", because `landingGateReason`'s whole job is refusing to land while a lane-starvation episode
 * is open — treating an unreadable state as empty state silently satisfies that check on exactly the
 * occasion it is least trustworthy (e.g. a tick killed mid-write). See {@link landPending}.
 * @returns {{ok:true, episodes:object}|{ok:false, reason:string}}
 */
function readStateForGate(dir) {
  const path = join(dir, 'state.json');
  if (!existsSync(path)) {
    return { ok: false, reason: 'state.json is missing — refusing to land (fail-closed; cannot confirm no lane-starvation episode is open)' };
  }
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    return { ok: false, reason: `state.json is corrupt — refusing to land (fail-closed): ${String(e?.message || e).split('\n')[0]}` };
  }
  return { ok: true, episodes: value?.episodes || {} };
}

// ── IO shell ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The ONE low-level subprocess primitive every effect below goes through — injected so tests can assert the
 *  exact `(cmd, args, cwd)` tuple of every call (proving lane-local paths are used, never the daemon clone's
 *  own cwd) without a single real subprocess running. */
export function runCmd(cmd, args, cwd, { timeoutMs = resolveChildTimeoutMs() } = {}) {
  return execFileSync(cmd, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
  });
}

/** `base`, when given, is a previously-PUSHED ref this lane should reset to instead of `origin/main` — the
 *  `land-existing-card` retry path uses it to recover a card commit a prior attempt already made durable (see
 *  the file header's IDEMPOTENCY / CRASH RECOVERY section). */
export function acquireLane(runFn = runCmd, { base } = {}) {
  const args = [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'acquire', '--purpose=health-file-request', '--json'];
  if (base) args.push(`--base=${base}`);
  return JSON.parse(runFn('node', args, REPO_ROOT, { timeoutMs: resolveLaneAcquireTimeoutMs() }));
}

export function releaseLane(acq, runFn = runCmd) {
  return runFn('node', [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'release', `--lane=${acq.lane}`, `--session=${acq.holder}`], REPO_ROOT);
}

/**
 * Offer a freshly committed card to the card batch (`./card-batch-file.mjs`, run from THIS clone so a daemon
 * overlay applies even before the lane's own copy lands). Returns `{batchRef}` when admitted, else null — a
 * non-zero exit (3 = not batched) or unreadable output means "take the per-card path".
 */
export function batchCard({ lane, cardFile, entry, runFn = runCmd }) {
  let out;
  try {
    out = runFn('node', [join(REPO_ROOT, 'scripts', 'operations', 'card-batch-file.mjs'), `--lane=${lane}`, `--card=${cardFile}`,
      `--note=health filing request ${entry.episodeId ?? entry.key ?? ''}`.trim(), '--json'], lane);
  } catch { return null; }
  try {
    const result = JSON.parse(String(out).trim().split('\n').pop());
    return result?.batched && result.batchRef ? { batchRef: result.batchRef } : null;
  } catch { return null; }
}

/**
 * Land ONE claimed entry. Every effect goes through `runFn` (default {@link runCmd}) — no other subprocess call
 * exists anywhere in this function, so a test can substitute a recording fake and assert every `(cmd, args,
 * cwd)` triple used a lane path, never `REPO_ROOT`/the daemon clone's own cwd (beyond the two lane-pool calls,
 * which are the only ones legitimately run from `REPO_ROOT` — acquiring/releasing a lane is not "editing the
 * daemon clone", it is the pool's own bookkeeping).
 * @returns {{status:'landed'|'failed', card?, cardFile?, pr?, prUrl?, batchRef?, error?}}
 */
export function landOne(entry, { runFn = runCmd, acquireFn = acquireLane, releaseFn = releaseLane } = {}) {
  const stage = nextLandingStage(entry);
  let acq = null;
  // Tracked OUTSIDE the try's local scope so the catch block can still report them: once the durable push
  // below succeeds, a LATER failure (verify/open-pr) must still hand the card/cardFile back so the ledger
  // patch (see `landPending`) keeps them — a fresh retry then correctly lands via `land-existing-card`
  // instead of re-running `file-item` for a card nothing durable backs.
  let card = entry.card;
  let cardFile = entry.cardFile;
  try {
    // `land-existing-card` resets the fresh lane to the PUSHED ref (not `origin/main`) so the card commit a
    // prior attempt already made durable is actually present here — see the file header's IDEMPOTENCY /
    // CRASH RECOVERY section. A lane leased plain, then released, remembers nothing: `lane-pool acquire`
    // with no `--base` always resets to `origin/main`.
    acq = acquireFn(runFn, stage === 'land-existing-card' ? { base: entry.ref } : {});
    const lane = acq.path;
    if (stage === 'file-and-land') {
      const out = runFn('node', [
        join(lane, 'scripts', 'operations', 'run.mjs'), 'file-item',
        `--title=${entry.title}`, `--digest=${entry.digest}`,
        `--scope=${(entry.scope || []).join(',')}`, `--size=${entry.size}`,
        '--queue=false', '--json',
      ], lane);
      let verdict;
      try { verdict = JSON.parse(out)?.verdict ?? JSON.parse(out); } catch { verdict = null; }
      const filedCard = verdict?.num ?? null;
      const filedCardFile = verdict?.rel ?? null;
      if (!filedCardFile) throw new Error(`health-file-request-land: file-item did not report a filed card path (${out.slice(0, 500)})`);
      runFn('git', ['add', '--', filedCardFile], lane);
      runFn('git', ['commit', '-m', `${machinePrTitle({ item: filedCard, kind: 'file', card: entry })}\n\nFiled by the health daemon's lane-bound landing pass (#4079); uncleared (--queue=false).\n`], lane);
      // CARD BATCH (operator go 2026-10-10): a mechanical filing joins the rolling card-only batch PR instead of
      // opening its own. Admission makes the card durable on the batch ref, so the per-card push below is skipped.
      // Any non-admission (setting off, refusal, error) falls through to the per-card path unchanged.
      const batched = batchCard({ lane, cardFile: filedCardFile, entry, runFn });
      if (batched) return { status: 'landed', card: filedCard, cardFile: filedCardFile, pr: null, prUrl: null, batchRef: batched.batchRef };
      // THE DURABLE HANDOFF POINT (#4079 review round 1, finding 1): push the commit to `entry.ref` on origin
      // BEFORE verify/open-pr can fail and strand it in a lane that gets hard-reset to `origin/main` on its
      // next acquire. `card`/`cardFile` (the outer, catch-visible variables) are only promoted AFTER this
      // push actually succeeds — if the push itself throws, they stay at their entry value (null on a first
      // attempt), so a later retry correctly re-runs `file-item` instead of trusting a card nothing durable
      // backs yet.
      runFn('git', ['push', '--force', 'origin', `HEAD:refs/heads/${entry.ref}`], lane);
      card = filedCard;
      cardFile = filedCardFile;
    }
    // Foreground verify — the lane-verify marker `pr-land`'s finish-guard requires (same convention every
    // other lane-bound pass in this repo uses; see orphan-claim-release.mjs).
    runFn('node', [join(lane, 'scripts', 'operations', 'run.mjs'), 'verify', `--checkout=${lane}`], lane, { timeoutMs: VERIFY_TIMEOUT_MS });
    const bodyFile = join(lane, '.git', 'health-file-request-body.md');
    writeFileSync(bodyFile, renderPrBody(entry, card));
    // `--mode=label-on-green` (#4079 live-proof review — the un-flagged call defaults to `open-pr`'s OWN
    // default, `mode: 'park'`, parked `review:pending`, which would strand every filed card awaiting a human
    // forever and defeat the point of an autonomous, capped filing pass). This is the SAME producer mode the
    // delivery-agent brief's own step 8 uses: it opens the self-approved PR, waits for the required `test`
    // check, and labels `ready-to-merge` ONLY once green — the producer's own review rubric can still park a
    // genuinely statute-touching or cross-repo change regardless of this flag, so it never bypasses that.
    const out = runFn('node', [
      join(lane, 'scripts', 'operations', 'run.mjs'), 'open-pr',
      `--ref=${entry.ref}`, '--sha=HEAD', '--base=main', `--bodyFile=${bodyFile}`, '--mode=label-on-green', '--json',
    ], lane, { timeoutMs: OPEN_PR_TIMEOUT_MS });
    const { pr, url } = parseOpenPrResult(out);
    return { status: 'landed', card, cardFile, pr, prUrl: url };
  } catch (e) {
    return { status: 'failed', card, cardFile, error: String(e?.stderr || e?.message || e).trim().split('\n')[0] };
  } finally {
    if (acq) { try { releaseFn(acq, runFn); } catch { /* the lease reaper reclaims it once it is unpaused */ } }
  }
}

/**
 * The declared `open-pr` operation's `--json` output is the RUN RECORD's own shape (`{runId, op, stopped,
 * verdict, findings, …}` — `we:scripts/operations/cli-adapter.mjs#outcomePayload`), not `{pr, url}` at the
 * top level: `open-pr`'s `verdictFrom` is `'plan'` (the PRE-submit plan), so the actual result lives under
 * `findings.submit.effects[].result` (#4079 live-proof review — a naive `JSON.parse(out).pr` silently read
 * `undefined` every time, so `patchLedgerEntry`'s `entry.pr` was never actually set and the ledger's own
 * "already landed" no-op check — keyed on `entry.pr` — could never fire; PR #2877 was this bug's live catch).
 * Tolerant of a non-JSON or unexpected shape: returns `{pr:null, url:null}` rather than throwing, since a
 * malformed result here must not stop the ledger patch that DOES have real card/cardFile data to record.
 */
export function parseOpenPrResult(out) {
  try {
    const parsed = JSON.parse(out);
    const effects = parsed?.findings?.submit?.effects;
    const applied = Array.isArray(effects) ? effects.find((e) => e?.type === 'open-pr.submit' && e?.status === 'applied') : null;
    const result = applied?.result;
    return { pr: result?.pr ?? null, url: result?.url ?? null };
  } catch {
    return { pr: null, url: null };
  }
}

function renderPrBody(entry, card) {
  return [
    `## Health daemon filing request (#4079)`,
    '',
    `Episode: \`${entry.episodeId}\` — smell \`${entry.smell}\` on \`${entry.subject}\`.`,
    '',
    entry.digest,
    '',
    `Filed **uncleared** (\`--queue=false\`) as card #${card ?? entry.card}. It is cleared through the normal readiness`,
    'path, never auto-cleared by this pass.',
    '',
  ].join('\n');
}

/**
 * Land every claimable entry, one at a time (never two lanes open for this pass concurrently — mirrors
 * `orphan-claim-release.mjs`'s own "one PR at a time" rule), up to `max`. Re-checks the global gates before
 * EACH entry — a FRESH read of `config.json`/`state.json` every iteration, not a snapshot taken once before
 * the loop (#4079 review round 3, standards-conformance finding: a stale snapshot would make this doc's own
 * claim false — a lane-starvation episode opening mid-pass, or the operator flipping `fileDispatch` off,
 * would go unnoticed for the REST of a pass whose individual landings can each take many minutes).
 */
export function landPending({
  dir, now = Date.now(), max = 3, dryRun = false, runFn = runCmd, acquireFn = acquireLane, releaseFn = releaseLane,
} = {}) {
  const results = [];
  // Keys this PASS already tried and could not claim (in-flight elsewhere, or vanished from the ledger) — never
  // reconsidered within the same call (#4079 review round 1, finding 9). Without this, `candidate` below is
  // always "the first non-terminal entry", so a single live in-flight claim gets re-selected and skipped up
  // to `max` times in a row, burning the whole pass's budget on one entry and starving every OTHER entry
  // behind it in the ledger.
  const skipped = new Set();
  for (let i = 0; i < max; i += 1) {
    const config = { fileDispatch: false, ...readJson(join(dir, 'config.json'), {}) };
    const stateRead = readStateForGate(dir);
    const gate = (config.fileDispatch === true && !stateRead.ok)
      ? stateRead.reason
      : landingGateReason(config, stateRead.ok ? stateRead.episodes : {});
    if (gate) { results.push({ status: 'gated', reason: gate }); break; }
    const ledger = readLedgerStrict(dir);
    const candidate = ledger.find((e) => !e.pr && !skipped.has(e.key) && (e.status === 'pending' || e.status === 'landing'));
    if (!candidate) break;
    if (dryRun) { results.push({ status: 'would-land', key: candidate.key }); break; }
    const { claimed, reason } = claimForLanding(dir, candidate.key, now);
    if (!claimed) { results.push({ status: 'skipped', key: candidate.key, reason }); skipped.add(candidate.key); continue; }
    const outcome = landOne(claimed, { runFn, acquireFn, releaseFn });
    const patch = outcome.status === 'landed'
      ? { status: 'landed', card: outcome.card, cardFile: outcome.cardFile, pr: outcome.pr, prUrl: outcome.prUrl, landedAt: now,
        ...(outcome.batchRef ? { batchRef: outcome.batchRef } : {}) }
      : { status: 'pending', card: outcome.card ?? claimed.card, cardFile: outcome.cardFile ?? claimed.cardFile };
    const patched = patchLedgerEntry(dir, claimed.key, claimed.attemptId, patch);
    if (patched) {
      const reportPath = join(dir, 'episodes', `${patched.episodeId}.md`);
      try { spliceFilingSection(reportPath, patched); } catch { /* retried next pass */ }
    }
    results.push({ status: outcome.status, key: claimed.key, card: patched?.card ?? null, pr: patched?.pr ?? null, error: outcome.error });
    // A failed entry is skipped for the REST of this pass, never re-selected (#4079 review round 2, correctness
    // finding: `break` here head-of-line-blocks every OTHER entry behind a single permanently-failing one —
    // e.g. a red gate on ONE card would starve two perfectly landable ones every pass, forever). It stays
    // `pending` on the ledger (see `patch` above), so a LATER pass still retries it fresh — just never twice
    // in the SAME pass, and never at the cost of the other entries `max` was meant to cover.
    if (outcome.status === 'failed') skipped.add(claimed.key);
  }
  return { results };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return flags;
}

const IS_CLI = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_CLI) {
  const flags = parseFlags(process.argv.slice(2));
  const dir = healthDir(flags['state-root']);
  const max = Number(flags.max) > 0 ? Number(flags.max) : 3;
  const report = landPending({ dir, max, dryRun: !!flags['dry-run'] });
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else for (const r of report.results) process.stdout.write(`${r.status}${r.key ? ` ${r.key}` : ''}${r.error ? ` — ${r.error}` : ''}\n`);
  process.exitCode = report.results.some((r) => r.status === 'failed') ? 1 : 0;
}
