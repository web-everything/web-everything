/**
 * PR #5282: catch-up drains hung for 600s with no JSON, then retried the same heads on every round.
 * Drive the real enqueue-on-event handle with one ready PR and a real child that never emits JSON.
 * Only GitHub reads and successful admission are injected; the child timeout and catch-up scheduler run
 * unchanged. Check timeout classification, three skipped listings, expiry, and event/head recovery.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPO = 'example-owner/example-repo';
const NUM = 5261;

export default {
  id: 'fast-drain-timeout-backoff',
  title: 'catch-up fast drains timed out without a structured result and repeatedly retried the same PR head',
  card: 'PR #5282 (fast-drain-only-read)',
  fixedBy: {
    sha: 'lane/fast-drain-only-read', where: 'lane/fast-drain-only-read',
    paths: ['scripts/lib/enqueue-on-event.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/lib/enqueue-on-event.mjs'), 'utf8').includes("reason: 'timeout'");
    } catch { return false; }
  },
  async run({ log = () => {} } = {}) {
    const root = process.env.SOAK_TREE_ROOT || REPO_ROOT;
    const { createEnqueueOnEvent } = await import(pathToFileURL(join(root, 'scripts/lib/enqueue-on-event.mjs')).href);
    const violations = [];
    const check = (ok, detail) => { if (!ok) violations.push(detail); };
    const lines = [];
    let time = 1_000;
    let attempts = 0;
    let kills = 0;
    let hang = true;
    let head = 'a'.repeat(40);
    const handle = createEnqueueOnEvent({
      cwd: root, localSlug: REPO, env: {}, now: () => time,
      // Shorten only the child's wall clock; policy remains the production three-listing backoff.
      timeoutMs: 50,
      resolveSetting: () => ({
        enabled: true, debounceSeconds: 15, timeoutSeconds: 600,
        catchUp: { enabled: true, intervalMinutes: 10, concurrency: 1, busyIntervalSeconds: 60,
          maxQueued: 1, missSmellAfter: 3, blockedBackoffRounds: 6, timeoutBackoffRounds: 3 },
      }),
      log: line => { lines.push(line); log(line); },
      readCandidates: async () => ({ ok: true, queued: 0, prs: [{ num: NUM, readyAt: 0 }] }),
      readCapacity: () => ({ capacity: 1, source: 'soak' }),
      readPriorities: () => ({ priority: {}, buildPriority: [], mainFix: null }),
      readQueueDepth: async () => ({ ok: true, queued: 0, queuedNums: [] }),
      readPr: async () => ({
        state: 'OPEN', isDraft: false, headRefOid: head, labels: [{ name: 'ready-to-merge' }],
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
      readMembership: async () => ({ ok: true, inQueue: true }),
      spawnImpl: (_command, args, options) => {
        attempts++;
        check(args.includes(`--only=${NUM}`), 'the replay spawned a full drain instead of the target PR');
        if (hang) {
          const child = spawn(process.execPath, ['-e', keepAliveScript()], options);
          const kill = child.kill.bind(child);
          child.kill = signal => { kills++; return kill(signal); };
          return child;
        }
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => false;
        queueMicrotask(() => {
          child.stdout.emit('data', JSON.stringify({ enqueueOutcomes: [{ num: NUM, outcome: 'enqueued' }] }) + '\n');
          child.emit('close', 0);
        });
        return child;
      },
    });
    const nextRound = async () => { time += 600_000; return handle.catchUp(); };
    try {
      const first = await handle.catchUp();
      check(first[0]?.outcome === 'timeout', 'killed drain did not return outcome=timeout');
      check(kills === 1, 'the hung child was not stopped by the timeout');
      check(lines.some(line => line.includes('timed out after') && line.endsWith('[outcome=timeout]')),
        'the timeout was not diagnosed in the daemon log');
      for (let round = 1; round <= 3; round++) {
        const result = await nextRound();
        check(result[0]?.outcome === 'skipped' && attempts === 1, `same-head timeout retried during backoff listing ${round}`);
      }
      const retry = await nextRound();
      check(retry[0]?.outcome === 'timeout' && attempts === 2 && kills === 2, 'timeout was not retried after three listings');

      hang = false;
      handle.notePoll({ ok: true, marked: [{ key: `${REPO}#${NUM}`, cause: 'check_suite.completed=success@1' }] });
      time += 15_000;
      const event = await handle.tick();
      check(event[0]?.outcome === 'enqueued' && event[0]?.verified === true && attempts === 3,
        'a fresh event did not bypass the timeout backoff and verify admission');
      check(handle.blocked?.()?.size === 0, 'successful event admission left a stale timeout hold');

      hang = true;
      await nextRound();
      check(attempts === 4 && handle.blocked?.()?.get(NUM)?.reason === 'timeout', 'another timeout did not re-arm backoff');
      hang = false;
      head = 'b'.repeat(40);
      const changed = await nextRound();
      check(changed[0]?.outcome === 'enqueued' && attempts === 5 && handle.blocked?.()?.size === 0,
        'a changed PR head did not clear the timeout hold and retry');
      return { violations, attempts, kills };
    } finally { handle.kill(); }
  },
  judge(report) { return report.violations; },
};
