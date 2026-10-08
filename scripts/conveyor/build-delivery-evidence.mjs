/**
 * @file scripts/conveyor/build-delivery-evidence.mjs
 * @description What a build ACTUALLY delivered, read from the world rather than from the dispatch record.
 *
 * WHY (xykwe0h). The dispatch record said `orphan-released` for every Claude and agy build, even ones that
 * opened a PR (agy #4388 opened PR #4339), and the daemon relaunched cards whose PR was already open or merged
 * (#4382 after PR #4288 merged). Both mistakes come from trusting the record's liveness guess over the real
 * evidence. This module is the one place that answers "did this card already get delivered?":
 *   - a PR on a `lane/<num>...` branch (or titled `#<num>`), open or merged -> `pr-open` / `pr-merged`;
 *   - the card itself is `status: resolved` on origin/main -> `card-resolved`.
 * A closed-unmerged PR is NOT delivery. Prepare/scope authoring PRs are NOT delivery.
 *
 * PURE CORE / IO SHELL. The IO shell fails soft: any read that cannot be made yields `null` ("unknown"), never
 * "delivered" and never "not delivered".
 */
import { execFileSync } from 'node:child_process';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { ghRepoSlug, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import { normNum } from './queue-store.mjs';

/** A card id as it appears in a lane ref: a number with an optional retry letter, or a hash id (`xykwe0h`). */
const CARD_ID_IN_REF = String.raw`(?:\d+[a-z]?|x[a-z0-9]{6,7})`;

/**
 * The ref SHAPE of a prepare / scope authoring PR: `lane/<id>-(scope|prepare)-<slug>`, anchored to the card id, so
 * a build whose slug merely CONTAINS "scope"/"prepare" (`lane/4400-narrow-scope-of-x`) never matches. The shape
 * alone is NOT proof of authoring: a card whose own slug STARTS with scope-/prepare- gets a build branch of exactly
 * this shape (live PRs #700 `lane/2629-scope-review-to-convergence`, #743 `lane/2638-prepare-time-jury-charter`).
 * Use {@link isNonImplementingPr}, which also reads the title (review of PR #4361).
 */
export const NON_IMPLEMENTING_REF_RE = new RegExp(String.raw`^lane\/${CARD_ID_IN_REF}-(scope|prepare)-`, 'i');
/** The legacy hash-suffixed authoring ref (`lane/3435-scope-3dfab284`): never a card's own slug, so the ref decides. */
const HASHED_AUTHORING_REF_RE = new RegExp(String.raw`^lane\/${CARD_ID_IN_REF}-(?:scope|prepare)-[0-9a-f]{8}$`, 'i');
/**
 * The subjects the authoring flows mint, matched right after the id prefix so a card title that merely starts with
 * the word (`prepare-time jury charter`, `prepare-stamp works on…`) never matches: `prepare — …` (machine-pr-title
 * kinds `prepare` / `prepare-stamp`), `prepare item — …`, `complete prepare stamp`, `author scope: for #N` and
 * `author decision forks for #N`.
 */
const AUTHORING_SUBJECT_RE = /^(?:prepare(?:[- ](?:item|stamp))?\s*[—–-]\s|complete\s+prepare[- ]stamp\b|author\s+scope:\s*for\s+#|author\s+decision\s+forks\b)/i;
/** The older free-form authoring titles: `prepare #N: …` and `backlog: #N prepare-stamp (…)`. */
const LEGACY_AUTHORING_TITLE_RES = [/^prepare\s+#[a-z0-9]+:/i, /^backlog:\s*#[a-z0-9]+\s+prepare[- ]stamp\b/i];

/**
 * Is this the title of an authoring PR? Checked on the PUBLISHED title: `publicationTitle` (machine-pr-title.mjs)
 * files any subject it has no kind for under `build`, so the prepare-scope brief's `WE #N: author scope: for #N`
 * lands on GitHub as `WE #N: build — author scope: for #N`. The subject is read both bare and after that wrapper. PURE.
 */
function isAuthoringTitle(raw) {
  const title = String(raw ?? '').normalize('NFKC').trim();
  if (LEGACY_AUTHORING_TITLE_RES.some((re) => re.test(title))) return true;
  const subject = /^(?:[A-Za-z]+\s+)?#?[a-z0-9]+:\s*(.*)$/is.exec(title)?.[1] ?? '';
  const wrapped = /^build\s+[—–-]\s+(.*)$/is.exec(subject)?.[1] ?? '';
  return AUTHORING_SUBJECT_RE.test(subject) || AUTHORING_SUBJECT_RE.test(wrapped);
}

/**
 * Did this PR only author a card's scope or prepare it (never implement it)? THE one definition: `dispatch-lane-io`
 * imports it (it imports this module, so the shared home is here). An authoring title decides on any ref; an
 * authoring-shaped ref decides only when it is the hash-suffixed legacy shape or there is no title to read. PURE.
 */
export function isNonImplementingPr(pr) {
  const title = String(pr?.title ?? '').trim();
  if (isAuthoringTitle(title)) return true;
  const ref = String(pr?.headRefName ?? '');
  if (!NON_IMPLEMENTING_REF_RE.test(ref)) return false;
  return HASHED_AUTHORING_REF_RE.test(ref) || title === '';
}

/**
 * Is this PR pure backlog/doc housekeeping: it has changed files and EVERY one is `.md`? THE one definition
 * (#3473 guard 4): `filterAlreadyDoneCandidates` in `dispatch-lane-io` imports it, and {@link prBelongsToBuild}
 * applies a backlog-only form of it ({@link isBacklogOnlyPr}), so the two "was this card already built?" readers cannot disagree about a backlog-only PR (a
 * JIT-number commit, a "file the prevention card" PR) that merely sits on the card's lane ref or names its number.
 * A no-op (false) when `files` is absent or empty, so a row from a list that did not request `files` is unchanged. PURE.
 */
export function isDocsOnlyPr(pr) {
  const files = pr?.files;
  return Array.isArray(files) && files.length > 0 && files.every((f) => /\.md$/i.test(String(f?.path ?? f)));
}

/** Settled outcomes this module can name, in preference order when several PRs match. */
export const DELIVERY_OUTCOMES = Object.freeze(['pr-merged', 'pr-open', 'card-resolved']);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is this PR backlog housekeeping only: it has changed files and EVERY one is a `.md` under `backlog/`? The delivery
 * gate uses this NARROWER form of {@link isDocsOnlyPr}: a card whose real deliverable is a doc (a `skills-src/` brief,
 * a `docs/` page) is genuinely built by an all-`.md` PR, and treating it as undelivered would relaunch a duplicate
 * build. A false hold is recoverable; a duplicate build is not. PURE.
 */
export function isBacklogOnlyPr(pr) {
  const files = pr?.files;
  return isDocsOnlyPr(pr) && files.every((f) => /^backlog\//.test(String(f?.path ?? f)));
}

/** The lane-ref shape of card `key`'s builds: `lane/<key>`, an optional retry letter, then `-` or end. PURE. */
const laneRefRe = (key) => new RegExp(`^lane/${escapeRe(key)}[a-z]?(?:-|$)`, 'i');

/** Does this PR row belong to card `num` as a build? PURE. */
export function prBelongsToBuild(pr, num) {
  const key = normNum(num);
  if (!key || !pr || typeof pr !== 'object') return false;
  // A fork PR is outside-party input: a branch named `lane/<num>-x` there would otherwise suppress the card's
  // dispatch (review of PR #4361). Same-repo branches need write access, so only forks are dropped.
  if (pr.isCrossRepository === true) return false;
  const ref = String(pr.headRefName ?? '');
  if (isNonImplementingPr(pr)) return false;
  // Backlog-only housekeeping on the card's ref or naming its number is not a build, open or merged (the same
  // exclusion the already-done gate applies, review of PR #4361). Otherwise the build is silently skipped.
  if (isBacklogOnlyPr(pr)) return false;
  const refRe = laneRefRe(key);
  const titleRe = new RegExp(`(^|[^0-9])${escapeRe(key)}([^0-9]|$)`);
  return refRe.test(ref) || titleRe.test(String(pr.title ?? ''));
}

/** Merged state of a `gh pr list --json state` row: OPEN / MERGED / CLOSED (closed-unmerged). */
const stateOf = (pr) => String(pr?.state ?? '').toUpperCase();

/** Has this merged PR landed strictly BEFORE the day the card was (re)opened? Unreadable dates never say yes. PURE. */
function mergedBeforeCardOpened(pr, cardOpenedAt) {
  const opened = /^\d{4}-\d{2}-\d{2}/.exec(String(cardOpenedAt ?? '').trim())?.[0];
  const merged = /^\d{4}-\d{2}-\d{2}/.exec(String(pr?.mergedAt ?? ''))?.[0];
  return !!opened && !!merged && merged < opened; // ISO dates compare as strings; same-day merges still count
}

/**
 * The real delivery of `num`, or `null` when nothing shows it delivered. PURE.
 *
 * SEMANTICS OF A MERGED PR (review of PR #4361). A merged `lane/<num>-` PR means "this card was built" ONLY for
 * the card's current opening: a card deliberately re-queued for another build restamps `dateOpened`, and a merged
 * PR that landed on an EARLIER day than `cardOpenedAt` is the previous build, not this one, so it is ignored.
 * NOTE: `backlog.mjs unresolve` keeps `dateOpened` today, so a re-queue must restamp it by hand (or `unresolve`
 * must learn to); until then a re-queued card is still held, with the hold reason naming the merged PR.
 * Same-day merges still count (a card is routinely opened, built and merged on one day), and an unreadable or
 * absent `cardOpenedAt` ignores nothing: the failure direction stays "do not relaunch a delivered card". An OPEN
 * PR is live work and always counts. Slices of a split card are cards of their own (own number, own branch), so
 * a merged slice never shadows its siblings. Fork PRs (`isCrossRepository`) never count.
 * @param {{prs?: object[], cardStatus?: string|null, cardOpenedAt?: string|null, num: string|number}} o
 * @returns {null|{outcome: 'pr-merged'|'pr-open'|'card-resolved', pr: number|null, url?: string|null, reason: string}}
 */
export function classifyBuildDelivery({ prs = [], cardStatus = null, cardOpenedAt = null, num }) {
  const mine = (Array.isArray(prs) ? prs : []).filter((p) => prBelongsToBuild(p, num));
  const merged = mine.filter((p) => stateOf(p) === 'MERGED' || (p.mergedAt && stateOf(p) !== 'OPEN'))
    .filter((p) => !mergedBeforeCardOpened(p, cardOpenedAt))
    .sort((a, b) => (Date.parse(b.mergedAt ?? '') || 0) - (Date.parse(a.mergedAt ?? '') || 0))[0];
  if (merged) return { outcome: 'pr-merged', pr: merged.number ?? null, url: merged.url ?? null, reason: `PR #${merged.number} merged` };
  const open = mine.find((p) => stateOf(p) === 'OPEN');
  if (open) return { outcome: 'pr-open', pr: open.number ?? null, url: open.url ?? null, reason: `PR #${open.number} is open` };
  if (String(cardStatus ?? '').toLowerCase() === 'resolved') {
    return { outcome: 'card-resolved', pr: null, url: null, reason: `card #${normNum(num)} is resolved` };
  }
  return null;
}

/** The `status:` value of a card's frontmatter text, or null. PURE. */
export function cardStatusFromText(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text ?? ''));
  const m = fm && /^status:\s*["']?([a-z-]+)["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

/** The `dateOpened:` value (`YYYY-MM-DD…`) of a card's frontmatter text, or null. PURE. */
export function cardOpenedFromText(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text ?? ''));
  const m = fm && /^dateOpened:\s*["']?(\d{4}-\d{2}-\d{2}[^"'\s]*)["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

/** The card's text on origin/main (never the possibly-stale working tree). null = unknown. */
function readCardTextOnMain(num, { git = execFileSync, cwd = process.cwd() } = {}) {
  try {
    const key = normNum(num);
    const run = (args) => String(git('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }));
    const file = run(['ls-tree', '--name-only', 'origin/main', 'backlog/']).split('\n').find((f) => f.startsWith(`backlog/${key}-`));
    return file ? run(['show', `origin/main:${file}`]) : null;
  } catch { return null; }
}

/** Card status on origin/main (never the possibly-stale working tree). null = unknown. */
export function defaultReadCardStatus(num, io = {}) {
  return cardStatusFromText(readCardTextOnMain(num, io));
}

/** Card `dateOpened` on origin/main. null = unknown (which never hides a merged PR). */
export function defaultReadCardOpened(num, io = {}) {
  return cardOpenedFromText(readCardTextOnMain(num, io));
}

/**
 * PRs (any state) on a `lane/<num>` branch (a branch-PREFIX lookup: `--head` is exact-match only). null = the read failed.
 * The prefix deliberately has NO trailing `-`: {@link prBelongsToBuild} accepts a retry-letter ref (`lane/4480b-…`),
 * which `head:lane/4480-` can never return (verified live: it misses PR #3074). The wider prefix also returns other
 * cards that merely start with the same digits (`lane/44801-…`); those are dropped here by ref, before any title test.
 * `files` rides along so a backlog-only PR can be excluded ({@link isBacklogOnlyPr}).
 */
export function defaultListBuildPrs(num, { exec = execFileSyncThrottled, cwd = process.cwd() } = {}) {
  try {
    const key = normNum(num);
    const out = exec('gh', ['pr', 'list', '--repo', ghRepoSlug(DEFAULT_REPO_KEY), '--state', 'all', '--search', `head:lane/${key}`,
      '--limit', '100', '--json', 'number,state,title,headRefName,mergedAt,url,isCrossRepository,files'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL', cwd });
    const parsed = JSON.parse(String(out));
    // The query is by REF prefix, so only a row whose ref is this card's own can be evidence: a card sharing the
    // digit prefix (`lane/4481-…` for card 448) must not reach the title test and suppress this card's build.
    const ours = laneRefRe(key);
    return Array.isArray(parsed) ? parsed.filter((p) => ours.test(String(p?.headRefName ?? ''))) : null;
  } catch { return null; }
}

/**
 * IO shell: read the evidence and classify it. Never throws.
 * @returns {null|{outcome: string, pr: number|null, url?: string|null, reason: string}}
 */
export function readBuildDelivery(num, { listPrs = defaultListBuildPrs, readCardStatus = defaultReadCardStatus, readCardOpened = defaultReadCardOpened } = {}) {
  let prs = null, cardStatus = null, cardOpenedAt = null;
  try { prs = listPrs(num); } catch { prs = null; }
  try { cardStatus = readCardStatus(num); } catch { cardStatus = null; }
  try { cardOpenedAt = readCardOpened(num); } catch { cardOpenedAt = null; }
  return classifyBuildDelivery({ prs: prs ?? [], cardStatus, cardOpenedAt, num });
}
