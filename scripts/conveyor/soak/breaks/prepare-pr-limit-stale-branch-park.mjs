/**
 * @file breaks/prepare-pr-limit-stale-branch-park.mjs — live #5754: truncated open-pr dumps hid a stale
 * prepare-branch push failure and a PR-limit refusal. Both were recorded as `unknown` and parked behind
 * `needs-you: prepare ended unstamped twice`, even after an exception cleared the PR limit.
 *
 * Fix: recover publication diagnostics from the referenced open-pr run, give stale prepare branches their
 * own retry, and release PR-limit holds when clearance is granted
 * (`we:scripts/conveyor/prepare-failure-policy.mjs#releaseDuePrepareRetries`).
 *
 * The scenario runs the REAL ledger release against a throwaway coordination file and in-memory run records.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const POLICY = 'scripts/conveyor/prepare-failure-policy.mjs';
const STALE_RUN = 'open-pr-8bfa7c5c-a2bf-49ae-aa80-e7e928e0563d';
const LIMIT_RUN = 'open-pr-0478cb26-0bf5-4ab6-99c9-2b2061a529d7';
const truncatedDump = runId => `{\n  "runId": "${runId}",\n  "op": "open-pr",\n  "stopped": "effect-halted",\n  "applied": [],\n  "pending": {`;

export default {
  id: 'prepare-pr-limit-stale-branch-park',
  title: 'truncated open-pr dumps leave stale-branch and PR-limit prepares parked as unknown after clearance',
  card: '5754',
  fixedBy: { sha: '3f9bdec9d', where: 'lane/bluegreen-root-5754', paths: [POLICY] },
  fixPresent(root) {
    const p = join(root, POLICY);
    if (!existsSync(p)) return false;
    const source = readFileSync(p, 'utf8');
    return source.includes('stale-prepare-branch') && source.includes('openPrRun');
  },
  async run({ log } = {}) {
    const { readFailureState, releaseDuePrepareRetries } = await import(resolve(REPO_ROOT, POLICY));
    const dir = mkdtempSync(join(tmpdir(), 'soak-prepare-publication-'));
    const path = join(dir, 'prepare-failures.json');
    try {
      const held = (num, runId) => ({
        num, attempt: `run ${runId}`, stage: 'result', cause: 'unknown', held: true, retry: false,
        recordedAt: '2026-10-10T21:35:50.031Z',
        holdReason: 'needs-you: prepare ended unstamped twice - open-pr reported no PR number / open-pr reported no PR number',
        evidence: { error: truncatedDump(runId), reason: 'prepare-unstamped' },
      });
      writeFileSync(path, JSON.stringify({ cards: {}, failures: {
        staleBranch: held('5754', STALE_RUN), prLimit: held('5755', LIMIT_RUN),
      } }));
      const runs = new Map([
        [STALE_RUN, { effects: [{ error: 'push-failed: the lane HEAD is not the tip of lane/5754-prepare-example; refusing to publish the stale branch' }] }],
        [LIMIT_RUN, { input: { ref: 'lane/5755-prepare-example' }, effects: [{ result: {
          outcome: 'refused', reason: 'pr-limit', ref: 'lane/5755-prepare-example',
        } }] }],
      ]);
      const released = releaseDuePrepareRetries({
        path, now: Date.parse('2026-10-13T17:00:00Z'),
        openPrRun: runId => runs.get(runId) ?? null,
        prLimitClear: () => true, // An exception has been granted for the refused prepare PR.
      });
      const { staleBranch, prLimit } = readFailureState(path).failures;
      const report = { released, staleBranch, prLimit };
      log?.(`release: ${JSON.stringify(report)}`);
      return report;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) {
    const problems = [];
    if (report.staleBranch.held) problems.push('stale-branch prepare is still held after recovering the open-pr push failure');
    if (report.prLimit.held) problems.push('PR-limit prepare is still held after prLimitClear returned true');
    return problems;
  },
};
