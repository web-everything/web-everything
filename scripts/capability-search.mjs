#!/usr/bin/env node
/**
 * @file scripts/capability-search.mjs
 * @description SEARCH TWO EXISTING SURFACES for anything that already matches a concept being considered,
 *   before it gets proposed or built fresh (#3559). Two real misses on 2026-09-06 motivate this: a tool
 *   rebuilt from scratch that already had a near-match (`we:scripts/conveyor/reconcile-finding.mjs`, see
 *   #3554), and an idea proposed as brand-new that was already filed two weeks earlier (#3277). Nothing
 *   made "search first" a routine step; this script is that step.
 *
 *   TWO SURFACES, READ-ONLY — no `op()` declaration on `we:scripts/operations/registry.mjs` (per #3001's
 *   reads-stay-free split, this is a plain script any session runs directly, not a mutating operation):
 *     1. operation/skill — `we:scripts/operations/*.mjs` + `we:scripts/conveyor/*.mjs` (their leading
 *        `/** … *\/` JSDoc header block in full, not just its `@description` line) and each
 *        `we:skills-src/<name>/SKILL.md` (frontmatter `name` + `description`,
 *        the source a skill deploys from — not the generated `we:.claude/skills/` copy).
 *     2. backlog — `we:backlog/*.md` titles, digests (lead paragraphs, via the SAME `derive()` the site
 *        loader already uses — `we:src/_data/backlog.js` — so this never re-derives title/summary logic
 *        that file already owns), and tags.
 *
 *   MATCHING IS DETERMINISTIC, THE RELEVANCE JUDGMENT IS NOT (per
 *   we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment): each candidate scores as the
 *   fraction of the QUERY's own tokens it covers, with a light stem tolerance (see `stemLike`) so
 *   "publish" still covers "publishes" — cheap and explainable, and it never claims to KNOW two things are
 *   the same, only that they share enough words to be worth a look. The verdict is one of three, never a
 *   silent "nothing here, proceed": `exact` (≥ EXACT_THRESHOLD), `partial` (≥ PARTIAL_THRESHOLD), or `none`.
 *
 * Usage:
 *   node scripts/capability-search.mjs "<concept text>" [--json] [--limit=N]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { tokens } from './conveyor/learnings-dedup.mjs';
import { idFromName } from './backlog/id.mjs';
import { writeLineSync } from './lib/write-all-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireCjs = createRequire(import.meta.url);
const matter = requireCjs('gray-matter');
// Loaded on first use, not at import: file-item's reader and the operator-task settings import this module's
// constants and search, and a checkout without src/ (a bare-origin test fixture, an edge clone) must still
// be able to import them. A missing loader surfaces per-file as a malformed card, which fails closed.
let deriveFn;
const derive = (body) => (deriveFn ??= requireCjs(join(ROOT, 'src/_data/backlog.js')).derive)(body);

export const EXACT_THRESHOLD = 0.7;
export const PARTIAL_THRESHOLD = 0.3;

// ---- matching core (pure) --------------------------------------------------

/** Two tokens match exactly, or one is a ≥4-char prefix of the other (cheap stem tolerance — "publish" ~
 *  "publishes", "refresh" ~ "refreshes"). Not a real stemmer, just enough to survive a plural/tense mismatch
 *  between a query and a title. */
export function stemLike(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** overlapScore(queryTokens, docTokens) → { score, matched }. score = fraction of the QUERY's own tokens
 *  covered by the doc — recall against the query, not Jaccard-over-union, so a long doc (an essay-length
 *  file header) is never penalized just for being long. */
export function overlapScore(queryTokens, docTokens) {
  if (!queryTokens.length) return { score: 0, matched: [] };
  const docSet = new Set(docTokens);
  const matched = [];
  for (const q of queryTokens) {
    if (docSet.has(q) || docTokens.some((d) => stemLike(q, d))) matched.push(q);
  }
  return { score: matched.length / queryTokens.length, matched };
}

export function classifyVerdict(score) {
  if (score >= EXACT_THRESHOLD) return 'exact';
  if (score >= PARTIAL_THRESHOLD) return 'partial';
  return 'none';
}

// ---- candidate loaders ------------------------------------------------------

// An optional shebang line (`#!/usr/bin/env node` — a third of the files this scans open with one), THEN
// any amount of leading whitespace/blank lines, THEN the JSDoc block — none of the leading noise is required
// to butt directly up against the next, so a stray blank line between the shebang and the header doesn't
// silently defeat the match either.
const HEADER_RE = /^(?:#!.*\n)?\s*\/\*\*([\s\S]*?)\*\//;

/** The leading `/** … *\/` JSDoc block of a script, stripped to plain words (comment syntax and `@tag`
 *  markers dropped so they don't dilute the token set with punctuation). '' if the file opens with no such
 *  block. */
export function extractHeaderText(source) {
  const m = HEADER_RE.exec(source);
  if (!m) return '';
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .replace(/@\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scriptCandidates(root, subdir) {
  const dir = join(root, 'scripts', subdir);
  let files;
  try { files = readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => extname(f) === '.mjs')
    .map((f) => {
      const text = extractHeaderText(readFileSync(join(dir, f), 'utf8'));
      return { kind: 'script', surface: `scripts/${subdir}`, id: `we:scripts/${subdir}/${f}`, text: `${f} ${text}` };
    });
}

/** we:scripts/operations/*.mjs + we:scripts/conveyor/*.mjs — every declared operation lives in the former
 *  (registry.mjs itself holds only the declaration SHAPE, never a per-operation description, so it is not
 *  scanned separately), and reconciliation/mechanical CLIs live in the latter. */
export function loadScriptCandidates(root = ROOT) {
  return [...scriptCandidates(root, 'operations'), ...scriptCandidates(root, 'conveyor')];
}

/** SKILL.md `description` fields routinely carry an unquoted colon ("…COLLECTS but never adjudicates:
 *  every lesson…", `we:skills-src/closing-session/SKILL.md`) — plain-scalar prose that full YAML parsing
 *  (js-yaml, under gray-matter) rejects outright, the same fragility `we:scripts/check-standards-rules.mjs`
 *  already lints backlog frontmatter for (#453). A line-based regex pull, not a YAML parse, is what
 *  tolerates it — including a YAML block scalar (`description: >` or `description: |`), whose continuation
 *  lines are just-as-indented lines that follow, joined in rather than dropped after the first line. */
export function parseSkillFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  const block = m ? m[1] : '';
  const lines = block.split('\n');
  const name = (block.match(/^name:\s*(.+)$/m) || [])[1] || '';
  let description = '';
  const idx = lines.findIndex((l) => /^description:\s*/.test(l));
  if (idx !== -1) {
    const rest = lines[idx].replace(/^description:\s*/, '');
    if (/^[|>][+-]?\s*$/.test(rest)) {
      const continuation = [];
      for (let i = idx + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) continuation.push(lines[i].trim());
      description = continuation.join(' ');
    } else {
      description = rest;
    }
  }
  return { name: name.trim(), description: description.trim() };
}

export function loadSkillCandidates(root = ROOT) {
  const dir = join(root, 'skills-src');
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    let raw;
    try { raw = readFileSync(join(dir, ent.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const { name, description } = parseSkillFrontmatter(raw);
    out.push({
      kind: 'skill',
      surface: 'skills-src',
      id: `we:skills-src/${ent.name}/SKILL.md`,
      text: `${name || ent.name} ${description}`,
    });
  }
  return out;
}

/** we:backlog/*.md — title + digest (lead paragraph) via the site loader's own `derive()`, plus tags.
 *  `backlogDir` overrides the live corpus with a fixture dir, mirroring `--backlog-dir` on
 *  we:scripts/backlog.mjs / we:scripts/readiness/dispatch-plan.mjs (#3445). Returns `{ candidates,
 *  malformed }` — a genuinely SKIP-AND-REPORT (mirroring src/_data/backlog.js's own convention), not just a
 *  skip: `malformed` names every file this scan could not read, so an incomplete search stays visible
 *  instead of silently narrowing what the tool claims to have checked. */
export function loadBacklogCandidates(root = ROOT, { backlogDir } = {}) {
  const dir = backlogDir || join(root, 'backlog');
  let files;
  try { files = readdirSync(dir); } catch { return { candidates: [], malformed: [] }; }
  const candidates = [];
  const malformed = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    const num = idFromName(id);
    if (!num) continue; // not an item file (e.g. a stray README)
    // `matter()` AND `derive()` both run on untrusted per-file content, so both sit inside the one try.
    let data, finalTitle, summary, tags;
    try {
      let content;
      ({ data, content } = matter(readFileSync(join(dir, f), 'utf8')));
      const ownBody = content.trim();
      const derived = ownBody ? derive(ownBody) : {};
      finalTitle = derived.title || data.title || id;
      summary = derived.summary;
      tags = Array.isArray(data.tags) ? data.tags.join(' ') : '';
    } catch (err) {
      malformed.push({ file: `we:backlog/${f}`, reason: err.message });
      continue;
    }
    candidates.push({
      kind: 'backlog',
      surface: 'backlog',
      id: `#${num}`,
      status: data.status || 'unknown',
      title: finalTitle,
      path: `we:backlog/${f}`,
      text: `${finalTitle} ${summary || ''} ${tags}`,
    });
  }
  return { candidates, malformed };
}

// ---- search -----------------------------------------------------------------

/** Score + sort every candidate, full list, UNTRUNCATED — `limit` is a display concern, applied later.
 *  Slicing here first would let `--limit=0` (or a non-numeric `--limit` that coerces to 0) silently drop
 *  every hit BEFORE the verdict is computed from it, turning a real exact match into a false `none`. */
function rank(query, candidates) {
  const q = tokens(query);
  return candidates
    .map((c) => ({ ...c, ...overlapScore(q, tokens(c.text)) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** searchCapabilities(query, opts) → { query, verdict, operations, backlog, malformed }. The two surfaces
 *  are ranked independently; `verdict` is the more confident of the two (exact beats partial beats none) so
 *  a caller reading only `verdict` still gets the right stop/proceed signal without inspecting both lists.
 *  `limit` only trims the returned rows — it never affects the verdict, which is derived from the full
 *  ranking. `malformed` names every backlog file this run could not read, so a caller can tell "genuinely
 *  nothing found" apart from "some of the corpus was unscannable" instead of the two looking identical. */
export function searchCapabilities(query, { root = ROOT, backlogDir, limit = 5 } = {}) {
  const { candidates: backlogCandidates, malformed } = loadBacklogCandidates(root, { backlogDir });
  const rankedOperations = rank(query, [...loadScriptCandidates(root), ...loadSkillCandidates(root)]);
  const rankedBacklog = rank(query, backlogCandidates);
  const best = Math.max(rankedOperations[0]?.score || 0, rankedBacklog[0]?.score || 0);
  const n = Number.isFinite(limit) && limit >= 0 ? limit : 5;
  return {
    query,
    verdict: classifyVerdict(best),
    operations: rankedOperations.slice(0, n),
    backlog: rankedBacklog.slice(0, n),
    malformed,
  };
}

// ---- CLI ----------------------------------------------------------------------

const VERDICT_LABEL = {
  exact: 'EXACT MATCH — this likely already exists, read the top hit(s) before building',
  partial: 'PARTIAL MATCH — related hits found, judge relevance yourself',
  none: 'NOTHING FOUND — safe to propose/build',
};

function printSection(label, rows, describe) {
  writeLineSync(1, `${label} (${rows.length}):`);
  if (!rows.length) writeLineSync(1, '  (none)');
  for (const r of rows) {
    writeLineSync(1, `  ${(r.score * 100).toFixed(0)}%  ${describe(r)}`);
    writeLineSync(1, `        matched: ${r.matched.join(', ')}`);
  }
  writeLineSync(1, '');
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 5;
  const query = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!query) {
    writeLineSync(2, 'usage: node scripts/capability-search.mjs "<concept text>" [--json] [--limit=N]');
    process.exitCode = 1;
    return;
  }
  const report = searchCapabilities(query, { limit });
  if (json) {
    writeLineSync(1, JSON.stringify(report, null, 2));
    return;
  }
  writeLineSync(1, `capability-search: "${report.query}"`);
  writeLineSync(1, `verdict: ${VERDICT_LABEL[report.verdict]}\n`);
  printSection('operation/skill surface', report.operations, (r) => r.id);
  printSection('backlog surface', report.backlog, (r) => `${r.id} (${r.status}) ${r.title}`);
  if (report.malformed.length) {
    writeLineSync(1, `warning: ${report.malformed.length} backlog file(s) could not be read and were skipped:`);
    for (const m of report.malformed) writeLineSync(1, `  ${m.file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
