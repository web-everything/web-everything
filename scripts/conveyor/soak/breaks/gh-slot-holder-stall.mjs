/**
 * Card 338, 2026-10-14: all six gh slots stayed occupied for roughly two minutes,
 * leaving every waiter to time out without identifying the holders. Replay the
 * real semaphore on private lock files with a virtual clock: one caller is capped,
 * a full pool reports its holders, and over-long holds yield to the next caller.
 * No GitHub calls or real-time 105-second sleeps are needed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const THROTTLE = 'scripts/lib/gh-throttle.mjs';
const HOLDERS = 'scripts/lib/gh-throttle-holders.mjs';

export default {
  id: 'gh-slot-holder-stall',
  title: 'six over-long gh slot holders stalled every waiter without attribution or bounded recovery',
  card: 'we:backlog/338 (PR #5326)',
  fixedBy: { sha: 'a4b18b2a0', where: 'lane/gh-slot-holder', paths: [THROTTLE, HOLDERS] },
  fixPresent(root) {
    try { return /acquireGhHolderSlot/.test(readFileSync(join(root, THROTTLE), 'utf8')); }
    catch { return false; }
  },
  async run({ log = () => {}, root = REPO_ROOT } = {}) {
    const throttle = await import(pathToFileURL(join(root, THROTTLE)).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-gh-holder-stall-'));
    const logPath = join(dir, 'calls.jsonl');
    const previousTelemetry = process.env.OPERATION_TELEMETRY_DIR;
    process.env.OPERATION_TELEMETRY_DIR = join(dir, 'telemetry');
    const violations = [];
    const check = (ok, invariant, detail) => { if (!ok) violations.push({ invariant, detail }); };
    const warnings = [];
    const startedAt = Date.now();
    let clock = startedAt;
    const policy = { maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 4 };
    const acquire = (owner, caller, holdPolicy = policy) => throttle.acquireGhSlotSync({
      lockRoot: dir, cap: 6, owner, pid: process.pid, logPath,
      now: () => clock, sleep: ms => { clock += ms; }, pollMs: 1, timeoutMs: 0,
      policy: holdPolicy, warn: message => warnings.push(message),
      meta: { caller, op: 'pr view', args: 'pr view <redacted>', parent: 'soak.mjs',
        ppid: process.ppid, acquiredAt: new Date(clock).toISOString(), timeoutMs: 90000 },
    });
    const release = owner => throttle.releaseGhSlotSync({ lockRoot: dir, cap: 6, owner });
    try {
      for (let slot = 0; slot < 4; slot++) {
        check(acquire(`holder-${slot}`, 'discovery').ok, 'setup', `holder ${slot} failed to acquire`);
      }
      const capped = acquire('excess-discovery', 'discovery');
      check(!capped.ok && capped.timedOut, 'caller-cap', 'one caller exceeded four slots while two were free');
      for (let slot = 4; slot < 6; slot++) {
        check(acquire(`holder-${slot}`, 'review').ok, 'setup', `holder ${slot} failed to acquire`);
      }

      // A live holder must retain its slot through max hold + grace, inclusive.
      clock = startedAt + 105000;
      const blocked = acquire('waiter-before-grace', 'drain');
      check(!blocked.ok && blocked.timedOut, 'premature-reap', 'a waiter acquired before the grace period ended');
      throttle.noteSlotTimeout(logPath, blocked, { caller: 'drain' }, message => warnings.push(message));
      const timeout = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').at(-1));
      check(timeout.outcome === 'slot_timeout' && timeout.holders?.length === 6 &&
        timeout.holders.every(h => h.alive && h.pid === process.pid && h.op === 'pr view' &&
          ['discovery', 'review'].includes(h.caller) && h.heldMs === 105000),
      'holder-attribution', 'timeout did not identify all six live holders and their hold durations');
      check(warnings.at(-1)?.includes('discovery(pr view, 105s)') && warnings.at(-1)?.includes('review(pr view, 105s)'),
        'holder-warning', 'timeout warning omitted the callers holding the pool');

      clock++;
      check(!acquire('waiter-disabled', 'drain', { ...policy, maxHoldSeconds: 0 }).ok,
        'disabled-reap', 'maxHoldSeconds=0 still reaped a live holder');
      const recovered = acquire('successor', 'drain');
      check(recovered.ok, 'pool-stalled', 'the full pool did not recover after max hold + grace');
      const reaped = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.outcome === 'slot_reaped');
      check(reaped.length === 6 && reaped.every(row => row.pid === process.pid && row.heldMs === 105001),
        'reap-evidence', 'recovery did not record all six over-long holders');
      process.kill(process.pid, 0); // Reaping must leave the live holder process alone.

      // A late finally from the old holder must not release the replacement's slot.
      for (let slot = 0; slot < 6; slot++) release(`holder-${slot}`);
      const { held } = throttle.ghThrottleStatus({ lockRoot: dir, cap: 6 });
      check(held.length === 1 && held[0].owner === 'successor' && held[0].slot === recovered.slot,
        'successor-release', 'an old holder released the successor slot');
      release('successor');
      check(acquire('next-tick', 'review').ok, 'recovery', 'the next daemon tick could not acquire a slot');
      release('next-tick');
      log(`gh slot replay: ${reaped.length} holders reaped; ${violations.length} violations`);
      return { violations };
    } finally {
      if (previousTelemetry === undefined) delete process.env.OPERATION_TELEMETRY_DIR;
      else process.env.OPERATION_TELEMETRY_DIR = previousTelemetry;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map(v => `[${v.invariant}] ${v.detail}`);
  },
};
