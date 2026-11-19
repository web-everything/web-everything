import { vi } from 'vitest';
import { basename } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

let active;
const encode = (value, options) => options.encoding ? String(value ?? '') : Buffer.from(value ?? '');
function dispatch(file, args = [], options = {}) {
  if (!active) throw new Error('CLI process port used outside runInProcess');
  if (file === process.execPath && basename(args[0] || '') === 'gh-throttle.mjs') {
    return active.throttle(args.slice(1), { spawn: childProcessMock.spawnSync });
  }
  const port = active.ports[basename(file)];
  if (!port) {
    const error = new Error(`Unexpected CLI subprocess: ${file} ${args.join(' ')}`);
    active.unexpected.push(error);
    throw error;
  }
  return port(args, options.env ?? process.env);
}
function spawnSync(file, args, options = {}) {
  const result = dispatch(file, args, options);
  return { ...result, stdout: encode(result.stdout, options), stderr: encode(result.stderr, options) };
}
function execFileSync(file, args, options = {}) {
  const result = spawnSync(file, args, options);
  if (result.status !== 0) throw Object.assign(new Error(String(result.stderr)), result);
  return result.stdout;
}
function execFile(file, args, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const child = new EventEmitter();
  queueMicrotask(() => {
    try {
      const result = spawnSync(file, args, options);
      callback(result.status ? Object.assign(new Error(String(result.stderr)), result) : null, result.stdout, result.stderr);
    } catch (error) { callback(error, '', ''); }
  });
  return child;
}
// Node's execFile has a custom promisifier returning BOTH streams.
execFile[promisify.custom] = async (file, args, options) => {
  const result = spawnSync(file, args, options);
  if (result.status) throw Object.assign(new Error(String(result.stderr)), result);
  return { stdout: result.stdout, stderr: result.stderr };
};
function spawn(file, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.unref = () => {}; child.kill = () => true;
  queueMicrotask(() => {
    try {
      const result = spawnSync(file, args, options);
      child.stdout.end(result.stdout); child.stderr.end(result.stderr);
      child.emit('exit', result.status, null); child.emit('close', result.status, null);
    } catch (error) { child.emit('error', error); }
  });
  return child;
}
const refuse = file => dispatch(file);
export const childProcessMock = {
  execFileSync, execFile, spawnSync, spawn, exec: refuse, execSync: refuse, fork: refuse,
};
childProcessMock.default = childProcessMock;

/** Sequential per file: restore ambient IO even on an exception or an injected exit. */
export async function runInProcess(argv, { cwd, env, ports }) {
  if (active) throw new Error('Concurrent CLI harness runs are unsupported');
  const savedEnv = process.env;
  const savedArgv = process.argv;
  const stopped = {};
  let stdout = '', stderr = '', status = 0;
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(value => { stderr += String(value); return true; });
  process.env = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
  process.argv = [process.execPath, 'in-process-merge-ai-prs', ...argv];
  active = { ports, unexpected: [] };
  try {
    // Recreate module-scoped paths, caches and settings just as a fresh CLI process would.
    vi.resetModules();
    active.throttle = (await import('../../lib/gh-throttle.mjs')).runGhCliPassthrough;
    const { main } = await import('../../merge-ai-prs.mjs');
    try {
      await main(argv, { env: process.env, stdout: { write(value) { stdout += value; } },
        exit(code) { status = code; throw stopped; } });
    } catch (error) { if (error !== stopped) throw error; }
    if (active.unexpected.length) throw new AggregateError(active.unexpected, 'Unported CLI subprocess');
    return { status, stdout, stderr };
  } finally {
    active = null;
    process.env = savedEnv; process.argv = savedArgv;
    stderrSpy.mockRestore(); cwdSpy.mockRestore();
  }
}
