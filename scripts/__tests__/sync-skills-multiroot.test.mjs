/**
 * @file scripts/__tests__/sync-skills-multiroot.test.mjs
 * @description SK1: sync-skills-deploy takes a LIST of source roots (WE skills-src plus e.g. plateau-ops/skills).
 *   Proves: two fixture roots both deploy; the same skill name in two roots is refused naming BOTH paths;
 *   --check reports an untracked (never-committed) new skill as drift. Each root is a real tmp git repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlans, parseArgs } from '../sync-skills-deploy.mjs';

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
