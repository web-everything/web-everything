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
// A longshore ref is PR-pinned only: there is no local longshore checkout, and an unpinned one would be read by basename
// from WE's own main (repo-identity bypass). `we:` keeps its optional `@pr`.
export const CARD_REF_RE = new RegExp(`^(?:we:backlog/${CARD_FILE}(?:@pr${PR_DIGITS})?|longshore:backlog/${CARD_FILE}@pr${PR_DIGITS})$`);
const PR_REF_RE = new RegExp(`^(we|longshore):backlog/(${CARD_FILE})@pr(${PR_DIGITS})$`);
const PR_NUMBER_RE = new RegExp(`^${PR_DIGITS}$`);
const CARD_REPO = CONSTELLATION_REPOS.we.slug;
const CARD_BASE = 'main'; // a card only "will land" if its PR targets the branch the backlog is read from
const hasFrontmatter = text => /^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(text);

/**
 * Default reader for a card on a PR: PR state + head sha, then the file at THAT sha, through gh. Throws on failure
 * so the caller can check the landed card. The caller selects the repo from the validated prefix.
 * `pr` is the decimal digit string from the ref; anything else throws before gh is called.
 */
export function readCardAtPrHead(file, pr, { repo = CARD_REPO, run = execFileSync } = {}) {
  if (typeof pr !== 'string' || !PR_NUMBER_RE.test(pr)) throw new TypeError('PR number must be a decimal digit string');
  const gh = args => run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
  const meta = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state,headRefOid,baseRefName']));
  if (meta.state !== 'OPEN' && meta.state !== 'MERGED') return null; // a CLOSED-unmerged PR's card will never land
  if (meta.baseRefName !== CARD_BASE) return null; // a stacked/side-branch PR's card never reaches the main backlog
  if (!/^[0-9a-f]{40}$/.test(meta.headRefOid ?? '')) return null;
  // Encoded as one path segment (defense in depth behind CARD_REF_RE): the verified sha stays the sole `ref` parameter.
  return gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/backlog/${encodeURIComponent(file)}?ref=${meta.headRefOid}`]);
}

/** A deferral is discharged only by an existing readable backlog card, never an intention to file. */
export function referralCardReadable(ref, root = process.cwd(), { readOnPr = readCardAtPrHead, readMainByBornAs = readMainCardByBornAs } = {}) {
  if (!CARD_REF_RE.test(ref ?? '')) return false;
  // Prefer the PR head. After landing, JIT numbering may have renamed the card there, so when the PR read fails
  // ONLY the provisional (`x…`) birth name may resolve through a card PUBLISHED on origin/main whose `bornAs:` names
  // it. An explicit `@pr<N>` cite never reads the checkout's working tree (it may hold an unpublished card of a
  // feature branch): an unreadable PR card stays unreadable unless main itself carries it.
  const onPr = PR_REF_RE.exec(ref);
  if (onPr) {
    const [, prefix, file, pr] = onPr;
    const repo = prefix === 'longshore' ? CONSTELLATION_REPOS.longshore.slug : CARD_REPO;
    try {
      const text = (prefix === 'we' ? readOnPr(file, pr) : readOnPr(file, pr, { repo })) ?? '';
      // A longshore card is read remotely only, so require a real card (a known `status:` value), not just a delimiter pair.
      if (hasFrontmatter(text) && (prefix === 'we' || /^status:[ \t]*["']?(?:open|active|preparing|parked|resolved|closed|folded)["']?[ \t]*(?:#.*)?$/m.test(text.split(/\r?\n---\r?\n/)[0]))) return true;
    } catch { /* try the published WE card */ }
    if (prefix !== 'we') return false;
    const born = BORN_RE.exec(file)?.[1];
    if (!born) return false;
    try { return hasBornAs(readMainByBornAs(born, root) ?? '', born); } catch { return false; }
  }
  try { return hasFrontmatter(readFileSync(`${root}/${ref.slice(3)}`, 'utf8')); }
  catch { return landedByBornAs(ref, root); }
}

/** #4979 — a provisional card (`x…`) is renumbered when it lands (#2288 JIT numbering); a ruling that cited
 * it by its birth name still names that card through the landed file's `bornAs:`. */
function landedByBornAs(ref, root) {
  const born = /^we:backlog\/(x[a-z0-9]{6})-/.exec(ref)?.[1];
  if (!born) return false;
  try {
    return readdirSync(`${root}/backlog`).some(name => name.endsWith('.md') && /^\d+-/.test(name) && hasBornAs(readFileSync(`${root}/backlog/${name}`, 'utf8'), born));
  } catch { return false; }
}

const BORN_RE = /^(x[a-z0-9]{6})-/;
const hasBornAs = (text, born) => hasFrontmatter(text) && new RegExp(`^bornAs:[ \\t]*["']?${born}["']?[ \\t]*$`, 'm').test(text.split(/\r?\n---\r?\n/)[0]);

/**
 * The card on PUBLISHED `origin/main` (committed objects only — never the working tree) whose frontmatter `bornAs:`
 * is `born`, or null. Fails closed: any git failure, no match, or a non-card returns null.
 * `born` must be a provisional `x…` birth name (checked here too, since it is spliced into a git pattern).
 */
export function readMainCardByBornAs(born, root = process.cwd(), { run = execFileSync } = {}) {
  if (!/^x[a-z0-9]{6}$/.test(born ?? '')) return null;
  const rev = `origin/${CARD_BASE}`;
  const git = args => run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 1 << 20 });
  try {
    const hits = git(['grep', '-l', '-E', `^bornAs:[ \t]*["']?${born}["']?[ \t]*\r?$`, rev, '--', 'backlog/']).split('\n');
    for (const hit of hits) {
      const path = hit.startsWith(`${rev}:`) ? hit.slice(rev.length + 1) : '';
      if (!/^backlog\/\d+-[A-Za-z0-9._-]*\.md$/.test(path)) continue;
      const text = git(['show', `${rev}:${path}`]);
      if (hasBornAs(text, born)) return text;
    }
  } catch { /* no published card */ }
  return null;
}
