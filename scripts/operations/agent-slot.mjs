#!/usr/bin/env node
/** CLI lease lifecycle for orchestrator Agent-tool and external builders. */
import { pathToFileURL } from 'node:url';
import { readBuilderSlotSettings } from '../lib/builder-slots-settings.mjs';
import { acquireSlot, waitForSlot, heartbeatSlot, releaseSlot, listSlots } from '../lib/builder-slots.mjs';

const usage = 'usage: agent-slot acquire --class=claude|codex|antigravity --purpose=<x> [--ttl-ms=N] [--wait-ms=N] [--pid=N]\n       agent-slot heartbeat <id> | release <id> | list [--json]';
export async function main(argv = process.argv.slice(2), o = {}) {
  const [command, ...args] = argv;
  const settings = o.settings ?? readBuilderSlotSettings();
  const opts = { ...o, settings };
  if (!command || args.includes('--help') || command === '--help') { console.log(usage); return 0; }
  if (command === 'release') { if (settings.enabled) releaseSlot(args[0], opts); return 0; }
  if (command === 'heartbeat') { if (settings.enabled) heartbeatSlot(args[0], opts); return 0; }
  if (command === 'list') {
    const rows = settings.enabled ? listSlots(opts) : [];
    console.log(args.includes('--json') ? JSON.stringify(rows) : rows.map(r => `${r.id} ${r.class} ${r.stale ? 'stale' : 'live'} ${r.purpose.replace(/[\p{Cc}\p{Cf}]/gu, '')}`).join('\n'));
    return 0;
  }
  if (command !== 'acquire') throw new Error(usage);
  const flags = Object.fromEntries(args.map(a => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)]; }));
  if (!['claude', 'codex', 'antigravity'].includes(flags.class) || !flags.purpose) throw new Error(usage);
  for (const key of ['ttl-ms', 'wait-ms', 'pid']) {
    if (flags[key] !== undefined && (!/^\d+$/.test(flags[key]) || !Number.isSafeInteger(Number(flags[key])) || Number(flags[key]) < (key === 'ttl-ms' ? 1000 : key === 'pid' ? 1 : 0))) throw new Error(`Invalid --${key}`);
  }
  const request = { ...opts, class: flags.class, purpose: flags.purpose,
    ...(flags['ttl-ms'] !== undefined ? { ttlMs: Number(flags['ttl-ms']) } : {}),
    ...(flags.pid !== undefined ? { pid: Number(flags.pid) } : {}) };
  const result = flags['wait-ms'] === undefined ? await acquireSlot(request) : await waitForSlot({ ...request, waitMs: Number(flags['wait-ms']) });
  if (result.ok) { console.log(`slot ${result.id}`); return 0; }
  console.error(`agent-slot: full (cap ${result.cap}, holders: ${JSON.stringify(result.holders)})`);
  return 75;
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then(code => { process.exitCode = code; }).catch(e => { console.error(e.message); process.exitCode = 1; });
