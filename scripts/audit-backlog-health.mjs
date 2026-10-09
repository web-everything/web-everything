#!/usr/bin/env node
/*
 * audit-backlog-health.mjs — the deterministic half of the pre-flight audit.
 *
 * Catches what `check:standards` does NOT: decision-governance gaps and reference
 * drift. It is READ-ONLY — it writes one markdown report and changes no backlog item.
 * The judgment half (guiding-principle conformance, fork-existence, premise-drift)
 * is done by reading agents on top of these flags.
 *
 * Checks (per backlog item):
 *   G1  edge-gap            a real prose prerequisite ("gated on #N", "depends on #N",
 *                           "requires #N", "builds on #N", guarded "blocked on/by #N")
 *                           that is NOT in blockedBy. Lineage ("per"/"ruled by") and
 *                           temporal ("after"/"once") verbs are excluded — they aren't
 *                           gates. Severity↑ if #N is a decision, highest if that decision
 *                           is still open; both-ends-resolved demotes to INFO.
 *   G2  ruling-after-build  a resolved build (non-decision kind) GATED ON (blockedBy) a `decision`
 *                           that resolved AFTER this item — built ahead of its ruling.
 *                           Build order is read from git (the commit flipping
 *                           `status: resolved`), NOT the backfillable `dateResolved`
 *                           frontmatter; items born resolved at their import commit are
 *                           undatable and skipped. `parent` (epic membership) is NOT a
 *                           gating edge, so it does not count here.
 *   G3  ungoverned-arch     a resolved build (non-decision kind) that graduated to a STANDARD
 *                           ENTITY (isEntityGraduation, #1498) but has no
 *                           governing decision reachable — neither in its TRANSITIVE
 *                           parent/blockedBy lineage (an epic-hop up) nor cited in its
 *                           prose (a `#N` resolving to a resolved `type: decision`). The
 *                           plugs class: an architectural call with no governing decision.
 *   G8  unruled-premise      a PREPARED, still-open `decision` whose `## Fork` prose cites another
 *                           `decision` that is itself still OPEN, with no `blockedBy` edge to it. The
 *                           fork's bold default rests on a premise nobody has ratified, and the DAG does
 *                           not encode the ordering — so readiness happily ranks the dependent card
 *                           ahead of the card its argument depends on. CANDIDATE: the citation may be
 *                           mere context; confirm at claim. Clears by adding the `blockedBy` edge, or by
 *                           re-grounding the default on a premise that stands alone.
 *                           (Distinct from G1, which keys on prerequisite VERBS — a fork can lean on an
 *                           unruled sibling without ever saying "blocked on".)
 *   G4  false-prepared-fork a `type: decision` carrying `preparedDate` whose `## Fork` sections
 *                           contain prioritization/effort tells ("premature", "no second/other consumer",
 *                           "no consumer need", "not broken … but", "more to build/maintain",
 *                           "avoids the drift/maintenance of B", "keep … in sync", "cheaper/expensive") — the
 *                           fork-existence test was skipped at prep, so the stamp is false. CANDIDATE:
 *                           the claim-time re-run confirms; collapsing to the #088 shape clears it.
 *   G5  missing-fork-existence-justification a `type: decision` carrying `preparedDate` with a `## Fork`
 *                           section that names NO excluded/flawed branch and gives no reason the
 *                           coherent branches can't coexist (#819). CANDIDATE: the justification line
 *                           was likely skipped at prep; confirm at claim, then add it or dissolve the fork.
 *   G6  codification-gap     a resolved `type: decision` with no `codifiedIn` — its rule may live only
 *                           in the case file. CANDIDATE: promote it to the statute layer (a guideline
 *                           with `codifiedIn` set) or mark `one-off`. Legacy catch-up only — the resolve
 *                           gate (backlog.mjs) blocks new decisions from landing here.
 *   G7  cite-the-case       a LIVE (non-resolved) work item cites a CODIFIED decision's `#N` but not its
 *                           statute anchor — the reader is sent into a deliberation when a named rule
 *                           exists. Resolved items are frozen history (lineage cites are correct) and are
 *                           NOT flagged. CANDIDATE: re-point to `platform-decisions.md#<anchor>`; keep `#N`
 *                           only for true lineage ("supersedes #N").
 *   A1  missing-done-when   an OPEN, non-decision item with no `## Acceptance` (or legacy-alias) heading,
 *                           or one with no backticked path/command-shaped token and no explicit
 *                           exemption phrase ("doc-only", "design judgment", "no tier-1") — #2949's
 *                           determinism-ladder rule (docs/agent/backlog-workflow.md) has nothing to
 *                           check against. CANDIDATE: a hit is a card to add a tier-1/2 criterion to,
 *                           or exempt, never a verdict.
 *   D1  dead-file-ref       a backticked code path (…/x.ts[:NN]) that doesn't exist — after
 *                           resolving slash-joined enumerations + bare suffixes against a dir
 *                           named in the same section, and suppressing paths prose marks as
 *                           absent ("no `x`"), planned ("a page at `x`"), or generated ("writes `x`").
 *   D2  dangling-item-ref   a #N referenced in the body with no backlog/N-*.md.
 *   D3  stale-project       PER PROJECT: a relatedProject absent from projects.json, or one still
 *                           `concept` despite substantial shipped work (intentionally-pending
 *                           concept projects with little resolved work are excluded).
 *
 * Usage: node scripts/audit-backlog-health.mjs [--json] [--scope=<session>|--mine=<session>]
 *
 * `--scope=<session>` (alias `--mine=`) attributes the flags by OWNING ITEM ID against the session's
 * claimed ids (`.claude/skills/batch-backlog-items/claims.json`, the #952 claim baseline now stamps owning
 * ids): a finding on an item THIS session claimed stays in the primary view; a concurrent/pre-existing
 * finding demotes to a non-failing note count. A finding with no owning id (D3, project-keyed) is
 * unattributable and stays in scope (fail-safe). Mirrors `check:standards --scope` (#952/#949) on the id
 * axis. The default no-flag run is unchanged — whole-backlog (#957).
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseClaims, claimedIdsFor, partitionById } from './readiness/claimScope.mjs';
import { loadDataRegistry } from './lib/registry-loader.cjs';
import { isExecKind, isEntityGraduation } from './check-standards-rules.mjs';
import { idFromName, isNum } from './backlog/id.mjs';
import { localToday } from './lib/local-date.mjs';
import { ACCEPTANCE_HEADING_RE } from './backlog/task-agreement.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BL = join(ROOT, 'backlog');
const REPORT = join(ROOT, 'audits', 'backlog-health-audit.md');  // outside reports/ — regenerable tool output, not a /research/ deliverable
const SIBLINGS = { 'frontierui/': '../frontierui/', 'plateau-app/': '../plateau-app/' };
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|json|njk|css|html|md)(:\d+)?$/;

// ---- parse ---------------------------------------------------------------
function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = {}; if (!m) return { fm, body: src };
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^(\w+):\s*(.*)$/); if (!mm) continue;
    let [, k, v] = mm; v = v.trim();
    if (v.startsWith('[')) fm[k] = [...v.matchAll(/"?(\d+)"?/g)].map(x => x[1]);
    else fm[k] = v.replace(/^["']|["']$/g, '');
  }
  return { fm, body: src.slice(m[0].length) };
}
const norm = s => (s == null ? s : String(parseInt(s, 10)));      // strip leading zeros: "064" -> "64"
const num = f => { const t = idFromName(f); return isNum(t) ? norm(t) : t; }; // two-form id (#2288): normalize numeric, leave a hash

const items = new Map();          // id -> {id, file, type, status, fm, body} — filled by loadItems() in main()
function loadItems() {
  const files = readdirSync(BL).filter(f => f.endsWith('.md') && idFromName(f));
  for (const f of files) {
    const src = readFileSync(join(BL, f), 'utf8');
    const { fm, body } = parseFrontmatter(src);
    // Items declare their type via `kind:` (the `type:` field was renamed in the kind-axis migration);
    // fall back to `type` for any legacy item. Without this, every `it.type === 'decision'` gate
    // (G3–G7) and the exec gate silently never fire — the whole decision-governance audit goes dead.
    items.set(num(f), { id: num(f), file: f, fm, body, type: fm.kind ?? fm.type, status: fm.status });
  }
}

// ---- ref extractors ------------------------------------------------------
// Keep only verbs that assert a real build prerequisite. Dropped (per #613): `per`/`ruled by`
// (lineage citation, not a gate) and `after`/`once` (temporal/prioritization ordering, not a
// dependency). `blocked on/by` is kept but guarded below (an adjacent #M to its left = an
// enumeration/citation, not a fresh edge). Group 1 is the verb (for the guard), group 2 the id.
// Export the live matchers for regression tests; keep the right boundary to reject numeric prefixes.
export const PROSE_PREREQ = /\b(gated on|blocked on|blocked by|depends on|needs|requires|premise[d]? on|consumed via|builds on)\s+#?(\d+)\b/gi;
export const ANY_REF = /(?:#|\/backlog\/)(\d+)\b/g;
const BACKTICK = /`([^`]+)`/g;

// G4 false-prepared-fork — prioritization/effort smuggled into a `## Fork` section of a *prepared*
// decision. The checklist (backlog-workflow.md → fork-is-not-prioritization / fork-existence test)
// forbids cost/sequencing as a branch; these phrases are the tells that a "fork" is really
// "support all + a prioritization call" and the `preparedDate` stamp skipped the fork-existence test.
// CANDIDATE class (like G3): a hit is a card to re-run the test on at claim time, not a verdict.
const FORK_TELLS = [
  /\bpremature(ly)?\b/i,
  /\bsequencing,?\s+not\s+exclusion\b/i,
  /\bno\s+(?:second|other)\s+consumer\b/i,
  /\bno\s+consumer\s+(?:need|for|that)\b/i,                          // "no consumer need" (#1457 — search, don't assert)
  /\b(?:more|extra|a\s+second|another)\s+(?:to\s+)?(?:build|maintain|entry|entries|schema|feed|manifest|artifact|surface)\b/i,
  /\bavoids?\b[^.]*\b(?:cost|maintenance|overhead|drift|surface)\b/i, // "avoids the drift surface / maintenance of B" — cost as merit
  /\bkeep\b[^.]*\bin\s+sync\b/i,                                     // "another manifest to keep in sync"
  /\bnot\s+broken\b[^.]*\bbut\b/i,        // "Not broken — … but premature/expensive"
  /\b(?:too\s+)?expensive\b/i,
  /\bcheaper\b/i,
  /\b(?:defer|deferring|carve)\b[^.]*\b(?:now|v1|for now|until)\b/i,
];

// G5 missing-fork-existence-justification — a `## Fork` of a *prepared* decision must carry the
// one-line fork-existence justification #819 requires: name the flawed/excluded branch (forced
// invariant) or say why the coherent branches cannot coexist (real either/or). These markers are the
// canonical phrasings the prepared-fork shape prescribes; a fork section matching NONE of them is a
// CANDIDATE that the justification line was skipped at prep (the #811 miss). Like G4, a hit is a card
// to re-run the fork-existence test on, not a verdict.
const FORK_EXISTENCE_MARKERS = [
  /fork[- ]existence/i,
  /\b(?:flawed|excluded|broken|rejected)\s+branch\b/i,
  /\bcan(?:no|')?t\s+coexist\b/i,
  /\bcannot\s+coexist\b/i,
  /\bmutually[- ]exclusive\b/i,
  /\beither\/or\b/i,
  /\bforced\s+invariant\b/i,
  /^\s*[-*]?\s*\*?Rejected\*?\b/im,   // a "Rejected: …" line names the excluded branch
];

// shorthand prefixes cards use for SoT include dirs
const SHORTHAND = ['block-descriptions/', 'plug-descriptions/', 'intent-descriptions/', 'adapter-descriptions/', 'research-descriptions/', 'protocol-descriptions/'];
// a backticked token that looks like a usable code path (has a dir + known extension, no glob/placeholder)
function isPathToken(t) {
  if (!t.includes('/') || !CODE_EXT.test(t)) return false;
  if (t.includes('{') || t.includes('}') || t.includes('*') || t.includes('<')) return false;
  return true;
}
// repo-locus prefixes (#883/#884 convention) → the repo root the path resolves against.
const LOCUS_ROOTS = { we: ROOT, webeverything: ROOT, fui: '../frontierui', frontierui: '../frontierui', plateau: '../plateau-app', 'plateau-app': '../plateau-app' };
function resolveRef(p) {
  const path = p.replace(/:\d+$/, '');
  // A `we:`/`fui:`/`plateau-app:` locus prefix (#883) names the owning repo — strip it and resolve there.
  const locus = path.match(/^([a-z][a-z-]*):(.+)$/);
  if (locus && Object.prototype.hasOwnProperty.call(LOCUS_ROOTS, locus[1])) {
    const root = LOCUS_ROOTS[locus[1]];
    return existsSync(root === ROOT ? join(ROOT, locus[2]) : join(ROOT, root, locus[2]));
  }
  const tries = [join(ROOT, path)];
  if (path.startsWith('../')) return existsSync(join(ROOT, path));
  for (const [pre, sib] of Object.entries(SIBLINGS))
    if (path.startsWith(pre)) tries.push(join(ROOT, sib, path.slice(pre.length)));
  for (const sh of SHORTHAND) if (path.startsWith(sh)) tries.push(join(ROOT, 'src/_includes', path));
  // bare blocks//plugs//demos/ may live in the FUI reference impl
  if (/^(blocks|plugs|demos)\//.test(path)) tries.push(join(ROOT, '../frontierui', path));
  return tries.some(existsSync);
}
const isDecision = id => items.get(id)?.type === 'decision';

// ---- D1 precision (per #613): resolution gaps + prose suppression ---------
// A backticked path that doesn't resolve verbatim is only a *dead* ref if it also (a) isn't a
// slash-joined enumeration of real files, (b) isn't a bare suffix of a dir named in its own
// section, and (c) isn't governed by prose that marks it absent / planned / generated.

// (resolution gap 1) a slash-joined name enumeration — `blocks/intents/plugs/protocols/projects.json`
// is five real `src/_data/*.json`, not one path. True only if every segment names an existing file.
function resolvesAsEnumeration(p) {
  const segs = p.replace(/:\d+$/, '').split('/');
  if (segs.length < 3) return false;                       // need a real enumeration, not a 2-deep path
  const last = segs[segs.length - 1];
  const dot = last.lastIndexOf('.'); if (dot < 0) return false;
  const ext = last.slice(dot);                             // ".json"
  const names = [...segs.slice(0, -1), last.slice(0, dot)];
  if (names.some(n => !/^[a-z][\w-]*$/i.test(n))) return false;   // each segment a bare identifier
  return names.every(n => existsSync(join(ROOT, 'src/_data', n + ext)));
}
// (resolution gap 2) a bare suffix resolved against a directory named in the same section —
// `adapters/eslint.mjs` under a section that says `scripts/validation-normalize/knowledge.mjs`.
function resolvesAgainstDir(p, dirSet) {
  for (const d of dirSet) {
    if (p.startsWith(d)) continue;                         // already rooted there → no synthetic join
    if (resolveRef(d + p)) return true;
  }
  return false;
}
// directory prefixes named (as backticked paths or bare `dir/` tokens) inside a chunk of prose
function dirsIn(text) {
  const out = new Set();
  for (const [, tok] of text.matchAll(BACKTICK)) {
    let t = tok.trim().split(/\s+/)[0].replace(/^\.\//, '');
    if (t.includes('{') || t.includes('*') || t.includes('<')) continue;
    if (/\/$/.test(t)) { out.add(t); continue; }           // bare dir token, e.g. `frontierui/plugs/`
    if (t.includes('/') && CODE_EXT.test(t)) { const dir = t.replace(/[^/]+$/, ''); if (dir) out.add(dir); }
  }
  return out;
}
// split the body into heading-delimited sections, each carrying the dir prefixes named within it
function sectionRanges(body) {
  const heads = [0];
  for (const m of body.matchAll(/^#{1,6}\s.*$/gm)) heads.push(m.index);
  heads.push(body.length);
  const bounds = [...new Set(heads)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++)
    out.push({ start: bounds[i], end: bounds[i + 1], dirs: dirsIn(body.slice(bounds[i], bounds[i + 1])) });
  return out;
}
const dirsAtOffset = (ranges, idx) => (ranges.find(r => idx >= r.start && idx < r.end) || { dirs: new Set() }).dirs;
// prose immediately to the left of the path governs it as absent / planned / generated, not claimed-existing
function suppressionReason(lead) {
  const t = lead.toLowerCase().replace(/[^\w]+$/, '');     // drop trailing whitespace/emphasis (`**`, etc.)
  if (/(?:^|\W)(?:no|not|never|without|absent|lacks?|missing|none)$/.test(t)) return 'absence';
  if (/(?:^|\W)(?:writes?|wrote|written|emits?|emitted|generates?|generated|produces?|produced|outputs?|output|renders?|rendered|dumps?)$/.test(t)) return 'generated';
  if (/(?:^|\W)(?:page|file|module|script|demo|playground|report|stylesheet|template|doc|fixture|entry|component|route)s?\s+(?:at|in|under)$/.test(t)) return 'planned';
  if (/(?:^|\W)(?:creates?|authors?|scaffolds?|builds?|adds?|introduces?|stands? up|lives? at)$/.test(t)) return 'planned';
  return null;
}
// the dead backticked code refs in an item's body, after resolution gaps + prose suppression
function deadFileRefs(it) {
  const ranges = sectionRanges(it.body);
  const dead = new Set();
  for (const m of it.body.matchAll(BACKTICK)) {
    const t = m[1].trim().split(/\s+/)[0];
    if (!isPathToken(t)) continue;
    if (resolveRef(t) || resolvesAsEnumeration(t) || resolvesAgainstDir(t, dirsAtOffset(ranges, m.index))) continue;
    if (suppressionReason(it.body.slice(Math.max(0, m.index - 60), m.index))) continue;
    dead.add(t);
  }
  return [...dead];
}

// A1 missing-done-when-proof — an OPEN, non-decision item (isExecKind) whose body has no acceptance
// heading (the shared task-agreement reader's `ACCEPTANCE_HEADING_RE`: `## Acceptance` or its legacy alias), OR has one with no backticked, path/command-shaped
// token (reusing BACKTICK + isPathToken, the same D1 uses to decide a citation "looks real") and no
// explicit exemption phrase ("doc-only", "design judgment", "no tier-1"). CANDIDATE, like G3/G4/G5 — a
// hit is a card to add a tier-1/2 criterion to, or exempt, never a verdict.
const EXEMPTION_PHRASE = /\b(doc-only|design judgment|no tier-1)\b/i;
export function missingDoneWhenProof(it) {
  const body = it?.body || '';
  const sections = sectionRanges(body).filter((r) => {
    const head = body.slice(r.start, r.end).match(/^#{1,6}\s+(.*)$/m)?.[1] || '';
    return ACCEPTANCE_HEADING_RE.test(head.trim());
  });
  if (!sections.length) return { hit: true, reason: 'no-section' };
  for (const r of sections) {
    const sec = body.slice(r.start, r.end);
    const hasToken = [...sec.matchAll(BACKTICK)].some((m) => isPathToken(m[1].trim().split(/\s+/)[0]));
    if (hasToken || EXEMPTION_PHRASE.test(sec)) return { hit: false, reason: null };
  }
  return { hit: true, reason: 'no-executable-token' };
}

// ---- git-derived resolution dates (G2 must not trust backfilled frontmatter) ----
// `dateResolved` is hand-stamped and was bulk-backfilled for early-era items, so two
// such dates can't establish build order. Instead read *when* an item actually flipped
// to `status: resolved` from git, and treat items that were born resolved (added already
// resolved — no flip commit distinct from the add) as undatable: their date is an import
// artifact, never a real ruling timeline.
let REPO_FIRST_COMMIT = null;     // set by main() — reading git at import time would make the import a side effect
function readRepoFirstCommit() {
  try { return execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT }).toString().trim().split('\n').pop(); } catch { return null; /* no git */ }
}
// #x7xv2xt — TWO whole-directory history passes, built once on first use, instead of two full-history
// `git log -- backlog/<file>` walks PER gated item (~0.7s each; hundreds of items made the audit take ~10 min).
// `--no-renames` keeps a move inside backlog/ reading as an add, exactly as the old single-path log saw it (a
// single-path log cannot pair the rename's other side, so it reported `A`).
//   flipBy: file → "<hash>|<iso>" of the NEWEST commit whose diff of that file matches `^status:.*resolved`
//   addBy:  file → hash of the OLDEST commit that added it
let gitMaps = null;
function historyByFile(args, keepFirst) {
  const out = execFileSync('git', ['-c', 'core.quotePath=false', 'log', '--no-renames', ...args, '--name-only', '--', 'backlog/'],
    { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString();
  const map = new Map();
  let commit = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('@')) { commit = line.slice(1); continue; }
    if (!line || !commit || !line.startsWith('backlog/')) continue;
    const file = line.slice('backlog/'.length);
    if (keepFirst && map.has(file)) continue;   // log is newest-first: keep the first sighting (newest)
    map.set(file, commit);                      // …or overwrite, leaving the last sighting (oldest)
  }
  return map;
}
function loadGitMaps() {
  try {
    return {
      flipBy: historyByFile(['--format=@%H|%cI', '-G', '^status:.*resolved'], true),
      addBy: historyByFile(['--diff-filter=A', '--format=@%H'], false),
    };
  } catch { return { flipBy: new Map(), addBy: new Map() }; /* no git — everything reads undatable */ }
}
function gitResolvedAt(file) {            // -> { date: ISO|null, undatable: bool }
  if (!gitMaps) gitMaps = loadGitMaps();
  const flip = gitMaps.flipBy.get(file);
  const add = gitMaps.addBy.get(file);   // earliest add commit
  if (!flip) return { date: null, undatable: true };
  const [hash, iso] = flip.split('|');
  const bornResolved = hash === add;             // added already resolved → no real flip
  const imported = add && add === REPO_FIRST_COMMIT;
  return { date: iso, undatable: bornResolved || imported };
}

// G3: the full governing lineage is the transitive closure over parent + blockedBy edges
// (a decision may sit an epic-hop up), not just the item's own two fields.
function transitiveLineage(it) {
  const seen = new Set();
  const stack = [...(it.fm.blockedBy || []).map(norm), norm(it.fm.parent)].filter(Boolean);
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !items.has(id)) continue;
    seen.add(id);
    const anc = items.get(id);
    for (const e of [...(anc.fm.blockedBy || []).map(norm), norm(anc.fm.parent)]) if (e) stack.push(e);
  }
  return seen;
}
// a body `#N` / `/backlog/N` that resolves to a *resolved* type:decision = a governing ruling cited in prose
function citesResolvedDecision(it) {
  for (const [, p] of it.body.matchAll(ANY_REF)) {
    const d = items.get(norm(p));
    if (d && d.type === 'decision' && d.status === 'resolved' && norm(p) !== it.id) return true;
  }
  return false;
}

// G7 cite-the-case-not-the-rule — a body `#N` that resolves to a CODIFIED decision (its rule already
// lives in the statute layer, `codifiedIn` set and ≠ `one-off`) while the body does NOT cite that
// decision's statute anchor. The reader is pointed into a deliberation when a named, stable rule
// exists — the orientation should propagate, not the case number. Returns the distinct {ref, anchor}
// pairs to nudge. A genuine lineage cite ("supersedes #N") is a tolerated false positive — this is a
// CANDIDATE pool (like G3/G6), a card to re-point-or-keep, never a hard gate.
// #1571 — ordinal/list-index false positives the G7 cite-the-rule heuristic must NOT flag: a `#N` that is
// really an intra-card ordinal ("Fix #2", "feature #6"), a `/`-joined enumeration ("#9/#10", "#12/#13/#15"),
// or a leading-zero legacy/lineage cite ("from #011" — `norm` collides it onto a small decision). Citing the
// *case* is correct for these; only a standalone reference to the decision itself is a cite-the-rule nudge.
// Irreducible lineage cites that don't match these shapes are left documented (a tolerated residue).
const G7_ORDINAL_WORD = /\b(?:acceptance|fix(?:e[sd])?|step|phase|gap|criteri(?:on|a)|feature|idea|fork|option|q|dc)\.?\s*$/i;
function isOrdinalOrListRef(body, m) {
  if (/^0/.test(m[1])) return true;                                   // leading-zero legacy/lineage cite (#011)
  const before = body.slice(Math.max(0, m.index - 24), m.index);
  const after = body.slice(m.index + m[0].length, m.index + m[0].length + 2);
  if (G7_ORDINAL_WORD.test(before)) return true;                      // "Fix #2", "feature #6"
  if (/\/\s*$/.test(before) || /^\s*\//.test(after)) return true;     // part of a #N/#M list run
  return false;
}
function citesCodifiedCase(it) {
  const out = new Map();
  for (const m of it.body.matchAll(ANY_REF)) {
    const id = norm(m[1]);
    if (id === it.id) continue;
    const d = items.get(id);
    const anchor = d && d.type === 'decision' && d.status === 'resolved' ? d.fm.codifiedIn : undefined;
    if (!anchor || anchor === 'one-off') continue;
    if (it.body.includes(anchor)) continue; // already cites the statute alongside the case — fine
    if (isOrdinalOrListRef(it.body, m)) continue; // #1571 ordinal/list/lineage — not a cite-the-rule nudge
    out.set(id, { ref: id, anchor });
  }
  return [...out.values()];
}

// ---- project liveness ----------------------------------------------------
const projects = new Map();      // filled by loadProjects() in main()
function loadProjects() {
  try {
    // per-project specs src/_data/projects/<id>.json, assembled (#1157)
    for (const p of loadDataRegistry('projects')) if (p && p.id) projects.set(p.id, p.status || '?');
  } catch { /* ignore */ }
}

// ---- run checks ----------------------------------------------------------

/**
 * G8 unruled-premise — the PURE decision, exported so it is unit-testable without a tree (#2949's shape).
 *
 * A prepared decision's `## Fork` prose may cite another decision as the ground its bold default stands on.
 * If that cited decision is itself still open AND no `blockedBy` edge records the dependency, the default
 * rests on an unratified premise while the DAG stays silent — so readiness can rank the dependent card ahead
 * of the card its argument depends on. Scoped to `## Fork` sections deliberately: a citation in Context or
 * Grounding is background, not the default leaning on it.
 *
 * @param {string} body - the item's markdown body.
 * @param {Set<string>} blocked - normalized ids already on this item's `blockedBy`.
 * @param {(id: string) => boolean} isOpenDecision - true when `id` is a still-open `decision`.
 * @param {(b: string) => Array<{start:number,end:number}>} ranges - section splitter.
 * @param {(id: string) => string} normId - id normalizer.
 * @returns {string[]} cited open-decision ids the forks lean on, with no edge.
 */
export function forkLeansOnUnruled(body, blocked, isOpenDecision, ranges, normId) {
  const leans = new Set();
  for (const r of ranges(body)) {
    const head = body.slice(r.start, r.end).match(/^#{1,6}\s+(.*)$/m)?.[1] || '';
    if (!/^fork\b/i.test(head.trim())) continue;
    for (const m of body.slice(r.start, r.end).matchAll(/#(\d+)\b/g)) {
      const ref = normId(m[1]);
      if (blocked.has(ref)) continue;
      if (isOpenDecision(ref)) leans.add(ref);
    }
  }
  return [...leans];
}

// ---- the audit itself — runs only as a CLI --------------------------------
// #x7xv2xt: everything below used to run at import time, so a test importing one pure helper ran the whole
// audit (git history walks per gated item, the full backlog read) and rewrote the report. It now runs only
// when this file is the entry point; importing it has no side effects.
function main() {
  loadItems();
  loadProjects();
  REPO_FIRST_COMMIT = readRepoFirstCommit();

  const flags = { G1: [], G2: [], G3: [], G4: [], G5: [], G6: [], G7: [], G8: [], A1: [], O1: [], D1: [], D2: [], D3: [] };
  const TODAY = localToday(); // for the O1 born-active-orphan TTL (#670)
  for (const it of items.values()) {
    const blocked = new Set((it.fm.blockedBy || []).map(norm));
    const isExec = isExecKind(it.type);

    // G1 edge-gap — a real prose prerequisite (filtered verb set) not lifted into blockedBy.
    const g1seen = new Set();
    for (const m of it.body.matchAll(PROSE_PREREQ)) {
      const kw = m[1].toLowerCase(), p = norm(m[2]);
      if (p === it.id || blocked.has(p) || !items.has(p) || g1seen.has(p)) continue;
      // `blocked on/by` guard: another #M within ~40 chars to its left = a citation/enumeration
      // ("blocked by #M, #N"), already-anchored — not a fresh ungoverned edge.
      if (kw.startsWith('blocked') && /#\d+\b/.test(it.body.slice(Math.max(0, m.index - 40), m.index))) continue;
      g1seen.add(p);
      const dec = isDecision(p), open = items.get(p)?.status !== 'resolved';
      // both ends resolved → historical lineage, not a live gap: demote to INFO (suppressed from the count).
      const sev = (it.status === 'resolved' && !open) ? 'INFO' : dec && open ? 'HIGH' : dec ? 'med' : 'low';
      flags.G1.push({ id: it.id, ref: p, decision: dec, refOpen: open, sev, title: title(it) });
    }
    // G2 ruling-after-build — a resolved build GATED ON (blockedBy) a decision that resolved
    // after it. `parent` is epic membership, not a gating edge, so it is excluded. Build order
    // comes from git (the resolve-flip commit), and undatable (import-born) endpoints are skipped.
    const gatingEdges = [...new Set((it.fm.blockedBy || []).map(norm).filter(Boolean))];
    if (isExec && it.status === 'resolved') {
      for (const p of gatingEdges) {
        if (!isDecision(p)) continue;
        const d = items.get(p);
        if (d.status !== 'resolved') { flags.G2.push({ id: it.id, ref: p, why: 'governing decision still open', title: title(it) }); continue; }
        const di = gitResolvedAt(d.file), ii = gitResolvedAt(it.file);
        if (di.undatable || ii.undatable) continue;                  // import artifact — order unknowable
        if (di.date > ii.date) flags.G2.push({ id: it.id, ref: p, why: `decision resolved ${di.date.slice(0, 10)} (git) > item ${ii.date.slice(0, 10)}`, title: title(it) });
      }
    }
    // G3 ungoverned-arch — CANDIDATE POOL (judgment confirms): graduated build with no governing
    // decision reachable transitively (parent/blockedBy closure) AND none cited in its prose.
    if (isExec && it.status === 'resolved' && isEntityGraduation(it.fm.graduatedTo)
        && ![...transitiveLineage(it)].some(isDecision) && !citesResolvedDecision(it))
      flags.G3.push({ id: it.id, graduatedTo: it.fm.graduatedTo, title: title(it) });
    // G4 false-prepared-fork — a PREPARED, still-open decision whose `## Fork` sections carry
    // prioritization/effort tells (forbidden as branches). CANDIDATE: the claim-time fork-existence
    // re-run confirms; collapsing the fork to the #088 shape (invariant + supported/deferred list)
    // clears it. Resolved decisions are historical — skipped.
    if (it.type === 'decision' && it.fm.preparedDate && it.status !== 'resolved') {
      const hits = new Set();
      for (const r of sectionRanges(it.body)) {
        const head = it.body.slice(r.start, r.end).match(/^#{1,6}\s+(.*)$/m)?.[1] || '';
        if (!/^fork\b/i.test(head.trim())) continue;
        const sec = it.body.slice(r.start, r.end);
        for (const re of FORK_TELLS) { const m = sec.match(re); if (m) hits.add(m[0].replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50).toLowerCase()); }
      }
      if (hits.size) flags.G4.push({ id: it.id, tells: [...hits].slice(0, 4), title: title(it) });
    }
    // G8 unruled-premise — see `forkLeansOnUnruled` above for the rule and why it is scoped to forks.
    // CANDIDATE: a citation may be context rather than ground; confirm at claim.
    if (it.type === 'decision' && it.fm.preparedDate && it.status !== 'resolved') {
      const leans = forkLeansOnUnruled(
        it.body, blocked,
        (ref) => ref !== it.id && items.get(ref)?.type === 'decision' && items.get(ref)?.status !== 'resolved',
        sectionRanges, norm,
      );
      if (leans.length) flags.G8.push({ id: it.id, refs: leans.slice(0, 4), title: title(it) });
    }
    // G5 missing-fork-existence-justification — a PREPARED, still-open decision with a `## Fork`
    // section carrying NONE of the fork-existence markers (#819). CANDIDATE: the line may use other
    // wording; confirm at claim before dissolving the fork or amending its prep.
    if (it.type === 'decision' && it.fm.preparedDate && it.status !== 'resolved') {
      const bare = [];
      for (const r of sectionRanges(it.body)) {
        const head = it.body.slice(r.start, r.end).match(/^#{1,6}\s+(.*)$/m)?.[1] || '';
        if (!/^fork\b/i.test(head.trim())) continue;
        const sec = it.body.slice(r.start, r.end);
        if (!FORK_EXISTENCE_MARKERS.some(re => re.test(sec))) bare.push(head.trim().slice(0, 40));
      }
      if (bare.length) flags.G5.push({ id: it.id, forks: bare.slice(0, 4), title: title(it) });
    }
    // G6 codification-gap — a resolved `type: decision` with no `codifiedIn` pointer. Its ruling may
    // live ONLY in this decision doc (case-law-only); if it states a reusable rule it should be promoted
    // to the statute layer (platform-decisions.md or a topical doc) with `codifiedIn` set, else marked
    // `codifiedIn: one-off`. CANDIDATE pool (like G3/G4): a hit is a card to promote-or-mark, never a
    // hard failure. The count is the uncodified backlog (64% case-law-only at the 2026-06-18 sweep) and
    // should shrink, not grow silently. See backlog-workflow.md → resolve step, and docs/agent/platform-decisions.md.
    if (it.type === 'decision' && it.status === 'resolved' && !it.fm.codifiedIn)
      flags.G6.push({ id: it.id, title: title(it) });

    // G7 cite-the-case-not-the-rule — a LIVE item cites a codified decision's `#N` but not its statute
    // anchor; re-point to platform-decisions.md#<anchor> so the rule, not the case, is what propagates.
    // Scoped to non-resolved items: "cite the rule" is *authoring* guidance, and a resolved item is frozen
    // history whose lineage `#N` cites are correct archaeology (473/550 at the 2026-06-19 sweep were resolved).
    if (it.status !== 'resolved') {
      const stale = citesCodifiedCase(it);
      if (stale.length) flags.G7.push({ id: it.id, refs: stale.slice(0, 4), title: title(it) });
    }
    // A1 missing-done-when-proof (#2949) — OPEN, non-decision items only: a resolved item is frozen
    // history and a decision has no build to prove. See `missingDoneWhenProof` above for the rule.
    if (it.status === 'open' && isExec) {
      const proof = missingDoneWhenProof(it);
      if (proof.hit) flags.A1.push({ id: it.id, reason: proof.reason, title: title(it) });
    }
    // D1 dead-file-ref — OPEN items only (resolved items' refs are historical by design).
    // deadFileRefs applies the #613 resolution gaps + prose suppression (absence / planned / generated).
    if (it.status !== 'resolved')
      for (const r of deadFileRefs(it)) flags.D1.push({ id: it.id, ref: r, title: title(it) });
    // D2 dangling-item-ref — OPEN items only
    if (it.status !== 'resolved')
      for (const [, p] of it.body.matchAll(ANY_REF)) if (!items.has(norm(p))) { flags.D2.push({ id: it.id, ref: norm(p), title: title(it) }); break; }
    // O1 orphan-born-active (#670) — a `scaffold --session` item is born `active` + `scaffoldedBy`, owned
    // until `settle`d. If it lingers past its creating day (dateScaffolded < today) it is a likely stranded
    // scaffold (a crashed/abandoned session): invisible to other batches yet never published. Recover by
    // `settle <NNN>` (publish) or revert to open. A born-active item has NO `dateStarted` (claim signal),
    // which is what distinguishes it from a normally-claimed active item.
    if (it.status === 'active' && it.fm.scaffoldedBy && !it.fm.dateStarted && it.fm.dateScaffolded && it.fm.dateScaffolded < TODAY)
      flags.O1.push({ id: it.id, by: it.fm.scaffoldedBy, since: it.fm.dateScaffolded, title: title(it) });
    // D3 is aggregated PER PROJECT after the loop (per #613), not per item.
  }

  // G3 subject-dedup (#1558) — the kind gate now counts every non-decision kind incl. epic (#1473), so when
  // an epic and a child both graduate to the SAME entity noun (e.g. #436↔#351 `project:webcompliance`) G3
  // double-counts the one architectural noun. The fix is subject-axis and NOUN-level (a `graduatedTo` can list
  // several `+`-joined nouns): drop a G3 candidate only when EVERY entity noun it declares is already covered
  // by a G3-candidate ANCESTOR (transitive parent/blockedBy closure) — the umbrella. A child that introduces
  // any noun the umbrella lacks (e.g. #629 adds `protocol:editor-engine`/`plug:…` atop `project:webediting`)
  // keeps its flag for those unique nouns. (Item-level whole-string compare would mis-handle a compound
  // umbrella + single-noun child; noun-set coverage is the robust form.)
  {
    const g3ById = new Map(flags.G3.map((f) => [f.id, f]));
    const entityNouns = (g) =>
      String(g).split('+').map((s) => s.trim().toLowerCase()).filter((s) => isEntityGraduation(s));
    flags.G3 = flags.G3.filter((f) => {
      const own = entityNouns(f.graduatedTo);
      if (!own.length) return true;
      const covered = new Set();
      for (const anc of transitiveLineage(items.get(f.id))) {
        const a = g3ById.get(anc);
        if (a) for (const n of entityNouns(a.graduatedTo)) covered.add(n);
      }
      return !own.every((n) => covered.has(n)); // drop only if the umbrella covers every noun
    });
  }

  // D3 stale-project — aggregated PER PROJECT, not per item (per #613). A `relatedProject` that is
  // absent from projects.json is a dangling ref; a project still `status: concept` despite substantial
  // shipped work (≥ STALE_RESOLVED_MIN resolved items) is stale drift whose status should advance. A
  // concept project with little/no resolved work is *intentionally pending* (e.g. `webplugs` pending
  // the #606 ruling, `webcases` too thin to graduate) and is NOT flagged — the false-positive class the
  // old per-item check produced 18 of.
  const STALE_RESOLVED_MIN = 5;
  const projAgg = new Map();              // relatedProject -> {resolved, graduated, total}
  for (const it of items.values()) {
    const rp = it.fm.relatedProject; if (!rp) continue;
    const a = projAgg.get(rp) || { resolved: 0, graduated: 0, total: 0 };
    a.total++;
    if (it.status === 'resolved') a.resolved++;
    if (it.fm.graduatedTo && it.fm.graduatedTo !== 'none') a.graduated++;
    projAgg.set(rp, a);
  }
  for (const [rp, a] of [...projAgg].sort((x, y) => y[1].resolved - x[1].resolved)) {
    const st = projects.get(rp);
    if (st === undefined) { flags.D3.push({ project: rp, why: 'not in projects.json (dangling project ref)', resolved: a.resolved, graduated: a.graduated }); continue; }
    if (st === 'concept' && a.resolved >= STALE_RESOLVED_MIN)
      flags.D3.push({ project: rp, why: `\`concept\` but ${a.resolved} resolved / ${a.graduated} graduated — shipped work warrants a status bump`, resolved: a.resolved, graduated: a.graduated });
  }
  function title(it) { return (it.body.match(/^#\s+(.+)$/m) || [, it.file])[1].slice(0, 70); }

  // ---- scope attribution (#957 — mirrors `check:standards --scope`, #952/#949, on the id axis) ----
  // Demote findings owned by another session to a note count; keep mine + unattributable (D3) in view.
  const scopeArg = process.argv.find(a => a.startsWith('--scope=') || a.startsWith('--mine='));
  const scopeSession = scopeArg ? scopeArg.split('=').slice(1).join('=') : null;
  let scopeNote = null;
  if (scopeSession) {
    let mineIds = null;
    try {
      mineIds = claimedIdsFor(parseClaims(readFileSync(join(ROOT, '.claude/skills/batch-backlog-items/claims.json'), 'utf8')), scopeSession);
    } catch { mineIds = null; }
    if (!mineIds) {
      scopeNote = `--scope="${scopeSession}" has no recorded claim — running whole-backlog.`;
    } else {
      // claims.json stamps the full item slug (`964-check-…`); health findings are numeric-id keyed (`964`).
      // Normalize both to the leading number so attribution joins across the two id formats.
      const mineNums = new Set([...mineIds].map(s => idFromName(String(s))).filter(Boolean)); // two-form id (#2288)
      let externalTotal = 0;
      for (const k of Object.keys(flags)) {
        // D3 is project-keyed (no owning item id) → partitionById keeps it as `mine` (fail-safe).
        const { mine, external } = partitionById(flags[k], mineNums);
        flags[k] = mine;
        externalTotal += external.length;
      }
      scopeNote = `--scope="${scopeSession}" — ${mineNums.size} claimed item(s); ${externalTotal} external flag(s) demoted to a note.`;
    }
  }

  // ---- report --------------------------------------------------------------
  const open = [...items.values()].filter(i => i.status !== 'resolved').length;
  const L = [];
  L.push('# Backlog health audit — deterministic sweep', '');
  L.push(`> Generated by \`scripts/audit-backlog-health.mjs\` (read-only). ${items.size} items (${open} open). The judgment layer (guiding-principle conformance) reads on top of these flags.`, '');
  if (scopeNote) L.push(`> **Scope:** ${scopeNote}`, '');
  L.push('## Summary', '', '| Check | What it catches | Hits |', '|---|---|---|');
  const desc = { G1: 'prose prereq not lifted into `blockedBy` (INFO = both ends resolved)', G2: 'resolved build gated on a decision that was open/later (git-dated)', G3: 'graduated entity with no governing decision (transitive lineage + prose)', G4: 'prepared decision with prioritization/effort tells in a `## Fork` (fork-existence test skipped)', G5: 'prepared decision with a `## Fork` lacking a fork-existence justification line (#819)', G6: 'resolved decision with no `codifiedIn` — rule may be case-law-only (promote to a guideline, or mark `one-off`)', G8: 'prepared decision whose `## Fork` leans on a still-open sibling decision with no `blockedBy` edge (default rests on an unratified premise)', G7: 'cites a codified decision\'s `#N` but not its statute anchor — re-point to platform-decisions.md#<anchor> (cite the rule, not the case)', A1: 'open item with no `## Acceptance` (or legacy-alias) proof — no heading, or one with no executable/observable token and no exemption (#2949)', O1: 'born-active scaffold (`scaffold --session`, #670) lingering past its creating day — likely a stranded session; `settle` it or revert to open', D1: 'backticked code path that no longer exists', D2: 'referenced #N item that does not exist', D3: 'project missing from projects.json, or `concept` despite shipped work' };
  const G1_INFO = flags.G1.filter(f => f.sev === 'INFO').length;
  for (const k of Object.keys(flags)) {
    const n = flags[k].length, note = k === 'G1' && G1_INFO ? ` (${n - G1_INFO} active + ${G1_INFO} INFO)` : '';
    L.push(`| **${k}** | ${desc[k]} | ${n}${note} |`);
  }
  L.push('');
  const HI = flags.G1.filter(f => f.sev === 'HIGH');
  L.push(`**Highest-priority (G1 HIGH — build references an _open decision_ with no edge): ${HI.length}**`, '');

  const SEV = { HIGH: 0, med: 1, low: 2, INFO: 3 };           // INFO sinks to the bottom
  function section(k, head, fmt) {
    L.push(`## ${k} — ${head} (${flags[k].length})`, '');
    if (!flags[k].length) { L.push('_none._', ''); return; }
    for (const f of flags[k].slice().sort((a, b) => (SEV[a.sev] ?? 1) - (SEV[b.sev] ?? 1)).slice(0, 200))
      L.push(`- ${fmt(f)}`);
    if (flags[k].length > 200) L.push(`- …and ${flags[k].length - 200} more`);
    L.push('');
  }
  section('G1', 'Edge-gaps (prose prereq not in blockedBy)', f => `**#${f.id}** → #${f.ref} ${f.decision ? `(decision${f.refOpen ? ', **OPEN**' : ''})` : ''} \`${f.sev}\` — ${f.title}`);
  section('G2', 'Built ahead of its ruling (gated on a later-ruled decision, git-dated)', f => `**#${f.id}** gated on decision #${f.ref} — ${f.why} — ${f.title}`);
  section('G3', 'Graduated with no governing decision (transitive lineage + prose checked)', f => `**#${f.id}** → \`${f.graduatedTo}\` — ${f.title}`);
  section('G4', 'Prepared decision with prioritization tells in a `## Fork` (re-run the fork-existence test at claim)', f => `**#${f.id}** — tells: ${f.tells.map(t => `_${t}_`).join(', ')} — ${f.title}`);
  section('G5', 'Prepared decision with a `## Fork` lacking a fork-existence justification line (#819 — name the excluded branch or why they can\'t coexist)', f => `**#${f.id}** — fork(s): ${f.forks.map(t => `_${t}_`).join(', ')} — ${f.title}`);
  section('G8', 'Prepared decision leaning on an unruled sibling decision (add the `blockedBy` edge, or re-ground the default on a premise that stands alone)', f => `**#${f.id}** → ${f.refs.map(r => `#${r} (**open decision**)`).join(', ')} — ${f.title}`);
  section('G6', 'Resolved decisions missing `codifiedIn` (promote the rule to a guideline, or mark `one-off`)', f => `**#${f.id}** — ${f.title}`);
  section('G7', 'Cites a codified decision by `#N` instead of its statute anchor (re-point to platform-decisions.md#<anchor> — cite the rule, not the case)', f => `**#${f.id}** → ${f.refs.map(r => `#${r.ref} ⇒ \`${r.anchor}\``).join(', ')} — ${f.title}`);
  section('A1', 'Missing `## Acceptance` proof (#2949 — add a tier-1/2 criterion, or an explicit exemption line)', f => `**#${f.id}** \`${f.reason}\` — ${f.title}`);
  section('O1', 'Orphaned born-active scaffolds (#670 — unsettled past their creating day; `settle <NNN>` to publish or revert to open)', f => `**#${f.id}** — owned by \`${f.by}\` since ${f.since} — ${f.title}`);
  section('D1', 'Dead file references', f => `**#${f.id}** \`${f.ref}\` — ${f.title}`);
  section('D2', 'Dangling item references', f => `**#${f.id}** → #${f.ref} (no such item) — ${f.title}`);
  section('D3', 'Stale project references (per project)', f => `**\`${f.project}\`** — ${f.why}`);

  writeFileSync(REPORT, L.join('\n'));
  if (process.argv.includes('--json')) console.log(JSON.stringify(flags, null, 2));
  const tot = Object.values(flags).reduce((a, b) => a + b.length, 0);
  console.log(`audit: ${items.size} items, ${tot} flags (G1=${flags.G1.length} [${HI.length} HIGH, ${G1_INFO} INFO], G2=${flags.G2.length}, G3=${flags.G3.length}, G4=${flags.G4.length}, G5=${flags.G5.length}, G6=${flags.G6.length}, G7=${flags.G7.length}, G8=${flags.G8.length}, A1=${flags.A1.length}, O1=${flags.O1.length}, D1=${flags.D1.length}, D2=${flags.D2.length}, D3=${flags.D3.length})`);
  if (scopeNote) console.log(`scope: ${scopeNote}`);
  console.log(`report → ${REPORT.replace(ROOT + '/', '')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
