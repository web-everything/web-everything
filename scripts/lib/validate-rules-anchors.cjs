// The cross-doc `codifiedIn:` anchor-resolution gate (#1828, #1792 Fork 1 → (c)).
//
// docs/agent/platform-decisions.md is edited on every decision-resolve, and ~229 `codifiedIn:` frontmatter
// values across backlog/*.md cite anchors in it and three sibling docs. With the docs now rendered at
// /rules/ (rules-loader.cjs), a renamed/removed heading would silently 404 every inbound cite. This gate
// re-uses the loader's `extractAnchors` to build the authoritative anchor set per doc, then asserts every
// `codifiedIn:` frontmatter anchor resolves to a rendered anchor — so anchor drift fails the build the
// next time `check:standards` runs, not at some reader's broken link.
//
// Scope: `codifiedIn:` FRONTMATTER values only (the machine-cite contract). Prose-body file:line links and
// GitHub line-anchors (#L110) are informal references, not part of the codified-cite namespace.

const fs = require('fs');
const path = require('path');
const { extractAnchors, RULE_DOCS } = require('./rules-loader.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const CODIFIED_RE = /^codifiedIn:\s*["']?([^"'\n]+?)["']?\s*$/m;
const DOC_CITE_RE = /^docs\/agent\/([\w-]+)\.md#([\w-]+)$/;

// Per-doc anchor sets, keyed by the `docs/agent/<id>.md` path the cites use. Pure (reads the four docs).
function buildAnchorIndex() {
  const index = {};
  for (const doc of RULE_DOCS) {
    const src = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
    index[doc.file] = extractAnchors(src).anchors;
  }
  return index;
}

// Collect every backlog item's `codifiedIn:` frontmatter value that points at a `docs/agent/*.md#anchor`.
function collectCodifiedCites(backlogDir) {
  const cites = [];
  for (const name of fs.readdirSync(backlogDir)) {
    if (!name.endsWith('.md')) continue;
    const txt = fs.readFileSync(path.join(backlogDir, name), 'utf8');
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const m = fm[1].match(CODIFIED_RE);
    if (!m) continue;
    const value = m[1].trim();
    if (!value.includes('docs/agent/') || !value.includes('#')) continue; // one-off / none / non-doc
    cites.push({ file: name, value });
  }
  return cites;
}

// The pure gate: every codifiedIn doc-cite resolves to a rendered anchor. Returns { errors, warnings }
// in the check-standards shape. `anchorIndex` + `cites` are injected so it is fixture-testable.
function validateRulesAnchors(anchorIndex, cites) {
  const errors = [];
  for (const { file, value } of cites) {
    const m = value.match(DOC_CITE_RE);
    if (!m) {
      errors.push({ message:
        `backlog/${file}: codifiedIn "${value}" is not a well-formed docs/agent/<doc>.md#<anchor> cite ` +
        `(the /rules/ read-path only renders the four cited governance docs).` });
      continue;
    }
    const docPath = `docs/agent/${m[1]}.md`;
    const anchor = m[2];
    const set = anchorIndex[docPath];
    if (!set) {
      errors.push({ message:
        `backlog/${file}: codifiedIn cites "${docPath}", which is not one of the four /rules/-rendered ` +
        `governance docs (platform-decisions, block-standard, backlog-workflow, vision-tiers).` });
      continue;
    }
    if (!set.has(anchor)) {
      errors.push({ message:
        `backlog/${file}: codifiedIn anchor "#${anchor}" does not resolve in ${docPath} — it would 404 on ` +
        `/rules/${m[1]}/. The heading/anchor was renamed or removed; update the cite or restore the anchor.` });
    }
  }
  return { errors, warnings: [] };
}

// ── Statute integrity (#2083): duplicates / orphans / substance ─────────────────────────────────────
//
// The resolution gate above catches a cite whose anchor vanished; these three catch the inverse failure
// modes on the statute doc itself. All pure + injectable (fixture-testable); the fs gather lives in
// `runStatuteCheck` below and in check-standards.mjs.

// Every explicit `{#id}` occurrence in a doc — heading-suffix or inline — with its 1-based line. In the
// rendered output every occurrence becomes an id, so a second occurrence (even a prose "see {#id}") is a
// DUPLICATE HTML id: the fragment silently resolves to the first. References must be `[text](#id)` links.
function collectExplicitAnchorDefs(src) {
  const defs = [];
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\{#([\w-]+)\}/g)) defs.push({ id: m[1], line: i + 1 });
  });
  return defs;
}

function findDuplicateAnchors(defs, docPath) {
  const byId = new Map();
  for (const d of defs) {
    if (!byId.has(d.id)) byId.set(d.id, []);
    byId.get(d.id).push(d.line);
  }
  const errors = [];
  for (const [id, lines] of byId) {
    if (lines.length > 1)
      errors.push({ message:
        `${docPath}: anchor "{#${id}}" is defined ${lines.length}× (lines ${lines.join(', ')}) — the rendered ` +
        `page gets a duplicate HTML id and the fragment resolves to the first only. If one is a prose ` +
        `reference, write it as a [link](#${id}) instead of the {#…} definition syntax.` });
  }
  return errors;
}

// An explicit statute anchor nobody cites — not a `codifiedIn:`, not a `#id` mention anywhere in the
// reference corpus (backlog bodies + governance docs + in-doc links). A dead cluster is either awaiting
// its first cite (then cite it from the decision that created it) or leftover from a rename.
// Slug-derived heading anchors (structural headings) are automatic, not "named", and are exempt.
function findOrphanAnchors(defs, referencedIds, docPath) {
  const errors = [];
  const seen = new Set();
  for (const { id } of defs) {
    if (seen.has(id) || referencedIds.has(id)) continue;
    seen.add(id);
    errors.push({ message:
      `${docPath}: named anchor "{#${id}}" is orphaned — no backlog codifiedIn, no doc link, no #${id} ` +
      `mention references it. Cite it from the decision(s) it codifies, or remove the dead anchor.` });
  }
  return errors;
}

// Which of `ids` are referenced in `texts` (an array of file bodies)? A reference is any `#id` occurrence
// NOT in the `{#id}` definition syntax. Pure string scan — cheap even over the full backlog.
function collectAnchorReferences(texts, ids) {
  const referenced = new Set();
  const corpus = texts.join('\n');
  for (const id of ids) {
    if (new RegExp(`(?<!\\{)#${id}(?![\\w-])`).test(corpus)) referenced.add(id);
  }
  return referenced;
}

// Locates the content behind an anchor: from its definition (explicit `{#id}`, slugged heading, or
// raw-HTML id) to the next heading line (or EOF). Returns `{ startLine, text }` (1-based `startLine`,
// normalized single-line `text`), or `null` when the anchor can't be located (the resolution gate
// reports that separately). Shared by `anchorSubstance` (a length) and the point-in-time claim lint
// below (which needs the text itself).
function locateAnchorBody(src, id) {
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(`{#${id}}`) || line.includes(`id="${id}"`) || line.includes(`id='${id}'`)) { start = i; break; }
    const hm = line.match(HEADING_LINE_RE_LOCAL);
    if (hm && githubSlugLocal(hm[2]) === id) { start = i; break; }
  }
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_LINE_RE_LOCAL.test(lines[i])) break;
    body.push(lines[i]);
  }
  // The anchor's own line counts too (inline anchors sit mid-paragraph), minus the marker itself.
  body.unshift(lines[start].replace(/\{#[\w-]+\}/g, '').replace(/^#{1,6}\s+/, ''));
  return { startLine: start + 1, text: body.join(' ').replace(/\s+/g, ' ').trim() };
}

// Normalized character count of the content behind an anchor. `null` when the anchor can't be located
// (the resolution gate reports that separately).
function anchorSubstance(src, id) {
  const located = locateAnchorBody(src, id);
  return located ? located.text.length : null;
}

const HEADING_LINE_RE_LOCAL = /^(#{1,6})\s+(.*)$/;
const { githubSlug: githubSlugLocal } = require('./rules-loader.cjs');

// Every CITED anchor must have substantive content behind it — a cite that resolves to a bare heading
// (or an empty span) is a rule that exists in name only. Threshold: the thinnest real cluster today is
// >200 normalized chars; 120 flags emptiness without ever brushing real statute prose.
function validateAnchorSubstance(anchorIndexSrc, cites, { minChars = 120 } = {}) {
  const errors = [];
  const checked = new Set();
  for (const { value } of cites) {
    const m = value.match(DOC_CITE_RE);
    if (!m) continue;
    const docPath = `docs/agent/${m[1]}.md`;
    const src = anchorIndexSrc[docPath];
    if (!src || checked.has(value)) continue;
    checked.add(value);
    const n = anchorSubstance(src, m[2]);
    if (n !== null && n < minChars)
      errors.push({ message:
        `${docPath}#${m[2]}: cited by codifiedIn but has only ${n} chars of content before the next ` +
        `heading — a rule in name only. Write the rule body at the anchor, or re-point the cite.` });
  }
  return errors;
}

// ── #2849 · AN UNCATALOGUED ANCHOR'S POINT-IN-TIME CLAIM MUST NAME ITS RETIRING OPEN ITEM ────────────────────────
//
// THE DRIFT THIS STOPS. An anchor body can carry an honest build-pending disclosure ("today the gate still
// parks…", "not yet enforced") that is true at the moment written and silently false once the mechanization it
// describes lands — exactly the "outstanding prevention" drift #2842/#2844 above were built to catch on the
// STATUS-CLAIM and INVARIANT-ENFORCER surfaces respectively. This rule catches the same drift on free-text
// PROSE: a temporal claim with no linked expiry rots into a wrong statement of current fact with nothing
// pointing back at it.
//
// SHAPE OF THE RULE, derived from #2854 Fork 1 = (a) ("build status lives on the decision item and the open
// guards; the anchor states only the timeless rule"), split by catalogue membership per that ruling's
// consequence table:
//   (i)  a CATALOGUED anchor — one an `invariants[].anchor` entry in `invariant-catalogue.json` points at —
//        already carries its build status machine-readably (`status`/`owedTo`, enforced by #2844's
//        `validateInvariantEnforcers` above). This rule does nothing new there; checking it again in prose
//        would just be a second, weaker copy of what #2844 already holds.
//   (ii) an UNCATALOGUED anchor's point-in-time token must be paired with an "until #NNNN" pointer naming the
//        OPEN item whose resolution retires the claim — the one retiring-item shape #2854 kept (narrower than
//        this item's original as-filed spec, which allowed any "name the item" phrasing). No pointer, or a
//        pointer at an item that isn't OPEN (dangling, resolved, dropped): ERROR, directing the author to
//        either register a catalogue entry (durable, machine-checked) or move the disclosure onto the item
//        itself (per #2854's ruling) instead of leaving free prose that can go stale unnoticed.
//
// TRANSITION GRANDFATHER. #2854 measured that this token list would hard-error the pre-existing corpus without
// an exemption list for anchors written before this lint shipped. `POINT_IN_TIME_EXEMPT_ANCHORS` is exactly
// that one-time list — it must only ever SHRINK (as those anchors are rewritten to (i) or (ii)), never grow: a
// newly written anchor earns no grandfathering.
//
// DELIBERATELY OUT OF SCOPE, for the same reason #2844's scope note gives: no attempt to heuristically classify
// which prose "sounds temporal" beyond the fixed token list — a broader heuristic is exactly the kind of
// classifier this file's own #2844 note measured as unreliable (5 false positives on a first pass). Authors
// opt in by writing one of the fixed tokens.

const POINT_IN_TIME_TOKENS = ['today', 'not yet', 'build-pending', 'still parks'];
const POINT_IN_TIME_RE = new RegExp(`\\b(${POINT_IN_TIME_TOKENS.join('|')})\\b`, 'i');
const UNTIL_OPEN_ITEM_RE = /\buntil\s+#(\d+)/i;
const UNTIL_OPEN_ITEM_RE_GLOBAL = /\buntil\s+#(\d+)/gi;

// The one-time transition grandfather (#2854 Fork 1 = (a); #2849). Every id below is an explicit `{#id}`
// anchor in docs/agent/platform-decisions.md that already carried a point-in-time token before this lint
// shipped and has not yet been rewritten per the shape above. Shrinks over time; never grows.
const POINT_IN_TIME_EXEMPT_ANCHORS = new Set([
  'constellation-placement', 'relocation-granularity', 'backlog-tracking-locus-now-distributed-next',
  'non-verdict-conformance-matcher', 'portfolio-project-tiering', 'plug-distribution-unit',
  'native-first-baseline', 'forward-emit-dedicated-ir', 'standard-consumability',
  'webrouting-runtime-route-ingestion', 'first-party-dogfood', 'vocabulary-completeness-early',
  'merge-risk-optimistic-with-targeted-lock', 'pr-flow-rollout-mechanism',
  'operations-declared-once-callers-generated', 'conveyor-dispatch-calls-the-declared-operation',
  'state-lives-where-its-nature-dictates', 'deterministic-oracle-clears-slice',
  'human-is-principle-surface-not-path', 'enforce-flip-triple-gated', 'memory-admission-verified-grounding',
  'statute-anchor-states-rule-not-status', 'size-adds-reviewers-never-refuses',
  'every-pr-gets-a-look-advisory-floor', 'heavy-command-admission-queue',
  'agent-mutations-through-typed-operations', 'registry-name-guard-namespace',
  'ci-lifecycle-total-label-function',
  // 'anchor' is not a real anchor — it is `collectExplicitAnchorDefs` matching a LITERAL `{#anchor}` example
  // inside backticks (docs/agent/platform-decisions.md:3760, illustrating the `### … {#anchor}` heading
  // syntax generically). Fixing that requires making the shared anchor-def collector backtick-aware, which
  // is #2083's scope, not this lint's — grandfathered here rather than papered over with a narrower regex.
  'anchor',
]);

// The "until #NNNN" pointer must sit within this many characters of the TOKEN OCCURRENCE it retires — a
// fixed char-distance bound, not a sentence-boundary heuristic. A sentence splitter was tried first and a
// red-team broke it (an under-split on a lowercase-starting continuation sentence silently merges two
// unrelated clauses into one "sentence", so a pointer that retires a DIFFERENT claim reads as covering
// this one — the exact failure the guard exists to prevent). A raw character window has no such failure
// mode: it is pure arithmetic, not a classification that can misfire. 60 is picked with headroom on both
// sides of the real corpus: every fixture pairing in this file sits within ~15 chars, and the adversarial
// unrelated-clause case found in review ("Today this still needs manual review. See #4200 for the
// tracking grooming, filed until #4300 sweeps the backlog.") puts its pointer ~84 chars from the token —
// outside this window, so it correctly reads as ungrounded. Mirrors the same-clause-adjacency techniques
// #2842 already uses above for cite-status attribution (its CLAIM_B_WINDOW, tuned the same way).
const POINT_IN_TIME_WINDOW = 60;

/**
 * The anchor ids in `docPath` that a catalogue entry already points at — #2849's "cataloged, so exempt"
 * half. Pure, and exercised directly (not just incidentally through `runStatuteCheck`'s real-corpus pass),
 * per build-brief discipline: an integration test must exercise the real call path, not only the isolated
 * `findPointInTimeClaims` unit.
 * @param {Array<object>} invariants - the `invariants` array from invariant-catalogue.json.
 * @param {string} docPath - the doc whose anchors to collect (e.g. docs/agent/platform-decisions.md).
 * @returns {Set<string>}
 */
function collectCatalogedAnchorIds(invariants, docPath) {
  return new Set(
    (invariants || [])
      .map((inv) => (inv && typeof inv.anchor === 'string' ? inv.anchor.trim().match(DOC_CITE_RE) : null))
      .filter((m) => m && `docs/agent/${m[1]}.md` === docPath)
      .map((m) => m[2]),
  );
}

const POINT_IN_TIME_RE_GLOBAL = new RegExp(`\\b(${POINT_IN_TIME_TOKENS.join('|')})\\b`, 'gi');

/**
 * #2849 — an uncatalogued anchor's point-in-time claim must name the OPEN item that retires it. The
 * "until #NNNN" pointer must sit within `POINT_IN_TIME_WINDOW` characters of the TOKEN OCCURRENCE it
 * retires — a pointer elsewhere in a multi-claim anchor body must not silently retire a claim it was
 * never written to cover (found in review: a body mixing an unrelated "#4300" mention with its own live
 * "today" disclosure must not read as covered by the other clause's pointer). Pure + injectable
 * (`isOpenItem`), so the whole rule is fixture-testable without the real tree.
 * @param {string} src - the statute doc source (docs/agent/platform-decisions.md).
 * @param {string} docPath - that doc's path, for the message.
 * @param {{catalogedAnchorIds?: Set<string>, exemptAnchorIds?: Set<string>, isOpenItem: (id:string)=>boolean}} deps
 * @returns {Array<{message:string}>}
 */
function findPointInTimeClaims(src, docPath, { catalogedAnchorIds = new Set(), exemptAnchorIds = new Set(), isOpenItem } = {}) {
  const errors = [];
  const seen = new Set();
  for (const { id } of collectExplicitAnchorDefs(src)) {
    if (seen.has(id) || catalogedAnchorIds.has(id)) continue;
    seen.add(id);
    const located = locateAnchorBody(src, id);
    if (!located) continue;
    const text = located.text;

    // Every "until #NNNN" pointer in the whole body, found ONCE and reused for every token occurrence — a
    // per-token slice-then-match would find the FIRST pointer inside the slice rather than the CLOSEST one
    // to that specific token, wrongly crediting an earlier, unrelated pointer to a later claim whenever two
    // tokens' windows overlap. Nearest-by-distance instead, the same "nearest, not leftmost" guard #2842
    // already applies above for cite-status attribution.
    const untilPointers = [...text.matchAll(UNTIL_OPEN_ITEM_RE_GLOBAL)];

    const matchedTokens = new Set();
    let missingPointer = false;
    const danglingCites = [];
    for (const m of text.matchAll(POINT_IN_TIME_RE_GLOBAL)) {
      matchedTokens.add(m[0].toLowerCase());
      let nearest = null;
      let nearestDist = Infinity;
      for (const u of untilPointers) {
        const dist = u.index < m.index ? m.index - (u.index + u[0].length) : u.index - (m.index + m[0].length);
        if (Math.max(dist, 0) < nearestDist) { nearestDist = Math.max(dist, 0); nearest = u; }
      }
      if (!nearest || nearestDist > POINT_IN_TIME_WINDOW) { missingPointer = true; continue; }
      if (isOpenItem(nearest[1])) continue; // a live, nearby retiring pointer — the narrow escape #2854 kept
      danglingCites.push(nearest[1]); // a pointer exists but names a dead item — collect ALL, not just the last
    }
    if (!matchedTokens.size) continue; // no point-in-time language in this anchor at all

    if (danglingCites.length) {
      const cites = [...new Set(danglingCites)];
      errors.push({ message:
        `${docPath}:${located.startLine}: anchor "{#${id}}" points a point-in-time claim at ${cites
          .map((c) => `"until #${c}"`).join(', ')}, but ${cites.length > 1 ? 'none of those are' : `#${cites[0]} is not`} ` +
        `an OPEN backlog item — a resolved/dropped/absent item retires nothing. Edit ${docPath}:${located.startLine} ` +
        '— point "until #NNNN" at a live item, or resolve the claim per #2854 (catalogue entry, or move it onto ' +
        'the item).' });
      continue;
    }
    if (!missingPointer) continue; // every token occurrence paired with a live, nearby pointer
    if (exemptAnchorIds.has(id)) continue; // pre-existing — grandfathered by the #2849 transition list

    errors.push({ message:
      `${docPath}:${located.startLine}: anchor "{#${id}}" makes a point-in-time claim (${[...matchedTokens]
        .map((t) => `"${t}"`).join(', ')}) with no linked open item retiring it nearby. Edit ` +
      `${docPath}:${located.startLine} — either register an invariant-catalogue.json entry (#2844) naming this ` +
      'anchor and its real status, or say "until #NNNN" (naming the OPEN item whose resolution retires the ' +
      `claim) within ${POINT_IN_TIME_WINDOW} chars of the claim, or move the disclosure out of the anchor onto ` +
      'that item (#2854: build status lives on the decision item, not the timeless rule).' });
  }
  return errors;
}

// ── #2844 · AN OPERATIONAL-INVARIANT ANCHOR MUST LINK AN ENFORCER ───────────────────────────────────────────────
//
// THE DRIFT THIS STOPS. The rules above police the anchor↔cite edges of the statute: a cite that 404s, a
// duplicate id, a dead anchor, an anchor with no prose. None of them ask the question that actually matters for
// an OPERATIONAL invariant — a runtime guarantee, as opposed to a design principle: *is there code that holds
// it?* A ratified invariant that names no enforcer reads as guaranteed while nothing enforces it, which is
// strictly worse than not claiming it, because every downstream rule composes on top of the claim. #2844's own
// cluster is the live example: `#fix-review-convergence-independent-root-cause` asserted a non-author bar whose
// enforcement was, in its own words, "build-pending".
//
// WHERE THE SUBJECTS LIVE. The repo's operational invariants are registered in
// `we:scripts/lib/invariant-catalogue.json` — one entry per guarantee, each with a `howChecked` naming the
// mechanism and a `status` saying whether that mechanism is real. That file, not the statute prose, is the
// machine-readable surface, so the gate binds THERE: every entry must LINK AN ENFORCER, which is exactly
// #2844's requirement ("an enforcing code path OR an open item that will build it").
//
// THE TWO WAYS TO SATISFY IT, and nothing else:
//   1. `howChecked` names a code path that EXISTS in this repo. Existence is the whole point — a `howChecked`
//      pointing at a file that was renamed or deleted is precisely the "asserted but unenforced" state, and it
//      is the failure this gate catches that no amount of prose review reliably does.
//   2. `owedTo` names a backlog item that is still OPEN. This is the honest escape for a guarantee the repo has
//      ruled but not yet built — it does not pretend the invariant is enforced, it records who owes it. A
//      RESOLVED item does not count: "we shipped the item that was going to build this" plus no code is the
//      drift, not the exit from it.
// An optional `anchor` may point the entry at the statute cluster it realizes; when present it must RESOLVE in
// the /rules/-rendered docs, reusing the same anchor index the cite gate uses — so the invariant→anchor link
// cannot rot silently either.
//
// SCOPE, stated so nobody re-derives it: this gate does NOT try to classify statute PROSE as operational or not.
// A heuristic over ~117 clusters ("does this paragraph sound like a runtime guarantee?") is a coin toss — it was
// measured at 5 false positives on the first pass — and a gate that cries wolf gets suppressed. Registering an
// invariant in the catalogue is the deliberate act that opts it into enforcement, and that registration is what
// the gate makes non-negotiable once made.

// A repo-relative-looking file path mentioned in prose: at least one directory segment, a known code/doc
// extension, and no leading protocol. Trailing `:lines` (a `foo.mjs:772-789` cite) is deliberately tolerated —
// it names the same file.
const ENFORCER_PATH_RE = /(?:^|[\s(`"'[])((?:\.?[\w-]+\/)+[\w.-]+\.(?:mjs|cjs|js|ts|json|md))(?::\d+(?:-\d+)?)?/g;

/** Every distinct file path a `howChecked` mentions. Pure. */
function collectEnforcerPaths(howChecked) {
  return [...new Set([...String(howChecked || '').matchAll(ENFORCER_PATH_RE)].map((m) => m[1]))];
}

/**
 * The candidate on-disk locations for a cited enforcer path. `.claude/skills/<x>` is a SYMLINK into the tracked
 * `skills-src/<x>`, so it resolves locally but not necessarily in a fresh checkout — cite either and the gate
 * accepts, checking the tracked source as well as the linked view. Pure (returns strings; the caller does the fs).
 */
function enforcerPathCandidates(p) {
  const alt = p.replace(/^\.claude\/skills\//, 'skills-src/');
  return alt === p ? [p] : [p, alt];
}

/**
 * #2844 — every registered operational invariant LINKS AN ENFORCER. Pure + injectable (`exists`, `isOpenItem`,
 * `anchorIndex`), so the whole rule is fixture-testable without touching the real repo.
 * @param {Array<object>} invariants - the `invariants` array from the catalogue.
 * @param {{exists:(p:string)=>boolean, isOpenItem:(id:string)=>boolean, anchorIndex?:object}} deps
 * @returns {Array<{message:string}>}
 */
function validateInvariantEnforcers(invariants, { exists, isOpenItem, anchorIndex = null } = {}) {
  const errors = [];
  const CAT = 'scripts/lib/invariant-catalogue.json';
  for (const inv of Array.isArray(invariants) ? invariants : []) {
    const id = (inv && inv.id) || '(unnamed entry)';
    const howChecked = (inv && typeof inv.howChecked === 'string') ? inv.howChecked.trim() : '';

    // The `anchor` back-link, when the entry carries one, must resolve like any other cite.
    if (inv && typeof inv.anchor === 'string' && inv.anchor.trim()) {
      const m = inv.anchor.trim().match(DOC_CITE_RE);
      if (!m) {
        errors.push({ message:
          `${CAT}: invariant "${id}" has anchor "${inv.anchor}", which is not a well-formed ` +
          'docs/agent/<doc>.md#<anchor> cite.' });
      } else if (anchorIndex) {
        const docPath = `docs/agent/${m[1]}.md`;
        const set = anchorIndex[docPath];
        if (!set) {
          errors.push({ message:
            `${CAT}: invariant "${id}" anchors to "${docPath}", which is not one of the /rules/-rendered ` +
            'governance docs.' });
        } else if (!set.has(m[2])) {
          errors.push({ message:
            `${CAT}: invariant "${id}" anchors to "#${m[2]}", which does not resolve in ${docPath} — the ` +
            'heading was renamed or removed; update the anchor or restore it.' });
        }
      }
    }

    if (!howChecked) {
      errors.push({ message:
        `${CAT}: invariant "${id}" has an empty howChecked — an operational invariant must name the mechanism ` +
        'that holds it (#2844). Name the enforcing code path, or add owedTo: "<open item>".' });
      continue;
    }

    const cited = collectEnforcerPaths(howChecked);
    const live = cited.filter((p) => enforcerPathCandidates(p).some((c) => exists(c)));
    if (live.length) continue; // (1) satisfied — a real enforcer exists on disk

    const owedTo = (inv && typeof inv.owedTo === 'string') ? inv.owedTo.trim().replace(/^#/, '') : '';
    if (owedTo && isOpenItem(owedTo)) continue; // (2) satisfied — the enforcement is owed, and owed to a LIVE item

    // Neither. Say which of the two exits is missing rather than just "invalid" — the fix differs completely.
    const detail = cited.length
      ? `its howChecked names ${cited.map((p) => `"${p}"`).join(', ')}, and none of those exist in this repo ` +
        '(renamed? deleted? — this is the invariant reading as enforced while nothing holds it)'
      : 'its howChecked names no code path at all';
    const owedDetail = owedTo
      ? ` Its owedTo "#${owedTo}" is not an OPEN backlog item — a resolved/absent item is not an owed enforcer.`
      : '';
    errors.push({ message:
      `${CAT}: invariant "${id}" links no enforcer — ${detail}.${owedDetail} #2844: an operational invariant ` +
      'must link an enforcing code path that EXISTS, or an owedTo naming an OPEN backlog item that will build it.' });
  }
  return errors;
}

/** Every backlog item's real frontmatter `status`, keyed by NNN AND by bornAs hash. Reads the backlog dir;
 *  the pure rules above/below take the resulting lookup injected. (#2842 widened this from the live/not-live
 *  Set below to the actual value — the status word is what a prose status claim has to be checked against.) */
function collectItemStatuses(backlogDir) {
  const statuses = new Map();
  for (const name of fs.readdirSync(backlogDir)) {
    if (!name.endsWith('.md')) continue;
    const fm = (fs.readFileSync(path.join(backlogDir, name), 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    const status = (fm.match(/^status:\s*["']?([\w-]+)/m) || [])[1];
    if (!status) continue;
    const num = (name.match(/^(\d+)-/) || [])[1];
    if (num) statuses.set(num, status);
    const born = (fm.match(/^bornAs:\s*["']?([\w-]+)/m) || [])[1];
    if (born) statuses.set(born, status);
  }
  return statuses;
}

/** The backlog item ids that are still LIVE (any status other than resolved/dropped), by NNN and by bornAs hash.
 *  A thin derivation over `collectItemStatuses`; the pure rule above takes the resulting predicate injected. */
function collectOpenItemIds(backlogDir) {
  const open = new Set();
  for (const [id, status] of collectItemStatuses(backlogDir)) {
    if (status === 'resolved' || status === 'closed' || status === 'dropped') continue;
    open.add(id);
  }
  return open;
}

// ── #2842 · A STATUS CLAIM ABOUT A CITED #NNN MUST MATCH THAT ITEM'S REAL STATUS ──────────────────────────────
//
// THE DRIFT THIS STOPS. Statute prose annotates its cites with the cited item's settledness — `(#2398, resolved
// — …)`, "#2785 is `status: open`", "owed on the **OPEN** line (#2840/#2785)". Nothing holds those annotations
// true: the claim goes false the day the cited item's status changes, and no reader of the statute can tell. The
// drift is not hypothetical — six sentences in platform-decisions.md asserted #2785/#2840 were OPEN months after
// both resolved, and downstream rules composed on top of "not yet live".
//
// WHAT COUNTS AS A CLAIM — the tight grammar, chosen by measurement, not argument. A LOOSE grammar (any status
// word within ~60 chars of a cite) was prototyped first: 52–124 candidates, ~75–95% false positives. It fires on
// "`open→active→resolved` backlog flow" (a state machine), on "closed scored axes + open findings" (a noun), on
// "without --session a scaffolded item is born `status: open`" (a mechanism, not the nearby cite). A gate that is
// three-quarters noise gets suppressed — the same reasoning #2844's scope note above records for not classifying
// statute prose heuristically. The TIGHT grammar below — the CITE ITSELF carries the status token — measured 0
// false positives at every tuning tried. Only that ships. Three patterns:
//
//   A — ADJACENT PARENTHETICAL. `#NNNN` then `,` or `(`, an optional hedge, then a bare status word.
//   B — EXPLICIT `status:` TOKEN. `#NNNN` … a copula (`is`/`are`/`stays`/`remains`/`still`) … `` `status: X` ``,
//       within a short same-line adjacency.
//   C — A DELIBERATE UPPERCASE `OPEN` governing the cite run that immediately follows it. Every cite in that run
//       must be non-`resolved` and non-`dropped`.
//
// THREE GUARDS, each found by prototyping against the live corpus; guards 1 and 2 each have a real line that goes
// wrong without them, so neither is decorative:
//   1. `(?![-\w])` after the status word. Without it `#086 (open-core constellation)` is a false positive —
//      "open" matched inside "open-core".
//   2. C's run stops at the CLAUSE BOUNDARY, not a flat character budget. A 120-char window swept #2851 into
//      "owed on the OPEN items #2840/#2785, tracked as outstanding preventions on #2851" — the OPEN claim governs
//      the slash-run, not the trailing attribution. But the boundary is the END OF THE GOVERNED PARENTHETICAL,
//      not the first punctuation mark: a naive `[^,;.)]` stop drops #2785 out of "(#2840 — …; #2785 — …)" and
//      under-reports.
//   3. B binds the NEAREST PRECEDING cite, not the leftmost. "**#2771**'s implementation **#2785** is
//      `status: open`" — a left-to-right scan attributes the claim to #2771 and would go SILENT on real drift the
//      moment the two cites' statuses differ. So B anchors on the `` `status: X` `` token and scans BACKWARDS.
//   (2 and 3 are both the attribution-precision class #2861 owns.)
//
// DELIBERATELY OUT OF SCOPE: soft precedent framing with no status word — `precedent #840/#844/#477`,
// `#1163 (golden precedent)`. Nearly all of the statute's 28 "precedent" uses are lineage lists making no
// settledness claim; hard-erroring them means judging whether a lineage cite ASSERTS settledness, which is the
// coin toss this rule refuses to make. The rule binds the claims that are WRITTEN DOWN; authors opt in by
// writing the annotation.
//
// BLAST RADIUS, accepted deliberately. This rule fails `check:standards` REPO-WIDE on a change nobody made to
// the doc: the moment a cited item's status flips, every unrelated commit is blocked until someone edits the
// statute. That is the rule working — but it turns a routine `/resolve` into a stop-the-line for an author who
// has never read this file. THEREFORE EVERY MESSAGE NAMES THE EXACT DOC LINE TO EDIT, twice: once as the
// `path:line` prefix, once in the fix clause. That requirement is load-bearing, not a nicety — without it the
// gate is the classic one that gets suppressed.

const CLAIM_STATUS_WORDS = ['open', 'active', 'resolved', 'closed', 'dropped', 'parked'];
// A — the cite itself carries the status word: `#2398, resolved`, `#1073 (open, to slice)`. The trailing
// `(?![-\w])` is guard 1 (`#086 (open-core …)` must not match).
const CLAIM_A_RE = new RegExp(
  String.raw`#(\d+)\s*[,(]\s*(?:(?:still|now|already)\s+)?(${CLAIM_STATUS_WORDS.join('|')})(?![-\w])`, 'g');
// B — the explicit backticked token. Matched first, then attributed BACKWARDS (guard 3).
const CLAIM_B_TOKEN_RE = /`status:\s*([\w-]+)`/g;
// The copula must ASSERT the token, i.e. sit directly on it (optionally through a hedge). Measured: a copula
// merely present somewhere in the lookback is the LOOSE grammar wearing a disguise — it re-admits both real
// corpus false positives, `(#670).** Without --session a scaffolded item IS BORN `status: open`` and
// `(… #083) — not by git. A racing agent IS DETECTED by the item reading `status: active``, where the token
// describes a MECHANISM and the nearby cite is not its subject.
const CLAIM_B_COPULA_RE = /\b(?:is|are|stays|remains|still)\b(?:\s+(?:now|still|already|currently|only))?\s*$/;
// …and the claim must be in the SAME SENTENCE as the cite it is attributed to. Both false positives above also
// cross a sentence end between the cite and the token; this is the second, independent half of that guard.
const CLAIM_B_SENTENCE_END_RE = /[.!?](?:[\s*)"']|$)/;
const CLAIM_B_WINDOW = 100;   // chars of same-line lookback; the widest real claim spans ~58
const CLAIM_B_LAST_CITE_RE = /#(\d+)(?![\d])/g;
// C — a DELIBERATE uppercase OPEN (case-sensitive on purpose: a lowercase "open" is ordinary prose).
const CLAIM_C_TOKEN_RE = /\bOPEN\b/g;
// …followed, within a short same-clause gap, by either a parenthetical or a bare slash-run of cites.
const CLAIM_C_GAP_RE = /^([^,;.#()\n]{0,60})([#(])/;
const CLAIM_C_SLASH_RUN_RE = /^#\d+(?:\s*\/\s*#\d+)*/;
const LIVE_STATUSES_NOTE = 'non-resolved / non-dropped';

/** All `#NNNN` ids inside a run of text, in order. Pure. */
function citesIn(text) {
  return [...String(text).matchAll(/#(\d+)/g)].map((m) => m[1]);
}

/**
 * The text pattern C's `OPEN` token governs: the parenthetical or slash-run that directly follows it (guard 2).
 * `null` when no cite run follows within the clause. Pure — exported for the fixture tests.
 * @param {string} rest - the line text AFTER the OPEN token.
 */
function citeRunAfterOpen(rest) {
  const gap = rest.match(CLAIM_C_GAP_RE);
  if (!gap) return null;
  const at = gap[1].length;
  if (rest[at] === '(') {
    // Boundary = the end of the GOVERNED PARENTHETICAL, so an inner `;` or `,` does not truncate the run.
    let depth = 0;
    for (let i = at; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') { depth--; if (depth === 0) return rest.slice(at + 1, i); }
    }
    return rest.slice(at + 1); // unterminated parenthetical — take the rest of the line
  }
  const run = rest.slice(at).match(CLAIM_C_SLASH_RUN_RE);
  return run ? run[0] : null;
}

/**
 * #2842 — an explicit status claim about a cited #NNN must match that item's real status. Pure + injectable
 * (`statusOf`), so the whole rule is fixture-testable without the real tree.
 * @param {Record<string,string>} srcByDoc - doc path → source text (the four RULE_DOCS).
 * @param {{statusOf: (nnn: string) => (string|null)}} deps - real frontmatter status, or null when no item exists.
 * @returns {Array<{message: string}>}
 */
function validateCitedItemStatusClaims(srcByDoc, { statusOf } = {}) {
  const errors = [];
  const seen = new Set();

  // Every message names the doc line to edit TWICE — prefix and fix clause. See the blast-radius note above.
  const push = (docPath, lineNo, cite, detail, fix) => {
    const key = `${docPath}|${lineNo}|${cite}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({ message:
      `${docPath}:${lineNo}: ${detail} Edit ${docPath}:${lineNo} — ${fix} (#2842: a status claim about a cited ` +
      'item must match that item\'s real frontmatter status.)' });
  };

  const check = (docPath, lineNo, cite, claimed, quoted) => {
    const real = statusOf ? statusOf(cite) : null;
    if (real === null || real === undefined) {
      push(docPath, lineNo, cite, `the prose claims #${cite} is ${quoted}, but there is no backlog item #${cite} ` +
        'at all — the cite is DANGLING.',
      'point the claim at a real item, or drop it');
      return;
    }
    if (real !== claimed) {
      push(docPath, lineNo, cite, `the prose claims #${cite} is ${quoted}, but #${cite} is really ` +
        `\`status: ${real}\`.`,
      `update the annotation to "${real}", or re-point the cite at an item that really is \`status: ${claimed}\``);
    }
  };

  for (const [docPath, src] of Object.entries(srcByDoc || {})) {
    String(src).split('\n').forEach((line, i) => {
      const lineNo = i + 1;

      // A — the cite carries the status word adjacently.
      for (const m of line.matchAll(CLAIM_A_RE)) check(docPath, lineNo, m[1], m[2], `\`${m[2]}\``);

      // B — the backticked `status: X` token, attributed BACKWARDS to the NEAREST preceding cite (guard 3).
      for (const m of line.matchAll(CLAIM_B_TOKEN_RE)) {
        const at = m.index;
        const window = line.slice(Math.max(0, at - CLAIM_B_WINDOW), at);
        const cites = [...window.matchAll(CLAIM_B_LAST_CITE_RE)];
        if (!cites.length) continue;
        const nearest = cites[cites.length - 1];
        const between = window.slice(nearest.index + nearest[0].length);
        if (CLAIM_B_SENTENCE_END_RE.test(between)) continue;   // different sentence — the cite is not the subject
        if (!CLAIM_B_COPULA_RE.test(between)) continue;        // no assertion — a bare mention, not a claim
        check(docPath, lineNo, nearest[1], m[1], `\`status: ${m[1]}\``);
      }

      // C — a deliberate uppercase OPEN governing the cite run right after it; every cite in the run must be live.
      for (const m of line.matchAll(CLAIM_C_TOKEN_RE)) {
        const run = citeRunAfterOpen(line.slice(m.index + m[0].length));
        if (run === null) continue;
        for (const cite of citesIn(run)) {
          const real = statusOf ? statusOf(cite) : null;
          if (real === null || real === undefined) {
            push(docPath, lineNo, cite, `an uppercase "OPEN" claim governs #${cite}, but there is no backlog ` +
              `item #${cite} at all — the cite is DANGLING.`,
            'point the claim at a real item, or drop it');
            continue;
          }
          if (real === 'resolved' || real === 'dropped')
            push(docPath, lineNo, cite, `an uppercase "OPEN" claim governs #${cite}, but #${cite} is ` +
              `\`status: ${real}\` — a ${real} item is not on an OPEN line.`,
            `drop the OPEN framing, or name only items that are still ${LIVE_STATUSES_NOTE}`);
        }
      }
    });
  }
  return errors;
}

// The full statute check (#2083) — fs gather + the four pure rules. Returns { errors, warnings } in the
// check-standards shape. Duplicates/orphans are scoped to platform-decisions.md's NAMED (`{#id}`) anchors;
// resolution (validateRulesAnchors) + substance cover all four /rules/-rendered docs. #2844 adds the
// invariant-catalogue enforcer-link rule, which binds the machine-readable invariant surface rather than prose.
function runStatuteCheck() {
  const statutePath = 'docs/agent/platform-decisions.md';
  const statuteSrc = fs.readFileSync(path.join(ROOT, statutePath), 'utf8');
  const cites = collectCodifiedCites(path.join(ROOT, 'backlog'));

  const errors = [];
  errors.push(...validateRulesAnchors(buildAnchorIndex(), cites).errors);

  const defs = collectExplicitAnchorDefs(statuteSrc);
  errors.push(...findDuplicateAnchors(defs, statutePath));

  // Reference corpus for the orphan rule: every backlog body + every docs/agent doc (the statute doc
  // itself included — in-doc `(#id)` links count; its `{#id}` definitions don't, per the lookbehind).
  const texts = [];
  for (const dir of ['backlog', path.join('docs', 'agent')]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.md')) texts.push(fs.readFileSync(path.join(ROOT, dir, name), 'utf8'));
    }
  }
  errors.push(...findOrphanAnchors(defs, collectAnchorReferences(texts, new Set(defs.map((d) => d.id))), statutePath));

  const srcByDoc = {};
  for (const doc of RULE_DOCS) srcByDoc[doc.file] = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
  errors.push(...validateAnchorSubstance(srcByDoc, cites));

  // #2844 — every registered operational invariant links an enforcer that exists, or an open item that owes it.
  const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'invariant-catalogue.json'), 'utf8'));
  const itemStatuses = collectItemStatuses(path.join(ROOT, 'backlog'));
  const openIds = collectOpenItemIds(path.join(ROOT, 'backlog'));
  errors.push(...validateInvariantEnforcers(catalogue.invariants, {
    exists: (p) => fs.existsSync(path.join(ROOT, p)),
    isOpenItem: (id) => openIds.has(id),
    anchorIndex: buildAnchorIndex(),
  }));

  // #2842 — an explicit status claim about a cited #NNN must match that item's real status. Reuses the
  // `srcByDoc` map the substance rule already built, so this costs no extra file reads.
  errors.push(...validateCitedItemStatusClaims(srcByDoc, {
    statusOf: (nnn) => (itemStatuses.has(nnn) ? itemStatuses.get(nnn) : null),
  }));

  // #2849 — an uncatalogued anchor's point-in-time claim must name the OPEN item that retires it (#2854
  // Fork 1 = (a)). A catalogued anchor is exempt — #2844 above already binds its status machine-readably.
  errors.push(...findPointInTimeClaims(statuteSrc, statutePath, {
    catalogedAnchorIds: collectCatalogedAnchorIds(catalogue.invariants, statutePath),
    exemptAnchorIds: POINT_IN_TIME_EXEMPT_ANCHORS,
    isOpenItem: (id) => openIds.has(id),
  }));

  return { errors, warnings: [] };
}

module.exports = {
  validateRulesAnchors, buildAnchorIndex, collectCodifiedCites,
  collectExplicitAnchorDefs, findDuplicateAnchors, findOrphanAnchors, collectAnchorReferences,
  anchorSubstance, validateAnchorSubstance, runStatuteCheck,
  collectEnforcerPaths, enforcerPathCandidates, validateInvariantEnforcers, collectOpenItemIds,
  collectItemStatuses, validateCitedItemStatusClaims, citeRunAfterOpen,
  locateAnchorBody, findPointInTimeClaims, POINT_IN_TIME_TOKENS, POINT_IN_TIME_EXEMPT_ANCHORS,
  collectCatalogedAnchorIds,
};
