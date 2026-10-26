/** Shared size evidence and non-blocking PR admission. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REVIEW_LABELS } from './review-labels.mjs';

export const OPEN_PR_MAX_NON_TEST_LINES = 300;
const SUMMARY_BYTES = 4096;
const SUMMARY_COUNT = 100;
// Require the absolute end of input for identities and paths at trust boundaries.
const FULL_SHA = /^[a-f0-9]{40}(?![\s\S])/;
const BODY_BYTES = 48 * 1024;
const CARD_PATH = /^backlog\/([A-Za-z0-9]{1,64})-[a-z0-9-]{1,160}\.md(?![\s\S])/;

function commitSha(value) {
  if (typeof value !== 'string' || !FULL_SHA.test(value.trim())) throw new Error('unresolved commit identity');
  return value.trim();
}

function qualifiedRef(value) {
  // Ref syntax, never revision-expression syntax (including reflogs and peel operators).
  if (!value.startsWith('refs/') || /[\x00-\x20\x7f~^:?*\[\]\\]/.test(value)
    || value.includes('..') || value.includes('@{') || value.includes('//')
    || value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('invalid qualified ref');
  }
  return value;
}

function boundedText(value, budget = 512) {
  const text = typeof value === 'string' ? value : '';
  let out = '', bytes = 0;
  for (const letter of text) {
    const escaped = summaryText(letter), cost = Buffer.byteLength(escaped);
    if (bytes + cost > budget - 3) return out + '...';
    out += escaped;
    bytes += cost;
  }
  return out;
}

// Keep complete entries: scope is a comma-separated path list, so truncating it
// mid-path changes its meaning. Byte budgets also cover multibyte filenames.
function boundedEntries(entries, separator, budget = SUMMARY_BYTES) {
  const kept = [];
  let bytes = 0, omitted = 0;
  for (const entry of entries) {
    const cost = Buffer.byteLength(entry) + (kept.length ? Buffer.byteLength(separator) : 0);
    if (kept.length >= SUMMARY_COUNT || bytes + cost > budget) { omitted++; continue; }
    kept.push(entry);
    bytes += cost;
  }
  return { text: kept.join(separator), omitted };
}

function summaryText(text) {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[&<>"'`\\[\](){}*_$#!|~]/g, (character) => `&#${character.codePointAt(0)};`);
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
    return git(['--literal-pathspecs', '-C', topLevel, ...args], { ...options, timeout });
  };
  const lines = (revision, path) => {
    const entry = read(['ls-tree', '-z', '--full-tree', revision, '--', path]);
    if (entry === '') return 0;
    const match = /^\d+ blob ([a-f0-9]{40})\t([\s\S]*)\0$/.exec(entry);
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
    mergeBase ??= commitSha(read(['merge-base', base, sha]));
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
    if (typeof base !== 'string' || typeof sha !== 'string') throw new Error('invalid diff ref');
    const headRef = FULL_SHA.test(sha) || sha === 'HEAD' ? sha
      : qualifiedRef(sha.startsWith('refs/') ? sha : `refs/heads/${sha}`);
    const resolvedSha = commitSha(git(['rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`]));
    let baseRef;
    if (base.startsWith('refs/')) {
      if (!base.startsWith('refs/remotes/')) throw new Error('base must be a remote-tracking ref');
      baseRef = qualifiedRef(base);
    }
    else if (base.startsWith('origin/')) baseRef = qualifiedRef(`refs/remotes/${base}`);
    else {
      const remote = base.includes('/') ? git(['remote'], { timeout: 60_000 }).split('\n')
        .find((name) => name && base.startsWith(`${name}/`)) : null;
      baseRef = qualifiedRef(`refs/remotes/${remote ? base : `origin/${base}`}`);
    }
    // Resolve the real remote-tracking base exactly once. Never fall back to a local shadow.
    const baseSha = commitSha(git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]));
    // Remove Git's record terminator only; trailing whitespace can belong to the
    // directory name, and trimming it could select a different repository.
    const topLevel = git(['rev-parse', '--show-toplevel']).replace(/\n$/, '');
    const text = git(['-C', topLevel, '-c', 'core.attributesFile=', 'diff', '--no-relative', '--text', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', `${baseSha}...${resolvedSha}`, '--'], { timeout: 60_000 });
    return {
      text: countBinaryDiffRows(text, { git, topLevel, base: baseSha, sha: resolvedSha }),
      sha: resolvedSha, baseSha,
    };
  };
}


const isTestPath = (path) => /(^|\/)__tests__\//.test(path) || /(^|\/)[^/]*\.(test|spec)\.[^/]+$/.test(path);
export function measureNonTestLines(text) {
  return measureEntries(parseNumstat(text));
}

function measureEntries(entries) {
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
  const filed = JSON.parse(output);
  const card = filed?.verdict;
  const path = typeof card?.rel === 'string' ? CARD_PATH.exec(card.rel) : null;
  const key = /^size-split-key:([a-f0-9]{64})\. /.exec(fields.digest)?.[1];
  // CLI output is untrusted. Confirm its safe identity/path against the card store
  // before passing it to the publisher or reporting a filed card in the PR.
  if (!key || !path || path[1] !== splitCardId(card?.num || card?.id)
    || !hasCardKey(readFileSync(join(cwd, card.rel), 'utf8'), key)) {
    throw new Error('file-item did not store this split-card identity');
  }
  return filed;
}

async function publishLocalSplitCard(card, request, cwd) {
  if (typeof card?.rel !== 'string' || !CARD_PATH.test(card.rel)) {
    throw new Error('split card has no publishable backlog path');
  }
  const git = createGitReader(cwd);
  // A card already in the canonical remote base needs no second publication.
  try {
    const entry = git(['ls-tree', '-z', '--full-tree', commitSha(request.baseSha), '--', card.rel], { timeout: 5000 });
    const blob = /^100644 blob [a-f0-9]{40,64}\t([^\0]+)\0$/.exec(entry);
    if (blob?.[1] === card.rel) return { batched: true };
  } catch { /* the batch coordinator still checks its own publication evidence */ }
  const [{ fileIntoBatch }, { originSlugOf }] = await Promise.all([
    import('../operations/card-batch-file.mjs'), import('../conveyor/infra-blocked.mjs'),
  ]);
  const repo = request.repo || originSlugOf(cwd);
  if (!repo) throw new Error('split-card publication repository is unknown');
  // The shared coordinator commits and pushes before returning batched:true. It
  // owns concurrency, retry dedupe and the later card-only PR/seal, without
  // changing the verified source SHA published by pr-land.
  return fileIntoBatch({ laneDir: cwd, cardPath: card.rel, actor: 'mechanical',
    idemKey: `size-split:${request.key}`,
    source: { repo, pr: request.pr ?? null, head: request.sha, note: `Split oversized PR ${boundedText(request.ref)}` },
  });
}

function hasCardKey(text, key) {
  return text.split('\n').some((line) => line.startsWith(`size-split-key:${key}. `));
}

// A durable local lookup also covers a failed forge create before its body was published.
function lookupLocalSplitCard({ key }, cwd) {
  if (!key) return null;
  const directory = join(cwd, 'backlog');
  const matches = [];
  for (const name of readdirSync(directory).filter((name) => CARD_PATH.test(`backlog/${name}`))) {
    const text = readFileSync(join(directory, name), 'utf8');
    // The trusted identity is a separate digest prefix, never a branch or a body receipt.
    if (hasCardKey(text, key)) matches.push({ id: name.split('-')[0], rel: `backlog/${name}` });
  }
  if (matches.length > 1) throw new Error('ambiguous split-card identity');
  return matches[0] || null;
}

// The exact Size note this module writes (see the runner's result.body). A marker in
// the editable body only names a candidate: text between the heading and the marker is
// replaced only when it is byte-for-byte this shape, so author text is never deleted.
const ESCAPED = '(?:[^\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069&<>"\'`\\\\[\\](){}*_$#!|~]|&#\\d{1,7};)';
const CARD_NOTE = 'split card (?:[A-Za-z0-9]{1,64} filed(?: via lane/[A-Za-z0-9-]{1,100})?|not filed \\(file-item failed\\))';
const ESCALATION = 'extra reviewers requested via the size escalation \\(review:pending\\)';
const OWN_NOTE = new RegExp(`^\\n\\n## Size\\n\\n(?:\\d{1,9} non-test lines \\(> ${OPEN_PR_MAX_NON_TEST_LINES}\\): ${CARD_NOTE}; ${ESCALATION}`
  + `|size unknown: ${ESCALATION}; ${CARD_NOTE})\\n`
  + `File groups: (?:unavailable \\(size unknown\\)|(?:we:${ESCAPED}*: \\d{1,12})?)(?:; and \\d{1,9} more \\(\\d{1,9} groups? omitted; summary budget\\))?`
  + '(?: Human review of the full diff is required; bounded summaries are incomplete\\.)?\\n'
  + '(?:<!-- size-published:[a-f0-9]{64} -->\\n)?(?![\\s\\S])');

function isOwnSizeNote(section, markerKey) {
  const published = /<!-- size-published:([a-f0-9]{64}) -->\n(?![\s\S])/.exec(section);
  return section.length <= 4 * SUMMARY_BYTES && OWN_NOTE.test(section) && (!published || published[1] === markerKey);
}

function splitCardId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && /^[A-Za-z0-9]{1,64}(?![\s\S])/.test(id) ? id : null;
}

export function createSizeAdmissionRunner({ cwd = process.cwd(), diffStat = createPrDiffStatReader({ cwd }),
  fileItem = (fields) => fileSplitItem(fields, cwd), lookupSplitCard = (request) => lookupLocalSplitCard(request, cwd),
  publishSplitCard = (card, request) => publishLocalSplitCard(card, request, cwd),
} = {}) {
  const run = async (input) => {
    const request = input && typeof input === 'object' ? input : {};
    const { ref = '', base = 'main', sha = 'HEAD' } = request;
    const body = typeof request.body === 'string' ? request.body : '';
    let entries, pinnedSha, baseSha, plan;
    try {
      const evidence = await diffStat({ base, sha });
      const text = typeof evidence === 'string' ? evidence : evidence.text;
      pinnedSha = typeof evidence === 'string' ? undefined : evidence.sha;
      baseSha = typeof evidence === 'string' ? undefined : evidence.baseSha;
      if (FULL_SHA.test(sha) && pinnedSha !== sha) {
        pinnedSha = sha;
        throw new Error('stale size request');
      }
      entries = parseNumstat(text);
      plan = planSizeAdmission(measureEntries(entries));
    } catch (error) { plan = planSizeAdmission(error); }
    const result = { ...plan, body, reviewLabel: null, ...(pinnedSha ? { sha: pinnedSha } : {}) };
    if (plan.status === 'ok') return result;
    result.reviewLabel = REVIEW_LABELS.pending;

    let repo = request.repo;
    if (!repo) {
      try { repo = (await import('../conveyor/infra-blocked.mjs')).originSlugOf(cwd); } catch { /* no reusable identity */ }
    }
    const head = FULL_SHA.test(sha) ? sha : pinnedSha;
    // A missing identity must not reuse another request's card. Repository/head stays
    // stable when the forge assigns a PR number after the initial admission.
    const key = typeof repo === 'string' && repo && FULL_SHA.test(head)
      && (request.pr == null || (Number.isSafeInteger(request.pr) && request.pr > 0))
      ? createHash('sha256').update(JSON.stringify([repo, head])).digest('hex') : null;
    const markerKey = key || createHash('sha256').update(randomUUID()).digest('hex');
    const filingRequest = { ...request, repo, sha: head, baseSha, key: markerKey };
    const groups = new Map(), files = new Set();
    if (plan.status === 'over') {
      for (const { paths, changed } of entries) {
        if (paths.every(isTestPath)) continue;
        const path = [...paths].reverse().find((path) => !isTestPath(path));
        const group = path.split('/').slice(0, 2).join('/');
        groups.set(group, (groups.get(group) || 0) + changed);
        for (const path of paths.filter((path) => !isTestPath(path))) files.add(path);
      }
    }
    const groupSummary = boundedEntries([...groups].map(([group, lines]) => `we:${summaryText(group)}: ${lines}`), '; ');
    const groupLine = `File groups: ${groups.size ? groupSummary.text : 'unavailable (size unknown)'}`
      + (groupSummary.omitted ? `; and ${groupSummary.omitted} more (${groupSummary.omitted} group${groupSummary.omitted === 1 ? '' : 's'} omitted; summary budget)` : '');
    // file-item's legacy comma-list API cannot represent commas. Its YAML writer
    // supplies the surrounding double quotes: JSON-escape their CONTENTS here.
    // Escape before budgeting so controls/quotes cannot expand past the argument cap.
    const scopePaths = [...files].filter((path) => !path.includes(','));
    const scopeSummary = boundedEntries(scopePaths.map((path) => JSON.stringify(`we:${path}`).slice(1, -1)
      .replace(/[\u0085\u2028\u2029]|\s+$/g, (text) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))), ',');
    const scopeOmitted = scopeSummary.omitted + files.size - scopePaths.length;
    const fallback = plan.status === 'unknown' || groupSummary.omitted || scopeOmitted
      ? ' Human review of the full diff is required; bounded summaries are incomplete.' : '';
    let cardId = null, cardPublished = false, cardNote;
    try {
      let card;
      // Only the trusted store can answer whether this repository/head has a card.
      // Editable body text is used below solely to replace a displayed note.
      try { card = await lookupSplitCard({ ...filingRequest, key }); } catch { /* ambiguity files a new card */ }
      if (!splitCardId(card?.num || card?.id) || card?.outcome === 'refused') {
        const subject = Number.isSafeInteger(request.pr) && request.pr > 0 ? `#${request.pr}` : boundedText(ref);
        const filed = await fileItem({ title: `Split PR ${subject} into focused changes`, kind: 'story', size: 3,
          digest: `size-split-key:${markerKey}. Plan follow-up splits for PR ${subject}. ${groupLine}`
            + (scopeOmitted ? `; and ${scopeOmitted} more (${scopeOmitted} scope path${scopeOmitted === 1 ? '' : 's'} omitted; scope budget or unrepresentable delimiter)` : '') + fallback,
          scope: scopeSummary.text });
        card = filed?.verdict;
      }
      cardId = card?.outcome !== 'refused' ? splitCardId(card?.num || card?.id) : null;
      if (!cardId) throw new Error('file-item returned no safe card identity');
      const publication = await publishSplitCard(card, filingRequest);
      if (publication?.batched !== true) throw new Error('split-card publication was not confirmed');
      if (publication.deduped) {
        cardId = splitCardId(publication.member?.cardId);
        if (!cardId) throw new Error('published split-card identity was not confirmed');
      }
      cardPublished = true;
      cardNote = `split card ${cardId} filed`
        + (typeof publication.batchRef === 'string' && /^lane\/[A-Za-z0-9-]{1,100}(?![\s\S])/.test(publication.batchRef)
          ? ` via ${publication.batchRef}` : '');
    } catch {
      cardId = null;
      cardNote = 'split card not filed (file-item failed)';
    }
    // Advisory markers are display hints only, including old ref-based notes.
    // Never read their ids/receipts as filing or publication evidence.
    let legacyToken;
    try { if (typeof ref === 'string' && ref.length <= 512) legacyToken = encodeURIComponent(ref); } catch { /* malformed ref */ }
    // A web edit returns CRLF; a forge may trim the leading blank lines of an empty description.
    const text = body.replace(/\r\n/g, '\n');
    // Our note is appended last, so prefer the last marker over an earlier quoted copy.
    // Marker tokens cannot span whitespace or `>`, so the match never reaches author text.
    const existing = [...text.matchAll(/<!-- size-admission:([^\s<>]{1,512})(?: [^\s<>]{1,256})? -->/g)]
      .findLast((match) => match[1] === markerKey || (legacyToken && match[1] === legacyToken));
    let previousBody = body;
    if (existing) {
      const heading = text.lastIndexOf('\n\n## Size\n', existing.index);
      const start = heading >= 0 ? heading : text.startsWith('## Size\n') ? 0 : -1;
      // Legacy ref-token notes predate the fixed shape: only their marker is dropped.
      const replaceNote = start >= 0 && existing[1] === markerKey
        && isOwnSizeNote((heading >= 0 ? '' : '\n\n') + text.slice(start, existing.index), markerKey);
      let end = existing.index + existing[0].length;
      if ((existing.index === 0 || text[existing.index - 1] === '\n') && text[end] === '\n') end++;
      previousBody = text.slice(0, replaceNote ? start : existing.index) + text.slice(end);
    }
    if (Buffer.byteLength(previousBody) > BODY_BYTES) previousBody = boundedText(previousBody, BODY_BYTES)
      + '\n\nPR description truncated; human review of the full diff is required.';
    const note = plan.status === 'over'
      ? `${plan.lines} non-test lines (> ${OPEN_PR_MAX_NON_TEST_LINES}): ${cardNote}; extra reviewers requested via the size escalation (review:pending)`
      : `size unknown: extra reviewers requested via the size escalation (review:pending); ${cardNote}`;
    result.body = `${previousBody}\n\n## Size\n\n${note}\n${groupLine}${fallback}\n`
      + (cardPublished ? `<!-- size-published:${markerKey} -->\n` : '')
      + `<!-- size-admission:${markerKey} -->\n`;
    return result;
  };
  // No malformed input or IO failure may block opening the PR or silence review escalation.
  return async (request) => {
    try { return await run(request); }
    catch {
      return { status: 'unknown', lines: null, reviewLabel: REVIEW_LABELS.pending,
        body: 'Size unknown: extra reviewers requested (review:pending); human review of the full diff is required. Split-card filing could not be confirmed.' };
    }
  };
}
