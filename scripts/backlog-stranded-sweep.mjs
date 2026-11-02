#!/usr/bin/env node
/**
 * #2899 A4 — STRANDED-ITEM SWEEP: find delivered work still sitting `open`/`active`.
 *
 * WHY. When a land assigns an item's `<NNN>` but never flips its `status:` (the #2899 defect), the card stays
 * permanently eligible: every future batch that packs by leverage re-selects it, and whoever draws it pays a
 * full claim + lane + investigate cycle to discover the work is already on main. #2880 and #2450 each cost
 * exactly that. This sweep finds the ones already stranded, so they are closed rather than re-packed.
 *
 * THE SIGNAL, AND WHY IT IS NOT FRONTMATTER. The tempting offline inference — "numerically named + still
 * carries a `bornAs` hash ⇒ its lane landed" — is WRONG, and wrong in the noisy direction. `numberPendingHashes`
 * numbers every pending hash file present on main at land, including items that some OTHER lane merely FILED in
 * passing (a prevention item, a spin-off). Run against this corpus that rule flags 218 of 2874 cards, almost all
 * of them correctly-open items that were never delivered at all. A report that cannot be trusted is not a heal.
 *
 * So the sweep uses the signal the acceptance criterion names: **a MERGED PR that actually delivered this
 * item**, matched on the lane ref / title / manifest the drain itself writes. One `gh pr list` for the whole
 * corpus, then pure matching — no per-item network call.
 *
 * REPORT, NEVER BULK-FLIP — for the general `gh`-sourced match above. A genuinely broader-scoped item may
 * legitimately outlive its first PR: it landed a slice and has more to do. That is indistinguishable from a
 * stranding without reading the item, so THAT signal writes nothing and hands the triage to a human.
 *
 * #3916 — ONE exception, `--apply`: a card whose id is the trailing `(#NNNN)` of a real commit already
 * reachable from `main` (never a `drain: ...` housekeeping commit — see `commitSubjectDeliversItem`'s own doc)
 * is unambiguous enough to flip automatically, through the drain's own `resolveLandedItem`
 * (`scripts/lane-drain.mjs`, #2748) — never a second resolver. Everything short of that bar stays report-only.
 *
 * The core (`prDeliveredItem` / `sweepStrandings` / `commitSubjectDeliversItem` / `autoResolvableStrandings`)
 * is PURE; the CLI is the only thing that touches fs/network/git.
 *
 * Usage:
 *   node scripts/backlog-stranded-sweep.mjs [--json] [--limit=N]             # report only (default)
 *   node scripts/backlog-stranded-sweep.mjs --apply [--json]                 # ALSO auto-resolve the strict subset
 *     [--log-limit=N]  cap the origin/main commit-log window the strict check reads (default 400)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveLandedItem } from './lane-drain.mjs'; // #3916 — the ONE resolve-on-land home (#2899 A5); never a second resolver
import { fetchFresh } from './lib/git-fetch-fresh.mjs';

/** Frontmatter-strict single-field read (#2603) — only the leading `---` block, never a body line. Pure. */
export function readFrontmatterField(body, field) {
  const text = String(body || '');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const m = text.slice(3, end).match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * #2899 jury — card-derived id tokens (a filename stem, a `bornAs` value) are interpolated into `new RegExp`, so
 * they are untrusted input to a regex compiler. Accept only the two real id shapes; anything else is dropped
 * rather than escaped, because a card id that is not an id is a data error, not something to pattern-match.
 */
const isCardId = (t) => /^\d{1,6}$/.test(t) || /^x[0-9a-z]{6}$/.test(t);

/** The id token of a `backlog/<id>-<slug>.md` stem — `2899-jit-…` → `2899`. Pure. */
export function idTokenOf(stem) {
  const s = String(stem || '');
  const cut = s.indexOf('-');
  return cut === -1 ? s : s.slice(0, cut);
}

/**
 * Is this PR an ANNOTATION pass rather than a delivery? Pure.
 *
 * Several sanctioned flows edit an item's card and land, and CORRECTLY leave it open for someone to actually
 * build it: `/prepare` (decision research), the dispatcher's `scope:` touch-set probe, and plain filing. They
 * name the item in their ref and title exactly as a delivery does, so without this carve-out they dominate the
 * report — 30+ of the first 71 hits on this corpus were `author scope: for #NNNN`. A heal that reports those is
 * noise again, which is the failure mode this whole sweep exists to avoid.
 */
export function isAnnotationPr({ headRefName = '', title = '' } = {}) {
  const machineKind = /^\s*(?:WE|FUI|PLATEAU) #[a-z0-9]+: ([\w-]+) — /i.exec(String(title || ''))?.[1]?.toLowerCase();
  if (['prepare', 'prepare-stamp', 'review-prep', 'file', 'prevention', 'findings', 'auto-resolve', 'auto-route', 'release', 'baselines'].includes(machineKind)) return true;
  // A card's prose can itself say 'file', 'prepare scope', etc.; it is display metadata.
  const t = machineKind ? '' : String(title || '');
  if (/\b(author|prepare|prepared|preparing)\s+scope\b/i.test(t)) return true;
  if (/\bscope:\s*for\b/i.test(t)) return true;
  if (/\bprepare\b.*\b(decision|fork|forks|placement|research)\b/i.test(t)) return true;
  if (/:\s*(file|files|filing)\b/i.test(t)) return true;
  if (/^\s*(?:WE\s+)?file[sd]?\b/i.test(t)) return true;   // "File #xhash: …" — the filing convention, id first
  const segs = String(headRefName || '').split(/[/\-_]/).filter(Boolean);
  if (segs.some((s, i) => /^(scope|prep|prepare|preparing|research)$/.test(s) && i > 0)) return true;
  // A MULTI-ITEM housekeeping lane names several items in one ref and delivers none of them: `slice-…` splits an
  // epic into children, `scaffold`/`file-…`/`capture-…` mint new cards. All land, all leave their subjects open.
  // Scan the segments BEFORE the first id-looking one, so `lane/backlog-scaffold-2555-2505` is caught as well as
  // `lane/slice-epics-2551-…` — the housekeeping verb is not always in a fixed position.
  const firstId = segs.findIndex((s) => /^(\d+|x[0-9a-z]{6})$/.test(s));
  const lead = firstId === -1 ? segs.slice(1) : segs.slice(1, firstId);
  return lead.some((s) => /^(slice|slices|scaffold|file|files|capture)$/.test(s));
}

/**
 * Did this merged PR DELIVER this item (as opposed to merely mentioning, filing or annotating it)? Pure.
 *
 * Matches the three places the drain and the lane transport write an item's identity, in descending strength:
 *   1. `headRefName` — a lane ref is `lane/<slug>-<id>` or `lane/<id>-<slug>`, so the id/hash appears as a
 *      whole dash-delimited segment. This is the strongest signal: a lane ref names the item it was cut FOR.
 *   2. `title` — the commit convention is `<id>: <subject>` / `Resolve #<NNN>`.
 *   3. the lane manifest in the body — `"item": <id>` / `"item": "<hash>"` (#2411, the manifest rides the body).
 * A bare `#NNN` anywhere in the body is deliberately NOT a match: that is a citation, which is exactly how a
 * filed-in-passing item looks, and admitting it reintroduces the noise this function exists to avoid.
 *
 * @param {{headRefName?:string, title?:string, body?:string}} pr
 * @param {{id:string, bornAs?:(string|null)}} item
 * @returns {{matched:boolean, via:(string|null)}}
 */
export function prDeliveredItem(pr = {}, item = {}) {
  // Tokens come from a CARD, so only real id shapes pass (`isCardId`, #2899 jury). This also stops a stray
  // token from matching half the corpus.
  const tokens = [String(item.id || ''), String(item.bornAs || '')].filter((t) => t && t !== 'null' && isCardId(t));
  if (!tokens.length) return { matched: false, via: null };
  if (isAnnotationPr(pr)) return { matched: false, via: null };
  const ref = String(pr.headRefName || '');
  const refSegments = ref.split(/[/\-_]/).filter(Boolean);
  // A BATCH lane ref (`lane/batch-<date>-<id>-<id>-<id>-<theOneItem>`) lists every item in the batch slug, so a
  // bare segment hit would credit the batch's delivery of item A to items B and C as well. Only the FINAL
  // segment names the item the lane actually built.
  const isBatchRef = /(^|[/\-_])batch([/\-_]|$)/.test(ref);
  const refCandidates = isBatchRef ? refSegments.slice(-1) : refSegments;
  // #2899 jury — a DATE segment is not an item id. `lane/calibrate-2026-08-02` was crediting item #2026 as
  // delivered, because every numeric segment was treated as a candidate. Drop the segments of any `YYYY-MM-DD`
  // run before matching; a real 4-digit item id that happens to look like a year is still matched via the
  // title/manifest paths, which carry an explicit `#`/`item:` marker.
  const dateSpans = new Set();
  for (let i = 0; i + 2 < refCandidates.length; i++) {
    const [y, m, d] = refCandidates.slice(i, i + 3);
    if (/^(19|20)\d{2}$/.test(y) && /^(0[1-9]|1[0-2])$/.test(m) && /^(0[1-9]|[12]\d|3[01])$/.test(d)) {
      dateSpans.add(y); dateSpans.add(m); dateSpans.add(d);
    }
  }
  const refSet = new Set(refCandidates.filter((s) => !dateSpans.has(s)));
  for (const t of tokens) {
    if (refSet.has(t)) return { matched: true, via: `lane-ref ${ref}` };
  }
  const title = String(pr.title || '');
  for (const t of tokens) {
    if (new RegExp(`(^|\\s)#?${t}\\s*:`).test(title)) return { matched: true, via: `title "${title.slice(0, 60)}"` };
    if (new RegExp(`\\bresolve[sd]?\\s+#${t}\\b`, 'i').test(title)) return { matched: true, via: `title "${title.slice(0, 60)}"` };
  }
  const body = String(pr.body || '');
  for (const t of tokens) {
    if (new RegExp(`"item"\\s*:\\s*"?${t}"?`).test(body)) return { matched: true, via: 'lane manifest in PR body' };
  }
  return { matched: false, via: null };
}

/**
 * Cross the open/active cards against the merged-PR list → the stranding candidates. Pure.
 * Only `open`/`active` cards are considered; `resolved`/`parked`/`preparing` have nothing to heal.
 */
export function sweepStrandings(cards = [], mergedPrs = [], { limitPerItem = 3 } = {}) {
  const prs = Array.isArray(mergedPrs) ? mergedPrs : [];
  const out = [];
  for (const c of (Array.isArray(cards) ? cards : [])) {
    if (!c) continue;
    const id = idTokenOf(c.stem);
    const status = readFrontmatterField(c.body, 'status');
    if (status !== 'open' && status !== 'active') continue;
    // An EPIC legitimately outlives every PR that lands one of its slices — it stays open until the last child
    // resolves (the no-open-slice guard). That is the designed lifecycle, never a stranding.
    if (readFrontmatterField(c.body, 'kind') === 'epic') continue;
    const bornAs = readFrontmatterField(c.body, 'bornAs');
    const hits = [];
    for (const pr of prs) {
      const m = prDeliveredItem(pr, { id, bornAs });
      if (m.matched) hits.push({ pr: pr.number, via: m.via });
      if (hits.length >= limitPerItem) break;
    }
    if (hits.length) out.push({ id, status, bornAs: bornAs || null, dateStarted: readFrontmatterField(c.body, 'dateStarted') || null, mergedPrs: hits });
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));
}

/**
 * #3916 — AUTO-RESOLVE, the one exception to "REPORT, NEVER BULK-FLIP" above. Pure.
 *
 * WHY THIS EXISTS. `#3916` graduated onto `main` (commit `092df91c4`, "Graduate test setup, heavy-command
 * admission and file-locks from lane/mechanical-dispatcher (#3916)") but the resolve-on-land path
 * (`scripts/merge-ai-prs.mjs`'s `deliveredItemNumsFromPr`, #2899) never even saw it: a guard meant to exclude a
 * doc-only PR misfired on a QUOTED citation inside the PR body ("... 'already landed, no code change' precedent
 * ...") and dropped the credited id before it ever reached `landedThisPass`, so the card sat `status: active`
 * indefinitely with real, merged, on-`main` work. That extractor bug is fixed at its source
 * (`scripts/lib/open-pr-items.mjs`), but resolve-on-land is inherently heuristic (it reads PR ref/title/body
 * text), so this sweep is the backstop for the NEXT heuristic miss, not just this one.
 *
 * WHY THIS ONE SIGNAL IS SAFE TO ACT ON AUTOMATICALLY (unlike `sweepStrandings` above, which only ever
 * reports). `commitSubjectDeliversItem` requires a commit **reachable from `main` itself** (ground truth, no
 * `gh` staleness/window-truncation risk) whose subject names the card's OWN id as the delivery-commit
 * convention this repo already uses (`Graduate ... (#3916)`, `WE #NNN: ...`) — never a bare mention. Excluding
 * every `drain: ...` commit matters: `drain: resolve #3917 on land (#2748)` / `drain: JIT-number x…→#4053 at
 * land (#2288)` are MECHANICAL housekeeping whose trailing `(#NNNN)` cites the EPIC that authorized the
 * automation, not something that commit delivers — without the exclusion, every routine drain commit would
 * misread as "delivering" #2748/#2288 forever.
 *
 * NEVER GUESS. A card with no matching commit is left OUT of this set — it still surfaces in
 * `sweepStrandings`'s general (report-only, hand-triaged) output exactly as before. This function decides
 * WHICH cards are safe to flip; the actual flip is the drain's own `resolveLandedItem`
 * (`scripts/lane-drain.mjs`, #2748) — this module never re-implements that mutation.
 *
 * @param {string} subject  one `git log` commit subject line, reachable from `main`
 * @param {string|number} id  the card's own id (its `backlog/<id>-*.md` stem token)
 * @returns {boolean}
 */
export function commitSubjectDeliversItem(subject, id) {
  const s = String(subject || '');
  if (/^drain:/i.test(s)) return false; // mechanical housekeeping — its trailing (#NNNN) cites the enabling epic, not a delivery
  const idStr = String(id ?? '').trim();
  if (!isCardId(idStr)) return false; // #3916 review round 1 — a card-derived token, never compiled unvalidated
  return new RegExp(`\\(#${idStr}\\)\\s*$`).test(s);
}

/**
 * The STRICT subset of open/active `cards` safe to resolve AUTOMATICALLY — cross-referenced against `mainLog`
 * (an array of commit subject strings reachable from `main`, caller-supplied so this stays pure/testable
 * without touching a real git repo). Same card filtering as `sweepStrandings` (skip anything not open/active,
 * skip epics — they legitimately outlive any one slice's PR). Pure.
 * @param {Array<{stem:string, body:string}>} cards
 * @param {string[]} mainLog
 * @returns {Array<{id:string, status:string, via:string}>}
 */
export function autoResolvableStrandings(cards = [], mainLog = []) {
  const subjects = Array.isArray(mainLog) ? mainLog : [];
  const out = [];
  for (const c of (Array.isArray(cards) ? cards : [])) {
    if (!c) continue;
    const id = idTokenOf(c.stem);
    const status = readFrontmatterField(c.body, 'status');
    if (status !== 'open' && status !== 'active') continue;
    if (readFrontmatterField(c.body, 'kind') === 'epic') continue;
    const hit = subjects.find((subj) => commitSubjectDeliversItem(subj, id));
    if (hit) out.push({ id, status, via: `commit-subject "${hit}"` });
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));
}

// #3916 — commit subjects reachable from `origin/main`, for `autoResolvableStrandings`'s ground-truth check.
// Best-effort: no `git`/no network/detached-from-a-remote → `null`, and the caller degrades `--apply`/
// `--dry-run` to "unavailable" rather than guessing off a possibly-stale local branch.
// EXPORTED (xvr2o8r) so `autoStrandedSweepPass` below — and the drain's own wiring — share this ONE read
// rather than a second copy that could drift on the fetch/window behaviour.
export function readMainLog(limit) {
  try { fetchFresh({ cwd: process.cwd(), branches: ['main'], maxAgeMs: 0, run: (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }); } catch { /* best-effort — a stale local origin/main still degrades safely below */ }
  try {
    const out = execFileSync('git', ['log', '--pretty=%s', ...(limit ? [`-n${limit}`] : []), 'origin/main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(Boolean);
  } catch { return null; }
}

/** Read every `backlog/*.md` card off disk as `{stem, body}` — the one fs read both the CLI and the
 * drain-wired auto-sweep share. Throws on an unreadable `backlog/` dir (caller decides how to degrade). */
export function readBacklogCards(cwd = process.cwd()) {
  const dir = join(cwd, 'backlog');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  return files.map((f) => {
    try { return { stem: f.replace(/\.md$/, ''), body: readFileSync(join(dir, f), 'utf8') }; } catch { return null; }
  }).filter(Boolean);
}

// xvr2o8r — the AUTO-WIRED default log-limit is a DELIBERATELY NARROW widening past the manual CLI's own 400
// (above), not a jump to "wide enough to never miss anything". Live evidence while authoring this item is WHY:
// running the strict check at --log-limit=2000 (a first attempt) surfaced not just the two live-stranded cards
// this item exists to close (#3916 at origin/main position ~403, #4025 at ~438) but THREE FALSE POSITIVES
// further back — #3634, #3881, #3751-adjacent commits whose trailing `(#NNNN)` cites a bigger PARENT
// story/decision an unrelated follow-up commit happened to land against (e.g. "fix(auth): refresh the App
// token per tick … (#3881)" — a partial follow-up on a story explicitly gated on a still-pending human step,
// NOT its delivery). `commitSubjectDeliversItem` has no defense against this shape (unlike `isAnnotationPr`,
// which only guards the general, report-only `sweepStrandings` signal) — the nearest such false positive at
// authoring time sits at position ~660. 500 sits with real margin on BOTH sides: past #4025's ~438 (the
// farther of the two live targets), short of the ~660 false-positive boundary. It is intentionally NOT pushed
// further just to buy more drift-margin — that trade directly re-admits the false-positive class this
// comment's own investigation exists to document. A stranding older than this window is exactly what
// `we:scripts/backlog-stranded-sweep.mjs --apply --log-limit=<bigger>` (already shipped, #2661) is for: a
// human-reviewed, supervised widening, not a silently-widened unattended default. Overridable via
// `WE_STRANDED_SWEEP_LOG_LIMIT` for an operator who has weighed that tradeoff and wants a different bound
// without a code change — including narrower, e.g. matching the CLI's own 400 exactly.
export const AUTO_SWEEP_LOG_LIMIT = Number(process.env.WE_STRANDED_SWEEP_LOG_LIMIT) > 0
  ? Number(process.env.WE_STRANDED_SWEEP_LOG_LIMIT)
  : 500;

/**
 * xvr2o8r — THE ONE CALLABLE the drain (`we:scripts/merge-ai-prs.mjs`) uses to run the strict stranded-item
 * auto-resolve as part of its own pass, and that this file's own CLI `main()` below now uses too (never a
 * second copy of the read+resolve sequence). Strict proof only (`autoResolvableStrandings`) — the general,
 * report-only `sweepStrandings` signal is deliberately NEVER reachable from here; anything short of a real
 * commit-subject match to a card's own id stays report-only, exactly as `--apply` already promised.
 *
 * NEVER THROWS. Every failure mode — an unreadable `backlog/` dir, `git log` unavailable, an individual
 * `resolveFn` call that errors — degrades to a reported field instead of propagating, because the drain's
 * contract for this step is "log and continue", never "fail the pass" (mirrors #2899's resolve-on-land, which
 * is already best-effort/non-fatal for the same reason).
 *
 * IDEMPOTENT BY CONSTRUCTION: `autoResolvableStrandings` (and `sweepStrandings` before it) already filters to
 * `status: open`/`status: active` cards before considering them a candidate, so a card this pass just resolved
 * reads back `status: resolved` on the very next call and is never a candidate again — no separate "already
 * ran" bookkeeping is needed for a repeat pass to be a safe no-op.
 *
 * `apply:false` (the drain's own `--dry-run`, or a caller that just wants the report) computes and returns
 * exactly what `apply:true` would resolve, without calling `resolveFn` at all — the live preview the drain's
 * dry-run proof needs, with zero risk of a partial write.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.apply]  false = compute + report only, matching `--dry-run`'s contract exactly
 * @param {number} [opts.logLimit]
 * @param {function} [opts.readCardsFn]  () => Array<{stem,body}> — injectable (tests never touch real fs)
 * @param {function} [opts.readMainLogFn]  (limit) => string[]|null — injectable (tests never touch real git)
 * @param {function} [opts.resolveFn]  (cwd, id, opts) => {flipped,alreadyResolved,reason?} — defaults to the
 *   drain's own `resolveLandedItem` (never a second resolver); injectable for tests.
 * @param {{sync?:boolean, publish?:boolean}} [opts.resolveOpts]  passed straight through to `resolveFn`.
 *   Defaults to `resolveLandedItem`'s own defaults (`sync:true, publish:true` — this call syncs main and
 *   publishes each flip itself), which is what a standalone `--apply` run needs since nothing else in that
 *   run publishes for it. A caller that already syncs/publishes as part of its own pass (the drain, #2899 A5's
 *   own resolve-on-land call) passes `{ sync:false, publish:false }` so the flip commit rides that pass's
 *   existing sync/push instead of doing a second one.
 * @returns {{ok:boolean, ran:boolean, autoResolvable:Array<{id:string,status:string,via:string}>,
 *   applied:Array<{id:string,flipped:boolean,alreadyResolved:boolean,reason?:string}>,
 *   mainLogUnavailable:boolean, mainLogWindowTruncated:boolean, mainLogLen:number, error:(string|null)}}
 */
export function autoStrandedSweepPass({
  cwd = process.cwd(),
  apply = false,
  logLimit = AUTO_SWEEP_LOG_LIMIT,
  readCardsFn = null,
  readMainLogFn = readMainLog,
  resolveFn = resolveLandedItem,
  resolveOpts = {},
} = {}) {
  const empty = { ok: true, ran: false, autoResolvable: [], applied: [], mainLogUnavailable: false, mainLogWindowTruncated: false, mainLogLen: 0, error: null };
  let cards;
  try {
    cards = typeof readCardsFn === 'function' ? readCardsFn() : readBacklogCards(cwd);
  } catch (e) {
    return { ...empty, ok: false, error: `cannot read backlog/: ${String((e && e.message) || e).split('\n')[0]}` };
  }
  let mainLog;
  try { mainLog = readMainLogFn(logLimit); }
  catch (e) { return { ...empty, ok: false, error: `readMainLogFn threw: ${String((e && e.message) || e).split('\n')[0]}` }; }
  if (mainLog == null) return { ...empty, mainLogUnavailable: true }; // best-effort — no git/network/detached; report, never guess
  const autoResolvable = autoResolvableStrandings(cards, mainLog);
  const applied = [];
  if (apply) {
    for (const h of autoResolvable) {
      try {
        const flip = resolveFn(cwd, h.id, resolveOpts);
        applied.push({ id: h.id, flipped: !!flip.flipped, alreadyResolved: !!flip.alreadyResolved, ...(flip.reason ? { reason: flip.reason } : {}) });
      } catch (e) {
        applied.push({ id: h.id, flipped: false, alreadyResolved: false, reason: String((e && e.message) || e).split('\n')[0] });
      }
    }
  }
  return { ok: true, ran: true, autoResolvable, applied, mainLogUnavailable: false, mainLogWindowTruncated: mainLog.length >= logLimit, mainLogLen: mainLog.length, error: null };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run');
  const wantAuto = apply || dryRun; // #3916 — a dry run previews exactly what --apply would do, never a guess
  const limitArg = (argv.find((a) => a.startsWith('--limit=')) || '').slice('--limit='.length);
  const limit = Number(limitArg) > 0 ? Number(limitArg) : 400;
  // #3916 review round 1 — the commit-log window has its own `--log-limit` (default 400, the prior shared value),
  // separate from the merged-PR `--limit`. Deliberately NOT widened to the whole history by default: a wider
  // window multiplies the strict bar's known false positives (a trailing `(#NNN)` that is not the item — see the
  // PR thread), so it stays bounded and the truncation warning below says so honestly.
  const logLimitArg = (argv.find((a) => a.startsWith('--log-limit=')) || '').slice('--log-limit='.length);
  const logLimit = Number(logLimitArg) > 0 ? Number(logLimitArg) : 400;
  const dir = join(process.cwd(), 'backlog');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); }
  catch { process.stderr.write('stranded-sweep ✗ cannot read backlog/ — run from the repo root\n'); process.exit(2); return; }
  const cards = files.map((f) => {
    try { return { stem: f.replace(/\.md$/, ''), body: readFileSync(join(dir, f), 'utf8') }; } catch { return null; }
  }).filter(Boolean);
  let prs = [];
  try {
    prs = JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,title,headRefName,body'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim() || '[]');
  } catch (e) {
    process.stderr.write(`stranded-sweep ✗ \`gh pr list\` failed (${String(e.message || e).split('\n')[0]}) — the merged-PR signal is the whole sweep; not falling back to a frontmatter guess\n`);
    process.exit(2); return;
  }
  const hits = sweepStrandings(cards, prs);

  // #3916 — the STRICT, git-ground-truth subset, computed independently of the `gh`-sourced `hits` above (never
  // guesses off it). `--dry-run` computes and reports this WITHOUT resolving anything; `--apply` (without
  // `--dry-run`) also flips each one through the drain's own `resolveLandedItem`.
  // xvr2o8r — delegates to `autoStrandedSweepPass`, the ONE read+resolve sequence this file and the drain's own
  // wiring (`we:scripts/merge-ai-prs.mjs`) both call, rather than a second inline copy. `readCardsFn` reuses the
  // `cards` this CLI already read above (never a second `backlog/` scan); the manual CLI's own `--log-limit`
  // flag rides straight through as `logLimit`, unchanged from before this refactor.
  let autoHits = [];
  let mainLogUnavailable = false;
  let mainLogTruncated = false;
  let mainLogLen = 0;
  let applied = [];
  if (wantAuto) {
    // The manual CLI's own default (400, not `AUTO_SWEEP_LOG_LIMIT`) is preserved exactly — `logLimit` above
    // already resolved to `--log-limit=<N>` or 400, so passing it through changes nothing about this CLI's
    // existing behaviour; only the drain's own wiring uses the wider `AUTO_SWEEP_LOG_LIMIT` default.
    const sweep = autoStrandedSweepPass({ cwd: process.cwd(), apply: apply && !dryRun, logLimit, readCardsFn: () => cards });
    if (!sweep.ok) { process.stderr.write(`stranded-sweep ✗ ${sweep.error}\n`); process.exit(2); return; }
    autoHits = sweep.autoResolvable;
    mainLogUnavailable = sweep.mainLogUnavailable;
    mainLogTruncated = sweep.mainLogWindowTruncated;
    mainLogLen = sweep.mainLogLen;
    applied = sweep.applied;
  }

  // #2899 jury — NO SILENT CAPS. `gh pr list --limit N` returns at most N, and a full page means the window may
  // be truncated: strandings older than it are simply absent from a report whose whole job is to find the ones
  // already stranded. An unqualified "no candidates" over a truncated window is a false all-clear, which is the
  // same class of silent bound this review flagged elsewhere and then shipped here.
  const truncated = prs.length >= limit;
  const window = truncated
    ? `the most recent ${prs.length} merged PRs — WINDOW FULL, older strandings are NOT covered; re-run with --limit=<bigger>`
    : `all ${prs.length} merged PRs`;
  // Drop anything the strict auto-resolve check above already covered (flagged or, under --apply, already
  // flipped) — it would otherwise re-appear as a "hand-triage" candidate for work already accounted for.
  const autoIds = new Set(autoHits.map((h) => String(h.id)));
  const handTriage = hits.filter((h) => !autoIds.has(String(h.id)));
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ scannedCards: cards.length, scannedPrs: prs.length, windowTruncated: truncated, limit, candidates: handTriage, ...(wantAuto ? { autoResolvable: autoHits, mainLogUnavailable, mainLogWindowTruncated: mainLogTruncated } : {}), ...(apply && !dryRun ? { applied } : {}) }, null, 2)}\n`);
    return;
  }
  if (truncated) process.stderr.write(`stranded-sweep ⚠ merged-PR window is FULL at --limit=${limit} — this report covers only the most recent ${prs.length}; older strandings are NOT covered. Re-run with a larger --limit for a complete sweep.\n`);
  if (wantAuto && mainLogTruncated) process.stderr.write(`stranded-sweep ⚠ origin/main commit-log window is FULL at --log-limit=${logLimit} — the strict auto-resolve check covers only the most recent ${mainLogLen} commits; an item delivered earlier is NOT covered. Re-run with a larger --log-limit for a wider check.\n`);
  if (wantAuto) {
    if (mainLogUnavailable) process.stdout.write(`stranded-sweep ⚠ could not read \`origin/main\`'s commit log — the --apply/--dry-run auto-resolve check is UNAVAILABLE this run; falling back to report-only\n\n`);
    else if (autoHits.length) {
      process.stdout.write(`stranded-sweep — ${autoHits.length} candidate(s) with STRICT commit-subject proof (#3916):\n`);
      for (const h of autoHits) process.stdout.write(`  #${h.id}  status:${h.status}  ← ${h.via}\n`);
      if (apply && !dryRun) {
        process.stdout.write('\n');
        for (const a of applied) process.stdout.write(`  ${a.flipped ? '✓ resolved' : a.alreadyResolved ? '· already resolved' : '⚠ FAILED'} #${a.id}${a.reason ? ` (${a.reason})` : ''}\n`);
      } else {
        process.stdout.write(`\n  DRY RUN — nothing written. Re-run with --apply to resolve these through the drain's own resolveLandedItem.\n`);
      }
      process.stdout.write('\n');
    } else {
      process.stdout.write(`stranded-sweep — 0 candidates meet the strict commit-subject bar (#3916) ${mainLogTruncated ? `in the most recent ${mainLogLen} origin/main commits — WINDOW FULL, older deliveries are NOT covered` : `across all ${mainLogLen} origin/main commits`}; nothing auto-resolved\n\n`);
    }
  }
  if (!handTriage.length) { process.stdout.write(`stranded-sweep ✓ no further candidates (${cards.length} cards × ${window})\n`); return; }
  process.stdout.write(`stranded-sweep — ${handTriage.length} candidate(s) (${cards.length} cards × ${prs.length} merged PRs, #2899 A4). REPORT ONLY; nothing was written.\n\n`);
  for (const h of handTriage) {
    process.stdout.write(`  #${h.id}  status:${h.status}${h.dateStarted ? `  started:${h.dateStarted}` : ''}${h.bornAs ? `  bornAs:${h.bornAs}` : ''}\n`);
    for (const p of h.mergedPrs) process.stdout.write(`        ← merged PR #${p.pr} via ${p.via}\n`);
  }
  process.stdout.write(`\n  Triage each by hand. Work IS on main → \`node scripts/backlog.mjs resolve <NNN>\` in a lane.\n  Item legitimately outlives its first PR (landed a slice, more to do) → leave it; that is not a stranding.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
