// Function ports and executable shims share the same response code and call logs.
import * as fs from 'node:fs';
import { drainScoredGit } from './drain-scored-git.mjs';
import { openPrPageFixture } from './open-pr-page-fixture.mjs';

function prestageGh(process, fs, page) {
const a = process.argv.slice(2), rootPr = JSON.parse(fs.readFileSync(process.env.PRESTAGE_PR, 'utf8'));
const commit = a.find(x => /\/commits\/([a-f0-9]{40})\//.test(x))?.match(/\/commits\/([a-f0-9]{40})\//)?.[1];
const pr = (rootPr.contextPartners ?? []).find(p => a[0] === 'pr' && a[1] === 'view' && p.number === Number(a[2]) || commit && p.headRefOid === commit) ?? rootPr;
fs.appendFileSync(process.env.PRESTAGE_LOG, JSON.stringify(a) + '\n');
// Synchronous writes: an async pipe write past 8KB would be cut off by the exit.
const out = x => { if (a.includes('-i')) fs.writeSync(1, 'HTTP/2 200 OK\n\n'); fs.writeSync(1, typeof x === 'string' ? x : JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo') {
  if (a.includes('url')) out('https://github.com/' + process.env.PRESTAGE_REPO);
  if (process.env.PRESTAGE_FAIL_BRANCH === '1') { fs.writeSync(2, 'fixture live default branch unreadable'); process.exit(1); }
  out(process.env.PRESTAGE_DEFAULT_BRANCH ?? 'main');
}
if (a[0] === 'pr' && ['list', 'view'].includes(a[1]) && a.includes('--repo') && a[a.indexOf('--repo') + 1] !== process.env.PRESTAGE_REPO) out([]);
if (a[0] === 'pr' && a[1] === 'list' && a.includes('--base')) out(pr.stacked || []);
if (a[0] === 'pr' && a[1] === 'list') out([pr]);
if (a[0] === 'pr' && a[1] === 'view') {
  if (pr.fullReadFails) { fs.writeSync(2, 'fixture partner full read failed'); process.exit(1); }
  out(pr);
}
if (a[0] === 'api') {
  if (a[1] === 'user') out('chalbert');
  const path = a.find(x => x.startsWith('repos/')) || '';
  if (path.includes('/rules/branches/') && path.includes('per_page=100')) {
    const rules = pr.queuePrecondition === false ? [] : [
    {type:'merge_queue'},
    {type:'required_status_checks',parameters:{required_status_checks:['test','smoke','daemon-soak','soak-replay-gate','merge-gate'].map(context=>({context,integration_id:15368}))}},
    {type:'workflows',parameters:{workflows:['ci.yml','soak-replay-gate.yml','merge-gate.yml'].map(name=>({path:'.github/workflows/'+name,ref:'refs/heads/main',repository_id:1142650361}))}}
    ];
    out(a.includes('--slurp') ? [rules] : rules);
  }
  if (path === 'repos/'+process.env.PRESTAGE_REPO) out({id:1142650361});
  if (path.includes('/rules/branches/')) out(a.includes('--slurp') ? [[{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]] : [{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]);
  if (path.endsWith('/branches/main')) out({ protected:false });
  if (path.includes('/comments')) out([pr.comments]);
  if (path.includes('/reviews')) out([[]]);
  if (path.includes('/files')) out([[{filename:'README.md',status:'modified'}]]);
  if (pr.unreadableCheckRows && path.includes('/' + pr.unreadableCheckRows + '?')) out([{}]);
  // Complete pages carry the server's total_count: the strict reader attests rows only when delivered === total.
  const runRows = pr.statusCheckRollup.filter(c => c.name).map((c, i) => ({ ...c, id: c.id ?? -(i + 1) }));
  const statusRows = pr.statusCheckRollup.filter(c => c.context).map((c, i) => ({ ...c, id: c.id ?? -(i + 1) }));
  if (path.includes('/check-runs')) out(pr.checkRuns || [{total_count:runRows.length,check_runs:runRows}]);
  if (path.includes('/status?')) out([{total_count:statusRows.length,statuses:statusRows}]);
  if (a[1] === 'graphql') {
    const q = a.find(x => x.startsWith('query=')) || '';
    if (q.includes('timelineItems(')) out({ data: { repository: { pullRequest: { timelineItems: {
      nodes:pr.mqTimeline || [], pageInfo:{hasPreviousPage:false}
    } } } } });
    if (q.includes('enqueuePullRequest')) { fs.writeFileSync(process.env.PRESTAGE_PR+'.queued',''); out({ data: { enqueuePullRequest: { mergeQueueEntry: { id:'E',position:1,state:'QUEUED' } } } }); }
    if (q.includes('isInMergeQueue')) {
      const reads = fs.readFileSync(process.env.PRESTAGE_LOG,'utf8').split('\n').filter(line => line.includes('isInMergeQueue')).length;
      out({ data: { repository: { pullRequest: { headRefOid:pr.headRefOid, isInMergeQueue:(!!pr.inQueue && (!pr.loseQueueAfterAdmission || reads === 1)) || fs.existsSync(process.env.PRESTAGE_PR+'.queued') } } } });
    }
    if (q.includes('mergeQueue(')) out({ data: { repository: { mergeQueue: { entries: { nodes:[],pageInfo:{hasNextPage:false} } } } } });
    const [owner, name] = process.env.PRESTAGE_REPO.split('/');
    if (q.includes('pullRequests(') && !q.includes('repository(owner:"'+owner+'",name:"'+name+'")')) out(page([], q));
    out(page([pr, ...(pr.contextPartners ?? [])], q));
  }
}
out([]);
}

function prestageGit(process, fs, page, scoredGit) {
let a = process.argv.slice(2);
while (a[0] === '-c') a = a.slice(2);
fs.appendFileSync(process.env.PRESTAGE_LOG, JSON.stringify(['git', ...a]) + '\n');
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:' + process.env.PRESTAGE_REPO + '.git\n');
else if (a[0] === 'cat-file' && a[1] === '-e') process.exit(/^[a-f0-9]{40}\^\{commit\}$/i.test(a.at(-1)) ? 0 : 1);
else if (['rev-parse', 'cat-file', 'merge-base', 'diff'].includes(a[0])) {
  const result = scoredGit(a, { gitDir: process.env.PRESTAGE_PR.replace(/pr\.json$/, '.git'), files: [{ path: 'README.md' }] });
  if (result) { process.stdout.write(result.stdout); process.exit(result.status); }
} else if (a[0] === 'ls-tree' && a.at(-1) === '.lane-manifest.json') process.stdout.write('');
else if (a[0] === 'ls-tree' && a.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) process.stdout.write('backlog/xabc123-card.md\n');
else if (a[0] === 'show') {
  if (a[1] === 'origin/main:scripts/lib/queue-branch-numbering.mjs') process.stdout.write('drain-branch-numbering-ci-v1');
  else process.exit(1);
}
}

function listingGh(process, fs, page) {
const a = process.argv.slice(2);
function log(entry) { if (process.env.GH_CALL_LOG) fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(entry) + '\n'); }
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  log({ argv: a });
  const all = JSON.parse(process.env.GH_FIXTURE_PRS_FILE ? fs.readFileSync(process.env.GH_FIXTURE_PRS_FILE, 'utf8') : (process.env.GH_FIXTURE_PRS || '[]'));
  const limitIdx = a.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(a[limitIdx + 1]) : all.length;
  // fs.writeSync (never process.stdout.write + process.exit) — a large payload's async pipe write can be
  // truncated by an immediate process.exit() (a real Node footgun, caught live authoring this fixture: a
  // 501-PR fixture came back "Unterminated string in JSON" at exactly one pipe-buffer's worth of bytes).
  fs.writeSync(1, JSON.stringify(all.slice(0, limit)));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write('{}'); process.exit(0); }
process.stdout.write('[]');
process.exit(0);
}

function capture(port, args, env) {
  let stdout = '', stderr = '';
  const stopped = {};
  let status = 0;
  const write = value => { stdout += String(value); return true; };
  const process = { argv: ['node', 'fixture', ...args], env, stdout: { write },
    exit(code = 0) { status = code; throw stopped; } };
  try { port(process, { ...fs, writeSync(fd, value) {
    if (fd === 2) { stderr += String(value); return Buffer.byteLength(value); }
    if (fd !== 1) throw new Error(`Unexpected fixture fd ${fd}`);
    write(value); return Buffer.byteLength(value);
  } }, openPrPageFixture, drainScoredGit); } catch (error) { if (error !== stopped) throw error; }
  return { status, stdout, stderr };
}
const port = fn => (args, env) => capture(fn, args, env);
export const prestagePorts = { gh: port(prestageGh), git: port(prestageGit) };
export const listingPorts = { gh: port(listingGh), git: args => {
  // The original throwaway repo has no origin and no commits.
  return { status: 128, stdout: '', stderr: 'fatal: no origin or revision' };
} };
const scriptFor = fn => `#!/usr/bin/env node
(${fn.toString()})(process, require('node:fs'), ${openPrPageFixture.toString()}, ${drainScoredGit.toString()});
`;
export const fakeGh = scriptFor(prestageGh);
export const fakeGit = scriptFor(prestageGit);
export const FAKE_GH = scriptFor(listingGh);
