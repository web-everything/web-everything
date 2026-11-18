import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeGit } from '../daemon-rebuild/shared.mjs';
import { OVERLAY_CONFLICT_STRATEGIES, resolveOverlayConflict } from '../daemon-rebuild/overlay-strategies.mjs';

// Load inside tests so the existing strategy integration is exercised even before
// the new module exists. Missing implementation is an expected red test, never a skip.
const advisoryModule = '../daemon-rebuild/advisory-merge.mjs';
const advisory = () => import(/* @vite-ignore */ advisoryModule);
const INDEX = 'scripts/conveyor/soak/breaks/index.mjs';
const TIMINGS = 'scripts/ci/test-timings.json';
const TESTING = 'docs/agent/testing.md';
const INDEX_BASE = '/**\n * Registry.\n */\nexport const breaks = [];\n';
const registry = (addition, base = INDEX_BASE) => base.replace(' */\n', `${addition} */\n`);
const DOC = 'Measured seconds per test file.';
const json = value => `${JSON.stringify(value, null, 1)}\n`;
const timings = (unit = {}, soak = {}) => ({ _doc: DOC, unit, soak });
const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ testing, timingConflict = true, codeConflict = false, duplicate = false, indexConflict = false, indexBase = INDEX_BASE, indexAddition = ' * theirs\n',
  indexOurs = registry(' * ours\n * shared\n', indexBase),
  indexTheirs = registry(`${indexAddition} * shared\n`, indexBase) } = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'advisory-merge-'));
  roots.push(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  // Do not let a launcher-provided index or repository redirect these fixture writes.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const git = makeGit({
    cwd: root, env,
    run: (args, opts) => spawnSync('git', args, {
      ...opts, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    }),
  });
  const ok = args => {
    const result = git(args);
    expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = message => {
    ok(['add', '-A']);
    ok(['commit', '-q', '-m', message]);
    return ok(['rev-parse', 'HEAD']);
  };
  ok(['init', '-q', '-b', 'base']);
  ok(['config', 'user.name', 'advisory-merge-test']);
  ok(['config', 'user.email', 'advisory-merge-test@localhost']);
  ok(['config', 'core.hooksPath', '/dev/null']);
  ok(['config', 'commit.gpgsign', 'false']);
  ok(['config', 'rerere.enabled', 'false']);
  write(TIMINGS, json(timings({ shared: 1 })));
  write(INDEX, indexBase);
  if (testing) write(TESTING, testing[0]);
  write('a.mjs', 'export const value = "base";\n');
  commit('base');
  ok(['checkout', '-q', '-b', 'ours']);
  if (timingConflict) write(TIMINGS, json(timings({ shared: 1, zeta: 3, ...(duplicate ? { same: 9 } : {}) })));
  if (codeConflict) write('a.mjs', 'export const value = "ours";\n');
  if (indexConflict) write(INDEX, indexOurs);
  if (testing) write(TESTING, testing[1]);
  write('ours-only.txt', 'keep ours\n');
  const cur = commit('ours');
  ok(['checkout', '-q', '-b', 'theirs', 'base']);
  if (timingConflict) write(TIMINGS, json(timings({ shared: 1, alpha: 2, ...(duplicate ? { same: 4 } : {}) })));
  if (codeConflict) write('a.mjs', 'export const value = "theirs";\n');
  if (indexConflict) write(INDEX, indexTheirs);
  if (testing) write(TESTING, testing[2]);
  write('theirs-only.txt', 'keep theirs\n');
  const ovSha = commit('theirs');
  ok(['checkout', '-q', 'ours']);
  return { root, git, ok, cur, ovSha };
}

function assertConflict(f, paths) {
  const result = f.git(['merge-tree', '--write-tree', '--name-only', f.cur, f.ovSha]);
  expect(result.status).toBe(1);
  const names = result.stdout.split('\n').slice(1);
  expect(names.slice(0, names.indexOf('')).sort()).toEqual([...paths].sort());
}

function snapshot(f) {
  return {
    head: f.ok(['rev-parse', 'HEAD']),
    index: readFileSync(join(f.root, '.git/index')),
    status: f.ok(['status', '--porcelain=v1']),
    timings: readFileSync(join(f.root, TIMINGS), 'utf8'),
    code: readFileSync(join(f.root, 'a.mjs'), 'utf8'),
  };
}

function assertTree(f, result, duplicate = false) {
  expect(result).toMatchObject({ ok: true, via: 'advisory-merge', tree: expect.stringMatching(/^[0-9a-f]{40}$/) });
  const text = f.git(['show', `${result.tree}:${TIMINGS}`]);
  expect(text.status).toBe(0);
  const expected = timings({ alpha: 2, ...(duplicate ? { same: 9 } : {}), shared: 1, zeta: 3 });
  expect(JSON.parse(text.stdout)).toEqual(expected);
  expect(text.stdout).toBe(json(expected));
  expect(f.ok(['show', `${result.tree}:ours-only.txt`])).toBe('keep ours');
  expect(f.ok(['show', `${result.tree}:theirs-only.txt`])).toBe('keep theirs');
}

describe('advisory merge contract', () => {
  it('creates a real Git fixture with TMPDIR unset using the platform fallback', () => {
    // Keep scratch files in the task temp directory; tmpdir() also honors TMP/TEMP.
    const taskTemp = process.env.TMPDIR || tmpdir();
    vi.stubEnv('TMP', taskTemp);
    vi.stubEnv('TEMP', taskTemp);
    vi.stubEnv('TMPDIR', '');
    delete process.env.TMPDIR;
    expect(process.env.TMPDIR).toBeUndefined();
    const f = fixture();
    expect(dirname(f.root)).toBe(tmpdir());
    assertConflict(f, [TIMINGS]);
  });

  it('exports a frozen allowlist containing exactly the known advisory files', async () => {
    const { ADVISORY_MERGE_PATHS } = await advisory();
    expect(ADVISORY_MERGE_PATHS).toEqual([TIMINGS, INDEX, TESTING]);
    expect(Object.isFrozen(ADVISORY_MERGE_PATHS)).toBe(true);
  });

  it('registers the advisory-merge strategy', () => {
    expect(OVERLAY_CONFLICT_STRATEGIES.filter(s => s.name === 'advisory-merge')).toHaveLength(1);
  });
});

describe('testing ledger union', () => {
  it.each(['object database', 'worktree'])('unions append-only notes and deduplicates common additions in the %s', async mode => {
    const { resolveAdvisoryConflicts, resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true, testing: ['# Tests\n', '# Tests\nours\nshared\n', '# Tests\ntheirs\nshared\n'] });
    assertConflict(f, [TIMINGS, INDEX, TESTING]);
    if (mode === 'worktree') {
      expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
      expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
      expect(readFileSync(join(f.root, TESTING), 'utf8')).toBe('# Tests\nours\nshared\ntheirs\n');
    } else {
      const before = snapshot(f);
      const result = resolveAdvisoryConflicts(f);
      assertTree(f, result);
      expect(f.git(['show', `${result.tree}:${TESTING}`]).stdout).toBe('# Tests\nours\nshared\ntheirs\n');
      expect(snapshot(f)).toEqual(before);
    }
  });

  it.each([
    ['edit', '# Changed\nours\n'], ['deletion', 'ours\n'], ['conflict markers', '# Tests\n<<<<<<< ours\n'],
  ])('refuses a testing ledger %s', async (_, ours) => {
    const { resolveAdvisoryConflicts, resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ testing: ['# Tests\n', ours, '# Tests\ntheirs\n'] });
    assertConflict(f, [TIMINGS, TESTING]);
    expect(resolveAdvisoryConflicts(f)).toBeNull();
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(false);
  });

  it('still refuses another conflicting file alongside additive testing notes', async () => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture({ codeConflict: true, testing: ['# Tests\n', '# Tests\nours\n', '# Tests\ntheirs\n'] });
    assertConflict(f, [TIMINGS, TESTING, 'a.mjs']);
    expect(resolveAdvisoryConflicts(f)).toBeNull();
  });
});

describe('mergeTimingsJson', () => {
  it('unions nested entries, retains both sides changes, and formats sorted unit and soak maps', async () => {
    const { mergeTimingsJson } = await advisory();
    const base = { soak: { stable: 1 }, unit: { stable: 1 }, _doc: DOC, metadata: { base: true } };
    const ours = { soak: { zeta: 3, stable: 1 }, unit: { zeta: 3, stable: 1 }, _doc: DOC,
      metadata: { base: true, ours: { keep: true } } };
    const theirs = { soak: { alpha: 2, stable: 1 }, unit: { alpha: 2, stable: 1 }, _doc: DOC,
      metadata: { base: true, theirs: { keep: true } } };
    const text = mergeTimingsJson(json(base), json(ours), json(theirs));
    expect(JSON.parse(text)).toEqual({
      ...timings({ alpha: 2, stable: 1, zeta: 3 }, { alpha: 2, stable: 1, zeta: 3 }),
      metadata: { base: true, ours: { keep: true }, theirs: { keep: true } },
    });
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).slice(0, 3)).toEqual(['_doc', 'unit', 'soak']);
    expect(Object.keys(parsed.unit)).toEqual(['alpha', 'stable', 'zeta']);
    expect(Object.keys(parsed.soak)).toEqual(['alpha', 'stable', 'zeta']);
    expect(text).toBe(json(parsed));
  });

  it('takes the numeric maximum in either direction at every object depth', async () => {
    const { mergeTimingsJson } = await advisory();
    const base = json(timings({ fast: 1, slow: 1 }, { nested: { seconds: 1 } }));
    const ours = json(timings({ fast: 8, slow: 3 }, { nested: { seconds: 9 } }));
    const theirs = json(timings({ fast: 2, slow: 7 }, { nested: { seconds: 4 } }));
    const expected = json(timings({ fast: 8, slow: 7 }, { nested: { seconds: 9 } }));
    expect(mergeTimingsJson(base, ours, theirs)).toBe(expected);
    expect(mergeTimingsJson(base, theirs, ours)).toBe(expected);
  });

  it.each([0, 1, 2])('returns null for invalid JSON in input %i', async index => {
    const { mergeTimingsJson } = await advisory();
    const inputs = Array(3).fill(json(timings()));
    inputs[index] = '{"unit": invalid}';
    expect(mergeTimingsJson(...inputs)).toBeNull();
  });
});

describe('registry syntax validation', () => {
  it.each(['worktree', 'object database'])(
    'resolves a header union without executing top-level registry code in the %s path', async strategy => {
      const { resolveAdvisoryConflicts, resolveAdvisoryInWorktree } = await advisory();
      // Keep the sentinel outside the resolver's scratch directory so cleanup cannot hide execution.
      const sentinelRoot = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'advisory-no-execution-'));
      roots.push(sentinelRoot);
      const sentinel = join(sentinelRoot, 'registry-executed');
      const indexBase = INDEX_BASE + "import { writeFileSync } from 'node:fs';\n" +
        `writeFileSync(${JSON.stringify(sentinel)}, 'registry executed');\n`;
      const f = fixture({ indexConflict: true, indexBase });
      assertConflict(f, [TIMINGS, INDEX]);
      expect(existsSync(sentinel)).toBe(false);
      const expected = registry(' * ours\n * shared\n * theirs\n', indexBase);
      if (strategy === 'worktree') {
        expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
        expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
        expect(readFileSync(join(f.root, INDEX), 'utf8')).toBe(expected);
        expect(f.ok(['status', '--porcelain=v1'])).toBe('');
      } else {
        const before = snapshot(f);
        const result = resolveAdvisoryConflicts(f);
        assertTree(f, result);
        expect(f.git(['show', `${result.tree}:${INDEX}`]).stdout).toBe(expected);
        expect(snapshot(f)).toEqual(before);
      }
      expect(existsSync(sentinel)).toBe(false);
    });
});

describe('object database advisory resolution', () => {
  it('resolves different unit additions through resolveOverlayConflict without changing the checkout', () => {
    const f = fixture();
    assertConflict(f, [TIMINGS]);
    const before = snapshot(f);
    assertTree(f, resolveOverlayConflict({ ...f, ref: 'theirs' }));
    expect(snapshot(f)).toEqual(before);
  });

  it('resolves a duplicate timing to the maximum through the registered strategy', () => {
    const f = fixture({ duplicate: true });
    assertConflict(f, [TIMINGS]);
    assertTree(f, resolveOverlayConflict({ ...f, ref: 'theirs' }), true);
  });

  it('exports a resolver that builds the merged tree directly', async () => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture();
    assertConflict(f, [TIMINGS]);
    const before = snapshot(f);
    assertTree(f, resolveAdvisoryConflicts(f));
    expect(snapshot(f)).toEqual(before);
  });

  it.each([
    ['mixed timings and code', { codeConflict: true }, [TIMINGS, 'a.mjs']],
    ['code-only', { timingConflict: false, codeConflict: true }, ['a.mjs']],
  ])('refuses %s conflicts through the strategy registry', (_name, options, paths) => {
    const f = fixture(options);
    assertConflict(f, paths);
    const before = snapshot(f);
    const result = resolveOverlayConflict({ ...f, ref: 'theirs' });
    expect(result == null || result.ok === false).toBe(true);
    expect(snapshot(f)).toEqual(before);
  });

  it.each([false, true])('resolves header-only registry unions in the object database (timings conflict: %s)', async timingConflict => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture({ timingConflict, indexConflict: true });
    assertConflict(f, timingConflict ? [TIMINGS, INDEX] : [INDEX]);
    const before = snapshot(f);
    const result = resolveAdvisoryConflicts(f);
    expect(result).toMatchObject({ ok: true, via: 'advisory-merge' });
    expect(f.ok(['show', `${result.tree}:${INDEX}`]) + '\n').toBe(registry(' * ours\n * shared\n * theirs\n'));
    if (timingConflict) assertTree(f, result);
    expect(snapshot(f)).toEqual(before);
  });

  it.each([
    ['closing delimiter', { indexAddition: ' * closes */ comment\n' }],
    ['opening delimiter', { indexAddition: ' * nested /* comment\n' }],
    ['executable addition', { indexAddition: 'export const code = 1;\n' }],
    ['multiplication after the header', {
      indexBase: INDEX_BASE + 'export const value = 2\n * 1;\n',
      indexOurs: INDEX_BASE + 'export const value = 2\n * 3\n * 1;\n',
      indexTheirs: INDEX_BASE + 'export const value = 2\n * 4\n * 1;\n',
    }],
    ['earlier inline header close', { indexBase: '/**\n * Registry. */\n/*\n */\nexport const breaks = [];\n' }],
    ['invalid syntax', { indexBase: INDEX_BASE + 'export const = ;\n' }],
  ])('refuses object database union with %s without changing the checkout', async (_name, options) => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture({ ...options, indexConflict: true });
    assertConflict(f, [TIMINGS, INDEX]);
    const before = snapshot(f);
    expect(resolveAdvisoryConflicts(f)).toBeNull();
    expect(snapshot(f)).toEqual(before);
  });

  it('refuses registry and source conflicts together', async () => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture({ timingConflict: false, indexConflict: true, codeConflict: true });
    assertConflict(f, [INDEX, 'a.mjs']);
    expect(resolveAdvisoryConflicts(f)).toBeNull();
  });

  it('returns null when Git cannot read the merge inputs', async () => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture();
    const before = snapshot(f);
    expect(resolveAdvisoryConflicts({ git: f.git, cur: 'missing-ref', ovSha: f.ovSha })).toBeNull();
    expect(snapshot(f)).toEqual(before);
  });
});

describe('resolveAdvisoryInWorktree', () => {
  it('writes the timings union, stages it and finishes the merge commit', async () => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ duplicate: true });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    expect(f.ok(['diff', '--name-only', '--diff-filter=U'])).toBe(TIMINGS);
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
    const expected = json(timings({ alpha: 2, same: 9, shared: 1, zeta: 3 }));
    expect(readFileSync(join(f.root, TIMINGS), 'utf8')).toBe(expected);
    expect(f.git(['show', `HEAD:${TIMINGS}`]).stdout).toBe(expected);
    expect(f.ok(['status', '--porcelain=v1'])).toBe('');
    expect(f.ok(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1)).toEqual([f.cur, f.ovSha]);
    expect(f.git(['rev-parse', '--verify', 'MERGE_HEAD']).status).not.toBe(0);
  });

  it.each([[2, 0], [0, 2], [2, 1], [1, 2], [2, 3]])(
    'preserves repeated additions within a branch and consumes cross-side matches one-for-one (ours: %i, theirs: %i)',
    async (ours, theirs) => {
      const { resolveAdvisoryInWorktree } = await advisory();
      const f = fixture({ timingConflict: false, indexConflict: true,
        indexOurs: registry(` * ours\n${' * repeated\n'.repeat(ours)}`),
        indexTheirs: registry(` * theirs\n${' * repeated\n'.repeat(theirs)}`) });
      expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
      expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
      expect(readFileSync(join(f.root, INDEX), 'utf8')).toBe(
        registry(` * ours\n${' * repeated\n'.repeat(ours)} * theirs\n${' * repeated\n'.repeat(Math.max(0, theirs - ours))}`));
    });

  it('keeps identical additions at different base gaps', async () => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true,
      indexOurs: INDEX_BASE.replace(' * Registry.\n', ' * repeated\n * Registry.\n * ours\n'),
      indexTheirs: registry(' * theirs\n * repeated\n') });
    assertConflict(f, [TIMINGS, INDEX]);
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
    expect(readFileSync(join(f.root, INDEX), 'utf8')).toBe(registry(' * ours\n * theirs\n * repeated\n',
      INDEX_BASE.replace(' * Registry.\n', ' * repeated\n * Registry.\n')));
  });

  it.each(['*/\n', 'export const code = 1;\n', '\n', ' * nested /* comment\n', ' * closes */ comment\n'])('refuses non-comment or delimiter additions and preserves conflicts: %s', async indexAddition => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true, indexAddition });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    const before = snapshot(f);
    const indexBefore = readFileSync(join(f.root, INDEX), 'utf8');
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(false);
    expect(snapshot(f)).toEqual(before);
    expect(readFileSync(join(f.root, INDEX), 'utf8')).toBe(indexBefore);
  });

  it.each([
    ['after the first header close', INDEX_BASE + 'export const value = 2\nINSERT * 1;\n/**\n * Later.\n */\n', ' * 3\n', ' * 4\n'],
    ['in a multi-line expression without a header', 'export const value = 2\nINSERT * 1;\n', ' * 3\n', ' * 4\n'],
    ['before the header', 'INSERT' + INDEX_BASE, ' * ours\n', ' * theirs\n'],
    ['after an inline header close', '/**\n * Registry. */\n/*\nINSERT */\nexport const breaks = [];\n', ' * ours\n', ' * theirs\n'],
    ['without a closing header line', '/**\n * Registry.\nINSERT', ' * ours\n', ' * theirs\n'],
  ])('refuses comment-looking additions %s and preserves conflicts', async (_name, template, ours, theirs) => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true, indexBase: template.replace('INSERT', ''),
      indexOurs: template.replace('INSERT', ours), indexTheirs: template.replace('INSERT', theirs) });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    const before = snapshot(f);
    const indexBefore = readFileSync(join(f.root, INDEX));
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(false);
    expect(snapshot(f)).toEqual(before);
    expect(readFileSync(join(f.root, INDEX))).toEqual(indexBefore);
  });

  it.each(['export const = ;\n'])(
    'refuses and restores conflicts when the base module has invalid syntax: %s', async code => {
      const { resolveAdvisoryInWorktree } = await advisory();
      const f = fixture({ indexConflict: true, indexBase: INDEX_BASE + code });
      expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
      const before = snapshot(f);
      const indexBefore = readFileSync(join(f.root, INDEX), 'utf8');
      expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(false);
      expect(snapshot(f)).toEqual(before);
      expect(readFileSync(join(f.root, INDEX), 'utf8')).toBe(indexBefore);
    });

  it.each(['add', 'commit', 'remaining conflicts'])(
    'restores both advisory files and the index when %s fails', async failure => {
      const { resolveAdvisoryInWorktree } = await advisory();
      const f = fixture({ indexConflict: true });
      expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
      const before = snapshot(f);
      const indexBefore = readFileSync(join(f.root, INDEX));
      const mergeHead = f.ok(['rev-parse', 'MERGE_HEAD']);
      let diffs = 0;
      const git = args => {
        if (args[0] === failure) {
          // Exercise rollback even after a partially successful staging operation.
          if (failure === 'add') f.git(args);
          return { status: 1, stdout: '' };
        }
        if (args[0] === 'diff' && ++diffs === 2 && failure === 'remaining conflicts') {
          return { status: 1, stdout: '' };
        }
        return f.git(args);
      };
      expect(resolveAdvisoryInWorktree({ git, cwd: f.root })).toBe(false);
      expect(snapshot(f)).toEqual(before);
      expect(readFileSync(join(f.root, INDEX))).toEqual(indexBefore);
      expect(f.ok(['rev-parse', 'MERGE_HEAD'])).toBe(mergeHead);
    });

  it('unions automatic registration header comments from both sides with both advisory files', async () => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true,
      indexOurs: registry(' * foo uses the same automatic registration.\n'),
      indexTheirs: registry(' * bar uses the same automatic registration.\n') });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
    expect(f.ok(['status', '--porcelain=v1'])).toBe('');
    expect(readFileSync(join(f.root, INDEX), 'utf8')).toBe(registry(
      ' * foo uses the same automatic registration.\n * bar uses the same automatic registration.\n'));
  });

  it('accepts a checkout containing an existing symlink', async () => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    symlinkSync('a.mjs', join(f.root, 'existing-link'));
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
    expect(readlinkSync(join(f.root, 'existing-link'))).toBe('a.mjs');
  });

  it('refuses mixed conflicts without changing files, index, HEAD or merge state', async () => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ codeConflict: true });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    expect(f.ok(['diff', '--name-only', '--diff-filter=U']).split('\n').sort()).toEqual([TIMINGS, 'a.mjs'].sort());
    const before = snapshot(f);
    const mergeHead = f.ok(['rev-parse', 'MERGE_HEAD']);
    const mergeMessage = readFileSync(join(f.root, '.git/MERGE_MSG'), 'utf8');
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(false);
    expect(snapshot(f)).toEqual(before);
    expect(f.ok(['rev-parse', 'MERGE_HEAD'])).toBe(mergeHead);
    expect(readFileSync(join(f.root, '.git/MERGE_MSG'), 'utf8')).toBe(mergeMessage);
  });
});
