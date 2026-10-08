/**
 * @file permission-change.test.mjs - the permission-change hold (operator decision 2026-10-08). Replays the real
 *   diffs of PR #4318 (workflow token widened to contents: write) and PR #4359 (extra Codex writable root) and
 *   proves each now scores humanRequired and cannot merge on a bare accept. RED on the old code, where #4318's
 *   diff scored only the agent-clearable blast-radius.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionChangeKind } from '../permission-change.mjs';
import { scoreEscalation, decideReviewGate, REVIEW_LABELS } from '../review-escalation.mjs';
import { deriveReviewDisposition } from '../review-core.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');
const diff4318 = readFileSync(join(FIX, 'pr4318-workflow-permissions.diff'), 'utf8');
const diff4359 = readFileSync(join(FIX, 'pr4359-sandbox-writable-roots.diff'), 'utf8');
const WF = '.github/workflows/apply-review-request.yml';
const WRAPPER = 'scripts/operations/deliver-item-wrapper.mjs';

describe('replay of PR #4318 (workflow permissions widened)', () => {
  const s = scoreEscalation({ changedFiles: [WF], diffLines: 30, diffHunks: diff4318 });
  it('is humanRequired with a permission-change reason', () => {
    expect(s.humanRequired).toBe(true);
    expect(s.signals.permissionChange).toEqual([WF]);
    expect(s.reasons.join('\n')).toMatch(/^permission-change \(.github\/workflows\/apply-review-request.yml: workflow-permissions\)/m);
    expect(s.careLevel).toBe('high');
  });
  it('the reason derives a human-cleared disposition (no auto-land)', () => {
    expect(deriveReviewDisposition({ reasons: s.reasons })).toEqual({ mode: 'converge', autoLand: false });
  });
  it('an automatic accept without a head-bound human clearance re-parks review:human', () => {
    const base = { escalate: true, humanRequired: true, labels: [REVIEW_LABELS.accepted], acceptedSha: 'abcdef1234', headSha: 'abcdef1234', permissionChange: true };
    const parked = decideReviewGate(base);
    expect(parked.action).toBe('park');
    expect(parked.applyLabel).toBe(REVIEW_LABELS.human);
    expect(decideReviewGate({ ...base, operatorClearance: { actor: 'op' } }).action).toBe('park');
    expect(decideReviewGate({ ...base, humanClearedSha: 'deadbeef00' }).action).toBe('park');
    expect(decideReviewGate({ ...base, humanClearedSha: 'abcdef1234' }).action).toBe('merge');
  });
  it('a PR with no permission change is unaffected by the new gate input', () => {
    const base = { escalate: true, humanRequired: false, labels: [REVIEW_LABELS.accepted], acceptedSha: 'abcdef1234', headSha: 'abcdef1234' };
    expect(decideReviewGate(base).action).toBe('merge');
  });
});

describe('replay of PR #4359 (Codex writable roots widened)', () => {
  it('is humanRequired', () => {
    const s = scoreEscalation({ changedFiles: [WRAPPER], diffLines: 10, diffHunks: diff4359 });
    expect(s.humanRequired).toBe(true);
    expect(s.signals.permissionChange).toEqual([WRAPPER]);
  });
});

describe('permissionChangeKind', () => {
  const hunk = (body) => `diff --git a/${WF} b/${WF}\n--- a/${WF}\n+++ b/${WF}\n@@ -1,3 +1,3 @@\n${body}\n`;
  it.each([
    ['-  contents: read\n+  contents: write'],
    ['+permissions:\n+  contents: read'],
    ['-permissions: read-all\n+permissions: write-all'],
    ['+      id-token: write'],
  ])('workflow permission edit %j holds', (b) => expect(permissionChangeKind(WF, hunk(b))).toBe('workflow-permissions'));

  it('workflow edits that leave permissions alone, and comment-only edits, do not hold', () => {
    expect(permissionChangeKind(WF, hunk('+      - run: npm test'))).toBeNull();
    expect(permissionChangeKind(WF, hunk('+  # contents: write is mentioned in a comment'))).toBeNull();
    expect(permissionChangeKind(WF, hunk('+  issues:\n+    types: [opened]'))).toBeNull();
  });
  it('a workflow with unreadable hunks fails closed', () => {
    expect(permissionChangeKind(WF, null)).toBe('workflow-permissions');
  });
  it('branch-protection-adjacent config holds on any touch', () => {
    for (const f of ['.github/CODEOWNERS', '.github/rulesets/main.json', 'scripts/lib/required-status-checks.mjs', 'scripts/lib/we-only-checks.json']) {
      expect(permissionChangeKind(f, '')).toBe('branch-protection-config');
    }
  });
  it('sandbox grants: code lines hold, comments and tests do not', () => {
    const h = (l) => `diff --git a/x b/x\n@@ -1 +1 @@\n${l}\n`;
    expect(permissionChangeKind('scripts/lib/isolation-provider.mjs', h('+  writableRoots: [a, b],'))).toBe('sandbox-widening');
    expect(permissionChangeKind('scripts/lib/isolation-provider.mjs', h('+ * writableRoots explained'))).toBeNull();
    expect(permissionChangeKind('scripts/lib/__tests__/isolation-provider.test.mjs', h('+  writableRoots: [a]'))).toBeNull();
    expect(permissionChangeKind('docs/x.md', h('+writableRoots'))).toBeNull();
  });
  it('an ordinary file is untouched', () => {
    expect(permissionChangeKind('src/index.ts', '')).toBeNull();
  });
});
