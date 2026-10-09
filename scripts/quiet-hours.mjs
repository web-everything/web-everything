#!/usr/bin/env node
/**
 * @file scripts/quiet-hours.mjs
 * @description The quietHours knob's operator CLI (card xmvc6oc). Reads the live settings + toggle file.
 *
 *   node scripts/quiet-hours.mjs status [--json]
 *   node scripts/quiet-hours.mjs simulate --at=<iso> [--title=<t>] [--emergency=main-red|daemon-down:<min>] [--job=<sweep>] [--json]
 *       Dry run: what the gate WOULD do with this alert at that time. Sends and writes nothing.
 *   node scripts/quiet-hours.mjs flush [--json]   send the held-alerts digest now if quiet hours are over
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideDelivery, isQuiet, sweepSkip } from './lib/quiet-hours.mjs';
import { flushDigest, loadQuietSettings, readToggle, digestPaths } from './lib/quiet-hours-io.mjs';

function flags(argv) {
  const f = {};
  for (const a of argv) if (a.startsWith('--')) { const i = a.indexOf('='); f[i < 0 ? a.slice(2) : a.slice(2, i)] = i < 0 ? true : a.slice(i + 1); }
  return f;
}

export function parseEmergency(spec) {
  if (!spec || spec === true) return undefined;
  if (spec === 'main-red') return { kind: 'main-red' };
  const m = /^daemon-down(?::(\d+))?$/.exec(spec);
  if (m) return { kind: 'daemon-down', downForMs: m[1] == null ? null : Number(m[1]) * 60_000 };
  throw new Error(`unknown --emergency "${spec}" (main-red | daemon-down:<min>)`);
}

export async function main(argv = process.argv.slice(2)) {
  const [verb] = argv; const f = flags(argv);
  const settings = loadQuietSettings(); const toggle = readToggle(settings);
  let out;
  if (verb === 'status') {
    out = { now: new Date().toISOString(), state: isQuiet(Date.now(), settings, toggle), toggle, window: `${settings.start}-${settings.end} ${settings.timeZone}`, held: digestPaths(settings).held };
  } else if (verb === 'simulate') {
    const now = f.at ? Date.parse(f.at) : Date.now();
    if (!Number.isFinite(now)) { console.error(`bad --at "${f.at}"`); return 2; }
    const alert = { title: typeof f.title === 'string' ? f.title : 'Health: red-pr-unattended — #1234', body: 'simulated', emergency: parseEmergency(f.emergency) };
    out = { at: new Date(now).toISOString(), alert, decision: decideDelivery(alert, { now, settings, toggle }), ...(f.job ? { sweep: sweepSkip(String(f.job), { now, settings, toggle }) } : {}) };
  } else if (verb === 'flush') {
    const { notifyDesktopChecked } = await import('./conveyor/branch-sync.mjs');
    out = flushDigest({ send: (n) => notifyDesktopChecked(n, { quietGate: null }) });
  } else {
    console.error('usage: quiet-hours.mjs <status|simulate|flush> [--at=<iso>] [--title=<t>] [--emergency=main-red|daemon-down:<min>] [--job=<sweep>] [--json]');
    return 2;
  }
  if (f.json) console.log(JSON.stringify(out));
  else if (verb === 'simulate') console.log(`${out.at}  "${out.alert.title}"${out.alert.emergency ? ` [${out.alert.emergency.kind}]` : ''} → ${out.decision.deliver ? 'DELIVER' : 'HOLD'} (${out.decision.reason})${out.sweep ? `; sweep ${f.job}: ${out.sweep.skip ? 'SKIP' : 'RUN'} (${out.sweep.reason})` : ''}`);
  else console.log(JSON.stringify(out, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
