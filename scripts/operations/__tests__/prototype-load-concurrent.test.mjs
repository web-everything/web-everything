import { expect, it, vi } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrototypeLoader } from '../prototype-load-io.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

// Keep the real CI reader, with transport and throttling state fully hermetic.
vi.mock('../../lib/gh-throttle.mjs', () => ({
  execFileSyncThrottled: (command, args, options) => options.throttle.exec(args, options),
}));

it('concurrent loads keep daemon repository contexts isolated', async () => {
  const weRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const home = join(dirname(weRepo), 'prototype-load-test-home');
  const workspace = join(home, 'workspace');
  const plateauRepo = join(workspace, 'plateau-app');
  const weSha = 'a'.repeat(40), plateauSha = 'b'.repeat(40), base = 'c'.repeat(40);
  const heads = new Map([[weRepo, weSha], [plateauRepo, plateauSha]]);
  const slugs = new Map([[weRepo, 'example/web-everything'], [plateauRepo, 'example/plateau-app']]);
  const calls = [];
  let phase = 'we-before-pause';
  let releaseSmoke, enteredSmoke;
  const held = new Promise((done) => { releaseSmoke = done; });
  const entered = new Promise((done) => { enteredSmoke = done; });
  const missing = () => { throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); };
  const audit = (head) => ({ head, base, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED',
    at: '2026-10-20T12:00:00Z', findings: [] });
  const load = createPrototypeLoader({
    env: { HOME: home }, now: () => 0, sleep: async () => {},
    settings: {
      workspaceRoot: workspace,
      daemons: { review: { clone: 'we-review' }, 'drain-plateau': { repo: 'plateau-app', clone: 'plateau-drain-daemon' } },
      recordPath: join(home, 'records'), readyRecordPath: join(home, 'ready'),
      auditRecordPath: join(home, 'audits'), loaderCli: 'scripts/daemon-overlay.mjs',
      adoption: { timeoutMs: 30, pollMs: 10 },
    },
    fs: {
      readFileSync(path) {
        if (path === join(home, 'ready')) return '';
        // A fingerprint-bearing older audit forces the real live fingerprint path for both heads.
        if (path === join(home, 'audits')) return [audit(weSha), audit(plateauSha),
          { ...audit('d'.repeat(40)), fingerprint: 'e'.repeat(64) }].map(JSON.stringify).join('\n');
        return missing();
      },
      mkdirSync() {}, appendFileSync() {},
    },
    retirePlanner: () => [],
    dispatchSmoke: async ({ sha }) => {
      expect(sha).toBe(weSha);
      enteredSmoke();
      await held;
      return { ok: true, sha };
    },
    exec(command, args, options) {
      const cwd = args[0] === '-C' ? args[1] : options.cwd;
      const argv = args[0] === '-C' ? args.slice(2) : args;
      calls.push({ command, args, cwd, phase });
      const sha = heads.get(cwd), slug = slugs.get(cwd);
      if (command === 'git') {
        if (!sha) throw new Error('unknown repository');
        if (argv[0] === 'fetch') return '';
        if (argv[0] === 'rev-parse') return sha;
        if (argv[0] === 'remote') return `https://github.com/${slug}.git`;
        if (argv[0] === 'merge-base') return argv.includes('--is-ancestor') ? '' : base;
        if (argv[0] === 'diff') return argv.includes('--name-status')
          ? 'M\0scripts/operations/dispatch-lane-io.mjs\0' : `diff --git a/x b/x\n+${sha}\n`;
      }
      if (command === 'gh') {
        if (argv[0] === 'repo') return JSON.stringify({ nameWithOwner: slug, url: `https://github.com/${slug}` });
        if (argv[1].includes('/check-runs')) return JSON.stringify({ total_count: 1, check_runs: [
          { id: 1, head_sha: sha, name: 'test', status: 'completed', conclusion: 'success',
            app: { id: 15368 }, check_suite: { id: 7 } },
        ] });
        if (argv[1].includes('/actions/runs')) return JSON.stringify({ total_count: 1, workflow_runs: [
          { check_suite_id: 7, head_sha: sha, path: '.github/workflows/ci.yml' },
        ] });
      }
      if (command === 'node') {
        if (argv[1] === 'list') return JSON.stringify({ list: [] });
        if (argv.includes('--check')) {
          const candidate = argv.find((arg) => arg.startsWith('--expected-sha=')).slice(15);
          return JSON.stringify({ check: { ok: true, clean: true, candSha: candidate }, wouldRegister: true });
        }
      }
      throw new Error(`unexpected fixture command ${command} ${argv.join(' ')}`);
    },
  });
  const weLoad = load({ daemon: 'review', branch: 'lane/we', sha: weSha, dryRun: true });
  await entered;
  let plateau;
  try {
    phase = 'plateau-while-we-paused';
    plateau = await load({ daemon: 'drain-plateau', branch: 'lane/plateau', sha: plateauSha, dryRun: true });
  } finally {
    phase = 'we-after-resume';
    releaseSmoke();
  }
  const we = await weLoad;
  expect(plateau).toMatchObject({ ok: true, canonicalAudit: { ok: true } });
  expect(we).toMatchObject({ ok: true, canonicalAudit: { ok: true } });
  ['we-before-pause', 'plateau-while-we-paused', 'we-after-resume'].forEach((stage) => {
    const expectedRepo = stage === 'plateau-while-we-paused' ? plateauRepo : weRepo;
    const git = calls.filter((call) => call.phase === stage && call.command === 'git');
    expect(git.length).toBeGreaterThan(0);
    git.forEach((call) => expect(call.cwd).toBe(expectedRepo));
  });
  [weRepo, plateauRepo].forEach((cwd) => {
    // Fingerprinting uses explicit git -C; ordinary ancestry/CI use cwd.
    expect(calls).toContainEqual(expect.objectContaining({ command: 'git', cwd,
      args: expect.arrayContaining(['-C', cwd, '--no-textconv']) }));
    const ci = calls.filter((call) => call.command === 'gh' && call.cwd === cwd);
    expect(ci).toHaveLength(3);
    expect(ci[0].args).toContain(`https://github.com/${slugs.get(cwd)}.git`);
    expect(ci[1].args).toContain(`repos/${slugs.get(cwd)}/commits/${heads.get(cwd)}/check-runs?per_page=100`);
    expect(ci[2].args).toContain(`repos/${slugs.get(cwd)}/actions/runs?head_sha=${heads.get(cwd)}&per_page=100`);
  });
});
