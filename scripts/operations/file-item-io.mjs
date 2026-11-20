/**
 * @file scripts/operations/file-item-io.mjs
 * @description THE IO SHELL of the `file-item` declaration — reuses `we:scripts/operations/scaffold-io.mjs`'s
 *   reader and write sink verbatim, clears the freshly scaffolded card for the conveyor via
 *   `we:scripts/conveyor/queue-store.mjs`'s pure core, and preserves the card on origin's UTC-day batch branch.
 *
 * THE QUEUE SINK REACHES `queue-store.mjs` DIRECTLY, never `queue.mjs` as a subprocess — same shape as every
 * other operation's io shell (`dispatch-lane-io.mjs` reaches the conveyor's own modules directly rather than
 * shelling a CLI). `queue-store.mjs`'s own header says its sidecar path resolves by SCRIPT LOCATION, never
 * cwd, specifically so "the writer and readers can never diverge" — importing it here inherits that property
 * for free; a subprocess shell-out would not.
 *
 * WHERE THE QUEUE LIVES (decouple-primary-checkout, epic #4075). This sink used to resolve the LIVE runner's
 *   checkout (`resolve-runner-checkout.mjs`, `we:backlog/xtwondy-*`) and write THAT checkout's
 *   `.conveyor/queue.json`, because the queue was per-checkout and a card filed from a lane landed in a sidecar
 *   the runner never read. The queue is now ONE machine-wide file in the automation's state home
 *   (`queue-store.mjs#resolveQueuePath`) that every runner and daemon reads whichever checkout it runs from, so
 *   the default path is simply that file — the runner-resolution step (and its `lsof`/`ps` shell-outs) is gone.
 *   The "one effect or zero, never refused" invariant (`we:scripts/operations/file-item.mjs#planQueueing`) holds
 *   unchanged.
 *
 * IMPURE by construction: `fs`.
 */

import { createScaffoldReader, createScaffoldSinks, REPO_ROOT } from './scaffold-io.mjs';
import {
  readQueueFile, writeQueueFile, addToQueue, queueHas, resolveQueuePath,
} from '../conveyor/queue-store.mjs';
import { FILE_ITEM_QUEUE_EFFECT, FILE_ITEM_CARD_BRANCH_EFFECT } from './file-item.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { readOperatorTaskSettings } from '../lib/operator-task-settings.mjs';
import { classifySession } from './session-role.mjs';
import { readdirSync, lstatSync, realpathSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { searchCapabilities } from '../capability-search.mjs';
import { localDateString } from '../lib/local-date.mjs';

export { REPO_ROOT };

/** Worktree-free, fast-forward-only publication. Every unknown state keeps the card local and warns.
 * `git` is injectable; production uses argv, bounded children and a private index, never the lane index.
 * A new batch starts at the known origin/main commit, never unpublished worker history.
 */
export function createCardBranchSink({ root = REPO_ROOT, now = () => new Date(),
  git = (args, options) => execFileSync('git', args, options), warn = console.warn } = {}) {
  return async ({ rel } = {}) => {
    let scratch;
    let branch;
    let stage = 'locating card';
    try {
      if (typeof rel !== 'string' || !/^backlog\/[^/\\\x00-\x1f]+\.md$/.test(rel)) throw new Error('invalid card path');
      const abs = resolve(root, rel);
      if (!lstatSync(abs).isFile() || realpathSync(dirname(abs)) !== join(realpathSync(root), 'backlog')) {
        throw new Error('card is not a regular backlog file');
      }
      const bytes = readFileSync(abs);
      branch = `lane/card-batch-${localDateString(now(), 'UTC')}`;
      const ref = `refs/heads/${branch}`;
      scratch = mkdtempSync(join(tmpdir(), 'file-item-index-'));
      const env = { ...process.env };
      // Inherited Git context must not redirect object writes, the worktree, or the private index.
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
      env.GIT_INDEX_FILE = join(scratch, 'index');
      env.GIT_TERMINAL_PROMPT = '0';
      env.GIT_NO_REPLACE_OBJECTS = '1';
      const run = (args, input) => String(git([
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args,
      ], { cwd: root, env, input, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })).trim();
      const sha = (value) => {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('invalid git object id');
        return value;
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        stage = 'reading remote batch branch';
        let listing;
        try { listing = run(['ls-remote', '--exit-code', '--refs', 'origin', ref]); }
        catch (error) {
          // Only exit 2 with no output proves absence. Offline/auth/timeout is UNKNOWN, never absence.
          if (error.status !== 2 || String(error.stdout ?? '').trim()) throw error;
          listing = null;
        }
        let base;
        if (listing === null) {
          stage = 'reading origin/main baseline';
          base = sha(run(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']));
        } else {
          const fields = listing.split(/\s+/);
          if (fields.length !== 2 || fields[1] !== ref) throw new Error('incomplete remote branch evidence');
          base = sha(fields[0]);
          stage = 'fetching remote batch commit';
          // Fetch the advertised SHA, not an implicitly updated tracking ref (narrow clones work too).
          run(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', base]);
          if (run(['cat-file', '-t', base]) !== 'commit') throw new Error('remote tip is not a commit');
        }
        stage = 'building card-only commit';
        run(['read-tree', base]);
        const blob = sha(run(['hash-object', '-w', '--stdin'], bytes));
        const existing = run(['ls-tree', base, '--', rel]);
        if (existing) {
          if (existing !== `100644 blob ${blob}\t${rel}`) throw new Error('remote card already exists with different bytes');
          return { branch, pushed: true, sha: base, alreadyPresent: true };
        }
        run(['update-index', '--add', '--cacheinfo', '100644', blob, rel]);
        const tree = sha(run(['write-tree']));
        const commit = sha(run(['commit-tree', tree, '-p', base, '-m', 'backlog: preserve filed card']));
        stage = 'pushing card batch';
        try {
          run(['push', '--porcelain', 'origin', `${commit}:${ref}`]);
          return { branch, pushed: true, sha: commit };
        } catch (error) {
          const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
          if (attempt === 0 && /\[rejected\].*(?:fetch first|non-fast-forward)/.test(output)) continue;
          throw error;
        }
      }
    } catch (error) {
      const reason = String(error.code ?? error.status ?? 'unavailable').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
      const warning = `WARNING file-item: ${stage} failed (${reason}); card retained locally if present. Preserve the lane and retry card publication before release.`;
      warn(warning);
      return { pushed: false, ...(branch ? { branch } : {}), warning };
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  };
}

/** Scaffold facts plus the operator admission policy and origin/main preparation baseline. */
export function createFileItemReader({ root = REPO_ROOT,
  today = () => localDateString(new Date(), 'America/Toronto'),
  readPolicy = readOperatorTaskSettings,
  env = process.env,
  readTip = () => readGit(['rev-parse', 'origin/main'], { cwd: root }).trim(),
  ...opts } = {}) {
  const read = createScaffoldReader({ root, today, ...opts });
  return () => {
    let originMainSha;
    let tipRead = false;
    return {
      // The session role gates who may file an operator task (operatorTaskFields).
      searchDuplicates: (query) => {
        // The search CLI tolerates a missing corpus; filing must prove it was readable.
        const backlogDir = opts.backlogDir ?? join(root, 'backlog');
        readdirSync(backlogDir);
        return searchCapabilities(query, { root, backlogDir, limit: Number.MAX_SAFE_INTEGER });
      },
      ...read(), operatorTask: readPolicy(), sessionRole: classifySession(env).role,
      get originMainSha() {
        if (!tipRead) {
          tipRead = true;
          try { originMainSha = readTip(); } catch { /* only operator stamping needs a reachable main tip */ }
        }
        return originMainSha;
      },
    };
  };
}

/**
 * BUILD THE SINK MAP: scaffold's write, queue-clear, then injectable card-branch publication.
 *
 * THE QUEUE-CLEAR IS IDEMPOTENT BY CONSTRUCTION: `addToQueue` no-ops on an id already present (first
 * `addedAt` wins), so a replayed effect after a crash between `pending` and `applied` writes the identical
 * sidecar it would have on the first attempt.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] - the write sink's repo root (unchanged — `scaffold-io.mjs`'s own knob).
 * @param {Function} [opts.write] - the write sink's injected writer (unchanged — `scaffold-io.mjs`'s own knob).
 * @param {Function} [opts.queuePath] - EXPLICIT override, same contract as before: a zero-arg `() => path`
 *   that wins outright over the state-home default (tests use this to point at a fixture sidecar). Leave
 *   unset in production.
 */
export function createFileItemSinks({ root = REPO_ROOT, write, queuePath, now,
  cardBranch = createCardBranchSink({ root, now }) } = {}) {
  // No explicit override → the ONE state-home queue every runner/daemon reads (see the file header).
  const resolvePath = queuePath || (() => resolveQueuePath());

  return {
    ...createScaffoldSinks({ root, write }),
    [FILE_ITEM_CARD_BRANCH_EFFECT]: cardBranch,
    [FILE_ITEM_QUEUE_EFFECT]: async (payload) => {
      const path = resolvePath();
      const before = readQueueFile(path);
      const already = queueHas(before, payload.num);
      const after = addToQueue(before, payload.num, new Date().toISOString());
      if (!already) writeQueueFile(after, path);
      return { num: payload.num, queued: true, alreadyQueued: already, path };
    },
  };
}
