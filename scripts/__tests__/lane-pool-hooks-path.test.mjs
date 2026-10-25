/**
 * @file lane-pool-hooks-path.test.mjs — every lane points `core.hooksPath` at the tracked `.githooks`, so the
 *   pre-commit guards (incl. the placeholder-author guard) run even when npm `prepare` never did. Audit finding:
 *   `provision --no-install` skips npm, and a `--reference` clone does not inherit `core.hooksPath`.
 *   Real throwaway origin + reference, private LANE_POOL_ROOT (same fixture shape as lane-pool-provision-dry-run).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureLaneHooksPath, LANE_HOOKS_PATH } from '../lib/git-identity.mjs';
import { laneStateSnapshot } from '../lib/lane-history.mjs';
import { cleanLaneLitter } from '../lib/lane-litter.mjs';
import { diagnoseLane } from '../lib/lane-repair.mjs';
import { snapshotWorkTree } from '../lib/lane-salvage.mjs';
import { gitStatusSummary, aheadCommits } from '../lane-whois.mjs';
import { laneGitHardeningEnv } from '../lib/lane-git-hardening.mjs';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('ensureLaneHooksPath (injected IO) — the EFFECTIVE value, every scope', () => {
  const has = () => true;
  const GET = ['config', '--show-scope', '--get', 'core.hooksPath'];
  // A fake git whose config is a scope→value map, resolved worktree > local > global like real git.
  const fakeGit = (cfg) => {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args.join(' ') === GET.join(' ')) {
        for (const sc of ['worktree', 'local', 'global']) if (cfg[sc]) return `${sc}\t${cfg[sc]}\n`;
        throw Object.assign(new Error('exit 1'), { status: 1 });
      }
      if (args[1] === '--local') { cfg.local = args[args.indexOf('core.hooksPath') + 1]; return ''; }
      if (args[1] === '--worktree' && args[2] === '--unset-all') { delete cfg.worktree; return ''; }
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    return { run, calls, cfg };
  };
  it('sets it when unset, and logs', () => {
    const g = fakeGit({});
    const logs = [];
    expect(ensureLaneHooksPath('/l', { exists: has, runnable: has, run: g.run, log: (l) => logs.push(l) })).toMatchObject({ status: 'set', was: null });
    expect(g.cfg.local).toBe(LANE_HOOKS_PATH);
    expect(logs[0]).toMatch(/core\.hooksPath \(unset\) → \.githooks/);
  });
  it('is idempotent: effective .githooks → no write', () => {
    const g = fakeGit({ local: '.githooks' });
    expect(ensureLaneHooksPath('/l', { exists: has, runnable: has, run: g.run }).status).toBe('ok');
    expect(g.calls).toHaveLength(1);
  });
  it('a WORKTREE /dev/null override beating a correct local value is flagged and repaired', () => {
    const g = fakeGit({ local: '.githooks', worktree: '/dev/null' });
    expect(ensureLaneHooksPath('/l', { exists: has, runnable: has, run: g.run, write: false })).toMatchObject({ status: 'override', scope: 'worktree' });
    expect(ensureLaneHooksPath('/l', { exists: has, runnable: has, run: g.run })).toMatchObject({ status: 'set', was: '/dev/null', scope: 'worktree' });
    expect(g.cfg.worktree).toBeUndefined();
  });
  it('an override the repair cannot remove (a higher scope, e.g. command) → override, logged', () => {
    const stubborn = { run: (args) => (args.join(' ') === GET.join(' ') ? 'command\t/dev/null\n' : ''), };
    const logs = [];
    expect(ensureLaneHooksPath('/l', { exists: has, runnable: has, run: stubborn.run, log: (l) => logs.push(l) })).toMatchObject({ status: 'override', scope: 'command' });
    expect(logs[0]).toMatch(/still \/dev\/null/);
  });
  it('write:false only reports', () => {
    const g = fakeGit({});
    expect(ensureLaneHooksPath('/l', { exists: has, runnable: has, run: g.run, write: false }).status).toBe('unset');
    expect(g.calls).toHaveLength(1);
  });
  it('a checkout that does not track .githooks/pre-commit is skipped', () => {
    const untracked = () => { throw Object.assign(new Error('did not match any file'), { status: 1 }); };
    expect(ensureLaneHooksPath('/l', { exists: () => false, run: untracked }).status).toBe('skipped');
  });
  it('a TRACKED pre-commit that is missing (deleted / dangling symlink) is an error, not skipped', () => {
    const logs = [];
    const result = ensureLaneHooksPath('/l', { exists: () => false, run: () => '.githooks/pre-commit\n', log: (l) => logs.push(l) });
    expect(result).toMatchObject({ status: 'error' });
    expect(result.detail).toMatch(/tracked but missing/);
  });
  it('a failing tracked-check (not exit 1) is an error, never skipped', () => {
    const boom = () => { throw Object.assign(new Error('not a git repository'), { status: 128 }); };
    expect(ensureLaneHooksPath('/l', { exists: () => false, run: boom, log: () => {} }).status).toBe('error');
  });
});

describe('provision --no-install sets core.hooksPath in the lane (real git)', () => {
  let base, originDir, referenceDir, env;
  const runPool = (args) => {
    const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env, timeout: 60_000, killSignal: 'SIGKILL' });
    return { code: r.status ?? 1, err: String(r.stderr || '') };
  };
  const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=hookspath', '--branch=main', '--no-install'];

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'lane-pool-hooks-path-'));
    originDir = join(base, 'origin.git');
    referenceDir = join(base, 'reference');
    git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
    git(['clone', '--quiet', originDir, referenceDir]);
    git(['config', 'user.name', 'Fixture Author'], referenceDir);
    git(['config', 'user.email', 'fixture@realcorp.io'], referenceDir);
    mkdirSync(join(referenceDir, '.githooks'));
    writeFileSync(join(referenceDir, '.githooks/pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(referenceDir, '.githooks/pre-commit'), 0o755);
    git(['add', '.githooks/pre-commit'], referenceDir);
    git(['commit', '--quiet', '-m', 'v1'], referenceDir);
    git(['push', '--quiet', 'origin', 'main'], referenceDir);
    env = { ...process.env, LANE_POOL_ROOT: join(base, 'pool'), HOME: base };
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('a fresh --reference clone gets .githooks, and a re-provision leaves it (idempotent)', () => {
    const r = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(r.code).toBe(0);
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    expect(git(['config', '--local', '--get', 'core.hooksPath'], lane)).toBe('.githooks');
    expect(r.err).toMatch(/core\.hooksPath \(unset\) → \.githooks/);
    const again = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(again.code).toBe(0);
    expect(again.err).not.toMatch(/core\.hooksPath .* → /);
    expect(git(['config', '--local', '--get', 'core.hooksPath'], lane)).toBe('.githooks');
  });

  it('a real WORKTREE-scope core.hooksPath=/dev/null is reported by status and repaired by provision', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    git(['config', '--local', 'extensions.worktreeConfig', 'true'], lane);
    git(['config', '--worktree', 'core.hooksPath', '/dev/null'], lane);
    expect(git(['config', '--get', 'core.hooksPath'], lane)).toBe('/dev/null');
    expect(runPool(['status', ...poolArgs()]).err).toMatch(/pre-commit guards are not verified in 1 lane\(s\) \(lane-1\)/);
    expect(git(['config', '--get', 'core.hooksPath'], lane)).toBe('/dev/null'); // status wrote nothing
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    expect(git(['config', '--get', 'core.hooksPath'], lane)).toBe('.githooks');
  });

  it('status reports a lane whose hooksPath was unset, without writing', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    git(['config', '--local', '--unset', 'core.hooksPath'], lane);
    const r = runPool(['status', ...poolArgs()]);
    expect(r.err).toMatch(/pre-commit guards are not verified in 1 lane\(s\) \(lane-1\)/);
    expect(() => git(['config', '--local', '--get', 'core.hooksPath'], lane)).toThrow();
  });

  it('repairs duplicate local hooksPath values instead of silently leaving guards disabled', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    git(['config', '--local', '--add', 'core.hooksPath', '/dev/null'], lane);
    git(['config', '--local', '--add', 'core.hooksPath', '/other-hooks'], lane);
    const r = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(git(['config', '--local', '--get-all', 'core.hooksPath'], lane)).toBe('.githooks');
    expect(r.err).toMatch(/lane pre-commit guards now run/);
  });

  it('reports a real config lock failure without claiming that guards were repaired', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    git(['config', '--local', 'core.hooksPath', '/dev/null'], lane);
    const lock = join(lane, '.git', 'config.lock');
    writeFileSync(lock, 'held');
    const logs = [];
    try {
      expect(ensureLaneHooksPath(lane, { log: (line) => logs.push(line) }).status).toBe('error');
      expect(logs.join('\n')).toMatch(/core\.hooksPath could not be verified or repaired.*pre-commit guards/);
      expect(git(['config', '--get', 'core.hooksPath'], lane)).toBe('/dev/null');
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it('a re-provision (fetch + reset + clean) runs no lane-set fsmonitor or hook, then repairs hooksPath (PR #5775)', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    const marker = join(base, 'lane-config-ran');
    const evil = join(base, 'evil-hooks');
    mkdirSync(evil, { recursive: true });
    const script = join(evil, 'marker.sh');
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\n`);
    chmodSync(script, 0o755);
    for (const h of ['post-checkout', 'reference-transaction', 'post-merge']) {
      writeFileSync(join(evil, h), `#!/bin/sh\necho "${h}" >> "${marker}"\n`);
      chmodSync(join(evil, h), 0o755);
    }
    git(['config', '--local', 'core.fsmonitor', script], lane);
    // A `--reference` lane has alternates, so its fetch runs a lane-set alternateRefsCommand (PR #5775 self-review).
    git(['config', '--local', 'core.alternateRefsCommand', script], lane);
    git(['config', '--local', '--replace-all', 'core.hooksPath', evil], lane);
    try {
      expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
      expect(git(['config', '--get', 'core.hooksPath'], lane)).toBe('.githooks');
      expect(git(['rev-parse', 'origin/main'], lane)).toBe(git(['rev-parse', 'main'], originDir));
    } finally {
      git(['config', '--local', '--unset', 'core.fsmonitor'], lane);
      git(['config', '--local', '--unset', 'core.alternateRefsCommand'], lane);
    }
  });

  it('the lane libs lane-pool calls (history snapshot, litter, repair probe, salvage, whois) run no lane-set fsmonitor (PR #5775)', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    const marker = join(base, 'lib-fsmonitor-ran');
    const script = join(base, 'lib-marker.sh');
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\n`);
    chmodSync(script, 0o755);
    git(['config', '--local', 'core.fsmonitor', script], lane);
    writeFileSync(join(lane, 'untracked-wip.txt'), 'dirty\n'); // dirty, so salvage stages and writes a wip tree
    const refs = { head: 'refs/salvage/fsmon/head', wip: 'refs/salvage/fsmon/wip' };
    try {
      expect(laneStateSnapshot(lane, 'origin/main').dirty).toBe(1);
      expect(gitStatusSummary(lane)).not.toBeNull();
      expect(diagnoseLane(lane).ok).toBe(true);
      cleanLaneLitter(lane);
      expect(snapshotWorkTree(lane, { refs, branchRef: 'origin/main' }).wipSha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
    } finally {
      git(['config', '--local', '--unset', 'core.fsmonitor'], lane);
      rmSync(join(lane, 'untracked-wip.txt'), { force: true });
      for (const r of Object.values(refs)) spawnSync('git', ['update-ref', '-d', r], { cwd: lane });
    }
  });

  it('a lane-set log.showSignature + gpg.program never runs on a "signed" ahead commit, and no lazy fetch is allowed (PR #5775)', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    const marker = join(base, 'gpg-ran');
    const script = join(base, 'gpg.sh');
    writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 1\n`);
    chmodSync(script, 0o755);
    const head = git(['rev-parse', 'HEAD'], lane);
    const tree = git(['rev-parse', 'HEAD^{tree}'], lane);
    const who = 'A <a@realcorp.io> 1700000000 +0000';
    const body = `tree ${tree}\nparent ${head}\nauthor ${who}\ncommitter ${who}\ngpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----\n\nsigned ahead\n`;
    const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: lane, input: body, encoding: 'utf8' }).trim();
    git(['update-ref', 'refs/heads/main', signed], lane);
    git(['config', '--local', 'log.showSignature', 'true'], lane);
    git(['config', '--local', 'gpg.program', script], lane);
    try {
      expect(aheadCommits(lane, 'origin/main')).toEqual([expect.objectContaining({ sha: signed, subject: 'signed ahead' })]);
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
      expect(laneGitHardeningEnv({}).GIT_NO_LAZY_FETCH).toBe('1');
    } finally {
      git(['config', '--local', '--unset', 'log.showSignature'], lane);
      git(['config', '--local', '--unset', 'gpg.program'], lane);
      git(['update-ref', 'refs/heads/main', head], lane);
    }
  });

  it('a re-provision fetch runs no lane-set uploadpack, and scrubs lane-set transport commands first (PR #5775)', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    const marker = join(base, 'uploadpack-ran');
    const script = join(base, 'uploadpack.sh');
    // Execs the real upload-pack, so a fetch that DID run it still succeeds: only the marker tells.
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\nexec git-upload-pack "$@"\n`);
    chmodSync(script, 0o755);
    git(['config', '--local', 'remote.origin.uploadpack', script], lane);
    git(['config', '--local', 'protocol.ext.allow', 'always'], lane);
    git(['config', '--local', 'credential.helper', `!${script}`], lane);
    try {
      expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
      expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
      expect(() => git(['config', '--local', '--get', 'protocol.ext.allow'], lane)).toThrow();
      expect(() => git(['config', '--local', '--get', 'credential.helper'], lane)).toThrow();
    } finally {
      git(['config', '--local', '--unset-all', 'remote.origin.uploadpack'], lane);
    }
  });

  it('status flags a lane whose hooksPath is correct but whose pre-commit git would ignore (not executable)', () => {
    const lane = join(base, 'pool', 'hookspath', 'lane-1');
    git(['config', '--local', '--replace-all', 'core.hooksPath', '.githooks'], lane);
    chmodSync(join(lane, '.githooks/pre-commit'), 0o644);
    try {
      const r = runPool(['status', ...poolArgs()]);
      expect(r.err).toMatch(/pre-commit is not executable/);
      expect(r.err).toMatch(/pre-commit guards are not verified in 1 lane\(s\) \(lane-1\)/);
    } finally {
      chmodSync(join(lane, '.githooks/pre-commit'), 0o755);
    }
  });
});
