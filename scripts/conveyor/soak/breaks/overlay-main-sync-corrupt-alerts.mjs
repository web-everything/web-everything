/** PR #6051: corrupt main-sync state must not flood the operator feed on every tick. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addOverlay, overlayFilePath } from '../../../lib/daemon-overlays.mjs';
import { kickOverlayMainSync } from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';
import { alertsFilePath } from '../../../lib/daemon-rebuild/state.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';
export default {
  id: 'overlay-main-sync-corrupt-alerts',
  title: 'repeated corrupt main-sync ticks alert once per ref and never launch workers',
  card: 'PR #6051',
  fixedBy: { sha: 'HEAD', where: 'lane/overlay-main-sync', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('function rateLimitedAlert('); },
  run() {
    const root = mkdtempSync(join(tmpdir(), 'soak-main-sync-alerts-'));
    const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_DAEMON_STATE_DIR: join(root, 'state') };
    const violations = [];
    let gitCalls = 0, spawns = 0;
    try {
      for (const ref of ['lane/one', 'lane/two']) addOverlay(root, { ref }, { env });
      const file = `${overlayFilePath(root, env)}.main-sync.state`;
      writeFileSync(file, '{corrupt');
      for (let tick = 0; tick < 6; tick++) kickOverlayMainSync({ root, env, mode: 'on',
        git: () => { gitCalls++; throw new Error('unexpected Git call'); },
        spawnFn: () => { spawns++; throw new Error('unexpected spawn'); },
      });
      const rows = readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').map(JSON.parse);
      for (const ref of ['lane/one', 'lane/two']) {
        const count = rows.filter(row => row.detail.ref === ref).length;
        if (count !== 1) violations.push(`${ref}: expected one alert after six ticks, got ${count}`);
      }
      if (gitCalls || spawns) violations.push('corrupt state authorized Git or a worker');
      if (readFileSync(file, 'utf8') !== '{corrupt') violations.push('corrupt evidence overwritten');
      return { violations };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
