/**
 * 2026-11-06: Claude OAuth stayed expired for ~3h. The health smell opened,
 * but only desktop notify went out; no NEEDS-YOU re-login item reached the operator.
 * Replay the recorded sessions through the real tick, persistence and detector.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/conveyor/health-watch.mjs';

// A fresh process keeps transport guards and HOME out of the soak runner. Node's
// permission boundary permits source reads and scratch writes only, with no child
// processes (including gh, Claude, osascript and desktop notification commands).
const CHILD = `
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const blocked = () => { throw new Error('soak: external transport disabled'); };
net.Socket.prototype.connect = blocked;
net.connect = net.createConnection = tls.connect = blocked;
http.request = http.get = https.request = https.get = blocked;
dgram.createSocket = blocked;
globalThis.fetch = blocked;
// CLI discovery expects existsSync to return false for unavailable host paths.
// Keep denied files unreadable while preserving that normal missing-file result.
const exists = fs.existsSync;
fs.existsSync = path => {
  try { return exists(path); }
  catch (error) { if (error.code === 'ERR_ACCESS_DENIED') return false; throw error; }
};
syncBuiltinESMExports();
const root = process.env.SOAK_SOURCE_ROOT;
const scratch = process.env.SOAK_SCRATCH;
const { tick } = await import(pathToFileURL(join(root, '${SOURCE}')).href);
const { default: smell } = await import(pathToFileURL(join(root, 'scripts/conveyor/health-smells/claude-auth-expired.mjs')).href);
// The ET Nov 6 outage's recorded timestamps fall on Nov 7 in UTC.
const start = Date.parse('2026-11-07T01:52:00Z');
const sessions = [
  { name: 'ci-heal-6469', startedAt: Date.parse('2026-11-07T00:13:54Z') },
  { name: 'ci-heal-6472', startedAt: Date.parse('2026-11-07T00:14:07Z') },
  { name: 'fix-6467', startedAt: Date.parse('2026-11-07T01:49:00Z') },
  { name: 'ci-heal-6469', startedAt: Date.parse('2026-11-07T01:51:00Z') },
];
const { diffFeed, REPORT_KINDS, GATE_KINDS } = await import(pathToFileURL(join(root, 'scripts/operations/needs-you-feed.mjs')).href);
const key = 'claude-auth-expired::claude-auth';
async function replay(name, blip) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const flags = { 'state-root': dir, 'logs-dir': join(dir, 'logs'),
    'builder-log-dir': join(dir, 'logs'), 'lock-root': join(dir, 'locks'),
    'self-sync-dir': join(dir, 'sync'), 'no-diagnose': true,
    'no-investigate': true, 'no-file': true, 'force-gh': true,
    'heavy-status-file': join(dir, 'heavy.json'),
    'ps-fixture': join(dir, 'ps.txt'),
    'graphql-budget-fixture': join(dir, 'graphql.json') };
  for (const folder of ['logs', 'locks', 'sync']) mkdirSync(join(dir, folder));
  writeFileSync(flags['heavy-status-file'], '{}');
  writeFileSync(flags['ps-fixture'], '');
  writeFileSync(flags['graphql-budget-fixture'], '{}');
  const calls = [];
  const transitions = [];
  const offsets = blip ? [0, 60_000] : [0, 60_000, 5 * 3_600_000];
  for (const offset of offsets) {
    const rows = (blip ? sessions.slice(-1) : sessions)
      .map(s => ({ ...s, startedAt: s.startedAt + (offset > 60_000 ? offset : 0) }));
    const result = await tick({ ...flags, now: new Date(start + offset).toISOString() }, {
      smells: [smell], publishNeedsYou: async item => { calls.push(item); },
      collectInventory: () => ({ repositories: [], ciFindings: [] }),
      collectGh: () => ({ probes: { authExpired: rows }, errors: {} }),
    });
    transitions.push(...result.transitions);
  }
  // The next normal operator-queue refresh (complete report, nothing for this item) must not clear the alert.
  const open = calls.length ? diffFeed([], calls, start).openKeys : [];
  const refresh = diffFeed(open, [], start + 60_000, { incomplete: false, clearKinds: REPORT_KINDS, alsoClear: GATE_KINDS });
  const refreshCleared = refresh.lines.filter(l => l.startsWith('NEEDS-YOU-CLEARED')).length;
  return { calls, refreshCleared, opened: transitions.some(t => t.type === 'opened' && t.key === key) };
}
const sustained = await replay('sustained', false);
const blip = await replay('blip', true);
process.stdout.write(JSON.stringify({ sustained, blip }));
`;

export default {
  id: 'claude-auth-needs-you',
  title: 'Claude OAuth expired for ~3h (2026-11-06); the smell opened but only desktop notify went out, with no NEEDS-YOU line',
  card: 'operator incident 2026-11-06 — Claude OAuth expired NEEDS-YOU delivery',
  fixedBy: { sha: 'HEAD', where: 'health-watch tick publishes one NEEDS-YOU re-login item', paths: [SOURCE] },
  fixPresent(root) {
    try { return readFileSync(join(root, SOURCE), 'utf8').includes('needsYouAt'); }
    catch { return false; }
  },
  async run({ log, sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soak-claude-auth-needs-you-')));
    try {
      const args = ['--experimental-permission', `--allow-fs-read=${sourceRoot}`,
        `--allow-fs-read=${realpathSync(join(sourceRoot, 'node_modules'))}`,
        `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '--input-type=module', '--eval', CHILD];
      const report = JSON.parse(execFileSync(process.execPath, args, {
        cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { HOME: dir, TMPDIR: dir, CONVEYOR_STATE_ROOT: join(dir, 'state'),
          SOAK_SOURCE_ROOT: sourceRoot, SOAK_SCRATCH: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      log?.(JSON.stringify(report));
      return report;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) {
    const problems = [];
    if (report?.sustained?.opened !== true) problems.push('scenario setup: sustained outage never opened claude-auth-expired');
    if (report?.sustained?.calls?.length !== 1) problems.push('sustained outage must publish exactly one NEEDS-YOU re-login item across repeated ticks and a reminder');
    const item = report?.sustained?.calls?.[0];
    if (item?.kind !== 'claude-auth-expired' || item?.reason !== 'Claude login expired — re-login') problems.push('missing NEEDS-YOU re-login item');
    if (report?.sustained?.refreshCleared !== 0) problems.push('a complete operator-queue feed refresh cleared the re-login alert while the outage was open');
    if (report?.blip?.calls?.length !== 0 || report?.blip?.opened !== false) problems.push('single-session blip produced an alert or its evidence is incomplete');
    return problems;
  },
};
