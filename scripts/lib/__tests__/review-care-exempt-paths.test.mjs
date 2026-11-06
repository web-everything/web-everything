import { describe, it, expect, vi } from 'vitest';
import { scoreEscalation } from '../review-escalation.mjs';
import { DEFAULT_CARE_EXEMPT_PATHS, MAX_CARE_EXEMPT_GLOB_LENGTH, MAX_CARE_EXEMPT_PATH_LENGTH,
  MAX_CARE_EXEMPT_PATH_SEGMENTS, matchesCareExemptPath, resolveReviewCareExemptPaths,
  validateCareExemptPaths } from '../review-care-exempt-paths.mjs';

const timings = 'scripts/ci/test-timings.json';
const section = (file, count) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${count} @@\n${'+data\n'.repeat(count)}`;

describe('R641 care exemptions', () => {
  it.each([
    'scripts/guard-bash.mjs', 'scripts/guard-git-push.mjs', 'scripts/lib/permission-change.mjs',
    ...['scripts', '.github', '.claude'].flatMap(root => ['guard', 'egress', 'permission'].flatMap(prefix => [
      `${root}/${prefix}/fixtures/sample.json`, `${root}/tools/fixtures/${prefix}-check.mjs`,
    ])),
  ])('always counts protected machinery %s despite explicit or fixture exemptions', file => {
    for (const careExemptPaths of [[file], ['**/fixtures/**']]) {
      const result = scoreEscalation({ changedFiles: [file], careExemptPaths, diffLines: 1000 });
      expect(result.signals.careExempt).toBeUndefined();
      expect(result.basisFiles).toEqual([file]);
      expect(result.signals.size).toBe(1000);
    }
  });

  it.each([
    'scripts/ci/old-timings.json => scripts/ci/test-timings.json',
    'scripts/ci/{old-timings => test-timings}.json',
  ])('subtracts one section only for rename alias %s and its plain path', renamed => {
    const diffHunks = section(timings, 200).replace(
      `diff --git a/${timings} b/${timings}`,
      `diff --git a/scripts/ci/old-timings.json b/${timings}\nrename from scripts/ci/old-timings.json\nrename to ${timings}`,
    ) + section('app.js', 400);
    // Both rename sides must be exempt for the rename to be exempt (#6433 review).
    const result = scoreEscalation({ changedFiles: [renamed, timings, 'app.js'], diffLines: 600, diffHunks,
      careExemptPaths: ['scripts/ci/*.json'] });
    expect(result.signals.size).toBe(400);
    // With only the target exempt, the alias must not subtract the retained rename's section.
    expect(scoreEscalation({ changedFiles: [renamed, timings, 'app.js'], diffLines: 600, diffHunks }).signals.size)
      .toBe(600);
  });

  it('timings alone have no size or blast-radius care and need no human', () => {
    const result = scoreEscalation({ changedFiles: [timings], diffLines: 10000 });
    expect(result.humanRequired).toBe(false);
    expect(result.careLevel).toBe('none');
    expect(result.signals.careExempt).toEqual([timings]);
    expect(result.basisFiles).toEqual([]);
  });

  it('a guard alongside timings retains human review even when explicitly matched', () => {
    const guard = 'scripts/lib/gate-config.mjs';
    const result = scoreEscalation({ changedFiles: [timings, guard], humanSurfaces: 'broad',
      careExemptPaths: [timings, guard], diffLines: 10000 });
    expect(result.humanRequired).toBe(true);
    expect(result.signals.careExempt).toEqual([timings]);
    expect(result.basisFiles).toEqual([guard]);
    expect(result.signals.size).toBe(10000);
  });

  // #6433 review: protected rules must hold on BOTH sides of a rename, in every numstat display form.
  const renameForms = {
    plain: (from, to) => `${from} => ${to}`,
    brace: (from, to) => {
      let i = 0;
      while (i < from.length && from[i] === to[i]) i += 1;
      const cut = from.lastIndexOf('/', i - 1) + 1;
      return `${from.slice(0, cut)}{${from.slice(cut)} => ${to.slice(cut)}}`;
    },
    quoted: (from, to) => `"${from}" => "${to}"`,
    // Real git quotes only the side that needs it.
    mixed: (from, to) => `${from} => "${to}"`,
  };
  // Protected machinery, plus authored files (a statute, an ordinary tool) that are not exempt themselves:
  // a rename is exempt only when every side is.
  const nonExemptSources = ['scripts/guard-bash.mjs', 'scripts/lib/egress-policy.mjs',
    'scripts/lib/permission-change.mjs', 'scripts/merge-ai-prs.mjs', '.github/workflows/build.yml', '.env',
    'docs/agent/platform-decisions.md', 'scripts/lib/foo.mjs'];
  const exemptTargets = ['data/generated/g.json', 'scripts/lib/__tests__/fixtures/policy.mjs',
    'scripts/ci/test-timings.json', 'src/_data/referenceIndex.json'];
  it.each(Object.keys(renameForms).flatMap(form => nonExemptSources.flatMap(from =>
    exemptTargets.map(to => [form, from, to]))))('keeps care for a %s rename of %s into exempt %s', (form, from, to) => {
    const entry = renameForms[form](from, to);
    for (const changedFiles of [[entry], [entry, to]]) {
      const diffHunks = `diff --git a/${from} b/${to}\nrename from ${from}\nrename to ${to}\n--- a/${from}\n+++ b/${to}\n`
        + `@@ -1,500 +1,500 @@\n${'-old\n'.repeat(500)}${'+new\n'.repeat(500)}`;
      const result = scoreEscalation({ changedFiles, diffLines: 1000, diffHunks });
      expect(result.signals.careExempt).toBeUndefined();
      expect(result.basisFiles).toEqual(changedFiles);
      expect(result.signals.size).toBe(1000);
      expect(result.careLevel).not.toBe('none');
    }
  });

  it('still exempts a rename whose every side is exempt', () => {
    const entry = 'scripts/ci/{old-timings.json => test-timings.json}';
    expect(scoreEscalation({ changedFiles: [entry], diffLines: 1000, careExemptPaths: ['scripts/ci/*.json'] })
      .signals.careExempt).toEqual([entry]);
    expect(scoreEscalation({ changedFiles: [entry], diffLines: 1000 }).signals.careExempt).toBeUndefined();
  });

  it.each(['scripts/tools/fixtures/Guard-check.mjs', 'scripts/tools/fixtures/EGRESS.json',
    '.claude/Permission/fixtures/x.json', 'scripts/tools/fixtures/ｇuard-x.mjs'])(
    'protects re-cased or compatibility-spelled machinery %s', file => {
      const result = scoreEscalation({ changedFiles: [file], diffLines: 1000 });
      expect(result.signals.careExempt).toBeUndefined();
      expect(result.basisFiles).toEqual([file]);
    });

  it('subtracts only exempt per-file changed lines when hunks are available', () => {
    const result = scoreEscalation({ changedFiles: [timings, 'app.js'], diffLines: 1002,
      diffHunks: section(timings, 1000) + section('app.js', 2) });
    expect(result.signals.size).toBeUndefined();
    expect(result.careLevel).toBe('none');
    expect(result.diffHunksBasisFiles).toEqual([timings, 'app.js']);
  });

  it('retains mixed-file size when exempt hunks are unavailable', () => {
    expect(scoreEscalation({ changedFiles: [timings, 'app.js'], diffLines: 1002 }).signals.size).toBe(1002);
  });

  it('retains mixed-file size when exempt hunks are truncated', () => {
    const diffHunks = section(timings, 1000).replace('@@ -0,0 +1,1000 @@', '@@ -0,0 +1,1001 @@');
    expect(scoreEscalation({ changedFiles: [timings, 'app.js'], diffLines: 1002, diffHunks }).signals.size).toBe(1002);
  });

  it('filters cumulative exempt files without losing a cumulative guard', () => {
    const guard = 'scripts/lib/gate-config.mjs';
    const result = scoreEscalation({ changedFiles: [timings], humanBasisFiles: [guard, timings],
      humanSurfaces: 'broad', diffLines: 1000 });
    expect(result.basisFiles).toEqual([guard]);
    expect(result.humanRequired).toBe(true);
  });

  // #6433 red team: the hunks describe the CUMULATIVE basis only. Exempt lines are subtracted per basis, then
  // the max is taken, so an ancestor's exempt lines can never hide the child's own non-exempt delta.
  it('keeps a stacked child own non-exempt delta when the ancestor added exempt lines', () => {
    const result = scoreEscalation({ changedFiles: ['app.js'], diffLines: 500,
      humanBasisFiles: [timings, 'app.js'], cumulativeDiffLines: 1100,
      diffHunks: section(timings, 1000) + section('app.js', 100) });
    expect(result.signals.size).toBe(500);
    expect(result.escalate).toBe(true);
    expect(result.careLevel).not.toBe('none');
  });

  it('does not subtract from a stacked own delta with the same file set but a different line split', () => {
    // Own: app.js 500 + timings 300 = 800. Cumulative: app.js 100 + timings 700 = 800. Equal sets and totals,
    // yet the cumulative timings count says nothing about the own delta's split.
    const result = scoreEscalation({ changedFiles: [timings, 'app.js'], diffLines: 800,
      humanBasisFiles: [timings, 'app.js'], cumulativeDiffLines: 800,
      diffHunks: section(timings, 700) + section('app.js', 100) });
    expect(result.signals.size).toBe(800);
  });

  it('still clears a stacked child whose own delta is exempt files only', () => {
    const result = scoreEscalation({ changedFiles: [timings], diffLines: 1000,
      humanBasisFiles: [timings, 'app.js'], cumulativeDiffLines: 1010,
      diffHunks: section(timings, 1000) + section('app.js', 10) });
    expect(result.signals.size).toBeUndefined();
  });

  it('subtracts exempt lines when the own delta IS the cumulative basis (non-stacked net-diff shape)', () => {
    // computeNetDiffChangedFiles / the gh fallback hand the SAME list for both bases when nothing is stacked.
    const files = [timings, 'app.js'];
    const result = scoreEscalation({ changedFiles: files, diffLines: 1010, humanBasisFiles: files,
      cumulativeDiffLines: 1010, diffHunks: section(timings, 1000) + section('app.js', 10) });
    expect(result.signals.size).toBeUndefined();
    expect(result.careLevel).toBe('none');
  });

  it('counts additions and removals without subtracting diff headers', () => {
    const diffHunks = `diff --git a/${timings} b/${timings}\n--- a/${timings}\n+++ b/${timings}\n@@ -1,250 +1,250 @@\n${'-old\n'.repeat(250)}${'+new\n'.repeat(250)}`
      + section('app.js', 400);
    expect(scoreEscalation({ changedFiles: [timings, 'app.js'], diffLines: 900, diffHunks }).signals.size).toBe(400);
  });

  // #6433 self-review: binary, pure-rename, mode-only and empty files change no counted line, so they must not
  // switch the exemption off for the rest of the PR.
  it('still subtracts when the PR also has binary, pure-rename, mode-only and empty-file sections', () => {
    const files = [timings, 'app.js', 'img.png', 'old.md => new.md', 'run.sh', 'empty.txt'];
    const diffHunks = section(timings, 1000) + section('app.js', 10)
      + 'diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/img.png differ\n'
      + 'diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n'
      + 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
      + 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n';
    const result = scoreEscalation({ changedFiles: files, diffLines: 1010, humanBasisFiles: files,
      cumulativeDiffLines: 1010, diffHunks });
    expect(result.signals.size).toBeUndefined();
  });

  // #6433 self-review: hunks that do not provably describe the counted basis subtract nothing.
  it.each([
    ['ancestry counts paired with base-tip hunks (upstream drift on the exempt file)', 401, section(timings, 5000) + section('app.js', 400)],
    ['a non-exempt section missing from the hunks', 1400, section(timings, 1000)],
    ['a hunk-less section that cannot account for the counted lines', 1400, `${section(timings, 1000)}diff --git a/app.js b/app.js\nBinary files differ\n`],
    ['a section truncated inside its hunk', 1010, section(timings, 1000) + section('app.js', 10).replace(/\+data\n$/, '')],
  ])('subtracts nothing when %s', (_name, lines, diffHunks) => {
    const files = [timings, 'app.js'];
    const result = scoreEscalation({ changedFiles: files, diffLines: lines, humanBasisFiles: files,
      cumulativeDiffLines: lines, diffHunks });
    expect(result.signals.size).toBe(lines);
    expect(result.careLevel).not.toBe('none');
  });

  it('allows an empty list to disable exemptions', () => {
    const result = scoreEscalation({ changedFiles: [timings], diffLines: 1000, careExemptPaths: [] });
    expect(result.signals.careExempt).toBeUndefined();
    expect(result.signals.size).toBe(1000);
  });

  it('retains engine and sensitive surfaces even when explicitly matched', () => {
    for (const file of ['scripts/merge-ai-prs.mjs', '.github/workflows/build.yml', '.env', 'scripts/lib/github-auth-policy.mjs']) {
      const result = scoreEscalation({ changedFiles: [file], careExemptPaths: [file], diffLines: 1000 });
      expect(result.signals.careExempt).toBeUndefined();
      expect(result.basisFiles).toEqual([file]);
      expect(result.signals.size).toBe(1000);
    }
  });

  it('matches fixture globs while preserving independent signals and human triggers', () => {
    const file = 'scripts/tools/fixtures/sample.json';
    const result = scoreEscalation({ changedFiles: [file], diffLines: 1000, crossRepo: true, dismissedFindings: 1 });
    expect(result.signals.careExempt).toEqual([file]);
    expect(result.signals.blastRadius).toBeUndefined();
    expect(result.signals.crossRepo).toBe(true);
    expect(result.signals.dismissedFindings).toBe(1);
    expect(scoreEscalation({ changedFiles: [file], deviation: 'declared deviation' }).humanRequired).toBe(true);
  });
});

describe('care exemption settings resolver', () => {
  const broadGlobs = ['scripts/**/*', 'scripts/**/**', 'scripts/*', '**/*', '*/**',
    'scripts/g*.mjs', 'scripts/[ab]/**', 'scripts/?/file.json', 's*/lib/**',
    // #6433 red team: compound or regex-metacharacter spellings widen reach — only a plain character set passes.
    'scripts/ci/**|scripts/**', 'scripts/ci/a.json|app.js', 'scripts/ci/x|**', 'scripts/ci/+(a|b)/**',
    'scripts/ci/@(**)', 'scripts/ci/$x.json', 'scripts/ci/^x.json', 'scripts/ci/a,b.json', 'scripts/ci/ä.json',
    'scripts/ci/a b.json', 'scripts/ci/[a-z]*.json'];

  // #6433 self-review: resource bound — many wildcard runs backtrack for seconds per author-chosen path.
  it.each([
    'x/y/*a*a*a*a*a*a*a*a*a*ab', 'scripts/ci/*a*.json', 'scripts/ci/*/*/*/*.json',
    'a/b/**/x/**/z', 'a/b/**/x/**/x/**/z', 'a/b/**/x/x/**/x/x/**/z',
    `scripts/ci/${'a'.repeat(MAX_CARE_EXEMPT_GLOB_LENGTH)}.json`,
  ])('refuses backtracking-prone or oversized glob %s through every settings layer', glob => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(validateCareExemptPaths([glob])).toEqual(DEFAULT_CARE_EXEMPT_PATHS);
      for (const options of [
        { readFile: () => JSON.stringify({ careExemptPaths: [glob] }) },
        { env: { WE_REVIEW_CARE_EXEMPT_PATHS: JSON.stringify([glob]) } },
      ]) {
        const result = resolveReviewCareExemptPaths({ env: {}, readFile: () => '{}', log: () => {}, ...options });
        expect(result.value).toEqual(DEFAULT_CARE_EXEMPT_PATHS);
      }
    } finally { warn.mockRestore(); }
  });

  it('the widest allowed wildcard shape still matches a long author-chosen path quickly', () => {
    const glob = 'scripts/ci/*/*/*x';
    expect(validateCareExemptPaths([glob])).toEqual([glob]);
    const started = Date.now();
    expect(matchesCareExemptPath(`scripts/ci/${'a/'.repeat(2)}${'a'.repeat(5000)}`, [glob])).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never exempts an over-long or over-deep author-chosen path (bounded match cost, fail closed)', () => {
    const deep = `data/generated/${'x/'.repeat(MAX_CARE_EXEMPT_PATH_SEGMENTS)}f.json`;
    const long = `data/generated/${'a'.repeat(MAX_CARE_EXEMPT_PATH_LENGTH)}.json`;
    for (const file of [deep, long]) {
      expect(matchesCareExemptPath(file, DEFAULT_CARE_EXEMPT_PATHS)).toBe(false);
      expect(scoreEscalation({ changedFiles: [file], diffLines: 1000 }).signals.size).toBe(1000);
    }
    expect(matchesCareExemptPath('data/generated/x/f.json', DEFAULT_CARE_EXEMPT_PATHS)).toBe(true);
  });

  it('a piped scope cannot exempt scripts/** through the environment (live repro)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { value } = resolveReviewCareExemptPaths({ readFile: () => '{}', log: () => {},
        env: { WE_REVIEW_CARE_EXEMPT_PATHS: '["scripts/ci/**|scripts/**"]' } });
      const result = scoreEscalation({ changedFiles: ['scripts/lib/under-test.mjs'], diffLines: 1000,
        careExemptPaths: value });
      expect(result.careLevel).toBe('high');
      expect(result.escalate).toBe(true);
      expect(result.signals.careExempt).toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  it.each(broadGlobs)('refuses shallow matching scope %s directly and through every settings layer', glob => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(validateCareExemptPaths([glob])).toEqual(DEFAULT_CARE_EXEMPT_PATHS);
      for (const options of [
        { readFile: () => JSON.stringify({ careExemptPaths: [glob] }) },
        { env: { WE_REVIEW_CARE_EXEMPT_PATHS: JSON.stringify([glob]) } },
      ]) {
        const result = resolveReviewCareExemptPaths({ env: {}, readFile: () => '{"careExemptPaths":["app/safe.json"]}',
          log: () => {}, ...options });
        expect(result.value).toEqual(DEFAULT_CARE_EXEMPT_PATHS);
        expect(result.sources['']).toBe('standard');
      }
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('allows specific files, narrow glob scopes and the explicit fixtures exception', () => {
    const patterns = ['app.js', 'scripts/tool.mjs', 'scripts/ci/*.json', 'data/generated/**', '**/fixtures/**'];
    expect(validateCareExemptPaths(patterns)).toEqual(patterns);
  });

  const resolve = async (options = {}) => {
    return resolveReviewCareExemptPaths({ env: {}, readFile: () => '{}', log: () => {}, ...options });
  };

  it.each(['**', '*', 'scripts/**', 'src/**', '**/*.json', '', 4])('refuses unsafe glob %j as a whole list with a warning and built-in fallback', async glob => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await resolve({ readFile: () => JSON.stringify({ careExemptPaths: ['app/safe.json', glob] }) });
      expect(result.value).toContain(timings);
      expect(result.value).not.toContain('app/safe.json');
      expect(result.sources['']).toBe('standard');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('careExemptPaths'));
    } finally { warn.mockRestore(); }
  });

  it('resolves tool then JSON environment overrides and logs provenance', async () => {
    const log = vi.fn();
    const readFile = () => JSON.stringify({ careExemptPaths: ['data/generated/**'] });
    expect((await resolve({ readFile })).value).toEqual(['data/generated/**']);
    const result = await resolve({ readFile, env: { WE_REVIEW_CARE_EXEMPT_PATHS: '["app/snapshot.json"]' }, log });
    expect(result.value).toEqual(['app/snapshot.json']);
    expect(result.sources['']).toBe('env');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/careExemptPaths.*env/));
  });

  // Any invalid layer resets the WHOLE list to built-in: tool valid/invalid × env valid/invalid/absent.
  const toolLayers = { valid: '{"careExemptPaths":["app/snapshot.json"]}', invalid: '{"careExemptPaths":["**"]}',
    empty: '{"careExemptPaths":[]}', unparseable: 'not json' };
  const envLayers = { valid: '["app/env.json"]', invalid: '["scripts/**"]', empty: '[]', unparseable: 'invalid',
    absent: undefined };
  const expectedLayer = (tool, env) => {
    if ([tool, env].some(l => l === 'invalid' || l === 'unparseable')) return [[...DEFAULT_CARE_EXEMPT_PATHS], 'standard'];
    if (env !== 'absent') return [env === 'valid' ? ['app/env.json'] : [], 'env'];
    return [tool === 'valid' ? ['app/snapshot.json'] : [], 'tool'];
  };
  it.each(Object.keys(toolLayers).flatMap(tool => Object.keys(envLayers).map(env => [tool, env])))(
    'settings matrix: tool %s × env %s', async (tool, env) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const envValue = envLayers[env];
        const result = await resolve({ readFile: () => toolLayers[tool],
          env: envValue === undefined ? {} : { WE_REVIEW_CARE_EXEMPT_PATHS: envValue } });
        const [value, source] = expectedLayer(tool, env);
        expect(result.value).toEqual(value);
        expect(result.sources['']).toBe(source);
        expect(warn.mock.calls.length > 0).toBe(source === 'standard');
      } finally { warn.mockRestore(); }
    });

  it('invalid environment JSON falls back to built-in rather than tool exemptions', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await resolve({ readFile: () => '{"careExemptPaths":["app/snapshot.json"]}',
        env: { WE_REVIEW_CARE_EXEMPT_PATHS: 'invalid' } });
      expect(result.value).toContain(timings);
      expect(result.sources['']).toBe('standard');
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
