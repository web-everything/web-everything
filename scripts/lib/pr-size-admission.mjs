/** Shared size evidence and non-blocking PR admission. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REVIEW_LABELS } from './review-labels.mjs';

export const OPEN_PR_MAX_NON_TEST_LINES = 300;
const SUMMARY_BYTES = 4096;

// Keep complete entries: scope is a comma-separated path list, so truncating it
// mid-path changes its meaning. Byte budgets also cover multibyte filenames.
function boundedEntries(entries, separator, budget = SUMMARY_BYTES) {
  const kept = [];
  let bytes = 0, omitted = 0;
  for (const entry of entries) {
    const cost = Buffer.byteLength(entry) + (kept.length ? Buffer.byteLength(separator) : 0);
    if (bytes + cost > budget) { omitted++; continue; }
    kept.push(entry);
    bytes += cost;
  }
  return { text: kept.join(separator), omitted };
}

function summaryText(text) {
  return text.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  // Scaffold resolves its root by script location, not cwd. Use the target lane's
  // copy so a direct pr-land caller cannot file in the dispatcher's checkout.
  const cli = resolve(cwd, 'scripts/operations/run.mjs');
  const output = execFileSync(process.execPath, [cli, 'file-item', ...Object.entries(fields).map(([key, value]) => `--${key}=${value}`), '--json'], {
    cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

async function publishLocalSplitCard(card, request, cwd) {
  if (typeof card?.rel !== 'string' || !/^backlog\/[A-Za-z0-9]+-[^/\\\x00-\x1f]+\.md$/.test(card.rel)) {
    throw new Error('split card has no publishable backlog path');
  }
  const git = createGitReader(cwd);
  // A card already in the canonical remote base needs no second publication.
  try {
    const entry = git(['ls-tree', '-z', '--full-tree', 'origin/main', '--', card.rel], { timeout: 5000 });
    const blob = /^100644 blob [a-f0-9]{40,64}\t([^\0]+)\0$/.exec(entry);
    if (blob?.[1] === card.rel) return { batched: true };
  } catch { /* the batch coordinator still checks its own publication evidence */ }
  const [{ fileIntoBatch }, { originSlugOf }] = await Promise.all([
    import('../operations/card-batch-file.mjs'), import('../conveyor/infra-blocked.mjs'),
  ]);
  const repo = originSlugOf(cwd);
  if (!repo) throw new Error('split-card publication repository is unknown');
  // The shared coordinator commits and pushes before returning batched:true. It
  // owns concurrency, retry dedupe and the later card-only PR/seal, without
  // changing the verified source SHA published by pr-land.
  return fileIntoBatch({ laneDir: cwd, cardPath: card.rel, actor: 'mechanical',
    idemKey: `size-split:${request.ref}`,
    source: { repo, pr: request.pr ?? null, head: request.sha, note: `Split oversized PR ${request.ref}` },
  });
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

function splitCardId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && id.length > 0 && !/[^A-Za-z0-9]/.test(id) ? id : null;
}

export function createSizeAdmissionRunner({ cwd = process.cwd(), diffStat = createPrDiffStatReader({ cwd }),
  fileItem = (fields) => fileSplitItem(fields, cwd), lookupSplitCard = (request) => lookupLocalSplitCard(request, cwd),
  publishSplitCard = (card, request) => publishLocalSplitCard(card, request, cwd),
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
    const groupSummary = boundedEntries([...groups].map(([group, lines]) => `we:${summaryText(group)}: ${lines}`), '; ');
    const groupLine = `File groups: ${groups.size ? groupSummary.text : 'unavailable (size unknown)'}`
      + (groupSummary.omitted ? `; ${groupSummary.omitted} group${groupSummary.omitted === 1 ? '' : 's'} omitted (summary budget)` : '');
    const scopePaths = [...files].filter((path) => !/[,\r\n]/.test(path));
    const scopeSummary = boundedEntries(scopePaths.map((path) => `we:${path}`), ',');
    const scopeOmitted = scopeSummary.omitted + files.size - scopePaths.length;
    let cardId = null;
    try { if (existing && existing[2] !== '-') cardId = splitCardId(decodeURIComponent(existing[2])); } catch { /* malformed marker is not filing evidence */ }
    // Older admission markers were written after scaffold alone. Only this new
    // receipt, emitted after publication, permits a retry to skip the publisher
    // (including after its batch has sealed and the coordinator moved on).
    const receipt = cardId ? `<!-- size-published:${refToken} ${encodeURIComponent(cardId)} -->\n` : '';
    let cardPublished = Boolean(receipt && body.slice(0, existing.index).endsWith(receipt));
    let cardNote = '';
    if (plan.status === 'over' && cardPublished) cardNote = `split card ${cardId} filed`;
    else if (plan.status === 'over') {
      try {
        let card;
        try { card = await lookupSplitCard({ ref }); } catch { /* filing remains available */ }
        if (!splitCardId(card?.num || card?.id) || card?.outcome === 'refused') {
          if (cardId) card = { id: cardId };
          else {
            const filed = await fileItem({ title: `Split PR ${request.pr ? `#${request.pr}` : ref} into focused changes`, kind: 'story', size: 3,
              digest: `Plan follow-up splits for PR ${request.pr ? `#${request.pr}` : ref}. size-split-ref:${refToken}. ${groupLine}`
                + (scopeOmitted ? `; ${scopeOmitted} scope path${scopeOmitted === 1 ? '' : 's'} omitted (scope budget or unrepresentable delimiter)` : ''),
              scope: scopeSummary.text });
            card = filed?.verdict;
          }
        }
        cardId = card?.outcome !== 'refused' ? splitCardId(card?.num || card?.id) : null;
        if (!cardId) throw new Error(card?.reason || 'file-item returned no card');
        const publication = await publishSplitCard(card, request);
        if (publication?.batched !== true) throw new Error(publication?.reason || 'split-card publication was not confirmed');
        if (publication.deduped) {
          // Concurrent filers can scaffold different local ids for this ref.
          // The coordinator's existing member is the card actually published.
          cardId = splitCardId(publication.member?.cardId);
          if (!cardId) throw new Error('published split-card identity was not confirmed');
        }
        cardPublished = true;
        cardNote = `split card ${cardId} filed`
          + (typeof publication.batchRef === 'string' && /^lane\/[A-Za-z0-9-]{1,100}$/.test(publication.batchRef)
            ? ` via ${publication.batchRef}` : '');
      } catch (error) {
        cardId = null;
        cardPublished = false;
        cardNote = `split card not filed: ${summaryText(String(error?.message || error).slice(0, 300))}`;
      }
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
    const publicationReceipt = cardPublished ? `<!-- size-published:${refToken} ${encodeURIComponent(cardId)} -->\n` : '';
    result.body = `${previousBody}\n\n## Size\n\n${note}\n${groupLine}\n${publicationReceipt}<!-- size-admission:${refToken} ${cardId ? encodeURIComponent(cardId) : '-'} -->\n`;
    return result;
  };
}
