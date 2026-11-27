/**
 * @file scripts/operations/live-work-io.mjs
 * @description The IO shell for `./live-work.mjs` (card x20lkf6, epic #3931). Every real read the RUNNING
 * section needs lives here, ADDING NO SECOND IMPLEMENTATION of a read another module already owns:
 *
 *   1. `createAgentActivityReader` (`./agent-activity-io.mjs`, card #3932) — the SAME `claude agents --json` +
 *      review-job + subagent + lane-lease + (with `all: true`) interactive-session sweep that operation's own
 *      declared op uses, called here with `all: true` so the operator's own interactive chats are in scope
 *      (the brief's own "the operator's interactive chats" bullet) — never a second directory walk.
 *   2. `collectHeavyQueue` / `assessHeavyQueue` (`./heavy-queue-io.mjs` / `./heavy-queue.mjs`, card xb0iuxq) —
 *      called and ASSESSED here exactly like `live-state-io.mjs` already does for its own `testQueue` section,
 *      so `./live-work.mjs#waitingForSlotWhos` reads the SAME already-classified WAITING rows.
 *   3. `pidAlive` (`./review-job-store.mjs`) — the SAME three-valued pid probe (EPERM = alive, ESRCH = dead)
 *      `listReviewJobAgents` already uses to prune dead job records, reused here for EVERY row that carries a
 *      `pid` (background sessions, review jobs alike), not just review jobs.
 *
 * THE ONE NEW PRIMITIVE: "last activity" — no existing operation reads a transcript/log's own mtime, so this
 * file adds it (`statMtimeMs`), applied to whatever `transcriptPath` `agent-activity-io.mjs` already computed
 * per row (this card's own small addition to that file — see its header) rather than re-deriving the path.
 */
import { statSync } from 'node:fs';

import { createAgentActivityReader } from './agent-activity-io.mjs';
import { collectHeavyQueue } from './heavy-queue-io.mjs';
import { assessHeavyQueue } from './heavy-queue.mjs';
import { pidAlive } from './review-job-store.mjs';

/** The mtime (ms since epoch) of `path`'s last write, or `null` when the path is absent/unreadable — a missing
 *  transcript is "unknown last activity", never "just now" or "never". */
export function statMtimeMs(path, stat = statSync) {
  if (!path) return null;
  try { return stat(path).mtimeMs; } catch { return null; }
}

/**
 * Stamp every raw agent-activity row with the two facts `./live-work.mjs#classifyRunState` needs that no
 * existing reader carries: `lastActivityAt` (the row's own `transcriptPath` mtime) and `pidAlive` (a real
 * `pidAlive` probe, `pid` present only). EXPORTED so `live-state-io.mjs` can enrich the SAME raw rows once and
 * hand them to `assessLiveWork` without this file's `collect()` also re-collecting the heavy queue a second
 * time — see that file's own header.
 * @param {object[]} rawRows
 * @param {{isAlive?:(pid:number) => boolean, stat?:Function}} [o]
 */
export function enrichRows(rawRows, { isAlive = pidAlive, stat = statSync } = {}) {
  return rawRows.map((row) => ({
    ...row,
    lastActivityAt: statMtimeMs(row.transcriptPath, stat),
    pidAlive: Number.isInteger(row.pid) ? isAlive(row.pid) : null,
  }));
}

/**
 * Build the injected `collect()` the declared operation calls. Every real read (`claude agents`, the review-job
 * store, lane-pool status, the harness's own project directories, the heavy-admission pool, each row's own
 * transcript/log mtime, a pid liveness probe) is bound here, and ONLY here.
 *
 * @param {{now?:() => number, readActivity?:(input:object) => {rows:object[]}, collectQueue?:Function,
 *   isAlive?:(pid:number) => boolean, stat?:Function, prToCard?: Record<string, unknown>}} [o]
 */
export function createLiveWorkCollector({
  now = Date.now,
  readActivity,
  collectQueue = collectHeavyQueue,
  isAlive = pidAlive,
  stat = statSync,
  prToCard = {},
} = {}) {
  return () => {
    // The default collector is constructed during module loading, which can reach
    // this module before agent-activity-io has initialized through a dispatch cycle.
    readActivity ??= createAgentActivityReader();
    const { rows: rawRows } = readActivity({ all: true });
    const heavyQueue = assessHeavyQueue(collectQueue());
    const rows = enrichRows(rawRows, { isAlive, stat });
    return { observedAt: new Date(now()).toISOString(), rows, heavyQueue, prToCard };
  };
}

/** The default collector, bound to every real read — what `run.mjs` wires the `live-work` operation to. */
export const collectLiveWork = createLiveWorkCollector();
