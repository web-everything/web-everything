/**
 * @file scripts/lib/__tests__/verify-lane-gate.test.mjs
 * @description Executable proof for #3372 + #3395: `verify-lane.mjs`'s default gate must invoke the diff-driven
 *   test selection (#2681) instead of an unconditional `npm run test:unit`, AND scope its check:standards half to
 *   `--local --files=<changed>` per #1937 whenever the changed set touches neither `backlog/` nor a gate-self/
 *   policy-core path (#3395) — AND the fail-safe direction must not regress for either half. Tests the pure
 *   decision core (`resolveDefaultGate`/`canScopeCheckStandards`) directly with an injected `runGit`, mirroring
 *   `scripts/readiness/__tests__/test-selection.test.mjs`'s own convention (no real git/npm/vitest IO — fast,
 *   hermetic, and immune to whatever the *current* diff of the repo happens to be). A source-wiring guard at the
 *   bottom pins that `verify-lane.mjs` actually calls this function for its default gate, so the decision core
 *   being correct can never silently drift from what ships.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { LANE_RELEASE_LITTER_ALLOWLIST } from '../lane-litter.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyStandardsPolicy, STANDARDS_AUTO_PREFIXES, standardsRelevantPath, decideStandardsHalf, verifyPhaseAdmissionEnabled, verifyFastTargets, phaseAdmissionKind, verifyRelatedMode, buildPhaseOutcome, firstStandardsErrorId, verifyTestTimeoutFactor, scaledTimeoutFlags, buildVerifyPhases, formatVerifyPhases, explicitGateRefusal, resolveDefaultGate, canScopeCheckStandards, composeGate, describeGate, laneRelevantChangeSince, computeWorkingTreeHash, stableTreeHash, FULL_GATE, MAX_RELATED_TARGETS } from '../verify-lane-gate.mjs';

/** A synthetic git runner for the xpnhz4o working-tree changed set: `merge-base` resolves to a fixed sha;
 *  `diff --name-only <sha>` returns the (working-tree) changed files; `--diff-filter=D` the deleted ones;
 *  `ls-files --others` the untracked ones; `grep -l -F -e <needle>…` the test files naming a needle (exit 1 —
 *  a throw — when none do, exactly as real `git grep`). No real git process. */
function fakeGit(changedFiles, { deleted = [], untracked = [], grepHits = {} } = {}) {
  return (args) => {
    if (args[0] === 'merge-base') return 'deadbeef';
    if (args[0] === 'diff' && args.includes('--diff-filter=D')) return deleted.join('\n');
    if (args[0] === 'diff') {
      expect(args).toEqual(['diff', '--name-only', 'deadbeef']);
      return changedFiles.join('\n');
    }
    if (args[0] === 'ls-files') return untracked.join('\n');
    if (args[0] === 'grep') {
      const needles = args.filter((_, i) => args[i - 1] === '-e');
      const hits = Array.from(new Set(needles.flatMap((n) => grepHits[n] || [])));
      if (!hits.length) throw new Error('git grep: exit 1 (no match)');
      return hits.join('\n');
    }
    throw new Error(`unexpected git invocation in test: ${args.join(' ')}`);
  };
}

/** Factor 1 = vitest's own timeouts, i.e. the exact pre-WE_VERIFY_TEST_TIMEOUT_FACTOR command. */
const TODAY = Object.freeze({ WE_VERIFY_TEST_TIMEOUT_FACTOR: '1' });

describe('#4540 — untracked lane scratch selection', () => {
  it('filters scratch before both related targets and reference discovery, preserving standards inputs', () => {
    const grepCalls = [];
    const git = fakeGit(['scripts/example.mjs'], {
      untracked: ['.commit-msg.txt'],
      grepHits: {
        '.commit-msg.txt': ['scripts/scratch.test.mjs'],
        'example.mjs': ['scripts/example.test.mjs'],
      },
    });
    const { command, decision } = resolveDefaultGate({ fileConfig: null,
      runGit: (args) => { if (args[0] === 'grep') grepCalls.push(args); return git(args); },
      env: TODAY,
    });
    expect.soft(grepCalls.flat()).not.toContain('.commit-msg.txt');
    expect.soft(decision.relatedFiles).toEqual(['scripts/example.mjs']);
    expect.soft(decision.targets).toEqual(['scripts/example.mjs', 'scripts/example.test.mjs']);
    expect.soft(decision.referencedTests).toEqual(['scripts/example.test.mjs']);
    expect(decision.changedFiles).toEqual(['.commit-msg.txt', 'scripts/example.mjs']);
    expect(command).toBe("npx vitest related 'scripts/example.mjs' 'scripts/example.test.mjs' --run --passWithNoTests && npm run check:standards -- --local --files='.commit-msg.txt,scripts/example.mjs'");
  });
  it('scratch-only skips successfully without grep, while opt-out requires an explicit gate', () => {
    for (const optOut of [false, true]) {
      const git = fakeGit([], { untracked: ['.commit-msg.txt'] });
      const { command, decision } = resolveDefaultGate({ fileConfig: null,
        runGit: (args) => { expect(args[0]).not.toBe('grep'); return git(args); },
        env: optOut ? { ...TODAY, WE_DIFF_TEST_SELECTION: '0' } : TODAY,
      });
      expect(decision.changedFiles).toEqual(['.commit-msg.txt']);
      expect(decision).toMatchObject({ mode: optOut ? 'blocked' : 'shrink', relatedFiles: [], triggerFiles: [], deletedSourceFiles: [], targets: [], referencedTests: [] });
      if (!optOut) expect(command.split(' && ')[1]).toBe("npm run check:standards -- --local --files='.commit-msg.txt'");
      if (optOut) expect(command).toBeNull();
      else {
        expect(decision.reasons.join(' ')).toMatch(/scratch only/);
        expect(execSync(command.split(' && ')[0], { encoding: 'utf8' })).toMatch(/vitest half skipped.*scratch/);
      }
    }
  });

  it('uses shared full-path patterns without excluding nested names, unknown names or directory children', () => {
    const scratch = LANE_RELEASE_LITTER_ALLOWLIST.filter((p) => !p.endsWith('/')).map((p) => p.replaceAll('*', '4540'));
    const retained = ['scripts/.commit-msg.txt', '.unknown-scratch-4540.txt', '.conveyor/state.json'];
    const { decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit([], { untracked: [...scratch, ...retained] }), env: TODAY });
    expect(decision.targets).toEqual([...retained].sort());
    expect(decision.changedFiles).toEqual([...new Set([...scratch, ...retained])].sort());
  });

  it.each([false, true])('preserves an allowlisted name when tracked (untracked=%s)', (untracked) => {
    const file = '.pr-body.md';
    const { decision } = resolveDefaultGate({ fileConfig: null,
      runGit: fakeGit(untracked ? [] : [file], { untracked: untracked ? [file] : [] }), env: TODAY,
    });
    expect(decision.targets).toEqual(untracked ? [] : [file]);
    expect(decision.relatedFiles).toEqual(untracked ? [] : [file]);
    expect(decision.changedFiles).toEqual([file]);
  });

  it.each([
    ['package.json', [], 'blocked', true],
    ['scripts/gone.mjs', ['scripts/gone.mjs'], 'blocked', true],
    ['backlog/100-example.md', [], 'shrink', false],
    ['scripts/lib/review-escalation.mjs', [], 'shrink', false],
    ['.pr-body.md', ['.pr-body.md'], 'shrink', true],
  ])('preserves selection and standards for scratch plus %s', (file, deleted, mode, scoped) => {
    const { decision, command } = resolveDefaultGate({ fileConfig: null,
      runGit: fakeGit([file], { deleted, untracked: ['.commit-msg.txt'] }), env: TODAY,
    });
    expect(decision.mode).toBe(mode);
    expect(decision.changedFiles).toEqual(['.commit-msg.txt', file].sort());
    expect(decision.targets).not.toContain('.commit-msg.txt');
    expect(decision.targets).not.toContain(deleted[0]);
    if (mode === 'blocked') { expect(command).toBeNull(); return; }
    expect(command.includes('--local --files=')).toBe(scoped);
    if (scoped) expect(command).toContain("--files='" + ['.commit-msg.txt', file].sort().join(',') + "'");
    if (file === 'package.json') expect(decision.triggerFiles).toEqual([file]);
    if (file === 'scripts/gone.mjs') expect(decision.deletedSourceFiles).toEqual([file]);
  });

  it('applies the target limit after scratch filtering and reference expansion', () => {
    const pattern = LANE_RELEASE_LITTER_ALLOWLIST.find((p) => p.includes('*'));
    const scratch = Array.from({ length: MAX_RELATED_TARGETS }, (_, i) => pattern.replaceAll('*', String(i)));
    const files = Array.from({ length: MAX_RELATED_TARGETS - 1 }, (_, i) => 'scripts/m' + i + '.mjs');
    for (const extra of [1, 2]) {
      const refs = Array.from({ length: extra }, (_, i) => 'scripts/ref' + i + '.test.mjs');
      const { decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(files, { untracked: scratch, grepHits: { 'm0.mjs': refs } }), env: TODAY });
      expect(decision.mode).toBe(extra === 1 ? 'shrink' : 'blocked');
      expect(decision.targets).toHaveLength(MAX_RELATED_TARGETS - 1 + extra);
    }
  });

});

describe('resolveDefaultGate (xpnhz4o) — the LOCAL gate runs only the diff-selected tests', () => {
  it('a scripts/ change (the everyday PR) SELECTS: vitest related on it + the tests naming it, never `npm run test:unit`', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null,
      runGit: fakeGit(['scripts/verify-lane.mjs'], { grepHits: { 'verify-lane.mjs': ['scripts/__tests__/verify-lane.test.mjs'] } }),
      env: TODAY,
    });
    expect(decision.mode).toBe('shrink');
    expect(decision.referencedTests).toEqual(['scripts/__tests__/verify-lane.test.mjs']);
    expect(command).toBe("npx vitest related 'scripts/__tests__/verify-lane.test.mjs' 'scripts/verify-lane.mjs' --run --passWithNoTests && npm run check:standards -- --local --files='scripts/verify-lane.mjs'");
    expect(command).not.toContain('test:unit');
  });

  it('a docs-only diff selects (and passes with no tests) and scopes check:standards (#1937)', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['docs/readme.md']), env: TODAY });
    expect(decision.mode).toBe('shrink');
    expect(command).toBe("npx vitest related 'docs/readme.md' --run --passWithNoTests && npm run check:standards -- --local --files='docs/readme.md'");
  });

  it('keys on the WORKING TREE: uncommitted and untracked files are in the selection (a fixer gates before committing)', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/a.mjs'], { untracked: ['scripts/__tests__/a-new.test.mjs'] }), env: TODAY });
    expect(decision.mode).toBe('shrink');
    expect(decision.changedFiles).toEqual(['scripts/__tests__/a-new.test.mjs', 'scripts/a.mjs']);
    expect(command).toContain("'scripts/__tests__/a-new.test.mjs' 'scripts/a.mjs'");
  });

  it.each([
    ['package.json'], ['package-lock.json'], ['vitest.config.ts'], ['vitest.setup.ts'], ['vitest.shared.ts'],
    ['tsconfig.json'],
  ])('FALLBACK: %s (config / setup / dependency / shared test helper) blocks automatic full-suite escalation and says why', (file) => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/a.mjs', file]), env: TODAY });
    expect(decision.mode).toBe('blocked');
    expect(decision.triggerFiles).toEqual([file]);
    expect(decision.reasons.join(' ')).toContain(file);
    expect(command).toBeNull();
  });

  it('FALLBACK: a deleted source file requires an explicit gate (its importers are unfindable); a deleted TEST file does not', () => {
    const src = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/gone.mjs'], { deleted: ['scripts/gone.mjs'] }), env: TODAY });
    expect(src.decision.mode).toBe('blocked');
    expect(src.decision.deletedSourceFiles).toEqual(['scripts/gone.mjs']);
    const test = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/a.mjs', 'scripts/__tests__/gone.test.mjs'], { deleted: ['scripts/__tests__/gone.test.mjs'] }), env: TODAY });
    expect(test.decision.mode).toBe('shrink');
    expect(test.command.split(' && ')[0]).toBe("npx vitest related 'scripts/a.mjs' --run --passWithNoTests");
  });

  it('PR #2680 review — a diff of ONLY deleted non-source files never emits a target-less `vitest related` (a false red)', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['docs/obsolete.md'], { deleted: ['docs/obsolete.md'] }), env: TODAY });
    expect(decision.mode).toBe('shrink');
    expect(decision.targets).toEqual([]);
    expect(command).not.toMatch(/vitest related\s+--run/);
    expect(command.split(' && ')[0]).toMatch(/^echo .*vitest half skipped/);
  });

  it('PR #2680 review — reference discovery greps every vitest test suffix (jsx / cts included)', () => {
    let seen = null;
    const git = fakeGit(['scripts/tool.mjs']);
    resolveDefaultGate({ fileConfig: null, runGit: (args) => { if (args[0] === 'grep') seen = args; return git(args); }, env: TODAY });
    for (const spec of ['*.test.ts', '*.test.tsx', '*.test.jsx', '*.test.mjs', '*.test.cjs', '*.test.cts']) expect(seen).toContain(spec);
  });

  it('a backlog/ card selects for vitest but keeps check:standards UNSCOPED (the #1937/#3395 margin), and never greps ~140 fixture tests for `backlog`', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['backlog/100-example.md'], { grepHits: { backlog: ['x.test.mjs'] } }), env: TODAY });
    expect(decision.mode).toBe('shrink');
    expect(decision.referencedTests).toEqual([]);
    expect(command).toBe("npx vitest related 'backlog/100-example.md' --run --passWithNoTests && npm run check:standards");
  });

  it('a change under a glob-discovered root (demos/) adds the tests that name the root', () => {
    const { decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['demos/loan/app.ts'], { grepHits: { demos: ['scripts/__tests__/demo-registry.test.mjs'] } }), env: TODAY });
    expect(decision.referencedTests).toEqual(['scripts/__tests__/demo-registry.test.mjs']);
  });

  it('a gate-self/policy-core path keeps check:standards unscoped (the gate sees the whole-repo signal on a change to itself)', () => {
    const { command } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/lib/review-escalation.mjs']), env: TODAY });
    expect(command).toMatch(/--passWithNoTests && npm run check:standards$/);
  });

  it('an explicit opt-out (WE_DIFF_TEST_SELECTION=0) requires an explicit gate', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['docs/readme.md']), env: { ...TODAY, WE_DIFF_TEST_SELECTION: '0' } });
    expect(decision.mode).toBe('blocked');
    expect(command).toBeNull();
  });

  it('FAIL-SAFE: a git failure (no computable diff) requires an explicit affected-test gate, never shrinks or scopes', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: () => { throw new Error('no such ref'); }, env: TODAY });
    expect(decision.mode).toBe('blocked');
    expect(decision.changedFiles).toBe(null);
    expect(command).toBeNull();
  });

  it('FAIL-SAFE: an empty changed set requires an explicit affected-test gate', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit([]), env: TODAY });
    expect(decision.mode).toBe('blocked');
    expect(decision.changedFiles).toEqual([]);
    expect(command).toBeNull();
  });

  it('a diff too large to pass to `vitest related` (over MAX_RELATED_TARGETS) blocks full-suite escalation and says so', () => {
    const many = Array.from({ length: MAX_RELATED_TARGETS + 1 }, (_, i) => `scripts/m${i}.mjs`);
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(many), env: TODAY });
    expect(decision.mode).toBe('blocked');
    expect(decision.reasons.join(' ')).toMatch(/limit 300/);
    expect(command).toBeNull();
  });

  it('describeGate SAYS which it was: SELECTED with counts, or FULL SUITE (fallback) with the reason', () => {
    const sel = describeGate(resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/a.mjs']), env: TODAY }));
    expect(sel).toMatch(/^verify-lane gate: SELECTED tests only — 1 changed path/);
    expect(sel).toContain('CI still runs the full suite');
    const full = describeGate(resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['package.json']), env: TODAY }));
    expect(full).toMatch(/^verify-lane gate: BLOCKED selection/);
    expect(full).toContain('package.json');
    expect(full).toContain('No local full suite');
  });
});

// #3919 — the gate must only name npm scripts the TARGET checkout has (real package.json script-name sets).
const WE_SCRIPTS = ['test:unit', 'check:standards', 'test', 'build'];
const FRONTIERUI_SCRIPTS = ['dev', 'build', 'test', 'test:unit', 'test:e2e', 'test:coverage', 'check:standards'];
const PLATEAU_APP_SCRIPTS = ['start', 'build', 'preview', 'test', 'check:render-conformance', 'test:e2e', 'explore'];

describe('resolveDefaultGate per-repo scripts (#3919) — only run the npm scripts the checkout actually has', () => {
  const cases = [
    { name: 'shrinkable diff', files: ['docs/readme.md'] },
    { name: 'full + scoped', files: ['package.json'] },
    { name: 'full + unscoped (backlog)', files: ['backlog/100-example.md'] },
    { name: 'empty diff', files: [] },
  ];

  it.each(cases)('a WE checkout ($name) gets the byte-for-byte unchanged command vs. no scripts injected', ({ files }) => {
    const legacy = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(files), env: TODAY });
    const we = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(files), env: TODAY, scripts: WE_SCRIPTS });
    expect(we.command).toBe(legacy.command);
    expect(we.gateReasons).toEqual([]);
  });

  it('a WE checkout with an empty diff requires an explicit gate', () => {
    expect(resolveDefaultGate({ fileConfig: null, runGit: fakeGit([]), env: TODAY, scripts: WE_SCRIPTS }).command).toBeNull();
  });

  it.each(cases)('a frontierui checkout ($name) has test:unit + check:standards, so its gate is unchanged too', ({ files }) => {
    const legacy = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(files), env: TODAY });
    expect(resolveDefaultGate({ fileConfig: null, runGit: fakeGit(files), env: TODAY, scripts: FRONTIERUI_SCRIPTS }).command).toBe(legacy.command);
  });

  it.each(cases)('a plateau-app checkout ($name) runs `npm test` and skips the missing check:standards', ({ files }) => {
    const { command, gateReasons, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(files), env: TODAY, scripts: PLATEAU_APP_SCRIPTS });
    if (decision.mode === 'blocked') { expect(command).toBeNull(); return; }
    expect(command).toBe('npm test');
    expect(command).not.toContain('test:unit');
    expect(command).not.toContain('check:standards');
    expect(gateReasons.join(' ')).toMatch(/no `test:unit`.*npm test/);
    expect(gateReasons.join(' ')).toMatch(/no `check:standards`/);
  });

  it('a plateau-app checkout with an uncommitted edit also gets `npm test` (the selection is WE-shaped; script-aware)', () => {
    const { command } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['docs/readme.md'], { untracked: ['src/x.ts'] }), env: TODAY, scripts: PLATEAU_APP_SCRIPTS });
    expect(command).toBe('npm test');
  });

  it('a checkout with check:standards but no test:unit keeps the (scoped) health gate after `npm test`', () => {
    const { command } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['src/a.ts']), env: TODAY, scripts: ['test', 'check:standards'] });
    expect(command).toBe("npm test && npm run check:standards -- --local --files='src/a.ts'");
  });

  it('a checkout with no test/test:unit/check:standards script skips BOTH halves with an explicit reason, never a missing-script failure', () => {
    const { command, gateReasons } = composeGate({ vitestCmd: 'npm run test:unit', checkStandardsCmd: 'npm run check:standards', scripts: ['build'] });
    expect(command).toMatch(/^echo /);
    expect(command).not.toMatch(/npm (run|test)/);
    expect(gateReasons).toHaveLength(2);
    expect(gateReasons.join(' ')).toMatch(/test half skipped/);
  });
});

describe('canScopeCheckStandards (#3395) — the check:standards-scoping predicate in isolation', () => {
  it('is false for null (unreadable/unknown diff)', () => {
    expect(canScopeCheckStandards(null)).toBe(false);
  });

  it('is false for an empty changed set', () => {
    expect(canScopeCheckStandards([])).toBe(false);
  });

  it('is false when any changed file is under backlog/', () => {
    expect(canScopeCheckStandards(['docs/readme.md', 'backlog/100-example.md'])).toBe(false);
  });

  it('is false when any changed file is a gate-self/policy-core path', () => {
    expect(canScopeCheckStandards(['scripts/lib/review-escalation.mjs'])).toBe(false);
  });

  it('is true for a non-empty changed set touching neither surface, even a blast-radius `scripts/` path outside the policy-core roster', () => {
    expect(canScopeCheckStandards(['scripts/verify-lane.mjs', 'package.json'])).toBe(true);
  });
});

/**
 * laneRelevantChangeSince (#4296) — the "what changed since the marker was recorded, and does it still matter"
 * computation the finish-guard reuses so a no-op merge of `base` (conflicting only OUTSIDE the lane's own
 * touch-set) does not force a fresh full re-verify. A synthetic COMMIT-graph git fake (distinct from the
 * working-tree `fakeGit` above, which this function never calls): `diff --name-only <a> <b>` returns a fixed
 * changed-set per pair, and `merge-base <base> <headSha>` resolves to a fixed sha.
 */
describe('laneRelevantChangeSince (#4296) — keys marker validity to what changed, not the exact commit', () => {
  const RECORD_SHA = 'a'.repeat(40);
  const HEAD_SHA = 'b'.repeat(40);
  const MERGE_BASE = 'm'.repeat(40);

  /**
   * @param {{sinceRecord: string[], relevantAtHead: string[], relevantAtRecord?: string[]}} diffs
   *   `relevantAtRecord` defaults to `relevantAtHead` — the common case where the lane's own touch-set hasn't
   *   changed shape between record time and headSha (only the revert-scenario tests below need it to differ).
   */
  function fakeCommitGit({ sinceRecord, relevantAtHead, relevantAtRecord = relevantAtHead }) {
    return (args) => {
      if (args[0] === 'merge-base') return MERGE_BASE;
      if (args[0] === 'diff' && args[2] === RECORD_SHA && args[3] === HEAD_SHA) return sinceRecord.join('\n');
      if (args[0] === 'diff' && args[2] === MERGE_BASE && args[3] === HEAD_SHA) return relevantAtHead.join('\n');
      if (args[0] === 'diff' && args[2] === MERGE_BASE && args[3] === RECORD_SHA) return relevantAtRecord.join('\n');
      throw new Error(`unexpected git invocation in test: ${args.join(' ')}`);
    };
  }

  it('RED (the #4296 bug, reproduced): a no-op merge of `base` touching only an OUT-OF-SCOPE file must not be treated as an overlap', () => {
    // The item's own evidence shape: the lane's real diff (vs base) only ever touched `scripts/verify-lane.mjs`;
    // the merge that landed on top of the recorded green additionally changed `scripts/operations/ci-heal-pr-dispatch.mjs`
    // — a file the lane itself never touches, brought in wholesale from `base`. After the merge that file is
    // IDENTICAL to (the also-advanced) `base`, so it does not appear in the fresh base-diff at all.
    const overlap = laneRelevantChangeSince({
      recordSha: RECORD_SHA, headSha: HEAD_SHA,
      runGit: fakeCommitGit({
        sinceRecord: ['scripts/operations/ci-heal-pr-dispatch.mjs'],
        relevantAtHead: ['scripts/verify-lane.mjs'],
      }),
    });
    expect(overlap).toEqual([]); // no lane-relevant overlap — the marker still covers headSha
  });

  it('a genuinely overlapping merge — the changed-since-record file IS still lane-relevant — reports the overlap', () => {
    const overlap = laneRelevantChangeSince({
      recordSha: RECORD_SHA, headSha: HEAD_SHA,
      runGit: fakeCommitGit({
        sinceRecord: ['scripts/verify-lane.mjs', 'scripts/operations/ci-heal-pr-dispatch.mjs'],
        relevantAtHead: ['scripts/verify-lane.mjs'],
      }),
    });
    expect(overlap).toEqual(['scripts/verify-lane.mjs']);
  });

  it('recordSha === headSha short-circuits to no overlap without calling git at all', () => {
    const runGit = () => { throw new Error('must not be called'); };
    expect(laneRelevantChangeSince({ recordSha: HEAD_SHA, headSha: HEAD_SHA, runGit })).toEqual([]);
  });

  it('nothing changed since the record at all → empty overlap, merge-base never consulted', () => {
    let mergeBaseCalled = false;
    const runGit = (args) => {
      if (args[0] === 'merge-base') { mergeBaseCalled = true; return MERGE_BASE; }
      if (args[0] === 'diff') return '';
      throw new Error('unexpected');
    };
    expect(laneRelevantChangeSince({ recordSha: RECORD_SHA, headSha: HEAD_SHA, runGit })).toEqual([]);
    expect(mergeBaseCalled).toBe(false);
  });

  it('missing recordSha or headSha → null (unknown), never an empty-overlap free pass', () => {
    expect(laneRelevantChangeSince({ recordSha: null, headSha: HEAD_SHA, runGit: () => '' })).toBe(null);
    expect(laneRelevantChangeSince({ recordSha: RECORD_SHA, headSha: undefined, runGit: () => '' })).toBe(null);
  });

  it('#4296 (converge round 2, security juror) — a NON-hex recordSha or headSha (e.g. flag-shaped) is REFUSED before it ever reaches git as a positional revision, never passed through', () => {
    const runGit = () => { throw new Error('must not be called — validation must reject before any git invocation'); };
    expect(laneRelevantChangeSince({ recordSha: '--upload-pack=evil', headSha: HEAD_SHA, runGit })).toBe(null);
    expect(laneRelevantChangeSince({ recordSha: RECORD_SHA, headSha: '-x', runGit })).toBe(null);
    expect(laneRelevantChangeSince({ recordSha: 'not-a-sha-at-all', headSha: HEAD_SHA, runGit })).toBe(null);
  });

  it('every diff --name-only call separates revisions from pathspecs with a trailing `--`', () => {
    const seen = [];
    const runGit = (args) => {
      seen.push(args);
      if (args[0] === 'merge-base') return MERGE_BASE;
      return 'scripts/a.mjs';
    };
    laneRelevantChangeSince({ recordSha: RECORD_SHA, headSha: HEAD_SHA, runGit });
    for (const args of seen) {
      if (args[0] === 'diff') expect(args[args.length - 1]).toBe('--');
    }
  });

  it('an unresolvable merge-base (git cannot answer) → null, fail closed', () => {
    const overlap = laneRelevantChangeSince({
      recordSha: RECORD_SHA, headSha: HEAD_SHA,
      runGit: (args) => {
        if (args[0] === 'diff' && args[2] === RECORD_SHA) return 'scripts/a.mjs';
        if (args[0] === 'merge-base') return ''; // git could not find one
        throw new Error('unexpected');
      },
    });
    expect(overlap).toBe(null);
  });

  it('a git throw (e.g. recordSha unreachable/gc-ed) → null, fail closed', () => {
    const overlap = laneRelevantChangeSince({
      recordSha: RECORD_SHA, headSha: HEAD_SHA,
      runGit: () => { throw new Error('fatal: bad object'); },
    });
    expect(overlap).toBe(null);
  });

  it('pins BOTH merge-base calls to explicit shas — headSha AND recordSha, never the bare literal `HEAD`', () => {
    // `pinnedMergeBase` (test-selection.mjs, reused elsewhere in this file) always resolves against the literal
    // `HEAD` of the checkout; this function must never rely on that, since a caller may verify a `headSha` that
    // is not (or is no longer) this checkout's actual current HEAD (e.g. an explicit `--sha=`) — and, since the
    // union fix (converge round 1's red-team), it ALSO computes the lane's relevance as of `recordSha`, which is
    // never the checkout's HEAD either.
    const mergeBaseCalls = [];
    const runGit = (args) => {
      if (args[0] === 'diff' && args[2] === RECORD_SHA && args[3] === HEAD_SHA) return 'scripts/a.mjs';
      if (args[0] === 'merge-base') { mergeBaseCalls.push(args); return MERGE_BASE; }
      if (args[0] === 'diff' && args[2] === MERGE_BASE) return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    laneRelevantChangeSince({ recordSha: RECORD_SHA, headSha: HEAD_SHA, base: 'origin/main', runGit });
    expect(mergeBaseCalls).toContainEqual(['merge-base', 'origin/main', HEAD_SHA]);
    expect(mergeBaseCalls).toContainEqual(['merge-base', 'origin/main', RECORD_SHA]);
  });

  it('#4296 round-1-red-team FIX, reproduced: a lane REVERT of its own already-verified edit — headSha-only relevance would miss it', () => {
    // The blocker the red-team found: the lane edited `scripts/a.mjs` AND `scripts/b.mjs`, recorded green at
    // RECORD_SHA (both relevant then). A later commit reverts `scripts/a.mjs` back to `base`'s content while
    // keeping `scripts/b.mjs`'s edit — headSha's own relevance (diff vs base) no longer lists `a.mjs` at all,
    // even though `a.mjs` genuinely changed (reverted) between RECORD_SHA and headSha and that revert was never
    // itself verified.
    const overlap = laneRelevantChangeSince({
      recordSha: RECORD_SHA, headSha: HEAD_SHA,
      runGit: fakeCommitGit({
        sinceRecord: ['scripts/a.mjs'], // a.mjs is the only file that differs between record and head
        relevantAtHead: ['scripts/b.mjs'], // a.mjs reverted to base — no longer in the head-vs-base diff
        relevantAtRecord: ['scripts/a.mjs', 'scripts/b.mjs'], // …but it WAS relevant when the marker was recorded
      }),
    });
    expect(overlap).toEqual(['scripts/a.mjs']); // caught via relevantAtRecord — forces a re-verify
  });

  it('the ORIGINAL no-op-merge fix still holds under the union: a file never relevant at EITHER end stays excluded', () => {
    const overlap = laneRelevantChangeSince({
      recordSha: RECORD_SHA, headSha: HEAD_SHA,
      runGit: fakeCommitGit({
        sinceRecord: ['scripts/operations/ci-heal-pr-dispatch.mjs'],
        relevantAtHead: ['scripts/verify-lane.mjs'],
        relevantAtRecord: ['scripts/verify-lane.mjs'], // the lane never touched the upstream file at either end
      }),
    });
    expect(overlap).toEqual([]);
  });
});

/** A synthetic git runner for {@link computeWorkingTreeHash} (#4473): `merge-base` resolves to a fixed sha;
 *  `diff <sha> --` returns the tracked-diff PATCH TEXT (content, not just names); `ls-files --others
 *  --exclude-standard` the untracked file list; `hash-object -- <file>` each untracked file's own content hash
 *  (keyed off a simple in-memory map, standing in for the real git object hash). No real git process.
 *  `ls-files` answers NUL-separated, as the real `-z` form does. */
function fakeTreeGit({ mergeBase = 'deadbeef', trackedDiff = '', untracked = [], untrackedHashes = {} } = {}) {
  return (args) => {
    if (args[0] === 'merge-base') return mergeBase;
    if (args[0] === 'diff') return trackedDiff;
    if (args[0] === 'ls-files') return untracked.join('\0');
    if (args[0] === 'hash-object') {
      const file = args[args.length - 1];
      return untrackedHashes[file] ?? `hash-of-${file}`;
    }
    throw new Error(`unexpected git invocation in test: ${args.join(' ')}`);
  };
}

describe('computeWorkingTreeHash (#4473) — a content hash of the working tree against the pinned merge-base', () => {
  const regularFile = () => 0o100644;
  const treeHash = (opts, fileMode = regularFile) => computeWorkingTreeHash({ runGit: fakeTreeGit(opts), fileMode });

  it('is deterministic: the same tracked diff + untracked content hashes the same across two calls', () => {
    const opts = { trackedDiff: 'diff --git a/x b/x\n+hi\n', untracked: ['scratch.txt'] };
    expect(treeHash(opts)).toBe(treeHash(opts));
  });

  it('changes when the TRACKED diff changes (an edit to an already-tracked file)', () => {
    expect(treeHash({ trackedDiff: 'diff B\n' })).not.toBe(treeHash({ trackedDiff: 'diff A\n' }));
  });

  it('changes when an UNTRACKED file is added', () => {
    expect(treeHash({ untracked: ['new.txt'] })).not.toBe(treeHash({ untracked: [] }));
  });

  it('changes when an untracked file\'s own CONTENT changes (its hash-object result differs), same filename', () => {
    const before = treeHash({ untracked: ['scratch.txt'], untrackedHashes: { 'scratch.txt': 'aaa' } });
    const after = treeHash({ untracked: ['scratch.txt'], untrackedHashes: { 'scratch.txt': 'bbb' } });
    expect(after).not.toBe(before);
  });

  it('is insensitive to the ON-DISK ORDER `ls-files` happens to return untracked files in (sorted before hashing)', () => {
    expect(treeHash({ untracked: ['b.txt', 'a.txt'] })).toBe(treeHash({ untracked: ['a.txt', 'b.txt'] }));
  });

  // PR #2982 review — `hash-object` is content-only, so the execute bit / file type must enter the key separately.
  it('changes when an untracked file loses its EXECUTE bit (same content, same hash-object)', () => {
    const opts = { untracked: ['tool.sh'] };
    expect(treeHash(opts, () => 0o100644)).not.toBe(treeHash(opts, () => 0o100755));
    // only the OWNER loses x (group/other keep it) — the owner running the gate now gets EACCES
    expect(treeHash(opts, () => 0o100655)).not.toBe(treeHash(opts, () => 0o100755));
  });

  it('changes when an untracked path turns into a SYMLINK (same hash-object)', () => {
    const opts = { untracked: ['link'] };
    expect(treeHash(opts, () => 0o120777)).not.toBe(treeHash(opts, () => 0o100755));
  });

  it('returns null (fail closed) with an untracked file but no `fileMode` reader — never a mode-blind key', () => {
    expect(computeWorkingTreeHash({ runGit: fakeTreeGit({ untracked: ['tool.sh'] }) })).toBeNull();
    expect(computeWorkingTreeHash({ runGit: fakeTreeGit({ untracked: [] }) })).not.toBeNull();
  });

  it('passes a non-ASCII / newline-bearing untracked path to hash-object verbatim (NUL-split, never C-quoted)', () => {
    const seen = [];
    const git = fakeTreeGit({ untracked: ['café.txt', 'a\nb.txt'] });
    const spy = (args) => { if (args[0] === 'hash-object') seen.push(args[args.length - 1]); return git(args); };
    expect(computeWorkingTreeHash({ runGit: spy, fileMode: regularFile })).not.toBeNull();
    expect(seen.sort()).toEqual(['a\nb.txt', 'café.txt']);
  });

  it('returns null (unknown — fail closed) when there is no computable merge-base', () => {
    const git = () => { throw new Error('no upstream configured'); };
    expect(computeWorkingTreeHash({ runGit: git })).toBeNull();
  });
});

describe('verify-lane.mjs source wiring — the default gate actually calls resolveDefaultGate', () => {
  it('xpnhz4o — prints describeGate before running, and `run` mode records no marker', () => {
    const src = readFileSync(resolve(process.cwd(), 'scripts/verify-lane.mjs'), 'utf8');
    expect(src).toMatch(/process\.stderr\.write\(describeGate\(resolved\)/);
    expect(src).toMatch(/if \(MODE !== 'run'\) writeMarker\(verifyStartBody/);
    expect(src).toMatch(/const preStart = MODE === 'run' \? null : readMarker\(\)/);
  });

  it('imports resolveDefaultGate from ./lib/verify-lane-gate.mjs and uses it to build the default GATE', () => {
    const src = readFileSync(resolve(process.cwd(), 'scripts/verify-lane.mjs'), 'utf8');
    expect(src).toMatch(/from ['"]\.\/lib\/verify-lane-gate\.mjs['"]/);
    expect(src).toMatch(/resolveDefaultGate\(/);
    // The literal bare default must be GONE — only the fallback constant inside verify-lane-gate.mjs keeps it.
    expect(src).not.toMatch(/const GATE = typeof flags\.gate === 'string' \? flags\.gate : 'npm run test:unit/);
  });

  it('#3919 — injects the target checkout\'s package.json script names into resolveDefaultGate', () => {
    const src = readFileSync(resolve(process.cwd(), 'scripts/verify-lane.mjs'), 'utf8');
    expect(src).toMatch(/join\(REPO, 'package\.json'\)/);
    expect(src).toMatch(/resolveDefaultGate\(\{[^}]*scripts: readCheckoutScripts\(\)/);
  });

  it('#4296 — both `check` paths (bare, and `--wait=`) feed laneRelevantChangeSinceForRecord into verifyGateDecision', () => {
    const src = readFileSync(resolve(process.cwd(), 'scripts/verify-lane.mjs'), 'utf8');
    expect(src).toMatch(/laneRelevantChangeSinceForRecord/);
    expect(src).toMatch(/from '\.\/lib\/verify-lane-gate\.mjs'/);
    // The bare `check` path — both calls go through the ONE shared guard+compute wrapper (converge round 1,
    // simplicity juror: the corrupt/missing-sha/exact-match precondition must live in exactly one place, never
    // copied per call site), and both name `base: 'origin/main'` EXPLICITLY (converge round 2, standards-
    // conformance juror — this file's own default gate already hardcodes that base; a caller-side default here
    // too would let the two silently disagree if either default ever changed alone).
    expect(src).toMatch(/laneRelevantChangeSince: laneRelevantChangeSinceForRecord\(\{ record: bareCheckRecord, headSha, base: 'origin\/main', runGit: git \}\)/);
    // The `--wait=` path threads a resolver callback through waitForVerifySettle, not a one-shot precomputed value
    // (the wait polls the marker fresh — see waitForVerifySettle's own doc for why the callback shape matters),
    // and the callback wraps the SAME shared wrapper, passing the FULL record (never just its sha).
    expect(src).toMatch(/resolveLaneRelevantChangeSince: \(record\) => laneRelevantChangeSinceForRecord\(\{ record, headSha, base: 'origin\/main', runGit: git \}\)/);
  });
});

// #4473 review finding 4 — a prior revision of this file had an additional source-text regex test here
// ('`request`/bare `verify` compute the working-tree hash and skip re-verifying on a cache hit') that matched
// verify-lane.mjs's exact expression text, including a whitespace window and the full start-write call. It was
// removed: it asserted nothing about BEHAVIOR that the real-git integration tests in
// scripts/__tests__/verify-lane.test.mjs (describe blocks tagged #4473) don't already cover end to end — cache
// hit on matching sha+treeHash+gate, cache MISS on a differing gate, cache MISS on a red record, and cache MISS
// with no computable origin/main ref — while being strictly MORE fragile than those: a harmless reformat or
// reordering of the cacheHit condition redded this regex with no behavior change at all.

describe('stableTreeHash (#4473, PR #2982 round-2 review) — record a tree hash only if the tree held still for the whole run', () => {
  it('returns the hash when every sample matches', () => {
    expect(stableTreeHash('a', 'a', 'a')).toBe('a');
  });
  it('returns null when any sample differs — including one that caught an edit later reverted by the next sample (A → B → A)', () => {
    expect(stableTreeHash('a', 'b', 'b')).toBeNull();
    expect(stableTreeHash('a', 'a', 'b')).toBeNull();
    expect(stableTreeHash('a', 'b', 'a')).toBeNull();
  });
  it('returns null when any sample is unknown, or there are no samples (fail closed)', () => {
    expect(stableTreeHash('a', null, 'a')).toBeNull();
    expect(stableTreeHash(null, null)).toBeNull();
    expect(stableTreeHash('a', undefined)).toBeNull();
    expect(stableTreeHash()).toBeNull();
  });
});

describe('fix-3311 selection replay', () => {
  it('selects all five observed shared helpers through graph inputs and reference discovery', () => {
    const helpers = [
      'scripts/conveyor/__tests__/sim/world.mjs',
      'scripts/lib/__tests__/fixtures/inherited-routing-policy.json',
      'scripts/lib/__tests__/inherited-routing-policy.mjs',
      'scripts/operations/__tests__/helpers/fake-claude-shim.mjs',
      'scripts/operations/__tests__/helpers/fake-claude.mjs',
    ];
    const ref = 'scripts/operations/__tests__/repair-routing-review-fixes.test.mjs';
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(helpers, {
      grepHits: { 'fake-claude.mjs': [ref] },
    }), env: TODAY });
    expect(decision.mode).toBe('shrink');
    expect(decision.targets).toEqual([...helpers, ref].sort());
    expect(command).toContain('vitest related');
    expect(command).not.toContain('npm run test:unit');
  });
  it('also bounds long path arguments below the target-count limit', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/' + 'a'.repeat(33000) + '.mjs']), env: TODAY });
    expect(decision.mode).toBe('blocked');
    expect(command).toBeNull();
  });
});

describe('explicitGateRefusal — an agent-supplied gate must be an affected-test shape', () => {
  it.each([
    'npx vitest related scripts/a.test.mjs scripts/b.mjs --run',
    "npx vitest related 'scripts/a.test.mjs' 'scripts/b.mjs' --run --bail=1",
    'npx vitest run scripts/a.test.mjs',
    'vitest run',
    'npm run test:unit',
    'npm test',
    'npx vitest related scripts/a.mjs --run && npm run check:standards -- --local --files=scripts/a.mjs',
    'npm run test:unit && npm run check:standards',
  ])('accepts %j', (gate) => expect(explicitGateRefusal(gate)).toBeNull());

  // The adversarial-review bypasses: each of these runs no real tests (or runs attacker-chosen code) yet records green.
  it.each([
    'npx vitest run --passWithNoTests zzz-nonexistent',
    'npx vitest related ghost.ts --run --passWithNoTests',
    'npx vitest run --config /tmp/evil.mjs x',
    'npx vitest run -c /tmp/evil.mjs x',
    'npx vitest run x --reporter=./evil.mjs',
    'npx vitest run x --root /tmp/elsewhere',
    'npx vitest run x --exclude "**/*"',
    'npx vitest run x -t zzznomatch',
    'npm run test:unit -- -t zzznomatch',
    'npm run test:unit:evil',
    'npm test -- --passWithNoTests',
  ])('refuses the silencing/redirecting form %j', (gate) => expect(explicitGateRefusal(gate)).not.toBeNull());

  it.each([
    ['', /empty/],
    ['true', /every `&&` segment/],
    ['exit 0', /every `&&` segment/],
    ['echo ok', /every `&&` segment/],
    ['npx vitest related scripts/a.mjs --run || true', /shell operator/],
    ['npx vitest related scripts/a.mjs --run; true', /shell operator/],
    ['npx vitest related scripts/a.mjs --run | cat', /shell operator/],
    ['npx vitest related scripts/a.mjs --run & true', /shell operator/],
    ['npx vitest related scripts/a.mjs --run > /dev/null', /shell operator/],
    ['npx vitest run $(echo x)', /shell operator/],
    ['npx vitest related scripts/a.mjs --run && true', /every `&&` segment/],
    ['npm run check:standards', /runs no tests/],
    ['npx vitest related --run', /names no target/],
    ['npx vitest related --run && npm run check:standards', /names no target/],
    ['npx vitest related --run --passWithNoTests && npm run check:standards', /not an allowed flag/],
  ])('refuses %j', (gate, why) => expect(explicitGateRefusal(gate)).toMatch(why));
});

it('exposes the gate halves without splitting shell-quoted changed paths', () => {
  const gate = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/a && b.mjs']), env: TODAY });
  expect(gate.testCommand).toContain("'scripts/a && b.mjs'");
  expect(gate.standardsCommand).toMatch(/^npm run check:standards/);
  expect(gate.command).toBe(`${gate.testCommand} && ${gate.standardsCommand}`);
});


describe('verify phase telemetry (#5141)', () => {
  const skipped = { vitest: { result: 'skipped' }, scan: { result: 'skipped' }, standards: { result: 'skipped' } };
  it('derives outcomes, file reasons, exit and signal fallbacks', () => {
    expect(buildPhaseOutcome({ kind: 'vitest' })).toEqual({ result: 'skipped' });
    expect(buildPhaseOutcome({ kind: 'vitest', exitCode: 0, failureDetails: { tests: [{ file: 'old-failure' }] } }))
      .toEqual({ result: 'pass' });
    expect(buildPhaseOutcome({ kind: 'scan', exitCode: 1, failureDetails: { tests: [{ file: 'scan.test.mjs' }] } }))
      .toEqual({ result: 'fail', reason: 'scan.test.mjs' });
    expect(buildPhaseOutcome({ kind: 'vitest', exitCode: 3 }))
      .toEqual({ result: 'fail', reason: 'exit 3', source: 'import-graph' });
    expect(buildPhaseOutcome({ kind: 'scan', exitCode: 0, signal: 'SIGTERM' }))
      .toEqual({ result: 'fail', reason: 'signal SIGTERM' });
    expect(buildPhaseOutcome({ kind: 'scan', exitCode: 1, failureDetails: { tests: [{ file: 'x'.repeat(250) }] } }).reason).toHaveLength(200);
  });
  it('attributes only literal-only failing files to literal discovery', () => {
    const decision = { relatedFiles: ['both.test.mjs'], referencedTests: ['literal.test.mjs', 'both.test.mjs'] };
    for (const [file, source] of [['literal.test.mjs', 'literal-reference'], ['both.test.mjs', 'import-graph'], ['other.test.mjs', 'import-graph']]) {
      expect(buildPhaseOutcome({ kind: 'vitest', exitCode: 1, decision, failureDetails: { tests: [{ file }, { file: 'ignored' }] } }))
        .toEqual({ result: 'fail', reason: file, source });
    }
  });
  it('extracts the first standards error, stripping ANSI and retaining a rule id when present', () => {
    expect(firstStandardsErrorId(' warning ignore\n\x1b[31m error\x1b[0m rule-42: broken\n error second: later')).toBe('rule-42');
    expect(firstStandardsErrorId(' error A message without a rule')).toBe('A message without a rule');
    expect(firstStandardsErrorId(' error ' + 'x'.repeat(250))).toHaveLength(200);
    expect(firstStandardsErrorId('0 error(s), 1 warning(s)')).toBeNull();
    for (const output of [null, { stdout: 'no errors', stderr: '' }]) {
      expect(buildPhaseOutcome({ kind: 'standards', exitCode: 2, output })).toEqual({ result: 'fail', reason: 'exit 2' });
    }
    expect(buildPhaseOutcome({ kind: 'standards', exitCode: 1, output: { stdout: '', stderr: ' error check-rule: broken' } }))
      .toEqual({ result: 'fail', reason: 'check-rule' });
    // Output over the capture cap is null: fall back to the collector's bounded tail.
    expect(buildPhaseOutcome({ kind: 'standards', exitCode: 1, output: null, failureDetails: { tests: [], summary: 'warn x\n error tail-rule: broken\n1 error(s)' } }))
      .toEqual({ result: 'fail', reason: 'tail-rule' });
  });
  it('counts discovery targets without counting graph overlap as literal', () => {
    expect(buildVerifyPhases({ decision: { relatedFiles: ['a', 'b'], referencedTests: ['b', 'c'] } }))
      .toMatchObject({ importGraphTargetCount: 2, literalReferenceTargetCount: 1 });
    expect(buildVerifyPhases({ decision: { relatedFiles: [], referencedTests: [] } }))
      .toMatchObject({ importGraphTargetCount: 0, literalReferenceTargetCount: 0 });
  });
  it('appends outcomes and discovery counts on one line', () => {
    const outcomes = { vitest: { result: 'fail', reason: 'scripts/__tests__/x.test.mjs', source: 'literal-reference' }, scan: { result: 'pass' }, standards: { result: 'skipped' } };
    const phases = buildVerifyPhases({ outcomes, decision: { relatedFiles: ['a'], referencedTests: ['b'] } });
    expect(phases.outcomes).toEqual(outcomes);
    expect(formatVerifyPhases(phases)).toBe('phaseMs vitest=fail(scripts/__tests__/x.test.mjs) scan=pass standards=skipped graph=1 literal=1 admission=gate');
  });
  it('rounds timings and derives counts from decision arrays', () => {
    expect(buildVerifyPhases({ admissionWaitMs: 12.4, vitestMs: 3400.6, scanMs: 800.2,
      standardsMs: 5200.5, gateMs: 9400.4, decision: { targets: ['a', 'b'], changedFiles: ['a'] } })).toEqual({
      admissionWaitMs: 12, vitestMs: 3401, scanMs: 800, standardsMs: 5201, gateMs: 9400,
      targetFileCount: 2, changedFileCount: 1, importGraphTargetCount: null, literalReferenceTargetCount: null, relatedMode: null, testTimeoutFactor: null, standardsPolicy: null, settingsSource: null, admissionMode: 'gate', admissionPhases: null, outcomes: skipped,
    });
  });
  it('uses null for missing or non-finite timings and absent decisions', () => {
    expect(buildVerifyPhases({ admissionWaitMs: Infinity, vitestMs: NaN, scanMs: -Infinity,
      standardsMs: undefined })).toEqual({ admissionWaitMs: null, vitestMs: null, scanMs: null,
      standardsMs: null, gateMs: null, targetFileCount: null, changedFileCount: null,
      importGraphTargetCount: null, literalReferenceTargetCount: null, relatedMode: null, testTimeoutFactor: null, standardsPolicy: null, settingsSource: null, admissionMode: 'gate', admissionPhases: null, outcomes: skipped });
    expect(buildVerifyPhases({})).toEqual(buildVerifyPhases({ admissionWaitMs: NaN }));
  });
  it('guards counts with Array.isArray and preserves empty counts and zero timings', () => {
    expect(buildVerifyPhases({ admissionWaitMs: 0, gateMs: 0,
      decision: { targets: { length: 4 }, changedFiles: 'abc' } })).toMatchObject({
      admissionWaitMs: 0, gateMs: 0, targetFileCount: null, changedFileCount: null,
    });
    expect(buildVerifyPhases({ decision: { targets: [], changedFiles: [] } })).toMatchObject({
      targetFileCount: 0, changedFileCount: 0,
    });
  });
  it('formats a single line and omits null values', () => {
    expect(formatVerifyPhases(buildVerifyPhases({ admissionWaitMs: 12, vitestMs: 3400, scanMs: 800,
      standardsMs: 5200, gateMs: 9400, decision: { targets: Array(7), changedFiles: Array(3) } })))
      .toBe('phaseMs admission=12 vitest=3400 scan=800 standards=5200 gate=9400 targets=7 changed=3 vitest=skipped scan=skipped standards=skipped admission=gate');
    expect(formatVerifyPhases(buildVerifyPhases({ admissionWaitMs: 0, gateMs: 4 })))
      .toBe('phaseMs admission=0 gate=4 vitest=skipped scan=skipped standards=skipped admission=gate');
  });
});

describe('WE_VERIFY_RELATED', () => {
  it.each([undefined, '', 'all', 'invalid', 'import-only'])('normalizes %s', (value) => {
    expect(verifyRelatedMode({ WE_VERIFY_RELATED: value }, null)).toBe(value === 'import-only' ? 'import-only' : 'all');
  });
  it.each(['all', 'import-only'])('selects %s targets and reports the mode', (mode) => {
    const calls = [];
    const git = fakeGit(['scripts/verify-lane.mjs'], {
      grepHits: { 'verify-lane.mjs': ['scripts/__tests__/verify-lane.test.mjs'] },
    });
    const { decision, command } = resolveDefaultGate({ fileConfig: null,
      env: mode === 'all' ? {} : { WE_VERIFY_RELATED: mode },
      runGit: (args) => { calls.push(args); return git(args); },
    });
    expect(decision.relatedMode).toBe(mode);
    expect(decision.referencedTests).toEqual(mode === 'all' ? ['scripts/__tests__/verify-lane.test.mjs'] : []);
    expect(decision.targets).toEqual([...decision.relatedFiles, ...decision.referencedTests].sort());
    expect(calls.some(args => args[0] === 'grep')).toBe(mode === 'all');
    expect(command).toContain(" && npm run check:standards -- --local --files='scripts/verify-lane.mjs'");
    const phases = buildVerifyPhases({ decision });
    expect(phases.relatedMode).toBe(mode);
    expect(formatVerifyPhases(phases)).toContain('related=' + mode);
  });
});

describe('WE_VERIFY_TEST_TIMEOUT_FACTOR (local-only scaled vitest timeouts)', () => {
  it('defaults to 3, accepts >= 1, falls back to 3 on junk', () => {
    expect(verifyTestTimeoutFactor({})).toBe(3);
    expect(verifyTestTimeoutFactor({ WE_VERIFY_TEST_TIMEOUT_FACTOR: '1' })).toBe(1);
    expect(verifyTestTimeoutFactor({ WE_VERIFY_TEST_TIMEOUT_FACTOR: '2.5' })).toBe(2.5);
    for (const bad of ['0', '-2', 'x', '0.5']) expect(verifyTestTimeoutFactor({ WE_VERIFY_TEST_TIMEOUT_FACTOR: bad })).toBe(3);
  });
  it('factor 1 adds no flags; factor 3 scales test and hook timeouts', () => {
    expect(scaledTimeoutFlags(1)).toBe('');
    expect(scaledTimeoutFlags(3)).toBe(' --testTimeout=15000 --hookTimeout=30000');
  });
  it('the default local gate scales the related and scan halves, never check:standards, and records the factor', () => {
    const { command, decision } = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/verify-lane.mjs']), env: {}, fileExists: () => true });
    for (const seg of command.split(' && ').filter((c) => /vitest (related|run)/.test(c))) expect(seg).toMatch(/--testTimeout=15000 --hookTimeout=30000$/);
    expect(command).toMatch(/&& npm run check:standards -- --local --files='scripts\/verify-lane\.mjs'$/);
    expect(decision.testTimeoutFactor).toBe(3);
    expect(buildVerifyPhases({ decision }).testTimeoutFactor).toBe(3);
    expect(formatVerifyPhases(buildVerifyPhases({ decision }))).toContain('timeoutFactor=3');
  });
});

describe('#verify-standards-auto', () => {
  it.each([undefined, '', 'unknown', 'always', 'auto', 'ci-only'])('normalizes policy %s', value => {
    expect(verifyStandardsPolicy({ WE_VERIFY_STANDARDS: value })).toBe(['always', 'auto', 'ci-only'].includes(value) ? value : 'auto');
  });
  it('defaults without an environment', () => expect(verifyStandardsPolicy()).toBe('auto'));
  it('freezes the relevant prefixes', () => {
    expect(Object.isFrozen(STANDARDS_AUTO_PREFIXES)).toBe(true);
    expect(STANDARDS_AUTO_PREFIXES).toEqual(['backlog/', 'docs/', 'config/', 'agent-memory-src/', 'skills-src/', '.claude/', '.github/', 'src/', 'blocks/', 'research/', 'site/']);
  });
  it.each(['backlog/a.md', 'docs/a.md', 'skills-src/a.md', '.claude/a.md', 'README.md', 'package.json', 'package-lock.json',
    'config/a.json', 'agent-memory-src/a.md', '.github/a.yml', 'src/a.ts', 'blocks/a.ts', 'research/a.md', 'site/a.njk'])('runs auto for %s', path => {
    expect(standardsRelevantPath(path)).toBe(true);
    expect(decideStandardsHalf({ policy: 'auto', changedFiles: [path] })).toEqual({
      policy: 'auto', run: true, scoped: !path.startsWith('backlog/'), reason: 'auto: standards-relevant path ' + path,
    });
  });
  it('skips code only and CI-owned standards with exact reasons', () => {
    expect(standardsRelevantPath('scripts/foo.mjs')).toBe(false);
    expect(standardsRelevantPath('scripts/readme.md')).toBe(false);
    expect(decideStandardsHalf({ policy: 'auto', changedFiles: ['scripts/foo.mjs'] })).toEqual({
      policy: 'auto', run: false, scoped: false, reason: 'skipped (auto: code-only diff)',
    });
    expect(decideStandardsHalf({ policy: 'ci-only', changedFiles: ['backlog/a.md'] })).toEqual({
      policy: 'ci-only', run: false, scoped: false, reason: 'skipped (ci-only: CI runs check:standards)',
    });
  });
  it.each([null, []])('fails safe for unknown auto diff %j', changedFiles => {
    expect(decideStandardsHalf({ policy: 'auto', changedFiles })).toEqual({
      policy: 'auto', run: true, scoped: false, reason: 'auto: diff unknown — run kept',
    });
  });
  it.each(['always', 'auto', 'ci-only'])('keeps policy core unscoped under %s', policy => {
    expect(decideStandardsHalf({ policy, changedFiles: ['scripts/lib/review-escalation.mjs'] })).toEqual({
      policy, run: true, scoped: false, reason: 'gate-self/policy-core path — unscoped run kept',
    });
  });
  it('preserves always scoping and reasons', () => {
    expect(decideStandardsHalf({ policy: 'always', changedFiles: ['scripts/foo.mjs'] })).toEqual({
      policy: 'always', run: true, scoped: true, reason: 'always',
    });
    expect(decideStandardsHalf({ policy: 'always', changedFiles: null }).reason)
      .toBe('always; unscoped: backlog/ or gate-self/policy-core path or unknown diff');
  });
  it('omits the standards command and describes the skip', () => {
    const resolved = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['scripts/foo.mjs']), env: { ...TODAY, WE_VERIFY_STANDARDS: 'auto' } });
    expect(resolved.command).toBe("npx vitest related 'scripts/foo.mjs' --run --passWithNoTests");
    expect(resolved.standardsCommand).toBeNull();
    expect(resolved.gateReasons).toContain('skipped (auto: code-only diff)');
    expect(describeGate(resolved)).toContain('  check:standards: skipped (auto: code-only diff)');
    expect(composeGate({ vitestCmd: 'test', checkStandardsCmd: null, scripts: ['test:unit'] }).gateReasons).toEqual([]);
    const blocked = resolveDefaultGate({ fileConfig: null, runGit: fakeGit(['package.json']), env: { WE_VERIFY_STANDARDS: 'auto' } });
    expect(blocked.decision.standards).toMatchObject({ policy: 'auto', run: true });
  });
  it('records the skip without replacing an existing outcome', () => {
    const decision = { standards: decideStandardsHalf({ policy: 'auto', changedFiles: ['scripts/foo.mjs'] }) };
    const phases = buildVerifyPhases({ decision });
    expect(phases.standardsPolicy).toBe('auto');
    expect(phases.outcomes.standards).toEqual({ result: 'skipped', reason: 'skipped (auto: code-only diff)' });
    expect(formatVerifyPhases(phases)).toContain('standardsPolicy=auto');
    expect(buildVerifyPhases({ decision, outcomes: { standards: { result: 'pass' } } }).outcomes.standards.result).toBe('pass');
  });
});

describe('#verify-phase-admission', () => {
  it.each([undefined, '', '1', 'false', '0'])('enables unless exactly zero: %s', value => {
    expect(verifyPhaseAdmissionEnabled({ WE_VERIFY_PHASE_ADMISSION: value })).toBe(value !== '0');
  });
  it.each([[undefined, 5], ['', 5], ['invalid', 5], ['-1', 5], ['1.5', 5], ['0', 0], ['10', 10]])('normalizes target bound %s', (value, expected) => {
    expect(verifyFastTargets({ WE_VERIFY_FAST_TARGETS: value })).toBe(expected);
  });
  it.each([
    ['vitest', 3, false, {}, 'files', 'fast'],
    ['vitest', 6, false, {}, 'other', 'slow'],
    ['vitest', 6, false, { WE_VERIFY_FAST_TARGETS: '10' }, 'files', 'fast'],
    ['scan', 6, false, {}, 'files', 'fast'],
    ['standards', 3, true, {}, 'standards', 'fast'],
    ['standards', 3, false, {}, 'other', 'slow'],
  ])('routes %s (%s targets, scoped=%s)', (phase, count, standardsScoped, env, kind, lane) => {
    expect(phaseAdmissionKind({ phase, decision: { targets: Array(count) }, standardsScoped, env })).toEqual({ kind, lane });
  });
  it('records phase admissions and sums waits', () => {
    const admissions = {
      vitest: { kind: 'files', lane: 'fast', waitedMs: 7, slot: 1, timedOut: false },
      scan: { kind: 'files', lane: 'fast', waitedMs: 9, slot: 1, timedOut: false },
      standards: { kind: 'other', lane: 'slow', waitedMs: 11, slot: null, timedOut: true },
    };
    const phases = buildVerifyPhases({ admission: { mode: 'phase', phases: admissions }, admissionWaitMs: 999 });
    expect(phases).toMatchObject({ admissionMode: 'phase', admissionPhases: admissions, admissionWaitMs: 27 });
    expect(formatVerifyPhases(phases)).toContain('admission=phase');
    expect(formatVerifyPhases(phases)).toContain('vitestWait=7(fast)');
    expect(buildVerifyPhases({ admissionWaitMs: 8 })).toMatchObject({ admissionMode: 'gate', admissionPhases: null, admissionWaitMs: 8 });
  });
});
