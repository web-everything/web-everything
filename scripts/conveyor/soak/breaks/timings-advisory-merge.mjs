/** Independent advisory timing additions must merge without allowing source conflicts through. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeGit } from '../../../lib/daemon-rebuild/shared.mjs';
import { resolveOverlayConflict } from '../../../lib/daemon-rebuild/overlay-strategies.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/overlay-strategies.mjs';
const TIMINGS = 'scripts/ci/test-timings.json';
const json = value => `${JSON.stringify(value, null, 1)}\n`;
const timings = unit => json({ _doc: 'Measured seconds per test file.', unit, soak: {} });

export default {
  id: 'timings-advisory-merge',
  title: 'timing-only overlay conflicts union both entries while mixed source conflicts refuse',
  card: '6901',
  fixedBy: { sha: 'b98edf98ce', where: 'lane/timings-auto-resolve', paths: [SOURCE] },
  fixPresent(root) { return existsSync(join(root, SOURCE)) && readFileSync(join(root, SOURCE), 'utf8').includes("name: 'advisory-merge'"); },
  async run() {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'soak-timings-advisory-merge-'));
    const env = { ...process.env, TMPDIR: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    const problems = [];
    try {
      for (const mixed of [false, true]) {
        const name = mixed ? 'mixed timings and code' : 'timings only';
        const root = join(dir, mixed ? 'mixed' : 'timings');
        mkdirSync(root);
        const git = makeGit({ cwd: root, env, timeoutMs: 20_000,
          run: (args, opts) => spawnSync('git', args, {
            ...opts, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
          }),
        });
        const ok = args => {
          const result = git(args);
          if (result.status !== 0) throw new Error(`timings-advisory-merge fixture Git failed: ${result.stderr}`);
          return result.stdout.trim();
        };
        const write = (path, text) => {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), text);
        };
        const commit = message => {
          ok(['add', '-A']);
          ok(['commit', '-qm', message]);
          return ok(['rev-parse', 'HEAD']);
        };
        ok(['init', '-q', '-b', 'base']);
        ok(['config', 'core.hooksPath', '/dev/null']);
        ok(['config', 'commit.gpgsign', 'false']);
        ok(['config', 'rerere.enabled', 'false']);
        write(TIMINGS, timings({ shared: 1 }));
        write('a.mjs', 'export const value = "base";\n');
        commit('base');
        ok(['checkout', '-qb', 'lane/ours']);
        write(TIMINGS, timings({ shared: 1, zeta: 3 }));
        if (mixed) write('a.mjs', 'export const value = "ours";\n');
        const cur = commit('ours');
        ok(['checkout', '-qb', 'lane/theirs', 'base']);
        write(TIMINGS, timings({ shared: 1, alpha: 2 }));
        if (mixed) write('a.mjs', 'export const value = "theirs";\n');
        const ovSha = commit('theirs');
        ok(['checkout', '-q', 'lane/ours']);

        const conflict = git(['merge-tree', '--write-tree', '--name-only', cur, ovSha]);
        const lines = String(conflict.stdout ?? '').split('\n').slice(1);
        const files = lines.slice(0, lines.indexOf('')).sort();
        const expected = mixed ? [TIMINGS, 'a.mjs'].sort() : [TIMINGS];
        if (conflict.status !== 1 || JSON.stringify(files) !== JSON.stringify(expected)) {
          problems.push(`${name}: fixture did not produce the expected conflicts`);
          continue;
        }
        const result = resolveOverlayConflict({ git, cur, ovSha, ref: 'lane/theirs' });
        if (mixed) {
          if (result?.ok !== false) problems.push('mixed timings and code: resolver did not refuse');
        } else if (result?.ok !== true || !/^[0-9a-f]{40}$/.test(result.tree ?? '')) {
          // Before the advisory strategy, replay hits the same timing conflict and returns ok:false.
          problems.push('timings only: resolver refused independent timing additions');
        } else {
          const merged = git(['show', `${result.tree}:${TIMINGS}`]);
          try {
            const value = JSON.parse(merged.stdout);
            if (merged.status !== 0 || value?.unit?.alpha !== 2 || value?.unit?.zeta !== 3 || value?.unit?.shared !== 1) {
              problems.push('timings only: merged tree lost timing entries');
            }
          } catch { problems.push('timings only: merged tree timings are unreadable'); }
        }
      }
      return { problems };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.problems; },
};
