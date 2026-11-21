/**
 * @file scripts/__tests__/sync-skills-multiroot.test.mjs
 * @description SK1: sync-skills-deploy takes a LIST of source roots (WE skills-src plus e.g. plateau-ops/skills).
 *   Proves: two fixture roots both deploy; the same skill name in two roots is refused naming BOTH paths;
 *   --check reports an untracked (never-committed) new skill as drift. Each root is a real tmp git repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlans, parseArgs } from '../sync-skills-deploy.mjs';
import * as skillsSync from '../sync-skills-deploy.mjs';

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'sync-skills-deploy.mjs');
let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sync-multiroot-')); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

function gitRepoWithSkills(name, skills, { commit = true } = {}) {
  const repo = join(tmp, name);
  const root = join(repo, 'skills');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  for (const s of skills) {
    mkdirSync(join(root, s), { recursive: true });
    writeFileSync(join(root, s, 'SKILL.md'), `# ${s}\n`);
  }
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  }
  return { repo, root };
}

// Never inherit developer root overrides or a real home in CLI fixtures.
function runCli(args, overrides = {}) {
  const env = { ...process.env, HOME: join(tmp, 'home'), WE_SKILLS_DEPLOY_DIR: join(tmp, 'dest'), ...overrides };
  delete env.WE_SKILLS_EXTRA_ROOTS;
  delete env.WE_SKILLS_SRC_ROOT;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [MODULE_PATH, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

describe('resolveRoots branch contract', () => {
  it('selects the repository source and the exact default ops root when present', () => {
    const home = join(tmp, 'home');
    const ops = join(home, 'workspace', 'plateau-ops', 'skills');
    expect(skillsSync.resolveRoots({}, parseArgs([]), home, () => true))
      .toEqual({ srcRoot: skillsSync.SRC_ROOT, extraRoots: [ops] });
  });

  it('skips an absent optional default ops root', () => {
    expect(skillsSync.resolveRoots({}, parseArgs([]), tmp, (p) => p === skillsSync.SRC_ROOT))
      .toEqual({ srcRoot: skillsSync.SRC_ROOT, extraRoots: [] });
  });

  it('excludes the default ops root when WE_SKILLS_SRC_ROOT is set', () => {
    expect(skillsSync.resolveRoots({ WE_SKILLS_SRC_ROOT: './fixture' }, parseArgs([]), tmp, () => true))
      .toEqual({ srcRoot: resolve('./fixture'), extraRoots: [] });
  });

  it('combines path-delimited env roots and repeatable CLI roots, removing exact duplicates', () => {
    const env = { WE_SKILLS_SRC_ROOT: tmp, WE_SKILLS_EXTRA_ROOTS: ['/env-a', '', '/env-b'].join(delimiter) };
    expect(skillsSync.resolveRoots(env, parseArgs(['--root=/env-a', '--root=/cli']), tmp, () => true))
      .toEqual({ srcRoot: tmp, extraRoots: ['/env-a', '/env-b', '/cli'] });
  });

  it('refuses a missing primary root before planning', () => {
    expect(() => skillsSync.resolveRoots({ WE_SKILLS_SRC_ROOT: tmp }, parseArgs([]), tmp, () => false))
      .toThrow(`sync-skills-deploy: missing skills-src at ${tmp}`);
  });

  it.each(['env', 'CLI'])('refuses a missing explicit %s root', (kind) => {
    const missing = join(tmp, 'missing');
    const env = kind === 'env' ? { WE_SKILLS_EXTRA_ROOTS: missing } : {};
    const args = parseArgs(kind === 'CLI' ? [`--root=${missing}`] : []);
    expect(() => skillsSync.resolveRoots(env, args, tmp, (p) => p !== missing))
      .toThrow(`sync-skills-deploy: source root(s) not found: ${missing}`);
  });
});

describe('default roots and fail-closed CLI wiring', () => {
  it('discovers the default HOME/workspace/plateau-ops/skills root when present', () => {
    gitRepoWithSkills('home/workspace/plateau-ops', ['ops-probe']);
    const r = runCli(['--check', '--all', '--json', '--only=ops-probe']);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({ checked: 1, drifted: 1, skills: [{ name: 'ops-probe' }] });
    expect(existsSync(join(tmp, 'dest', 'ops-probe'))).toBe(false);
  });

  it('skips the default ops root when absent without attempting Git discovery there', () => {
    const r = runCli(['--check', '--json', '--only=']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, checked: 0, skills: [] });
  });

  it('suppresses an existing default ops root when WE_SKILLS_SRC_ROOT is set', () => {
    gitRepoWithSkills('home/workspace/plateau-ops', ['alpha']);
    const primary = gitRepoWithSkills('we', ['alpha']);
    const r = runCli(['--all', '--check', '--json'], { WE_SKILLS_SRC_ROOT: primary.root });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({ checked: 1, skills: [{ name: 'alpha' }] });
  });

  it('refuses a missing WE_SKILLS_EXTRA_ROOTS entry before deploying anything', () => {
    const primary = gitRepoWithSkills('we', ['alpha']);
    const missing = join(tmp, 'missing');
    const r = runCli(['--all'], { WE_SKILLS_SRC_ROOT: primary.root, WE_SKILLS_EXTRA_ROOTS: missing });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(`sync-skills-deploy: source root(s) not found: ${missing}`);
    expect(existsSync(join(tmp, 'dest'))).toBe(false);
  });

  it.each(['env', 'CLI'])('refuses a non-Git extra root supplied by %s before deploying anything', (kind) => {
    const primary = gitRepoWithSkills('we', ['alpha']);
    const extra = join(tmp, 'non-git');
    mkdirSync(extra);
    const r = runCli(['--all', ...(kind === 'CLI' ? [`--root=${extra}`] : [])], {
      WE_SKILLS_SRC_ROOT: primary.root,
      ...(kind === 'env' ? { WE_SKILLS_EXTRA_ROOTS: extra } : {}),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`sync-skills-deploy: extra root "${extra}" is not inside a git repo; refusing`);
    expect(existsSync(join(tmp, 'dest'))).toBe(false);
  });
});

describe('untracked skills CLI contract in every mode', () => {
  it.each([
    { flags: [], exit: 0, applied: true },
    { flags: ['--all'], exit: 0, applied: true },
    { flags: ['--only=fresh'], exit: 0, applied: true },
    { flags: ['--all', '--prune'], exit: 0, applied: true },
    { flags: ['--all', '--dry-run'], exit: 0, applied: false },
    { flags: ['--all', '--check'], exit: 1, applied: false },
  ])('$flags reports ok:false and never deploys or prunes an untracked skill (exit $exit)', ({ flags, exit, applied }) => {
    const primary = gitRepoWithSkills('we', ['alpha']);
    mkdirSync(join(primary.root, 'fresh'));
    writeFileSync(join(primary.root, 'fresh', 'SKILL.md'), '# fresh\n');
    const dest = join(tmp, 'dest');
    // An existing operator file must survive even --prune; a fresh SKILL.md must never be copied.
    mkdirSync(join(dest, 'fresh'), { recursive: true });
    writeFileSync(join(dest, 'fresh', 'mine.md'), 'operator notes');
    const env = { WE_SKILLS_SRC_ROOT: primary.root };
    const r = runCli([...flags, '--json'], env);
    expect(r.status).toBe(exit);
    expect(r.stderr).toBe('');
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ ok: false, untrackedSkills: ['fresh'], applied });
    expect(report.skills.find((s) => s.name === 'fresh')).toMatchObject({ untracked: true, actions: [], stale: [] });
    expect(existsSync(join(dest, 'fresh', 'SKILL.md'))).toBe(false);
    expect(readFileSync(join(dest, 'fresh', 'mine.md'), 'utf8')).toBe('operator notes');
    if (flags.includes('--all')) expect(existsSync(join(dest, 'alpha', 'SKILL.md'))).toBe(applied);
    const text = runCli(flags, env);
    expect(text.status).toBe(exit);
    expect(text.stdout).toContain('UNTRACKED fresh');
    expect(existsSync(join(dest, 'fresh', 'SKILL.md'))).toBe(false);
    expect(readFileSync(join(dest, 'fresh', 'mine.md'), 'utf8')).toBe('operator notes');
  });

  it('reports ok:true and an empty untrackedSkills list after a tracked-only sync', () => {
    const primary = gitRepoWithSkills('we', ['alpha']);
    const r = runCli(['--all', '--json'], { WE_SKILLS_SRC_ROOT: primary.root });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, untrackedSkills: [], applied: true });
    expect(readFileSync(join(tmp, 'dest', 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n');
  });
});

describe('multi-root source list', () => {
  it('parseArgs accepts repeatable --root=<dir>', () => {
    expect(parseArgs(['--root=/a', '--root=/b']).roots).toEqual(['/a', '/b']);
  });

  it('deploys skills from both roots', () => {
    const a = gitRepoWithSkills('we', ['alpha']);
    const b = gitRepoWithSkills('ops', ['beta']);
    const dest = join(tmp, 'dest');
    const plans = buildPlans({ srcRoot: a.root, extraRoots: [b.root], destRoot: dest, all: true });
    expect(plans.map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
    expect(plans.every((p) => p.actions.length === 1)).toBe(true);
  });

  it('CLI deploys from both roots; a missing explicit root errors', () => {
    const a = gitRepoWithSkills('we', ['alpha']);
    const b = gitRepoWithSkills('ops', ['beta']);
    const dest = join(tmp, 'dest');
    const env = { ...process.env, WE_SKILLS_DEPLOY_DIR: dest, WE_SKILLS_SRC_ROOT: a.root };
    const ok = spawnSync(process.execPath, [MODULE_PATH, '--all', `--root=${b.root}`], { env, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(existsSync(join(dest, 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'beta', 'SKILL.md'))).toBe(true);
    const bad = spawnSync(process.execPath, [MODULE_PATH, '--check', `--root=${join(tmp, 'nope')}`], { env, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/not found/);
  });

  it('refuses a duplicate name and names both paths', () => {
    const a = gitRepoWithSkills('we', ['dup']);
    const b = gitRepoWithSkills('ops', ['dup']);
    expect(() => buildPlans({ srcRoot: a.root, extraRoots: [b.root], destRoot: join(tmp, 'dest'), all: true }))
      .toThrow(new RegExp(`${join(a.root, 'dup').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*${join(b.root, 'dup').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('--check exits 1 and names an untracked new skill', () => {
    const a = gitRepoWithSkills('we', ['alpha']);
    mkdirSync(join(a.root, 'fresh'));
    writeFileSync(join(a.root, 'fresh', 'SKILL.md'), '# fresh\n');
    const dest = join(tmp, 'dest');
    mkdirSync(join(dest, 'alpha'), { recursive: true });
    writeFileSync(join(dest, 'alpha', 'SKILL.md'), '# alpha\n');
    const plans = buildPlans({ srcRoot: a.root, destRoot: dest });
    expect(plans.find((p) => p.name === 'fresh')?.untracked).toBe(true);
    // CLI path: the real script, source roots overridden by env so it never reads the live repo.
    const r = spawnSync(process.execPath, [MODULE_PATH, '--check'], {
      env: { ...process.env, WE_SKILLS_DEPLOY_DIR: dest, WE_SKILLS_SRC_ROOT: a.root },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/UNTRACKED fresh/);
    expect(existsSync(join(dest, 'fresh'))).toBe(false);
  });
});
