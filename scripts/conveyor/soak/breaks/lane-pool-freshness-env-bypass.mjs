/** PR #6242: a test marker in an operator environment must not admit a stale tool. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const ENTRY = 'scripts/lib/stale-tool-guard-entry.mjs';

export default {
  id: 'lane-pool-freshness-env-bypass',
  title: 'lane-pool refuses stale entry before tool imports even with test and re-exec markers',
  card: 'we:PR#6242',
  fixedBy: { sha: 'HEAD', where: 'lane/tools-from-main', paths: [ENTRY, 'scripts/lane-pool.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, ENTRY), 'utf8').includes('export async function guardToolEntry');
  },
  async run({ root = ROOT, log } = {}) {
    const fixture = mkdtempSync(join(tmpdir(), 'soak-freshness-entry-'));
    const violations = [];
    try {
      mkdirSync(join(fixture, 'scripts/lib'), { recursive: true });
      writeFileSync(join(fixture, 'scripts/lane-pool.mjs'), readFileSync(join(root, 'scripts/lane-pool.mjs')));
      writeFileSync(join(fixture, ENTRY), readFileSync(join(root, ENTRY)));
      // Deterministic freshness refusal, with the production bootstrap and exit path.
      // No tool dependencies exist: reaching one proves the guard did not stop loading.
      writeFileSync(join(fixture, 'scripts/lib/stale-tool-guard.mjs'),
        "export async function guardToolCheckout() { await Promise.resolve(); throw new Error('stale tool checkout (6 behind)'); }\n");
      const env = { ...process.env, VITEST: 'true', WE_TOOL_FRESH_REEXEC: '1' };
      delete env.NODE_OPTIONS;
      const result = spawnSync(process.execPath, [join(fixture, 'scripts/lane-pool.mjs')], {
        env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 1 || result.stderr !== 'stale tool checkout (6 behind)\n') {
        violations.push('environment markers bypassed the freshness refusal before tool imports');
      }
      log?.(`entry environment markers: ${violations.length ? 'RED' : 'GREEN'}`);
      return { violations };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
