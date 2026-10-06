/**
 * @file breaks/verify-daemon-kills-same-sha-gate.mjs — live break, 2026-10-05 (coroner-2, held card 65).
 *
 * LIVE INCIDENT: from 17:00Z the verify daemon started 87 gates; 11 were SIGKILLed as "superseded by a newer
 * request" and the same lane+sha re-ran from scratch (lane-2 @3257ba1d killed twice in 8 min; lane-5 @49556db0
 * dispatched three times). An agent whose `check --wait` timed out re-ran `verify-lane request` for the SAME sha,
 * gate and tree; the re-stamp alone counted as a newer request. A launchd SIGTERM (19:44Z) also SIGKILLed every
 * in-flight gate (lane-7 @e7f260d3, lane-2 @32303b3e), and the successor re-ran both.
 *
 * FIX — `scripts/conveyor/verify-dispatch.mjs` `sameVerifyRequest` / `inFlightSuperseded(…, policy)` (setting
 * `supersede: newer`) and `skills-src/conveyor/verify-daemon.mjs` `createCleanup({ restartInFlight: 'adopt' })` +
 * `adoptInFlight` (setting `restartInFlight: adopt`).
 *
 * SCENARIO: one in-flight gate; (1) the agent re-stamps an identical request; (2) the daemon gets SIGTERM.
 * RED = the gate is killed in either step. GREEN = it is kept, then handed to the successor.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'verify-daemon-kills-same-sha-gate',
  title: 'the verify daemon killed a running gate for an identical same-sha re-request or a restart, then re-ran it',
  card: 'held card 65 (coroner-2, 2026-10-05) — lane/verify-gate-waste',
  fixedBy: { sha: '418fbfdbe', where: 'lane/verify-gate-waste', paths: ['scripts/conveyor/verify-dispatch.mjs', 'skills-src/conveyor/verify-daemon.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/verify-dispatch.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('export function sameVerifyRequest');
  },
  async run({ log } = {}) {
    const dispatch = await import('../../verify-dispatch.mjs');
    const daemon = await import('../../../../skills-src/conveyor/verify-daemon.mjs');
    const violations = [];
    const entry = { runId: 'run-1', requestStartedAt: 't0', sha: 'head', suites: 'npx vitest related a.mjs --run', treeHash: 'tree' };
    const restamped = { status: 'running', sha: 'head', suites: entry.suites, treeHash: 'tree', startedAt: 't1' };
    const policy = dispatch.resolveSupersedePolicy ? dispatch.resolveSupersedePolicy({}) : undefined;
    if (dispatch.inFlightSuperseded(entry, restamped, 'head', policy)) {
      violations.push({ invariant: 'same-sha-superseded', detail: 'an identical re-request (same sha, gate, tree) would SIGKILL the running gate' });
    }
    const kills = [];
    const inFlight = new Map([['/lanes/x', { ...entry, pool: 'p', lane: 1, dir: '/lanes/x', pid: 4242, startedMs: 0 }]]);
    const restartInFlight = daemon.resolveRestartInFlight ? daemon.resolveRestartInFlight({}) : 'kill';
    const cleanup = daemon.createCleanup({ inFlight, restartInFlight, kill: (pid, sig) => kills.push([pid, sig]),
      stopHeartbeat: () => {}, release: () => {}, exit: () => {}, log: { error: (m) => log?.(m) }, handoff: (m) => [...m.values()] });
    cleanup.stopAndExit('SIGTERM', { adoptable: true });
    if (kills.length) violations.push({ invariant: 'restart-kills-gate', detail: `a daemon SIGTERM killed ${kills.length} in-flight gate(s) mid-run` });
    return { violations, out: { policy, restartInFlight, kills } };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
