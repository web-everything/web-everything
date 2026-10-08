/**
 * @file breaks/infra-auto-rearm-budget-not-persisted.mjs — PR #4396 / card xg44s2t review bounce. The infra retry
 * pass's auto re-arm (an attempt-capped entry whose GitHub outage has passed is reset by the product itself) is
 * bounded by a per-entry `autoRearms` counter (default 2). But `parseInfraStore` rebuilt every entry from a fixed
 * field whitelist that did not include `autoRearms`, so EVERY read of the sidecar (the retry pass's snapshot, and
 * the re-read inside every locked mutation) dropped it: the budget always read as unspent and an entry that kept
 * failing was re-armed every time it hit the cap, forever — the bound was inert in production while every unit
 * test (in-memory objects, no file round trip) stayed green.
 *
 * Scenario: the REAL `infra-blocked.mjs retry` CLI against a real sidecar file (`CONVEYOR_INFRA_FILE`) holding one
 * attempt-capped, outage-caused entry whose auto re-arm budget is already spent (`autoRearms: 2`), last attempted
 * long past the cool-off (so it is eligible on either the offline or the "GitHub operational" path). With the fix
 * the budget survives the read: the entry is surfaced, not re-armed, and the file keeps its count and its cap.
 * Before the fix the counter is dropped on read, the pass reports it `rearmed` and resets it to attempt 1.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra-blocked.mjs');

export default {
  id: 'infra-auto-rearm-budget-not-persisted',
  title: 'the infra retry pass re-armed a capped entry whose auto re-arm budget was already spent — '
    + 'parseInfraStore dropped autoRearms on every read, so the bound never took effect (PR #4396 review)',
  card: 'xg44s2t (PR #4396)',
  fixedBy: {
    sha: 'pr-4396-review-fix',
    where: 'lane/xg44s2t-infra-rearm',
    paths: ['scripts/conveyor/infra-blocked.mjs'],
  },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/infra-blocked.mjs');
    return existsSync(p) && /autoRearmUnderLock/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-infra-rearm-'));
    const file = join(dir, 'infra-blocked.json');
    try {
      const entry = {
        num: '4381', ref: 'lane/4381-x', sha: null, base: 'main', repo: null, cause: 'GitHub outage', body: null,
        attempt: 6, refusals: 0, autoRearms: 2,
        firstFailedAt: '2026-01-01T00:00:00.000Z', lastAttemptAt: '2026-01-01T00:00:00.000Z', nextRetryAt: '2026-01-01T00:00:00.000Z',
      };
      writeFileSync(file, JSON.stringify([entry], null, 2) + '\n');
      const r = spawnSync(process.execPath, [SCRIPT, 'retry', '--max-attempts=6'], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONVEYOR_INFRA_FILE: file },
      });
      const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
      let out = null;
      try { out = JSON.parse(lines[lines.length - 1]); } catch { /* reported below */ }
      const after = JSON.parse(readFileSync(file, 'utf8'))[0] ?? null;
      log?.(`retry exit=${r.status} out=${JSON.stringify(out)} after=${JSON.stringify(after && { attempt: after.attempt, autoRearms: after.autoRearms })}`);
      const violations = [];
      if (!out) {
        violations.push({ invariant: 'retry-pass-reports', detail: `retry printed no JSON result (exit ${r.status}): ${String(r.stderr || '').slice(0, 300)}` });
      } else {
        if ((out.rearmed || []).some((x) => String(x.num) === '4381')) {
          violations.push({ invariant: 'spent-budget-not-rearmed', detail: 'the pass re-armed #4381 although its auto re-arm budget (autoRearms=2 of 2) was already spent — the counter was dropped on read' });
        }
        if (!(out.surfaced || []).some((x) => String(x.num) === '4381')) {
          violations.push({ invariant: 'spent-budget-surfaced', detail: 'a capped entry with a spent budget must be surfaced to the operator; it was not' });
        }
      }
      if (after && after.attempt !== 6) violations.push({ invariant: 'cap-kept', detail: `entry attempt reset to ${after.attempt}; the attempt cap must stay a bound` });
      if (after && after.autoRearms !== 2) violations.push({ invariant: 'budget-persisted', detail: `autoRearms on disk is ${after.autoRearms}, expected 2 preserved across the pass` });
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
