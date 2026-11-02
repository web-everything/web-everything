/** PR #6226 operator probes: imported symlinks and launchd globs must not authorize skipping a rebuild. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = 'scripts/lib/daemon-clone-entries.mjs';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export default {
  id: 'clone-entry-symlink-and-glob',
  title: 'clone discovery refuses hidden CommonJS dependencies and launchd glob entry substitutions',
  card: 'PR #6226 operator send-back IC_kwDORBt1-c8AAAABiLKyvA',
  fixedBy: { sha: 'HEAD', where: 'lane/clone-entries-slice-d', paths: [SOURCE, 'scripts/lib/import-closure.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('canonicalize: path =>') && source.includes('LaunchAgents glob argument refused');
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const { cloneRuntimeEntries, collectCloneImportClosure } = await import(pathToFileURL(join(sourceRoot, SOURCE)));
    const { collectRunClosure, decideSkipRebuild } = await import(pathToFileURL(join(sourceRoot,
      'scripts/lib/daemon-rebuild/skip-unrelated.mjs')));
    const { DAEMON_ENTRY_MODULES } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/daemon-boot-smoke.mjs')));
    const dir = mkdtempSync(join(tmpdir(), 'soak-clone-entry-'));
    const root = join(dir, 'clone'), launchAgentsDir = join(dir, 'agents');
    const violations = [];
    try {
      mkdirSync(root); mkdirSync(launchAgentsDir);
      for (const entry of DAEMON_ENTRY_MODULES) {
        mkdirSync(dirname(join(root, entry)), { recursive: true });
        writeFileSync(join(root, entry), 'export {};');
      }
      writeFileSync(join(root, 'hidden.cjs'), 'module.exports = 1;');
      symlinkSync('hidden.cjs', join(root, 'alias.mjs'));
      for (const spec of ['./alias.mjs', join(root, 'alias.mjs'), pathToFileURL(join(root, 'alias.mjs')).href,
        './%61lias.mjs?version=1#entry']) {
        writeFileSync(join(root, 'entry.mjs'), `import ${JSON.stringify(spec)};`);
        const closure = collectRunClosure({ root, entries: ['entry.mjs'], byName: () => [],
          importClosure: collectCloneImportClosure });
        const decision = decideSkipRebuild({ closure, changedFiles: ['scripts/changed.mjs'] });
        if (decision.skip) violations.push(`imported CommonJS symlink permitted skipping rebuild: ${spec}`);
        let symlinkRefused = false;
        try { cloneRuntimeEntries({ root, launchAgentsDir, entries: ['entry.mjs'] }); }
        catch (error) { symlinkRefused = /runtime dependency proof incomplete/.test(error.message); }
        if (!symlinkRefused) violations.push(`runtime discovery accepted imported CommonJS symlink: ${spec}`);
        log?.(`specifier=${spec}; symlink refused=${symlinkRefused}; rebuild skipped=${decision.skip}`);
      }

      // A literal wildcard file is innocuous; launchd may instead select the hidden worker.
      writeFileSync(join(root, '*.mjs'), 'export {};');
      writeFileSync(join(launchAgentsDir, 'org.example.glob.plist'), 'fixture');
      let globRefused = false;
      try {
        cloneRuntimeEntries({ root, launchAgentsDir, run: () => ({ status: 0, stdout: JSON.stringify({
          WorkingDirectory: root, EnableGlobbing: true,
          ProgramArguments: ['node', join(root, '*.mjs')],
        }) }) });
      } catch (error) { globRefused = /LaunchAgents glob argument refused/.test(error.message); }
      if (!globRefused) violations.push('runtime discovery accepted launchd wildcard entry');
      log?.(`glob refused=${globRefused}`);
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
