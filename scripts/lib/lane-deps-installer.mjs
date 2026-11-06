import { tmpdir } from 'node:os';

/** Installer policy and orchestration; all subprocess/filesystem effects are injected. */
export function selectInstaller({ which, exec, hasPnpmLock, hasNpmLock, parity, storeDir }) {
  const npm = { backend: 'npm', command: 'npm', args: [hasNpmLock ? 'ci' : 'install'] };
  try {
    if (!hasPnpmLock) return npm;
    const command = which('pnpm');
    if (!command) return npm;
    // A packageManager pin can make even --version rewrite the cwd's lockfile.
    const version = String(exec(command, ['--version'], { cwd: tmpdir() })).trim();
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || Number(version.split('.')[0]) < 12) return npm;
    if (parity() !== true) return npm;
    return { backend: 'pnpm', command,
      args: ['install', '--frozen-lockfile', '--store-dir=' + storeDir], fallback: npm };
  } catch {
    return npm;
  }
}

export function markerMatches(marker, hash, backend) {
  return marker === backend + ':' + hash || (backend === 'npm' && marker === hash);
}

/** Returns the marker to persist only AFTER success. A throwing npm install propagates. */
export function runDepsInstaller({ plan, hash, marker, hasNodeModules, exec, remove,
  invalidate = () => {}, log = () => {} }) {
  if (hasNodeModules && markerMatches(marker, hash, plan.backend)) {
    return { state: 'ok', backend: plan.backend, marker };
  }
  invalidate();
  // Unknown or legacy state is npm-shaped; never reuse it for a pnpm installation.
  const previous = marker?.startsWith('pnpm:') ? 'pnpm' : 'npm';
  if (hasNodeModules && previous !== plan.backend) remove();
  let selected = plan;
  log('installing deps with ' + selected.backend);
  try {
    exec(selected.command, selected.args);
  } catch (error) {
    if (!selected.fallback) throw error;
    log('pnpm install failed; falling back to npm');
    remove(); // includes partial output from a failed first installation
    selected = selected.fallback;
    exec(selected.command, selected.args);
  }
  return { state: 'installed', backend: selected.backend, marker: selected.backend + ':' + hash };
}
