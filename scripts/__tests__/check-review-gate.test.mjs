/**
 * @file scripts/__tests__/check-review-gate.test.mjs
 * @description #2412 Layer 5 — the pure decision behind the required-status-check backstop
 *   (`we:scripts/check-review-gate.mjs`, wired into CI by `.github/workflows/review-gate.yml`): does this PR's
 *   label set carry a review hold? The exported pure `reviewGateVerdict` is unit-tested here, plus the `--pr`
 *   manual mode against a fake `gh` (the bound CI mode is covered by check-review-gate-marker.test.mjs).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reviewGateVerdict } from '../check-review-gate.mjs';
import { REVIEW_LABELS, REVIEW_HOLD_LABELS } from '../lib/review-escalation.mjs';

describe('reviewGateVerdict (#2412 Layer 5 — required-check backstop against a manual gh pr merge bypass)', () => {
  it('is clear when the PR carries no labels at all', () => {
    expect(reviewGateVerdict([])).toEqual({ held: false, holdLabels: [] });
    expect(reviewGateVerdict(undefined)).toEqual({ held: false, holdLabels: [] });
  });

  it('is clear for an unrelated label set (e.g. ready-to-merge with no hold)', () => {
    expect(reviewGateVerdict(['ready-to-merge']).held).toBe(false);
  });

  it.each(REVIEW_HOLD_LABELS)('is held when the PR carries the hold label %s', (label) => {
    const verdict = reviewGateVerdict([label]);
    expect(verdict.held).toBe(true);
    expect(verdict.holdLabels).toEqual([label]);
  });

  it('is clear for review:accepted — an accept CLEARS a hold, it is not one itself', () => {
    expect(reviewGateVerdict([REVIEW_LABELS.accepted]).held).toBe(false);
  });

  it('is clear for redteam:accepted — an orthogonal sign-off, not a hold', () => {
    expect(reviewGateVerdict([REVIEW_LABELS.redteamAccepted]).held).toBe(false);
  });

  it('accepts the GitHub API label shape ({name}), not just bare strings', () => {
    const verdict = reviewGateVerdict([{ name: REVIEW_LABELS.human, color: 'ededed' }]);
    expect(verdict.held).toBe(true);
    expect(verdict.holdLabels).toEqual([REVIEW_LABELS.human]);
  });

  it('names every hold label present, not just the first', () => {
    // Not a realistic PR state (the labels are mutually exclusive in practice), but the reader must not stop
    // at the first match — a caller reporting "why" should see the whole set.
    const verdict = reviewGateVerdict([REVIEW_LABELS.human, REVIEW_LABELS.pending]);
    expect(verdict.held).toBe(true);
    expect(verdict.holdLabels.sort()).toEqual([REVIEW_LABELS.human, REVIEW_LABELS.pending].sort());
  });

  it('ignores an unlabeled/malformed entry rather than throwing', () => {
    expect(() => reviewGateVerdict([null, {}, 42, REVIEW_LABELS.human])).not.toThrow();
    expect(reviewGateVerdict([null, {}, 42, REVIEW_LABELS.human]).held).toBe(true);
  });
});

// The `--pr` manual mode loads proc-read lazily. Hermetic: a fake `gh` first on PATH answers `pr view`, and the
// throttle's lock root and HOME point into the same temp dir, so no real gh and no shared state are touched.
describe('check-review-gate --pr manual mode (lazy proc-read import)', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-review-gate.mjs');
  function runManual(labelsJson) {
    const dir = mkdtempSync(join(tmpdir(), 'check-review-gate-pr-'));
    try {
      writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"\n'
        + 'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\\n\' "$FAKE_GH_LABELS"; fi\nexit 0\n');
      chmodSync(join(dir, 'gh'), 0o755);
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir,
        WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'locks'), FAKE_GH_LOG: join(dir, 'gh.log'), FAKE_GH_LABELS: labelsJson };
      for (const key of ['WE_GH_READ_MEMO_DIR', 'WE_GH_THROTTLE_PERSONAL_ROUTE', 'WE_GH_THROTTLE_GH_BIN', 'LANE_POOL_ROOT']) delete env[key];
      const child = spawnSync(process.execPath, [script, '--pr=1', '--repo=o/n'], { env, encoding: 'utf8', timeout: 30_000 });
      expect(child.error).toBeUndefined();
      return { child, calls: readFileSync(join(dir, 'gh.log'), 'utf8') };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('exits 1 (held) when the fetched labels carry a hold', () => {
    const { child, calls } = runManual('{"labels":[{"name":"review:human"}]}');
    expect(calls).toContain('pr view 1 --repo o/n --json labels');
    expect(child.status, child.stderr).toBe(1);
    expect(child.stderr).toContain('held');
  });

  it('exits 0 (clear) when the fetched labels carry no hold', () => {
    const { child, calls } = runManual('{"labels":[]}');
    expect(calls).toContain('pr view 1 --repo o/n --json labels');
    expect(child.status, child.stderr).toBe(0);
  });

  it('exits 3 (fail closed, never clear) when gh output is empty, malformed or has no labels array', () => {
    for (const output of ['', 'not json', '{}', '{"labels":null}']) {
      const { child } = runManual(output);
      expect(child.status, `${JSON.stringify(output)}: ${child.stderr}`).toBe(3);
      expect(child.stderr).toContain('could not read labels for PR 1');
    }
  });
});
