/** PR #6219: a stale daemon checkout must use main's merge attributes when checking a resolved tip. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { addOverlay, overlayFilePath } from '../../../lib/daemon-overlays.mjs';
import { kickOverlayMainSync, runOverlayMainSync } from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';
export default {
  id: 'overlay-main-sync-resolved-union',
  title: 'resolved overlay code conflicts resume with main union attributes from a stale daemon checkout',
  card: 'PR #6219 / x1b8hlo',
  fixedBy: { sha: 'HEAD', where: 'lane/overlay-sync-conflict-stop', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes("run(['--attr-source=origin/main', 'merge-tree'");
  },
  async run() {
    const base = mkdtempSync(join(tmpdir(), 'soak-main-sync-union-'));
    const root = join(base, 'clone'), origin = join(base, 'origin.git'), ref = 'lane/union';
    const env = { ...process.env, TMPDIR: base, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
      WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_EVENTS: join(base, 'events.jsonl'),
      WE_NEEDS_YOU_FEED: join(base, 'needs-you.jsonl') };
    const git = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, cwd: root, env, ...opts });
    const ok = args => {
      const result = git(args);
      if (result.status !== 0) throw new Error(`fixture Git failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const write = (file, text) => writeFileSync(join(root, file), text);
    const violations = [];
    try {
      mkdirSync(root); mkdirSync(join(root, 'docs/agent'), { recursive: true });
      ok(['init', '-q', '-b', 'main']);
      write('worker.mjs', 'export const value = 0;\n');
      write('docs/agent/testing.md', '# Testing\n');
      ok(['add', '.']); ok(['commit', '-qm', 'base without attributes']);
      const baseSha = ok(['rev-parse', 'HEAD']);
      ok(['checkout', '-qb', ref]);
      write('worker.mjs', 'export const value = 1;\n');
      write('docs/agent/testing.md', '# Testing\nOverlay notes\n');
      ok(['commit', '-qam', 'overlay code and docs']);
      const tip = ok(['rev-parse', 'HEAD']);
      ok(['checkout', '-q', 'main']);
      write('worker.mjs', 'export const value = 2;\n');
      write('docs/agent/testing.md', '# Testing\nMain notes\n');
      write('.gitattributes', 'docs/agent/testing.md merge=union\n');
      ok(['add', '.']); ok(['commit', '-qm', 'main code and union attributes']);
      const main = ok(['rev-parse', 'HEAD']);
      ok(['clone', '-q', '--bare', root, origin]);
      ok(['remote', 'add', 'origin', origin]);
      ok(['update-ref', 'refs/remotes/origin/main', main]);
      ok(['update-ref', `refs/remotes/origin/${ref}`, tip]);
      ok(['checkout', '-q', '--detach', baseSha]);
      addOverlay(root, { ref, pr: 6219 }, { env });
      try {
        await runOverlayMainSync({ root, ref, env, deps: { git } });
        violations.push('initial code conflict was not rejected');
      } catch (error) {
        if (!/merge conflicts/.test(error.message)) throw error;
      }
      const events = readFileSync(env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
      const files = events.find(e => e.kind === 'overlay-main-sync-conflict')?.detail.files;
      if (JSON.stringify(files) !== JSON.stringify(['worker.mjs'])) violations.push('initial worker conflict did not use main attributes');
      ok(['checkout', '-q', ref]);
      write('worker.mjs', 'export const value = 0;\n');
      ok(['commit', '-qam', 'owner drops code conflict but retains docs']);
      ok(['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
      ok(['checkout', '-q', '--detach', baseSha]);
      if (existsSync(join(root, '.gitattributes'))) violations.push('daemon checkout is not stale');
      let spawns = 0;
      const result = kickOverlayMainSync({ root, env, mode: 'on', git, deps: { appendDaemonEvent: () => {} },
        spawnFn: () => { spawns++; return { once() {}, unref() {} }; } });
      if (spawns !== 1 || !result.started.includes(ref)) violations.push('resolved code conflict remains stopped by documentation appends');
      const state = JSON.parse(readFileSync(`${overlayFilePath(root, env)}.main-sync.state`, 'utf8'));
      if (state.conflictMain[ref] || state.attemptedMain[ref]) violations.push('resolved conflict stop was retained');
      return { violations };
    } finally { rmSync(base, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
