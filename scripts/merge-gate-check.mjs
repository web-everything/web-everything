#!/usr/bin/env node
/**
 * @file scripts/merge-gate-check.mjs
 * @description The required `merge-gate` CI check: every gate the drain applies right before its merge write,
 *   evaluated in CI so GitHub's merge queue can do the merging (strategy `github-merge-queue`). THIS FILE ONLY
 *   GATHERS FACTS; every decision is `./lib/merge-gate-ci.mjs`, which reuses the drain's own pure functions.
 *   The gate list and where each gate lives is `./lib/merge-gate-inventory.mjs`.
 *
 * Usage:
 *   node scripts/merge-gate-check.mjs --repo=<owner/name> --pr=<n>[,<n>…]            # pull_request / dry run
 *   node scripts/merge-gate-check.mjs --repo=<owner/name> --merge-group \
 *        --head-sha=<sha> --base-sha=<sha> --head-ref=<ref>                           # merge_group: every PR in it
 *   flags: --json (machine output) · --cwd=<clone> (git reads; default cwd) · --group-tree=<dir> (merge_group:
 *          the group commit's checkout, scanned for duplicate ids too) · --list-group (print the group's PR
 *          numbers, one per line, and exit)
 * Exit: 0 every PR passes · 1 a gate holds or fails closed · 3 usage error.
 *
 * SECURITY: the workflow runs THIS script from `main` (never the PR's ref), so a PR cannot neuter its own gate.
 * The PR's body/labels/diff are read as DATA only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePrGates, evaluateGroup, groupPrNumbers, formatPrResult } from './lib/merge-gate-ci.mjs';
import { readDrainAcceptance, computeNetDiffSignals } from './merge-ai-prs.mjs';
import { extractManifestFromBody } from './readiness/lane-manifest.mjs';
import { remoteManifestApiArgs } from './lib/remote-manifest.mjs';
import { findDuplicateIds } from './lib/duplicate-id-tripwire.mjs';
import { loadDrainGateSettings } from './lib/codeql-gate.mjs';
import { loadMergeDeliveryPolicy, formatMergeDeliverySourcesLine } from './lib/merge-delivery-policy.mjs';
import { readSettings } from './lib/settings-files.mjs';
import { GATE_IDS } from './lib/merge-gate-inventory.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';

const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
const ghJson = (args, exec) => JSON.parse(exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) || 'null');

const PR_FIELDS = 'number,title,body,labels,commits,headRefName,headRefOid,baseRefName,statusCheckRollup';
const BODY_HISTORY_QUERY = 'query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){userContentEdits(first:100){totalCount nodes{diff}}}}}';
const QUEUE_QUERY = 'query($o:String!,$n:String!,$b:String!){repository(owner:$o,name:$n){mergeQueue(branch:$b){entries(first:100){nodes{position headCommit{oid} pullRequest{number}}}}}}';

/** Gather every fact `evaluatePrGates` needs for one PR. Never throws; each failure is recorded on its fact. */
export function gatherPrFacts({ repo, num, cwd, defaultBranch, groupDuplicateIds = null, exec = execFileSync }) {
  const facts = { repo, num };
  try { facts.pr = ghJson(['pr', 'view', String(num), '--repo', repo, '--json', PR_FIELDS], exec); }
  catch (e) { facts.prReadError = firstLine(e); return facts; }
  facts.defaultBranch = defaultBranch;
  const pr = facts.pr;
  const gitExec = (cmd, args, opts) => exec(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024, ...opts });

  // Manifest: the PR body first, the legacy tree file second (the drain's readPrManifest order).
  const fromBody = extractManifestFromBody(pr.body);
  if (fromBody) facts.manifest = { live: fromBody };
  else {
    try {
      const b64 = String(exec('gh', remoteManifestApiArgs(repo, pr.headRefName), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
      const m = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null;
      facts.manifest = m && m.item != null ? { live: m, fromTree: true } : { live: null };
    } catch (e) {
      facts.manifest = /404|Not Found/i.test(String(e?.stderr || e?.message)) ? { live: null } : { live: null, error: firstLine(e) };
    }
  }

  // Net diff signals off the checkout (the drain's computeNetDiffSignals), gh files list as the drain's fallback.
  try {
    const sig = computeNetDiffSignals({ exec: gitExec, rev: pr.headRefName, baseRev: facts.manifest?.live?.base ?? null, fetchExtraRefs: [pr.headRefName] });
    facts.netSignals = sig;
    if (!sig.scored) {
      const files = ghJson(['pr', 'view', String(num), '--repo', repo, '--json', 'files'], exec)?.files || [];
      facts.netSignals = { ...sig, changedFiles: files.map((f) => f.path), humanBasisFiles: files.map((f) => f.path),
        diffLines: files.reduce((s, f) => s + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0),
        cumulativeDiffLines: files.reduce((s, f) => s + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0),
        basisNarrowed: true, fallbackFiles: true };
    }
  } catch (e) { facts.netSignals = { scored: false, error: firstLine(e) }; }

  // Review acceptance evidence (comments + markers), read exactly as the drain reads it.
  if ((pr.labels || []).some((l) => (l?.name ?? l) === 'review:accepted')) {
    try { facts.acceptance = readDrainAcceptance({ pr: num, repo, cwd, local: true, exec: (c, a, o) => exec(c, a, { cwd, ...o }) }); }
    catch (e) { facts.acceptance = { error: firstLine(e) }; }
  }

  // Body history: every earlier body version is a candidate manifest baseline.
  try {
    const [o, n] = repo.split('/');
    const d = ghJson(['api', 'graphql', '-f', `query=${BODY_HISTORY_QUERY}`, '-f', `o=${o}`, '-f', `n=${n}`, '-F', `pr=${num}`], exec);
    const edits = d?.data?.repository?.pullRequest?.userContentEdits;
    if (!edits) facts.bodyHistory = { error: 'no userContentEdits in response' };
    else {
      const bodies = [pr.body || '', ...edits.nodes.map((x) => x?.diff).filter((x) => typeof x === 'string')];
      facts.bodyHistory = { bodies, complete: edits.totalCount <= edits.nodes.length };
    }
  } catch (e) { facts.bodyHistory = { error: firstLine(e) }; }

  // Duplicate ids on main (the checkout this script runs from) and, for a merge group, the group's tree.
  const scan = (dir) => (existsSync(dir) ? findDuplicateIds(dir) : null);
  const mainDup = scan(join(cwd, 'backlog'));
  facts.duplicateIds = mainDup === null ? { error: `no backlog dir at ${cwd}` } : { main: mainDup, ...(groupDuplicateIds ? { group: groupDuplicateIds } : {}) };

  // Red-main freeze: no shared source exists yet (the marker is local to the drain host) → evaluator fails closed.
  facts.redMain = { source: null };
  // Enqueue clearance (drain-stamped) is not wired yet → manifest couples/blockedBy fail closed in the evaluator.
  facts.enqueueClearance = null;
  return facts;
}

function parseArgs(argv) {
  const f = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const i = a.indexOf('=');
    if (i === -1) f[a.slice(2)] = true; else f[a.slice(2, i)] = a.slice(i + 1);
  }
  return f;
}

/** The PR numbers in a merge group, from every source (fail closed upstream when empty). */
export function readGroupPrs({ repo, headSha, baseSha, headRef, cwd, base = 'main', exec = execFileSync }) {
  let entries = [];
  let commitSubjects = [];
  try {
    const [o, n] = repo.split('/');
    entries = ghJson(['api', 'graphql', '-f', `query=${QUEUE_QUERY}`, '-f', `o=${o}`, '-f', `n=${n}`, '-f', `b=${base}`], exec)?.data?.repository?.mergeQueue?.entries?.nodes || [];
  } catch { /* other sources still count */ }
  try {
    commitSubjects = String(exec('git', ['log', '--first-parent', '--format=%s', `${baseSha}..${headSha}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).split('\n').filter(Boolean);
  } catch { /* other sources still count */ }
  // --first-parent: only the queue's own per-PR commits, never a PR's internal commits (whose "(#NNN)" subjects
  // name backlog items, not PRs).
  return groupPrNumbers({ headRef, headSha, entries, commitSubjects });
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  const repo = typeof f.repo === 'string' ? f.repo : process.env.GITHUB_REPOSITORY;
  const cwd = resolve(typeof f.cwd === 'string' ? f.cwd : process.cwd());
  if (!repo) { process.stderr.write('merge-gate-check: --repo=<owner/name> required\n'); process.exit(3); }
  const policy = loadMergeDeliveryPolicy({ toolSettings: readSettings(), knownGates: GATE_IDS });
  process.stderr.write(`${formatMergeDeliverySourcesLine(policy)}\n`);

  let defaultBranch = null;
  try { defaultBranch = ghJson(['repo', 'view', repo, '--json', 'defaultBranchRef'], execFileSync)?.defaultBranchRef?.name || null; } catch { /* fail closed per gate */ }

  let nums;
  let groupDup = null;
  if (f['merge-group']) {
    nums = readGroupPrs({ repo, headSha: f['head-sha'], baseSha: f['base-sha'], headRef: f['head-ref'] || '', cwd, base: defaultBranch || 'main' });
    if (f['list-group']) { writeAllSync(1, nums.map((x) => `${x}\n`).join('')); process.exit(nums.length ? 0 : 1); }
    if (typeof f['group-tree'] === 'string') {
      const d = join(resolve(f['group-tree']), 'backlog');
      groupDup = existsSync(d) ? findDuplicateIds(d) : [{ id: `group tree has no backlog dir (${d})` }];
    }
  } else {
    nums = String(f.pr || '').split(',').map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
    if (!nums.length) { process.stderr.write('merge-gate-check: --pr=<n>[,<n>…] or --merge-group required\n'); process.exit(3); }
  }

  const blockOnCodeQL = loadDrainGateSettings().drainBlocksOnCodeQL;
  const prs = nums.map((num) => evaluatePrGates(gatherPrFacts({ repo, num, cwd, defaultBranch, groupDuplicateIds: groupDup }), { policy, blockOnCodeQL }));
  const verdict = f['merge-group'] ? evaluateGroup(prs) : { ok: prs.every((p) => p.ok), reason: prs.every((p) => p.ok) ? 'all pass' : 'held', prs };
  if (f.json) writeAllSync(1, `${JSON.stringify({ ok: verdict.ok, reason: verdict.reason, policy, prs }, null, 2)}\n`);
  else {
    for (const p of prs) writeAllSync(1, `${formatPrResult(p)}\n`);
    writeAllSync(1, `merge-gate: ${verdict.ok ? 'PASS' : 'HOLD'} — ${verdict.reason}\n`);
  }
  process.exit(verdict.ok ? 0 : 1);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main().catch((e) => { process.stderr.write(`merge-gate-check ✗ ${e?.stack || e}\n`); process.exit(1); });
