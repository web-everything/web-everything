/** Is a `card` referral ruling's deferral backed by a real card? One definition for every reader of that gate. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';

/** A card reference: `we:backlog/<file>.md`, optionally `@pr<N>` = "the card as it stands on PR N's head" (xc7ctn1). */
// The file name is a strict alphabet (every backlog file already fits it): it is spliced into a local path AND a GitHub
// API URL, so `?`, `#`, `%`, `&`, `=`, `{}`, whitespace, newlines and `\` must never reach either one.
const CARD_FILE = '[A-Za-z0-9][A-Za-z0-9._-]*\\.md';
// The PR number is capped at 9 digits and handed to gh as that exact digit string: a longer one would be mangled by
// `Number()` into exponent notation (`1e+22`), which gh reads as a branch name rather than a PR number.
const PR_DIGITS = '[1-9]\\d{0,8}';
export const CARD_REF_RE = new RegExp(`^we:backlog/${CARD_FILE}(?:@pr${PR_DIGITS})?$`);
const PR_REF_RE = new RegExp(`^we:backlog/(${CARD_FILE})@pr(${PR_DIGITS})$`);
const PR_NUMBER_RE = new RegExp(`^${PR_DIGITS}$`);
const CARD_REPO = CONSTELLATION_REPOS.we.slug;
const CARD_BASE = 'main'; // a card only "will land" if its PR targets the branch the backlog is read from
const hasFrontmatter = text => /^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(text);

/** Per-stage timing line, so a slow review pass can be attributed (`enrich-timing: <stage> <ms>`). */
const logTiming = (stage, started, log) => log(`enrich-timing: ${stage} ${Math.round(performance.now() - started)}`);
const stderrLog = line => { try { process.stderr.write(`${line}\n`); } catch { /* logging never changes a verdict */ } };

/**
 * In-process read cache. Two layers, with different safety arguments:
 *  - `content`: card text keyed by (repo, file, 40-hex sha). A blob at a sha is immutable, so this never goes stale.
 *    Only successful reads are stored (errors are re-tried, so fail-closed behaviour is unchanged). Bounded, oldest out.
 *  - `heads`: the `gh pr view` answer (state / head sha / base), keyed by PR number, with a short TTL because a PR's
 *    state and head DO change. TTL is at most one pass, so a verdict can lag a PR change by <= TTL.
 */
export const HEAD_TTL_MS = 60_000;
export const CONTENT_MAX = 256;
export function createCardReadCache({ now = () => Date.now(), headTtlMs = HEAD_TTL_MS, contentMax = CONTENT_MAX } = {}) {
  return { now, headTtlMs, contentMax, heads: new Map(), content: new Map() };
}
const defaultCache = createCardReadCache();

/**
 * Default reader for a card on a PR: PR state + head sha, then the file at THAT sha, through gh. Throws (-> false)
 * on any failure. Only the repo named by CARD_REPO is ever asked, so a ruling cannot cite a card from elsewhere.
 * `pr` is the decimal digit string from the ref; anything else throws before gh is called.
 * Caching is on only for the real `gh` (a caller that injects `run` gets none unless it passes `cache`).
 */
export function readCardAtPrHead(file, pr, { repo = CARD_REPO, run = execFileSync, cache = run === execFileSync ? defaultCache : null, log = stderrLog } = {}) {
  if (typeof pr !== 'string' || !PR_NUMBER_RE.test(pr)) throw new TypeError('PR number must be a decimal digit string');
  const gh = args => run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
  const headKey = `${repo}#${pr}`;
  let meta = null;
  const hit = cache?.heads.get(headKey);
  if (hit && cache.now() - hit.at < cache.headTtlMs) meta = hit.meta;
  else {
    const t0 = performance.now();
    meta = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state,headRefOid,baseRefName']));
    logTiming('referral-card-gh-pr-view', t0, log);
    cache?.heads.set(headKey, { at: cache.now(), meta });
  }
  if (meta.state !== 'OPEN' && meta.state !== 'MERGED') return null; // a CLOSED-unmerged PR's card will never land
  if (meta.baseRefName !== CARD_BASE) return null; // a stacked/side-branch PR's card never reaches the main backlog
  if (!/^[0-9a-f]{40}$/.test(meta.headRefOid ?? '')) return null;
  const contentKey = `${repo}\0${file}\0${meta.headRefOid}`;
  if (cache?.content.has(contentKey)) return cache.content.get(contentKey);
  const t1 = performance.now();
  // Encoded as one path segment (defense in depth behind CARD_REF_RE): the verified sha stays the sole `ref` parameter.
  const text = gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/backlog/${encodeURIComponent(file)}?ref=${meta.headRefOid}`]);
  logTiming('referral-card-gh-contents', t1, log);
  if (cache && typeof text === 'string') {
    cache.content.set(contentKey, text);
    while (cache.content.size > cache.contentMax) cache.content.delete(cache.content.keys().next().value);
  }
  return text;
}

/**
 * The sha a checkout's HEAD points at, read from `.git` files (no process spawn, no git call). null when it cannot be
 * resolved, which makes the index below uncached (every lookup then scans, exactly as before).
 */
export function checkoutHeadSha(root) {
  try {
    let gitDir = `${root}/.git`;
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = m[1].trim();
    }
    const head = readFileSync(`${gitDir}/HEAD`, 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref) return null;
    try { const sha = readFileSync(`${gitDir}/${ref}`, 'utf8').trim(); if (/^[0-9a-f]{40}$/.test(sha)) return sha; } catch { /* packed */ }
    let common = gitDir;
    try { common = `${gitDir}/${readFileSync(`${gitDir}/commondir`, 'utf8').trim()}`; } catch { /* not a linked worktree */ }
    for (const dir of [gitDir, common]) {
      try {
        const line = readFileSync(`${dir}/packed-refs`, 'utf8').split('\n').find(l => l.endsWith(` ${ref}`));
        if (line && /^[0-9a-f]{40}/.test(line)) return line.slice(0, 40);
      } catch { /* none */ }
    }
    return null;
  } catch { return null; }
}

const BORN_LINE_RE = /^bornAs:[ \t]*["']?(x[a-z0-9]{6})["']?[ \t]*$/gm;
/** The set of birth names carried by landed cards (`NNN-*.md` with frontmatter), as the old per-lookup scan found them. */
function buildBornIndex(root) {
  const born = new Set();
  for (const name of readdirSync(`${root}/backlog`)) {
    if (!(name.endsWith('.md') && /^\d+-/.test(name))) continue;
    const text = readFileSync(`${root}/backlog/${name}`, 'utf8');
    if (!hasFrontmatter(text)) continue;
    for (const m of text.split(/\r?\n---\r?\n/)[0].matchAll(BORN_LINE_RE)) born.add(m[1]);
  }
  return born;
}
const bornIndexCache = new Map(); // root -> { key, born }; one entry per root, replaced when main moves
/** Lazily built once per (root, main sha, backlog dir mtime); rebuilt when either moves. Uncached when the sha is unknown. */
function bornIndexFor(root, log) {
  const sha = checkoutHeadSha(root);
  let key = null;
  if (sha) { try { key = `${sha}:${statSync(`${root}/backlog`).mtimeMs}`; } catch { key = null; } }
  const hit = key && bornIndexCache.get(root);
  if (hit && hit.key === key) return hit.born;
  const t0 = performance.now();
  const born = buildBornIndex(root);
  logTiming('referral-card-backlog-index', t0, log);
  if (key) bornIndexCache.set(root, { key, born });
  return born;
}
export const _resetBornIndexCache = () => bornIndexCache.clear();

/** A deferral is discharged only by an existing readable backlog card, never an intention to file. */
export function referralCardReadable(ref, root = process.cwd(), { readOnPr = readCardAtPrHead, log = stderrLog } = {}) {
  if (!CARD_REF_RE.test(ref ?? '')) return false;
  // `@pr<N>`: the card has no home on main yet, but it exists verbatim on that PR's head. Once it lands, the same
  // citation stays true (the PR is MERGED), so the recorded ruling never needs rewriting.
  const onPr = PR_REF_RE.exec(ref);
  if (onPr) {
    try { return hasFrontmatter(readOnPr(onPr[1], onPr[2]) ?? ''); } catch { return false; }
  }
  const card = hasFrontmatter;
  try { return card(readFileSync(`${root}/${ref.slice(3)}`, 'utf8')); }
  catch {
    // #4979 — a provisional card (`x…`) is renumbered when it lands (#2288 JIT numbering); a ruling that cited
    // it by its birth name still names that card through the landed file's `bornAs:`.
    const born = /^we:backlog\/(x[a-z0-9]{6})-/.exec(ref)?.[1];
    if (!born) return false;
    try {
      let index;
      try { index = bornIndexFor(root, log); } catch { index = null; }
      if (index) return index.has(born);
      // The index could not be built (an unreadable card): fall back to the original early-exit scan, so a failure
      // gives exactly the verdict it always did.
      return readdirSync(`${root}/backlog`).some(name => name.endsWith('.md') && /^\d+-/.test(name) && (() => {
        const text = readFileSync(`${root}/backlog/${name}`, 'utf8');
        return card(text) && new RegExp(`^bornAs:[ \\t]*["']?${born}["']?[ \\t]*$`, 'm').test(text.split(/\r?\n---\r?\n/)[0]);
      })());
    } catch { return false; }
  }
}
