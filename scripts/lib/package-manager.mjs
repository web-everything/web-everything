/**
 * packageManager setting (story 5743, slice 1): `npm | pnpm`, resolved through the policy cascade
 * standard (npm) -> platform (platform-preferences.json `packageManager`) -> repo/tool -> env WE_PACKAGE_MANAGER.
 * Nothing calls this yet; install sites are wired in later slices. Only the install verb changes: every
 * `npm run` / `npx` call site stays as it is.
 *
 * Fail closed: an unknown value resolves to npm (never to a lower layer's pnpm); a missing `pnpm` or a failed
 * pnpm install falls back to npm, and says so.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cascadePolicy } from './policy-cascade.mjs';

export const PACKAGE_MANAGERS = ['npm', 'pnpm'];
const text = (v) => (v === undefined || v === null || !String(v).trim() ? undefined : String(v).trim());

/** @returns {{manager:'npm'|'pnpm', source:string, value:unknown, note?:string}} */
export function resolvePackageManager({ env = process.env, tool, platform, log } = {}) {
  const r = cascadePolicy('packageManager', text(tool), {
    standard: 'npm', platform, env, envValues: { '': text(env.WE_PACKAGE_MANAGER) }, ...(log ? { log } : {}),
  });
  const source = r.sources[''] ?? 'standard';
  const value = r.value;
  if (PACKAGE_MANAGERS.includes(value)) return { manager: value, source, value };
  return { manager: 'npm', source, value, note: `unknown packageManager ${JSON.stringify(value)} (from ${source}); using npm` };
}

const defaultPnpmVersion = () => execFileSync('pnpm', ['--version'], { stdio: 'pipe', timeout: 30_000 }).toString().trim();

/** @returns {{bin:string, args:string[], manager:string, source:string, note?:string}} */
export function installArgv({ ci = false, ignoreScripts = false, pnpmVersion = defaultPnpmVersion, ...opts } = {}) {
  const r = resolvePackageManager(opts);
  let { manager, note } = r;
  if (manager === 'pnpm') {
    try { pnpmVersion(); } catch { manager = 'npm'; note = `pnpm --version failed (from ${r.source}); using npm`; }
  }
  const args = manager === 'pnpm' ? ['install', ...(ci ? ['--frozen-lockfile'] : [])] : [ci ? 'ci' : 'install'];
  if (ignoreScripts) args.push('--ignore-scripts');
  return { bin: manager, args, manager, source: r.source, ...(note ? { note } : {}) };
}

/** The install command line as text (`frozen` = lockfile-exact install). */
export function installCommand({ frozen = false, ...opts } = {}) {
  const { bin, args } = installArgv({ ci: frozen, ...opts });
  return [bin, ...args].join(' ');
}

/** Run the install; a failed pnpm install falls back to `npm ci`/`npm install` and logs it. */
export function installWithFallback({ frozen = false, ignoreScripts = false, cwd, exec = (bin, args, o) => execFileSync(bin, args, { stdio: 'inherit', ...o }), log = (l) => console.error(l), ...opts } = {}) {
  const first = installArgv({ ci: frozen, ignoreScripts, ...opts });
  if (first.note) log(`package-manager · ${first.note}`);
  try { exec(first.bin, first.args, { cwd }); return { ...first, fellBack: false }; }
  catch (e) {
    if (first.manager !== 'pnpm') throw e;
    log(`package-manager · pnpm install failed (${String(e?.message ?? e).split('\n')[0]}); falling back to npm ${frozen ? 'ci' : 'install'}`);
    const args = [frozen ? 'ci' : 'install', ...(ignoreScripts ? ['--ignore-scripts'] : [])];
    exec('npm', args, { cwd });
    return { bin: 'npm', args, manager: 'npm', source: first.source, fellBack: true };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv.includes('--explain')) {
  const r = installArgv({ ci: true });
  console.log(`packageManager=${r.manager} source=${r.source} command="${[r.bin, ...r.args].join(' ')}"${r.note ? ` note="${r.note}"` : ''}`);
}
