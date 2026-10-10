/**
 * @file breaks/prepare-lane-busy-burns-retry-budget.mjs — review of PR #4643. LIVE 2026-10-09: ~6 held prepares
 * were `could not acquire a lane … a LIVE lease` (a review loop held every free lane for hours). The first cut of
 * the re-classification retried them as `infra-transient` with the shared 2-attempt budget and NO backoff, so two
 * quick ticks spent the budget, the third failure was held for good with `cause: infra-transient` — a cause no heal
 * loop reclassifies and no card or `needsYou` line surfaces — i.e. the same silent hold the change set out to end.
 * The same patch also pulled a dispatch-stage `Command failed: git fetch … cannot lock ref` out of
 * `dispatch-transient` (exponential backoff, longer budget) into that 2-attempt `infra-transient` budget.
 *
 * Fix: `lane-busy` is its own cause on the backoff schedule (surfaced as `needs-you:` once the window is spent), and
 * the new infra patterns never claim a failure of the dispatch launch itself
 * (`we:scripts/conveyor/prepare-failure-policy.mjs#classifyPrepareFailure`).
 *
 * The scenario runs the REAL ledger (`recordPrepareFailure` + `releaseDuePrepareRetries`) in a throwaway
 * coordination file across consecutive one-minute ticks against a lease that never frees.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const POLICY = 'scripts/conveyor/prepare-failure-policy.mjs';

const LANE_BUSY = { error: 'unexpected error: could not acquire a lane: ✗ lane-10 is leased by review-4484 (review-loop) @ 2026-10-08T22:25:28.468Z — a LIVE lease; --force does not override it (#2337).', sessionAbsent: true, reason: 'prepare-unstamped' };
const DISPATCH_REF_LOCK = { reason: "Command failed: git fetch -q origin main\nerror: cannot lock ref 'refs/remotes/origin/main': is at a04b734 but expected adde7a6\n" };

export default {
  id: 'prepare-lane-busy-burns-retry-budget',
  title: 'a prepare held behind a long lane lease burns its whole retry budget in two ticks and is then held silently; '
    + 'a dispatch-stage ref lock loses its backoff',
  card: 'we:backlog (PR #4643 review — prepare-failure-policy lane-busy / dispatch-stage regression)',
  fixedBy: { sha: 'HEAD', where: 'lane/prepare-held-retry', paths: [POLICY, 'skills-src/conveyor/build-dispatch-daemon.mjs'] },
  fixPresent(root) {
    const p = join(root, POLICY);
    return existsSync(p) && /LANE_BUSY_RE/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const { recordPrepareFailure, releaseDuePrepareRetries, classifyPrepareFailure } = await import(resolve(REPO_ROOT, POLICY));
    const dir = mkdtempSync(join(tmpdir(), 'soak-lane-busy-'));
    const path = join(dir, 'prepare-failures.json');
    try {
      const t0 = Date.parse('2026-10-09T17:00:00Z');
      const ticks = [];
      for (let i = 0; i < 4; i += 1) {
        const now = t0 + i * 60_000; // the daemon ticks every minute; the lease never frees
        releaseDuePrepareRetries({ path, now });
        const f = await recordPrepareFailure({ num: '4425', attempt: `run ${i}`, stage: 'result', evidence: LANE_BUSY }, { path, fileCard: async () => ({ ok: true }), now });
        ticks.push({ i, cause: f.cause, held: f.held, retry: f.retry, retryAfter: f.retryAfter ?? null, holdReason: f.holdReason ?? null });
        log?.(`tick ${i}: ${JSON.stringify(ticks.at(-1))}`);
      }
      return { ticks, dispatchRefLockCause: classifyPrepareFailure(DISPATCH_REF_LOCK, 'dispatch') };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) {
    const problems = [];
    // A held failure must carry the way out: a time it is retried at, or a reason a person is told about.
    for (const t of report.ticks) {
      if (t.held && !t.retryAfter && !t.holdReason) problems.push(`tick ${t.i}: lane-busy failure held for good (cause ${t.cause}) with no retryAfter and nothing surfacing it`);
    }
    if (report.ticks.filter(t => t.retry).length >= 2) problems.push('lane-busy retried immediately on consecutive ticks — no backoff while the lease is still held');
    if (report.dispatchRefLockCause !== 'dispatch-transient') problems.push(`a dispatch-stage ref-lock failure classified ${report.dispatchRefLockCause}, not dispatch-transient (backoff lost)`);
    return problems;
  },
};
