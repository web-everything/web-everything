/** PR #6945: fresh ownership must be re-established after every handoff or failure. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export default {
  id: 'host-handoff-cache-write-race',
  title: 'Ownership cannot survive a failed fresh read after handoff',
  card: 'PR #6945 / x2fybk1',
  fixedBy: { sha: 'PR #6945 R970 R971 repair', where: 'lane/daemon-host-guard',
    paths: ['scripts/lib/daemon-host-guard.mjs', 'scripts/operations/daemon-preflight.mjs'] },
  fixPresent() {
    // The fix ships with this break, so it is always required. A deleted or renamed guard must make run() fail
    // (a required pass), never flip the test to it.fails where the resulting import error would satisfy it.
    return true;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const violations = [];
    let guard;
    let preflight;
    try {
      guard = await import(pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href);
      preflight = await import(pathToFileURL(join(root, 'scripts/operations/daemon-preflight.mjs')).href);
    } catch (error) {
      return { violations: [`host guard module import failed: ${error?.message ?? error}`] };
    }
    const missing = [['getThisHost', guard], ['decideHostRole', guard], ['resolveHostRole', guard], ['createGitHubOwnershipSource', guard],
      ['cliIO', preflight], ['main', preflight]].filter(([name, mod]) => typeof mod[name] !== 'function');
    if (missing.length) return { violations: [`missing callable exports: ${missing.map(([name]) => name).join(', ')}`] };
    const { cliIO, main } = preflight;
    const home = mkdtempSync(join(tmpdir(), 'host-handoff-'));
    try {
      // The ownership source must be callable and read through a fixture: a 404 means unset, a valid ref+file yields the host.
      const fixtureHost = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const fixtureSource = guard.createGitHubOwnershipSource({ ghApi: async (path) => (path.includes('/git/ref/')
        ? { ok: true, status: 200, body: { object: { type: 'commit', sha: 'f'.repeat(40) } } }
        : { ok: true, status: 200, body: { type: 'file', encoding: 'base64', content: Buffer.from(fixtureHost + '\n').toString('base64') } }) });
      const fixtureRead = await fixtureSource.readOwner();
      if (fixtureRead?.host !== fixtureHost || fixtureRead.version !== 'f'.repeat(40)) {
        violations.push('ownership source did not read the fixture owner');
      }
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
      const alias = 'legacy-alpha';
      const shared = { host: alias, version: 'fixture', legacyOwnerValues: { [alias]: first } };
      for (const thisHost of [first, second]) {
        const input = { thisHost, owner: alias, legacyHost: alias, ownerReadAt: 1000, now: 1000,
          legacyOwnerValues: { [alias]: thisHost } };
        const localOnly = guard.decideHostRole(input);
        if (localOnly.role !== 'standby' || localOnly.reason !== 'owner-alias-ambiguous') {
          violations.push('per-host alias binding activated a host without shared authority');
        }
        if (guard.decideHostRole({ ...input, ownerRecord: shared }).role !== (thisHost === first ? 'active' : 'standby')) {
          violations.push('shared alias binding did not select exactly one UUID');
        }
        if (guard.decideHostRole({ ...input, owner: thisHost }).role !== 'active') violations.push('direct UUID owner did not activate');
      }
      for (const [bindings, expected] of [[undefined, ['standby', 'standby']],
        [alias + '=' + first, ['active', 'standby']], [alias + '=' + second, ['standby', 'active']],
        [alias + '=' + first + ',' + alias + '=' + second, ['standby', 'standby']],
        ['legacy-beta=' + first, ['standby', 'standby']], [alias + '=invalid', ['standby', 'standby']]]) {
        const contents = alias + (bindings === undefined ? '' : '\n' + bindings) + '\n';
        for (const [index, thisHost] of [first, second].entries()) {
          const migration = cliIO({ WE_DAEMON_LEGACY_OWNER_VALUES: alias + '=' + thisHost }, {
            legacyHost: alias, execFileSync: (_file, args) => JSON.stringify(
              args[1].includes('/git/ref/') ? { object: { type: 'commit', sha: 'a'.repeat(40) } }
                : { type: 'file', encoding: 'base64', content: Buffer.from(contents).toString('base64') }),
          });
          const decision = await migration.resolveRole({ thisHost });
          const ambiguous = expected.every((role) => role === 'standby');
          if (decision.role !== expected[index] || (ambiguous && decision.reason !== 'owner-alias-ambiguous')) {
            violations.push('preflight did not use the shared alias authority');
          }
        }
      }
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
