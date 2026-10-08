/**
 * @file scripts/conveyor/prep-review-io.mjs
 * @description The real effects behind `prep-review.mjs` (card x5f2daz): read the card at the PR head, probe main for
 * scope files, run the already-on-main check, spawn the tool-free reviewer, post the note and label. Thin on purpose:
 * every decision lives in the pure module. Argv arrays only, no shell; every path is checked before it is used.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { judgeSpawn } from '../lib/judge-spawn.mjs';
import { isSafeRepoRelativePath } from './prepare-outcome.mjs';
import {
  PREP_REVIEW_EFFORT, PREP_REVIEW_BUDGET_USD, readPrepReviewModel, resolvePrepReviewMode,
} from './prep-review.mjs';

const GH_TIMEOUT_MS = 30_000;
/** A card read over this fails (`ENOBUFS`) instead of returning part of a card. */
export const PREP_REVIEW_CARD_READ_MAX_BYTES = 16 * 1024 * 1024;

/** Who opened a PR and from where never changes, so one read serves every later tick (bounded; cleared when full). */
const AUTHOR_CACHE_MAX = 500;
const authorCache = new Map();

/**
 * @param {{root:string, env?:object, exec?:Function, judge?:Function, provider?:object, checkAlreadyDone?:Function}} o
 *   `root` is the daemon's own clone of the repo (it holds `origin/main`).
 */
export function makePrepReviewDeps({ root, env = process.env, exec = execFileSync, judge = judgeSpawn, provider = createGhProvider(), checkAlreadyDone = null } = {}) {
  const model = readPrepReviewModel({ readFile: (p) => readFileSync(p, 'utf8'), path: join(root, 'scripts/lib/model-settings.json') });
  return {
    mode: resolvePrepReviewMode(env),
    model,
    provider,
    readCard: (sha, path, repo) => {
      if (!/^[0-9a-f]{7,40}$/.test(sha) || !isSafeRepoRelativePath(path) || !/^\w[\w.-]*\/\w[\w.-]*$/.test(String(repo))) throw new Error('prep-review: refusing an unsafe card ref');
      return String(exec('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`],
        { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: PREP_REVIEW_CARD_READ_MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }));
    },
    // The PR's own changed-file paths, for the stale-label strip when the listing carried none. Throws on any failure.
    readPrFiles: (pr, repo) => {
      const n = pr?.number;
      if (!Number.isSafeInteger(n) || n <= 0 || !/^\w[\w.-]*\/\w[\w.-]*$/.test(String(repo))) throw new Error('prep-review: refusing an unsafe PR ref');
      const row = JSON.parse(String(exec('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'files'],
        { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })));
      return (Array.isArray(row?.files) ? row.files : []).map((f) => f?.path).filter((p) => typeof p === 'string');
    },
    readPrAuthor: (pr, repo) => {
      const n = pr?.number;
      if (!Number.isSafeInteger(n) || n <= 0 || !/^\w[\w.-]*\/\w[\w.-]*$/.test(String(repo))) throw new Error('prep-review: refusing an unsafe PR ref');
      const key = `${repo}#${n}`;
      if (authorCache.has(key)) return authorCache.get(key);
      const row = JSON.parse(String(exec('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'author,isCrossRepository'],
        { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })));
      const who = { author: row?.author ?? null, isCrossRepository: row?.isCrossRepository };
      if (authorCache.size >= AUTHOR_CACHE_MAX) authorCache.clear();
      authorCache.set(key, who);
      return who;
    },
    exists: (p) => {
      if (!isSafeRepoRelativePath(p)) return false;
      try { exec('git', ['-C', root, 'cat-file', '-e', `origin/main:${p.replace(/\/$/, '')}`], { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; }
    },
    checkAlreadyDone: checkAlreadyDone ?? (async (item) => {
      const { defaultCheckAlreadyDoneAsync } = await import('../operations/dispatch-lane-io.mjs');
      return defaultCheckAlreadyDoneAsync(item, { cwd: root });
    }),
    judge: ({ mandate, input, shape }) => judge({
      mandate, input, shape, model, effort: PREP_REVIEW_EFFORT, budget: PREP_REVIEW_BUDGET_USD,
      runId: `prep-review-${Date.now()}`, lens: 'prep-review',
    }),
  };
}
