#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = '/srv/forge-exec';
const LIMIT = 4 * 1024 * 1024;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const ENV_KEYS = ['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR'];
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const newRunId = () => `${new Date().toISOString().replace(/[^0-9tz]/gi, '').toLowerCase()}-${randomBytes(4).toString('hex')}`;

export function isAllowedCommand(argv) {
  return Array.isArray(argv) && argv.length >= 3 && argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    && argv[0] === 'npm' && argv[1] === 'run' && ['test:unit', 'check:standards'].includes(argv[2]);
}

export function filterEnv(env = {}) {
  return Object.fromEntries(ENV_KEYS.filter((key) => Object.hasOwn(env, key) && typeof env[key] === 'string'
    && !env[key].includes('\0')).map((key) => [key, env[key]]));
}

export function validateRunId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{5,63}$/.test(id);
}

export function buildRemoteScript({ runId, lockHash, env = {}, argv, retainRun = false }) {
  if (!validateRunId(runId) || !/^[a-f0-9]{64}$/.test(lockHash) || !isAllowedCommand(argv)) {
    throw new Error('Invalid remote execution parameters');
  }
  const dir = `${ROOT}/${runId}`;
  // Version the install profile so an older production-only cache is never reused.
  const cacheRoot = `${ROOT}/.cache/${lockHash}`;
  const cache = `${cacheRoot}/dev-v1`;
  const cleanEnv = `env -i PATH=/usr/local/bin:/usr/bin:/bin ${Object.entries(filterEnv(env)).map(([k, v]) => `${k}=${quote(v)}`).join(' ')}`;
  return `set -euo pipefail
mkdir -p ${quote(dir)}
trap 'code=$?; trap - EXIT; if [ "\${ran:-0}" = 1 ]; then printf "%s\\n" "$code" > ${quote(`${dir}/.exit-code`)}; fi; ${retainRun ? ':' : `rm -rf -- ${quote(dir)}`}; exit "$code"' EXIT
cd ${quote(dir)}
mkdir -p ${quote(cache)}
# Serialize cache creation on the Linux execution host.
if command -v flock >/dev/null 2>&1; then
  exec 9>${quote(`${cache}/.lock`)}
  flock -x 9
fi
if [ ! -d ${quote(`${cache}/node_modules`)} ]; then
  # Install output must not pollute the command's streamed output; show a tail only on failure.
  if ! ${cleanEnv} npm ci --include=dev --ignore-scripts --no-audit --no-fund >.npm-ci.log 2>&1; then tail -n 20 .npm-ci.log >&2; exit 97; fi
  rm -f .npm-ci.log
  mv node_modules ${quote(`${cache}/node_modules`)}
fi
touch ${quote(cacheRoot)} ${quote(cache)}
cp -a --reflink=auto ${quote(`${cache}/node_modules`)} node_modules 2>/dev/null || cp -a ${quote(`${cache}/node_modules`)} node_modules
if command -v flock >/dev/null 2>&1; then flock -u 9; exec 9>&-; fi
ran=1
${cleanEnv} ${argv.map(quote).join(' ')}
`;
}

// Captures have a hard byte limit; streamed command output is inherited verbatim.
// @test-only-export-ok: the capture boundary suite exercises this process adapter directly.
export function defaultExec({ file, args, cwd, input, inherit = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, file === 'ssh' ? [...SSH_OPTIONS, ...args] : args, {
      cwd, stdio: [input === undefined ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let bytes = 0;
    let exceeded = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMIT) { exceeded = true; child.kill('SIGKILL'); return; }
        if (stream === child.stdout) stdout += chunk.toString();
      });
    }
    child.on('error', reject);
    child.on('close', (code) => exceeded ? reject(new Error('Captured output limit exceeded')) : resolve({ code: code ?? 1, stdout }));
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // A failed SSH may close stdin before reading.
      child.stdin.end(input);
    }
  });
}

function safeFiles(files) {
  if (!Array.isArray(files)) throw new Error('Invalid file inventory');
  const safe = files.filter((path) => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('Invalid file path');
    const parts = path.split('/');
    if (parts.some((part) => part === '..' || part === '.')) throw new Error('Unsafe file path');
    return !parts.some((part) => /^(?:node_modules|\.git|\.env(?:\..*)?|\.secrets|\.ssh|\.aws|\.claude|\.codex|\.npmrc|\.netrc|credentials(?:\..*)?|.*\.(?:pem|key))$/i.test(part));
  });
  const input = [...new Set(safe)].join('\n') + '\n';
  if (Buffer.byteLength(input) > LIMIT) throw new Error('File inventory limit exceeded');
  return input;
}

export async function runRemote({ argv, cwd = process.cwd(), env = process.env, runId = newRunId(), host = 'forge', exec = defaultExec, listFiles } = {}) {
  const fallback = (reason) => ({ mode: 'fallback', reason });
  if (!isAllowedCommand(argv)) return fallback('command-not-allowed');
  if (!validateRunId(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) return fallback('invalid-parameters');
  try {
    if ((await exec({ file: 'ssh', args: [host, 'true'], cwd })).code !== 0) return fallback('forge-unreachable');
  } catch { return fallback('forge-unreachable'); }
  const dir = `${ROOT}/${runId}`;
  const ssh = (script, inherit = false) => exec({ file: 'ssh',
    args: [host, inherit ? 'sudo -u forge-exec bash -s' : `sudo -u forge-exec bash -c ${quote(script)}`],
    ...(inherit ? { input: script } : {}), cwd, inherit });
  const cleanup = async () => { try { await ssh(`rm -rf -- ${quote(dir)}`); } catch { /* Daily pruning is the final cleanup backstop. */ } };
  let lockHash;
  try {
    lockHash = createHash('sha256').update(await readFile(join(cwd, 'package-lock.json'))).digest('hex');
    const files = listFiles ? await listFiles(cwd) : await (async () => {
      const result = await exec({ file: 'git', args: ['ls-files', '-co', '--exclude-standard', '-z'], cwd });
      if (result.code !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > LIMIT) throw new Error('File inventory unavailable');
      return result.stdout.split(result.stdout.includes('\0') ? '\0' : '\n').filter(Boolean);
    })();
    const inventory = safeFiles(files);
    // This repository's shared config aliases both plugs and webtheme into
    // ../frontierui. Our single-repository transport cannot reproduce that layout.
    // Conservatively use local admission for either command until sibling snapshots
    // are supported; do not turn a missing remote dependency into a test failure.
    if (files.includes('vitest.shared.ts')) return fallback('unsupported-sibling-dependency');
    // No --mkpath: macOS openrsync lacks it; rsync creates the final run dir under the existing /srv/forge-exec.
    const copied = await exec({ file: 'rsync', args: ['-a', '--delete', '--files-from=-', '--rsync-path=sudo -u forge-exec rsync', '-e', `ssh ${SSH_OPTIONS.join(' ')}`, './', `${host}:${dir}/`], cwd, input: inventory });
    if (copied.code !== 0) throw new Error('Copy failed');
  } catch { await cleanup(); return fallback('copy-failed'); }
  try {
    const result = await ssh(buildRemoteScript({ runId, lockHash, env, argv, retainRun: true }), true);
    const receipt = await ssh(`head -c 32 -- ${quote(`${dir}/.exit-code`)}`);
    if (receipt.code !== 0 || typeof receipt.stdout !== 'string' || !/^(?:0|[1-9][0-9]{0,2})\n?$/.test(receipt.stdout)) return fallback('ambiguous-result');
    const code = Number(receipt.stdout);
    if (code >= 255 || code !== result.code) return fallback('ambiguous-result');
    return { mode: 'remote', code };
  } catch { return fallback('ambiguous-result'); }
  finally { await cleanup(); }
}

export async function runWithRemoteFallback(options = {}) {
  const result = await runRemote(options);
  if (result.mode === 'remote') return result.code;
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  log(`remote-exec: falling back to local (${result.reason})`);
  const local = options.local ?? (async (argv) => (await defaultExec({ file: process.execPath,
    args: ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=600000', '--', ...argv], cwd: options.cwd, inherit: true })).code);
  return local(options.argv);
}

export function parseArgs(args) {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) throw new Error('Usage: remote-exec.mjs [--host=forge] [--run-id=<id>] -- <command...>');
  const options = { host: 'forge', runId: newRunId(), argv: args.slice(separator + 1) };
  for (const arg of args.slice(0, separator)) {
    if (arg.startsWith('--host=')) options.host = arg.slice(7);
    else if (arg.startsWith('--run-id=')) options.runId = arg.slice(9);
    else throw new Error('Unknown remote-exec option');
  }
  if (!validateRunId(options.runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.host)) throw new Error('Invalid host or run id');
  return options;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await runWithRemoteFallback(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`remote-exec: ${error.message}\n`); process.exitCode = 1; }
}
