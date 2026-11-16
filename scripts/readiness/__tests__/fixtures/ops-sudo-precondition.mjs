import {spawnSync} from 'node:child_process';

// Environment precondition (R952): the cross-identity Forge tests need a non-root ops
// user with passwordless sudo. Probe `sudo -n true` once; only a failing probe skips.
export const OPS_SUDO_SKIP_REASON = 'needs ops passwordless sudo (Forge ops host)';
export const opsSudoMissing = process.platform === 'linux'
  && spawnSync('/usr/bin/sudo', ['-n', 'true'], {stdio: 'ignore', timeout: 10000}).status !== 0;
if (opsSudoMissing) console.warn(`SKIPPED cross-identity Forge tests: ${OPS_SUDO_SKIP_REASON}`);
