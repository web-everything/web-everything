/** Local dependency installer for simulator children; never contacts a package registry. */
import { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeFixtureNpm(binDir) {
  const path = join(binDir, 'npm');
  writeFileSync(path, `#!${process.execPath}\nimport(${JSON.stringify(import.meta.url)}).then(({ installFixtureDependencies }) => {\n  installFixtureDependencies({ root: process.cwd(), modules: process.env.SIM_NPM_MODULES, lockfile: process.env.SIM_NPM_LOCKFILE, args: process.argv.slice(2) });\n}).catch(e => { console.error(e.message); process.exitCode = 1; });\n`);
  chmodSync(path, 0o755);
  return path;
}

export function installFixtureDependencies({ root, modules, lockfile, args }) {
  if (!['ci', 'install'].includes(args[0]) || args.slice(1).some(arg => arg !== '--ignore-scripts')) {
    throw new Error(`sim npm: unsupported command ${args.join(' ')}`);
  }
  if (!modules || !lockfile || !existsSync(modules)) {
    throw new Error('sim npm: installed fixture dependencies are required');
  }
  const targetLock = join(root, 'package-lock.json');
  if (!existsSync(targetLock) || !readFileSync(targetLock).equals(readFileSync(lockfile))) {
    throw new Error('sim npm: lockfile differs from the installed fixture; refusing a network install');
  }
  const target = join(root, 'node_modules');
  if (existsSync(target)) {
    if (realpathSync(target) !== realpathSync(modules)) {
      throw new Error('sim npm: refusing to replace existing dependencies');
    }
  }
  // Fresh lanes need the same exclusion as initially seeded lanes. A node_modules/ rule ignores
  // directories, but not this symlink. Candidate worktrees already set their shared exclude in setup.
  if (existsSync(join(root, '.git', 'info'))) {
    const exclude = join(root, '.git', 'info', 'exclude');
    const patterns = existsSync(exclude) ? readFileSync(exclude, 'utf8').split('\n') : [];
    if (!patterns.some(pattern => pattern.trim() === 'node_modules')) appendFileSync(exclude, '\nnode_modules\n');
  }
  if (!existsSync(target)) symlinkSync(modules, target, 'dir');
}
