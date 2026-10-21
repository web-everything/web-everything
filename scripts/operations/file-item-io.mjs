/**
 * @file scripts/operations/file-item-io.mjs
 * @description THE IO SHELL of the `file-item` declaration — reuses `we:scripts/operations/scaffold-io.mjs`'s
 *   reader and write sink verbatim, and adds the one new sink `file-item.mjs` declares: clearing the freshly
 *   scaffolded card for the conveyor via `we:scripts/conveyor/queue-store.mjs`'s pure core.
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
import { FILE_ITEM_QUEUE_EFFECT } from './file-item.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { readOperatorTaskSettings } from '../lib/operator-task-settings.mjs';
import { classifySession } from './session-role.mjs';
import { localDateString } from '../lib/local-date.mjs';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export { REPO_ROOT };

/**
 * THE EXPLICIT TARGET-CHECKOUT KNOB (card xx7o40x follow-up). `file-item` writes into the checkout its own code
 * lives in (`scaffold-io.mjs#REPO_ROOT`, resolved by script location). A caller that must run ONE checkout's code
 * against ANOTHER checkout's tree — the detached prevention-card landing job, which runs the code of the clone
 * that spawned it (where daemon overlays such as number-at-birth are adopted) but must write into the lane it
 * acquired — names the target here. Unset → `REPO_ROOT`, exactly as before. Set but not an absolute git checkout
 * with a `backlog/` directory → THROWS: falling back to `REPO_ROOT` would write the card into the caller's own
 * checkout, the #4317 bug.
 */
export const FILE_ITEM_ROOT_ENV = 'WE_FILE_ITEM_ROOT';
export function fileItemRoot(env = process.env, { exists = existsSync } = {}) {
  const raw = env?.[FILE_ITEM_ROOT_ENV];
  if (raw === undefined || raw === '') return REPO_ROOT;
  const root = resolve(String(raw));
  if (!isAbsolute(String(raw)) || !exists(join(root, 'backlog')) || !exists(join(root, '.git'))) {
    throw new Error(`file-item: ${FILE_ITEM_ROOT_ENV}=${raw} is not an absolute checkout with a backlog/ directory`);
  }
  return root;
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
 * BUILD THE SINK MAP for `file-item`'s two effects: `scaffold`'s own write (reused verbatim from
 * `scaffold-io.mjs`) plus the new queue-clear.
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
export function createFileItemSinks({ root = REPO_ROOT, write, queuePath } = {}) {
  // No explicit override → the ONE state-home queue every runner/daemon reads (see the file header).
  const resolvePath = queuePath || (() => resolveQueuePath());

  return {
    ...createScaffoldSinks({ root, write }),
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
