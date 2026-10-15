#!/usr/bin/env node
/** Card 359 — session-independent operator attention feed. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffHome } from './handoff-home.mjs';
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
import { isLaneLocus, workspaceRootOf } from '../guard-lane.mjs';
import { daemonCloneRoots, isDaemonCloneRealpath } from '../lib/daemon-clone-registry.mjs';

export const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function readOptional(path, fallback) {
  try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function readSettings(checkoutRoot = CHECKOUT_ROOT) {
  return JSON.parse(readOptional(join(checkoutRoot, 'scripts/settings/needs-you-feed.json'), '{}'));
}
/** Each resolved value retains its provenance, matching operator-queue's read-attempt setting. */
export function resolveSettings({ env = process.env, file = readSettings(), home = homedir() } = {}) {
  const spec = {
    enabled: ['WE_NEEDS_YOU_FEED_ENABLED', true, v => v === true || v === 'true' || v === '1' ? true : v === false || v === 'false' || v === '0' ? false : undefined],
    intervalMinutes: ['WE_NEEDS_YOU_FEED_INTERVAL_MINUTES', 2, v => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) * 60000 <= 2147483647 ? Number(v) : undefined],
    path: ['WE_NEEDS_YOU_FEED', join(handoffHome({ home }), 'needs-you-events.jsonl'), v => typeof v === 'string' && v.trim() ? resolve(v) : undefined],
    allowPrimary: ['WE_NEEDS_YOU_FEED_ALLOW_PRIMARY', false, v => v === true || v === '1' || v === 'true' ? true : v === false || v === '0' || v === 'false' ? false : undefined],
  };
  return Object.fromEntries(Object.entries(spec).map(([key, [name, fallback, parse]]) => {
    for (const [raw, source] of [[env[name], 'env'], [file[key], 'settings']]) {
      if (raw == null || raw === '') continue;
      const value = parse(raw); if (value !== undefined) return [key, { value, source }];
    }
    return [key, { value: fallback, source: 'default' }];
  }));
}
export function logSettings(settings, log = console.error) {
  for (const [key, setting] of Object.entries(settings)) log(`needs-you-feed ${key}=${JSON.stringify(setting.value)} source=${setting.source}`);
}
export function feedPath(options = {}) { return resolveSettings(options).path.value; }
export function assertProducerCheckout(checkoutRoot, { env = process.env, settings = resolveSettings({ env }) } = {}) {
  if (settings.allowPrimary.value) return;
  let root = resolve(checkoutRoot); try { root = realpathSync(root); } catch { /* nonexistent test checkout */ }
  const pinned = /^[a-f0-9]{40}$/.test(basename(root)) && basename(dirname(root)) === 'code'
    && basename(dirname(dirname(root))) === '.snapshots' && existsSync(join(root, '.snapshot-complete'));
  if (isLaneLocus(root) || isDaemonCloneRealpath(root, daemonCloneRoots(workspaceRootOf(root), { env })) || pinned) return;
  throw new Error('needs-you-feed: refusing primary checkout; use a lane, daemon clone or sha-pinned snapshot (WE_NEEDS_YOU_FEED_ALLOW_PRIMARY=1 overrides)');
}
export function itemsFromReport(report) {
  const items = [];
  for (const [field, baseKind] of [['ready', 'needs-you'], ['needsYourMerge', 'needs-you'], ['rulingNeeded', 'ruling-needed'], ['stoodDown', 'stood-down']]) {
    for (const row of report[field] ?? []) {
      const clues = [row.kind, row.reason, ...(row.findings ?? []).map(f => f.reason)].filter(Boolean).join(' ');
      const kind = baseKind !== 'ruling-needed' ? baseKind : /round-cap|at-round-limit/.test(clues) ? 'at-round-limit' : /escalat|dispute/.test(clues) ? 'escalated' : baseKind;
      const reason = row.reason || row.reasons?.join('; ') || row.findings?.map(f => f.summary || f.reason).join('; ') || row.title || baseKind;
      items.push({ pr: row.number ?? row.pr, repo: row.repo, head: row.head ?? row.headRefOid ?? '', kind, reason,
        ...(row.pick ? { pick: row.pick } : {}), ...(row.command ? { command: row.command } : {}) });
    }
  }
  items.incomplete = !!report.incomplete;
  return items;
}
const keyOf = i => `${i.repo}#${i.pr}@${i.head}:${i.kind}`;
function fromKey(key) {
  const m = /^(.*)#(\d+)@(.*):([^:]+)$/.exec(key);
  if (!m) throw new Error(`needs-you-feed: invalid state key ${key}`);
  return { repo: m[1], pr: Number(m[2]), head: m[3], was: m[4] };
}
export function diffFeed(prevOpenKeys, items, now, { incomplete = items.incomplete } = {}) {
  const at = new Date(now).toISOString(), prev = new Set(prevOpenKeys), current = new Map(items.map(i => [keyOf(i), i]));
  const lines = [];
  const singleLine = s => String(s).replace(/[\r\n]+/g, ' ');
  for (const [key, item] of current) if (!prev.has(key)) {
    const event = { at, ...item };
    lines.push(`NEEDS-YOU ${item.repo}#${item.pr} ${item.kind}: ${singleLine(item.reason).slice(0, 100)}${item.pick || item.command ? ` | pick: ${singleLine(item.pick || item.command)}` : ''} ${JSON.stringify(event)}`);
  }
  if (!incomplete) for (const key of prev) if (!current.has(key)) {
    const event = { at, kind: 'cleared', ...fromKey(key) };
    lines.push(`NEEDS-YOU-CLEARED ${event.repo}#${event.pr} left ${event.was} ${JSON.stringify(event)}`);
  }
  return { lines, openKeys: [...new Set([...(incomplete ? prev : []), ...current.keys()])] };
}
export function parseFeedLine(line) {
  if (!/^NEEDS-YOU(?:-CLEARED)? /.test(line)) return null;
  // Locate the JSON suffix by its stable first field, never by braces inside a reason/command.
  const start = line.lastIndexOf(' {"at":');
  if (start < 0) return null;
  try { return JSON.parse(line.slice(start + 1)); } catch { return null; }
}
export function appendLines(path, lines) {
  if (!lines.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines.join('\n') + '\n', { flag: 'a' });
}
export function replay({ path = feedPath(), since = '1970-01-01T00:00:00Z' } = {}) {
  const threshold = Date.parse(since); if (!Number.isFinite(threshold)) throw new Error('needs-you-feed: invalid --since timestamp');
  return readOptional(path, '').split('\n').map(parseFeedLine).filter(e => e && Date.parse(e.at) >= threshold);
}
export function unacknowledged({ path = feedPath(), ackPath = join(dirname(path), 'needs-you-ack') } = {}) {
  const ack = readOptional(ackPath, '1970-01-01T00:00:00Z').trim();
  const open = new Map();
  for (const event of replay({ path })) {
    const key = keyOf(event.kind === 'cleared' ? { ...event, kind: event.was } : event);
    if (event.kind === 'cleared') open.delete(key); else open.set(key, event);
  }
  return [...open.values()].filter(e => Date.parse(e.at) > Date.parse(ack));
}
export function monitorCommand(path = feedPath()) {
  return `tail -n 0 -F '${path.replace(/'/g, "'\\''")}' | grep --line-buffered NEEDS-YOU`;
}
export async function runOnce({ exec = execFileSync, home = homedir(), now = new Date(), checkoutRoot = CHECKOUT_ROOT,
  env = process.env, settings = resolveSettings({ env, home, file: readSettings(checkoutRoot) }), log = console.error, owns = () => true } = {}) {
  logSettings(settings, log);
  assertProducerCheckout(checkoutRoot, { env, settings });
  let stdout, failedRead = false;
  try { stdout = await exec(process.execPath, [join(checkoutRoot, 'scripts/operations/operator-queue.mjs'), '--json'],
    { cwd: checkoutRoot, encoding: 'utf8', timeout: 100000, maxBuffer: 256 * 1024 * 1024 }); }
  catch (error) {
    if ((error.status ?? error.code) !== 1 || !error.stdout) throw error;
    stdout = error.stdout; failedRead = true;
  }
  const report = JSON.parse(String(stdout));
  if (!report || typeof report !== 'object' || !Array.isArray(report.ready)) throw new Error('needs-you-feed: invalid operator-queue report');
  if (failedRead) report.incomplete = true;
  const path = settings.path.value, statePath = join(dirname(path), 'needs-you-feed-state.json');
  mkdirSync(dirname(path), { recursive: true });
  // Serialization prevents concurrent once/loop calls from duplicating the same transition.
  return withFileLock(`${statePath}.lock`, () => {
    if (!owns()) return { lines: [], superseded: true };
    const prev = JSON.parse(readOptional(statePath, '{"openKeys":[]}'));
    const result = diffFeed(prev.openKeys, itemsFromReport(report), now);
    appendLines(path, result.lines);
    writeJsonAtomic(statePath, { openKeys: result.openKeys, lastRunAt: new Date(now).toISOString() });
    return result;
  });
}
export async function main(argv = process.argv.slice(2)) {
  const [verb, ...flags] = argv;
  const settings = resolveSettings(); logSettings(settings);
  const path = settings.path.value;
  if (verb === 'monitor-command') console.log(monitorCommand(path));
  else if (verb === 'replay') console.log(JSON.stringify(replay({ path, since: flags.find(f => f.startsWith('--since='))?.slice(8) }), null, 2));
  else if (verb === 'ack') { mkdirSync(dirname(path), { recursive: true }); writeFileSync(join(dirname(path), 'needs-you-ack'), new Date().toISOString() + '\n'); }
  else if (verb === 'once' || verb === 'loop') {
    assertProducerCheckout(CHECKOUT_ROOT, { settings });
    do {
      const started = Date.now();
      try { await runOnce({ settings, log: () => {} }); } catch (error) { if (verb === 'once') throw error; console.error(`needs-you-feed: ${error.message}`); }
      if (verb === 'once') break;
      await new Promise(done => setTimeout(done, Math.max(0, settings.intervalMinutes.value * 60000 - (Date.now() - started))));
    } while (true);
  } else throw new Error('usage: needs-you-feed.mjs once|loop|replay [--since=<iso>]|ack|monitor-command');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
