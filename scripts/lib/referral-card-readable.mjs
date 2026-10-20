/** Is a `card` referral ruling's deferral backed by a real card? One definition for every reader of that gate. */
import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * Memo of card TEXT keyed by (repo, file, 40-hex commit sha). Content at a sha is immutable, so an entry can never go
 * stale. Successful reads only (errors are re-tried, so fail-closed behaviour is unchanged); bounded, oldest out.
 * Nothing else is cached: the `gh pr view` answer (state / head / base) is always asked fresh.
 */
export const CONTENT_MAX = 256;
export const createCardTextMemo = ({ max = CONTENT_MAX } = {}) => ({ max, text: new Map() });
const defaultMemo = createCardTextMemo();
const stderrLog = line => { try { process.stderr.write(`${line}\n`); } catch { /* logging never changes a verdict */ } };
const timed = (stage, log, fn) => {
  const t0 = performance.now();
  try { return fn(); } finally { log(`enrich-timing: ${stage} ${Math.round(performance.now() - t0)}`); }
};

/**
 * Default reader for a card on a PR: PR state + head sha, then the file at THAT sha, through gh. Throws (-> false)
 * on any failure. Only the repo named by CARD_REPO is ever asked, so a ruling cannot cite a card from elsewhere.
 * `pr` is the decimal digit string from the ref; anything else throws before gh is called.
 */
export function readCardAtPrHead(file, pr, { repo = CARD_REPO, run = execFileSync, memo = run === execFileSync ? defaultMemo : null, log = stderrLog } = {}) {
  if (typeof pr !== 'string' || !PR_NUMBER_RE.test(pr)) throw new TypeError('PR number must be a decimal digit string');
  const gh = args => run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
  const meta = timed('referral-card-gh-pr-view', log, () => JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state,headRefOid,baseRefName'])));
  if (meta.state !== 'OPEN' && meta.state !== 'MERGED') return null; // a CLOSED-unmerged PR's card will never land
  if (meta.baseRefName !== CARD_BASE) return null; // a stacked/side-branch PR's card never reaches the main backlog
  if (!/^[0-9a-f]{40}$/.test(meta.headRefOid ?? '')) return null;
  // Encoded as one path segment (defense in depth behind CARD_REF_RE): the verified sha stays the sole `ref` parameter.
  const key = `${repo}\0${file}\0${meta.headRefOid}`;
  if (memo?.text.has(key)) return memo.text.get(key);
  const text = timed('referral-card-gh-contents', log, () => gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/backlog/${encodeURIComponent(file)}?ref=${meta.headRefOid}`]));
  if (memo && typeof text === 'string') {
    memo.text.set(key, text);
    while (memo.text.size > memo.max) memo.text.delete(memo.text.keys().next().value);
  }
  return text;
}

/** A deferral is discharged only by an existing readable backlog card, never an intention to file. */
export function referralCardReadable(ref, root = process.cwd(), { readOnPr = readCardAtPrHead } = {}) {
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
      return readdirSync(`${root}/backlog`).some(name => name.endsWith('.md') && /^\d+-/.test(name) && (() => {
        const text = readFileSync(`${root}/backlog/${name}`, 'utf8');
        return card(text) && new RegExp(`^bornAs:[ \\t]*["']?${born}["']?[ \\t]*$`, 'm').test(text.split(/\r?\n---\r?\n/)[0]);
      })());
    } catch { return false; }
  }
}
