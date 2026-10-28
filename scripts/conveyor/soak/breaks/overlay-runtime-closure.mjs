/** PR #6023: exported ticks must keep their runtime data and selected workers. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild } from '../../../lib/daemon-rebuild/plan.mjs';
import { finalClosureScope, isExcludable } from '../../../lib/daemon-rebuild/closure-scope.mjs';
import { smokeSurfaceEntries } from '../../../lib/daemon-rebuild/skip-unrelated.mjs';

const PATHS = ['scripts/lib/daemon-rebuild/closure-scope.mjs', 'scripts/lib/import-closure.mjs'];
const CASES = [
  { path: 'data/foo.json', base: '{"value":"base"}', main: '{"value":"main"}', overlay: '{"value":"overlay"}',
    entry: `import { readFileSync } from 'node:fs';
export function tick(dir, name){ return JSON.parse(readFileSync(\`\${dir}/\${name}.json\`, 'utf8')); }` },
  { path: 'prompt.md', base: 'old prompt', main: 'main prompt', overlay: 'overlay:v2',
    entry: `import { readFileSync } from 'node:fs';
export function tick(){
  const prompt = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  if (!prompt.startsWith('overlay:')) throw new Error('wrong prompt format');
  return prompt;
}` },
  { path: 'worker.mjs', base: 'export {};', main: 'export const main = true;',
    overlay: 'export function runOverlay(){return true;}',
    entry: 'export async function tick(){return (await import /* selected worker */ (process.env.TARGET)).runOverlay();}' },
];

export default {
  id: 'overlay-runtime-closure',
  title: 'runtime JSON, Markdown and commented dynamic imports retain overlay conflicts',
  card: 'PR #6023 / x1b8hlo',
  fixedBy: { sha: 'HEAD', where: 'lane/r171-closure-scope', paths: PATHS },
  fixPresent(root) {
    return readFileSync(join(root, PATHS[0]), 'utf8').includes('md|json')
      && readFileSync(join(root, PATHS[1]), 'utf8').includes('ts.isCallExpression(node)');
  },
  async run() {
    const violations = [];
    for (const scenario of CASES) {
      const root = mkdtempSync(join(tmpdir(), 'soak-runtime-closure-'));
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
          'entry.mjs': 'export {};', [scenario.path]: scenario.base }, 'main');
        const overlay = commit({ 'entry.mjs': scenario.entry, [scenario.path]: scenario.overlay }, 'lane/runtime');
        ok(['checkout', '-q', '--detach', base]);
        const main = commit({ [scenario.path]: scenario.main }, 'main');
        const options = { git, headSha: main, mainRef: 'origin/main', overlays: [{ ref: 'lane/runtime' }],
          entries: ['entry.mjs'], env: {}, stackMode: 'independent', edgeResolve: false };
        const on = await planRebuild({ ...options, closureScopeMode: 'on' });
        if (on.applied.length || !on.decisions.some(d => d.action === 'drop' && d.reason === 'conflict')) {
          violations.push(`${scenario.path}: scope discarded a dependency required by the overlay tick`);
        }
        const shadow = await planRebuild({ ...options, closureScopeMode: 'shadow' });
        if (shadow.applied.length || shadow.alerts.some(a => a.kind === 'overlay-conflict-resolved')) {
          violations.push(`${scenario.path}: shadow advertised an unsafe conflict exclusion`);
        }
        // The final-tree verifier must reach the same conservative decision as the initial probe.
        const final = finalClosureScope({ git, sha: overlay, entries: ['entry.mjs'], env: {} });
        if (/\.(md|json)$/.test(scenario.path)
          ? !final.ok || isExcludable(scenario.path, final.scope)
          : final.ok || final.reason !== 'closure-incomplete') {
          violations.push(`${scenario.path}: final verification repeated the omitted dependency`);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
