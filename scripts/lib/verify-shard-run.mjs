import * as nodeFs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir as nodeTmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRemoteReport } from './verify-remote-routing.mjs';
import { killProcessTree } from './bounded-child.mjs';
import { acquireSlotBlocking, releaseOwnedSlot, admissionLockRoot, resolveCap, ADMISSION_HELD_ENV } from '../readiness/heavy-admission.mjs';

const positive = n => Number.isSafeInteger(n) && n > 0;
// Gate arguments use --key=value. Also preserve ordinary two-token Vitest options;
// boolean switches must never consume the following test file.
const booleans = new Set(['--passWithNoTests', '--run', '--watch', '--coverage', '--silent', '--globals', '--isolate', '--no-isolate', '--no-file-parallelism', '--fileParallelism']);
export function splitVitestArgs(argv, count) {
  if (!positive(count) || argv.slice(0, 3).join(' ') !== 'npx vitest run') throw Error('expected npx vitest run and a positive shard count');
  const files = [], flags = [];
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) files.push(arg);
    else {
      if (/^--(?:outputFile|reporter)(?:[.=]|$)/.test(arg)) throw Error('report options are owned by verify-shard');
      flags.push(arg);
      if (!arg.includes('=') && !booleans.has(arg)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw Error(`missing option value: ${arg}`);
        flags.push(argv[++i]);
      }
    }
  }
  if (!files.length || new Set(files).size !== files.length) throw Error('expected nonempty unique file list');
  const k = Math.min(count, files.length), shards = [];
  let offset = 0;
  for (let i = 0; i < k; i++) {
    const size = Math.floor(files.length / k) + (i < files.length % k ? 1 : 0);
    shards.push(files.slice(offset, offset += size));
  }
  return { shards, flags };
}

export function inventoryVerdict(text, files, cwd = process.cwd()) {
  try {
    const report = JSON.parse(text);
    if (!Array.isArray(report.testResults)) return 'INVENTORY-INCOMPLETE';
    const results = new Map(report.testResults.map(r => [resolve(cwd, r.name), r]));
    const assigned = files.map(f => results.get(resolve(cwd, f)));
    // A suite reported but skipped/pending is not execution evidence.
    if (assigned.some(r => !r || !['passed', 'failed'].includes(r.status)
      || !Array.isArray(r.assertionResults) || !r.assertionResults.some(a => ['passed', 'failed'].includes(a.status)))) return 'INVENTORY-INCOMPLETE';
    return report.success === false || assigned.some(r => r.status !== 'passed'
      || r.assertionResults.some(a => a.status === 'failed')) ? 'FAIL' : 'PASS';
  } catch { return 'INVENTORY-INCOMPLETE'; }
}

// Streams output without retaining an unbounded child buffer. A partial line is
// bounded too, so even a child printing without newlines remains observable.
export function executeShard({ command, args, env, cwd, timeoutMs, prefix, log }, {
  spawn = nodeSpawn, killTree = killProcessTree, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  return new Promise(resolveResult => {
    let child, timer, settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimer(timer); resolveResult(result); } };
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream?.on('data', chunk => {
          pending += String(chunk).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
          while (pending.includes('\n') || pending.length >= 8192) {
            const end = pending.includes('\n') ? Math.min(pending.indexOf('\n') + 1, 8192) : 8192;
            log(`${prefix}${pending.slice(0, end).replace(/\n$/, '')}\n`); pending = pending.slice(end);
          }
        });
        stream?.on('end', () => { if (pending) log(`${prefix}${pending}\n`); });
      }
      child.once('error', () => finish({ exitCode: 1 }));
      child.once('close', (exitCode, signal) => finish({ exitCode, signal }));
      timer = setTimer(() => {
        try { killTree(child.pid, 'SIGKILL', { orphansOfGroup: child.pid }); }
        finally { finish({ exitCode: 124, timedOut: true }); }
      }, timeoutMs);
    } catch { finish({ exitCode: 1 }); }
  });
}

async function acquireLocalDefault({ cwd, env, remainingMs }) {
  const options = { lockRoot: admissionLockRoot(cwd, env), cap: resolveCap(env, cwd), owner: cwd };
  const acquired = await acquireSlotBlocking({ ...options, env, kind: 'vitest', ceilingMs: remainingMs,
    canDefer: true, waitMs: remainingMs, log: m => process.stderr.write(m) });
  return { ...acquired, options };
}

export async function runShards({ argv, shards: count, parallel, budgetMs }, deps = {}) {
  const { fs = nodeFs, now = Date.now, tmpdir = nodeTmpdir, log = s => process.stdout.write(s),
    env = process.env, cwd = process.cwd(), execute = executeShard,
    acquireLocal = acquireLocalDefault, releaseLocal = slot => releaseOwnedSlot(slot.options) } = deps;
  let directory;
  try {
    if (!positive(parallel) || !Number.isSafeInteger(budgetMs) || budgetMs < 0) throw Error('invalid parallelism or budget');
    const { shards, flags } = splitVitestArgs(argv, count);
    const deadline = now() + budgetMs, results = new Array(shards.length);
    directory = fs.mkdtempSync(join(tmpdir(), 'verify-shards-'));
    let next = 0;
    // The slot helpers identify holders by process. Serialize confirmation in
    // this process so one confirmation cannot release another's slot.
    let localTail = Promise.resolve();
    const remaining = () => Math.max(0, deadline - now());
    async function worker() {
      while (next < shards.length) {
        const index = next++, files = shards[index], started = now();
        const remoteReport = join(directory, `${index}.remote.jsonl`);
        // `npx vitest` / `npm run` put node_modules/.bin on PATH for the shell; a bare node child does not.
        const childEnv = { ...env, WE_VERIFY_REMOTE_REPORT: remoteReport, PATH: `${join(cwd, 'node_modules', '.bin')}:${env.PATH ?? ''}` };
        delete childEnv[ADMISSION_HELD_ENV];
        async function attempt(local) {
          if (!remaining()) return 'NOT-RUN';
          const report = join(directory, `${index}.${local ? 'local' : 'initial'}.json`);
          const args = ['vitest', 'run', ...files, ...flags, '--reporter=default', '--reporter=json', `--outputFile=${report}`];
          const result = await execute({ command: local ? 'npx' : 'node',
            args: local ? args : ['scripts/readiness/heavy-admission.mjs', 'run', '--', ...args],
            files, report, remoteReport, cwd, env: local ? { ...childEnv, [ADMISSION_HELD_ENV]: '1' } : childEnv,
            timeoutMs: remaining(), prefix: `[verify-shard ${index + 1}/${shards.length}] `, log });
          if (result.timedOut || result.exitCode === 124) return 'TIMEOUT';
          let inventory;
          try { inventory = inventoryVerdict(fs.readFileSync(report, 'utf8'), files, cwd); }
          catch { inventory = 'INVENTORY-INCOMPLETE'; }
          if (inventory === 'INVENTORY-INCOMPLETE') return inventory;
          return result.exitCode === 0 && !result.signal && inventory === 'PASS' ? 'PASS' : 'FAIL';
        }
        let status;
        try {
          status = await attempt(false);
          let remote = false;
          try {
            const lines = readRemoteReport(remoteReport, (path, encoding) => fs.readFileSync(path, encoding));
            remote = lines.length > 0 && lines.every(r => r.location === 'remote');
          } catch { /* Unknown location cannot authorize replacing a red verdict. */ }
          if (remote && ['FAIL', 'INVENTORY-INCOMPLETE'].includes(status)) {
            log(`verify-shard ${index + 1}/${shards.length}: remote red; confirming locally\n`);
            if (!remaining()) status = 'NOT-RUN';
            else {
              const previous = localTail;
              let unlock;
              localTail = new Promise(resolve => { unlock = resolve; });
              await previous;
              try {
                if (!remaining()) status = 'NOT-RUN';
                else {
                  const slot = await acquireLocal({ cwd, env: childEnv, remainingMs: remaining() });
                  try { status = slot.ok ? await attempt(true) : remaining() ? 'FAIL' : 'NOT-RUN'; }
                  finally { if (slot.ok) releaseLocal(slot); }
                }
              } finally { unlock(); }
            }
          }
        } catch (error) { status = 'FAIL'; log(`verify-shard error: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, '')}\n`); }
        results[index] = status;
        log(`verify-shard ${index + 1}/${shards.length}: ${status} (${files.length} files, ${now() - started} ms)\n`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, shards.length) }, worker));
    if (results.every(r => r === 'PASS')) {
      log(`verify-shards: GREEN (all ${shards.length} shards, ${shards.flat().length} files executed and passed)\n`);
      return 0;
    }
    log(`verify-shards: RED (${results.map((r, i) => `${i + 1}:${r}`).join(', ')}; inspect shard output and rerun the affected selection)\n`);
    return results.some(r => !['PASS', 'TIMEOUT', 'NOT-RUN'].includes(r)) ? 1 : 124;
  } catch (error) {
    log(`verify-shards: RED (internal error: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, '')})\n`);
    return 1;
  } finally {
    if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* verdict already recorded */ } }
  }
}

export function parseShardCli(args) {
  const separator = args.indexOf('--');
  if (separator !== 3) throw Error('usage: --shards=K --parallel=P --budget-ms=M -- npx vitest run <files> <flags>');
  const options = {};
  for (const arg of args.slice(0, separator)) {
    const match = /^--(shards|parallel|budget-ms)=(\d+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('invalid shard option');
    options[match[1]] = Number(match[2]);
  }
  return { shards: options.shards, parallel: options.parallel, budgetMs: options['budget-ms'], argv: args.slice(separator + 1) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runShards(parseShardCli(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`verify-shards: RED (${error.message})\n`); process.exitCode = 1; }
}
