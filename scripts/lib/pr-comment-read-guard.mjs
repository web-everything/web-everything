/**
 * @file pr-comment-read-guard.mjs — pure detector + per-file ratchet for truncated PR comment reads (item 88).
 *
 * `gh pr list|view --json comments` and GraphQL `comments(first:N)` return one page (100) of a thread; a REST
 * `issues/N/comments` read without `--paginate` does the same. Four bugs came from that truncation (#4091 grants
 * and note dedupe, #4140 load-flake reverify, #4048 park-comment spam). The one full-thread reader is
 * `readCompletePrComments` in we:scripts/conveyor/pr-comments-complete.mjs; a read that bypasses it is counted here
 * and may never grow past the baseline (we:scripts/pr-comment-read-baseline.json).
 * Regenerate after an improvement: node scripts/lib/pr-comment-read-guard.mjs --write-baseline
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { checkBaseline } from './exec-output-guard.mjs';

export { checkBaseline };

/** `--json` followed (same line) by a field list naming `comments` — argv array, template string or prose. */
const JSON_COMMENTS = /--json(?:['"`]?\s*[,=\s]\s*['"`]?)[^'"`\s]*\bcomments\b/;
/** GraphQL connection read of comments with a page size. */
const GRAPHQL_COMMENTS = /\bcomments\s*\(\s*(?:first|last)\s*:/;
/** REST issue-comments endpoint. */
const REST_COMMENTS = /issues\/[^'"`\s]*\/comments/;
const PAGINATED = /--paginate|paginate\s*:\s*true/;

/** Drop whole-line `//` and block/JSDoc comment lines (prose that merely names a read). */
function codeLines(content) {
  const out = [];
  let inBlock = false;
  content.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      inBlock = false; line = line.slice(end + 2);
    }
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open !== -1 && !/['"`].*\/\*/.test(line.slice(0, open + 2))) { inBlock = true; line = line.slice(0, open); }
    if (/^\s*\/\//.test(line)) return;
    out.push({ line: i + 1, text: line });
  });
  return out;
}

/** @returns {{line:number, kind:'json-comments'|'graphql-comments'|'rest-unpaginated', text:string}[]} */
export function findTruncatedCommentReads(content) {
  const lines = codeLines(content);
  const paginated = lines.some((l) => PAGINATED.test(l.text));
  const found = [];
  for (const { line, text } of lines) {
    if (JSON_COMMENTS.test(text)) found.push({ line, kind: 'json-comments', text: text.trim() });
    else if (GRAPHQL_COMMENTS.test(text)) found.push({ line, kind: 'graphql-comments', text: text.trim() });
    else if (REST_COMMENTS.test(text) && !paginated) found.push({ line, kind: 'rest-unpaginated', text: text.trim() });
  }
  return found;
}

/** Production JS sources in scripts/ and skills-src/, minus the helper modules that own the reads. */
export function isCommentReadSource(file) {
  return /^(scripts|skills-src)\//.test(file) && /\.(mjs|js)$/.test(file)
    && !/(?:^|\/)(?:__tests__|__fixtures__|node_modules)(?:\/|$)|\.test\./.test(file)
    && !/^scripts\/(?:lib\/pr-comment-read-guard|conveyor\/pr-comments-complete)\.mjs$/.test(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') !== '--write-baseline') throw new Error('Usage: node scripts/lib/pr-comment-read-guard.mjs --write-baseline');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { readGit } = await import('./proc-read.mjs');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = readGit(['ls-files', '-z', 'scripts', 'skills-src'], { cwd: root }).split('\0').filter(isCommentReadSource).sort();
  const counts = {};
  for (const file of files) {
    const n = findTruncatedCommentReads(readFileSync(resolve(root, file), 'utf8')).length;
    if (n) counts[file] = n;
  }
  writeFileSync(resolve(root, 'scripts/pr-comment-read-baseline.json'), `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`${Object.values(counts).reduce((a, b) => a + b, 0)} bypassing sites in ${Object.keys(counts).length} files`);
  for (const [f, n] of Object.entries(counts)) console.log(`  ${n}  ${f}`);
}
