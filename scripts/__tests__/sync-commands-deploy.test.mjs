/**
 * @file sync-commands-deploy.test.mjs — slash commands reach the machine-global tree the same way skills do,
 *   and the operator's own files in that tree survive it. Pure over tmp dirs + injected probes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCommandsPlan, deployRoot } from '../sync-commands-deploy.mjs';
import { applyPlan } from '../sync-skills-deploy.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-deploy-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('deployRoot', () => {
  it('defaults to the machine-global commands tree, one directory over from skills', () => {
    expect(deployRoot({})).toBe(path.join(os.homedir(), '.claude', 'commands'));
  });

  it('honours the override so a test or a non-default layout never writes to the real home', () => {
    expect(deployRoot({ WE_COMMANDS_DEPLOY_DIR: '/tmp/elsewhere' })).toBe('/tmp/elsewhere');
  });
});

describe('buildCommandsPlan', () => {
  // Conservative in the same way the skills deploy is: never CREATE a machine-global tree on a machine that
  // has chosen not to have one. `--all` is the deliberate bootstrap.
  it('returns no plan when the operator has no commands tree and --all was not passed', () => {
    expect(buildCommandsPlan({ destRoot: '/nope', all: false, exists: (p) => p !== '/nope' })).toBeNull();
  });

  it('refuses to run at all when the source is missing, rather than deploying nothing quietly', () => {
    expect(() => buildCommandsPlan({ srcRoot: '/gone', destRoot: tmp, exists: () => false }))
      .toThrow(/missing commands/);
  });

  it('plans one unit whose files sit flat, not a directory per unit', () => {
    const plan = buildCommandsPlan({ destRoot: tmp, all: true });
    expect(plan.name).toBe('commands');
    expect(plan.actions.every((a) => !a.rel.includes(path.sep))).toBe(true);
    expect(plan.actions.length).toBeGreaterThan(0);
  });

  // The containment check must anchor on the operator's real tree. Here the unit's dir IS the deploy root,
  // which is exactly why destRoot must be passed rather than defaulted per-unit.
  it('anchors containment on the deploy root itself', () => {
    const plan = buildCommandsPlan({ destRoot: tmp, all: true });
    expect(plan.destRoot).toBe(tmp);
    expect(plan.destDir).toBe(tmp);
  });
});

describe('deploying', () => {
  it('copies every tracked command, then reports no drift on a re-run', () => {
    applyPlan(buildCommandsPlan({ destRoot: tmp, all: true }));
    expect(fs.readdirSync(tmp).length).toBeGreaterThan(0);
    expect(buildCommandsPlan({ destRoot: tmp, all: true }).actions).toHaveLength(0);
  });

  it('re-copies a command the operator edited at the deploy target', () => {
    applyPlan(buildCommandsPlan({ destRoot: tmp, all: true }));
    const victim = fs.readdirSync(tmp)[0];
    fs.appendFileSync(path.join(tmp, victim), '\ndrifted\n');
    const plan = buildCommandsPlan({ destRoot: tmp, all: true });
    expect(plan.actions).toEqual([{ type: 'update', rel: victim }]);
  });

  // THE reason this deploys by copy rather than by symlinking ~/.claude/commands at the repo: a symlinked
  // directory cannot also hold the operator's own commands. Theirs must survive, and be reported, not deleted.
  it("reports the operator's own command as stale and leaves it on disk", () => {
    applyPlan(buildCommandsPlan({ destRoot: tmp, all: true }));
    fs.writeFileSync(path.join(tmp, 'my-own.md'), 'mine');
    const plan = buildCommandsPlan({ destRoot: tmp, all: true });
    expect(plan.stale).toContain('my-own.md');
    expect(plan.actions.some((a) => a.type === 'remove')).toBe(false);
    applyPlan(plan);
    expect(fs.existsSync(path.join(tmp, 'my-own.md'))).toBe(true);
  });

  it('removes it only when prune is asked for explicitly', () => {
    applyPlan(buildCommandsPlan({ destRoot: tmp, all: true }));
    fs.writeFileSync(path.join(tmp, 'my-own.md'), 'mine');
    applyPlan(buildCommandsPlan({ destRoot: tmp, all: true, prune: true }));
    expect(fs.existsSync(path.join(tmp, 'my-own.md'))).toBe(false);
  });
});

// #3767 — the REAL mechanism: run the CLI itself (not the plan builder) against a scratch deploy dir through
// the WE_COMMANDS_DEPLOY_DIR override, exactly as `npm run bootstrap` and the operator's `--check` do. This is
// the check that catches a hand-edited deployed command BEFORE a deploy would overwrite it.
describe('--check on the real CLI against a scratch deploy dir (#3767)', () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync-commands-deploy.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WE_COMMANDS_DEPLOY_DIR: tmp },
    timeout: 20_000,
  });

  it.each([
    { roots: ['--root=/extra'] },
    { roots: ['--root='] },
    { roots: ['--root=/a', '--root=/b'] },
  ])(
    'rejects unsupported --root arguments ($roots) before deploying', ({ roots }) => {
      const r = run('--all', ...roots);
      expect(r.status).toBe(2);
      expect(r.stderr.trim()).toBe('Error: sync-commands-deploy: --root is not supported (single source root)');
      expect(r.stdout).toBe('');
      expect(fs.readdirSync(tmp)).toEqual([]);
    },
  );

  it('exits 0 and reports nothing once the deploy target equals the source', () => {
    expect(run('--all').status).toBe(0);
    const r = run('--check');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/DRIFT|STALE/);
  });

  it('exits 1 and names the hand-edited command; --check itself writes nothing', () => {
    run('--all');
    const victim = fs.readdirSync(tmp)[0];
    const file = path.join(tmp, victim);
    fs.appendFileSync(file, '\nhand edit\n');
    const edited = fs.readFileSync(file, 'utf8');
    const r = run('--check');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/DRIFT/);
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);
  });

  it('exits 1 with a STALE line for a deployed command the source does not track, and deletes nothing', () => {
    run('--all');
    fs.writeFileSync(path.join(tmp, 'untracked.md'), 'mine');
    const r = run('--check');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/STALE commands: 1 file\(s\).*untracked\.md/);
    expect(fs.existsSync(path.join(tmp, 'untracked.md'))).toBe(true);
  });
});
