import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
function probe(root = process.env.SOAK_TREE_ROOT || sourceRoot) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { mkdtempSync, rmSync } from 'node:fs';
    import { join } from 'node:path';
    import { timeoutFixture } from './scripts/lib/__tests__/fixtures/mq-timeout.mjs';
    const root = mkdtempSync(join(process.env.TMPDIR, 'mq-timeout-soak-'));
    try {
      const first = timeoutFixture(root).guard();
      const second = timeoutFixture(root).guard();
      console.log(JSON.stringify({ violations: !first.hold && second.hold ? [] : ['timeout retry did not heal exactly once'] }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  `], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  try { if (child.status === 0) return JSON.parse(child.stdout); } catch {}
  return { violations: ['timeout retry probe unavailable'] };
}
export default {
  id: 'mq-timeout-same-head', title: 'pure Vitest timeout heals a held MQ head once across drain passes',
  card: 'same-head timeout recovery', fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/lib/drain-queue-safety.mjs', 'scripts/lib/drain-mq-flake-rerun.mjs', 'scripts/lib/mq-failure-ledger.mjs'] },
  fixPresent(root) { return probe(root).violations.length === 0; },
  async run() { return probe(); }, judge: report => report.violations,
};
