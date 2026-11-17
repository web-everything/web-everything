/** PR #6945: every ownership decision must survive handoff and read failure closed. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'host-handoff-cache-write-race',
  title: 'Ownership cannot survive handoff or unreadable fresh evidence',
  card: 'PR #6945 / x2fybk1',
  fixedBy: { sha: 'PR #6945 repair', where: 'lane/daemon-host-guard',
    paths: ['scripts/lib/daemon-host-guard.mjs', 'scripts/operations/daemon-preflight.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-host-guard.mjs'), 'utf8')
      .includes('export function createGithubOwnershipSource');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { resolveHostRole, createGithubOwnershipSource } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href);
    const { cliIO, main } = await import(pathToFileURL(join(root, 'scripts/operations/daemon-preflight.mjs')).href);
    if (!createGithubOwnershipSource) return { violations: ['fresh ownership source interface missing'] };
    const thisHost = '12345678-1234-4234-8234-123456789abc';
    const other = '87654321-4321-4321-8321-cba987654321';
    const version = 'a'.repeat(40);
    let owner = thisHost;
    let reads = 0;
    const ownershipSource = createGithubOwnershipSource({ ghApi: (path) => {
      if (path.includes('/git/ref/')) {
        reads += 1;
        if (owner === null) throw new Error('offline');
        return { ok: true, status: 200, body: { object: { sha: version } } };
      }
      return { ok: true, status: 200, body: {
        encoding: 'base64', content: Buffer.from(owner + '\n').toString('base64'),
      } };
    } });
    const violations = [];
    for (const [next, expected] of [[thisHost, 'active'], [other, 'standby'], [null, 'standby'], [thisHost, 'active'], [null, 'standby']]) {
      owner = next;
      const before = reads;
      const result = await resolveHostRole({ thisHost, ownershipSource });
      if (result.role !== expected || reads !== before + 1) violations.push('decision reused authorization or skipped its fresh read');
    }
    const adapter = cliIO({}, { ownershipSource });
    const io = { resolveRole: adapter.resolveRole, which: () => true, keyFiles: () => [],
      cloneDirs: () => [], parsePreferences: () => ({}), sshForge: () => ({ status: 0 }) };
    const lines = [];
    const exit = await main({ thisHost, io, log: (line) => lines.push(line) });
    if (exit !== 1 || !lines[0].includes('FAIL role role=standby reason=owner-unreadable')
      || !lines[0].includes('ok   ssh:forge status=0')) {
      violations.push('preflight failed to report unreadable ownership and continue');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
