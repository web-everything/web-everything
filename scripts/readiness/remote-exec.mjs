#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { allowedCommand, digestInput, digestArgv, digestLock, isTestFile, validateTestNames, pathParts, bytePath, splitPaths, manifestWire, digestManifest, readManifestFile } from './forge-exec-run.mjs';

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
    && (argv.length === 3 || argv[3] === '--')
    && (argv[2] !== 'test:unit' || allowedCommand(argv));
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
      : resolve({ code: code ?? 1, stdout: Buffer.concat(stdout) }));
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // A failed SSH may close stdin before reading.
      child.stdin.end(input);
    }
  });
}

export { isTestFile };
// This exclusion policy is part of the manifest, never an independent rsync
// filter. Test-shaped names under excluded components refuse remote admission.
const excludedComponent = /^(?:node_modules|\.git|\.env.*|\.secrets|\.ssh|\.aws|\.claude|\.codex|\.npmrc|\.netrc|credentials.*|.*\.(?:pem|key)|\.exit-code)$/i;
export async function buildManifest({cwd = process.cwd(), exec = defaultExec, fs = filesystem, listFiles} = {}) {
  // Only dependency and Git internals are exempt. In particular, secret/hidden
  // directories and ambiguous dist/build directories may still contain tests.
  const ignored = await exec({file:'git',args:['ls-files','-o','-i','--exclude-standard','-z'],cwd});
  if (ignored.code !== 0 || !Buffer.isBuffer(ignored.stdout)) throw new Error('Ignored byte inventory unavailable');
  for (const path of splitPaths(ignored.stdout)) {
    if (pathParts(path).slice(0,-1).some(part => part.equals(Buffer.from('node_modules')) || part.equals(Buffer.from('.git')))) continue;
    if (isTestFile(path)) throw Object.assign(new Error('Ignored test: use local fallback'), {code:'ignored-test-file'});
  }
  let files;
  if (listFiles) {
    const names = await listFiles(cwd);
    if (!Array.isArray(names) || names.some(name => !Buffer.isBuffer(name) && typeof name !== 'string')) throw new Error('Invalid inventory');
    files = names.map(name => Buffer.from(name));
  } else {
    const result = await exec({file:'git',args:['ls-files','-co','--exclude-standard','-z'],cwd});
    if (result.code !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error('Byte inventory unavailable');
    files = splitPaths(result.stdout);
    const stage = await exec({file:'git',args:['ls-files','--stage','-z'],cwd});
    if (stage.code !== 0 || !Buffer.isBuffer(stage.stdout) || stage.stdout.length > LIMIT
      || (stage.stdout.length && stage.stdout.at(-1) !== 0)) throw new Error('Git index unavailable');
    let start = 0;
    for (let i = 0; i < stage.stdout.length; i++) if (stage.stdout[i] === 0) {
      const record = stage.stdout.subarray(start,i), tab = record.indexOf(9);
      if (tab < 0 || !/^[0-7]{6} [a-f0-9]{40,64} [0-3]$/.test(record.subarray(0,tab).toString('latin1'))) throw new Error('Invalid git index record');
      pathParts(record.subarray(tab+1));
      // Gitlinks cannot be transported as directory leaves. Until recursive
      // submodule inventories are supported, use real local heavy admission.
      if (record.subarray(0,6).equals(Buffer.from('160000'))) throw new Error('gitlink-unsupported: use local fallback');
      start = i + 1;
    }
  }
  files.sort(Buffer.compare);
  files = files.filter((path,i) => !i || !path.equals(files[i-1]));
  if (files.reduce((size,path) => size + path.length + 3,0) > LIMIT) throw new Error('Inventory limit exceeded; use local fallback');
  validateTestNames(files);
  const rootInfo = await fs.lstat(Buffer.from(cwd));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Invalid inventory root');
  const entries = [], excluded = [];
  for (const path of files) {
    const parts = pathParts(path);
    if (parts.some(part => excludedComponent.test(part.toString('latin1')))) {
      if (isTestFile(path) || /\.(test|spec)\./.test(parts.at(-1).toString('latin1'))) throw new Error('Excluded test: use local fallback');
      excluded.push(path); continue;
    }
    let absolute = Buffer.from(cwd), st;
    for (const [i,part] of parts.entries()) {
      absolute = bytePath(absolute,part);
      st = await fs.lstat(absolute);
      if (st.isSymbolicLink() || (i === parts.length-1 ? !st.isFile() : !st.isDirectory())) throw new Error('Unsafe inventory component');
    }
    entries.push({path,sha256:createHash('sha256').update(await readManifestFile(absolute,st,fs)).digest('hex'), executable:!!(st.mode & 0o111)});
  }
  const manifest = {entries,excluded};
  const wire = manifestWire(manifest);
  if (Buffer.byteLength(JSON.stringify(wire)) > LIMIT - 16384) throw new Error('Manifest wire limit exceeded; use local fallback');
  return {...manifest,manifestDigest:digestManifest(wire)};
}

// Only protocol JSON is decoded, never inventory bytes.
function protocolText(stdout, limit) {
  if ((!Buffer.isBuffer(stdout) && typeof stdout !== 'string') || Buffer.byteLength(stdout) > limit) throw new Error('Invalid protocol output');
  if (Buffer.isBuffer(stdout)) {
    const text = stdout.toString('utf8');
    if (!Buffer.from(text).equals(stdout)) throw new Error('Invalid protocol UTF-8');
    return text;
  }
  return stdout;
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
    let expected, expectedManifest;
    try {
      const manifest = await buildManifest({cwd,exec,listFiles});
      const selected = manifest.entries.map(entry => entry.path);
      if (selected.some(path => path.equals(Buffer.from('vitest.shared.ts')))) return fallback('unsupported-sibling-dependency');
      // Anchor comment-like and option-like names for both rsync implementations.
      const inventory = Buffer.concat(selected.flatMap(path => [Buffer.from('./'),path,Buffer.from([0])]));
      const wire = manifestWire(manifest);
      const lock = await digestLock(cwd);
      // Reject incomplete or linked input before transmitting any file bytes.
      const inputDigest = await digestInput(cwd, selected);
      const prepared = await ssh('prepare',{nonce,label:runId});
      if(prepared.code !== 0) throw new Error('Prepare failed');
      run = JSON.parse(protocolText(prepared.stdout,1024)).run;
      if(typeof run !== 'string' || !/^r-[a-f0-9]{32}$/.test(run)) {run=undefined; throw new Error('Invalid server run');}
      const copied = await exec({file:'rsync',args:['-a','-r','--no-links','--safe-links','--no-implied-dirs','--delete','--exclude=.exit-code',
        '--from0','--files-from=-','--rsync-path=sudo -u forge-exec rsync','-e',`ssh ${SSH_OPTIONS.join(' ')}`,
        './',`${host}:${ROOT}/${run}/work/`],cwd,input:inventory});
      if(copied.code !== 0) throw new Error('Copy failed');
      expected = {v:1,nonce,run,inputDigest,argvDigest:digestArgv(argv),lock,manifestDigest:manifest.manifestDigest};
      expectedManifest = wire;
    } catch (error) {return fallback(error.code === 'ignored-test-file' ? 'ignored-test-file' : 'copy-failed');}
    try {
      const result = await ssh('run',{...expected,manifest:expectedManifest,argv,env:filterEnv(env)},true);
      const receipt = await finish();
      if(!receipt || receipt.code!==0) return fallback('ambiguous-result');
      if(!verifyReceipt(protocolText(receipt.stdout,4096),expected,result.code)) return fallback('ambiguous-result');
      return {mode:'remote',code:result.code};
    } catch {return fallback('ambiguous-result');}
  } finally {try {await finish();} catch { /* Pruning is the cleanup backstop; never retry execution. */ }}
}

export function verifyReceipt(text, expected, code) {
  try {
    const receipt=JSON.parse(text);
    return receipt && typeof expected?.manifestDigest === 'string' && /^[a-f0-9]{64}$/.test(expected.manifestDigest)
      && Object.keys(receipt).sort().join(',') === 'argvDigest,code,inputDigest,lock,manifestDigest,nonce,phase,run,v'
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
