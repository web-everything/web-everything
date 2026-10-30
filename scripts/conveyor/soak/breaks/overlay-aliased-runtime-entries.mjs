/** PR #6023: aliased LaunchAgents must feed both boot smoke and closure scoping. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { cloneRuntimeEntries } from '../../../lib/daemon-clone-entries.mjs';
import { DAEMON_ENTRY_MODULES, resolveDaemonEntries } from '../../../lib/daemon-boot-smoke.mjs';
import { computeClosureScope, isExcludable } from '../../../lib/daemon-rebuild/closure-scope.mjs';
import { smokeSurfaceEntries } from '../../../lib/daemon-rebuild/skip-unrelated.mjs';

export default {
  id: 'overlay-aliased-runtime-entries',
  title: 'aliased LaunchAgent daemon and pass entries protect their runtime dependencies',
  card: 'PR #6023',
  fixedBy: { sha: 'HEAD', where: 'lane/r171-closure-scope', paths: ['scripts/lib/daemon-clone-entries.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-clone-entries.mjs'), 'utf8').includes('canonicalArgument');
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-aliased-entries-'));
    const violations = [];
    try {
      const root = join(dir, 'clone'), alias = join(dir, 'alias'), launchAgentsDir = join(dir, 'agents');
      mkdirSync(root); mkdirSync(launchAgentsDir); symlinkSync(root, alias);
      const files = new Map([...DAEMON_ENTRY_MODULES, ...smokeSurfaceEntries({})].map(p => [p, 'export {};']));
      files.set('scripts/extra-daemon.mjs', "import './daemon-dependency.mjs';");
      files.set('scripts/daemon-dependency.mjs', 'export {};');
      files.set('scripts/conveyor/branch-drift.mjs', "import './pass-dependency.mjs';");
      files.set('scripts/conveyor/pass-dependency.mjs', 'export {};');
      for (const [p, text] of files) {
        mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text);
      }
      const programs = {
        'com.we.extra.plist': ['node', join(alias, 'scripts/extra-daemon.mjs')],
        'com.we.pass.plist': ['node', join(alias, 'skills-src/conveyor/pass-daemon.mjs'), '--pass=branch-drift'],
        'com.we.external.plist': ['node', `${root}-other/foreign.mjs`],
      };
      for (const name of Object.keys(programs)) writeFileSync(join(launchAgentsDir, name), 'plist');
      const runtimeEntries = options => cloneRuntimeEntries({ ...options, launchAgentsDir,
        run: (_bin, args) => ({ status: 0,
          stdout: JSON.stringify({ ProgramArguments: programs[args.at(-1).split('/').at(-1)] }) }),
      });
      const boot = resolveDaemonEntries({ WE_DAEMON_CLOSURE_SCOPE: 'on', WE_SMOKE_LIVE_CLONE: alias }, { root, runtimeEntries });
      for (const p of ['scripts/extra-daemon.mjs', 'scripts/conveyor/branch-drift.mjs']) {
        if (!boot.entries.includes(p)) violations.push(`boot omitted aliased entry: ${p}`);
      }
      if (boot.entries.some(p => p.includes('foreign'))) violations.push('boot included an external entry');
      const key = p => relative(root, resolve(root, p));
      const reader = { root, listFiles: () => [...files.keys()], exists: p => files.has(key(p)),
        readFile: p => { if (!files.has(key(p))) throw new Error('unreadable'); return files.get(key(p)); } };
      const scope = computeClosureScope({ reader, entries: runtimeEntries({ root, env: {} }), env: {} });
      for (const p of ['scripts/daemon-dependency.mjs', 'scripts/conveyor/pass-dependency.mjs']) {
        if (!scope.ok || isExcludable(p, scope.scope)) violations.push(`scope missed aliased runtime dependency: ${p}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
