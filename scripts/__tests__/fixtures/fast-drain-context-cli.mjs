import { createHash } from 'node:crypto';
/** Real drain entrypoint with hermetic git/gh transports; every listing is recorded as argv. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_FIELDS } from '../../lib/pr-snapshot.mjs';
import { writeDefaultBranchCache, readDefaultBranchCache } from '../../lib/default-branch-cache.mjs';
import { PR_SNAPSHOT_VERSION } from '../../lib/pr-snapshot-store.mjs';
import { buildManifest, embedManifestInBody } from '../../readiness/lane-manifest.mjs';
import { fastDrainArgs } from '../../lib/enqueue-on-event.mjs';
import { daemonAppEnv } from './daemon-app-env.mjs';

export function runFastDrainContextCli({ root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), killSwitch = false,
  cacheWriteFailure = false, watchDirty = false, pinnedPatches = {}, rebaseDrop = true,
  catchUp = false, scope = 'target', livePatches = {}, targetLabels = null, failDefaultBranch = false, outputAsJson = true, cachedBranch = null, liveDefaultBranch = 'main', branchAfterMembership = null, roundBranch = null, rowCount = 48, leanIncomplete = false, fullIncomplete = false, leanPageError = false, targetBaseRefName = 'main', workflowEditSetting = null, extraContextRows = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'fast-context-cli-'));
  try {
    const bin = join(dir, 'bin'), snapshots = join(dir, 'snapshots');
    mkdirSync(bin); mkdirSync(snapshots); mkdirSync(join(dir, 'backlog'));
    if (cacheWriteFailure) {
      const slug = `fixture/${cacheWriteFailure === true ? 'web-everything' : cacheWriteFailure}`;
      mkdirSync(join(snapshots, `heavy-${createHash('sha256').update(slug).digest('hex')}.json`));
    }
    const rows = Array.from({ length: rowCount }, (_, i) => {
      const number = i + 7, headRefOid = number.toString(16).padStart(40, '0');
      return { number, headRefOid, headRefName: `lane/${number}`, title: `Fixture ${number}`, state: 'OPEN',
        updatedAt: '2026-11-18T00:00:00Z', baseRefName: number === 7 ? targetBaseRefName : 'main', baseRefOid: 'b'.repeat(40), isDraft: false,
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
        labels: number === 7 && targetLabels ? targetLabels : [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], files: [{ path: `src/${number}.mjs` }],
        body: embedManifestInBody('fixture', buildManifest({ item: number, repos: [{ repo: 'we', ref: `lane/${number}` }] })),
        comments: [{ author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${headRefOid} -->` }],
        rowsHead: headRefOid, rowsComplete: true,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'test' }] };
    });
    for (const repo of ['fixture/web-everything', 'fixture/frontierui', 'fixture/plateau-app']) {
      writeFileSync(join(snapshots, `${repo.replace('/', '__')}.json`), JSON.stringify({ v: PR_SNAPSHOT_VERSION,
        repo, fetchedAtMs: Date.now(), fields: SNAPSHOT_FIELDS, count: repo === 'fixture/web-everything' ? rows.length : 0,
        prs: repo === 'fixture/web-everything' ? rows : [] }));
    }
    const cacheEnv = { ...process.env, WE_DEFAULT_BRANCH_CACHE_DIR: join(dir, 'branch-cache') };
    if (cachedBranch) writeDefaultBranchCache('fixture/web-everything', cachedBranch, { env: cacheEnv });
    const roundPath = join(dir, 'round.json');
    if (roundBranch) writeFileSync(roundPath, JSON.stringify({ repo: 'fixture/web-everything',
      writtenAt: Date.now(), defaultBranch: roundBranch }));
    // Snapshot and live transports intentionally diverge without changing membership identity.
    const liveRows = rows.map(p => ({ ...p, ...(livePatches[p.number] ?? {}) }));
    writeFileSync(join(dir, 'rows.json'), JSON.stringify(liveRows));
    writeFileSync(join(dir, 'calls.jsonl'), '');
    writeFileSync(join(dir, 'live-branch'), liveDefaultBranch);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CONTEXT_CALLS + '.git', JSON.stringify(args) + '\\n');
if (args[0] === 'remote' && args[1] === 'get-url') {
  fs.writeSync(1, 'https://github.com/fixture/web-everything.git\\n'); process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
    // The async test transport resolves gh via PATH; both that path and the binary
    // hook must reach gh-throttle before the fake serves check/status evidence.
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CONTEXT_CALLS, JSON.stringify(a) + '\\n');
const rows = JSON.parse(fs.readFileSync(process.env.CONTEXT_ROWS, 'utf8'));
const r = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : process.env.GH_REPO;
const selected = !r || r === 'fixture/web-everything' || process.env.CONTEXT_EXTRA_ROWS === '1' ? rows : [];
function out(v) { fs.writeSync(1, JSON.stringify(v)); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'view') {
  if (process.env.CONTEXT_FAIL_BRANCH === '1') { fs.writeSync(2, 'fixture default branch failure'); process.exit(1); }
  fs.writeSync(1, fs.readFileSync(process.env.CONTEXT_BRANCH_FILE, 'utf8')); process.exit(0);
}
if (a[0] === 'api' && a[1]?.includes('/git/ref/heads/')) { fs.writeSync(1, 'a'.repeat(40)); process.exit(0); }
const endpoint = a.find(v => v.startsWith('repos/') && v.includes('/commits/'));
if (a[0] === 'api' && endpoint) {
  if (!process.env.WE_GH_THROTTLE_OUTER_INV) {
    fs.appendFileSync(process.env.CONTEXT_CALLS + '.bare-checks', JSON.stringify(a) + '\\n');
    fs.writeSync(2, 'check/status read bypassed gh-throttle'); process.exit(1);
  }
  const p = selected.find(p => endpoint.includes(p.headRefOid));
  if (p && endpoint.includes('/check-runs?')) {
    if (endpoint.includes('filter=all') && Object.hasOwn(p, 'liveCheckRunPages')) out(p.liveCheckRunPages);
    const runs = p.liveCheckRuns ?? (p.statusCheckRollup ?? []).filter(c => c.__typename === 'CheckRun')
      .map((c, i) => ({...c, id:i+1, head_sha:p.headRefOid}));
    const checkName = /[?&]check_name=([^&]+)/.exec(endpoint)?.[1];
    const filtered = checkName ? runs.filter(c => c.name === decodeURIComponent(checkName)) : runs;
    out([{total_count:filtered.length,check_runs:filtered}]);
  }
  if (p && endpoint.includes('/status?')) {
    if (Object.hasOwn(p, 'liveStatusPages')) out(p.liveStatusPages);
    const statuses = (p.statusCheckRollup ?? []).filter(c => c.__typename === 'StatusContext')
      .map((c, i) => ({...c, id:i+1}));
    out([{total_count:statuses.length,statuses}]);
  }
}
if (a[0] === 'pr' && a[1] === 'list') {
  const fields = a[a.indexOf('--json') + 1].split(',');
  out(selected.map(p => Object.fromEntries(fields.map(f => [f, p[f]]))));
}
if (a[0] === 'pr' && a[1] === 'view') {
  const fields = (a[a.indexOf('--json') + 1] || '').split(',');
  const realFields = new Set('number,headRefOid,headRefName,title,state,updatedAt,baseRefName,baseRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,labels,files,body,statusCheckRollup,commits,comments'.split(','));
  if (fields.some(f => !realFields.has(f))) process.exit(1);
  const p = selected.find(p => p.number === Number(a[2]));
  const view = p ? Object.fromEntries(fields.map(f => [f, f === 'commits' ? [] : p[f]])) : {};
  if (fields.includes('baseRefOid') && fields.includes('body') && fields.includes('files')) {
    Object.assign(view, JSON.parse(process.env.CONTEXT_PINNED_PATCHES || '{}')[a[2]] || {});
  }
  // Commit reads happen after the first listing has persisted, between watch listings.
  if (process.env.CONTEXT_WATCH_DIRTY === '1' && fields.includes('commits')) {
    fs.writeFileSync(process.env.WE_PR_SNAPSHOT_DIR + '/fixture__web-everything.dirty', 'dirty');
  }
  fs.appendFileSync(process.env.CONTEXT_CALLS + '.views', JSON.stringify({fields,view}) + '\\n');
  out(view);
}
if (a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN'))) {
  const query = a.find(v => v.includes('pullRequests(states:OPEN'));
  const pageRows = query.includes('name:"web-everything"') || process.env.CONTEXT_EXTRA_ROWS === '1' ? rows : [];
  if (!query.includes('statusCheckRollup')) {
    if (pageRows.length && process.env.CONTEXT_BRANCH_AFTER_MEMBERSHIP) {
      fs.writeFileSync(process.env.CONTEXT_BRANCH_FILE, process.env.CONTEXT_BRANCH_AFTER_MEMBERSHIP);
    }
    const size = Number(/first:(\\d+)/.exec(query)?.[1]);
    const offset = Number(/after:"lean-(\\d+)"/.exec(query)?.[1] || 0);
    if (offset && process.env.CONTEXT_LEAN_PAGE_ERROR === '1') out({errors:[{message:'fixture lean page error'}]});
    const partial = pageRows.length && process.env.CONTEXT_LEAN_INCOMPLETE === '1';
    const nodes = (partial ? pageRows.slice(0, 1) : pageRows.slice(offset, offset + size))
      .map(p => Object.fromEntries(['number','headRefOid','updatedAt','baseRefName','isDraft','state'].map(f => [f,p[f]])));
    const hasNextPage = !partial && offset + size < pageRows.length;
    out({data:{repository:{pullRequests:{totalCount:pageRows.length,
      pageInfo:{hasNextPage,endCursor:hasNextPage ? 'lean-'+(offset+size) : null},nodes}}}});
  }
  const fullRows = process.env.CONTEXT_FULL_INCOMPLETE === '1' ? pageRows.slice(0, -1) : pageRows;
  out({data:{repository:{pullRequests:{totalCount:pageRows.length, pageInfo:{hasNextPage:false,endCursor:null},
    nodes:fullRows.map(p => ({...p, labels:{totalCount:p.labels.length,nodes:p.labels}, commits:{nodes:[{commit:{oid:p.headRefOid,
      statusCheckRollup:{contexts:{pageInfo:{hasNextPage:false},totalCount:p.statusCheckRollup.length,nodes:p.statusCheckRollup}}}}]}}))}}}});
}
out({});
`, { mode: 0o755 });
    const args = catchUp ? fastDrainArgs({ scriptRoot: root, num: 7, listingSnapshot: roundPath })
      : [join(root, 'scripts/merge-ai-prs.mjs'), '--this-repo', '--only=7', '--from-green-event', '--label=ready-to-merge',
        ...(outputAsJson ? ['--json'] : []), ...(roundBranch ? [`--listing-snapshot=${roundPath}`] : [])];
    const result = spawnSync(process.execPath, [...args, '--dry-run', '--no-drain-lease',
      ...(!rebaseDrop ? ['--no-rebase-drop'] : []),
      ...(watchDirty ? ['--watch', '--max-idle=2', '--interval=1'] : []),
      '--no-red-main-freeze', '--no-review-escalation', '--repoll-delay=0'], {
      cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...daemonAppEnv(dir), PATH: `${bin}:${process.env.PATH}`, WE_UNDER_TEST: '1',
        ...(workflowEditSetting ? { WE_DRAIN_WORKFLOW_EDIT_HUMAN: workflowEditSetting } : {}),
        WE_PR_SNAPSHOT: '1', WE_PR_SNAPSHOT_DIR: snapshots, WE_FAST_DRAIN_LISTING: 'snapshot',
        WE_DEFAULT_BRANCH_CACHE_DIR: join(dir, 'branch-cache'), CONTEXT_FAIL_BRANCH: failDefaultBranch ? '1' : '0',
        CONTEXT_BRANCH_FILE: join(dir, 'live-branch'), CONTEXT_BRANCH_AFTER_MEMBERSHIP: branchAfterMembership ?? '',
        WE_FAST_DRAIN_SCOPE: scope, WE_FAST_DRAIN_CONTEXT: killSwitch ? 'live' : 'snapshot', WE_PR_SNAPSHOT_TTL_MS: '75000',
        WE_GH_THROTTLE_GH_BIN: join(bin, 'gh'), WE_GH_THROTTLE_OUTER_INV: '',
        WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1',
        CONTEXT_LEAN_INCOMPLETE: leanIncomplete ? '1' : '0', CONTEXT_FULL_INCOMPLETE: fullIncomplete ? '1' : '0',
        CONTEXT_LEAN_PAGE_ERROR: leanPageError ? '1' : '0', CONTEXT_EXTRA_ROWS: extraContextRows ? '1' : '0',
        CONTEXT_WATCH_DIRTY: watchDirty ? '1' : '0',
        CONTEXT_PINNED_PATCHES: JSON.stringify(pinnedPatches),
        CONTEXT_CALLS: join(dir, 'calls.jsonl'), CONTEXT_ROWS: join(dir, 'rows.json') },
    });
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls,
      gitCalls: existsSync(join(dir, 'calls.jsonl.git'))
        ? readFileSync(join(dir, 'calls.jsonl.git'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
      bareCheckReads: existsSync(join(dir, 'calls.jsonl.bare-checks'))
        ? readFileSync(join(dir, 'calls.jsonl.bare-checks'), 'utf8').trim().split('\n').map(JSON.parse) : [],
      prViews: existsSync(join(dir, 'calls.jsonl.views'))
        ? readFileSync(join(dir, 'calls.jsonl.views'), 'utf8').trim().split('\n').map(JSON.parse) : [],
      heavyStores: ['web-everything','frontierui','plateau-app'].filter(name => existsSync(join(snapshots, `heavy-${createHash('sha256').update(`fixture/${name}`).digest('hex')}.json`))),
      passSnapshotPublished: existsSync(roundPath),
      cachedBranch: readDefaultBranchCache('fixture/web-everything', { env: cacheEnv }),
      fullListings: calls.filter(a => a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN') && v.includes('statusCheckRollup'))).length,
      leanListings: calls.filter(a => a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN') && !v.includes('statusCheckRollup'))).length,
      heavyListings: calls.filter(a => a[0] === 'pr' && a[1] === 'list' && a.some(v => v.includes('statusCheckRollup'))).length };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
