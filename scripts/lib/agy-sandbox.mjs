import { isAbsolute, join, normalize } from 'node:path';

// Exactly what agy needs for state writes; extend only with measured evidence.
export const AGY_STATE_WRITE_DIRS = ['.gemini/antigravity-cli/log'];
export const sandboxSecretPaths = home => ['.ssh', '.aws', '.gnupg', '.config/gh',
  '.plateau'].map(p => join(home, p));
const safePath = p => {
  if (typeof p !== 'string' || !isAbsolute(p) || normalize(p) !== p || /["\\\x00-\x1f\x7f-\x9f]/.test(p))
    throw new Error('unsafe sandbox path; use another provider or request operator review');
  return p;
};
const inside = (p, root) => p === root || p.startsWith(`${root}/`);

/** Confines the process's own file writes only. Mach/XPC/LaunchServices-mediated writes
 * (defaults, open, osascript, launchctl) are out of scope; this is not a service sandbox.
 * Pure SBPL builder. Inputs are canonical absolute paths resolved by the launcher.
 * deniedPaths lets the launcher resolve secret symlinks; extraDeniedPaths supports isolated probes. */
export function buildSandboxProfile({ transcriptDir, cloneDir, privateTempDir, laneDir, homeDir, workspaceOps,
  agyBinDir, homebrewPrefix, workspaceDir = join(homeDir, 'workspace'), deniedPaths = sandboxSecretPaths(homeDir), extraDeniedPaths = [] }) {
  const stateDirs = AGY_STATE_WRITE_DIRS.map(p => join(homeDir, p));
  const writable = [cloneDir, privateTempDir, ...stateDirs];
  const binaryRoots = [agyBinDir, homebrewPrefix].filter(Boolean);
  safePath(transcriptDir);
  [homeDir, workspaceDir, workspaceOps, laneDir, ...writable, ...binaryRoots, ...deniedPaths, ...extraDeniedPaths].forEach(safePath);
  if ([...writable, workspaceDir, join(homeDir, 'workspace'), laneDir]
    .some(p => inside(transcriptDir, p) || inside(p, transcriptDir)))
    throw new Error('transcript directory overlaps sandbox writable roots/workspace/lane; use another provider or request operator review');
  if (binaryRoots.some(bin => [workspaceDir, join(homeDir, 'workspace')].some(p => inside(bin, p) || inside(p, bin))))
    throw new Error('agy binary overlaps workspace; use another provider or request operator review');
  if ([cloneDir, privateTempDir].some(p => inside(p, join(homeDir, '.gemini')) || inside(join(homeDir, '.gemini'), p)))
    throw new Error('sandbox path overlaps real agy state');
  if (writable.some(p => [workspaceDir, join(homeDir, 'workspace'), laneDir].some(root => inside(p, root) || inside(root, p))))
    throw new Error('sandbox writable path under home/workspace or lane; use another provider or request operator review');
  if (inside(privateTempDir, cloneDir) || inside(cloneDir, privateTempDir))
    throw new Error('sandbox temp must be outside clone; use another provider or request operator review');
  const subpath = p => `(subpath ${JSON.stringify(p)})`;
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* ${writable.map(subpath).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    `(deny file-read* ${[...deniedPaths, workspaceDir, join(homeDir, 'workspace'), workspaceOps, ...extraDeniedPaths].map(subpath).join(' ')})`, ''].join('\n');
}

export function buildSandboxEnv(env, privateTempDir, homeDir) {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|USER|LOGNAME|SHELL|LANG|LC_[A-Za-z0-9_]+|TERM)$/.test(key))),
  HOME: safePath(homeDir), TMPDIR: privateTempDir, TMP: privateTempDir, TEMP: privateTempDir };
}

export const sandboxedSpawnArgv = (profileFile, argv) => ['sandbox-exec', '-f', profileFile, ...argv];
