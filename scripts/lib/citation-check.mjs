/**
 * citation-check.mjs — pure, testable core for the CITATION-VERIFICATION gate family (backlog #2821).
 *
 * The unifying root class these rules hook is "a reference asserted without resolving it against the
 * source it points at" (#2821). The #957 ratification review bounced six times, and the most expensive
 * miss — 11 occurrences across the item, the statute, and two rendered research files that six review
 * rounds never caught — was an *anchor-ruling* mis-attribution: a platform-decisions `#anchor` whose
 * governing decision is `#2398` was attributed to `#2439` (a real, topically-plausible build slice, so a
 * plausibility check passes while the authority is wrong). Resolving a citation against its target is
 * exactly what a machine does better than a reviewer (#51 hookable-vs-judgment), so it becomes a gate.
 *
 * This module is I/O-free: every filesystem fact (does the file exist? how many lines? what does the
 * codifiedIn front-matter say?) is injected by the caller (`check-standards.mjs`), so each rule is
 * exercisable with synthetic fixtures (see scripts/__tests__/citation-check.test.mjs). It delivers the
 * proven subset of #2821 — the three deterministic checks whose real instances the #957 bounce proved:
 *
 *   • findAnchorRulingMismatches — gate "anchor-authority resolution" (#2821 gate 10, the 11-vs-1 core).
 *   • findDanglingLoci           — gate 5 (`we:<path>:<line>` must resolve to a real file + in-range line).
 *   • findOutOfScopeHashSlugs    — gate 3 (a `xNNNNNN` hash-slug cited outside the at-land rewrite scope).
 *   • findDanglingMemoryHashSlugs — gate 3b (#3100): a `xNNNNNN` hash-slug cited INSIDE the rewrite scope
 *     (`agent-memory-src/`) that does not resolve to anything live — see that function's header for why
 *     directory membership alone (gate 3's test) is the wrong tool for a dir the rewriter DOES cover.
 *   • findUnresolvedIdentifiers  — the PROVENANCE gate (#3026): a bare backticked identifier in prose must
 *     resolve against the tree, or carry an explicit not-asserted marker.
 *
 * #2821 stays OPEN — the ratify-gate (1a/1b), the `#NNN`-plausibility / PR-number check (gate 2), the
 * symbol-anchor convention (gate 6), and the declarative-leash / ruled-not-implemented markers (gates
 * 8/9) are not in this subset.
 */

import { ACCEPTANCE_HEADING_RE, NON_GOALS_HEADING_RE } from '../backlog/task-agreement.mjs';

// ── Enforcement level. The gate ships at WARN, not ERROR (#2821 "don't break the gate on the existing
// corpus"): a whole-repo scan surfaces ~39 anchor-ruling co-citations, ~429 drifted `we:<path>:<line>`
// loci, and ~85 out-of-scope hash-slugs — all in HISTORICAL reports/research authored before the gate
// existed, most legitimate-at-the-time or long-since-relocated. Red-erroring them would block every
// batch on content no one is touching. Warn surfaces each finding (and `--scope` attributes a SESSION's
// own new bad cite to that session), while a corpus cleanup drains the backlog of historical hits. Flip
// this to `true` — promoting all three to hard `check:standards` errors — once that scan reads clean.
// TODO(#2821): promote CITATION_GATES_ENFORCED → true after the historical corpus is triaged to zero.
export const CITATION_GATES_ENFORCED = false;

// ── The at-land hash→NNN rewrite scope. numberPendingHashes (we:scripts/lane-drain.mjs#numberPendingHashes),
// via the numbering brain applyLedger (we:scripts/backlog/id.mjs#applyLedger), rewrites hash→NNN only in
// these dirs. A hash slug cited from anywhere else never self-heals → dead link post-land (#2821 gate 3).
// `agent-memory-src/` joined this set at #3100 — the compiled agent-memory bundle every future session
// loads into context, so a dangling hash there silently misdirects every session, not just one card.
// `scripts/conveyor/flows/` joined at #4075/xmd4pfa — a flow's own `cite`s name a backlog file by its
// pre-numbering hash, and without this sweep the cite dangles the moment the card lands numbered (the
// live incident: build-dispatch.flow.json's `backlog/xr05jjl-…` cite outliving the card's rename to #4220,
// turning main's CI red for every PR).
export const HASH_REWRITE_DIRS = ['backlog/', 'docs/agent/', 'agent-memory-src/', 'scripts/conveyor/flows/'];

// The dirs the rewriter does NOT cover but where a hash-slug citation still renders / is cite-able.
// Same set as DERIVED_ARTIFACT_DIRS in check-standards-rules.mjs (#2180) — kept as its own constant so the
// gate-3 scope is legible at the call site.
//
// `agent-memory-src/` deliberately does NOT belong here (#3100), even though it is a real dir where a
// dead hash-slug can live. This list means "the rewriter never touches this dir, so ANY hash-slug found
// here is presumptively dead" — true for reports/ and the two research dirs (nothing ever numbers them),
// but FALSE for agent-memory-src/ once it joined HASH_REWRITE_DIRS above: a hash-slug there DOES
// self-heal, but only AT THE MOMENT the item it names lands — so gate 3's unconditional "in this dir ⇒
// WARN" would false-positive on every citation to a still-pending item mid-flight (#3100 independent
// review, mutation-confirmed: adding agent-memory-src/ here fires on ordinary in-flight citations the
// widened rewrite scope makes self-healing). The dir needs a RESOLUTION check instead of a MEMBERSHIP
// check — see findDanglingMemoryHashSlugs.
export const HASH_SLUG_OUT_OF_SCOPE_DIRS = [
  'reports/',
  'src/_data/researchTopics/',
  'src/_includes/research-descriptions/',
];

// Repo-locus prefixes (we:docs/agent/conventions.md → the repo-locus convention). `we:` resolves against
// THIS working tree (deterministic); `fui:` / `plateau:` name a sibling repo not in this checkout, so their
// path/line existence can't be resolved here and must never be errored (#2821 gate 5 scope note).
export const IN_REPO_LOCUS = 'we:';
export const CROSS_REPO_LOCI = new Set(['fui:', 'plateau:']);

// A provisional hash-slug id: `x` + exactly 6 lowercase-alnum chars (the born-as id form, e.g. `x9kptqv`).
// Mirrors the two-form id in check-standards-rules.mjs ITEM_REF_RX (`x[0-9a-z]{6}`).
const HASH_SLUG = 'x[0-9a-z]{6}';

/**
 * Gate NEW (#4075 follow-up, xmd4pfa) — a hash-named BACKLOG FILE PATH cited from ANYWHERE outside
 * `backlog/` itself: `backlog/x<hash>-<slug>.md`. This exact shape is what dangled in
 * `scripts/conveyor/flows/build-dispatch.flow.json` (#4075): the file existed only until the drain's JIT
 * numbering (#2288) renamed the card to `#4220`, at which point every citation to it by its OLD path 404'd
 * — turning main's CI red for every PR. A citation should name the card by its STABLE id (a bare `#xHASH`
 * pending, or `#NNN` once landed — both resolvable against `bornAs`), never by the file's CURRENT path,
 * which JIT numbering can and does rename out from under it.
 *
 * This is DELIBERATELY broader than gate 3 (`findOutOfScopeHashSlugs`, which is scoped to a FIXED historical
 * dir list — `reports/` and the two research dirs). Gate 3's scope is "the rewriter never covers this dir,
 * so this citation shape can never self-heal there." This gate is scope-INDEPENDENT — it fires in ANY dir
 * outside `backlog/`, including dirs the JIT-numbering rewrite scope (`HASH_REWRITE_DIRS`) DOES cover today
 * — because that scope is a maintained LIST, and a list can lag a new citing file TYPE exactly the way it
 * lagged `scripts/conveyor/flows/` until this same incident added it. The rule has to be scope-independent
 * even though the REWRITE remains scope-limited: the rewrite is the (bounded, maintained) cure, this is the
 * (unbounded, scope-blind) detector that catches the rewrite scope falling behind again.
 *
 * `backlog/` itself is exempt — a backlog item legitimately mentions a SIBLING hash-named file mid-flight
 * (a `relatedReport`, a cross-ref during drafting) and that dir is the ledger's own numbering target, always
 * rewritten in the SAME pass regardless of any other scope question.
 *
 * @param text the file body (raw).
 * @param relPath the file's repo-relative path (decides in/out of scope: `backlog/` is exempt).
 * @returns array of `{ path, hash }` — one entry per distinct hash-named path cited (deduped per file).
 */
export const HASH_PATH_CITE_SOURCE = 'backlog/(x[0-9a-z]{6,7})-[A-Za-z0-9-]+\\.md';
const HASH_PATH_CITE_RE = new RegExp(`\\b${HASH_PATH_CITE_SOURCE}\\b`, 'g');

export const CAPTURED_DATA_PREFIXES = ['scripts/conveyor/soak/fixtures/'];
export function isCapturedDataPath(relPath) {
  return typeof relPath === 'string' && CAPTURED_DATA_PREFIXES.some(prefix => relPath.startsWith(prefix));
}

/** Only exact existing citations owned by the checkout's net diff are errors. */
export function classifyHashPathCite({ cited, exists, citingFile, changedFiles }) {
  if (!exists(cited)) return 'dangling';
  const owned = changedFiles instanceof Set ? changedFiles.has(citingFile)
    : Array.isArray(changedFiles) && changedFiles.includes(citingFile);
  return owned ? 'resolving' : 'unowned';
}

export function findHashPathCiteOutsideBacklog(text, relPath) {
  const findings = [];
  if (typeof text !== 'string' || text === '' || typeof relPath !== 'string') return findings;
  if (relPath.startsWith('backlog/')) return findings; // the ledger's own numbering target — always exempt
  // A test file's synthetic hash-named-path fixture string is not a real citation —
  // same reasoning as isIndexableSourcePath's own test-file exclusion. Without this the gate mostly reports
  // its OWN suite's fixtures back to it, which is exactly the wolf-cry failure mode a noisy gate produces.
  if (PROVENANCE_TEST_FILE_RE.test(relPath)) return findings;
  // Captured threads record card paths as data, not citations; neither gate nor drain should act on them.
  if (isCapturedDataPath(relPath)) return findings;
  const seen = new Set();
  for (const m of text.matchAll(HASH_PATH_CITE_RE)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    findings.push({ path: m[0], hash: m[1] });
  }
  return findings;
}

/**
 * Scan `git grep -n` output lines (`<file>:<lineno>:<text>`) with findHashPathCiteOutsideBacklog — the ONE
 * detector both production scanners (check:standards' gate and the drain's pre-number backstop) route
 * through, so a change to what counts as a citation lands in both at once. Every citation on a line is
 * reported, not only the first (PR #2757 review).
 *
 * @param lines raw `git grep -n` output lines.
 * @returns array of `{ file, path, hash }` — `file` is the citing file, `path`/`hash` the cited card.
 */
export function findHashPathCitesInGrepLines(lines) {
  const out = [];
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const j = line.indexOf(':', i + 1);
    const file = line.slice(0, i);
    for (const f of findHashPathCiteOutsideBacklog(j === -1 ? line.slice(i + 1) : line.slice(j + 1), file)) {
      out.push({ file, ...f });
    }
  }
  return out;
}

// Char classes only, never `\d` — this source string is shared with a raw `git grep -E` invocation
// (check-standards.mjs's gate) whose POSIX ERE flavor doesn't support Perl's `\d`, the same reasoning
// HASH_PATH_CITE_SOURCE above already follows.
export const BACKLOG_GLOB_CITE_SOURCE = 'backlog/([0-9]{1,5}|x[0-9a-z]{6,7})-\\*\\.md';
const BACKLOG_GLOB_CITE_RE = new RegExp(`\\b${BACKLOG_GLOB_CITE_SOURCE}`, 'g');
const BORN_AS_HASH_TEST_RE = new RegExp(`^${HASH_SLUG}$`);

/**
 * The full RESOLUTION set gate 6f-ii-d's `findDanglingBacklogGlobCite` checks a cited id against: every
 * item's own `num` (a still-pending item's `num` IS its birth hash; a landed item's `num` is its `#NNN`)
 * UNION every item's `bornAs` hash (a landed item's birth hash — the id its glob citations were written
 * against before it graduated). Extracted into its own function, called by BOTH check-standards.mjs's real
 * gate and this module's own tests, so the wiring this builds can never silently drift from what actually
 * ships — round-2 independent review (#4318) caught an earlier draft's "wiring" test re-implementing this
 * exact formula locally (its own `isHashLike` copy) instead of calling it, which could drift from the
 * shipped construction with no test ever noticing.
 *
 * @param backlog array of `{ num, bornAs? }` — the already-loaded backlog item list.
 * @returns Set<string> of every id currently resolvable to a real backlog file.
 */
export function buildBacklogResolvableIds(backlog) {
  const items = backlog || [];
  return new Set([
    ...items.map((b) => String(b.num)),
    ...items.filter((b) => typeof b.bornAs === 'string' && BORN_AS_HASH_TEST_RE.test(b.bornAs)).map((b) => b.bornAs),
  ]);
}

/**
 * Gate 6f-ii-d (#4318) — the WILDCARD-GLOB backlog citation, `backlog/<id>` followed by a LITERAL `-*.md`
 * (not a real slug), does not resolve to any currently-tracked or landed item. This convention is
 * distinct from `findHashPathCiteOutsideBacklog` above: that gate matches a citation carrying a REAL
 * slug (`[A-Za-z0-9-]+`, no `*`) and flags the FORM unconditionally (it always dangles once the card is
 * JIT-numbered); this gate matches the deliberately-vague glob form authors already use to dodge that
 * exact staleness problem, and checks RESOLUTION instead — the same "does it resolve against something
 * real" test gate 3b (`findDanglingMemoryHashSlugs`) already applies to bare hash-slugs, extended to this
 * glob-path form and to NUMERIC ids too (an id that graduated from a hash to a number, or a stale numeric
 * id from a renumber, both leave the glob matching nothing).
 *
 * A `bornAs` hash counts as resolving, same as gate 3b — so an id that graduated hash→NNN is a
 * STALENESS/hygiene issue (the citation should name the current id), never something THIS gate flags.
 * The gate's real catch is an id with neither a `num` nor a `bornAs` match anywhere: the live instance
 * this gate's own build turned up (#4318) is `we:scripts/conveyor/reconcile-core.mjs` citing an id with no
 * match at all on this tree — filed as a follow-up rather than fixed in the same change (see the #4318
 * card's own Proof plan / Follow-ups for the full trace and the id, kept out of this docstring's own text
 * so it can't become a second self-citing instance of the exact thing this gate exists to catch).
 *
 * DELIBERATELY generic on the id shape: a hash (`x[0-9a-z]{6,7}`) OR a bare backlog number (`[0-9]{1,5}`)
 * — both forms appear in the corpus.
 *
 * @param text the file body (raw).
 * @param relPath the file's repo-relative path (test-file fixtures are exempt — same reasoning as
 *        findHashPathCiteOutsideBacklog's own exemption: a synthetic glob-cite string in a test's own
 *        fixture is not a real citation).
 * @param opts.resolvableIds Set<string> — every id (backlog `num`, or any item's `bornAs` hash) that
 *        currently resolves to a real backlog file. The caller builds this from the already-loaded
 *        `backlog` array — no extra fs pass.
 * @returns array of `{ id, path }`, deduped per distinct id per call (a call is already one file).
 */
export function findDanglingBacklogGlobCite(text, relPath, { resolvableIds = new Set() } = {}) {
  const findings = [];
  if (typeof text !== 'string' || text === '' || typeof relPath !== 'string') return findings;
  if (PROVENANCE_TEST_FILE_RE.test(relPath)) return findings;
  const seen = new Set();
  for (const m of text.matchAll(BACKLOG_GLOB_CITE_RE)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    if (resolvableIds.has(id)) continue; // resolves to a currently-tracked or landed item — not a defect
    findings.push({ id, path: m[0] });
  }
  return findings;
}

/**
 * Scan `git grep -n` output lines (`<file>:<lineno>:<text>`) with findDanglingBacklogGlobCite, deduping
 * per file+id across the WHOLE hit set — the wiring `check-standards.mjs`'s gate 6f-ii-d actually runs.
 * Mirrors `findHashPathCitesInGrepLines` above (same line-splitting shape, same per-call reason). Extracted
 * so this wiring — not just the pure per-line detector — is unit-testable and can't silently drift from
 * what the gate ships (round-3 red-team review, #4318: every lens converged on "the line-parsing and
 * per-file/id dedup the gate does are described in a comment but defended by no test").
 *
 * @param lines raw `git grep -n` output lines.
 * @param opts.resolvableIds Set<string> — see findDanglingBacklogGlobCite.
 * @returns array of `{ file, id, path }`, deduped per distinct (file, id) pair across the WHOLE input
 *          (unlike findDanglingBacklogGlobCite's own per-call dedup, which only ever sees one line here).
 */
export function findDanglingBacklogGlobCitesInGrepLines(lines, { resolvableIds = new Set() } = {}) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const j = line.indexOf(':', i + 1);
    const file = line.slice(0, i);
    const content = j === -1 ? line.slice(i + 1) : line.slice(j + 1);
    for (const f of findDanglingBacklogGlobCite(content, file, { resolvableIds })) {
      const key = `${file}\u0000${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, ...f });
    }
  }
  return out;
}

/**
 * Build the anchor → owning-items map from backlog front-matter. A platform-decisions `#anchor` is owned
 * by EVERY backlog item that resolves to it — an anchor is genuinely multi-owner on this corpus (measured:
 * 109 anchors resolve, 32 have 2+ owners; `#constellation-placement` alone has 43). Two front-matter fields
 * confer ownership, both written as `…platform-decisions.md#<anchor>`:
 *   • `codifiedIn` — the item whose ruling the anchor codifies.
 *   • `graduatedTo` — an item that graduated INTO the anchor (14 items on this tree do), which is just as
 *     much a legitimate authority for it.
 * So the map is `anchor → Set(ownerNum)`, the UNION of both fields across all items. Firing must test set
 * membership, never a single "the owner" — an earlier single-owner premise kept whichever item `readdirSync`
 * yielded first and mislabeled the other 30+ legitimate owners as wrong (#2821 gate 10). This is a lookup,
 * not a recall (#51 hookable-vs-judgment).
 *
 * @param items array of `{ num, codifiedIn?, graduatedTo? }`. `num` is the backlog number; either field may
 *        be absent. Both are scanned for the doc#anchor form.
 * @param opts.doc the statute doc path the anchors live in (default platform-decisions.md).
 * @returns Map<anchorName, Set<ownerNum:string>>. Every item that cites the anchor via either field is in
 *          the set; membership — not identity — is what `findAnchorRulingMismatches` tests.
 */
export function buildAnchorOwners(items, { doc = 'docs/agent/platform-decisions.md' } = {}) {
  const owners = new Map();
  const re = new RegExp(`${doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#([a-z0-9][a-z0-9-]*)`);
  const add = (anchor, num) => {
    let set = owners.get(anchor);
    if (!set) { set = new Set(); owners.set(anchor, set); }
    set.add(String(num));
  };
  for (const it of items || []) {
    if (!it || it.num == null) continue;
    for (const field of [it.codifiedIn, it.graduatedTo]) {
      if (typeof field !== 'string') continue;
      const m = field.match(re);
      if (m) add(m[1], it.num);
    }
  }
  return owners;
}

/**
 * Gate 10 — anchor-authority resolution. Find sentences that cite a platform-decisions `#anchor` AND
 * attribute its ruling to an `#NNN` that is NOT in the anchor's owner set (its codifiedIn / graduatedTo
 * owners). An anchor with several legitimate owners passes for a citation to ANY one of them.
 *
 * PRECISION is the whole game (the task's zero-false-positive bar): a bare `#2439` used as a build-slice
 * reference, and a cross-reference to an anchor with no attributing number, must NOT fire. We fire on only
 * two tight *attribution* shapes, and only for anchors we can resolve (present in the owner map):
 *
 *   A. anchor immediately followed by an attribution paren whose LEADING token is a number, AND whose
 *      number immediately closes or hands off to a comma-separated sibling — `#anchor (#2439, …)` or
 *      `[…](#anchor) (#2439)`. A trailing PROSE paren — `#anchor (independence rests on …)` — does not
 *      match (it does not open with `#NNN`), so real cross-refs are safe; neither does a paren whose
 *      leading number is itself the subject of a PROSE clause — `#anchor (#9999 tracks the build slice)`
 *      — because `#9999` is not followed by a comma or the paren's own close (#2861).
 *   B. an anchor and a number sharing ONE parenthetical group — `(#2439, #anchor-name)` /
 *      `(#anchor-name, #2439)`. A number in a *different* paren than the anchor (e.g. a preceding
 *      `**Ratified … (#2563).**` clause that then mentions the anchor in prose) is NOT in the same group,
 *      so it does not match.
 *
 * The heading-definition form `{#anchor}` is never a citation and is excluded (we only match `#anchor`
 * and `](#anchor)` — a bare `#` immediately preceded by `{` never seeds shape A). Cross-repo / numeric
 * noise can't be an anchor because the anchor must resolve in `anchorOwners`.
 *
 * @param text     the file body (raw). Newlines are normalised so a citation split across lines still matches.
 * @param anchorOwners Map<anchorName, Set<ownerNum>> from buildAnchorOwners.
 * @returns array of `{ anchor, citedNum, owners, shape, context }` — `owners` is the anchor's full sorted
 *          owner set (the legitimate authorities the cited number was NOT one of).
 */
export function findAnchorRulingMismatches(text, anchorOwners) {
  const findings = [];
  if (typeof text !== 'string' || text === '' || !anchorOwners || anchorOwners.size === 0) return findings;
  // Join lines so a citation wrapped across a newline (as in platform-decisions Lineage blocks) still reads
  // as one adjacency; collapse runs of whitespace so the adjacency regexes stay simple.
  const flat = text.replace(/\s+/g, ' ');
  // Longest anchor first so a shorter anchor that prefixes a longer one can't shadow it.
  const anchorAlt = [...anchorOwners.keys()].sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!anchorAlt) return findings;

  const record = (anchor, citedNum, shape, idx) => {
    const ownerSet = anchorOwners.get(anchor);
    // Fire ONLY when the cited number owns NONE of this anchor — a genuinely wrong attribution. An anchor
    // is multi-owner on this corpus, so a citation to any ONE of its legitimate owners must pass.
    if (!ownerSet || ownerSet.size === 0 || ownerSet.has(String(citedNum))) return;
    findings.push({
      anchor,
      citedNum: String(citedNum),
      owners: [...ownerSet].sort(),
      shape,
      context: flat.slice(Math.max(0, idx - 30), idx + 80).trim(),
    });
  };

  // Shape A: `#anchor` — optionally closing a markdown link (`)`) or a backtick/quote wrapper (`` ` `` / `'`
  // / `"`) — directly followed by an attribution paren whose LEADING token is `#NNN` AND whose trailing edge
  // (mod a backtick/quote wrapper) is a comma or the paren's own close. That trailing requirement is the
  // shape-A analogue of shape B's comma-adjacency hardening below: `#anchor (#2439, …)` / `#anchor (#2439)`
  // are citation-list parens — the number IS (the start of) the paren's content — but `#anchor (#9999 tracks
  // the build slice)` is a PROSE paren that merely OPENS with a number; `#9999` is the subject of its own
  // clause, not an attribution. A bare `\(\s*#(\d{3,5})\b` with no tail check can't tell them apart, and
  // that gap is exactly the false positive #2861 reproduces: `[foo](#foo-anchor) (#9999 tracks the build
  // slice)` — the wrapper class steps over the markdown link's own closing `)` (correctly — that's the
  // anchor's OWN group, not an attribution), then the loose tail let `#9999`'s unrelated prose paren read as
  // `#foo-anchor`'s attribution merely for sitting next to it.
  // A bare `#` is also never preceded by `{` — `{#anchor}` is a HEADING DEFINITION (see module header), not
  // a citation, so it must not seed shape A regardless of what (if anything) follows it. The `](#` alternative
  // (markdown link) is unaffected — a link target is always a real citation, never a heading anchor.
  const shapeA = new RegExp(
    `(?:\\]\\(#|(?<!\\{)#)(${anchorAlt})[)\`'"]*\\s*\\(\\s*#(\\d{3,5})\\b[\`'"]*\\s*[,)]`,
    'g',
  );
  for (const m of flat.matchAll(shapeA)) record(m[1], m[2], 'A', m.index);

  // Shape B: a single parenthetical group holding the anchor and a number as COMMA-SEPARATED attribution
  // tokens, in either order — `` (`#anchor`, #NNN) `` / `(#NNN, #anchor-name)`. The comma-adjacency is what
  // makes it an ATTRIBUTION rather than mere co-residence: an incidental number in prose beside the anchor
  // (`(#NNN introduced the check enforced by #anchor)`) has no comma directly between the two tokens, so it
  // no longer over-fires (the earlier "any anchor + any number in one paren" test broke the zero-false-positive
  // bar). A backtick/quote wrapper between a token and the comma is tolerated (the real `` `#anchor`, #NNN `` form).
  const parenGroup = /\(([^()]*)\)/g;
  const anchorThenNum = new RegExp(`#(${anchorAlt})[\`'"]*\\s*,\\s*#(\\d{3,5})\\b`);
  const numThenAnchor = new RegExp(`#(\\d{3,5})\\b[\`'"]*\\s*,\\s*[\`'"]*#(${anchorAlt})\\b`);
  for (const pm of flat.matchAll(parenGroup)) {
    const inner = pm[1];
    const am = inner.match(anchorThenNum);
    if (am) { record(am[1], am[2], 'B', pm.index); continue; }
    const nm = inner.match(numThenAnchor);
    if (nm) record(nm[2], nm[1], 'B', pm.index);
  }
  return findings;
}

/**
 * Gate 5 — `we:<path>:<line>` resolution. A code-locus citation must resolve: the file exists and the line
 * is within it. Dangling path or out-of-range line = error. `fui:` / `plateau:` loci are recognised and
 * skipped (their targets aren't in this checkout). Line ranges (`:164-194`) resolve on both bounds.
 *
 * @param text the file body (raw).
 * @param opts.fileExists (relPath:string) => boolean — does the repo-relative path exist?
 * @param opts.lineCount  (relPath:string) => number|null — line count, or null if unreadable/missing.
 * @returns array of `{ locus, path, line, reason }` (reason: 'missing-file' | 'line-out-of-range').
 */
export function findDanglingLoci(text, { fileExists, lineCount }) {
  const findings = [];
  if (typeof text !== 'string' || text === '') return findings;
  // A code-locus is a REPO-RELATIVE path. A matched path that is absolute or climbs out of the repo with a
  // `..` segment is never a valid citation — and must NOT reach the injected fs readers, or the caller's
  // `readFileSync(join(ROOT, path))` would resolve the traversal and read (and line-split) an arbitrary file
  // outside the tree — a large/streaming target (e.g. `we:../../../../dev/urandom:1`) hangs or OOMs the gate.
  // Skip such loci entirely (never resolved, never errored — same posture as a cross-repo locus).
  const isInRepoPath = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').includes('..');
  // we:<path>:<line> or we:<path>:<start>-<end>. Path is a run of path chars (no whitespace, no `:` — the
  // `:` after the path is the line separator). Requires at least one `/` so a bare `we:foo:1` word can't
  // masquerade as a locus; matches the repo-locus convention (we:docs/agent/conventions.md).
  const rx = /\b(we|fui|plateau):([A-Za-z0-9._\-/]+\/[A-Za-z0-9._\-]+):(\d+)(?:-(\d+))?\b/g;
  const seen = new Set();
  for (const m of text.matchAll(rx)) {
    const [, prefix, path, startStr, endStr] = m;
    if (CROSS_REPO_LOCI.has(`${prefix}:`)) continue; // cross-repo — not resolvable here, never errored
    if (!isInRepoPath(path)) continue;               // absolute / `..`-escaping — never hand to the fs readers
    const locus = endStr ? `${prefix}:${path}:${startStr}-${endStr}` : `${prefix}:${path}:${startStr}`;
    if (seen.has(locus)) continue;
    seen.add(locus);
    if (!fileExists(path)) {
      findings.push({ locus, path, line: Number(startStr), reason: 'missing-file' });
      continue;
    }
    const count = lineCount(path);
    if (count == null) continue; // unreadable — don't guess
    const hi = endStr ? Number(endStr) : Number(startStr);
    if (Number(startStr) < 1 || hi > count) {
      findings.push({ locus, path, line: hi, reason: 'line-out-of-range' });
    }
  }
  return findings;
}

/**
 * Count the LINES of a source file for a `we:<path>:<line>` range check (gate 5). A file ending in a
 * newline has that trailing `\n` as a line TERMINATOR, not a following empty line — so a naive
 * `split('\n').length` overcounts by one and lets a locus pointing one line past the true end read as
 * in-range. This strips that single trailing-newline artifact so the count is the real line total. Pure —
 * the caller injects the file text; this is exercised directly by the unit test (the injected `lineCount`
 * in `findDanglingLoci` should be `countSourceLines(readFileSync(...))`).
 * @param text the file body.
 * @returns the number of lines (0 for an empty file).
 */
export function countSourceLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Wrap a raw file-text reader in a per-path memoizing cache, for `findDanglingLoci`'s injected `lineCount`
 * (#2863). Without this, `check-standards.mjs` re-reads and re-splits the SAME cited file once per locus
 * OCCURRENCE citing it — measured: `docs/agent/platform-decisions.md` (355 KB) read and line-split 145 times,
 * `scripts/merge-ai-prs.mjs` (207 KB) 40 times, 113.7 MB of redundant I/O and string-splitting in one gate
 * pass across only 279 distinct files out of 1513 reads. Cost is O(citations × file size) and grows every
 * time a popular file gains another citation. A `Map` keyed on the repo-relative path fixes it: same file,
 * many citing loci, ONE read.
 *
 * I/O-free and pure by construction: the caller injects `readFileText` (e.g.
 * `(p) => readFileSync(join(ROOT, p), 'utf8')`), so this is exercisable with a synthetic COUNTING reader that
 * asserts it is invoked once per distinct path even when the returned function is called many times with the
 * same path (see scripts/__tests__/citation-check.test.mjs).
 *
 * @param readFileText (relPath:string) => string — throws (or returns non-string) for a missing/unreadable
 *        file, which this treats the same way `findDanglingLoci`'s original inline closure did: cache `null`.
 * @returns (relPath:string) => number|null — a drop-in replacement for the `lineCount` option.
 */
export function makeMemoizedLineCounter(readFileText) {
  const cache = new Map();
  return (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath);
    let count;
    try {
      const text = readFileText(relPath);
      count = typeof text === 'string' ? countSourceLines(text) : null;
    } catch {
      count = null;
    }
    cache.set(relPath, count);
    return count;
  };
}

/**
 * Split a source file into its real lines, with the same trailing-newline handling as `countSourceLines`
 * (the final `\n` is a terminator, not an extra empty line). `splitSourceLines(t).length === countSourceLines(t)`.
 * @param text the file body.
 * @returns the lines (empty array for an empty / non-string input).
 */
export function splitSourceLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Memoizing line reader for `findBlankLineLoci`'s injected `readLines` — same one-read-per-distinct-path
 * rationale as `makeMemoizedLineCounter` (#2863). Unreadable files cache `null`.
 * @param readFileText (relPath:string) => string — throws or returns non-string for an unreadable file.
 * @returns (relPath:string) => string[]|null
 */
export function makeMemoizedLineReader(readFileText) {
  const cache = new Map();
  return (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath);
    let lines;
    try {
      const text = readFileText(relPath);
      lines = typeof text === 'string' ? splitSourceLines(text) : null;
    } catch {
      lines = null;
    }
    cache.set(relPath, lines);
    return lines;
  };
}

/**
 * Gate 6f-ii-e — a `we:<path>:<line>` cite whose START line is blank. Gate 5 (`findDanglingLoci`) only
 * bounds-checks, so a cite into a file that was later edited stays green while pointing at unrelated text.
 * A deterministic gate cannot judge what a card MEANT to point at, but a blank line is never it — the
 * cheapest drift signal. Only the start line of a range `a-b` is checked (a range may legitimately span
 * blanks). A cite that drifts onto unrelated NON-blank text still passes: this is the cheap slice, not the
 * content-aware check. Same locus regex and skips as `findDanglingLoci`; missing / unreadable / out-of-range
 * targets yield no finding (gate 5 owns those).
 *
 * @param text the file body (raw).
 * @param opts.fileExists (relPath:string) => boolean
 * @param opts.readLines  (relPath:string) => string[]|null — the file's lines (see `splitSourceLines`).
 * @returns array of `{ locus, path, line }` — one per distinct blank-start-line locus.
 */
export function findBlankLineLoci(text, { fileExists, readLines }) {
  const findings = [];
  if (typeof text !== 'string' || text === '') return findings;
  const isInRepoPath = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').includes('..');
  const rx = /\b(we|fui|plateau):([A-Za-z0-9._\-/]+\/[A-Za-z0-9._\-]+):(\d+)(?:-(\d+))?\b/g;
  const seen = new Set();
  for (const m of text.matchAll(rx)) {
    const [, prefix, path, startStr, endStr] = m;
    if (CROSS_REPO_LOCI.has(`${prefix}:`)) continue;
    if (!isInRepoPath(path)) continue;
    const locus = endStr ? `${prefix}:${path}:${startStr}-${endStr}` : `${prefix}:${path}:${startStr}`;
    if (seen.has(locus)) continue;
    seen.add(locus);
    if (!fileExists(path)) continue;
    const lines = readLines(path);
    if (!Array.isArray(lines)) continue;
    const line = Number(startStr);
    if (line < 1 || line > lines.length) continue;
    if (lines[line - 1].trim() === '') findings.push({ locus, path, line });
  }
  return findings;
}

/**
 * Gate 3 — hash-slug outside the at-land rewrite scope. A `xNNNNNN` hash-slug citation living in a dir the
 * hash→NNN rewriter never touches (reports/, the two research dirs) will dangle permanently once the item
 * lands with a real NNN. We match only the two citation FORMS the drift takes — a `#xNNNNNN` cross-ref and
 * a `xNNNNNN-slug.md` file link — so a stray word can't trip it.
 *
 * DEDUPED PER SLUG, PER FILE (#2863). The raw regexes below are occurrence-scanners: the same slug cited 11
 * times in one file, or cited in both forms (a `#xNNNNNN` cross-ref AND a `xNNNNNN-slug.md` file link), is
 * still ONE problem a reader fixes once — not 11 (or 2-3) separate warnings. Measured on this corpus before
 * the dedupe: 85 warnings for 30 distinct slugs, one slug alone yielding 11. Every duplicate also carried the
 * identical `{kind, file}` descriptor, so `--scope` could not tell them apart — the opposite of the per-file
 * keying #1389 established for the sibling `findDanglingLoci` rule above (which dedupes by exact locus text).
 * So this dedupes down to ONE finding per distinct slug per call (a call is already one file, per the caller's
 * per-file scan loop): the FIRST form the slug is seen in (hash-ref scanned before file-link) is what the
 * finding reports, which is enough for the caller's message to name a concrete citation to fix.
 *
 * @param text    the file body (raw).
 * @param relPath the file's repo-relative path (decides in/out of scope).
 * @param opts.outOfScopeDirs default HASH_SLUG_OUT_OF_SCOPE_DIRS.
 * @returns array of `{ slug, form }` (form: 'hash-ref' | 'file-link'), one entry per distinct slug; empty if
 *          relPath is in rewrite scope.
 */
export function findOutOfScopeHashSlugs(text, relPath, { outOfScopeDirs = HASH_SLUG_OUT_OF_SCOPE_DIRS } = {}) {
  const findings = [];
  if (typeof text !== 'string' || text === '' || typeof relPath !== 'string') return findings;
  if (!outOfScopeDirs.some((d) => relPath.startsWith(d))) return findings; // in-scope dir self-heals at land
  const hashRef = new RegExp(`#(${HASH_SLUG})\\b`, 'g');
  const fileLink = new RegExp(`\\b(${HASH_SLUG})-[a-z0-9-]+\\.md\\b`, 'g');
  const seen = new Map(); // slug → form of its first-seen citation
  for (const m of text.matchAll(hashRef)) if (!seen.has(m[1])) seen.set(m[1], 'hash-ref');
  for (const m of text.matchAll(fileLink)) if (!seen.has(m[1])) seen.set(m[1], 'file-link');
  for (const [slug, form] of seen) findings.push({ slug, form });
  return findings;
}

/**
 * Gate 3b (#3100) — a hash-slug cited in `agent-memory-src/` that does not resolve to anything LIVE.
 *
 * WHY THIS IS NOT JUST "run findOutOfScopeHashSlugs with agent-memory-src/ added to outOfScopeDirs". That
 * was the fix the #3100 card originally proposed, and its own independent review mutation-tested it and
 * found it wrong: `agent-memory-src/` is now INSIDE the rewrite scope (`HASH_REWRITE_DIRS`), meaning a
 * hash-slug cited there DOES self-heal — but only AT THE MOMENT the item it names lands, not before. A
 * membership test ("is this dir out of scope?") can't tell "this hash is mid-flight and will self-heal at
 * its own land" apart from "this hash already landed and its citation was never rewritten" apart from
 * "this hash never existed" — it would WARN on all three, including the first, which is not a defect.
 *
 * So this checks RESOLUTION instead of directory membership, the same way a human reviewer would (and the
 * way #3100's own independent review did by hand): does the cited hash resolve against something real?
 *   • a currently-tracked `backlog/<hash>.md` file (still pending/in-flight) — NOT a defect: the next time
 *     that item lands, the now-widened rewrite scope rewrites this exact citation to `#NNN` automatically.
 *   • a `bornAs: <hash>` record in a landed `backlog/NNN-*.md` (the item already landed under a real
 *     number) — a genuine defect: the citation should already read `#NNN` and does not, either because it
 *     was written before this fix widened the rewrite scope, or because it was hand-typed after the item
 *     had already landed. Flagged as `dead-landed`.
 *   • neither — the hash never existed on this tree (typo, or an abandoned/rebased lane's throwaway id).
 *     Flagged as `unresolved`.
 *
 * @param text the file body (raw), expected to be an `agent-memory-src/*.md` file.
 * @param opts.pendingHashes Set<hash> — hashes with a currently-tracked `backlog/<hash>.md` (still
 *        in-flight; self-heals at that item's own land — never flagged).
 * @param opts.bornAsHashes  Set<hash> — hashes with a `bornAs: <hash>` record in a landed backlog item
 *        (already landed under a real number; a citation still carrying the hash is stale).
 * @returns array of `{ slug, form, reason }` (form: 'hash-ref' | 'file-link'; reason: 'dead-landed' |
 *          'unresolved').
 */
export function findDanglingMemoryHashSlugs(text, { pendingHashes = new Set(), bornAsHashes = new Set() } = {}) {
  const findings = [];
  if (typeof text !== 'string' || text === '') return findings;
  const classify = (slug) => {
    if (pendingHashes.has(slug)) return null; // still in-flight — self-heals at its own land, not a defect
    if (bornAsHashes.has(slug)) return 'dead-landed';
    return 'unresolved';
  };
  const hashRef = new RegExp(`#(${HASH_SLUG})\\b`, 'g');
  const fileLink = new RegExp(`\\b(${HASH_SLUG})-[a-z0-9-]+\\.md\\b`, 'g');
  for (const m of text.matchAll(hashRef)) {
    const reason = classify(m[1]);
    if (reason) findings.push({ slug: m[1], form: 'hash-ref', reason });
  }
  for (const m of text.matchAll(fileLink)) {
    const reason = classify(m[1]);
    if (reason) findings.push({ slug: m[1], form: 'file-link', reason });
  }
  return findings;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// PROVENANCE gate (#3026) — a bare backticked identifier in prose must resolve, or be marked
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The three markers that say "this name is NOT being asserted to exist". A closed vocabulary of exactly
 * three, one per legitimate class MEASURED on this corpus (#3026) — not an open synonym list, because the
 * escape's whole value is being greppable: `grep -rn '(proposed)\|(does not exist)\|(example)'` finds every
 * deliberate forward reference in one pass, and a reviewer reading the sentence sees the author's intent
 * inline. Each marker follows the closing backtick: `` `newThing` (proposed) ``.
 *
 *   • `proposed`        — a name for something not built yet (the dominant corpus class: 1,068 distinct
 *                         unresolved tokens are mostly an unbuilt item naming the function it will write).
 *   • `does not exist`  — a name cited AS absent: a refuted claim, an audit finding, a defect being reported.
 *                         Real instance: #3013 prep's "`enforceFlipReady`, which the statute names but which
 *                         does not exist in the tree".
 *   • `example`         — a name quoted illustratively or as a historical citation, where whether it exists
 *                         is beside the point. Real instance: this gate's own item quoting the seven misses.
 */
export const PROVENANCE_ESCAPE_MARKERS = Object.freeze(['proposed', 'does not exist', 'example']);

/** Heading zones where an unresolved name is conventional and expected (#3026). A `## Done when` section
 *  names the functions the item will WRITE; a `## Design` section names the shape it proposes. Both are
 *  already the conventional homes for not-yet-real names, so an author writing there does not also have to
 *  mark each token. The zone runs until the next heading at the SAME OR SHALLOWER level, so a `###`
 *  subsection of `## Done when` inherits it. Verified against the historical misses this gate exists to
 *  catch: none of them lived under an escape heading (`validateTodoMarkerBlock` was under
 *  `## Where it is today`, `enforceFlipReady` in the item lede, `collectOpenItemIds` in a JSDoc block).
 *  `## Acceptance` is the #5399 name for `## Done when`; `## Non-goals` names things deliberately not built.
 *  An entry is a lowercase string (the heading, or the heading followed by a space or colon) or a RegExp tested
 *  against the lowercased title. The agreement sections use the reader's own regexes, so a spelling the reader
 *  accepts (`Acceptance criteria`, `Non-goal`, `Done when:`) can never fall outside the zone. */
export const PROVENANCE_ESCAPE_HEADINGS = Object.freeze(['design', ACCEPTANCE_HEADING_RE, NON_GOALS_HEADING_RE]);

/** Whether a (lowercased, markup-stripped) heading title opens an escape zone. */
function isEscapeHeading(title, escapeHeadings) {
  return escapeHeadings.some((k) => (k instanceof RegExp
    ? k.test(title)
    : title === k || title.startsWith(`${k} `) || title.startsWith(`${k}:`)));
}

/** The region escape, for a block that quotes MANY non-resolving names (a table of historical defects, a
 *  list of illustrative proposals) where a per-token marker would be pure noise. Two lines instead of N
 *  markers. A REASON is REQUIRED — a bare `off` does not escape and is reported in its own right, so the
 *  escape can never be a silent blanket. Greppable as `provenance-lint:`; visible in the rendered diff.
 *
 *  These two patterns are matched against a line's COMMENT PAYLOAD ONLY, never the raw line — see
 *  `regionMarkerPayload`. Matching the raw line is the SELF-DISARM defect: the paragraph in
 *  `docs/agent/conventions.md` that documents this very escape contains the sentence "a bare
 *  `` `provenance-lint: off` `` suppresses nothing", which the raw-line form matched, captured " suppresses
 *  nothing and is reported in its own" as a ≥3-char "reason", and silently switched the gate off for the
 *  whole remainder of the page — so every section appended to that file afterwards was exempt, and any docs
 *  page that merely MENTIONS the marker in prose disarmed itself the same way. Silent-clean is the worst
 *  failure mode a gate can have, so the marker is now recognised only where a real directive can live. */
export const PROVENANCE_REGION_OFF_RE = /provenance-lint:\s*off\b(.*)$/i;
export const PROVENANCE_REGION_ON_RE = /provenance-lint:\s*on\b/i;

/** Blank out every inline code span on a line, preserving offsets. A marker QUOTED as code is a marker being
 *  DISCUSSED, not one being issued — both the single- and double-backtick forms, because docs prose uses
 *  both (`` `provenance-lint: off` `` and `` `<!-- provenance-lint: off — why -->` `` are equally "quoted"). */
function maskCodeSpans(line) {
  if (typeof line !== 'string' || line === '') return '';
  const blank = (m) => ' '.repeat(m.length);
  return line.replace(/``.+?``/g, blank).replace(/`[^`\n]{1,120}`/g, blank);
}

/**
 * The part of a line where a `provenance-lint:` directive may legitimately live — a COMMENT, per syntax mode
 * — with inline code spans masked out first. Returns null when the line offers no such place.
 *
 * Two independent gates, and both are needed; either alone still self-disarms.
 *   • ANCHOR TO A COMMENT. In markdown the documented form is an HTML comment (`<!-- provenance-lint: off — …
 *     -->`); in `comment` syntax mode the caller has already established the line is a `//` or `/* … *\/`
 *     comment. Prose that merely says the words "provenance-lint: off" mid-sentence — the exact shape that
 *     disarmed `conventions.md` — carries no comment opener and is therefore inert. Masking alone would not
 *     have caught it: the sentence writes the marker in code spans AND in bare prose in the same paragraph.
 *   • MASK CODE SPANS. A docs page teaching the syntax naturally writes the whole HTML comment inside an
 *     inline span, which WOULD satisfy the anchor. Fenced blocks are already skipped upstream, but an inline
 *     span is not, so it is masked here.
 *
 * Net effect: the marker works as a real HTML comment, is inert inside a fenced block (upstream), inert
 * inside an inline code span, and inert in running prose — all three of which occur on the same docs page.
 *
 * @param line   the raw line.
 * @param syntax 'markdown' | 'comment'.
 * @returns the directive-eligible text, or null if this line has none.
 */
export function regionMarkerPayload(line, syntax = 'markdown') {
  const masked = maskCodeSpans(line);
  if (masked === '') return null;
  if (syntax === 'comment') {
    // The caller only offers lines it has already classified as comment prose, so the whole line qualifies;
    // strip the punctuation so a reason does not start with `*` or end with `*/`.
    return masked.replace(/^\s*(?:\/\*+|\/\/+|\*+)/, '').replace(/\*+\/\s*$/, '');
  }
  const html = masked.match(/<!--([\s\S]*?)(?:-->|$)/);
  return html ? html[1] : null;
}

// Identifier SHAPES that read as a code symbol in prose. camelCase must carry an interior capital (so a
// plain English word like `status` is never a citation) and SCREAMING_SNAKE must carry an underscore (so a
// bare acronym like `WE` / `TODO` is never one). Deliberately excludes PascalCase: on this corpus that shape
// is dominated by class/type NOUNS used as concepts (`CustomStore`, `InjectorRoot`) rather than existence
// claims, and including it re-introduces the false positives the corpus-wide run proved fatal.
const PROVENANCE_CAMEL_RE = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/;
const PROVENANCE_SCREAMING_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Longest backticked span we will even look at. Caps regex work on a pathological line (a NUL-sentinel
 *  file read as utf8 is one long line) and no real identifier citation is longer. */
const PROVENANCE_MAX_SPAN = 120;

const isIdentifierShape = (t) =>
  typeof t === 'string' && t.length > 1 && t.length <= PROVENANCE_MAX_SPAN &&
  (PROVENANCE_CAMEL_RE.test(t) || PROVENANCE_SCREAMING_RE.test(t));

/**
 * Parse ONE backticked span into the identifier it asserts, or null if it asserts none.
 *
 * Two accepted forms — and the CALL form is not cosmetic. #3026's design said "a trailing `()` tolerated",
 * i.e. `` `foo()` ``. Measured against the real corpus that misses the single most important instance: the
 * statute asserts `` `enforceFlipReady({ ciStatus, reviewShadowLedger })` `` — a call written WITH its
 * arguments, which is the STRONGEST form of "this function exists" and the exact citation the briefing
 * flagged as resolving to zero code files. So the call form accepts any argument list, not just `()`.
 *
 * @param raw the span's inner text, already trimmed.
 * @returns `{ token, form }` (form: 'bare' | 'call') or null.
 */
export function parseIdentifierSpan(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > PROVENANCE_MAX_SPAN) return null;
  if (isIdentifierShape(raw)) return { token: raw, form: 'bare' };
  // `foo(…)` / `ns.foo(…)` — the callee is the last dotted segment.
  const call = raw.match(/^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,4})\s*\(/);
  if (call) {
    const callee = call[1].slice(call[1].lastIndexOf('.') + 1);
    if (isIdentifierShape(callee)) return { token: callee, form: 'call' };
  }
  return null;
}

/**
 * Every inline code span on a line, innermost text first, with whatever FOLLOWS the span (so the caller can
 * look for a trailing escape marker).
 *
 * Handles BOTH markdown forms, and the doubled one is not academic. `docs/agent/conventions.md` writes
 * `` `we:CustomComment.ts` `` — the double-backtick wrapper you need whenever the displayed code itself
 * contains a backtick — throughout. A single-backtick-only regex silently sees nothing there, which is the
 * worst failure mode a gate can have: it read the file, found no citation, and reported clean. (Observed:
 * the first wiring returned zero findings on a docs page deliberately seeded with two bad names.)
 *
 * @returns array of `{ inner, after }`.
 */
export function codeSpans(line) {
  const out = [];
  if (typeof line !== 'string' || line === '') return out;
  // Double-backtick spans first; their content MAY contain single backticks, so match non-greedily and then
  // peel the inner wrapper. Mask each consumed region so the single-backtick pass cannot re-scan inside it.
  const chars = [...line];
  const masked = chars.slice();
  for (const m of line.matchAll(/``(.+?)``/g)) {
    const inner = m[1].trim().replace(/^`+/, '').replace(/`+$/, '').trim();
    out.push({ inner, after: line.slice(m.index + m[0].length) });
    for (let i = m.index; i < m.index + m[0].length && i < masked.length; i++) masked[i] = ' ';
  }
  const rest = masked.join('');
  for (const m of rest.matchAll(/`([^`\n]{1,120})`/g)) {
    out.push({ inner: m[1].trim(), after: line.slice(m.index + m[0].length) });
  }
  return out;
}

/** Does the text immediately following a span's closing backtick carry a not-asserted marker? Tolerates
 *  markdown emphasis inside the parens — the real instance is written `(**does not exist**)`. */
function hasInlineEscape(rest) {
  const m = rest.match(/^\s*\(\s*[*_~]{0,2}\s*([a-z ]+?)\s*[*_~]{0,2}\s*\)/i);
  return !!m && PROVENANCE_ESCAPE_MARKERS.includes(m[1].trim().toLowerCase());
}

/**
 * The PROVENANCE gate (#3026) — extract identifier-shaped backticked tokens from PROSE and report the ones
 * that do not resolve against the tree and are not explicitly marked as unasserted.
 *
 * WHY THIS IS DIFF-SCOPED, AND WHY THAT IS THE WHOLE DESIGN. Measured on this checkout (re-derived
 * 2026-08-09, and it reproduces the filing measurement): a corpus-wide run over the 3,040 markdown files in
 * `backlog/` + `docs/` extracts **11,779 identifier tokens of which 1,068 distinct (1,808 occurrences) do
 * not resolve** — and spot-checking the head of that list (`createRadioGroup`, `detectAnomalies`,
 * `mountLaneBoard`, `produceFunctionalBytes`) shows the dominant class is LEGITIMATE: an unbuilt item naming
 * the function it proposes to write. A gate that fires 1,808 times on correct prose is a gate everyone
 * learns to scroll past. So the caller passes `addedLines` — the lines the change under review ADDED — and
 * only findings on those lines are returned. The existing corpus is never re-litigated.
 *
 * WHY `backlog/` IS OUT OF SCOPE — a MEASURED narrowing of #3026's filed design, not a shortcut. The item
 * specifies `backlog/*.md` + `docs/**` + `leash: spec` comments, on the strength of one hand-picked diff
 * ("19 tokens, 1 unresolved, zero false positives"). Replaying the SHIPPING extractor over the 40 most
 * recent merges into `main` does not reproduce that:
 *
 *   scope                                 findings   merges non-clean
 *   backlog + docs + leash-spec              503          22 / 40
 *   …plus a "token appears in the item's
 *     own filename" proposal escape          339          20 / 40
 *   docs + leash-spec (SHIPPED)                0           0 / 40
 *
 * The 503 are overwhelmingly correct prose: `clearerId`(108) and `authorId`(99) are parameters an OPEN item
 * accurately describes as not yet existing; `buildPassRecord`(72) is a function a slice proposes to write.
 * That is not a lint, it is a wolf-cry. The dividing line is what the surface is FOR: `backlog/` is a
 * PROPOSAL register whose prose is mostly about work not yet done, so an unresolved name there is the norm;
 * `docs/agent/**` (the statute and the agent instructions) and the `leash: spec` contracts are ASSERTION
 * surfaces that describe what IS, and a name there resolving nowhere is exactly the defect class.
 *
 * The shipped zero is NOT vacuous — a positive control (same 40 merges, `resolves` forced false) shows the
 * gate put **271 identifier tokens on added prose lines through resolution across 12 of the 40 merges** and
 * flagged none. #3026 therefore stays OPEN for its `backlog/` half, which needs a proposal-vs-assertion
 * discriminator nobody has yet built.
 *
 * The state that decides an escape (fenced-code, heading zone, `provenance-lint: off` region) is computed
 * over the WHOLE text, not just the added lines, because a line added inside a pre-existing fence or under
 * an untouched `## Done when` heading must inherit that context. Hence: scan everything, report the subset.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Resolution here is deliberately LOOSE — a token resolves if the
 * name appears anywhere in the tree's source files. The question the gate answers is "does this name exist
 * at all?", which is precisely the question the historical misses failed. It cannot prove the SENTENCE about
 * the name is true: a resolvable name can still be cited wrongly (a real symbol in the wrong file, a
 * miscounted fixture total, a misdescribed behaviour). That residue stays a review-and-author discipline.
 *
 * @param text the file body (raw).
 * @param opts.resolves (token:string) => boolean — injected; does this name exist anywhere in the tree's
 *        source files? I/O-free here, so the index is built by check-standards.mjs and faked by the tests.
 * @param opts.addedLines Set<number> of 1-based line numbers the change added, or null for "the whole file"
 *        (used only by the corpus-wide measurement, never by the wired gate).
 * @param opts.syntax 'markdown' (default) or 'comment' — in 'comment' mode only `//` and `/* *\/` comment
 *        lines are prose, so the gate reads a `leash: spec` source file's JSDoc without reading its code.
 * @returns array of `{ kind, token, line, form, context }`. `kind` is 'unresolved' for a failing citation;
 *          'escape-no-reason' for a `provenance-lint: off` marker that states no reason (which therefore
 *          does NOT escape — the fail-closed direction: an unexplained blanket is refused, not honoured);
 *          or 'escape-unclosed' for a reasoned region left open at EOF (which DOES escape, but says so).
 */
export function findUnresolvedIdentifiers(text, {
  resolves,
  addedLines = null,
  syntax = 'markdown',
  escapeHeadings = PROVENANCE_ESCAPE_HEADINGS,
} = {}) {
  const findings = [];
  if (typeof text !== 'string' || text === '' || typeof resolves !== 'function') return findings;

  const lines = text.split('\n');
  let inFence = false;
  let fenceChar = '';
  let escapeLevel = null;   // heading depth that opened the current escape zone, or null
  let regionOff = false;
  let regionOffLine = null;      // where the currently-open region was opened (for the unclosed report)
  let regionOffContext = '';
  let inBlockComment = false;
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // ── fenced code: never prose, in either syntax mode (JSDoc carries ``` blocks too).
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (fence[1][0] === fenceChar) { inFence = false; }
      continue;
    }
    if (inFence) continue;

    // ── prose selection + heading zones.
    let prose;
    if (syntax === 'comment') {
      // Track `/* … */` blocks; a `//` line is prose too. Everything else is code — not our surface.
      const opensBlock = /\/\*/.test(line);
      const closesBlock = /\*\//.test(line);
      prose = inBlockComment || opensBlock || /^\s*\/\//.test(line);
      if (opensBlock && !closesBlock) inBlockComment = true;
      else if (closesBlock) inBlockComment = false;
    } else {
      prose = true;
      const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (h) {
        const depth = h[1].length;
        const title = h[2].replace(/[`*_]/g, '').trim().toLowerCase();
        // A heading at the same-or-shallower depth closes an open zone; a deeper one inherits it.
        if (escapeLevel !== null && depth <= escapeLevel) escapeLevel = null;
        if (escapeLevel === null && isEscapeHeading(title, escapeHeadings))
          escapeLevel = depth;
        continue;
      }
    }
    if (!prose) continue;

    // ── the region escape, read from this line's COMMENT PAYLOAD only (never the raw line — see
    //    PROVENANCE_REGION_OFF_RE's header for the self-disarm defect that requires this). Checked before the
    //    regionOff/zone skip so that `on` can always re-arm from inside an open region.
    const payload = regionMarkerPayload(line, syntax);
    if (payload !== null) {
      const off = payload.match(PROVENANCE_REGION_OFF_RE);
      if (off) {
        const reason = off[1].replace(/(-->|\*\/)\s*$/, '').replace(/^[\s—–:,.*_-]+/, '').trim();
        if (reason.length >= 3) { regionOff = true; regionOffLine = lineNo; regionOffContext = line.trim().slice(0, 120); }
        else findings.push({ kind: 'escape-no-reason', token: null, line: lineNo, form: null, context: line.trim().slice(0, 120) });
        continue;
      }
      if (PROVENANCE_REGION_ON_RE.test(payload)) { regionOff = false; regionOffLine = null; continue; }
    }

    if (regionOff || escapeLevel !== null) continue;
    if (addedLines && !addedLines.has(lineNo)) continue;

    for (const { inner, after } of codeSpans(line)) {
      const parsed = parseIdentifierSpan(inner);
      if (!parsed) continue;
      if (hasInlineEscape(after)) continue;
      if (resolves(parsed.token)) continue;
      const key = `${lineNo}:${parsed.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind: 'unresolved', token: parsed.token, line: lineNo, form: parsed.form, context: line.trim().slice(0, 160) });
    }
  }

  // An `off` that is never closed suppresses everything to EOF. That is design-ACCEPTED (a file whose tail is
  // all illustrative names is legitimate) but it must not be silent: an author who forgets the `on` gets a
  // blanket escape they never asked for, and every future section appended to that file inherits it. Reported
  // only when the OPENING line is itself in the diff, so the gate stays diff-scoped and never re-litigates a
  // region that was already there.
  if (regionOff && regionOffLine !== null && (!addedLines || addedLines.has(regionOffLine))) {
    findings.push({ kind: 'escape-unclosed', token: null, line: regionOffLine, form: null, context: regionOffContext });
  }
  return findings;
}

/**
 * Strip COMMENT text from a source body so the resolution index is built from code only.
 *
 * This is not a nicety — it is the fix for a measured miss. Replaying PR #1112 round 1 (`2423f255`), the
 * false cite `collectOpenItemIds` did NOT fire, because the index included the very JSDoc block that
 * invented the name: the token "resolved" against its own false assertion. A citation in prose asserts
 * something about the CODE, so the index must be what the code knows, never what another comment claims.
 *
 * Deliberately conservative about `//`: only a line whose first non-space characters are `//` is stripped.
 * A trailing `// …` is left alone because the same two characters appear inside every `https://` URL in
 * every JSON/config string, and stripping to end-of-line there would silently delete real code tokens.
 * Block comments (`/* … *\/`, which is where JSDoc — and the miss — lives) are stripped wherever they occur.
 */
export function stripSourceComments(body) {
  if (typeof body !== 'string' || body === '') return '';
  // Block comments first; keep newlines so nothing merges across lines.
  const noBlocks = body.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
}

/** A source extension worth indexing. Anything else (images, lockfiles, binaries) carries no vocabulary.
 *  `.mts`/`.cts` are here for the same reason `.mjs`/`.cjs` are: they are ORDINARY SOURCE, and a missing
 *  extension is a silent false-positive generator — every name defined only in such a file contributes no
 *  vocabulary, so citing it reads as "resolves to NO source file". They were omitted on first wiring; the one
 *  tracked file affected was `vite.config.mts` (1 `.mts`, 0 `.cts` at the time of the fix). */
const PROVENANCE_SRC_EXT_RE = /\.(mjs|cjs|mts|cts|js|jsx|ts|tsx|json|njk|html|css|sh|bash|yml|yaml|py)$/;
/** PROSE dirs — if the index covered them, every false citation would resolve against the sentence that
 *  invented it. This is the same self-resolution failure `stripSourceComments` fixes, one level up. */
const PROVENANCE_PROSE_DIR_RE = /^(backlog|docs|reports|plans|research)\//;
/** TEST files. */
// Exported (not just PROVENANCE-local) because findHashPathCiteOutsideBacklog's own callers need the same
// exclusion: a test fixture's synthetic hash-named-path string literal is not a real citation any more than
// a test's invented identifier is real vocabulary (see isIndexableSourcePath's own header for that identical
// reasoning) — without this, the gate drowns in fixture noise from its own suite.
export const PROVENANCE_TEST_FILE_RE = /(^|\/)(__tests__|__mocks__|__fixtures__)\/|\.(test|spec)\.[A-Za-z]+$/;

/**
 * Is this tracked path part of the tree's VOCABULARY — i.e. should its body feed the resolution index?
 *
 * Lives here rather than inline in `check-standards.mjs` so it is unit-coverable. That is not tidiness: the
 * test-file exclusion below is the single most mutation-fragile line in the gate, and deleting it was caught
 * only by an end-to-end probe, never by a test. A gate whose load-bearing predicate has no unit is a gate
 * that can be silently reverted.
 *
 * TEST FILES ARE NOT THE TREE'S VOCABULARY, and excluding them is load-bearing. A test's whole job is to name
 * things that must NOT exist: this gate's own fixtures carry the string literals 'enforceFlipReady',
 * 'collectOpenItemIds' and 'validateTodoMarkerBlock' precisely because they are the historical false
 * citations. Index them and all three regressions start "resolving" — the gate is neutered by the very suite
 * that proves it works. (Observed on first wiring: a docs page seeded with `enforceFlipReady({ ciStatus })`
 * reported clean because this file had just been written.) A comment's own file is re-indexed locally by the
 * caller, which is what keeps a conformance suite's JSDoc able to cite the helpers defined right below it.
 *
 * @param p a repo-relative tracked path.
 */
export function isIndexableSourcePath(p) {
  return typeof p === 'string' && p !== '' &&
    PROVENANCE_SRC_EXT_RE.test(p) && !PROVENANCE_PROSE_DIR_RE.test(p) && !PROVENANCE_TEST_FILE_RE.test(p);
}

/**
 * Build the resolution index: every identifier-shaped token appearing in the tree's SOURCE CODE.
 *
 * Two exclusions, both load-bearing:
 *   • PROSE DIRS (`backlog/`, `docs/`, `reports/`, …) are excluded by the caller — if the index covered them,
 *     every false citation would resolve against the very sentence that made it up.
 *   • COMMENTS are excluded here (see `stripSourceComments`) — same failure one level down, and it is the
 *     one that actually bit on replay.
 *
 * Tolerant of NUL bytes by construction — three committed scripts carry deliberate NUL sentinels
 * (`guard-bash.mjs`, `renumber-collisions.mjs`, `component-render-build-hook.cjs`) that make plain `grep`
 * silently report nothing on them. This reads with `readFileSync(…, 'utf8')` and matches with a JS regex,
 * both of which treat `\0` as an ordinary character, so those files index normally rather than dropping out.
 *
 * @param texts iterable of source-file bodies.
 * @param opts.stripComments default true; false only for the measurement harness.
 * @returns Set<string> of identifier-shaped tokens.
 */
export function buildIdentifierIndex(texts, { stripComments = true } = {}) {
  const idx = new Set();
  for (const raw of texts || []) {
    if (typeof raw !== 'string') continue;
    const body = stripComments ? stripSourceComments(raw) : raw;
    for (const m of body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) if (isIdentifierShape(m[0])) idx.add(m[0]);
  }
  return idx;
}

// ── Reference RESOLUTION across the constellation (#2821 gate 5, widened) ─────────────────────────
//
// The gates above resolve a reference's CONTAINER. `findDanglingLoci` asks "does the file exist, and is
// the line within it" — a BOUNDS check. It never asks whether the cited line still holds what the prose
// says, so a citation into a file that GROWS stays green forever while pointing at unrelated content:
// `docs/agent/platform-decisions.md` reached 4138 lines and every pre-growth `:NNN` cite in the backlog
// still passes, off by 130–520 lines. That is the largest single staleness class in the corpus (2026-09-06
// audit, we:reports/2026-09-06-open-story-staleness-audit.md).
//
// The four helpers below close that family by resolving a reference's CONTENT, and by resolving the two
// sibling repos the original gate skipped by construction:
//
//   • resolveRepoRef / makeRepoResolver — the shared prefix→checkout resolution, detect-or-skip.
//   • findDanglingSymbolAnchors — the `we:<path>#<symbol>` form gate 5's own error message RECOMMENDS as
//     the drift-immune alternative, which until now had no validator at all: nothing rewarded adopting it
//     and nothing protected you once you had.
//   • findDanglingGraduatedTargets — a resolved item's `graduatedTo` target must exist. Nothing checked
//     this, which is how #2756 landed `resolved` naming a Rust subtree that was never created, and how 93
//     further targets silently rotted through three repo relocations.
//   • findDanglingScopePaths — a LIVE item's `scope:` entries must exist. These are machine-read (the
//     dispatcher plans lane collisions from them), so a stale entry mis-plans dispatch rather than merely
//     misleading a reader.

/** Repo-locus prefix → checkout directory, relative to the WE repo root. */
export const REPO_ROOTS = Object.freeze({
  'we:': '.',
  'webeverything:': '.',
  'fui:': '../frontierui',
  'frontierui:': '../frontierui',
  'plateau:': '../plateau-app',
  'plateau-app:': '../plateau-app',
});

/** Every recognised repo-locus prefix, longest first so `plateau-app:` wins over `plateau:`. */
export const REPO_PREFIXES = Object.freeze(
  Object.keys(REPO_ROOTS).sort((a, b) => b.length - a.length),
);

/**
 * Split a repo-qualified reference into `{ prefix, path }`, or null when it carries no known prefix.
 * A bare path is deliberately NOT resolved — the #883 locus convention requires a prefix, and guessing
 * a repo for an unprefixed path is exactly the basename-guessing that mis-resolves (see the audit's
 * "guard rail that mattered": a bare `conformanceVectors.ts` matched an unrelated file in another repo).
 */
export function splitRepoRef(ref) {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  for (const prefix of REPO_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const path = trimmed.slice(prefix.length).replace(/[.,;)]+$/, '');
    if (path === '') return null;
    // Absolute or `..`-escaping paths are never valid citations and must never reach an fs reader
    // (same posture as findDanglingLoci's isInRepoPath: a traversal target can hang or OOM the gate).
    if (path.startsWith('/') || path.split('/').includes('..')) return null;
    return { prefix, path };
  }
  return null;
}

/**
 * Build the `resolvePath` / `readRepoFile` pair the resolution gates inject, over a caller-supplied fs.
 *
 * DETECT-OR-SKIP, never fail-open: a prefix whose checkout is absent resolves to `'no-repo'`, which every
 * gate below reports as SKIPPED rather than counting as present. This mirrors the existing sibling-repo
 * posture in check-standards.mjs (the FUI block-content arm silently skips without `../frontierui`) and is
 * the rule the audit's own sweep needed: "a gate that cannot see the target must not report the target as
 * present" (#3502 Done-when 2).
 *
 * @param opts.exists  (absPath:string) => boolean
 * @param opts.read    (absPath:string) => string   — may throw for missing/unreadable
 * @param opts.join    (...parts:string[]) => string
 * @param opts.root    the WE repo root.
 * @returns { resolvePath, readRepoFile, repoAvailable }
 */
export function makeRepoResolver({ exists, read, join, root = '.' }) {
  const repoDirCache = new Map();
  const repoAvailable = (prefix) => {
    const rel = REPO_ROOTS[prefix];
    if (rel === undefined) return false;
    if (!repoDirCache.has(prefix)) repoDirCache.set(prefix, exists(join(root, rel)));
    return repoDirCache.get(prefix);
  };
  const resolvePath = (prefix, path) => {
    if (!repoAvailable(prefix)) return 'no-repo';
    return exists(join(root, REPO_ROOTS[prefix], path)) ? 'present' : 'missing';
  };
  const readRepoFile = (prefix, path) => {
    if (!repoAvailable(prefix)) return { status: 'no-repo' };
    const abs = join(root, REPO_ROOTS[prefix], path);
    if (!exists(abs)) return { status: 'missing' };
    try {
      const text = read(abs);
      return typeof text === 'string' ? { status: 'ok', text } : { status: 'unreadable' };
    } catch {
      return { status: 'unreadable' };
    }
  };
  return { resolvePath, readRepoFile, repoAvailable };
}

/**
 * Gate 5b — `we:<path>#<symbol>` anchor resolution (the drift-immune citation form).
 *
 * A symbol anchor is CONTENT-addressed: it survives a file growing, shrinking, or being reformatted,
 * which is precisely what a `:<line>` cite does not. Gate 5's error message has always recommended this
 * form; nothing validated it, so an anchor could name a symbol the file never had and read as rigorous.
 * Resolving it makes the recommendation real — and makes migrating a drifting `:<line>` cite to an anchor
 * a strict improvement rather than a swap of one unchecked form for another.
 *
 * Absent-checkout and unreadable targets are SKIPPED, never errored (detect-or-skip, see makeRepoResolver).
 *
 * @param text the file body (raw).
 * @param opts.readRepoFile (prefix, path) => {status:'ok',text} | {status:'missing'|'no-repo'|'unreadable'}
 * @returns array of `{ locus, prefix, path, symbol, reason }` — 'missing-file' | 'symbol-not-found'.
 */
export function findDanglingSymbolAnchors(text, { readRepoFile }) {
  const findings = [];
  if (typeof text !== 'string' || text === '') return findings;
  // <prefix>:<path with at least one `/`>#<symbol>. The symbol is an identifier-shaped run, so a markdown
  // heading anchor (`docs/x.md#some-heading`, hyphenated) does not match and is left to the anchor gate.
  // The trailing `(?![-\w$])` rejects a hyphenated markdown heading anchor (`x.md#some-heading`), which
  // would otherwise match its first segment (`some`) and be reported as a missing symbol.
  // DERIVED from REPO_PREFIXES, never hand-listed. The first cut spelled the alternation out and omitted
  // `webeverything:` — a prefix `splitRepoRef` and `makeRepoResolver` both accept — so an anchor using it
  // resolved fine everywhere else and was silently never scanned here. Two lists of the same thing drift
  // from the moment they are written; this one now cannot.
  const prefixAlt = REPO_PREFIXES.map((p) => p.slice(0, -1)).join('|');
  const rx = new RegExp(
    String.raw`\b(${prefixAlt}):([A-Za-z0-9._\-/]+\/[A-Za-z0-9._\-]+)#([A-Za-z_$][A-Za-z0-9_$]*)(?![-\w$])`,
    'g',
  );
  const seen = new Set();
  for (const m of text.matchAll(rx)) {
    const [, bare, path, symbol] = m;
    const prefix = `${bare}:`;
    const locus = `${prefix}${path}#${symbol}`;
    if (seen.has(locus)) continue;
    seen.add(locus);
    // `#L123` is a GitHub-style LINE anchor, not a symbol. It is position-based (so it drifts like a
    // `:<line>` cite), but reporting it as "the file contains no `L123`" would be a false claim about
    // a symbol that was never asserted. Out of scope here; gate 5's line-range check is its home.
    if (/^L\d+$/.test(symbol)) continue;
    const split = splitRepoRef(`${prefix}${path}`);
    if (!split) continue; // absolute / traversal — never resolved, never errored
    const res = readRepoFile(prefix, split.path);
    if (res.status === 'no-repo' || res.status === 'unreadable') continue; // skipped, not passed
    if (res.status === 'missing') {
      findings.push({ locus, prefix, path: split.path, symbol, reason: 'missing-file' });
      continue;
    }
    // Word-boundary match so `foo` does not satisfy an anchor naming `fooBar` (or vice versa).
    const hit = new RegExp(`(?:^|[^A-Za-z0-9_$])${symbol.replace(/\$/g, '\\$')}(?:[^A-Za-z0-9_$]|$)`);
    if (!hit.test(res.text)) {
      findings.push({ locus, prefix, path: split.path, symbol, reason: 'symbol-not-found' });
    }
  }
  return findings;
}

/**
 * Gate 5e — relative markdown links (`](../x.md)`, `](x.md#frag)`) must resolve to a file in the tree.
 *
 * `findDanglingSymbolAnchors` only sees `<repo>:<path>#<symbol>`; a bare relative link was never resolved,
 * so a link written as a same-directory target while the file lives elsewhere read as a real cite. Only
 * the FILE is checked — heading fragments are out of scope. Skipped: URLs, `mailto:`, site-absolute `/…`,
 * pure `#frag`, and `<repo>:` refs (gate 5's job). A target escaping the repo root is reported as missing
 * WITHOUT calling `exists`. Backlog→backlog `.md` links that are missing are also WARNed by
 * `findBadBodyLinks`; that overlap is accepted deliberately.
 *
 * @param text the file body (raw).
 * @param opts.fromDir repo-relative posix dir of the file holding the links (e.g. `backlog`).
 * @param opts.exists (repoRelPath) => boolean
 * @returns array of `{ link, resolved, reason: 'missing-file' }`.
 */
export function findDanglingMarkdownLinks(text, { fromDir, exists }) {
  const findings = [];
  if (typeof text !== 'string' || text === '') return findings;
  const prose = text
    .replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\2[`~]*[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const seen = new Set();
  for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const link = m[1];
    if (seen.has(link)) continue;
    seen.add(link);
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(link)) continue; // URL, mailto:, <repo>:, site-absolute, fragment
    let target = link.split('#')[0].split('?')[0];
    if (target === '') continue;
    try { target = decodeURIComponent(target); } catch { /* keep raw */ }
    const parts = [];
    let escapes = false;
    for (const seg of `${fromDir}/${target}`.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length === 0) { escapes = true; break; } parts.pop(); } else parts.push(seg);
    }
    const resolved = parts.join('/');
    if (escapes || !exists(resolved)) findings.push({ link, resolved: escapes ? link : resolved, reason: 'missing-file' });
  }
  return findings;
}

/**
 * Gate 5c — a resolved item's `graduatedTo` target must exist.
 *
 * `graduatedTo` is the one field that asserts something OUTSIDE the item's own diff: *this shipped, and it
 * landed at `<path>`*. Nothing resolved it. That is how #2756 landed `resolved` naming
 * `frontierui:plugs/webdirectives/ssr/rust/` — a directory that does not exist, in a repo with zero `.rs`
 * files — while its two dependents read as ready to build against it. The same blindness let three repo
 * relocations rot 93 further targets without a single gate signal.
 *
 * Only the LEADING entity ref is resolved, matching the canonical-graduatedTo shape the #614 nudge already
 * enforces. A `none`-prefixed value (including `none (… deleted by #NNNN …)`) is a deliberate record that
 * no entity was produced and is skipped — narrative paths later in the string are prose, not the target.
 *
 * @param items backlog items ({ num, status, graduatedTo }).
 * @param opts.resolvePath (prefix, path) => 'present' | 'missing' | 'no-repo'
 * @returns array of `{ num, ref, prefix, path }` for targets that resolve to nothing.
 */
export function findDanglingGraduatedTargets(items, { resolvePath }) {
  const findings = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.status !== 'resolved') continue;
    const raw = it.graduatedTo;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const lead = raw.trim().split(/\s+/)[0];
    if (/^none\b/i.test(lead)) continue;
    // A graduation can name SEVERAL artifacts as one comma-joined leading token (#2210 lists three
    // extension files). Resolve each; one dangling member is a dangling record.
    for (const member of lead.split(',')) {
      // A `{a,b,c}` brace expansion is shorthand for a FAMILY of real files (#1954 names seven njk
      // partials that way). It is not a path any fs call can resolve, and expanding it here would be a
      // second, divergent implementation of shell globbing — skip it.
      if (member.includes('{') || member.includes('}')) continue;
      // A trailing `#fragment` is a DOC ANCHOR (a markdown heading, a template region), not part of the
      // path. The file is what must exist; whether the heading exists is the anchor gate's business.
      const split = splitRepoRef(member.split('#')[0]);
      if (!split) continue; // unprefixed / non-path — the #614 canonical nudge owns that shape
      if (resolvePath(split.prefix, split.path) !== 'missing') continue;
      findings.push({ num: it.num, ref: `${split.prefix}${split.path}`, prefix: split.prefix, path: split.path });
    }
  }
  return findings;
}

// ── Gate 5d (scope: path existence) was DESIGNED, IMPLEMENTED, AND REMOVED — the invariant is unsound.
//
// The motivating defect is real: a six-way split of one test file silently invalidated the `scope:` of
// five open items, and `scope:` is machine-read (the dispatcher plans lane collisions from it), so a stale
// entry mis-plans dispatch rather than merely misleading a reader.
//
// But "a live item's scope entries must exist" is FALSE. A greenfield item legitimately scopes the files
// it is about to CREATE — #2756's own scopeRationale says so explicitly ("stands up a whole new language
// subtree ... a file-level enumeration would under-scope and breach the lease"). Enforced as written, the
// gate fired on #3483, #3484, #3487 and #3323, every one of them a correct card describing work not yet
// done. A gate that reds correct cards gets disabled, not fixed.
//
// The SOUND signal is narrower: an entry that existed at some earlier commit and no longer does (rotted),
// versus one that never existed (planned). That needs real history, and this checkout is a shallow clone,
// so it cannot be computed here. Tracked on the scope-rot card rather than shipped as a noisy heuristic.
