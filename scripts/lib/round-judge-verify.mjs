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
const TITLE = /^\s*(?:it|test|describe)(?:\.[a-z]+)?\s*\(\s*(['"`])(.*?)\1/;

function titlesOf(text) {
  const out = [];
  text.split('\n').forEach((line, i) => { const m = TITLE.exec(line); if (m) out.push({ line: i + 1, title: m[2] }); });
  return out;
}
const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

function checkCoverage(f, repo) {
  const ids = claimIdentifiers(f.summary).filter((x) => x.length >= 6).slice(0, 1); // the subject only
  const stem = stemOf(f.file);
  const stemParts = new Set(stem.toLowerCase().split(/[^a-z0-9]+/));
  const terms = claimTerms(f.summary).filter((t) => !stemParts.has(t));
  for (const path of repo.tests(stem, ids)) {
    const text = repo.read(path);
    if (text == null) continue;
    const lines = text.split('\n');
    // 1. a named identifier of the claim appears in the test file.
    for (const id of ids) {
      const at = lines.findIndex((l) => l.includes(id));
      if (at >= 0) return { status: 'refuted', evidence: `${path}:${at + 1} mentions ${id}` };
    }
    // 2. a test title, then any line, carries at least two distinctive terms of the claim (stem words excluded).
    const norm = (l) => l.toLowerCase().replace(/[_-]+/g, ' ');
    for (const t of titlesOf(text)) {
      const w = norm(t.title);
      if (terms.filter((x) => w.includes(x)).length >= 2) return { status: 'refuted', evidence: `${path}:${t.line} "${t.title.slice(0, 80)}"` };
    }
    if (terms.length >= 2) {
      const at = lines.findIndex((l) => terms.filter((x) => norm(l).includes(x)).length >= 2);
      if (at >= 0) return { status: 'refuted', evidence: `${path}:${at + 1} ${lines[at].trim().slice(0, 80)}` };
    }
  }
  return { status: 'inconclusive', evidence: null };
}

function checkSilent(f, repo) {
  const text = repo.read(f.file);
  if (text == null || !Number.isInteger(f.line)) return { status: 'inconclusive', evidence: null };
  const lines = text.split('\n');
  const lo = Math.max(0, f.line - 51), hi = Math.min(lines.length, f.line + 50);
  let logAt = -1, statusAt = -1;
  for (let i = lo; i < hi; i += 1) {
    if (logAt < 0 && /\b(?:console\.(?:error|warn|log)|throw\b|log(?:ger)?\.(?:error|warn))/.test(lines[i])) logAt = i;
    if (statusAt < 0 && /status\s*:\s*['"]error['"]|\bexitCode\s*=\s*[1-9]|return\s*\{[^}]*\berror\b/.test(lines[i])) statusAt = i;
  }
  return logAt >= 0 && statusAt >= 0
    ? { status: 'refuted', evidence: `${f.file}:${logAt + 1} logs/throws and ${f.file}:${statusAt + 1} returns an error status` }
    : { status: 'inconclusive', evidence: null };
}

function checkBehaviour(f, repo) {
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
        if (!/^[\w.$-]+$/.test(id)) continue;
        try {
          const hits = exec(['grep', '-l', '-F', '--no-color', id, head, '--']);
          for (const l of hits.split('\n')) { const p = l.replace(`${head}:`, '').trim(); if (p && TEST_PATH.test(p)) out.push(p); }
        } catch { /* no hit */ }
      }
      return [...new Set(out)].slice(0, 12);
    },
  };
}
