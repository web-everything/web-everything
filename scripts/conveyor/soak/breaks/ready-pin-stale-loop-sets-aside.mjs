/** A pin whose adopted head lost its audit evidence must be set aside once, never rebuilt and discarded forever. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'ready-pin-stale-loop-sets-aside',
  title: 'planRebuild sets a recorded stale pin aside when its adopted head has no audit evidence',
  card: 'ready-pin-stale loop on the fix daemon',
  fixedBy: { sha: '4db05f14a6ce406125d01cd7551357d303e7ee19', where: 'main', paths: ['scripts/lib/daemon-rebuild/plan.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs'] },
  fixPresent(root) {
    try {
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { default: scenario } = await import(process.argv[1]);
        const report = await scenario.run({ sourceRoot: process.argv[2] });
        process.exitCode = scenario.judge(report).length ? 1 : 0;
      `, import.meta.url, root], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
      return !probe.error && probe.status === 0;
    } catch { return false; }
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const load = (p) => import(pathToFileURL(join(root, p)).href);
    const { planRebuild } = await load('scripts/lib/daemon-rebuild/plan.mjs');
    const { makeGit } = await load('scripts/lib/daemon-rebuild/shared.mjs');
    const { makeAuditedTipGate } = await load('scripts/lib/daemon-rebuild/audited-tip.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'soak-ready-pin-stale-'));
    try {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      const g = (...args) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8', timeout: 20_000 });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
      };
      const commit = (name, content) => {
        mkdirSync(dirname(join(repo, name)), { recursive: true });
        writeFileSync(join(repo, name), content);
        g('add', '-A'); g('commit', '-q', '-m', content);
        return g('rev-parse', 'HEAD');
      };
      const ref = 'lane/soak-stale-pin';
      g('init', '-q', '-b', 'main');
      const base = commit('moving.txt', 'base');
      g('update-ref', 'refs/remotes/origin/main', base);
      const a = commit('a.txt', 'audited A');
      g('update-ref', `refs/remotes/origin/${ref}`, a);
      const evidence = join(dir, 'fix-ready.jsonl');
      const platform = join(dir, 'platform.json');
      writeFileSync(platform, '{}');
      const env = { HOME: dir, WE_FIX_READY_PATH: evidence, WE_PLATFORM_PREFERENCES_FILE: platform, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
      writeFileSync(evidence, `${JSON.stringify({ ref, sha: a, tests: 'green', audit: 'NOT WEAKENED' })}\n`);
      const git = makeGit({ cwd: repo, env: process.env, run: (args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8' }) });
      const args = { git, mainRef: 'origin/main', overlays: [{ ref, pr: 42 }], edgeResolve: false };
      const adopted = await planRebuild({ ...args, headSha: base, auditedTip: makeAuditedTipGate(env) });
      const b = commit('moving.txt', 'unaudited B');
      g('update-ref', `refs/remotes/origin/${ref}`, b);
      writeFileSync(evidence, ''); // A's audit row is gone; B never had one
      const plan = await planRebuild({ ...args, headSha: adopted.finalSha, auditedTip: makeAuditedTipGate(env), stalePins: { [ref]: a } });
      const violations = [];
      if (!plan.ok) violations.push('plan failed');
      else if (plan.applied.some((x) => x.ref === ref)) violations.push('stale pinned overlay is still applied (adoption will discard it forever)');
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
