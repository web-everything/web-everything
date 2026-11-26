/** PR #7477: an admitted hotpatch replacement must use the production origin tip reader. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceRegistration } from '../../../daemon-overlay.mjs';
import { addOverlay, readOverlays } from '../../../lib/daemon-overlays.mjs';

export default {
  id: 'hotpatch-registration-default-tip',
  title: 'hotpatch replacement admits an unchanged origin tip and refuses failed admission or a moved tip',
  card: 'PR #7477',
  fixedBy: { sha: 'pending', where: 'lane/rs-hp-3-adopt', paths: ['scripts/daemon-overlay.mjs', 'scripts/lib/daemon-load-overlay.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/daemon-overlay.mjs'), 'utf8');
    return source.includes('admitHotpatch: deps.admitHotpatch, tipOf: tip }');
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-hotpatch-registration-'));
    const report = { fatal: null, violations: [] };
    const git = (cwd, args) => {
      const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], {
        cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(result.stderr || 'fixture git failed');
      return result.stdout.trim();
    };
    try {
      const origin = join(dir, 'origin');
      const root = join(dir, 'clone');
      mkdirSync(origin);
      git(origin, ['init', '-q', '-b', 'main']);
      writeFileSync(join(origin, 'base.txt'), 'base\n');
      git(origin, ['add', '.']);
      git(origin, ['commit', '-qm', 'base']);
      const base = git(origin, ['rev-parse', 'HEAD']);
      const old = 'lane/previous';
      git(origin, ['update-ref', `refs/heads/${old}`, base]);
      writeFileSync(join(origin, 'patch.txt'), 'patch\n');
      git(origin, ['add', '.']);
      git(origin, ['commit', '-qm', 'patch']);
      const sha = git(origin, ['rev-parse', 'HEAD']);
      const ref = `hotpatch/${sha}`;
      git(origin, ['update-ref', `refs/heads/${ref}`, sha]);
      git(origin, ['update-ref', 'refs/heads/main', base]);
      git(dir, ['clone', '-q', origin, root]);
      for (const outcome of ['pass', 'fail', 'moved']) {
        git(origin, ['update-ref', `refs/heads/${ref}`, sha]);
        const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(dir, outcome), WE_DAEMON_OVERLAY_STACK_BASES: '{}' };
        addOverlay(root, { ref: old, pr: 1 }, { env });
        let admittedSha;
        const result = await replaceRegistration({ root, ref, old, expectedSha: sha, env, deps: {
          admitHotpatch: async (candidate) => {
            admittedSha = candidate;
            if (outcome === 'moved') git(origin, ['update-ref', `refs/heads/${ref}`, base]);
            return { outcome: outcome === 'fail' ? 'fail' : 'pass' };
          },
        } });
        const refs = readOverlays(root, { env }).map((row) => row.ref);
        const expectedReason = outcome === 'fail' ? 'hotpatch-not-admitted' : 'hotpatch-sha-moved';
        if (admittedSha !== sha || result.ok !== (outcome === 'pass')
          || (outcome !== 'pass' && result.refused !== expectedReason)
          || JSON.stringify(refs) !== JSON.stringify([outcome === 'pass' ? ref : old])) {
          report.violations.push(`${outcome}: ok=${result.ok} refused=${result.refused} refs=${refs.join(',')}`);
        }
      }
    } catch (error) {
      report.fatal = error.message;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return report;
  },
  judge(report) {
    return [...(report.fatal ? [`[crash] ${report.fatal}`] : []), ...report.violations];
  },
};
