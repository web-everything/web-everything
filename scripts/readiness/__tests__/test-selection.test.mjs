/**
 * @file scripts/readiness/__tests__/test-selection.test.mjs
 * @description Unit proof of diff-driven test selection (WE #2681). Pins the design jury's four properties and the
 *   three round-2 sharpenings AS invariants: select-off-the-diff, deny-by-default shrink allow-list (evaluated on
 *   the ACTUAL changed set), glob-edge guard, pinned merge-base, and the false-green shadow compare. The
 *   Definition-of-Done invariant — "no configuration where a diff touching a gate/statute/hook/dependency path
 *   shrinks" — is the load-bearing block below (`DoD invariant`).
 */
import { describe, it, expect } from 'vitest';
import {
  SELECTION_FLAG,
  selectionFlagEnabled,
  EXTRA_DENY,
  isSensitivePath,
  SHRINK_ALLOW_LIST,
  isShrinkablePath,
  GLOB_FIXTURE_ROOTS,
  hitsGlobEdge,
  decideSelection,
  pinnedMergeBase,
  changedFilesSince,
  selectTests,
  assessFalseGreen,
} from '../test-selection.mjs';

describe('the flag — NOT defaulted (DoD)', () => {
  it('is off unless the env var is exactly "1"', () => {
    expect(selectionFlagEnabled({})).toBe(false);
    expect(selectionFlagEnabled({ [SELECTION_FLAG]: 'true' })).toBe(false);
    expect(selectionFlagEnabled({ [SELECTION_FLAG]: '0' })).toBe(false);
    expect(selectionFlagEnabled({ [SELECTION_FLAG]: '1' })).toBe(true);
  });
  it('flag off ⇒ decideSelection is always full, even for a pure-doc diff', () => {
    const d = decideSelection({ changedFiles: ['docs/readme.md'], flagEnabled: false });
    expect(d.mode).toBe('full');
  });
});

describe('isSensitivePath — the DENY surface (property 2), composing the ratified predicates', () => {
  it('denies the ratified blast-radius / statute / gate-self surfaces', () => {
    expect(isSensitivePath('scripts/merge-ai-prs.mjs')).toBe(true);           // blast-radius scripts/
    expect(isSensitivePath('.github/workflows/ci.yml')).toBe(true);           // CI
    expect(isSensitivePath('.githooks/pre-commit')).toBe(true);               // hooks
    expect(isSensitivePath('docs/agent/platform-decisions.md')).toBe(true);   // statute
    expect(isSensitivePath('.claude/skills/foo/skill.md')).toBe(true);        // skills
    expect(isSensitivePath('src/_data/blocks.json')).toBe(true);              // standard defs
  });
  it('denies the EXTRA supply-chain / config / full-.claude / check-* surfaces (#2681 additions)', () => {
    expect(isSensitivePath('package.json')).toBe(true);
    expect(isSensitivePath('package-lock.json')).toBe(true);
    expect(isSensitivePath('vitest.config.ts')).toBe(true);
    expect(isSensitivePath('playwright.config.mjs')).toBe(true);
    expect(isSensitivePath('.claude/settings.json')).toBe(true);              // full .claude, not just skills
    expect(isSensitivePath('.claude/hooks/guard.mjs')).toBe(true);
    expect(isSensitivePath('scripts/check-standards-rules.mjs')).toBe(true);
  });
  it('treats an empty/unknown path as sensitive (safe direction)', () => {
    expect(isSensitivePath('')).toBe(true);
    expect(isSensitivePath(null)).toBe(true);
  });
  it('does NOT deny an ordinary leaf doc / research file', () => {
    expect(isSensitivePath('docs/guide.md')).toBe(false);
    expect(isSensitivePath('research/topic.md')).toBe(false);
  });
});

describe('isShrinkablePath — deny-by-default (property 2)', () => {
  it('is true ONLY for allow-listed AND non-sensitive paths', () => {
    expect(isShrinkablePath('docs/guide.md')).toBe(true);
    expect(isShrinkablePath('research/x.md')).toBe(true);
    expect(isShrinkablePath('blocks/foo/__tests__/foo.test.ts')).toBe(true); // a test file, non-sensitive
  });
  it('is false for anything NOT on the allow-list (deny-by-default) — a new surface is safe', () => {
    expect(isShrinkablePath('src/components/thing.ts')).toBe(false);
    expect(isShrinkablePath('some/brand/new/surface.ts')).toBe(false);
    expect(isShrinkablePath('')).toBe(false);
  });
  it('sensitive always wins even when a broad allow-list rule would match (a test under scripts/)', () => {
    // scripts/**/__tests__ matches the allow-list rule, but scripts/ is sensitive → NOT shrinkable.
    expect(isShrinkablePath('scripts/__tests__/foo.test.mjs')).toBe(false);
    expect(isSensitivePath('scripts/__tests__/foo.test.mjs')).toBe(true);
  });
});

describe('hitsGlobEdge — the static-graph blind spot (round-2)', () => {
  it('flags a path under a glob-discovered fixture root', () => {
    for (const root of GLOB_FIXTURE_ROOTS) {
      expect(hitsGlobEdge(`${root}anything.json`)).toBe(true);
    }
    expect(hitsGlobEdge('backlog/2681-x.md')).toBe(true);
    expect(hitsGlobEdge('src/_data/intents/foo.json')).toBe(true);
  });
  it('does not flag an unrelated leaf path', () => {
    expect(hitsGlobEdge('docs/guide.md')).toBe(false);
    expect(hitsGlobEdge('research/x.md')).toBe(false);
  });
});

describe('decideSelection — the core rule (properties 1 + 2 + glob-edge)', () => {
  const flagEnabled = true;

  it('an all-allow-listed diff shrinks and selects the changed files', () => {
    const d = decideSelection({ changedFiles: ['docs/a.md', 'research/b.md'], flagEnabled });
    expect(d.mode).toBe('shrink');
    expect(d.humanRequired).toBe(false);
    expect(d.selectedFiles).toEqual(['docs/a.md', 'research/b.md']);
  });

  it('ANY sensitive file forces full + humanRequired (on the actual diff)', () => {
    const d = decideSelection({ changedFiles: ['docs/a.md', 'package-lock.json'], flagEnabled });
    expect(d.mode).toBe('full');
    expect(d.humanRequired).toBe(true);
    expect(d.sensitiveFiles).toContain('package-lock.json');
  });

  it('a glob-edge file forces full but NOT humanRequired (soundness, not sensitivity)', () => {
    const d = decideSelection({ changedFiles: ['backlog/2681-x.md'], flagEnabled });
    expect(d.mode).toBe('full');
    expect(d.humanRequired).toBe(false);
    expect(d.globEdgeFiles).toContain('backlog/2681-x.md');
  });

  it('an unlisted (not sensitive, not glob) file forces full by deny-by-default, NOT humanRequired', () => {
    const d = decideSelection({ changedFiles: ['src/components/new-thing.ts'], flagEnabled });
    expect(d.mode).toBe('full');
    expect(d.humanRequired).toBe(false);
    expect(d.unlistedFiles).toContain('src/components/new-thing.ts');
  });

  it('empty changed set ⇒ full (no sound selection basis)', () => {
    expect(decideSelection({ changedFiles: [], flagEnabled }).mode).toBe('full');
  });

  it('DoD invariant — NO diff touching a gate/statute/hook/dependency path ever shrinks', () => {
    const sensitiveEach = [
      'scripts/pr-land.mjs',
      'scripts/lib/review-escalation.mjs',
      'docs/agent/platform-decisions.md',
      '.github/workflows/ci.yml',
      '.githooks/pre-push',
      '.claude/settings.json',
      'package.json',
      'package-lock.json',
      'vitest.config.ts',
      'src/_data/plugs.json',
    ];
    for (const p of sensitiveEach) {
      // even mixed in with otherwise-shrinkable files, the presence of one sensitive path forces full + human
      const d = decideSelection({ changedFiles: ['docs/ok.md', p], flagEnabled });
      expect(d.mode, `${p} must force full`).toBe('full');
      expect(d.humanRequired, `${p} must force review:human`).toBe(true);
    }
  });
});

describe('changedFilesSince — pinned merge-base (round-2), injectable git', () => {
  it('pins the merge-base then diffs base..HEAD', () => {
    const calls = [];
    const runGit = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'merge-base') return 'abc123\n';
      if (args[0] === 'diff') return 'docs/a.md\nresearch/b.md\ndocs/a.md\n'; // dup to prove de-dup
      return '';
    };
    const files = changedFilesSince({ runGit });
    expect(calls[0]).toBe('merge-base origin/main HEAD');
    expect(calls[1]).toBe('diff --name-only abc123 HEAD'); // the PINNED sha, not the branch tip
    expect(files).toEqual(['docs/a.md', 'research/b.md']); // de-duped + sorted
  });

  it('returns null (⇒ caller treats as FULL) when the merge-base cannot be computed', () => {
    const runGit = () => { throw new Error('no merge base'); };
    expect(pinnedMergeBase({ runGit })).toBeNull();
    expect(changedFilesSince({ runGit })).toBeNull();
  });
});

describe('selectTests — end to end, never shrink on an unknown diff', () => {
  it('a git failure ⇒ full (changedFiles null)', () => {
    const runGit = () => { throw new Error('boom'); };
    const r = selectTests({ runGit, env: { [SELECTION_FLAG]: '1' } });
    expect(r.changedFiles).toBeNull();
    expect(r.mode).toBe('full');
  });
  it('flag off ⇒ full even with a clean shrinkable diff', () => {
    const runGit = (args) => (args[0] === 'merge-base' ? 'sha' : 'docs/a.md');
    const r = selectTests({ runGit, env: {} });
    expect(r.mode).toBe('full');
  });
  it('flag on + shrinkable diff ⇒ shrink', () => {
    const runGit = (args) => (args[0] === 'merge-base' ? 'sha' : 'docs/a.md\n');
    const r = selectTests({ runGit, env: { [SELECTION_FLAG]: '1' } });
    expect(r.mode).toBe('shrink');
    expect(r.selectedFiles).toEqual(['docs/a.md']);
  });
});

describe('assessFalseGreen — the shadow full-suite compare (round-2)', () => {
  it('a full-suite failure OUTSIDE the selected set is a false-green', () => {
    const r = assessFalseGreen({
      failedTestFiles: ['blocks/x/__tests__/x.test.ts', 'src/other/y.test.ts'],
      selectedTestFiles: ['blocks/x/__tests__/x.test.ts'],
      mode: 'shrink',
    });
    expect(r.falseGreen).toBe(true);
    expect(r.escaped).toEqual(['src/other/y.test.ts']);
  });
  it('a failure INSIDE the selected set is NOT a false-green', () => {
    const r = assessFalseGreen({
      failedTestFiles: ['blocks/x/__tests__/x.test.ts'],
      selectedTestFiles: ['blocks/x/__tests__/x.test.ts', 'other.test.ts'],
      mode: 'shrink',
    });
    expect(r.falseGreen).toBe(false);
    expect(r.escaped).toEqual([]);
  });
  it('a FULL decision can never false-green (selection ≡ full)', () => {
    const r = assessFalseGreen({ failedTestFiles: ['anything.test.ts'], selectedTestFiles: [], mode: 'full' });
    expect(r.falseGreen).toBe(false);
  });
  it('normalizes ./ prefixes when comparing', () => {
    const r = assessFalseGreen({
      failedTestFiles: ['./a.test.ts'],
      selectedTestFiles: ['a.test.ts'],
      mode: 'shrink',
    });
    expect(r.falseGreen).toBe(false);
  });
});

describe('exported shapes are stable / documented', () => {
  it('EXTRA_DENY, SHRINK_ALLOW_LIST, GLOB_FIXTURE_ROOTS are non-empty', () => {
    expect(EXTRA_DENY.length).toBeGreaterThan(0);
    expect(SHRINK_ALLOW_LIST.length).toBeGreaterThan(0);
    expect(GLOB_FIXTURE_ROOTS.length).toBeGreaterThan(0);
  });
});


describe('S1b throwing shadow fallback', () => {
  it('records full shadow on failure while preserving the real shrink decision', () => {
    const options = { runGit: (args) => args[0] === 'merge-base' ? 'abc' : 'docs/readme.md\n', env: { [SELECTION_FLAG]: '1' } };
    const off = selectTests(options);
    const { shadow, ...on } = selectTests({ ...options, shadow: () => { throw Error('ls-files failed'); } });
    expect(off.mode).toBe('shrink');
    expect(on).toEqual(off);
    expect(shadow).toEqual({ mode: 'full', tests: [], partial: true, reasons: ['shadow threw'] });
  });
});


describe('S1b static reach remains diagnostic', () => {
  it.each(['0', '1'])('preserves the serialized real decision with empty static reach (flag=%s)', (flag) => {
    const options = { runGit: (args) => args[0] === 'merge-base' ? 'abc' : 'docs/readme.md\n', env: { [SELECTION_FLAG]: flag } };
    const off = selectTests(options);
    const { shadow, ...on } = selectTests({ ...options, shadow: () => ({ mode: 'full', tests: ['all.test.mjs'], staticTests: [], partial: false }) });
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(shadow.staticTests).toEqual([]);
  });
});
