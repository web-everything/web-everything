#!/usr/bin/env node
/** Bounded, operator-scheduled binary maintenance; no daemon is installed here. */
import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { agyEvidenceDir } from '../lib/antigravity-run-evidence.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { publishAttention } from './needs-you-feed.mjs';

export function resolveSettings(env = process.env, log = console.error) {
  const number = key => env[key] === undefined ? undefined : Number(env[key]);
  const raw = env.WE_AGY_UPGRADE_ENABLED;
  const settings = cascadePolicy('agyUpgrade', {}, { platform: {}, operatorOverride: {}, env,
    standard: { enabled: true, minIntervalMinutes: 60, smokeTimeoutMs: 20000 },
    envValues: { enabled: raw === undefined ? undefined : ['true', '1'].includes(raw) ? true : ['false', '0'].includes(raw) ? false : raw,
      minIntervalMinutes: number('WE_AGY_UPGRADE_MIN_INTERVAL_MINUTES'), smokeTimeoutMs: number('WE_AGY_UPGRADE_SMOKE_TIMEOUT_MS') },
    valid: { enabled: v => typeof v === 'boolean',
      minIntervalMinutes: v => Number.isFinite(v) && v >= 60 && v <= 1440,
      smokeTimeoutMs: v => Number.isInteger(v) && v > 0 && v <= 20000 } });
  log(formatCascadeSourcesLine('agyUpgrade', settings));
  return settings.value;
}

/** Resolves on the deadline even if the child never emits close after SIGKILL. */
export function boundedExec(command, args, { timeoutMs, spawn = nodeSpawn,
  kill = (pid, signal) => process.kill(pid, signal), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise(resolveResult => {
    let child, timer, done = false, stdout = '', bytes = 0;
    const finish = (result, terminate = false) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      if (terminate && Number.isInteger(child?.pid) && child.pid > 0) {
        // Own process group (detached): the negative exact PID also reaches the child's descendants.
        for (const target of [-child.pid, child.pid]) {
          try { kill(target, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') result = { ok: false, hung: !!result.hung, reason: 'cleanup incomplete' };
          }
        }
      }
      resolveResult({ stdout, ...result });
    };
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      timer = setTimer(() => finish({ ok: false, hung: true, reason: 'timeout' }, true), timeoutMs);
      const collect = (chunk, output) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 65536) return finish({ ok: false, hung: false, reason: 'output-limit' }, true);
        if (output && !done) stdout += chunk.toString();
      };
      child.stdout.on('data', chunk => collect(chunk, true));
      child.stderr.on('data', chunk => collect(chunk, false));
      child.once('error', () => finish({ ok: false, hung: false, reason: 'spawn-error' }, true));
      child.once('close', code => finish({ ok: code === 0, hung: false, reason: code === 0 ? '' : 'exit-failed' }));
    } catch { finish({ ok: false, hung: false, reason: 'spawn-error' }, true); }
  });
}

export async function smoke({ exec = boundedExec, smokeTimeoutMs = 20000, ...io } = {}) {
  const result = await exec('agy', ['--version'], { ...io, timeoutMs: smokeTimeoutMs });
  const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(result.stdout ?? '')?.[0] ?? 'unknown';
  return { ok: result.ok && version !== 'unknown', version, hung: !!result.hung, ...(result.reason === 'cleanup incomplete' ? { reason: result.reason } : {}) };
}

function readBounded(io, path) {
  try {
    if (io.statSync(path).size > 8192) return null;
    return JSON.parse(io.readFileSync(path, 'utf8'));
  } catch { return null; }
}
function atomicWrite(io, path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { io.writeFileSync(temp, JSON.stringify(value) + '\n'); io.renameSync(temp, path); }
  finally { io.rmSync(temp, { force: true }); }
}

/** All commands, filesystem, clock and attention publication are injectable. */
export async function runUpgradeCheck({ dir = agyEvidenceDir(), env = process.env, io = fs, now = Date.now,
  exec = boundedExec, alert = publishAttention, log = console.error } = {}) {
  const settings = resolveSettings(env, log);
  if (!settings.enabled) return { status: 'disabled' };
  io.mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'upgrade-check.lock');
  try { io.mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') return { status: 'locked' }; throw e; }
  // A kill that could not be confirmed leaves the lock in place: no later tick may overlap a surviving child.
  let leaveLock = false;
  try {
    const binaryDir = join(dir, 'binary');
    io.mkdirSync(binaryDir, { recursive: true });
    const at = now(), cachePath = join(binaryDir, 'upgrade-check.json'), healthPath = join(binaryDir, 'health.json');
    const cache = readBounded(io, cachePath);
    // A cache record is trusted only when every field is well-formed; otherwise it is ignored and the check runs.
    const wellFormed = typeof cache?.at === 'string' && (cache.alerted === undefined || (typeof cache.alerted === 'string' && cache.alerted.length <= 128));
    const lastRun = wellFormed ? Date.parse(cache.at) : NaN;
    if (Number.isFinite(lastRun) && lastRun <= at && at - lastRun < settings.minIntervalMinutes * 60000)
      return { status: 'rate-limited' };
    const state = { at: new Date(at).toISOString(), alerted: Number.isFinite(lastRun) && lastRun <= at
      && typeof cache?.alerted === 'string' && cache.alerted.length <= 128 ? cache.alerted : '' };
    atomicWrite(io, cachePath, state);
    const record = async result => {
      const reason = result.ok ? '' : result.reason === 'cleanup incomplete' ? result.reason : result.hung ? 'hung' : 'failed';
      atomicWrite(io, healthPath, { state: result.ok ? 'ok' : 'dead', at: new Date(now()).toISOString(), version: result.version, reason });
      if (result.ok && state.alerted) {
        // needs-you-feed has no sanctioned resolver for independently published alerts.
        state.alerted = '';
        atomicWrite(io, cachePath, state);
      }
      if (!result.ok) {
        const identity = `${result.version}:${reason}`;
        if (state.alerted !== identity) {
          await alert({ repo: 'webeverything', pr: 0, head: createHash('sha256').update(`${identity}:${state.at}`).digest('hex'), kind: 'agy-binary-dead',
            reason: `agy ${result.version} ${reason}; seat held for 24h. Inspect binary; run upgrade check again.`,
            command: 'node scripts/operations/agy-upgrade-check.mjs' });
          state.alerted = identity;
          atomicWrite(io, cachePath, state);
        }
      }
    };
    let result = await smoke({ exec, smokeTimeoutMs: settings.smokeTimeoutMs });
    if (result.reason === 'cleanup incomplete') leaveLock = true; // before record(): persistence may throw
    await record(result);
    if (result.reason === 'cleanup incomplete') return { status: 'dead', ...result };
    const outdated = await exec('brew', ['outdated', '--cask', '--json=v2'], { timeoutMs: 60000 });
    const cleanupFailed = async command => {
      leaveLock = true; // before record(): persistence may throw
      result = { ...result, ok: false, reason: 'cleanup incomplete', hung: !!command.hung };
      await record(result);
      return { status: 'dead', ...result };
    };
    if (outdated.reason === 'cleanup incomplete') return await cleanupFailed(outdated);
    let casks;
    try { casks = JSON.parse(outdated.stdout).casks; } catch { /* refuse unknown staleness */ }
    if (!outdated.ok || !Array.isArray(casks)) {
      log('agy-upgrade: staleness unavailable; no upgrade attempted; operator should inspect brew outdated');
      return { status: 'staleness-unavailable', ...result };
    }
    if (casks.some(cask => cask?.name === 'antigravity-cli' || cask?.token === 'antigravity-cli')) {
      // Hold the seat while the executable is replaced; the post-upgrade smoke is the only thing that clears it.
      atomicWrite(io, healthPath, { state: 'dead', at: new Date(now()).toISOString(), version: result.version, reason: 'upgrading' });
      const upgrade = await exec('brew', ['upgrade', '--cask', 'antigravity-cli'], { timeoutMs: 120000 });
      if (upgrade.reason === 'cleanup incomplete') return await cleanupFailed(upgrade);
      result = await smoke({ exec, smokeTimeoutMs: settings.smokeTimeoutMs });
      if (result.reason === 'cleanup incomplete') leaveLock = true; // before record(): persistence may throw
      await record(result);
      if (!upgrade.ok) log('agy-upgrade: upgrade failed; operator should inspect brew upgrade --cask antigravity-cli');
    }
    return { status: result.ok ? 'ok' : 'dead', ...result };
  } finally { if (!leaveLock) io.rmdirSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUpgradeCheck().then(result => { console.log(JSON.stringify(result)); process.exitCode = result.ok === false ? 1 : 0; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
