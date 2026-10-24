/** Shared size evidence and non-blocking PR admission. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_LABELS } from './review-labels.mjs';

export const OPEN_PR_MAX_NON_TEST_LINES = 300;

/** Pure git --numstat -z accounting (also accepts legacy unquoted newline rows).
 * Binary rows are unmeasurable; malformed or incomplete evidence must never become a zero-sized diff.
 */
function parseNumstat(numstatText) {
  if (typeof numstatText !== 'string') throw new Error('numstat must be text');
  if (!numstatText) return [];
  const nulDelimited = numstatText.includes('\0');
  if (nulDelimited && !numstatText.endsWith('\0')) throw new Error('unterminated numstat record');
  const rows = nulDelimited ? numstatText.slice(0, -1).split('\0') : numstatText.replace(/\n$/, '').split('\n');
  const entries = [];
  for (let i = 0; i < rows.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rows[i]);
    if (!match) throw new Error('unreadable numstat line');
    const [, additions, deletions] = match;
    let paths = [match[3]];
    // -z represents a rename as counts + empty path, then the old and new paths.
    if (nulDelimited && !paths[0]) {
      const source = rows[++i];
      const destination = rows[++i];
      if (!source || !destination) throw new Error('incomplete numstat rename');
      paths = [source, destination];
    }
    if (paths.some((path) => !path || (!nulDelimited && /[\t\r\n]|^"/.test(path)))) throw new Error('unreadable numstat path');
    if ((additions === '-') !== (deletions === '-')) throw new Error('unreadable numstat counts');
    if (additions === '-') throw new Error('unmeasurable numstat counts');
    const changed = Number(additions) + Number(deletions);
    if (!Number.isSafeInteger(changed)) throw new Error('numstat count exceeds safe integer range');
    entries.push({ paths, changed });
  }
  return entries;
}

export function createGitReader(cwd, exec = execFileSync) {
  // A replacement character changes filename identity: an empty lookup for the
  // substituted path could otherwise be mistaken for proof that a blob is absent.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return (args, options = {}) => {
    const output = exec('git', args, { cwd, encoding: null, maxBuffer: 64 * 1024 * 1024, ...options });
    return typeof output === 'string' ? output : decoder.decode(output);
  };
}

/** Attributes can override --text. Recover binary rows from immutable blobs, counting the
 * whole old and new files conservatively. Only a successful tree read proves a missing side.
 */
function countBinaryDiffRows(text, { git, topLevel, base, sha }) {
  if (!text.includes('-\t-\t')) return text;
  if (!text.endsWith('\0')) throw new Error('unterminated numstat record');
  const rows = text.slice(0, -1).split('\0');
  let mergeBase;
  // Bound the entire fallback, including every tree/blob read, rather than each file alone.
  const deadline = performance.now() + 60_000;
  const read = (args, options = {}) => {
    const timeout = Math.ceil(deadline - performance.now());
    if (timeout <= 0) throw new Error('binary size read timed out');
    return git(['-C', topLevel, ...args], { ...options, timeout });
  };
  const lines = (revision, path) => {
    const entry = read(['ls-tree', '-z', '--full-tree', revision, '--', path]);
    if (entry === '') return 0;
    const match = /^\d+ blob ([a-f0-9]+)\t([\s\S]*)\0$/.exec(entry);
    if (!match || match[2] !== path) throw new Error('unreadable diff blob');
    // Blob contents are arbitrary bytes, not filename metadata. Latin-1 preserves
    // one character per byte so newline counting never needs lossy UTF-8 decoding.
    const blob = read(['cat-file', 'blob', match[1]], { encoding: 'latin1' });
    let count = blob.length && !blob.endsWith('\n') ? 1 : 0;
    for (let i = 0; i < blob.length; i++) if (blob[i] === '\n') count++;
    return count;
  };
  for (let i = 0; i < rows.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rows[i]);
    if (!match) throw new Error('unreadable numstat line');
    const rowIndex = i;
    const source = match[3] || rows[++i];
    const destination = match[3] || rows[++i];
    if (!source || !destination) throw new Error('incomplete numstat path');
    if (match[1] !== '-' || match[2] !== '-') continue;
    mergeBase ??= read(['merge-base', base, sha]).trim();
    if (!mergeBase) throw new Error('missing diff merge base');
    rows[rowIndex] = `${lines(sha, destination)}\t${lines(mergeBase, source)}\t${match[3]}`;
  }
  return rows.join('\0') + '\0';
}

/** Local Git size evidence, separately constructible with a temp cwd or injected git/exec.
 * Tests can opt into the production reader without enabling credential resolution or the GitHub advisory.
 */
export function createPrDiffStatReader({ cwd = process.cwd(), exec = execFileSync, git = createGitReader(cwd, exec) } = {}) {
  return ({ base, sha }) => {
    if (!base || base.startsWith('-') || !sha || sha.startsWith('-')) throw new Error('invalid diff ref');
    const resolvedSha = git(['rev-parse', '--verify', `${sha}^{commit}`]).trim();
    let ref = base;
    try { git(['rev-parse', '--verify', '--quiet', `origin/${base}`]); ref = `origin/${base}`; } catch { /* use local base */ }
    // Remove Git's record terminator only; trailing whitespace can belong to the
    // directory name, and trimming it could select a different repository.
    const topLevel = git(['rev-parse', '--show-toplevel']).replace(/\n$/, '');
    const text = git(['-C', topLevel, '-c', 'core.attributesFile=', 'diff', '--no-relative', '--text', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', `${ref}...${resolvedSha}`], { timeout: 60_000 });
    return {
      text: countBinaryDiffRows(text, { git, topLevel, base: ref, sha: resolvedSha }),
      sha: resolvedSha,
    };
  };
}


const isTestPath = (path) => /(^|\/)__tests__\//.test(path) || /(^|\/)[^/]*\.(test|spec)\.[^/]+$/.test(path);
export function measureNonTestLines(text) {
  const entries = parseNumstat(text);
  let lines = 0;
  for (const { paths, changed } of entries) {
    if (!paths.every(isTestPath)) lines += changed;
    if (!Number.isSafeInteger(lines)) throw new Error('numstat total exceeds safe integer range');
  }
  return { lines, exempt: entries.length > 0 && entries.every(({ paths }) => paths.every((p) => p.startsWith('backlog/'))) };
}

export function planSizeAdmission(result) {
  if (!result || result instanceof Error || !Number.isSafeInteger(result.lines) || result.lines < 0 || typeof result.exempt !== 'boolean') {
    return { status: 'unknown', lines: null };
  }
  return { ...result, status: result.exempt || result.lines <= OPEN_PR_MAX_NON_TEST_LINES ? 'ok' : 'over' };
}

function fileSplitItem(fields, cwd) {
  const cli = fileURLToPath(new URL('../operations/run.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, 'file-item', ...Object.entries(fields).map(([key, value]) => `--${key}=${value}`), '--json'], {
    cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

// A durable local lookup also covers a failed forge create before its body was published.
function lookupLocalSplitCard({ ref }, cwd) {
  const token = `size-split-ref:${encodeURIComponent(ref)}`;
  const directory = join(cwd, 'backlog');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.md'))) {
    const text = readFileSync(join(directory, name), 'utf8');
    // The digest writer terminates the complete encoded ref with '. '. A prefix
    // such as lane/foo must never reuse the card for lane/foobar.
    if (text.includes(`${token}. `)) return { id: name.split('-')[0], rel: `backlog/${name}` };
  }
  return null;
}

export function createSizeAdmissionRunner({ cwd = process.cwd(), diffStat = createPrDiffStatReader({ cwd }),
  fileItem = (fields) => fileSplitItem(fields, cwd), lookupSplitCard = (request) => lookupLocalSplitCard(request, cwd),
} = {}) {
  return async (request) => {
    const { ref, base = 'main', sha = 'HEAD', body = '' } = request;
    let text, pinnedSha, plan;
    try {
      const evidence = await diffStat({ base, sha });
      text = typeof evidence === 'string' ? evidence : evidence.text;
      pinnedSha = typeof evidence === 'string' ? undefined : evidence.sha;
      plan = planSizeAdmission(measureNonTestLines(text));
    } catch (error) { plan = planSizeAdmission(error); }
    const result = { ...plan, body, reviewLabel: null, ...(pinnedSha ? { sha: pinnedSha } : {}) };
    if (plan.status === 'ok') return result;
    // #size-adds-reviewers-never-refuses: use the existing size escalation label path.
    result.reviewLabel = REVIEW_LABELS.pending;
    const refToken = encodeURIComponent(ref);
    const markerPattern = /<!-- size-admission:([^ ]+) ([^ ]+) -->/g;
    const existing = [...body.matchAll(markerPattern)].find((match) => match[1] === refToken);
    const groups = new Map();
    const files = new Set();
    if (plan.status === 'over') {
      for (const { paths, changed } of parseNumstat(text)) {
        if (paths.every(isTestPath)) continue;
        const path = [...paths].reverse().find((path) => !isTestPath(path));
        const group = path.split('/').slice(0, 2).join('/');
        groups.set(group, (groups.get(group) || 0) + changed);
        for (const path of paths.filter((path) => !isTestPath(path))) files.add(path);
      }
    }
    const groupLine = `File groups: ${groups.size ? [...groups].map(([group, lines]) => `we:${group}: ${lines}`).join('; ') : 'unavailable (size unknown)'}`;
    let cardId = null;
    try { if (existing && existing[2] !== '-') cardId = decodeURIComponent(existing[2]); } catch { /* malformed marker is not filing evidence */ }
    let cardNote = '';
    if (plan.status === 'over') {
      try {
        if (!cardId) {
          let card;
          try { card = await lookupSplitCard({ ref }); } catch { /* filing remains available */ }
          if (!card) {
            const filed = await fileItem({ title: `Split PR ${request.pr ? `#${request.pr}` : ref} into focused changes`, kind: 'story', size: 3,
              digest: `Plan follow-up splits for PR ${request.pr ? `#${request.pr}` : ref}. size-split-ref:${refToken}. ${groupLine}`,
              scope: [...files].map((path) => `we:${path}`).join(',') });
            card = filed?.run?.verdict;
          }
          if (!card || (!card.num && !card.id) || card.outcome === 'refused') throw new Error(card?.reason || 'file-item returned no card');
          cardId = String(card.num || card.id);
        }
        cardNote = `split card ${cardId} filed`;
      } catch (error) { cardNote = `split card not filed: ${String(error?.message || error).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 300)}`; }
    }
    // Replace only this ref's generated section, including unknown-size/failure retries.
    let previousBody = body;
    if (existing) {
      const start = body.lastIndexOf('\n\n## Size\n', existing.index);
      if (start >= 0) previousBody = body.slice(0, start) + body.slice(existing.index + existing[0].length).replace(/^\n/, '');
    }
    const note = plan.status === 'over'
      ? `${plan.lines} non-test lines (> ${OPEN_PR_MAX_NON_TEST_LINES}): ${cardNote}; extra reviewers requested via the size escalation (review:pending)`
      : 'size unknown: extra reviewers requested via the size escalation (review:pending)';
    result.body = `${previousBody}\n\n## Size\n\n${note}\n${groupLine}\n<!-- size-admission:${refToken} ${cardId ? encodeURIComponent(cardId) : '-'} -->\n`;
    return result;
  };
}
