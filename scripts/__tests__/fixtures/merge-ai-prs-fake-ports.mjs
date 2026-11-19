// Function ports and executable shims share the same response code and call logs.
import * as fs from 'node:fs';
import { openPrPageFixture } from './open-pr-page-fixture.mjs';

function prestageGh(process, fs, page) {
const a = process.argv.slice(2), pr = JSON.parse(fs.readFileSync(process.env.PRESTAGE_PR, 'utf8'));
fs.appendFileSync(process.env.PRESTAGE_LOG, JSON.stringify(a) + '\n');
// Synchronous writes: an async pipe write past 8KB would be cut off by the exit.
const out = x => { if (a.includes('-i')) fs.writeSync(1, 'HTTP/2 200 OK\n\n'); fs.writeSync(1, typeof x === 'string' ? x : JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo') out('main');
if (a[0] === 'pr' && ['list', 'view'].includes(a[1]) && a.includes('--repo') && a[a.indexOf('--repo') + 1] !== process.env.PRESTAGE_REPO) out([]);
if (a[0] === 'pr' && a[1] === 'list' && a.includes('--base')) out(pr.stacked || []);
if (a[0] === 'pr' && a[1] === 'list') out([pr]);
if (a[0] === 'pr' && a[1] === 'view') out(pr);
if (a[0] === 'api') {
  if (a[1] === 'user') out('chalbert');
  const path = a.find(x => x.startsWith('repos/')) || '';
  if (path.includes('/rules/branches/')) out(a.includes('--slurp') ? [[{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]] : [{type:'required_status_checks',parameters:{required_status_checks:[{context:'test'}]}}]);
  if (path.endsWith('/branches/main')) out({ protected:false });
  if (path.includes('/comments')) out([pr.comments]);
  if (path.includes('/reviews')) out([[]]);
  if (path.includes('/files')) out([[{filename:'README.md',status:'modified'}]]);
  if (path.includes('/check-runs')) out(pr.checkRuns || [{check_runs:[]}]);
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
    out(page([pr], q));
  }
}
out([]);
}

function prestageGit(process, fs, page) {
const a = process.argv.slice(2);
fs.appendFileSync(process.env.PRESTAGE_LOG, JSON.stringify(['git', ...a]) + '\n');
// Git accepts global config pins before the subcommand. Keep the original argv in the call log.
while (a[0] === '-c') a.splice(0, 2);
const pr = JSON.parse(fs.readFileSync(process.env.PRESTAGE_PR, 'utf8'));
const baseSha = 'd'.repeat(40);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:' + process.env.PRESTAGE_REPO + '.git\n');
else if (a[0] === 'merge-base') process.stdout.write(baseSha + '\n');
else if (a[0] === 'rev-parse') {
  const ref = a.at(-1).replace(/\^\{commit\}$/, '');
  if (['refs/remotes/origin/main', 'FETCH_HEAD'].includes(ref)) process.stdout.write(baseSha + '\n');
  else if ([pr.headRefOid, pr.headRefName, 'HEAD'].includes(ref)) process.stdout.write(pr.headRefOid + '\n');
  else process.exit(1);
}
else if (a[0] === 'diff') {
  if (a.includes('--name-only')) process.stdout.write('README.md\0');
  else if (a.includes('--numstat')) process.stdout.write('1\t0\tREADME.md\n');
  else process.stdout.write('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n');
} else if (a[0] === 'ls-tree' && a.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) process.stdout.write('backlog/xabc123-card.md\n');
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
  let stdout = '';
  const stopped = {};
  let status = 0;
  const write = value => { stdout += String(value); return true; };
  const process = { argv: ['node', 'fixture', ...args], env, stdout: { write },
    exit(code = 0) { status = code; throw stopped; } };
  try { port(process, { ...fs, writeSync(fd, value) {
    if (fd !== 1) throw new Error(`Unexpected fixture fd ${fd}`);
    write(value); return Buffer.byteLength(value);
  } }, openPrPageFixture); } catch (error) { if (error !== stopped) throw error; }
  return { status, stdout, stderr: '' };
}
const port = fn => (args, env) => capture(fn, args, env);
export const prestagePorts = { gh: port(prestageGh), git: port(prestageGit) };
export const listingPorts = { gh: port(listingGh), git: args => {
  // The original throwaway repo has no origin and no commits.
  return { status: 128, stdout: '', stderr: 'fatal: no origin or revision' };
} };
const scriptFor = fn => `#!/usr/bin/env node
(${fn.toString()})(process, require('node:fs'), ${openPrPageFixture.toString()});
`;
export const fakeGh = scriptFor(prestageGh);
export const fakeGit = scriptFor(prestageGit);
export const FAKE_GH = scriptFor(listingGh);
