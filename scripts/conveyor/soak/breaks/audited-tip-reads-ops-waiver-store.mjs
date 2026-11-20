/** The audited-tip gate must consume operator waivers from the canonical ops store. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'audited-tip-reads-ops-waiver-store',
  title: 'audited-tip accepts exact WEAKENED evidence waived in the ops store',
  card: 'audited-tip ops-store waiver evidence',
  fixedBy: { sha: '47c657608c010007d46ef478f2ea56d459b538e0', where: 'main', paths: ['scripts/lib/daemon-rebuild/audited-tip.mjs'] },
  fixPresent(root) {
    try {
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { default: scenario } = await import(process.argv[1]);
        const report = await scenario.run({ sourceRoot: process.argv[2] });
        process.exitCode = scenario.judge(report).length ? 1 : 0;
      `, import.meta.url, root], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
      return !probe.error && probe.status === 0;
    } catch { return false; }
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { makeAuditedTipGate } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/audited-tip.mjs')).href);
    const { appendEntry, storePath } = await import(pathToFileURL(join(root, 'scripts/operations/ruled-weakened-store.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-audited-tip-ops-waiver-'));
    try {
      const env = {
        HOME: dir,
        WE_FIX_READY_PATH: join(dir, 'fix-ready.jsonl'),
        WE_PLATFORM_PREFERENCES_FILE: join(dir, 'platform.json'),
        WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only',
      };
      const ref = 'lane/soak-ops-waiver', sha = 'b'.repeat(40);
      const ruling = 'R907', findings = ['finding'];
      writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
      writeFileSync(env.WE_FIX_READY_PATH, `${JSON.stringify({
        ref, sha, tests: 'green', audit: 'WEAKENED', auditRuling: ruling, auditDisclosed: findings,
      })}\n`);
      appendEntry({ ref, sha, ruling, findings, actor: 'operator', quote: 'approved' }, { path: storePath(env) });
      const gate = makeAuditedTipGate(env);
      return { violations: gate(ref, sha) === true
        ? [] : ['audited-tip rejected exact WEAKENED evidence waived in the ops store'] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
