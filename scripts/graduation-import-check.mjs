#!/usr/bin/env node
/**
 * @file scripts/graduation-import-check.mjs
 * @description Epic #3443 (porting `origin/lane/mechanical-dispatcher` to `main` in slices) has hit the same
 *   failure TWICE: a slice's scoped TEST file imports a module owned by a LATER slice — one whose files are
 *   not on `main` yet and are not declared as a `blockedBy` dependency — so the slice cannot pass its own
 *   tests once it lands on `main`. #3901 had three test files like this (hand-fixed in PR #2567, moved to
 *   #3856/#3908/#3902); #3895 has two more, not yet fixed, at the snapshot this tool defaults to.
 *
 *   This checks EVERY OPEN card parented to the epic: for each `.mjs` file in its `scope:`, read the file AS IT
 *   STOOD AT THE PORT SNAPSHOT (`git show <sha>:<path>` — the port has not landed, so main's own working tree
 *   copy, if any, is irrelevant; the snapshot is the branch content about to be ported), statically extract its
 *   relative imports (`import … from './x.mjs'`, `import './x.mjs'`, and `import('./x.mjs')`), resolve each to a
 *   repo path, and classify it:
 *     - `on-main`   — the path already exists on `origin/main` (kept simple per the card: existence only, no
 *                     content diff — a file `main` already has can never be a slice-ordering hazard).
 *     - `own`       — declared in the SAME card's own `scope:`.
 *     - `blocker`   — declared in the `scope:` of a card this card's `blockedBy` reaches, transitively — landing
 *                     order is guaranteed by the epic's drain (Slice procedure rule 2), so this is safe.
 *     - `later:#N`  — declared in the `scope:` of some OTHER open card, with no declared `blockedBy` edge
 *                     guaranteeing it lands first. THIS is the hazard: nothing enforces #N lands before this
 *                     card, so the import may not exist on `main` when this card's tests run.
 *     - `unowned`   — not on `main`, not in any open card's `scope:` — likely a moved/renamed file or a scope
 *                     gap; flagged for a human, since there is no card to point a fix at.
 *
 *   Only `later` and `unowned` are findings. The proposed fix differs by file kind (`*.test.mjs` vs. impl):
 *     - a TEST file moves wholesale to the owning card that LANDS LAST among its `later` imports — moving it to
 *       the earliest-landing owner would just recreate the same hazard one hop down. "Lands last" is read off
 *       the `blockedBy` DAG as topological depth (`landingDepth`, counting only OPEN blockers — a resolved
 *       blocker has already landed and costs no further depth): #3895's own `telemetry-wiring.test.mjs` imports
 *       modules owned by #3902 (depth 1), #3905 (depth 4) and #3908 (depth 5) — #3908 wins, and that agrees with
 *       the epic card's own hand-written "Critical path: 3897 → 3902 → 3903 → 3906 → 3908 → 3487" and its Wave
 *       lettering (3902 is Wave B, 3905 is Wave C, 3908 is Wave D — D lands after B and C).
 *     - an IMPL file cannot be moved (its OWN card owns it) — the fix is to add the later owner(s) as
 *       `blockedBy`, which is exactly what the `blocker` classification then makes safe on the next run.
 *
 *   PURE CORE below (no fs/child_process/Date) is unit-tested on synthetic fixtures
 *   (`we:scripts/__tests__/graduation-import-check.test.mjs`). The IO shell (git/fs) and the CLI sit at the
 *   bottom, guarded by the `import.meta.url` check so importing this module for its exports never runs it.
 *
 * REUSES, NEVER REINVENTS: frontmatter scalar-field read/insert (`./backlog/frontmatter.mjs`, #2603-descended)
 *   and the ONE card-mutation writer (`./backlog/guarded-write.mjs`, #3034) — `--apply` never hand-rolls a
 *   frontmatter splice or a raw `writeFileSync` on a backlog card.
 *
 * Usage:
 *   node scripts/graduation-import-check.mjs [--snapshot=600acc14f] [--parent=3443] [--json] [--apply]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, posix as pathPosix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import matter from 'gray-matter';

import { readField, setFrontmatterField } from './backlog/frontmatter.mjs';
import { writeBacklogMd } from './backlog/guarded-write.mjs';
import { localToday } from './lib/local-date.mjs';

// ---------------------------------------------------------------------------------------------------------------
// PURE CORE — no fs, no child_process, no Date. Every fact this half needs (card data, file text, "does this
// path exist on origin/main", "today") is INJECTED by the IO shell below.

/** `backlog/3895-graduate-….md` → `3895`; `backlog/x8w8pux-….md` → `x8w8pux` (a not-yet-JIT-numbered card). */
export function idFromFilename(name) {
  return String(name).replace(/\.md$/, '').split('-')[0];
}

/** Strip/add the `we:` repo-locus prefix (#883) that every `scope:`/`blockedBy` display path in this repo carries. */
export function stripWe(p) { return p.startsWith('we:') ? p.slice(3) : p; }
export function withWe(p) { return p.startsWith('we:') ? p : `we:${p}`; }

/**
 * Parse one card's frontmatter into the fields this check needs. PURE (gray-matter is a string parser, no IO).
 * `blockedBy`/`scope` are always arrays of strings, regardless of whether the source YAML had zero, one
 * (bare-scalar) or many entries — mirrors `we:scripts/lib/priority-order.mjs#parseCard`'s normalization.
 * @param {string} name  the backlog filename (`3895-graduate-….md`)
 * @param {string} text  the file's full text
 * @returns {{id:string, kind:string, status:string, parent:string|null, blockedBy:string[], scope:string[]}|null}
 */
export function parseCard(name, text) {
  let data;
  try { data = matter(String(text ?? '')).data ?? {}; } catch { return null; }
  const asArray = (v) => (Array.isArray(v) ? v.map(String) : v != null && v !== '' ? [String(v)] : []);
  return {
    id: idFromFilename(name),
    kind: String(data.kind ?? ''),
    status: String(data.status ?? ''),
    parent: data.parent != null && data.parent !== '' ? String(data.parent) : null,
    blockedBy: asArray(data.blockedBy),
    scope: asArray(data.scope),
  };
}

/** Numeric-first id compare (`"3902" < "3908"`), falling back to string compare for non-numeric (hash) ids —
 *  used only to make an otherwise-arbitrary tie-break (equal landing depth, or several `later` owners)
 *  deterministic, never as a claim about actual landing order. */
export function idCompare(a, b) {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * The file's leading run of `import` statements — everything from the top up to the first line that is
 * neither blank nor part of an import statement. PURE. House ESM style (confirmed across every module read
 * while building this tool) always clusters real imports in one contiguous block at the top of the file, so
 * this is a cheap, reliable boundary — and a NECESSARY one: some modules embed literal `import … from '…'`
 * text inside a template-literal STRING (a source string handed to a spawned subprocess for a test, e.g.
 * `we:scripts/conveyor/validate-and-promote.mjs`'s `DISPATCH_PROBE_SRC` and
 * `we:scripts/operations/__tests__/coordination-cross-clone.test.mjs`'s spawned `-e` probe) — text that
 * matches the static-import regex but is not an import of the current module at all. Restricting the static
 * regex to this header keeps those false positives out without needing a real parser. (Dynamic `import()` is
 * scanned over the WHOLE file, not just the header — a lazy `await import(...)` deep in a function, as in
 * `we:scripts/operations/review-loop-cli.mjs`, is a real import there.) Assumes the house style of terminating
 * every import statement with a semicolon (true of every file this tool has read) — a file that relied on ASI
 * would fail open (header would swallow the rest of the file), which only widens what gets scanned, never
 * narrows it.
 */
function importHeader(source) {
  const lines = source.split('\n');
  const header = [];
  let inImport = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inImport) {
      if (trimmed === '') { header.push(line); continue; }
      if (/^import\b/.test(trimmed)) {
        header.push(line);
        inImport = !trimmed.includes(';');
        continue;
      }
      break; // first non-blank, non-import top-level line — header ends here
    }
    header.push(line);
    if (trimmed.includes(';')) inImport = false;
  }
  return header.join('\n');
}

/**
 * Extract every relative static-import / dynamic-`import()` specifier from one module's source text. PURE
 * string scanning, not a real parser — deliberately simple, matched to this repo's house ESM style (explicit
 * `.mjs` extensions, no bundler magic). Comments are stripped first so a JSDoc header that merely MENTIONS an
 * import in prose (this file's own header does exactly that) is never mistaken for a real one; static imports
 * are then read only from {@link importHeader} (see its doc for why). Non-relative specifiers (bare packages,
 * `node:*`) are returned too; the caller (`resolveRelativeImport`) is what filters to repo-local paths — this
 * function only extracts, it does not judge.
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  const stripped = String(source ?? '')
    .replace(/^#!.*\n/, '') // shebang, if any (`#!/usr/bin/env node`) — not a comment, but not code either
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. JSDoc) — do this first, may contain `//`
    .replace(/\/\/.*$/gm, ''); // line comments
  const out = [];
  // `import 'x'` / `import Foo from 'x'` / `import { a, b } from 'x'` (from-clause may span multiple lines —
  // the middle class excludes quotes/parens/semicolons so it can never cross into a NEXT statement).
  const staticRe = /\bimport\s+(?:[^'"();]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
  for (const m of importHeader(stripped).matchAll(staticRe)) out.push(m[1]);
  // `import('x')` / `await import('x')` — excluded from staticRe above (no whitespace before `(`). Scanned over
  // the whole file (see importHeader's doc for why this one is NOT header-restricted).
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of stripped.matchAll(dynamicRe)) out.push(m[1]);
  return out;
}

/**
 * Resolve a relative import specifier against the repo path of the file that contains it, to a repo-relative
 * path (no `we:` prefix, no `./`/`../`). Returns `null` for a non-relative specifier (bare package, `node:*`)
 * — those never resolve to a card-owned file, so there is nothing to classify.
 * @param {string} fromRepoPath
 * @param {string} specifier
 * @returns {string|null}
 */
export function resolveRelativeImport(fromRepoPath, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const dir = pathPosix.dirname(fromRepoPath);
  return pathPosix.normalize(pathPosix.join(dir, specifier));
}

/** Every id reachable from `id`'s `blockedBy` edges, transitively (cycle-safe). PURE. */
export function transitiveBlockedBy(id, cardsById) {
  const out = new Set();
  const stack = [...(cardsById.get(id)?.blockedBy ?? [])];
  while (stack.length) {
    const b = stack.pop();
    if (out.has(b)) continue;
    out.add(b);
    for (const nb of cardsById.get(b)?.blockedBy ?? []) if (!out.has(nb)) stack.push(nb);
  }
  return out;
}

/**
 * Files declared in MORE THAN ONE open card's `scope:` — e.g. `we:scripts/operations/run.mjs` and
 * `we:scripts/operations/__tests__/http-adapter.test.mjs`, which epic #3443's own card documents as shared,
 * append-only files that every slice adds its own line to ("each slice appends only its own lines… so parallel
 * slices merge cleanly"). At the port SNAPSHOT such a file's content is already the union of every slice's
 * lines — not any one slice's own increment — so scanning it as if it were singly owned would misattribute the
 * WHOLE merged import graph to whichever one card happened to be checked, which is exactly the false-positive
 * flood this rule prevents. Generalized past the two named files: ANY scope path with 2+ open owners is
 * treated the same way, never hardcoded by filename. Caller skips these entirely as importers (does not read
 * or scan their content) but leaves them fully eligible as IMPORT TARGETS (unaffected — the existing per-card
 * scope-membership checks already look across every card, single- or multi-owned alike). PURE.
 * @param {Map<string,object>} cardsById
 * @returns {Map<string, string[]>} path -> owning card ids (open only), sorted by {@link idCompare}
 */
export function computeSharedFiles(cardsById) {
  const owners = new Map();
  for (const c of cardsById.values()) {
    if (c.status !== 'open') continue;
    for (const s of c.scope) {
      if (!owners.has(s)) owners.set(s, new Set());
      owners.get(s).add(c.id);
    }
  }
  const shared = new Map();
  for (const [path, ids] of owners) if (ids.size > 1) shared.set(path, [...ids].sort(idCompare));
  return shared;
}

/**
 * Topological depth of `id` in the OPEN-card `blockedBy` DAG: 0 if it has no open blocker, else
 * `1 + max(depth(blocker))` over its OPEN blockers (a resolved blocker has already landed — it costs no
 * further depth). Used only to rank several `later` owners of one test file by "lands last" — see the file
 * header for why this agrees with the epic's own hand-written Wave/critical-path notes. Cycle-safe (a cycle in
 * `blockedBy` is a data bug elsewhere; this returns 0 for the repeated id rather than looping forever).
 */
export function landingDepth(id, cardsById, seen = new Set()) {
  if (seen.has(id)) return 0;
  const card = cardsById.get(id);
  if (!card || !card.blockedBy.length) return 0;
  const nextSeen = new Set(seen);
  nextSeen.add(id);
  let max = 0;
  for (const b of card.blockedBy) {
    const bc = cardsById.get(b);
    if (!bc || bc.status !== 'open') continue;
    const d = 1 + landingDepth(b, cardsById, nextSeen);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Classify one resolved import path for the card that owns the IMPORTING file.
 * @param {{repoPath:string, ownerId:string, cardsById:Map<string,object>, mainPaths:Set<string>}} a
 * @returns {{kind:'on-main'|'own'|'blocker'|'later'|'unowned', ownerId?:string}}
 */
export function classifyImportPath({ repoPath, ownerId, cardsById, mainPaths }) {
  const we = withWe(repoPath);
  if (mainPaths.has(repoPath) || mainPaths.has(we)) return { kind: 'on-main' };
  const owner = cardsById.get(ownerId);
  if (owner && owner.scope.includes(we)) return { kind: 'own' };
  const blockers = transitiveBlockedBy(ownerId, cardsById);
  for (const bId of blockers) {
    if (cardsById.get(bId)?.scope.includes(we)) return { kind: 'blocker', ownerId: bId };
  }
  // `later` is deliberately scoped to SIBLING slices of the SAME epic (`owner.parent`), never the whole
  // backlog. The same repo path can legitimately appear in an unrelated card's `scope:` too — e.g. a bug card
  // filed against the not-yet-landed branch file under a completely different epic (measured: one graduation
  // module here has FOUR open owners across three different epics, only one of which is this porting epic) —
  // and that card has nothing to do with this epic's landing order. Reaching outside the epic would propose
  // moving/blocking against a card the drain's Slice-procedure ordering never touches.
  const candidates = [];
  for (const [id, c] of cardsById) {
    if (id === ownerId || blockers.has(id)) continue;
    if (c.status === 'open' && c.parent === owner?.parent && c.scope.includes(we)) candidates.push(id);
  }
  if (candidates.length) {
    candidates.sort(idCompare);
    return { kind: 'later', ownerId: candidates[0] };
  }
  return { kind: 'unowned' };
}

/**
 * Rank candidate owner ids by which one SHOULD end up hosting a multi-owner test file, deepest-first:
 *   1. greater `landingDepth` (lands later in the OPEN-card `blockedBy` DAG) wins;
 *   2. tie-break: a card that ALREADY carries ≥1 `blockedBy` entry wins over one with none — never make a
 *      currently blocker-free card (typically a foundational leaf, e.g. #3901) the first to gain a new
 *      blocker when an already-more-constrained alternative exists;
 *   3. further tie-break: {@link idCompare}, for determinism.
 * PURE. `planTestFileFix` walks this order looking for the first ACYCLIC placement — see its doc for why
 * "deepest" alone (this order's #1) is not sufficient on its own to pick a placement.
 */
export function rankOwnerCandidates(ids, cardsById) {
  return [...new Set(ids)].sort((a, b) => {
    const da = landingDepth(a, cardsById), db = landingDepth(b, cardsById);
    if (da !== db) return db - da;
    const ha = (cardsById.get(a)?.blockedBy.length ?? 0) > 0 ? 1 : 0;
    const hb = (cardsById.get(b)?.blockedBy.length ?? 0) > 0 ? 1 : 0;
    if (ha !== hb) return hb - ha;
    return idCompare(a, b);
  });
}

const isTestFile = (repoOrWePath) => /\.test\.mjs$/.test(repoOrWePath);

/** Would giving `target` a `blockedBy` edge on `blockerId` create a cycle? True iff `target` is already
 *  (transitively) a dependency OF `blockerId` — i.e. `blockerId` needs `target` to land first, so `target`
 *  cannot also need `blockerId` first. PURE. */
function wouldCycle(target, blockerId, cardsById) {
  return transitiveBlockedBy(blockerId, cardsById).has(target);
}

/**
 * Choose the home for a test file with imports spread across several cards, and the extra `blockedBy` edges
 * that placement needs. THE CANDIDATE SET IS the file's CURRENT owner plus every `later`-classified owner —
 * not just the `later` owners — because the current owner may ALREADY own some of the file's other imports
 * (classified `own`), and those are exactly as real a constraint on where the file can safely live.
 *
 * Real case found live that a naive "move to whichever later-owner lands deepest" gets BACKWARDS:
 * `action-dispatch-paths.test.mjs` lives at #3856 (owns `land-advance-io.mjs`) and also imports
 * `action-store.mjs`/`action-record.mjs`, both #3901's. #3901 is a foundational LEAF (currently zero
 * `blockedBy`, feeding #3902/#3906/#3907/#3863 downstream); #3856 sits at the END of the land-advance chain
 * (7 blockers already). Only looking at the later owner (#3901) and moving there, then blocking #3901 on
 * #3856, would give a foundational leaf a brand-new dependency on something far downstream — stalling
 * everything #3901 feeds behind the whole land-advance chain. The right call is the reverse: the file STAYS
 * at #3856 (already the deeper, already-more-constrained card — so `target === currentOwnerId` here, no scope
 * move at all) and #3856 gains `blockedBy #3901` instead.
 *
 * Mechanism: rank the candidate set with {@link rankOwnerCandidates} (deepest, then already-has-blockers,
 * first) and walk that order picking the first candidate that can safely receive a `blockedBy` edge to EVERY
 * other candidate (no cycle) — never picking a shallower/blocker-free candidate over a deeper acyclic one.
 * Falls back to the top-ranked candidate (reporting the unavoidable edges as `cycleWarnings`) only if no
 * candidate is fully clean — a genuine circular need between two slices, left for a human.
 *
 * Once a target is chosen, every import of the file is RE-classified as if it belonged to that target (not
 * just the original candidate owners) — a move can turn some other import (safely `own`/`blocker` under the
 * old owner) into a fresh hazard under the new one, exactly the mechanism the #3895→#3908 case needed
 * (residual `blockedBy #3905`). PURE.
 * @param {{currentOwnerId:string, classifications:Array, cardsById:Map<string,object>, mainPaths:Set<string>}} a
 * @returns {{target:string, addBlockedBy:string[], cycleWarnings:Array<{path:string, ownerId:string}>}|null}
 *   `null` when the file has no `later` import (nothing to place for). `target === currentOwnerId` means
 *   "stays put" — the caller must not treat that as a scope move.
 */
export function planTestFileFix({ currentOwnerId, classifications, cardsById, mainPaths }) {
  const laterOwnerIds = classifications.filter((c) => c.kind === 'later').map((c) => c.ownerId);
  if (!laterOwnerIds.length) return null;
  const candidates = [...new Set([currentOwnerId, ...laterOwnerIds])];
  const ranked = rankOwnerCandidates(candidates, cardsById);
  const isFullyAcyclic = (t) => candidates.every((other) => other === t || !wouldCycle(t, other, cardsById) || transitiveBlockedBy(t, cardsById).has(other));
  const target = ranked.find(isFullyAcyclic) ?? ranked[0];

  const addBlockedBy = new Set();
  const cycleWarnings = [];
  for (const c of classifications) {
    if (c.kind === 'on-main') continue; // owner-independent; reclassifying is a no-op
    const under = classifyImportPath({ repoPath: c.repoPath, ownerId: target, cardsById, mainPaths });
    if (under.kind !== 'later') continue; // own/blocker/on-main under the chosen home — no edge needed
    if (under.ownerId === target) continue; // defensive; classifyImportPath never returns this
    if (wouldCycle(target, under.ownerId, cardsById)) cycleWarnings.push({ path: c.repoPath, ownerId: under.ownerId });
    else addBlockedBy.add(under.ownerId);
  }
  return { target, addBlockedBy: [...addBlockedBy].sort(idCompare), cycleWarnings };
}

/**
 * Group per-import classifications into per-file findings with a proposed fix. Only files carrying a `later`
 * or `unowned` classification produce a finding — `on-main`/`own`/`blocker` are silently fine.
 * @param {{cardsById:Map<string,object>, mainPaths:Set<string>, results:Array<{ownerId:string, file:string, classifications:Array}>}} a
 *   `results[i].classifications` items are `{specifier, repoPath, ...classifyImportPath() result}`.
 * @returns {Array<object>} one entry per (card, file) with a finding.
 */
export function buildFindings({ cardsById, mainPaths, results }) {
  const findings = [];
  for (const r of results) {
    const later = r.classifications.filter((c) => c.kind === 'later');
    const unowned = r.classifications.filter((c) => c.kind === 'unowned');
    if (!later.length && !unowned.length) continue;
    const test = isTestFile(r.file);
    let fix;
    if (later.length) {
      if (test) {
        fix = { kind: 'move', ...planTestFileFix({ currentOwnerId: r.ownerId, classifications: r.classifications, cardsById, mainPaths }) };
      } else {
        // An impl file cannot move (the card's own scope IS the code) — but a proposed blockedBy edge can
        // still cycle (the later owner already depends, transitively, on THIS card). Guard it the same way
        // planTestFileFix does, rather than blindly wiring a self-defeating edge.
        const targets = [], cycleWarnings = [];
        for (const t of new Set(later.map((c) => c.ownerId))) {
          if (wouldCycle(r.ownerId, t, cardsById)) cycleWarnings.push({ path: null, ownerId: t });
          else targets.push(t);
        }
        fix = { kind: 'blockedBy', targets: targets.sort(idCompare), cycleWarnings };
      }
    } else {
      // Every remaining import is `unowned`: the branch has the file, but no OPEN card in the epic claims it —
      // it has to be ported together with the code that needs it, so the fix is to add it to the IMPORTING
      // card's own scope (never invented as a new card, never guessed onto some other card).
      fix = { kind: 'add-to-scope', owner: r.ownerId, paths: [] };
    }
    // A file can carry BOTH `later` and `unowned` imports at once. Whichever card ends up owning the FILE
    // (the move target, or this card unchanged) is also the one whose scope should gain the unowned path(s) —
    // same reasoning as the unowned-only case above, just attached to whatever the primary fix already is.
    if (unowned.length) {
      const owner = fix.kind === 'move' ? fix.target : r.ownerId;
      fix.addToScope = { owner, paths: unowned.map((c) => withWe(c.repoPath)) };
      if (fix.kind === 'add-to-scope') fix.paths = fix.addToScope.paths; // unowned-only: same list, top-level too
    }
    findings.push({ ownerId: r.ownerId, file: r.file, isTest: test, later, unowned, fix });
  }
  return findings.sort((a, b) => idCompare(a.ownerId, b.ownerId) || a.file.localeCompare(b.file));
}

/** One-line, human-readable rendering of a finding's proposed fix. PURE. */
export function describeFix(finding) {
  const scopeSuffix = finding.fix.addToScope?.paths.length
    ? `; add ${finding.fix.addToScope.paths.map((p) => `\`${p}\``).join(', ')} to #${finding.fix.addToScope.owner}'s scope (unowned)`
    : '';
  if (finding.fix.kind === 'move') {
    const cyc = finding.fix.cycleWarnings?.length
      ? ` — MANUAL: ${finding.fix.cycleWarnings.map((w) => `${withWe(w.path)} needs #${w.ownerId}, which would cycle`).join('; ')}`
      : '';
    if (finding.fix.target === finding.ownerId) {
      const extra = finding.fix.addBlockedBy?.length ? ` blockedBy ${finding.fix.addBlockedBy.map((t) => `#${t}`).join(', ')}` : '';
      return `stays here; add${extra}${cyc}${scopeSuffix}`;
    }
    const extra = finding.fix.addBlockedBy?.length ? `, plus blockedBy ${finding.fix.addBlockedBy.map((t) => `#${t}`).join(', ')} (its other imports, under the new owner)` : '';
    return `move to #${finding.fix.target} (lands last among: ${finding.later.map((c) => `#${c.ownerId}`).join(', ')})${extra}${cyc}${scopeSuffix}`;
  }
  if (finding.fix.kind === 'blockedBy') {
    const cyc = finding.fix.cycleWarnings?.length
      ? ` — MANUAL: #${finding.fix.cycleWarnings.map((w) => w.ownerId).join(', #')} would cycle`
      : '';
    return `add blockedBy ${finding.fix.targets.map((t) => `#${t}`).join(', ')}${cyc}${scopeSuffix}`;
  }
  if (finding.fix.kind === 'add-to-scope') return `add ${finding.fix.paths.map((p) => `\`${p}\``).join(', ')} to #${finding.fix.owner}'s own scope (unowned; ports with the code that needs it)`;
  return finding.fix.reason;
}

/**
 * Turn findings into the edits each affected card needs: `scope:`/`blockedBy:` array changes plus a dated
 * one-line note for BOTH sides of every move/blockedBy edge — exactly what `--apply` writes, nothing else.
 * PURE (caller supplies `today`). Only `move` and `blockedBy` fixes produce edits; `unresolved` has no card to
 * point a fix at, so it is left for a human and never auto-applied.
 * @param {Array<object>} findings  from {@link buildFindings}
 * @param {string} today  `YYYY-MM-DD`
 * @returns {Map<string, {removeScope:string[], addScope:string[], addBlockedBy:string[], notes:string[]}>}
 */
export function planEdits(findings, today) {
  const edits = new Map();
  const get = (id) => {
    if (!edits.has(id)) edits.set(id, { removeScope: [], addScope: [], addBlockedBy: [], notes: [] });
    return edits.get(id);
  };
  for (const f of findings) {
    if (f.fix.kind === 'move') {
      const target = f.fix.target;
      if (target !== f.ownerId) {
        get(f.ownerId).removeScope.push(f.file);
        get(target).addScope.push(f.file);
        get(f.ownerId).notes.push(`- ${today}: graduation-import-check moved \`${f.file}\` to #${target} — it imports a module #${target} owns.`);
        get(target).notes.push(`- ${today}: graduation-import-check moved \`${f.file}\` here from #${f.ownerId} — it imports a module this card owns.`);
      }
      // Placing (or keeping) the file at `target` can leave one of its OTHER imports uncovered — see
      // planTestFileFix's doc for the #3901/#3856 and #3895/#3908 shapes this covers. Fix with blockedBy on
      // `target` rather than moving again (which could ping-pong between two unrelated owners forever).
      for (const t of f.fix.addBlockedBy ?? []) {
        get(target).addBlockedBy.push(t);
        get(target).notes.push(`- ${today}: graduation-import-check added blockedBy #${t} — the moved-in \`${f.file}\` also imports a module #${t} owns.`);
        get(t).notes.push(`- ${today}: graduation-import-check made this a blocker of #${target} — its moved-in \`${f.file}\` imports a module this card owns.`);
      }
    } else if (f.fix.kind === 'blockedBy') {
      for (const t of f.fix.targets) {
        get(f.ownerId).addBlockedBy.push(t);
        get(f.ownerId).notes.push(`- ${today}: graduation-import-check added blockedBy #${t} — \`${f.file}\` imports a module #${t} owns.`);
        get(t).notes.push(`- ${today}: graduation-import-check made this a blocker of #${f.ownerId} — its \`${f.file}\` imports a module this card owns.`);
      }
    }
    if (f.fix.addToScope?.paths.length) {
      const { owner, paths } = f.fix.addToScope;
      for (const p of paths) {
        get(owner).addScope.push(p);
        get(owner).notes.push(`- ${today}: graduation-import-check added ${p} to this card's own scope — no open card owned it, and it is imported by \`${f.file}\`, which this card ports.`);
      }
    }
  }
  return edits;
}

/** Read a card's inline JSON-array frontmatter field (`scope:`/`blockedBy:` are always `["a", "b"]` in this
 *  repo's cards — valid JSON), or `[]` if absent/unparseable. PURE (operates on already-read file text). */
export function readArrayField(content, key) {
  const raw = readField(content, key);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

/** Render + splice an array field back with this repo's house style (`, ` between entries — plain
 *  `JSON.stringify` omits the space, which would diff-noise every untouched entry). PURE. */
export function writeArrayField(content, key, arr, { after = [] } = {}) {
  const rendered = `[${arr.map((v) => JSON.stringify(v)).join(', ')}]`;
  return setFrontmatterField(content, key, rendered, { after });
}

const GRAD_NOTE_HEADING = '## Graduation import check';

/** Append one dated note line under a (created-if-absent) `## Graduation import check` section, right after the
 *  heading — so repeat runs stack newest-first without needing to locate "end of section". Idempotent: a byte-
 *  identical line already present is not duplicated. PURE. */
export function appendGraduationNote(content, line) {
  if (content.includes(line)) return content;
  const idx = content.indexOf(GRAD_NOTE_HEADING);
  if (idx === -1) return `${content.replace(/\s+$/, '')}\n\n${GRAD_NOTE_HEADING}\n\n${line}\n`;
  let insertAt = content.indexOf('\n', idx);
  insertAt = insertAt === -1 ? content.length : insertAt + 1;
  if (content[insertAt] === '\n') insertAt += 1;
  return content.slice(0, insertAt) + `${line}\n` + content.slice(insertAt);
}

/**
 * Apply one card's planned edit to its raw file text. Touches ONLY `scope:`, `blockedBy:` and an appended
 * `## Graduation import check` note — no other frontmatter field is ever read or written. PURE.
 * @param {string} content
 * @param {{removeScope?:string[], addScope?:string[], addBlockedBy?:string[], notes?:string[]}} edit
 * @returns {string}
 */
export function applyCardEdits(content, edit) {
  let next = content;
  const { removeScope = [], addScope = [], addBlockedBy = [], notes = [] } = edit;
  if (removeScope.length || addScope.length) {
    let scope = readArrayField(next, 'scope').filter((s) => !removeScope.includes(s));
    for (const s of addScope) if (!scope.includes(s)) scope.push(s);
    next = writeArrayField(next, 'scope', scope, { after: ['blockedBy', 'status', 'parent', 'size', 'kind'] }) ?? next;
  }
  if (addBlockedBy.length) {
    const bb = readArrayField(next, 'blockedBy');
    for (const t of addBlockedBy) if (!bb.includes(t)) bb.push(t);
    next = writeArrayField(next, 'blockedBy', bb, { after: ['status', 'parent', 'size', 'kind'] }) ?? next;
  }
  for (const note of notes) next = appendGraduationNote(next, note);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// IO shell — the only part that touches fs/git. Everything above stays testable on plain objects/strings.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readBacklogCards(backlogDir) {
  const cards = new Map();
  const files = new Map(); // id -> {name, abs}
  for (const name of readdirSync(backlogDir)) {
    if (!name.endsWith('.md')) continue;
    const abs = join(backlogDir, name);
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const card = parseCard(name, text);
    if (!card) continue;
    cards.set(card.id, card);
    files.set(card.id, { name, abs, rel: `backlog/${name}`, text });
  }
  return { cards, files };
}

/** `git show <ref>:<path>` → text, or `null` if the ref/path doesn't resolve (moved/renamed/never existed). */
function gitShow(ref, repoPath) {
  try { return execFileSync('git', ['show', `${ref}:${repoPath}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch { return null; }
}

/** `git cat-file -e <ref>:<path>` → does the blob exist (cheaper than reading it when only existence matters). */
function existsAtRef(ref, repoPath) {
  try { execFileSync('git', ['cat-file', '-e', `${ref}:${repoPath}`], { cwd: ROOT, stdio: 'pipe' }); return true; }
  catch { return false; }
}

function parseArgs(argv) {
  const flag = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  return {
    snapshot: flag('snapshot', '600acc14f'),
    parent: flag('parent', '3443'),
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
  };
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const backlogDir = join(ROOT, 'backlog');
  const { cards: cardsById, files } = readBacklogCards(backlogDir);

  const targets = [...cardsById.values()].filter((c) => c.status === 'open' && c.parent === args.parent);
  // Shared-file detection is scoped to THIS epic's own sibling slices, not the whole backlog — "each slice
  // appends only its own lines" is a claim epic #3443 makes about ITS OWN cards; a file two unrelated stories
  // elsewhere in the repo both happen to touch (e.g. `we:scripts/check-standards.mjs`) is not that pattern.
  const targetsById = new Map(targets.map((c) => [c.id, c]));
  const sharedFiles = computeSharedFiles(targetsById);

  const results = [];
  const warnings = [];
  const toCheckOnMain = new Set();
  const perFileImports = []; // { ownerId, file, resolved: [{specifier, repoPath}] }

  for (const card of targets) {
    for (const file of card.scope) {
      if (!file.endsWith('.mjs')) continue;
      if (sharedFiles.has(file)) continue; // reported once below, not once per owning card
      const repoPath = stripWe(file);
      const src = gitShow(args.snapshot, repoPath);
      if (src == null) {
        warnings.push(`could not read ${file} at ${args.snapshot} (git show failed) — skipped`);
        continue;
      }
      const specifiers = extractImportSpecifiers(src);
      const resolved = [];
      for (const spec of specifiers) {
        const rp = resolveRelativeImport(repoPath, spec);
        if (!rp) continue;
        resolved.push({ specifier: spec, repoPath: rp });
        toCheckOnMain.add(rp);
      }
      perFileImports.push({ ownerId: card.id, file, resolved });
    }
  }

  for (const [path, ids] of sharedFiles) warnings.push(`${path} is shared across ${ids.map((i) => `#${i}`).join(', ')} (append-only) — not scanned as an importer`);

  const mainPaths = new Set();
  for (const p of toCheckOnMain) if (existsAtRef('origin/main', p)) mainPaths.add(p);

  for (const { ownerId, file, resolved } of perFileImports) {
    const classifications = resolved.map(({ specifier, repoPath }) => ({
      specifier, repoPath, ...classifyImportPath({ repoPath, ownerId, cardsById, mainPaths }),
    }));
    results.push({ ownerId, file, classifications });
  }

  const findings = buildFindings({ cardsById, mainPaths, results });

  if (args.apply) {
    const edits = planEdits(findings, localToday());
    for (const [id, edit] of edits) {
      const f = files.get(id);
      if (!f) { warnings.push(`--apply: no card file found for #${id} (referenced by an edit) — skipped`); continue; }
      const before = readFileSync(f.abs, 'utf8');
      const after = applyCardEdits(before, edit);
      if (after !== before) writeBacklogMd(f.abs, f.rel, after, { root: ROOT });
    }
  }

  report({ args, targets, findings, warnings });
  process.exit(findings.length ? 1 : 0);
}

function report({ args, targets, findings, warnings }) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      snapshot: args.snapshot,
      parent: args.parent,
      cardsChecked: targets.length,
      findings: findings.map((f) => ({
        card: f.ownerId, file: f.file, isTest: f.isTest,
        laterImports: f.later.map((c) => ({ path: withWe(c.repoPath), owner: c.ownerId })),
        unownedImports: f.unowned.map((c) => withWe(c.repoPath)),
        fix: f.fix,
      })),
      warnings,
      applied: args.apply,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`graduation-import-check — snapshot ${args.snapshot}, parent #${args.parent}, ${targets.length} open card(s) checked${args.apply ? ' (--apply)' : ''}\n\n`);
  for (const w of warnings) process.stdout.write(`  ⚠ ${w}\n`);
  if (!findings.length) {
    process.stdout.write('  ✓ no findings — every scoped file imports only on-main / own / blocker paths.\n');
    return;
  }
  process.stdout.write(`  ${findings.length} finding(s):\n\n`);
  for (const f of findings) {
    process.stdout.write(`  #${f.ownerId}  ${f.file}${f.isTest ? '  [test]' : '  [impl]'}\n`);
    for (const c of f.later) process.stdout.write(`        later:  ${withWe(c.repoPath)}  → owned by #${c.ownerId}\n`);
    for (const c of f.unowned) process.stdout.write(`        unowned: ${withWe(c.repoPath)}\n`);
    process.stdout.write(`        fix → ${describeFix(f)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run();
