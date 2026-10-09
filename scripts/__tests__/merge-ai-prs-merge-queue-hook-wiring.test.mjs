/**
 * Card xs1hdl7 — the merge-queue freshness hook, exercised through the REAL drain CLI with hermetic git/gh shims
 * (the #4389 isolation harness). Proves the merge-site wiring, not just the pure rule: a stale-pass PR is never
 * handed to `gh pr merge`, a fresh one merges unchanged, and with the hook off both merge (today).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const NOW = Date.now();
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const F = process.env.MQ_FIXTURE;
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const landed = n => fs.existsSync(F + '.merged-' + n);
const out = x => { process.stdout.write(JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') out(prs.filter(p => !landed(p.number)));
if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs.find(p => String(p.number) === a[2]);
  if (!p) process.exit(1);
  out({ ...p, state: landed(p.number) ? 'MERGED' : 'OPEN', mergedAt: landed(p.number) ? '2026-10-09T00:00:00Z' : null });
}
if (a[0] === 'pr' && a[1] === 'merge') { fs.appendFileSync(F + '.attempts', a[2] + '\\n'); fs.writeFileSync(F + '.merged-' + a[2], ''); process.exit(0); }
if (a[0] === 'run' && a[1] === 'rerun') { fs.appendFileSync(F + '.reruns', a[2] + '\\n'); process.exit(0); }
if (a[0] === 'api') {
  const path = a[1];
  fs.appendFileSync(F + '.api', path + '\\n');
  let m;
  if ((m = /commits\\/(sha-\\d+)\\/check-runs/.exec(path))) {
    const p = prs.find(p => p.headRefOid === m[1]);
    out([{ check_runs: [{ id: 7, name: 'test', head_sha: m[1], status: 'completed', conclusion: 'success',
      started_at: p.passAt, completed_at: p.passAt, details_url: 'https://github.com/o/r/actions/runs/99' + p.number + '/job/1' }] }]);
  }
  if (/\\/branches\\/main$/.test(path)) out({ sha: 'tip' });
  if ((m = /compare\\/(sha-\\d+)\\.\\.\\.tip$/.exec(path))) out({ base: 'base-' + m[1], ahead: 3, files: ['backlog/elsewhere.md'], n: 1 });
  if ((m = /pulls\\/(\\d+)\\/files/.exec(path))) out([[{ filename: 'backlog/leaf-' + m[1] + '.md' }]]);
}
process.exit(0);
`;
const fakeGit = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-mq.git\\n');
if (a[0] === 'diff') process.exit(1);
process.exit(0);
`;

function runCli({ hookOn, seedRefreshed = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-mq-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, code] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const fixture = join(dir, 'prs.json');
    // #3001: pass 5 min old (fresh). #3002: pass 120 min old (stale). Main moved only on a backlog card (non-code).
    writeFileSync(fixture, JSON.stringify([[3001, 5], [3002, 120]].map(([number, age]) => ({
      number, title: `leaf ${number}`, body: 'A real summary.', headRefName: `lane/leaf-${number}`,
      baseRefName: 'main', headRefOid: `sha-${number}`, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      labels: [{ name: 'ready-to-merge' }], comments: [], passAt: iso(age),
      commits: [{ oid: `sha-${number}`, authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0 }],
    }))));
    const settings = join(dir, 'merge-queue.json');
    writeFileSync(settings, JSON.stringify({
      mergeQueue: { enabled: hookOn, batchSize: 1 },
      mergeFreshness: { enabled: hookOn, maxAgeMinutes: 30, allowDisjointMainMoves: true },
    }));
    const coord = join(dir, 'coord');
    const statePath = join(coord, 'merge-queue-refreshed.json');
    if (seedRefreshed) { mkdirSync(coord, { recursive: true }); writeFileSync(statePath, JSON.stringify(seedRefreshed)); }
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.MQ_HOME; syncBuiltinESMExports();");
    const r = spawnSync(process.execPath, ['--import', preload, script, '--this-repo', '--label=ready-to-merge',
      '--no-reconcile-labels', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MQ_FIXTURE: fixture, MQ_HOME: dir,
        // hook OFF = no settings file at all: the built-in default (a test run never reads the live file)
        ...(hookOn ? { WE_MERGE_QUEUE_SETTINGS_FILE: settings } : {}), WE_COORDINATION_ROOT: coord },
    });
    expect(r.error, r.stderr).toBeUndefined();
    const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
    const read = (s) => (existsSync(fixture + s) ? readFileSync(fixture + s, 'utf8').trim().split('\n').filter(Boolean) : []);
    const refreshed = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    return { result, stderr: r.stderr, attempts: read('.attempts').map(Number), api: read('.api'), refreshed };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('card xs1hdl7 — merge-queue hook wired at the drain merge site', () => {
  it('hook ON: the fresh PR merges, the stale-pass PR never reaches gh pr merge and is refreshed instead', () => {
    const { result, stderr, attempts, api } = runCli({ hookOn: true });
    expect(attempts).toEqual([3001]);
    expect(result.merged.map((p) => p.num)).toEqual([3001]);
    expect(stderr).toMatch(/merge-queue: refresh \(pass-too-old\)/);
    expect(api.some((p) => p.includes('commits/sha-3002/check-runs'))).toBe(true);
  }, 30000);

  it('a refresh that did not go through is NOT recorded, so the next pass retries it', () => {
    // The shim `git ls-remote` prints no tip, so the head pin refuses the refresh (unreadable tip ≠ judged head).
    const { stderr, refreshed } = runCli({ hookOn: true });
    expect(stderr).toMatch(/merge-queue: refresh \(pass-too-old\) → \S+ failed/);
    expect(refreshed).toBeNull();
  }, 30000);

  it('once per head: a head already refreshed waits — no second refresh, no merge', () => {
    const seed = Object.fromEntries(['fixture/drain-mq#3002', 'cwd#3002'].map((k) => [k, 'sha-3002']));
    const { stderr, attempts } = runCli({ hookOn: true, seedRefreshed: seed });
    expect(attempts).toEqual([3001]);
    expect(stderr).toMatch(/merge-queue: wait \(refresh-already-requested\)/);
  }, 30000);

  it('hook OFF (built-in default): both merge exactly as today, no freshness reads', () => {
    const { attempts, api } = runCli({ hookOn: false });
    expect(attempts.sort()).toEqual([3001, 3002]);
    expect(api.filter((p) => p.includes('check-runs?check_name=test&per_page=100'))).toEqual([]);
  }, 30000);
});
