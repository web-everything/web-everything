import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export const sandboxSecretPaths = home => ['.ssh', '.aws', '.gnupg', '.config/gh',
  'Library/Keychains', '.plateau'].map(p => join(home, p));
const safePath = p => {
  if (typeof p !== 'string' || !isAbsolute(p) || normalize(p) !== p || /["\\\x00-\x1f\x7f-\x9f]/.test(p))
    throw new Error('unsafe sandbox path; use another provider or request operator review');
  return p;
};
const inside = (p, root) => p === root || p.startsWith(`${root}/`);

/** Copy bounded config files and empty immediate directories; redirected paths refuse. */
export function preparePrivateAgyHome(homeDir, privateHomeDir, cloneDir) {
  const inspect = (relative, optional = false) => {
    const source = join(homeDir, '.gemini', relative);
    // Check the nearest existing parent even when optional state has not been created yet.
    let parent = dirname(source);
    for (;;) {
      try { lstatSync(parent); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        parent = dirname(parent);
        continue;
      }
      if (realpathSync(parent) !== parent) throw new Error('redirected agy config');
      break;
    }
    let stat;
    try { stat = lstatSync(source); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('redirected agy config');
    return stat;
  };
  const copy = relative => {
    const source = join(homeDir, '.gemini', relative);
    inspect(relative);
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw new Error('agy config must be a regular file at most 64KB');
      const bytes = Buffer.alloc(65537);
      let length = 0, count;
      while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null))) length += count;
      if (length > 65536 || length !== stat.size) throw new Error('agy config exceeds 64KB or changed during copy');
      return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  };
  try {
    const settings = inspect('antigravity-cli/settings.json', true)
      ? JSON.parse(copy('antigravity-cli/settings.json').toString('utf8')) : {};
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('invalid agy settings');
    const config = inspect('config', true);
    const stateDir = join(privateHomeDir, '.gemini/antigravity-cli');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({ ...settings, trustedWorkspaces: [cloneDir] }), { mode: 0o600, flag: 'wx' });
    const target = join(privateHomeDir, '.gemini/config');
    if (config?.isDirectory()) {
      const entries = readdirSync(join(homeDir, '.gemini/config'));
      if (entries.length > 16) throw new Error('agy config exceeds 16 entries');
      mkdirSync(target, { mode: 0o700 });
      for (const entry of entries) {
        const relative = join('config', entry);
        const stat = inspect(relative);
        if (stat.isDirectory()) mkdirSync(join(target, entry), { mode: 0o700 });
        else writeFileSync(join(target, entry), copy(relative), { mode: 0o600, flag: 'wx' });
      }
    } else if (config) writeFileSync(target, copy('config'), { mode: 0o600, flag: 'wx' });
  } catch {
    throw new Error('private agy config copy failed; use another provider or request operator review');
  }
}

/** Pure SBPL builder. Inputs are canonical absolute paths resolved by the launcher.
 * deniedPaths lets the launcher resolve secret symlinks; extraDeniedPaths supports isolated probes. */
export function buildSandboxProfile({ transcriptDir, cloneDir, privateTempDir, laneDir, homeDir, privateHomeDir, workspaceOps, osTempBase,
  agyBinDir, homebrewPrefix, workspaceDir = join(homeDir, 'workspace'), deniedPaths = sandboxSecretPaths(homeDir), extraDeniedPaths = [] }) {
  const privateState = join(privateHomeDir, '.gemini');
  const writable = [cloneDir, privateTempDir, privateState];
  safePath(osTempBase);
  safePath(transcriptDir);
  const readDenied = ['/Users', '/Volumes', '/private/tmp', '/tmp',
    inside(osTempBase, '/private/var/folders') ? '/private/var/folders' : osTempBase, homeDir];
  const binaryRoots = [agyBinDir, homebrewPrefix].filter(Boolean);
  const readable = [cloneDir, privateTempDir, privateHomeDir, ...binaryRoots];
  readDenied.forEach(safePath);
  [homeDir, workspaceDir, workspaceOps, laneDir, ...writable, ...readable, ...(agyBinDir ? [agyBinDir] : []), ...deniedPaths, ...extraDeniedPaths].forEach(safePath);
  if ([...writable, privateHomeDir, workspaceDir, join(homeDir, 'workspace'), laneDir]
    .some(p => inside(transcriptDir, p) || inside(p, transcriptDir)))
    throw new Error('transcript directory overlaps sandbox writable roots/home/workspace/lane; use another provider or request operator review');
  if (binaryRoots.some(bin => [workspaceDir, join(homeDir, 'workspace')].some(p => inside(bin, p) || inside(p, bin))))
    throw new Error('agy binary overlaps workspace; use another provider or request operator review');
  if (binaryRoots.some(p => inside(p, join(homeDir, '.gemini')) || inside(join(homeDir, '.gemini'), p)))
    throw new Error('agy binary overlaps real state');
  if ([...writable, privateHomeDir].some(p => inside(p, join(homeDir, '.gemini')) || inside(join(homeDir, '.gemini'), p)))
    throw new Error('sandbox path overlaps real agy state');
  if ([cloneDir, laneDir, workspaceDir, join(homeDir, 'workspace')].some(p => inside(privateHomeDir, p) || inside(p, privateHomeDir)))
    throw new Error('private home overlaps clone, lane or workspace');
  if (writable.some(p => [workspaceDir, join(homeDir, 'workspace'), laneDir].some(root => inside(p, root) || inside(root, p))))
    throw new Error('sandbox writable path under home/workspace or lane; use another provider or request operator review');
  if (inside(privateTempDir, cloneDir) || inside(cloneDir, privateTempDir))
    throw new Error('sandbox temp must be outside clone; use another provider or request operator review');
  const subpath = p => `(subpath ${JSON.stringify(p)})`;
  return ['(version 1)', '(allow default)', ...readDenied.map(p => `(deny file-read* ${subpath(p)})`),
    `(allow file-read* ${readable.map(subpath).join(' ')})`, '(deny file-write*)',
    `(allow file-write* ${writable.map(subpath).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    `(deny file-read* ${[...deniedPaths, workspaceDir, join(homeDir, 'workspace'), workspaceOps, ...extraDeniedPaths].map(subpath).join(' ')})`, ''].join('\n');
}

export function buildSandboxEnv(env, privateTempDir, privateHomeDir) {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|USER|LOGNAME|SHELL|LANG|LC_[A-Za-z0-9_]+|TERM)$/.test(key))),
  HOME: safePath(privateHomeDir), TMPDIR: privateTempDir, TMP: privateTempDir, TEMP: privateTempDir };
}

export const sandboxedSpawnArgv = (profileFile, argv) => ['sandbox-exec', '-f', profileFile, ...argv];
