/**
 * @file scripts/lib/round-judge-verify.mjs
 * @description The shadow round judge's DETERMINISTIC claim checker (operator 2026-10-21, case #5768). Some findings
 *   are mechanically refutable on the live head: "no named test for X" while a test named for X exists, "the
 *   function discards errors" while the cited region logs and returns an error status. This module checks such a
 *   claim against the head's files and returns `refuted` WITH evidence, or `inconclusive`. It never returns "real":
 *   anything it cannot prove false stays a finding (the judge then sends it back; it never guesses not-real).
 *
 *   PURE over a small `repo` seam: `{ read(path) -> string|null, tests(stem) -> string[] }`. `makeGitRepo` is the
 *   read-only IO adapter (git show / git grep on the head; nothing is fetched, checked out or written).
 *
 *   Rules (each needs concrete evidence):
 *     1. COVERAGE claim ("no test", "untested", "COVERAGE:"): a test file that mentions the cited file's name has a
 *        test title (`it(` / `test(` / `describe(`) containing the claim's identifier, or at least two of its
 *        distinctive terms. Evidence: `<test file>:<line> "<title>"`.
 *     2. BEHAVIOUR claim naming identifiers ("function X does ..."): none of the named identifiers occurs anywhere in
 *        the cited file at the head, which exists. Evidence: `<file> has no occurrence of <ids>`.
 *     3. SILENT-FAILURE claim ("silently discarded / swallowed / ignored" errors): within 50 lines of the cited line
 *        there is BOTH a log or throw AND an error-status return. Evidence: `<file>:<line>` of each.
 */
import { execFileSync } from 'node:child_process';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'has', 'have', 'are', 'its', 'not', 'from', 'into', 'than', 'then',
  'when', 'does', 'test', 'tests', 'named', 'untested', 'coverage', 'regression', 'case', 'cases', 'wiring', 'without', 'there', 'their',
  'which', 'while', 'every', 'each', 'only', 'also', 'can', 'any', 'all', 'but', 'was', 'were', 'will', 'would', 'should', 'minute', 'caller']);

const COVERAGE_CLAIM = /\bCOVERAGE\b|\buntested\b|\bnot (?:covered|tested)\b|\b(?:no|lacks?|without|missing)\b[^.]{0,60}\b(?:tests?|regression|coverage)\b/i;
const SILENT_CLAIM = /\b(?:silent(?:ly)?|swallow(?:s|ed)?|discard(?:s|ed)?|ignor(?:e|es|ed)|drop(?:s|ped))\b[^.]{0,60}\berrors?\b|\berrors?\b[^.]{0,40}\b(?:silent(?:ly)?|swallowed|discarded|ignored|dropped)\b/i;

/** Identifiers a claim names: backticked words, UPPER_SNAKE, camelCase / PascalCase. PURE. */
export function claimIdentifiers(summary) {
  const s = String(summary ?? '');
  const ids = new Set();
  for (const m of s.matchAll(/`([^`]{2,80})`/g)) ids.add(m[1].trim());
  for (const m of s.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) ids.add(m[0]);
  for (const m of s.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g)) ids.add(m[0]);
  for (const m of s.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g)) ids.add(m[0]);
  // Earliest mention first: the first identifier is the claim's subject.
  return [...ids].sort((a, b) => s.indexOf(a) - s.indexOf(b));
}

/** Distinctive lower-case terms of a claim (hyphen / underscore split). PURE. */
export function claimTerms(summary) {
  const out = new Set();
  for (const w of String(summary ?? '').toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  return [...out];
}

const stemOf = (file) => String(file ?? '').split('/').pop().replace(/\.[a-z]+$/i, '');
const TITLE = /^\s*(?:it|test|describe)(?:\.(?!skip\b|todo\b|fixme\b)[a-z]+)?\s*\(\s*(['"`])(.*?)\1/;
/** A skipped / todo test (or a file with a skipped suite) proves nothing: the checker treats the whole file as inconclusive. */
const SKIPPED = /^\s*(?:(?:it|test|describe)\.(?:skip|todo|fixme)\b|x(?:it|describe|test)\s*\()/m;

function titlesOf(text) {
  const out = [];
  text.split('\n').forEach((line, i) => { const m = TITLE.exec(line); if (m) out.push({ line: i + 1, title: m[2] }); });
  return out;
}
const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

const IMPORTISH = /^\s*(?:import\b|export\s*\{|export\s+\*|\/\/|\*|\/\*)|\brequire\(/;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordSet = (l) => new Set(String(l).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

const IND = (l) => l.length - l.trimStart().length;
const TEST_TITLE = /^\s*(?:it|test)(?:\.(?!skip\b|todo\b|fixme\b)[a-z]+)?\s*\(\s*(['"`])/;

/** Line indexes that sit INSIDE an `it(` / `test(` call body (title line to its closing line). */
function testBodyLines(lines) {
  const inside = new Set();
  lines.forEach((l, i) => {
    if (!TEST_TITLE.test(l)) return;
    const n = IND(l);
    inside.add(i);
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j].trim();
      if (t && IND(lines[j]) <= n && /^[})\]]/.test(t)) break; // the call's closing `})` at the title's indent
      if (t && IND(lines[j]) <= n && !/^[})\]]/.test(t)) break;
      inside.add(j);
    }
  });
  return inside;
}

function checkCoverage(f, repo) {
  const ids = claimIdentifiers(f.summary).filter((x) => x.length >= 6).slice(0, 1); // the subject only
  const stem = stemOf(f.file);
  const stemParts = new Set(stem.toLowerCase().split(/[^a-z0-9]+/));
  const terms = claimTerms(f.summary).filter((t) => !stemParts.has(t));
  for (const path of repo.tests(stem, ids)) {
    const text = repo.read(path);
    if (text == null || SKIPPED.test(text)) continue;
    const lines = text.split('\n');
    const body = testBodyLines(lines);
    // 1. the subject identifier is USED inside an it()/test() body: whole word, not an import / comment line.
    for (const id of ids) {
      const re = new RegExp(`(?<![\\w$])${esc(id)}(?![\\w$])`);
      const at = lines.findIndex((l, i) => body.has(i) && re.test(l) && !IMPORTISH.test(l));
      if (at >= 0) return { status: 'refuted', evidence: `${path}:${at + 1} uses ${id}` };
    }
    // 2. a test title, then a line inside a test body, carries at least two whole-word distinctive terms.
    const hits = (l) => { const w = wordSet(l); return terms.filter((x) => w.has(x)).length; };
    for (const t of titlesOf(text)) if (hits(t.title) >= 2) return { status: 'refuted', evidence: `${path}:${t.line} "${t.title.slice(0, 80)}"` };
    if (terms.length >= 2) {
      const at = lines.findIndex((l, i) => body.has(i) && !IMPORTISH.test(l) && hits(l) >= 2);
      if (at >= 0) return { status: 'refuted', evidence: `${path}:${at + 1} ${lines[at].trim().slice(0, 80)}` };
    }
  }
  return { status: 'inconclusive', evidence: null };
}

const FN_DECL = /^(?:export\s+)?(?:async\s+)?function\b|^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/; // top-level only
// A bare empty catch is a real swallow. One that carries a comment (`catch { /* log only */ }`) is a documented best-effort
// step and does not by itself decide the claim.
const LOGGY = /\b(?:console\.(?:error|warn|log)|throw\b|log(?:ger)?\.(?:error|warn)|\blog\()/;
const STATUSY = /status\s*:\s*['"]error['"]|\bexitCode\s*=\s*[1-9]|return\s*\{[^}]*\berror\b|\bthrow\b/;
/** Every `catch` block in some lines: { line (of the catch), body }. Brace counting; strings are not parsed. */
function catchBlocks(lines) {
  const out = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\bcatch\b\s*(?:\([^)]*\))?\s*\{/g)) {
      let depth = 0, body = '', closed = false;
      for (let r = i; r < lines.length && r < i + 60 && !closed; r += 1) {
        const text = r === i ? lines[r].slice(m.index + m[0].length - 1) : lines[r];
        for (const ch of text) {
          if (ch === '{') { depth += 1; if (depth === 1) continue; }
          if (ch === '}') { depth -= 1; if (depth === 0) { closed = true; break; } }
          if (depth >= 1) body += ch;
        }
        if (!closed) body += '\n';
      }
      out.push({ line: i, body });
    }
  });
  return out;
}

function checkSilent(f, repo) {
  const text = repo.read(f.file);
  if (text == null || !Number.isInteger(f.line)) return { status: 'inconclusive', evidence: null };
  const lines = text.split('\n');
  let at = Math.min(Math.max(f.line - 1, 0), lines.length - 1);
  // A cited line that has drifted into a doc comment means the function right below it.
  while (at < lines.length - 1 && /^\s*(?:\/\*|\*|\/\/|$)/.test(lines[at])) at += 1;
  // Only the function that CONTAINS the cited line counts: a log or error return in another function proves nothing.
  let lo = at; while (lo > 0 && !FN_DECL.test(lines[lo])) lo -= 1;
  let hi = at + 1; while (hi < lines.length && !FN_DECL.test(lines[hi])) hi += 1;
  if (hi - lo > 120) return { status: 'inconclusive', evidence: null };
  const scope = lines.slice(lo, hi);
  const blocks = catchBlocks(scope);
  if (!blocks.length) return { status: 'inconclusive', evidence: null };
  // EVERY catch in the function must be handled (log / throw / error status) or be a documented empty best-effort one;
  // a catch that does something else (e.g. `void e`) or is a bare `{}` is a real swallow and the claim stands.
  const offset = (b, re) => { const m = re.exec(b.body); return m ? b.line + b.body.slice(0, m.index).split('\n').length - 1 : null; };
  const handled = blocks.map((b) => ({ ...b, logLine: offset(b, LOGGY), statusLine: offset(b, STATUSY), log: LOGGY.test(b.body), status: STATUSY.test(b.body), commented: /\/\*|\/\//.test(b.body) && !b.body.replace(/\/\*.*?\*\/|\/\/.*$/gm, '').trim() }));
  if (handled.some((b) => !b.log && !b.status && !b.commented)) return { status: 'inconclusive', evidence: null };
  const logAt = handled.find((b) => b.log); const statusAt = handled.find((b) => b.status);
  return logAt && statusAt
    ? { status: 'refuted', evidence: `${f.file}:${lo + logAt.logLine + 1} logs/throws and ${f.file}:${lo + statusAt.statusLine + 1} returns an error status, every catch in the function holding line ${f.line} is handled` }
    : { status: 'inconclusive', evidence: null };
}

/** A claim about something ABSENT ("omits", "never", "missing") is not refuted by an identifier being absent. */
const NEGATIVE = /\b(?:omit(?:s|ted)?|missing|lacks?|without|never|not|no|fails? to|doesn'?t|isn'?t|cannot|can'?t|skips?|ignores?)\b/i;

function checkBehaviour(f, repo) {
  if (NEGATIVE.test(f.summary)) return { status: 'inconclusive', evidence: null };
  const ids = claimIdentifiers(f.summary);
  if (!ids.length || !f.file) return { status: 'inconclusive', evidence: null };
  const text = repo.read(f.file);
  if (text == null) return { status: 'inconclusive', evidence: null };
  return ids.every((id) => !text.includes(id))
    ? { status: 'refuted', evidence: `${f.file} has no occurrence of ${ids.slice(0, 3).join(', ')}` }
    : { status: 'inconclusive', evidence: null };
}

/**
 * Check one finding. PURE over `repo`. Never throws: any error is `inconclusive`.
 * @param {{file:(string|null), line:(number|null), summary:string}} f
 * @param {{read:(path:string)=>(string|null), tests:(stem:string, ids?:string[])=>string[]}} repo
 * @returns {{status:'refuted'|'inconclusive', evidence:(string|null)}}
 */
export function verifyFinding(f, repo) {
  try {
    if (!f?.file || !repo) return { status: 'inconclusive', evidence: null };
    if (COVERAGE_CLAIM.test(f.summary)) return checkCoverage(f, repo);
    if (SILENT_CLAIM.test(f.summary)) return checkSilent(f, repo);
    return checkBehaviour(f, repo);
  } catch {
    return { status: 'inconclusive', evidence: null };
  }
}

const TEST_PATH = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Read-only git adapter over a commit. `run(args)` returns stdout or throws. Nothing is fetched or written; a commit
 * that is not in this clone makes every read null / empty, i.e. `inconclusive`. @param {{head:string, cwd?:string, run?:Function}} o
 */
export function makeGitRepo({ head, cwd = process.cwd(), run } = {}) {
  const exec = run ?? ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
  const ok = /^[0-9a-f]{40}$/.test(String(head ?? ''));
  const cache = new Map();
  let tree = null;
  return {
    read(path) {
      if (!ok || !path || /^[-/]|\.\./.test(path)) return null;
      if (cache.has(path)) return cache.get(path);
      let text = null;
      try { text = exec(['show', `${head}:${path}`]); } catch { text = null; }
      cache.set(path, text);
      return text;
    },
    /** Test files named for the cited file (`<stem>*.test.*`), then tests that contain one of the claim's identifiers. */
    tests(stem, ids = []) {
      if (!ok || !stem || !/^[\w.-]+$/.test(stem)) return [];
      const out = [];
      try {
        tree ??= exec(['ls-tree', '-r', '--name-only', head]).split('\n');
        for (const p of tree) if (TEST_PATH.test(p) && p.split('/').pop().startsWith(stem)) out.push(p);
      } catch { /* fall through to identifiers */ }
      for (const id of ids.slice(0, 4)) {
        if (!/^[A-Za-z_$][\w$]*$/.test(id)) continue;
        try {
          const hits = exec(['grep', '-l', '-F', '--no-color', '-e', id, head, '--']);
          for (const l of hits.split('\n')) { const p = l.replace(`${head}:`, '').trim(); if (p && TEST_PATH.test(p)) out.push(p); }
        } catch { /* no hit */ }
      }
      return [...new Set(out)].slice(0, 12);
    },
  };
}
