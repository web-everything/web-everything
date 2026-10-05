#!/usr/bin/env node
/**
 * @file scripts/conveyor/orphan-claim-release.mjs
 * @description THE ORPHANED-CLAIM RELEASE PASS (WE #3913, epic #3383). Finds backlog cards stuck `status: active`
 *   with nobody on them, and hands them back to `open` so the pool can offer them again.
 *
 * WHY. A card goes `active` two ways — a claim (`backlog.mjs claim`, stamps `dateStarted`) or a born-active
 * scaffold (`backlog.mjs scaffold --session`, stamps `scaffoldedBy`/`dateScaffolded`). If the session behind it
 * dies or forgets it, the card stays `active` forever: excluded from every batch pool, and nobody working it.
 * Real cases: #3467 and #3783, born active and never settled. `audit-backlog-health.mjs` flag O1 REPORTS the
 * born-active half; nothing acted. A release is reversible (anyone can re-claim) and the question "is anyone on
 * this card?" is script-decidable, so this pass ACTS rather than reports.
 *
 * THE OWNER-GONE SIGNALS are the ones `we:scripts/conveyor/lease-reaper.mjs` already trusts, turned around: the
 * reaper asks "is this LANE's owner gone?", this asks "is this CARD's owner gone?". A card is planned for
 * release only when ALL hold:
 *   • status is `active` and it is not an epic (an active epic is the normal "children in flight" shape);
 *   • no lane lease in ANY pool names it (session / workerSession / purpose / holder segment);
 *   • no OPEN PR names it (lane ref segment, `#id` in the title, or a delivery match);
 *   • no live `claude agents` session names it (a name encoding the id, or equal to its `scaffoldedBy`), where
 *     "live" is any state outside the reaper's own {@link AGENT_GONE_STATES};
 *   • no MERGED PR delivered it — matched exactly the way `we:scripts/backlog-stranded-sweep.mjs#prDeliveredItem`
 *     matches. A delivered-but-still-active card is a stranded resolve (#3914), not an orphaned claim; releasing
 *     it would re-offer finished work;
 *   • it is older than 48 h, measured from `dateStarted`, else `dateScaffolded`, else `dateOpened`. Unknown age
 *     ⇒ skip. The age is measured from the LATEST instant the date could denote in any timezone, so a
 *     date-only stamp can never read older than it really is.
 * FAIL-CLOSED: when any signal source is unavailable (gh failed, the agents listing failed or came back empty,
 * the pool root is unreadable), EVERY card is skipped. This pass writes; unknown is never read as "gone".
 *
 * THE WRITERS ARE THE EXISTING ONES — never a hand-rolled status splice: a born-active scaffold (has
 * `scaffoldedBy`, no `dateStarted`) goes through `backlog.mjs settle <id>`; everything else through
 * `backlog.mjs release <id>` (whose own queued-item guard still applies — we never pass `--force`).
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors lease-reaper.mjs):
 *   • PURE: {@link cardAgeMs}, {@link idSegments}, {@link textNamesItem}, {@link classifyOrphan},
 *     {@link planOrphanRelease}, {@link parseCard}. No fs / git / gh / clock — every signal is passed in.
 *   • IO SHELL (`main()`, only when run directly): reads backlog/, the lane pools, ONE open-PR list, ONE
 *     merged-PR list, ONE `claude agents --json --all`; then either reports (default, and `--dry-run`) or, with
 *     `--apply`, writes the release/settle edits in a freshly-acquired lane clone, commits them, verifies the
 *     lane, and opens ONE parked PR through the `open-pr` operation. Backlog writes never land on `main`
 *     directly (Rule 104). `--apply --checkout=<dir>` writes the edits into an existing checkout only (no
 *     commit, no PR) — the manual path a session uses inside its own lane.
 *
 * Usage:
 *   node scripts/conveyor/orphan-claim-release.mjs [--json]                    # report only (same as --dry-run)
 *   node scripts/conveyor/orphan-claim-release.mjs --apply [--json]            # lane → edits → commit → verify → one parked PR
 *   node scripts/conveyor/orphan-claim-release.mjs --apply --checkout=<dir>    # edits only, into an existing lane checkout
 *   [--min-age-hours=48] [--merged-limit=5000]   # the whole merged history fits in ~12 s today; a full window
 *                                                 # makes cards older than its oldest PR skip (merged-window-uncovered)
 */

import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';
import { machinePrTitle } from '../operations/machine-pr-title.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_GONE_STATES, itemNumFromSession, laneRefItemNum } from './lease-reaper.mjs';
import { prDeliveredItem, readFrontmatterField, idTokenOf } from '../backlog-stranded-sweep.mjs';
import { LEASE_FILENAME } from '../lib/lane-lease.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { resolveChildTimeoutMs, resolveLaneAcquireTimeoutMs } from '../lib/bounded-child.mjs';

const WE_SLUG = CONSTELLATION_REPOS.we.slug;

// ── PURE CORE ────────────────────────────────────────────────────────────────────────────────────────────────

/** The default minimum age before a claim counts as orphaned. */
export const DEFAULT_MIN_AGE_MS = 48 * 60 * 60 * 1000;

/** The ref prefix this pass opens its one PR under — also how it recognises its own still-open PR. */
export const RUN_REF_PREFIX = 'lane/orphan-claim-release-';

/** Latest instant a `YYYY-MM-DD` date can denote in any timezone (end of day at UTC-12) = UTC midnight + 36 h. */
const LATEST_TZ_OFFSET_MS = 36 * 60 * 60 * 1000;

/**
 * Parse one card file into the fields the classifier needs. Pure.
 * @param {string} stem  filename without `.md`
 * @param {string} body  file contents
 */
export function parseCard(stem, body) {
  const f = (k) => readFrontmatterField(body, k);
  return {
    id: idTokenOf(stem),
    stem,
    status: f('status'),
    kind: f('kind'),
    bornAs: f('bornAs'),
    scaffoldedBy: f('scaffoldedBy'),
    dateStarted: f('dateStarted'),
    dateScaffolded: f('dateScaffolded'),
    dateOpened: f('dateOpened'),
  };
}

/**
 * The age basis for a card: `dateStarted`, else `dateScaffolded`, else `dateOpened`. Pure.
 * @returns {{field:string, date:string}|null}  null when none is a readable `YYYY-MM-DD`.
 */
export function cardAgeBasis(card) {
  for (const field of ['dateStarted', 'dateScaffolded', 'dateOpened']) {
    const v = card?.[field];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return { field, date: v };
  }
  return null;
}

/**
 * How old a card is, in ms, measured CONSERVATIVELY from the latest instant its basis date could mean. Pure.
 * @returns {number|null}  null when the age is unknown.
 */
export function cardAgeMs(card, nowMs) {
  const basis = cardAgeBasis(card);
  if (!basis || typeof nowMs !== 'number') return null;
  return nowMs - (Date.parse(`${basis.date}T00:00:00Z`) + LATEST_TZ_OFFSET_MS);
}

/** Split a name/ref/purpose into lower-cased segments on `/ - _ : .` and whitespace. Pure. */
export function idSegments(text) {
  return String(text ?? '').toLowerCase().split(/[/\-_:.\s]+/).filter(Boolean);
}

/** The id tokens a card answers to: its id and (if any) its `bornAs` hash. Pure. */
export function cardTokens(card) {
  return [card?.id, card?.bornAs]
    .map((t) => String(t ?? '').toLowerCase())
    .filter((t) => /^\d{1,6}$/.test(t) || /^x[0-9a-z]{6}$/.test(t));
}

/**
 * Does a free-text name (session name, lease purpose, lane ref…) name this card? Pure. A whole-segment match
 * on either token — deliberately loose: a false "yes" only makes this pass SKIP a card, never release one.
 */
export function textNamesItem(text, tokens) {
  const segs = idSegments(text);
  return tokens.some((t) => segs.includes(t));
}

/** Does a lane lease name this card (any of the fields a lease identifies its owner / purpose by)? Pure. */
export function leaseNamesItem(lease, tokens) {
  if (!lease || typeof lease !== 'object') return false;
  for (const k of ['session', 'workerSession', 'purpose', 'holder']) {
    const v = lease[k];
    if (typeof v !== 'string') continue;
    if (tokens.includes(String(itemNumFromSession(v) ?? ''))) return true;
    if (textNamesItem(v, tokens)) return true;
  }
  return false;
}

/** Does an OPEN PR name this card (lane ref, `#id` in title, or a delivery match)? Pure. */
export function openPrNamesItem(pr, card, tokens) {
  if (!pr) return false;
  if (tokens.includes(String(laneRefItemNum(pr.headRefName) ?? ''))) return true;
  if (textNamesItem(pr.headRefName, tokens)) return true;
  const title = String(pr.title || '');
  if (tokens.some((t) => new RegExp(`#${t}\\b`, 'i').test(title))) return true;
  return prDeliveredItem(pr, { id: card.id, bornAs: card.bornAs }).matched;
}

/** Is a `claude agents` row a LIVE session that names this card? Pure. */
export function sessionNamesItem(row, card, tokens) {
  if (!row || typeof row !== 'object' || typeof row.name !== 'string' || !row.name) return false;
  if (AGENT_GONE_STATES.has(row.state)) return false;
  if (card.scaffoldedBy && row.name === card.scaffoldedBy) return true;
  if (tokens.includes(String(itemNumFromSession(row.name) ?? ''))) return true;
  return textNamesItem(row.name, tokens);
}

/**
 * The verdict for ONE card. Pure — same card + signals → same verdict.
 *
 * @param {ReturnType<typeof parseCard>} card
 * @param {{nowMs:number, minAgeMs?:number, leases:Array|null, openPrs:Array|null, mergedPrs:Array|null,
 *          sessions:Array|null, mergedWindowFloor?:(string|null)}} sig
 *   `leases` / `openPrs` / `mergedPrs` / `sessions` = null means that source was unavailable → skip.
 *   `mergedWindowFloor` = the oldest `YYYY-MM-DD` the merged-PR list is known to cover (null = it covers
 *   everything); a card opened before it cannot be proven undelivered → skip.
 * @returns {{act:boolean, verb?:('release'|'settle'), reason:string, ageField?:string}}
 */
export function classifyOrphan(card, sig = {}) {
  const { nowMs, minAgeMs = DEFAULT_MIN_AGE_MS, leases, openPrs, mergedPrs, sessions, mergedWindowFloor = null } = sig;
  if (!card || card.status !== 'active') return { act: false, reason: 'not-active' };
  if (card.kind === 'epic') return { act: false, reason: 'epic' };
  const tokens = cardTokens(card);
  if (!tokens.length) return { act: false, reason: 'no-id' };
  // Fail closed: any unavailable source means we cannot say the owner is gone.
  for (const [name, v] of [['leases', leases], ['open-prs', openPrs], ['merged-prs', mergedPrs], ['sessions', sessions]]) {
    if (!Array.isArray(v)) return { act: false, reason: `signal-unavailable:${name}` };
  }
  const age = cardAgeMs(card, nowMs);
  if (age === null) return { act: false, reason: 'age-unknown' };
  if (age <= minAgeMs) return { act: false, reason: 'too-young' };
  if (leases.some((l) => leaseNamesItem(l, tokens))) return { act: false, reason: 'live-lease' };
  if (openPrs.some((pr) => openPrNamesItem(pr, card, tokens))) return { act: false, reason: 'open-pr' };
  if (sessions.some((row) => sessionNamesItem(row, card, tokens))) return { act: false, reason: 'live-session' };
  if (mergedPrs.some((pr) => prDeliveredItem(pr, { id: card.id, bornAs: card.bornAs }).matched)) return { act: false, reason: 'merged-delivery' };
  if (mergedWindowFloor && (!card.dateOpened || card.dateOpened < mergedWindowFloor)) return { act: false, reason: 'merged-window-uncovered' };
  const verb = card.scaffoldedBy && !card.dateStarted ? 'settle' : 'release';
  return { act: true, verb, reason: 'orphaned', ageField: cardAgeBasis(card).field };
}

/**
 * The plan over every card. Pure. Only `active` cards appear in either list.
 * @returns {{release:Array<{id:string, stem:string, verb:string, ageField:string}>, skip:Array<{id:string, reason:string}>}}
 */
export function planOrphanRelease(cards, sig) {
  const release = [];
  const skip = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.status !== 'active') continue;
    const v = classifyOrphan(card, sig);
    if (v.act) release.push({ id: card.id, stem: card.stem, verb: v.verb, ageField: v.ageField });
    else skip.push({ id: card.id, reason: v.reason });
  }
  return { release, skip };
}

/**
 * The oldest date a `gh pr list --limit N` result is known to cover. Pure. If fewer than `limit` rows came back
 * the list is complete (null = covers everything); otherwise the floor is the oldest `createdAt` date in it.
 */
export function mergedWindowFloorOf(prs, limit) {
  if (!Array.isArray(prs) || prs.length < limit) return null;
  const dates = prs.map((p) => String(p?.createdAt || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return dates[0] || '9999-12-31';
}

/** The PR body for one apply run. Pure. */
export function renderPrBody(applied, { minAgeHours = 48 } = {}) {
  const lines = applied.map((a) => `- #${a.id} — \`backlog.mjs ${a.verb}\` (age from \`${a.ageField}\`)`);
  return [
    '## Orphaned-claim release (mechanical pass, #3913)',
    '',
    `These cards were \`status: active\` with no lane lease, no open PR, no live session, no merged delivery PR, and older than ${minAgeHours} h. Each is handed back to \`open\` through the standard backlog writer.`,
    '',
    ...lines,
    '',
    'Reversible: re-claim any card with `node scripts/backlog.mjs claim <id>`.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    '',
  ].join('\n');
}

// ── IO SHELL ─────────────────────────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const POOL_ROOT = expandHome(process.env.LANE_POOL_ROOT) || join(homedir(), 'workspace', '.lanes');
const log = (m) => process.stderr.write(m + '\n');

function readCards(root) {
  const dir = join(root, 'backlog');
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseCard(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')));
}

/** Every held lease across every pool under POOL_ROOT, or null if the pool root cannot be read. */
function readAllLeases() {
  try {
    const leases = [];
    for (const pool of readdirSync(POOL_ROOT)) {
      const poolDir = join(POOL_ROOT, pool);
      let lanes;
      try { lanes = readdirSync(poolDir).filter((d) => /^lane-\d+$/.test(d)); } catch { continue; }
      for (const lane of lanes) {
        const file = join(poolDir, lane, '.git', LEASE_FILENAME);
        if (!existsSync(file)) continue;
        try {
          const l = JSON.parse(readFileSync(file, 'utf8'));
          if (l && typeof l === 'object') leases.push({ ...l, _where: `${pool}/${lane}` });
        } catch { leases.push({ session: null, purpose: null, _where: `${pool}/${lane}`, corrupt: true }); }
      }
    }
    return leases;
  } catch (e) {
    log(`  ⚠ cannot read lane pools at ${POOL_ROOT} (${String(e?.message || e).split('\n')[0]}) — every card skipped`);
    return null;
  }
}

function ghPrs(state, limit, fields) {
  try {
    // WE-only: backlog ids name WE cards, and a WE card's delivery/claim PR lives in the WE repo.
    // Through the shared gh throttle (concurrency cap + points budget + backoff) — the fleet shares one quota.
    return JSON.parse(execFileSyncThrottled('gh', ['pr', 'list', '--repo', WE_SLUG, '--state', state, '--limit', String(limit), '--json', fields], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024, timeout: 120_000,
    }));
  } catch (e) {
    log(`  ⚠ gh pr list --state ${state} failed (${String(e?.message || e).split('\n')[0]}) — every card skipped`);
    return null;
  }
}

function listSessions() {
  try {
    const rows = JSON.parse(cachedClaudeAgents({ all: true, fetch: () => execFileSync('claude', ['agents', '--json', '--all'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL',
    }) }) || '[]');
    // An empty listing is indistinguishable from a bad read (lease-reaper's sessionStatesForReap reasoning).
    if (!Array.isArray(rows) || rows.length === 0) { log('  ⚠ `claude agents --json --all` listed nothing — every card skipped'); return null; }
    return rows;
  } catch (e) {
    log(`  ⚠ \`claude agents --json --all\` failed (${String(e?.message || e).split('\n')[0]}) — every card skipped`);
    return null;
  }
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/** Run the backlog writer for each planned card inside `dir`. A refusal (e.g. a queued item) skips that card. */
function writeEdits(dir, release) {
  const applied = [];
  const failed = [];
  for (const r of release) {
    try {
      // #x5n4zn3 — was bare (no timeout).
      execFileSync('node', [join(dir, 'scripts', 'backlog.mjs'), r.verb, r.id], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
      applied.push(r);
      log(`  ${r.verb === 'settle' ? 'settled' : 'released'} #${r.id} → open`);
    } catch (e) {
      failed.push({ ...r, error: String(e?.stderr || e?.message || e).trim().split('\n')[0] });
      log(`  ⚠ #${r.id}: backlog.mjs ${r.verb} refused — left as is (${failed.at(-1).error})`);
    }
  }
  return { applied, failed };
}

// #x5n4zn3 — was bare (no timeout): git add/commit + `lane-pool.mjs acquire`/`open-pr` all shell through here.
const run = (cmd, args, cwd, { timeoutMs = resolveChildTimeoutMs() } = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' });

/**
 * Acquire the lane this pass writes in. The acquire installs deps (`npm ci` under lane-pool's own
 * `NPM_INSTALL_TIMEOUT_MS`), so it gets the acquire-sized budget, never the generic 5-minute default: a tighter
 * outer timeout would SIGKILL a slow-but-healthy install, leak the lease it already wrote, and abort the whole
 * pass (#x5n4zn3 review). `runFn` is injectable for tests.
 */
export function acquireLane(runFn = run) {
  const args = [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'acquire', '--purpose=orphan-claim-release', '--json'];
  return JSON.parse(runFn('node', args, REPO_ROOT, { timeoutMs: resolveLaneAcquireTimeoutMs() }));
}

// #x5n4zn3 — a real full-gate `run.mjs verify` run: generous (matches the established `VERIFY_TIMEOUT_MS`
// convention `we:scripts/operations/verify-io.mjs`/`we:scripts/conveyor/verify-dispatch.mjs` already use for
// the SAME command), never unbounded.
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;

/** Full apply: acquire a lane, write, commit, verify, open ONE parked PR, always release the lane. */
function applyViaLane(sig, minAgeHours) {
  const acq = acquireLane();
  const lane = acq.path;
  log(`  acquired lane-${acq.lane} → ${lane}`);
  try {
    const { release } = planOrphanRelease(readCards(lane), sig); // re-plan against fresh origin/main
    if (!release.length) return { applied: [], failed: [], pr: null, note: 'nothing to release on fresh origin/main' };
    const { applied, failed } = writeEdits(lane, release);
    if (!applied.length) return { applied, failed, pr: null };
    run('git', ['add', '--', 'backlog'], lane);
    const msg = `${machinePrTitle({ item: applied[0].id, kind: 'release', subject: applied.map((a) => `orphaned claim ${a.id} (${a.verb})`).join(', ') })}\n\n${applied.map((a) => `- #${a.id} (${a.verb})`).join('\n')}\n`;
    run('git', ['commit', '-m', msg], lane);
    // Foreground verify — the lane-verify marker is what pr-land's finish-guard requires.
    execFileSync('node', [join(lane, 'scripts', 'operations', 'run.mjs'), 'verify', `--checkout=${lane}`], { cwd: lane, stdio: ['ignore', 'inherit', 'inherit'], timeout: VERIFY_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const bodyFile = join(lane, '.git', 'orphan-claim-release-body.md');
    writeFileSync(bodyFile, renderPrBody(applied, { minAgeHours }));
    const ref = `${RUN_REF_PREFIX}${Date.now().toString(36)}`;
    const out = run('node', [join(lane, 'scripts', 'operations', 'run.mjs'), 'open-pr', `--ref=${ref}`, '--sha=HEAD', '--base=main', `--bodyFile=${bodyFile}`, '--json'], lane);
    let pr = null;
    try { pr = JSON.parse(out); } catch { pr = { raw: out.slice(0, 2000) }; }
    return { applied, failed, ref, pr };
  } finally {
    try { run('node', [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'release', `--lane=${acq.lane}`, `--session=${acq.holder}`], REPO_ROOT); log(`  released lane-${acq.lane}`); }
    catch (e) { log(`  ⚠ lane-${acq.lane} release failed (${String(e?.message || e).split('\n')[0]}) — the lease reaper will reclaim it`); }
  }
}

function main(argv) {
  const flags = parseFlags(argv);
  const apply = !!flags.apply && !flags['dry-run'];
  const minAgeHours = Number.isFinite(Number(flags['min-age-hours'])) && flags['min-age-hours'] !== true ? Number(flags['min-age-hours']) : 48;
  const mergedLimit = Number(flags['merged-limit']) > 0 ? Number(flags['merged-limit']) : 5000;
  const nowMs = Date.now();

  const openPrs = ghPrs('open', 300, 'number,title,headRefName,body,state');
  const mergedPrs = ghPrs('merged', mergedLimit, 'number,title,headRefName,body,createdAt');
  const sig = {
    nowMs,
    minAgeMs: minAgeHours * 3600_000,
    leases: readAllLeases(),
    openPrs,
    mergedPrs,
    sessions: listSessions(),
    mergedWindowFloor: mergedPrs ? mergedWindowFloorOf(mergedPrs, mergedLimit) : null,
  };
  const plan = planOrphanRelease(readCards(REPO_ROOT), sig);
  const report = { mode: apply ? (flags.checkout ? 'apply-checkout' : 'apply') : 'dry-run', minAgeHours, mergedWindowFloor: sig.mergedWindowFloor, plan };

  if (apply && plan.release.length) {
    const ownOpen = (openPrs || []).find((p) => String(p.headRefName || '').startsWith(RUN_REF_PREFIX));
    if (typeof flags.checkout === 'string') {
      Object.assign(report, writeEdits(flags.checkout, plan.release));
    } else if (ownOpen) {
      report.note = `a previous run's PR #${ownOpen.number} is still open — one PR at a time, nothing written`;
      log(`  ${report.note}`);
    } else {
      Object.assign(report, applyViaLane(sig, minAgeHours));
    }
  }

  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    log(`orphan-claim-release (${report.mode}): ${plan.release.length} orphaned · ${plan.skip.length} skipped`);
    for (const r of plan.release) log(`  ${apply ? '' : 'would '}${r.verb} #${r.id} (age from ${r.ageField})`);
    const counts = {};
    for (const s of plan.skip) counts[s.reason] = (counts[s.reason] || 0) + 1;
    if (plan.skip.length) log(`  skipped: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }
  process.exitCode = report.failed?.length ? 1 : 0; // exitCode, not exit() — never truncate the JSON on stdout
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(process.argv.slice(2)); } catch (e) { log(`orphan-claim-release ✗ ${String(e?.stderr || e?.message || e).split('\n')[0]}`); process.exitCode = 1; }
}
