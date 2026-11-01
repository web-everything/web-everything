/**
 * @file scripts/conveyor/review-churn.mjs
 * @description R365 fix 4 (perf 2026-11-01, D-daemons-deep): stop redundant re-reviews. Live data (24 h, 116 review
 *   loops): three PRs took 13, 11 and 10 loops (29% of all loops). Their loops were NOT same-content re-arms: every
 *   loop judged a head with a genuinely new tree (fixer / advisory-fix pushes after an accept), so the driver is a
 *   fix-push -> re-review ping-pong. Two guards, each a policy-cascade leaf, both SHADOW by default:
 *   - `sameTree`: a head whose git tree equals the tree of an already ACCEPTED reviewed head owes no review (a new
 *     commit id over identical content). A changed tree is always reviewed.
 *   - `maxLoopsPerPr` (+ `capMode`): once a PR has accumulated that many reviews of distinct heads, a needs-you note
 *     (`review-churn`) tells a person the loop is not converging. The review itself STILL runs: changed code is never
 *     left unreviewed.
 *   Modes: `off` (today), `shadow` (compute and record `churnShadow` on the dispatch row, change nothing), `on`.
 *   Cascade: standard -> platform preference `reviewChurn` -> `scripts/settings/review.json#reviewChurn` -> env
 *   WE_REVIEW_CHURN_SAME_TREE / WE_REVIEW_CHURN_CAP_MODE / WE_REVIEW_CHURN_MAX_LOOPS.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { isReviewVerdictComment, reviewedHeadsOf, verdictKind } from './mechanical-round-cap.mjs';

export const REVIEW_CHURN_STANDARD = Object.freeze({ sameTree: 'shadow', capMode: 'shadow', maxLoopsPerPr: 8 });
const MODES = new Set(['off', 'shadow', 'on']);
const parseMode = (v) => { const x = String(v ?? '').trim().toLowerCase(); return MODES.has(x) ? x : undefined; };
const parseLoops = (v) => { const n = typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v) : v; return Number.isInteger(n) && n >= 1 && n <= 999 ? n : undefined; };
const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review.json');

/** @returns {{sameTree:string, capMode:string, maxLoopsPerPr:number, sources:object, invalid:string[]}} */
export function resolveReviewChurn({ env = process.env, file = SETTINGS_FILE, platform, tool } = {}) {
  let block = tool;
  if (block === undefined) { try { block = JSON.parse(readFileSync(file, 'utf8'))?.reviewChurn; } catch { block = undefined; } }
  const envValues = {
    sameTree: parseMode(env?.WE_REVIEW_CHURN_SAME_TREE), capMode: parseMode(env?.WE_REVIEW_CHURN_CAP_MODE),
    maxLoopsPerPr: parseLoops(env?.WE_REVIEW_CHURN_MAX_LOOPS),
  };
  const c = cascadePolicy('reviewChurn', block, { standard: REVIEW_CHURN_STANDARD, envValues, env, platform,
    valid: { sameTree: (v) => parseMode(v) === v, capMode: (v) => parseMode(v) === v, maxLoopsPerPr: (v) => Number.isInteger(v) && v >= 1 && v <= 999 } });
  return { ...REVIEW_CHURN_STANDARD, ...(c.value ?? {}), sources: c.sources, invalid: c.invalid };
}

/** Heads judged by trusted review verdicts on a PR, in thread order: [{ head, accept }]. Advisory notes do not count. */
export function reviewedHeadVerdicts(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isReviewVerdictComment(c)) continue;
    const kind = verdictKind(c);
    if (kind === 'advisory') continue;
    const head = reviewedHeadsOf(c)[0];
    if (head) out.push({ head, accept: kind === 'accept' });
  }
  return out;
}

/** PURE: how many reviews of DISTINCT heads this PR has had. */
export function countReviewLoops(comments) {
  return new Set(reviewedHeadVerdicts(comments).map((v) => v.head)).size;
}

/**
 * PURE decision from the enriched facts on `pr.reviewChurn` ({ settings, headTree, trees: {sha: tree} }).
 * Returns null (nothing), or { kind: 'same-tree'|'loop-cap', mode: 'shadow'|'on', ... }. A different tree is never
 * `same-tree`; an unknown tree is never `same-tree`.
 */
export function decideReviewChurn(pr) {
  const f = pr?.reviewChurn;
  if (!f?.settings) return null;
  const { sameTree, capMode, maxLoopsPerPr } = f.settings;
  const head = typeof pr.headRefOid === 'string' ? pr.headRefOid.trim().toLowerCase() : '';
  const verdicts = reviewedHeadVerdicts(pr.comments);
  const found = [];
  if (sameTree !== 'off' && head && f.headTree) {
    // Only a head whose LATEST verdict is an accept counts: a later changes verdict on it supersedes the accept.
    const latest = new Map(verdicts.map((v) => [v.head, v.accept]));
    const twin = verdicts.find((v) => latest.get(v.head) === true && !head.startsWith(v.head) && !v.head.startsWith(head)
      && f.trees?.[v.head] && f.trees[v.head] === f.headTree);
    if (twin) found.push({ kind: 'same-tree', mode: sameTree, head, reviewedHead: twin.head, tree: f.headTree });
  }
  if (capMode !== 'off') {
    const loops = countReviewLoops(pr.comments);
    const reviewedThisHead = verdicts.some((v) => head.startsWith(v.head));
    if (loops >= maxLoopsPerPr && !reviewedThisHead) found.push({ kind: 'loop-cap', mode: capMode, loops, cap: maxLoopsPerPr });
  }
  // An enforcing ('on') decision always wins over a shadow one, whatever the other guard's mode.
  return found.find((d) => d.mode === 'on') ?? found[0] ?? null;
}

const defaultReadTree = (repo, sha, { exec = execFileSync } = {}) => {
  try {
    const out = exec('gh', ['api', `repos/${repo}/git/commits/${sha}`, '--jq', '.tree.sha'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, killSignal: 'SIGKILL' });
    const t = String(out).trim();
    return /^[0-9a-f]{40}$/.test(t) ? t : null;
  } catch { return null; }
};
const treeMemo = new Map(); // a commit's tree is immutable

/** Attach `reviewChurn` facts. Trees are read only for PRs whose head differs from every reviewed head. */
export function enrichPrsWithReviewChurn(prs, { repo, settings = resolveReviewChurn(), readTree = defaultReadTree } = {}) {
  const list = Array.isArray(prs) ? prs : [];
  if (settings.sameTree === 'off' && settings.capMode === 'off') return list;
  const tree = (sha) => {
    const k = `${repo}@${sha}`;
    if (!treeMemo.has(k)) { const t = readTree(repo, sha); if (t) treeMemo.set(k, t); else return null; }
    return treeMemo.get(k);
  };
  return list.map((pr) => {
    const head = typeof pr?.headRefOid === 'string' ? pr.headRefOid.trim().toLowerCase() : '';
    const verdicts = reviewedHeadVerdicts(pr?.comments);
    const facts = { settings: { sameTree: settings.sameTree, capMode: settings.capMode, maxLoopsPerPr: settings.maxLoopsPerPr } };
    const accepted = verdicts.filter((v) => v.accept && /^[0-9a-f]{40}$/.test(v.head));
    if (settings.sameTree !== 'off' && head.length === 40 && accepted.length && !verdicts.some((v) => head.startsWith(v.head))) {
      const headTree = tree(head);
      if (headTree) {
        facts.headTree = headTree; facts.trees = {};
        for (const v of accepted) { const t = tree(v.head); if (t) facts.trees[v.head] = t; }
      }
    }
    return { ...pr, reviewChurn: facts };
  });
}
