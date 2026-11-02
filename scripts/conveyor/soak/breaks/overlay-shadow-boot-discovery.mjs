/** PR #6023: shadow boot and skip checks must not depend on host LaunchAgents. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDaemonEntriesBoot, DAEMON_ENTRY_MODULES } from '../../../lib/daemon-boot-smoke.mjs';
import { smokeSurfaceEntries } from '../../../lib/daemon-rebuild/skip-unrelated.mjs';

export default {
  id: 'overlay-shadow-boot-discovery',
  title: 'shadow boot and skip checks survive missing LaunchAgents without changing the smoke surface',
  card: 'PR #6023',
  fixedBy: { sha: 'HEAD', where: 'lane/r171-closure-scope',
    paths: ['scripts/lib/daemon-boot-smoke.mjs', 'scripts/lib/daemon-rebuild/skip-unrelated.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/skip-unrelated.mjs'), 'utf8').includes('fixedEntriesOnly: true');
  },
  async run() {
    const home = mkdtempSync(join(tmpdir(), 'soak-shadow-boot-'));
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const violations = [];
    try {
      for (const mode of [undefined, 'off', 'shadow', 'on']) {
        const env = { HOME: home, WE_SMOKE_LIVE_CLONE: root,
          ...(mode === undefined ? {} : { WE_DAEMON_CLOSURE_SCOPE: mode }) };
        let spawned = 0;
        const boot = await checkDaemonEntriesBoot({ root, env, log: {},
          runChild: async () => { spawned++; return '{"ok":true}'; } });
        if (mode === 'on') {
          if (boot.ok || spawned || !boot.detail.includes('runtime entries unreadable')) {
            violations.push('on failed to refuse unreadable LaunchAgents');
          }
        } else if (!boot.ok || spawned !== DAEMON_ENTRY_MODULES.length
          || boot.entries.some((entry, i) => entry.entry !== DAEMON_ENTRY_MODULES[i])) {
          violations.push(`${mode ?? 'default'} changed the fixed-list boot gate`);
        }
        try {
          if (JSON.stringify(smokeSurfaceEntries(env)) !== JSON.stringify(smokeSurfaceEntries({}))) {
            violations.push(`${mode ?? 'default'} widened the skip surface`);
          }
        } catch { violations.push(`${mode ?? 'default'} threw out of the skip surface`); }
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
