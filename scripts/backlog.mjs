#!/usr/bin/env node
/**
 * backlog.mjs — the mechanical backlog-status CLI (claim / resolve / release / scaffold).
 *
 * The deterministic counterpart to `check-readiness.mjs --select` (which tells you *what* to work):
 * this performs the *mechanical* state changes the agent otherwise does by hand on every item — flip
 * `status`, stamp `dateStarted`/`dateResolved`, set `graduatedTo`, allocate the next free `NNN`. Each
 * is a surgical frontmatter splice (the body is never touched — see `backlog/frontmatter.mjs`), guarded
 * by the legal `from` status so the script can't double-claim or resolve an open item. One command
 * replaces a re-read → reason → Edit round-trip, saving a tool call and context on every transition.
 *
 * It does the EDIT only — never the gate. `claim` doesn't run tests; `resolve` assumes you've already
 * run the close-out gate (tests + check:standards green). And it stays out of the chat-rename
 * discipline: `claim` prints the rename slug for you to copy, but the script can't (and doesn't) rename.
 *
 * Usage:
 *   node scripts/backlog.mjs claim   <NNN> [--as=preparing] [--force]  # open    → active (or preparing, for /prepare) + dateStarted=today; prints rename slug. Refuses if the item's own file is dirty (claim-first guard); --force overrides
 *   node scripts/backlog.mjs resolve <NNN> [--graduated-to=X] [--codified-to=Y] [--force]  # active → resolved + dateResolved=today (+ graduatedTo); a kind:decision REQUIRES --codified-to=<doc#anchor|one-off> (#911 gate); an epic with open children is refused unless --force (#658 no-open-slice guard)
 *   node scripts/backlog.mjs resolve-parent <childNNN> [--json]  # #2752 drain-side ON-LAND pass: if <childNNN>'s parent EPIC now has every parent:-edge child resolved AND no judgment marker, splice it resolved+graduatedTo=none (mechanizes /resolve-on-last-child); a blocked/untriaged tail ESCALATEs (never auto-closes); a standing program / open-children / non-epic is a no-op. EDIT-ONLY — the caller lands + publishes it
 *   node scripts/backlog.mjs release <NNN>                       # active|preparing → open (abandon/redirect; stamps untouched)
 *   node scripts/backlog.mjs unresolve <NNN> --reason=<why> --force  # resolved → open, dropping dateResolved/graduatedTo/codifiedIn (#2779-incident: correcting a resolve-on-land false positive — evidence failure, never a routine reopen; --force + --reason both required)
 *   node scripts/backlog.mjs retype  <NNN> [--to=<kind>] [--size=N|none] [--status=parked]  # SANCTIONED pack-phase flag-fix — retype a mis-flagged item / bump size / park it through the CLI instead of a raw primary-tree Edit (no LANE_GUARD_OFF). Frontmatter-only (#2123)
 *   node scripts/backlog.mjs yield    <NNN-slug>                 # move a LOCAL-ONLY NNN collision to the next free number (the guard's "a new item takes the next free number; yield this one"). Refuses a git-tracked file — NNN is immutable
 *   node scripts/backlog.mjs scaffold --kind=story --size=3 --title="..." [--digest="..."] [--blocked-by=NNN,NNN] [--parent=NNN] [--session=<slug>]   # --kind ∈ story|epic|task|decision|feature (#466/#487/#2691). --session ⇒ born `active`+`scaffoldedBy` (owned until settle, #670); without it, born `open` (default)
 *   node scripts/backlog.mjs settle   <NNN>                         # born-active scaffold (--session) → open: publish it once digest+edges+body are authored (#670)
 *   node scripts/backlog.mjs reserve   <NNN...> --session=<slug>     # soft-hold planned items (#083 cross-session deprioritize)
 *   node scripts/backlog.mjs unreserve [--session=<slug>] [<NNN...>] # release soft holds (whole session, or specific items)
 *   node scripts/backlog.mjs queue     <NNN...> [--lane=<ref>] [--session=<slug>]  # mark ready-to-merge (#2138 Fork 4) — claim/release refuse a queued item until the drain lands it
 *   node scripts/backlog.mjs unqueue   <NNN...>                     # clear the ready-to-merge mark (the drain's single clear point at landing)
 *   node scripts/backlog.mjs build-queue [--next] [--config=<path>] [--backlog-dir=<path>]  # READ-ONLY (#2527): the ordered build queue — ready items in next-to-build order (tier→score→rank), each row annotated with its tier + score + buildQueued; --next prints the top CLEARED item (what the builder pulls); --config previews under a hypothetical config WITHOUT persisting; --backlog-dir points the whole read at a fixture corpus instead of the live backlog/ dir (#3445). Distinct from the drain `queue` verb above
 *   node scripts/backlog.mjs build-queue add|remove <NNN>            # MANUAL CLEAR-FOR-BUILD gate (#2530): `add` sets buildQueued:true (the supervised builder may pull it); `remove` clears it. Frontmatter-only, lane-gated; never touches blockedBy/readiness. The builder pulls ONLY cleared items, so re-prioritizing never arms a build
 *   add --json to any verb for machine-readable output.
 */
import { isUnderTest } from './lib/under-test.mjs';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { applyTransition, applySettle, readField, setFrontmatterField, removeFrontmatterField, accrueCost } from './backlog/frontmatter.mjs';
import { planEpicResolveOnLand, hasBlockedBy } from './backlog/epic-resolve.mjs';
import { parseCostTokens, formatCostTokens } from './backlog/cost-rates.mjs';
import { nextNum, slugify, renderItem, sizeRefusal, parseSize } from './backlog/scaffold.mjs';
import { nextHash, normalizeId, idFromName, isHash, slugFromName } from './backlog/id.mjs';
import { parseReservations, emptyState, addHolds, removeBySession, removeNums, pruneExpired, serialize, sessionForNum } from './readiness/reservations.mjs';
// #2803 resolve-time scope reconciliation. Every one of these graphs is light and adds no measurable startup
// cost to this CLI (which every hook and the conveyor shell out to): render-check imports only
// route-import-graph, scope-lease only lane-partition, lane-manifest only backlog/id, and scope-lease-collect
// runs its IO shell ONLY under a main-module check.
import { reconcileScope } from './readiness/scope-reconcile.mjs';
import { parseObservedFiles } from './readiness/scope-lease-collect.mjs';
import { repoKeyFromSlug } from './readiness/lane-manifest.mjs';
import { ROUTE_ENTRIES } from './lib/route-import-graph.mjs';
import { parseClaims, serializeClaims, pruneExpiredClaims, recordClaim, recordTouch, mostRecentSession, porcelainFiles } from './readiness/claimScope.mjs';
import { parseQueued, emptyQueuedState, isQueued, queuedNums, addQueued, removeQueued, serializeQueued } from './readiness/queued-state.mjs';
import { parseHolds, emptyHoldState, heldNums, addHold, removeHold, pruneExpired as pruneHolds, leaseUntilIso, serializeHolds, DEFAULT_LEASE_MINUTES } from './readiness/prepare-hold-state.mjs';
import { fitAffineCost, budgetFromFit, impliedCapacity, isKnownStopReason, KNOWN_STOP_REASONS } from './backlog/capacity.mjs';
import { BACKLOG_KINDS } from './check-standards-rules.mjs';
import { numberPendingHashes, landedNumberFor } from './lane-drain.mjs';
import { laneGuardDecision, resolveReal, isLaneLocus } from './guard-lane.mjs';
import { TIERS, rankBetween, DEFAULT_CONFIG, validateConfig, orderQueueDetailed, resolveBuildQueuePrioritySettings, classOrder, formatBuildQueuePriorityShadowLine } from './lib/build-queue.mjs';
import { loadOverlapYieldConfig, writeOverlapYieldConfig, defaultOverlapYieldConfigPath } from './conveyor/land-overlap-yield.mjs';
import { localToday } from './lib/local-date.mjs';
import { buildQueueCacheFile, buildQueueCacheKey, readBuildQueueCache, writeBuildQueueCache } from './lib/build-queue-cache.mjs';
import { readQueueFile, resolveQueuePath, resolveQueueSource, normNum, bornAsIndexFromItems, resolveBornAsRefs } from './conveyor/queue-store.mjs';
import { DELIVERY_PRIORITY_SETTINGS_PATH } from './conveyor/delivery-priority-shadow.mjs';
import { readSettings, SETTINGS_DIR } from './lib/settings-files.mjs';
import { writeAllSync, writeLineSync } from './lib/write-all-sync.mjs';
import { writeBacklogMd as writeBacklogMdCore, writeBacklogMdUnguarded as writeBacklogMdUnguardedCore } from './backlog/guarded-write.mjs';
// #3034 — `claim` runs through this declared operation, not a second hand-rolled implementation. See
// `claimViaOperation` below (the `v === 'claim'` rewire of the old inline `transition()` guard block).
import { createRegistry } from './operations/registry.mjs';
import { driveRun } from './operations/cli-adapter.mjs';
import { startRun } from './operations/engine.mjs';
import { createMemoryRunStore, newRunId } from './operations/run-store.mjs';
import { claimOperation } from './operations/claim.mjs';
import { createClaimReader, createClaimSinks } from './operations/claim-io.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// #3445 — `--backlog-dir=<path>` points this CLI's own file reads (and, via `WE_BACKLOG_DIR`, the
// `src/_data/backlog.js` loader `buildQueue()` requires) at a fixture corpus instead of the live `backlog/`
// directory — the dispatcher-fixture-root thread (#3402). Read straight off `process.argv` here (before the
// `flag()` helper below exists) since DIR must be settled before any other module-level path is built.
const backlogDirFlag = process.argv.slice(2).find((a) => a.startsWith('--backlog-dir='));
const DIR = backlogDirFlag ? backlogDirFlag.slice('--backlog-dir='.length) : join(ROOT, 'backlog');
if (backlogDirFlag) process.env.WE_BACKLOG_DIR = DIR;
const requireCjs = createRequire(import.meta.url);
const BUILD_QUEUE_CONFIG_PATH = join(ROOT, 'scripts', 'build-queue-config.json');
const CAPACITY_PATH = join(ROOT, '.claude/skills/batch-backlog-items/capacity.json');
const RESERVATIONS_PATH = join(ROOT, '.claude/skills/batch-backlog-items/reservations.json');
const CLAIMS_PATH = join(ROOT, '.claude/skills/batch-backlog-items/claims.json');
const QUEUED_PATH = join(ROOT, '.claude/skills/batch-backlog-items/queued.json');
const PREPARE_HOLD_PATH = join(ROOT, '.claude/skills/batch-backlog-items/prepare-hold.json');
const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', DIM = '\x1b[2m', BLD = '\x1b[1m', RST = '\x1b[0m';

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes('--json');
const verb = argv[0];
const flag = (name) => { const m = argv.find((a) => a.startsWith(`--${name}=`)); return m ? m.slice(name.length + 3) : undefined; };
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));

const today = () => localToday();
const files = () => readdirSync(DIR).filter((f) => f.endsWith('.md'));

// `writeLineSync` is remedy (b) from we:scripts/lib/write-all-sync.mjs — a synchronous drain that keeps the
// `process.exit()` below. Required here rather than `process.exitCode`: every `die()` is a GUARD that must halt
// the caller in place, and an async write callback would let the code after the guard keep running. This file
// used to carry its own copy of the loop (one of three); #3061 moved it to the shared home. Behaviour is
// unchanged — `writeLineSync` appends exactly the one trailing newline the local copy did.
function die(msg) {
  if (JSON_MODE) writeLineSync(1, JSON.stringify({ ok: false, error: msg }));
  else writeLineSync(2, `${RED}✗${RST} ${msg}`);
  process.exit(1);
}
function ok(payload, human) {
  writeLineSync(1, JSON_MODE ? JSON.stringify({ ok: true, ...payload }) : human);
  process.exit(0);
}

// #3034 — the guard chain (lane-isolation #2302/#104/#2219/#2339, the #3015 secret scrub, the #883
// locus-prefix scan) moved to `we:scripts/backlog/guarded-write.mjs` so `we:scripts/operations/claim-io.mjs`'s
// sink can call the SAME writer instead of re-deriving it — a declared operation's effect that re-derives a
// guard chain instead of calling it is the exact "re-declares, does not re-implement" defect #3034's epic
// forbids. These two are now thin shims: they catch the extracted writer's thrown refusal and hand it to this
// file's own `die()`, so every existing call site (scaffold/resolve/settle/retype/yield/prepare-stamp) and its
// exact exit-1 text are unchanged. `recordCliTouch` stays here (it is `backlog.mjs`-specific session
// bookkeeping — `CLAIMS_PATH`, `--session` — the extracted writer knows nothing about it).
function writeBacklogMd(abs, rel, content) {
  try { writeBacklogMdCore(abs, rel, content, { root: ROOT }); }
  catch (e) { die(String(e?.message ?? e)); }
  recordCliTouch(rel);
}

function writeBacklogMdUnguarded(abs, rel, content) {
  try { writeBacklogMdUnguardedCore(abs, rel, content, { root: ROOT }); }
  catch (e) { die(String(e?.message ?? e)); }
  recordCliTouch(rel);
}

/**
 * 2-C touch-recording (#1661): record a file this CLI just spliced against the active session's `touched`
 * set, so `check:standards --scope` attributes a finding on a file already-dirty-at-claim but edited here as
 * **mine** (not a foreign red). The session is the `--session` flag when present, else the most-recently
 * claimed one (`mostRecentSession`). Best-effort — never let attribution bookkeeping fail a mutation.
 * (`recordTouch` no-ops if the session row doesn't exist yet, e.g. the very first claim before `recordClaim`
 * runs — there the baseline-diff already catches the newly-dirtied file.)
 */
function recordCliTouch(rel) {
  try {
    const claims = loadClaims();
    const session = flag('session') ?? mostRecentSession(claims);
    if (session) saveClaims(recordTouch(claims, { session, files: [rel], nowIso: new Date().toISOString() }));
  } catch { /* best-effort — attribution is advisory, never the lock */ }
}

/**
 * Enumerate the open children of an epic by `parent:` EDGE (never the body's "N children" prose, which
 * goes stale — the #658 footgun). Returns every child item whose `status` isn't `resolved`, so `resolve`
 * can refuse to close an umbrella with live work under it BEFORE writing the bad state (instead of the
 * post-hoc `check:standards` catch). Mirrors the gate's resolved-epic-with-open-child rule.
 * @param {string} padded  The epic's zero-padded NNN.
 * @returns {{ num: string, status: string }[]}
 */
function openChildrenOf(padded) {
  const open = [];
  for (const f of files()) {
    const content = readFileSync(join(DIR, f), 'utf8');
    const parent = readField(content, 'parent');
    if (parent !== padded) continue;
    const status = readField(content, 'status') || 'open';
    if (status !== 'resolved') open.push({ num: idFromName(f), status });
  }
  return open;
}

// The epic-resolve-on-last-child DECISION (#2752) is a pure core — it lives in ./backlog/epic-resolve.mjs
// (mirroring frontmatter.mjs / scaffold.mjs), unit-tested with no CLI; the `resolve-parent` verb below wires
// fs + the splice around it.

/**
 * Diagnose a not-found item before dying. A missing local file has two very different causes — the item
 * genuinely doesn't exist, or your checkout is simply behind origin (the common case for an item that was
 * just scaffolded and landed on `main` in another session/PR). The flat "not on disk" error conflated the
 * two and sent the caller down a wrong-premise path instead of a `git pull`, so on the FAILURE path only we
 * probe origin and, if the item exists there, say so.
 *
 * This is NOT a Rule #105 violation: #105 forbids a git *ownership* check on the happy path (a dirty tree is
 * never a drop-reason), and this stays true — the happy path resolves purely from local `files()`, fully
 * offline. This is a distinct *existence/freshness* probe that fires only when there is no local match, so
 * the network cost lands solely on the rare not-found death, never on a successful claim/resolve/release.
 * Best-effort throughout: any git hiccup (offline, no remote, timeout) falls back to the original plain message.
 */
function missingItemMessage(padded) {
  const plain = `no backlog item #${padded} on disk`;
  // The probe only ENRICHES an interactive error. `--json` (machine) mode's contract is a fast, offline,
  // deterministic error, so skip the network entirely there — never make a machine consumer block on a fetch.
  if (JSON_MODE) return plain;
  try {
    // Bounded + non-interactive: a stalled remote or a credential prompt must not hang the death path
    // (this also runs unattended in the drain). timeout → SIGTERM → the catch below returns `plain`.
    const gitEnv = { cwd: ROOT, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
    execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { ...gitEnv, stdio: 'ignore' });
    const onOrigin = execFileSync('git', ['ls-tree', '--name-only', 'FETCH_HEAD', 'backlog/'], { ...gitEnv, encoding: 'utf8' })
      .split('\n')
      .some((p) => p.startsWith(`backlog/${padded}-`));
    if (!onOrigin) return plain;
    // Advice is context-agnostic ON PURPOSE: this CLI runs both in a primary checkout (on `main`, where
    // `git pull --ff-only` is right) AND in `lane/*` clones (#104), where a bare pull can't fast-forward a
    // diverged lane branch and a HEAD..origin/main count would be inflated. So point at the GOAL — sync to
    // origin/main — and name the right move per context, rather than prescribing one command / a wrong count.
    return `#${padded} exists on origin/main but not your checkout — sync to origin/main and retry (a stale-checkout `
      + `miss, not a missing item): \`git pull --ff-only\` on a primary checkout, or refresh the lane `
      + `(\`node scripts/lane-pool.mjs refresh --lane=N\`).`;
  } catch {
    return plain; // offline / no remote / timed out — can't diagnose, keep the plain error
  }
}

/** Resolve a bare ref (NNN or the provisional hash `xNNNNNN`, ± -slug) to its current filename, or die. */
function resolveFile(ref) {
  if (!ref) die('missing <NNN> — e.g. `backlog.mjs claim 122`');
  const id = idFromName(ref); // numeric NNN (landed) or an `xNNNNNN` hash (provisional, #2288)
  if (!id) die(`"${ref}" is not a valid item reference (NNN or xNNNNNN)`);
  const padded = normalizeId(id); // pad a number, leave a hash untouched
  const matches = files().filter((f) => f.startsWith(`${padded}-`));
  if (matches.length === 0) die(missingItemMessage(padded));
  if (matches.length > 1) die(`#${padded} is ambiguous: ${matches.join(', ')}`);
  return matches[0];
}

// ── #2803 resolve-time scope reconciliation: the two IO shells the guard in transition() reads ──────────────

/** The item's declared `scope:` as a plain array, or `null` when the item declares none (Fork C — a pre-#2613
 *  legacy item). MUST go through gray-matter: `readField` (backlog/frontmatter.mjs:37) is SCALAR-only (it
 *  regex-matches the rest of one line) and cannot read a block-list `scope:`. Same read `check-standards.mjs`
 *  uses for its `scope:` shape rule, so the two never disagree on what the field says. Best-effort — a
 *  malformed-YAML item is already reported by the gate; here it just reads as unscoped. */
function readScopeList(content) {
  try {
    const data = requireCjs('gray-matter')(content)?.data;
    const scope = data?.scope;
    return Array.isArray(scope) ? scope.filter((s) => typeof s === 'string' && s.trim()) : null;
  } catch { return null; }
}

/** This clone's repo-qualified changed-file set — the lane's committed range UNIONED with its dirty tree
 *  (#2803 Fork B: THIS clone only; see scope-reconcile.mjs's header for why a sibling product clone is out of
 *  reach). GIT ONLY — it parses nothing itself: the raw `git diff` + `git status` stdouts go to `parseObservedFiles`
 *  (readiness/scope-lease-collect.mjs:105), which already unions the two halves, applies the rename-aware
 *  `porcelainFiles`, repo-qualifies, and `normScope`s. Re-deriving that union inline would drift from the
 *  collector on what `we:` means, and the collector's own header makes "composes, never reinvents" the rule.
 *
 *  BEST-EFFORT by contract: any git failure (not a repo, `git` missing, no `origin/main`, detached base, no
 *  origin remote) returns `[]` with a printed note, so the guard degrades to a pass and a resolve is NEVER
 *  blocked by a git hiccup — the same convention as the claim-baseline block and the claim cleanliness guard.
 *  An unresolvable repo key is deliberately in that degrade set rather than a fallback: unqualified observed
 *  paths can never match a `we:`-qualified declared entry, so every file would read as undeclared and a
 *  presentation file among them would raise a FALSE hard error. */
function observedFilesForResolve() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    // `repoKeyFromSlug` (lane-manifest.mjs:171) takes an `owner/name` SLUG, not a remote URL: it splits on `/`
    // and never strips `.git`, so the raw `git@github.com:web-everything/web-everything.git` would key as
    // `web-everything.git` and NOTHING would ever match a `we:`-qualified declared entry — the guard would be
    // silently inert. Normalize the URL to `owner/name` first, with the same pattern pr-land.mjs:830 uses.
    const url = git(['remote', 'get-url', 'origin']).trim();
    const slug = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? url;
    const repoKey = repoKeyFromSlug(slug);
    if (!repoKey) throw new Error(`origin remote "${url}" yields no repo key`);
    const base = git(['merge-base', 'origin/main', 'HEAD']).trim();
    if (!base) throw new Error('empty merge-base against origin/main');
    const diffOut = git(['diff', '--name-only', '--end-of-options', `${base}...HEAD`]);
    const porcelainOut = git(['status', '--porcelain']);
    return parseObservedFiles({ diffOut, porcelainOut, repoKey });
  } catch (e) {
    console.error(`${DIM}note: resolve-time scope reconciliation (#2803) skipped — this clone's changed-file set could not be read (${e?.message?.split('\n')[0] || e}).${RST}`);
    return [];
  }
}

function transition(v) {
  const file = resolveFile(positional[0]);
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  const before = readFileSync(abs, 'utf8');
  // No WHOLE-tree git/commit check here: concurrency is owned by the status transition itself — `claim`
  // only succeeds from `open`, so a second claimer hits an already-`active` item and the transition errors
  // (plus the `reserve` session soft-holds, #083). The tree's commit state at large is irrelevant to
  // ownership (a perpetually-dirty tree is the normal baseline), so claim never inspects the tree —
  // EXCEPT the per-item cleanliness guard, which inspects only the single file being claimed.
  //
  // #3034 — `claim` no longer runs through this function at all. `we:scripts/backlog.mjs`'s bottom-level
  // `switch (verb)` routes it to `claimViaOperation()` below, which drives the declared `claim` operation
  // (`we:scripts/operations/claim.mjs`) — the SAME queued/prepare-hold/dirty-file guard order, now living in
  // that operation's `planClaim`, not duplicated here. Only `resolve` and `release` still call this function.
  //
  // Ready-to-merge (queued) guard (#2138 Fork 4): a queued item pushed a lane and is waiting for the
  // drain. It is still `status: active` on main, so a naive read would reopen it as abandoned (release —
  // the #2072 closeout reconcile's active→open flip). Read the LOCAL queued token OFFLINE (Rule #105 — no
  // tree read, no ls-remote) and refuse: a queued item is not abandoned. `--force` overrides for the rare
  // deliberate case (e.g. abandoning a stuck queue entry).
  // #2779-incident — `unresolve` (resolved → open) exists to CORRECT a resolve that should never have
  // happened (evidence failure, e.g. the drain's branch-name-coincidence bug), never as a routine reopen —
  // always requires --force, mirroring release's rare-deliberate-abandon gate just below, and a --reason
  // (applyTransition itself refuses without one; this is the fast, readable failure before that point).
  if (v === 'unresolve' && !argv.includes('--force')) {
    die(`unresolve #${idFromName(file)} refused — reopening a RESOLVED card is a correction, not a routine transition; pass --force and --reason="<why>" to confirm this resolve should never have happened.`);
  }
  if (v === 'release' && !argv.includes('--force')) {
    const num = idFromName(file);
    if (isQueued(loadQueued(), num)) {
      die(`#${num} is queued (ready-to-merge, #2138 Fork 4) — it is waiting to be drained, NOT abandoned; releasing it to open would drop its ready-to-merge state and re-offer it. Let the drain land + unqueue it; pass --force only to deliberately abandon the queued lane.`);
    }
  }
  // No-open-slice guard (#658): an epic can't close while live work sits under it. Enumerate children by
  // the `parent:` EDGE (not the body's stale "N children" listing) and refuse BEFORE writing — so the
  // `resolved-epic-with-open-child` contradiction is never created, not just caught later by the gate.
  // `--force` overrides for the rare deliberate mid-re-parent case (prints what it stepped over).
  if (v === 'resolve' && readField(before, 'kind') === 'epic') {
    const padded = idFromName(file);
    const openKids = openChildrenOf(padded);
    if (openKids.length && !argv.includes('--force'))
      die(`#${padded} is an epic with ${openKids.length} open child slice(s) — resolve or re-parent them first, or pass --force:\n${openKids.map((k) => `    #${k.num} — ${k.status}`).join('\n')}`);
    if (openKids.length) console.error(`${YEL}warning:${RST} ${DIM}--force: resolving epic #${padded} over ${openKids.length} open child(ren): ${openKids.map((k) => `#${k.num}`).join(', ')}${RST}`);
  }
  // Resolve-time scope reconciliation (#2803, epic #2804): diff the item's DECLARED `scope:` against the files
  // this clone ACTUALLY changed, and refuse when it touched a presentation / route-graph surface it never
  // declared. That is the self-declared-scope master bypass — declare a narrow non-UI scope, edit the UI
  // anyway, and the UI-fidelity gate never looks at the item. Placed BEFORE applyTransition (the same shape as
  // the #658 epic guard directly above, `--force` escape hatch included) so the contradiction is never written
  // to disk. Fork D: only PRESENTATION drift is fatal — ordinary undeclared non-UI files are RETURNED by
  // `reconcileScope` for a later consumer (#2812's record) and deliberately NOT printed here, because a
  // non-empty `undeclared` set occurs on essentially every resolve and the noise would train the operator to
  // ignore the line that also carries the real offenders.
  //
  // COVERAGE, stated so it is not mistaken for the enforcement point: this fires on the PRODUCER-AUTHORED
  // resolve, in the lane clone that still holds `origin/main..HEAD` plus its dirty tree. The drain's on-land
  // flip (`resolveLandedItem`, lane-drain.mjs) shells out to this same verb, but from a clone already synced to
  // merged `origin/main` — the observed set there is EMPTY and this guard passes vacuously, which is the
  // intended shape, since that call site wraps the subprocess in a `catch { flipped: false }` that would turn a
  // hard refusal into a SILENT stranded-reopen rather than a visible failure. The real floor is #2812's
  // gate-side check; this is a cheap producer-side speed bump.
  if (v === 'resolve') {
    const declared = readScopeList(before);
    if (!declared?.length) {
      // Fork C — an absent `scope:` PASSES with a note. An unscoped item is already refused at dispatch
      // (`unshaped-no-scope`) and has its scope auto-prepared (#2613), so this is a pre-#2613 legacy item, not
      // a bypass attempt; erroring would break resolves of old items for no fidelity gain.
      console.error(`${DIM}note: #${idFromName(file)} declares no scope: — resolve-time scope reconciliation skipped (#2613 legacy item).${RST}`);
    } else {
      const { offending } = reconcileScope({ declared, observed: observedFilesForResolve(), routeGraph: { routeEntries: ROUTE_ENTRIES } });
      if (offending.length && !argv.includes('--force'))
        die(`#${idFromName(file)} touched ${offending.length} presentation/route surface(s) its scope: never declared — an under-scoped UI item cannot resolve (#2803):\n${offending.map((f) => `    ${f}`).join('\n')}\nDeclare them in scope: (and let the UI-fidelity gate see the item), or pass --force.`);
      if (offending.length)
        console.error(`${YEL}warning:${RST} ${DIM}--force: resolving #${idFromName(file)} over ${offending.length} undeclared presentation surface(s): ${offending.join(', ')}${RST}`);
    }
  }
  const res = applyTransition(before, v, { today: today(), graduatedTo: flag('graduated-to'), codifiedTo: flag('codified-to'), reason: flag('reason') });
  if (res.error) die(`#${idFromName(file)} — ${res.error}`);
  writeBacklogMd(abs, rel, res.content);
  const id = file.replace(/\.md$/, '');
  if (v === 'resolve') {
    const g = flag('graduated-to');
    const c = flag('codified-to');
    ok({ verb: v, id, file: rel, status: 'resolved', graduatedTo: g, codifiedIn: c },
      `${GRN}✓ resolved${RST} ${id} ${DIM}→ resolved (dateResolved ${today()}${g ? `, graduatedTo ${g}` : ''}${c ? `, codifiedIn ${c}` : ''})${RST}${g ? '' : `\n${YEL}note:${RST} ${DIM}no --graduated-to set; if a resolved idea spawned no entity, set graduatedTo=none by hand${RST}`}`);
  }
  if (v === 'unresolve') {
    const reason = flag('reason');
    ok({ verb: v, id, file: rel, status: 'open', unresolvedReason: reason },
      `${GRN}✓ unresolved${RST} ${id} ${DIM}→ open (dateUnresolved ${today()}, reason: ${reason})${RST}`);
  }
  ok({ verb: v, id, file: rel, status: 'open' }, `${GRN}✓ released${RST} ${id} ${DIM}→ open${RST}`);
}

/**
 * `claim` — #3034's rewire. Drives the declared `claim` operation (`we:scripts/operations/claim.mjs`) to
 * completion instead of running the old inline guard block. Everything the operation does NOT own —
 * reservations-clearing, the `.claude/skills/batch-backlog-items/claims.json` attribution baseline, and the
 * rename-slug/two-turn-stop/background messaging — stays here, now reading the operation's returned finding
 * (`outcome.run.verdict`) instead of local variables computed inline.
 *
 * ASYNC, DELIBERATELY NARROW (see the card's "open implementation detail"): `we:scripts/backlog.mjs` is a
 * synchronous, `process.exit()`-driven CLI end to end, and the operation engine's effect application
 * (`applyPendingEffects`) is `async`. Rather than making the whole 500+-line CLI's top-level dispatch async to
 * serve one verb, ONLY this one function is — mirroring how `we:scripts/operations/run.mjs`'s own `IS_CLI`
 * block drives its single async entry with `.then()/.catch()`. This composed cleanly: `claim` never awaits a
 * judge or a person (no `judge`/`confirm` step exists in its declaration), so the `await`s inside `driveRun`
 * resolve on the same tick as the underlying (fully synchronous) `fs`/`git` calls — nothing here is genuinely
 * asynchronous, only mechanically so. The run's store is an EPHEMERAL in-memory one
 * (`we:scripts/operations/run-store.mjs#createMemoryRunStore`): this call always drives the run to completion
 * or a refusal in one process, never suspends, and never needs a `--resume` — a crash mid-write is naturally
 * covered by the item's own ownership invariant (a half-applied claim leaves `status: open`, so a retried
 * `claim` just succeeds again; a fully-applied one leaves `status: active`, so a retried `claim` is refused by
 * `applyTransition` exactly as it always was), not by resuming a persisted run record. `node
 * scripts/operations/run.mjs claim --ref=<NNN>` (registered in `we:scripts/operations/run.mjs`) is the one that
 * gets the real file-backed, resumable run record, for a caller that wants it directly.
 */
async function claimViaOperation() {
  const file = resolveFile(positional[0]);
  const rel = `backlog/${file}`;
  const as = flag('as');
  if (as && as !== 'active' && as !== 'preparing') die(`--as="${as}" is not valid — use --as=preparing (a /prepare claim) or omit for a normal active claim`);
  const force = argv.includes('--force');

  const declaration = claimOperation({ readClaimContext: createClaimReader({ root: ROOT }) });
  const registry = createRegistry();
  registry.register(declaration);
  const store = createMemoryRunStore();
  const sinks = createClaimSinks({ root: ROOT });
  const run = startRun({
    op: declaration.name,
    id: newRunId('claim'),
    input: { ref: file, as: as === 'preparing' ? 'preparing' : 'active', force },
    registry,
  });
  store.write(run);

  const outcome = await driveRun({
    run, registry, store, sinks,
    // No `judge` step is declared, so this is never called — present only because `driveRun`'s signature
    // requires one. A call here would be this operation's own "the vocabulary grew a fifth kind" bug.
    judge: async () => { throw new Error('claim: no `judge` step is declared — this should be unreachable'); },
    attemptedBy: 'human',
  });

  if (outcome.stopped === 'step-refused' || outcome.stopped === 'effect-halted') {
    // Every message `planClaim`/the guarded writer throws is verbatim what this file used to `die()` with
    // directly — see `we:scripts/operations/claim.mjs` and `we:scripts/backlog/guarded-write.mjs`.
    die(String(outcome.error?.message ?? outcome.error));
    return;
  }
  if (outcome.stopped !== 'complete') {
    die(`claim: the operation stopped unexpectedly (${outcome.stopped}) — ${String(outcome.error?.message ?? outcome.error ?? 'no further detail')}`);
    return;
  }

  // The write landed — record the touch the same way every other CLI-driven splice does (the extracted
  // guarded writer is bookkeeping-agnostic; this file owns `.claude/skills/batch-backlog-items/claims.json`).
  recordCliTouch(rel);

  const verdict = outcome.run.verdict || {};
  const id = file.replace(/\.md$/, '');
  const slug = id; // the rename slug is the full id (NNN-slug)

  // Clear-on-claim (#083 invariant 2): a hard claim supersedes any soft reservation on this item — drop it
  // so the now-`active` item never lingers as a stale hold against another session. Read the reservation's
  // session BEFORE dropping it, so the baseline below can recover it (#1723).
  const num = idFromName(file);
  const reservationsAtClaim = loadReservations();
  saveReservations(removeNums(reservationsAtClaim, [num]));
  // Gate-attribution baseline (#952, #949 Fork 2-A): snapshot the files ALREADY dirty (everyone else's
  // in-flight + pre-existing) the first time this session claims, and stamp the owning id. Lets
  // `check:standards --scope=<session>` later block only on files THIS session dirtied. Best-effort — a
  // git/IO hiccup must never fail the claim (attribution is an opt-in convenience, not the lock).
  const session = flag('session') ?? sessionForNum(reservationsAtClaim, num) ?? mostRecentSession(loadClaims());
  if (session) {
    try {
      const baselineFiles = [...porcelainFiles(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }))];
      saveClaims(recordClaim(loadClaims(), { session, id, baselineFiles, nowIso: new Date().toISOString() }));
    } catch { /* attribution is best-effort — never block a claim on it */ }
  }

  const claimedStatus = verdict.claimedStatus === 'preparing' ? 'preparing' : 'active';
  const verbWord = claimedStatus === 'preparing' ? 'prepping' : 'claimed';
  const head = `${GRN}✓ ${verbWord}${RST} ${id} ${DIM}→ ${claimedStatus} (dateStarted ${today()})${RST}`;
  // Background carve-out (#2621): a conveyor/background delivery agent claims non-interactively as its FIRST
  // action and then does the readiness pre-check + build in the SAME turn — the two-turn "rename the chat,
  // stop here" arc below is written for a human-driven /decision chat, and an agent obeying it literally
  // would STALL waiting for a hand-off that never comes. Detect that context DETERMINISTICALLY (the
  // conveyor's `conveyor-*` session-slug convention, or an explicit `--background` flag the agent passes)
  // and, for the ACTIVE claim, replace the whole rename + stop block with a one-line "no stop"
  // acknowledgement so the agent proceeds.
  //
  // STILL LOAD-BEARING AFTER #xd0hvsg, though it is no longer the ONLY way out. Its last sentence used to
  // read "interactive human sessions … are unchanged", which is now false — the stop is opt-in, so an
  // ordinary interactive claim does not stop either. What this flag still buys is PRECEDENCE: it asserts
  // there is no human to end the turn, so it wins even when `--stop-for-rename` is also passed, and an agent
  // can never be stalled by a caller that asked for both.
  const background = claimedStatus === 'active'
    && (argv.includes('--background') || (flag('session') ?? '').startsWith('conveyor-'));

  // THE STOP IS OPT-IN, AND `/next` IS WHAT OPTS IN (#xd0hvsg).
  //
  // The hard-stop guards the SELECTION flow's two-go arc: there the claim really is the whole turn, a human
  // renames the chat, and a present+discuss must not collapse into a commit. That is a property of HOW THE
  // CLAIM WAS REACHED, not of claiming — so `we:skills-src/next-backlog-item/SKILL.md` passes
  // `--stop-for-rename` and nothing else does.
  //
  // WHAT IT WAS BEFORE, and why that was wrong: emitted for every non-conveyor `active` claim, with
  // `--background` the only escape and only the conveyor knowing to pass it — an allow-list of one. Every
  // other caller paid a wasted turn obeying a hand-off that was never coming.
  // `we:skills-src/batch-backlog-items/SKILL.md` labels the session ONCE for a whole batch and was still told
  // to stop and rename per item, contradicting its own rule; a directed claim was told to wait for a human
  // who was already waiting on it. The block's own comment said "emit the stop only for the decision claim
  // (#1397)" while the code emitted it for all of them — the intent was written down and never implemented.
  //
  // INVERTED RATHER THAN kind-GATED. Gating on `kind: decision` would have matched that stale comment, but
  // the arc it protects is the selection hand-off, and `/next` runs it for a story just as much as for a
  // decision. The caller knows which flow it is; the item's kind does not.
  const stop = claimedStatus === 'active' && !background && argv.includes('--stop-for-rename');

  const renameBlock = `\n\n${DIM}Rename this chat via the tab menu to label this session — copy:${RST}\n\`\`\`\n${slug}\n\`\`\``;
  let tailBlock;
  if (background) {
    tailBlock = `\n\n${DIM}claimed (background session — no stop); proceed with the readiness pre-check + build in the same turn.${RST}`;
  } else if (claimedStatus === 'preparing') {
    // /prepare has no two-go arc — prep is autonomous agent work (research + authoring, no ruling), so a
    // `preparing` claim flows straight into the passes. Unchanged: it keeps the rename prompt, never a stop.
    tailBlock = `${renameBlock}\n\n${DIM}Proceed with the prep passes now — claiming and preparing are one turn (prep makes no ruling, so there is no two-go arc to split).${RST}`;
  } else if (stop) {
    tailBlock = `${renameBlock}\n\n${YEL}⏸ This is the claim turn — it ends here.${RST} Do NOT ground, present, or discuss the item's substance now. Stop, let the chat be renamed, and begin the work next turn (the claim and its substance are two distinct turns — collapsing them races concurrent sessions and skips the two-go arc).`;
  } else {
    // THE NEW DEFAULT. The slug is still reported — it is useful data, and a caller that wants to label a
    // session can — but as a fact rather than as an instruction, and with no stop attached.
    tailBlock = `\n\n${DIM}claimed (slug \`${slug}\`); proceed with the work in the same turn — pass \`--stop-for-rename\` if this claim is a /next selection hand-off.${RST}`;
  }
  ok({ verb: 'claim', id, file: rel, slug, status: claimedStatus, background, stop }, `${head}${tailBlock}`);
}

/** Read the cross-session reservation registry (#083); a missing/unreadable file degrades to empty. */
function loadReservations() {
  try { return parseReservations(readFileSync(RESERVATIONS_PATH, 'utf8')); }
  catch { return emptyState(); }
}
/** Write the registry, self-pruning expired holds on every write (TTL hygiene). */
function saveReservations(state) {
  writeFileSync(RESERVATIONS_PATH, serialize(pruneExpired(state, Date.now())));
}

/** Read the per-session claim-baseline registry (#952); a missing/unreadable file degrades to empty. */
function loadClaims() {
  try { return parseClaims(readFileSync(CLAIMS_PATH, 'utf8')); }
  catch { return parseClaims(''); }
}
/** Write the claim registry, self-pruning expired session baselines on every write (TTL hygiene). */
function saveClaims(state) {
  writeFileSync(CLAIMS_PATH, serializeClaims(pruneExpiredClaims(state, Date.now())));
}

/** Read the ready-to-merge (queued) registry (#2138 Fork 4); a missing/unreadable file degrades to
 *  empty so the claim/release ownership path never wedges on a corrupt token. */
function loadQueued() {
  try { return parseQueued(readFileSync(QUEUED_PATH, 'utf8')); }
  catch { return emptyQueuedState(); }
}
/** Write the queued registry. */
function saveQueued(state) {
  writeFileSync(QUEUED_PATH, serializeQueued(state));
}

/** Read the prepare-hold registry (#2219 (b) flow / #2264); a missing/unreadable file degrades to empty so
 *  the select/claim path never wedges on a corrupt token. Self-prunes expired holds on each read+write. */
function loadHolds() {
  try { return parseHolds(readFileSync(PREPARE_HOLD_PATH, 'utf8')); }
  catch { return emptyHoldState(); }
}
/** Write the prepare-hold registry, dropping any expired hold (housekeeping). */
function saveHolds(state) {
  writeFileSync(PREPARE_HOLD_PATH, serializeHolds(pruneHolds(state, Date.now())));
}

/**
 * prepare-hold <NNN> [--session=<slug>] [--lease=<minutes>] — place/refresh a HARD local hold while a
 * session prepares a fork in a lane (#2219 (b) flow). `--select` skips a held item and `claim` refuses it,
 * unlike the soft `reserve` deprioritize. Idempotent: re-holding extends the lease (refresh across a long
 * prepare). The token is LOCAL-only (never pushed; read offline per Rule #105) — it is NOT a backlog
 * mutation, so it may run from anywhere. Release with `prepare-release <NNN>` once the one lane→PR lands.
 */
function prepareHold() {
  const num = idFromName(String(positional[0] || '')); // NNN or `xNNNNNN` (#2288)
  if (!num) die('prepare-hold needs a <NNN> to hold');
  resolveFile(num); // a typo must not hold a phantom item
  const holder = flag('session') || process.env.LANE_SESSION || null;
  const leaseMin = Number.isFinite(Number(flag('lease'))) ? Number(flag('lease')) : DEFAULT_LEASE_MINUTES;
  const until = leaseUntilIso(Date.now(), leaseMin);
  saveHolds(addHold(loadHolds(), num, holder, until));
  const padded = normalizeId(num); // pad a number, leave a hash untouched
  ok({ verb: 'prepare-hold', num: padded, holder, leaseUntil: until },
    `${GRN}✓ prepare-held${RST} #${padded} ${DIM}→ hard-excluded from --select + claim until released (lease ${leaseMin}min${holder ? `, holder ${holder}` : ''}). Enter a lane, author + prepare-stamp, land one PR, then \`prepare-release ${padded}\`.${RST}`);
}

/**
 * prepare-stamp <NNN> — write `status: open` + `preparedDate: <today>` + `preparedAgainstSha: <sha>` into the
 * item's frontmatter (the one flag readiness ranks as `✓ ready to ratify`). Authored IN the lane and landed via
 * the one PR — never a primary-tree splice: like the other item-file mutations it is blocked from a primary cwd
 * (guard-bash #2302) and allowed in a `.lanes/` clone. Idempotent (status:open is a no-op on an already-open item).
 */
function prepareStamp() {
  const file = resolveFile(positional[0]);
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  const before = readFileSync(abs, 'utf8');
  // Only (re)write status for an absent/`open` card — an active/preparing/parked claim must survive stamping (#4480).
  const curStatus = (readField(before, 'status') || '').trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  const status = curStatus || 'open';
  let after = status === 'open' ? setFrontmatterField(before, 'status', 'open', { after: ['kind', 'size'] }) : before;
  if (after == null) die(`#${idFromName(file)} — could not splice frontmatter (no frontmatter block?)`);
  const today = localToday();
  after = setFrontmatterField(after, 'preparedDate', `"${today}"`, { after: ['status', 'dateStarted', 'dateOpened'] });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DIR, encoding: 'utf8' }).trim();
  after = setFrontmatterField(after, 'preparedAgainstSha', `"${sha}"`, { after: ['preparedDate'] });
  writeBacklogMd(abs, rel, after);
  ok({ verb: 'prepare-stamp', num: idFromName(file), preparedDate: today, preparedAgainstSha: sha, status },
    `${GRN}✓ prepare-stamped${RST} #${idFromName(file)} ${DIM}→ preparedDate ${today}, preparedAgainstSha ${sha.slice(0, 8)} (status: ${status}; readiness now ranks it ✓ ready to ratify). Commit this item file + land the lane PR.${RST}`);
}

/** prepare-release <NNN> — drop the prepare-hold (the preparer's clear point once the one lane→PR lands).
 *  Local-only token write; idempotent. */
function prepareRelease() {
  const num = idFromName(String(positional[0] || '')); // NNN or `xNNNNNN` (#2288)
  if (!num) die('prepare-release needs a <NNN> to release');
  const before = heldNums(loadHolds(), Date.now()).length;
  const state = removeHold(loadHolds(), [num]);
  saveHolds(state);
  const padded = normalizeId(num); // pad a number, leave a hash untouched
  ok({ verb: 'prepare-release', num: padded, cleared: before - heldNums(state, Date.now()).length },
    `${GRN}✓ prepare-released${RST} #${padded} ${DIM}— hold dropped; the item is claimable again.${RST}`);
}

/**
 * queue <NNN...> [--lane=<ref>] [--session=<slug>] — mark items ready-to-merge (#2138 Fork 4). The
 * lane-producing session calls this at lane-push so a queued item isn't read as re-claimable/abandoned
 * while it waits for the drain. `unqueue <NNN...>` clears the mark (the drain's single clear point at
 * landing). Idempotent. The lane-push/drain call-sites are wired by the drain command (#2162).
 */
function queue() {
  const nums = positional.map((p) => idFromName(p)).filter(Boolean);
  if (!nums.length) die('queue needs one or more <NNN> to mark ready-to-merge');
  for (const n of nums) resolveFile(n); // a typo must not queue a phantom item
  const state = addQueued(loadQueued(), nums, new Date().toISOString(), { lane: flag('lane'), batchSlug: flag('session') });
  saveQueued(state);
  const padded = nums.map(normalizeId);
  ok({ verb: 'queue', queued: padded },
    `${GRN}✓ queued${RST} #${padded.join(', #')} ${DIM}→ ready-to-merge (claim/release refuse it until the drain lands + unqueues it)${RST}`);
}
function unqueue() {
  const nums = positional.map((p) => idFromName(p)).filter(Boolean);
  if (!nums.length) die('unqueue needs one or more <NNN> to clear');
  const before = queuedNums(loadQueued()).length;
  const state = removeQueued(loadQueued(), nums);
  saveQueued(state);
  const cleared = before - queuedNums(state).length;
  ok({ verb: 'unqueue', nums: nums.map(normalizeId), cleared },
    `${GRN}✓ unqueued${RST} ${DIM}— cleared ${cleared} ready-to-merge mark(s); ${queuedNums(state).length} still queued${RST}`);
}

/**
 * reserve <NNN...> --session=<slug> — soft-hold the items a batch PLANS at plan-approval (#083). A live
 * hold deprioritizes (never excludes) those items for OTHER sessions' `check:readiness --select`, so a
 * second concurrent batch packs around them. Advisory: the real lock is still `claim`. First-holder-wins
 * (a num already held by another session is left alone); the holding session is recorded for cleanup.
 */
function reserve() {
  const session = flag('session');
  if (!session) die('reserve needs --session=<batch-slug> — the session that holds these (e.g. batch-2026-06-12-083)');
  const nums = positional.map((p) => idFromName(p)).filter(Boolean);
  if (!nums.length) die('reserve needs one or more <NNN> to soft-hold');
  for (const n of nums) resolveFile(n); // a typo must not hold a phantom item
  const state = addHolds(pruneExpired(loadReservations(), Date.now()), nums, session, new Date().toISOString());
  saveReservations(state);
  const padded = nums.map(normalizeId);
  ok({ verb: 'reserve', session, held: padded, ttlMinutes: state.ttlMinutes },
    `${GRN}✓ reserved${RST} #${padded.join(', #')} ${DIM}→ soft-held by ${session} (deprioritized for other sessions; advisory, TTL ${state.ttlMinutes}m)${RST}\n${DIM}clear on stop: ${RST}node scripts/backlog.mjs unreserve --session=${session}`);
}

/**
 * unreserve [--session=<slug>] [<NNN...>] — release soft holds (#083 invariant 2). `--session` clears
 * the WHOLE session's holds (the batch stop/hand-off path); bare `<NNN>` releases specific items. At
 * least one must be given. Idempotent — releasing an already-free item is a no-op.
 */
function unreserve() {
  const session = flag('session');
  const nums = positional.map((p) => idFromName(p)).filter(Boolean);
  if (!session && !nums.length) die('unreserve needs --session=<slug> (clear a whole session) and/or one or more <NNN>');
  let state = loadReservations();
  const before = state.held.length;
  if (session) state = removeBySession(state, session);
  if (nums.length) state = removeNums(state, nums);
  state = pruneExpired(state, Date.now());
  saveReservations(state);
  const cleared = before - state.held.length;
  ok({ verb: 'unreserve', session: session ?? null, nums: nums.map(normalizeId), cleared },
    `${GRN}✓ unreserved${RST} ${DIM}— released ${cleared} hold(s)${session ? ` for ${session}` : ''}; ${state.held.length} still held${RST}`);
}

function scaffold() {
  // One `kind` axis (#466/#487). Prefer --kind; accept legacy --type/--workitem (a `decision` type wins,
  // else the workItem carries the kind) so older skill/doc invocations don't break mid-migration.
  let kind = flag('kind');
  if (!kind) {
    const legacyType = flag('type');
    const legacyWorkitem = flag('workitem');
    if (legacyType || legacyWorkitem) kind = legacyType === 'decision' ? 'decision' : (legacyWorkitem || 'story');
    else kind = 'story';
  }
  if (!BACKLOG_KINDS.has(kind)) die(`--kind must be one of ${[...BACKLOG_KINDS].join('|')} (got "${kind}")`);
  const size = parseSize(flag('size'));
  const title = flag('title');
  if (!title) die('scaffold needs --title="…"');
  // Shared with the `scaffold`/`file-item` operations (#x0h3pe4): never silently drop a passed --size.
  const sizeProblem = sizeRefusal(kind, flag('size'));
  if (sizeProblem) die(sizeProblem.message);
  const slug = flag('slug') || slugify(title);
  // Cross-refs may point at a landed item (NNN) or an in-flight sibling (hash) — normalize each, never
  // blindly zero-pad (padding a hash would corrupt it). #2288.
  const blockedBy = (flag('blocked-by') || '').split(',').map((s) => s.trim()).filter(Boolean).map(normalizeId);
  const parent = flag('parent') ? normalizeId(flag('parent')) : undefined;
  // Optional predicted touch-set (#x53zzf9) — comma-separated repo-relative path prefixes for the dispatcher.
  const scope = (flag('scope') || '').split(',').map((s) => s.trim()).filter(Boolean);

  // JIT numbering (#2288): a new item is born with a collision-free HASH id, NOT `max+1`. Parallel lanes
  // can no longer race on the next number — the drain (sole serial writer to main, #2290) rewrites the
  // hash to the real sequential NNN at land. The re-glob guards the astronomically-unlikely hash clash.
  const existing = files().map((f) => idFromName(f)).filter(Boolean);
  let finalNum = nextHash(existing);
  let finalName = `${finalNum}-${slug}.md`;
  let finalAbs = join(DIR, finalName);
  if (files().some((f) => f.startsWith(`${finalNum}-`))) {
    finalNum = nextHash([...existing, finalNum]);
    finalName = `${finalNum}-${slug}.md`;
    finalAbs = join(DIR, finalName);
  }
  // Born-active when a creating session owns it (#670): `scaffold --session=<slug>` stamps the item
  // `status: active` + `scaffoldedBy`, so it is excluded from every OTHER session's batch pool until the
  // author `settle`s it (closes the born-public, half-authored-item race). Without `--session` (ad-hoc /
  // hand / non-batch callers) it stays born-open, the long-standing default.
  const session = flag('session');
  const content = renderItem({ kind, size, slug, title, today: today(), blockedBy, parent, scope, digest: flag('digest'), scaffoldedBy: session });
  writeBacklogMd(finalAbs, `backlog/${finalName}`, content);
  const id = finalName.replace(/\.md$/, '');
  const filled = !!flag('digest');
  const nextStep = session
    ? `owned by ${session} (born active) — author digest + edges + body, then \`settle ${finalNum}\` to publish it (→ open)`
    : (filled ? 'add the body (digest set), then re-run check:standards' : 'fill the digest (TODO line) and body, then re-run check:standards');
  ok({ verb: 'scaffold', id, num: finalNum, file: `backlog/${finalName}`, digestFilled: filled, status: session ? 'active' : 'open', scaffoldedBy: session ?? null },
    `${GRN}✓ scaffolded${RST} ${BLD}#${finalNum}${RST} ${DIM}backlog/${finalName}${RST}\n${YEL}→ ${nextStep}${RST}`);
}

/**
 * settle <NNN> — publish a born-active scaffold (#670): flip a `scaffold --session` item from
 * `active` (owned, half-authored, pool-excluded) to `open` (claimable by anyone), once its digest +
 * `blockedBy`/`parent` edges + body are written. Explicit, not auto-on-digest-fill, because only the
 * author knows the edges are final. Refuses an item that is not a born-active scaffold (no `scaffoldedBy`)
 * — a claim-active item is settled by `resolve`, not this.
 */
function settle() {
  const id = positional[0];
  if (!id) die('settle needs <NNN> — the born-active scaffold to publish (→ open)');
  const padded = normalizeId(id); // a born-active scaffold is hash-keyed (#2288) — pad a number, leave a hash
  const file = files().find((f) => f.startsWith(`${padded}-`));
  if (!file) die(`settle: no backlog item #${padded}`);
  const abs = join(DIR, file);
  const src = readFileSync(abs, 'utf8');
  // active → open, and drop the ownership stamps (settled = published, no longer session-owned).
  const res = applySettle(src);
  if (res.error) die(`settle: ${res.error} (#${padded})`);
  writeBacklogMd(abs, `backlog/${file}`, res.content);
  const rel = `backlog/${file}`;
  ok({ verb: 'settle', id: file.replace(/\.md$/, ''), file: rel, status: 'open' },
    `${GRN}✓ settled${RST} ${file.replace(/\.md$/, '')} ${DIM}→ open (published; ownership stamps cleared)${RST}`);
}

/**
 * calibrate — fold one session's `(points resolved, context% at close)` into the **pooled affine
 * context-cost model** that sizes a points-budgeted batch (capacity.json; ratified in #1505). This is the
 * close-out feedback loop: the count cap is gone, so the budget must stay honest about what a session
 * actually fits. `--points` = cost-points resolved (sum of each item's batchCost: a story's size, a
 * task = 2); `--context-pct` = the share of the window consumed at close (the editor's context meter,
 * 1–100); `--stop-reason` (optional) = why the batch stopped, recorded as **audit metadata only** — since
 * #1505 every batch trains the model regardless of stop reason (see capacity.mjs for why).
 *
 * Estimator = a Deming (errors-in-variables) fit of `context% = overhead + cost·points` over EVERY
 * sample's raw `(points, context%)` in the retained 12-sample window. The fixed overhead is the intercept
 * (real work in every batch), so it is measured rather than misattributed to per-point cost, and the old
 * work-bound exclusion gate is gone — work-bound is the common case, so dropping it stops the estimate
 * starving on the rare capacity-bound stop. The next budget is the largest P under a context ceiling minus
 * a data-driven margin (`budgetFromFit`); `contextCeiling`/`marginK` in the JSON tune it (defaults 80/1),
 * replacing the arbitrary ×0.6. The 12-sample window ages out old sessions, staying adaptive to a regime
 * change (a new model); RLS-with-forgetting is the planned successor (#1516).
 */
function calibrate() {
  const points = Number(flag('points'));
  const ctxPct = Number(flag('context-pct'));
  const stopReason = flag('stop-reason'); // optional; audit metadata only since #1505 (every batch trains)
  if (!Number.isFinite(points) || points <= 0) die('calibrate needs --points=<cost-points resolved this session>');
  if (!Number.isFinite(ctxPct) || ctxPct <= 0 || ctxPct > 100) die('calibrate needs --context-pct=<1–100, context consumed at close>');
  // Fail-closed on an unrecognised --stop-reason (#968): reject a typo / un-listed token rather than
  // recording a garbage audit tag.
  if (stopReason && !isKnownStopReason(stopReason))
    die(`calibrate: unknown --stop-reason="${stopReason}" — use one of: ${[...KNOWN_STOP_REASONS].join(', ')} (or omit it)`);

  let cap;
  try { cap = JSON.parse(readFileSync(CAPACITY_PATH, 'utf8')); }
  catch { die(`cannot read ${CAPACITY_PATH} — run a batch in this repo first (the file ships seeded)`); }

  const sample = { date: today(), points, contextPct: ctxPct };
  if (stopReason) sample.stopReason = stopReason;
  // #1516: the hard 12-sample window is gone — the RLS forgetting factor (below) ages old samples out
  // smoothly instead of by a cutoff, so ALL history is kept and weighted by recency. The `.slice(-200)`
  // is a pure storage bound (the file can't grow without limit), not a statistical window: at the default
  // forgetting ≈ 0.99 a 200-old sample already weighs 0.99^199 ≈ 0.13, well past the effective window.
  const samples = [...(Array.isArray(cap.samples) ? cap.samples : []), sample].slice(-200);

  const ceiling = Number.isFinite(cap.contextCeiling) ? cap.contextCeiling : 80;
  const k = Number.isFinite(cap.marginK) ? cap.marginK : 1;
  // RLS forgetting factor (#1516): tunable via capacity.json, default 0.99 (the ≈0.98–0.995 band ratified
  // in #1505). Newest samples dominate; a regime change ages out smoothly. `1` → unweighted pooled fit.
  const forgetting = Number.isFinite(cap.forgetting) && cap.forgetting > 0 && cap.forgetting <= 1 ? cap.forgetting : 0.99;
  const fit = fitAffineCost(samples, { forgetting });
  const budget = budgetFromFit(fit, { ceiling, k });
  const capPts = impliedCapacity(fit);

  // Fall back to the prior estimate only when the fit is degenerate (e.g. < 2 samples on a fresh file).
  const prevBudget = Number.isFinite(cap.budgetPoints) ? cap.budgetPoints
    : Number.isFinite(cap.capacityPoints) ? Math.round(cap.capacityPoints * (cap.targetFraction ?? 0.5)) : null;
  const nextBudget = budget ?? prevBudget;

  cap.samples = samples;
  if (fit) {
    cap.fit = { overhead: Math.round(fit.overhead * 100) / 100, cost: Math.round(fit.cost * 10000) / 10000, n: fit.n, nEff: Math.round(fit.nEff * 10) / 10, residualStd: Math.round(fit.residualStd * 100) / 100 };
    if (capPts != null) cap.capacityPoints = capPts;
  }
  cap.contextCeiling = ceiling;
  cap.marginK = k;
  cap.forgetting = forgetting;
  if (nextBudget != null) cap.budgetPoints = nextBudget;
  delete cap.ema; // legacy fixed-α weight — long unused
  delete cap.targetFraction; // superseded by contextCeiling/marginK (#1505); budgetPoints is now stored directly
  writeFileSync(CAPACITY_PATH, JSON.stringify(cap, null, 2) + '\n');

  const note = fit
    ? `affine fit over ${fit.n} (nEff ${cap.fit.nEff} @ forgetting ${forgetting}; overhead ${cap.fit.overhead}%, cost ${cap.fit.cost}%/pt); capacity ≈ ${capPts}`
    : `fit degenerate (need ≥2 samples) — held prior budget`;
  ok({ verb: 'calibrate', points, contextPct: ctxPct, stopReason: stopReason ?? null, fit: cap.fit ?? null, capacityPoints: cap.capacityPoints ?? null, budget: nextBudget },
    `${GRN}✓ calibrated${RST} ${DIM}— ${points} pts at ${ctxPct}% → ${note}; next batch budget ≈ ${RST}${BLD}${nextBudget ?? '?'} pts${RST}`);
}

/**
 * retype <NNN> [--to=<kind>] [--size=N|none] [--status=<s>] — `--size=none` drops the field. The SANCTIONED pack-phase flag-fix (#2123 escape
 * that isn't `LANE_GUARD_OFF`). The batch skill tells the packer to "fix a mis-flagged item in place" — retype
 * a `story` the pre-flight found is really a `decision`, bump a `size` to 13 to drop it from the pool, park it
 * — but the lane guard blocks a raw primary-tree Edit of the item's `.md`, which pushed agents to override the
 * guard by hand. This does the SAME frontmatter splice through the sanctioned CLI (guard-clean, auditable, and
 * the locus-prefix scan still runs), so no `LANE_GUARD_OFF` is needed. Frontmatter-only; the body is untouched.
 */
function retype() {
  const file = resolveFile(positional[0]);
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  let src = readFileSync(abs, 'utf8');
  const toKind = flag('to');
  const toSize = flag('size');
  const toStatus = flag('status');
  if (!toKind && toSize === undefined && !toStatus) die('retype needs at least one of --to=<kind> / --size=N / --status=<s>');
  if (toKind && !BACKLOG_KINDS.has(toKind)) die(`--to must be one of ${[...BACKLOG_KINDS].join('|')} (got "${toKind}")`);
  const curStatus = readField(src, 'status') || 'open';
  if (curStatus === 'resolved' && !argv.includes('--force')) die(`#${idFromName(file)} is resolved — retyping a closed item is almost certainly a mistake; pass --force if deliberate`);
  const changes = [];
  if (toKind) { src = setFrontmatterField(src, 'kind', toKind, { after: [] }); changes.push(`kind→${toKind}`); }
  if (toSize === 'none') {
    // Drop `size` (frontmatter only). The split flow's "sliced epic carries no size" step (workflow-invariants
    // rule 1) had no sanctioned way to do this, so a split stalled on a hand-edit.
    const m = src.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (m) src = m[1] + m[2].replace(/^size:[^\n]*\n?/m, '') + m[3] + src.slice(m[0].length);
    changes.push('size dropped');
  } else if (toSize !== undefined) {
    const n = Number(toSize);
    if (!Number.isFinite(n) || n < 0) die(`--size must be a non-negative number (got "${toSize}")`);
    src = setFrontmatterField(src, 'size', String(n), { after: ['kind'] }); changes.push(`size→${n}`);
  }
  if (toStatus) { src = setFrontmatterField(src, 'status', toStatus, { after: ['kind', 'size'] }); changes.push(`status→${toStatus}`); }
  writeBacklogMd(abs, rel, src);
  const id = file.replace(/\.md$/, '');
  ok({ verb: 'retype', id, file: rel, changes },
    `${GRN}✓ retyped${RST} ${BLD}#${idFromName(file)}${RST} ${DIM}${changes.join(', ')}${RST}`);
}

/**
 * prioritize <NNN> [--to=<value>|--clear] — set or clear the item's `priority` frontmatter (the same field
 * the readiness/batch machinery reads when it ranks work). Frontmatter-only, like {@link retype}. `--to`
 * takes a simple lowercase token (e.g. `low`); `--clear` (or an empty `--to`) removes the field, returning
 * the item to the default (unprioritised). A resolved item is refused without `--force`.
 */
function prioritize() {
  const file = resolveFile(positional[0]);
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  let src = readFileSync(abs, 'utf8');
  const to = flag('to');
  const clear = argv.includes('--clear') || to === '';
  if (!to && !clear) die('prioritize needs --to=<value> (e.g. low) or --clear');
  if (to && !clear && !/^[a-z]+$/.test(to)) die(`--to must be a simple lowercase token (e.g. low), got "${to}"`);
  const curStatus = readField(src, 'status') || 'open';
  if (curStatus === 'resolved' && !argv.includes('--force')) die(`#${idFromName(file)} is resolved — reprioritising a closed item is almost certainly a mistake; pass --force if deliberate`);
  let change;
  if (clear) {
    // Remove the `priority:` line from the frontmatter block ONLY (scoped between the two fences).
    const m = src.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (m) src = m[1] + m[2].replace(/^priority:[^\n]*\n?/m, '') + m[3] + src.slice(m[0].length);
    change = 'priority cleared';
  } else {
    src = setFrontmatterField(src, 'priority', to, { after: ['size', 'kind'] });
    change = `priority→${to}`;
  }
  writeBacklogMd(abs, rel, src);
  const id = file.replace(/\.md$/, '');
  ok({ verb: 'prioritize', id, file: rel, change },
    `${GRN}✓ prioritized${RST} ${BLD}#${idFromName(file)}${RST} ${DIM}${change}${RST}`);
}

// ── Build-queue prioritization verbs (#2528) — tier / rank / weights ─────────────────────────────────
// These set the autonomous build queue's ordering fields (epic #2527), per the ratified design #2526. All
// three are FRONTMATTER-ONLY splices, like {@link prioritize}, and NONE touches `blockedBy` or readiness —
// the ratified invariant: prioritization is strictly DOWNSTREAM of readiness (it only orders the ready set).

/** Read a sibling item's `rank` field (for the relative --after/--before rank computation). */
function rankOf(ref) {
  const f = resolveFile(ref);
  return readField(readFileSync(join(DIR, f), 'utf8'), 'rank') || '';
}

/**
 * tier <NNN> --to=<pinned|normal|someday|won't> | --clear — set the coarse build-queue TIER (the primary
 * sort key + the human override). Frontmatter-only. Refuses a resolved item without --force.
 */
function tier() {
  const file = resolveFile(positional[0]);
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  let src = readFileSync(abs, 'utf8');
  const to = flag('to');
  const clear = argv.includes('--clear') || to === '';
  if (!to && !clear) die(`tier needs --to=<${TIERS.join('|')}> or --clear`);
  if (to && !clear && !TIERS.includes(to)) die(`--to must be one of ${TIERS.join(', ')} (got "${to}")`);
  if ((readField(src, 'status') || 'open') === 'resolved' && !argv.includes('--force')) {
    die(`#${idFromName(file)} is resolved — re-tiering a closed item is almost certainly a mistake; pass --force if deliberate`);
  }
  let change;
  if (clear) {
    const m = src.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (m) src = m[1] + m[2].replace(/^tier:[^\n]*\n?/m, '') + m[3] + src.slice(m[0].length);
    change = 'tier cleared';
  } else {
    src = setFrontmatterField(src, 'tier', to, { after: ['priority', 'size', 'kind'] });
    change = `tier→${to}`;
  }
  writeBacklogMd(abs, rel, src);
  ok({ verb: 'tier', id: file.replace(/\.md$/, ''), file: rel, change },
    `${GRN}✓ tiered${RST} ${BLD}#${idFromName(file)}${RST} ${DIM}${change}${RST}`);
}

/**
 * rank <NNN> --to=<key> | --after=<NNN> [--before=<NNN>] | --before=<NNN> — set the between-able LexoRank
 * key for manual drag-ordering within a tier. `--after`/`--before` compute the key between the named
 * neighbours' ranks (via the engine's `rankBetween`); `--to` persists an explicit base-36 key.
 */
function rank() {
  const file = resolveFile(positional[0]);
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  let src = readFileSync(abs, 'utf8');
  const to = flag('to');
  const after = flag('after');
  const before = flag('before');
  let key;
  if (to) {
    if (!/^[0-9a-z]+$/.test(to)) die(`--to must be a base-36 rank key ([0-9a-z]+), got "${to}"`);
    key = to;
  } else if (after != null || before != null) {
    const lo = after != null ? rankOf(after) : '';
    const hi = before != null ? rankOf(before) : '';
    try { key = rankBetween(lo, hi); }
    catch (e) { die(`cannot rank between ${after != null ? '#' + after : 'start'} and ${before != null ? '#' + before : 'end'}: ${e.message}`); }
  } else {
    die('rank needs --to=<key>, or --after=<NNN> and/or --before=<NNN>');
  }
  if ((readField(src, 'status') || 'open') === 'resolved' && !argv.includes('--force')) {
    die(`#${idFromName(file)} is resolved — re-ranking a closed item is almost certainly a mistake; pass --force if deliberate`);
  }
  src = setFrontmatterField(src, 'rank', key, { after: ['tier', 'priority', 'size', 'kind'] });
  writeBacklogMd(abs, rel, src);
  ok({ verb: 'rank', id: file.replace(/\.md$/, ''), file: rel, change: `rank→${key}`, key },
    `${GRN}✓ ranked${RST} ${BLD}#${idFromName(file)}${RST} ${DIM}rank→${key}${RST}`);
}

/** Load the build-queue scoring config (or the engine's default if none is committed / it's malformed). */
function loadBuildQueueConfig() {
  try {
    const cfg = JSON.parse(readFileSync(BUILD_QUEUE_CONFIG_PATH, 'utf8'));
    // A valid-JSON-but-shapeless file (e.g. a hand-edit missing `criteria`) falls back to the default
    // rather than crashing `--show`'s `criteria.map` (#2528 review).
    return cfg && Array.isArray(cfg.criteria) ? cfg : structuredClone(DEFAULT_CONFIG);
  } catch { return structuredClone(DEFAULT_CONFIG); }
}

/**
 * weights [--show] | --set=<key>=<n> [--set=…] — read or edit the build-queue scoring CONFIG (the criterion
 * weights the WSJF-shaped engine ranks by). Validated on write (sum 100, ≤5 criteria, none >50%); an invalid
 * edit is refused, never persisted. Config is data, separate from items — editing it re-ranks everything.
 */
function weights() {
  const cfg = loadBuildQueueConfig();
  const sets = argv.filter((a) => a.startsWith('--set=')).map((a) => a.slice('--set='.length));
  if (argv.includes('--show') || sets.length === 0) {
    return ok({ verb: 'weights', config: cfg },
      `${BLD}build-queue config${RST}\n${cfg.criteria.map((c) => `  ${c.key}: ${c.weight}`).join('\n')}\n  ${DIM}aging.ratePerDay: ${cfg.aging?.ratePerDay ?? 0}${RST}`);
  }
  for (const s of sets) {
    const eq = s.indexOf('=');
    const rawVal = eq >= 0 ? s.slice(eq + 1) : '';
    const key = eq >= 0 ? s.slice(0, eq) : s;
    const n = Number(rawVal);
    if (eq < 0 || rawVal === '' || Number.isNaN(n)) die(`--set expects <key>=<number>, got "${s}"`);
    const crit = cfg.criteria.find((c) => c.key === key);
    if (!crit) die(`unknown criterion "${key}" (have: ${cfg.criteria.map((c) => c.key).join(', ')})`);
    crit.weight = n;
  }
  const v = validateConfig(cfg);
  if (!v.ok) die(`refused — the config would be invalid: ${v.errors.join('; ')}`);
  // Lane-gate the config write too (#2528 review): like writeBacklogMd, refuse a write that resolves under
  // the shared PRIMARY checkout so this tracked config is never spliced onto the primary tree (#2302/#2339).
  if (laneGuardDecision(resolveReal(dirname(BUILD_QUEUE_CONFIG_PATH)), ROOT)) {
    die(`build-queue config mutation BLOCKED — "${BUILD_QUEUE_CONFIG_PATH}" resolves under the shared PRIMARY checkout; run it in a lane clone, never primary (#2302/#2339). No override.`);
  }
  writeFileSync(BUILD_QUEUE_CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  ok({ verb: 'weights', config: cfg },
    `${GRN}✓ weights updated${RST} ${DIM}${cfg.criteria.map((c) => `${c.key}=${c.weight}`).join(' ')}${RST}`);
}

/**
 * overlap-yield-config [--show] | --set-enabled=<true|false> | --set-window=<minutes> — the ONE sanctioned
 * editor for the TRACKED (#4308, never git-ignored — unlike `weights`' `build-queue-config.json`) drain
 * land-time overlap-yield settings (`we:scripts/drain-overlap-yield-config.json`, `{enabled, windowMinutes}`).
 * Strictly validated on write (`enabled` boolean, `windowMinutes` a finite number > 0) — an invalid edit is
 * refused, nothing is written; `--set-enabled` accepts ONLY the literal strings `true`/`false` — anything else
 * (`yes`, `1`, `TRUE`) is a usage error, never a silent fall-through to `--show` (2026-09-29 review finding).
 * Attempts a per-file lock around the read-modify-write (`we:scripts/readiness/file-locks.mjs`, via
 * `writeOverlapYieldConfig`) — never a bare `writeFileSync` — but DEGRADES to an unlocked write when the lock
 * cannot be acquired (mirrors `we:scripts/lib/target-registry.mjs#appendRegistryEntry`'s own `unlocked: true`
 * convention); the printed result says so plainly rather than claiming a concurrent writer was ruled out.
 * Lane-gated exactly like `weights`: this tracked file must never be spliced onto the shared PRIMARY checkout.
 */
function overlapYieldConfig() {
  const path = defaultOverlapYieldConfigPath();
  const setEnabledFlag = argv.find((a) => a.startsWith('--set-enabled='));
  const windowFlag = argv.find((a) => a.startsWith('--set-window='));
  if (argv.includes('--show') || (!setEnabledFlag && !windowFlag)) {
    const cfg = loadOverlapYieldConfig({ path, warn: (msg) => process.stderr.write(`${msg}\n`) });
    return ok({ verb: 'overlap-yield-config', config: cfg },
      `${BLD}drain overlap-yield config${RST}\n  enabled: ${cfg.enabled}\n  windowMinutes: ${cfg.windowMinutes}`);
  }
  const patch = {};
  if (setEnabledFlag) {
    const raw = setEnabledFlag.slice('--set-enabled='.length);
    if (raw !== 'true' && raw !== 'false') die(`--set-enabled expects "true" or "false", got "${raw}"`);
    patch.enabled = raw === 'true';
  }
  if (windowFlag) {
    const raw = windowFlag.slice('--set-window='.length);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) die(`--set-window expects a positive number of minutes, got "${raw}"`);
    patch.windowMinutes = n;
  }
  if (laneGuardDecision(resolveReal(dirname(path)), ROOT)) {
    die(`overlap-yield config mutation BLOCKED — "${path}" resolves under the shared PRIMARY checkout; run it in a lane clone, never primary (#2302/#2339/#4308). No override.`);
  }
  const result = writeOverlapYieldConfig({ path, patch, owner: `backlog.mjs:${process.pid}` });
  if (!result.ok) die(`refused — the config would be invalid: ${result.errors.join('; ')}`);
  ok({ verb: 'overlap-yield-config', config: result.config, locked: result.locked },
    `${GRN}✓ overlap-yield config updated${RST} ${DIM}enabled=${result.config.enabled} windowMinutes=${result.config.windowMinutes}${result.locked ? '' : ' (lock unavailable — wrote unlocked; a concurrent writer may have raced this edit)'}${RST}`);
}

/**
 * build-queue [--json] [--next] — READ the ordered build queue (epic #2527): every READY item in the exact
 * order the autonomous builder would pull them (tier → effectiveScore → rank → dateOpened → num), each row
 * annotated with WHY it ranks there (build-queue tier + score). PURE READ — nothing on disk changes; the
 * console queue view (#2529) shells this and the builder (#2530) will too, so a user sees exactly what gets
 * built next (one engine, no re-implementation → no drift). `--next` emits just the head (or null when empty).
 *
 * TIER RECOVERY: the single loader overwrites `item.tier` with the derived A/B/C *leverage* tier (#249),
 * which collides in NAME with the build-queue tier (pinned/normal/someday/won't). We RE-READ the raw
 * frontmatter tier for the open set the engine orders, so it sorts on the human's pin, never the readiness
 * rubric. All other engine inputs (status, blockedBy, size, dateOpened, value/timeCriticality/confidence,
 * rank) come straight off the loader (`...data`), which is authoritative for them.
 */
function buildQueue() {
  // A `--backlog-dir=` fixture run is uncached unless the caller opts in with WE_BUILD_QUEUE_CACHE=1 (the cache-key
  // regression test does, so it can exercise the cache on a small corpus instead of the live 5k-card backlog).
  const cacheEnabled = JSON_MODE && !argv.some(arg => arg.startsWith('--config=')) &&
    (!argv.some(arg => arg.startsWith('--backlog-dir=')) || process.env.WE_BUILD_QUEUE_CACHE === '1') &&
    process.env.WE_BUILD_QUEUE_CACHE !== '0' &&
    !(isUnderTest() && process.env.WE_BUILD_QUEUE_CACHE === undefined);
  const at = Date.now();
  // #4355 — the cleared set and the priority settings are inputs too: fold their files' mtimes into the key, so a
  // `queue.mjs add/remove` or a settings edit is never answered from a stale cached read.
  const queueFilePath = resolveQueuePath();
  const queueSrc = resolveQueueSource(queueFilePath);
  const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return 'none'; } };
  const baseKey = cacheEnabled ? buildQueueCacheKey({ backlogDir: DIR, configPath: BUILD_QUEUE_CONFIG_PATH,
    next: argv.includes('--next') }) : null;
  const key = baseKey === null ? null
    : JSON.stringify([baseKey, queueSrc.path, mtimeOf(queueSrc.path), mtimeOf(DELIVERY_PRIORITY_SETTINGS_PATH),
      mtimeOf(join(SETTINGS_DIR, 'build-queue-priority.json')), process.env.WE_BUILD_QUEUE_PRIORITY_MODE,
      // The tool layer is the MERGE of dispatch-settings.json + every scripts/settings/*.json, so a later-sorting file can
      // set it too: key on the merged value itself, not only on the one file's mtime.
      JSON.stringify(readSettings().buildQueuePriority ?? null)]);
  const file = cacheEnabled ? buildQueueCacheFile(DIR) : null;
  const configuredAge = Number(process.env.WE_BUILD_QUEUE_CACHE_MAX_AGE_MS ?? 60_000);
  const maxAgeMs = Number.isFinite(configuredAge) && configuredAge >= 0 ? configuredAge : 60_000;
  if (key !== null) {
    const stdout = readBuildQueueCache({ file, key, now: at, maxAgeMs });
    if (stdout !== null) { writeAllSync(1, stdout); process.exit(0); }
  }
  const emit = (payload, human) => {
    if (key === null) return ok(payload, human);
    const stdout = `${JSON.stringify({ ok: true, ...payload })}\n`;
    writeBuildQueueCache({ file, key, at, stdout });
    writeAllSync(1, stdout);
    process.exit(0);
  };
  // `--config=<path>` previews the order under a HYPOTHETICAL config (the console's live weights preview,
  // #2529) WITHOUT persisting it — validated, never written. Absent → the committed/default config.
  const configPath = flag('config');
  let config;
  if (configPath) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch (e) { die(`--config: cannot read/parse "${configPath}": ${e.message}`); }
    const v = validateConfig(parsed);
    if (!v.ok) die(`--config is invalid: ${v.errors.join('; ')}`);
    config = parsed;
  } else {
    config = loadBuildQueueConfig();
  }
  const loaded = requireCjs(join(ROOT, 'src/_data/backlog.js'))();
  // #4355 — CLEARED = membership of the conveyor sidecar, read through queue-store's state-home resolver (the same
  // read `queue.mjs list`, dispatch-plan and conveyor-state use; #2613/#4075), NOT committed `buildQueued`
  // frontmatter (which reported `cleared: 0` from every checkout once the sidecar moved to the state home). A
  // JIT-numbered card cleared under its pre-number hash still matches (bornAs resolve-at-read-time). The entry's
  // `addedAt` is when the card started waiting in the build queue — the delivery class's wait (aging + score).
  const sidecar = resolveBornAsRefs(readQueueFile(queueFilePath), bornAsIndexFromItems(loaded));
  const clearedAt = new Map(sidecar.map((e) => [normNum(e.num), e.addedAt ?? null]));
  const items = loaded.map((it) => {
    if (it.status !== 'open') return it; // only the open set is ordered; skip the re-read for the rest
    const k = normNum(it.num);
    const queue = { buildQueued: clearedAt.has(k), queuedAt: clearedAt.get(k) ?? undefined };
    // Recover the raw build-queue tier (the loader clobbers `tier` with the A/B/C leverage tier). A missing
    // file (e.g. fixture-mode dir divergence) falls back to undefined → the engine treats it as `normal`.
    let rawTier;
    try { rawTier = readField(readFileSync(join(DIR, `${it.id}.md`), 'utf8'), 'tier') || undefined; }
    catch { rawTier = undefined; }
    return { ...it, tier: rawTier, ...queue };
  });
  // Keep platform preferences raw so the tool and environment override only their declared keys.
  let platform;
  try { platform = JSON.parse(readFileSync(DELIVERY_PRIORITY_SETTINGS_PATH, 'utf8')).deliveryPriority; }
  catch { platform = undefined; }
  const priority = resolveBuildQueuePrioritySettings({
    platform, tool: readSettings().buildQueuePriority, env: process.env,
  });
  const detailed = orderQueueDetailed(items, config, Date.now(), { priority });
  const shadow = priority.mode === 'shadow'
    ? { shadowClassOrder: classOrder(detailed).map((r) => r.item.num) } : {};
  if (priority.mode === 'shadow') console.error(formatBuildQueuePriorityShadowLine(detailed, priority.mode));
  const rows = detailed.map((r) => ({
    num: r.item.num,
    id: r.item.id,
    title: r.item.title,
    tier: r.tier,
    score: Number(r.score.toFixed(6)),
    unblocks: r.unblocks,
    rank: r.rank || null,
    size: r.item.size ?? null,
    dateOpened: r.item.dateOpened ?? null,
    buildQueued: r.buildQueued, // cleared for build: membership of the conveyor sidecar (#2613, #4355)
    queuedAt: r.item.queuedAt ?? null,
    priorityClass: r.priorityClass,
    priorityScore: r.priorityScore,
    priorityReasons: r.priorityReasons,
  }));
  if (argv.includes('--next')) {
    // The builder's ACTUAL next = the top-ordered item the human has CLEARED for build (#2530), not merely the
    // top ready one. A ready, high-tier item that hasn't been cleared is never auto-built.
    const head = rows.find((r) => r.buildQueued) ?? null;
    return emit({ verb: 'build-queue', next: head, config, priorityMode: priority.mode, prioritySource: priority.source, ...shadow },
      head ? `${GRN}next → #${head.num}${RST} ${DIM}[${head.priorityClass} · ${head.tier} · ${head.score.toFixed(2)}] ${head.title}${RST}`
           : `${DIM}build queue empty (no items cleared for build)${RST}`);
  }
  const clearedCount = rows.filter((r) => r.buildQueued).length;
  const sidecarInfo = { path: queueSrc.path, source: queueSrc.source, entries: sidecar.length };
  return emit({ verb: 'build-queue', count: rows.length, cleared: clearedCount, sidecar: sidecarInfo, priorityMode: priority.mode, prioritySource: priority.source, ...shadow, queue: rows, config },
    `${BLD}build queue${RST} ${DIM}(${rows.length} ready · ${clearedCount} cleared for build (${sidecar.length} in ${queueSrc.path}) · ${priority.mode === 'enforce' ? 'class-first order' : 'next-to-build order'}, priority ${priority.mode})${RST}\n` +
    rows.slice(0, 25).map((r, i) => `  ${String(i + 1).padStart(2)}. ${r.buildQueued ? `${GRN}✓${RST}` : ' '} ${BLD}#${r.num}${RST} ${DIM}[${r.priorityClass} · ${r.tier} · ${r.score.toFixed(2)}] ${r.priorityReasons.join('; ')}${RST} ${r.title}`).join('\n') +
    (rows.length > 25 ? `\n  ${DIM}… +${rows.length - 25} more${RST}` : ''));
}

/**
 * build-queue add|remove <NNN> — the human's manual CLEAR-FOR-BUILD gate (#2530). `add` sets `buildQueued:
 * true` (the supervised builder may then pull it); `remove` clears the flag. Frontmatter-only + lane-gated,
 * like {@link tier}/{@link rank} — and like them it NEVER touches blockedBy/readiness. The builder pulls ONLY
 * cleared items, so re-prioritizing (tier/rank) never arms an autonomous build; only an explicit `add` does.
 */
function buildQueueMark(action) {
  const file = resolveFile(positional[1]); // positional[0] is the sub-verb ('add'/'remove')
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  let src = readFileSync(abs, 'utf8');
  if (action === 'add' && (readField(src, 'status') || 'open') !== 'open') {
    die(`#${idFromName(file)} is not open — only an open item can be cleared for build`);
  }
  if (action === 'add') {
    src = setFrontmatterField(src, 'buildQueued', 'true', { after: ['tier', 'priority', 'size', 'kind'] });
  } else {
    src = removeFrontmatterField(src, 'buildQueued'); // CRLF-safe shared helper (not a hand-rolled regex)
  }
  writeBacklogMd(abs, rel, src);
  ok({ verb: 'build-queue', action, id: file.replace(/\.md$/, ''), file: rel, buildQueued: action === 'add' },
    `${GRN}✓ ${action === 'add' ? 'cleared for build' : 'removed from build queue'}${RST} ${BLD}#${idFromName(file)}${RST}`);
}

/**
 * yield <NNN-slug> — resolve an NNN COLLISION by moving a LOCAL-ONLY item to the next free number (the guard's
 * own prescription: "a new item takes the next free number; yield this one"). Renumbering a *committed* item is
 * forbidden — NNN is immutable — so this REFUSES a git-tracked file and only ever moves an untracked/local one.
 * Takes the full `NNN-slug` (or a unique prefix) so it targets the right file when two share a number. Writes
 * the new `<freeNum>-<slug>.md`, deletes the old, and reports the new number — the sanctioned counterpart to a
 * hand `git mv` (which the renumber guard blocks).
 */
function yieldNum() {
  const ref = positional[0];
  if (!ref) die('yield needs <NNN-slug> — the local-only colliding item to move to a free number');
  const matches = files().filter((f) => f === ref || f === `${ref}.md` || f.startsWith(`${ref}`));
  if (matches.length === 0) die(`no backlog file matching "${ref}"`);
  if (matches.length > 1) die(`"${ref}" is ambiguous: ${matches.join(', ')} — pass the full NNN-slug`);
  const file = matches[0];
  const rel = `backlog/${file}`;
  // Immutability guard: only a LOCAL-ONLY (untracked) item may yield; a committed NNN never moves.
  let tracked = true;
  try { execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT, stdio: 'pipe' }); }
  catch { tracked = false; }
  if (tracked && !argv.includes('--force')) die(`${rel} is git-tracked — NNN is immutable, a committed item never renumbers. yield only moves a LOCAL-ONLY (untracked) collision. (If this really is a dup to reconcile, that's a manual call.)`);
  const slug = slugFromName(file.replace(/\.md$/, '')); // two-form id (#2288): strip NNN- or xNNNNNN-
  const existing = files().map((f) => (f.match(/^(\d+)/) || [])[1]).filter(Boolean);
  const newNum = nextNum(existing);
  const newName = `${newNum}-${slug}.md`;
  if (files().some((f) => f.startsWith(`${newNum}-`))) die(`race: #${newNum} just got taken — re-run yield`);
  const content = readFileSync(join(DIR, file), 'utf8');
  writeBacklogMd(join(DIR, newName), `backlog/${newName}`, content);
  unlinkSync(join(DIR, file));
  ok({ verb: 'yield', from: file.replace(/\.md$/, ''), to: newName.replace(/\.md$/, ''), num: newNum, file: `backlog/${newName}` },
    `${GRN}✓ yielded${RST} ${DIM}${file} →${RST} ${BLD}#${newNum}${RST} ${DIM}backlog/${newName}${RST}`);
}

// `cost <NNN> --tokens="in:.. cw:.. cr:.. out:.."` (or --in= --cw= --cr= --out=) — fold a session's usage
// into a card's cumulative accounting (#close cost-on-card). The DURABLE record is the cumulative token
// breakdown `costTokens`; `costUsd` is DERIVED from it through the one shared rate table (cost-rates.mjs)
// at every accrual, so it can never drift from a stale rate and is always regenerable. A pure frontmatter
// splice via `accrueCost`. The close skill decides WHICH card(s) and how much (a single dominant
// decision/prepare session → full cost on one card; a workflow → even-split across the N items it worked;
// slice/resolve attribute nothing). `--sessions=<n>` overrides the +1 session-share. `--usd=` is accepted
// for back-compat but IGNORED — usd is no longer a source of truth, only the tokens are.
function cost() {
  const file = resolveFile(positional[0]);
  // Tokens are the source of truth: a single --tokens="in:.. cw:.. cr:.. out:.." (colon or = separator,
  // e.g. the estimator's `--tokens-only` line) OR the four individual flags. Individual flags override.
  const tokens = parseCostTokens(flag('tokens'));
  for (const k of ['in', 'cw', 'cr', 'out']) {
    const v = flag(k);
    if (v !== undefined) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) die(`cost --${k}=<non-negative integer token count>, got "${v}"`);
      tokens[k] = n;
    }
  }
  const anyTokens = tokens.in || tokens.cw || tokens.cr || tokens.out;
  if (!anyTokens) die('cost needs the token breakdown — --tokens="in:.. cw:.. cr:.. out:.." (the estimator\'s --tokens-only line) or --in= --cw= --cr= --out=. (usd is now DERIVED from tokens; --usd= is ignored.)');
  if (flag('usd') !== undefined) console.error(`${YEL}note:${RST} ${DIM}--usd is ignored — costUsd is derived from the token breakdown (cost-rates.mjs).${RST}`);
  const sessions = Number(flag('sessions'));
  const rel = `backlog/${file}`;
  const abs = join(DIR, file);
  const before = readFileSync(abs, 'utf8');
  const after = accrueCost(before, tokens, Number.isFinite(sessions) ? { sessions } : {});
  if (after == null) die(`#${idFromName(file)} — could not splice frontmatter (no frontmatter block?)`);
  writeBacklogMd(abs, rel, after);
  const total = readField(after, 'costUsd');
  const toks = readField(after, 'costTokens');
  const n = readField(after, 'costSessions');
  ok({ verb: 'cost', num: idFromName(file), added: tokens, costTokens: toks, costUsd: Number(total), costSessions: Number(n) },
    `${GRN}✓ cost${RST} ${DIM}— +[${formatCostTokens(tokens)}] → $${total} (derived) over ${n} session(s) on #${idFromName(file)}${RST}`);
}

// #2319 — a one-shot repair: number every TRACKED hash-id backlog file in this checkout (a hash that reached
// main via a numbering-bypassing land route, e.g. pr-land --fallback-git). Reuses the drain's numberPendingHashes
// (the same JIT-numbering engine, #2288) so refs (blockedBy/parent/short-refs) are rewritten identically.
// `--dry-run` reports the planned mapping without touching the tree.
//
// IT MUST NOT RUN IN A LANE, and "the checkout carrying the stray" used to read as if it could. A lane
// carries the stray too — it branched from the main that has it — but the NNN this assigns is only valid
// when it is assigned against SERIALIZED MAIN (#2288). Assign it in a lane and `check:standards` rejects
// the result from the other side: *"carries a hand-picked NNN id that is not on origin/main"*. So the verb
// refuses both ways at once, and the operator is left holding a half-applied rename with no verb to finish
// it — which is exactly what happened on 2026-09-06 (7 cards, renamed then reverted by hand).
//
// The guard is a locus test, the same one `we:scripts/guard-lane.mjs` uses to separate a lane clone from a
// primary: a lane lives under `<workspace>/.lanes/`. Refuse there and name the two places it DOES belong.
function numberStranded() {
  const dryRun = argv.includes('--dry-run');
  // #1961 review r4 — test ROOT, NOT `process.cwd()`. The repair below writes to `ROOT` (this script's own
  // checkout, resolved from `import.meta.url`), so cwd is the wrong thing to ask: invoked by ABSOLUTE PATH
  // from an unrelated directory — `cd /tmp && node /…/.lanes/<pool>/lane-1/scripts/backlog.mjs
  // number-stranded` — the cwd test passed and the verb went on to renumber the LANE's cards, which is the
  // exact half-applied rename this guard exists to prevent. Verified against the running code before the fix
  // (it offered to number 2 cards); the inverse mis-invocation also FALSELY refused a legitimate primary run.
  // A locus guard must test the locus it protects.
  if (isLaneLocus(resolveReal(ROOT), sep)) {
    die('number-stranded: refusing to run in a LANE clone. The NNN it assigns is only valid when assigned '
      + 'against serialized main (#2288) — assigned here, check:standards rejects the result as "a hand-picked '
      + 'NNN not on origin/main", so the verb would refuse both ways and leave a half-applied rename. Run it '
      + 'in a PRIMARY checkout, or leave it to the drain, whose at-land pass numbers strays automatically.');
  }
  const r = numberPendingHashes(ROOT, { dryRun });
  if (r.error) die(`number-stranded: ${r.error}`);
  if (!r.assigned || r.assigned.length === 0) { console.log('number-stranded: no stranded hash-id files — nothing to number.'); return; }
  const summary = r.assigned.map((a) => `${a.hash} → #${a.nnn}`).join(', ');
  if (dryRun) console.log(`number-stranded (dry-run): would number ${r.assigned.length} — ${summary}`);
  else console.log(`number-stranded: numbered ${r.assigned.length} (${r.committed ? 'committed' : 'NOT committed'}) — ${summary}`);
}

/**
 * `resolve-parent <childRef>` (#2752) — the drain-side ON-LAND epic-resolve pass, mechanizing what the
 * `/resolve` skill does by hand when an epic's last child closes. Given a child that JUST resolved on land
 * (its resolve is already on this checkout — the caller `syncMain`s first), read its `parent` edge and the
 * parent epic's signals, run the pure {@link planEpicResolveOnLand} verdict, and:
 *   - `resolve`  → splice the epic to `resolved` + `graduatedTo: none` (the same transition `/resolve` runs),
 *                  writing via the UNGUARDED drain-side writer (this runs on primary, post-land — the same
 *                  carve-out JIT-numbering uses). Emits `{ action:'resolved', epic, file }`.
 *   - `escalate` → writes NOTHING; emits `{ action:'escalate', epic, reason }` so the caller (pr-watch) can
 *                  surface it — the epic's blocked/untriaged tail needs a human `/resolve`, never an auto-close.
 *   - `skip`     → writes nothing; emits `{ action:'skip', reason }` (no parent, not-an-epic, already
 *                  resolved, a standing program, or still has open children — the common "not the last child").
 * EDIT-ONLY, like every verb here — it never commits or publishes; the caller lands the splice via the
 * sanctioned gated transport (pr-land / push-if-green), exactly as the drain lands JIT-numbering.
 * Idempotent: a second call after the epic is already resolved returns `skip: already-resolved`, so two
 * sibling lands racing the same epic never double-write (and a ff-only publish drops the loser's push).
 */
function resolveParent() {
  // A landed item is NUMBERED on main; the conveyor may hand us its birth-hash (a provisional `xNNNNNN`
  // dispatched pre-numbering, #2288). If the raw ref is a hash with no matching file on disk, map it to the
  // NNN it landed as via the `bornAs` proof-of-land (#2392) before resolving the file — so the on-land pass
  // works whether the child landed as a number or was JIT-numbered at land. A numeric ref falls straight through.
  let childRef = positional[0];
  const rawId = idFromName(childRef || '');
  if (rawId && isHash(rawId) && files().every((f) => !f.startsWith(`${rawId}-`))) {
    const nnn = landedNumberFor(rawId, ROOT);
    if (nnn) childRef = nnn;
  }
  const childFile = resolveFile(childRef);
  const childAbs = join(DIR, childFile);
  const childContent = readFileSync(childAbs, 'utf8');
  const parentRef = readField(childContent, 'parent');

  // Resolve the parent epic's file + signals (best-effort — a missing/re-pointed parent is a `skip`, never a throw).
  let parentFile = null, parentContent = null, parentPadded = null;
  if (parentRef) {
    parentPadded = normalizeId(idFromName(parentRef) || parentRef);
    const matches = files().filter((f) => f.startsWith(`${parentPadded}-`));
    if (matches.length === 1) { parentFile = matches[0]; parentContent = readFileSync(join(DIR, parentFile), 'utf8'); }
  }
  const verdict = planEpicResolveOnLand({
    hasParent: !!parentRef,
    parentFound: !!parentContent,
    kind: parentContent ? readField(parentContent, 'kind') : undefined,
    status: parentContent ? (readField(parentContent, 'status') || 'open') : undefined,
    hasBlockedBy: parentContent ? hasBlockedBy(parentContent) : false,
    childlessReason: parentContent ? readField(parentContent, 'childlessReason') : undefined,
    ongoing: parentContent ? readField(parentContent, 'ongoing') === 'true' : false,
    openChildrenCount: parentPadded ? openChildrenOf(parentPadded).length : 0,
  });
  const epicId = parentFile ? parentFile.replace(/\.md$/, '') : (parentRef ? `#${parentPadded}` : null);

  if (verdict.action === 'resolve') {
    const rel = `backlog/${parentFile}`;
    const res = applyTransition(parentContent, 'resolve', { today: today(), graduatedTo: 'none' });
    if (res.error) die(`resolve-parent: epic ${epicId} — ${res.error}`);
    writeBacklogMdUnguarded(join(DIR, parentFile), rel, res.content);
    ok({ verb: 'resolve-parent', action: 'resolved', epic: epicId, file: rel, child: childFile.replace(/\.md$/, ''), reason: verdict.reason },
      `${GRN}✓ resolved epic${RST} ${epicId} ${DIM}→ resolved (graduatedTo none) — last child ${idFromName(childFile)} landed (#2752)${RST}`);
  }
  if (verdict.action === 'escalate') {
    ok({ verb: 'resolve-parent', action: 'escalate', epic: epicId, child: childFile.replace(/\.md$/, ''), reason: verdict.reason },
      `${YEL}⚠ epic ${epicId} needs a human /resolve${RST} ${DIM}— its last tracked child landed but it carries a judgment marker (${verdict.reason}); NOT auto-closing over a possibly-undelivered tail (#2752)${RST}`);
  }
  ok({ verb: 'resolve-parent', action: 'skip', epic: epicId, child: childFile.replace(/\.md$/, ''), reason: verdict.reason },
    `${DIM}resolve-parent: nothing to do (${verdict.reason})${RST}`);
}

switch (verb) {
  // #3034 — `claim` routes through the declared operation (`we:scripts/operations/claim.mjs`); it is async, so
  // it manages its own `ok()`/`die()` exit rather than returning to fall through this synchronous switch.
  case 'claim': claimViaOperation().catch((e) => die(`claim: unexpected error — ${String(e?.message ?? e)}`)); break;
  case 'resolve': case 'release': case 'unresolve': transition(verb); break;
  case 'resolve-parent': resolveParent(); break;
  case 'number-stranded': numberStranded(); break;
  case 'retype': retype(); break;
  case 'prioritize': prioritize(); break;
  case 'tier': tier(); break;
  case 'rank': rank(); break;
  case 'weights': weights(); break;
  case 'overlap-yield-config': overlapYieldConfig(); break;
  case 'build-queue':
    (positional[0] === 'add' || positional[0] === 'remove') ? buildQueueMark(positional[0]) : buildQueue();
    break;
  case 'yield': yieldNum(); break;
  case 'scaffold': scaffold(); break;
  case 'settle': settle(); break;
  case 'calibrate': calibrate(); break;
  case 'cost': cost(); break;
  case 'reserve': reserve(); break;
  case 'unreserve': unreserve(); break;
  case 'queue': queue(); break;
  case 'unqueue': unqueue(); break;
  case 'prepare-hold': prepareHold(); break;
  case 'prepare-stamp': prepareStamp(); break;
  case 'prepare-release': prepareRelease(); break;
  default:
    console.error(`${BLD}backlog.mjs${RST} — mechanical backlog-status CLI\n` +
      `  ${GRN}claim${RST} <NNN> [--as=preparing] [--force]   open → active (or preparing, /prepare) + dateStarted; refuses on a dirty item file (claim-first), --force overrides\n` +
      `  ${GRN}resolve${RST} <NNN> [--graduated-to=X] [--codified-to=Y] [--force]   active → resolved + dateResolved (decision REQUIRES --codified-to=<doc#anchor|one-off>; an epic with open children is refused unless --force)\n` +
      `  ${GRN}resolve-parent${RST} <childNNN>   #2752 on-land: auto-resolve the child's parent EPIC iff every parent:-edge child is resolved + no judgment marker (else escalate/no-op); EDIT-ONLY\n` +
      `  ${GRN}release${RST} <NNN>               active|preparing → open\n` +
      `  ${GRN}unresolve${RST} <NNN> --reason=<why> --force   resolved → open, dropping dateResolved/graduatedTo/codifiedIn (#2779-incident correction path — a resolve that should never have happened, never a routine reopen)\n` +
      `  ${GRN}retype${RST} <NNN> [--to=story|epic|task|decision|feature] [--size=N|none] [--status=parked]   sanctioned pack-phase flag-fix (no LANE_GUARD_OFF); frontmatter-only\n` +
      `  ${GRN}prioritize${RST} <NNN> [--to=low|--clear]   set or clear the item's \`priority\` frontmatter (the field readiness/batch ranks by); frontmatter-only\n` +
      `  ${GRN}tier${RST} <NNN> --to=pinned|normal|someday|won't [--clear]   set the build-queue TIER (#2528, the coarse ordering bucket); frontmatter-only\n` +
      `  ${GRN}rank${RST} <NNN> --to=<key> | --after=<NNN> [--before=<NNN>]   set the build-queue LexoRank (#2528, manual drag-order within a tier)\n` +
      `  ${GRN}weights${RST} [--show] | --set=<key>=<n>   read/edit the build-queue scoring config (#2528; validated: sum 100, ≤5, none >50%)\n` +
      `  ${GRN}overlap-yield-config${RST} [--show] | --set-enabled=<true|false> | --set-window=<minutes>   read/edit the drain's land-time overlap-yield settings (#4308; tracked file, validated, lock-serialized)\n` +
      `  ${GRN}yield${RST} <NNN-slug>            move a LOCAL-ONLY NNN collision to the next free number (refuses a git-tracked item; NNN is immutable)\n` +
      `  ${GRN}number-stranded${RST} [--dry-run]      number every TRACKED hash-id backlog file in this checkout (a hash that reached main via a numbering-bypassing land; #2319/#2288)\n` +
      `  ${GRN}scaffold${RST} --kind=story|epic|task|decision|feature --size= --title= [--digest=] [--blocked-by=] [--parent=] [--session=<slug>]   --session ⇒ born active+owned (#670), publish with settle\n` +
      `  ${GRN}settle${RST} <NNN>               born-active scaffold (--session) → open (publish once authored)\n` +
      `  ${GRN}calibrate${RST} --points= --context-pct= [--stop-reason=budget|context|empty-pool|fork|gate|outgrew|manual|abort]   fold a session into the batch point-budget estimate\n` +
      `  ${GRN}cost${RST} <NNN> --tokens="in:.. cw:.. cr:.. out:.." (or --in= --cw= --cr= --out=) [--sessions=<n>]   accrue a session's token usage into the card's cumulative costTokens; costUsd is DERIVED from it (close cost-on-card)\n` +
      `  ${GRN}reserve${RST} <NNN...> --session=<slug>    soft-hold planned items (deprioritize for other sessions)\n` +
      `  ${GRN}unreserve${RST} [--session=<slug>] [<NNN...>]  release soft holds (clear a session, or specific items)\n` +
      `  ${GRN}queue${RST} <NNN...> [--lane=<ref>] [--session=<slug>]   mark ready-to-merge (#2138 Fork 4); claim/release refuse a queued item until the drain lands it\n` +
      `  ${GRN}unqueue${RST} <NNN...>            clear the ready-to-merge mark (the drain's clear point at landing)\n` +
      `  ${GRN}prepare-hold${RST} <NNN> [--session=<slug>] [--lease=<min>]   HARD local hold while preparing a fork in a lane (#2219 (b)); --select skips + claim refuses it (vs the soft reserve)\n` +
      `  ${GRN}prepare-stamp${RST} <NNN>         write status:open + preparedDate=<today> + preparedAgainstSha=<sha> into the item (in-lane, landed via the one PR; blocked from a primary cwd)\n` +
      `  ${GRN}prepare-release${RST} <NNN>       drop the prepare-hold (clear point once the lane PR lands)\n` +
      `  (add --json for machine output)`);
    process.exit(verb ? 1 : 0);
}
