#!/usr/bin/env node
/**
 * review-runner.mjs — the scheduled SHADOW review runner (#2830, the front slice of #2572, under epic #2612).
 * THE TRIGGER that removes the human from routing `review:pending` PRs to review — but in SHADOW: it observes and
 * logs what it WOULD do, and mutates NOTHING.
 *
 * WHY (the #2830 / #2572 gap): a PR at `review:pending` with green CI should be picked up mechanically and
 * disposed — cleared to `review:accepted` on a clean converged jury verdict, or kept parked for a human — with NO
 * human trigger. Tonight #974 and #975 sat at `review:pending` forever waiting for a person, stalling the
 * conveyor. The convergence LOOP that produces a verdict is already built (`review-parked-prs.mjs` #2639) and the
 * disposition→label→land SEAMS are already built (#2674/#2675). What was missing is the INDEPENDENT, scheduled
 * process that fires them — this runner. It is #2439 actor-independence made concrete: a distinct process fired
 * by a schedule, NOT by the builder and NOT inside the resident drain daemon (which is review-blind by design and
 * is the sole main-writer). This slice ships the SHADOW half: it clears nothing; the enforce flip is a separate
 * ratified step (#2572 part 2).
 *
 * WHAT IT DOES (all read-only against GitHub):
 *   1. DISCOVER the `review:pending` parked PRs (`gh pr list --state open`, filtered client-side by label —
 *      never `--label`, which is search-backed and rate-limits separately; #no-label-search), or look up an explicit
 *      set, and re-read each one's CURRENT labels — then `partitionRunnerPRs` drops every `review:human` /
 *      label-unverifiable PR fail-closed (INVARIANT 2 / #2439). It never trusts caller-asserted labels.
 *   2. For each clearable PR, OBTAIN its converged jury LEDGER. The #2639 loop persists its ledger to the durable
 *      append-only jury log (`jury-ledger.mjs`, #2641) — the #2612 single source of truth. The SHADOW runner
 *      READS that log (read-only): it does NOT run the mutating editor rounds itself (those push revisions to PR
 *      branches — a mutation shadow must not do). A PR with no persisted ledger yet folds to an empty ledger,
 *      which the seams treat FAIL-CLOSED (no roster / no verdicts → keep parked). The `loadLedger` seam is
 *      injectable so the enforce-era wiring can point it at a live convergence dispatch instead.
 *   3. Run the ledger through the EXISTING seams IN SHADOW (`runnerShadowPlan`, mode hard-coded to SHADOW) → a
 *      plan of what it WOULD do (clear / keep-parked) that applies NOTHING, and emit a structured shadow-log
 *      record per PR (`buildShadowRecord`), also appended best-effort to the verdict ledger as non-bearing
 *      `observed` rows marked `mode: shadow` (#3217). Only local observation storage changes.
 *
 * SINGLETON-LOCKED (daemon parity): the runner takes an exclusive, TTL-leased singleton lock (the SAME atomic
 * `O_EXCL`/reclaim primitive the resident drain daemon's lease uses, `we:scripts/readiness/file-locks.mjs`) under
 * its OWN machine-global lock root so two scheduled runs never double-dispose the same PR. A second run that
 * finds a LIVE lease no-ops (exit 0); a crashed run's lease self-reclaims via the TTL. Idempotent + safe to run
 * repeatedly: a single read-only pass, then release.
 *
 * SAFETY — this runner writes NO label, posts NO comment, merges NOTHING, and pushes to NO branch. It composes
 * only PURE deciders (`runnerShadowPlan` forces shadow and never reaches a writer) and makes only read-only `gh`
 * calls. `--enforce` is deliberately REFUSED: flipping to act is a separate ratified step, not a flag on this
 * mechanical slice.
 *
 * Usage:
 *   node scripts/review-runner.mjs                       # discover review:pending PRs and shadow-dispose each
 *   node scripts/review-runner.mjs 974 975 983           # shadow-dispose an explicit set (labels re-read fresh)
 *   node scripts/review-runner.mjs --json                # machine-readable shadow log on stdout
 *   node scripts/review-runner.mjs --repo=web-everything/web-everything   # override the discovery repo (default: WE)
 *   node scripts/review-runner.mjs --no-lock             # skip the singleton lease (tests / a forced re-run)
 *
 * Exit codes: 0 = a pass ran (or a live runner already held the lease — a benign no-op); 2 = usage error
 * (`--enforce`, or a discovery/gh failure that left nothing to do). A per-PR error never aborts the batch.
 */
import { readGh } from './lib/proc-read.mjs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { mkdirSync } from 'node:fs';
import {
  reserve, readLockEntry, releaseLockDir, DEFAULT_LEASE_MINUTES,
} from './readiness/file-locks.mjs';
import { resolveDispositionConfig } from './lib/review-policy.mjs';
import { readJuryLog } from './lib/jury-ledger.mjs';
import { repoKeyForSlug, CONSTELLATION_REPOS } from './lib/constellation-repos.mjs';
import { appendVerdict, buildVerdictRecord, VERDICTS } from './lib/verdict-ledger.mjs';
import {
  partitionRunnerPRs, runnerShadowPlan, buildShadowRecord,
} from './lib/review-runner-core.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
import { OPEN_PR_LIST_LIMIT, filterOpenPrsByLabel } from './lib/no-search-backed-pr-list.mjs';

// ── singleton lease (daemon parity — its OWN lock root/key so it never aliases the drain lease) ───────────────
/** Machine-global lock home for the review runner — shared across checkouts on the host so two scheduled runs
 *  (a cron pass + a hand run) contend on the SAME lock. Local-only, never committed/pushed (Rule #105). */
export const RUNNER_LOCK_ROOT = join(homedir(), '.claude', 'review-runner-locks');
/** The fixed sentinel "path" file-locks keys the singleton lock dir by (distinct string ⇒ distinct lock dir). */
export const RUNNER_LEASE_PATH = '<review-runner:singleton>';
/** A read-only pass is seconds; the TTL only needs to outlast a slow pass and self-reclaim a crash. Mirrors the
 *  daemon lease default (15 min). */
export const RUNNER_LEASE_MINUTES = DEFAULT_LEASE_MINUTES;
/** A stable per-process owner id (host:pid:kind) — the SAME string acquires and releases. Exported so a test can
 *  prove the acquire/release owner-match round-trips (a drift in this format would make release a silent no-op). */
export function runnerOwner() { return `${hostname()}:${process.pid}:review-runner`; }

const DEFAULT_REPO_SLUG = CONSTELLATION_REPOS.we.slug;

// ── tiny flags parser (matches review-core-cli.mjs) ───────────────────────────────────────────────────────────
function parseFlags(argv) {
  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return { flags, positionals };
}

/** Read-only `gh pr list` of the review:pending PRs for a repo → `[{pr, repo, labels}]`. `repoKey` is the internal
 *  constellation key (`we`/`frontierui`/…) the ledger subject is keyed by — derived from the `--repo` slug through
 *  the shared mapper, NEVER hard-coded (#2830 M3). A gh failure returns `null` (the caller reports it), never a
 *  partial/guessed set. */
function discoverPending(repoSlug, repoKey) {
  try {
    // #no-label-search (2026-09-27 live incident) — `--label` on `gh pr list` is served by GitHub's issue-SEARCH
    // index, a separate, much smaller budget than the ordinary GraphQL list this call already is; filtering
    // server-side by label routinely tripped "API rate limit already exceeded" even with GraphQL budget to
    // spare. `labels` is already requested below, so filter client-side instead of passing `--label`.
    // The cap now bounds the RAW open-PR list (not a pre-filtered set), so list at the shared OPEN_PR_LIST_LIMIT
    // and surface a full page loudly — a `review:pending` PR past it would otherwise go silently unreviewed.
    const out = execFileSync('gh', [
      'pr', 'list', '--repo', repoSlug, '--state', 'open',
      '--json', 'number,labels', '--limit', String(OPEN_PR_LIST_LIMIT),
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const { prs, truncated } = filterOpenPrsByLabel(JSON.parse(out), 'review:pending');
    if (truncated) process.stderr.write(`review-runner ⚠ ${repoSlug}: the open-PR listing hit the --limit ${OPEN_PR_LIST_LIMIT} cap — it MAY be truncated, so a review:pending PR past it can be missing from this discovery (#no-label-search)\n`);
    return prs
      .map((r) => ({
        pr: r.number, repo: repoKey, labels: labelNamesOf(r.labels),
      }));
  } catch {
    return null;
  }
}

/** Re-read the CURRENT labels for an explicit PR set (never trust the number alone) → `[{pr, repo, labels?}]`.
 *  `repoKey` is the internal constellation key (#2830 M3). A PR that cannot be read is emitted WITHOUT a `labels`
 *  key (`{pr, repo}`) so the partition routes it to the fail-closed `skippedUnverified` bucket and REPORTS it —
 *  a deleted / private / rate-limited PR is distinguishable from one never requested (#2830 minor), and it is
 *  still never acted on (no labels array ⇒ unverified ⇒ never cleared). */
function lookupLabels(prNumbers, repoSlug, repoKey) {
  const out = [];
  for (const n of prNumbers) {
    try {
      const view = execFileSync('gh', [
        'pr', 'view', String(n), '--repo', repoSlug, '--json', 'number,labels',
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const parsed = JSON.parse(view);
      out.push({ pr: parsed.number, repo: repoKey, labels: labelNamesOf(parsed.labels) });
    } catch {
      // unreadable — emit with NO labels key so it surfaces as skippedUnverified (reported, never acted on).
      out.push({ pr: Number(n), repo: repoKey });
    }
  }
  return out;
}

/** Map a raw gh labels array (objects `{name}` or strings) to a plain name array. */
function labelNamesOf(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
}

/** The default LEDGER seam — read the durable append-only jury log the #2639 convergence loop persists (#2641).
 *  Read-only. Injectable so the enforce-era wiring can swap in a live convergence dispatch. */
function loadLedgerFromDurableLog(subject) {
  try { return readJuryLog(subject); } catch { return []; }
}

/** Acquire the singleton lease. `{ ok, reason, heldBy }` — `ok:false, reason:'held'` ⇒ a live runner holds it. The
 *  `root` is injectable (default: the machine-global lock root) so a test can exercise the protocol against a temp
 *  dir instead of the real `~/.claude` home. Exported for that test. */
export function acquireLease(owner, nowMs = Date.now(), root = RUNNER_LOCK_ROOT) {
  try { mkdirSync(root, { recursive: true }); } catch { /* reserve self-heals a missing root */ }
  return reserve(
    root, RUNNER_LEASE_PATH, owner, nowMs, new Date(nowMs).toISOString(),
    process.pid, 'unknown', RUNNER_LEASE_MINUTES,
  );
}

/** Release the singleton lease, but ONLY if `owner` still holds it (never stomp a reclaimer). Idempotent. `root`
 *  is injectable for the same reason as `acquireLease`. Returns true iff it actually released. Exported for test. */
export function releaseLease(owner, root = RUNNER_LOCK_ROOT) {
  const cur = readLockEntry(root, RUNNER_LEASE_PATH);
  if (cur && cur.owner === owner) { releaseLockDir(root, RUNNER_LEASE_PATH); return true; }
  return false;
}

/**
 * Run one SHADOW pass over the given (already partitioned) clearable PRs. PURE-ish: I/O is confined to the
 * injected `loadLedger` seam (default: the durable jury log). Returns the shadow-log records. Never throws on a
 * per-PR error — it surfaces that PR as a fail-closed keep-parked record and continues.
 * @param {Array<{pr:number,repo:string,labels:Array}>} clearable
 * @param {object} config - the resolved #2651 disposition config
 * @param {(subject:string)=>Array<object>} loadLedger
 */
export function runShadowPass(clearable, config, loadLedger = loadLedgerFromDurableLog) {
  const records = [];
  for (const item of clearable) {
    const subject = `${item.repo}#${item.pr}`;
    let ledger = [];
    try { ledger = loadLedger(subject) || []; } catch { ledger = []; }
    const { intent, plan } = runnerShadowPlan({ ledger, config, currentLabels: item.labels });
    records.push(buildShadowRecord({ item, ledger, intent, plan }));
  }
  return records;
}

/** Persist observations through the verdict ledger's single writer. Per-row failures, including refused
 * records, never abort the pass or suppress its report. The injected writer supports failure-path probes. */
export function appendShadowRecords(records, repo, append = appendVerdict) {
  for (const r of records) {
    try {
      if (r.mode !== 'shadow' || r.applied !== false || r.mutated !== false) {
        throw new TypeError('not an unapplied shadow observation');
      }
      const result = append(buildVerdictRecord({
        repo, pr: r.pr, at: new Date().toISOString(), verdict: VERDICTS.OBSERVED,
        mode: 'shadow', wouldClear: r.wouldClear, reason: r.reason,
        findingCount: r.outstandingFindings, source: 'review-runner', channel: 'shadow',
      }));
      if (!result.ok) throw new Error(result.errors.join('; '));
    } catch (e) {
      try {
        process.stderr.write(`review-runner: verdict-ledger append failed for ${r.subject} (shadow, non-fatal) — ${String((e && e.message) || e)}\n`);
      } catch { /* even a closed stderr must not cost the shadow report */ }
    }
  }
}

// ── the CLI (gated on direct invocation) ──────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) main(process.argv.slice(2));

function main(argv) {
  const { flags, positionals } = parseFlags(argv);
  const asJson = !!flags.json;
  const repoSlug = typeof flags.repo === 'string' && flags.repo ? flags.repo : DEFAULT_REPO_SLUG;

  // `--enforce` is REFUSED — this mechanical slice is shadow-only; the act flip is a separate ratified step.
  if (flags.enforce) {
    writeAllSync(1, `${JSON.stringify({ error: 'review-runner is SHADOW-only — enforcing (auto-clearing) is a separate ratified step (#2572 part 2), not a flag here' })}\n`);
    return process.exit(2);
  }

  // Derive the INTERNAL repo key from the --repo SLUG through the shared mapper — the ledger subject is keyed by
  // key (`${key}#${pr}`), never the slug. Fail-CLOSED on an unknown slug rather than silently keying it `we` (the
  // #2830 M3 defect: `--repo=…frontierui` reading a FrontierUI PR but folding the WE ledger).
  const repoKey = repoKeyForSlug(repoSlug);
  if (!repoKey) {
    writeAllSync(1, `${JSON.stringify({ error: `review-runner: --repo=${repoSlug} is not a known constellation repo (slug or key) — refusing to guess its ledger key` })}\n`);
    return process.exit(2);
  }

  const owner = runnerOwner();
  const useLock = !flags['no-lock'];
  let holding = false;
  if (useLock) {
    const acq = acquireLease(owner);
    if (!acq.ok) {
      // A live runner already holds the lease → benign no-op (idempotent, singleton). Exit 0.
      const msg = `review-runner: another runner holds the singleton lease (${acq.reason}${acq.heldBy ? `, heldBy ${acq.heldBy}` : ''}) — no-op.`;
      if (asJson) writeAllSync(1, `${JSON.stringify({ ranPass: false, reason: 'lease-held', heldBy: acq.heldBy || null, records: [] })}\n`);
      else process.stderr.write(`${msg}\n`);
      return process.exit(0);
    }
    holding = true;
  }

  try {
    // 1. DISCOVER (read-only). Explicit positionals → re-read their labels; else list the review:pending set.
    let discovered;
    if (positionals.length) {
      const nums = positionals.map((p) => Number(p)).filter((n) => Number.isFinite(n) && n > 0);
      discovered = lookupLabels(nums, repoSlug, repoKey);
    } else {
      discovered = discoverPending(repoSlug, repoKey);
    }
    if (discovered == null) {
      writeAllSync(1, `${JSON.stringify({ error: `review-runner: could not discover review:pending PRs from ${repoSlug} (gh failed)` })}\n`);
      return exit(holding, owner, 2);
    }

    const { clearable, skippedHuman, skippedUnverified } = partitionRunnerPRs(discovered);

    // 2 + 3. Shadow-dispose each clearable PR (read the durable ledger → seams in SHADOW → record).
    const config = resolveDispositionConfig({});
    const records = runShadowPass(clearable, config);

    // Jury subjects use internal keys; the shared verdict ledger requires the SAME owner/name as human rows.
    // Resolve short constellation names via gh rather than inventing an owner. This too is best-effort.
    try {
      const candidate = repoSlug.includes('/') ? repoSlug : CONSTELLATION_REPOS[repoKey].slug;
      const ledgerRepo = candidate.includes('/') ? candidate : JSON.parse(readGh([
        'repo', 'view', candidate, '--json', 'nameWithOwner',
      ], { encoding: 'utf8' })).nameWithOwner;
      appendShadowRecords(records, ledgerRepo);
    } catch (e) {
      try {
        process.stderr.write(`review-runner: could not resolve verdict-ledger repo (shadow, non-fatal) — ${String((e && e.message) || e)}\n`);
      } catch { /* best-effort diagnostic */ }
    }

    // Emit the shadow log.
    const summary = {
      ranPass: true,
      mode: 'shadow',
      repo: repoSlug,
      discovered: discovered.length,
      clearable: clearable.length,
      skippedHuman: skippedHuman.map((s) => `${s.repo}#${s.pr}`),
      skippedUnverified: skippedUnverified.map((s) => `${s.repo}#${s.pr}`),
      wouldClear: records.filter((r) => r.wouldClear).length,
      wouldKeepParked: records.filter((r) => !r.wouldClear).length,
      mutations: 0, // INVARIANT — a shadow pass mutates nothing
      records,
    };

    if (asJson) {
      writeAllSync(1, `${JSON.stringify(summary, null, 2)}\n`);
    } else {
      writeAllSync(1, renderHuman(summary));
    }
    return exit(holding, owner, 0);
  } catch (e) {
    writeAllSync(1, `${JSON.stringify({ error: `review-runner: ${String((e && e.message) || e)}` })}\n`);
    return exit(holding, owner, 2);
  }
}

/** Release the lease (if held) and exit. */
function exit(holding, owner, code) {
  if (holding) { try { releaseLease(owner); } catch { /* best-effort */ } }
  return process.exit(code);
}

/** Render the shadow log as a scannable text report. */
function renderHuman(s) {
  const lines = [];
  lines.push(`review-runner [SHADOW] over ${s.repo} — discovered ${s.discovered}, clearable ${s.clearable}; mutations: ${s.mutations} (observe-only).`);
  if (s.skippedHuman.length) lines.push(`  skipped review:human (never agent-cleared — #2439): ${s.skippedHuman.join(', ')}`);
  if (s.skippedUnverified.length) lines.push(`  skipped label-unverifiable (fail-closed): ${s.skippedUnverified.join(', ')}`);
  for (const r of s.records) {
    const verdict = r.ledgerFound ? r.panelVerdict : 'no-ledger';
    const findings = r.outstandingFindings ? ` · ${r.outstandingFindings} outstanding finding(s)` : '';
    lines.push(
      `  ${r.subject}: WOULD ${r.wouldClear ? 'CLEAR (→ review:accepted)' : 'KEEP PARKED (→ human)'}`
      + ` — verdict ${verdict}, disposition ${r.disposition}${findings} — reason: ${r.reason}`,
    );
    lines.push(`      ${r.observation}`);
  }
  lines.push(`  WOULD clear: ${s.wouldClear}   WOULD keep parked: ${s.wouldKeepParked}   applied: 0 (shadow).`);
  return `${lines.join('\n')}\n`;
}
