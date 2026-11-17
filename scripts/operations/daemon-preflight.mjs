/** Read-only host inspection; NOT yet wired into daemons. */
import { accessSync, constants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decideHostRole, defaultCachePath as hostCachePath, getThisHost, readOwnerRemote } from '../lib/daemon-host-guard.mjs';
import { DAEMON_CLONE_SEED, classifyOverlayRecord } from '../lib/daemon-clone-registry.mjs';
import { defaultCachePath } from '../lib/github-app-auth-env.mjs';

const MAX_BUFFER = 1024 * 1024;
export const clean = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');

/** All effects are injected reads. A failed check never prevents later checks. */
export async function runPreflight({ thisHost, io, env = process.env, now = Date.now() } = {}) {
  const checks = [];
  const check = async (name, probe) => {
    try {
      const { ok, detail } = await probe();
      checks.push({ name, ok: ok === true, detail: clean(detail) });
    } catch (error) {
      checks.push({ name, ok: false, detail: clean(error?.message ?? error) });
    }
  };
  await check('role', async () => {
    const result = await io.resolveRole({ thisHost, now });
    return { ok: ['active', 'standby'].includes(result?.role) && typeof result?.reason === 'string'
      && result.source !== 'remote-failed' && !['invalid-input', 'owner-unreadable', 'start-requires-fresh-read', 'clock-skew'].includes(result.reason),
    detail: `role=${result?.role} reason=${result?.reason}` };
  });
  await check('cache-lock', () => io.cacheLock());
  for (const tool of ['node', 'claude', 'gh', 'codex']) {
    await check(`tool:${tool}`, async () => ({ ok: await io.which(tool) === true, detail: tool }));
  }
  // Discovery failures are explicit failures rather than silently empty lists.
  let keys = [];
  try {
    keys = await io.keyFiles(env);
    if (!Array.isArray(keys)) throw new Error('keyfile list unreadable');
  } catch (error) {
    keys = [];
    await check('keyfiles', () => { throw error; });
  }
  for (const key of keys) {
    await check(`keyfile:${key?.name ?? 'unknown'}`, async () => {
      if (typeof key?.path !== 'string' || !key.path.trim()) throw new Error('keyfile path missing');
      return { ok: await io.statFile(key.path) === true, detail: key.path };
    });
  }
  let clones = [];
  try {
    clones = await io.cloneDirs();
    if (!Array.isArray(clones)) throw new Error('clone list unreadable');
  } catch (error) {
    clones = [];
    await check('clone-dirs', () => { throw error; });
  }
  for (const dir of clones) {
    await check(`clone-head:${dir}`, async () => {
      if (typeof dir !== 'string' || !dir.trim()) throw new Error('clone path missing');
      const head = await io.readHead(dir);
      return { ok: typeof head === 'string' && /^[a-f0-9]{40}$/.test(head), detail: head };
    });
  }
  await check('platform-preferences', async () => {
    const preferences = await io.parsePreferences();
    return { ok: preferences !== null && typeof preferences === 'object' && !Array.isArray(preferences),
      detail: 'delivery-platform-preferences.json' };
  });
  await check('ssh:forge', async () => {
    const result = await io.sshForge();
    return { ok: result?.status === 0 && !result.error && !result.signal, detail: `status=${result?.status}` };
  });
  return { ok: checks.every(({ ok }) => ok), checks };
}

export function formatPreflight(result) {
  return result.checks.map(({ name, ok, detail }) => `${ok ? 'ok  ' : 'FAIL'} ${clean(name)} ${clean(detail)}`).join('\n');
}

// The hook registry deliberately skips discovery errors. Preflight needs strict
// reads, while sharing its seed and live-record predicate with those hooks.
function discoverCloneDirs(workspace, { env }) {
  const overlayDir = env.WE_DAEMON_OVERLAY_DIR?.trim() || join(homedir(), '.claude', 'daemon-overlays');
  const roots = DAEMON_CLONE_SEED.map((name) => join(workspace, name));
  for (const name of readdirSync(overlayDir)) {
    if (!name.endsWith('.json') || name.includes('.json.')) continue;
    const file = join(overlayDir, name);
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (!record || typeof record.clone !== 'string' || !record.clone.trim()
        || !Array.isArray(record.overlays)) throw new Error('invalid overlay record');
      if (classifyOverlayRecord(record, workspace).live) roots.push(record.clone);
    } catch (error) {
      throw new Error(`clone discovery ${file}: ${error.message}`);
    }
  }
  return [...new Set(roots.map((root) => {
    try { return realpathSync(root); } catch { return resolve(root); } // readHead reports inaccessible clones.
  }))];
}

export function cliIO(env = process.env, options = {}) {
  for (const key of Object.keys(options)) {
    if (!['readOwnerRemote', 'execFileSync', 'spawnSync', 'daemonCloneRoots'].includes(key)) {
      throw new TypeError(`unknown cliIO option: ${key}`);
    }
  }
  const { readOwnerRemote: readRemote = readOwnerRemote, execFileSync: exec = execFileSync,
    spawnSync: spawn = spawnSync, daemonCloneRoots: cloneRoots = discoverCloneDirs } = options;
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  return {
    cacheLock: () => {
      const lock = `${hostCachePath(env.HOME || homedir())}.lock`;
      try { lstatSync(lock); }
      catch (error) {
        if (error.code === 'ENOENT') return { ok: true, detail: 'no retained lock' };
        throw error;
      }
      return { ok: false, detail: `${lock}: ownership fenced; stop all guard writers and inspect the holder, cache permissions and disk capacity; remove the lock only after repairing cache evidence, then restart with a fresh owner read` };
    },
    resolveRole: async ({ thisHost, now }) => {
      let remote;
      try { remote = await readRemote(); } catch { /* Unreadable startup evidence fails closed. */ }
      const readable = (remote?.status === 'ok' && typeof remote.owner === 'string' && remote.owner !== '')
        || remote?.status === 'unset';
      if (!readable) return { ...decideHostRole({ thisHost, now }), source: 'remote-failed' };
      return { ...decideHostRole({ thisHost, now, atStart: true,
        owner: remote.status === 'ok' ? remote.owner : remote.status === 'unset' ? '' : null,
        ownerReadAt: remote.status === 'error' ? undefined : now }),
      source: remote.status === 'error' ? 'remote-failed' : 'remote' };
    },
    which: (tool) => (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => {
      try {
        const path = join(dir, tool);
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch { return false; }
    }),
    keyFiles: (environment) => [
      { name: 'WE_GITHUB_APP_PRIVATE_KEY_PATH', path: environment.WE_GITHUB_APP_PRIVATE_KEY_PATH },
      // Auth has no token-cache environment override; use its canonical path.
      { name: 'github-app-token-cache', path: defaultCachePath() },
    ],
    statFile: (path) => statSync(path).isFile(),
    cloneDirs: () => cloneRoots(env.WE_WORKSPACE_ROOT || dirname(checkout), { env }),
    readHead: (dir) => {
      const git = (...args) => exec('git', ['-C', dir, ...args], {
        env, encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      // A plain directory inside another checkout must not pass via the parent repo's HEAD.
      if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(dir)) throw new Error('not a git checkout root');
      return git('rev-parse', 'HEAD');
    },
    parsePreferences: () => JSON.parse(readFileSync(new URL('../lib/delivery-platform-preferences.json', import.meta.url), 'utf8')),
    sshForge: () => spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'forge', 'true'], {
      env, timeout: 15_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    }),
  };
}

export async function main({ thisHost = getThisHost(), env = process.env,
  io = cliIO(env), log = console.log, now = Date.now() } = {}) {
  const result = await runPreflight({ thisHost, env, io, now });
  log(formatPreflight(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
