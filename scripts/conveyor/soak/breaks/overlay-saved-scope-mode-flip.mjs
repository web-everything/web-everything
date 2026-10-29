/** PR #6023: saved scoped candidates keep their runtime-evidence requirement across mode changes. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild } from '../../../lib/daemon-rebuild/plan.mjs';
import { readyBuildVerified } from '../../../lib/daemon-rebuild/adopt.mjs';
import { smokeSurfaceEntries } from '../../../lib/daemon-rebuild/skip-unrelated.mjs';

const PATH = 'scripts/lib/daemon-rebuild/adopt.mjs';
export default {
  id: 'overlay-saved-scope-mode-flip',
  title: 'saved scoped candidates refuse missing runtime evidence after a mode change',
  card: 'PR #6023',
  fixedBy: { sha: 'HEAD', where: 'lane/r171-closure-scope', paths: [PATH] },
  fixPresent(root) { return readFileSync(join(root, PATH), 'utf8').includes('if (scoped ||'); },
  async run() {
    const root = mkdtempSync(join(tmpdir(), 'soak-saved-scope-'));
    const violations = [];
    const git = (args, options = {}) => spawnSync('git', [
      '-c', 'user.name=Soak', '-c', 'user.email=soak@example.test', ...args,
    ], { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, ...options });
    const ok = args => {
      const result = git(args);
      if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.error));
      return result.stdout.trim();
    };
    const commit = (files, ref) => {
      for (const [path, source] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), source + '\n');
      }
      ok(['add', '-A']); ok(['commit', '-qm', ref]);
      const sha = ok(['rev-parse', 'HEAD']);
      ok(['update-ref', `refs/remotes/origin/${ref}`, sha]);
      return sha;
    };
    try {
      ok(['init', '-qb', 'main']);
      const base = commit({ ...Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, 'export {};'])),
        'entry.mjs': 'export {};', 'unused.mjs': '// base' }, 'main');
      commit({ 'entry.mjs': "import './added.mjs';", 'added.mjs': 'export {};', 'unused.mjs': '// overlay' }, 'lane/saved');
      ok(['checkout', '-q', '--detach', base]);
      const main = commit({ 'unused.mjs': '// main' }, 'main');
      const plan = await planRebuild({ git, headSha: main, mainRef: 'origin/main',
        overlays: [{ ref: 'lane/saved' }], entries: ['entry.mjs'], env: {},
        closureScopeMode: 'on', stackMode: 'independent', edgeResolve: false });
      if (plan.applied?.[0]?.resolvedVia !== 'closure-scope') throw new Error('fixture did not create a scoped candidate');
      const adopt = JSON.parse(JSON.stringify(plan));
      for (const mode of ['on', 'off', 'shadow']) {
        const args = { git, adopt, mainTip: main, prevHead: main, env: { WE_DAEMON_CLOSURE_SCOPE: mode } };
        if (!readyBuildVerified({ ...args, entries: ['entry.mjs'] })) violations.push(`${mode}: valid candidate refused`);
        for (const options of [{}, { entries: [] }, { entries: () => [] }]) {
          if (readyBuildVerified({ ...args, ...options })) violations.push(`${mode}: accepted without runtime entries`);
        }
        let reads = 0;
        if (readyBuildVerified({ ...args, entries: () => ++reads === 1 ? ['entry.mjs', 'unused.mjs'] : [] })) {
          violations.push(`${mode}: discarded a reachable runtime entry on a repeated provider read`);
        }
        if (reads !== 1) violations.push(`${mode}: runtime entries read ${reads} times`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
