#!/usr/bin/env node
import '../lib/tools-root-guard.mjs';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestInput, digestArgv, digestLock } from './forge-exec-run.mjs';

const ROOT = '/srv/forge-exec';
const LIMIT = 4 * 1024 * 1024;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const ENV_KEYS = ['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR'];
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const newRunId = () => `${new Date().toISOString().replace(/[^0-9tz]/gi, '').toLowerCase()}-${randomBytes(4).toString('hex')}`;

export function isAllowedCommand(argv) {
  // Only task arguments may follow the script name; npm options can skip or replace execution.
  return Array.isArray(argv) && argv.length >= 3 && argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    && argv[0] === 'npm' && argv[1] === 'run' && ['test:unit', 'check:standards'].includes(argv[2])
    && (argv.length === 3 || argv[3] === '--');
}

export function filterEnv(env = {}) {
  return Object.fromEntries(ENV_KEYS.filter((key) => Object.hasOwn(env, key) && typeof env[key] === 'string'
    && !env[key].includes('\0')).map((key) => [key, env[key]]));
}

export function validateRunId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{5,63}$/.test(id);
}

// Captures have a hard byte limit; streamed command output is inherited verbatim.
// @test-only-export-ok: the capture boundary suite exercises this process adapter directly.
export function defaultExec({ file, args, cwd, input, inherit = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, file === 'ssh' ? [...SSH_OPTIONS, ...args] : args, {
      cwd, stdio: [input === undefined ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
    });
    const stdout = [];
    let bytes = 0;
    let exceeded = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMIT) { exceeded = true; child.kill('SIGKILL'); return; }
        if (stream === child.stdout) stdout.push(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => exceeded ? reject(new Error('Captured output limit exceeded'))
      : resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8') }));
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
    if (parts.some((part) => !part || part === '..' || part === '.')) throw new Error('Unsafe file path');
    return !parts.some((part) => part === '.exit-code' || /^(?:node_modules|\.git|\.env(?:\..*)?|\.secrets|\.ssh|\.aws|\.claude|\.codex|\.npmrc|\.netrc|credentials(?:\..*)?|.*\.(?:pem|key))$/i.test(part));
  });
  // openrsync still treats leading #/; as comments with --from0. Anchor every
  // validated relative path so both rsync implementations read it literally.
  const input = [...new Set(safe)].map((path) => `./${path}\0`).join('');
  if (Buffer.byteLength(input) > LIMIT) throw new Error('File inventory limit exceeded');
  return input;
}

async function validateInventory(root, files) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Invalid input root');
  for (const file of files) {
    const parts = file.split('/');
    let path = root;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Input symlink');
      // A directory leaf would let recursive rsync send unlisted contents.
      if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw new Error('Invalid inventory component');
    }
  }
}

export async function runRemote({ argv, cwd = process.cwd(), env = process.env, runId = newRunId(), host = 'forge', exec = defaultExec, listFiles } = {}) {
  const fallback = (reason) => ({ mode: 'fallback', reason });
  if (!isAllowedCommand(argv)) return fallback('command-not-allowed');
  // Standards inspects Git's work tree and index. The transported snapshot has
  // neither, so run it through local admission instead of certifying a false failure.
  if (argv[2] === 'check:standards') return fallback('requires-git-worktree');
  if (!validateRunId(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) return fallback('invalid-parameters');
  try {
    if ((await exec({ file: 'ssh', args: [host, 'true'], cwd })).code !== 0) return fallback('forge-unreachable');
  } catch { return fallback('forge-unreachable'); }
  const nonce = randomBytes(16).toString('hex');
  const ssh = (command, request, inherit = false) => exec({file:'ssh',
    args:[host, `sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs ${command}`],
    input:JSON.stringify(request), cwd, inherit});
  let run;
  let finished = false;
  const finish = async () => {
    if (!run || finished) return null;
    finished = true;
    return ssh('finish', {nonce,run});
  };
  try {
    let expected;
    try {
      const files = listFiles ? await listFiles(cwd) : await (async () => {
        const result = await exec({file:'git',args:['ls-files','-co','--exclude-standard','-z'],cwd});
        if(result.code !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout)>LIMIT) throw new Error('Inventory unavailable');
        return result.stdout.split(result.stdout.includes('\0')?'\0':'\n').filter(Boolean);
      })();
      const inventory = safeFiles(files);
      if(files.includes('vitest.shared.ts')) return fallback('unsupported-sibling-dependency');
      const selected = inventory.split('\0').filter(Boolean).map(name=>name.slice(2));
      await validateInventory(cwd, selected);
      const lock = await digestLock(cwd);
      // Reject incomplete or linked input before transmitting any file bytes.
      const inputDigest = await digestInput(cwd, selected);
      const prepared = await ssh('prepare',{nonce,label:runId});
      if(prepared.code !== 0 || typeof prepared.stdout !== 'string' || prepared.stdout.length>1024) throw new Error('Prepare failed');
      run = JSON.parse(prepared.stdout).run;
      if(typeof run !== 'string' || !/^r-[a-f0-9]{32}$/.test(run)) {run=undefined; throw new Error('Invalid server run');}
      const copied = await exec({file:'rsync',args:['-a','-r','--no-links','--safe-links','--no-implied-dirs','--delete','--exclude=.exit-code',
        ...['node_modules','.git','.env*','.secrets','.ssh','.aws','.claude','.codex','.npmrc','.netrc','credentials*','*.pem','*.key'].map(name=>`--exclude=${name}`),
        '--from0','--files-from=-','--rsync-path=sudo -u forge-exec rsync','-e',`ssh ${SSH_OPTIONS.join(' ')}`,
        './',`${host}:${ROOT}/${run}/work/`],cwd,input:inventory});
      if(copied.code !== 0) throw new Error('Copy failed');
      expected = {v:1,nonce,run,inputDigest,argvDigest:digestArgv(argv),lock};
    } catch {return fallback('copy-failed');}
    try {
      const result = await ssh('run',{...expected,argv,env:filterEnv(env)},true);
      const receipt = await finish();
      if(!receipt || receipt.code!==0 || typeof receipt.stdout!=='string' || Buffer.byteLength(receipt.stdout)>4096) return fallback('ambiguous-result');
      if(!verifyReceipt(receipt.stdout,expected,result.code)) return fallback('ambiguous-result');
      return {mode:'remote',code:result.code};
    } catch {return fallback('ambiguous-result');}
  } finally {try {await finish();} catch { /* Pruning is the cleanup backstop; never retry execution. */ }}
}

export function verifyReceipt(text, expected, code) {
  try {
    const receipt=JSON.parse(text);
    return receipt && Object.keys(receipt).sort().join(',') === 'argvDigest,code,inputDigest,lock,nonce,phase,run,v'
      && Object.entries(expected).every(([key,value])=>receipt[key]===value)
      && receipt.phase==='test' && Number.isInteger(code) && code>=0 && code<255 && receipt.code===code;
  } catch {return false;}
}

export async function runWithRemoteFallback(options = {}) {
  // A rejected command must not regain execution through local fallback.
  if (!isAllowedCommand(options.argv)) throw new Error('command-not-allowed: use npm run <allowed-task> -- <task-args>');
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
