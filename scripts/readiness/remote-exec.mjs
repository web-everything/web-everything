#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestInput, digestArgv } from './forge-exec-run.mjs';

const ROOT = '/srv/forge-exec';
const LIMIT = 4 * 1024 * 1024;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const ENV_KEYS = ['CI', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR'];
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const newRunId = () => `${new Date().toISOString().replace(/[^0-9tz]/gi, '').toLowerCase()}-${randomBytes(4).toString('hex')}`;

// Admission sees the expanded package script, whereas the wrapper accepts npm argv.
function normalizeCommand(argv) {
  const offset = argv?.[0] === 'npx' ? 1 : 0;
  return Array.isArray(argv) && argv[offset] === 'vitest' && argv[offset + 1] === 'run'
    ? ['npm', 'run', 'test:unit', '--', ...argv.slice(offset + 2)] : argv;
}

export function isAllowedCommand(argv) {
  argv = normalizeCommand(argv);
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
export function defaultExec({ file, args, cwd, input, inherit = false, signal }) {
  if (signal?.aborted) return Promise.resolve({ mode: 'cancelled', terminated: true });
  return new Promise((resolve, reject) => {
    const child = spawn(file, file === 'ssh' ? [...SSH_OPTIONS, ...args] : args, {
      cwd, detached: true, stdio: [input === undefined ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
    });
    // Include rsync's SSH child. Never acknowledge termination from kill() alone.
    const kill = () => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const stdout = [];
    let bytes = 0;
    let exceeded = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMIT) { exceeded = true; kill(); return; }
        if (stream === child.stdout) stdout.push(chunk);
      });
    }
    let error;
    child.on('error', (value) => { error = value; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) resolve({ mode: 'cancelled', terminated: true });
      else if (error || exceeded) reject(error ?? new Error('Captured output limit exceeded'));
      // A UTF-8 filename may span data events. Decode only complete output;
      // the capture limit above still counts raw bytes from both streams.
      else resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8') });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // A failed SSH may close stdin before reading.
      child.stdin.end(input);
    }
  });
}

// These basename globs are shared by inventory validation and rsync. Expand
// letters for rsync's case-sensitive matching rather than maintaining a second,
// subtly different credential denylist at the transport boundary.
const omittedFiles = ['.exit-code', 'node_modules', '.git'];
const credentialFiles = ['.git-credentials', '.git-credentials[-.~_]*', 'id_*',
  'identity', 'identity[-.~_]*', '.env*', '.secrets', '.ssh', '.aws', '.claude',
  '.codex', '.npmrc', '.netrc', 'credentials', 'credentials.*', '*.pem', '*.key'];
const identitySources = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].map(ext => `identity.${ext}`);
const basenamePattern = glob => new RegExp(`^${glob.replaceAll('.', '\\.').replaceAll('*', '.*')}$`, 'is');
const omittedPatterns = omittedFiles.map(basenamePattern);
const credentialPatterns = credentialFiles.map(basenamePattern);
const identityPatterns = identitySources.map(basenamePattern);
const rsyncPattern = glob => glob.replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`);
const inventoryFilters = [
  ...omittedFiles.map(name => `--exclude=${rsyncPattern(name)}`),
  ...identitySources.map(name => `--include=${rsyncPattern(name)}`),
  ...credentialFiles.map(name => `--exclude=${rsyncPattern(name)}`),
];

function safeFiles(files) {
  if (!Array.isArray(files)) throw new Error('Invalid file inventory');
  const dropped = [];
  const safe = files.filter((path) => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || /[\0\r\n\ufffd]/.test(path)
      || Buffer.from(path, 'utf8').toString('utf8') !== path) throw new Error('Invalid file path');
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '..' || part === '.')) throw new Error('Unsafe file path');
    const reason = parts.some(part => omittedPatterns.some(pattern => pattern.test(part))) ? 'generated'
      : parts.some(part => !identityPatterns.some(pattern => pattern.test(part))
        && credentialPatterns.some(pattern => pattern.test(part))) ? 'credential' : null;
    if (reason) dropped.push({ path, reason });
    return !reason;
  });
  // openrsync still treats leading #/; as comments with --from0. Anchor every
  // validated relative path so both rsync implementations read it literally.
  // Deduplicate exact strings only: never normalize Unicode, case or slashes.
  // The caller also checks cardinality against Git's original inventory.
  const selected = [...new Set(safe)];
  const input = selected.map((path) => `./${path}\0`).join('');
  if (Buffer.byteLength(input) > LIMIT) throw new Error('File inventory limit exceeded');
  return { input, dropped, selected };
}

export async function runRemote({ argv, cwd = process.cwd(), env = process.env, runId = newRunId(), host = 'forge', exec = defaultExec, listFiles, signal } = {}) {
  const fallback = (reason) => ({ mode: 'fallback', reason });
  let transportTerminated = true;
  const cancelled = () => ({ mode: 'cancelled', terminated: transportTerminated });
  const uncertain = () => ({ mode: 'uncertain', reason: 'ambiguous-result', terminated: false });
  const checkAbort = () => { if (signal?.aborted) throw new Error('Remote execution cancelled'); };
  const execute = async (request) => {
    // A resolved/rejected adapter promise alone is not proof its child stopped.
    // Cleanup has its own signal and must not overwrite the attempt's evidence.
    const attempt = request.signal === signal;
    if (attempt) transportTerminated = false;
    const result = await exec(request);
    if (attempt) transportTerminated = result?.mode === 'cancelled'
      ? result.terminated === true
      : result?.terminated !== false && Number.isInteger(result?.code) && result.code >= 0 && result.code <= 255;
    return result;
  };
  argv = normalizeCommand(argv);
  if (signal?.aborted) return cancelled();
  if (!isAllowedCommand(argv)) return fallback('command-not-allowed');
  // Standards inspects Git's work tree and index. The transported snapshot has
  // neither, so run it through local admission instead of certifying a false failure.
  if (argv[2] === 'check:standards') return fallback('requires-git-worktree');
  if (!validateRunId(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) return fallback('invalid-parameters');
  try {
    checkAbort();
    const probe = await execute({ file: 'ssh', args: [host, 'true'], cwd, signal });
    if (signal?.aborted) return cancelled();
    if (probe.code !== 0) return fallback('forge-unreachable');
  } catch { return signal?.aborted ? cancelled() : fallback('forge-unreachable'); }
  const nonce = randomBytes(16).toString('hex');
  const ssh = (command, request, inherit = false, operationSignal = signal) => {
    const input = JSON.stringify(request);
    if (operationSignal?.aborted) return Promise.resolve(cancelled());
    return execute({file:'ssh', args:[host, `sudo -n -u ops /usr/local/libexec/forge-exec-run ${command}`],
      input, cwd, inherit, signal: operationSignal});
  };
  let run;
  let finished = false;
  let dispatched = false;
  const finish = async () => {
    if (!run || finished) return null;
    finished = true;
    // Cleanup is bounded independently, so aborting a copy still cleans its run.
    return ssh('finish', {nonce,run}, false, AbortSignal.timeout(1000));
  };
  try {
    let expected;
    try {
      const lock = createHash('sha256').update(await readFile(join(cwd,'package-lock.json'))).digest('hex');
      checkAbort();
      const files = listFiles ? await listFiles(cwd) : await (async () => {
        const result = await execute({file:'git',args:['ls-files','-co','--exclude-standard','-z'],cwd,signal});
        if(result.code !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout)>LIMIT) throw new Error('Inventory unavailable');
        if (result.stdout === '') return [];
        if (!result.stdout.endsWith('\0')) throw new Error('Invalid file inventory framing');
        // Remove only the terminator; empty interior entries must fail validation.
        return result.stdout.slice(0, -1).split('\0');
      })();
      const { input: inventory, dropped, selected } = safeFiles(files);
      checkAbort();
      if(dropped.some(file => file.reason !== 'generated')) return fallback('filtered-inventory');
      // Only explicitly classified generated files may be omitted. A duplicate
      // or any other count loss must not certify a reduced selection.
      if (inventory.split('\0').length - 1 !== files.length - dropped.length) throw new Error('File inventory count mismatch');
      if(files.includes('vitest.shared.ts')) return fallback('unsupported-sibling-dependency');
      const prepared = await ssh('prepare',{nonce,label:runId});
      if(prepared.code !== 0 || typeof prepared.stdout !== 'string' || prepared.stdout.length>1024) throw new Error('Prepare failed');
      run = JSON.parse(prepared.stdout).run;
      if(typeof run !== 'string' || !/^r-[a-f0-9]{32}$/.test(run)) {run=undefined; throw new Error('Invalid server run');}
      checkAbort();
      const copied = await execute({file:'rsync',args:['-a','--delete',...inventoryFilters,
        '--from0','--files-from=-','--rsync-path=sudo -u forge-exec rsync','-e',`ssh ${SSH_OPTIONS.join(' ')}`,
        './',`${host}:${ROOT}/${run}/work/`],cwd,input:inventory,signal});
      checkAbort();
      if(copied.code !== 0) throw new Error('Copy failed');
      const inputDigest = await digestInput(cwd, selected);
      expected = {v:1,nonce,run,inputDigest,argvDigest:digestArgv(argv),lock};
    } catch {return signal?.aborted ? cancelled() : fallback('copy-failed');}
    try {
      const request = {...expected,argv,env:filterEnv(env)};
      // All awaited preparation and request construction precede the final guard.
      checkAbort();
      dispatched = true;
      const result = await ssh('run',request,true);
      // Closing SSH does not prove the remote worker stopped. Preserve its state.
      if (signal?.aborted || result.code === 255) return uncertain();
      const receipt = await finish();
      if(!receipt || receipt.code!==0 || typeof receipt.stdout!=='string' || Buffer.byteLength(receipt.stdout)>4096) return uncertain();
      if(result.code===75 && verifyReceipt(receipt.stdout,expected,result.code,'not-started')) return fallback('worker-busy');
      if(verifyReceipt(receipt.stdout,expected,result.code,'install')) return {mode:'not-started',reason:'install-failed',code:result.code,terminated:true};
      if(!verifyReceipt(receipt.stdout,expected,result.code)) return uncertain();
      return {mode:'remote',code:result.code};
    } catch {return !dispatched && signal?.aborted ? cancelled() : uncertain();}
  } finally {
    if (!dispatched) try {await finish();} catch { /* Pruning is the cleanup backstop. No command was dispatched. */ }
  }
}

export function verifyReceipt(text, expected, code, phase = 'test') {
  try {
    const receipt=JSON.parse(text);
    return receipt && Object.keys(receipt).sort().join(',') === 'argvDigest,code,inputDigest,lock,nonce,phase,run,v'
      && Object.entries(expected).every(([key,value])=>receipt[key]===value)
      && receipt.phase===phase && Number.isInteger(code) && code>=0 && code<255 && receipt.code===code
      && (phase !== 'install' || code !== 0);
  } catch {return false;}
}

export async function runWithRemoteFallback(options = {}) {
  // A rejected command must not regain execution through local fallback.
  if (!isAllowedCommand(options.argv)) throw new Error('command-not-allowed: use npm run <allowed-task> -- <task-args>');
  const result = await runRemote(options);
  if (result.mode === 'remote') return result.code;
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  if (result.mode !== 'fallback' && !(result.mode === 'not-started' && result.terminated === true)) {
    log(`remote-exec: ${result.reason ?? result.mode}; refusing local rerun (exit 124). Confirm remote termination before retrying.`);
    return 124;
  }
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
