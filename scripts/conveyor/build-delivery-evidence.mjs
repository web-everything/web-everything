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
  const ref = String(pr.headRefName ?? '');
  if (AUTHORING_REF_RE.test(ref)) return false;
  const refRe = new RegExp(`^lane/${escapeRe(key)}[a-z]?(?:-|$)`, 'i');
  const titleRe = new RegExp(`(^|[^0-9])${escapeRe(key)}([^0-9]|$)`);
  return refRe.test(ref) || titleRe.test(String(pr.title ?? ''));
}

/** Merged state of a `gh pr list --json state` row: OPEN / MERGED / CLOSED (closed-unmerged). */
const stateOf = (pr) => String(pr?.state ?? '').toUpperCase();

/**
 * The real delivery of `num`, or `null` when nothing shows it delivered. PURE.
 * @param {{prs?: object[], cardStatus?: string|null, num: string|number}} o
 * @returns {null|{outcome: 'pr-merged'|'pr-open'|'card-resolved', pr: number|null, url?: string|null, reason: string}}
 */
export function classifyBuildDelivery({ prs = [], cardStatus = null, num }) {
  const mine = (Array.isArray(prs) ? prs : []).filter((p) => prBelongsToBuild(p, num));
  const merged = mine.filter((p) => stateOf(p) === 'MERGED' || (p.mergedAt && stateOf(p) !== 'OPEN'))
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

/** Card status on origin/main (never the possibly-stale working tree). null = unknown. */
export function defaultReadCardStatus(num, { git = execFileSync, cwd = process.cwd() } = {}) {
  try {
    const key = normNum(num);
    const run = (args) => String(git('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }));
    const file = run(['ls-tree', '--name-only', 'origin/main', 'backlog/']).split('\n').find((f) => f.startsWith(`backlog/${key}-`));
    if (!file) return null;
    return cardStatusFromText(run(['show', `origin/main:${file}`]));
  } catch { return null; }
}

/** PRs (any state) on a `lane/<num>-` branch (a branch-PREFIX lookup: `--head` is exact-match only). null = the read failed. */
export function defaultListBuildPrs(num, { exec = execFileSyncThrottled, cwd = process.cwd() } = {}) {
  try {
    const key = normNum(num);
    const out = exec('gh', ['pr', 'list', '--repo', ghRepoSlug(DEFAULT_REPO_KEY), '--state', 'all', '--search', `head:lane/${key}-`,
      '--limit', '20', '--json', 'number,state,title,headRefName,mergedAt,url'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL', cwd });
    const parsed = JSON.parse(String(out));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * IO shell: read the evidence and classify it. Never throws.
 * @returns {null|{outcome: string, pr: number|null, url?: string|null, reason: string}}
 */
export function readBuildDelivery(num, { listPrs = defaultListBuildPrs, readCardStatus = defaultReadCardStatus } = {}) {
  let prs = null, cardStatus = null;
  try { prs = listPrs(num); } catch { prs = null; }
  try { cardStatus = readCardStatus(num); } catch { cardStatus = null; }
  return classifyBuildDelivery({ prs: prs ?? [], cardStatus, num });
}
