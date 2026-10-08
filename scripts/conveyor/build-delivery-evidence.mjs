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

/** Prepare / scope authoring PRs never implement the build (mirrors dispatch-lane-io NON_IMPLEMENTING_REF_RE). */
const AUTHORING_REF_RE = /^lane\/[^/]*?-(scope|prepare)-/i;

/** Settled outcomes this module can name, in preference order when several PRs match. */
export const DELIVERY_OUTCOMES = Object.freeze(['pr-merged', 'pr-open', 'card-resolved']);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does this PR row belong to card `num` as a build? PURE. */
export function prBelongsToBuild(pr, num) {
  const key = normNum(num);
  if (!key || !pr || typeof pr !== 'object') return false;
  // A fork PR is outside-party input: a branch named `lane/<num>-x` there would otherwise suppress the card's
  // dispatch (review of PR #4361). Same-repo branches need write access, so only forks are dropped.
  if (pr.isCrossRepository === true) return false;
  const ref = String(pr.headRefName ?? '');
  if (AUTHORING_REF_RE.test(ref)) return false;
  const refRe = new RegExp(`^lane/${escapeRe(key)}[a-z]?(?:-|$)`, 'i');
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

/** PRs (any state) on a `lane/<num>-` branch (a branch-PREFIX lookup: `--head` is exact-match only). null = the read failed. */
export function defaultListBuildPrs(num, { exec = execFileSyncThrottled, cwd = process.cwd() } = {}) {
  try {
    const key = normNum(num);
    const out = exec('gh', ['pr', 'list', '--repo', ghRepoSlug(DEFAULT_REPO_KEY), '--state', 'all', '--search', `head:lane/${key}-`,
      '--limit', '100', '--json', 'number,state,title,headRefName,mergedAt,url,isCrossRepository'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL', cwd });
    const parsed = JSON.parse(String(out));
    return Array.isArray(parsed) ? parsed : null;
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
