/**
 * @file scripts/readiness/__tests__/scope-lease.test.mjs
 * @description Unit proof of the scope-lease + conflict-policy engine (WE epic #2560, slice 1). Pins the §3i
 *   model (predicted module/glob-level vs observed file-level; breach = their coverage difference) and the
 *   §3i-A4 ratified policies: overlap-at-launch ∈ {wait,ask,force}, breach-mid-build ∈ {pause,park,
 *   resolve-at-drain}, and the retry-once-then-escalate ladder keyed on a TOTAL attempt counter.
 */
import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import source from '../scope-lease.mjs?raw';
import {
  normScope, isSubtreeEntry, coversFile, globsMayIntersect, scopeEntriesOverlap, scopesOverlap,
  scopeLease, breachOf,
  overlapAtLaunch, OVERLAP_POLICIES,
  breachOutcome, BREACH_POLICIES, RETRY_BOUND, BREACH_ESCALATION_LADDER, ESCALATION_ROUTES,
  disjoint,
} from '../scope-lease.mjs';

describe('normScope — dedupe + stringify + drop empties', () => {
  it('dedupes and drops falsy', () => {
    expect(normScope(['we:a', 'we:a', '', null, 'we:b'])).toEqual(['we:a', 'we:b']);
  });
  it('non-array → []', () => {
    expect(normScope(undefined)).toEqual([]);
    expect(normScope('we:a')).toEqual([]);
  });
});

describe('isSubtreeEntry — file-vs-subtree granularity classifier (WE #2679)', () => {
  it('a bare directory (no extension on the last segment) is a SUBTREE', () => {
    expect(isSubtreeEntry('we:scripts')).toBe(true);
    expect(isSubtreeEntry('we:src/backlog-view')).toBe(true);
  });
  it('a trailing slash marks a SUBTREE explicitly', () => {
    expect(isSubtreeEntry('we:scripts/lib/')).toBe(true);
  });
  it('a glob is a SUBTREE (spans many files)', () => {
    expect(isSubtreeEntry('we:src/**')).toBe(true);
    expect(isSubtreeEntry('we:src/*.ts')).toBe(true);
    expect(isSubtreeEntry('we:src/a?.ts')).toBe(true);
  });
  it('an extension-bearing path is a FILE (leases only itself)', () => {
    expect(isSubtreeEntry('we:scripts/backlog.mjs')).toBe(false);
    expect(isSubtreeEntry('we:src/list.ts')).toBe(false);
    expect(isSubtreeEntry('we:a/b/c.d.mjs')).toBe(false); // multi-dot → still a file
  });
  it('a dotfile is a FILE, not a subtree', () => {
    expect(isSubtreeEntry('we:.gitignore')).toBe(false);
    expect(isSubtreeEntry('we:scripts/.eslintrc.json')).toBe(false);
  });
  it('repo qualification does not change the classification', () => {
    expect(isSubtreeEntry('frontierui:src/x')).toBe(true);
    expect(isSubtreeEntry('frontierui:src/x.ts')).toBe(false);
    expect(isSubtreeEntry('src/x.ts')).toBe(false); // unqualified ok too
  });
});

describe('coversFile — repo-qualified module/glob coverage', () => {
  it('module prefix covers files UNDER it, and the exact path', () => {
    expect(coversFile('we:src/backlog-view', 'we:src/backlog-view/list.ts')).toBe(true);
    expect(coversFile('we:src/backlog-view', 'we:src/backlog-view')).toBe(true);
    expect(coversFile('we:src/backlog-view/', 'we:src/backlog-view/list.ts')).toBe(true); // trailing slash ok
  });
  it('module prefix does NOT cover a sibling that merely shares a name prefix', () => {
    expect(coversFile('we:src/backlog', 'we:src/backlog-view/list.ts')).toBe(false); // segment boundary
  });
  it('repo must match — a we: lease never covers a frontierui: file', () => {
    expect(coversFile('we:src/x', 'frontierui:src/x/y.ts')).toBe(false);
  });
  it('* matches within a segment, ** crosses segments', () => {
    expect(coversFile('we:src/*.ts', 'we:src/a.ts')).toBe(true);
    expect(coversFile('we:src/*.ts', 'we:src/deep/a.ts')).toBe(false); // * stops at /
    expect(coversFile('we:src/**', 'we:src/deep/a.ts')).toBe(true);
    expect(coversFile('we:src/**/*.ts', 'we:src/a/b/c.ts')).toBe(true);
  });
  it('? matches exactly one non-slash char', () => {
    expect(coversFile('we:src/a?.ts', 'we:src/ab.ts')).toBe(true);
    expect(coversFile('we:src/a?.ts', 'we:src/a/.ts')).toBe(false);
  });
  it('a FILE entry covers ONLY its exact path — never a synthetic subtree beneath it (WE #2679)', () => {
    expect(coversFile('we:scripts/foo.mjs', 'we:scripts/foo.mjs')).toBe(true);
    // the pre-#2679 latent over-match: a file entry no longer "covers" a deeper path under it.
    expect(coversFile('we:scripts/foo.mjs', 'we:scripts/foo.mjs/x')).toBe(false);
    // a file entry does not cover a sibling file in the same directory.
    expect(coversFile('we:scripts/foo.mjs', 'we:scripts/bar.mjs')).toBe(false);
  });
});

describe('scopeEntriesOverlap / scopesOverlap — module-pattern overlap (mirrors intersects)', () => {
  it('same module root or a prefix relation overlaps', () => {
    expect(scopeEntriesOverlap('we:src/foo', 'we:src/foo')).toBe(true);
    expect(scopeEntriesOverlap('we:src/foo', 'we:src/foo/bar.ts')).toBe(true);
    expect(scopeEntriesOverlap('we:src/foo/**', 'we:src/foo/bar/*.ts')).toBe(true); // literal roots overlap
  });
  it('disjoint module roots do NOT overlap; a shared name prefix at no boundary does not', () => {
    expect(scopeEntriesOverlap('we:src/foo', 'we:src/bar')).toBe(false);
    expect(scopeEntriesOverlap('we:src/foo', 'we:src/foobar')).toBe(false);
  });
  it('different repos never overlap', () => {
    expect(scopeEntriesOverlap('we:src/x', 'frontierui:src/x')).toBe(false);
  });
  it('scopesOverlap = any-pair overlap over two scope lists', () => {
    expect(scopesOverlap(['we:a', 'we:b'], ['we:c', 'we:b/x.ts'])).toBe(true);
    expect(scopesOverlap(['we:a', 'we:b'], ['we:c', 'we:d'])).toBe(false);
    expect(scopesOverlap([], ['we:a'])).toBe(false);
  });
});

describe('glob intersection — conservative scope contention', () => {
  it('single stars cannot cross path segments', () => {
    expect(globsMayIntersect('src/*.mjs', 'src/x/*.mjs')).toBe(false);
  });
  it('question marks consume exactly one character', () => {
    expect(globsMayIntersect('src/a?b.mjs', 'src/ac*.mjs')).toBe(true);
    expect(globsMayIntersect('src/a?b.mjs', 'src/ab.mjs')).toBe(false);
    expect(globsMayIntersect('src/a?b.mjs', 'src/a/x/b.mjs')).toBe(false);
  });
  it('globstars match zero or many segments on either side', () => {
    expect(globsMayIntersect('src/**/a*b.mjs', 'src/ab*.mjs')).toBe(true);
    expect(globsMayIntersect('src/ab*.mjs', 'src/**/a*b.mjs')).toBe(true);
    expect(globsMayIntersect('src/**/a*b.mjs', 'src/x/y/ab*.mjs')).toBe(true);
    expect(globsMayIntersect('src/**/a.mjs', 'other/**/a.mjs')).toBe(false);
  });
  it('bare and trailing-slash directory entries cover descendants of globbed parents', () => {
    expect(globsMayIntersect('src/ab', 'src/a*/child.mjs')).toBe(true);
    expect(globsMayIntersect('src/ab.v2/', 'src/a*/child.mjs')).toBe(true);
    expect(globsMayIntersect('src/ab.mjs', 'src/a*/child.mjs')).toBe(false);
  });
  it.each([
    ['src/*/lib/', 'src/a/lib/*.mjs'],
    ['src/*/', 'src/x/y/*.mjs'],
    ['src/*/', 'src/ab/x/*.mjs'],
    ['src/a*/', 'src/a*/child.mjs'],
    ['src/*.v2/', 'src/ab.v2/x/*.mjs'],
    ['src/*.v2', 'src/ab.v2/x/*.mjs'],
    ['src/a?.v2', 'src/ab.v2/x/*.mjs'],
    ['src/*.d', 'src/a.d/*.mjs'],
    ['.git*', '.github/*.yml'],
    ['packages/*/foo.v2', 'packages/x/foo.v2/*.mjs'],
    ['packages/*/v1.2', 'packages/a/v1.2/deep/*.mjs'],
    ['src/*.mjs', 'src/a.mjs/child/*.mjs'],
    ['*/lib/', 'src/lib/*.mjs'],
    ['packages/*/src/', 'packages/app/src/deep/*.mjs'],
    ['src/*/lib', 'src/a/lib/deep/*.mjs'],
    ['src/a*', 'src/ab/deep/*.mjs'],
    ['src/a?', 'src/ab/deep/*.mjs'],
    ['src/a?/', 'src/ab/deep/*.mjs'],
    ['src/*/lib/', 'src/a/lib/deep/file.mjs'],
  ])('glob directory %s contends with descendant %s in both orders', (directory, descendant) => {
    expect(globsMayIntersect(directory, descendant)).toBe(true);
    expect(globsMayIntersect(descendant, directory)).toBe(true);
    expect(scopeEntriesOverlap(`we:${directory}`, `we:${descendant}`)).toBe(true);
    expect(scopeEntriesOverlap(`we:${descendant}`, `we:${directory}`)).toBe(true);
  });
  it('checks every pairing of file, bare dir, trailing-slash dir, glob and glob-dir entries', () => {
    const entries = ['src/ab/a.mjs', 'src/ab', 'src/ab/', 'src/*/*.mjs', 'src/a*/'];
    // Every entry contains the concrete witness src/ab/a.mjs, so none is provably disjoint.
    for (const a of entries) for (const b of entries) {
      expect(scopeEntriesOverlap(`we:${a}`, `we:${b}`), `${a} vs ${b}`).toBe(true);
      expect(scopeEntriesOverlap(`we:${a}`, `other:${b}`), `${a} vs other:${b}`).toBe(false);
    }
  });
  it('preserves every generated old ancestor relation unless an explicit disjointness proof exists', () => {
    const oldRoot = (entry) => entry.match(/^[^*?]*/)[0].replace(/\/$/, '');
    const oldRelated = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || !a || !b;
    let checked = 0;
    // Construct entries from concrete paths, rather than using the new matcher as the oracle.
    for (const root of ['src', 'packages', 'packages/app']) for (const name of ['a', 'ab', 'ab.v2', 'foo.v2', 'a.d', 'v1.2', 'a.mjs', '.github']) {
      for (const depth of ['', '/lib', '/lib/deep']) {
        const file = `${root}/${name}${depth}/a.mjs`;
        const parents = [`${root}/${name}/`, `${root}/*/`, `${root}/${name[0]}*/`, `${root}/a?/`, `${root}/*`,
          `${root}/${name[0]}*`, `${root}/*.v2`, `${root}/*.d`, `${root}/*.mjs`];
        if (root === 'packages/app') parents.push(`packages/*/${name}`);
        const entries = [file, `${root}/${name}${depth}/*.mjs`, `${root}/*${depth}/*.mjs`];
        for (const parent of parents) for (const entry of entries) {
          if (!oldRelated(oldRoot(parent), oldRoot(entry))) continue;
          // For two globs, a concrete directory name can prove these parents disjoint. A wildcard
          // directory can choose another name satisfying the parent's length or suffix constraint.
          // Literal file entries retain the old ancestor fallback even when the glob cannot match.
          const fixedName = !entry.startsWith(`${root}/*`);
          const disjoint = entry.includes('*') && fixedName && (
            (parent === `${root}/a?/` && (name.length !== 2 || !name.startsWith('a')))
            || ['.v2', '.d', '.mjs'].some((suffix) => parent === `${root}/*${suffix}` && !name.endsWith(suffix))
          );
          checked++;
          expect(scopeEntriesOverlap(`we:${parent}`, `we:${entry}`), `${parent} vs ${entry}`).toBe(!disjoint);
          expect(scopeEntriesOverlap(`we:${entry}`, `we:${parent}`), `${entry} vs ${parent}`).toBe(!disjoint);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
  it.each([
    ['src/a*/', 'src/b*/deep/*.mjs'],
    ['src/a?', 'src/abc/deep/*.mjs'],
    ['src/*.v2/', 'src/ab.v3/deep/*.mjs'],
    ['src/*.v2', 'src/ab.v3/deep/*.mjs'],
    ['src/a?.v2', 'src/abc.v2/deep/*.mjs'],
    ['packages/*/foo.v2', 'packages/x/bar.v2/*.mjs'],
    ['.git*', '.hg/*.yml'],
    ['src/*/lib/', 'src/a/other/*.mjs'],
  ])('keeps provably disjoint glob entries separate: %s vs %s', (a, b) => {
    expect(scopeEntriesOverlap(`we:${a}`, `we:${b}`)).toBe(false);
    expect(scopeEntriesOverlap(`we:${b}`, `we:${a}`)).toBe(false);
  });
  it('launch policy waits on a glob directory lease when a candidate edits its descendants', () => {
    const decision = overlapAtLaunch(['we:packages/app/src/deep/*.mjs'], [
      { id: 'directory-owner', scope: ['we:packages/*/src/'] },
    ]);
    expect(decision.outcome).toBe('wait');
    expect(decision.waitOn).toEqual(['directory-owner']);
  });
  it.each(['we:src/*.v2', 'we:packages/*/foo.v2', 'we:.git*'])(
    'launch policy waits on a bare dotted-directory lease %s', (directory) => {
      const descendants = {
        'we:src/*.v2': 'we:src/a.v2/x/*.mjs',
        'we:packages/*/foo.v2': 'we:packages/x/foo.v2/*.mjs',
        'we:.git*': 'we:.github/*.yml',
      };
      for (const [owner, candidate] of [[directory, descendants[directory]], [descendants[directory], directory]]) {
        const decision = overlapAtLaunch([candidate], [{ id: 'directory-owner', scope: [owner] }]);
        expect(decision.outcome).toBe('wait');
        expect(decision.waitOn).toEqual(['directory-owner']);
      }
    },
  );
  it('budget exhaustion conservatively contends for disjoint patterns', () => {
    // The final characters differ, so the exact languages cannot intersect. Their many star
    // placements exhaust the shared state budget before the matcher can establish that fact.
    const a = `src/${'*a'.repeat(160)}b.mjs`;
    const b = `src/${'*a'.repeat(160)}c.mjs`;
    expect(globsMayIntersect(a, b)).toBe(true);
    expect(globsMayIntersect(b, a)).toBe(true);
  });
  it('the disjoint exhaustion regression rejects fail-open and raised-budget mutations', () => {
    // Execute mutants only in memory: never weaken the working source to prove the guard.
    const guard = 'if (--budget.remaining < 0) return true;';
    const bound = 'remaining: 20000';
    expect(source).toContain(guard);
    expect(source).toContain(bound);
    const loadMatcher = (code) => runInNewContext(code
      .replace("import { disjoint } from './lane-partition.mjs';", '')
      .replace(/^export /gm, '') + '\nglobsMayIntersect;', { disjoint });
    const a = `src/${'*a'.repeat(160)}b.mjs`;
    const b = `src/${'*a'.repeat(160)}c.mjs`;
    expect(loadMatcher(source.replace(guard, 'if (--budget.remaining < 0) return false;'))(a, b)).toBe(false);
    expect(loadMatcher(source.replace(bound, 'remaining: 2000000'))(a, b)).toBe(false);
  });
  it('long-star patterns finish within a bounded budget', () => {
    const start = performance.now();
    expect(scopeEntriesOverlap(`we:src/a${'*a'.repeat(200)}*b.mjs`, `we:src/ab${'*a'.repeat(200)}*.mjs`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('oversized patterns conservatively contend instead of exhausting the matcher', () => {
    expect(globsMayIntersect(`src/a${'*a'.repeat(3000)}.mjs`, 'other/b*.mjs')).toBe(true);
  });
  it('unrecognised embedded globstars conservatively contend', () => {
    expect(globsMayIntersect('src/a**b.mjs', 'other/x.mjs')).toBe(true);
  });
  it('finds a common filename even when neither glob matches the other glob text', () => {
    expect(scopeEntriesOverlap('we:src/a*b.mjs', 'we:src/ab*.mjs')).toBe(true);
    expect(scopeEntriesOverlap('we:src/ab*.mjs', 'we:src/a*b.mjs')).toBe(true);
  });
  it('globstar covers nested files and zero intervening segments', () => {
    expect(scopeEntriesOverlap('we:src/**', 'we:src/x/y.mjs')).toBe(true);
    expect(scopeEntriesOverlap('we:src/**/a*b.mjs', 'we:src/ab*.mjs')).toBe(true);
  });
  it('two single-star globs under different depths are disjoint end to end', () => {
    expect(scopeEntriesOverlap('we:src/*.mjs', 'we:src/x/*.mjs')).toBe(false);
  });
  it('keeps literal file equality and inequality unchanged', () => {
    expect(scopeEntriesOverlap('we:src/a.mjs', 'we:src/a.mjs')).toBe(true);
    expect(scopeEntriesOverlap('we:src/a.mjs', 'we:src/b.mjs')).toBe(false);
  });
  it('keeps repository boundaries even for intersecting or unsupported globs', () => {
    expect(scopeEntriesOverlap('we:src/a*b.mjs', 'fui:src/ab*.mjs')).toBe(false);
    expect(scopeEntriesOverlap('we:src/[ab].mjs', 'fui:src/a.mjs')).toBe(false);
  });
  it.each(['[ab]', '{a,b}', '!a', 'a\\b'])('fails closed for unsupported syntax %s', (syntax) => {
    expect(scopeEntriesOverlap(`we:src/${syntax}.mjs`, 'we:other/z.mjs')).toBe(true);
  });
});

describe('file-level lease granularity — narrow scopes lease at FILE granularity (WE #2679)', () => {
  it('two DISJOINT files that merely share a directory do NOT contend (the parallelism win)', () => {
    // The #2673 false positive, narrowed to files: guard-hook work vs the scripts/lib cluster.
    expect(scopeEntriesOverlap('we:scripts/guard-backward-edge.mjs', 'we:scripts/lib/pr-merge-gate.mjs')).toBe(false);
    expect(scopeEntriesOverlap('we:scripts/backlog.mjs', 'we:scripts/lane-pool.mjs')).toBe(false);
    // The console-board cluster, declared at file granularity, runs in parallel.
    expect(scopeEntriesOverlap('plateau-app:src/backlog-view/board.ts', 'plateau-app:src/backlog-view/console.ts')).toBe(false);
    expect(scopesOverlap(['we:scripts/a.mjs', 'we:scripts/b.mjs'], ['we:scripts/c.mjs'])).toBe(false);
  });
  it('a GENUINE same-file dependency still contends (correct overlap preserved) — e.g. #2440↔#2669', () => {
    expect(scopeEntriesOverlap('we:scripts/lib/pr-merge-gate.mjs', 'we:scripts/lib/pr-merge-gate.mjs')).toBe(true);
  });
  it('a FILE contends with a SUBTREE (glob or directory) that COVERS it', () => {
    expect(scopeEntriesOverlap('we:scripts/guard-backward-edge.mjs', 'we:scripts')).toBe(true);        // parent dir
    expect(scopeEntriesOverlap('we:scripts/guard-backward-edge.mjs', 'we:scripts/')).toBe(true);       // trailing slash
    expect(scopeEntriesOverlap('we:scripts/lib/pr-merge-gate.mjs', 'we:scripts/lib/*.mjs')).toBe(true); // glob
    // …but not a sibling subtree it does not fall under.
    expect(scopeEntriesOverlap('we:scripts/guard-backward-edge.mjs', 'we:scripts/lib/')).toBe(false);
  });
  it('SUBTREE ↔ SUBTREE still serializes a genuinely-spanning declaration (pre-#2679 behavior preserved)', () => {
    expect(scopeEntriesOverlap('we:scripts', 'we:scripts/lib')).toBe(true);
    expect(scopeEntriesOverlap('plateau-app:src/backlog-view/', 'plateau-app:src/backlog-view/')).toBe(true);
  });
  it('SAFETY: a directory-with-a-dot (misclassified as a file) never lets a real parent↔child overlap slip', () => {
    // conservative fallback — errs toward over-serializing, never toward a missed conflict.
    expect(scopeEntriesOverlap('we:src/foo.v2', 'we:src/foo.v2/bar.mjs')).toBe(true); // dotted-dir ↔ file child
    // dotted-dir ↔ a GLOB of its children — the case a coverage-only test would miss (regression guard).
    expect(scopeEntriesOverlap('we:.github', 'we:.github/**')).toBe(true);
    expect(scopeEntriesOverlap('we:.github', 'we:.github/workflows/ci.yml')).toBe(true);
    expect(scopeEntriesOverlap('we:src/foo.v2', 'we:src/foo.v2/*.mjs')).toBe(true);
    // …but a dotted dir must NOT overlap an unrelated sibling.
    expect(scopeEntriesOverlap('we:.github', 'we:.gitlab/**')).toBe(false);
  });
  it('breach detection is file-granular: an out-of-scope sibling file breaches a file-level lease', () => {
    // predicted a single file; touching a DIFFERENT file in the same dir is a breach (not silently in-scope).
    expect(breachOf(['we:scripts/foo.mjs'], ['we:scripts/foo.mjs', 'we:scripts/bar.mjs'])).toEqual(['we:scripts/bar.mjs']);
    // a subtree predicted scope still absorbs everything under it (no false breach).
    expect(breachOf(['we:scripts/'], ['we:scripts/foo.mjs', 'we:scripts/bar.mjs'])).toEqual([]);
  });
});

describe('(1) scopeLease — predicted vs observed → breach', () => {
  it('all observed inside predicted ⇒ clean, no breach', () => {
    const lease = scopeLease(['we:src/backlog-view', 'we:src/lib/*.ts'], ['we:src/backlog-view/list.ts', 'we:src/lib/x.ts']);
    expect(lease.clean).toBe(true);
    expect(lease.breach).toEqual([]);
    expect(lease.inScope).toEqual(['we:src/backlog-view/list.ts', 'we:src/lib/x.ts']);
  });
  it('observed outside predicted ⇒ breach = the difference (coverage-generalized)', () => {
    const lease = scopeLease(['we:src/backlog-view'], ['we:src/backlog-view/list.ts', 'we:src/router.ts']);
    expect(lease.clean).toBe(false);
    expect(lease.breach).toEqual(['we:src/router.ts']);
    expect(lease.inScope).toEqual(['we:src/backlog-view/list.ts']);
  });
  it('cross-repo spill is a breach when predicted did not include that repo', () => {
    const lease = scopeLease(['we:src/x'], ['we:src/x/a.ts', 'frontierui:src/impl.ts']);
    expect(lease.breach).toEqual(['frontierui:src/impl.ts']);
  });
  it('empty predicted ⇒ every observed file breaches', () => {
    expect(scopeLease([], ['we:a', 'we:b']).breach).toEqual(['we:a', 'we:b']);
  });
  it('breachOf convenience returns just the breach set', () => {
    expect(breachOf(['we:src/x'], ['we:src/x/a.ts', 'we:src/y.ts'])).toEqual(['we:src/y.ts']);
  });
});

describe('(2) overlapAtLaunch — the {wait,ask,force} knob', () => {
  const leases = [
    { id: 'lane-2', scope: ['we:src/backlog-view'] },
    { id: 'lane-5', scope: ['we:src/router.ts'] },
  ];
  it('no overlap ⇒ launch, for every policy', () => {
    for (const policy of OVERLAP_POLICIES) {
      const r = overlapAtLaunch(['we:src/unrelated'], leases, policy);
      expect(r.outcome).toBe('launch');
      expect(r.overlaps).toEqual([]);
    }
  });
  it('wait (default) ⇒ block on every overlapping lease', () => {
    const r = overlapAtLaunch(['we:src/backlog-view/detail.ts'], leases);
    expect(r.policy).toBe('wait');
    expect(r.outcome).toBe('wait');
    expect(r.waitOn).toEqual(['lane-2']);
    expect(r.resolveAtDrain).toBe(false);
  });
  it('ask ⇒ park for the human (no auto-launch)', () => {
    const r = overlapAtLaunch(['we:src/backlog-view/detail.ts'], leases, 'ask');
    expect(r.outcome).toBe('ask');
    expect(r.overlaps.map((o) => o.leaseId)).toEqual(['lane-2']);
  });
  it('force ⇒ launch now + schedule resolve-at-drain', () => {
    const r = overlapAtLaunch(['we:src/backlog-view/detail.ts'], leases, 'force');
    expect(r.outcome).toBe('force');
    expect(r.resolveAtDrain).toBe(true);
    expect(r.waitOn).toEqual(['lane-2']);
  });
  it('overlaps MANY leases ⇒ waits on all of them', () => {
    const r = overlapAtLaunch(['we:src/backlog-view/x.ts', 'we:src/router.ts'], leases, 'wait');
    expect(r.waitOn).toEqual(['lane-2', 'lane-5']);
  });
  it('laneId is used when id is absent; missing both ⇒ null', () => {
    expect(overlapAtLaunch(['we:src/a/x.ts'], [{ laneId: 'L', scope: ['we:src/a'] }]).waitOn).toEqual(['L']);
    expect(overlapAtLaunch(['we:src/a/x.ts'], [{ scope: ['we:src/a'] }]).waitOn).toEqual([null]);
  });
  it('empty / missing lease list ⇒ launch', () => {
    expect(overlapAtLaunch(['we:src/a'], []).outcome).toBe('launch');
    expect(overlapAtLaunch(['we:src/a'], undefined).outcome).toBe('launch');
  });
  it('unknown policy throws', () => {
    expect(() => overlapAtLaunch(['we:a'], leases, 'nope')).toThrow(/unknown policy/);
  });
});

describe('(3) breachOutcome — the {pause,park,resolve-at-drain} knob + retry ladder', () => {
  it('no breach ⇒ continue, for every policy', () => {
    for (const policy of BREACH_POLICIES) {
      const r = breachOutcome([], policy);
      expect(r.breached).toBe(false);
      expect(r.action).toBe('continue');
      expect(r.escalated).toBe(false);
    }
  });
  it('accepts a scopeLease() result OR a raw file array as the breach', () => {
    const lease = scopeLease(['we:src/x'], ['we:src/y.ts']);
    expect(breachOutcome(lease, 'pause').breached).toBe(true);
    expect(breachOutcome(['we:src/y.ts'], 'pause').breached).toBe(true);
  });
  it('within the retry bound ⇒ retry-in-place (A4 default) for ANY policy', () => {
    for (const policy of BREACH_POLICIES) {
      const r = breachOutcome(['we:src/y.ts'], policy, { attempt: 1 });
      expect(r.action).toBe('retry-in-place');
      expect(r.rung).toBe('retry-in-place');
      expect(r.escalated).toBe(false);
    }
  });
  it('TOTAL attempt counter drives escalation (not same-scope-twice): a DIFFERENT breach file still escalates', () => {
    // attempt 2 > RETRY_BOUND(1) — even though the breached file differs from attempt 1, it escalates.
    const r = breachOutcome(['we:src/DIFFERENT.ts'], 'park', { attempt: 2 });
    expect(r.escalated).toBe(true);
    expect(r.action).toBe('park');
  });
  it('resolve-at-drain ⇒ continue building, resolve scheduled at drain', () => {
    const r = breachOutcome(['we:src/y.ts'], 'resolve-at-drain', { attempt: 2 });
    expect(r.action).toBe('resolve-at-drain');
    expect(r.resolveAtDrain).toBe(true);
    expect(r.escalated).toBe(true);
    expect(r.holdSource).toBe(null);
  });
  it('pause ⇒ hold with sibling-lane source (wait for the owning lease)', () => {
    const r = breachOutcome(['we:src/y.ts'], 'pause', { attempt: 2 });
    expect(r.action).toBe('pause');
    expect(r.holdSource).toBe('sibling-lane');
    expect(r.rung).toBe('handoff-cross-lane');
  });
  it('park ⇒ amber you-card (policy hold) offering the escalation route menu', () => {
    const r = breachOutcome(['we:src/y.ts'], 'park', { attempt: 2 });
    expect(r.action).toBe('park');
    expect(r.holdSource).toBe('policy');
    expect(r.routes).toBe(ESCALATION_ROUTES);
    expect(r.routes.map((x) => x.rung)).toEqual(['widen-lease', 'handoff-cross-lane', 'bounce-quarantine']);
  });
  it('a custom retryBound extends how long retry-in-place holds before escalating', () => {
    expect(breachOutcome(['we:src/y.ts'], 'park', { attempt: 3, retryBound: 3 }).action).toBe('retry-in-place');
    expect(breachOutcome(['we:src/y.ts'], 'park', { attempt: 4, retryBound: 3 }).escalated).toBe(true);
  });
  it('unknown policy throws', () => {
    expect(() => breachOutcome(['we:a'], 'nope')).toThrow(/unknown policy/);
  });
});

describe('escalation ladder + constants (§3i-A4 Fork 2, as data)', () => {
  it('RETRY_BOUND is 1 (retry-once-then-escalate)', () => {
    expect(RETRY_BOUND).toBe(1);
  });
  it('ladder is ordered retry → widen → handoff → bounce', () => {
    expect(BREACH_ESCALATION_LADDER.map((r) => r.rung))
      .toEqual(['retry-in-place', 'widen-lease', 'handoff-cross-lane', 'bounce-quarantine']);
    expect(BREACH_ESCALATION_LADDER.map((r) => r.order)).toEqual([0, 1, 2, 3]);
  });
  it('ESCALATION_ROUTES = the rungs past the retry-in-place default', () => {
    expect(ESCALATION_ROUTES.every((r) => r.order >= 1)).toBe(true);
    expect(ESCALATION_ROUTES.length).toBe(3);
  });
  it('policy token sets are the ratified §3i values', () => {
    expect(OVERLAP_POLICIES).toEqual(['wait', 'ask', 'force']);
    expect(BREACH_POLICIES).toEqual(['pause', 'park', 'resolve-at-drain']);
  });
});

describe('composition — the reused lane-partition primitive', () => {
  it('re-exports disjoint (the exact-set primitive reused, not re-implemented)', () => {
    expect(disjoint(new Set(['we:a']), new Set(['we:b']))).toBe(true);
    expect(disjoint(new Set(['we:a']), new Set(['we:a']))).toBe(false);
  });
});
