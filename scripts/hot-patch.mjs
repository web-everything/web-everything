#!/usr/bin/env node
/**
 * @file hot-patch.mjs — bounded hot-patch request and global status CLI (ET timestamps).
 * Usage: node scripts/hot-patch.mjs request --daemon=<clone> --pr=<n> | status
 * Admission uses the shared helper's real defaults; refusals require evidence repair
 * or ordinary delivery. Status includes the ledger, current overlay and force-watch.
 */
import { parseArgs } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestHotPatch, readHotPatch } from './lib/hot-patch.mjs';
import { forcedWatchStatus, readForceWatch } from './lib/daemon-force-adopt.mjs';
import { readOverlayState } from './lib/daemon-overlays.mjs';
import { DAEMON_CLONE_SEED, daemonCloneForLabel } from './lib/daemon-clone-registry.mjs';
import { workspaceFor } from './lib/lane-pool-paths.mjs';

export function hotPatchRoot(daemon, cwd) {
  const clone = daemonCloneForLabel(daemon) ?? (DAEMON_CLONE_SEED.includes(daemon) ? daemon : null);
  if (clone) return join(workspaceFor(cwd), clone);
  if (daemon && (isAbsolute(daemon) || daemon.includes('/'))) return resolve(cwd, daemon);
  throw new Error('unknown daemon; use its registered label, clone name or explicit clone path');
}

/** ET ISO timestamps include the date-specific offset, including daylight saving time. */
export function easternIso(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    .formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '')}`;
}

function easternTimes(value, key = '') {
  if ((typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value))
    || (typeof value === 'number' && /(?:At|Until|Start)$/.test(key))) return easternIso(value);
  if (Array.isArray(value)) return value.map(v => easternTimes(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, easternTimes(v, k)]));
  return value;
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env,
  request = requestHotPatch, stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  try {
    const [command, ...args] = argv;
    if (!['request', 'status'].includes(command)) throw new Error('expected request or status');
    const { values: f } = parseArgs({ args, options: command === 'request'
      ? { daemon: { type: 'string' }, pr: { type: 'string' } } : {} });
    let result;
    if (command === 'status') {
      const ledger = readHotPatch(env);
      if (!ledger) { stdout('no hot-patch open\n'); return 0; }
      const state = readOverlayState(ledger.root, { env });
      if (state.corrupt) throw new Error('overlay state unreadable; repair evidence or use ordinary delivery');
      if (forcedWatchStatus(ledger.root, env) === 'unreadable')
        throw new Error('force-watch state unreadable; repair evidence or use ordinary delivery');
      result = { ledger, overlay: state.overlays.find(o => o.ref === ledger.branch) ?? null,
        watch: readForceWatch(ledger.root, env) };
    } else {
      if (!f.daemon) throw new Error('--daemon is required');
      const root = hotPatchRoot(f.daemon, cwd);
      if (!/^[1-9]\d*$/.test(f.pr ?? '') || !Number.isSafeInteger(Number(f.pr)))
        throw new Error('--pr requires a positive safe integer');
      result = await request({ root, pr: Number(f.pr), env });
    }
    stdout(JSON.stringify(easternTimes(result), null, 2) + '\n');
    return 0;
  } catch (e) {
    stderr(String(e.message).replace(/[\x00-\x1f\x7f-\x9f]/g, '') + '\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
