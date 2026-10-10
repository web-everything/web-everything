/**
 * @file scripts/lib/stack-review-while-open.mjs
 * @description Setting `stack.reviewWhileBaseOpen` (operator go 2026-10-10): a PR opened as a GitHub stack (its base is
 *   another PR's `lane/*` branch, not `main`) is promoted, reviewed and fixed while its base PR is still open, instead
 *   of waiting for the base to land. Merge still waits for the base: the drain never merges a PR whose base is not the
 *   default branch (`merge-ai-prs.mjs#classifyPr`).
 *
 *   Live before (2026-10-10): #4750, #4757, #4759 and #4770 sat as drafts labelled `review-status:awaiting-base`. CI ran
 *   only for PRs into `main`, so a stacked draft never had green checks, never got promoted, and the review daemon
 *   skipped it as a draft. A stack of N PRs was reviewed one PR at a time, one base landing apart.
 *
 *   What the setting gates:
 *     - promotion of a stacked draft whose OWN required checks are green on its head
 *       (`draft-promotion-rule.mjs#isDraftOwedPromotion`, `promote-draft-pr-dispatch.mjs`);
 *     - parallel fixing of a stacked top whose own change touches none of its base's files
 *       (`pr-stack.mjs#applyStackOrder`; a top that does touch them keeps the bottom-first order of #4655).
 *   Review then follows the ordinary path: a ready PR with green checks is owed a review, and the stack-aware review
 *   (#4729, `review-stack-base.mjs`) judges the top against its base and carries an accept forward after the restack.
 *
 *   Cascade (the same shape as `policy-cascade.mjs`, PR #4772, which was not merged when this shipped):
 *     1. standard default `true`;
 *     2. tool override: `stack.reviewWhileBaseOpen` in `we:scripts/settings/stack.json`;
 *     3. env `WE_STACK_REVIEW_WHILE_BASE_OPEN` (`on`/`off`).
 *   An unparseable value at a layer is ignored. The source of the value in force is logged once per process (inside a
 *   daemon, or with `WE_POLICY_CASCADE_LOG=1`; never under test unless `=1`). Never throws.
 */
import { readSettings } from './settings-files.mjs';
import { isUnderTest } from './under-test.mjs';

export const STACK_REVIEW_WHILE_BASE_OPEN_DEFAULT = true;
export const STACK_REVIEW_WHILE_BASE_OPEN_ENV = 'WE_STACK_REVIEW_WHILE_BASE_OPEN';
const LOG_ENV = 'WE_POLICY_CASCADE_LOG';

const parseSwitch = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim().toLowerCase();
  return /^(on|true|1|yes)$/.test(s) ? true : /^(off|false|0|no)$/.test(s) ? false : null;
};

/**
 * The value in force and the layer it came from. Never throws.
 * @returns {{value:boolean, source:'standard'|'tool'|'env'}}
 */
export function resolveStackReviewWhileBaseOpen(env = process.env, { read = readSettings } = {}) {
  const fromEnv = parseSwitch(env?.[STACK_REVIEW_WHILE_BASE_OPEN_ENV]);
  if (fromEnv !== null) return { value: fromEnv, source: 'env' };
  let tool = null;
  try { tool = parseSwitch(read()?.stack?.reviewWhileBaseOpen); } catch { tool = null; }
  if (tool !== null) return { value: tool, source: 'tool' };
  return { value: STACK_REVIEW_WHILE_BASE_OPEN_DEFAULT, source: 'standard' };
}

let lastLogged = null;
const shouldLog = (env) => {
  const flag = String(env?.[LOG_ENV] ?? '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  if (isUnderTest(env)) return false;
  return /-daemon\.mjs$/.test(String(process.argv[1] ?? ''));
};

/** {@link resolveStackReviewWhileBaseOpen}, plus the one-line source log. Returns the boolean in force. */
export function stackReviewWhileBaseOpen(env = process.env, { read = readSettings, log = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const r = resolveStackReviewWhileBaseOpen(env, { read });
  const line = `policy-cascade · stack: reviewWhileBaseOpen=${r.value} (${r.source})`;
  if (line !== lastLogged && shouldLog(env)) {
    lastLogged = line;
    try { log(line); } catch { /* logging never fails a decision */ }
  }
  return r.value;
}

/** PURE. Is this PR a GitHub stack, i.e. its base is a branch other than the default branch? Unknown base: no. */
export function isGithubStacked(pr, defaultBranch = 'main') {
  const base = typeof pr?.baseRefName === 'string' ? pr.baseRefName : '';
  return base !== '' && base !== defaultBranch;
}

/**
 * PURE. May a stacked top be fixed in parallel with its open bottom? Only when the top's OWN change (its diff from the
 * bottom's head) touches none of the bottom's files. An unknown file list on either side is "touches" (fail closed:
 * the #4655 bottom-first order holds).
 * @param {{topOwnFiles:string[]|null, bottomFiles:string[]|null}} o
 * @returns {{parallel:boolean, overlap:string[]|null}}
 */
export function stackedTopMayFixInParallel({ topOwnFiles, bottomFiles } = {}) {
  if (!Array.isArray(topOwnFiles) || !Array.isArray(bottomFiles)) return { parallel: false, overlap: null };
  const bottom = new Set(bottomFiles);
  const overlap = topOwnFiles.filter((f) => bottom.has(f));
  return { parallel: overlap.length === 0, overlap };
}

/** Test seam: forget the once-per-process log memory. */
export const resetStackReviewLog = () => { lastLogged = null; };
