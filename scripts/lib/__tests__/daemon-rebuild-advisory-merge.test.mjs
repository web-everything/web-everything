import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const DOC = 'Measured seconds per test file.';
const json = value => `${JSON.stringify(value, null, 1)}\n`;
const timings = (unit = {}, soak = {}) => ({ _doc: DOC, unit, soak });
const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ timingConflict = true, codeConflict = false, duplicate = false, indexConflict = false, indexAddition = "// theirs\n" } = {}) {
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
  write(INDEX, 'export const breaks = [];\n');
  write('a.mjs', 'export const value = "base";\n');
  commit('base');
  ok(['checkout', '-q', '-b', 'ours']);
  if (timingConflict) write(TIMINGS, json(timings({ shared: 1, zeta: 3, ...(duplicate ? { same: 9 } : {}) })));
  if (codeConflict) write('a.mjs', 'export const value = "ours";\n');
  if (indexConflict) write(INDEX, 'export const breaks = [];\n// ours\n// shared\n');
  write('ours-only.txt', 'keep ours\n');
  const cur = commit('ours');
  ok(['checkout', '-q', '-b', 'theirs', 'base']);
  if (timingConflict) write(TIMINGS, json(timings({ shared: 1, alpha: 2, ...(duplicate ? { same: 4 } : {}) })));
  if (codeConflict) write('a.mjs', 'export const value = "theirs";\n');
  if (indexConflict) write(INDEX, `export const breaks = [];\n${indexAddition}// shared\n`);
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
    expect(ADVISORY_MERGE_PATHS).toEqual([TIMINGS, INDEX]);
    expect(Object.isFrozen(ADVISORY_MERGE_PATHS)).toBe(true);
  });

  it('registers the advisory-merge strategy', () => {
    expect(OVERLAY_CONFLICT_STRATEGIES.filter(s => s.name === 'advisory-merge')).toHaveLength(1);
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

  it.each([false, true])('unions registry comments and imports the result (timings conflict: %s)', async timingConflict => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture({ timingConflict, indexConflict: true });
    assertConflict(f, timingConflict ? [TIMINGS, INDEX] : [INDEX]);
    const before = snapshot(f);
    const result = resolveAdvisoryConflicts(f);
    expect(result?.ok).toBe(true);
    if (timingConflict) assertTree(f, result);
    const text = f.ok(['show', `${result.tree}:${INDEX}`]);
    expect(text).toContain('// ours');
    expect(text).toContain('// theirs');
    expect(text.match(/\/\/ shared/g)).toHaveLength(1);
    const modulePath = join(f.root, 'merged.mjs');
    writeFileSync(modulePath, text);
    expect(spawnSync(process.execPath, [modulePath], { timeout: 5000 }).status).toBe(0);
    rmSync(modulePath);
    expect(snapshot(f)).toEqual(before);
  });

  it('refuses registry and source conflicts together', async () => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture({ timingConflict: false, indexConflict: true, codeConflict: true });
    assertConflict(f, [INDEX, 'a.mjs']);
    expect(resolveAdvisoryConflicts(f)).toBeNull();
  });

  it('refuses the entire advisory set when the registry union has invalid syntax', async () => {
    const { resolveAdvisoryConflicts } = await advisory();
    const f = fixture({ indexConflict: true, indexAddition: 'export const = ;\n' });
    assertConflict(f, [TIMINGS, INDEX]);
    const before = snapshot(f);
    expect(resolveAdvisoryConflicts(f)).toBeNull();
    expect(snapshot(f)).toEqual(before);
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

  it.each(['export const = ;\n', "import './missing.mjs';\n", '<<<<<<< ours\n'])('refuses and restores all conflicts when registry validation fails: %s', async indexAddition => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true, indexAddition });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    const before = snapshot(f);
    const indexBefore = readFileSync(join(f.root, INDEX), 'utf8');
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(false);
    expect(snapshot(f)).toEqual(before);
    expect(readFileSync(join(f.root, INDEX), 'utf8')).toBe(indexBefore);
  });

  it('refuses a registry import that exceeds the validation timeout', async () => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ timingConflict: false, indexConflict: true,
      indexAddition: "await import('node:timers/promises').then(({ setTimeout }) => setTimeout(60_000));\n" });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(false);
    expect(f.ok(['diff', '--name-only', '--diff-filter=U'])).toBe(INDEX);
  }, 15_000);

  it('resolves both advisory files together in a worktree', async () => {
    const { resolveAdvisoryInWorktree } = await advisory();
    const f = fixture({ indexConflict: true });
    expect(f.git(['merge', '--no-edit', f.ovSha]).status).toBe(1);
    expect(resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
    expect(f.ok(['status', '--porcelain=v1'])).toBe('');
    expect(readFileSync(join(f.root, INDEX), 'utf8')).toContain('// theirs');
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
