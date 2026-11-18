import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';

export function readAgyUsageSettings({ env = process.env, read = readSettings, platform, log = console.error } = {}) {
  const number = key => env[key] === undefined ? undefined : Number(env[key]);
  return cascadePolicy('agyUsage', read()?.agyUsage, {
    standard: { minIntervalMinutes: 15, timeoutMs: 45000 }, platform, env: { ...env, WE_POLICY_CASCADE_LOG: '1' }, log,
    envValues: { minIntervalMinutes: number('WE_AGY_USAGE_MIN_INTERVAL_MINUTES'), timeoutMs: number('WE_AGY_USAGE_TIMEOUT_MS') },
    valid: { minIntervalMinutes: v => Number.isFinite(v) && v >= 0,
      timeoutMs: v => Number.isSafeInteger(v) && v > 0 && v <= 2147483647 },
  }).value;
}

/** Pure: require both Gemini windows; incomplete or unknown screens never become quota evidence. */
export function parseAgyUsage(screen, now = Date.now()) {
  const text = stripVTControlCharacters(screen).replace(/\r/g, '');
  const group = text.split(/GEMINI MODELS/i)[1]?.split(/\n\s*[A-Z][A-Z ]+ MODELS/)[0];
  if (!group || !Number.isFinite(now)) throw new Error('Incomplete Gemini usage screen');
  const window = label => {
    const match = group.match(new RegExp(`${label} Limit Remaining\\s+[^\\d%\\n+-]*?(\\d+(?:\\.\\d+)?)%\\s+Refreshes in[ \\t]+(?:(\\d+)h[ \\t]*)?(?:(\\d+)m)?[ \\t]*(?=\\n|$)`, 'i'));
    if (!match || (!match[2] && !match[3])) throw new Error(`Missing ${label} usage or refresh time`);
    const remaining = Number(match[1]);
    const seconds = Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60;
    if (remaining > 100 || !Number.isSafeInteger(seconds)) throw new Error('Invalid usage bounds');
    return { used_percentage: Number((100 - remaining).toFixed(6)), resets_at: Math.floor(now / 1000) + seconds };
  };
  return { at: new Date(now).toISOString(), session: null, five_hour: window('Five Hour'),
    seven_day: window('Weekly'), spend_limit: null };
}

/** Run only the PTY wrapper; all process I/O is injectable and bounded. No agy settings are written. */
export function collectAgyUsage({ home = homedir(), timeoutMs = 45000, spawnFn = spawn,
  kill = process.kill.bind(process), now = Date.now, startupMs = 3000, stepMs = 300,
  maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('sh', ['-c', 'cat | script -q /dev/null agy'], { cwd: home, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let screen = '', bytes = 0, requested = false, stopping = false, settled = false;
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      if (Number.isInteger(child.pid) && child.pid > 0) {
        // Own process group (detached): negative exact PID kills sh, cat, script and agy together.
        try { kill(-child.pid, 'SIGKILL'); } catch { /* child may already have exited */ }
      }
      error ? reject(error) : resolve(value);
    };
    const send = value => { if (!settled) child.stdin.write(value); };
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    const receive = data => {
      if (settled) return;
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) return finish(new Error('agy output exceeded bound; inspect agy manually and retry'));
      screen += data.toString();
      if (/trust this folder/i.test(stripVTControlCharacters(screen))) {
        return finish(new Error('agy asks to trust this folder; trust it manually once and retry'));
      }
      if (!requested || stopping) return;
      let parsed;
      try { parsed = parseAgyUsage(screen, now()); } catch { return; }
      stopping = true;
      send('\x03');
      send('\x03');
      finish(null, parsed);
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('close', () => {
      if (settled) return;
      if (!stopping) return finish(new Error('agy exited before complete usage; inspect agy manually and retry'));
      try { finish(null, parseAgyUsage(screen, now())); } catch (error) { finish(error); }
    });
    later(() => finish(new Error('agy usage timed out; inspect agy startup or increase timeoutMs and retry')), timeoutMs);
    later(() => {
      send('\x1b');
      later(() => { requested = true; send('/usage\r'); }, stepMs);
    }, startupMs);
  });
}

export async function runAgyUsageReader({ home = homedir(), io = fs, now = Date.now,
  settings = readAgyUsageSettings(), collect = collectAgyUsage } = {}) {
  const target = join(home, '.plateau', 'agy-usage.json');
  try {
    const previous = JSON.parse(await io.readFile(target, 'utf8'));
    const at = Date.parse(previous.at);
    const valid = w => Number.isFinite(w?.used_percentage) && w.used_percentage >= 0 && w.used_percentage <= 100
      && Number.isSafeInteger(w?.resets_at) && w.resets_at > 0;
    // Only a complete, non-future previous record may suppress collection.
    if (Number.isFinite(at) && at <= now() && valid(previous.five_hour) && valid(previous.seven_day)
      && now() - at < settings.minIntervalMinutes * 60000) return { skipped: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = await collect({ home, timeoutMs: settings.timeoutMs, now });
  await io.mkdir(join(home, '.plateau'), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temporary, `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 });
    await io.rename(temporary, target);
  } finally { await io.unlink(temporary).catch(() => {}); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgyUsageReader().catch(error => { console.error(error.message); process.exitCode = 1; });
}
