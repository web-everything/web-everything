import {spawnSync} from 'node:child_process';

// Environment precondition (R952): the cross-identity Forge tests need a non-root ops
// user with passwordless Python sudo. Use the same argv builder in the probe and
// cross-identity fixtures so a command-scoped sudoers policy enables those tests.
export const OPS_SUDO_SKIP_REASON = 'needs ops passwordless sudo (Forge ops host)';
export const opsSudoPythonArgs = (source, ...args) => ['-n', '/usr/bin/python3', '-I', '-c', source, ...args];

export function probeOpsSudo({platform = process.platform, run = spawnSync,
  required = process.env.FORGE_OPS_HOST === '1'} = {}) {
  if (platform !== 'linux') return false;
  const result = run('/usr/bin/sudo', opsSudoPythonArgs('pass'), {stdio: 'ignore', timeout: 10000});
  // Missing executables, timeouts and signals are broken probe evidence, not a
  // permission precondition. Let them fail collection rather than hide coverage.
  if (result.error) throw result.error;
  if (!Number.isInteger(result.status) || result.signal) throw new Error('Incomplete ops sudo probe');
  if (result.status === 0) return false;
  if (required) throw new Error('Required cross-identity tests need ops passwordless Python sudo (FORGE_OPS_HOST=1)');
  return true;
}

export const opsSudoMissing = probeOpsSudo();
if (opsSudoMissing) console.warn(`SKIPPED cross-identity Forge tests: ${OPS_SUDO_SKIP_REASON}`);
