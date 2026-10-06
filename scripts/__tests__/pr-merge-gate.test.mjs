/**
 * @file scripts/__tests__/pr-merge-gate.test.mjs
 * @description Proof of the shared merge gate (`scripts/lib/pr-merge-gate.mjs`, #2290) — the ONE place a
 *   `gh pr merge` to `main` may originate. The transition invariant: only the drain may merge; every other
 *   route is rejected unless the documented `WE_MERGE_BREAK_GLASS=1` admin override is armed (which then emits
 *   a loud audit line). The gh shell is injected (never actually called).
 */
import { describe, it, expect, vi } from 'vitest';
import { mergePr, assertMayMerge, buildGateMergeArgs, decideDeleteBranch, mergeMethodFlag, hasNonEmptyBody, isTestPath, parseUnifiedDiff, scanTestTampering, buildStackedPrListArgs, buildRetargetArgs, retargetStackedPrs, describeStackedTestGamingOrigin } from '../lib/pr-merge-gate.mjs';

// A capturing fake gh exec + a capturing stderr sink, so nothing shells out and the audit line is observable.
const fakeExec = () => { const calls = []; const exec = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { ok: true }; }; return { exec, calls }; };
const fakeLog = () => { const lines = []; return { log: { write: (s) => lines.push(s) }, lines }; };

describe('pr-merge-gate — buildGateMergeArgs (mirrors the merge-ai-prs inline call)', () => {
  it('builds `pr merge <n> --merge --delete-branch` with no --repo for the cwd repo', () => {
    expect(buildGateMergeArgs({ pr: 12 })).toEqual(['pr', 'merge', '12', '--merge', '--delete-branch']);
  });
  it('threads --repo <slug> when a repo is given (the multi-repo drain)', () => {
    expect(buildGateMergeArgs({ pr: 7, repo: 'frontier-ui/frontierui' }))
      .toEqual(['pr', 'merge', '7', '--repo', 'frontier-ui/frontierui', '--merge', '--delete-branch']);
  });
  it('honours the merge method flag and never emits --auto (the drain owns ordering)', () => {
    expect(mergeMethodFlag('squash')).toBe('--squash');
    expect(mergeMethodFlag('rebase')).toBe('--rebase');
    expect(mergeMethodFlag('merge')).toBe('--merge');
    expect(mergeMethodFlag(undefined)).toBe('--merge');
    expect(buildGateMergeArgs({ pr: 1, method: 'squash' })).not.toContain('--auto');
  });

  // xvzc4v4 (merge-safety review, bug 1) — the merge was not tied to the reviewed/checked commit: `gh pr merge`
  // carried no `--match-head-commit`, so a push (or a `review:changes`) landing between the pass-start decision
  // and this call was invisible. `gh` itself refuses the merge server-side if the live head no longer matches.
  it('threads --match-head-commit <sha> when a sha is given (bug 1 fix)', () => {
    expect(buildGateMergeArgs({ pr: 12, matchHeadCommit: 'abc1234' }))
      .toEqual(['pr', 'merge', '12', '--merge', '--delete-branch', '--match-head-commit', 'abc1234']);
  });
  it('threads --match-head-commit AFTER --repo when both are given', () => {
    expect(buildGateMergeArgs({ pr: 7, repo: 'frontier-ui/frontierui', matchHeadCommit: 'deadbeef' }))
      .toEqual(['pr', 'merge', '7', '--repo', 'frontier-ui/frontierui', '--merge', '--delete-branch', '--match-head-commit', 'deadbeef']);
  });
  it('omits --match-head-commit when none is given — byte-identical to the pre-fix argv (no regression)', () => {
    expect(buildGateMergeArgs({ pr: 12 })).toEqual(['pr', 'merge', '12', '--merge', '--delete-branch']);
    expect(buildGateMergeArgs({ pr: 12, matchHeadCommit: null })).toEqual(['pr', 'merge', '12', '--merge', '--delete-branch']);
    expect(buildGateMergeArgs({ pr: 12, matchHeadCommit: '' })).toEqual(['pr', 'merge', '12', '--merge', '--delete-branch']);
  });
  it('mergePr threads matchHeadCommit through to the gh argv it shells', () => {
    const { exec, calls } = fakeExec();
    mergePr({ pr: 5, repo: null, method: 'merge', matchHeadCommit: 'cafef00d', caller: 'drain', exec, env: {} });
    expect(calls[0].args).toEqual(['pr', 'merge', '5', '--merge', '--delete-branch', '--match-head-commit', 'cafef00d']);
  });
  it('omits --delete-branch when false while retaining --match-head-commit', () => {
    expect(buildGateMergeArgs({ pr: 12, deleteBranch: false, matchHeadCommit: 'abc1234' }))
      .toEqual(['pr', 'merge', '12', '--merge', '--match-head-commit', 'abc1234']);
  });
  it('keeps default argv unchanged with deletion omitted or explicitly true', () => {
    for (const options of [{}, { deleteBranch: undefined }, { deleteBranch: true }]) {
      expect(buildGateMergeArgs({ pr: 7, repo: 'frontier-ui/frontierui', method: 'squash', matchHeadCommit: 'deadbeef', ...options }))
        .toEqual(['pr', 'merge', '7', '--repo', 'frontier-ui/frontierui', '--squash', '--delete-branch', '--match-head-commit', 'deadbeef']);
    }
  });
  it('mergePr passes deleteBranch false through while retaining matchHeadCommit', () => {
    const { exec, calls } = fakeExec();
    mergePr({ pr: 5, deleteBranch: false, matchHeadCommit: 'cafef00d', caller: 'drain', exec, env: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['pr', 'merge', '5', '--merge', '--match-head-commit', 'cafef00d']);
  });
});

describe('pr-merge-gate — decideDeleteBranch', () => {
  it('preserves the branch when one retarget failed', () => {
    expect(decideDeleteBranch({ retarget: { retargeted: [11], failed: [12] } })).toBe(false);
  });
  it('allows deletion when no retarget failed', () => {
    expect(decideDeleteBranch({ retarget: { retargeted: [11], failed: [] } })).toBe(true);
  });
  it('allows deletion for undefined or empty inputs', () => {
    expect(decideDeleteBranch()).toBe(true);
    expect(decideDeleteBranch(undefined)).toBe(true);
    expect(decideDeleteBranch({})).toBe(true);
    expect(decideDeleteBranch({ retarget: undefined })).toBe(true);
    expect(decideDeleteBranch({ retarget: {} })).toBe(true);
  });
  it('allows deletion when failures are not an array', () => {
    expect(decideDeleteBranch({ retarget: null })).toBe(true);
    expect(decideDeleteBranch({ retarget: { failed: 'failure' } })).toBe(true);
    expect(decideDeleteBranch({ retarget: { failed: { length: 1 } } })).toBe(true);
  });
});

describe('pr-merge-gate — mergePr caller invariant (#2290)', () => {
  it('caller "drain" PROCEEDS and shells the gh merge', () => {
    const { exec, calls } = fakeExec();
    const r = mergePr({ pr: 5, repo: null, method: 'merge', caller: 'drain', exec, env: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toEqual(['pr', 'merge', '5', '--merge', '--delete-branch']);
    expect(r).toEqual({ ok: true }); // returns whatever exec returns (the inline call's shape)
  });

  it('caller "pr-land" THROWS (no merge) with the enqueue-instead guidance', () => {
    const { exec, calls } = fakeExec();
    expect(() => mergePr({ pr: 5, caller: 'pr-land', exec, env: {} }))
      .toThrow(/only the drain may merge to main \(route pr-land is not the drain\)/);
    expect(calls).toHaveLength(0); // never shelled a merge
  });

  it('caller "lane-resume" THROWS (no merge)', () => {
    const { exec, calls } = fakeExec();
    expect(() => mergePr({ pr: 9, caller: 'lane-resume', exec, env: {} })).toThrow(/only the drain may merge to main/);
    expect(calls).toHaveLength(0);
  });

  it('WE_MERGE_BREAK_GLASS=1 lets a non-drain caller PROCEED and emits the loud audit line', () => {
    const { exec, calls } = fakeExec();
    const { log, lines } = fakeLog();
    const r = mergePr({ pr: 42, repo: 'plateauapp/plateau-app', caller: 'pr-land', exec, env: { WE_MERGE_BREAK_GLASS: '1' }, log });
    expect(calls).toHaveLength(1); // the merge WAS shelled under break-glass
    expect(calls[0].args).toContain('--repo');
    expect(lines.join('')).toMatch(/BREAK-GLASS merge by route=pr-land pr=42 repo=plateauapp\/plateau-app — off the normal path/);
    expect(r).toEqual({ ok: true });
  });
});

describe('pr-merge-gate — hasNonEmptyBody (#2324 shared by pr-land.mjs + merge-ai-prs.mjs)', () => {
  it('rejects null/undefined/non-string, empty, and whitespace-only bodies', () => {
    expect(hasNonEmptyBody(null)).toBe(false);
    expect(hasNonEmptyBody(undefined)).toBe(false);
    expect(hasNonEmptyBody(42)).toBe(false);
    expect(hasNonEmptyBody('')).toBe(false);
    expect(hasNonEmptyBody('   \n\t  ')).toBe(false);
  });
  it('accepts a real description', () => {
    expect(hasNonEmptyBody('fixes the thing because reasons')).toBe(true);
    expect(hasNonEmptyBody('  padded but real  ')).toBe(true);
  });
});

describe('pr-merge-gate — isTestPath (#2440 anti-test-gaming)', () => {
  it('recognises __tests__/ members and *.test/spec.* modules across js/ts/jsx/mjs', () => {
    expect(isTestPath('scripts/__tests__/foo.test.mjs')).toBe(true);
    expect(isTestPath('src/components/Button.spec.ts')).toBe(true);
    expect(isTestPath('a/b/thing.test.jsx')).toBe(true);
    expect(isTestPath('pkg/__tests__/nested/deep.mjs')).toBe(true);
  });
  it('does NOT flag ordinary source, docs, or a file merely named "test" in a segment', () => {
    expect(isTestPath('scripts/lib/pr-merge-gate.mjs')).toBe(false);
    expect(isTestPath('docs/agent/backlog-workflow.md')).toBe(false);
    expect(isTestPath('scripts/test-helpers/util.mjs')).toBe(false); // a dir named test-helpers is not __tests__
  });
});

describe('pr-merge-gate — parseUnifiedDiff (#2440)', () => {
  it('buckets +/- content lines per file and flags a deletion, skipping headers/hunk markers', () => {
    const diff = [
      'diff --git a/scripts/__tests__/x.test.mjs b/scripts/__tests__/x.test.mjs',
      'index 111..222 100644',
      '--- a/scripts/__tests__/x.test.mjs',
      '+++ b/scripts/__tests__/x.test.mjs',
      '@@ -1,3 +1,3 @@',
      '-old line',
      '+new line',
      ' context',
      'diff --git a/scripts/__tests__/gone.test.mjs b/scripts/__tests__/gone.test.mjs',
      'deleted file mode 100644',
      '--- a/scripts/__tests__/gone.test.mjs',
      '+++ /dev/null',
      '-was here',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('scripts/__tests__/x.test.mjs');
    expect(files[0].added).toEqual(['new line']);
    expect(files[0].removed).toEqual(['old line']);
    expect(files[0].deleted).toBe(false);
    expect(files[1].deleted).toBe(true);
    // the `+++ /dev/null` and `---` file headers are NOT counted as content
    expect(files[1].added).toEqual([]);
  });
  it('is empty for an empty/blank diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff(null)).toEqual([]);
  });
});

describe('pr-merge-gate — scanTestTampering (#2440 the deterministic gate)', () => {
  it('a clean diff that only ADDS a test is not tampering', () => {
    const diff = [
      'diff --git a/scripts/__tests__/x.test.mjs b/scripts/__tests__/x.test.mjs',
      '@@',
      "+  it('covers the new case', () => { expect(f()).toBe(1); });",
    ].join('\n');
    expect(scanTestTampering({ diffText: diff }).tampered).toBe(false);
  });
  it('flags a DELETED test file', () => {
    const diff = [
      'diff --git a/scripts/__tests__/gone.test.mjs b/scripts/__tests__/gone.test.mjs',
      'deleted file mode 100644',
      "-  it('was covering the bug', () => {});",
    ].join('\n');
    const r = scanTestTampering({ diffText: diff });
    expect(r.tampered).toBe(true);
    expect(r.findings[0].kind).toBe('test-file-removed');
  });
  it('flags an ADDED .skip / .only marker in a test file', () => {
    const skip = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  it.skip(\'flaky\', () => {});';
    const only = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  describe.only(\'just this\', () => {});';
    expect(scanTestTampering({ diffText: skip }).findings[0].kind).toBe('test-skipped');
    expect(scanTestTampering({ diffText: only }).findings[0].kind).toBe('test-skipped');
  });
  it('does NOT false-positive on ordinary identifiers that merely contain fit/skip/context (regression)', () => {
    // A PR that ADDS coverage to a test file, using everyday names — `const fit = fitAffineCost(...)`,
    // `model.fit(...)`, an `object-fit` string, a variable named `context` — must NOT read as a skip/only.
    const diff = [
      'diff --git a/scripts/__tests__/capacity.test.mjs b/scripts/__tests__/capacity.test.mjs',
      '@@',
      "+  it('fits the affine cost', () => {",
      '+    const fit = fitAffineCost(samples);',
      '+    model.fit(rows);',
      "+    const context = { style: 'object-fit: cover' };",
      '+    expect(fit).toBeGreaterThan(0);',
      '+  });',
    ].join('\n');
    expect(scanTestTampering({ diffText: diff }).tampered).toBe(false);
  });
  it('flags a bare xit(/fit( invocation but not a dotted .fit( method call', () => {
    const bare = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  fit(\'only me\', () => {});';
    const method = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  chart.fit(data);';
    expect(scanTestTampering({ diffText: bare }).findings[0].kind).toBe('test-skipped');
    expect(scanTestTampering({ diffText: method }).tampered).toBe(false);
  });
  it('catches an ADDED .skip.each / .only.each parameterized marker (#2669 — old \\( -only anchor let it bypass)', () => {
    const skipEach = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  it.skip.each([[1], [2]])(\'flaky %s\', () => {});';
    const onlyEach = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  test.only.each([[1]])(\'just this\', () => {});';
    const onlyEachTpl = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  describe.only.each`a | b`(\'tpl\', () => {});';
    expect(scanTestTampering({ diffText: skipEach }).findings[0].kind).toBe('test-skipped');
    expect(scanTestTampering({ diffText: onlyEach }).findings[0].kind).toBe('test-skipped');
    expect(scanTestTampering({ diffText: onlyEachTpl }).findings[0].kind).toBe('test-skipped');
  });
  it('catches a line-wrapped .skip whose ( wrapped to the next line (#2669 — diff scans per-line)', () => {
    // A prettier-wrapped `it.skip(\n  'name', …)` leaves `it.skip` alone on the added line; the old
    // `(`-must-follow anchor missed it. `it.skip` at end-of-line now reads as the skip it is.
    const wrapped = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  it.skip';
    expect(scanTestTampering({ diffText: wrapped }).findings[0].kind).toBe('test-skipped');
  });
  it('does NOT false-positive on a `.skip`-prefixed identifier or non-test dotted call (#2669 regression)', () => {
    // The widened skip/only tail (`.each` | `(` | EOL) must not read `obj.skipList(` or a `.only` chained
    // off a non-test callee as a skip marker.
    const diff = [
      'diff --git a/scripts/__tests__/x.test.mjs b/scripts/__tests__/x.test.mjs',
      '@@',
      "+  it('adds real coverage', () => {",
      '+    const rows = query.skipList(3);',
      '+    const first = list.only;',
      '+    expect(rows.length).toBe(first);',
      '+  });',
    ].join('\n');
    expect(scanTestTampering({ diffText: diff }).tampered).toBe(false);
  });
  it('does NOT count a .test(\'literal\') assertion as a test-case opener (#2669 — false-positive removal)', () => {
    // Consolidating inline `RE.test('sample')` assertions in a *.test.mjs file is a legitimate refactor that
    // nets a removal of `.test('…')` method calls. The old opener regex counted those as removed `it(`/`test(`
    // cases and mis-parked the couple review:human. The `.test('…')` method-call form must not count.
    const diff = [
      'diff --git a/scripts/__tests__/regex.test.mjs b/scripts/__tests__/regex.test.mjs',
      '@@',
      "-    expect(RE.test('alpha')).toBe(true);",
      "-    expect(RE.test('beta')).toBe(true);",
      "-    expect(RE.test('gamma')).toBe(false);",
      "+    for (const [s, want] of cases) expect(RE.test(s)).toBe(want);",
    ].join('\n');
    expect(scanTestTampering({ diffText: diff }).tampered).toBe(false);
  });
  it('still counts genuine it(\'…\')/test(\'…\') openers after excluding the .test() method form (#2669)', () => {
    // The exclusion must be surgical: a real removed `it('…')` / `test('…')` opener still counts, even amid
    // `.test('…')` assertions on the same removed lines.
    const diff = [
      'diff --git a/scripts/__tests__/x.test.mjs b/scripts/__tests__/x.test.mjs',
      '@@',
      "-  it('case one', () => { expect(RE.test('a')).toBe(true); });",
      "-  test('case two', () => { expect(RE.test('b')).toBe(false); });",
      "+  it('merged', () => {});",
    ].join('\n');
    const r = scanTestTampering({ diffText: diff });
    expect(r.tampered).toBe(true);
    expect(r.findings.some((f) => f.kind === 'tests-removed')).toBe(true);
  });
  it('keeps common non-skip lines clean despite the widened end-of-line tail (#2669 residual boundary)', () => {
    // The `$` tail catches a line-wrapped bare `it.skip`, so its false-positive surface is a line ENDING
    // exactly at `.skip`/`.only`. The common terminated reference and any mid-line string stay clean — the
    // safe-direction residual (over-park at most, never a missed tamper) documented in the spec.
    const terminatedRef = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  const focused = test.only;';
    const midLineString = 'diff --git a/x.test.mjs b/x.test.mjs\n@@\n+  const note = \'todo: drop the it.skip before merge\';';
    expect(scanTestTampering({ diffText: terminatedRef }).tampered).toBe(false);
    expect(scanTestTampering({ diffText: midLineString }).tampered).toBe(false);
  });
  it('flags NET removal of test cases (removed openers exceed added)', () => {
    const diff = [
      'diff --git a/scripts/__tests__/x.test.mjs b/scripts/__tests__/x.test.mjs',
      '@@',
      "-  it('case one', () => {});",
      "-  it('case two', () => {});",
      "+  it('merged case', () => {});",
    ].join('\n');
    const r = scanTestTampering({ diffText: diff });
    expect(r.tampered).toBe(true);
    expect(r.findings.some((f) => f.kind === 'tests-removed')).toBe(true);
  });
  it('does NOT flag test-case churn that nets neutral or positive (refactor/rename)', () => {
    const diff = [
      'diff --git a/scripts/__tests__/x.test.mjs b/scripts/__tests__/x.test.mjs',
      '@@',
      "-  it('old name', () => { expect(g()).toBe(2); });",
      "+  it('renamed', () => { expect(g()).toBe(2); });",
      "+  it('extra coverage', () => {});",
    ].join('\n');
    expect(scanTestTampering({ diffText: diff }).tampered).toBe(false);
  });
  it('ignores removals in NON-test files (deleting product code is not test-gaming)', () => {
    const diff = [
      'diff --git a/scripts/lib/thing.mjs b/scripts/lib/thing.mjs',
      '@@',
      "-  it('this is not a real test file', () => {});",
      'deleted file mode 100644',
    ].join('\n');
    // `deleted file mode` here attaches to the same non-test file → still not flagged.
    expect(scanTestTampering({ diffText: diff }).tampered).toBe(false);
  });
});

describe('pr-merge-gate — describeStackedTestGamingOrigin (#2766/#2767 stacked-base attribution)', () => {
  // #2767's actual live shape: it is opened on top of #2766's own branch; #2766 legitimately rewrites its
  // "property 4" tests; #2767 inherits that same diff (it is stacked), so scanTestTampering trips the
  // IDENTICAL tests-removed finding on #2767's own net diff too.
  const findings = [{ path: 'scripts/operations/__tests__/review-loop-cli.test.mjs', kind: 'tests-removed', detail: 'net 2 test case(s) removed' }];

  it('names the base when it is stacked-and-already-escalated and the finding path is one of its own files', () => {
    const r = describeStackedTestGamingOrigin({
      findings,
      baseFiles: ['scripts/operations/__tests__/review-loop-cli.test.mjs', 'scripts/operations/review-loop-cli.mjs'],
      baseAlreadyEscalated: true,
    });
    expect(r).toEqual({ sharedPaths: ['scripts/operations/__tests__/review-loop-cli.test.mjs'] });
  });

  it('returns null when there is no stacked base at all (baseFiles unknown)', () => {
    expect(describeStackedTestGamingOrigin({ findings, baseAlreadyEscalated: true })).toBe(null);
    expect(describeStackedTestGamingOrigin({ findings, baseFiles: null, baseAlreadyEscalated: true })).toBe(null);
  });

  it('returns null when the base is NOT already escalated — never attribute to an unparked sibling', () => {
    expect(describeStackedTestGamingOrigin({
      findings, baseFiles: ['scripts/operations/__tests__/review-loop-cli.test.mjs'], baseAlreadyEscalated: false,
    })).toBe(null);
  });

  it('returns null when the finding is on a file the base never touched — a genuinely NEW finding', () => {
    expect(describeStackedTestGamingOrigin({
      findings: [{ path: 'scripts/only-in-this-pr.test.mjs', kind: 'tests-removed', detail: 'net 1 test case(s) removed' }],
      baseFiles: ['scripts/operations/__tests__/review-loop-cli.test.mjs'],
      baseAlreadyEscalated: true,
    })).toBe(null);
  });
});

describe('pr-merge-gate — assertMayMerge (the no-gh write-to-main guard, e.g. fallback-git)', () => {
  it('drain passes silently (no audit line)', () => {
    const { log, lines } = fakeLog();
    expect(assertMayMerge({ caller: 'drain', env: {}, log })).toEqual({ breakGlass: false });
    expect(lines).toHaveLength(0);
  });
  it('a non-drain route throws without break-glass', () => {
    expect(() => assertMayMerge({ caller: 'pr-land', env: {} })).toThrow(/only the drain may merge to main/);
  });
  it('break-glass lets it through and audits', () => {
    const { log, lines } = fakeLog();
    const r = assertMayMerge({ caller: 'pr-land', pr: null, repo: null, env: { WE_MERGE_BREAK_GLASS: '1' }, log });
    expect(r).toEqual({ breakGlass: true });
    expect(lines.join('')).toMatch(/BREAK-GLASS merge by route=pr-land pr=null repo=cwd/);
  });
});

describe('pr-merge-gate — retargetStackedPrs (#3383, the #2578 incident)', () => {
  it('buildStackedPrListArgs scopes the listing to --base <headRef> — never a full-repo fan-out', () => {
    expect(buildStackedPrListArgs({ headRef: 'lane/3681-ratify-daemon-lifecycle' }))
      .toEqual(['pr', 'list', '--state', 'open', '--base', 'lane/3681-ratify-daemon-lifecycle', '--json', 'number,baseRefName']);
    expect(buildStackedPrListArgs({ repo: 'frontier-ui/frontierui', headRef: 'lane/x' }))
      .toEqual(['pr', 'list', '--state', 'open', '--base', 'lane/x', '--repo', 'frontier-ui/frontierui', '--json', 'number,baseRefName']);
  });

  it('buildRetargetArgs builds `pr edit <n> --base <default>`', () => {
    expect(buildRetargetArgs({ pr: 2578, base: 'main' })).toEqual(['pr', 'edit', '2578', '--base', 'main']);
    expect(buildRetargetArgs({ pr: 9, repo: 'plateauapp/plateau-app', base: 'main' }))
      .toEqual(['pr', 'edit', '9', '--repo', 'plateauapp/plateau-app', '--base', 'main']);
  });

  it('retargets every PR the listing names, onto the default branch, BEFORE any merge/delete happens', () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 2578, baseRefName: 'lane/3681' }, { number: 2601, baseRefName: 'lane/3681' }]);
      return '';
    };
    const retargeted = [];
    const r = retargetStackedPrs({ headRef: 'lane/3681', defaultBranch: 'main', exec, onRetarget: (n) => retargeted.push(n) });
    expect(r).toEqual({ retargeted: [2578, 2601], failed: [] });
    expect(retargeted).toEqual([2578, 2601]);
    // The listing call comes first, then one `pr edit --base main` per stacked PR found.
    expect(calls[0].args).toEqual(['pr', 'list', '--state', 'open', '--base', 'lane/3681', '--json', 'number,baseRefName']);
    expect(calls[1].args).toEqual(['pr', 'edit', '2578', '--base', 'main']);
    expect(calls[2].args).toEqual(['pr', 'edit', '2601', '--base', 'main']);
  });

  it('is a no-op when nothing is stacked on the branch (the common case)', () => {
    const exec = (cmd, args) => (args[1] === 'list' ? '[]' : '');
    expect(retargetStackedPrs({ headRef: 'lane/solo', defaultBranch: 'main', exec })).toEqual({ retargeted: [], failed: [] });
  });

  it('a listing failure never throws — best-effort, never blocks the merge that is about to happen', () => {
    const exec = () => { throw new Error('gh: rate limited'); };
    expect(() => retargetStackedPrs({ headRef: 'lane/x', defaultBranch: 'main', exec })).not.toThrow();
    expect(retargetStackedPrs({ headRef: 'lane/x', defaultBranch: 'main', exec })).toEqual({ retargeted: [], failed: [] });
  });

  it('one failed retarget is reported but does not stop the others — best-effort per PR', () => {
    const exec = (cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 1 }, { number: 2 }, { number: 3 }]);
      if (args[1] === 'edit' && args[2] === '2') throw new Error('gh: 422 already closed');
      return '';
    };
    const failed = [];
    const r = retargetStackedPrs({ headRef: 'lane/x', defaultBranch: 'main', exec, onFailed: (n) => failed.push(n) });
    expect(r).toEqual({ retargeted: [1, 3], failed: [2] });
    expect(failed).toEqual([2]);
  });
});
