/** Read-only host inspection; NOT yet wired into daemons. */
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decideHostRole, getThisHost, readOwnerRemote } from '../lib/daemon-host-guard.mjs';
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';
import { defaultCachePath } from '../lib/github-app-auth-env.mjs';

const MAX_BUFFER = 1024 * 1024;
const clean = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');

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

function cliIO(env) {
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  return {
    resolveRole: async ({ thisHost, now }) => {
      const remote = await readOwnerRemote();
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
    cloneDirs: () => daemonCloneRoots(env.WE_WORKSPACE_ROOT || dirname(checkout), { env }),
    readHead: (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    parsePreferences: () => JSON.parse(readFileSync(new URL('../lib/delivery-platform-preferences.json', import.meta.url), 'utf8')),
    sshForge: () => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'forge', 'true'], {
      timeout: 15_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runPreflight({ thisHost: getThisHost(), io: cliIO(process.env) });
  console.log(formatPreflight(result));
  process.exitCode = result.ok ? 0 : 1;
}
