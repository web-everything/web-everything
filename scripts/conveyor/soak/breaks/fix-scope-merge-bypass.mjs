/** PR #5461: a fixer merge must not exempt its own outside paths from the push fence. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const IO = 'scripts/conveyor/fix-scope-fence-io.mjs';

export async function replay(root = ROOT) {
  const { createScopeFencedPush } = await import(pathToFileURL(join(root, IO)).href);
  const dir = mkdtempSync(join(tmpdir(), 'soak-scope-merge-'));
  const git = args => String(execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }));
  const ident = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null'];
  const commit = message => { git(['add', '.']); git([...ident, 'commit', '-qm', message]); return git(['rev-parse', 'HEAD']).trim(); };
  const reports = [];
  try {
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'guard.mjs'), '// initial\n'); commit('initial');
    git(['checkout', '-qb', 'pr']);
    writeFileSync(join(dir, 'guard.mjs'), '// PR\n'); const head = commit('PR');
    git(['checkout', '-qb', 'side']);
    writeFileSync(join(dir, 'outside.mjs'), '// outside repair\n'); const side = commit('outside repair');
    git(['checkout', '-q', 'pr']); git([...ident, 'merge', '-q', '--no-ff', '--no-edit', side]);
    const unverified = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'upstream.mjs'), '// upstream\n'); const base = commit('upstream');
    git(['checkout', '-qb', 'amended-pr', head]); git([...ident, 'merge', '-q', '--no-edit', base]);
    const clean = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(dir, 'smuggled.mjs'), '// merge amendment\n');
    git(['add', '.']); git([...ident, 'commit', '-q', '--amend', '--no-edit']);
    const amended = git(['rev-parse', 'HEAD']).trim();
    for (const [shape, sha, verifiedBase, blocked] of [
      ['unverified side', unverified, null, true], ['amended catch-up', amended, base, true], ['unchanged catch-up', clean, base, false],
    ]) {
      let pushed = false, stoodDown = false;
      const exec = (_, args) => {
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefName: 'lane/scope-fence', headRefOid: head, baseRefOid: verifiedBase });
        if (args[0] === 'api' && args[1] === 'graphql') return `1\n${head}\tPR\n`;
        if (args[0] === 'api' && args[1].includes('/compare/')) return args[1].includes(`${base}...${base}`) ? 'identical' : 'diverged';
        if (args[0] === 'api') return 'diff --git a/guard.mjs b/guard.mjs\n--- a/guard.mjs\n+++ b/guard.mjs\n';
        if (args[0] === 'pr' && args[1] === 'diff') return 'guard.mjs\n';
        if (args[0] === 'pr' && args[1] === 'comment') stoodDown = true;
        return '';
      };
      const fence = createScopeFencedPush({ root, exec, env: { WE_FIX_SCOPE_FENCE_MODE: 'stand-down' }, log: () => {}, readComments: () => [],
        loadItems: () => [{ num: '5957', slug: 'leading-cd', scope: ['we:guard.mjs'] }] });
      const result = fence({ repo: ghRepoSlug('we'), pr: 5461, sha, git,
        push: () => { pushed = true; return { ok: true }; } });
      reports.push({ shape, blocked, pushed, stoodDown, refused: result.scopeFence === true && result.terminal === true, reason: result.reason });
    }
    return reports;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'fix-scope-merge-bypass',
  title: 'fixer-authored merges bypass the file scope fence',
  card: 'PR #5461 advisory merge-scope prevention',
  fixedBy: { sha: 'HEAD', where: 'lane/scope-fence', paths: [IO] },
  fixPresent(root) { return readFileSync(join(root, IO), 'utf8').includes('mergeScopePaths'); },
  async run({ log } = {}) {
    const reports = await replay();
    log?.(JSON.stringify(reports));
    return { violations: reports.filter(r => r.blocked ? r.pushed || !r.stoodDown || !r.refused : !r.pushed || r.stoodDown || r.refused)
      .map(r => `${r.shape}: ${JSON.stringify(r)}`) };
  },
  judge(report) { return report.violations; },
};
