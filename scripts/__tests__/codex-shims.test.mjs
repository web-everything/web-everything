import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_SHIM_DIR, codexShimPath, buildCodexDirectTaskArgv } from '../codex-direct-task.mjs';

// Fake project with a stub node_modules/.bin/vitest so the shim's pass-through is observable.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  for (const t of ['vitest', 'playwright']) {
    const f = join(dir, 'node_modules/.bin', t);
    writeFileSync(f, `#!/bin/sh\necho REAL-${t} "$@"\n`); chmodSync(f, 0o755);
  }
  return dir;
}
const run = (cmd, args, { held, cwd } = {}) => {
  const env = { ...process.env, PATH: codexShimPath(process.env) };
  delete env.WE_HEAVY_ADMISSION_HELD;
  if (held) env.WE_HEAVY_ADMISSION_HELD = '1';
  return spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
};

describe('codex shims (R650)', () => {
  const cwd = fixture();
  it.each(['vitest', 'playwright'])('refuses bare %s naming heavy-admission', (t) => {
    const r = run(join(CODEX_SHIM_DIR, t), ['--run', 'x'], { cwd });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('node scripts/readiness/heavy-admission.mjs run -- ');
    expect(r.stdout).not.toContain('REAL');
  });
  it('allows with WE_HEAVY_ADMISSION_HELD=1', () => {
    const r = run(join(CODEX_SHIM_DIR, 'vitest'), ['--run', 'x'], { held: true, cwd });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REAL-vitest --run x');
  });
  it('allows --version and --help', () => {
    for (const a of ['--version', '--help']) {
      expect(run(join(CODEX_SHIM_DIR, 'vitest'), [a], { cwd }).stdout).toContain(`REAL-vitest ${a}`);
    }
  });
  it('npx vitest and npx playwright route to the refusing shim', () => {
    for (const t of ['vitest', 'playwright']) {
      const r = run(join(CODEX_SHIM_DIR, 'npx'), [t, 'test'], { cwd });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('REFUSED');
    }
    const ok = run(join(CODEX_SHIM_DIR, 'npx'), ['--yes', 'vitest', '--run'], { held: true, cwd });
    expect(ok.stdout).toContain('REAL-vitest --run');
  });
  it('gates npx --package x vitest, vitest@1 and npm exec; passes unrelated npx through', () => {
    for (const [c, a] of [['npx', ['--package', 'x', 'vitest']], ['npx', ['vitest@1', 'run']], ['npm', ['exec', 'vitest']], ['npx', ['--package=vitest', '--call=vitest run']], ['npm', ['exec', '--', 'playwright', 'test']], ['npm', ['--prefix', '/', 'exec', 'vitest', 'run']]]) {
      expect(run(join(CODEX_SHIM_DIR, c), a, { cwd }).status).toBe(97);
    }
  });
  it('npm subcommands other than exec pass through even if they name vitest', () => {
    const r = run(join(CODEX_SHIM_DIR, 'npm'), ['--version'], { cwd });
    expect(r.status).toBe(0);
    expect(run(join(CODEX_SHIM_DIR, 'npm'), ['view', 'vitest', 'name'], { cwd }).status).not.toBe(97);
  });
  it('npx on an unrelated file named vitest.config.ts passes through', () => {
    expect(run(join(CODEX_SHIM_DIR, 'npx'), ['--version', 'vitest.config.ts'], { cwd }).status).not.toBe(97);
  });
  it('trailing-slash shim PATH entry does not recurse', () => {
    const env = { ...process.env, PATH: `${CODEX_SHIM_DIR}/:${process.env.PATH}` };
    const r = spawnSync(join(CODEX_SHIM_DIR, 'npx'), ['--version'], { cwd, env, encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(0);
  });
  it('PATH resolves the shim first, and argv sets it for non-review runs only', () => {
    expect(codexShimPath({ PATH: '/usr/bin' }).split(':')[0]).toBe(CODEX_SHIM_DIR);
    const base = { route: { model: 'm', effort: 'low' }, cwd: '/x', outputLastMessageFile: '/x/o', env: { PATH: '/usr/bin' } };
    expect(buildCodexDirectTaskArgv(base).join(' ')).toContain(`shell_environment_policy.set.PATH=`);
    expect(buildCodexDirectTaskArgv({ ...base, review: true }).join(' ')).not.toContain('set.PATH');
  });
});
