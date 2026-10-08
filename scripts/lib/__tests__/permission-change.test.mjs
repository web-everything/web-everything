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

describe('permissionChangeKind - quoted scope values and flow mappings (PR #4446 review)', () => {
  const hunk = (body) => `diff --git a/${WF} b/${WF}\n--- a/${WF}\n+++ b/${WF}\n@@ -1,3 +1,3 @@\n${body}\n`;
  it.each([
    ['double-quoted value', '+  contents: "write"'],
    ['single-quoted value', "+  contents: 'write'"],
    ['quoted key and value', '+  "contents": "write"'],
    ['quoted none', "-  contents: 'read'\n+  contents: 'none'"],
    ['one-line flow mapping', '+permissions: { contents: write }'],
    ['quoted flow mapping', '+permissions: {"contents": "write", "issues": "read"}'],
    ['flow mapping nested in a job line', '+  build: { permissions: { contents: write }, runs-on: x }'],
    ['continuation line of a multi-line flow mapping', '+  { contents: write, issues: read }'],
    ['flow entry after a comma', '+  issues: read, contents: write }'],
    ['quoted key before a flow value', '+  "permissions": {contents: read}'],
    ['quoted write-all', '+permissions: "write-all"'],
    ['quoted read-all', "+permissions: 'read-all'"],
    ['expression-valued grant', '+  contents: ${{ inputs.level }}'],  ])('%s holds', (_n, b) => expect(permissionChangeKind(WF, hunk(b))).toBe('workflow-permissions'));

  it('a quoted value that is not a grant, or a quoted comment, does not hold', () => {
    expect(permissionChangeKind(WF, hunk('+  name: "write"'))).toBeNull();
    expect(permissionChangeKind(WF, hunk('+      - run: echo "contents: write"'))).toBeNull();
    expect(permissionChangeKind(WF, hunk('+  # "contents": "write"'))).toBeNull();
  });
});

describe('permissionChangeKind - entries added inside an existing multi-line sandbox list (PR #4446 review)', () => {
  const CODE = 'scripts/lib/isolation-provider.mjs';
  const CODEX = '.codex/config.toml';
  const h = (body) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,5 +10,6 @@\n${body}\n`;
  it.each([
    ['js array, key line is unchanged context', CODE, '   writableRoots: [\n     rootA,\n+    rootB,\n   ],'],
    ['js array, snake_case key', CODE, '   writable_roots: [\n     "/a",\n+    "/b",\n   ],'],
    ['js array, key then a removed entry', CODE, '   writableRoots: [\n-    rootA,\n     rootB,\n   ],'],
    ['argv list with --add-dir as the preceding sibling', CODE, "   args: [\n     '--add-dir',\n+    dir,\n   ],"],
    ['argv list with a changed value after --add-dir', CODE, "     '--add-dir',\n+    extraDir,"],
    ['yaml list under an unchanged key', '.codex/sandbox.yaml', '   writable_roots:\n     - /a\n+    - /b'],
    ['toml array under an unchanged key', CODEX, '   writable_roots = [\n     "/a",\n+    "/b",\n   ]'],
    ['a removed bare --add-dir line is not mistaken for a "---" file header', '.codex/sandbox.yaml', '---add-dir'],
    ['key two context lines above the change', CODE, '   writableRoots: [\n     a,\n     b,\n+    c,\n   ],'],
  ])('%s holds', (_n, file, body) => expect(permissionChangeKind(file, h(body))).toBe('sandbox-widening'));

  it('a list-entry change in a codex config whose key is outside the hunk fails closed', () => {
    expect(permissionChangeKind(CODEX, h('     "/a",\n+    "/b",\n     "/c",'))).toBe('sandbox-widening');
    expect(permissionChangeKind('.codex/sandbox.yaml', h('   - /a\n+  - /b'))).toBe('sandbox-widening');
  });

  it('an owner lookup never reads across a hunk boundary', () => {
    const two = (a, b) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n${a}\n@@ -40,2 +40,3 @@\n${b}\n`;
    // hunk 1's unrelated key must not hide the out-of-reach list entry in hunk 2 (codex fails closed)
    expect(permissionChangeKind('.codex/sandbox.yaml', two('-effort: low\n+effort: high', '   - /a\n+  - /b'))).toBe('sandbox-widening');
    // a dangling opener at the end of hunk 1 must not adopt an unrelated edit in hunk 2
    expect(permissionChangeKind(CODE, two('   writableRoots: [\n     a,', '   names: [\n+    b,\n   ],'))).toBeNull();
    expect(permissionChangeKind(CODE, two('   writableRoots: [\n     a,', '+    b,'))).toBeNull();
    // while each hunk on its own still holds
    expect(permissionChangeKind(CODE, two('-x', '   writableRoots: [\n+    b,'))).toBe('sandbox-widening');
  });

  it('list edits that are not under a sandbox key do not hold', () => {
    expect(permissionChangeKind(CODE, h('   names: [\n     a,\n+    b,\n   ],'))).toBeNull();
    expect(permissionChangeKind(CODE, h('   writableRoots: [a],\n+  names: [\n+    b,\n+  ],'))).toBeNull();
    expect(permissionChangeKind(CODE, h('   writableRoots: [\n     a,\n   ],\n+  names: [\n+    b,\n+  ],'))).toBeNull();
    expect(permissionChangeKind(CODE, h('   // writableRoots: [\n+    b,'))).toBeNull();
  });
  it('tests and docs are still exempt', () => {
    expect(permissionChangeKind('scripts/lib/__tests__/x.test.mjs', h('   writableRoots: [\n+    b,'))).toBeNull();
    expect(permissionChangeKind('docs/x.md', h('   writableRoots: [\n+    b,'))).toBeNull();
  });
});
