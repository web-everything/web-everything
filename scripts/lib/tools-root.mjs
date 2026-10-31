/** R259 prototype: optional tools.root (platform), overridden by WE_TOOLS_ROOT (environment).
 * Unset means local tooling. Invalid or unavailable evidence also falls back locally, with a reason.
 * No tool-layer default; this setting deliberately uses the host preferences location.
 */
import * as nativeFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { CLONES_DIR_NAME } from './daemon-clone-layout.mjs';

export function boundedToolsText(path, fs = nativeFs, limit = 256 * 1024) {
  const fd = fs.openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > limit) throw Error('tools-root input exceeds byte limit; use local tooling');
    return bytes.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const transient = path => path.split(sep).some(part => part === '.lanes' || part === CLONES_DIR_NAME
  || /(?:^|-)daemon(?:-|$)/.test(part));

/** Injectable filesystem and git seams; never throws, including malformed settings and failed git. */
export function resolveToolsRoot({ scriptRelPath, env = process.env, home = homedir(), ownRoot,
  fs = nativeFs, git = (root, args) => spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
  }),
} = {}) {
  try {
    let candidate = env.WE_TOOLS_ROOT;
    if (candidate === undefined) {
      let prefs;
      try { prefs = JSON.parse(boundedToolsText(env.WE_PLATFORM_PREFERENCES || join(home, '.claude', 'platform-preferences.json'), fs)); }
      catch (error) { if (error?.code === 'ENOENT') return { active: false }; throw error; }
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw Error('platform preferences must be an object');
      candidate = prefs.tools?.root;
    }
    if (candidate === undefined) return { active: false };
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) throw Error('tools.root must be an absolute path');
    const root = fs.realpathSync(candidate);
    if (transient(candidate) || transient(root) || inside(join(home, 'workspace', '.lanes'), root)) {
      throw Error('tools.root cannot be a lane or daemon clone');
    }
    if (typeof scriptRelPath !== 'string' || isAbsolute(scriptRelPath) || !scriptRelPath
      || !inside(root, join(root, scriptRelPath))) throw Error('entry script must be inside its repository');
    if (!fs.existsSync(join(root, '.git'))
      || JSON.parse(boundedToolsText(join(root, 'package.json'), fs)).name !== 'web-everything') {
      throw Error('tools.root is not a web-everything checkout');
    }
    const script = join(root, scriptRelPath);
    if (!fs.statSync(script).isFile() || !inside(root, fs.realpathSync(script))) throw Error('requested script is missing or outside tools.root');
    const top = git(root, ['rev-parse', '--show-toplevel']);
    if (top.error || top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== root) throw Error('tools.root is not a git checkout root');
    const head = git(root, ['rev-parse', 'HEAD']);
    const sha = head.stdout?.trim();
    if (head.error || head.status !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)) throw Error('tools.root HEAD is unavailable');
    if (root === fs.realpathSync(ownRoot)) return { active: false };
    return { active: true, root, sha };
  } catch (error) {
    return { active: false, reason: String(error?.message ?? error) };
  }
}
