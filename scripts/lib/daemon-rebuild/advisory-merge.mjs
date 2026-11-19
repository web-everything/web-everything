/** Narrow, fail-closed resolution of append-only advisory registries; never resolves source conflicts. */
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { FULL_SHA_RE } from './shared.mjs';

export const ADVISORY_MERGE_PATHS = Object.freeze(['scripts/ci/test-timings.json', 'scripts/conveyor/soak/breaks/index.mjs', 'docs/agent/testing.md']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Union object entries, conservatively retaining the larger numeric observation. */
export function mergeTimingsJson(baseText, oursText, theirsText) {
  try {
    const [base, ours, theirs] = [baseText, oursText, theirsText].map(text => JSON.parse(text));
    if (![base, ours, theirs].every(value => object(value) && object(value.unit) && object(value.soak))) return null;
    const merge = (b, o, t) => {
      if (typeof o === 'number' && typeof t === 'number') return Math.max(o, t);
      if (object(o) && object(t)) {
        return Object.fromEntries([...new Set([...Object.keys(o), ...Object.keys(t)])].sort().map(key => [
          key, merge(object(b) ? b[key] : undefined, o[key], t[key]),
        ]));
      }
      if (o === undefined) return t;
      if (t === undefined || isDeepStrictEqual(o, t)) return o;
      if (isDeepStrictEqual(o, b)) return t;
      if (isDeepStrictEqual(t, b)) return o;
      throw new Error('incompatible advisory values');
    };
    const merged = merge(base, ours, theirs);
    const { _doc, unit, soak, ...rest } = merged;
    return `${JSON.stringify({ _doc, unit, soak, ...rest }, null, 1)}\n`;
  } catch { return null; }
}

const textLines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];

/** Only unindented data rows are unambiguous here; nested/continuation Markdown needs human resolution. */
function markdownRow(line) {
  const text = line.replace(/\r?\n$/, '');
  if (/[\x00-\x1f\x7f]/.test(text) || /```|~~~|<!--|-->|<\s*[!/?a-z]/i.test(text)) return null;
  // A thematic break (`* * *`, `- - -`, `***`, `___`) is structure, never a data row.
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(text)) return null;
  const item = text.match(/^(?:- |\* |\d+\. )(.+)$/);
  // A nested block marker after the item marker (`- + # x`, `- - x`, `- 1. x`, `- > x`, `- | x`) is structure, not data.
  if (item) return /^(?:\s|#|---(?:\s|$)|>|\||[-*_+](?:\s|$)|\d+[.)](?:\s|$)|[-*_](?:\s*[-*_])*\s*$)/.test(item[1]) ? null : 'list';
  if (!/^\|.+/.test(text)) return null;
  const cells = text.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  return cells.every(cell => /^:?-+:?$/.test(cell)) ? null : 'table';
}

/** Mark both neighbouring gaps of protected base lines, including opening/closing delimiters.
 * Ambiguous or unbalanced base syntax refuses the union rather than guessing at Markdown semantics.
 */
function markdownContext(lines) {
  const unsafe = Array(lines.length + 1).fill(false);
  const delimiters = [];
  // Includes CommonMark block tags, raw-text containers and standalone custom tags.
  const blockTags = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param pre script search section source style summary table tbody td textarea tfoot th thead title tr track ul').split(' '));
  const voidTags = new Set('area base basefont br col embed frame hr img input link menuitem meta param source track wbr'.split(' '));
  const rawTags = new Set(['pre', 'script', 'style', 'textarea']);
  const html = [];
  let fence = null, comment = false;
  for (const [i, line] of lines.entries()) {
    let protectedLine = !!fence || comment || html.length > 0 || /^(?: {4}|\t)/.test(line);
    const tag = !fence && !comment && line.match(/^ {0,3}<\/?([a-z][\w-]*)\b/i);
    if (html.length || (tag && (blockTags.has(tag[1].toLowerCase()) || /^ {0,3}<\/?[a-z][^>]*>\s*$/i.test(line)))) {
      protectedLine = true;
      if (/<!--|-->/.test(line)) return null; // Mixed HTML/comment nesting needs human resolution.
      for (const token of line.matchAll(/<(\/?)([a-z][\w-]*)\b[^>]*>/gi)) {
        const name = token[2].toLowerCase(), closing = !!token[1];
        if (rawTags.has(html.at(-1)) && !(closing && name === html.at(-1))) continue;
        delimiters.push(token[0]);
        if (closing) {
          if (html.pop() !== name) return null;
        } else if (!voidTags.has(name)) html.push(name);
      }
      // Incomplete opening tags are ambiguous and must not authorize a union.
      if (tag && !line.includes('>')) return null;
    } else if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        delimiters.push(close[1]);
        fence = null;
      }
    } else if (!comment && /^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
      fence = line.match(/^ {0,3}(`{3,}|~{3,})/)[1];
      delimiters.push(fence);
      protectedLine = true;
    } else {
      // A fence in an unsupported container (list, quote, etc.) is unclear; fail closed.
      if (/```|~~~/.test(line)) return null;
      for (const token of line.match(/<!--|-->/g) ?? []) {
        if ((token === '<!--') === comment) return null;
        comment = token === '<!--';
        delimiters.push(token);
        protectedLine = true;
      }
      if (!comment && [...line.matchAll(/<\/?([a-z][\w-]*)\b/gi)].some(token => blockTags.has(token[1].toLowerCase()))) return null;
    }
    if (protectedLine) unsafe[i] = unsafe[i + 1] = true;
  }
  return fence || comment || html.length ? null : { unsafe, delimiters: delimiters.join('\n') };
}

// Preserve every base line; match identical cross-side additions one-for-one at each base gap.
// A non-additive edit is outside this registry contract; leave it for operator resolution.
function mergeRegistryLines(baseText, oursText, theirsText, markdown = false) {
  const base = textLines(baseText), gaps = base.map(() => []);
  const headerEnd = base.findIndex(line => line.includes('*/'));
  if (!markdown && (base[0] !== '/**\n' || headerEnd < 1 || ![' */\n', ' */'].includes(base[headerEnd]))) return null;
  const context = markdown ? markdownContext(base) : null;
  if (markdown && !context) return null;
  const lastContent = base.findLastIndex(line => line.trim());
  gaps.push([]);
  const added = gaps.map(() => new Map());
  for (const [side, text] of [oursText, theirsText].entries()) {
    let cursor = 0;
    for (const line of textLines(text)) {
      if (cursor < base.length && line === base[cursor]) cursor++;
      else {
        if (!markdown && (cursor === 0 || cursor > headerEnd || !/^ \* /.test(line) || line.includes('/*') || line.includes('*/'))) return null;
        if (markdown) {
          const kind = markdownRow(line);
          const previous = cursor > 0 && (/^\|/.test(base[cursor - 1]) ? 'table' : markdownRow(base[cursor - 1]));
          if (!kind || !line.endsWith('\n') || context.unsafe[cursor]
            || (cursor <= lastContent && previous !== kind)) return null;
        }
        const count = added[cursor].get(line) || 0;
        if (side === 1 && count > 0) added[cursor].set(line, count - 1);
        else {
          gaps[cursor].push(line);
          if (side === 0) added[cursor].set(line, count + 1);
        }
      }
    }
    if (cursor !== base.length) return null;
  }
  const merged = gaps.map((gap, i) => gap.join('') + (base[i] || '')).join('');
  if (markdown && markdownContext(textLines(merged))?.delimiters !== context.delimiters) return null;
  return /^(?:<{7}|={7}|>{7}|\|{7})/m.test(merged) ? null : merged;
}

// The card's "must import" requirement is satisfied by construction plus node --check:
// only delimiter-free header comment lines can be added, so executable bytes stay unchanged.
// Syntax validation must never execute the registry or resolve its imports.
function checkModuleSyntax(path) {
  return spawnSync(process.execPath, ['--check', path], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }).status === 0;
}

function readMerge(git, revisions, path) {
  const inputs = revisions.map(revision => git(['show', `${revision}:${path}`]));
  if (inputs.some(result => result.status !== 0)) return null;
  const texts = inputs.map(result => String(result.stdout));
  return path === ADVISORY_MERGE_PATHS[0] ? mergeTimingsJson(...texts)
    : mergeRegistryLines(...texts, path === 'docs/agent/testing.md');
}

const advisoryOnly = paths => paths.length > 0 && paths.every(path => ADVISORY_MERGE_PATHS.includes(path));

/** Builds a tree using an isolated index, leaving the caller's index and checkout untouched. */
export function resolveAdvisoryConflicts({ git, cur, ovSha }) {
  let scratch;
  try {
    if (![cur, ovSha].every(revision => FULL_SHA_RE.test(revision))) return null;
    const result = git(['merge-tree', '--write-tree', '--name-only', cur, ovSha]);
    if (result.status !== 1) return null;
    const lines = String(result.stdout ?? '').split('\n');
    const tree = lines.shift();
    const end = lines.indexOf('');
    if (!FULL_SHA_RE.test(tree) || end < 0) return null;
    const paths = lines.slice(0, end);
    if (!advisoryOnly(paths)) return null;
    const base = git(['merge-base', '--all', cur, ovSha]);
    const baseSha = String(base.stdout ?? '').trim();
    if (base.status !== 0 || !FULL_SHA_RE.test(baseSha)) return null;
    // A private index permits adopting the clean merge-tree entries without touching the real index.
    scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-advisory-merge-'));
    const options = { env: { GIT_INDEX_FILE: join(scratch, 'index') } };
    if (git(['read-tree', tree], options).status !== 0) return null;
    for (const path of paths) {
      const text = readMerge(git, [baseSha, cur, ovSha], path);
      if (text === null) return null;
      const blobPath = join(scratch, path.endsWith('.mjs') ? 'index.mjs' : 'timings.json');
      writeFileSync(blobPath, text);
      if (path.endsWith('.mjs') && !checkModuleSyntax(blobPath)) return null;
      const blob = git(['hash-object', '-w', '--', blobPath]);
      const blobSha = String(blob.stdout ?? '').trim();
      if (blob.status !== 0 || !FULL_SHA_RE.test(blobSha)) return null;
      if (git(['update-index', '--add', '--cacheinfo', '100644', blobSha, path], options).status !== 0) return null;
    }
    const written = git(['write-tree'], options);
    const mergedTree = String(written.stdout ?? '').trim();
    return written.status === 0 && FULL_SHA_RE.test(mergedTree)
      ? { ok: true, via: 'advisory-merge', tree: mergedTree } : null;
  } catch { return null; }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

/** Resolves only an advisory-only in-progress merge, then completes its merge commit. */
export function resolveAdvisoryInWorktree({ git, cwd }) {
  try {
    const unmerged = git(['diff', '--name-only', '-z', '--diff-filter=U']);
    if (unmerged.status !== 0) return false;
    const paths = String(unmerged.stdout ?? '').split('\0').filter(Boolean);
    if (!advisoryOnly(paths)) return false;
    const mergeHead = git(['rev-parse', '--verify', 'MERGE_HEAD']);
    if (mergeHead.status !== 0 || !FULL_SHA_RE.test(String(mergeHead.stdout ?? '').trim())) return false;
    const merged = paths.map(path => ({ path, text: readMerge(git, [':1', ':2', ':3'], path) }));
    if (merged.some(({ text }) => text === null)) return false;
    // Back up only the files we will stage and the index, for rollback on any failure.
    const originals = new Map(paths.map(path => {
      const fullPath = join(cwd, path);
      const stat = lstatSync(fullPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsupported advisory file');
      return [path, { link: stat.isSymbolicLink(),
        data: stat.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath) }];
    }));
    const index = git(['rev-parse', '--git-path', 'index']);
    if (index.status !== 0 || !String(index.stdout ?? '').trim()) return false;
    const indexPath = resolve(cwd, String(index.stdout).trim());
    const originalIndex = readFileSync(indexPath);
    const restore = () => {
      for (const [path, original] of originals) {
        const fullPath = join(cwd, path);
        if (original === null) rmSync(fullPath, { force: true });
        else {
          const current = lstatSync(fullPath, { throwIfNoEntry: false });
          if (original.link || (current && !current.isFile())) rmSync(fullPath, { recursive: true, force: true });
          if (original.link) symlinkSync(original.data, fullPath);
          else writeFileSync(fullPath, original.data);
        }
      }
      writeFileSync(indexPath, originalIndex);
      return false;
    };
    try {
      for (const { path, text } of merged) writeFileSync(join(cwd, path), text);
      for (const { path } of merged) {
        if (path.endsWith('.mjs') && !checkModuleSyntax(join(cwd, path))) return restore();
      }
      if (git(['add', '--', ...paths]).status !== 0) return restore();
      const remaining = git(['diff', '--name-only', '-z', '--diff-filter=U']);
      if (remaining.status !== 0 || String(remaining.stdout ?? '') !== '') return restore();
      return git(['commit', '--no-edit']).status === 0 || restore();
    } catch { return restore(); }
  } catch { return false; }
}
