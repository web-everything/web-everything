#!/usr/bin/env node
/**
 * @file scripts/conveyor/heavy-run-ungated.mjs
 * @description Pure heavy-process attribution plus the health watch's cheap process sampler IO shell.
 * `sample [--json] [--state-root=DIR] [--ps-fixture=FILE]` records one snapshot;
 * `loop [--interval=N] [--count=N]` repeats only when the flag or WE_HEAVY_SAMPLE_INTERVAL_S
 * supplies a finite interval >= 10 seconds. Otherwise the health-watch tick samples every 5 min.
 * No GitHub calls or process mutations.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePsOutput } from './health-watch-core.mjs';
import { healthDir } from './health-watch-section.mjs';

export const HEAVY_SAMPLE_INTERVAL_ENV = 'WE_HEAVY_SAMPLE_INTERVAL_S';

/** PURE. An explicit flag wins over the environment value, including when invalid. */
export function resolveSampleIntervalS({ flag, env }) {
  const interval = Number(flag === undefined ? env : flag);
  return Number.isFinite(interval) && interval >= 10 ? interval : null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn']);
const KEEP = 1440;

/** Inspect executable/argv positions only: grep, editors and shell command text are not executions. */
function invocation(command) {
  const words = String(command ?? '').match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map((w) => w.replace(/^(['"])(.*)\1$/, '$2')) || [];
  const executable = basename(words.shift() || '').replace(/^-/, '');
  if (executable !== 'node' && executable !== 'nodejs') return { executable, name: executable, args: words, script: null };
  let index = 0;
  while (words[index]?.startsWith('-')) {
    const flag = words[index++];
    if (['--check', '-c', '--eval', '-e', '--print', '-p'].includes(flag) || /^(--eval|--print)=/.test(flag)) return { executable, name: executable, args: [], script: null };
    if (['--require', '-r', '--import', '--loader', '--experimental-loader'].includes(flag)) index++;
    if (flag === '--') break;
  }
  const script = words[index] || null;
  return { executable, script, name: script ? basename(script) : executable, args: words.slice(index + 1) };
}
function isHeavy(command) {
  const { name, args, script } = invocation(command);
  if (name === 'check-standards.mjs') return script !== null;
  let vitestArgs;
  if (name === 'vitest' || (script && name === 'vitest.mjs')) vitestArgs = args;
  else if (RUNNERS.has(name) || ['npm-cli.js', 'npx-cli.js'].includes(name)) {
    const runner = name.replace('-cli.js', '');
    const tokens = args.filter((a) => a !== '--');
    if (runner === 'npm' && tokens.shift() !== 'exec') return false;
    if (['pnpm', 'yarn'].includes(runner) && tokens[0] === 'exec') tokens.shift();
    while (['--yes', '-y', '--no', '--no-install'].includes(tokens[0])) tokens.shift();
    if (tokens.shift() !== 'vitest') return false;
    vitestArgs = tokens;
  } else return false;
  return !vitestArgs.some((a) => ['--version', '-v', '--help', '-h', 'list'].includes(a));
}
function isWrapper(command) {
  const { executable, name } = invocation(command);
  return SHELLS.has(executable) || RUNNERS.has(executable) || ['npm-cli.js', 'npx-cli.js'].includes(name);
}
function defaultGate(command) {
  const { name, args } = invocation(command);
  return name === 'verify-lane.mjs' || (name === 'heavy-admission.mjs' && args[0] === 'run');
}
function programName(command) {
  const { executable, script, name } = invocation(command);
  return script ? `${executable} ${name}` : executable || 'unknown';
}

/** PURE. Top-most ungated heavy runs, with nearest non-wrapper ancestor attribution.
 * `gateMatchers` optionally replaces the default gate predicate with RegExp/function matchers.
 */
export function findUngatedHeavyRuns(processes, { gateMatchers = [defaultGate] } = {}) {
  const rows = Array.isArray(processes) ? processes : [];
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  const heavy = new Set(rows.filter((p) => isHeavy(p.command)).map((p) => p.pid));
  const gated = (command) => gateMatchers.some((m) => typeof m === 'function' ? m(command) : new RegExp(m.source, m.flags.replace(/[gy]/g, '')).test(command));
  const result = [];
  for (const row of rows) {
    if (!heavy.has(row.pid)) continue;
    const ancestors = []; const seen = new Set([row.pid]);
    let parent = row.ppid;
    while (parent !== 1 && !seen.has(parent) && byPid.has(parent)) {
      seen.add(parent);
      const p = byPid.get(parent); ancestors.push(p); parent = p.ppid;
    }
    if (ancestors.some((p) => heavy.has(p.pid) || gated(p.command))) continue;
    const program = ancestors.find((p) => !isWrapper(p.command));
    result.push({
      pid: row.pid, command: row.command, parentPid: row.ppid,
      parentCommand: byPid.get(row.ppid)?.command ?? null,
      program: program?.command ?? null, programPid: program?.pid ?? null,
      programName: program ? programName(program.command) : 'unknown',
      chain: ancestors.slice(0, 6).map((p) => String(p.command).trim().slice(0, 160)),
    });
  }
  return result;
}

/** PURE. Compact persisted observation; repeated PIDs in separate samples are separate observations. */
export function summarizeSample(runs, at) {
  return { at, count: runs.length, runs: runs.map((r) => ({ pid: r.pid, programName: r.programName, command: r.command.trim().slice(0, 200) })) };
}
function sampleLines(path) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
/** IO. Read the retained tail; a torn/corrupt line does not discard the other observations. */
export function readRecentSamples(path, { now, windowMs }) {
  return sampleLines(path).slice(-KEEP).flatMap((line) => {
    try { const sample = JSON.parse(line); const at = Date.parse(sample?.at); return at >= now - windowMs && at <= now ? [sample] : []; }
    catch { return []; }
  });
}
/** IO. Shared by the sampler and tick; append before pruning the bounded history. */
export function appendSample(path, sample) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(sample) + '\n');
  const lines = sampleLines(path);
  if (lines.length > KEEP) writeFileSync(path, lines.slice(-KEEP).join('\n') + '\n');
}
function sample(flags) {
  const at = new Date().toISOString();
  let result;
  try {
    const output = flags['ps-fixture'] ? readFileSync(flags['ps-fixture'], 'utf8')
      : execFileSync('ps', ['-Ao', 'pid,ppid,pcpu,etime,command'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    result = summarizeSample(findUngatedHeavyRuns(parsePsOutput(output)), at);
  } catch (error) { result = { at, error: String(error.message).split('\n')[0] }; }
  appendSample(join(healthDir(flags['state-root']), 'heavy-run-samples.jsonl'), result);
  console.log(flags.json ? JSON.stringify(result) : result.error
    ? `heavy-run sample ${at}: error ${result.error}`
    : `heavy-run sample ${at}: ${result.count} ungated (${result.runs.map((r) => `${r.programName} pid ${r.pid}`).join(', ')})`);
}
async function main(args) {
  const [command, ...options] = args;
  if (!['sample', 'loop'].includes(command)) throw new Error('Usage: heavy-run-ungated.mjs sample|loop [--json] [--state-root=DIR] [--ps-fixture=FILE] [--interval=N] [--count=N]');
  const flags = Object.fromEntries(options.map((arg) => { const i = arg.indexOf('='); return i < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, i), arg.slice(i + 1)]; }));
  const interval = command === 'sample' ? Number(flags.interval ?? 60)
    : resolveSampleIntervalS({ flag: flags.interval, env: process.env[HEAVY_SAMPLE_INTERVAL_ENV] });
  if (command === 'loop' && interval === null) {
    console.log('heavy-run sampler: dedicated sampler disabled — the health-watch tick samples every 5 min; set WE_HEAVY_SAMPLE_INTERVAL_S=<seconds> (>= 10) to enable');
    return;
  }
  const count = command === 'sample' ? 1 : flags.count === undefined ? Infinity : Number(flags.count);
  if (!(interval > 0 && Number.isFinite(interval)) || !(count === Infinity || (Number.isInteger(count) && count > 0))) throw new Error('interval and count must be positive');
  for (let n = 0; n < count; n++) {
    sample(flags);
    if (n + 1 < count) await new Promise((done) => setTimeout(done, interval * 1000));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
