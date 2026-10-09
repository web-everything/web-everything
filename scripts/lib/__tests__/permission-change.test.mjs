/**
 * @file permission-change.test.mjs - the permission-change hold (operator decision 2026-10-08). Replays the real
 *   diffs of PR #4318 (workflow token widened to contents: write) and PR #4359 (extra Codex writable root) and
 *   proves each now scores humanRequired and cannot merge on a bare accept. RED on the old code, where #4318's
 *   diff scored only the agent-clearable blast-radius.
 *
 *   @repo-scanning-test scope=full - one case walks `scripts/` to pin SANDBOX_BEARING_FILES (registered in repo-scan-tests.mjs).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionChangeKind, SANDBOX_BEARING_FILES, SANDBOX_NULL_HUNKS_FREE, SANDBOX_TOKEN_RE } from '../permission-change.mjs';
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
    expect(permissionChangeKind(CODE, two('   writableRoots: [\n     a,', '+    const b = 1;'))).toBeNull();
    // a bare list entry with no owner in ITS hunk fails closed in a sandbox-bearing file (it is not adopted, it is unreadable)
    expect(permissionChangeKind(CODE, two('   writableRoots: [\n     a,', '+    b,'))).toBe('sandbox-widening');
    // while each hunk on its own still holds
    expect(permissionChangeKind(CODE, two('-x', '   writableRoots: [\n+    b,'))).toBe('sandbox-widening');
  });

  it('list edits that are not under a sandbox key do not hold', () => {
    expect(permissionChangeKind(CODE, h('   names: [\n     a,\n+    b,\n   ],'))).toBeNull();
    expect(permissionChangeKind(CODE, h('   writableRoots: [a],\n+  names: [\n+    b,\n+  ],'))).toBeNull();
    expect(permissionChangeKind(CODE, h('   writableRoots: [\n     a,\n   ],\n+  names: [\n+    b,\n+  ],'))).toBeNull();
    // a commented-out owner names nothing: a plain script reads as free, a sandbox-bearing one fails closed (no owner in reach)
    expect(permissionChangeKind('scripts/lib/ordinary.mjs', h('   // writableRoots: [\n+    b,'))).toBeNull();
    expect(permissionChangeKind(CODE, h('   // writableRoots: [\n+    b,'))).toBe('sandbox-widening');
  });
  it('tests and docs are still exempt', () => {
    expect(permissionChangeKind('scripts/lib/__tests__/x.test.mjs', h('   writableRoots: [\n+    b,'))).toBeNull();
    expect(permissionChangeKind('docs/x.md', h('   writableRoots: [\n+    b,'))).toBeNull();
  });
});

describe('permissionChangeKind - workflow grants in spellings the first matcher did not know (PR #4446 advisory)', () => {
  const hunk = (body) => `diff --git a/${WF} b/${WF}\n--- a/${WF}\n+++ b/${WF}\n@@ -1,3 +1,4 @@\n${body}\n`;
  it.each([
    ['scope outside the known list', '+  copilot-requests: write'],
    ['another unlisted scope', '+  artifact-metadata: write'],
    ['unlisted scope read', '+  some-new-scope: read'],
    ['value on the next line, both lines added', '+  contents:\n+    write'],
    ['value on the next line, key is context', '   contents:\n+    write'],
    ['value on the next line, key under an unchanged permissions block', ' permissions:\n+  contents:\n+    write'],
    ['key changed, value is unchanged context on the next line', '+  contents:\n     write'],
    ['anchored value', '+  contents: &w write'],
    ['tagged value', '+  contents: !!str write'],
    ['tagged and quoted value', '+  contents: !!str "write"'],
    ['alias value on a known scope', '+  contents: *w'],
    ['unlisted key with a non-grant value under an unchanged permissions block', ' permissions:\n+  some-new-scope: ${{ inputs.level }}'],
    ['any added line under an unchanged permissions block', ' permissions:\n+  anything-at-all: true'],
    ['job-level permissions block, nested deeper', '   build:\n     permissions:\n+      new-scope: write'],
    ['flow mapping with an unlisted scope', '+  { copilot-requests: write }'],
  ])('%s holds', (_n, b) => expect(permissionChangeKind(WF, hunk(b))).toBe('workflow-permissions'));

  it('lines that only look like a grant do not hold', () => {
    expect(permissionChangeKind(WF, hunk('+  TOKEN: ${{ secrets.X }}'))).toBeNull();
    expect(permissionChangeKind(WF, hunk(' env:\n+  FOO: bar'))).toBeNull();
    expect(permissionChangeKind(WF, hunk('+  timeout-minutes: 5'))).toBeNull();
    expect(permissionChangeKind(WF, hunk(' permissions:\n   contents: read\n+on:\n+  push:'))).toBeNull();
    expect(permissionChangeKind(WF, hunk('   name:\n+    write'))).toBeNull();
  });

  it.each([
    ['a 100% rename into the workflows dir', `diff --git a/x.yml b/${WF}\nsimilarity index 100%\nrename from x.yml\nrename to ${WF}\n`],
    ['an empty new file', `diff --git a/${WF} b/${WF}\nnew file mode 100644\nindex 0000000..e69de29\n`],
    ['an empty section', ''],
  ])('a workflow section with no hunk (%s) fails closed', (_n, section) => {
    expect(permissionChangeKind(WF, section)).toBe('workflow-permissions');
  });
  it('a rename into the workflows dir scores humanRequired end to end', () => {
    const diff = `diff --git a/x.yml b/${WF}\nsimilarity index 100%\nrename from x.yml\nrename to ${WF}\n`;
    const s = scoreEscalation({ changedFiles: [WF], diffLines: 0, diffHunks: diff });
    expect(s.humanRequired).toBe(true);
    expect(s.signals.permissionChange).toEqual([WF]);
  });
});

describe('permissionChangeKind - sandbox grants the first matcher skipped (PR #4446 advisory)', () => {
  const h = (l) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${l}\n`;
  const CODE = 'scripts/lib/isolation-provider.mjs';

  it.each([
    ['a leading block comment before a grant', CODE, '+/* note */ writableRoots: [a, "/"],'],
    ['two leading block comments', CODE, '+/* a */ /* b */ writableRoots: [a],'],
    ['a grant in a .ts file', 'scripts/lib/provider.ts', '+  writableRoots: [a],'],
    ['a grant in a .js file', 'scripts/lib/provider.js', '+  sandbox_mode: "danger-full-access",'],
    ['a grant in a .cjs file', 'scripts/lib/provider.cjs', '+  approval_policy: "never",'],
    ['a grant in a .mts file', 'scripts/lib/provider.mts', '+  network_access: true,'],
    ['an --add-dir flag in a shell script', 'scripts/run-agent.sh', '+codex exec --add-dir "$HOME" "$@"'],
    ['a grant in .claude/settings.json', '.claude/settings.json', '+  "sandbox_mode": "danger-full-access",'],
  ])('%s holds', (_n, file, body) => expect(permissionChangeKind(file, h(body))).toBe('sandbox-widening'));

  it('comment-only lines, tests and specs of the widened file types do not hold', () => {
    expect(permissionChangeKind(CODE, h('+/* writableRoots is documented here */'))).toBeNull();
    expect(permissionChangeKind(CODE, h('+/* a */ // writableRoots'))).toBeNull();
    expect(permissionChangeKind(CODE, h('+ * writableRoots'))).toBeNull();
    expect(permissionChangeKind('scripts/lib/provider.test.ts', h('+  writableRoots: [a],'))).toBeNull();
    expect(permissionChangeKind('scripts/lib/provider.spec.js', h('+  writableRoots: [a],'))).toBeNull();
    expect(permissionChangeKind('scripts/lib/__tests__/provider.ts', h('+  writableRoots: [a],'))).toBeNull();
  });

  it('a block comment between an opener and a changed entry does not hide the owner', () => {
    expect(permissionChangeKind(CODE, h('   /* roots */ writableRoots: [\n+    b,\n   ],'))).toBe('sandbox-widening');
  });

  describe('unreadable hunks (the net diff was not scored, or the repo had no clone)', () => {
    const unreadable = [null, undefined, '', 'diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n'];
    const failClosed = SANDBOX_BEARING_FILES.filter((f) => !SANDBOX_NULL_HUNKS_FREE.includes(f));
    it.each(failClosed.flatMap((f) => unreadable.map((u) => [f, u])))('%s fails closed (%j)', (f, u) => {
      expect(permissionChangeKind(f, u)).toBe('sandbox-widening');
    });
    it('an engine-tier file stays agent-reviewable on unreadable hunks, but a token on a readable line holds', () => {
      for (const f of SANDBOX_NULL_HUNKS_FREE) {
        expect(SANDBOX_BEARING_FILES).toContain(f);
        expect(permissionChangeKind(f, null)).toBeNull();
        expect(permissionChangeKind(f, h('+  argv.push("--dangerously-skip-permissions");'))).toBe('sandbox-widening');
      }
    });
    it('.codex config and .claude settings fail closed', () => {
      for (const f of ['.codex/config.toml', '.codex/sandbox.yaml', '.claude/settings.json', '.claude/settings.local.json']) {
        expect(permissionChangeKind(f, null)).toBe('sandbox-widening');
      }
    });
    it('an unrelated script or a test with unreadable hunks stays free', () => {
      expect(permissionChangeKind('scripts/lib/ordinary.mjs', null)).toBeNull();
      expect(permissionChangeKind('scripts/lib/__tests__/isolation-provider.test.mjs', null)).toBeNull();
      expect(permissionChangeKind('docs/isolation-provider.md', null)).toBeNull();
    });
    it('a sandbox-bearing file whose hunks ARE readable is judged by its lines, not its path', () => {
      expect(permissionChangeKind('scripts/lib/isolation-provider.mjs', h('+  const x = 1;'))).toBeNull();
    });
  });

  it('SANDBOX_BEARING_FILES names every non-test script that spells a sandbox token (a new one forces a list update)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const SKIP_DIR = new Set(['node_modules', '__tests__', '__fixtures__', 'fixtures', '.git']);
    const SCRIPT_EXT = /\.(mjs|cjs|js|mts|ts|sh|bash|py)$/;
    const found = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(rel); continue; }
        if (!SCRIPT_EXT.test(e.name) || /\.(test|spec)\.[a-z]+$/.test(e.name)) continue;
        if (SANDBOX_TOKEN_RE.test(readFileSync(join(root, rel), 'utf8'))) found.push(rel);
      }
    };
    walk('scripts');
    expect(found.sort()).toEqual([...SANDBOX_BEARING_FILES].sort());
    for (const f of SANDBOX_BEARING_FILES) expect(existsSync(join(root, f))).toBe(true);
  });
});

describe('permissionChangeKind - second advisory round: spellings, case and resource bounds (PR #4446)', () => {
  const wfHunk = (body) => `diff --git a/${WF} b/${WF}\n--- a/${WF}\n+++ b/${WF}\n@@ -1,3 +1,4 @@\n${body}\n`;
  const sbHunk = (l) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${l}\n`;

  it.each([
    ['alias on an unlisted scope', '+  copilot-requests: *w'],
    ['grant word, upper case', '+  contents: WRITE'],
    ['grant word, capitalised', '+  contents: Write'],
    ['agent action sandbox input', '+        sandbox: danger-full-access'],
    ['agent action permission-skip flag', '+          claude_args: --dangerously-skip-permissions'],
    ['agent action codex sandbox', '+        codex_args: --sandbox workspace-write'],
  ])('workflow: %s holds', (_n, b) => expect(permissionChangeKind(WF, wfHunk(b))).toBe('workflow-permissions'));

  it('workflow: an env value from an expression is still free', () => {
    expect(permissionChangeKind(WF, wfHunk('+  TOKEN: ${{ secrets.X }}'))).toBeNull();
    expect(permissionChangeKind(WF, wfHunk(' env:\n+  OTHER: ${{ inputs.level }}'))).toBeNull();
  });

  it.each([
    ['-s workspace-write argv pair', 'scripts/codex-direct-task.mjs', '-  "-s", "read-only",\n+  "-s", "workspace-write",'],
    ['--sandbox flag', 'scripts/lib/provider.mjs', '+  args.push("--sandbox", mode);'],
    ['--full-auto', 'scripts/lib/provider.mjs', '+  args.push("--full-auto");'],
    ['--yolo', 'scripts/lib/provider.mjs', '+  args.push("--yolo");'],
    ['bypass flag', 'scripts/lib/provider.mjs', '+  args.push("--dangerously-bypass-approvals-and-sandbox");'],
    ['skip-permissions flag', 'scripts/gemini-direct-task.mjs', '+  argv.push("--dangerously-skip-permissions");'],
    ['ask-for-approval', 'scripts/lib/provider.mjs', '+  args.push("--ask-for-approval", "never");'],
    ['camelCase sandboxMode', 'scripts/lib/provider.mjs', '+  sandboxMode: "workspace-write",'],
    ['camelCase approvalPolicy', 'scripts/lib/provider.mjs', '+  approvalPolicy: "never",'],
    ['networkAccessEnabled', 'scripts/lib/provider.mjs', '+  networkAccessEnabled: true,'],
    ['kebab writable-roots', 'scripts/lib/provider.mjs', '+  "writable-roots": ["/"],'],
    ['PascalCase WritableRoots', 'scripts/lib/provider.mjs', '+  WritableRoots: ["/"],'],
    ['toml sandbox_workspace_write table', '.codex/config.toml', '+[sandbox_workspace_write]'],
    ['bypassPermissions in claude settings', '.claude/settings.json', '+  "defaultMode": "bypassPermissions",'],
    ['additionalDirectories in claude settings', '.claude/settings.json', '+  "additionalDirectories": ["/"],'],
    ['a python script', 'scripts/operator/run.py', '+    args += ["--add-dir", d]'],
    ['a bash script', 'scripts/run.bash', '+codex exec --add-dir "$HOME"'],
  ])('sandbox: %s holds', (_n, file, body) => expect(permissionChangeKind(file, sbHunk(body))).toBe('sandbox-widening'));

  describe('resource bounds', () => {
    const timed = (fn) => { const t = Date.now(); const r = fn(); return [r, Date.now() - t]; };
    it('a run of YAML decorations on an empty key does not backtrack exponentially', () => {
      for (const deco of ['&a', '!', '&', '!!str']) {
        const [, ms] = timed(() => permissionChangeKind(WF, wfHunk(`+k: ${deco.repeat(60)} z`)));
        expect(ms).toBeLessThan(500);
      }
    });
    it('a huge workflow hunk is bounded: it holds instead of scanning quadratically', () => {
      const body = Array.from({ length: 30000 }, () => '+    foo: bar').join('\n');
      const [r, ms] = timed(() => permissionChangeKind(WF, wfHunk(body)));
      expect(r).toBe('workflow-permissions');
      expect(ms).toBeLessThan(3000);
    });
    it('a long workflow line holds without a regex scan', () => {
      const [r, ms] = timed(() => permissionChangeKind(WF, wfHunk(`+  note: ${'x'.repeat(100000)}`)));
      expect(r).toBe('workflow-permissions');
      expect(ms).toBeLessThan(500);
    });
    it('a huge script hunk is read in bounded time and still catches a grant', () => {
      const filler = Array.from({ length: 25000 }, () => '+const a = 1;').join('\n');
      const [r, ms] = timed(() => permissionChangeKind('scripts/lib/big.mjs', sbHunk(`${filler}\n+  writableRoots: ["/"],`)));
      expect(r).toBe('sandbox-widening');
      expect(ms).toBeLessThan(3000);
      const [free, ms2] = timed(() => permissionChangeKind('scripts/lib/big.mjs', sbHunk(filler)));
      expect(free).toBeNull();
      expect(ms2).toBeLessThan(3000);
    });
    it('a mid-size script hunk (5k lines) stays fast', () => {
      const filler = Array.from({ length: 5000 }, () => '+const a = 1;').join('\n');
      const [r, ms] = timed(() => permissionChangeKind('scripts/lib/big.mjs', sbHunk(filler)));
      expect(r).toBeNull();
      expect(ms).toBeLessThan(2000);
    });
  });
});

describe('permissionChangeKind - grants whose owner or value sits outside the diff context (PR #4446 block-ruled referrals)', () => {
  const wfHunk = (body, heading = '') => `diff --git a/${WF} b/${WF}\n--- a/${WF}\n+++ b/${WF}\n@@ -20,4 +20,5 @@${heading}\n${body}\n`;
  const sbHunk = (body) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -40,3 +40,4 @@\n${body}\n`;
  const BEARING = 'scripts/lib/isolation-provider.mjs';
  const CODEX = '.codex/config.toml';
  const CLAUDE = '.claude/settings.json';

  describe('sandbox list entry added where the owning key is beyond the three context lines', () => {
    it.each([
      ['quoted js entry, bearing script', BEARING, '     "/a",\n+    "/b",\n     "/c",'],
      ['single-quoted js entry', BEARING, "     '/a',\n+    '/b',\n     '/c',"],
      ['template-string entry', BEARING, '     `${a}/x`,\n+    `${b}/y`,\n     `${c}/z`,'],
      ['bare identifier entry', BEARING, '     rootA,\n+    rootB,\n     rootC,'],
      ['bare path entry', BEARING, '     /a,\n+    /b,\n     /c,'],
      ['yaml dash entry', BEARING, '   - /a\n+  - /b\n   - /c'],
      ['json entry in claude settings', CLAUDE, '     "/a",\n+    "/b",\n     "/c"'],
      ['removed entry in claude settings', CLAUDE, '     "/a",\n-    "/b",\n     "/c"'],
      ['codex yaml entry', '.codex/sandbox.yaml', '   - /a\n+  - /b\n   - /c'],
    ])('%s holds', (_n, file, body) => expect(permissionChangeKind(file, sbHunk(body))).toBe('sandbox-widening'));

    it('an entry under a visible, unrelated owner stays free', () => {
      expect(permissionChangeKind(BEARING, sbHunk('   names: [\n     "/a",\n+    "/b",\n   ],'))).toBeNull();
    });
    it('a non-list line in a bearing file stays free', () => {
      expect(permissionChangeKind(BEARING, sbHunk('     const a = 1;\n+    const b = 2;\n     return a + b;'))).toBeNull();
    });
    it('a script that is not sandbox-bearing keeps reading only its own lines', () => {
      expect(permissionChangeKind('scripts/lib/ordinary.mjs', sbHunk('     "/a",\n+    "/b",\n     "/c",'))).toBeNull();
    });
  });

  describe('multi-line grant: the key or flag is on a different line than the changed value', () => {
    it.each([
      ['argv pair, flag on the previous line, in an array', BEARING, "const args = [\n  '--ask-for-approval',\n+  'never',\n];"],
      ['argv pair, flag two lines up', BEARING, "  '--ask-for-approval',\n  // why\n+  'never',"],
      ['key then value on the next line (yaml)', '.codex/sandbox.yaml', '   approval_policy:\n-    on-request\n+    never'],
      ['key then value on the next line (js)', BEARING, '   approvalPolicy:\n+    "never",'],
      ['toml key then value on the next line', CODEX, '   network_access =\n+    true'],
      ['shell continuation, flag then value', 'scripts/run-agent.sh', '   codex exec --ask-for-approval \\\n+    never'],
      ['string concatenation', BEARING, "   const flag = '--ask-for-approval=' +\n+    'never';"],
      ['json key then value on the next line', CLAUDE, '   "network_access":\n+    true'],
      ['removed value under a kept key', CLAUDE, '   "approval_policy":\n-    "untrusted"'],
    ])('%s holds', (_n, file, body) => expect(permissionChangeKind(file, sbHunk(body))).toBe('sandbox-widening'));

    it('a line after a finished statement is not adopted by an earlier token', () => {
      expect(permissionChangeKind(BEARING, sbHunk("   args.push('--sandbox', mode);\n+  doOtherThing();"))).toBeNull();
      expect(permissionChangeKind(BEARING, sbHunk("   args.push('--sandbox', mode);\n\n+  const x = 1;"))).toBeNull();
    });
  });

  describe('workflow: grant added under a permissions block whose key is outside the context', () => {
    it.each([
      ['unlisted scope from an expression', '     issues: read\n+    new-scope: ${{ inputs.level }}\n     statuses: read', ' permissions:'],
      ['merge key aliasing a grant map', '     issues: read\n+    <<: *wide\n     statuses: read', ' permissions:'],
      ['merge key, chain unknown (heading is jobs)', '     issues: read\n+    <<: *wide\n     statuses: read', ' jobs:'],
      ['merge key, no heading at all', '     issues: read\n+    <<: *wide\n     statuses: read', ''],
      ['expression on a lowercase key, chain unknown', '     issues: read\n+    copilot-requests: ${{ inputs.level }}\n     statuses: read', ' jobs:'],
      ['block scalar value on the next line, chain unknown', '     issues: read\n+    contents: >-\n+      write\n     statuses: read', ' jobs:'],
      ['tag only, value on the next line, chain unknown', '     issues: read\n+    contents: !!str\n+      write\n     statuses: read', ' jobs:'],
      ['heading is the permissions key itself', '     issues: read\n+    anything: true\n     statuses: read', ' permissions:'],
    ])('%s holds', (_n, body, heading) => expect(permissionChangeKind(WF, wfHunk(body, heading))).toBe('workflow-permissions'));

    it('an edit whose full ancestor chain is visible and is not permissions stays free', () => {
      expect(permissionChangeKind(WF, wfHunk('   env:\n     A: 1\n+    B: ${{ inputs.level }}'))).toBeNull();
      expect(permissionChangeKind(WF, wfHunk('   build:\n     steps:\n+      - uses: actions/checkout@v4'))).toBeNull();
      expect(permissionChangeKind(WF, wfHunk('   with:\n+    node-version: 20', ' jobs:'))).toBeNull();
    });
    it('uppercase env expressions stay free even when the chain is unknown', () => {
      expect(permissionChangeKind(WF, wfHunk('     A: 1\n+    TOKEN: ${{ secrets.X }}\n     B: 2', ' jobs:'))).toBeNull();
      expect(permissionChangeKind(WF, wfHunk('+    FOO: bar', ' jobs:'))).toBeNull();
    });
  });
});

describe('permissionChangeKind - adversarial round on the block-ruled repair (PR #4446)', () => {
  const wf = (body, heading = '') => `diff --git a/${WF} b/${WF}\n--- a/${WF}\n+++ b/${WF}\n@@ -20,4 +20,5 @@${heading}\n${body}\n`;
  const sb = (body) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -50,3 +50,4 @@\n${body}\n`;
  const BEARING = 'scripts/operations/run.mjs';
  const CODEX = '.codex/config.toml';

  it.each([
    ['trailing # comment (toml)', CODEX, ' "/a",\n "/b",\n+"/c", # tmp'],
    ['trailing // comment (js)', BEARING, " '/a',\n '/b',\n+'/c', // tmp"],
    ['inline table entry (toml)', CODEX, ' { path = "/a" },\n+{ path = "/etc" },'],
    ['object entry (json)', '.claude/settings.json', ' {"path": "/a"},\n+{"path": "/etc"},'],
    ['call entry', BEARING, " path.join(a, 'x'),\n+path.join(home, '.ssh'),"],
    ['concatenation entry', BEARING, " a + '/x',\n+home + '/.ssh',"],
    ['final unquoted element, no comma', BEARING, '   ONE,\n+  ETC'],
  ])('unowned list element: %s holds', (_n, file, body) => expect(permissionChangeKind(file, sb(body))).toBe('sandbox-widening'));

  it('statements, block edges and key/value pairs in a bearing file stay free', () => {
    for (const body of ['+  const x = 1;', '+  }', '+  if (a) {', '+  return a + b;', '+  name: value', '+  ]);']) {
      expect(permissionChangeKind(BEARING, sb(body))).toBeNull();
    }
  });

  describe('bounds: what cannot be read within them cannot be cleared', () => {
    const timed = (fn) => { const t = Date.now(); const r = fn(); return [r, Date.now() - t]; };
    it('a hunk over the owner-read line cap holds in a grant-bearing file and stays free elsewhere', () => {
      const body = Array.from({ length: 20001 }, (_, i) => `+  "/p${i}",`).join('\n');
      expect(permissionChangeKind(CODEX, sb(body))).toBe('sandbox-widening');
      const filler = Array.from({ length: 20001 }, () => '+const a = 1;').join('\n');
      expect(permissionChangeKind(BEARING, sb(filler))).toBe('sandbox-widening');
      expect(permissionChangeKind('scripts/lib/ordinary.mjs', sb(filler))).toBeNull();
    });
    it('very long lines hold in a grant-bearing file in bounded time', () => {
      const body = Array.from({ length: 800 }, (_, i) => `+  ${'x'.repeat(8000)}${i}`).join('\n');
      const [r, ms] = timed(() => permissionChangeKind(BEARING, sb(body)));
      expect(r).toBe('sandbox-widening');
      expect(ms).toBeLessThan(2000);
      const [free, ms2] = timed(() => permissionChangeKind('scripts/lib/ordinary.mjs', sb(body)));
      expect(free).toBeNull();
      expect(ms2).toBeLessThan(2000);
    });
    it('a workflow with a long CONTEXT line holds', () => {
      expect(permissionChangeKind(WF, wf(` note: ${'x'.repeat(5000)}\n+  FOO: bar`))).toBe('workflow-permissions');
    });
  });

  describe('line endings and separators inside the diff text', () => {
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    it('a CRLF diff reads like the LF one, trailing comments included', () => {
      const body = '      contents:\n-        read # was\n+        write # now';
      expect(permissionChangeKind(WF, wf(body))).toBe('workflow-permissions');
      expect(permissionChangeKind(WF, crlf(wf(body)))).toBe('workflow-permissions');
      expect(permissionChangeKind(WF, crlf(wf('     issues: read\n+    contents: # need\n+      write\n     statuses: read', ' jobs:')))).toBe('workflow-permissions');
      expect(permissionChangeKind(CODEX, crlf(sb(' "/a",\n "/b",\n+"/c", # tmp')))).toBe('sandbox-widening');
    });
    it('U+2028 / U+2029 / a lone CR inside a comment do not hide the value', () => {
      for (const sep of [' ', ' ', '\r', '\u0085']) {
        expect(permissionChangeKind(WF, wf(`      contents:\n+        write # x${sep}y`))).toBe('workflow-permissions');
      }
    });
    it('a separator inside a changed line does not strip its marker (the token after it is still read)', () => {
      expect(permissionChangeKind(BEARING, sb('+  x = 1;   approval_policy = "never"'))).toBe('sandbox-widening');
    });
    it('a CRLF diff with no hunk header still fails closed', () => {
      expect(permissionChangeKind(WF, 'diff --git a/x b/y\r\nsimilarity index 100%\r\n')).toBe('workflow-permissions');
    });
  });

  describe('workflow: values that are not grant words, and a heading that cannot clear a line', () => {
    it.each([
      ['expression on its own line under an empty key', '       pages: read\n+      copilot-requests:\n+        ${{ inputs.l }}'],
      ['block scalar then an expression', '       pages: read\n+      contents: >-\n+        ${{ inputs.l }}'],
      ['alias on its own line', '       pages: read\n+      contents:\n+        *wide'],
      ['lone expression under an unchanged key', '      contents:\n+        ${{ inputs.l }}'],
    ])('%s holds', (_n, body) => expect(permissionChangeKind(WF, wf(body, ' jobs:'))).toBe('workflow-permissions'));

    it('a non-permissions heading does not clear an unknown chain', () => {
      expect(permissionChangeKind(WF, wf('     scope1: read\n+    copilot-requests: ${{ inputs.l }}\n     scope2: read', ' on: push'))).toBe('workflow-permissions');
      expect(permissionChangeKind(WF, wf('     scope1: read\n+    <<: *wide', ' env:'))).toBe('workflow-permissions');
    });
    it('an expression on its own line under a free-text key stays free', () => {
      expect(permissionChangeKind(WF, wf('   run:\n+    ${{ inputs.cmd }}', ' jobs:'))).toBeNull();
    });
  });
});
