#!/usr/bin/env node
/**
 * @file scripts/review-corpus/gates.mjs
 * @description Candidate deterministic gates, written as PURE functions so the replay harness can score
 * them against the mined review corpus before any of them is wired into `check:standards`.
 *
 * Each gate is `(text, ctx) => Finding[]`, where `ctx` gives read access to OTHER files at the same
 * revision (`ctx.read(path) -> string|null`, `ctx.exists(path) -> boolean`, `ctx.list(glob) -> string[]`).
 * Nothing here touches the working tree, the network, or `process`; the harness supplies a reader bound
 * to one commit, so a gate can be replayed at any historical revision.
 *
 * THE BAR THESE ARE BEING SCORED AGAINST (declared before the run, per the experiment design): a gate
 * ships only if it catches >=80% of its own labelled class in the corpus AND fires zero times where no
 * reviewer found anything. A gate that needs judgment to interpret its output has already failed — the
 * whole point is to take a class of finding away from the reviewer, not to give it more to read.
 */

import { ACCEPTANCE_HEADING_RE } from '../backlog/task-agreement.mjs';

/**
 * @typedef {object} Finding
 * @property {string} gate the gate's name.
 * @property {string} path the file the gate fired on.
 * @property {number} line the 1-based line it fired at.
 * @property {string} message what is wrong, in the gate's own words.
 * @property {string} subject THE FIELD THE DEFAULT SCORER DEPENDS ON — the needle, slug, id, path or
 *   locus the gate actually fired on. `covers()` in `replay-gates.mjs` runs in `content` mode by default
 *   and matches a hit to a label by looking for this string inside the reviewer's own description of the
 *   finding. It must be a real substring of the source, and at least 3 characters: `covers()` returns
 *   false at `subject.length < 3`, so a gate that omits it scores a structural zero against every label,
 *   silently. `__tests__/gates.test.mjs` asserts every gate here emits one.
 *
 * RETRACTED — this typedef used to read *`{{gate:string, path:string, line:number, message:string}}`*,
 * omitting `subject` entirely. That was wrong, and wrong in the way that matters: all eight gates below
 * already emit `subject`, and the default matcher is unusable without it, so the documented shape was a
 * shape no gate has and no gate may have. A ninth gate written to it would have scored 0 with no error
 * and no failing test.
 */

/** The acceptance heading at any level: the shared task-agreement reader's rule (`## Acceptance` or its
 *  legacy alias, #5399 S7), plus the hyphenated legacy spelling this gate has always tolerated. */
const isAcceptanceHeading = (title) => ACCEPTANCE_HEADING_RE.test(title) || /^done-when\b/i.test(title);

/** Slice a markdown body to its acceptance section (to the next heading of any level). */
export function doneWhenSection(text) {
  if (typeof text !== 'string') return null;
  const m = [...text.matchAll(/^#+[ \t]*(.*)$/gm)].find((h) => isAcceptanceHeading(h[1].trim()));
  if (!m) return null;
  const start = m.index;
  const after = text.slice(start + m[0].length);
  const next = after.search(/^#+\s+\S/m);
  const body = next === -1 ? after : after.slice(0, next);
  return { start, body, startLine: text.slice(0, start).split('\n').length };
}

/** Line number (1-based) of a character offset within `text`. */
function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/** Read frontmatter as raw text (between the first two `---` fences). */
export function frontmatter(text) {
  const m = typeof text === 'string' && text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ G5a */

/**
 * A card flipped to `status: resolved` while its Done-when still carries the scaffold's `TODO:`
 * placeholder. The card claims an executable proof it never wrote.
 * Labelled by: PR #1516, `backlog/3240-…md` (goal-completeness, degraded).
 */
export function resolvedWithTodo(text, { path } = {}) {
  if (!/^backlog\//.test(path || '')) return [];
  const fm = frontmatter(text);
  if (!fm || !/^status:\s*resolved\s*$/m.test(fm)) return [];
  const dw = doneWhenSection(text);
  if (!dw) return [];
  const idx = dw.body.indexOf('TODO:');
  if (idx === -1) return [];
  return [{
    gate: 'resolved-with-todo',
    path,
    line: dw.startLine + dw.body.slice(0, idx).split('\n').length - 1,
    subject: 'TODO',
    message: 'status: resolved, but Done-when still holds the scaffold TODO: placeholder — no executable proof was ever written.',
  }];
}

/* ------------------------------------------------------------------ G5b */

/**
 * An acceptance criterion that hardcodes a live gate's absolute error/warning count. The count drifts
 * with every unrelated commit, so the criterion is stale the moment it is written; the repo's own
 * practice is delta-relative phrasing ("warnings unchanged from baseline").
 * Labelled by: PR #1556, `backlog/3230-…md` (acceptance-criteria-accuracy, degraded).
 */
export function staleGateCount(text, { path } = {}) {
  if (!/^backlog\//.test(path || '')) return [];
  const dw = doneWhenSection(text);
  if (!dw) return [];
  const out = [];
  // The count and its unit may be joined by whitespace OR a hyphen — the repo's own phrasing is
  // "the 0-error / 1435-warning baseline", which a `\s+` form silently misses.
  const rx = /\b(\d{1,5})[\s-]+(warnings?|errors?)\b/gi;
  for (const m of dw.body.matchAll(rx)) {
    // "0 errors" is a delta-free absolute that is legitimately stable — the gate is meant to hold at zero.
    if (m[1] === '0' && /error/i.test(m[2])) continue;
    out.push({
      gate: 'stale-gate-count',
      path,
      line: dw.startLine + lineOf(dw.body, m.index) - 1,
      subject: m[1],
      message: `Done-when hardcodes the absolute count "${m[0]}" as a target; it drifts with unrelated commits. Phrase it as a delta instead.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ G5c */

/**
 * A `[[wikilink]]` in the agent-memory corpus that resolves to no memory file. `check-memory.mjs`
 * already validates `](file.md)` links and `- N.` index references; it does not look at wikilinks.
 * Labelled by: PR #1559, `agent-memory-src/full-concurrency-…md:37` (broken-reference, degraded).
 */
export function danglingWikilink(text, { path, list } = {}) {
  if (!/^agent-memory-src\//.test(path || '')) return [];
  const corpus = (list ? list('agent-memory-src/') : []).map((p) => p.split('/').pop().replace(/\.md$/, ''));
  if (!corpus.length) return [];
  // A memory file resolves by full slug, or by its leading number, or by the slug with a numeric prefix.
  const resolves = (slug) => corpus.some((c) => c === slug
    || c.replace(/^\d+-/, '') === slug.replace(/^\d+-/, '')
    || c.replace(/^\d+-/, '').replace(/_/g, '-') === slug.replace(/^\d+-/, '').replace(/_/g, '-'));
  const out = [];
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const slug = m[1].trim();
    if (resolves(slug)) continue;
    out.push({
      gate: 'dangling-wikilink',
      path,
      line: lineOf(text, m.index),
      subject: slug,
      message: `[[${slug}]] resolves to no file in the memory corpus.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ G5d */

/**
 * A `#xNNNNNN` hash-slug backlog reference in card prose that exists nowhere. The existing citation
 * scan resolves `parent`/`blockedBy`/`we:` loci; it does not resolve hash ids appearing in body text.
 * Labelled by: PR #1509, `backlog/x4omld5-…md:27` (dangling-citation, degraded) — `#x2sqf62`.
 */
export function danglingHashId(text, { path, knownHashIds } = {}) {
  if (!/^backlog\//.test(path || '')) return [];
  // The resolvable-id set is supplied by the caller, which collects it once per revision: the
  // `xNNNNNN-` filename form plus every `bornAs:` a JIT-numbered card kept. Resolving it per card here
  // would be a `git show` per backlog file per case.
  const known = typeof knownHashIds === 'function' ? knownHashIds() : null;
  if (!known || !known.size) return [];
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(/#(x[0-9a-z]{6,7})\b/g)) {
    const id = m[1];
    if (known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      gate: 'dangling-hash-id',
      path,
      line: lineOf(text, m.index),
      subject: id,
      message: `#${id} resolves to no backlog card (by filename or bornAs).`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ G2 */

/**
 * An acceptance criterion written as a literal grep, checked by ACTUALLY RUNNING IT against the file it
 * names at this revision. Catches criteria typed from memory: markup the author forgot (`**bold**`,
 * backticks), a capitalisation difference, or a claimed "returns nothing today" that already has hits.
 * Labelled by: PR #1560, `backlog/3147-…md` lines 100/102/107 (correctness / acceptance-criteria-accuracy).
 *
 * Recognised shapes, all requiring a quoted needle and a named path in the same criterion:
 *   grep … 'NEEDLE' … <path>            |  grepping <path> for `NEEDLE`
 *   `NEEDLE` … occurs N times in <path> |  … "returns nothing" / "no hits" in <path>
 */
/**
 * Split a Done-when body into its numbered criteria, each carrying its continuation lines. A criterion
 * routinely wraps across three or four physical lines with the path on one and the claim on the next, so
 * a per-line scan sees neither half — that is a real defect this gate had on its first replay.
 * @returns {{text:string, line:number}[]} criterion text and its 1-based offset within the section.
 */
export function doneWhenCriteria(body) {
  const lines = body.split('\n');
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:\d+\.|[-*+][ \t]+\[A\d+\])\s+/i.test(lines[i])) {
      if (cur) out.push(cur);
      cur = { text: lines[i], line: i };
    } else if (cur && lines[i].trim() !== '') {
      cur.text += `\n${lines[i]}`;
    } else if (cur && lines[i].trim() === '') {
      out.push(cur); cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Backticked runs in a criterion that are plausible grep NEEDLES rather than the path being grepped. */
export function candidateNeedles(criterion) {
  const all = [...criterion.matchAll(/`{1,2}([^`]{3,160})`{1,2}/g)].map((m) => m[1].trim());
  return all.filter((n) => !/^(?:we:|fui:|plateau:)?[\w.@-]+(?:\/[\w.@-]+)+$/.test(n) // a bare path
    && !/^(?:we:|fui:|plateau:)?[\w.@-]+(?:\/[\w.@-]+)+:\d+/.test(n)                  // a path:line locus
    && !/^npm run /.test(n));
}

/**
 * @see grepLiteralMismatch — operates per CRITERION (not per physical line), and picks the needle from
 * the backticked runs that are not the path being grepped.
 */
export function grepLiteralMismatch(text, { path, read } = {}) {
  if (!/^backlog\//.test(path || '') || typeof read !== 'function') return [];
  const dw = doneWhenSection(text);
  if (!dw) return [];
  const out = [];
  for (const crit of doneWhenCriteria(dw.body)) {
    const target = crit.text.match(/\b((?:we:)?[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|md|js|ts|json|njk))\b/);
    if (!target) continue;
    const rel = target[1].replace(/^we:/, '');
    const body = read(rel);
    if (body == null) continue;
    const needles = candidateNeedles(crit.text);
    if (!needles.length) continue;
    // Markdown emphasis inside a needle is authoring noise, not source text; compare on both the literal
    // and its de-emphasised form, because "matches with the bold stripped" is exactly the drift here.
    const plain = (s) => s.replace(/\*\*/g, '').replace(/`/g, '');
    const line = dw.startLine + crit.line;
    for (const needle of needles) {
      const hits = body.split('\n').filter((l) => l.includes(needle)).length;
      const hitsPlain = body.split('\n').filter((l) => plain(l).includes(plain(needle))).length;
      const claimsNone = /\breturns? nothing\b|\bno hits\b|\bzero (?:hits|matches|times)\b|\bmatches \*{0,2}zero\b/i.test(crit.text);
      // A line REFERENCE is not an occurrence COUNT. Without the lookbehind, "at lines 251 and 279"
      // and "the line-77 mention" are read as claims that the needle occurs 251 or 77 times — which
      // is how this gate produced a confidently wrong message on card #3147 in its first replay.
      const countClaim = crit.text.match(/\b(?:occurs|occurrences?|appears|count[^.]{0,20}?from)\D{0,24}?(?<!\blines?[- ])(\d+)\b/i);
      if (claimsNone && hits > 0) {
        out.push({ gate: 'grep-literal-mismatch', path, line, subject: needle, message: `Criterion says "${needle}" is absent from ${rel}, but it has ${hits} hit(s) at this revision.` });
      } else if (!claimsNone && hits === 0 && hitsPlain > 0) {
        out.push({ gate: 'grep-literal-mismatch', path, line, subject: needle, message: `Criterion cites the literal "${needle}" in ${rel}; it occurs only with different markup (${hitsPlain} hit(s) once bold/backticks are stripped). A literal grep for it matches nothing.` });
      } else if (countClaim && hits > 0 && Number(countClaim[1]) !== hits) {
        out.push({ gate: 'grep-literal-mismatch', path, line, subject: needle, message: `Criterion states a count of ${countClaim[1]} for "${needle}" in ${rel}; it occurs ${hits}×.` });
      }
    }
  }
  return out;
}

/**
 * A test-runner invocation under a NAME FILTER, as written in a criterion: `vitest … -t <pattern>` or
 * `--testNamePattern`. The filter is what makes the run an empty selection when no test matches.
 */
const NAME_FILTERED_RUN_RX = /\b(?:npx\s+|pnpm\s+|yarn\s+|npm\s+(?:run\s+\S+\s+--\s+)?)?(?:vitest|jest)\b[^\n`]*?(\s-t[= ]\s*[^\s`]+|\s--testNamePattern[= ]\s*[^\s`]+)/;

/**
 * Does the criterion assert, downstream of its command, that tests actually RAN? The repo's convention
 * is `| grep -qE "Tests +[0-9]+ passed"`; a stated pass count in prose, or `--passWithNoTests=false`,
 * says the same thing. Deliberately GENEROUS: a criterion that already carries any such assertion is
 * correct, and a gate that flags correct criteria gets routed around, after which it protects nothing.
 */
function assertsTestsRan(criterion) {
  return /(?:^|[^\w[])\d+\+?\s*(?:tests?\s+)?pass(?:ed|ing)\b/i.test(criterion)      // "Tests  3 passed"
    || /\b(?:grep|rg|ripgrep)\b[\s\S]{0,120}?pass(?:ed|ing)/i.test(criterion)         // "| grep -qE \"… passed\""
    || /--passWithNoTests[= ]*false/i.test(criterion)                                 // the runner flag itself
    || /\bnon-?zero\s+pass\b/i.test(criterion);
}

/**
 * An "Executable" acceptance criterion that ALREADY holds before the change — a criterion that would
 * pass while the work sat untouched, so it proves nothing. Card #3147's own round-2 revision names this
 * defect in its own words: *"a criterion that would have 'passed' while the prose sat untouched."*
 * Labelled by: PR #1560 `backlog/3147-…md:100` (correctness, broken).
 *
 * THE GENERAL RULE, of which the shapes below are instances: **a criterion is vacuous when its success
 * is independent of the work.** Two instances are modelled here, and more will follow — when the next
 * one turns up it belongs in this function as a third predicate, not on a new card:
 *
 *   1. ABSENCE — "grepping <file> for <literal> returns zero hits", where the literal already matches
 *      zero times at this revision. The criterion is green before anyone starts.
 *   2. EMPTY SELECTION — a test-runner invocation under a name filter (`vitest … -t "#NNNN"`) with no
 *      downstream assertion that tests ran. A filter matching nothing is a selection of ZERO, and
 *      vitest exits **0** on an empty selection, so the command is green on a tree where the test does
 *      not exist yet. The fix, and the positive example this gate must let through, is the repo's
 *      convention: `| grep -qE "Tests +[0-9]+ passed"`. Specimen: the pre-fix #3319 criterion, quoted
 *      verbatim in `backlog/3340-…md` and pinned as a case in `__tests__/gates.test.mjs`. (The two
 *      commits that introduced and fixed it never landed on `main`, so the card text — not a sha — is
 *      the fixture.)
 *
 * The two predicates are independent: a criterion can trip either, or both.
 */
export function vacuousExecutableCriterion(text, { path, read } = {}) {
  if (!/^backlog\//.test(path || '') || typeof read !== 'function') return [];
  const dw = doneWhenSection(text);
  if (!dw) return [];
  const out = [];
  for (const crit of doneWhenCriteria(dw.body)) {
    if (!/\*\*Executable\*\*/.test(crit.text)) continue;
    const line = dw.startLine + crit.line;

    /* --- shape 1: the literal is already absent ------------------------------------------------ */
    const demandsAbsence = /returns? \*{0,2}zero\*{0,2} hits|\bis gone\b|\bno longer (?:appears|occurs)\b|returns? nothing/i.test(crit.text);
    const target = crit.text.match(/\b((?:we:)?[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|md|js|ts|json|njk))\b/);
    if (demandsAbsence && target) {
      const rel = target[1].replace(/^we:/, '');
      const body = read(rel);
      if (body != null) {
        for (const needle of candidateNeedles(crit.text)) {
          if (body.includes(needle)) continue; // the literal is present, so demanding its absence is real work
          out.push({
            gate: 'vacuous-executable-criterion',
            path,
            line,
            subject: needle,
            message: `Executable criterion demands "${needle}" be absent from ${rel}, but it already matches zero times at this revision — the criterion passes without the work being done.`,
          });
        }
      }
    }

    /* --- shape 2: the test selection is already empty ------------------------------------------ */
    const filtered = crit.text.match(NAME_FILTERED_RUN_RX);
    if (filtered && !assertsTestsRan(crit.text)) {
      const subject = filtered[1].trim();
      out.push({
        gate: 'vacuous-executable-criterion',
        path,
        line,
        subject,
        message: `Executable criterion runs a test suite under the name filter \`${subject}\` and asserts nothing about the result. A filter matching no test is a selection of zero, and the runner exits 0 on it — so the criterion is green before the test exists. Assert that tests ran, e.g. \`| grep -qE "Tests +[0-9]+ passed"\`.`,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ G5e */

/**
 * `scope:` must cover every file the card's own Done-when requires touching. A Done-when naming a test
 * file the scope omits is a slice that cannot be built inside its declared scope.
 * Labelled by: PR #1560, `backlog/3147-…md:11` (coverage, degraded).
 */
export function scopeOmitsDoneWhenFile(text, { path } = {}) {
  if (!/^backlog\//.test(path || '')) return [];
  const fm = frontmatter(text);
  if (!fm) return [];
  const scopeBlock = fm.match(/^scope:\n((?:\s+-\s+.*\n?)+)/m);
  if (!scopeBlock) return [];
  const scopes = [...scopeBlock[1].matchAll(/-\s+(\S+)/g)].map((m) => m[1].replace(/^we:/, '').replace(/["']/g, ''));
  const dw = doneWhenSection(text);
  if (!dw) return [];
  const covered = (p) => scopes.some((s) => (s.endsWith('/') ? p.startsWith(s) : p === s));
  const out = [];
  const seen = new Set();
  for (const m of dw.body.matchAll(/\b((?:we:)?[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|js|ts|md|njk))\b/g)) {
    const rel = m[1].replace(/^we:/, '');
    if (seen.has(rel) || covered(rel)) continue;
    // Only repo-internal, plausibly-editable paths — a card may legitimately cite a doc it does not edit.
    if (!/^(scripts|skills-src|blocks|plugs|src|docs|agent-memory-src)\//.test(rel)) continue;
    seen.add(rel);
    out.push({
      gate: 'scope-omits-donewhen-file',
      path,
      line: dw.startLine + lineOf(dw.body, m.index) - 1,
      subject: rel,
      message: `Done-when requires touching ${rel}, which the card's scope: does not cover.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ G1 */

/**
 * A `we:<path>:<line>` citation whose named symbol is not at that line. The existing gate
 * (`findDanglingLoci`, `we:scripts/lib/citation-check.mjs`) proves the file exists and the line is in
 * range — it never looks at what is ON the line. This closes that gap: when the prose around a locus
 * names an identifier in backticks, that identifier must appear within `window` lines of the citation.
 * Labelled by: PR #1556, `backlog/3233-…md:227` and `:158` (citation-accuracy / citation-precision).
 */
export function citationLineContent(text, { path, read, window = 4 } = {}) {
  if (typeof read !== 'function') return [];
  const out = [];
  const rx = /\bwe:([A-Za-z0-9._\-/]+\/[A-Za-z0-9._-]+):(\d+)\b/g;
  for (const m of text.matchAll(rx)) {
    const [full, rel, lineStr] = m;
    const body = read(rel);
    if (body == null) continue;
    const lines = body.split('\n');
    const n = Number(lineStr);
    if (n < 1 || n > lines.length) continue; // out-of-range is the existing gate's job
    // Identifiers named in backticks within the same sentence as the citation.
    const sentence = sentenceAround(text, m.index);
    const idents = [...sentence.matchAll(/`([A-Za-z_$][\w$]{2,})`/g)].map((x) => x[1])
      .filter((id) => !/^(we|fui|plateau|true|false|null|undefined|const|function|return)$/.test(id));
    if (!idents.length) continue;
    const lo = Math.max(0, n - 1 - window);
    const hi = Math.min(lines.length, n + window);
    const near = lines.slice(lo, hi).join('\n');
    // Only fire when the identifier exists in the file but NOT near the cited line — that is drift.
    // An identifier absent from the whole file is a different defect (a stale name), left to the
    // existing unresolved-identifier scan so this gate keeps one job.
    const drifted = idents.filter((id) => !near.includes(id) && body.includes(id));
    if (!drifted.length) continue;
    const trueLine = lines.findIndex((l) => l.includes(drifted[0])) + 1;
    out.push({
      gate: 'citation-line-content',
      path,
      line: lineOf(text, m.index),
      subject: `${rel}:${lineStr}`,
      message: `${full} is cited alongside \`${drifted[0]}\`, which is not within ${window} lines of ${n}${trueLine ? ` (nearest occurrence: line ${trueLine})` : ''}.`,
    });
  }
  return out;
}

function sentenceAround(text, offset) {
  // Split on a sentence-ending period — one followed by whitespace or end — NOT on any period. A naive
  // `.` split cuts inside `pr-land.mjs:574`, so the identifier the citation is about falls outside the
  // "sentence" and the gate goes silent. That single bug is why citation-line-content matched none of
  // its own labelled findings on the first replay while still firing eight times elsewhere.
  const before = text.slice(0, offset);
  const startCandidates = [
    0,
    ...[...before.matchAll(/\.\s/g)].map((m) => m.index + m[0].length),
    before.lastIndexOf('\n') + 1,
  ];
  const start = Math.max(...startCandidates);
  const after = text.slice(offset);
  const endM = after.match(/\.\s|\n/);
  const end = endM ? offset + endM.index + 1 : text.length;
  return text.slice(start, end);
}

/* ------------------------------------------------------------------ G3 (#3341) */

/**
 * MECHANISM VERBS, in the third-person singular ONLY. The `-s` restriction is not stylistic: it is the
 * whole prescription filter. A modal takes the BARE form ("must derive", "should read", "will resolve"),
 * so requiring `-s` excludes every "what this card wants built" sentence without a modal blocklist. It
 * also disambiguates the many stems that are equally nouns — "the `pr-land` call" reads `call` as a noun,
 * "`pr-land` calls" cannot.
 */
const MECHANISM_VERBS = [
  'derives', 'computes', 'reads', 'calls', 'invokes', 'scores', 'resolves', 'parses', 'queries',
  'fetches', 'filters', 'narrows', 'matches', 'strips', 'greps', 'delegates', 'dispatches', 'emits',
  'writes', 'passes', 'sends', 'loads', 'spawns', 'scans', 'applies', 'maps', 'sets', 'returns',
];

/** Adverbs allowed to sit between the module subject and its verb. Anything else breaks the subject bond. */
const SUBJECT_ADVERBS = '(?:already|still|now|only|silently|always|never|then|also|itself|deliberately|currently|explicitly|actually|simply|just|therefore|instead)';

const MECHANISM_VERB_RX = new RegExp(
  `^(?:\\s+${SUBJECT_ADVERBS})*\\s+(?:(?:does|did)\\s+not\\s+(\\w+)|(${MECHANISM_VERBS.join('|')}))\\b`,
  'i',
);

/**
 * Is `w` the BARE form of a mechanism verb, as it appears after a negating auxiliary ("does not pass")?
 * Spelled as three inflections rather than by de-suffixing the list: de-suffixing turns `parses` into
 * `pars` and `passes` into `pass` by the same rule, so one of the two is always wrong.
 */
const isMechanismStem = (w) => MECHANISM_VERBS.some((v) => v === `${w}s` || v === `${w}es` || v === w.replace(/y$/, 'ies'));

/** A `path:line` locus — the strongest citation, and the only one the sibling gate can then check. */
const LOCUS_RX = /(?:^|[\s`([])(?:we:|fui:|plateau:)?[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|js|ts|md|njk|json|css|html):\d+/;

/** A bare path with no line — the archetype's own non-citation, so it must NOT count as one. */
const BARE_PATH_RX = /^(?:we:|fui:|plateau:)?[\w.@-]+(?:\/[\w.@-]+)+(?::\d+)?$/;

/**
 * Strip everything that is not the card's OWN assertion about the CURRENT tree: frontmatter, fenced code,
 * headings, table rows, the Done-when section, and — the one that matters most — blockquoted lines.
 *
 * Two of those exclusions are load-bearing rather than tidying:
 *   - BLOCKQUOTES. This repo's retraction convention is to QUOTE the wrong sentence and then correct it,
 *     so a gate that fired inside `>` blocks would punish exactly the practice this card exists to
 *     reinforce — and would fire on `backlog/3343-…md`, the very card whose revision is the fixed form.
 *   - DONE-WHEN. A criterion describes the tree AFTER the work ("a subsequent `X` still reads it"), so a
 *     present-tense verb there is a prescription wearing an indicative's clothes. Measured, not assumed:
 *     leaving the section in added 5 findings to the sweep across `backlog/`, 4 of which were false.
 *
 * Excluded lines are replaced by blank ones rather than dropped, so line numbers stay true AND an
 * excluded line still terminates the sentence either side of it.
 */
export function ownProseLines(text) {
  const lines = text.split('\n');
  const out = new Array(lines.length).fill('');
  let inFence = false;
  let fmEnd = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i += 1) if (lines[i] === '---') { fmEnd = i; break; }
  }
  const dw = doneWhenSection(text);
  const dwFrom = dw ? dw.startLine - 1 : Infinity;
  const dwTo = dw ? dwFrom + dw.body.split('\n').length : -1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (i <= fmEnd) continue;
    if (/^\s*(?:```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (i >= dwFrom && i <= dwTo) continue;
    if (/^\s*>/.test(l)) continue;      // quoted / retracted material, not this card's claim
    if (/^\s*#{1,6}\s/.test(l)) continue;
    if (/^\s*\|/.test(l)) continue;     // table rows are evidence grids, not sentences
    out[i] = l;
  }
  return out;
}

/**
 * Split prose into sentences, carrying each one's 1-based start and end line.
 *
 * Inline-code runs are MASKED before the split, not after: a `.` or `?` inside `` `pr-land.mjs` `` or
 * `` `typeof flags.transport === 'string' ?` `` is not a sentence end, and splitting there strands the
 * citation outside the sentence it belongs to — which is how this gate flagged a card that quoted the
 * source on the same line.
 */
function sentencesWithLines(lines) {
  const text = lines.join('\n');
  const masked = text.replace(/`{1,2}[^`\n]{0,400}`{1,2}/g, (m) => ' '.repeat(m.length));
  const out = [];
  let start = 0;
  const push = (end) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) out.push({ text: raw, line: lineOf(text, start + lead), endLine: lineOf(text, end - 1) });
    start = end;
  };
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if ((c === '.' || c === '!' || c === '?') && (i + 1 >= masked.length || /\s/.test(masked[i + 1]))) push(i + 1);
    else if (c === '\n' && masked[i + 1] === '\n') push(i + 1);
  }
  push(masked.length);
  return out;
}

/**
 * Line indexes (0-based) whose sentence is immediately followed by a fenced code block. The block IS the
 * citation — "`X` spawns the label CLI with an explicit `cwd`:" followed by the quoted source is the
 * behaviour this gate wants, not the behaviour it flags.
 */
function fenceIntroLines(text) {
  const lines = text.split('\n');
  const out = new Set();
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*(?:```|~~~)/.test(lines[i])) continue;
    if (inFence) { inFence = false; continue; }
    inFence = true;
    for (let j = i - 1; j >= 0 && j >= i - 3; j -= 1) {
      if (lines[j].trim()) { out.add(j); break; }
    }
  }
  return out;
}

/** A determiner or quantifier before a bare module STEM makes it an attributive noun — "multiple
 * dispatch-lane calls" is a count of calls, not a claim that dispatch-lane calls anything. */
const ATTRIBUTIVE_RX = /\b(?:the|a|an|its|their|his|her|our|this|that|these|those|each|every|any|some|no|other|another|multiple|several|many|few|two|three|four|five|both|all|per|one)\s+$/i;

/** Verb readings that are not invocations of a mechanism at all — naming, describing, characterising. */
const NON_MECHANISM_PHRASE_RX = /^(?:reads\s+as|calls\s+(?:out|for|that|this)|maps\s+onto|passes\s+\d)/i;

/** Every module path this card names — its `scope:` plus every `we:`/bare locus in the body. */
function namedModules(text) {
  const paths = new Set();
  const fm = frontmatter(text) || '';
  for (const m of fm.matchAll(/(?:we:)?((?:scripts|skills-src|blocks|plugs|src|docs|agent-memory-src|tools|hooks)\/[\w.@/-]+\.\w+)/g)) paths.add(m[1]);
  for (const m of text.matchAll(/\bwe:([\w.@-]+(?:\/[\w.@-]+)+\.\w+)/g)) paths.add(m[1]);
  return [...paths];
}

/**
 * Does this sentence carry EVIDENCE for the mechanism it asserts? Deliberately GENEROUS — the gate asks
 * *where is your evidence*, never *is your evidence right*. Whether the cited line says what the sentence
 * claims is `citation-line-content`'s job above and, past that, a review convention the card says is not
 * gateable at all. A gate that also judged the narrative would be a detector whose real aperture is
 * invisible from its name (#3340).
 */
function carriesCitation(sentence, moduleSource, introducesFence) {
  if (introducesFence) return true;                               // the quoted block below IS the citation
  if (LOCUS_RX.test(sentence)) return true;                       // path:line
  if (/\blines?\s+\d+/i.test(sentence)) return true;              // "at line 839"
  if (/\b[a-z][a-z0-9]*[A-Z][\w$]*\b/.test(sentence.replace(/`[^`]*`/g, ''))) return true; // bare camelCase symbol
  for (const m of sentence.matchAll(/`{1,2}([^`]{3,200})`{1,2}/g)) {
    const run = m[1].trim();
    if (BARE_PATH_RX.test(run)) continue;                         // the subject itself is not its evidence
    if (/[a-z][A-Z]|_|\(\)|\(\s*\w/.test(run)) return true;       // a named function / identifier
    if (moduleSource && run.length >= 4 && moduleSource.includes(run)) return true; // a literal that appears
  }
  // A straight or curly quotation that is VERBATIM in the module — the card's third accepted form.
  if (moduleSource) {
    for (const m of sentence.matchAll(/["“]([^"“”]{6,240})["”]/g)) {
      if (moduleSource.includes(m[1].trim())) return true;
    }
  }
  return false;
}

/**
 * An UNCITED MECHANISM CLAIM: a sentence whose subject is a repo module the card itself names, whose verb
 * asserts how that module behaves, and which points at nothing a reader can open.
 *
 * WHERE THIS CAME FROM. `backlog/3343-…md` opened *"pr-land derives the review label from GitHub's
 * three-dot file list"* and concluded the producer-side derivation *"did not get the same treatment"* as
 * the review side. Both false, the second exactly backwards: the code scores off a local computation, and
 * the basis has been merge-base-narrowed since #2404 with a named regression test. The symptom was real;
 * the mechanism was invented, and it cost a build round. Nothing in the repo asked the author to open the
 * file — `citation-line-content` only fires on citations that EXIST.
 *
 * WHAT THIS GATE SCANS AND WHAT IT MATCHES (stated this way on purpose — #3362): it scans the prose of
 * files under `backlog/`, minus frontmatter, fenced code, headings, table rows and blockquotes, and it
 * matches a sentence in which a module reference is followed — across whitespace and a closed list of
 * adverbs only — by one of the third-person-singular verbs in `MECHANISM_VERBS` (or its bare form under
 * a negating auxiliary), with no `path:line`, no named function and no verbatim source literal anywhere
 * in that sentence. It does not claim to find every uncited mechanism claim, and the exclusions below are
 * deliberate. Swept over `backlog/` at 3336 cards it produced 17 findings, adjudicated on the card.
 *
 * DELIBERATELY OUT OF SCOPE:
 *   - A STATE claim — "X is slow", "X is broken", "X has three callers". Not "does Y by Z", no mechanism
 *     to cite, and including it would turn the gate into noise on a 3300-card board.
 *   - A PRESCRIPTION — "X must derive", "X should read". Modals take the bare verb, so the `-s` form
 *     excludes them structurally rather than by blocklist.
 *   - A sentence whose SUBJECT is a function rather than a file — "`resolveNetDiffBasis` falls back to
 *     the base tip". Naming the function IS the locus; there is nothing further to cite.
 *   - The archetype's SECOND sentence, "the producer-side derivation … did not get the same treatment".
 *     That asserts a comparison, not a mechanism, and the verb that would catch it ("get") catches
 *     hundreds of ordinary sentences. Caught by the convention, not by this gate.
 *   - COMPLETENESS claims — "every X does Y". A citation is not their remedy, and they are #3362's.
 */
export function uncitedMechanismClaim(text, { path, read } = {}) {
  if (!/^backlog\//.test(path || '') || typeof read !== 'function') return [];
  // Read each named module ONCE. `carriesCitation` needs the source to judge a quoted literal, and it
  // runs per sentence per alias — an un-memoised `read` would be a file read per pair.
  const src = new Map();
  const modules = namedModules(text).filter((p) => {
    const body = read(p);
    if (body == null) return false;
    src.set(p, body);
    return true;
  });
  if (!modules.length) return [];
  // Address each module by every form the prose uses for it: full locus, bare path, basename, and the
  // basename with its extension dropped — "pr-land", which is how the archetype named it.
  const aliases = [];
  for (const rel of modules) {
    const base = rel.split('/').pop();
    const stem = base.replace(/\.\w+$/, '');
    aliases.push({ rel, form: `we:${rel}` }, { rel, form: rel }, { rel, form: base });
    if (stem.length >= 4 && /[-_]/.test(stem)) aliases.push({ rel, form: stem });
  }
  aliases.sort((a, b) => b.form.length - a.form.length);

  const out = [];
  const seen = new Set();
  const fenceIntro = fenceIntroLines(text);
  for (const s of sentencesWithLines(ownProseLines(text))) {
    if (/^\s*(?:if|whether|suppose|were)\b/i.test(s.text)) continue; // hypothetical, not an assertion
    const introducesFence = fenceIntro.has(s.endLine - 1);
    for (const { rel, form } of aliases) {
      let idx = -1;
      const needle = form;
      const bareStem = !/[/.]/.test(form);
      for (let from = 0; ; ) {
        idx = s.text.indexOf(needle, from);
        if (idx === -1) break;
        from = idx + needle.length;
        const before = s.text[idx - 1];
        if (before && /[\w./:-]/.test(before)) continue;           // mid-word or mid-path
        if (bareStem && ATTRIBUTIVE_RX.test(s.text.slice(0, idx))) continue;
        const after = s.text.slice(idx + needle.length).replace(/^`+/, '');
        const vm = after.match(MECHANISM_VERB_RX);
        if (!vm) continue;
        if (vm[1] && !isMechanismStem(vm[1].toLowerCase())) continue;  // "does not <non-verb>"
        const verbWord = vm[2] || vm[1];
        if (NON_MECHANISM_PHRASE_RX.test(after.slice(vm[0].length - verbWord.length))) continue;
        if (carriesCitation(s.text, src.get(rel), introducesFence)) { idx = -2; break; }
        const key = `${s.line}:${rel}`;
        if (seen.has(key)) { idx = -2; break; }
        seen.add(key);
        out.push({
          gate: 'uncited-mechanism-claim',
          path,
          line: s.line,
          subject: form.length >= 3 ? form : rel,
          message: `"${form}${vm[0].replace(/\s+/g, ' ')}…" asserts how ${rel} behaves and cites nothing — no path:line, no named function, no quoted source. Open the file and cite the line, or drop the mechanism and keep the symptom.`,
        });
        idx = -2;
        break;
      }
      if (idx === -2) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ G4 (#3362) */

/**
 * THE CLASSES OF THING A CHECK SCANS — the set a completeness claim quantifies over. Checkers
 * themselves (`gate`, `check`, `sweep`, `test`, `guard`) are deliberately ABSENT: *"all gates are pure
 * functions"* is a claim about the checkers, not about what they cover, and admitting them would make
 * every sentence about this file's own registry a finding.
 *
 * `branch` is absent for a different reason, and it was measured: in this repo the word means a DECISION
 * fork or a code path, never a scan candidate, and admitting it produced three of the sweep's false
 * positives at once — two spellings of *"no branch is broken"* (the fork-existence test) and one
 * *"every branch is string equality"* about the arms of a function.
 *
 * `finding` is absent for the same measured reason: in this repo it is an element of a review VERDICT,
 * and *"every finding is resolved"* — the `prevention-outstanding` precondition, written out in
 * `we:scripts/lib/jury-core.mjs`, `we:scripts/lib/review-core.mjs` and `we:scripts/pr-status.mjs` — is a
 * state of the verdict, not a claim about what a scan reached. It accounted for six of the twenty script
 * hits in one phrase.
 */
const CANDIDATE_NOUNS = [
  'caller', 'callers', 'call site', 'call sites', 'callsite', 'callsites',
  'invocation', 'invocations', 'emitter', 'emitters', 'site', 'sites',
  'usage', 'usages', 'occurrence', 'occurrences', 'instance', 'instances',
  'reference', 'references', 'file', 'files', 'path', 'paths',
  'script', 'scripts', 'module', 'modules', 'card', 'cards', 'item', 'items',
  'doc', 'docs', 'commit', 'commits',
  'entry', 'entries', 'line', 'lines', 'symbol', 'symbols',
  'export', 'exports', 'import', 'imports', 'function', 'functions',
  'helper', 'helpers', 'rule', 'rules', 'claim', 'claims',
  'sentence', 'sentences', 'criterion', 'criteria', 'hook', 'hooks',
  'skill', 'skills', 'lane', 'lanes',
].sort((a, b) => b.length - a.length);

/**
 * The verb slot, in the third-person-singular AND the bare plural form. Both are needed here and the
 * `-s`-only trick #3341 uses cannot be borrowed: a universal subject is routinely plural (*"all callers
 * declare"*), so the bare form is the normal spelling rather than the modal's tell. Prescriptions are
 * excluded instead by the slot being a CLOSED list that contains no modal — *"every caller must
 * declare"* puts `must` in the slot and fails to match at all.
 *
 * `name`/`names` is deliberately NOT in the slot even though it reads as a coverage verb. It is the
 * second half of too many noun-noun compounds: *"no function name"* parses as `no` + `function` +
 * `name`, which flagged #3341's own card on a phrase that asserts nothing.
 */
const COVERAGE_VERBS = [
  'declares', 'declare', 'states', 'state', 'carries', 'carry', 'ships', 'ship',
  'cites', 'cite', 'has', 'have', 'is', 'are', 'gets', 'get',
  'records', 'record', 'includes', 'include', 'uses', 'use', 'sets', 'set',
  'emits', 'emit', 'reports', 'report', 'passes', 'pass', 'matches', 'match',
  'resolves', 'resolve', 'points', 'point', 'says', 'say', 'appears', 'appear',
  'lives', 'live', 'sits', 'sit', 'runs', 'run', 'goes', 'go', 'exists', 'exist',
  'checks', 'check', 'covers', 'cover', 'ends', 'end', 'reads', 'read',
  'writes', 'write', 'calls', 'call', 'takes', 'take', 'comes', 'come',
].sort((a, b) => b.length - a.length);

/** Adverbs allowed between the quantified noun and its verb. Anything else breaks the subject bond. */
const COVERAGE_ADVERBS = '(?:already|still|now|only|silently|always|never|then|also|itself|deliberately|currently|explicitly|actually|simply|just|therefore|thus|finally|correctly|properly)';

/** Function words that may not stand in the modifier slot — they end the noun phrase rather than modify it. */
const MODIFIER_STOP = '(?:this|that|these|those|the|a|an|its|their|our|it|we|you|other|such|of|in|on|at|for|from|with|by|to)';

/**
 * `every|all|no|none of the` + up to two adjectival modifiers + a candidate noun + a verb.
 *
 * `each` is deliberately NOT a quantifier here. It distributes over an enumerated set the reader can
 * see — *"each round shipped a sentence"* names four rows of a table — which is the honest form this
 * card is asking for, not the unbounded universal it is asking against.
 */
const COMPLETENESS_SUBJECT_RX = new RegExp(
  `\\b(every|all|no|none of the)\\s+`
  + `((?:(?!${MODIFIER_STOP}\\b)[a-z][\\w-]*\\s+){0,2})`
  + `(${CANDIDATE_NOUNS.join('|')})\\b`
  + `((?:\\s+${COVERAGE_ADVERBS})*)\\s+`
  + `(${COVERAGE_VERBS.join('|')})\\b`,
  'gi',
);

/**
 * The second shape: a check declaring itself the settled answer. Round 4 of PR #1609 shipped exactly
 * this — *"the sweep, not this comment, is now authoritative"* — beside a predicate that matched the
 * lander's path spelled without a repo prefix.
 */
const AUTHORITY_RX = /\b(?:is|are|was|were|remains?|becomes?|stays?)\s+(?:(?:now|still|already|therefore|thus|the|only|sole|itself)\s+){0,3}authoritative\b|\bthe\s+(?:\w+\s+){0,2}?authoritative\s+(?:source|list|sweep|check|scan|answer|record|set|account)\b/i;

/**
 * A checker noun. Required IN THE SUBJECT — the 48 characters before the word — not merely somewhere in
 * the sentence: it is the CHECK that must not call itself settled. Measured: the loose form flagged
 * *"the lane's own remote-tracking refs are authoritative"* (a claim about a data source) and a quoted
 * *"unreviewed content is authoritative on `main`"*, neither of which is a coverage claim.
 */
const CHECK_NOUN_RX = /\b(?:sweep|check|gate|guard|scan|harvest|lint|linter|validator|audit|detector|test|suite|grep|search|comment)\b/i;

/**
 * Vocabulary that makes a sentence a claim about VERIFICATION rather than about anything else. This is
 * the tightening that keeps the gate off a 3300-card board: *"every card carries a `bornAs`"* is an
 * ordinary universal and must not fire; *"every caller is covered"* is a coverage claim and must.
 */
const VERIFICATION_TERM_RX = /\b(?:check(?:s|ed|ing)?|gate(?:s|d)?|guard(?:s|ed|ing)?|sweep(?:s|ing)?|swept|scan(?:s|ned|ning)?|harvest(?:s|ed|ing)?|lint(?:s|er|ed)?|verif(?:y|ies|ied|ication)|coverage|covered|caught|catch(?:es)?|flagged|flagging|detect(?:s|ed|or|ion)?|audit(?:s|ed)?|validat(?:e|es|ed|ion|or)|enforce[sd]?|assert(?:s|ed|ion)?|prove[sn]?|proof|authoritative|complete(?:ness)?|exhaustive|miss(?:es|ed)?|grep(?:s|ped)?|test(?:s|ed)?|regression)\b/i;

/**
 * THE ESCAPE, and the half that stops the rule being satisfied by DELETING the sentence. A claim that
 * names what it scanned is the fixed form and must pass: a count, a harvest command, the tracked set,
 * the word `candidate`, a stated predicate, or a path/glob that bounds the search.
 *
 * Deliberately GENEROUS, on #3341's reasoning: the gate asks *what did you actually scan*, never *is
 * your scan wide enough*. A sentence naming a path as a citation rather than as a candidate set is let
 * through, and that is the intended trade — a gate that flags qualified sentences gets routed around,
 * and the routing-around costs more than the misses.
 *
 * THE BARE PATH ALTERNATIVE IS STRUCTURAL, not "any word slash word". PR #1649's review caught the
 * naive bare-slash pattern this used to be — one word, a slash, more word characters, nothing else —
 * matching ordinary English slash idioms: *"and/or"*, *"pass/fail"*, *"his/her"*, *"before/after"*. Any
 * of those silently exempted a genuine unqualified completeness claim carrying one of them from ever
 * being flagged (verified directly: those four variants, plus the unmodified control sentence, tested
 * against the old pattern). The trailing lookahead requires the run of path-like characters after the
 * first slash to contain a dot, digit, hyphen, or a second slash before it runs out — every real
 * path/glob in this repo has an extension, a hyphenated segment, more than one segment, or a digit, and
 * no plain two-word English slash idiom does. A bare two-segment path with no extension (`scripts/lib`)
 * no longer self-exempts on its own; that trades a false positive (an extra, correctable flag) for
 * closing a false negative (a missed completeness claim), which is the direction this gate exists to
 * protect.
 */
const NAMES_CANDIDATE_SET_RX = /\bcandidates?\b|\bgit\s+(?:grep|ls-files)\b|\bls-files\b|\btracked\s+(?:set|files|tree)\b|\bscans?\b|\bscanned\b|\bscanning\b|\bsweeps?\s+over\b|\bmatching\b|\bpredicate\b|\bof\s+the\s+\d+\b|\b\d\d+\s+[a-z]|`{1,2}[^`\n]*[/*][^`\n]*`{1,2}|\b[\w-]+\/(?=[\w.*/-]*[.\d/-])[\w.*/-]+/i;

/**
 * A hedge or a negator in front of the quantifier, which already concedes the claim is partial. The
 * lookback runs to the nearest clause boundary rather than the immediately preceding word, because the
 * honest disclaimer this must not punish puts a verb in between: `we:scripts/operations/__tests__/review-pr.test.mjs`
 * reads *"they do NOT prove that every caller passes `--careLevel`"*, which is this rule being FOLLOWED.
 * Flagging it would make deleting the sentence cheaper than keeping it — the exact failure the card names.
 */
const HEDGED_RX = /\b(?:not|never|n't|nor|without|hardly|barely|nearly|almost|virtually|perhaps|maybe)\b[^.;:!]{0,40}$/i;

/** A conditional or prescriptive frame EARLIER in the sentence demotes the universal to a wish. */
const PRESCRIPTIVE_FRAME_RX = /\b(?:if|whether|unless|until|once|when|suppose|assume[sd]?|must|should|shall|will|would|can|could|may|might|ought|aims?|intends?|wants?|so that|goal|target)\b/i;

/**
 * Straight and curly quotation spans within a sentence. A match inside one is a QUOTATION, not this
 * author's claim — the same exemption `ownProseLines` gives a markdown blockquote, and for the same
 * reason: this repo's retraction convention is to reproduce the wrong sentence and then correct it, so
 * firing inside quotes would punish exactly the practice the rule exists to reinforce.
 *
 * Newlines are INSIDE the span, not a terminator. A quoted ruling wraps — `backlog/3013-…md` quotes the
 * screen's merit split across two lines — and a `\n`-terminated span left the second half unquoted.
 */
function quotedSpans(sentence) {
  const out = [];
  for (const m of sentence.matchAll(/["“][^"“”]{4,600}["”]/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * Blank an `## Acceptance` / `## Acceptance criteria` / `## Criteria` section, on exactly the reasoning
 * `ownProseLines` already blanks Done-when for #3341: a criterion describes the tree AFTER the work, so
 * a present-tense universal there is a target, not a claim about what was scanned. Done LOCALLY rather
 * than inside `ownProseLines` so #3341's measured sweep is not perturbed by this card.
 *
 * The heading must be that phrase and nothing else. `backlog/2949-…md` is titled "Acceptance criteria on
 * items, written to be proven not judged"; a prefix match would blank the whole card.
 */
const CRITERIA_HEADING_RX = /^(#+)\s*(?:acceptance(?:\s+criteria)?|criteria|definition of done)\s*$/i;

function dropCriteriaSections(lines, text) {
  const raw = text.split('\n');
  const out = lines.slice();
  for (let i = 0; i < raw.length; i += 1) {
    const m = raw[i].match(CRITERIA_HEADING_RX);
    if (!m) continue;
    for (let j = i; j < raw.length; j += 1) {
      const h = raw[j].match(/^(#+)\s+\S/);
      if (j > i && h && h[1].length <= m[1].length) break;
      out[j] = '';
    }
  }
  return out;
}

/**
 * 0-based line indexes whose sentence ENDS on a line introducing a list. A sentence closing with `:` in
 * front of a bullet or numbered run names its candidate set in the rows below — *"Every upstream item is
 * still open, verified live:"* followed by the three items it checked is the qualified form, not the
 * overclaim. Same exemption, same reason, as `fenceIntroLines` above for #3341.
 */
function listIntroLines(text) {
  const raw = text.split('\n');
  const out = new Set();
  for (let i = 0; i < raw.length; i += 1) {
    if (!/[:：]\s*[*_`]*\s*$/.test(raw[i])) continue;
    for (let j = i + 1; j < raw.length && j <= i + 3; j += 1) {
      if (!raw[j].trim()) continue;
      if (/^\s*(?:[-*+]\s|\d+[.)]\s|\|)/.test(raw[j])) out.add(i);
      break;
    }
  }
  return out;
}

/**
 * Comment text only, from a JS/TS source, with every other line blanked so line numbers stay true.
 * Handles `/* … *\/` blocks and line-leading `//` runs. A `/*` inside a string or regex literal would
 * fool it; that is a heuristic limit of scanning comments without parsing, not a claim it cannot happen.
 */
export function commentLines(text) {
  const lines = text.split('\n');
  const out = new Array(lines.length).fill('');
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (inBlock) {
      const e = l.indexOf('*/');
      if (e === -1) { out[i] = l.replace(/^\s*\*+\s?/, ''); continue; }
      inBlock = false;
      out[i] = l.slice(0, e).replace(/^\s*\*+\s?/, '');
      continue;
    }
    const b = l.indexOf('/*');
    if (b !== -1) {
      const e = l.indexOf('*/', b + 2);
      if (e === -1) { inBlock = true; out[i] = l.slice(b + 2); } else out[i] = l.slice(b + 2, e);
      continue;
    }
    const s = l.match(/^\s*\/\/+\s?(.*)$/);
    if (s) out[i] = s[1];
  }
  return out;
}

/**
 * Blank any paragraph (a run of non-blank lines) that carries a retraction marker. A retraction
 * reproduces the sentence it is withdrawing, and in a comment there is no blockquote to mark it with.
 */
function dropRetractedParagraphs(lines) {
  const out = lines.slice();
  let i = 0;
  while (i < out.length) {
    if (!out[i].trim()) { i += 1; continue; }
    let j = i;
    while (j < out.length && out[j].trim()) j += 1;
    const para = out.slice(i, j).join('\n');
    if (/\bRETRACT(?:ED|ION|S)?\b/.test(para)) for (let k = i; k < j; k += 1) out[k] = '';
    i = j;
  }
  return out;
}

/**
 * AN UNQUALIFIED COMPLETENESS CLAIM: a sentence asserting that a check covers every case, that names no
 * candidate set the reader could check the claim against.
 *
 * WHERE THIS CAME FROM. PR #1609 (#3321) went five rounds. Every round found a real caller the previous
 * sweep had missed, and every round shipped a sentence larger than its code: round 2 *"every committed
 * landing invocation declares its verification posture"*, round 3 *"no emitter ships a landing invocation
 * that says nothing about verification"*, round 4 *"the sweep, not this comment, is now authoritative"*.
 * The guard improved each round; the claim was false each round. Round 4 is the sharpest: the candidate
 * set had already been widened to a `git grep` over the tracked set, but the predicate matched the
 * lander's path spelled without a repo prefix while this repo writes it with one. Widening the candidate
 * set while the predicate stayed narrow only moved where the blindness sat.
 *
 * WHAT THIS GATE SCANS AND WHAT IT MATCHES (stated this way because the card is about not doing
 * otherwise). It scans the prose of files under `backlog/` — minus frontmatter, fenced code, headings,
 * table rows, blockquotes and the Done-when section (`ownProseLines`), minus an `Acceptance` section
 * (`dropCriteriaSections`), and minus a paragraph carrying a retraction marker (`dropRetractedParagraphs`)
 * — and the comment text of `.mjs`/`.js`/`.ts` files (`commentLines`), under the same last exclusion.
 * Within that text it matches a sentence that (a) contains `every|all|no|none of the` + up to two
 * adjectival modifiers + a noun from `CANDIDATE_NOUNS` + a verb from `COVERAGE_VERBS`, or asserts
 * `AUTHORITY_RX` beside a checker noun; AND (b) carries a word from `VERIFICATION_TERM_RX`; AND (c)
 * matches nothing in `NAMES_CANDIDATE_SET_RX`. Four further exemptions apply per sentence and are
 * documented where they are defined, not restated here: a question, a quotation span (`quotedSpans`), a
 * colon introducing a list (`listIntroLines`), and a hedge or negator in front of the quantifier
 * (`HEDGED_RX` / `PRESCRIPTIVE_FRAME_RX`).
 *
 * Swept over `backlog/` at 3339 cards it produced 12 findings, adjudicated on the card; over the 576
 * `.mjs`/`.cjs` files under `scripts/`, 10.
 *
 * It does NOT find every unqualified completeness claim, and the gaps below are known ones rather than
 * an exhaustive list of them:
 *   - A universal whose noun is outside `CANDIDATE_NOUNS` — *"every round shipped a claim"*.
 *   - A universal whose verb is outside `COVERAGE_VERBS`, or separated from its noun by a relative
 *     clause — *"no caller that lands ships a bare invocation"*.
 *   - A coverage claim carrying NO verification vocabulary — *"every caller now declares the flag"*.
 *     Admitted, and admitted knowingly: without that word the sentence is indistinguishable from the
 *     thousands of ordinary universals on a 3300-card board, and a loose predicate here is the noise
 *     #3308 measured (a first draft firing on 59 of 60 PRs).
 *   - Past-tense and future claims; the verb slot is present-tense only.
 *
 * DISTINCT FROM #3341, which shares this file's prose splitter and nothing else. That gate governs
 * MECHANISM claims — *"X does Y by mechanism Z"* — and is answered by a citation; its subject is a module
 * path, and `ATTRIBUTIVE_RX` already drops a bare stem sitting behind `every`/`all`, so the two cannot
 * fire on the same phrase. This gate governs COMPLETENESS claims, where a citation is NOT the remedy: a
 * sentence can cite a real predicate and still overstate its reach, which is precisely what round 4 did.
 */
export function unqualifiedCompletenessClaim(text, { path } = {}) {
  const p = path || '';
  let lines;
  if (/^backlog\/.*\.md$/.test(p)) lines = dropCriteriaSections(dropRetractedParagraphs(ownProseLines(text)), text);
  else if (/\.(?:mjs|cjs|js|ts)$/.test(p)) lines = dropRetractedParagraphs(commentLines(text));
  else return [];

  const out = [];
  const listIntro = listIntroLines(text);
  for (const s of sentencesWithLines(lines)) {
    if (s.text.includes('?')) continue;                       // a question is not an assertion
    if (listIntro.has(s.endLine - 1)) continue;               // the rows below ARE the candidate set
    if (!VERIFICATION_TERM_RX.test(s.text)) continue;         // not a claim about a check at all
    if (NAMES_CANDIDATE_SET_RX.test(s.text)) continue;        // the fixed form: it says what it scanned
    const quoted = quotedSpans(s.text);
    const inQuote = (i) => quoted.some(([a, b]) => i >= a && i < b);

    let hit = null;
    COMPLETENESS_SUBJECT_RX.lastIndex = 0;
    for (const m of s.text.matchAll(COMPLETENESS_SUBJECT_RX)) {
      if (inQuote(m.index)) continue;
      if (HEDGED_RX.test(s.text.slice(0, m.index))) continue;
      if (PRESCRIPTIVE_FRAME_RX.test(s.text.slice(0, m.index))) continue;
      // "every card has to declare" is a prescription wearing an indicative's clothes.
      if (/^\s+to\b/.test(s.text.slice(m.index + m[0].length))) continue;
      // A CAPITALISED word mid-sentence in the verb slot is a proper noun, not a verb: "no contract type
      // references Report" is a noun phrase whose head is `references`, and reading `Report` as the verb
      // inverted the whole parse on `backlog/1808-…md`.
      if (/^[A-Z]/.test(m[5]) && m.index > 0) continue;
      hit = { subject: `${m[1]} ${m[2]}${m[3]}`.replace(/\s+/g, ' ').trim(), kind: 'universal' };
      break;
    }
    if (!hit) {
      const am = s.text.match(AUTHORITY_RX);
      if (am && !inQuote(am.index) && CHECK_NOUN_RX.test(s.text.slice(Math.max(0, am.index - 48), am.index))
        && !PRESCRIPTIVE_FRAME_RX.test(s.text.slice(0, am.index))) {
        hit = { subject: 'authoritative', kind: 'authority' };
      }
    }
    if (!hit) continue;

    out.push({
      gate: 'unqualified-completeness-claim',
      path: p,
      line: s.line,
      subject: hit.subject,
      message: hit.kind === 'universal'
        ? `"${hit.subject}…" claims a check covers the whole set and names no candidate set — no count, no harvest command, no path, no predicate. State what was scanned and what the predicate matches instead; a reader can then see their own spelling is not covered.`
        : `This sentence calls a check authoritative without saying what it scans or what it matches. "Authoritative" is not falsifiable; "scans N candidates from <harvest>, matching <predicate>" is, and stays true as the tree grows.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ registry */

export const GATES = Object.freeze([
  { name: 'resolved-with-todo', fn: resolvedWithTodo, targets: 'backlog card' },
  { name: 'stale-gate-count', fn: staleGateCount, targets: 'backlog card' },
  { name: 'dangling-wikilink', fn: danglingWikilink, targets: 'agent memory' },
  { name: 'dangling-hash-id', fn: danglingHashId, targets: 'backlog card' },
  { name: 'grep-literal-mismatch', fn: grepLiteralMismatch, targets: 'backlog card' },
  { name: 'vacuous-executable-criterion', fn: vacuousExecutableCriterion, targets: 'backlog card' },
  { name: 'scope-omits-donewhen-file', fn: scopeOmitsDoneWhenFile, targets: 'backlog card' },
  { name: 'citation-line-content', fn: citationLineContent, targets: 'any prose' },
  { name: 'uncited-mechanism-claim', fn: uncitedMechanismClaim, targets: 'backlog card' },
  { name: 'unqualified-completeness-claim', fn: unqualifiedCompletenessClaim, targets: 'backlog card or script comment' },
]);

/** Run every registered gate over one file. */
export function runGates(text, ctx) {
  const out = [];
  for (const g of GATES) {
    try { out.push(...g.fn(text, ctx)); } catch { /* a gate that throws scores as finding nothing */ }
  }
  return out;
}
