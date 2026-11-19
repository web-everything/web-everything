/** Real drain entrypoint with hermetic git/gh transports; every listing is recorded as argv. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_FIELDS } from '../../lib/pr-snapshot.mjs';
import { PR_SNAPSHOT_VERSION } from '../../lib/pr-snapshot-store.mjs';
import { buildManifest, embedManifestInBody } from '../../readiness/lane-manifest.mjs';
import { daemonAppEnv } from './daemon-app-env.mjs';

export function runFastDrainContextCli({ root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), killSwitch = false,
  failDefaultBranch = false, outputAsJson = true } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'fast-context-cli-'));
  try {
    const bin = join(dir, 'bin'), snapshots = join(dir, 'snapshots');
    mkdirSync(bin); mkdirSync(snapshots); mkdirSync(join(dir, 'backlog'));
    const rows = Array.from({ length: 48 }, (_, i) => {
      const number = i + 7, headRefOid = number.toString(16).padStart(40, '0');
      return { number, headRefOid, headRefName: `lane/${number}`, title: `Fixture ${number}`, state: 'OPEN',
        updatedAt: '2026-11-18T00:00:00Z', baseRefName: 'main', isDraft: false,
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
        labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], files: [{ path: `src/${number}.mjs` }],
        body: embedManifestInBody('fixture', buildManifest({ item: number, repos: [{ repo: 'we', ref: `lane/${number}` }] })),
        rowsHead: headRefOid, rowsComplete: true,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'test' }] };
    });
    for (const repo of ['fixture/web-everything', 'fixture/frontierui', 'fixture/plateau-app']) {
      writeFileSync(join(snapshots, `${repo.replace('/', '__')}.json`), JSON.stringify({ v: PR_SNAPSHOT_VERSION,
        repo, fetchedAtMs: Date.now(), fields: SNAPSHOT_FIELDS, count: repo === 'fixture/web-everything' ? rows.length : 0,
        prs: repo === 'fixture/web-everything' ? rows : [] }));
    }
    writeFileSync(join(dir, 'rows.json'), JSON.stringify(rows));
    writeFileSync(join(dir, 'calls.jsonl'), '');
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1 $2" = "remote get-url" ]; then echo https://github.com/fixture/web-everything.git; exit 0; fi\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CONTEXT_CALLS, JSON.stringify(a) + '\\n');
const rows = JSON.parse(fs.readFileSync(process.env.CONTEXT_ROWS, 'utf8'));
const r = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : process.env.GH_REPO;
const selected = !r || r === 'fixture/web-everything' ? rows : [];
function out(v) { fs.writeSync(1, JSON.stringify(v)); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'view') {
  if (process.env.CONTEXT_FAIL_BRANCH === '1') { fs.writeSync(2, 'fixture default branch failure'); process.exit(1); }
  fs.writeSync(1, 'main'); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'list') {
  const fields = a[a.indexOf('--json') + 1].split(',');
  out(selected.map(p => Object.fromEntries(fields.map(f => [f, p[f]]))));
}
if (a[0] === 'pr' && a[1] === 'view') {
  const fields = (a[a.indexOf('--json') + 1] || '').split(',');
  if (fields.length === 1 && fields[0] === 'commits') out({commits:[]});
  out(selected.find(p => p.number === Number(a[2])) || {});
}
if (a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN'))) {
  const query = a.find(v => v.includes('pullRequests(states:OPEN'));
  const pageRows = query.includes('name:"web-everything"') ? rows : [];
  out({data:{repository:{pullRequests:{totalCount:pageRows.length, pageInfo:{hasNextPage:false,endCursor:null},
    nodes:pageRows.map(p => ({...p, labels:{nodes:p.labels}, commits:{nodes:[{commit:{oid:p.headRefOid,
      statusCheckRollup:{contexts:{pageInfo:{hasNextPage:false},totalCount:p.statusCheckRollup.length,nodes:p.statusCheckRollup}}}}]}}))}}}});
}
out({});
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(root, 'scripts/merge-ai-prs.mjs'), '--this-repo', '--only=7',
      '--from-green-event', '--label=ready-to-merge', '--dry-run', ...(outputAsJson ? ['--json'] : []), '--no-drain-lease',
      '--no-red-main-freeze', '--no-review-escalation', '--repoll-delay=0'], {
      cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...daemonAppEnv(dir), PATH: `${bin}:${process.env.PATH}`, WE_UNDER_TEST: '1',
        WE_PR_SNAPSHOT: '1', WE_PR_SNAPSHOT_DIR: snapshots, WE_FAST_DRAIN_LISTING: 'snapshot',
        WE_DEFAULT_BRANCH_CACHE_DIR: join(dir, 'branch-cache'), CONTEXT_FAIL_BRANCH: failDefaultBranch ? '1' : '0',
        WE_FAST_DRAIN_CONTEXT: killSwitch ? 'live' : 'snapshot', WE_PR_SNAPSHOT_TTL_MS: '75000',
        WE_GH_THROTTLE_GH_BIN: join(bin, 'gh'), WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1',
        CONTEXT_CALLS: join(dir, 'calls.jsonl'), CONTEXT_ROWS: join(dir, 'rows.json') },
    });
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls,
      fullListings: calls.filter(a => a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN'))).length,
      leanListings: calls.filter(a => a[0] === 'pr' && a[1] === 'list' && a.includes('number,headRefOid,updatedAt,baseRefName,isDraft,state')).length,
      heavyListings: calls.filter(a => a[0] === 'pr' && a[1] === 'list' && a.some(v => v.includes('statusCheckRollup'))).length };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
