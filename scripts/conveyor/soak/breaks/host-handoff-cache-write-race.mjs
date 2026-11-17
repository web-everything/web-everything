/** PR #6945: fresh ownership must be re-established after every handoff or failure. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export default {
  id: 'host-handoff-cache-write-race',
  title: 'Ownership cannot survive a failed fresh read after handoff',
  card: 'PR #6945 / x2fybk1',
  fixedBy: { sha: 'PR #6945 R970 R971 repair', where: 'lane/daemon-host-guard',
    paths: ['scripts/lib/daemon-host-guard.mjs', 'scripts/operations/daemon-preflight.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-host-guard.mjs'), 'utf8').includes('createGitHubOwnershipSource');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const guard = await import(pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href);
    const { cliIO, main } = await import(pathToFileURL(join(root, 'scripts/operations/daemon-preflight.mjs')).href);
    const home = mkdtempSync(join(tmpdir(), 'host-handoff-'));
    const violations = [];
    try {
      const first = guard.getThisHost({ home: join(home, 'first') });
      const second = guard.getThisHost({ home: join(home, 'second') });
      if (!first || !second || first === second) violations.push('identities are not independent');
      let owner = first;
      let reads = 0;
      const source = { readOwner: async () => {
        reads += 1;
        if (owner === null) throw new Error('offline');
        return { host: owner, version: 'revision-' + reads };
      } };
      for (const [next, expected] of [[first, ['active', 'standby']], [second, ['standby', 'active']],
        [null, ['standby', 'standby']], ['', ['standby', 'standby']], [first, ['active', 'standby']]]) {
        owner = next;
        // Fresh resolver calls model a restart without retained ownership evidence.
        const decisions = await Promise.all([first, second].map((thisHost) => guard.resolveHostRole({ thisHost, source })));
        decisions.forEach((decision, index) => {
          if (decision.role !== expected[index]) violations.push('incorrect role at read ' + reads);
        });
      }
      if (reads !== 10) violations.push('a call reused earlier ownership');
      owner = null;
      const io = cliIO({ HOME: join(home, 'first') }, { source });
      const lines = [];
      const code = await main({ io: { ...io, which: () => true, keyFiles: () => [], cloneDirs: () => [],
        parsePreferences: () => ({}), sshForge: () => ({ status: 0 }) }, log: (line) => lines.push(line) });
      if (code !== 1 || !lines[0].includes('FAIL role role=standby reason=owner-unreadable')) {
        violations.push('preflight did not report unreadable ownership');
      }
      for (const local of ['first', 'second']) {
        if (JSON.stringify(readdirSync(join(home, local, '.claude'))) !== '["host-id"]') {
          violations.push('unexpected persisted ownership state');
        }
      }
      return { violations };
    } finally { rmSync(home, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
